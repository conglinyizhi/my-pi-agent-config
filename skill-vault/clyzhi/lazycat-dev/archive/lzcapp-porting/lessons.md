# 把第三方应用移植成 lzcapp

> 来源：TokenRouter（LGPL-3.0 的自托管 LLM 网关，Go + Vue3 + PostgreSQL + Redis）打包成懒猫应用，2026-10。
> 目标不只是"能跑"，而是"别人下载后立刻可用"以及"支持懒猫一键登录"。
> 下面每条都是实际踩出来的现象 + 根因 + 做法，不是推测。

---

## A. 读运行日志：走 ssh bridge，别去啃官方 HTTP 接口

**现象**：想读应用容器日志，官方日志页用的是 `/sys/debug/logs/history | /ws | /download` 这套纯 HTTP 接口，
但它在微服主域名下、**要微服登录态**，匿名请求一律 307 跳 `/sys/login`。

**更省事的路子**：微服的 ssh（端口 22222）被一个 `debug.bridge` 接管，**不给 shell**，
但放行了这些子命令：

```
lzc-docker  lzc-docker-compose  devshell  info  status
pause  resume  install  uninstall  platform  version  build  blob-*
```

拿 lzc-cli 自己生成的开发者密钥就能用，不需要微服账号，而且能读**任意**应用、不只当前项目。

```bash
KEY=~/.config/lazycat/lzc-cli-dev-box.key
# 地址和端口从 lzc-cli 的报错输出里抠（见下面 C 的注意事项）
ssh -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
    -o ControlMaster=no -o IdentitiesOnly=yes -i $KEY -q -p 22222 box@<微服地址> \
    lzc-docker logs --tail 200 <容器名>
```

容器名规律：`<包名去掉点>-<service>-1`，例如
`cloud.lazycat.app.foo` 的 `web` 服务 → `cloudlazycatappfoo-web-1`。

**本附件**：[lzc-logs](./lzc-logs) 是一个现成脚本，把这些包装成 `apps / ps / info / log / sh` 五个子命令，
带本地 `--grep` 过滤和 `-f` 跟随。

**两个坑**：

1. **地址不能用 DNS 解析的结果**。`<微服名>.heiyu.space` 解析出来的地址和实际 ssh 地址最后一段不同
   （实测 `:0` 连不上、`:402` 才通）。这个地址是 lzc-cli 通过本地客户端的 gRPC 拿的，没有命令行入口，
   只能从 `lzc-cli project info` **报错时**打印的 ssh 命令里抠一次然后缓存。
2. **bridge 的参数按 argv 传，远端没有 shell**。管道、通配符、变量展开统统无效，引号会被吞掉。
   所以过滤要在本地做；要在容器里跑带引号/空格的命令（比如 `psql -c "select ..."`），
   用 `setup_script` 的 heredoc 落盘再执行，别指望命令行传参。

---

## B. PostgreSQL 首次 initdb 会骗过 healthcheck

**现象**：全新安装（数据目录为空）时，`db` 容器报 healthy、依赖它的应用容器随即启动，
然后应用报 `dial tcp <db>:5432: connect: connection refused` 并**直接 panic 退出**（不重试）。

**根因**：PostgreSQL 官方镜像在首次 initdb 时会先起一个**只监听 unix socket 的临时实例**。
而 healthcheck 如果写 `pg_isready -U user -d db`（**不带 `-h`**，走 local socket），
在这个临时阶段就通过检查了 → compose 判定 db 就绪 → 放行依赖服务 → 依赖服务去连 TCP，被拒。

**做法**（两处都要）：

```yaml
# 1) healthcheck 强制走 TCP
db:
  healthcheck:
    test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U tokenrouter -d tokenrouter"]

# 2) 依赖服务在 setup_script 里前台等 TCP 真的通（这一步是兜底，防 healthcheck 语义变化）
tokenrouter:
  setup_script: |
    export PGPASSWORD="$DATABASE_PASSWORD"
    PSQL="psql -h $DATABASE_HOST -p $DATABASE_PORT -U $DATABASE_USER -d $DATABASE_DBNAME"
    until $PSQL -c "select 1" >/dev/null 2>&1; do sleep 2; done   # ← 前台阻塞，挡住 entrypoint
    ( ... 后续后台任务 ... ) &
```

