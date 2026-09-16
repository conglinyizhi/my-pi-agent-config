// 临时冒烟测试：node --experimental-strip-types smoke.test.ts
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// 必须在 import 扩展之前改 HOME——STORE_PATH 在模块加载时就算好了
const TMP_HOME = "/tmp/talk-sleep-smoke";
rmSync(TMP_HOME, { recursive: true, force: true });
mkdirSync(join(TMP_HOME, ".pi"), { recursive: true });
process.env.HOME = TMP_HOME;

const { default: register } = await import("./index.ts");

const STORE = join(TMP_HOME, ".pi", "talk-sleep.jsonl");
const SESSION_FILE = join(TMP_HOME, "session-abc.jsonl");
const SESSION_S5 = join(TMP_HOME, "session-s5.jsonl");
writeFileSync(SESSION_FILE, "{}\n");
writeFileSync(SESSION_S5, "{}\n");
const readStoreLines = (): string[] => (existsSync(STORE) ? readFileSync(STORE, "utf-8").trim().split("\n").filter(Boolean) : []);

type Cmd = { description: string; handler: (args: string, ctx: any) => Promise<void> };
const commands = new Map<string, Cmd>();
register({
  registerCommand: (name: string, def: Cmd) => commands.set(name, def),
} as any);

const notices: string[] = [];
let selectAnswers: (string | undefined)[] = [];
let inputAnswers: (string | undefined)[] = [];
let editorAnswers: (string | undefined)[] = [];
const selectCalls: string[][] = [];

const ctx = {
  ui: {
    notify: (m: string) => notices.push(m),
    setStatus: () => {},
    input: async () => inputAnswers.shift(),
    editor: async () => editorAnswers.shift(),
    select: async (_t: string, items: string[]) => {
      selectCalls.push(items);
      const a = selectAnswers.shift();
      return a === undefined ? undefined : a;
    },
  },
  sessionManager: {
    getSessionFile: () => SESSION_FILE,
    getSessionId: () => "session-abc",
    getCwd: () => "/home/some/very/deep/workspace",
  },
};

const sleep = commands.get("talk-sleep")!;
const load = commands.get("talk-sleep-load")!;

