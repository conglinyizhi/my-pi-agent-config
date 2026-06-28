/* eslint-disable */
/**
 * Socket.IO 握手版本检测 + 部署后自动刷新 + 防死循环
 *
 * 构建时同一 BUILD_ID 注入前后端。Socket.IO 连接时前端发送 clientVersion，
 * 后端比对后返回 { reload: true/false }。不一致时前端执行 location.replace 跳过缓存。
 *
 * 关键点：
 * - location.replace(href) 走浏览器缓存 → 用 cache-busting URL 参数
 * - 刷新后若缓存仍返回旧 JS → sessionStorage 标记防死循环
 * - 版本匹配后清除标记 → 下次部署才能正常触发刷新
 */

// ======================== 后端 socketio.ts ========================

import type { Server as HttpServer } from "node:http";
import { Server as SocketIOServer } from "socket.io";

declare const BUILD_ID: string;
const SERVER_BUILD_ID = typeof BUILD_ID !== "undefined" && BUILD_ID ? BUILD_ID : "dev";

export function createSocketIOServer(server: HttpServer) {
  const io = new SocketIOServer(server, {
    path: "/ws",
    transports: ["websocket", "polling"],
    cors: { origin: false },
  });

  io.on("connection", (socket) => {
    const clientVersion = socket.handshake.query.clientVersion as string | undefined;
    const needReload = !!(clientVersion && clientVersion !== SERVER_BUILD_ID);
    socket.emit("connected", {
      status: "ok",
      version: SERVER_BUILD_ID,
      reload: needReload,
    });
  });

  return io;
}

// ======================== 前端 useSocket.ts ========================

declare const __BUILD_ID__: string;
const CLIENT_BUILD_ID = typeof __BUILD_ID__ !== "undefined" && __BUILD_ID__ ? __BUILD_ID__ : "dev";

const socket = io({
  path: "/api/ws",
  transports: ["websocket", "polling"],
  reconnection: true,
  query: { clientVersion: CLIENT_BUILD_ID },
});

socket.on("connected", (data: { version: string; reload: boolean }) => {
  const RELOAD_KEY = "__pi_eco_debugger_reloaded__";

  if (data.reload) {
    if (sessionStorage.getItem(RELOAD_KEY)) {
      console.warn("已刷新过但仍版本不一致，停止刷新以防死循环", "\n  客户端版本:", CLIENT_BUILD_ID, "\n  服务端版本:", data.version);
      return;
    }
    sessionStorage.setItem(RELOAD_KEY, "1");

    // 加 cache-busting 参数跳过浏览器缓存
    const url = new URL(location.href);
    url.searchParams.set("_v", data.version);
    location.replace(url.toString());
  } else {
    // 版本匹配，清除标记以便下次部署正常触发
    sessionStorage.removeItem(RELOAD_KEY);
  }
});
