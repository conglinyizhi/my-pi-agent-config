# 20260709

随着技能越来越复杂，总要写一些大模型不需要看到但是人需要知道的注意事项的……

我总不能将 html 或者 vue 那套流程搬过来吧？而且主要是社区行为规范，没有社区的推动，我的想法啥也不是啊

TODO:DONE 新增的这个插件（extensions/external-editor-shortcuts.ts）其实可以直接融合 extensions/open-editor.ts，因为有些功能重叠，但时间太晚了（0:31），记录之后就休息了

上面这一行 AI 建议我改掉，因为风格比较随意……作为仓库甚至我的源码中占比越来越少的人类语言，还是留着吧，万一……算了，我想不到谁会利用这段文本，总之，保留思考痕迹，挺好的

TODO:DONE 考虑到文档和代码中都有可能出现 TODO: 开头或者是包含的行，因此，我可以用这个功能再做一个插件，在 tui 里面展示这个功能，rg 或者 grep 指令超时就抛弃，不在tui里面显示，但如上所述，太晚了，先记一下想法(已实现：extensions/todo-scanner.ts（/todos 命令、ctrl+shift+t 快捷键)session_start 自动扫描）

# 20260712

TODO: 这个 skill 也很好，那个 skill 也很好，要不……用云端拉取的方式定义一些 skill？

# 20260714

TODO:DONE ask_question 超长提问已能正确折行、不再崩 TUI；结果侧已带回完整 question_text。renderCall 仍只 truncateToWidth(question_text, 60) 做预览——若要在工具调用展示里也看到全文，可再改 renderCall。

# 20260719

服了，输入一大堆文本粘贴的时候 Ctrl-C 误触，整个文本没了，写个插件吧 （extensions/ctrl-c-safety.ts）

但是可能需要配合的ban掉对应的快捷键

# 20260720

cd /tmp && rm -rf mbtest && mkdir mbtest &&

这种格式也报告危险指令……当编辑案例修了吧
条件：

- 前面是指令分隔符（可选的 &&）
- 结构简单，必须符合：进入 /tmp 目录，删除某个目录，创建某个目录
- 创建的目录必须是删除的那个目录
- 严格检查空格状态（避免 bash 一个空格错误导致语义崩飞的问题）
- 如果安全检查发现 3 个 rm -rf 但是仅匹配到一个上面的条件，仍然报告风险
- 如果安全检查发现的指令切片数量和匹配条件一致，视为安全，放行

# 20260721

MoonBit 写 pi 扩展的可行性验证：JS target 成立，但是同进程、函数调用、零 IPC。但工程障碍在于 MoonBit JS target 产物是 IIFE 自执行格式，不是 ES module，需要手动剥壳包装。方案可以做但不优雅，放弃

# 20260722

技能预检扩展方案记录：

背景：WUJI Labs 的 10 个技能在日常对话中从不自动触发。原因：description 是英文关键词、触发条件太窄、agent 不主动扫描 available_skills。
（这段是 agent 自己给出的）

方案演进：

1. 最初想在 SKILL.md 的 YAML description 里加中文触发词 → 放弃，因为技能是 git clone 的，改会被 pull 覆盖
2. 然后想在 repo.toml 里用 wake_words（关键词列表）→ 放弃，大模型做语义匹配比关键词命中好得多
3. 最终方案：repo.toml 新增 trigger 字段（自然语言场景描述），extension 启动时读一次缓存，构建紧凑表格注入 system prompt

关键决策：

- trigger 纯自然语言，不列举关键词。大模型语义理解比正则匹配靠谱，不行的话这模型也算废了
- extension 完全通用，不硬编码任何技能名称、不做截断、不对 nopua 等做特殊处理。引入新技能只改 toml + /reload
- session 启动时读 toml 一次，整个 session 不再动。技能变更 /reload
- 注入体量选紧凑表格（每技能一行），不把完整描述全塞 system prompt
- skill-kit 的 import-guide.md 同步更新字段说明和步骤 6（改完 toml 后 /reload）

# 20260722

