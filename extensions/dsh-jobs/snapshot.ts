// snapshot.ts — dsh-jobs 共享快照层：主会话看见 worker 子进程里的后台任务
//
// 为什么走文件而不是信号：worker 是独立 pi 进程，任务注册表各自在内存里，父子之间没有
// 常驻通道；而且 pi 拿不到 job 的 pid，跨进程 kill 不能靠信号。于是约定一个公共目录：
//   job-state/owner-<kind>[-<taskId>]-<pid>.json  每个进程原子写自己的任务列表
//   job-state/kill-<pid>-<jobId>.json             跨进程 kill 请求，目标进程轮询后消费
// 读方读全目录 = 全舰队的任务视图；写方只管自己那份，互不阻塞。
//
// 目录位置：这是**运行时状态**（每进程一份，带 pid，进程死了就是垃圾），放
// XDG_RUNTIME_DIR（per-user、0700、登录会话结束自动清）或系统临时目录，
// 不挂 agent 目录：那里是配置与备份的地方，落进去会一直往 git status 里冒未跟踪文件。
// 多进程共享的约束照样满足：同一用户的进程都看得见同一个目录。
//
// 宽容是硬要求：同一个目录里可能同时有半写文件、崩溃进程的残留、旧版本写的格式。
// 读不动就跳过，不抛异常——面板刷新的失败方式只能是「少显示几项」，
// 不能是「整个任务视图打不开」。
//
// 纯逻辑，零 pi 运行期依赖，方便单测用 PI_JOB_STATE_DIR 把它指到临时目录。

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

/** 共享目录名（挂在运行时目录下，进程退出后无保留价值） */
export const JOB_STATE_DIR_NAME = "pi-jobs";

const SNAPSHOT_PREFIX = "owner-";
const REQUEST_PREFIX = "kill-";
const JSON_SUFFIX = ".json";

/** 写快照文件的进程身份 */
export interface OwnerInfo {
	kind: "main" | "worker";
	pid: number;
	/** worker 的批量 task id（PI_TASK_ID）；主进程没有 */
	taskId?: string;
	sessionId?: string;
	cwd: string;
	/** 显示用短标签：「主进程」/「worker w2」 */
	label: string;
}

/** 快照里的一条任务（registry.JobSnapshot 的裁剪投影，够面板显示即可） */
export interface JobRecord {
	id: string;
	kind: string;
	label: string;
	status: string;
	detail?: string;
	startedAt: number;
	finishedAt?: number;
	/** 输出尾部（写方截到 4000 字符以内，避免快照文件涨大） */
	tail?: string;
}

/** 一个进程的完整快照文件内容 */
export interface OwnerSnapshot {
	version: 1;
	owner: OwnerInfo;
	updatedAt: number;
	jobs: JobRecord[];
}

/**
 * 共享目录绝对路径（每次现算）。
 *
 * 三种来源，按优先级：
 *   PI_JOB_STATE_DIR  显式覆盖（测试隔离用，也留给用户改）
 *   XDG_RUNTIME_DIR   per-user 运行时目录，0700，登录会话结束自动清理，语义最贴
 *   系统临时目录       兜底；带 uid 子目录，避免多用户机器上互相看见
 */
export function jobStateDir(): string {
	const override = envValue("PI_JOB_STATE_DIR");
	if (override) return override;
	const runtime = envValue("XDG_RUNTIME_DIR");
	if (runtime) return join(runtime, JOB_STATE_DIR_NAME);
	const uid = typeof process.getuid === "function" ? process.getuid() : "default";
	return join(tmpdir(), `${JOB_STATE_DIR_NAME}-${uid}`);
}

/**
 * 本进程的 owner 信息。
 * 环境变量派生而非读 registry：主进程没有 PI_SUBAGENT / PI_TASK_ID，worker 子进程两者都有，
 * 这是父子进程之间唯一稳定可辨的差别（见 lib/subagent-run.ts 的 buildSubagentEnv）。
 */
