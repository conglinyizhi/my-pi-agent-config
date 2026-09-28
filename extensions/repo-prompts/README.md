# repo-prompts — 按目录注入提示词段

有些提示词只在某个仓库里成立（如「preshell 升级走 A/B 流程」）。`AGENTS.md` 能做的事是
**在每个仓库里放一份**，改起来散、分发也散。本扩展把「目录 → 提示词」的映射集中放在一处，
按当前 cwd 的路径前缀匹配后，注册成 [prompt-sections](../prompt-sections/README.md) 的段。

## 存储

```
~/.pi/agent/repo-prompts/
  index.toml          共享规则表（跟 agent 仓一起提交、可分发）
  preshell.md         每条规则一份正文（也可以内联，不落文件）
  local.example.toml  私有规则的范文（占位文本，本身是空表）
  my-notes.local.toml 只留本地的规则表（.gitignore 排除）
  my-notes.local.md   只留本地的正文（.gitignore 排除）
```

这个目录本身可以 `git init` + push 当分发单元用——扩展只管读，不碰 git。

## 规则表：目录下所有 `*.toml` 都读

规则表不是单个 `index.toml`：`dir` 下（**不递归子目录**）的每个 `*.toml` 都会被读，按
**文件名序**（码位序，与 locale 无关）依次合并成一张规则表。

- 同一个规则名在后面的文件里再定义 → **后者覆盖前者**（内容与位置都取后一份）
- 覆盖是正常用法，不是错误：`/repo-prompts` 的「提示」里会写「规则 X 被 B.toml 覆盖
  （前一条来自 A.toml）」，同时日志一条 warn（去重，不会每轮刷）
- 同一个文件里重名则按「问题」记录（多半是手滑写重了）
- 单个 toml 读不动 / 解析失败 → 只丢这个文件的规则，其它文件照常
- 文件名不做任何特殊判断，`*.local.toml` 跟别的文件完全一样（见下）

## 共享 / 私有

大部分规则适合跟 agent 仓一起提交（共享、可分发），有些只想留本地。这个区分交给 git，
扩展不参与：

| | 文件名 | 去向 |
| --- | --- | --- |
| 共享 | `index.toml`、`xxx.toml`；正文 `preshell.md`、`xxx.md` | 提交、可分发 |
| 私有 | `xxx.local.toml`；正文 `xxx.local.md` | agent 仓 `.gitignore` 排除，只留本地 |

```gitignore
# repo-prompts：只留本地的规则（改名即可切换共享性）
repo-prompts/*.local.toml
repo-prompts/*.local.md
```

**切换共享性就是改文件名**：`xxx.local.toml` → `xxx.toml`（正文同步 `xxx.local.md` →
`xxx.md`）就从私有转共享，反之后缀加回 `.local` 就转回私有。不用动扩展，也不用改 dir 配置；
改名后 `/reload` 一次即可，改名属于「规则表变了」。

范文见 `repo-prompts/local.example.toml`（整段是注释，粘出来改个名就能用）。

## toml 里的字段

```toml
[[prompt]]
name = "preshell"                          # 必填。段名 = repo:<name>；只能用字母数字与 . _ -
paths = ["~/disk/ai_workspace/preshell"]   # 必填。路径前缀，至少一条；支持 ~；须绝对路径或 ~/…
file = "preshell.md"                       # 与 text 二选一。相对本目录（也收绝对路径）
order = 200                                # 可选。缺省 200（200+ 是「动态」档）
```

`text = "…"` 可替代 `file`，放一两句的内联短规则：

```toml
[[prompt]]
name = "scratch"
paths = ["/tmp/scratch"]
text = "这个目录是临时实验区，产物别留在仓库里。"
```

写错一条只丢它自己（`/repo-prompts` 的「问题」里列出来），不影响同一文件里其它规则，
也不影响其它文件。`file` 读不到时该段为空，其它段照常注入。

## 匹配规则

只看**本地路径前缀**：`cwd === p`，或 `cwd` 以 `p + "/"` 开头。两边都先归一化
（`~` 展开 → `resolve` 去掉 `.` / `..` / 重复与结尾斜线）。