虽然是 23 号写的记录，但这事儿确实发生再 22 号；简而言之就是发现某个模型有一些 xml 的返回会卡死任务，这需要 agent 适配，就适配了，顺手从 hugging face 上和 codex 源码中复刻了一个 /goal 模式

都这样了我还自己写个锤的 agent，凑活用吧……

# 20260723

extensions/session-search
extensions/session-browse

这俩插件……？想办法给他合并

# 20260724

extensions/net-guard.ts 插件开发动机

什么玩意，pi 检查更新竟然会让 pi 在网络不好的情况下出现异常的同时竟然没有显式提示？！甚至 verbose 都不给对应的日志！

怒而写插件提醒未来的自己

# 20260724-安全门

发现 Qwen 3.x 模型也存在 DeepSeek 那种调用 bash 去 mktemp 里面瞎折腾的，本身是好事情，但是每次都需要我同意安全指令有点过分，补了一个安全豁免

# 20260724-代理语法糖

extensions/put-http-proxy.ts 每次大模型都笨笨的直接访问raw资源站点，加一个插件，解决很多问题，不过我开始写自己的语法糖咯？行吧……

# 20260724-关闭 Biome 杂音提醒

详见： https://biomejs.dev/assist/actions/organize-imports

终于可以让编辑器消停一点了

# 20260724-安全门续修

让 agent 自己分析历史 session 然后挑选几个好修的安全案例修了

# 20260726-加了又删除的功能

动态接入第三方平台好像确实没必要，反正价格也不是在这里看，删了也行，不过还是加了一个 diff 的功能

# 20260727

TODO:DONE 将 ask_question 改成 GUI :)

# 20260729-task_create 异步设计

本来想参考 kimi code 设计一个同步等待几个 sub agent 完成的，但是我发现主 agent 我还用来其他的调查和交流，不做这个
task_create 始终异步发射，不提供 await 选项。OC agent 还需用于AI驱动的角色扮演，
同步等待会阻塞对话流。任务完成后自动回写状态到队列，通过 task_list / /task-manager 查看。

# 20260802-copy-code-block 插件

需要复制大模型输出中的代码块包裹内容（``` 围栏）去填写 issue 模板，因此需要单独复制代码块内容；直接 /copy 复制整段回复内容太多，因此创建了 extensions/copy-code-block 插件。

/copy-code-block 交互选择（TUI）或 /copy-code-block <编号> 直接复制。代码块按距最近用户发言的回合数排序，离用户最近的排最前；临时工程，后续再细修（当前 item 单行、预览不足）。

# 20260803

为了确定自己对某些概念的理解程度，做了一个用于大模型发问、用户通过回答来反馈的 skill（skills/clyzhi/quiz-from-doc）

一开始是 prompt 模板，后来因为有洗牌脚本（选项顺序随机化不能靠大模型手动排，太浪费算力）就改成 skill 了

踩过的坑：答案位置有规律（某轮全 A）、选项 description 泄漏对错提示、干扰项太离谱一眼排除、正确答案写太长。全写进 SKILL.md 的「避免」了

另外出题别出成视频阅读理解（年份、顺序、原话复述这种），考概念理解才有意义

# 20260804-permission-gate 审批链路修复 + 动态构造分级审核设计

弹窗审核指令快烦死我了，引擎更新之后错误弹出的有点频繁，顺便修几个小bug

好像项目有点大，大模型都觉得自己需要 superpower 来写详细计划了

# 20260805

权限提示的问题算是修的差不多了

另外，最近收到通知，有人发起了一场针对 npm 的蠕虫攻击，挺恐怖的

先一刀切避免 npm 运行（除了安装 pnpm），剩下的走一步看一步吧，我还是优先确定自己的key和环境能重装系统后能快速重现比较可靠

# 20260821-权限闸门放行备注删除

权限闸门那个「[权限闸门] 命令含命令替换，内部指令已通过规则审核，放行」前缀删了。考虑到大模型的纯净性：它在这个工具正常工作的时候，其实不知道这一行代表着什么，也没有必要去理解。所以工具有这一行纯属多余，最终删掉
