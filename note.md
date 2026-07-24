# 20260709

随着技能越来越复杂，总要写一些大模型不需要看到但是人需要知道的注意事项的……

我总不能将 html 或者 vue 那套流程搬过来吧？而且主要是社区行为规范，没有社区的推动，我的想法啥也不是啊

TODO:DONE 新增的这个插件（extensions/external-editor-shortcuts.ts）其实可以直接融合 extensions/open-editor.ts，因为有些功能重叠，但时间太晚了（0:31），记录之后就休息了

上面这一行 AI 建议我改掉，因为风格比较随意……作为仓库甚至我的源码中占比越来越少的人类语言，还是留着吧，万一……算了，我想不到谁会利用这段文本，总之，保留思考痕迹，挺好的

TODO:DONE 考虑到文档和代码中都有可能出现 TODO: 开头或者是包含的行，因此，我可以用这个功能再做一个插件，在 tui 里面展示这个功能，rg 或者 grep 指令超时就抛弃，不在tui里面显示，但如上所述，太晚了，先记一下想法(已实现：extensions/todo-scanner.ts（/todos 命令、ctrl+shift+t 快捷键)session_start 自动扫描）

# 20260712

TODO: 这个 skill 也很好，那个 skill 也很好，要不……用云端拉取的方式定义一些 skill？

# 20260714

TODO: ask_question 超长提问已能正确折行、不再崩 TUI；结果侧已带回完整 question_text。renderCall 仍只 truncateToWidth(question_text, 60) 做预览——若要在工具调用展示里也看到全文，可再改 renderCall。

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
- skill-manager 的 import-guide.md 同步更新字段说明和步骤 6（改完 toml 后 /reload）

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
