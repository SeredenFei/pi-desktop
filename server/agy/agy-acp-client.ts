/**
 * agy-acp-client.ts — Antigravity CLI 的 ACP（Agent Client Protocol）stdio JSON-RPC 2.0 客户端。
 *
 * 设计约束（防封红线，逐条落到代码里）：
 *   1. **原样拉起子进程**：`spawn("agy", ["acp"])`，不生成包装脚本、绝不追加
 *      `--dangerously-skip-permissions`（`assertSpawnArgsCompliant` 在 spawn 前硬断言）；
 *      工具确认走标准 `session/request_permission` → 交给 UI 点击放行。
 *   2. **不碰 OAuth 凭证**：本模块只通过 stdio 与官方进程通信，不读 `~/.gemini/**`
 *      的 token / creds 文件，不监听 127.0.0.1 授权回调；登录由用户在终端跑
 *      `agy acp --login` 完成（官方进程自己管理本地缓存）。
 *   3. 模型过滤在驱动层（`agy-compliance.ts`），本层只透传官方下发的目录。
 *   4. 不做自动追问：不存在「任务完成后自动发下一条指令」的路径 —— 会话内每条
 *      `prompt()` 都由用户输入驱动（驱动层无定时器、无重试循环）。
 *   5. 本层不发任何配额查询；配额走 `agy-quota.ts` 的按需单次调用。
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { killPidTree } from "../process-utils.js";
import {
	ACP_PROTOCOL_VERSION,
	AcpRpcError,
	type AcpConfigOption,
	type AcpInitializeResult,
	type AcpMcpServerStdio,
	type AcpPermissionRequest,
	type AcpPermissionOption,
	type AcpPromptResult,
	type AcpSessionNewResult,
	type AcpSessionNotification,
	type AcpContentBlock,
} from "./agy-types.js";
import { FORBIDDEN_ARGS, assertSpawnArgsCompliant } from "./agy-compliance.js";
import { buildAgyEnv } from "./agy-env.js";

/** 单帧 JSON 上限（协议帧防爆；agy 的 available_commands_update 约 8KB） */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface AgyAcpClientOptions {
	/** 子进程工作目录（= 会话 cwd）。 */
	cwd: string;
	/** 可执行文件；默认 `agy`（PATH 解析，不做任何 SHELL 包装）。 */
	command?: string;
	/** 追加参数（**不得**含权限跳过参数；allowlist 之外的参数会被拒绝）。 */
	extraArgs?: string[];
	/** stderr / 生命周期调试输出（由调用方按需门控，例如 PI_WEB_AGY_DEBUG=1）。 */
	log?: (line: string) => void;
	/** `session/update` 通知回调。 */
	onNotification?: (notification: AcpSessionNotification) => void;
	/** `session/request_permission` 回调（实现方必须调用 answerPermission 收尾）。 */
	onPermission?: (request: AcpPermissionRequest, requestId: AcpRequestId) => void;
	/** 子进程退出（intentional = 主动 kill）。 */
	onExit?: (info: { code: number | null; signal: NodeJS.Signals | null; intentional: boolean }) => void;
	/** 子进程环境（默认由 `buildAgyEnv(process.env)` 裁剪，剥掉别家内核的密钥/端点）。 */
	env?: NodeJS.ProcessEnv;
	/** 普通请求的超时（prompt 不受此限，靠 session/cancel 结束）。 */
	requestTimeoutMs?: number;
}

/** JSON-RPC id 既可能是数字也可能是字符串：agy acp 1.5.9 的**服务端请求**用字符串 id（"1"），
 *  回包 id 也必须原样回字符串，否则官方进程会一直等下去（实测：把字符串 id 当 number 丢掉的
 *  直接后果就是工具调用卡在 pending，UI 永远等不到放行弹窗）。 */
export type AcpRequestId = number | string;

interface Pending {
	method: string;
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
	timer?: NodeJS.Timeout;
}

/**
 * ACP 客户端：一个实例 = 一个 `agy acp` 子进程（多次 session 复用它）。
 */
