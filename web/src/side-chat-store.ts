/**
 * side-chat-store.ts — 侧边聊天前端独立外部状态仓库（useSyncExternalStore）。
 *
 * 与主对话 ChatState 解耦：
 * - 侧边流式 delta 仅重渲染 SideChatPanel，绝不触发主对话 MessageList 全量刷新；
 * - 消息锚点徽标（💬 N）通过原语数值订阅 `useMessageSideThreadCount(msgId)` 精准按条更新；
 * - 钉选模型持久化于 `localStorage["pi-web-ui:side-chat-model"]`（空串 = 跟随主对话模型）。
 */
import { useSyncExternalStore } from "react";
import { withToken } from "./auth-token";
import { appUrl } from "./base-url";
import { appSend } from "./app-globals";
import { messageMarkdown } from "./copy-text";
import type { UiMessage } from "./types";

export type SideChatContextMode = "selection" | "turn" | "full";

export interface SideChatAnchor {
	selectedText: string;
	messageId: string;
	role: string;
	turnContext?: string;
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
	model?: string;
	messages: SideChatMessage[];
	createdAt: number;
	updatedAt: number;
}

export interface SideChatStreamingState {
	text: string;
	tools: SideChatToolTrace[];
}

export interface SideChatSnapshot {
	mainSessionId: string;
	cwd: string;
	fallbackModel: string;
	threads: SideChatThread[];
	activeThreadId: string | null;
	draftAnchor: SideChatAnchor | null;
	draftContextMode: SideChatContextMode;
	pinnedModel: string;
	loading: boolean;
	error: string;
	focusNonce: number;
	streamingByThread: Record<string, SideChatStreamingState>;
}

const LS_SIDE_CHAT_MODEL = "pi-web-ui:side-chat-model";
const LS_SIDE_CHAT_CTX_MODE = "pi-web-ui:side-chat-ctx-mode";
const MAX_TURN_CHARS = 18_000;
const MAX_FULL_CHARS = 36_000;

function loadPinnedModel(): string {
	try {
		return localStorage.getItem(LS_SIDE_CHAT_MODEL)?.trim() ?? "";
	} catch {
		return "";
	}
}

function loadDefaultContextMode(): SideChatContextMode {
	try {
		const raw = localStorage.getItem(LS_SIDE_CHAT_CTX_MODE);
		if (raw === "selection" || raw === "turn" || raw === "full") return raw;
	} catch {
		/* ignore */
	}
	return "turn";
}

/**
 * 从主对话消息列表构造侧边问答锚点（含单轮上下文与受预算限制的完整上文）。
 * 纯函数，单测覆盖。
 */
export function buildAnchorFromTranscript(
	messages: readonly UiMessage[],
	targetMessageId: string,
	selectedText: string,
	fallbackRole = "assistant",
): SideChatAnchor {
	const idx = messages.findIndex((m) => m.id === targetMessageId);
	const target = idx >= 0 ? messages[idx] : undefined;
	const role = target?.role ?? fallbackRole;
	const cleanSelected = selectedText.trim() || (target ? messageMarkdown(target.content).trim().slice(0, 4000) : "");

	let turnContext = "";
	if (idx >= 0 && target) {
		const parts: string[] = [];
		if (target.role === "assistant") {
			for (let i = idx - 1; i >= 0; i--) {
				if (messages[i].role === "user") {
					const q = messageMarkdown(messages[i].content).trim();
					if (q) parts.push(`User:\n${q}`);
					break;
				}
			}
			const a = messageMarkdown(target.content).trim();
			if (a) parts.push(`Assistant:\n${a}`);
		} else {
			const q = messageMarkdown(target.content).trim();
			if (q) parts.push(`User:\n${q}`);
			for (let i = idx + 1; i < messages.length; i++) {
				if (messages[i].role === "assistant") {
					const a = messageMarkdown(messages[i].content).trim();
					if (a) parts.push(`Assistant:\n${a}`);
					break;
				}
				if (messages[i].role === "user") break;
			}
		}
		turnContext = parts.join("\n\n").slice(0, MAX_TURN_CHARS);
	}

	let fullContext = "";
	if (idx >= 0) {
		const chunks: string[] = [];
		let budget = MAX_FULL_CHARS;
		for (let i = idx; i >= 0; i--) {
			const m = messages[i];
			if (m.role !== "user" && m.role !== "assistant") continue;
			const md = messageMarkdown(m.content).trim();
			if (!md) continue;
			const label = m.role === "user" ? "User" : "Assistant";
			const block = `[${label}]\n${md}`;
			if (block.length > budget && chunks.length > 0) break;
			chunks.unshift(block.slice(0, budget));
			budget -= block.length;
			if (budget <= 0) break;
		}
		fullContext = chunks.join("\n\n");
	}

	return {
		selectedText: cleanSelected,
		messageId: targetMessageId,
		role,
		...(turnContext ? { turnContext } : {}),
		...(fullContext ? { fullContext } : {}),
	};
}

