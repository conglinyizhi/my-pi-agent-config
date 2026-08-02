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

const winName = await window.go.main.App.GetWindowName();
const View = views[winName] || SetupView;
createApp(View).mount("#app");
