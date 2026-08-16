# 热更新后门：本机编译 → 推送运行中容器（build tag 条件编译）

> 来源：lzc-file-reader 项目（2025-08）。懒猫微服的 `project deploy`/`project build` 走云端 build-pack，
> 每次改代码都要重新构建镜像（dev 镜像含 Go 工具链约 2-3 分钟、包体 120MB+），迭代很慢。
> 本项目验证的方案：**部署一次后，本机编译 → 通过后门接口把二进制 + 前端推到运行中的容器 → 容器自动重启**。

## 核心思路

1. **后门接口**：`POST /api/_dev/update`，接收本机编译的 ELF 二进制或 tar.gz（`app` + `web/`），
   原子写入持久目录，随后自重启，由 supervisor 拉起新二进制。
2. **build tag 条件编译**：后门代码用 `//go:build devupdate` 隔离；release 构建不带 tag → 自动走空实现，接口物理不存在。
3. **持久目录优先**：`/lzcapp/var` 是容器重启不丢的持久目录；run.sh 优先加载 `/lzcapp/var/app.bin`，
   静态服务优先 `/lzcapp/var/web`，镜像内的 `/app/app`、`/app/web` 仅作兜底。
4. **公开可达**：后门路径加入 manifest `public_path`（仅在 `#@build if env.DEV_MODE=1` 块内），
   否则 curl 会被 ingress 307 到登录页。

## 双构建模型

| | 调试包（dev） | 发行包（release） |
|---|---|---|
| 构建文件 | `Dockerfile.dev` | `Dockerfile` |
| 编译命令 | `go build -tags devupdate` | `go build`（无 tag） |
| 后门 `/api/_dev/update` | ✅ 有 | ❌ 无（stub 空实现） |
| manifest `public_path` | ✅ 含（DEV_MODE=1 块） | ❌ 不含（物理剔除） |
| 镜像形态 | 轻量、自动启动（同发行版） | 轻量、自动启动 |

**剔除后门不需要改代码**：release 构建自动完成（条件编译 + manifest 预处理块）。发布上架前用 `lzc-cli project release` 即可。

## 关键代码

### devupdate.go（`//go:build devupdate`）

```go
//go:build devupdate

package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const devMaxBytes = 200 << 20 // 200MB 上限

// 路径默认指向容器持久目录，可用环境变量覆盖（本地测试用）
func devTokenPath() string {
	if v := os.Getenv("DEV_TOKEN_PATH"); v != "" { return v }
	return "/lzcapp/var/dev.token"
}
func devBinPath() string {
	if v := os.Getenv("DEV_BIN_PATH"); v != "" { return v }
	return "/lzcapp/var/app.bin"
}
func devWebDir() string {
	if v := os.Getenv("DEV_WEB_DIR"); v != "" { return v }
	return "/lzcapp/var/web"
}

func registerDevUpdate(mux *http.ServeMux) {
	_, _ = ensureDevToken()
	mux.HandleFunc("/api/_dev/update", handleDevUpdate)
}

// 首次启动生成 32 字节随机 token 并持久化；此后保持不变
func ensureDevToken() (string, error) {
	if bs, err := os.ReadFile(devTokenPath()); err == nil {
		return string(bs), nil
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil { return "", err }
	token := hex.EncodeToString(buf)
	if err := os.MkdirAll(filepath.Dir(devTokenPath()), 0o755); err != nil { return "", err }
	if err := os.WriteFile(devTokenPath(), []byte(token), 0o600); err != nil { return "", err }
	return token, nil
}

func handleDevUpdate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost { http.Error(w, "method not allowed", http.StatusMethodNotAllowed); return }
	token, err := os.ReadFile(devTokenPath())
	if err != nil { http.NotFound(w, r); return } // 未初始化 token → 404，避免暴露接口
	if r.Header.Get("X-Dev-Token") != string(token) { http.Error(w, "forbidden", http.StatusForbidden); return }

	body, err := io.ReadAll(io.LimitReader(r.Body, devMaxBytes+1))
	if err != nil { http.Error(w, "read body failed", http.StatusBadRequest); return }
	if len(body) > devMaxBytes { http.Error(w, "payload too large", http.StatusRequestEntityTooLarge); return }

	// gzip magic \x1f\x8b → tar.gz 包（二进制 + web）；否则按 ELF 二进制处理
	if len(body) >= 2 && body[0] == 0x1f && body[1] == 0x8b {
		if err := applyUpdateArchive(body); err != nil { http.Error(w, "archive apply failed: "+err.Error(), http.StatusBadRequest); return }
	} else {
		if err := applyUpdateBinary(body); err != nil { http.Error(w, "binary apply failed: "+err.Error(), http.StatusBadRequest); return }
	}

	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte("ok, restarting"))

	// 延迟 300ms 确保响应送达，再自杀让 run.sh 拉起新二进制
	go func() { time.Sleep(300 * time.Millisecond); _ = syscall.Kill(syscall.Getpid(), syscall.SIGTERM) }()
}

// ELF magic 校验：\x7fELF
func applyUpdateBinary(body []byte) error {
	if len(body) < 4 || body[0] != 0x7f || body[1] != 'E' || body[2] != 'L' || body[3] != 'F' {
		return fmt.Errorf("not an ELF binary")
	}
	return atomicWrite(devBinPath(), body, 0o755)
}

// tar.gz 解包：app → /lzcapp/var/app.bin；web/* → /lzcapp/var/web/（带路径穿越防护）
func applyUpdateArchive(body []byte) error {
	gz, err := gzip.NewReader(bytes.NewReader(body))
	if err != nil { return err }
	defer gz.Close()
	tr := tar.NewReader(gz)

	hasBin, hasWeb := false, false
	for {
		hdr, err := tr.Next()
		if err == io.EOF { break }
		if err != nil { return err }
		name := filepath.Clean(hdr.Name)
		if hdr.Typeflag == tar.TypeDir { continue }
		switch {
		case name == "app" || name == "./app":
			data, err := io.ReadAll(io.LimitReader(tr, devMaxBytes))
			if err != nil { return err }
			if err := applyUpdateBinary(data); err != nil { return err }
			hasBin = true
		case strings.HasPrefix(name, "web/"):
			rel := strings.TrimPrefix(name, "web/")
			if rel == "" || strings.HasPrefix(rel, "../") { return fmt.Errorf("invalid web path: %s", hdr.Name) }
			target := filepath.Join(devWebDir(), rel)
			if !strings.HasPrefix(target, filepath.Clean(devWebDir())+string(os.PathSeparator)) {
				return fmt.Errorf("path escape: %s", hdr.Name)
			}
			data, err := io.ReadAll(io.LimitReader(tr, devMaxBytes))
			if err != nil { return err }
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil { return err }
			if err := os.WriteFile(target, data, 0o644); err != nil { return err }
			hasWeb = true
		default:
			continue // 忽略未知条目
		}
	}
	if !hasBin && !hasWeb { return fmt.Errorf("archive contains neither app nor web/") }
	return nil
}

// 原子写：tmp + rename，避免写一半
func atomicWrite(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil { return err }
	if err := os.Chmod(tmp, mode); err != nil { _ = os.Remove(tmp); return err }
	if err := os.Rename(tmp, path); err != nil { _ = os.Remove(tmp); return err }
	return nil
}
```