**注意**：`setup_script` 是"先以 root 执行，再执行镜像原本的 entrypoint"。**前台**写的命令会推迟 entrypoint，
这正是我们要的；不想要的副作用记得丢进 `( ... ) &`。

**什么时候用**：任何把 PostgreSQL 当依赖打包的 lzcapp。首次安装必踩，之后有数据了就不复现，
所以很容易在"我这能跑"之后才被别人踩到。

---

## C. `.S.DeployUID` 在单实例应用下是空串

**现象**：想在模板里拿"部署者是谁"：

```yaml
LZC_ADMIN_EMAIL: '{{ .S.DeployUID }}@{{ .S.BoxDomain }}'
```

单实例应用（`multi_instance: false`）下渲染出来是 `@@clracat001.heiyu.space` —— **UID 那半边是空的**。

**根因**：官方文档只在字段表里轻描淡写一句「`.DeployUID`：部署用户 UID。**单实例应用下该值无实际意义**」。
多实例才有值。

**做法**：需要"用户身份"时，改用部署参数里的 `lzc_uid` 类型，让用户在部署向导里显式选：

```yaml
# lzc-deploy-params.yml
params:
  - id: box_admin_uid
    type: lzc_uid              # ← 向导会列出微服用户供选择
    name: "Box admin user"
    optional: false
```

```yaml
# lzc-manifest.yml
environment:
  LZC_BOX_ADMIN_EMAIL: '{{ .U.box_admin_uid }}@{{ .S.BoxDomain }}'
```

**顺带记住 `optional` 的语义**：「若所有字段均为可选则会**直接跳过部署界面**」。
想保留向导就至少留一个非 optional 字段；想装完即用就把全部设成 optional。

---

## D. 上游应用不认懒猫身份时，怎么让管理员一键登录

**背景**：懒猫微服的统一 OIDC 能把用户身份给到应用，但**第三方应用多半只认自己的账号体系**。
TokenRouter 就是典型：它建 OIDC 账号时**写死普通用户角色**，既不读懒猫 OIDC 的 `groups: [ADMIN]`，
也不看 ingress 注入的 `X-HC-User-Role`。

**先实测 header 是否可靠**（用 request inject 做探针，别猜）：

```yaml
application:
  injects:
    - id: hc-header-probe
      on: request
      auth_required: false          # 未登录也要跑，才能看到"空"这个对照
      when: ["/*"]
      do: |
        console.log("[probe] path=" + ctx.request.path
          + " | user=" + ctx.headers.get("X-HC-User-ID")
          + " | role=" + ctx.headers.get("X-HC-User-Role")
          + " | source=" + ctx.headers.get("X-HC-SOURCE"));
```

`console.log` 会写进 **lzcapp 运行日志**（就是 `<包名>-app-1` 容器），用 A 节的工具直接读。
实测结论：**经微服访问时 `role=ADMIN`、`user=<微服UID>` 都正常带过来**；
但应用是 `public_path: [/]` 时，**未登录请求的 `X-HC-*` 会被 ingress 清空**——所以探针必须带 `auth_required: false` 才能看到对照。

**但 inject 改不了数据库**。`request/response` 阶段是**同步模型**：没有 fetch、不能查库、不能调上游 API。
它能拦请求、能返回自定义页（`ctx.response.send`）、能改转发目标（`ctx.proxy.to`）——**唯独做不了"提权"**。
要做基于 header 的提权，只能自写 sidecar 代理，代价是还得正确转发 WebSocket/SSE。

**推荐的落地方式**：把身份判断放到部署时，用数据库触发器兜住：

```sql
-- 部署时选定的机主账号，走 OIDC 建号时直接建成管理员
CREATE FUNCTION promote_box_admin() RETURNS trigger AS $$
BEGIN
  IF lower(NEW.email) = lower('<所选用户>@<微服域名>') THEN
    NEW.role := 'admin';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER promote_box_admin BEFORE INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION promote_box_admin();
```

**为什么不用"第一个注册的人是管理员"**：那是抢注漏洞，任何能访问站点的人都能抢到最高权限。用部署时显式选择的身份才站得住。

---

## E. inject 的能力边界（一次记清）