export class AgyAcpClient {
	private child?: ChildProcessWithoutNullStreams;
	private buf = "";
	private readonly decoder = new StringDecoder("utf8");
	private nextId = 1;
	/** 键统一成字符串：官方回包 id 的数字/字符串形态不保证与请求一致。 */
	private readonly pending = new Map<string, Pending>();
	private startPromise?: Promise<AcpInitializeResult>;
	private init?: AcpInitializeResult;
	private stderrTail = "";
	private intentionalKill = false;
	private closed = false;
	private readonly opts: AgyAcpClientOptions;
	private readonly requestTimeoutMs: number;

	constructor(options: AgyAcpClientOptions) {
		const args = options.extraArgs ?? [];
		assertSpawnArgsCompliant(args);
		this.opts = { ...options, extraArgs: args };
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
	}

	/**
	 * 热替换通知/权限回调（每轮 prompt 前由驱动重新指向当前轮的 sink）。
	 * 不重启子进程：一个 `agy acp` 进程可以服务多个会话与多轮对话。
	 */
	setHandlers(handlers: {
		onNotification?: (notification: AcpSessionNotification) => void;
		onPermission?: (request: AcpPermissionRequest, requestId: AcpRequestId) => void;
	}): void {
		if (handlers.onNotification) this.opts.onNotification = handlers.onNotification;
		if (handlers.onPermission) this.opts.onPermission = handlers.onPermission;
	}

	/** 已握手的 agent 信息（未启动时为 undefined）。 */
	get agentInfo(): AcpInitializeResult["agentInfo"] {
		return this.init?.agentInfo;
	}

	/** 启动的登录方式（供 UI 提示「请在终端 agy acp --login」）。 */
	get authMethods(): NonNullable<AcpInitializeResult["authMethods"]> {
		return this.init?.authMethods ?? [];
	}

	/** 子进程是否存活。 */
	get alive(): boolean {
		return Boolean(this.child && !this.child.killed && this.child.exitCode === null);
	}

	/** 最近一段 stderr（错误提示用，最多 8KB）。 */
	get lastStderr(): string {
		return this.stderrTail.trim();
	}

	/** 启动并握手（幂等；并发调用共享同一个 Promise）。 */
	start(): Promise<AcpInitializeResult> {
		if (this.startPromise) return this.startPromise;
		this.startPromise = (async () => {
			await this.spawnProcess();
			const result = (await this.request("initialize", {
				protocolVersion: ACP_PROTOCOL_VERSION,
				// 只声明我们真正实现的客户端能力：文件读写与终端都由 agy 自身执行，
				// 宿主侧不接管（否则会出现「谁执行工具」的双重身份，属于越界）。
				clientCapabilities: { terminal: false },
			})) as AcpInitializeResult;
			this.init = result;
			return result;
		})().catch((err) => {
			// 启动失败后允许下一次 start() 重试（例如用户刚完成终端登录）
			this.startPromise = undefined;
			throw err;
		});
		return this.startPromise;
	}

	/** 新建 ACP 会话。 */
	async newSession(input: { cwd: string; mcpServers?: AcpMcpServerStdio[] }): Promise<AcpSessionNewResult> {
		await this.start();
		return (await this.request("session/new", {
			cwd: input.cwd,
			mcpServers: input.mcpServers ?? [],
		})) as AcpSessionNewResult;
	}

	/** 载入既有 ACP 会话（agy 声明 loadSession=true 时可用）。 */
	async loadSession(input: {
		sessionId: string;
		cwd: string;
		mcpServers?: AcpMcpServerStdio[];
	}): Promise<AcpSessionNewResult> {
		await this.start();
		return (await this.request("session/load", {
			sessionId: input.sessionId,
			cwd: input.cwd,
			mcpServers: input.mcpServers ?? [],
		})) as AcpSessionNewResult;
	}

