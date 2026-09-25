// lib/preshell-stream.ts — preshell 的流式客户端（一个子进程里跑多条命令）
//
// 为什么要它：单次调用的成本几乎全在起进程。本机实测（preshell v0.2，12 核）：
//   单条模式 1.12 ms/条，其中分析本身只有 5 µs（它自己的 --bench：20000 条 112ms）
//   流式 --stream 0.116 ms/条；45100 条命令：流式 5.2s，单条模式约 50s
// 实时路径（命令审核）一次只问一条，起进程那 2ms 无所谓，所以它仍走 lib/preshell.ts 的
// 单条模式；批量路径（影子对比、语料回放）才是这 10 倍差距的受益者。
//
// 契约（preshell v0.2 的 docs/integration.md，v0.2.1 未变；另新增 --spec 给机读形式）：
//   stdin  每行一个 JSON 字符串，或 {"id":…,"command":"…"}
//   stdout 每行一份报告；带 id 的请求拿信封 {"id":…,"report":{…}}，坏行拿 {"error":…,"line":N}
//   一行进一行出，严格对应；报告随算随出，不等 EOF；另有退出码 0 与 stderr 汇总
//   只认 id 与 command 两个键，多写一个键会被整行拒掉
//
// 上游文档（v0.2.1 「客户端这边要守住四条」）点了调用方要兜的四件事，逐条对应：
//   1 对 stdin 的写要串行：我们用 child.stdin（单一 stream、内部排队），天然安全
//   2 读要按 \n 缓冲：下面 handleLine 那段 buf 累积就是干这个的（一次 read 未必一行）
//   3 id 要不可猜（随机，不能自增）：见下面 nextId 那行注释
//   4 别让旁系子进程继承这根 fd：Node/libuv 默认 CLOEXEC，不需要我们做什么
//
// 上游点名要父进程兜住的三件事，这里也都兜了：
//   1 应答不来不许挂着等：每条请求有自己的超时；子进程一退出，未决请求全部判失败
//   2 无主应答（id 对不上）绝不当成功：只记数，丢掉
//   3 拿不到应答不等于什么都没碰：失败一律翻成 ok:false，由调用方走保守兜底

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { EXPECTED_SCHEMA, DEFAULT_TIMEOUT_MS, queryPreshellVersion, type PreshellReport, type PreshellUnavailableReason } from "./preshell.ts";

export type StreamOutcome =
	| { ok: true; report: PreshellReport }
	| { ok: false; reason: PreshellUnavailableReason; detail?: string };

export interface PreshellStreamOptions {
	bin: string;
	/** 单条命令的应答上限（毫秒）：到点这条判失败，子进程留着。分析本身是微秒级，超时即卡住 */
	timeoutMs?: number;
	/** 空闲多久就收工（毫秒）；0 = 不收工，活到调用方进程结束 */
	idleMs?: number;
	/** 期望的契约版本；不符按「事实层不可用」处理 */
	schema?: number;
	/** 交给子进程的参数（默认 --shell=probe；方言是进程级设置，切换要重开） */
	args?: string[];
	/** stderr 逐行回调：工具自己的诊断汇总走这里，不混进报告 */
	onDiagnostic?: (line: string) => void;
}

/** 计数是给调用方看的：批量跑完能一眼看出流式是否真的在干活 */
export interface PreshellStreamStats {
	spawns: number;
	requests: number;
	timeouts: number;
	/** 非本客户端主动收工而死的次数（崩溃、被杀、OOM） */
	crashes: number;
	/** id 对不上的应答：绝不进结果，但要有数 */
	orphanAnswers: number;
	/** 读得出但不是报告也不是拒绝的行 */
	badLines: number;
}

export interface PreshellStream {
	analyze(command: string): Promise<StreamOutcome>;
	/** 优雅收工：先让未决请求拿到应答（各自超时兜底），再关 stdin，超时则硬杀 */
	close(): Promise<void>;
	/** 硬杀：未决请求立刻全部失败 */
	kill(): void;
	pid(): number | undefined;
	stats(): PreshellStreamStats;
}

