import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * /put-http-proxy <data> —— prompt 语法糖
 *
 * 替你向模型发一条消息，告知可用 HTTP 代理。
 *
 *   /put-http-proxy 7890                → 127.0.0.1:7890
 *   /put-http-proxy proxy.example.com:80 → 远程代理
 *   /put-http-proxy 1.2.3.4:8080         → 远程代理
 *   /put-http-proxy proxy.example.com    → TUI 追问端口
 */

export default function (pi: ExtensionAPI) {
  function parsePort(raw: string): number | null {
    if (!/^\d+$/.test(raw)) return null;
    const n = Number(raw);
    return n >= 1 && n <= 65535 ? n : null;
  }

  function parseArg(raw: string): { host: string; port?: number } | null {
    const s = raw.trim();
    if (!s) return null;

    // 纯数字 → 本地端口
    if (/^\d+$/.test(s)) {
      const port = parsePort(s);
      return port ? { host: "127.0.0.1", port } : null;
    }

    // [ipv6]:port
    const v6 = s.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      if (v6[2] !== undefined) {
        const port = parsePort(v6[2]);
        return port ? { host: v6[1], port } : null;
      }
      return { host: v6[1] };
    }

    // host:port
    const idx = s.lastIndexOf(":");
    if (idx > 0) {
      const host = s.slice(0, idx);
      const port = parsePort(s.slice(idx + 1));
      return port && host ? { host, port } : null;
    }

    // 仅 host，缺端口
    return { host: s };
  }

  pi.registerCommand("put-http-proxy", {
    description: "语法糖：告知模型可用 HTTP 代理。<端口> 或 <host[:port]>，缺端口时追问",
    handler: async (args, ctx) => {
      const raw = (args ?? "").trim();
      if (!raw) {
        ctx.ui.notify("用法：/put-http-proxy <端口> 或 <host[:port]>", "warning");
        return;
      }

      const parsed = parseArg(raw);
      if (!parsed) {
        ctx.ui.notify(`无法解析："${raw}"（支持 7890 / host:port / [ipv6]:port）`, "error");
        return;
      }

      let port: number | undefined = parsed.port;
      if (port === undefined) {
        const answer = await ctx.ui.input(`代理 ${parsed.host} 的端口：`, "例如 7890");
        if (answer === undefined) return;
        const asked = parsePort(answer.trim());
        if (asked === null) {
          ctx.ui.notify(`无效端口："${answer}"（应为 1–65535）`, "error");
          return;
        }
        port = asked;
      }

      const host = parsed.host.includes(":") ? `[${parsed.host}]` : parsed.host;
      const url = `http://${host}:${port}`;

      pi.sendUserMessage(`可以尝试代理（ ${url} ）访问部分超时/403站点，用 curl 内置的 -x 参数走代理，当情况相反你也可以不使用代理尝试`);
    },
  });
}
