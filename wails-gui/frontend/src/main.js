import { createApp } from "vue";
import SetupView from "./views/SetupView.vue";
import ReviewView from "./views/ReviewView.vue";
import ManagerView from "./views/ManagerView.vue";
import RoutingView from "./views/RoutingView.vue";
import GateView from "./views/GateView.vue";
import EditorView from "./views/EditorView.vue";

// 窗口路由壳 —— 按 windowName 选视图
const views = {
  setup: SetupView,
  review: ReviewView,
  manager: ManagerView,
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

const winName = await window.go.main.App.GetWindowName();
const View = views[winName] || SetupView;
createApp(View).mount("#app");