	/** 发送一轮 prompt（阻塞到本轮结束；中断用 cancel）。 */
	async prompt(sessionId: string, prompt: AcpContentBlock[]): Promise<AcpPromptResult> {
		await this.start();
		return (await this.request("session/prompt", { sessionId, prompt }, { timeoutMs: 0 })) as AcpPromptResult;
	}

	/** 中断当前轮（官方语义：会话保留，可继续对话）。 */
	cancel(sessionId: string): void {
		if (!this.child || !this.alive) return;
		this.notify("session/cancel", { sessionId });
	}

	/** 切换模型 / 思考档位 / 模式（ACP configOptions）。 */
	async setConfigOption(sessionId: string, configId: string, value: string): Promise<AcpConfigOption[]> {
		await this.start();
		const result = (await this.request("session/set_config_option", { sessionId, configId, value })) as {
			configOptions?: AcpConfigOption[];
		};
		return result?.configOptions ?? [];
	}

	/** 切换会话模式（default / accept-edits / auto / plan）。 */
	async setMode(sessionId: string, modeId: string): Promise<void> {
		await this.start();
		await this.request("session/set_mode", { sessionId, modeId });
	}

	/** 放行/拒绝一次权限请求（optionId 来自官方下发的 options；null = 取消）。 */
	answerPermission(requestId: AcpRequestId, optionId: string | null): void {
		if (!this.child || !this.alive) return;
		const result = optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
		this.write({ jsonrpc: "2.0", id: requestId, result });
	}

	/** 退出会话（agy 支持 session/close；失败静默）。 */
	async closeSession(sessionId: string): Promise<void> {
		if (!this.child || !this.alive) return;
		try {
			await this.request("session/close", { sessionId }, { timeoutMs: 3000 });
		} catch {
			/* 老版本不支持 close：退出进程即可 */
		}
	}

	/** 终止子进程（先 SIGTERM，超时后进程树强杀）。 */
	async kill(): Promise<void> {
		this.closed = true;
		this.startPromise = undefined;
		const child = this.child;
		if (!child || child.exitCode !== null) return;
		this.intentionalKill = true;
		this.failAll(new Error("agy acp closed"));
		const pid = child.pid;
		try {
			if (pid) {
				let timer: NodeJS.Timeout | undefined;
				await Promise.race([
					killPidTree(pid),
					new Promise<void>((resolve) => {
						timer = setTimeout(resolve, 3000);
					}),
				]);
				if (timer) clearTimeout(timer);
			} else child.kill();
		} catch {
			child.kill("SIGKILL");
		}
	}

	// -------------------------------------------------------------------------
	// 进程与帧处理
	// -------------------------------------------------------------------------