/**
 * 增量解析 NDJSON 缓冲区：返回已完整换行的对象数组与剩余半行尾部（纯函数）。
 */
export function drainNdjsonLines(buffer: string): { events: Array<Record<string, unknown>>; rest: string } {
	const events: Array<Record<string, unknown>> = [];
	let start = 0;
	for (;;) {
		const nl = buffer.indexOf("\n", start);
		if (nl < 0) break;
		const line = buffer.slice(start, nl).trim();
		start = nl + 1;
		if (!line) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed && typeof parsed === "object") {
				events.push(parsed as Record<string, unknown>);
			}
		} catch {
			/* ignore malformed chunk */
		}
	}
	return { events, rest: buffer.slice(start) };
}

interface SideChatUiHost {
	openPanelAndFocusTab: () => void;
	jumpToMessage: (messageId: string) => void;
	onNotice?: (level: "info" | "warning" | "error", text: string) => void;
}

let uiHost: SideChatUiHost | null = null;
let mainTranscriptRef: readonly UiMessage[] = [];
const inflightControllers = new Map<string, AbortController>();
let fetchThreadsSeq = 0;

let state: SideChatSnapshot = {
	mainSessionId: "",
	cwd: "",
	fallbackModel: "",
	threads: [],
	activeThreadId: null,
	draftAnchor: null,
	draftContextMode: loadDefaultContextMode(),
	pinnedModel: loadPinnedModel(),
	loading: false,
	error: "",
	focusNonce: 0,
	streamingByThread: {},
};

const listeners = new Set<() => void>();

function emit(): void {
	for (const fn of listeners) fn();
}

function setState(patch: Partial<SideChatSnapshot>): void {
	state = { ...state, ...patch };
	emit();
}

