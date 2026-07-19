# 20260709

随着技能越来越复杂，总要写一些大模型不需要看到但是人需要知道的注意事项的……

我总不能将 html 或者 vue 那套流程搬过来吧？而且主要是社区行为规范，没有社区的推动，我的想法啥也不是啊

TODO: 新增的这个插件（extensions/external-editor-shortcuts.ts）其实可以直接融合 extensions/open-editor.ts，因为有些功能重叠，但时间太晚了（0:31），记录之后就休息了

上面这一行 AI 建议我改掉，因为风格比较随意……作为仓库甚至我的源码中占比越来越少的人类语言，还是留着吧，万一……算了，我想不到谁会利用这段文本，总之，保留思考痕迹，挺好的

TODO:DONE 考虑到文档和代码中都有可能出现 TODO: 开头或者是包含的行，因此，我可以用这个功能再做一个插件，在 tui 里面展示这个功能，rg 或者 grep 指令超时就抛弃，不在tui里面显示，但如上所述，太晚了，先记一下想法(已实现：extensions/todo-scanner.ts（/todos 命令、ctrl+shift+t 快捷键)session_start 自动扫描）

# 20260712

TODO: 这个 skill 也很好，那个 skill 也很好，要不……用云端拉取的方式定义一些 skill？

# 20260714

TODO: ask_question 超长提问已能正确折行、不再崩 TUI；结果侧已带回完整 question_text。renderCall 仍只 truncateToWidth(question_text, 60) 做预览——若要在工具调用展示里也看到全文，可再改 renderCall。

# 20260719

服了，输入一大堆文本粘贴的时候 Ctrl-C 误触，整个文本没了，写个插件吧 （extensions/ctrl-c-safety.ts）

但是可能需要配合的ban掉对应的快捷键