	private async spawnProcess(): Promise<void> {
		if (this.child && this.alive) return;
		const args = ["acp", ...(this.opts.extraArgs ?? [])];
		assertSpawnArgsCompliant(args);
		this.closed = false;
		this.intentionalKill = false;
		const child = spawn(this.opts.command ?? "agy", args, {
			cwd: this.opts.cwd,
			stdio: ["pipe", "pipe", "pipe"],
			env: { ...(this.opts.env ?? buildAgyEnv(process.env)), NO_COLOR: "1" },
			windowsHide: true,
			detached: process.platform !== "win32",
		});
		this.child = child;
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.ingest(chunk));
		child.stderr.on("data", (chunk: Buffer | string) => {
			this.stderrTail = (this.stderrTail + chunk.toString()).slice(-8000);
			this.log(`[agy:stderr] ${String(chunk).trim()}`);
		});
		child.on("error", (err) => {
			this.failAll(err instanceof Error ? err : new Error(String(err)));
		});
		child.on("close", (code, signal) => {
			const intentional = this.intentionalKill || this.closed;
			this.failAll(new Error(this.stderrTail.trim() || `agy acp exited (${code ?? signal ?? "unknown"})`));
			this.child = undefined;
			this.opts.onExit?.({ code, signal, intentional });
		});
	}

	private ingest(chunk: string): void {
		this.buf += chunk;
		if (this.buf.length > MAX_FRAME_BYTES) {
			this.failAll(new Error("agy acp 输出帧超过上限，连接已断开"));
			void this.kill();
			return;
		}
		let index: number;
		while ((index = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, index).trim();
			this.buf = this.buf.slice(index + 1);
			if (!line) continue;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(line) as Record<string, unknown>;
			} catch {
				this.log(`[agy:nonjson] ${line.slice(0, 300)}`);
				continue;
			}
			this.dispatch(msg);
		}
	}

	private dispatch(msg: Record<string, unknown>): void {
		const id = msg.id as AcpRequestId | undefined;
		const method = typeof msg.method === "string" ? msg.method : undefined;
		if (method) {
			const line = JSON.stringify(msg);
			this.log(`[agy:in] ${line.length > 400 ? `${line.slice(0, 400)}…` : line}`);
		}

		// agent → client request（需要一个 result/error 回包）
		if (method) {
			const params = (msg.params ?? {}) as Record<string, unknown>;
			if (method === "session/update") {
				this.opts.onNotification?.(params as unknown as AcpSessionNotification);
				return;
			}
			if (method === "session/request_permission") {
				const request = params as unknown as AcpPermissionRequest;
				if (id === undefined || id === null) return;
				if (this.opts.onPermission) this.opts.onPermission(request, id);
				else this.answerPermission(id, denyOption(request.options));
				return;
			}
			if (id !== undefined) {
				// 未实现的客户端能力：明确回 RPC 错误，让 agy 自己降级（不静默吞掉）
				this.write({
					jsonrpc: "2.0",
					id,
					error: { code: -32601, message: `Client does not implement ${method}` },
				});
			} else {
				this.log(`[agy:notification:unhandled] ${method}`);
			}
			return;
		}

		// response
		if (id === undefined || id === null) return;
		const key = String(id);
		const pending = this.pending.get(key);
		if (!pending) return;
		this.pending.delete(key);
		if (pending.timer) clearTimeout(pending.timer);
		if (msg.error) {
			const err = msg.error as { code?: number; message?: string; data?: unknown };
			pending.reject(new AcpRpcError(err.code ?? -32000, err.message ?? "agy acp error", err.data));
		} else {
			pending.resolve(msg.result);
		}
	}

	private request(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<unknown> {
		if (!this.child || !this.alive) return Promise.reject(new Error("agy acp 未启动或已退出"));
		const id = this.nextId++;
		const timeoutMs = opts?.timeoutMs ?? this.requestTimeoutMs;
		return new Promise((resolve, reject) => {
			const entry: Pending = { method, resolve, reject };
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					this.pending.delete(String(id));
					reject(new Error(`agy acp ${method} 超时（${timeoutMs}ms）`));
				}, timeoutMs);
				entry.timer.unref?.();
			}
			this.pending.set(String(id), entry);
			this.write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private notify(method: string, params: unknown): void {
		this.write({ jsonrpc: "2.0", method, params });
	}

	private write(message: unknown): void {
		if (!this.child || this.child.stdin.destroyed) return;
		const frame = `${JSON.stringify(message)}\n`;
		this.log(`[agy:out] ${frame.length > 400 ? `${frame.slice(0, 400)}…` : frame.trim()}`);
		this.child.stdin.write(frame);
	}

	private failAll(err: Error): void {
		for (const [key, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(err);
			this.pending.delete(key);
		}
	}

	private log(line: string): void {
		this.opts.log?.(line);
	}
}

/** 官方 denied 语义：优先 reject_once，其次第一个 reject 选项，最后任何选项。 */
export function denyOption(options: AcpPermissionOption[] | undefined): string | null {
	const list = options ?? [];
	const once = list.find((o) => o.kind === "reject_once");
	const anyReject = list.find((o) => typeof o.kind === "string" && o.kind.startsWith("reject"));
	return (once ?? anyReject)?.optionId ?? null;
}

/** 供测试/文档引用：客户端从不追加的参数清单。 */
export const AGY_FORBIDDEN_ARGS = FORBIDDEN_ARGS;