export const DEFAULT_STREAM_TIMEOUT_MS = 2_000;
export const DEFAULT_STREAM_IDLE_MS = 60_000;
/** 优雅收工的宽限：超过就 SIGKILL，不留一个赖着不走的子进程 */
const CLOSE_GRACE_MS = 500;

// ── 能力探测：老二进制（v0.1）不认识 --stream，得先问清楚 ──

const streamSupportCache = new Map<string, boolean>();

/** 测试用：清掉 --stream 支持探测缓存 */
export function resetStreamSupportCache(): void {
	streamSupportCache.clear();
}

/** 这个二进制认不认识 --stream（一次探测，缓存到进程结束） */
export function streamSupported(bin: string, timeoutMs = DEFAULT_TIMEOUT_MS): boolean {
	const hit = streamSupportCache.get(bin);
	if (hit !== undefined) return hit;
	let ok = false;
	try {
		const proc = spawnSync(bin, ["--help"], { encoding: "utf8", timeout: timeoutMs });
		const text = `${proc.stdout ?? ""}${proc.stderr ?? ""}`;
		ok = !proc.error && /--stream\b/.test(text);
	} catch {
		ok = false;
	}
	streamSupportCache.set(bin, ok);
	return ok;
}

// ── 子进程不许拖住宿主 ──

const live = new Set<ChildProcess>();
let exitHookInstalled = false;

/** 宿主进程走了就把子进程带走：不然会留下一堆没人喂 stdin 的孤儿 */
function installExitHook(): void {
	if (exitHookInstalled) return;
	exitHookInstalled = true;
	process.once("exit", () => {
		for (const child of live) {
			try {
				child.kill("SIGKILL");
			} catch {
				// 已经死了就算了
			}
		}
	});
}

function unref(handle: unknown): void {
	const fn = (handle as { unref?: () => void } | undefined)?.unref;
	if (typeof fn === "function") fn.call(handle);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		unref(timer);
	});
}

// ── 客户端 ──

