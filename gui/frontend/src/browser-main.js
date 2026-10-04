import { createApp } from "vue";
import GateView from "./views/GateView.vue";
import SubagentsView from "./views/SubagentsView.vue";
import RoutingView from "./views/RoutingView.vue";
import EditorView from "./views/EditorView.vue";
import { browserFixtures } from "./fixtures/browser.js";
import { createBrowserPlatform } from "./platform/browser.js";
import { platformKey } from "./platform/context.js";

const views = { gate: GateView, subagents: SubagentsView, routing: RoutingView, editor: EditorView };
const params = new URLSearchParams(window.location.search);
const name = params.get("view") || "gate";
const View = views[name];
const fixture = browserFixtures[name];
const fatal = document.getElementById("fatal-error");

function showFatal(message) {
  if (!fatal) return;
  fatal.textContent = `❌ ${message}`;
  fatal.style.display = "block";
}

if (!View || !fixture) {
  showFatal(`未知浏览器预览视图：${name}。可选 gate、subagents、routing、editor`);
} else {
  const platform = createBrowserPlatform(fixture, {
    onSubmit(response) { console.info("browser GUI response", response); },
    onOpenFile(file, line) { console.info("browser open file request", { file, line }); },
  });
  createApp(View).provide(platformKey, platform).mount("#app");
}
