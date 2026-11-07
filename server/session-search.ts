/**
 * session-search — 会话转录文件扫描、搜索匹配与锚点收集工具。
 *
 * 负责：
 * - piSessionsRoot: 解析 pi 引擎的会话根目录环境变量
 * - isInsideSessionsDir: 校验路径是否在会话目录下，防止任意文件逃逸
 * - sessionMatchesMetadata / messageSearchText: 会话元数据与转录文本检索
 * - collectSessionAnchors: 扫描消息文本中的查询命中锚点
 * - readCwdFromSessionHeader: 轻量探测转录首行 cwd
 *
 * 从 agent-service.ts 抽出为独立模块。
 */
import * as fsPromises from "node:fs/promises";
import { basename, resolve, sep } from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { MessageAnchor } from "./protocol.js";
import { restoreWorkspaceUriFromSessionDir } from "./remote-ssh-service.js";
import { sessionLines, mapSessionsConcurrent } from "./session-scan.js";
export { mapSessionsConcurrent } from "./session-scan.js";

/** Legacy whole-file reader guard, retained for readHistorySession callers only.
 * Streaming search has no file-size cutoff. */
export const MAX_TRANSCRIPT_SCAN_BYTES = 16 * 1024 * 1024;

/** Legacy parser text-preview budget. Search must use scanSessionForSearch. */
export const MAX_SEARCH_TEXT_CHARS = 256 * 1024;

/** 会话元数据快速匹配（列表初筛）：仅比对 session.name、会话文件名与第一条消息。
 *  显示名、当前项目内的文件名片段、首条消息。
 *  转录全文匹配不在这里：全文单条可达 MB 级，不再随列表缓存常驻（issue #440），
 *  由 searchSessions / scanSessionForSearch 流式判定（仅 user 与 assistant 消息文本）。 */
export function sessionMatchesMetadata(q: string, s: SessionInfo): boolean {
	if (s.name && s.name.toLowerCase().includes(q)) return true;
	if (basename(s.path).toLowerCase().includes(q)) return true;
	if (s.firstMessage.toLowerCase().includes(q)) return true;
	return false;
}

/** 抽取一条 AgentMessage 的可搜索文本（user/assistant 的 text 块；
 *  镜像 SDK buildSessionInfo 的 allMessagesText 范围，保证搜索与定位一致）。 */
