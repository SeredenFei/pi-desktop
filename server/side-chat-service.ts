/**
 * side-chat-service.ts — 侧边聊天（Side Chat Threads）存储、只读查证流式问答与会话升级服务。
 *
 * 设计要点：
 * 1. 按主会话 `mainSessionId` 独立存储于 `<dataDir>/side-chats/<hash>.json`，绝不生成主 `.jsonl`
 *    文件，不污染左栏「历史会话」与「运行的对话」列表。
 * 2. 流式问答走独立 HTTP NDJSON 流（`/api/side-chat/ask`），与主对话 WS `snapshot` 通道解耦，
 *    主对话生成期间也可零干扰并发提问。
 * 3. 工具严格限定为只读集合 `["read", "grep", "find", "ls"]`，禁写文件与执行命令，零冲突。
 * 4. 支持一键将有价值的侧边话题升级（Promote）为真实持久化的主对话 `.jsonl` 会话文件。
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import express, { type Express, type Request, type Response } from "express";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { writeJsonAtomicSync } from "./atomic-file.js";
import { parseModelSpec } from "./attachments.js";
import type { ClientStateStore } from "./client-state.js";
import {
	isRemoteWorkspaceUri,
	resolveWorkspaceSessionDir,
	restoreWorkspaceUriFromSessionDir,
} from "./remote-ssh-service.js";

export type SideChatContextMode = "selection" | "turn" | "full";

export interface SideChatAnchor {
	/** 选中的原文片段 */
	selectedText: string;
	/** 锚定的主会话消息 ID */
	messageId: string;
	/** 原消息角色（user / assistant） */
	role: string;
	/** 所在单轮上下文（原消息全文 + 紧邻提问） */
	turnContext?: string;
	/** 截至该消息的完整上文摘录（受预算裁剪） */
	fullContext?: string;
}

export interface SideChatToolTrace {
	id: string;
	name: string;
	argsPreview: string;
	status: "running" | "done" | "error";
}

export interface SideChatMessage {
	id: string;
	role: "user" | "assistant";
	text: string;
	timestamp: number;
	model?: string;
	tools?: SideChatToolTrace[];
	error?: string;
}

export interface SideChatThread {
	id: string;
	mainSessionId: string;
	cwd: string;
	title: string;
	anchor: SideChatAnchor | null;
	contextMode: SideChatContextMode;
	/** 用户钉选的侧边模型（"provider/id"）；空串或未定义表示跟随主对话模型 */
	model?: string;
	messages: SideChatMessage[];
	createdAt: number;
	updatedAt: number;
}

interface SideChatFileDoc {
	version: 1;
	mainSessionId: string;
	threads: SideChatThread[];
}

export interface CreateSideChatThreadInput {
	mainSessionId: string;
	cwd: string;
	title?: string;
	anchor?: SideChatAnchor | null;
	contextMode?: SideChatContextMode;
	model?: string;
}

const MAX_SELECTED_TEXT = 16_000;
const MAX_TURN_CONTEXT = 24_000;
const MAX_FULL_CONTEXT = 48_000;
const MAX_QUESTION_CHARS = 12_000;
const MAX_PRIOR_HISTORY_CHARS = 24_000;
const MAX_THREADS_PER_SESSION = 50;
const MAX_INFLIGHT = 4;
const ASK_TIMEOUT_MS = 180_000;

export function normalizeContextMode(raw: unknown): SideChatContextMode {
	if (raw === "selection" || raw === "turn" || raw === "full") return raw;
	return "turn";
}

function clampText(raw: unknown, maxLen: number): string {
	if (typeof raw !== "string") return "";
	return raw.length > maxLen ? raw.slice(0, maxLen) : raw;
}

export function sanitizeAnchor(raw: unknown): SideChatAnchor | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const selectedText = clampText(obj.selectedText, MAX_SELECTED_TEXT).trim();
	const messageId = clampText(obj.messageId, 200).trim();
	const role = clampText(obj.role, 32).trim() || "assistant";
	if (!selectedText && !messageId) return null;
	const turnContext = clampText(obj.turnContext, MAX_TURN_CONTEXT).trim();
	const fullContext = clampText(obj.fullContext, MAX_FULL_CONTEXT).trim();
	return {
		selectedText,
		messageId,
		role,
		...(turnContext ? { turnContext } : {}),
		...(fullContext ? { fullContext } : {}),
	};
}

