import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CHECK_URL = "https://pi.dev/api/latest-version";
const TIMEOUT_MS = 3000;
const STATUS_KEY = "net-guard";

export default function (pi: ExtensionAPI) {
  let userMessageCount = 0;
  let networkOk = false;
  let statusVisible = true;
  let sessionGeneration = 0;

  pi.on("session_start", async (_event, ctx) => {
    // 重置状态
    const gen = ++sessionGeneration;
    userMessageCount = 0;
    networkOk = false;
    statusVisible = true;

    // 初始状态：检测中
    ctx.ui.setStatus(STATUS_KEY, "🌍…");

    // 异步检测网络，不阻塞启动
    checkNetwork(ctx, gen).catch(() => {});
  });

  async function checkNetwork(ctx: { ui: { setStatus: Function; notify: Function } }, gen: number) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      await fetch(CHECK_URL, { signal: controller.signal });
      clearTimeout(timer);
      // 过期会话的回调不再写入状态
      if (gen !== sessionGeneration) return;
      // 网络正常
      networkOk = true;
      if (statusVisible) {
        ctx.ui.setStatus(STATUS_KEY, "🌍OK");
      }
    } catch {
      clearTimeout(timer);
      if (gen !== sessionGeneration) return;
      // 网络异常
      networkOk = false;
      if (statusVisible) {
        ctx.ui.setStatus(STATUS_KEY, "🌍?");
      }
      // 静音警告通知：持久显示，不阻塞进程
      ctx.ui.notify(
        "似乎网络出现问题了，请检查网络设置，部分情况下 pi coding agent 在这种边界情况下可能表现诡异",
        "warning",
      );
    }
  }

  // 追踪用户发消息次数，第二次发消息后隐藏状态标志
  pi.on("before_agent_start", async (_event, ctx) => {
    if (!statusVisible) return;

    userMessageCount++;

    if (networkOk && userMessageCount >= 2) {
      statusVisible = false;
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  });

  // 会话关闭时清理
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}