export function messageSearchText(m: { content?: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (!Array.isArray(c)) return "";
	const parts: string[] = [];
	for (const b of c) {
		if (!b || typeof b !== "object") continue;
		const blk = b as { type?: unknown; text?: unknown };
		if (blk.type === "text" && typeof blk.text === "string") parts.push(blk.text);
	}
	return parts.join("\n");
}

export interface SessionSearchMatch {
	matched: boolean;
	anchors: MessageAnchor[];
}

/** One asynchronous pass determines the match and collects anchors. Only user and
 * assistant text participates. A missing timestamp still counts as a text match.
 * Invalid/unreadable records do not prevent searching other sessions. */
export async function scanSessionForSearch(
	filePath: string,
	query: string,
	cap = 10,
	signal?: AbortSignal,
): Promise<SessionSearchMatch> {
	signal?.throwIfAborted();
	const result: SessionSearchMatch = { matched: false, anchors: [] };
	const q = query.trim().toLowerCase();
	if (!q) return result;
	const limit = Number.isFinite(cap) ? Math.max(0, Math.floor(cap)) : 10;
	try {
		for await (const line of sessionLines(filePath, signal)) {
			let entry;
			try {
				entry = JSON.parse(line);
			} catch {
				continue;
			}
			if (entry?.type !== "message") continue;
			const message = entry.message;
			if (message?.role !== "user" && message?.role !== "assistant") continue;
			if (!messageSearchText(message).toLowerCase().includes(q)) continue;
			result.matched = true;
			if (
				typeof message.timestamp === "number" &&
				Number.isFinite(message.timestamp) &&
				result.anchors.length < limit
			) {
				result.anchors.push({ role: message.role, timestamp: message.timestamp });
			}
			if (result.anchors.length >= limit) break;
		}
	} catch {
		// Cancellation must propagate; only transcript errors are best effort.
		signal?.throwIfAborted();
		// Keep any matches already read from a partially readable transcript.
	}
	signal?.throwIfAborted();
	return result;
}

/** Async compatibility entry point. Prefer scanSessionForSearch when also filtering. */
export async function collectSessionAnchors(
	filePath: string,
	q: string,
	cap = 10,
	signal?: AbortSignal,
): Promise<MessageAnchor[]> {
	return (await scanSessionForSearch(filePath, q, cap, signal)).anchors;
}

/** Search every supplied candidate once, preserving order with bounded I/O.
 * Metadata hits still scan text to provide anchors; no 200-session list limit.
 * Empty queries return all candidates without opening their transcripts. */
export async function searchSessions(
	sessions: readonly SessionInfo[],
	query: string,
	options: { concurrency?: number; anchorCap?: number; signal?: AbortSignal } = {},
): Promise<Array<{ session: SessionInfo; anchors: MessageAnchor[] }>> {
	const q = query.trim().toLowerCase();
	const results = await mapSessionsConcurrent(
		sessions,
		async (session) => {
			const scan = q
				? await scanSessionForSearch(session.path, q, options.anchorCap, options.signal)
				: { matched: true, anchors: [] };
			return scan.matched || sessionMatchesMetadata(q, session) ? { session, anchors: scan.anchors } : null;
		},
		options.concurrency ?? 4,
		options.signal,
	);
	return results.filter((result): result is NonNullable<typeof result> => result !== null);
}

/**
 * pi 的会话存储根目录。设置了 `PI_CODING_AGENT_SESSION_DIR` 时，pi 将 transcript
 * 以**扁平布局**直接写在根目录顶层（`<root>/<timestamp>_<uuid>.jsonl`，所属 cwd 是
 * 文件内字段）；未设置时走 SDK 默认的 `<agentDir>/sessions/--<cwd>--/` 每-cwd
 * 子目录布局（此时必须**不传** sessionDir，让 SDK 落回默认路径）。
 *
 * 注意：未设置 env 时**不要**回退返回 `join(getAgentDir(), "sessions")`——那样会把
 * 根目录强塞给 SDK `list()/listAll()`，它们只会扫根目录**顶层** jsonl，默认子目录布局
 * 下顶层为空，历史对话/最近项目会全丢（回归风险，已在 0.84.4 实证）。
 */
export function piSessionsRoot(): string | undefined {
	return process.env.PI_CODING_AGENT_SESSION_DIR || undefined;
}

/** Guardrail: only transcripts under a sessions root may be opened/deleted/renamed
 *  — never arbitrary files. Two roots count as “a sessions root”, and they must stay
 *  the **same two** the history list reads from (`loadSessionInfos` →
 *  `SessionManager.list(cwd, piSessionsRoot())`):
 *
 *   1. `<agentDir>/sessions/`（SDK 默认的每-cwd 子目录布局）
 *   2. `PI_CODING_AGENT_SESSION_DIR`（扁平「额外会话根」，设了就以它为准扫盘）
 *
 *  只认第 1 条会让设了该变量的用户「历史列得出来、却点不开/删不掉/改不了名」
 *  （列表与打开两边口径不一致）。守卫的意图是「不许开任意文件」，不是「只许开
 *  默认目录下的文件」，所以放宽到两个根仍然成立。
 *  Shared by deleteSession/renameSession/switchSession so the open path cannot
 *  escape the confinement the write paths already enforce. */
export function isInsideSessionsDir(agentDir: string, targetPath: string): boolean {
	const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
	const abs = fold(resolve(targetPath));
	const roots = [fold(resolve(agentDir, "sessions")), fold(resolve(agentDir, "bot-sessions"))];
	const extra = piSessionsRoot();
	if (extra) roots.push(fold(resolve(extra)));
	return roots.some((root) => abs.startsWith(root + sep));
}

/**
 * 从会话文件首行读取 cwd（轻量探测，最多读取 2KB，绝不完整解析整个 jsonl 消息历史）。
 */
export async function readCwdFromSessionHeader(filePath: string): Promise<string | null> {
	let handle: fsPromises.FileHandle | undefined;
	try {
		handle = await fsPromises.open(filePath, "r");
		const buf = Buffer.alloc(2048);
		const { bytesRead } = await handle.read(buf, 0, 2048, 0);
		const text = buf.toString("utf8", 0, bytesRead);
		const nl = text.indexOf("\n");
		const firstLine = nl !== -1 ? text.slice(0, nl) : text;
		if (!firstLine.trim()) return null;
		const parsed = JSON.parse(firstLine);
		return typeof parsed.cwd === "string" && parsed.cwd.trim()
			? restoreWorkspaceUriFromSessionDir(parsed.cwd.trim())
			: null;
	} catch {
		return null;
	} finally {
		if (handle) await handle.close().catch(() => {});
	}
}
