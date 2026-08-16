# DSH 插件架构盘点：Cordis 组装机制调查

> 版本基准：@deepseek-ai/dsh-*@0.1.0-rc.6（pnpm dlx 缓存内已发布包，只读调查）。

> 调查范围：`$BASE/@deepseek-ai+<pkg>@<ver>/node_modules/@deepseek-ai/<pkg>/`（BASE = pnpm dlx 缓存），以及 `~/.dsh/` 运行时家目录。全部源码/README 可读（cordis 系是 Koishi 系框架的 fork：`@deepseek-ai/cordis` v4.0.1 + loader/include/hmr/group 插件 + `@deepseek-ai/schemastery` v3.18.1）。关键源码文件均有 src TypeScript。
>
> 路径简写：`<dsh>`=dsh 包目录，`<boot>`=dsh-app-boot 包目录，`<loader>`=cordis-plugin-loader 包目录，`<web-app>`=dsh-web-app 包目录，`<base>`=dsh-base 包目录。所有 lib 均为编译产物，src 与 lib 内容一致（引用 src 优先）。
>
> 目的：作为把 DSH 的 Cordis 插件架构移植到 pi coding agent 平台的机制参考。风格：机制描述 + 关键文件路径 + 少量关键签名，不贴大段源码。

---

## A. 启动与组装全链路：bin → boot → Loader → cordis.yml include → patches → profiles → HMR

### A1. bin 入口（launcher 只解析自己的 flag，其余全交给插件树）

- 唯一 bin：`<dsh>/lib/bin.js`（package.json `bin.dsh`）。流程：读版本 → `parseDshArgs(process.argv.slice(2))`（commander，`allowUnknownOption+passThroughOptions+enablePositionalOptions`）→ 解析 launcher 自有 flag：`--profile <name>`、`--patch <path>`（可重复）、`--dump-config`/`--dump-default-config`、`web`（= `--profile web` 别名）、`plugin` 子命令；**launcher flag 之后的所有参数原样透传给插件树**（`args`）。
- 三种 mode 动态 import 分发：`profile`→`runProfile`、`plugin`→`runPlugin`（转发 pnpm 管理 profile 依赖）、`dump-config`→`runDumpConfig`。
- 环境：`loadLayeredEnv("dsh")`（`<boot>/lib/index.js`）构建「继承环境 > 项目 .env > 用户 .env」快照，拒绝 bootstrap-only 文件变量，物化进 `process.env`，并以 `launchEnvironment` 上下文值注入（`DSH_LAUNCH_ENVIRONMENT_KEY`）。

### A2. runProfile：profile 组装与启动编排（`<dsh>/lib/profile-boot-DG5t9aNs.js`）

1. `prepareProfile(name)`：`healProfilesModuleFallback(INSTALL_ANCHOR)`（见 D4）→ `loadProfile(...)` → **每次 boot 前把 profile 的 `cordis.yml` 重写为空 `[]`**（Loader 需要一个真实 include 根来锚定 baseUrl；同时防止 Loader 的 self-dispose 写回把组合结果烤进文件）。
2. `composeProfile` 算出全部 patch 层（顺序见 C）→ `runProfile` 里 `boot("dsh", rootConfig, structuredClone(allPatches), prepare)`。
3. `prepare(ctx)` 钩子（在任何配置树条目挂载前）：`ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, env)` + `provideCmdline(ctx, {args, exit})`（`<dsh-cmdline>`：提供 `ctx.cmdlineArgs` 快照与 `ctx.appExit` 有界退出）。
4. boot 后：若 `ctx.get("hmr")` 不存在（web profile 禁用了 hmr 行），动态 `ctx.loader.create` timer + hmr 插件（`config:{root:[]}`，只做配置监听不做模块监听）；然后对 **profile 的 cordis.patch.yml 和 home 级 cordis.patch.yml 各注册一个** `watchUserPatches`（见 A6）。
5. 进程级：`installFailLoud`（unhandledRejection → 一行标签化 stderr + exit(1)，带限时 release 清理）+ `createProcessShutdown`（SIGINT/SIGTERM → dispose 整个 fiber 树，5s 上限强制退出）。

### A3. boot()（`<boot>/lib/index.js`）—— 核心序列

```
new Context()                       # 根 cordis 上下文
ctx.baseUrl = config 目录
ctx.provide("dshHomePath", dshHomePath)   # 供配置里 !!js 表达式用
await ctx.plugin(Loader)            # 安装 Loader 服务
await prepare?.(ctx)                # 宿主钩子：注入 launchEnvironment/cmdlineArgs
await mountRootInclude(ctx, configPath, patches, bareModuleBaseUrl)
await ctx.get("loader").await()     # 等整棵树 settle（含失败聚合）
await assertEntriesActivated(ctx)   # 启动审计：见下
return ctx
```
- 失败：dispose 部分上下文 → 抛标签化错误（"host preparation failed" / "plugin tree failed to load"）。
- `assertEntriesActivated`：enabled 但无 fiber → 列出所有解析失败的插件名；fiber 状态 FAILED → 恢复原始 stack；PENDING → 列出未解析的服务。**启动即审计，绝不静默半活**。

### A4. mountRootInclude：include/group 内建 + 根条目

- `ctx.loader.builtins.include = Include`（dsh-app-boot **内嵌**了 cordis-plugin-include 的实现，逐行一致；带 `bareModuleBaseUrl` 时用 `HostResolvedRootInclude` 子类：裸包名经 Node 内部 `loader.internal.import(specifier, bareModuleBaseUrl)` 解析，相对路径与 `cordis:` 仍按 baseUrl 解析）。
- `ctx.loader.builtins.group = Group`（cordis-plugin-group，纯再导出 loader 的 `Group extends EntryGroup`，`[EntryGroup.key]=Symbol.for('cordis.group')` 树载体标记）。
- `ctx.loader.create({id:"include", name:"cordis:include", config:{path, patches}})`：Include 是 `EntryTree` 子类，读 YAML 文件（就是那个空 `[]`）→ `applyEntryPatches(data, patches)` 一次应用**全部** patch 层 → `root.update(data)` 事务性 diff（create/update/remove + 失败回滚，保留 last good tree）。
- 条目名解析（`EntryTree.import`）：`cordis:*` → builtins；`.` 开头 → baseUrl 相对；裸名 → Node 22+ 内部 ModuleLoader（依赖可选原生助手 `node-addon-require-builtin`）。
- **激活是服务可用性驱动的**：行只声明 `inject`，加载顺序与文件行序无关——这是整个架构最重要的运行语义。

### A5. 真实示例：web profile 的三层组合

- `<base>/cordis.patch.yml`（451 行）：一个巨型 `insert`，约百行基础行（timer、hmr、llm、session、typert-registry/loader、api-gateway、settings-file、credentials-local、sandbox/tool 全家、goal、subagent、workflow、commands、skill 等）。
- `<web-app>/cordis.patch.yml`（424 行）：
  1. **id-targeted 覆盖**：`system-prompt` persona、`hmr: disabled`、`session-query-sqlite` 改 `:memory:`、`tools.mode: !!js process.env.DSH_TOOLS_MODE` 等；
  2. **一个 insert**：宿主行（code-runtime、storage、storage-json、storage-domain、workspace、plugin-inventory、api-gateway、cordis-host-runner、web-startup）+ 传输行（webserver 注入 webStartup、web-runtime、client-hmr）+ 浏览器名册 `dsh.client` 行（modules、connection、api-remotes、client-runtime、cordis-client-runner、ui-* 全部 UI）；
  3. **禁用整个「agent 平面」**：`tool-bash/tool-fs/tool-goal/skill-*/subagent-*/workflow-*/plan-mode/agent-instructions/compaction-*` 等全 `disabled: true`——web 改为每会话由 agent preset 组合 agent；
  4. **一个 insert**：`agent-presets` 行（`config:{default: standard}`）。
- profile 自己的 `cordis.patch.yml` = `[]`（用户层为空）。`~/.dsh/profiles/web/package.json` 的 `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`。
- 结果：`dsh web` → web-startup 从 `cmdlineArgs` 解析 `--host/--port/--trusted-host` → webserver 绑定 127.0.0.1:3080 → web-runtime 提供 `webRuntime` → client-modules 扫描已启用行合成 `window.__DSH_BOOT__` → `dsh-host-frontend-static` 伺服 SPA（index-tap 注入）。

### A6. HMR：两层机制