export function subscribeSideChat(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getSideChatSnapshot(): SideChatSnapshot {
	return state;
}

export function useSideChatState(): SideChatSnapshot {
	return useSyncExternalStore(subscribeSideChat, getSideChatSnapshot, getSideChatSnapshot);
}

/**
 * 订阅单条主消息关联的侧边话题数量（原语 number：无变化零重渲染）。
 */
export function useMessageSideThreadCount(messageId: string): number {
	return useSyncExternalStore(
		subscribeSideChat,
		() => {
			if (!messageId) return 0;
			let n = 0;
			for (const t of state.threads) {
				if (t.anchor?.messageId === messageId) n += 1;
			}
			return n;
		},
		() => 0,
	);
}

export function registerSideChatUiHost(host: SideChatUiHost | null): void {
	uiHost = host;
}

/**
 * 由 App 同步当前主会话身份与消息引用（不触发无关重渲染，仅在 mainSessionId 切换时拉取对应话题列表）。
 */
export function syncSideChatMainContext(ctx: {
	mainSessionId: string;
	cwd: string;
	fallbackModel: string;
	messages: readonly UiMessage[];
}): void {
	mainTranscriptRef = ctx.messages;
	const sessionChanged = ctx.mainSessionId !== state.mainSessionId;
	const metaChanged = ctx.cwd !== state.cwd || ctx.fallbackModel !== state.fallbackModel;
	if (!sessionChanged && !metaChanged) return;

	if (sessionChanged) {
		setState({
			mainSessionId: ctx.mainSessionId,
			cwd: ctx.cwd,
			fallbackModel: ctx.fallbackModel,
			threads: [],
			activeThreadId: null,
			draftAnchor: null,
			error: "",
		});
		if (ctx.mainSessionId) {
			void reloadSideChatThreads(ctx.mainSessionId);
		}
	} else {
		setState({
			cwd: ctx.cwd,
			fallbackModel: ctx.fallbackModel,
		});
	}
}

export async function reloadSideChatThreads(targetSessionId?: string): Promise<void> {
	const sid = (targetSessionId ?? state.mainSessionId).trim();
	if (!sid) return;
	const seq = ++fetchThreadsSeq;
	setState({ loading: true, error: "" });
	try {
		const res = await fetch(withToken(appUrl(`/api/side-chat/threads?mainSessionId=${encodeURIComponent(sid)}`)), {
			credentials: "same-origin",
		});
		const data = (await res.json()) as { threads?: SideChatThread[]; error?: string };
		if (seq !== fetchThreadsSeq || sid !== state.mainSessionId) return;
		if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
		const list = Array.isArray(data.threads) ? data.threads : [];
		const hasActive = state.activeThreadId && list.some((t) => t.id === state.activeThreadId);
		setState({
			threads: list,
			activeThreadId: hasActive ? state.activeThreadId : state.draftAnchor ? null : (list[0]?.id ?? null),
			loading: false,
			error: "",
		});
	} catch (err) {
		if (seq !== fetchThreadsSeq) return;
		setState({
			loading: false,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

export function setSideChatPinnedModel(modelSpec: string): void {
	const clean = modelSpec.trim();
	try {
		if (clean) localStorage.setItem(LS_SIDE_CHAT_MODEL, clean);
		else localStorage.removeItem(LS_SIDE_CHAT_MODEL);
	} catch {
		/* ignore */
	}
	setState({ pinnedModel: clean });
	if (state.activeThreadId && state.mainSessionId) {
		void fetch(withToken(appUrl("/api/side-chat/threads")), {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				op: "update",
				mainSessionId: state.mainSessionId,
				threadId: state.activeThreadId,
				model: clean,
			}),
		}).catch(() => {});
	}
}

export function setSideChatContextMode(mode: SideChatContextMode): void {
	try {
		localStorage.setItem(LS_SIDE_CHAT_CTX_MODE, mode);
	} catch {
		/* ignore */
	}
	if (state.activeThreadId && state.mainSessionId) {
		const nextThreads = state.threads.map((t) => (t.id === state.activeThreadId ? { ...t, contextMode: mode } : t));
		setState({ draftContextMode: mode, threads: nextThreads });
		void fetch(withToken(appUrl("/api/side-chat/threads")), {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				op: "update",
				mainSessionId: state.mainSessionId,
				threadId: state.activeThreadId,
				contextMode: mode,
			}),
		}).catch(() => {});
	} else {
		setState({ draftContextMode: mode });
	}
}

export function selectSideChatThread(threadId: string | null): void {
	setState({
		activeThreadId: threadId,
		draftAnchor: threadId ? null : state.draftAnchor,
		error: "",
	});
}

export function startBlankSideChatDraft(): void {
	setState({
		activeThreadId: null,
		draftAnchor: null,
		error: "",
		focusNonce: state.focusNonce + 1,
	});
}

export function clearSideChatDraftAnchor(): void {
	setState({ draftAnchor: null });
}

/**
 * 从消息选区（右键菜单 / 划词胶囊）唤起右栏侧边聊天；若附带 autoQuestion 则立即流式提问。
 */
export function openSideChatFromSelection(opts: {
	selectedText: string;
	messageId: string;
	role?: string;
	autoQuestion?: string;
}): void {
	const anchor = buildAnchorFromTranscript(
		mainTranscriptRef,
		opts.messageId,
		opts.selectedText,
		opts.role ?? "assistant",
	);
	uiHost?.openPanelAndFocusTab();
	if (opts.autoQuestion?.trim()) {
		setState({
			activeThreadId: null,
			draftAnchor: anchor,
			error: "",
		});
		void askSideChat(opts.autoQuestion.trim(), { forceNewThread: true, anchorOverride: anchor });
	} else {
		setState({
			activeThreadId: null,
			draftAnchor: anchor,
			error: "",
			focusNonce: state.focusNonce + 1,
		});
	}
}

/**
 * 点击主消息上的 💬 锚点徽标 → 打开右栏侧边聊天并定位到该消息关联的最新话题。
 */
export function openSideChatForMessage(messageId: string): void {
	uiHost?.openPanelAndFocusTab();
	const found = state.threads.find((t) => t.anchor?.messageId === messageId);
	if (found) {
		setState({
			activeThreadId: found.id,
			draftAnchor: null,
			error: "",
		});
	}
}

/**
 * 从侧边聊天顶部选区卡点击跳回并高亮原主对话消息。
 */
export function jumpToSideChatAnchor(messageId: string): void {
	if (!messageId) return;
	uiHost?.jumpToMessage(messageId);
}

export async function deleteSideChatThread(threadId: string): Promise<void> {
	const sid = state.mainSessionId;
	if (!sid || !threadId) return;
	abortSideChatStream(threadId);
	const remaining = state.threads.filter((t) => t.id !== threadId);
	setState({
		threads: remaining,
		activeThreadId: state.activeThreadId === threadId ? (remaining[0]?.id ?? null) : state.activeThreadId,
	});
	try {
		await fetch(
			withToken(
				appUrl(`/api/side-chat/threads/${encodeURIComponent(threadId)}?mainSessionId=${encodeURIComponent(sid)}`),
			),
			{ method: "DELETE", credentials: "same-origin" },
		);
	} catch {
		/* ignore */
	}
}

export function abortSideChatStream(threadId?: string): void {
	const id = threadId ?? state.activeThreadId ?? "__draft__";
	const ctrl = inflightControllers.get(id);
	if (ctrl) {
		ctrl.abort();
		inflightControllers.delete(id);
	}
	if (id !== "__draft__") {
		void fetch(withToken(appUrl("/api/side-chat/abort")), {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ threadId: id }),
		}).catch(() => {});
	}
}

