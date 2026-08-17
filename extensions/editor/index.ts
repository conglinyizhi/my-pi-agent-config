// editor — 编辑器相关能力四合一：GUI 编辑器、圆角输入框、Ctrl+C 历史、外部编辑器
//
// 子模块（各自 default export，注册到同一 pi 实例）：
//   editor-gui.ts                /prompt-edit-gui（Wails GUI 编辑器，读 cliphist 历史）
//   editor-margin.ts             圆角边框输入编辑器（session_start 时 setEditorComponent）
//   ctrl-c-safety.ts             Ctrl+C 保存历史到 cliphist（editor-gui 读取）
//   external-editor-shortcuts.ts Ctrl+O + /open-editor 外部编辑器
//
// editor-gui 与 ctrl-c-safety 通过 ~/.pi/agent/queue/cliphist.json 共享历史队列
// （一个写、一个读），无先后依赖；此顺序仅保证确定性。
//
// 依赖：lib/gui-runner（editor-gui 的 Wails 启动器；相对路径 ../../lib 深度不变）
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import editorGui from "./editor-gui";
import editorMargin from "./editor-margin";
import ctrlCSafety from "./ctrl-c-safety";
import externalEditorShortcuts from "./external-editor-shortcuts";

export default function (pi: ExtensionAPI): void {
  editorGui(pi);
  editorMargin(pi);
  ctrlCSafety(pi);
  externalEditorShortcuts(pi);
}