- **用户 patch 层热更**（web/headless 都开）：`watchUserPatches(ctx, {binName, filename, compose})` 用 `hmr.registerConfig(filename, async cb)`（cordis-plugin-hmr）监听文件；变更时 `compose` 闭包**重读 patch 文件并按调用方层序重组完整列表**（bundle 层在下、overlay 在上）→ `entry.update({config:{...includeConfig, patches}})` → Include 的 `internal/update` 处理器 → `applyPatches` → `root.update` 事务替换。失败保留 last good tree 并广播 `hmr/config-update-failed`。burst 串行化，观察者失败被隔离。
- **插件模块级 HMR**（非 web surface）：hmr 插件 `root:['.']` 监视模块；事务 = 备份/清 ESM loadCache + CJS require.cache → 入口 all-or-nothing 重 import → 释放旧插件、用旧 config 重建同 entry fiber；失败回滚恢复缓存；externals（CLI 入口依赖树）变更走 `loader.exit()` 整进程重启。web 禁用该行，改用 `dsh-client-hmr`（浏览器 bundle 重载链）。
- 与 Vite/webpack HMR 的本质差异：无 accept 注解、重载粒度是**插件条目**（依赖图自动推导）、真正的缓存备份/回滚事务、框架级变更整进程重启、配置热更与插件热更共用 watcher 通道。详见补充 4。

---

## B. cordis 框架核心能力（`<cordis>/src/*.ts` + `<loader>/src/*.ts`）

| 能力 | 一句话说明 | 关键签名/位置 |
|---|---|---|
| **Context** | 根依赖容器，运行时是 Proxy：属性读取走服务解析；`extend(meta)` 原型继承子上下文、`isolate(name,label)` 服务作用域隔离、`intercept(name,config)` 服务配置拦截 | `context.ts`；`new Context()` 即根 |
| **Plugin / Registry** | `ctx.plugin(fn|class|{apply}, config)` 装载插件；三种形态统一为 callback；`inject` 声明依赖、`Config`（schemastery/StandardSchemaV1）校验配置；registry 跟踪 runtime（callback → fibers 列表） | `registry.ts`；`ctx.inject(deps, cb)` 依赖就绪回调 |
| **Fiber** | 一个插件实例的生命周期单元：PENDING→LOADING→ACTIVE→FAILED / UNLOADING→DISPOSED；`await fiber` 等 settle；`fiber.update(config)` 热更配置；**effect 系统**（ctx.on/provide/plugin/effect 自动收集，fiber dispose 时逆序清理） | `fiber.ts`；`FiberState` 枚举 |
| **Service** | 命名服务基类：`class X extends Service { constructor(ctx,'name') }` 即注册；`Service.init`（async generator 异步初始化 + yield 清理）、`Service.check`（可用性谓词，loader 借此让依赖方 pending）、`Service.invoke`（可调用服务）；服务随 fiber 卸载自动注销 | `service.ts` |
| **Events** | 类型化事件总线（`interface Events{}` 模块扩充），`emit/parallel/serial/bail/waterfall` 多派发模式，`{global, prepend}` 选项，支持 thisArg 过滤 | `events.ts` |
| **Logger** | 命名 logger（`ctx.logger(name)`）+ %C 格式化 + 导出器 | `logger.ts` |
| **Schema** | Koishi 系 `@deepseek-ai/schemastery` v3.18.1：类型驱动校验器（`z.object({...})`），插件 Config 用它定义；同一 schema 驱动运行时校验、客户端表单/设置页、dump | schemastery |
| **Loader** | 运行时插件树服务 `ctx.loader`：EntryTree 持有 `id/name/config/inject/disabled/group/isolate/intercept` 条目；`create/update/remove/resolve`；**事务性 diff 更新 + 失败回滚**；`await()` 聚合 settle；`internal/config` 事件在非树载体 fiber 上插值 `!!js`；`internal/plugin` 钩子把 fiber↔entry 绑定、处理 self-dispose→标 disabled | `loader/src/index.ts`、`config/entry.ts`、`config/tree.ts`、`config/group.ts` |
| **include** | YAML/JSON 配置文件作 EntryTree（`cordis:include` 内建）：`!!js` 表达式按行条目各自 ctx **惰性求值**（`new Function('ctx','expr','with(ctx){eval(expr)}')`）；配置可写回（.tmp+rename、防重试）；**patch 算法**（见 C） | `include/src/index.ts`（app-boot 内嵌同源） |
| **group** | 嵌套子条目列表（`cordis:group` 内建）：Group 插件把 config 数组挂成子树；patch 的 `insert` 可指定目标 group | `loader/src/config/group.ts` |
| **isolate** | entry 选项 `isolate:{服务名: true|label}`：服务实现按条目/标签作用域隔离（LocalRealm/GlobalRealm），同进程内两个条目可各自装载同名服务的不同实现，配 `loader/patch-context` 钩子动态迁移 | `loader/src/config/isolate.ts` |
| **intercept** | entry 选项 `intercept:{服务名: config}`：合并进该服务每插件解析出的配置（祖先优先，`Service[resolveConfig]`） | `loader/src/config/isolate.ts` |
| **HMR** | `registerConfig(filename, refresh)` 配置热更 + 模块级插件重载（清双缓存→重 import→重建 fiber→失败回滚）+ `loader.exit()` 全量重启 + `hmr/config-update-failed` 事件 | `hmr/src/index.ts` |
| **timer** | disposal-aware 的 setTimeout/interval/throttle/debounce，随 fiber 清理 | cordis-plugin-timer |

---

## C. patch 分层模型（优先级与合并算法）

**PatchOptions**（`include/lib/types/index.d.ts`）：`{id?, name?, insert?, config?, disabled?, group?, inject?, intercept?, isolate?, [k]:any}`——id-targeted 覆盖、insert 追加、disabled 禁用。

**合并算法**（`applyEntryPatches`，挂载与 `--dump-config` 共用同一实现，保证 dump=boot）：
1. `structuredClone` 输入（输入不可变、结果脱离输入——热更可回退）；
2. 建 id→entry 索引（递归 group.config）；
3. 顺序应用：`insert`（带 id → 目标必须是 group，插入其 config；不带 id → 顶层追加；**插入后立即重建索引**，同列表后续 patch 可定位新行）；id-targeted（`name` 不匹配 → 跳过并警告；其余字段**整体覆盖，config 不深合并**——覆盖层必须重述保留字段；id 不存在 → 警告跳过）。

**应用顺序**（`<dsh>/lib/profile-boot` 的 `composeProfile`，后层赢）：
1. **bundle 层**：`dsh.profile.bundles` 顺序，每 bundle 的 `dsh.bundle.patch`（web = dsh-base → dsh-web-app）；
2. **profile 层**：`$DSH_HOME/profiles/<name>/cordis.patch.yml`（每 profile 一个，热更）；
3. **home 层**：`$DSH_HOME/cordis.patch.yml`（机器级偏好，**高于 profile 层**，热更）；
4. **overlay 层**：`--patch <path>` 文件（argv 顺序）；
5. **程序化 overlay**：shipped agent-presets root 配置 + telemetry 开关（`DSH_TELEMETRY_DISABLED` 任意非空即禁用 `session-telemetry-otel` 行）。

最终全部作为 **ONE 扁平 patch 列表**传给 `mountRootInclude`，对空根 `[]` 应用——"last write wins per row"。`renderConfigDump` 离线按层逐步应用并标注 provenance 注释，输出可直接加载的 YAML。

---

## D. profile 机制（模板、bundle、composeEntries）

- **目录布局**：`$DSH_HOME/profiles/<name>/`（`DSH_HOME` 默认 `~/.dsh`；`resolveDshHome` 在 `<dsh-home-paths>`）含 `package.json`（`dependencies` + `dsh.profile.bundles` 有序列表）、`cordis.patch.yml`（用户层）、`pnpm-workspace.yaml`（hoisted + autoInstallPeers:false）。`cordis.yml` 是**每次 boot 重写的空根**，不是用户编辑面（注释明示"Edit cordis.patch.yml, not this file"）。
- **bundle**：npm 包，package.json 声明 `"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`；`loadProfile` 把每个 bundle 名**双锚点解析**（先 dsh 安装、后 profile 目录），列出的包无 bundle 声明 → fail loud。
- **模板**：`PROFILE_TEMPLATES = {web:[base,web-app], headless:[base,headless]}` 首次使用自动 `initProfile`；其他名字 fail loud 直到 `dsh plugin --profile <name> add <pkg>`（转发 pnpm，cwd=profile 目录，之后 reconcile bundles）；`DEFAULT_PROFILE_BUNDLES=[base]`。`normalizeShippedProfile` 把「安装完全拥有的 bundle 元组」（如 headless 曾=base+web-app+headless）规范化回 shipped 模板，其余字段保留；用户改动过的列表保持用户所有。
- **模块解析契约**：`healProfilesModuleFallback(installAnchor)` 维护 `$DSH_HOME/profiles/node_modules/` **扁平 symlink 农场**——BFS 安装闭包（app manifest 的 dependencies+peerDependencies）给每个包建一个 symlink，使任何 profile 通过 Node parent-walk 解析到安装内包，**pnpm 不管理 in-box 包**；profile 自己的 node_modules 只放 out-of-tree 插件。
- **composeEntries(layers)**：`applyEntryPatches([], layers.flat(), warn)` —— 与 boot 完全相同的调用，flag 推导/dump 不可能与运行时漂移。