function upsertThreadInList(list: readonly SideChatThread[], thread: SideChatThread): SideChatThread[] {
	const idx = list.findIndex((t) => t.id === thread.id);
	if (idx < 0) return [thread, ...list];
	const next = [...list];
	next[idx] = thread;
	return next.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function askSideChat(
	question: string,
	opts?: { forceNewThread?: boolean; anchorOverride?: SideChatAnchor | null },
): Promise<void> {
	const q = question.trim();
	const sid = state.mainSessionId.trim();
	if (!q) return;
	if (!sid) {
		setState({ error: "当前主会话尚未就绪，请稍候再试" });
		return;
	}

	const targetThreadId = opts?.forceNewThread ? undefined : (state.activeThreadId ?? undefined);
	const activeThread = targetThreadId ? state.threads.find((t) => t.id === targetThreadId) : undefined;
	const anchor = opts?.anchorOverride !== undefined ? opts.anchorOverride : (activeThread?.anchor ?? state.draftAnchor);
	const contextMode = activeThread?.contextMode ?? state.draftContextMode;
	const model = (activeThread?.model ?? state.pinnedModel).trim();

	let trackingKey = targetThreadId ?? "__draft__";
	inflightControllers.get(trackingKey)?.abort();
	const controller = new AbortController();
	inflightControllers.set(trackingKey, controller);

	setState({
		error: "",
		streamingByThread: {
			...state.streamingByThread,
			[trackingKey]: { text: "", tools: [] },
		},
	});

	try {
		const res = await fetch(withToken(appUrl("/api/side-chat/ask")), {
			method: "POST",
			credentials: "same-origin",
			signal: controller.signal,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				mainSessionId: sid,
				...(targetThreadId ? { threadId: targetThreadId } : {}),
				question: q,
				cwd: state.cwd,
				...(anchor ? { anchor } : {}),
				contextMode,
				...(model ? { model } : {}),
				...(state.fallbackModel ? { fallbackModel: state.fallbackModel } : {}),
			}),
		});

		if (!res.ok || !res.body) {
			let errText = `HTTP ${res.status}`;
			try {
				const errJson = (await res.json()) as { error?: string };
				if (errJson?.error) errText = errJson.error;
			} catch {
				/* ignore */
			}
			throw new Error(errText);
		}

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";

		const handleEvent = (ev: Record<string, unknown>) => {
			if (ev.type === "thread" && ev.thread && typeof ev.thread === "object") {
				const serverThread = ev.thread as SideChatThread;
				if (trackingKey !== serverThread.id) {
					const prevStream = state.streamingByThread[trackingKey] ?? { text: "", tools: [] };
					const nextMap = { ...state.streamingByThread };
					delete nextMap[trackingKey];
					nextMap[serverThread.id] = prevStream;
					inflightControllers.delete(trackingKey);
					trackingKey = serverThread.id;
					inflightControllers.set(trackingKey, controller);
					setState({
						threads: upsertThreadInList(state.threads, serverThread),
						activeThreadId: serverThread.id,
						draftAnchor: null,
						streamingByThread: nextMap,
					});
				} else {
					setState({
						threads: upsertThreadInList(state.threads, serverThread),
						activeThreadId: serverThread.id,
						draftAnchor: null,
					});
				}
			} else if (ev.type === "text_delta" && typeof ev.delta === "string") {
				const cur = state.streamingByThread[trackingKey] ?? { text: "", tools: [] };
				setState({
					streamingByThread: {
						...state.streamingByThread,
						[trackingKey]: {
							...cur,
							text: cur.text + ev.delta,
						},
					},
				});
			} else if (ev.type === "tool_start" && ev.tool && typeof ev.tool === "object") {
				const cur = state.streamingByThread[trackingKey] ?? { text: "", tools: [] };
				setState({
					streamingByThread: {
						...state.streamingByThread,
						[trackingKey]: {
							...cur,
							tools: [...cur.tools, ev.tool as SideChatToolTrace],
						},
					},
				});
			} else if (ev.type === "tool_end" && typeof ev.id === "string") {
				const cur = state.streamingByThread[trackingKey];
				if (!cur) return;
				setState({
					streamingByThread: {
						...state.streamingByThread,
						[trackingKey]: {
							...cur,
							tools: cur.tools.map((t) => (t.id === ev.id ? { ...t, status: ev.isError ? "error" : "done" } : t)),
						},
					},
				});
			} else if ((ev.type === "done" || ev.type === "error") && ev.thread && typeof ev.thread === "object") {
				const finalThread = ev.thread as SideChatThread;
				const nextMap = { ...state.streamingByThread };
				delete nextMap[trackingKey];
				delete nextMap[finalThread.id];
				setState({
					threads: upsertThreadInList(state.threads, finalThread),
					activeThreadId: finalThread.id,
					streamingByThread: nextMap,
					...(ev.type === "error" && typeof ev.error === "string" ? { error: ev.error } : {}),
				});
			}
		};

		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			const drained = drainNdjsonLines(buf);
			buf = drained.rest;
			for (const ev of drained.events) handleEvent(ev);
		}
		buf += decoder.decode();
		if (buf.trim()) {
			const drained = drainNdjsonLines(`${buf}\n`);
			for (const ev of drained.events) handleEvent(ev);
		}
	} catch (err) {
		if ((err as { name?: string })?.name !== "AbortError") {
			setState({ error: err instanceof Error ? err.message : String(err) });
		}
	} finally {
		if (inflightControllers.get(trackingKey) === controller) {
			inflightControllers.delete(trackingKey);
		}
		if (state.streamingByThread[trackingKey]) {
			const nextMap = { ...state.streamingByThread };
			delete nextMap[trackingKey];
			setState({ streamingByThread: nextMap });
		}
		if (sid === state.mainSessionId) {
			void reloadSideChatThreads(sid);
		}
	}
}

/**
 * 一键将当前侧边话题升级为独立可读写的主对话并切换过去。
 */
export async function promoteSideChatToMain(threadId?: string): Promise<boolean> {
	const id = threadId ?? state.activeThreadId;
	const sid = state.mainSessionId;
	if (!id || !sid) return false;
	try {
		const res = await fetch(withToken(appUrl("/api/side-chat/promote")), {
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mainSessionId: sid, threadId: id }),
		});
		const data = (await res.json()) as {
			ok?: boolean;
			sessionPath?: string;
			sessionId?: string;
			title?: string;
			error?: string;
		};
		if (!res.ok || !data.ok || !data.sessionPath) {
			throw new Error(data.error || `HTTP ${res.status}`);
		}
		appSend({ type: "list_sessions" });
		appSend({ type: "switch_session", path: data.sessionPath, sessionId: data.sessionId });
		uiHost?.onNotice?.("info", data.title ? `已升级为独立对话：${data.title}` : "已升级为独立对话");
		return true;
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		setState({ error: msg });
		uiHost?.onNotice?.("error", msg);
		return false;
	}
}
