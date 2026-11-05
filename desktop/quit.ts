/**
 * 桌面版退出：server sidecar 的优雅关闭 + 进程树兜底清理（redesign P1，docs/redesign-plan.md §4）。
 *
 * 为什么不能只 `serverProc.kill()`：Windows 上 ChildProcess.kill() 是 TerminateProcess
 * 硬杀，server 自己的 SIGTERM 收尾（dispose PTY / MCP / LSP + taskkill /T 看门狗）根本
 * 不会跑，node-pty 派生的 conhost / bash、MCP 子进程会成孤儿。
 *
 * 流程：
 *   1. 快照 server 的全部子孙 PID（best effort）；
 *   2. 经 IPC 发 {type:"shutdown"}，等 server 自己收尾退出（≤ graceMs）；
 *   3. 超时 → 树杀：Windows `taskkill /F /T /PID`，POSIX 现查子孙逐个 SIGKILL
 *      （node-pty 每个 pty 都 setsid，进程组杀不到它们，所以按 ppid 树找）；
 *   4. 扫尾：第 1 步快照里仍存活的 PID 一律 SIGKILL（应对父进程先死、子孙已被
 *      重挂到 init / 失去父链的情况）。
 *
 * 本文件不 import electron，便于单测。
 */
import { execFile } from "node:child_process";

export type RunCommand = (cmd: string, args: string[], timeoutMs: number) => Promise<string>;

export const defaultRun: RunCommand = (cmd, args, timeoutMs) =>
	new Promise((resolve, reject) => {
		execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
			if (err) reject(err);
			else resolve(String(stdout));
		});
	});

/** 解析「pid ppid」逐行文本，返回 root 的全部子孙（BFS，不含 root）。 */
export function collectDescendants(listing: string, root: number): number[] {
	const children = new Map<number, number[]>();
	for (const line of listing.split(/\r?\n/)) {
		const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		const ppid = Number(m[2]);
		if (pid === ppid) continue;
		const list = children.get(ppid);
		if (list) list.push(pid);
		else children.set(ppid, [pid]);
	}
	const out: number[] = [];
	const seen = new Set<number>([root]);
	const queue = [root];
	while (queue.length) {
		const cur = queue.shift() as number;
		for (const c of children.get(cur) ?? []) {
			if (seen.has(c)) continue;
			seen.add(c);
			out.push(c);
			queue.push(c);
		}
	}
	return out;
}

/** 列出系统进程的「pid ppid」文本。失败返回空串（调用方按 best effort 处理）。 */
export async function listProcesses(platform: NodeJS.Platform, run: RunCommand = defaultRun): Promise<string> {
	try {
		if (platform === "win32") {
			return await run(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
				],
				4000,
			);
		}
		return await run("ps", ["-A", "-o", "pid=,ppid="], 3000);
	} catch {
		return "";
	}
}

export interface KillDeps {
	platform: NodeJS.Platform;
	run?: RunCommand;
	kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
}

function safeKill(kill: NonNullable<KillDeps["kill"]>, pid: number, signal: NodeJS.Signals | 0): boolean {
	try {
		kill(pid, signal);
		return true;
	} catch {
		return false;
	}
}

/** 树杀 pid 及其当前全部子孙。 */
export async function killProcessTree(pid: number, deps: KillDeps): Promise<void> {
	const run = deps.run ?? defaultRun;
	const kill = deps.kill ?? process.kill.bind(process);
	if (deps.platform === "win32") {
		try {
			await run("taskkill", ["/F", "/T", "/PID", String(pid)], 5000);
		} catch {
			// 已退出 / 部分失败：后面的快照扫尾兜底
		}
		return;
	}
	const desc = collectDescendants(await listProcesses(deps.platform, run), pid);
	// 先停根（防止它继续派生），再收子孙
	safeKill(kill, pid, "SIGKILL");
	for (const p of desc) safeKill(kill, p, "SIGKILL");
}

/** 快照里仍存活的 PID 全部 SIGKILL，返回实际被清理的 PID。 */
export function sweepSurvivors(pids: number[], deps: KillDeps): number[] {
	const kill = deps.kill ?? process.kill.bind(process);
	const killed: number[] = [];
	for (const p of pids) {
		if (!safeKill(kill, p, 0)) continue; // 已不存在
		if (safeKill(kill, p, "SIGKILL")) killed.push(p);
	}
	return killed;
}

/** sidecar 子进程需要的最小接口（ChildProcess 满足）。 */
export interface SidecarLike {
	pid?: number;
	connected: boolean;
	exitCode: number | null;
	signalCode: NodeJS.Signals | null;
	send?(msg: unknown): boolean;
	on(ev: "message", cb: (msg: unknown) => void): unknown;
	off(ev: "message", cb: (msg: unknown) => void): unknown;
	once(ev: "exit", cb: () => void): unknown;
}

function hasExited(c: SidecarLike): boolean {
	return c.exitCode !== null || c.signalCode !== null;
}

function waitExit(c: SidecarLike, timeoutMs: number): Promise<boolean> {
	if (hasExited(c)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const t = setTimeout(() => resolve(hasExited(c)), timeoutMs);
		c.once("exit", () => {
			clearTimeout(t);
			resolve(true);
		});
	});
}

let statusSeq = 0;

/** 问 server 当前有几个正在执行的会话。通道不可用 / 超时一律当 0（不因查询失败卡住退出）。 */
export function queryActiveConversations(child: SidecarLike | null, timeoutMs = 1500): Promise<number> {
	if (!child || !child.connected || hasExited(child) || typeof child.send !== "function") return Promise.resolve(0);
	const id = ++statusSeq;
	return new Promise((resolve) => {
		const done = (n: number) => {
			clearTimeout(timer);
			child.off("message", onMsg);
			resolve(n);
		};
		const onMsg = (raw: unknown) => {
			const m = raw as { type?: unknown; id?: unknown; activeConversations?: unknown } | null;
			if (m && m.type === "status" && m.id === id) {
				done(typeof m.activeConversations === "number" ? m.activeConversations : 0);
			}
		};
		const timer = setTimeout(() => done(0), timeoutMs);
		child.on("message", onMsg);
		try {
			child.send?.({ type: "status", id });
		} catch {
			done(0);
		}
	});
}

export interface ShutdownResult {
	mode: "graceful" | "killed" | "already-exited" | "no-pid";
	swept: number[];
}

export async function shutdownSidecar(
	child: SidecarLike | null,
	deps: KillDeps & { graceMs?: number; log?: (msg: string) => void },
): Promise<ShutdownResult> {
	const log = deps.log ?? (() => {});
	if (!child || typeof child.pid !== "number") return { mode: "no-pid", swept: [] };
	const pid = child.pid;
	if (hasExited(child)) return { mode: "already-exited", swept: [] };

	const snapshot = collectDescendants(await listProcesses(deps.platform, deps.run), pid);
	log(`[desktop] 退出：server pid=${pid}，子孙进程 ${snapshot.length} 个`);

	let mode: ShutdownResult["mode"] = "graceful";
	let exited = false;
	if (child.connected && typeof child.send === "function") {
		try {
			child.send({ type: "shutdown" });
			exited = await waitExit(child, deps.graceMs ?? 5000);
		} catch {
			exited = false;
		}
	}
	if (!exited) {
		mode = "killed";
		log("[desktop] server 未在限时内退出，执行进程树强杀");
		await killProcessTree(pid, deps);
		await waitExit(child, 2000);
	}
	const swept = sweepSurvivors(snapshot, deps);
	if (swept.length) log(`[desktop] 扫尾清理残留进程：${swept.join(", ")}`);
	return { mode, swept };
}