---

## E. 插件清单/发现机制

- **`<dsh-host-plugin-inventory>`**：Remote-only Cordis 服务 `pluginInventory`（inject `loader`）；每次调用**实时遍历 `ctx.loader.entries()` 做只读投影**，只透出 `entryId/moduleName/enabled/fiberPhase` 四字段。**清单既不扫描 node_modules、也不读 package.json 字段——它就是 Loader 树的当前状态**（"已配置且可加载"的插件 = 启用的行 + 名字可解析）。
- `typert.host.js`/`typert.remote-client.js` 是 DSH 自有 RPC 协议（`dsh-typert-protocol`/registry/loader）自动生成的 Host 侧 FaceModel 与 Client 侧 Remote 描述符；浏览器经 `./remote` + api-remotes 组装层消费。详见补充 2。
- 真正的"插件发现"在 **Loader 的模块解析**：`cordis:` builtins / 相对路径 / 裸包名（Node 内部 ModuleLoader + `bareModuleBaseUrl` 锚定安装树）。
- 客户端侧发现：`<dsh-client-modules>` 的 Node 半区**增量扫描已启用的 loader 条目** → 解析各包 package.json 的 `dsh.client`（platform:"web"）与 `exports["./client"]` → 哈希 bundle → 组 `window.__DSH_BOOT__` 图 → index-tap 注入内联 JSON（head 第一个 script）+ 伺服 `/plugins/<id>/client.js?rev=`。浏览器半区 `ClientModuleSystem` 是惰性 CJS 模块表（执行只注册 factory，物化才跑副作用）。**同名包双入口**（main=host 插件，./client=浏览器 bundle）使 host 插件与其 client bundle 按包名一一映射。详见补充 1。

---

## F. 存储与工作区抽象

四包一条依赖链：**storage（中心）→ storage-json（介质后端）→ storage-domain（领域数据形式）→ workspace（业务实体注册表）**。全部宿主侧、模型不可见。详见补充 3。

- **`<dsh-storage>`**（`ctx.storage`，无 Config）：`BackendRegistry.register(name, backend)→disposer / get / names`；`mount(form, facility)`；契约 `StorageBackend{kv?: KvFacet; close()}`、`KvUnit{loadAll/putRecord/deleteRecord/setGlobal/close}`（unit 名 `^[a-z][a-z0-9_]*$`）；`StorageError` codes（backend-not-found/form-not-mounted/duplicate-backend/version-mismatch/malformed-medium/closed）；`storageBackendServiceKey(name)` → `storage.backend.<name>` 生命周期服务键（domain 层 `ctx.inject(["storage.backend.json"])` 等后端注册）。
- **`<dsh-storage-json>`**（name=storage-json，inject `["storage"]`，Config `{root}`）：每 unit 一个 `<name>.json`，root 按需 mkdir 0o700；内存状态权威，每次写 = 临时文件+fsync+原子 rename（POSIX 再 fsync 父目录），失败回滚内存并删临时文件；ENOENT → 空单元首次写物化；**无跨进程锁**（last-write-wins）。
- **`<dsh-storage-domain>`**（name=storage-domain，inject `["storage"]`，Config `{backend 必填, routes}`）：`ctx.storageDomain` = `ctx.storage.domain`；`defineDomain`（zod 校验）→ `open(spec)`（already-open 去重 → 路由选后端 → kv.open → 逐条校验）→ Domain；写链：先持久后端 → 改内存 → `emit("domain/changed")`；`KvTable.get/put/delete/update(原子RMW)`、`DomainGlobal`；`DomainError`（already-open/facet-unsupported/invalid-record/missing-key/closed）。
- **`<dsh-workspace>`**（`ctx.workspaceRegistry`，static inject `["storageDomain","sessionPersistence"]`，无 Config）：**不是会话 cwd**，而是"已存在目录的持久注册 + 会话分组账户"；id 为 UUID 品牌，路径 `fs.realpath` 规范化后唯一；`create/get/list/delete/archiveSession/insertBefore/resolveByPath`；会话归属规则：session header 的 `cwd` realpath 必须等于 workspace.path 才计入；持久化到 domain `workspace`（version 2，global=initialized/workspaceIds/archivedSessionIds/pendingMutation，table=workspaces），create/delete 前写 pendingMutation，启动只补完标记所指变更（崩溃一致性）。
- **组装**（`<web-app>/cordis.patch.yml` insert，行序 + inject 双保险）：`storage → storage-json(root: !!js dshHomePath('storages')) → storage-domain(backend: json) → workspace`。运行时产物可见于 `~/.dsh/storages/{session_projcache,workspace,message_feedback}.json`。
- 每包有 `*-invariant` 伴生插件（inject `["invariants"]`）做运行时一致性检查——这是贯穿 DSH 的通用模式（`dsh-invariants` + `dsh-brand` 服务）。

---

## G. 哪些是「架构能力」值得移植，哪些是 DSH 特有耦合

### 高移植价值（建议优先）

1. **声明式插件树 + 分层 patch 组合**（A2/C）：应用 = 有序 patch 层（bundle/profile/home/overlay），行级 id-targeted 覆盖/禁用/insert；离线 dump 与运行时同一算法。这是把"可扩展应用"做成"可组合文档"的核心——pi agent 平台的多功能组装可直接照搬。
2. **服务可用性驱动的激活 + DI**（B）：插件只声明 `inject`，不关心启动顺序；fiber 生命周期 + effect 自动清理。移植成本低、收益极高（多工具/多后端插件化）。
3. **事务性配置热更**（A6/C）：EntryGroup diff + 回滚 + last-good-tree 保底 + watcher 驱动重组合。移植要点是"配置即状态、热更即事务替换"。
4. **isolate/intercept 作用域**（B）：单进程内多租户（每会话一个 agent）的服务隔离与配置拦截——pi 平台多会话/多 agent 场景直接命中。
5. **schemastery schema 驱动**（B）：配置校验 + 客户端表单 + dump 的单一事实源。
6. **启动审计 fail-loud**（A3）：`assertEntriesActivated`（无 fiber/FAILED/PENDING 逐一归因）——"宁可亮失败，不可静默半活"，移植成本低。
7. **`!!js` 惰性表达式**（B/C）：配置里按条目 ctx 求值的表达式（如 `!!js ctx.webStartup.port ?? 3080`）。机制值得借鉴，但移植时应换成沙箱求值器（原实现是 `with(ctx){eval()}`，有安全取舍）。

### 中等价值（机制可借鉴，需适配）

8. **profile + bundle + symlink 农场**（D）：双锚点解析 + 扁平 node_modules fallback 解决"安装内插件 vs 用户插件"的模块解析契约——解决可扩展平台依赖解析难题的好方案。
9. **模块级 HMR 事务**（A6）：清双缓存→重 import→回滚，与 Vite/webpack 的 accept 机制完全不同，值得作为"框架热更"参考。

### DSH 特有耦合（移植时按需裁剪）

- `$DSH_HOME`/profiles 布局、`dshHomePath`、agent-presets（每会话组合 agent 的 preset 体系及其 host-plane 所有权分析）、telemetry 开关、settings.yaml 热更。
- **cordis.yml 空根 + 每次重写防写回污染**：DSH 用法，一般平台不需要。
- **typert RPC 协议**、`window.__DSH_BOOT__`、`dsh.client` 双入口（`main`+`exports["./client"]`）：DSH 特有，但"同名包双入口"形态值得借鉴。
- **浏览器侧 cordis**（`<dsh-client-runtime>/lib/client.js` 10543 行是 cordis 的浏览器移植，HTTP-up/WebSocket-down 传输、SlotRegistry 插槽注入）：DSH 特有的大工程，移植成本高。
- **Node 内部 ModuleLoader 依赖**（`node-addon-require-builtin`）：与 Node 22–24 版本深度耦合，一般平台用普通 import/require 即可。

---

## 补充 1：dsh-client-runtime / dsh-client-modules（浏览器客户端运行时与模块注册机制）

### 一、dsh-client-runtime —— 浏览器端运行时形态