export function deriveSideChatTitle(question?: string, selectedText?: string): string {
	const base = (question?.trim() || selectedText?.trim() || "侧边提问").replace(/\s+/g, " ");
	return base.length > 36 ? `${base.slice(0, 36)}…` : base;
}

function sessionStorageKey(mainSessionId: string): string {
	return createHash("sha256").update(mainSessionId).digest("hex").slice(0, 24);
}

/**
 * 组装发送给侧边只读模型的完整提示词（纯函数，单测覆盖）。
 */
export function buildSideChatPrompt(
	thread: Pick<SideChatThread, "anchor" | "contextMode">,
	question: string,
	priorMessages: readonly SideChatMessage[] = [],
): string {
	const sections: string[] = [
		[
			"You are a focused Side-Chat assistant embedded beside the user's main coding conversation.",
			"- Answer concisely and directly in the same language as the user's question.",
			"- You have strictly READ-ONLY workspace tools (`read`, `grep`, `find`, `ls`). Use them only when checking actual project files helps answer accurately; never attempt to modify files or run commands.",
			"- Do NOT emit internal inline markers like `[[conv:rename:...]]` or `[[memory:...]]`.",
		].join("\n"),
	];

	const anchor = thread.anchor;
	if (anchor) {
		const mode = normalizeContextMode(thread.contextMode);
		if (mode === "full" && anchor.fullContext) {
			sections.push(`<main_conversation_context>\n${anchor.fullContext}\n</main_conversation_context>`);
		} else if (mode !== "selection" && anchor.turnContext) {
			sections.push(`<source_turn_context>\n${anchor.turnContext}\n</source_turn_context>`);
		}
		if (anchor.selectedText) {
			sections.push(
				`<selected_excerpt role="${anchor.role}" message_id="${anchor.messageId}">\n${anchor.selectedText}\n</selected_excerpt>`,
			);
		}
	}

	if (priorMessages.length > 0) {
		const lines: string[] = [];
		let budget = MAX_PRIOR_HISTORY_CHARS;
		for (let i = priorMessages.length - 1; i >= 0; i--) {
			const m = priorMessages[i];
			if (!m.text.trim()) continue;
			const tag = m.role === "user" ? "User" : "Assistant";
			const entry = `${tag}: ${m.text.trim()}`;
			if (entry.length > budget && lines.length > 0) break;
			lines.unshift(entry.slice(0, budget));
			budget -= entry.length;
			if (budget <= 0) break;
		}
		if (lines.length > 0) {
			sections.push(`<side_chat_history>\n${lines.join("\n\n")}\n</side_chat_history>`);
		}
	}

	sections.push(`User question:\n${question.trim()}`);
	return sections.join("\n\n---\n\n");
}

function summarizeToolArgs(name: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const obj = args as Record<string, unknown>;
	if (typeof obj.path === "string" && obj.path) {
		if (name === "grep" && typeof obj.pattern === "string") {
			return `${obj.pattern} in ${obj.path}`;
		}
		return obj.path;
	}
	if (typeof obj.file_path === "string" && obj.file_path) return obj.file_path;
	if (typeof obj.pattern === "string" && obj.pattern) return obj.pattern;
	return "";
}

export class SideChatStore {
	private readonly rootDir: string;
	private readonly cache = new Map<string, SideChatThread[]>();

	constructor(dataDir: string) {
		this.rootDir = join(dataDir, "side-chats");
	}

	private filePathFor(mainSessionId: string): string {
		return join(this.rootDir, `${sessionStorageKey(mainSessionId)}.json`);
	}