### devupdate_stub.go（`//go:build !devupdate`）

```go
//go:build !devupdate

package main

// 正式发布构建（不带 -tags devupdate）时，后门为空实现。
import "net/http"

func registerDevUpdate(mux *http.ServeMux) {}
```

### main.go 注册

```go
// 开发期热更新后门（devupdate tag 编译时注册；正式发布为空实现）
registerDevUpdate(mux)
```

### run.sh（supervisor 循环，优先热更新二进制）

```sh
#!/bin/sh
# supervisor 循环：优先加载热更新二进制（开发期后门写入 /lzcapp/var/app.bin，持久目录），
# 应用退出后自动重启（热更新接口自重启依赖此机制）。
# 正式发布包不带后门时，/lzcapp/var/app.bin 不存在，回退到镜像内的 /app/app。

APP=/app/app
if [ -f /lzcapp/var/app.bin ]; then
	APP=/lzcapp/var/app.bin
	echo "[run.sh] using hot-updated binary: $APP"
fi

echo "[run.sh] starting $APP"

while true; do
	"$APP" &
	PID=$!
	if wait "$PID"; then
		echo "[run.sh] app exited normally, restarting in 1s"
	else
		rc=$?
		echo "[run.sh] app exited with code $rc, restarting in 1s"
	fi
	sleep 1
done
```

### main.go 静态目录优先热更新 web

```go
// 静态目录：优先热更新目录（开发期后门写入 /lzcapp/var/web），否则镜像内置 /app/web
webDir := os.Getenv("WEB_DIR")
if webDir == "" {
	if v := os.Getenv("DEV_WEB_DIR"); v != "" {
		webDir = v
	} else if _, err := os.Stat("/lzcapp/var/web"); err == nil {
		webDir = "/lzcapp/var/web"
	} else {
		webDir = "/app/web"
	}
}
```

### Dockerfile（release，无后门）vs Dockerfile.dev（调试，带后门）

```dockerfile
# Dockerfile（release）—— 不带 tag，后门自动剔除
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /workspace/app .
...
CMD ["/app/run.sh"]
```

```dockerfile
# Dockerfile.dev（调试）—— 带 tag，后门参与编译
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -tags devupdate -o /workspace/app .
...
CMD ["/app/run.sh"]   # 与 release 一致：自动启动 run.sh，不依赖云端编译/热重载
```

### lzc-manifest.yml（public_path 仅在 DEV_MODE 块）

```yaml
application:
  subdomain: file-reader
  image: embed:app-runtime
  routes:
    - /=exec://3000,/app/run.sh
#@build if env.DEV_MODE=1
  public_path:
    # 开发期热更新后门入口：仅调试构建（DEV_MODE=1）包含；release 构建物理上不包含
    - /api/_dev/update
#@build end

ext_config:
  enable_media_access: true
```

### scripts/hot-update.sh（本机一键热更新）

