import { createApp } from "vue";
import SubagentsView from "./views/SubagentsView.vue";
import RoutingView from "./views/RoutingView.vue";
import GateView from "./views/GateView.vue";
import EditorView from "./views/EditorView.vue";
import { createWailsPlatform, platformKey } from "./platform/index.js";

// 窗口路由壳 —— 按 windowName 选视图
const views = {
  subagents: SubagentsView,
  routing: RoutingView,
  gate: GateView,
  editor: EditorView,
};

// 全局错误兜底：GetInitData 失败 / 运行时异常时显示错误条，避免白板
function showFatal(msg) {
  const el = document.getElementById("fatal-error");
  if (el) {
    el.textContent = "❌ " + msg;
    el.style.display = "block";
  }
}
window.addEventListener("error", (e) => showFatal(e.message || String(e.error || "未知错误")));
window.addEventListener("unhandledrejection", (e) => showFatal(e.reason?.message || String(e.reason || "未知 Promise 错误")));

const platform = createWailsPlatform();
const winName = await platform.session.getWindowName();
const View = views[winName] || GateView;
createApp(View).provide(platformKey, platform).mount("#app");