	private load(mainSessionId: string): SideChatThread[] {
		const id = mainSessionId.trim();
		if (!id) return [];
		const hit = this.cache.get(id);
		if (hit) return hit;
		const fp = this.filePathFor(id);
		if (!existsSync(fp)) {
			this.cache.set(id, []);
			return [];
		}
		try {
			const raw = JSON.parse(readFileSync(fp, "utf8")) as Partial<SideChatFileDoc>;
			const list = Array.isArray(raw.threads) ? raw.threads : [];
			this.cache.set(id, list);
			return list;
		} catch {
			this.cache.set(id, []);
			return [];
		}
	}

	private persist(mainSessionId: string, threads: SideChatThread[]): void {
		const id = mainSessionId.trim();
		if (!id) return;
		const sorted = [...threads].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_THREADS_PER_SESSION);
		this.cache.set(id, sorted);
		const fp = this.filePathFor(id);
		if (sorted.length === 0) {
			try {
				rmSync(fp, { force: true });
			} catch {
				/* ignore */
			}
			return;
		}
		mkdirSync(this.rootDir, { recursive: true });
		const doc: SideChatFileDoc = {
			version: 1,
			mainSessionId: id,
			threads: sorted,
		};
		writeJsonAtomicSync(fp, doc);
	}

	listThreads(mainSessionId: string): SideChatThread[] {
		return [...this.load(mainSessionId)].sort((a, b) => b.updatedAt - a.updatedAt);
	}

	getThread(mainSessionId: string, threadId: string): SideChatThread | undefined {
		return this.load(mainSessionId).find((t) => t.id === threadId);
	}

	createThread(input: CreateSideChatThreadInput): SideChatThread {
		const mainSessionId = input.mainSessionId.trim();
		if (!mainSessionId) throw new Error("mainSessionId is required");
		const now = Date.now();
		const anchor = sanitizeAnchor(input.anchor);
		const thread: SideChatThread = {
			id: `sc-${randomUUID()}`,
			mainSessionId,
			cwd: input.cwd.trim(),
			title: input.title?.trim() || deriveSideChatTitle(undefined, anchor?.selectedText),
			anchor,
			contextMode: normalizeContextMode(input.contextMode),
			...(input.model?.trim() ? { model: input.model.trim() } : {}),
			messages: [],
			createdAt: now,
			updatedAt: now,
		};
		const existing = this.load(mainSessionId);
		this.persist(mainSessionId, [thread, ...existing]);
		return thread;
	}

	updateThread(
		mainSessionId: string,
		threadId: string,
		patch: { title?: string; contextMode?: SideChatContextMode; model?: string; anchor?: SideChatAnchor | null },
	): SideChatThread | undefined {
		const list = this.load(mainSessionId);
		const idx = list.findIndex((t) => t.id === threadId);
		if (idx < 0) return undefined;
		const cur = list[idx];
		const updated: SideChatThread = {
			...cur,
			...(typeof patch.title === "string" && patch.title.trim() ? { title: patch.title.trim() } : {}),
			...(patch.contextMode ? { contextMode: normalizeContextMode(patch.contextMode) } : {}),
			...(patch.model !== undefined ? (patch.model.trim() ? { model: patch.model.trim() } : { model: undefined }) : {}),
			...(patch.anchor !== undefined ? { anchor: sanitizeAnchor(patch.anchor) } : {}),
			updatedAt: Date.now(),
		};
		const next = [...list];
		next[idx] = updated;
		this.persist(mainSessionId, next);
		return updated;
	}

	deleteThread(mainSessionId: string, threadId: string): boolean {
		const list = this.load(mainSessionId);
		const next = list.filter((t) => t.id !== threadId);
		if (next.length === list.length) return false;
		this.persist(mainSessionId, next);
		return true;
	}

	appendUserMessage(mainSessionId: string, threadId: string, text: string): SideChatThread | undefined {
		const list = this.load(mainSessionId);
		const idx = list.findIndex((t) => t.id === threadId);
		if (idx < 0) return undefined;
		const cur = list[idx];
		const now = Date.now();
		const userMsg: SideChatMessage = {
			id: `scm-${randomUUID()}`,
			role: "user",
			text: text.trim(),
			timestamp: now,
		};
		const isFirstQuestion = cur.messages.length === 0;
		const updated: SideChatThread = {
			...cur,
			title: isFirstQuestion ? deriveSideChatTitle(text, cur.anchor?.selectedText) : cur.title,
			messages: [...cur.messages, userMsg],
			updatedAt: now,
		};
		const next = [...list];
		next[idx] = updated;
		this.persist(mainSessionId, next);
		return updated;
	}

	appendAssistantMessage(mainSessionId: string, threadId: string, msg: SideChatMessage): SideChatThread | undefined {
		const list = this.load(mainSessionId);
		const idx = list.findIndex((t) => t.id === threadId);
		if (idx < 0) return undefined;
		const cur = list[idx];
		const updated: SideChatThread = {
			...cur,
			messages: [...cur.messages, msg],
			updatedAt: Date.now(),
		};
		const next = [...list];
		next[idx] = updated;
		this.persist(mainSessionId, next);
		return updated;
	}
}

