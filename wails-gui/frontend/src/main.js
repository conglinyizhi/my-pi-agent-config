import { createApp } from "vue";
import SetupView from "./views/SetupView.vue";
import ReviewView from "./views/ReviewView.vue";

// 窗口路由壳 —— 按 windowName 选视图（P3 逐个加入）
const views = {
  setup: SetupView,
  review: ReviewView,
};

const winName = await window.go.main.App.GetWindowName();
const View = views[winName] || SetupView;
createApp(View).mount("#app");