export function currentOwner(): OwnerInfo {
	const taskId = envValue("PI_TASK_ID");
	const isWorker = envValue("PI_SUBAGENT") !== undefined || taskId !== undefined;
	return {
		kind: isWorker ? "worker" : "main",
		pid: process.pid,
		taskId,
		sessionId: envValue("PI_SESSION_ID"),
		cwd: process.cwd(),
		label: isWorker ? (taskId ? `worker ${taskId}` : "worker") : "主进程",
	};
}

/** 覆盖写本进程的快照；失败静默（快照只是观察通道，不该打断调度） */
export function writeOwnerSnapshot(owner: OwnerInfo, jobs: JobRecord[]): void {
	const snapshot: OwnerSnapshot = { version: 1, owner, updatedAt: Date.now(), jobs };
	atomicWrite(join(jobStateDir(), ownerFileName(owner)), JSON.stringify(snapshot));
}

/** 进程退出时清掉自己那份（清不掉也无所谓：读方会按 pid 判 stale） */
export function removeOwnerSnapshot(owner: OwnerInfo): void {
	removeFile(join(jobStateDir(), ownerFileName(owner)));
}

/**
 * 读全目录，合并所有进程的任务视图。
 * staleFiles = 对应进程已经不在的快照文件，返回值交给调用方决定要不要清理
 * （读操作不留副作用，面板刷新不该顺手删东西）。
 */
export function readAllSnapshots(): { owners: OwnerSnapshot[]; staleFiles: string[] } {
	const dir = jobStateDir();
	const owners: OwnerSnapshot[] = [];
	const staleFiles: string[] = [];
	for (const file of listFiles(dir, SNAPSHOT_PREFIX)) {
		const snapshot = parseSnapshot(readJsonFile(file));
		if (!snapshot) continue; // 半写/损坏：跳过，下一轮刷新会再看到新版本
		if (isProcessAlive(snapshot.owner.pid)) owners.push(snapshot);
		else staleFiles.push(file);
	}
	return { owners, staleFiles };
}

/** 清理死进程留下的残留（快照 + 没被消费的 kill 请求），返回删除的文件数 */
export function pruneStaleSnapshots(): number {
	let removed = 0;
	for (const file of readAllSnapshots().staleFiles) {
		if (removeFile(file)) removed++;
	}
	// 请求文件同理会堆积：目标进程已猝死时没人会来消费它
	for (const file of listFiles(jobStateDir(), REQUEST_PREFIX)) {
		const request = readJsonFile(file) as { targetPid?: unknown } | undefined;
		if (isProcessAlive(request?.targetPid)) continue;
		if (removeFile(file)) removed++;
	}
	return removed;
}

/**
 * 给目标进程投一份 kill 请求。
 * 不直接动对方的任务：请求会被目标进程轮询读到，由它调自己的 registry.kill()，
 * 走正规取消路径（stopping → 生产者结算），状态才不会两边说法不一致。
 */
export function writeKillRequest(target: OwnerInfo, jobId: string): void {
	const file = join(jobStateDir(), requestFileName(target.pid, jobId));
	atomicWrite(file, JSON.stringify({ jobId, targetPid: target.pid, requestedAt: Date.now(), requesterPid: process.pid }));
}

/**
 * 读走发给本进程的 kill 请求并删除（读后即删）。
 * 删掉才不会下一轮重复 kill；删除失败也没关系，下一轮还会读到，registry.kill 幂等。
 */
export function readKillRequests(owner: OwnerInfo): string[] {
	const prefix = `${REQUEST_PREFIX}${owner.pid}-`;
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const file of listFiles(jobStateDir(), prefix)) {
		const request = readJsonFile(file) as { jobId?: unknown } | undefined;
		removeFile(file);
		const jobId = typeof request?.jobId === "string" ? request.jobId.trim() : "";
		if (jobId === "" || seen.has(jobId)) continue;
		seen.add(jobId);
		ids.push(jobId);
	}
	return ids;
}

// ---------------------------------------------------------------------------