/**
 * 将侧边话题固化为标准 SDK `.jsonl` 主会话文件，返回 sessionPath 与 sessionId。
 */
export function promoteSideChatToMainSession(
	thread: SideChatThread,
	opts: { dataDir: string; defaultCwd: string },
): { sessionPath: string; sessionId: string; title: string } {
	const rawCwd = thread.cwd?.trim() || opts.defaultCwd;
	const restoredCwd = restoreWorkspaceUriFromSessionDir(rawCwd);
	const sessionBaseDir = isRemoteWorkspaceUri(restoredCwd)
		? resolveWorkspaceSessionDir(opts.dataDir, restoredCwd)
		: resolve(restoredCwd);
	const sm = SessionManager.create(sessionBaseDir);
	const title = `💬 ${thread.title || "侧边讨论"}`;

	const contextHeaderLines: string[] = [];
	if (thread.anchor?.selectedText) {
		contextHeaderLines.push(`> **原消息选区摘录：**\n> ${thread.anchor.selectedText.replace(/\n/g, "\n> ")}`);
	}
	if (thread.contextMode !== "selection" && thread.anchor?.turnContext) {
		contextHeaderLines.push(`<details><summary>原轮次上下文</summary>\n\n${thread.anchor.turnContext}\n\n</details>`);
	}
	const prefix = contextHeaderLines.length > 0 ? `${contextHeaderLines.join("\n\n")}\n\n---\n\n` : "";

	if (thread.messages.length === 0) {
		sm.appendMessage({
			role: "user",
			content: [{ type: "text", text: `${prefix}继续围绕上述内容深入讨论。` }],
			timestamp: Date.now(),
		});
	} else {
		thread.messages.forEach((m, index) => {
			if (m.role === "user") {
				const contentText = index === 0 && prefix ? `${prefix}${m.text}` : m.text;
				sm.appendMessage({
					role: "user",
					content: [{ type: "text", text: contentText }],
					timestamp: m.timestamp || Date.now(),
				});
			} else {
				const spec = parseModelSpec(m.model);
				sm.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: m.text || (m.error ? `*(错误：${m.error})*` : "") }],
					api: "openai-completions",
					provider: spec?.provider ?? "side-chat",
					model: spec?.id ?? m.model ?? "side-chat",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: m.timestamp || Date.now(),
				});
			}
		});
	}

	sm.appendSessionInfo(title);
	const sessionPath = sm.getSessionFile();
	if (!sessionPath) {
		throw new Error("Failed to materialize session file for side chat promotion");
	}
	return {
		sessionPath,
		sessionId: sm.getSessionId(),
		title,
	};
}

export interface SideChatRoutesConfig {
	dataDir: string;
	agentDir: string;
	defaultCwd: string;
	stateStore: ClientStateStore;
}

