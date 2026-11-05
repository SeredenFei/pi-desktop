/**
 * 进程树快照与扫尾（server 侧，redesign P1）。
 *
 * 与 desktop/quit.ts 中的同名函数是同一套算法：两个 tsconfig 的 rootDir 不同
 * （server / desktop），无法直接共享源码；tests/unit/process-tree-parity.test.ts
 * 用同一组用例同时跑两份实现，防止漂移。
 *
 * 用途：桌面壳崩溃（IPC 断开）时 server 自行退出——先快照子孙，退出时把仍存活的
 * 一律 SIGKILL。dispose() 只会收掉自己直接持有的句柄（pty / MCP / LSP），脱离
 * 终端的后台程序（Start-Process / nohup / setsid）只能靠这一步收尾。
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

/** 列出系统进程的「pid ppid」文本。失败返回空串（best effort）。 */
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

/** 快照里仍存活的 PID 全部 SIGKILL（同步，可在 process 'exit' 里调用），返回实际清理的 PID。 */
export function sweepSurvivors(
	pids: number[],
	kill: (pid: number, signal?: NodeJS.Signals | 0) => void = process.kill.bind(process),
): number[] {
	const killed: number[] = [];
	for (const p of pids) {
		try {
			kill(p, 0);
		} catch {
			continue; // 已不存在
		}
		try {
			kill(p, "SIGKILL");
			killed.push(p);
		} catch {
			// 无权限 / 刚好退出
		}
	}
	return killed;
}