**形态**：双入口 npm 包。`main → lib/index.js` 是 host（Node）侧插件体——`lib/types/index.d.ts` 明说 "Host plugin body — no host-side behavior"，`apply(_ctx)` 是空操作。真正的浏览器运行时在 `./client → lib/client.js`。该文件**不是源码模块，而是 tsdown 产出的浏览器 bundle**：整文件是 `window.__ModuleLoader__.load({ id: "@deepseek-ai/dsh-client-runtime", factory: (require) => {...} })` 注册调用，10543 行主体都在 factory 闭包内。bundle 内只直接 `require` 两个模块（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`）；其余依赖（connection/typert/api-remotes 等）都是 external，经 cordis 服务访问而非 require。

**dsh.client 声明**（package.json）：`{ inject: ["@deepseek-ai/dsh-client-connection", "@deepseek-ai/dsh-typert-registry", "@deepseek-ai/dsh-api-remotes"], platform: "web", immediately: true }`。

**与 host 通信**（经 dsh-client-connection，描述即 "HTTP-up/WebSocket-down client, dual streams with reconnect"）：
- 上行 = HTTP fetch：`/api` 路由（host 侧 node:http↔fetch bridge），unary/respond RPC（RpcRequest/RpcResponse/RpcResult/RpcError），通用逻辑通道 `ClientConnectionRpc.call(channel, endpoint, payload, signal)`。
- 下行 = 两条单向 WebSocket downlink：`/api/events.mux`（mux 帧流）、`/api/events.host`（host 帧流）；非浏览器走 SSE。客户端消息是协议违规，上游只在 HTTP。
- `ConnectionHandle = { api: IApiClient, isLoopback, hostDescription, rpc, start(sinks, config) }`。runtime 的 apply 是流的唯一消费者，`connection.start({ onMuxEnvelope, onHostEnvelope, onConnected, onStateChange })` 把共享 host 流分发给 Session/Workspace。

**Typert RPC**（dsh-typert-protocol/registry/api-remotes）：`ctx.typert.contexts.registerClient("agent", { identity: (c) => sessions.scopeOf(c) })`（client Agent scope 与 session 共用 wire id，`TypertContextMap.agent: TypertContext<SessionId>`）；`ctx.remote`（TypertClientRemote）提供 `$mount(contribution)` / `$on(event, listener)`（订阅 host 转发事件）/ `$dispatch(event, args)`（wire 边界）。apply 里 `frame.type === "host/remote-event"` → `ctx.remote.$dispatch(frame.event, frame.args)`；各领域包用 `ctx.remote.$on` 订阅自己的 owner 事件。

**客户端服务/API**：`inject = ["connection", "typert", "remote", "remote.commands"]`（cordis 服务依赖）。apply 挂载：`ctx.plugin(SlotRegistry)`、`ConversationEventRegistry/ConversationViewRegistry`、`SessionRuntime(ctx, connection.api, ctx.remote, conversation)`、`WorkspaceRuntime(ctx, connection.api, sessions)`、`startInitialSelection()`、连接流 loop（ctx.effect 卸载）。Context 合并：`ctx.slots`、`ctx.conversationEvents`、`ctx.conversationViews`、`ctx.sessions`（ISessions 外表面）、`ctx.workspaces`；事件 `slots/changed(key)`、`connection/reset()`。关键类：SlotRegistry（声明注入 `inject(key, callback)`、renderer 安装）、SessionRuntime（Session 对象/列表镜像/scope 状态，会话一律 host 创建，持有 ProjectionValueStore 按 seq 高者胜）、WorkspaceRuntime（`connectWorkspace()` New Session 复用、`archiveSession()`）、ConversationNodeAssembler/LocationIndex（事件→节点组装）、createSnapshotStore/defineStore、useProjection、SessionProvideChannel、PendingWait（approval/plan-review/question）。UI 契约：SlotMap 声明 + SessionStandardProps{useSession, sessionId, useProjection} / GlobalStandardProps{useSessions, useWorkspaces}。

### 二、dsh-client-modules —— 模块注册机制（双面包）

**双面结构**：Node 半区 `main → lib/index.js` = `ClientModuleRegistry extends Service`（`inject: ["webServer", "loader"]`），描述即"增量 dsh.client 扫描 + __DSH_BOOT__ 组合 + bundle 路由 + index tap + clientModules 服务"。浏览器半区 `./client → lib/client.js`（189 行）= ClientModuleSystem 实现 + parseBootManifest + enroll 插件。**bootstrap 例外**：模块系统由 shell 内核在 cordis 存在之前构造（装插件的机制不能经由自己到达），`apply(ctx)` 只 `ctx.reflect.provide("modules", modules)`（从 `window.__DSH_MODULES__` 取实例）；内核静态注册本包，故其图行永不触发真实 fetch。

**manifest 结构**（lib/types/client/manifest.d.ts）：
- `WebBootEntry = { id（==包名）, url（'/plugins/<id>/client.js?rev=<rev>'）, rev（sha1 12hex 短哈希）, inject?: string[]（信息性边）, immediately?: boolean（一阶段预取）}`
- `WebBootGraph = { rev, entries: WebBootEntry[] }` — 注入为 `window.__DSH_BOOT__`
- `parseBootManifest(wire): BootManifest` — 一份 wire 拆两个消费视图：`modules: BootModuleRow[]`（模块表）+ `plugins: BootPluginRow[]`（entry 组合，inject 归一 []、immediately 归一 false）
- `ClientPluginHandoff = { id, factory(require) }`；`DshWindow = { __DSH_BOOT__, __ModuleLoader__.load, __DSH_MODULES__ }`
- `ClientModuleLoader`（挂 ctx.modules，vendored cordis Loader 经 internal 契约消费，唯一调用点 `EntryTree.import → internal.import`）：`version='client'`、`loadCache: Map<string, ClientModuleRecord>`、`import(specifier, parentURL, attrs)`、`registerStatic`、`prefetch`、`invalidate`。`ClientModuleRecord = { id, exports, styles[], edges: Set }`

**惰性 CJS 模型**：执行 bundle 只注册 factory（`window.__ModuleLoader__.load`）；副作用（含 CSS 注入）在物化时 `factory(require)→exports`，memoized 于 loadCache；递归物化使加载顺序自洽，require 循环致命。import 解析分支：seed 词 → loadCache → statics（app-shell 等 shell 自有模块）→ 已注册 factory→物化 → 图行→prefetch(动态加载 classic script)+物化 → 否则 throw（构建时 bundle 纯度门禁的运行时镜像）。factory 拿到的同步 require 走同序不含异步加载分支；`<id>/client` 与裸 id 归一（stripClientSuffix）。

**与打包配合**：无独立模块清单 JSON 文件——清单就是注入 index.html 的 `window.__DSH_BOOT__` 内联 JSON（`<` 转义 \u003c 防 script 逃逸），作为 head 第一个 script 先于 shell bundle。每个声明 dsh.client 的包用 tsdown 打独立 bundle（`scripts.bundle: "tsdown"`，产物即上述 load 注册文件）。bundle 经同源 `<script src="/plugins/<id>/client.js?rev=...">` 动态到达，rev 是缓存破坏一致性锚；HMR（dsh-client-hmr）用 `rebuilt()` 重哈希 + `invalidate()` 强制重载。

**Node 半区扫描**（增量、无全量重扫）：监听 cordis `internal/plugin` 发射 → entry name 标 dirty → 微任务 flush 逐个 reconcile；激活 pass 用现有全部 entries 播种并同步 flush，首次与稳态同一实现。`processOne`：loader 条目 fiber 存在且未 disabled → `createRequire(ctx.baseUrl).resolve('<pkg>/package.json')` → 读 `pkg.dsh.client`（parseDshClient 校验 platform/inject/immediately）→ platform≠"web" 或无声明则缓存 null 否定结论 → `clientExportOf` 读 `exports["./client"]`（字符串或 {default}）→ clientPath=dirname(pkgJson)+rel → 哈希 → graphRow；缺 bundle 抛 MissingClientBundleError（提示 `pnpm run build`），激活期聚合成 ClientPackageCompositionError。pkgMeta 按包名缓存永不过期（插件集合变化需重启；bundle 内容变化只能经 `rebuilt()`）。`compose()` 序列化 entries 短哈希得整图 rev。注册 `/plugins` prefix 路由（serveBundle，GET/HEAD，no-cache）+ `ctx.webServer.tapIndex(html => injectBootManifest(html, composed))`。

### 三、与 host 插件的关系（同名包双入口）

同一 npm 包两个入口：`main`（lib/index.js = host 插件体，Node loader 加载；runtime 的 host 半区是空操作）+ `exports["./client"]`（lib/client.js = 浏览器 bundle，由 client-modules 解析同一 package.json 并经 /plugins 伺服）。图行 id == 包名 == 模块表 key == factory 注册 key，host loader entry name 与 client bundle id 同命名空间，host 插件与其 client 半区一一映射；inject 边包名（如 dsh-api-remotes）同时是 host 插件名与其 client bundle 名。客户端插件间通过 cordis 服务协作（connection/typert/remote），跨插件值 import 是构建错误。

**Boot 全链路**：host 启动 → loader 激活 → ClientModuleRegistry 激活扫描组图 → tap index 注入 `__DSH_BOOT__` → 浏览器加载页面 → shell 内核（cordis 前）parseBootManifest 构造 ClientModuleSystem（装 `__ModuleLoader__`、存 `__DSH_MODULES__`）→ boot vendored cordis → enroll 插件 apply 提供 ctx.modules → vendored Loader 按 fiber/inject 等待激活各 entry → `EntryTree.import` → `modules.import` → prefetch 脚本 → factory 注册 → 物化 → 插件 apply → dsh-client-runtime 挂服务并 start 连接流（HTTP up + 两条 WS down：/api/events.mux、/api/events.host）。

**对移植的意义**：①「bootstrap 例外 + 注入自举（__DSH_MODULES__）」是插件系统自举的通用范式；②「清单 = 内联 JSON + rev 哈希 + 惰性 factory 注册」是浏览器侧模块联邦的轻量实现；③「同包双入口 + 增量扫描 enabled loader 条目」让客户端插件集合自动跟随服务端配置，无需单独的前端插件清单——"配置驱动全栈插件"的关键拼图。

---

## 补充 2：dsh-host-plugin-inventory（插件清单/发现机制细化）

【定位】Host 侧"只读投影"包，源码 packages/host/plugin-inventory；只依赖 zod ^4.4.3；peer 依赖 cordis-plugin-loader ^1.0.2、dsh-typert-protocol、dsh-brand、dsh-invariants、cordis ^4.0.1。package.json 无 dsh.plugin/dsh.bundle/dsh.client 字段。

【实现形态】`PluginInventoryGateway extends TypertRemoteService`（typert RPC 的 Host 侧基类），`static inject=['loader']`，服务名 `pluginInventory`，唯一方法 `list(): PluginInventorySnapshot` 用 `@Remote('list')` 装饰器声明（wire id `'@deepseek-ai/dsh-host-plugin-inventory#pluginInventory/list'`，kind 'direct'、无参、zod strict 校验）。返回 `{ entries: { entryId: Branded<'PluginEntryId'>, moduleName, enabled, fiberPhase('pending'|'loading'|'active'|'failed'|'unloading'|null) }[] }`。

【清单来源】既非扫描 node_modules，也非读 package.json 字段，而是每次调用实时遍历 `ctx.loader.entries()`（Loader 的 EntryTree 生成器）。规则：跳过 `entry.options.group` 为真的行；`entryId=entry.id`；`moduleName=entry.options.name`（模块说明符）；`enabled=!entry.disabled`（含祖先组禁用的有效态）；`fiberPhase` 由 `FiberState` const enum 映射（DISPOSED→null）。Loader 是唯一生命周期权威，本包无缓存/历史/订阅/变更路径——**点时刻快照**。只透出 entryId/moduleName/enabled/fiberPhase 四字段，不含描述、config schema、inject、client 部分（README 原文确认——那些属插件模块自身，不在投影内）。

【客户端消费】Remote-only，无同进程 Context merge，不 import Host 实现；走 exports 的 `./remote`，由 api-remotes 组装层（packages/api/remotes）收集各包 `TYPERT_REMOTE` 注册进 client registry；`typert.remote-client.js` 的 `.d.ts` 用 module augmentation 把 `pluginInventory.list` 注入 `TypertRemoteMap`/`TypertRemoteNamespaceMap` 供客户端类型安全调用。浏览器经 `TypertRemoteMap['pluginInventory/list']` 或 `pluginInventory.list()` 拿 zod 校验过的快照。无独立 manifest/client bundle 文件。

【对移植的意义】「宿主内部状态 → 类型化只读 API」的最小范式：服务端零额外状态、零缓存；客户端类型由生成式描述符 + module augmentation 保证；如需在 pi 平台提供"当前已启用能力清单"，可照抄这个形态（服务 + @Remote + 实时投影 + 生成式客户端类型）。

---

## 补充 3：dsh-workspace / dsh-storage / dsh-storage-json / dsh-storage-domain（存储与工作区细化）

核心结论：storage（中心/注册表）→ storage-json（介质后端）→ storage-domain（领域数据形式）→ workspace（业务实体注册表）层层叠加；workspace 通过"域 + session header cwd"把会话分组到目录，纯宿主侧，模型不可见。

### 1. dsh-storage —— 存储中心（hub）

- 插件形态：导出 `Storage` 类（extends Cordis `Service`，服务名 `"storage"`），`export default Storage`；无 name/inject/Config（Service 类插件经 `ctx.plugin` / cordis.yml 行实例化）。peerDeps 仅 cordis + dsh-invariants。
- 服务接口 `ctx.storage`：
  - `backend: BackendRegistry` —— 名称→后端表：`register(name, backend): () => void`（返回 disposer，重复名抛 `duplicate-backend`；disposer 不 close 后端）、`get(name): StorageBackend`（未知抛 `backend-not-found`）、`names(): string[]`。
  - `mount(form, facility): () => void` / `form(form)`（重复挂载 `duplicate-mount`，未挂载 `form-not-mounted`）；`get domain` → `form("domain")`。`StorageForms` 空接口靠声明合并扩展（storage-domain 合并 `domain: DomainFacility`）。
  - 辅助 `storageBackendServiceKey(name)` → `"storage.backend.${name}"`：后端插件用 `ctx.provide` 提供的"生命周期服务键"，domain 层 `ctx.inject` 它以保证后端先注册，调用方仍走 registry。
- 后端契约（backend.d.ts）：
  - `StorageBackend { readonly kv?: KvFacet; close(): Promise<void> }` —— 一个后端拥有一块介质；分面（facet）是可选成员，kv 是当前唯一分面。
  - `KvFacet.open(descriptor: KvUnitDescriptor): Promise<KvUnit>`。
  - `KvUnitDescriptor { name; version; tables; hasGlobal }`，name/table 必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（文件名/SQL 标识符双安全）。
  - `KvUnit { loadAll(): Promise<{tables, global}>; putRecord(table,key,value); deleteRecord(table,key); setGlobal(value); close() }`。值对层不透明（无 schema/事件）。unit 不串行化并发写——写入顺序归调用方（domain 层每 unit 一条写链），单次调用原子且持久；close 后调用抛 `closed`。
- 错误模型：`StorageError`，`code: 'backend-not-found'|'form-not-mounted'|'duplicate-backend'|'duplicate-mount'|'version-mismatch'|'malformed-medium'|'closed'`，code 是稳定契约，message 是诊断文案。
- 特性：hub 自身零 IO（介质归后端、语义归数据形式）；多后端并排挂载（json/sqlite），路由是消费方配置而非全局选择；form 懒解析（未挂载即抛错，fail loud）。
- invariant 伴生：`storage-invariant`（inject `["invariants"]`）。

### 2. dsh-storage-json —— JSON 文件后端

- 插件：`name="storage-json"`，`inject=["storage"]`，Config（schemastery）= `z.object({ root: z.string().required() })`——root 必填无默认（避免 cwd 回退散落文件）。
- `apply(ctx, config)`：构造 `JsonStorageBackend(root)`；`ctx.effect` 里 `ctx.storage.backend.register("json", backend)`，卸载时 unregister + `backend.close()`；`ctx.provide(storageBackendServiceKey("json"), backend)`。
- 实现机制（unit.js/atomic.js/format.js）：
  - root 按需 `mkdir 0o700`（mode 448）；每 unit 一个 `<name>.json` 文件。`JsonStorageBackend` 维护 `open`/`opening` 两个 Map：同名 unit 同时只能有一个活句柄（重复 open 报错），open 在 close 时回调释放槽位。
  - 打开：readFile，ENOENT → 空 unit（首次写物化）；否则 `parse` 校验 JSON 合法、unit 头（name 匹配 + version 数值）→ 外来/不可解析抛 `malformed-medium`，version ≠ descriptor.version 抛 `version-mismatch`（无迁移，预发布立场）；tables 按 descriptor 逐一加载。
  - 原子写 `writeAtomic(path, data)`：同目录 `.${randomUUID()}.tmp` 临时文件（open "wx" 0o600）→ writeFile → `handle.sync()` → close → `rename()` 覆盖目标（POSIX 原子；Windows 由 libuv 映射 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`）→ POSIX 上再 fsync 父目录；任何失败 `rm(tmp, {force:true})` 后重抛。
  - 内存 `UnitState { version; global; tables: Map<table, Map<key,value>> }` 权威；每个写原语先改内存再整文件重发，写失败回滚内存（put 恢复旧值/删新键，delete 恢复旧值）。`publish()` 把 write 记入 `inFlight` Set，close 时 `Promise.allSettled` 排空。
  - 写不排队（README：顺序归调用方）；无跨进程锁（README 明示 last-write-wins，多进程写入暂缓；Windows 无显式 write-through 属已知限制）。