/** 空字符串也算没设：环境变量被赋成 "" 时语义上跟不存在一样 */
function envValue(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value ? value : undefined;
}

/** 本进程快照文件名。导出供推送方报“哪个文件变了”（面板收到信号后重读目录） */
export function ownerFileName(owner: OwnerInfo): string {
	const parts = ["owner", owner.kind];
	if (owner.kind === "worker" && owner.taskId) parts.push(slug(owner.taskId));
	parts.push(String(owner.pid));
	return `${parts.join("-")}${JSON_SUFFIX}`;
}

function requestFileName(targetPid: number, jobId: string): string {
	return `${REQUEST_PREFIX}${targetPid}-${slug(jobId)}${JSON_SUFFIX}`;
}

/**
 * 文件名片段只留安全字符。
 * taskId / jobId 是外部数据（PI_TASK_ID 来自派工参数），直接拼进路径会把
 * 「a/b」这种值写到别的目录去。
 */
function slug(value: string): string {
	const safe = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64);
	return safe.length > 0 ? safe : "unknown";
}

/**
 * 原子写：先落同目录 tmp 再 rename。
 * 读方随时可能在扫这个文件，rename 在 POSIX 上是原子的，所以读方只会看到
 * 旧版本或新版本，不会看到写了一半的 JSON。
 */
function atomicWrite(file: string, text: string): void {
	const tmp = `${file}.${process.pid}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(tmp, text, "utf8");
		renameSync(tmp, file);
	} catch {
		removeFile(tmp); // 失败留下的 tmp 会被读方按后缀忽略，但没必要攒着
	}
}

function removeFile(file: string): boolean {
	try {
		rmSync(file, { force: true });
		return true;
	} catch {
		return false;
	}
}

/** 列目录里带指定前缀的 .json 文件；目录不存在 = 空列表 */
function listFiles(dir: string, prefix: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return []; // 目录还没建出来：第一个写快照的进程自然会建
	}
	return names.filter((name) => name.startsWith(prefix) && name.endsWith(JSON_SUFFIX)).map((name) => join(dir, name));
}

/** 读 JSON；半写、损坏、无权限统一返回 undefined，由调用方跳过 */
function readJsonFile(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * pid 是否还活着。
 * pid <= 0 一律按已死处理：process.kill 对非正数会命中进程组（甚至自己的组），
 * 语义根本不是「探测某进程」，这种脏数据不能当成活着的进程留着。
 * EPERM 说明进程存在但不属于本用户，同样算活着——宁可留着陈快照，也不误删别人的。
 */
function isProcessAlive(pid: unknown): boolean {
	if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** 只认自己认识的字段；别的版本多写的字段丢掉，缺关键字段就整份跳过 */
function parseSnapshot(raw: unknown): OwnerSnapshot | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const obj = raw as Record<string, unknown>;
	const owner = obj.owner;
	if (typeof owner !== "object" || owner === null) return undefined;
	const o = owner as Record<string, unknown>;
	if (o.kind !== "main" && o.kind !== "worker") return undefined;
	if (typeof o.pid !== "number") return undefined;
	// 可选字段缺省就不建键：写出去的 owner 读回来要一模一样（undefined 键会破坏往返比较）
	const parsedOwner: OwnerInfo = {
		kind: o.kind,
		pid: o.pid,
		cwd: typeof o.cwd === "string" ? o.cwd : "",
		label: typeof o.label === "string" && o.label.length > 0 ? o.label : `${o.kind} ${o.pid}`,
	};
	const taskId = optionalString(o.taskId);
	if (taskId !== undefined) parsedOwner.taskId = taskId;
	const sessionId = optionalString(o.sessionId);
	if (sessionId !== undefined) parsedOwner.sessionId = sessionId;
	return {
		version: 1,
		owner: parsedOwner,
		updatedAt: typeof obj.updatedAt === "number" ? obj.updatedAt : 0,
		jobs: Array.isArray(obj.jobs) ? (obj.jobs as JobRecord[]) : [],
	};
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
