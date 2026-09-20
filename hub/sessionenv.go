package main

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
)

// hub 由 default.target 拉起，比图形会话导入环境（DISPLAY / WAYLAND_DISPLAY）早二十多秒，
// 继承到的是空值。之后它拉 wails-gui / yad 时子进程同样拿不到显示，窗口不出现也不报错。
// 启动 GUI 之前向 systemd 用户管理器要一次当前会话环境，把缺的显示变量补上。
//
// 只补 sessionVars 白名单里的键：show-environment 里还有 PATH 之类，
// 整包覆盖会把 hub 自己的环境搞乱。

var sessionVars = []string{
	"DISPLAY",
	"WAYLAND_DISPLAY",
	"XAUTHORITY",
	"XDG_SESSION_TYPE",
	"XDG_RUNTIME_DIR",
}

// showEnvironment 单列成变量，测试里替换掉，不真去调 systemctl。
var showEnvironment = func() (string, error) {
	out, err := exec.Command("systemctl", "--user", "show-environment").Output()
	if err != nil {
		return "", err
	}
	return string(out), nil
}

var backfillLogged sync.Once

// guiEnv 返回 GUI 子进程要用的环境。自己有显示环境就直接用，缺了才去问 systemd。
func guiEnv() []string {
	env := os.Environ()
	if hasDisplay(env) {
		return env
	}
	out, err := showEnvironment()
	if err != nil {
		return env
	}
	merged := mergeSessionEnv(env, out, sessionVars)
	if filled := diffEnv(env, merged); len(filled) > 0 {
		backfillLogged.Do(func() {
			log.Printf("会话环境缺失，已从 systemd 补入：%s", strings.Join(filled, " "))
		})
	}
	return merged
}

// hasDisplay 判断环境里是否已经有可用的显示目标。
// 空串算没有：systemd 给的环境里这两个键常在，但值是空的。
func hasDisplay(env []string) bool {
	for _, kv := range env {
		k, v, _ := strings.Cut(kv, "=")
		if v != "" && (k == "DISPLAY" || k == "WAYLAND_DISPLAY") {
			return true
		}
	}
	return false
}

// mergeSessionEnv 把 show-environment 输出里白名单内的键覆盖进 env。
// 已有的键就地替换（不留重复项），env 里没有的键追加到尾部。空值不补。
func mergeSessionEnv(env []string, showEnv string, keys []string) []string {
	allowed := make(map[string]bool, len(keys))
	for _, k := range keys {
		allowed[k] = true
	}
	fromSession := make(map[string]string, len(keys))
	for _, line := range strings.Split(showEnv, "\n") {
		k, v, ok := strings.Cut(strings.TrimRight(line, "\r"), "=")
		if !ok || v == "" || !allowed[k] {
			continue
		}
		fromSession[k] = v
	}
	seen := make(map[string]bool, len(env))
	out := make([]string, 0, len(env)+len(keys))
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		seen[k] = true
		if v, ok := fromSession[k]; ok {
			out = append(out, k+"="+v)
			continue
		}
		out = append(out, kv)
	}
	for _, k := range keys {
		if seen[k] {
			continue
		}
		if v, ok := fromSession[k]; ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}

// diffEnv 列出 first 里为空、second 里补上的键，只用于日志。
func diffEnv(before, after []string) []string {
	had := make(map[string]string, len(before))
	for _, kv := range before {
		k, v, _ := strings.Cut(kv, "=")
		had[k] = v
	}
	var filled []string
	for _, kv := range after {
		k, v, _ := strings.Cut(kv, "=")
		old, ok := had[k]
		if !ok || (old == "" && v != "") {
			filled = append(filled, k)
		}
	}
	return filled
}