- 导出类型：format（serialize/parse/UnitState）、unit（openJsonUnit）、atomic（writeAtomic）。invariant：`storage-json-invariant`。

### 3. dsh-storage-domain —— 领域数据形式

- 插件：`name="storage-domain"`，`inject=["storage"]`，Config（schemastery）= `z.object({ backend: z.string().required(), routes: z.dict(z.string()).default({}) })`——backend 是每个域默认后端（必填，无普适介质）；routes 逐域覆盖。
- `apply`：收集 `{config.backend, ...routes}` 的去重集合映射成 `storageBackendServiceKey`，`ctx.inject(backendServices, …)` 等所有后端注册完成；构造 `DomainFacility`；effect 中 `ctx.storage.mount("domain", facility)`（卸载先 `closeAll()` 再 unmount）+ `ctx.provide("storageDomain", facility)`。于是对外两个入口：`ctx.storageDomain` 与 `ctx.storage.domain`。
- 域声明（spec.ts，zod）：`defineDomain(spec)` 校验 name/tables 匹配 UNIT_NAME_RE、version 非负整数、global schema 不得接受 null（null 是介质"从未写入"哨兵，可空 global 无法区分）；`domainTable(schema)` 声明表（phantom 键类型）；`descriptorOf(spec) → KvUnitDescriptor`（name=域 name，version=tables keys，hasGlobal）。记录 schema 用 zod（z.infer 类型 + 未来 RPC wire 投影），插件 Config 用 schemastery——两者分工明确。
- `DomainFacility.open(spec)`：`reserved` 防重（`already-open`）→ `routes[name] ?? backend` 选后端（`backend-not-found` 透传）→ 无 kv 分面抛 `facet-unsupported` → `kv.open(descriptorOf(spec))`（`version-mismatch`/`malformed-medium` 透传）→ `loadAll` + 每条记录 zod 校验（失败抛 `invalid-record`，`detail={table,key}`，global 为 table=""/key=""）→ 构造 `DomainImpl`。打开者拥有句柄生命周期（`Domain.close()` 幂等，通常作 ctx.effect disposer）；facility 卸载时 `closeAll()` 兜底。
- Domain 运行期（domain.ts）：内存权威、读同步；每域一条写链（Promise 尾链 enqueue）；**写先等后端持久（unit.putRecord/deleteRecord/setGlobal），成功后才改内存、再 `ctx.emit("domain/changed", change)`**——后端失败内存不动（读写与介质不背离）；事件在写序上携带与内存一致的值。close 流程：disposing 拒绝新写 → 排空链（已排队写仍发事件）→ unit.close → 释放名字。
- 表句柄 `KvTable<K,V>`：`get/entries/keys/size`（同步）；`put(key,value)`（整值覆盖，无部分合并）；`delete(key): Promise<boolean>`（不存在返回 false 且不写不发事件）；`update(key, fn)`（写链上原子 RMW，缺键抛 `missing-key`）。`DomainGlobal`：`get()` 同步、`set(v)`（首个 set 物化 global）。
- 事件：`domain/changed`（events.d.ts 声明合并进 cordis Events）——`DomainChanged = {domain, table(''=global), key(''=global)} & ({operation:'put', value} | {operation:'deleted', value?:never})`；进程内事件，跨进程推送（RPC frames）是后续阶段。
- 错误模型：`DomainError`，`code: 'already-open'|'facet-unsupported'|'invalid-record'|'missing-key'|'closed'`，`detail` 仅 invalid-record 携带；后端 StorageError 一律透传不重包装。
- invariant：`storage-domain-invariant`（每个 domain/changed 必须与发出域的内存状态一致）。已知限制：单进程变更可见性；无跨表事务/二级索引/多段键。