```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

ARCH="${1:-amd64}"
TARGET_URL="${2:-https://file-reader.clracat001.heiyu.space/api/_dev/update}"

# 1) 本机编译（不带云端编译）
mkdir -p .build
CGO_ENABLED=0 GOOS=linux GOARCH="${ARCH}" go build -tags devupdate -o .build/app .

# 2) 读取云端 dev token（注意顺序：先 tail 取最后一行，再去空白；exec 输出首行是 "Build config: ..."）
TOKEN="$(lzc-cli project exec -- /bin/sh -lc 'cat /lzcapp/var/dev.token' 2>/dev/null | tail -1 | tr -d '[:space:]')"
if [ -z "${TOKEN}" ]; then
  echo "!! 无法读取 /lzcapp/var/dev.token，请确认发行版已部署且容器运行中" >&2
  exit 1
fi

# 3) 打包 app + web 并推送
rm -rf .build/pkg && mkdir -p .build/pkg
cp .build/app .build/pkg/app
cp -r web .build/pkg/web
tar -C .build/pkg -czf .build/update.tar.gz app web

HTTP_CODE="$(curl -sS -o .build/update.resp -w '%{http_code}' -m 120 \
  -X POST -H "X-Dev-Token: ${TOKEN}" \
  --data-binary @.build/update.tar.gz "${TARGET_URL}")"
echo "    HTTP ${HTTP_CODE}: $(cat .build/update.resp)"
[ "${HTTP_CODE}" = "200" ] || { echo "!! 热更新失败" >&2; exit 1; }
echo "==> 完成，云端容器即将自动重启加载新二进制"
```

## 踩坑记录

### 1. manifest 的 `ext_config` 位置会破坏 `#@build` 缩进链

把 `ext_config` 放在 `#@build if/else/end` 块**前面**时，渲染结果中 `routes` 会被错误地嵌套进 `ext_config`（而不是 `application`），导致应用启动报 `Status_Error` 且无错误信息：

```yaml
# ❌ 错误：routes 被渲染进 ext_config
ext_config:
  enable_media_access: true
  routes:                      # ← 错位！
    - /=exec://3000,/app/run.sh
```

**修复**：`ext_config` 放到文件末尾、`#@build end` 之后。

**排查方法**：`lzc-cli project build` 后 `tar -xOf <pkg>.lpk manifest.yml` 查看渲染结果；应用 `Status_Error` 且 `project info` 错误信息为空时优先怀疑 manifest 渲染。

### 2. lzc-cli `project exec` 的 `-c` 冲突

`project exec` 自身有 `-c/--config` 参数，直接传 `/bin/sh -c '...'` 会把 `-c` 后的内容当成构建配置文件名。用 `--` 分隔：`lzc-cli project exec -- /bin/sh -lc '...'`。

### 3. dev token 提取顺序

`project exec` 输出第一行是 `Build config: ...`。提取 token 必须 **先 `tail -1` 再 `tr -d`**，反了会把前缀混进来。

### 4. 本机 /etc/ssh/ssh_config.d 属主异常导致 OpenSSH 拒绝

某些容器环境下 `/etc/ssh/ssh_config.d/20-systemd-ssh-proxy.conf` 属主是 `nobody`，OpenSSH 直接报
`Bad owner or permissions`，导致 lzc-cli 的 SSH 桥接（deploy/exec）全部失败。绕过：PATH 前置一个 `ssh -F /dev/null` 包装脚本。

### 5. 后门路径必须进 `public_path` 才能被 curl 直连

不在 `public_path` 的路径，curl 会被 ingress 307 到 `/sys/login`。后门用自研 token 鉴权（不依赖 X-HC 头），放 `public_path` 是安全的；release 构建通过 `#@build if env.DEV_MODE=1` 物理剔除。

### 6. 热更新产物放持久目录 `/lzcapp/var`

`/app`（镜像 rootfs）重启会还原，只有 `/lzcapp/var`、`/lzcapp/cache` 持久。二进制与前端必须落到 `/lzcapp/var` 下，run.sh / 静态服务优先读取，容器重启后热更新版本不丢。

### 7. 架构注意：GOARCH 要与云端一致

本机默认 amd64 通常与微服一致；若目标微服是 arm 架构，需 `GOARCH=arm64` 重新编译，否则容器内 `exec format error`。

## 什么时候用

1. 迭代频繁、`project deploy` 云端构建太慢（分钟级）。
2. 前端 + 后端都要改，希望一条命令同步推上去。
3. 不想要 dev workflow 的 `project sync --watch` + 容器内 `go run` 那套（容器要带 Go 工具链、包体大）。
4. 需要"部署一次，之后纯本机编译"的开发节奏。

## 安全边界（发布前）

- 后门仅存在于 debug 构建（`-tags devupdate`），release 构建（`lzc-cli project release`）自动剔除，无需改代码。
- token 存 `/lzcapp/var/dev.token`（0600），首次启动生成；接口无 token/错 token 一律 403，未初始化直接 404。
- ELF magic 校验防乱传；tar.gz 解包带路径穿越防护；200MB 体积上限。
