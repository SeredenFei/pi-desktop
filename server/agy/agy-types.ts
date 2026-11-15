/**
 * agy-types.ts — Antigravity CLI（agy）Agent Client Protocol（ACP）线协议类型。
 *
 * 事实源自 2026-11-15 对 `agy acp` 1.5.9 的实测探针：
 *   initialize → session/new → session/prompt 的完整往返、通知形状、权限请求形状、
 *   config_option 切换与 usage 结构均以本文件为准（见 docs/agy-acp-engine.md §2）。
 *
 * 只描述 pi-desktop 真正消费的字段；其余透传保留在 `raw`。
 */

/** ACP 协议版本（agy acp 1.5.x 回报 protocolVersion=1） */
export const ACP_PROTOCOL_VERSION = 1;

export interface AcpJsonRpcRequest {
	jsonrpc: "2.0";
	id: number;
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcNotification {
	jsonrpc: "2.0";
	method: string;
	params?: unknown;
}

export interface AcpJsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/** 驱动可见的 ACP 错误（带 JSON-RPC code，便于上层区分「未登录」「方法不存在」） */
export class AcpRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "AcpRpcError";
	}
}

export interface AcpAuthMethod {
	id: string;
	name: string;
	description?: string;
}

export interface AcpInitializeResult {
	protocolVersion: number;
	agentCapabilities?: {
		loadSession?: boolean;
		promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
		sessionCapabilities?: Record<string, unknown>;
		auth?: Record<string, unknown>;
		_meta?: { antigravity?: { tier?: boolean; systemPrompt?: { append?: boolean } } };
	};
	agentInfo?: { name?: string; version?: string };
	authMethods?: AcpAuthMethod[];
}

/** session/new 下发的「模型/思考档位/模式」选择器（ACP configOptions） */
export interface AcpConfigOption {
	id: string;
	name: string;
	category?: string;
	type: "select";
	currentValue: string;
	options: Array<{ value: string; name: string; description?: string }>;
}

export interface AcpModelInfo {
	modelId: string;
	name: string;
	description?: string;
}

export interface AcpSessionNewResult {
	sessionId: string;
	models?: { availableModels?: AcpModelInfo[]; currentModelId?: string };
	modes?: { currentModeId?: string; availableModes?: Array<{ id: string; name: string; description?: string }> };
	configOptions?: AcpConfigOption[];
	_meta?: { antigravity?: { tier?: AgyTier } } & Record<string, unknown>;
}

/** 订阅档位（session/new 的 _meta.antigravity.tier；只读展示，不做任何推断） */
export interface AgyTier {
	name?: string;
	id?: string;
	upgradeUri?: string;
}

/** ACP content block（prompt 入参与 agent 流式输出共用） */
export type AcpContentBlock =
	| { type: "text"; text: string }
	| { type: "image"; mimeType: string; data: string }
	| { type: "resource_link"; uri: string; name?: string; mimeType?: string };

/** tool_call 的定位与差异内容（前端工具卡片展示用） */
export interface AcpToolCallLocation {
	path: string;
	line?: number;
}

export interface AcpToolCallContent {
	type: "content" | "diff" | "terminal";
	path?: string;
	oldText?: string;
	newText?: string;
	content?: AcpContentBlock;
}

export interface AcpToolCall {
	sessionUpdate?: "tool_call";
	toolCallId: string;
	title?: string;
	name?: string;
	kind?: string;
	status?: "pending" | "in_progress" | "completed" | "failed";
	rawInput?: Record<string, unknown>;
	args?: Record<string, unknown>;
	locations?: AcpToolCallLocation[];
	content?: AcpToolCallContent[];
}

export interface AcpPermissionOption {
	optionId: string;
	name?: string;
	/** ACP 标准 kind：allow_once / allow_always / reject_once / reject_always */
	kind?: string;
}

export interface AcpPermissionRequest {
	sessionId: string;
	toolCall: AcpToolCall;
	options: AcpPermissionOption[];
}

export interface AcpPromptResult {
	stopReason: "end_turn" | "max_tokens" | "refusal" | "cancelled" | string;
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cachedReadTokens?: number;
		cachedWriteTokens?: number;
		thoughtTokens?: number;
		totalTokens?: number;
	};
	_meta?: Record<string, unknown>;
}

/** session/update 通知的 update 联合（只列 pi-desktop 消费的分支） */
export type AcpSessionUpdate =
	| { sessionUpdate: "agent_message_chunk"; content: AcpContentBlock }
	| { sessionUpdate: "agent_thought_chunk"; content: AcpContentBlock }
	| { sessionUpdate: "user_message_chunk"; content: AcpContentBlock }
	| ({ sessionUpdate: "tool_call"; toolCallId: string; title?: string; status?: string } & Partial<AcpToolCall>)
	| ({ sessionUpdate: "tool_call_update" } & Partial<AcpToolCall>)
	| { sessionUpdate: "usage_update"; used: number; size: number }
	| { sessionUpdate: "session_info_update"; title?: string }
	| {
			sessionUpdate: "available_commands_update";
			availableCommands?: Array<{ name: string; description?: string; input?: unknown }>;
	  }
	| { sessionUpdate: "config_option_update"; configOptions?: AcpConfigOption[] }
	| { sessionUpdate: "current_mode_update"; currentModeId?: string }
	| { sessionUpdate: "plan"; entries?: Array<{ content: string; status: string; priority?: string }> }
	| { sessionUpdate: string; [key: string]: unknown };

export interface AcpSessionNotification {
	sessionId: string;
	update: AcpSessionUpdate;
}

/** ACP mcpServers 入参（stdio 形态；以 agy 官方配置结构为准） */
export interface AcpMcpServerStdio {
	name: string;
	command: string;
	args?: string[];
	env?: Array<{ name: string; value: string }>;
}

/** `agy mcp list --json` 之外的本地 MCP 配置文件（项目/全局）结构 */
export interface AgyMcpConfigFile {
	mcpServers?: Record<
		string,
		{
			command?: string;
			args?: string[];
			env?: Record<string, string> | Array<{ name: string; value: string }>;
			type?: string;
			url?: string;
		}
	>;
}

/** `agy -p /usage --output-format json` 的输出结构（按需单次查询；绝不轮询） */
export interface AgyUsageReport {
	groups: Array<{
		name: string;
		description?: string;
		buckets: Array<{
			id: string;
			name: string;
			description?: string;
			/** weekly | 5h */
			window?: string;
			remaining_fraction?: number;
			reset_time?: string;
		}>;
	}>;
	/** 原始 JSON（未知字段透传） */
	raw: unknown;
}