### 4. dsh-workspace —— Workspace 实体注册表

- 插件形态：导出 `WorkspaceRegistry`（extends Service，服务名 `"workspaceRegistry"`）为默认导出，`static inject = ["storageDomain", "sessionPersistence"]`（两个启动必需依赖，任一不可用则 pending、不提交 initialized 标记）；无 name/Config/apply（Service 类插件）。peerDeps 含 dsh-storage、dsh-storage-domain、dsh-session、dsh-session-persistence、dsh-brand。
- workspace 是什么：**不是**会话工作目录，也不是 dsh 的 cwd——它是"已存在目录的持久注册记录 + 会话分组账户"（实体注册表，消费方只见 `Workspace` 接口，实现包私有）。id 是生成的 UUID（`WorkspaceId` 品牌类型），**绝不用路径做引用锚**（路径规范化会改写路径）。
- 创建/选择/校验：`create(path, title?)` 用 `fs.realpath` 规范化（唯一 canon：尾斜杠/`..`/符号链接全解析），拒绝不存在（原 ENOENT）与非目录；每规范路径最多一条记录，重复创建返回现有记录不改 title；新记录前置到持久顺序。`resolveByPath(path)` 异步、缺失路径拒绝但不创建。目录选择器集成：workspace 包本身不含选择器——web 层由 `directory-picker` 行（@deepseek-ai/dsh-host-directory-picker-auto）把 GUI 选目录喂给 registry.create。`list()` 同步按持久顺序；`insertBefore(id, before?)` DOM-insertBefore 语义（源/锚不在注册表则拒绝不写，原位/自锚直接完成）；`delete(id)` 只删注册+顺序+归属，**绝不动目录/日志/活会话**（相关会话变 Ungrouped），未知 id 返回 false。
- 与 agent 会话的关系：`Workspace.sessionIds` 是"候选账户 + 头部校验"的投影——会话的 session header `cwd` 经 realpath 后必须等于 workspace.path 才计入（attachSession 校验：未知会话/无 cwd/解析失败/非目录/不匹配都拒绝不写；detach 只删账户项；insertSessionBefore 只移动账户内顺序）。归档：`archiveSession(id)`/`archivedSessionIds` 是注册表级全局归档集（保留 sessionIds 席位以便取消归档恢复原位，接受任意活/持久会话包括 Ungrouped）。`status(): 'ok'|'missing-dir'` 未缓存目录检查。
- 持久化（spec.ts）：域 `workspace`（version 2），global = `workspaceDomainState`（`{initialized, workspaceIds, archivedSessionIds (default []), pendingMutation?}`），table `workspaces`（`workspaceRecord`: path/title/sessionIds/createdAt/updatedAt）。**崩溃安全**：create/delete 先持久化 `pendingMutation` 标记（discriminatedUnion create/delete），启动 `recoverPendingMutation` 只补完标记所指变更；无标记的顺序/表不一致视为来源不明损坏 fail loud。
- 启动：`Service.init` 打开域 → recoverPendingMutation → validateStoredState → 未初始化时用 `SessionPersistence.list()` 头部（只读 id/cwd/createdAt，不读事件体）按 cwd 分组历史目录、写初始顺序、最后写 initialized 标记（部分引导写入可安全复用）→ indexLiveSessions → rebuildEntities。不变量校验：顺序无重复/无孤儿、路径单主、会话单主。
- 错误：`WorkspaceMoveInvalidError`/`WorkspaceOrderInvalidError`/`WorkspaceUnknownSessionError`（普通 Error，带相关 id 字段）。模型体验：零 token、零 KV cache 影响、不注册工具/提示词/事件（宿主侧专用）。

### 5. cordis.yml 组装（web 层 dsh-web-app/cordis.patch.yml 的 insert 组，base 层之后应用）

```yaml
- id: storage        name: '@deepseek-ai/dsh-storage'
- id: storage-json   name: '@deepseek-ai/dsh-storage-json'
  config: { root: !!js dshHomePath('storages') }        # → $DSH_HOME/storages（默认 ~/.dsh/storages）
- id: storage-domain name: '@deepseek-ai/dsh-storage-domain'
  config: { backend: json }
- id: workspace      name: '@deepseek-ai/dsh-workspace'
```

- 依赖顺序的机制（三重保险）：① cordis.yml 行序；② 插件级 `inject`（storage-json/storage-domain inject `["storage"]`）；③ 运行期 `ctx.inject(["storage.backend.json"])`（`storageBackendServiceKey`）——后端插件 `ctx.provide` 该键，domain 层 inject 它以保证 json 后端**注册完成**后才挂载 domain form；workspace 则 `static inject=["storageDomain","sessionPersistence"]` 等 form 与会话持久化（后者是 base 层行 `session-persistence-jsonl`，root: dshHomePath('sessions')）。form 懒解析：未挂载时读 `ctx.storage.domain` 抛 `form-not-mounted`。
- `dshHomePath` 来自 @deepseek-ai/dsh-home-paths：解析显式配置 > $DSH_HOME（空值视为未设）> ~/.dsh，再 join 段；所有用户数据单根存放。
- invariant 伴生插件（storage-invariant / storage-json-invariant / storage-domain-invariant / workspace-invariant，均 inject `["invariants"]`）通过 `ctx.invariants.register(PACKAGE_NAME, install)` 挂运行时一致性检查（如 workspace 的"domain/changed 删除/落盘必须与实体缓存一致"、domain 的"事件快照必须等于内存读"）——DSH 把"不变量"做成可插拔服务、随 fiber 生命周期装载/卸载的通用做法。

### 6. 分层原则一句话

storage（hub，零 IO，只做注册表与契约）→ storage-json（介质后端，内存权威+原子写+回滚）→ storage-domain（数据形式：schema/校验/事件/写链）→ workspace（业务实体：注册表+会话分组+崩溃恢复）。每层只依赖下一层接口，后端可并排挂载（json/sqlite），路由是消费方配置而非全局选择——这是"存储可替换"的干净分层，pi 平台若需多介质/多租户存储可直接照搬。

