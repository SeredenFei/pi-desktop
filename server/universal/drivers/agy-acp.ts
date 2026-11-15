/**
 * agy-acp.ts — Antigravity CLI（agy）作为 **平级可切换内核** 的通用底座驱动。
 *
 * 与 pi-agy-acp 插件的根本差别：这里不是把 agy 的模型接口塞进第三方 Agent 循环
 * 「套娃」调用，而是把一个**完整的官方 Agent 进程**当作引擎：
 *   - 对话循环、文件读写、终端执行全部由 Antigravity CLI 自身完成；
 *   - 宿主只做标准 ACP 客户端该做的事：拉起子进程、转发用户输入、渲染流式事件、
 *     把 `session/request_permission` 弹到界面由人点击放行。
 *
 * 红线见 `server/agy/agy-compliance.ts`（模型只放 Gemini、无权限跳过参数、
 * 不碰凭证、无自动追问、配额按需单次）。
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	BaseAgentDriver,
	type AgentCapabilities,
	type AgentEventSink,
	type AgentPermissionDecision,
	type AgentPermissionRequest,
	type AgentTurnUsage,
} from "../driver-base.js";
import type { PromptAttachment, SlashCommandInfo } from "../../protocol.js";
import { AgyAcpClient, denyOption, type AcpRequestId } from "../../agy/agy-acp-client.js";
import {
	assertGeminiModelId,
	assertSpawnArgsCompliant,
	filterGeminiModels,
	isGeminiModelId,
} from "../../agy/agy-compliance.js";
import type {
	AcpConfigOption,
	AcpContentBlock,
	AcpModelInfo,
	AcpSessionNewResult,
	AcpSessionNotification,
	AcpToolCall,
} from "../../agy/agy-types.js";
import { formatUsageLines, queryAgyUsage } from "../../agy/agy-quota.js";
import { buildAgyEnv } from "../../agy/agy-env.js";
import { stripReasoningSignatures } from "../../agy/agy-handoff.js";
import {
	agyGlobalMcpConfigPath,
	agyMcpConfigPath,
	agySkillsDir,
	linkSkillsIntoProject,
	readProjectMcpConfig,
} from "../../agy/agy-workspace.js";

/** agy acp 1.5.9 实测的 Gemini 目录兜底表（在 `session/new` 之前就能渲染下拉）。 */
const FALLBACK_GEMINI_MODELS: AcpModelInfo[] = [
	{ modelId: "gemini-4-carbon", name: "Gemini 4 Carbon" },
	{ modelId: "gemini-4-argon", name: "Gemini 4 Argon" },
	{ modelId: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen" },
	{ modelId: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" },
	{ modelId: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)" },
	{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
];

const DEFAULT_THINKING_LEVELS = ["low", "medium", "high"];
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

export interface AgyAcpDriverOptions {
	/** 可执行文件路径（默认 PATH 里的 `agy`）。 */
	command?: string;
	/** 显式追加的环境变量（仍会被红线黑名单拒绝；默认只透传运行必需项）。 */
	env?: NodeJS.ProcessEnv;
	/** 追加参数（红线校验；不允许权限跳过类开关）。 */
	extraArgs?: string[];
	/** 调试日志（PI_WEB_AGY_DEBUG=1 时由调用方注入）。 */
	log?: (line: string) => void;
}

export class AgyAcpDriver extends BaseAgentDriver {
	readonly id = "agy";
	readonly name = "Antigravity";
	readonly capabilities: AgentCapabilities = {
		supportsTreeFork: false,
		supportsHistoryEdit: false,
		supportsToolPromptOverride: false,
		supportsModelSwitch: true,
		supportsThinkingLevels: true,
		// agy 自带 team / swarm 等编排能力，但不暴露给宿主子代理调度
		supportsSubagents: false,
		supportsAskUser: false,
	};

	/** 供 UniversalSession 初始化时读取的默认模型（Gemini 4 Carbon）。 */
	readonly currentModel = FALLBACK_GEMINI_MODELS[0].modelId;

	private readonly options: AgyAcpDriverOptions;
	private client?: AgyAcpClient;
	private sessionId = "";
	private needsSession = true;
	private model = FALLBACK_GEMINI_MODELS[0].modelId;
	private thinking = "medium";
	private catalog: AcpModelInfo[] = FALLBACK_GEMINI_MODELS;
	private thinkingLevels: string[] = DEFAULT_THINKING_LEVELS;
	private configOptions: AcpConfigOption[] = [];
	private commands: Array<{ name: string; description?: string }> = [];
	private tierName = "";
	private contextUsed: number | null = null;
	private contextWindow = 0;
	private activeToolCalls = new Set<string>();
	private activePrompt?: Promise<unknown>;
	private disposed = false;

	constructor(cwd: string, options: AgyAcpDriverOptions = {}) {
		super(cwd);
		assertSpawnArgsCompliant(options.extraArgs ?? []);
		this.options = options;
	}

	// -------------------------------------------------------------------------
	// 会话生命周期
	// -------------------------------------------------------------------------

	async createSession(): Promise<string> {
		const info = await this.ensureSession(undefined);
		return info.sessionId;
	}

	async resumeSession(sessionId: string): Promise<void> {
		if (!sessionId.trim()) return;
		if (this.sessionId === sessionId && !this.needsSession) return;
		this.sessionId = sessionId;
		this.needsSession = true;
		try {
			await this.ensureSession(sessionId);
		} catch {
			// 会话已失效（agy 侧清理 / 版本升级）：退回新会话，由 onSessionStarted 通知宿主换 id
			this.needsSession = true;
			await this.ensureSession(undefined);
		}
	}

	private getClient(): AgyAcpClient {
		if (this.client) return this.client;
		this.client = new AgyAcpClient({
			cwd: this.cwd,
			command: this.options.command,
			extraArgs: this.options.extraArgs,
			// 内核级环境隔离：agy 进程看不到别家的 API Key / 端点覆盖（订阅额度不串台）
			env: buildAgyEnv(process.env, this.options.env),
			log: this.options.log,
			onExit: (info) => {
				this.needsSession = true;
				if (!info.intentional && this.options.log) {
					this.options.log(`[agy] 子进程退出 code=${info.code ?? "?"} signal=${info.signal ?? "?"}`);
				}
			},
		});
		return this.client;
	}

	private async ensureSession(resumeId: string | undefined): Promise<AcpSessionNewResult> {
		const client = this.getClient();
		await client.start();
		const mcpServers = this.readMcpServers();
		const info = resumeId
			? await client.loadSession({ sessionId: resumeId, cwd: this.cwd, mcpServers })
			: await client.newSession({ cwd: this.cwd, mcpServers });
		this.applySessionInfo(info);
		this.sessionId = info.sessionId;
		this.needsSession = false;
		return info;
	}

	private applySessionInfo(info: AcpSessionNewResult): void {
		this.configOptions = info.configOptions ?? this.configOptions;
		const modelOption = this.configOptions.find((option) => option.id === "model" || option.category === "model");
		const liveCatalog: AcpModelInfo[] = (modelOption?.options ?? []).map((option) => ({
			modelId: option.value,
			name: option.name,
		}));
		const catalog = liveCatalog.length > 0 ? liveCatalog : (info.models?.availableModels ?? []);
		const filtered = filterGeminiModels(catalog, (model) => model.modelId);
		if (filtered.length > 0) this.catalog = filtered;
		const thoughtOption = this.configOptions.find((option) => option.id === "thought_level");
		const levels = (thoughtOption?.options ?? []).map((option) => option.value);
		if (levels.length > 0) this.thinkingLevels = levels;
		const current = info.models?.currentModelId;
		if (current && isGeminiModelId(current)) this.model = baseModelId(current);
		this.tierName = info._meta?.antigravity?.tier?.name ?? this.tierName;
	}

	/** 项目 `.agents/mcp_config.json`（自定义工具走标准 MCP；不做工具反向桥接）。 */
	private readMcpServers() {
		try {
			return readProjectMcpConfig(this.cwd);
		} catch {
			return [];
		}
	}

	// -------------------------------------------------------------------------
	// 一轮对话
	// -------------------------------------------------------------------------

	async sendPrompt(prompt: string, attachments: PromptAttachment[] | undefined, sink: AgentEventSink): Promise<void> {
		if (this.disposed) throw new Error("Antigravity 驱动已释放");
		const blocks = buildPromptBlocks(prompt, attachments);
		if (this.needsSession) {
			const info = await this.ensureSession(undefined);
			sink.onSessionStarted?.(info.sessionId);
		}
		assertGeminiModelId(this.model);
		this.attachHandlers(sink);
		await this.applyModelSelection(sink);
		const client = this.getClient();
		const sessionId = this.sessionId;
		this.contextUsed = null;
		const run = client.prompt(sessionId, blocks);
		this.activePrompt = run;
		try {
			const result = await run;
			if (result.stopReason === "cancelled") {
				sink.onError(new Error("已中止本轮（session/cancel）"));
				return;
			}
			sink.onTurnComplete(this.toTurnMeta(result.usage, result.stopReason));
		} finally {
			if (this.activePrompt === run) this.activePrompt = undefined;
		}
	}

	private async applyModelSelection(sink: AgentEventSink): Promise<void> {
		const client = this.client;
		if (!client || this.needsSession || !this.sessionId) return;
		const modelOption = this.configOptions.find((option) => option.id === "model");
		if (modelOption && modelOption.currentValue !== this.model) {
			try {
				this.configOptions = await client.setConfigOption(this.sessionId, "model", this.model);
			} catch (err) {
				sink.onError(err instanceof Error ? err : String(err));
			}
		}
		const thoughtOption = this.configOptions.find((option) => option.id === "thought_level");
		if (thoughtOption && thoughtOption.currentValue !== this.thinking) {
			try {
				this.configOptions = await client.setConfigOption(this.sessionId, "thought_level", this.thinking);
			} catch (err) {
				sink.onError(err instanceof Error ? err : String(err));
			}
		}
	}

	private toTurnMeta(
		usage:
			| { inputTokens?: number; cachedReadTokens?: number; cachedWriteTokens?: number; outputTokens?: number }
			| undefined,
		stopReason: string,
	) {
		const input = usage?.inputTokens ?? 0;
		const cached = usage?.cachedReadTokens ?? 0;
		const turnUsage: AgentTurnUsage = {
			inputTokens: Math.max(0, input - cached),
			outputTokens: usage?.outputTokens ?? 0,
			cacheReadTokens: cached,
			cacheWriteTokens: usage?.cachedWriteTokens ?? 0,
			contextTokens: this.contextUsed ?? undefined,
			contextWindow: this.contextWindow || undefined,
		};
		if (stopReason !== "end_turn" && this.options.log) {
			// refusal / max_tokens 等结束原因只进调试日志，不伪造成功率
			this.options.log(`[agy] turn stopReason=${stopReason}`);
		}
		return {
			usage: turnUsage,
			model: this.model,
			contextTokens: this.contextUsed ?? undefined,
			contextWindow: this.contextWindow || undefined,
		};
	}

	async abort(): Promise<void> {
		const client = this.client;
		if (!client || !this.sessionId) return;
		client.cancel(this.sessionId);
		const pending = this.activePrompt;
		if (!pending) return;
		const settled = await Promise.race([
			pending.then(() => true).catch(() => true),
			new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 4000);
				timer.unref?.();
			}),
		]);
		if (!settled) {
			// 官方进程没有在宽限期内结束本轮：断开连接（会话仍在磁盘，下次自动重开）
			await client.kill();
			this.client = undefined;
			this.needsSession = true;
		}
	}

	// -------------------------------------------------------------------------
	// 模型 / 思考档位 / 事件桥
	// -------------------------------------------------------------------------

	async listModels(): Promise<Array<{ id: string; name: string }>> {
		return this.catalog.map((model) => ({ id: model.modelId, name: model.name }));
	}

	async setModel(modelId: string): Promise<void> {
		// 宿主下拉用的是 canonical id（`agy/gemini-4-carbon`），ACP 只认族名
		const bare = modelId.includes("/") ? modelId.slice(modelId.lastIndexOf("/") + 1) : modelId;
		const base = baseModelId(bare);
		assertGeminiModelId(base);
		this.model = base;
	}

	setThinkingLevel(level: string): void {
		this.thinking = this.thinkingLevels.includes(level) ? level : (this.thinkingLevels[0] ?? "medium");
	}

	getSupportedThinkingLevels(): string[] {
		return this.thinkingLevels.length > 0 ? this.thinkingLevels : DEFAULT_THINKING_LEVELS;
	}

	/** 订阅档位（session/new 的 _meta；只读展示）。 */
	getTierName(): string {
		return this.tierName;
	}

	/** agy 侧下发的斜杠命令（只做展示，不代发 —— 代发会变成普通文本）。 */
	getAgentCommands(): Array<{ name: string; description?: string }> {
		return this.commands;
	}

	/**
	 * 把 ACP 通知挂到事件槽（每个 prompt 前重建，保证 sink 指向当前轮）。
	 */
	private attachHandlers(sink: AgentEventSink): void {
		const client = this.getClient();
		client.setHandlers?.({
			onNotification: (notification) => this.onNotification(notification, sink),
			onPermission: (request, requestId) => void this.onPermission(request, requestId, sink),
		});
	}

	private onNotification(notification: AcpSessionNotification, sink: AgentEventSink): void {
		const update = notification.update;
		switch (update.sessionUpdate) {
			case "agent_message_chunk": {
				const block = (update as { content?: AcpContentBlock }).content;
				const text = block?.type === "text" ? block.text : "";
				if (text) sink.onTextDelta(text);
				return;
			}
			case "agent_thought_chunk": {
				const block = (update as { content?: AcpContentBlock }).content;
				const text = block?.type === "text" ? block.text : "";
				if (text) sink.onThinkingDelta(text);
				return;
			}
			case "tool_call": {
				const call = update as unknown as AcpToolCall;
				if (!call.toolCallId || this.activeToolCalls.has(call.toolCallId)) return;
				this.activeToolCalls.add(call.toolCallId);
				sink.onToolStart(call.toolCallId, call.name || call.kind || call.title || "tool", toolParams(call));
				return;
			}
			case "tool_call_update": {
				const call = update as unknown as AcpToolCall;
				if (!call.toolCallId) return;
				const status = call.status;
				if (!this.activeToolCalls.has(call.toolCallId)) {
					this.activeToolCalls.add(call.toolCallId);
					sink.onToolStart(call.toolCallId, call.name || call.kind || call.title || "tool", toolParams(call));
				}
				if (status === "completed") {
					sink.onToolEnd(call.toolCallId, { output: toolOutput(call) });
					this.activeToolCalls.delete(call.toolCallId);
				} else if (status === "failed") {
					sink.onToolEnd(call.toolCallId, { error: toolOutput(call) || "tool failed" });
					this.activeToolCalls.delete(call.toolCallId);
				} else {
					const progress = toolOutput(call);
					if (progress) sink.onToolUpdate?.(call.toolCallId, progress);
				}
				return;
			}
			case "usage_update": {
				const usage = update as { used?: number; size?: number };
				if (typeof usage.used === "number") this.contextUsed = usage.used;
				if (typeof usage.size === "number") this.contextWindow = usage.size;
				return;
			}
			case "available_commands_update": {
				this.commands = (
					(update as { availableCommands?: Array<{ name: string; description?: string }> }).availableCommands ?? []
				).map((command) => ({ name: command.name, description: command.description }));
				return;
			}
			case "config_option_update": {
				const options = (update as { configOptions?: AcpConfigOption[] }).configOptions;
				if (Array.isArray(options)) this.configOptions = options;
				return;
			}
			case "current_mode_update":
			case "session_info_update":
			case "user_message_chunk":
			case "plan":
				// 用户消息已由宿主落库；模式/标题/计划条不在通用底座渲染
				return;
			default:
				return;
		}
	}

	/**
	 * ACP 权限请求 → 界面点击（红线 1：绝不自动放行）。
	 * 没有审批 UI 或超时 → 走官方 deny 选项。
	 */
	private async onPermission(
		request: { toolCall?: AcpToolCall; options?: Array<{ optionId: string; name?: string; kind?: string }> },
		requestId: AcpRequestId,
		sink: AgentEventSink,
	): Promise<void> {
		const client = this.getClient();
		const options = request.options ?? [];
		const toolCall = request.toolCall;
		this.options.log?.(
			`[agy] permission request id=${requestId} tool=${toolCall?.name ?? "?"} options=${options.length}`,
		);
		if (!sink.onPermissionRequest) {
			client.answerPermission(requestId, denyOption(options));
			return;
		}
		const payload: AgentPermissionRequest = {
			toolCallId: toolCall?.toolCallId ?? `perm-${requestId}`,
			toolName: toolCall?.name || toolCall?.kind || "tool",
			title: toolCall?.title,
			kind: toolCall?.kind,
			params: toolParams(toolCall),
			options: options.map((option) => ({ optionId: option.optionId, name: option.name, kind: option.kind })),
		};
		let timer: NodeJS.Timeout | undefined;
		try {
			const decision = await Promise.race<AgentPermissionDecision>([
				sink.onPermissionRequest(payload),
				new Promise<AgentPermissionDecision>((resolve) => {
					timer = setTimeout(() => resolve({ optionId: null, reason: "审核超时，已拒绝" }), PERMISSION_TIMEOUT_MS);
					timer.unref?.();
				}),
			]);
			this.options.log?.(`[agy] permission reply id=${requestId} option=${decision.optionId ?? "(deny)"}`);
			client.answerPermission(requestId, decision.optionId ?? denyOption(options));
		} catch {
			this.options.log?.(`[agy] permission reply id=${requestId} option=(deny/timeout)`);
			client.answerPermission(requestId, denyOption(options));
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	// -------------------------------------------------------------------------
	// 斜杠命令 / 技能
	// -------------------------------------------------------------------------

	async getSlashCommands(): Promise<SlashCommandInfo[]> {
		return [
			{
				name: "usage",
				description: "查询一次 Antigravity 额度（20x 滚动配额；仅单次，不轮询）",
				descriptionEn: "Query Antigravity quota once (no polling)",
				source: "builtin",
			} as SlashCommandInfo,
			{
				name: "agy-skills",
				description: "把已有技能目录软链到项目 .agents/skills/（两个内核共享同一份技能）",
				descriptionEn: "Symlink existing skill dirs into .agents/skills/ for the Antigravity CLI",
				source: "builtin",
			} as SlashCommandInfo,
			{
				name: "agy-mcp",
				description: "查看 agy 的 MCP 配置路径与当前项目挂载的 stdio 服务",
				descriptionEn: "Show agy MCP config paths and project-declared stdio servers",
				source: "builtin",
			} as SlashCommandInfo,
		];
	}

	async execSlashCommand(
		name: string,
		_args: string,
		context?: {
			emitNotice?: (level: "info" | "warning" | "error", text: string, textEn?: string) => void;
		},
	): Promise<boolean> {
		const notice = context?.emitNotice ?? (() => {});
		if (name === "usage") {
			// 红线 5：用户动作触发的单次查询（无定时器、无缓存轮询）
			const snapshot = await queryAgyUsage({ reason: "slash:/usage", command: this.options.command, cwd: this.cwd });
			const zh = formatUsageLines(snapshot, "zh");
			const en = formatUsageLines(snapshot, "en");
			notice(
				snapshot.error ? "warning" : "info",
				zh.join("\n") || "（无额度数据）",
				en.join("\n") || "(no quota data)",
			);
			return true;
		}
		if (name === "agy-skills") {
			const result = linkSkillsIntoProject(this.cwd);
			const summary = [
				`技能目录：${agySkillsDir(this.cwd)}`,
				`新链接 ${result.linked.length} 个${result.linked.length ? `（${result.linked.join("、")}）` : ""}`,
				`已存在 ${result.existing.length} 个`,
				result.skipped.length
					? `跳过 ${result.skipped.length} 个：${result.skipped.map((s) => `${s.name}(${s.reason})`).join("；")}`
					: "",
				result.errors.length
					? `失败 ${result.errors.length} 个：${result.errors.map((e) => `${e.name}(${e.reason})`).join("；")}`
					: "",
			]
				.filter(Boolean)
				.join("\n");
			notice(
				result.errors.length ? "warning" : "info",
				summary,
				`Skill dirs: ${agySkillsDir(this.cwd)} · linked ${result.linked.length} · existing ${result.existing.length} · skipped ${result.skipped.length} · failed ${result.errors.length}`,
			);
			return true;
		}
		if (name === "agy-mcp") {
			let servers: Array<{ name: string; command: string }> = [];
			try {
				servers = readProjectMcpConfig(this.cwd).map((server) => ({
					name: server.name,
					command: `${server.command} ${(server.args ?? []).join(" ")}`.trim(),
				}));
			} catch (err) {
				notice(
					"error",
					`读取项目 MCP 配置失败：${(err as Error).message}`,
					`Failed to read project MCP config: ${(err as Error).message}`,
				);
				return true;
			}
			const lines = [
				`项目配置：${agyMcpConfigPath(this.cwd)}（${servers.length} 个 stdio 服务）`,
				...servers.map((server) => `· ${server.name}: ${server.command}`),
				`全局配置：${agyGlobalMcpConfigPath()}（用 agy mcp add 管理）`,
			];
			notice("info", lines.join("\n"), lines.join("\n"));
			return true;
		}
		return false;
	}

	async getSkills(): Promise<Array<{ name: string; description: string; filePath?: string }>> {
		const roots = [agySkillsDir(this.cwd)];
		const skills: Array<{ name: string; description: string; filePath?: string }> = [];
		for (const root of roots) {
			if (!existsSync(root)) continue;
			let entries: string[] = [];
			try {
				entries = readdirSync(root);
			} catch {
				continue;
			}
			for (const entry of entries) {
				const filePath = join(root, entry, "SKILL.md");
				if (!existsSync(filePath)) continue;
				skills.push({ name: entry, description: readSkillDescription(filePath), filePath });
			}
		}
		return skills;
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		const client = this.client;
		this.client = undefined;
		this.needsSession = true;
		if (client) await client.kill();
	}
}

/** `gemini-4-carbon-medium` → `gemini-4-carbon`（ACP 的 config_option 只认族名）。 */
export function baseModelId(modelId: string): string {
	return modelId.replace(/-(minimal|low|medium|high|xhigh|max)$/i, "");
}

function toolParams(call: AcpToolCall | undefined): Record<string, unknown> {
	if (!call) return {};
	const params = call.args ?? call.rawInput ?? {};
	return { ...params, ...(call.title ? { _title: call.title } : {}), ...(call.kind ? { _kind: call.kind } : {}) };
}

function toolOutput(call: AcpToolCall | undefined): string {
	if (!call?.content?.length) return "";
	const parts: string[] = [];
	for (const block of call.content) {
		if (block.type === "diff" && block.path) {
			parts.push(`--- ${block.path}\n${block.oldText ?? ""}${block.newText ? `→\n${block.newText}` : ""}`);
		} else if (block.type === "content" && block.content?.type === "text") {
			parts.push(block.content.text);
		} else if (typeof (block as unknown as { text?: string }).text === "string") {
			parts.push((block as unknown as { text: string }).text);
		}
	}
	return parts.join("\n").trim();
}

function readSkillDescription(filePath: string): string {
	try {
		const text = readFileSync(filePath, "utf8");
		const frontMatter = /^---\n([\s\S]*?)\n---/.exec(text);
		const match = frontMatter ? /description:\s*(.+)/.exec(frontMatter[1]) : null;
		return (match?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
	} catch {
		return "";
	}
}

/** 把宿主 prompt + 附件转成 ACP content blocks（只做格式适配，不做能力伪装）。 */
export function buildPromptBlocks(prompt: string, attachments: PromptAttachment[] | undefined): AcpContentBlock[] {
	const blocks: AcpContentBlock[] = [];
	let text = prompt;
	for (const attachment of attachments ?? []) {
		if (attachment.imageData) {
			const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(attachment.imageData);
			if (match) {
				blocks.push({ type: "image", mimeType: match[1], data: match[2] });
				continue;
			}
		}
		if (attachment.mode === "quote" && attachment.quote) {
			text += `\n<quote>\n${attachment.quote.text}\n</quote>`;
			continue;
		}
		if (attachment.path) {
			text += `\n[参考文件] ${attachment.path}${
				attachment.mode === "lines" ? `（第 ${attachment.lines?.start ?? ""}-${attachment.lines?.end ?? ""} 行）` : ""
			}`;
		}
	}
	// 跨内核接力：纯文本进、签名出（推理签名块绝不能带进 другой厂商的接口）
	const cleaned = stripReasoningSignatures(text);
	if (cleaned.trim()) blocks.unshift({ type: "text", text: cleaned });
	return blocks;
}