function check(name: string, cond: boolean, extra = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`);
  if (!cond) process.exitCode = 1;
}

function lineWidth(line: string): number {
  let w = 0;
  for (const ch of line) {
    const cp = ch.codePointAt(0)!;
    w += (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0x1f300 && cp <= 0x1faff) ? 2 : 1;
  }
  return w;
}

// ---- 1. 备注必填
await sleep.handler("", ctx);
check("输入 Esc → 取消暂存", notices.at(-1)!.includes("已取消暂存"), notices.at(-1));

inputAnswers = ["   "];
await sleep.handler("", ctx);
check("空白输入 → 取消暂存", notices.at(-1)!.includes("备注为空"), notices.at(-1));
check("取消时未写入文件", readStoreLines().length === 0, JSON.stringify(readStoreLines()));

inputAnswers = ["  弹框给的备注  "];
await sleep.handler("", ctx);
let lines = readStoreLines();
check("弹框备注写入且已规范化", lines.length === 1 && JSON.parse(lines[0]).note === "弹框给的备注", lines[0]);

// ---- 2. 命令行备注
await sleep.handler("短", ctx);
await sleep.handler("一个挺长的备注会被截断处理掉多余的部分", ctx);
lines = readStoreLines();
check("命令行备注写入", lines.length === 3, String(lines.length));

writeFileSync(STORE, readFileSync(STORE, "utf-8") +
  JSON.stringify({ sessionId: "s4", sessionFile: SESSION_FILE, cwd: "/tmp", note: "多行\n备注\t带制表符", timestamp: "2026-01-04T10:00:00.000Z" }) + "\n" +
  JSON.stringify({ sessionId: "s5", sessionFile: SESSION_S5, cwd: "/tmp", note: "emoji 🚢 混排", timestamp: "2026-01-05T10:00:00.000Z" }) + "\n");

// ---- 3. 列表对齐
selectAnswers = [undefined];
await load.handler("", ctx);
const items = selectCalls.at(-1)!;
check("列表条数 = 5", items.length === 5, String(items.length));
const noteCols = items.map((i) => lineWidth(i.split("  │  ")[0]));
check("备注列等宽（终端宽度）", new Set(noteCols).size === 1, JSON.stringify(noteCols));
const bars = items.map((i) => lineWidth(i.slice(0, i.indexOf("│"))));
check("分隔符对齐", new Set(bars).size === 1, JSON.stringify(bars));
check("长备注被截断带省略号", items.some((i) => i.includes("…")), items.join("\n"));
check("多行备注被压成单行", items.some((i) => i.includes("多行 备注 带制表符")));
items.forEach((i) => console.log("   |" + i + "|"));

// ---- 4. 编辑备注
const s5Item = items.find((i) => i.includes("emoji"))!;
selectAnswers = [s5Item, "编辑备注", "取消"];
editorAnswers = ["  改过的备注  "];
await load.handler("", ctx);
const after = readStoreLines().map((l) => JSON.parse(l));
check("编辑备注落盘（规范化）", after.find((l: any) => l.sessionId === "s5")?.note === "改过的备注", JSON.stringify(after.find((l: any) => l.sessionId === "s5")));
check("其余行保持不变", after.length === 5 && after.every((l: any) => l.sessionId), JSON.stringify(after.map((l: any) => l.sessionId)));
check("编辑后回到动作菜单并可复制", notices.at(-1)!.includes("备注已更新"), notices.at(-1));

// ---- 5. 清空备注 + 复制指令
selectAnswers = [items[1], "编辑备注", "仅显示恢复指令"];
editorAnswers = [""];
await load.handler("", ctx);
check("清空备注", readFileSync(STORE, "utf-8").includes('"note":""'));
selectAnswers = [undefined];
await load.handler("", ctx);
const items5 = selectCalls.at(-1)!;
selectAnswers = [items5.find((i) => i.includes("无备注"))!, "仅显示恢复指令"];
await load.handler("", ctx);
check("无备注时不加 # 后缀", !notices.at(-1)!.includes("  # "), notices.at(-1));
selectAnswers = [items5.find((i) => i.includes("改过的备注"))!, "仅显示恢复指令"];
await load.handler("", ctx);
check("有备注时指令带 # 后缀", notices.at(-1)!.includes("  # 改过的备注"), notices.at(-1));

// ---- 6. Esc 取消编辑不改动
const before6 = readFileSync(STORE, "utf-8");
selectAnswers = [items[2], "编辑备注", "取消"];
editorAnswers = [undefined];
await load.handler("", ctx);
check("编辑取消不写盘", readFileSync(STORE, "utf-8") === before6);

// ---- 7. 重复行不会选错目标
const dupe = JSON.parse(readStoreLines()[0]);
for (let i = 0; i < 3; i++) {
  writeFileSync(STORE, readFileSync(STORE, "utf-8") + JSON.stringify({ ...dupe, sessionId: `dup-${i}` }) + "\n");
}
selectAnswers = [undefined];
await load.handler("", ctx);
const items7 = selectCalls.at(-1)!;
check("重复行自动加序号", items7.filter((i) => i.endsWith("#2")).length === 1, items7.join("\n"));

// ---- 8. 空 store
writeFileSync(STORE, "");
selectAnswers = [];
await load.handler("", ctx);
check("空 store 给出提示", notices.at(-1)!.includes("没有暂存的对话"), notices.at(-1));

// ---- 9. 会话文件缺失
writeFileSync(STORE, JSON.stringify({ sessionId: "gone", sessionFile: join(TMP_HOME, "gone.jsonl"), cwd: "/tmp", note: "已删除的会话", timestamp: "2026-01-06T10:00:00.000Z" }) + "\n");
selectAnswers = [undefined];
await load.handler("", ctx);
selectAnswers = [selectCalls.at(-1)![0]];
await load.handler("", ctx);
check("会话文件缺失时提示", notices.at(-1)!.includes("会话文件已不存在"), notices.at(-1));

// ---- 10. 非持久化会话
const ctxNoSession = { ...ctx, sessionManager: { ...ctx.sessionManager, getSessionFile: () => undefined } };
await sleep.handler("x", ctxNoSession);
check("in-memory 会话拒绝暂存", notices.at(-1)!.includes("无法暂存"), notices.at(-1));

// ---- 11. 只剩 OSC 52 兜底时，不能报成「已复制到剪贴板」
writeFileSync(STORE, JSON.stringify({ sessionId: "osc", sessionFile: SESSION_FILE, cwd: "/tmp", note: "远端会话", timestamp: "2026-01-07T10:00:00.000Z" }) + "\n");
selectAnswers = [undefined];
await load.handler("", ctx);
const items11 = selectCalls.at(-1)!;

// 造一个「没有本地通道可用 + remote 会话」的环境，逼出 OSC 52 分支
const savedEnv = ["SSH_CONNECTION", "WAYLAND_DISPLAY", "DISPLAY", "TERMUX_VERSION"] as const;
const restoreEnv = new Map(savedEnv.map((k) => [k, process.env[k]]));
process.env.SSH_CONNECTION = "10.0.0.1 22 10.0.0.2 22";
for (const k of ["WAYLAND_DISPLAY", "DISPLAY", "TERMUX_VERSION"] as const) delete process.env[k];

const stdoutChunks: string[] = [];
const realWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = ((chunk: unknown) => { stdoutChunks.push(String(chunk)); return true; }) as typeof process.stdout.write;
selectAnswers = [items11[0], "复制恢复指令到剪贴板"];
await load.handler("", ctx);
process.stdout.write = realWrite;
for (const [k, v] of restoreEnv) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }

check("OSC 52 序列已发出", stdoutChunks.some((c) => c.startsWith("\x1b]52;c;")), JSON.stringify(stdoutChunks));
check("OSC 52 兜底时提示取决于终端", notices.at(-1)!.includes("OSC 52"), notices.at(-1));
check("OSC 52 兜底时不报已复制", !notices.at(-1)!.includes("已复制到剪贴板"), notices.at(-1));