---

## 补充 4：cordis-plugin-hmr / cordis-plugin-group / cordis-plugin-include（三个官方插件机制细化）

源码路径（pnpm store 内，均 type=module，读 src/*.ts）：
- HMR: `@deepseek-ai+cordis-plugin-hmr@1.0.16` → src/index.ts(576行) + src/error.ts(36行)
- Group: `@deepseek-ai+cordis-plugin-group@1.0.1` → src/index.ts(3行)
- Include: `@deepseek-ai+cordis-plugin-include@1.0.6` → src/index.ts(377行)

### 1. cordis-plugin-hmr —— 服务端插件级 HMR

**一句话职责**：HMR 服务插件，用 chokidar 监听源码目录，追踪 Node 的 ESM/CJS 模块图，清缓存后事务性地只重载"依赖了变更文件的插件条目"；框架级（externals）变更则 `loader.exit()` 整体重启进程。

**关键导出（精确签名）**：
- `class Hmr extends Service`，`static inject = ['loader', 'timer']`，注册 `ctx.hmr` 服务；构造时要求 `--expose-internals`（`ctx.loader.internal` 必须存在），否则抛错。
- `async registerConfig(filename: string, refresh: () => Promise<void> | void): Promise<() => Promise<void>>` —— 在模块根之外注册"精确路径"配置监听；返回异步 disposer；HMR 未激活 / 路径已注册 / watcher 启动失败时抛错。**注意：没有 registerModule 之类的 API，唯一对外注册 API 就是 registerConfig。**
- 配置 `Hmr.Config = ChokidarOptions & { base?: string; root: string[]; debounce: number; ignored: string[] }`（schemastery z 对象）：root 默认 `['.']`，ignored 默认 `['**/node_modules','**/.*','cache','data']`，debounce 默认 100ms。
- 广播事件（在 `@deepseek-ai/cordis` 的 Events 上扩展）：
  - `'hmr/change'(url: string): void` —— 无法归入插件重载/配置重载的变更文件
  - `'hmr/reload'(reloads: Map<Plugin, Reload>): void` —— 重载完成后
  - `'hmr/config-update-failed'(filename: string, error: Error): Promise<void> | void`（`@mode parallel`，即用 `ctx.parallel` 并行分发）—— 配置刷新失败
- 内部类型：`interface Reload { filename: string; runtime?: Plugin.Runtime }`；`error.ts` 导出 `handleError(ctx, e)`：对 esbuild `BuildFailure` 用 `@babel/code-frame` 的 `codeFrameColumns` 打印带高亮代码帧，其它错误只 warn。

**关键机制**：
1. **三类变更分流**（`Service.init` 里注册主 watcher，`ignoreInitial: true`，ignored 用 picomatch 相对 baseDir 匹配）：
   - 配置类文件：遍历 `loader.entries()`，若某 include 条目的 `subtree.filename` 匹配 → `refreshConfig(include, filename, () => include.refresh())`；
   - externals（= CLI worker 入口 `process.argv[1]` 的完整依赖树，启动时用 `loadDependencies` 预收集）→ `loader.exit()` 全量重启；
   - 在 `loader.internal.loadCache` 里的模块（Node 24 下 CJS 经 import() 也会进 loadCache）→ 存入 `stashed` 集合并 debounce 触发 `partialReload`；
   - 其它 → `ctx.emit('hmr/change', url)`。
2. **配置刷新串行化**（refreshConfig）：`dirty` 标志 + 单飞 `running` promise，do/while 合并 burst；失败时 warn 并 `ctx.parallel('hmr/config-update-failed', filename, error)`。
3. **变更分类**（`analyzeChanges`）：`accepted` = stashed 及其所有依赖者（沿 `job.linked` 子模块图向上传播）；`declined` = externals + "所有依赖者都被 declined" 的文件；未定文件反复迭代直至收敛，剩余归 declined。
4. **重载粒度 = 整个插件条目**（原子单位）：从 loader entries 收集每个配置树的插件名（nameMap），用 `_resolve`（兼容 ModuleLoader v1 `resolve`/v2 `resolveSync`，适配 Node 22–24）解析成 URL，跳过 declined；再对每个待定插件的依赖树做 `loadDependencies`，只要有任一依赖在 accepted 里就把该插件加入 `reloads`（并把它整个依赖树并入 accepted）。
5. **事务性替换 + 回滚**：
   - 先把所有 accepted 文件的模块缓存备份并清掉：ESM `loadCache` 用 `Map.prototype.get/delete` 直接操作（Node 22/23 是普通 Map；Node 24 的 `LoadCache.delete` 只把类型槽置 undefined，必须绕过）；CJS `require.cache`（经 `createRequire`）同样备份删除。`rollback()` = 原样恢复两套缓存。
   - 然后对 reloads 的插件入口文件**全部重新 import（all-or-nothing）**；任一个构建失败 → `handleError` 打印代码帧并 `rollback()` 恢复缓存，旧插件原样继续。
   - 替换顺序：先 `ctx.registry.delete(plugin)` 释放旧插件（runtime 的旧 fiber 都挂掉），再对每个旧 fiber 执行 `reload(attempts[filename], runtime)`：`oldFiber.parent.registry.plugin(新插件, oldFiber._config, getOuterStack)` 用**旧的 config 与同一个 entry** 重建 fiber（`fiber.entry = oldFiber.entry`）。任一失败 → 再次 `rollback()` 恢复缓存 + 删除刚注册的 attempts + 重新 `reload` 旧插件（恢复旧实例）。
   - 成功则 `ctx.emit('hmr/reload', reloads)` 并清空 stashed。
6. **registerConfig 细节**：`findWatchRoot` 把要监听的路径向上找到**最深存在的目录**做 realpath 规范化，再按相对路径补回缺失后缀，用受限 depth 的独立 chokidar 实例监听（`ignoreInitial: false`——注册时已有的用户补丁层必须 apply 一次）；disposer 里 `watcher.close()` 并等 `configRefreshes.running` 排干。
7. **防死锁细节**：主 watcher `ignoreInitial: true`，注释明确说明——boot 刚消费完的初始扫描若重新广播 add 事件，会在 include 的 init apply 尚未落地时触发 refresh，导致刷新等 apply、apply 失败又回滚插件，形成 teardown 死锁。

### 2. cordis-plugin-group —— loader Group 的纯再导出

**一句话职责**：把 loader 的嵌套插件组类 `Group` 原样再导出成独立包（整个包就是 3 行 import+export），让用户无需依赖 loader 本体即可声明嵌套组。

**源码（完整）**：
```ts
import { Group } from '@deepseek-ai/cordis-plugin-loader'
export default Group
```

**与 loader EntryGroup/isolate 的关系**（读 `cordis-plugin-loader@1.0.2` src/config/group.ts 确认）：
- `class EntryGroup`：一组子 loader 条目的运行时属主，`static readonly key = Symbol.for('cordis.group')`；构造时把 `ctx.fiber.entry.subgroup = this`（挂到父条目上）；API：`create(options)`（经 `tree.ensureId` 稳定 id，可把条目从别的组移过来，失败回滚父引用/store）、`unlink/remove/stop`、`update(config)` —— **事务性**：`Promise.allSettled` 逐个 create，任一失败则反向删除新增 id、重建旧配置，失败聚合为 `AggregateError`。
- `class Group extends EntryGroup`：`static initial`（默认配置）+ `static readonly [EntryGroup.key] = true`（树载体标记，loader 的 `internal/config` 钩子见 `plugin?.[EntryGroup.key]` 就跳过配置插值）；构造时订阅 `ctx.on('internal/update', config => this.update(config))`；`Service.init` async generator 在 dispose 时先 `stop()` 子条目再 apply 配置。
- **isolate 与 Group 是两回事**：isolate 是 loader 的另一个特性（src/config/isolate.ts，条目选项 `isolate?: Dict<true | string>`），用 `Context.isolate` Symbol realm 按条目/标签隔离服务实现，`isolate(ctx)` 安装 loader 钩子。Group 只管"条目列表嵌套"，isolate 管"服务作用域"。本包只再导出 Group，不含 isolate。

### 3. cordis-plugin-include —— 文件背书的 EntryTree

**一句话职责**：`EntryTree` 子类，把 YAML/JSON 配置文件当作一棵 loader 条目树的持久化来源：带 `!!js` 表达式方言、`applyEntryPatches` 运行时补丁算法、事务性应用、以及写回配置文件。