- 不做 glob、不递归推断、**不读 git 远端**
- 前缀相似但不包含不命中：`/a/bc` 不在 `/a/b` 下；只向下，父目录 `/a` 也不命中
- 相对路径不解析（解释权会随会话漂移），写 `~/…` 或绝对路径
- 多条命中 → 每条各注一个段，按 `order` 升序；同 `order` 保持合并顺序（文件名序，
  同名规则取后定义它的那份的位置）

## 与 pi 原生 AGENTS.md 的关系

共存，不替代。`AGENTS.md` 是仓库自带、面向任意 agent 的说明，由 pi 自己发现；
本扩展是**提督侧**的集中规则，面向 pi 会话。两者命中时都会进上下文。

## 注入告知：notify 一次 + 编辑器上方常驻

会话开始时（`session_start`）本扩展会对界面说两件事：

1. `ui.notify`：本目录注入了 N 条规则 —— 跳出来那一下最醒目
2. `ui.setWidget("repo-prompts", lines)`：同样的话在**编辑器上方常驻**

为什么要两份：`notify` 是一次性 toast，几秒就没了，用户没看到的那一刻就永远错过 ——
而「本目录注入了什么」是整个会话都成立的事实，值得一直摆在那儿（随时能回看）。

widget 只在真有事说的时候才设：没命中规则、也没配置告警 → `setWidget(id, undefined)`
清掉（让不命中规则的目录保持零打扰）。告警也进这份 widget（第一条 + 总条数，
全部走 `/repo-prompts`）。行数上限 6，超出折叠成一行提示。

行内容由 `widget.ts` 的 `buildWidgetLines()` 组装（纯函数，便于单测）。

## 命令

`/repo-prompts` 打印：存储位置、规则数与已注册段数、读到的规则表清单、每条规则的
paths 与归一化结果、**这条规则来自哪个 toml**、正文是否读得到、当前 cwd 命中了哪些、
注册了哪些段，以及配置里的提示与问题。

## 实现要点

- **注册在 factory 期，对合并后的每条规则都注册一个段**（不管当前 cwd），名 `repo:<name>`；
  段的 `text` 在装配时按 `ctx.cwd` 现场判定：命中读 md，不命中返回空串（空段被丢弃）。
- **KV 前缀纪律**：段集合在会话生命周期里是常量，cwd 在同一次会话里不动，所以同一目录
  重复装配结果稳定，前缀缓存不会逐轮失效。规则表改动要 `/reload` 才重新注册；
  md 正文改动下一次装配即生效。
- **/reload 语义**：`/reload` 会重跑 factory，而 prompt-sections 的注册表是进程内单例、
  旧注册不会自己消失。每次注册前会先注销本扩展上一轮的段，所以改完规则表再
  `/reload`，新规则能加上、删掉的规则也能收回去（否则被删的规则会继续按旧路径注入）。
- **读文件缓存**：按「路径 + mtime + size」缓存 md 内容，没改就不重读。
- **失败降级**：目录读不到 / 某个 TOML 坏掉 / md 读不到一律不抛、不阻断会话，只记一条
  去重的 warn 并在 `/repo-prompts` 里显示；单个坏文件、单条坏规则都不影响其它段。

## 配置（extensions.toml）

```toml
[repo-prompts]
enabled = true
dir = "~/.pi/agent/repo-prompts"
```

缺省即上面的值；文件缺失 / 坏掉 / 没有该段时按缺省走。

## 测试

```bash
node --test --experimental-strip-types extensions/repo-prompts/index.test.ts
```

覆盖：归一化（`~` 展开、去尾斜线、相对路径不匹配）、前缀命中（相等 / 子目录 / 前缀相似 /
父目录）、toml 解析与坏输入降级、多 toml 按文件名序合并、同名规则后者覆盖（含提示）、
`*.local.toml` 一视同仁、子目录不递归、多条命中的顺序、md 缺失与缓存失效、
同一目录重复装配稳定、`/repo-prompts` 报告内容（含规则来源 toml）、`[repo-prompts]` 设置读取。
