/**
 * agy-handoff.ts — 跨内核接力时的上下文清洗（工作区共享，推理签名不共享）。
 *
 * 场景：你在 pi 内核里做到一半，切到 agy 内核继续同一任务。
 *   - ✅ 可以直接共享：工作区代码、`.agents/skills/` 技能、本地记忆文件、MCP 配置。
 *   - ❌ 绝不能传递：原模型专属的**加密推理签名块**（`thinkingSignature`、`signature`、
 *     `encrypted_content` 等），以及工具调用 id / 供应商内部字段。跨厂商接口会直接
 *     校验失败，或者把上一家的推理当成本家的思维链。
 *
 * 本模块只做「纯文本化」：保留 role 与可见正文（含工具调用的名字与参数文本），
 * 丢弃一切签名/内部 id。任何跨内核的历史注入都必须先过 `sanitizeCrossEngineHistory`。
 */

/** 明文可见的文本块类型（其余一律丢弃）。 */
const TEXT_BLOCK_TYPES = new Set(["text"]);

/** 需要被剔除的签名字段名（不同厂商叫法不同，全部按字段名剥）。 */
const SIGNATURE_FIELDS = new Set([
	"thinkingSignature",
	"thinking_signature",
	"thoughtSignature",
	"thought_signature",
	"signature",
	"encryptedContent",
	"encrypted_content",
	"reasoningContent",
	"reasoning_content",
	"reasoningDetails",
	"reasoning_details",
	"providerMetadata",
	"provider_metadata",
	"cacheControl",
	"cache_control",
]);

export interface HandoffMessageLike {
	role: string;
	content?: unknown;
}

export interface HandoffLine {
	role: "user" | "assistant" | "tool";
	text: string;
}

/** 判断一个字段名是否属于「签名/供应商内部」类，需要剥离。 */
export function isSignatureField(key: string): boolean {
	return SIGNATURE_FIELDS.has(key);
}

/** 深度剥离对象里的签名类字段（返回新对象，不改入参）。 */
export function stripSignatureFields<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => stripSignatureFields(item)) as unknown as T;
	if (!value || typeof value !== "object") return value;
	const out: Record<string, unknown> = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
		if (isSignatureField(key)) continue;
		out[key] = stripSignatureFields(item);
	}
	return out as T;
}

/**
 * 把一段自由文本里的推理签名块剪掉。
 * 覆盖 `<thinking_signature>…</thinking_signature>` 与内联 base64 签名标记两类常见形态。
 */
export function stripReasoningSignatures(text: string): string {
	return text
		.replace(
			/<(?:thinking_signature|thought_signature|signature)>[\s\S]*?<\/(?:thinking_signature|thought_signature|signature)>/gi,
			"",
		)
		.replace(/\n?\[(?:thinking|thought)[ _-]?signature\][^\n]*/gi, "")
		.replace(/\n?signature:\s*[A-Za-z0-9+/=]{64,}/gi, "");
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (typeof block === "string") {
			parts.push(block);
			continue;
		}
		if (!block || typeof block !== "object") continue;
		const record = block as Record<string, unknown>;
		const type = typeof record.type === "string" ? record.type : "";
		if (TEXT_BLOCK_TYPES.has(type) && typeof record.text === "string") {
			parts.push(record.text);
			continue;
		}
		// 工具调用：只留「谁、调了什么参数」，不留 id 与签名
		if (type === "toolCall" || type === "tool_call") {
			const name = typeof record.name === "string" ? record.name : "tool";
			const args = record.arguments ?? record.args;
			parts.push(
				`[tool ${name}] ${typeof args === "string" ? args : JSON.stringify(stripSignatureFields(args ?? {}))}`,
			);
		}
		if (type === "toolResult" || type === "tool_result") {
			const inner = textOf(record.content);
			if (inner) parts.push(`[tool result] ${inner}`);
		}
	}
	return parts.join("\n").trim();
}

/**
 * 历史 → 可安全喂给另一个内核的纯文本行。
 *
 * - 只保留 user / assistant / tool 三种角色的可见正文；
 * - 丢弃 thinking 块（含签名）、图片/附件二进制、供应商元数据；
 * - 单行超长截断（`maxCharsPerLine`），整体超长按 `maxChars` 从头截断并加省略标记。
 */
export function sanitizeCrossEngineHistory(
	messages: readonly HandoffMessageLike[],
	options?: { maxChars?: number; maxCharsPerLine?: number },
): HandoffLine[] {
	const maxChars = options?.maxChars ?? 24_000;
	const maxCharsPerLine = options?.maxCharsPerLine ?? 4_000;
	const lines: HandoffLine[] = [];
	for (const message of messages) {
		const role =
			message.role === "assistant"
				? "assistant"
				: message.role === "tool" || message.role === "toolResult"
					? "tool"
					: "user";
		const text = stripReasoningSignatures(textOf(stripSignatureFields(message.content)));
		if (!text) continue;
		lines.push({ role, text: text.length > maxCharsPerLine ? `${text.slice(0, maxCharsPerLine)}…` : text });
	}
	let total = 0;
	const out: HandoffLine[] = [];
	for (const line of lines) {
		if (total + line.text.length > maxChars) {
			out.push({ role: "user", text: "…（更早的历史已省略）" });
			break;
		}
		total += line.text.length;
		out.push(line);
	}
	return out;
}

/** 渲染成注入用文本（跨内核接力提示词尾巴）。 */
export function renderHandoffContext(lines: readonly HandoffLine[]): string {
	if (lines.length === 0) return "";
	const body = lines.map((line) => `### ${line.role}\n${line.text}`).join("\n\n");
	return `以下是你之前（另一个内核/模型）在同一任务上的对话，仅保留纯文本上下文，推理签名与工具内部字段已剥离：\n\n${body}`;
}