**关键导出（精确签名）**：
- `export default Include`（`class Include extends EntryTree`，`static inject = ['loader']`，`static readonly [EntryGroup.key] = true` 树载体标记）
- `export function applyEntryPatches(data: EntryOptions[], patches: PatchOptions[] | undefined, warn: (message: string, ...args: any[]) => void): EntryOptions[]`
- `export const entryListSchema`（= `yaml.JSON_SCHEMA.extend(JsExpr)`，JsExpr 是 `tag:yaml.org,2002:js` 的 yaml.Type）
- `export interface PatchOptions { id?: string; insert?: EntryOptions[]; name?: string; config?: any; group?: boolean | null; disabled?: boolean | null; inject?: any; intercept?: any; isolate?: any; [key: string]: any }`
- 配置命名空间 `Include.Config { path: string; initial?: any[]; patches?: PatchOptions[]; enableLogs?: boolean }`

**补丁算法（applyEntryPatches）**：
- 输入永不被改：先 `structuredClone(data)` 脱钩——否则共享条目对象会把旧值"烤进"缓存解析，热重载永远无法回退已删/已改的补丁。
- `buildMap` 递归（含 `entry.group && Array.isArray(entry.config)` 的嵌套）建立 id → 条目 索引。
- 逐条按序应用：
  - `insert` 补丁：带 id → 目标必须是 group（否则 warn 跳过），把 `insert` 列表 push 进 `target.config`；不带 id → push 到根列表；随后**立即 `buildMap(insert)` 重新索引**，让同列表后面的补丁能定位刚插入的行（补丁按层组合：每个 bundle 层 → 用户层 → `--patch` 覆盖层）。
  - 非 insert 补丁：无 id → warn 跳过；id 找不到 → warn 跳过；`name` 与目标不符 → warn 跳过；其余键（除 `id`）直接覆盖 `target[key]`。

**`!!js` 表达式求值时机（关键）**：include **自己不求值**。`!!js` 标量（yaml.Type `tag:yaml.org,2002:js`，kind scalar）只被构造为 `{ __jsExpr: string }` 节点，represent 原样写回。因为 Include 带 `[EntryGroup.key] = true` 树载体标记，loader 的 `internal/config` 全局钩子（src/index.ts）对树载体条目**跳过 `interpolate`**，保持其配置字面化——嵌套行的 `!!js` 属于该行自己的 fiber。求值发生在**每行条目激活/取配置时**，由 loader 的 `interpolate(ctx, value)` 递归替换 `{__jsExpr}` 节点：`evaluate = new Function('ctx','expr','with(ctx){ return eval(expr) }')`，在**该行自己的 ctx**（含服务、其它条目配置）作用域内 eval。另有特例：Entry 的 `disabled` 字段在 `get disabled()` 里直接 `Boolean(this.evaluate(options.disabled.__jsExpr))`（src/config/entry.ts:105-106）。

**文件/生命周期机制**：
- 支持 .json/.yaml/.yml（mime 表决定 parse 与 writable 类型），其它扩展名构造即抛错；`ctx.baseUrl` 被重置到配置文件所在目录。
- `internal/update` 监听：`config.path` 匹配时入队 `applyPatches(this.data, config.patches)` + `root.update` + 换 config —— 支持配置里 patches 热更。
- `applyQueue`（enqueue）：**所有 apply 路径串行**——group 的事务性 update 不可重入，init apply 与 HMR 初始扫描触发的 refresh 并发会互相穿插 create/rollback 把 fiber 卡死；前驱失败只归调用方，不阻塞后继。
- 启动：`read(true)` 强制读；ENOENT 且配了 `initial` → `_writeFile(initial)` 落盘再读，否则抛 "config file not found"；dispose 时 `stop()` = `root.stop()` + `flushWrite()`。
- `refresh()`（HMR 调用）：在队列内重读，内容未变直接返回，变了 `_apply`：`applyPatches` → `root.update(data)`（**事务性，回滚成功则上一棵好树保持激活**）→ 记录 content/data → `checkAccess`。
- **写回**：`_writeFile` 先写 `filename.tmp` 再 `rename`，对 EACCES/EBUSY/EPERM 重试最多 10 次（递增退避 50ms）；`writeFile` 用 setTimeout(0) 合并 + `writeQueue` 串行；`write()` 先 emit `loader/config-update` 再调度写 `root.data`。写回回路：loader 的 `internal/update` 全局钩子把新 config 写回 `entry.options.config` 并调 `entry.parent.tree.write()`，从而把运行期配置改动持久化回文件。`checkAccess` 探测 W_OK，不可写则 readonly，写时抛错。
- 错误类型 `ConfigFileError` 带 stage：`'read' | 'parse' | 'validate'`。

### 4. 官方 include 包 vs dsh-app-boot 内嵌版差异（已逐段比对）

dsh-app-boot@0.1.0-rc.6 的 lib/index.js 中 `//#region ../../../vendor/include/src/index.ts` 段就是官方 include 源码打进 bundle 的编译结果——`applyEntryPatches`、`Include` 类（含 enqueue/read/refresh/_apply/_writeFile/write）**逻辑逐行一致，无行为差异**。差异只在周边胶水：
1. **导出面**：官方包导出 `Include/applyEntryPatches/entryListSchema`；boot 不公开导出这些（内部使用），多导出的是 profile 体系（`mountRootInclude`、`watchUserPatches`、`composeEntries`、`renderConfigDump`、`loadOverlayPatches` 等）。
2. **HostResolvedRootInclude**：`mountRootInclude` 里把 Include 子类化，覆写 `import()`——绝对路径/相对路径/`cordis:` 走原逻辑，**裸包名**经 `ctx.loader.internal.import(specifier, bareModuleBaseUrl, {})` 以安装宿主为基准解析（官方包没有 bare-module 解析）。
3. **builtin 装配**：boot 设置 `ctx.loader.builtins.include` 与 `ctx.loader.builtins.group = Group`，并创建根条目 `{ id: 'include', name: 'cordis:include' }` 挂进 loader；官方包不含这层。
4. **补丁来源**：boot 在挂载/离线工具里把多层 patches（bundle 层 + 用户层 + CLI `--patch` 覆盖）**预先组合**后调用同一个 `applyEntryPatches`（composeEntries 对空列表 + 各层 flat）；官方 include 只应用自身 `config.patches`。
5. HMR 包的额外差异：vendored 版本删除了 `.i18n({...})` 与 `./locales/*.yml` 导入（避免引入不 vendored 的 `@cordisjs/unyaml` YAML import 钩子，见 src/index.ts 尾部注释）。

### 5. 与普通 Vite/webpack HMR 的本质差异

- **作用域与图**：Vite/webpack 在浏览器侧跑自己的 transform/模块图，靠**作者声明**的 `import.meta.hot.accept` 边界决定热更范围；DSH HMR 在 Node 服务端直接读 **Node 内部模块图**（ESM `loadCache` + CJS `require.cache`），热更边界是**自动推导**的——没有 accept 注解，粒度是"整个插件条目 = 原子重载单位"，通过从变更文件沿依赖向上闭包传播（accepted/declined 分类）确定。
- **事务性**：DSH 是真正的**事务 + 回滚**——模块缓存先备份后清除、插件入口 all-or-nothing 重 import、`registry.delete` 释放旧实例后用旧 config/同 entry 重建新 fiber，任何一步失败都恢复缓存并**还原旧插件实例**；Vite/webpack 无此概念（失败只回退到整页刷新）。
- **框架级变更处理**：依赖 CLI 入口的 externals 变更直接 `loader.exit()` 整进程重启（Vite 是 dev server 自身重启，webpack 无对应）；配置变更也走 HMR（include refresh + 失败事件 `hmr/config-update-failed`），且与插件热更共享同一 watcher 通道。
- **运行期状态语义**：DSH 用 `oldFiber._config` + 同一 entry 重跑插件 init，等价"停旧起新但保留条目身份与配置对象"；Vite/webpack 是"保留模块实例、替换导出、accept 回调里手工迁移状态"。
- **缓存兼容层**：DSH 必须处理 Node 22/23 与 24 的 `loadCache` 差异（`Map.prototype.delete` 绕过 Node 24 只置 undefined 槽的 delete）与 CJS/ESM 双缓存，这是 Vite/webpack 不需要碰的运行时细节。
- **反死锁/串行化**：include 的 applyQueue 串行化所有 apply（group 事务 update 不可重入）、HMR 主 watcher `ignoreInitial: true` 避免初始扫描与 init apply 竞态，都是服务端生命周期编排特有的设计。

---

## 附：可读性说明

所有指定包均有 README（部分带 README.zh.md）与 lib/src 源码，未遇到不可读情况。`cordis-plugin-group/src/index.ts` 仅 3 行（纯再导出 loader 的 Group），机制在其依赖的 `loader/src/config/group.ts`。`dsh-app-boot` 内嵌的 Include 与官方 `cordis-plugin-include` 逐行一致（同源 vendored），差异仅在周边胶水（HostResolvedRootInclude、builtins 装配、多层 patch 预组合）。DSH 运行时家目录 `~/.dsh/` 已按实际状态核实（web profile 四件套、settings.yaml、storages/*.json、sessions/、profiles/node_modules symlink 农场）。