export function registerSideChatRoutes(app: Express, cfg: SideChatRoutesConfig): SideChatStore {
	const store = new SideChatStore(cfg.dataDir);
	const activeAborts = new Map<string, () => void>();
	let inflight = 0;

	const writeNdjson = (res: Response, payload: unknown) => {
		if (res.writableEnded || res.destroyed) return;
		try {
			res.write(`${JSON.stringify(payload)}\n`);
		} catch {
			/* socket closed */
		}
	};

	app.get("/api/side-chat/threads", (req: Request, res: Response) => {
		res.setHeader("Cache-Control", "no-cache");
		const mainSessionId = typeof req.query.mainSessionId === "string" ? req.query.mainSessionId.trim() : "";
		if (!mainSessionId) {
			res.json({ threads: [] });
			return;
		}
		res.json({ threads: store.listThreads(mainSessionId) });
	});

	app.post("/api/side-chat/threads", express.json({ limit: "256kb" }), (req: Request, res: Response) => {
		try {
			const body = (req.body ?? {}) as {
				op?: "create" | "update";
				mainSessionId?: string;
				threadId?: string;
				cwd?: string;
				title?: string;
				anchor?: unknown;
				contextMode?: SideChatContextMode;
				model?: string;
			};
			const mainSessionId = String(body.mainSessionId ?? "").trim();
			if (!mainSessionId) {
				res.status(400).json({ error: "mainSessionId is required" });
				return;
			}
			if (body.op === "update" && body.threadId) {
				const thread = store.updateThread(mainSessionId, String(body.threadId), {
					title: body.title,
					contextMode: body.contextMode,
					model: body.model,
					...(body.anchor !== undefined ? { anchor: sanitizeAnchor(body.anchor) } : {}),
				});
				if (!thread) {
					res.status(404).json({ error: "Side chat thread not found" });
					return;
				}
				res.json({ thread, threads: store.listThreads(mainSessionId) });
				return;
			}
			const thread = store.createThread({
				mainSessionId,
				cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : cfg.defaultCwd,
				title: body.title,
				anchor: sanitizeAnchor(body.anchor),
				contextMode: body.contextMode,
				model: body.model,
			});
			res.json({ thread, threads: store.listThreads(mainSessionId) });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.delete("/api/side-chat/threads/:threadId", (req: Request, res: Response) => {
		const mainSessionId = typeof req.query.mainSessionId === "string" ? req.query.mainSessionId.trim() : "";
		const threadId = String(req.params.threadId ?? "").trim();
		if (!mainSessionId || !threadId) {
			res.status(400).json({ error: "mainSessionId and threadId are required" });
			return;
		}
		activeAborts.get(threadId)?.();
		store.deleteThread(mainSessionId, threadId);
		res.json({ ok: true, threads: store.listThreads(mainSessionId) });
	});

	app.post("/api/side-chat/abort", express.json({ limit: "16kb" }), (req: Request, res: Response) => {
		const threadId = String((req.body as { threadId?: string } | undefined)?.threadId ?? "").trim();
		if (threadId) {
			activeAborts.get(threadId)?.();
		}
		res.json({ ok: true });
	});

	app.post("/api/side-chat/promote", express.json({ limit: "64kb" }), (req: Request, res: Response) => {
		try {
			const body = (req.body ?? {}) as { mainSessionId?: string; threadId?: string };
			const mainSessionId = String(body.mainSessionId ?? "").trim();
			const threadId = String(body.threadId ?? "").trim();
			const thread = store.getThread(mainSessionId, threadId);
			if (!thread) {
				res.status(404).json({ error: "Side chat thread not found" });
				return;
			}
			const promoted = promoteSideChatToMainSession(thread, {
				dataDir: cfg.dataDir,
				defaultCwd: cfg.defaultCwd,
			});
			res.json({ ok: true, ...promoted });
		} catch (err) {
			res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
		}
	});

	app.post("/api/side-chat/ask", express.json({ limit: "512kb" }), async (req: Request, res: Response) => {
		const body = (req.body ?? {}) as {
			mainSessionId?: string;
			threadId?: string;
			question?: string;
			cwd?: string;
			anchor?: unknown;
			contextMode?: SideChatContextMode;
			model?: string;
			fallbackModel?: string;
		};
		const mainSessionId = String(body.mainSessionId ?? "").trim();
		const question = clampText(body.question, MAX_QUESTION_CHARS).trim();
		if (!mainSessionId || !question) {
			res.status(400).json({ error: "mainSessionId and question are required" });
			return;
		}
		if (inflight >= MAX_INFLIGHT) {
			res.status(429).json({ error: "侧边问答并发已满，请稍后再试 / Too many concurrent side-chat requests" });
			return;
		}

		const effectiveCwdRaw = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : cfg.defaultCwd;
		let thread = body.threadId ? store.getThread(mainSessionId, String(body.threadId)) : undefined;
		if (!thread) {
			thread = store.createThread({
				mainSessionId,
				cwd: effectiveCwdRaw,
				anchor: sanitizeAnchor(body.anchor),
				contextMode: body.contextMode,
				model: body.model,
			});
		} else if (body.contextMode || body.model !== undefined || body.anchor !== undefined) {
			thread =
				store.updateThread(mainSessionId, thread.id, {
					contextMode: body.contextMode,
					model: body.model,
					...(body.anchor !== undefined ? { anchor: sanitizeAnchor(body.anchor) } : {}),
				}) ?? thread;
		}

		const priorMessages = [...thread.messages];
		const updatedWithUser = store.appendUserMessage(mainSessionId, thread.id, question) ?? thread;
		const threadId = updatedWithUser.id;

		// 中止同一 thread 上可能仍在跑的旧请求
		activeAborts.get(threadId)?.();

		res.status(200);
		res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
		res.setHeader("Cache-Control", "no-cache, no-transform");
		res.setHeader("X-Accel-Buffering", "no");
		res.flushHeaders?.();

		writeNdjson(res, { type: "thread", thread: updatedWithUser });

		inflight += 1;
		let aborted = false;
		let disposed = false;
		let sessionDispose: (() => void) | undefined;
		let sessionAbort: (() => Promise<void>) | undefined;

		const triggerAbort = () => {
			if (aborted) return;
			aborted = true;
			try {
				void sessionAbort?.().catch(() => {});
			} catch {
				/* ignore */
			}
			sessionDispose?.();
		};
		activeAborts.set(threadId, triggerAbort);
		const onResClose = () => {
			if (!res.writableEnded) triggerAbort();
		};
		res.on("close", onResClose);
		const timer = setTimeout(triggerAbort, ASK_TIMEOUT_MS);

		let streamedText = "";
		let turnHasEmittedText = false;
		const tools: SideChatToolTrace[] = [];
		let resolvedModelLabel = "";

		try {
			const realCwd = restoreWorkspaceUriFromSessionDir(updatedWithUser.cwd || effectiveCwdRaw);
			const isRemote = isRemoteWorkspaceUri(realCwd);
			const sessionBaseDir = isRemote ? resolveWorkspaceSessionDir(cfg.dataDir, realCwd) : resolve(realCwd);

			const modelRuntime = await ModelRuntime.create({
				authPath: join(cfg.agentDir, "auth.json"),
				modelsPath: join(cfg.agentDir, "models.json"),
			});
			if (aborted) throw new Error("aborted");

			const services = await createAgentSessionServices({
				cwd: sessionBaseDir,
				agentDir: cfg.agentDir,
				resourceLoaderOptions: {
					skillsOverride: (r) => ({ ...r, skills: [] }),
				},
				modelRuntime,
			});
			if (aborted) throw new Error("aborted");

			const preferredSpec =
				parseModelSpec(body.model?.trim() || updatedWithUser.model) ??
				parseModelSpec(body.fallbackModel?.trim()) ??
				parseModelSpec(cfg.stateStore.getDefaultModel("pi") ?? undefined);

			let selectedModel;
			if (preferredSpec) {
				const candidate = services.modelRuntime.getModel(preferredSpec.provider, preferredSpec.id);
				if (candidate) {
					selectedModel = candidate;
					resolvedModelLabel = preferredSpec.spec;
				}
			}

			const srv = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(sessionBaseDir),
				...(selectedModel ? { model: selectedModel } : {}),
				thinkingLevel: "low",
				...(isRemote ? { noTools: "all" as const } : { tools: ["read", "grep", "find", "ls"] }),
			});

			sessionAbort = () => srv.session.abort();
			sessionDispose = () => {
				if (disposed) return;
				disposed = true;
				try {
					srv.session.dispose();
				} catch {
					/* ignore */
				}
			};
			if (aborted) {
				sessionDispose();
				throw new Error("aborted");
			}

			if (!resolvedModelLabel && srv.session.model) {
				const m = srv.session.model as { provider?: string; id?: string };
				if (m.provider && m.id) resolvedModelLabel = `${m.provider}/${m.id}`;
			}

			const unsub = srv.session.subscribe((event) => {
				if (aborted) return;
				if (event.type === "turn_start") {
					if (turnHasEmittedText && streamedText && !streamedText.endsWith("\n\n")) {
						streamedText += "\n\n";
						writeNdjson(res, { type: "text_delta", delta: "\n\n" });
					}
					turnHasEmittedText = false;
				} else if (event.type === "message_update") {
					const ame = event.assistantMessageEvent;
					if (ame.type === "text_delta" && "delta" in ame && typeof ame.delta === "string" && ame.delta) {
						turnHasEmittedText = true;
						streamedText += ame.delta;
						writeNdjson(res, { type: "text_delta", delta: ame.delta });
					}
				} else if (event.type === "tool_execution_start") {
					const trace: SideChatToolTrace = {
						id: event.toolCallId,
						name: event.toolName,
						argsPreview: summarizeToolArgs(event.toolName, event.args),
						status: "running",
					};
					tools.push(trace);
					writeNdjson(res, { type: "tool_start", tool: trace });
				} else if (event.type === "tool_execution_end") {
					const found = tools.find((t) => t.id === event.toolCallId);
					if (found) found.status = event.isError ? "error" : "done";
					writeNdjson(res, { type: "tool_end", id: event.toolCallId, isError: Boolean(event.isError) });
				}
			});

			try {
				const fullPrompt = buildSideChatPrompt(updatedWithUser, question, priorMessages);
				await srv.session.prompt(fullPrompt, { expandPromptTemplates: false });
				if (!aborted) {
					const finalText = (streamedText.trim() || srv.session.getLastAssistantText() || "").trim();
					const assistantMsg: SideChatMessage = {
						id: `scm-${randomUUID()}`,
						role: "assistant",
						text: finalText,
						timestamp: Date.now(),
						...(resolvedModelLabel ? { model: resolvedModelLabel } : {}),
						...(tools.length > 0 ? { tools } : {}),
					};
					const saved = store.appendAssistantMessage(mainSessionId, threadId, assistantMsg);
					writeNdjson(res, { type: "done", thread: saved ?? updatedWithUser });
				}
			} finally {
				unsub();
				sessionDispose();
			}
		} catch (err) {
			const errMsg = err instanceof Error ? err.message : String(err);
			if (aborted || errMsg === "aborted") {
				if (streamedText.trim()) {
					const partialMsg: SideChatMessage = {
						id: `scm-${randomUUID()}`,
						role: "assistant",
						text: `${streamedText.trim()}\n\n*(已停止 / Stopped)*`,
						timestamp: Date.now(),
						...(resolvedModelLabel ? { model: resolvedModelLabel } : {}),
						...(tools.length > 0 ? { tools } : {}),
					};
					const saved = store.appendAssistantMessage(mainSessionId, threadId, partialMsg);
					writeNdjson(res, { type: "done", thread: saved ?? updatedWithUser });
				} else {
					writeNdjson(res, { type: "done", thread: store.getThread(mainSessionId, threadId) ?? updatedWithUser });
				}
			} else {
				const errorAssistantMsg: SideChatMessage = {
					id: `scm-${randomUUID()}`,
					role: "assistant",
					text: streamedText.trim(),
					error: errMsg,
					timestamp: Date.now(),
					...(resolvedModelLabel ? { model: resolvedModelLabel } : {}),
					...(tools.length > 0 ? { tools } : {}),
				};
				const saved = store.appendAssistantMessage(mainSessionId, threadId, errorAssistantMsg);
				writeNdjson(res, { type: "error", error: errMsg, thread: saved ?? updatedWithUser });
			}
		} finally {
			clearTimeout(timer);
			res.off("close", onResClose);
			if (activeAborts.get(threadId) === triggerAbort) {
				activeAborts.delete(threadId);
			}
			inflight = Math.max(0, inflight - 1);
			if (!res.writableEnded && !res.destroyed) {
				res.end();
			}
		}
	});

	return store;
}