export function openPreshellStream(options: PreshellStreamOptions): PreshellStream {
	const bin = options.bin;
	const timeoutMs = options.timeoutMs ?? DEFAULT_STREAM_TIMEOUT_MS;
	const idleMs = options.idleMs ?? DEFAULT_STREAM_IDLE_MS;
	const schema = options.schema ?? EXPECTED_SCHEMA;
	const args = options.args ?? ["--shell=probe"];

	let child: ChildProcess | undefined;
	/** 正在收工的关闭中状态（只用来避免重复安排闲时回收，不参与分类） */
	let closeInFlight = false;
	/** 哪些子进程是我们主动收的工：按子进程记，不是一个全局标志——
	 *  收工期间又起了新子进程时，新子进程的死活不能被旧标志带偏 */
	const closingChildren = new WeakSet<ChildProcess>();
	/** 确定性失败或意外退出之后就认死：不再起进程，让调用方改走单条模式 */
	let dead: { ok: false; reason: PreshellUnavailableReason; detail?: string } | undefined;
	let buf = "";
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** 请求按「发给哪个子进程」记账：收工时只收自己那一摊，不牵连新起的子进程 */
	const pending = new Map<string, { child: ChildProcess; resolve: (outcome: StreamOutcome) => void }>();
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const stats: PreshellStreamStats = { spawns: 0, requests: 0, timeouts: 0, crashes: 0, orphanAnswers: 0, badLines: 0 };

	function clearIdle(): void {
		if (idleTimer) {
			clearTimeout(idleTimer);
			idleTimer = undefined;
		}
	}

	/** 闲下来才安排收工：手上还有未决请求时收工等于把它们全判失败 */
	function touchIdle(): void {
		clearIdle();
		if (dead || closeInFlight || pending.size > 0 || idleMs <= 0) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			void close();
		}, idleMs);
		unref(idleTimer);
	}

	function settle(id: string, outcome: StreamOutcome): void {
		const timer = timers.get(id);
		if (timer) {
			clearTimeout(timer);
			timers.delete(id);
		}
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		entry.resolve(outcome);
		if (pending.size === 0) setRef(false);
		touchIdle();
	}

	function failAll(reason: PreshellUnavailableReason, detail: string): void {
		for (const id of [...pending.keys()]) settle(id, { ok: false, reason, detail });
	}

	/** 只失败发给某个子进程的请求：它退出的动静不该牵连另一个子进程手上的活 */
	function failForChild(target: ChildProcess, reason: PreshellUnavailableReason, detail: string): void {
		for (const [id, entry] of [...pending.entries()]) {
			if (entry.child === target) settle(id, { ok: false, reason, detail });
		}
	}

	/**
	 * 子进程的引用：有待答请求时保持引用，闲下来才放手。
	 *
	 * 这一对不能省：全 unref 会让「没有任何其它句柄」的宿主直接退出（批量脚本里
	 * 表现为 pending 的 await 永远不兑现，Node 会报 unsettled top-level await）；
	 * 全程 ref 又反过来钉住宿主，让它退不出去。所以按「手上有没有活」切。
	 */
	function setRef(ref: boolean): void {
		const target = child;
		if (!target) return;
		for (const handle of [target, target.stdout, target.stderr, target.stdin]) {
			const fn = (handle as { ref?: () => void; unref?: () => void } | undefined)?.[ref ? "ref" : "unref"];
			if (typeof fn === "function") fn.call(handle);
		}
	}

	/** 认死：把原因记下来，让后续调用立刻失败而不是反复重启子进程 */
	function markDead(reason: PreshellUnavailableReason, detail?: string): { ok: false; reason: PreshellUnavailableReason; detail?: string } {
		dead = detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
		failAll(reason, detail ?? "客户端已失效");
		return dead;
	}

	function handleLine(line: string): void {
		if (line.trim() === "") return;
		let msg: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(line);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				stats.badLines++;
				return;
			}
			msg = parsed as Record<string, unknown>;
		} catch {
			stats.badLines++;
			return;
		}
		const id = msg.id;
		// 无主应答：可能是上一轮超时后迟到的，也可能是客户端没发过的 id。记数，绝不当成功
		// （我们只发随机字符串 id，所以数字 id 的应答一律算无主）
		if (typeof id !== "string" || !pending.has(id)) {
			stats.orphanAnswers++;
			return;
		}
		if (typeof msg.error === "string") {
			settle(id, { ok: false, reason: "bad-json", detail: msg.error });
			return;
		}
		const report = msg.report;
		if (!report || typeof report !== "object") {
			stats.badLines++;
			settle(id, { ok: false, reason: "bad-json", detail: "应答里既没有 report 也没有 error" });
			return;
		}
		settle(id, { ok: true, report: report as PreshellReport });
	}

	function ensureChild(): { ok: true } | { ok: false; reason: PreshellUnavailableReason; detail?: string } {
		if (child && child.exitCode === null && !child.killed) return { ok: true };
		if (dead) return dead;

		const version = queryPreshellVersion(bin, Math.max(timeoutMs, DEFAULT_TIMEOUT_MS));
		if ("error" in version) return markDead(version.error);
		if (version.schema !== schema) return markDead("schema", `工具报 schema=${version.schema}，期望 ${schema}`);
		if (!streamSupported(bin, Math.max(timeoutMs, DEFAULT_TIMEOUT_MS))) {
			return markDead("exit", "这个二进制不认识 --stream（v0.1？）：批量场景请升级到 v0.2，或改走单条模式");
		}

		let spawned: ChildProcess;
		try {
			spawned = spawn(bin, ["--stream", ...args], { stdio: ["pipe", "pipe", "pipe"] });
		} catch (err) {
			return markDead("exit", err instanceof Error ? err.message : String(err));
		}
		child = spawned;
		stats.spawns++;
		installExitHook();
		live.add(spawned);

		spawned.stdout?.setEncoding("utf8");
		spawned.stdout?.on("data", (chunk: string) => {
			buf += chunk;
			for (;;) {
				const nl = buf.indexOf("\n");
				if (nl < 0) break;
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				handleLine(line);
			}
		});

		spawned.stderr?.setEncoding("utf8");
		let errBuf = "";
		spawned.stderr?.on("data", (chunk: string) => {
			errBuf += chunk;
			for (;;) {
				const nl = errBuf.indexOf("\n");
				if (nl < 0) break;
				const line = errBuf.slice(0, nl);
				errBuf = errBuf.slice(nl + 1);
				if (line.trim() !== "") options.onDiagnostic?.(line);
			}
		});

		spawned.on("error", (err: Error) => {
			live.delete(spawned);
			if (child === spawned) child = undefined;
			stats.crashes++;
			const code = (err as NodeJS.ErrnoException).code;
			markDead(code === "ENOENT" ? "missing" : "exit", err.message);
		});

		spawned.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			live.delete(spawned);
			if (child === spawned) child = undefined;
			const reason = `code=${code ?? "?"} signal=${signal ?? "?"}`;
			if (closingChildren.has(spawned)) {
				// 我们自己的收工：只收发给它的那些请求。它的退出事件可能迟到，
				// 那时新子进程已经在替我们干活了，一刀切会把那边的活也判死
				failForChild(spawned, "exit", `子进程已收工（${reason}）`);
				return;
			}
			stats.crashes++;
			markDead("exit", `子进程意外退出（${reason}）`);
		});

		// 不拖住宿主的事件循环：收了工就把句柄放掉（还在等应答时不放，见 setRef）
		setRef(false);
		return { ok: true };
	}

	async function drain(ms: number): Promise<void> {
		const deadline = Date.now() + ms;
		while (pending.size > 0 && Date.now() < deadline) await delay(5);
	}

	async function close(): Promise<void> {
		clearIdle();
		const current = child;
		if (!current) return;
		// 收工这段时间由我们把子进程送走，就得让句柄把我们留在事件循环里：
		// 全靠 unref 的话，宿主没别的话时直接退出，收工根本跑不完
		setRef(true);
		closeInFlight = true;
		closingChildren.add(current);
		// 先给未决请求留出应答窗口（各自还有超时兜底），再关 stdin 让它自己退
		if (pending.size > 0) await drain(timeoutMs);
		if (child === current) child = undefined;
		live.delete(current);
		try {
			current.stdin?.end();
		} catch {
			// 已经关了就算了
		}
		// 宽限计时器不 unref：子进程赖着不走时靠它兜住，别让收工悬在那儿
		await Promise.race([
			once(current, "exit").catch(() => undefined),
			new Promise<void>((resolve) => {
				setTimeout(resolve, CLOSE_GRACE_MS);
			}),
		]);
		if (current.exitCode === null && !current.killed) {
			try {
				current.kill("SIGKILL");
			} catch {
				// 已经死了就算了
			}
		}
		closeInFlight = false;
	}

	function kill(): void {
		clearIdle();
		const current = child;
		child = undefined;
		if (current) {
			live.delete(current);
			failAll("exit", "客户端被硬杀，未决请求一并失败");
			try {
				current.kill("SIGKILL");
			} catch {
				// 已经死了就算了
			}
		}
	}

	async function analyze(command: string): Promise<StreamOutcome> {
		const ready = ensureChild();
		if (!ready.ok) return ready;
		const current = child;
		const stdin = current?.stdin;
		if (!current || !stdin) return { ok: false, reason: "exit", detail: "子进程没有可写的 stdin" };

		clearIdle();
		stats.requests++;
		setRef(true);
		return new Promise<StreamOutcome>((resolve) => {
			// 随机而不是自增：管道若被旁系进程拿到，猜得到的 id 意味着伪造的应答能顶掉真应答。
			// 随机 id 让这种情况只能表现为「无主的应答」（上游 v0.2.1 那条义务）
			const id = randomUUID();
			const timer = setTimeout(() => {
				stats.timeouts++;
				settle(id, { ok: false, reason: "timeout", detail: `${timeoutMs}ms 内没有应答` });
			}, timeoutMs);
			unref(timer);
			timers.set(id, timer);
			pending.set(id, { child: current, resolve });
			try {
				stdin.write(`${JSON.stringify({ id, command })}\n`, (err?: Error | null) => {
					if (err) settle(id, { ok: false, reason: "exit", detail: `写入失败：${err.message}` });
				});
			} catch (err) {
				settle(id, { ok: false, reason: "exit", detail: err instanceof Error ? err.message : String(err) });
			}
		});
	}

	return {
		analyze,
		close,
		kill,
		pid: () => child?.pid,
		stats: () => ({ ...stats }),
	};
}
