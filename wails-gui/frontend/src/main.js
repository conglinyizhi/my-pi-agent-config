import { createApp } from "vue";
import SetupView from "./views/SetupView.vue";

// P2: 窗口路由壳 —— 按 windowName 选视图（P3 逐个加入其余窗口）
const views = {
  setup: SetupView,
};

const winName = await window.go.main.App.GetWindowName();
const View = views[winName] || SetupView;
createApp(View).mount("#app");