| 能做 | 不能做 |
|---|---|
| `ctx.headers` 读写请求/响应头 | 发额外 HTTP 请求（同步模型，无 fetch） |
| `ctx.body` 读写 body（含 JSON/Form） | 查数据库 |
| `ctx.response.send(status, body, opts)` 短路返回自定义页 | 调上游应用的 API |
| `ctx.proxy.to(url, opts)` 按请求改反代目标 | 用 Promise / async |
| `ctx.persist` 按 `SAFE_UID` 跨请求持久化 | |
| `ctx.flow` 同一请求内 request→response 共享 | |
| `ctx.dump.request()` / `console.log` → **lzcapp 运行日志** | |
| `ctx.net.reachable()` 实时 TCP 探测 | |

**易踩的三点**：

1. `when` 里写 `#hash` 只在 `browser` 阶段有效，request/response 阶段不生效。
2. `auth_required` 默认 `true`——没有合法 `SAFE_UID` 时 inject **会被整个跳过**。想观察未登录流量必须显式设 `false`。
3. 调试期用 `console.log` 打日志很方便，但**记得撤**，否则每个请求都写一行。

---

## F. 镜像上传官方源与 GC

`registry.lazycat.cloud` 是懒猫提供的稳定源，上架审核要求应用镜像来自这里。

```bash
lzc-cli appstore login                       # 需要开发者账号，token 存在 ~/.config/lazycat/box-config.json
lzc-cli appstore copy-image <公网镜像>        # 服务端 pull 后转存，返回新的引用地址
# → registry.lazycat.cloud/<用户名>/<镜像名>:<镜像ID>
```

**四个必须知道的点**：

1. 返回的 **tag 是镜像 ID，不是版本号**，manifest 里要照抄新地址。
2. 镜像引用必须写全 registry 前缀。`tokenflux/xxx` 会被当成 Docker Hub 的，`ghcr.io/` 开头的要写全。
3. **被上传的镜像必须至少被一个商店应用引用**，否则官方源会定期 GC 回收。
   **没上架的包，镜像随时可能被清掉**——这是"别人装不了"的头号隐患。
4. `registry.lazycat.cloud` 仅供微服内部使用，在微服外拉取有限速。

---

## G. `setup_script` 实战

`setup_script` 以 root 执行、跑完再走镜像原本的 entrypoint，`services[].setup_script`。
和 `entrypoint`/`command` **互斥**。适合做"等依赖就绪 / 补初始化数据 / 装触发器"。

**模式一：前台等依赖**（见 B 节）——挡住 entrypoint，等条件满足再放行。

**模式二：后台做初始化**——用 `( ... ) &` 丢后台，不拖慢启动：

```yaml
setup_script: |
  export PGPASSWORD="$DATABASE_PASSWORD"
  PSQL="psql -h $DATABASE_HOST -p $DATABASE_PORT -U $DATABASE_USER -d $DATABASE_DBNAME"

  until $PSQL -c "select 1" >/dev/null 2>&1; do sleep 2; done    # 前台：等 TCP

  (
    # 后台：直到写进去为止。注意"表存在"不等于"目标表存在"——
    # 迁移是分批建表的，等 A 表存在时 B 表可能还没建。用目标操作本身当循环条件最稳。
    until $PSQL -c "INSERT INTO settings (key,value,updated_at) VALUES ('registration_enabled','true',now()) ON CONFLICT (key) DO NOTHING" >/dev/null 2>&1; do
      sleep 3
    done
    echo "[lzc] done"

    # 多行 SQL / 带引号的 SQL：heredoc 落盘再 psql -f，绕开 argv 吞引号
    cat > /tmp/init.sql <<'SQL'
  CREATE OR REPLACE FUNCTION ... $$ ... $$ LANGUAGE plpgsql;
  SQL
    sed -i "s|__PLACEHOLDER__|$SOME_ENV|g" /tmp/init.sql
    $PSQL -f /tmp/init.sql
  ) &
```

**三个坑**：

1. **别用 `echo` 当成功标志**。`cmd >/dev/null 2>&1 && echo ok` 才是对的；
   直接 `cmd >/dev/null 2>&1; echo ok` 会在失败时照样打印"成功"，排查时能把人坑死。
2. **`until` 的循环条件要选对**。"users 表存在"不等于"settings 表存在"——迁移分批建表，
   用**你真正要做的那个操作**当条件最稳（失败了就重试）。
3. **镜像里不一定有 psql**。TokenRouter 的 Dockerfile 正好从 postgres 镜像 COPY 了 psql；
   换别的应用要确认，没有就得换工具或另加一个 service。
