/**
 * 分级记忆存储与跨端无损合并引擎（server/memory-store.ts）。
 *
 * 职责：
 * 1. 管理两层记忆库：
 *    - 全局记忆（global）：所有会话共享（个人偏好、长期背景、通用约定），上限 100 条；
 *    - 项目记忆（project）：按项目隔离（每个话题项目或本地代码仓库各自一套，上限 100 条）+ 项目自定义指令；
 * 2. 维护「💬 独立对话空间」（<dataDir>/chat-space）与「📁 话题项目」（<dataDir>/chat-projects/<slug>）；
 * 3. 提供按条目 ID + updatedAt 时间戳（含 deletedAt 墓碑）的确定性无损合并 mergeMemoryDocuments()，
 *    供 GitHub 跨端同步在多设备并发修改时安全合流；
 * 4. 渲染注入系统提示词的 <user_memory> XML 片段。
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizePathKey } from "./client-state.js";

export const MAX_MEMORY_ITEM_CHARS = 300;
export const MAX_MEMORIES_PER_SCOPE = 100;
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 4000;
export const MAX_SYNCED_CHAT_TRANSCRIPTS = 60;
/** 瘦身后的单会话同步上限（512KB 纯对话文本 ≈ 100~150 轮完整问答）。 */
export const MAX_TRANSCRIPT_BYTES = 512 * 1024;
/** 磁盘原始会话文件读取上限（10MB，读取后经 compactJsonlForSync 剥离工具 Schema 与签名后通常缩小 85%~92%）。 */
export const MAX_RAW_SESSION_FILE_BYTES = 10 * 1024 * 1024;

export type MemoryScope = "global" | "project";

export interface MemoryItem {
	id: string;
	content: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	/** 软删除墓碑时间戳：跨端合并时防止已删条目被旧副本复活。 */
	deletedAt?: number;
}

export interface ProjectMemoryBucket {
	/** 稳定项目键（话题项目为 chat-project:<slug>，Git 仓库为 git:<normalized-remote>，普通目录为 dir:<name>）。 */
	projectKey: string;
	/** 展示名称。 */
	name: string;
	/** 项目级自定义指令（Project Instructions）。 */
	instructions?: string;
	instructionsUpdatedAt?: number;
	/** 是否为纯云端话题项目（存放于 <dataDir>/chat-projects/<slug>）。 */
	isChatProject?: boolean;
	/** 话题项目的 slug（用于跨端自动恢复本地虚拟目录）。 */
	slug?: string;
	/** 本地/远程工作区目录名（小写，用于在侧栏列表中按路径快速匹配自定义项目名称）。 */
	folderName?: string;
	/** 软删除墓碑时间戳：删除项目后跨端合并时防止被旧副本复活。 */
	deletedAt?: number;
	updatedAt: number;
	items: MemoryItem[];
}

export interface SyncedChatTranscript {
	sessionId: string;
	fileName: string;
	/** "chat-space" 或 "chat-project:<slug>" */
	scopeKey: string;
	updatedAt: number;
	/** 便携化后的 JSONL 文本（首行 cwd 使用跨平台占位符 __PI_CHAT_SPACE__ / __PI_CHAT_PROJECT__:<slug>）。 */
	jsonl: string;
}

export interface TranscriptIndexEntry {
	sessionId: string;
	fileName: string;
	title: string;
	scopeKey: string;
	lineCount: number;
	messageCount: number;
	updatedAt: number;
}

export interface MemoryDocument {
	version: 1;
	updatedAt: number;
	global: MemoryItem[];
	projects: Record<string, ProjectMemoryBucket>;
	/** 开启了「🔒 独立记忆（不读写共享记忆）」的会话 ID 列表。 */
	isolatedSessionIds?: string[];
	/** 轻量对话索引表（写入 memory-store.json，具体对话内容分文件存放在 transcripts/<sessionId>.jsonl）。 */
	transcriptIndex?: Record<string, TranscriptIndexEntry>;
	/** 跨端同步的 Chat 空间（独立对话 + Chat Projects）轻量对话记录。 */
	chatTranscripts?: Record<string, SyncedChatTranscript>;
}

export interface SyncedTranscriptSummary {
	sessionId: string;
	fileName: string;
	title: string;
	scopeKey: string;
	scopeName: string;
	cwd: string;
	filePath: string;
	messageCount: number;
	updatedAt: number;
}

export interface MemorySnapshotView {
	chatSpaceCwd: string;
	chatProjectsRoot: string;
	workProjectsRoot: string;
	isChatSpace: boolean;
	projectKey: string;
	projectName: string;
	projectInstructions: string;
	globalItems: MemoryItem[];
	projectItems: MemoryItem[];
	chatProjects: {
		slug: string;
		name: string;
		path: string;
		instructions: string;
		itemCount: number;
		updatedAt: number;
	}[];
	/** 自定义项目显示名映射（按 projectKey / dir:<folderLower> / slug:<slugLower> 索引）。 */
	projectNames: Record<string, string>;
	syncedTranscripts: SyncedTranscriptSummary[];
}

function emptyDocument(): MemoryDocument {
	return {
		version: 1,
		updatedAt: 0,
		global: [],
		projects: {},
	};
}

/**
 * 对会话 JSONL 进行无损瘦身与跨平台路径脱敏：
 * 1. 首行 session 的 cwd 替换为占位符（或还原为本机实际路径），消除 Windows/Mac/Linux 路径差异；
 * 2. 剥离 role="system" 记录中庞大的 sections（含本机绝对路径的系统提示词快照）与 toolsAdded（35KB+ 工具 JSON Schema），
 *    仅保留 id / parentId / timestamp 空壳，确保 SessionManager 的 parentId 消息链表 100% 不断裂；
 * 3. 剥离 assistant 消息中无展示价值的加密签名串 thinkingSignature（单轮 10KB+ base64），完整保留 thinking 思考正文与回答正文；
 * 4. 统计有效消息行数与最新一条记录的真实时间戳，避免跨机下载时文件 mtime 覆盖真实对话时间。
 */
export function compactJsonlForSync(
	rawText: string,
	targetCwd?: string,
): { jsonl: string; sessionId: string; lineCount: number; lastTimestamp: number } | null {
	const rawLines = rawText.split("\n");
	const outLines: string[] = [];
	let sessionId = "";
	let lastTimestamp = 0;

	for (const rawLine of rawLines) {
		const trimmed = rawLine.trim();
		if (!trimmed) continue;
		let obj: Record<string, unknown>;
		try {
			obj = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (typeof obj.timestamp === "string") {
			const parsedTs = Date.parse(obj.timestamp);
			if (Number.isFinite(parsedTs) && parsedTs > lastTimestamp) lastTimestamp = parsedTs;
		} else if (typeof obj.timestamp === "number" && obj.timestamp > lastTimestamp) {
			lastTimestamp = obj.timestamp;
		}

		if (obj.type === "session") {
			if (typeof obj.id === "string" && obj.id) sessionId = obj.id;
			if (targetCwd !== undefined) obj.cwd = targetCwd;
			outLines.push(JSON.stringify(obj));
			continue;
		}

		if (obj.type === "message" && obj.message && typeof obj.message === "object") {
			const msg = { ...(obj.message as Record<string, unknown>) };
			if (typeof msg.timestamp === "number" && msg.timestamp > lastTimestamp) {
				lastTimestamp = msg.timestamp;
			}
			if (msg.role === "system") {
				delete msg.sections;
				delete msg.toolsAdded;
				msg.content = "";
				outLines.push(
					JSON.stringify({
						type: "message",
						id: obj.id,
						parentId: obj.parentId ?? null,
						timestamp: obj.timestamp,
						message: msg,
					}),
				);
				continue;
			}
			if (Array.isArray(msg.content)) {
				msg.content = msg.content.map((part) => {
					if (!part || typeof part !== "object") return part;
					const p = { ...(part as Record<string, unknown>) };
					delete p.thinkingSignature;
					if (p.type === "image" && typeof p.data === "string" && p.data.length > 32768) {
						delete p.data;
					}
					return p;
				});
			}
			outLines.push(
				JSON.stringify({
					...obj,
					message: msg,
				}),
			);
			continue;
		}

		outLines.push(JSON.stringify(obj));
	}

	if (!sessionId || outLines.length === 0) return null;
	return {
		jsonl: `${outLines.join("\n")}\n`,
		sessionId,
		lineCount: outLines.length,
		lastTimestamp,
	};
}

function clampText(raw: string, maxChars: number): string {
	const trimmed = raw.trim().replace(/\r\n/g, "\n");
	return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

/** 从便携 JSONL 中提取标题、消息条数与总行数，生成轻量索引条目。 */
export function buildTranscriptIndexEntry(tr: SyncedChatTranscript): TranscriptIndexEntry {
	let title = "";
	let firstUserText = "";
	let messageCount = 0;
	const lines = tr.jsonl
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	for (const line of lines) {
		if (!line.startsWith("{")) continue;
		try {
			const obj = JSON.parse(line) as Record<string, unknown>;
			if (obj.type === "session_info" && typeof obj.name === "string" && obj.name.trim()) {
				title = obj.name.trim();
			} else if (obj.type === "message" && obj.message && typeof obj.message === "object") {
				const msg = obj.message as Record<string, unknown>;
				if (msg.role === "user" || msg.role === "assistant") {
					messageCount++;
				}
				if (msg.role === "user" && !firstUserText) {
					if (typeof msg.content === "string") {
						firstUserText = msg.content.trim();
					} else if (Array.isArray(msg.content)) {
						for (const part of msg.content) {
							if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
								const t = String((part as Record<string, unknown>).text ?? "").trim();
								if (t) {
									firstUserText = t;
									break;
								}
							}
						}
					}
				}
			}
		} catch {
			/* ignore */
		}
	}
	const finalTitle = (title || firstUserText || tr.sessionId.slice(0, 8)).replace(/\s+/g, " ").slice(0, 80);
	return {
		sessionId: tr.sessionId,
		fileName: tr.fileName,
		title: finalTitle,
		scopeKey: tr.scopeKey,
		lineCount: lines.length,
		messageCount,
		updatedAt: tr.updatedAt || 0,
	};
}

/** 从 .git/config 提取远端 URL 并归一化（使不同电脑 clone 的同一仓库共享同一个 projectKey）。 */
export function detectGitRemoteKey(cwd: string): string | null {
	try {
		const gitConfig = join(cwd, ".git", "config");
		if (!existsSync(gitConfig)) return null;
		const text = readFileSync(gitConfig, "utf8");
		const m = /^\s*url\s*=\s*(.+)$/m.exec(text);
		if (!m) return null;
		let url = m[1]!.trim().toLowerCase();
		url = url
			.replace(/^git@([^:]+):/, "$1/")
			.replace(/^https?:\/\//, "")
			.replace(/^ssh:\/\/git@/, "")
			.replace(/\.git$/, "")
			.replace(/\/+$/, "");
		return url ? `git:${url}` : null;
	} catch {
		return null;
	}
}

/** 识别远程工作区目录或 URI，格式化为 `🌐 远端目录名 (主机)`。 */
export function formatRemoteWorkspaceDisplayName(cwdOrUri: string): string | null {
	if (!cwdOrUri) return null;
	let target = cwdOrUri.trim();
	try {
		const marker = join(target, ".pi-remote-uri");
		if (existsSync(marker)) {
			const uri = readFileSync(marker, "utf8").trim();
			if (uri.startsWith("ssh://")) target = uri;
		}
	} catch {
		/* ignore */
	}
	const sshMatch = /^ssh:\/\/([^@]+)@([^:/]+)(?::\d+)?(\/.*)?$/i.exec(target);
	if (sshMatch) {
		const user = sshMatch[1];
		const host = sshMatch[2];
		const rawPath = (sshMatch[3] || "").replace(/\\/g, "/").replace(/\/+$/, "");
		const segs = rawPath.split("/").filter(Boolean);
		const dir = segs[segs.length - 1] || user || "/";
		return `🌐 ${dir} (${host})`;
	}
	const base = basename(resolve(target));
	const fullSlug =
		/^([a-zA-Z0-9._-]+?)_((?:\d{1,3}\.){3}\d{1,3}|localhost|[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)_(\d+)_(.+?)(?:_([0-9a-f]{8,12}))?$/i.exec(
			base,
		);
	if (fullSlug) {
		const user = fullSlug[1];
		const host = fullSlug[2];
		const pathPart = fullSlug[4].replace(/_+[0-9a-f]{8,12}$/i, "");
		const segs = pathPart.split("_").filter(Boolean);
		const dir = segs[segs.length - 1] || user;
		return `🌐 ${dir} (${host})`;
	}
	const shortSlug = /^([a-zA-Z0-9._ -]+?)[_@]+((?:\d{1,3}\.){3}\d{1,3})$/.exec(base);
	if (shortSlug) {
		return `🌐 ${shortSlug[1].trim()} (${shortSlug[2]})`;
	}
	return null;
}

/** 计算任意工作区目录对应的稳定项目记忆键与展示名。 */
export function resolveProjectMemoryIdentity(
	dataDir: string,
	cwd: string,
): { projectKey: string; name: string; isChatSpace: boolean; chatProjectSlug?: string } {
	const chatSpace = resolveChatSpaceDir(dataDir);
	const normCwd = normalizePathKey(resolve(cwd)).replace(/\\/g, "/").replace(/\/+$/, "");
	const normSpace = normalizePathKey(chatSpace).replace(/\\/g, "/").replace(/\/+$/, "");
	if (normCwd === normSpace) {
		return { projectKey: "chat-space", name: "Chats", isChatSpace: true };
	}
	const chatProjectsRoot = resolveChatProjectsRoot(dataDir);
	const normRoot = normalizePathKey(chatProjectsRoot).replace(/\\/g, "/").replace(/\/+$/, "");
	if (normCwd.startsWith(`${normRoot}/`)) {
		const resolvedCwd = resolve(cwd).replace(/\\/g, "/");
		const resolvedRoot = resolve(chatProjectsRoot).replace(/\\/g, "/").replace(/\/+$/, "");
		const rawRel = resolvedCwd.slice(resolvedRoot.length + 1);
		const rawSlug = rawRel.split("/")[0] || "project";
		const slug = sanitizeProjectSlug(rawSlug);
		return {
			projectKey: `chat-project:${slug}`,
			name: slug,
			isChatSpace: false,
			chatProjectSlug: slug,
		};
	}
	const gitKey = detectGitRemoteKey(cwd);
	const folderName = basename(resolve(cwd)) || "workspace";
	const displayName = formatRemoteWorkspaceDisplayName(cwd) || folderName;
	if (gitKey) {
		return { projectKey: gitKey, name: displayName, isChatSpace: false };
	}
	return { projectKey: `dir:${folderName.toLowerCase()}`, name: displayName, isChatSpace: false };
}

export function resolveChatSpaceDir(dataDir: string): string {
	const dir = resolve(dataDir, "chat-space");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	return dir;
}

export function resolveChatProjectsRoot(dataDir: string): string {
	const dir = resolve(dataDir, "chat-projects");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	return dir;
}

export function resolveWorkProjectsRoot(dataDir: string): string {
	const homeProjects = resolve(homedir(), "projects");
	if (existsSync(homeProjects)) return homeProjects;
	const dir = resolve(dataDir, "work-projects");
	try {
		mkdirSync(dir, { recursive: true });
	} catch {
		/* ignore */
	}
	return dir;
}

/** 判断某个路径是否属于 Chat 独立目录体系（chat-space 或 chat-projects/*）。 */
export function isChatWorkspacePath(dataDir: string, targetPath: string): boolean {
	if (!targetPath) return false;
	const normTarget = normalizePathKey(resolve(targetPath)).replace(/\\/g, "/").replace(/\/+$/, "");
	const normSpace = normalizePathKey(resolveChatSpaceDir(dataDir)).replace(/\\/g, "/").replace(/\/+$/, "");
	if (normTarget === normSpace || normTarget.startsWith(`${normSpace}/`)) return true;
	const normRoot = normalizePathKey(resolveChatProjectsRoot(dataDir)).replace(/\\/g, "/").replace(/\/+$/, "");
	if (normTarget === normRoot || normTarget.startsWith(`${normRoot}/`)) return true;
	return normTarget.includes("/chat-projects/") || normTarget.endsWith("/chat-space");
}

export function sanitizeProjectSlug(name: string): string {
	const cleaned = name
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]+/g, "-")
		.replace(/\s+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "")
		.slice(0, 64);
	return cleaned || `project-${Date.now().toString(36)}`;
}

/** 按条目 ID + updatedAt 时间戳合并两组记忆条目（保留软删除墓碑，防止已删条目被旧副本复活）。 */
export function mergeMemoryItems(local: MemoryItem[], remote: MemoryItem[]): MemoryItem[] {
	const map = new Map<string, MemoryItem>();
	for (const item of [...local, ...remote]) {
		if (!item || typeof item.id !== "string" || !item.id) continue;
		const prev = map.get(item.id);
		const itemStamp = Math.max(item.updatedAt ?? 0, item.deletedAt ?? 0);
		const prevStamp = prev ? Math.max(prev.updatedAt ?? 0, prev.deletedAt ?? 0) : -1;
		if (!prev || itemStamp >= prevStamp) {
			map.set(item.id, {
				id: item.id,
				content: clampText(String(item.content ?? ""), MAX_MEMORY_ITEM_CHARS),
				enabled: item.enabled !== false,
				createdAt: Number(item.createdAt) || itemStamp || Date.now(),
				updatedAt: Number(item.updatedAt) || itemStamp || Date.now(),
				...(item.deletedAt ? { deletedAt: Number(item.deletedAt) } : {}),
			});
		}
	}
	const all = [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
	const active: MemoryItem[] = [];
	const tombs: MemoryItem[] = [];
	for (const it of all) {
		if (it.deletedAt) tombs.push(it);
		else if (it.content) active.push(it);
	}
	return [...active.slice(0, MAX_MEMORIES_PER_SCOPE), ...tombs.slice(0, MAX_MEMORIES_PER_SCOPE)];
}

/** 合并本地与远端的完整记忆文档（确定性 Last-Write-Wins per item / per field）。 */
export function mergeMemoryDocuments(local: MemoryDocument, remote: MemoryDocument): MemoryDocument {
	const projects: Record<string, ProjectMemoryBucket> = {};
	const keys = new Set([...Object.keys(local.projects ?? {}), ...Object.keys(remote.projects ?? {})]);
	for (const key of keys) {
		const a = local.projects?.[key];
		const b = remote.projects?.[key];
		if (a && !b) {
			projects[key] = { ...a, items: mergeMemoryItems(a.items ?? [], []) };
		} else if (!a && b) {
			projects[key] = { ...b, items: mergeMemoryItems([], b.items ?? []) };
		} else if (a && b) {
			const aDel = a.deletedAt ?? 0;
			const bDel = b.deletedAt ?? 0;
			const maxDel = Math.max(aDel, bDel);
			const aUpd = a.updatedAt ?? 0;
			const bUpd = b.updatedAt ?? 0;
			const maxUpd = Math.max(aUpd, bUpd);
			const aInstAt = a.instructionsUpdatedAt ?? aUpd;
			const bInstAt = b.instructionsUpdatedAt ?? bUpd;
			const newerInst = bInstAt >= aInstAt ? b : a;
			const newerMeta = bUpd >= aUpd ? b : a;
			const isDeleted = maxDel > 0 && maxDel >= maxUpd;
			projects[key] = {
				projectKey: key,
				name: newerMeta.name || a.name || b.name || key,
				...(newerInst.instructions
					? { instructions: clampText(newerInst.instructions, MAX_PROJECT_INSTRUCTIONS_CHARS) }
					: {}),
				instructionsUpdatedAt: Math.max(aInstAt, bInstAt),
				...(a.isChatProject || b.isChatProject ? { isChatProject: true } : {}),
				...(newerMeta.slug || a.slug || b.slug ? { slug: newerMeta.slug || a.slug || b.slug } : {}),
				...(newerMeta.folderName || a.folderName || b.folderName
					? { folderName: newerMeta.folderName || a.folderName || b.folderName }
					: {}),
				...(isDeleted ? { deletedAt: maxDel } : {}),
				updatedAt: Math.max(maxUpd, maxDel),
				items: isDeleted ? [] : mergeMemoryItems(a.items ?? [], b.items ?? []),
			};
		}
	}
	const mergedTranscripts: Record<string, SyncedChatTranscript> = {};
	const allTranscriptIds = new Set([
		...Object.keys(local.chatTranscripts ?? {}),
		...Object.keys(remote.chatTranscripts ?? {}),
	]);
	const transcriptList: SyncedChatTranscript[] = [];
	for (const sid of allTranscriptIds) {
		const lt = local.chatTranscripts?.[sid];
		const rt = remote.chatTranscripts?.[sid];
		let chosen: SyncedChatTranscript | undefined;
		if (lt && rt) {
			const lLines = lt.jsonl ? lt.jsonl.trim().split("\n").length : 0;
			const rLines = rt.jsonl ? rt.jsonl.trim().split("\n").length : 0;
			if (rLines !== lLines) {
				chosen = rLines > lLines ? rt : lt;
			} else {
				chosen = (rt.updatedAt ?? 0) >= (lt.updatedAt ?? 0) ? rt : lt;
			}
		} else {
			chosen = lt ?? rt;
		}
		if (chosen && chosen.sessionId && chosen.jsonl) {
			if (projects[chosen.scopeKey]?.deletedAt) continue;
			const compacted = compactJsonlForSync(chosen.jsonl);
			const cleanJsonl = compacted ? compacted.jsonl : chosen.jsonl;
			if (cleanJsonl.length <= MAX_TRANSCRIPT_BYTES) {
				transcriptList.push({
					...chosen,
					jsonl: cleanJsonl,
					updatedAt: Math.max(chosen.updatedAt ?? 0, compacted?.lastTimestamp ?? 0),
				});
			}
		}
	}
	transcriptList.sort((a, b) => b.updatedAt - a.updatedAt);
	for (const t of transcriptList.slice(0, MAX_SYNCED_CHAT_TRANSCRIPTS)) {
		mergedTranscripts[t.sessionId] = t;
	}
	const mergedIndex: Record<string, TranscriptIndexEntry> = {};
	for (const [sid, t] of Object.entries(mergedTranscripts)) {
		mergedIndex[sid] = buildTranscriptIndexEntry(t);
	}

	return {
		version: 1,
		updatedAt: Math.max(local.updatedAt ?? 0, remote.updatedAt ?? 0, Date.now()),
		global: mergeMemoryItems(local.global ?? [], remote.global ?? []),
		projects,
		isolatedSessionIds: [...new Set([...(local.isolatedSessionIds ?? []), ...(remote.isolatedSessionIds ?? [])])].slice(
			-500,
		),
		transcriptIndex: mergedIndex,
		chatTranscripts: mergedTranscripts,
	};
}

export class MemoryStore {
	readonly dataDir: string;
	readonly filePath: string;
	readonly transcriptsDir: string;
	private doc: MemoryDocument;
	private lastDiskMtime = 0;
	private changeListeners = new Set<() => void>();
	private remoteMergeListeners = new Set<() => void>();

	constructor(dataDir: string) {
		this.dataDir = resolve(dataDir);
		this.filePath = join(this.dataDir, "memory-store.json");
		this.transcriptsDir = join(this.dataDir, "transcripts");
		this.doc = this.loadFromDisk();
		this.ensureChatProjectDirs();
	}

	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
	}

	onRemoteMerge(cb: () => void): () => void {
		this.remoteMergeListeners.add(cb);
		return () => this.remoteMergeListeners.delete(cb);
	}

	private notifyChange(): void {
		for (const cb of this.changeListeners) {
			try {
				cb();
			} catch {
				/* ignore */
			}
		}
	}

	private notifyRemoteMerge(): void {
		for (const cb of this.remoteMergeListeners) {
			try {
				cb();
			} catch {
				/* ignore */
			}
		}
	}

	private loadFromDisk(): MemoryDocument {
		try {
			if (!existsSync(this.filePath)) return emptyDocument();
			try {
				this.lastDiskMtime = statSync(this.filePath).mtimeMs;
			} catch {
				/* ignore */
			}
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<MemoryDocument>;
			if (!raw || typeof raw !== "object") return emptyDocument();
			const chatTranscripts: Record<string, SyncedChatTranscript> =
				raw.chatTranscripts && typeof raw.chatTranscripts === "object" ? { ...raw.chatTranscripts } : {};
			// 从分文件目录 <dataDir>/transcripts/<sessionId>.jsonl 还原完整对话记录
			if (raw.transcriptIndex && typeof raw.transcriptIndex === "object") {
				for (const [sid, meta] of Object.entries(raw.transcriptIndex)) {
					if (!meta || typeof meta !== "object" || chatTranscripts[sid]?.jsonl) continue;
					const tf = join(this.transcriptsDir, `${sanitizeProjectSlug(sid)}.jsonl`);
					if (existsSync(tf)) {
						try {
							const jsonl = readFileSync(tf, "utf8");
							if (jsonl.trim()) {
								chatTranscripts[sid] = {
									sessionId: meta.sessionId || sid,
									fileName: meta.fileName || `${sid}.jsonl`,
									scopeKey: meta.scopeKey || "chat-space",
									updatedAt: Number(meta.updatedAt) || 0,
									jsonl,
								};
							}
						} catch {
							/* ignore */
						}
					}
				}
			}
			return mergeMemoryDocuments(emptyDocument(), {
				version: 1,
				updatedAt: Number(raw.updatedAt) || 0,
				global: Array.isArray(raw.global) ? raw.global : [],
				projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
				isolatedSessionIds: Array.isArray(raw.isolatedSessionIds)
					? raw.isolatedSessionIds.filter((x): x is string => typeof x === "string")
					: [],
				chatTranscripts,
			});
		} catch {
			return emptyDocument();
		}
	}

	/** 若磁盘上的 memory-store.json 已被其他窗口或进程更新，先无损合并进内存，防止旧内存覆盖新数据。 */
	syncFromDiskIfNewer(): void {
		try {
			if (!existsSync(this.filePath)) return;
			const st = statSync(this.filePath);
			if (st.mtimeMs > this.lastDiskMtime) {
				const diskDoc = this.loadFromDisk();
				this.doc = mergeMemoryDocuments(this.doc, diskDoc);
			}
		} catch {
			/* ignore */
		}
	}

	/** 生成只含轻量索引（不含大段内联 jsonl 文本）的 memory-store.json 持久化结构。 */
	getIndexDocument(): MemoryDocument {
		this.syncFromDiskIfNewer();
		const transcriptIndex: Record<string, TranscriptIndexEntry> = {};
		for (const [sid, tr] of Object.entries(this.doc.chatTranscripts ?? {})) {
			if (this.doc.projects[tr.scopeKey]?.deletedAt) continue;
			transcriptIndex[sid] = buildTranscriptIndexEntry(tr);
		}
		return {
			version: 1,
			updatedAt: this.doc.updatedAt,
			global: this.doc.global,
			projects: this.doc.projects,
			isolatedSessionIds: this.doc.isolatedSessionIds ?? [],
			transcriptIndex,
		};
	}

	private saveToDisk(): void {
		try {
			mkdirSync(this.dataDir, { recursive: true });
			mkdirSync(this.transcriptsDir, { recursive: true });
			const transcriptIndex: Record<string, TranscriptIndexEntry> = {};
			for (const [sid, tr] of Object.entries(this.doc.chatTranscripts ?? {})) {
				if (!tr?.jsonl || this.doc.projects[tr.scopeKey]?.deletedAt) continue;
				transcriptIndex[sid] = buildTranscriptIndexEntry(tr);
				const tf = join(this.transcriptsDir, `${sanitizeProjectSlug(sid)}.jsonl`);
				try {
					writeFileSync(tf, tr.jsonl, "utf8");
				} catch {
					/* ignore */
				}
			}
			this.doc.transcriptIndex = transcriptIndex;
			const diskPayload: MemoryDocument = {
				version: 1,
				updatedAt: this.doc.updatedAt,
				global: this.doc.global,
				projects: this.doc.projects,
				isolatedSessionIds: this.doc.isolatedSessionIds ?? [],
				transcriptIndex,
			};
			writeFileSync(this.filePath, JSON.stringify(diskPayload, null, "\t"), "utf8");
			try {
				this.lastDiskMtime = statSync(this.filePath).mtimeMs;
			} catch {
				/* ignore */
			}
		} catch {
			/* ignore */
		}
	}

	/** 确保所有同步过来的话题项目在本地 <dataDir>/chat-projects/<slug> 下有实体目录（已标记删除的则清理）。 */
	ensureChatProjectDirs(): void {
		const root = resolveChatProjectsRoot(this.dataDir);
		for (const bucket of Object.values(this.doc.projects)) {
			if (bucket.isChatProject && bucket.slug) {
				const dir = join(root, sanitizeProjectSlug(bucket.slug));
				if (bucket.deletedAt) {
					try {
						if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
					} catch {
						/* ignore */
					}
					continue;
				}
				try {
					mkdirSync(dir, { recursive: true });
				} catch {
					/* ignore */
				}
			}
		}
	}

	getDocument(): MemoryDocument {
		this.syncFromDiskIfNewer();
		return JSON.parse(JSON.stringify(this.doc)) as MemoryDocument;
	}

	/** 与远端文档合并并落盘（返回合并后的文档，同时将远端 Chat 对话记录还原到本地会话目录并通知宿主刷新缓存）。 */
	mergeRemote(remote: MemoryDocument): MemoryDocument {
		this.syncFromDiskIfNewer();
		this.captureChatTranscriptsFromDisk(false);
		this.doc = mergeMemoryDocuments(this.doc, remote);
		this.ensureChatProjectDirs();
		this.materializeChatTranscriptsToDisk();
		this.saveToDisk();
		this.notifyRemoteMerge();
		return this.getDocument();
	}

	/**
	 * 扫描本机 Chat 空间（chat-space 与 chat-projects/*）下的 .jsonl 会话记录，
	 * 经 compactJsonlForSync 无损瘦身与路径脱敏后打包进 doc.chatTranscripts 以便随 GitHub 云同步上传。
	 */
	captureChatTranscriptsFromDisk(notify = true): boolean {
		this.syncFromDiskIfNewer();
		const targets: { scopeKey: string; dir: string; placeholder: string }[] = [
			{
				scopeKey: "chat-space",
				dir: resolveChatSpaceDir(this.dataDir),
				placeholder: "__PI_CHAT_SPACE__",
			},
		];
		for (const cp of this.listChatProjects()) {
			targets.push({
				scopeKey: `chat-project:${cp.slug}`,
				dir: cp.path,
				placeholder: `__PI_CHAT_PROJECT__:${cp.slug}`,
			});
		}

		const nextMap: Record<string, SyncedChatTranscript> = { ...(this.doc.chatTranscripts ?? {}) };
		let changed = false;

		for (const t of targets) {
			try {
				const sessionDir = SessionManager.create(t.dir).getSessionDir();
				if (!existsSync(sessionDir)) continue;
				for (const f of readdirSync(sessionDir)) {
					if (!f.endsWith(".jsonl")) continue;
					const fp = join(sessionDir, f);
					let st;
					try {
						st = statSync(fp);
					} catch {
						continue;
					}
					if (st.size === 0 || st.size > MAX_RAW_SESSION_FILE_BYTES) continue;
					const rawText = readFileSync(fp, "utf8");
					const compacted = compactJsonlForSync(rawText, t.placeholder);
					if (!compacted || this.isSessionIsolated(compacted.sessionId)) continue;
					if (compacted.jsonl.length > MAX_TRANSCRIPT_BYTES) continue;
					const sid = compacted.sessionId;
					const prev = nextMap[sid];
					const mtime = Math.max(Math.round(st.mtimeMs), compacted.lastTimestamp);
					const prevLines = prev?.jsonl ? prev.jsonl.trim().split("\n").length : 0;
					if (
						!prev ||
						compacted.lineCount > prevLines ||
						(compacted.lineCount === prevLines && (mtime > prev.updatedAt || prev.jsonl !== compacted.jsonl))
					) {
						nextMap[sid] = {
							sessionId: sid,
							fileName: f,
							scopeKey: t.scopeKey,
							updatedAt: mtime,
							jsonl: compacted.jsonl,
						};
						changed = true;
					}
				}
			} catch {
				/* ignore */
			}
		}

		if (changed) {
			this.doc.chatTranscripts = mergeMemoryDocuments(this.doc, {
				...this.doc,
				chatTranscripts: nextMap,
			}).chatTranscripts;
			this.doc.updatedAt = Date.now();
			this.saveToDisk();
			if (notify) this.notifyChange();
		}
		return changed;
	}

	/**
	 * 将 doc.chatTranscripts 中来自其他设备的 Chat 会话记录落盘到本机对应的会话目录，
	 * 把首行 cwd 占位符还原为本机的真实目录路径，并同步文件 mtime 为真实对话时间。
	 */
	materializeChatTranscriptsToDisk(): void {
		const map = this.doc.chatTranscripts ?? {};
		for (const item of Object.values(map)) {
			try {
				if (!item?.sessionId || !item?.jsonl || !item?.fileName) continue;
				if (this.doc.projects[item.scopeKey]?.deletedAt) continue;
				let localDir: string;
				if (item.scopeKey === "chat-space") {
					localDir = resolveChatSpaceDir(this.dataDir);
				} else if (item.scopeKey.startsWith("chat-project:")) {
					const slug = sanitizeProjectSlug(item.scopeKey.slice("chat-project:".length));
					localDir = join(resolveChatProjectsRoot(this.dataDir), slug);
					mkdirSync(localDir, { recursive: true });
				} else {
					continue;
				}
				const sessionDir = SessionManager.create(localDir).getSessionDir();
				mkdirSync(sessionDir, { recursive: true });
				const safeFile = basename(item.fileName);
				if (!safeFile.endsWith(".jsonl")) continue;
				const destPath = join(sessionDir, safeFile);
				const incomingCompacted = compactJsonlForSync(item.jsonl, localDir);
				if (!incomingCompacted) continue;

				if (existsSync(destPath)) {
					try {
						const existingRaw = readFileSync(destPath, "utf8");
						const existingCompacted = compactJsonlForSync(existingRaw, localDir);
						const existingLines = existingCompacted?.lineCount ?? 0;
						const st = statSync(destPath);
						// 若本机文件行数更多，或行数相同且本机已是最新的，则不覆盖本机正在进行的会话
						if (existingLines > incomingCompacted.lineCount) continue;
						if (existingLines === incomingCompacted.lineCount && Math.round(st.mtimeMs) >= item.updatedAt) {
							continue;
						}
					} catch {
						/* overwrite */
					}
				}
				writeFileSync(destPath, incomingCompacted.jsonl, "utf8");
				if (item.updatedAt > 0) {
					try {
						const mtimeSec = item.updatedAt / 1000;
						utimesSync(destPath, mtimeSec, mtimeSec);
					} catch {
						/* ignore */
					}
				}
			} catch {
				/* ignore */
			}
		}
	}

	listActiveItems(scope: MemoryScope, cwd?: string): MemoryItem[] {
		if (scope === "global") {
			return this.doc.global.filter((i) => !i.deletedAt && i.content);
		}
		if (!cwd) return [];
		const { projectKey, isChatSpace } = resolveProjectMemoryIdentity(this.dataDir, cwd);
		if (isChatSpace) return [];
		return (this.doc.projects[projectKey]?.items ?? []).filter((i) => !i.deletedAt && i.content);
	}

	private ensureProjectBucket(cwd: string): ProjectMemoryBucket {
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		const existing = this.doc.projects[id.projectKey];
		if (existing) return existing;
		const bucket: ProjectMemoryBucket = {
			projectKey: id.projectKey,
			name: id.name,
			...(id.chatProjectSlug ? { isChatProject: true, slug: id.chatProjectSlug } : {}),
			updatedAt: Date.now(),
			items: [],
		};
		this.doc.projects[id.projectKey] = bucket;
		return bucket;
	}

	/** 新增或幂等更新一条记忆（若已有完全相同内容的条目则直接刷新时间戳）。 */
	addItem(scope: MemoryScope, content: string, cwd?: string): MemoryItem {
		this.syncFromDiskIfNewer();
		const text = clampText(content, MAX_MEMORY_ITEM_CHARS);
		if (!text) throw new Error("Memory content cannot be empty");
		const now = Date.now();
		const targetList =
			scope === "global" || !cwd || resolveProjectMemoryIdentity(this.dataDir, cwd).isChatSpace
				? this.doc.global
				: this.ensureProjectBucket(cwd).items;

		const dup = targetList.find((i) => !i.deletedAt && i.content.toLowerCase() === text.toLowerCase());
		if (dup) {
			dup.content = text;
			dup.enabled = true;
			dup.updatedAt = now;
			this.doc.updatedAt = now;
			this.saveToDisk();
			this.notifyChange();
			return { ...dup };
		}

		const item: MemoryItem = {
			id: randomUUID().slice(0, 12),
			content: text,
			enabled: true,
			createdAt: now,
			updatedAt: now,
		};
		targetList.unshift(item);
		if (scope === "project" && cwd) {
			const b = this.ensureProjectBucket(cwd);
			delete b.deletedAt;
			b.updatedAt = now;
			b.items = mergeMemoryItems(targetList, []);
		} else {
			this.doc.global = mergeMemoryItems(targetList, []);
		}
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
		return { ...item };
	}

	updateItem(
		scope: MemoryScope,
		id: string,
		patch: { content?: string; enabled?: boolean },
		cwd?: string,
	): MemoryItem | null {
		this.syncFromDiskIfNewer();
		const list =
			scope === "global" || !cwd
				? this.doc.global
				: (this.doc.projects[resolveProjectMemoryIdentity(this.dataDir, cwd).projectKey]?.items ?? []);
		const item = list.find((i) => i.id === id && !i.deletedAt);
		if (!item) return null;
		const now = Date.now();
		if (typeof patch.content === "string") {
			const text = clampText(patch.content, MAX_MEMORY_ITEM_CHARS);
			if (!text) return null;
			item.content = text;
		}
		if (typeof patch.enabled === "boolean") {
			item.enabled = patch.enabled;
		}
		item.updatedAt = now;
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
		return { ...item };
	}

	deleteItem(scope: MemoryScope, id: string, cwd?: string): boolean {
		this.syncFromDiskIfNewer();
		const list =
			scope === "global" || !cwd
				? this.doc.global
				: (this.doc.projects[resolveProjectMemoryIdentity(this.dataDir, cwd).projectKey]?.items ?? []);
		const item = list.find((i) => i.id === id && !i.deletedAt);
		if (!item) return false;
		const now = Date.now();
		item.deletedAt = now;
		item.updatedAt = now;
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
		return true;
	}

	setProjectInstructions(cwd: string, instructions: string): void {
		this.syncFromDiskIfNewer();
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		if (id.isChatSpace) return;
		const bucket = this.ensureProjectBucket(cwd);
		const now = Date.now();
		delete bucket.deletedAt;
		bucket.instructions = clampText(instructions, MAX_PROJECT_INSTRUCTIONS_CHARS);
		bucket.instructionsUpdatedAt = now;
		bucket.updatedAt = now;
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
	}

	/** 创建或更新一个云端可同步的「话题项目」（位于 <dataDir>/chat-projects/<slug>）。 */
	createChatProject(name: string, instructions = ""): { slug: string; name: string; path: string } {
		this.syncFromDiskIfNewer();
		const trimmedName = clampText(name, 80) || "New Project";
		const slug = sanitizeProjectSlug(trimmedName);
		const dir = join(resolveChatProjectsRoot(this.dataDir), slug);
		mkdirSync(dir, { recursive: true });
		const key = `chat-project:${slug}`;
		const now = Date.now();
		const existing = this.doc.projects[key];
		this.doc.projects[key] = {
			projectKey: key,
			name: trimmedName,
			instructions: clampText(instructions, MAX_PROJECT_INSTRUCTIONS_CHARS) || existing?.instructions,
			instructionsUpdatedAt: now,
			isChatProject: true,
			slug,
			updatedAt: now,
			items: existing?.deletedAt ? [] : (existing?.items ?? []),
		};
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
		return { slug, name: trimmedName, path: dir };
	}

	/**
	 * 重命名指定路径对应的项目（支持 Chat 话题项目与 Work 本地/远程项目，自动更新时间戳以参与跨端同步）。
	 */
	renameProjectByCwd(cwd: string, newName: string): { projectKey: string; name: string } | null {
		this.syncFromDiskIfNewer();
		const trimmedName = clampText(newName, 80);
		if (!cwd || !trimmedName) return null;
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		if (id.isChatSpace) return null;
		const now = Date.now();
		const folderLower = (basename(resolve(cwd)) || "").toLowerCase();
		const existing = this.doc.projects[id.projectKey];
		this.doc.projects[id.projectKey] = {
			projectKey: id.projectKey,
			name: trimmedName,
			...(existing?.instructions ? { instructions: existing.instructions } : {}),
			...(existing?.instructionsUpdatedAt ? { instructionsUpdatedAt: existing.instructionsUpdatedAt } : {}),
			...(existing?.isChatProject || id.chatProjectSlug
				? { isChatProject: true, slug: existing?.slug || id.chatProjectSlug }
				: {}),
			...(folderLower ? { folderName: folderLower } : {}),
			updatedAt: now,
			items: existing?.deletedAt ? [] : (existing?.items ?? []),
		};
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
		return { projectKey: id.projectKey, name: trimmedName };
	}

	/**
	 * 删除指定路径对应的项目（若为 Chat 话题项目，同步写入墓碑、移除云端对话记录并清理本地 chat-projects/<slug> 目录）。
	 */
	deleteProjectByCwd(cwd: string): boolean {
		this.syncFromDiskIfNewer();
		if (!cwd) return false;
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		if (id.isChatSpace) return false;
		const now = Date.now();
		let touched = false;
		const targetKeyLower = id.projectKey.toLowerCase();
		const targetSlugLower = id.chatProjectSlug?.toLowerCase();

		for (const [k, b] of Object.entries(this.doc.projects)) {
			if (k.toLowerCase() === targetKeyLower || (targetSlugLower && b.slug?.toLowerCase() === targetSlugLower)) {
				this.doc.projects[k] = {
					projectKey: k,
					name: b.name || id.name,
					...(b.isChatProject || id.chatProjectSlug ? { isChatProject: true, slug: b.slug || id.chatProjectSlug } : {}),
					deletedAt: now,
					updatedAt: now,
					items: [],
				};
				touched = true;
			}
		}
		if (!touched && (this.doc.projects[id.projectKey] || id.chatProjectSlug)) {
			this.doc.projects[id.projectKey] = {
				projectKey: id.projectKey,
				name: id.name,
				...(id.chatProjectSlug ? { isChatProject: true, slug: id.chatProjectSlug } : {}),
				deletedAt: now,
				updatedAt: now,
				items: [],
			};
			touched = true;
		}
		if (this.doc.chatTranscripts) {
			for (const [sid, tr] of Object.entries(this.doc.chatTranscripts)) {
				if (tr.scopeKey.toLowerCase() === targetKeyLower) {
					delete this.doc.chatTranscripts[sid];
					touched = true;
				}
			}
		}
		if (id.chatProjectSlug) {
			const root = resolveChatProjectsRoot(this.dataDir);
			const dir = join(root, sanitizeProjectSlug(id.chatProjectSlug));
			try {
				const sessionDir = SessionManager.create(dir).getSessionDir();
				if (existsSync(sessionDir)) rmSync(sessionDir, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
			try {
				if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
				// 同时清理同目录下大小写不同的同名子目录
				if (existsSync(root)) {
					for (const entry of readdirSync(root, { withFileTypes: true })) {
						if (entry.isDirectory() && sanitizeProjectSlug(entry.name).toLowerCase() === targetSlugLower) {
							rmSync(join(root, entry.name), { recursive: true, force: true });
						}
					}
				}
			} catch {
				/* ignore */
			}
			touched = true;
		}
		if (touched) {
			this.doc.updatedAt = now;
			this.saveToDisk();
			this.notifyChange();
		}
		return touched;
	}

	listChatProjects(): {
		slug: string;
		name: string;
		path: string;
		instructions: string;
		itemCount: number;
		updatedAt: number;
	}[] {
		const root = resolveChatProjectsRoot(this.dataDir);
		const out: {
			slug: string;
			name: string;
			path: string;
			instructions: string;
			itemCount: number;
			updatedAt: number;
		}[] = [];
		const seen = new Set<string>();
		const deletedSlugs = new Set<string>();
		for (const b of Object.values(this.doc.projects)) {
			if (!b.isChatProject || !b.slug) continue;
			const slug = sanitizeProjectSlug(b.slug);
			if (b.deletedAt) {
				deletedSlugs.add(slug.toLowerCase());
				continue;
			}
			seen.add(slug.toLowerCase());
			const p = join(root, slug);
			try {
				mkdirSync(p, { recursive: true });
			} catch {
				/* ignore */
			}
			out.push({
				slug,
				name: b.name || slug,
				path: p,
				instructions: b.instructions ?? "",
				itemCount: (b.items ?? []).filter((i) => !i.deletedAt && i.content).length,
				updatedAt: b.updatedAt || 0,
			});
		}
		try {
			for (const entry of readdirSync(root, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				const slugKey = sanitizeProjectSlug(entry.name).toLowerCase();
				if (seen.has(slugKey) || deletedSlugs.has(slugKey)) continue;
				out.push({
					slug: entry.name,
					name: entry.name,
					path: join(root, entry.name),
					instructions: "",
					itemCount: 0,
					updatedAt: 0,
				});
			}
		} catch {
			/* ignore */
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** 解析并返回当前已捕获/同步的 Chat 对话列表摘要（供前端「记忆与跨端同步」面板直观展示与一键跳转）。 */
	listSyncedTranscripts(): SyncedTranscriptSummary[] {
		const map = this.doc.chatTranscripts ?? {};
		const out: SyncedTranscriptSummary[] = [];
		const chatSpaceDir = resolveChatSpaceDir(this.dataDir);
		const chatProjectsRoot = resolveChatProjectsRoot(this.dataDir);

		for (const tr of Object.values(map)) {
			if (!tr?.sessionId || !tr?.jsonl) continue;
			if (this.doc.projects[tr.scopeKey]?.deletedAt) continue;
			let cwd = chatSpaceDir;
			let scopeName = "💬 独立对话";
			if (tr.scopeKey.startsWith("chat-project:")) {
				const slug = sanitizeProjectSlug(tr.scopeKey.slice("chat-project:".length));
				cwd = join(chatProjectsRoot, slug);
				scopeName = this.doc.projects[tr.scopeKey]?.name || slug;
			}
			let title = "";
			let firstUserText = "";
			let messageCount = 0;
			for (const rawLine of tr.jsonl.split("\n")) {
				const line = rawLine.trim();
				if (!line.startsWith("{")) continue;
				try {
					const obj = JSON.parse(line) as Record<string, unknown>;
					if (obj.type === "session_info" && typeof obj.name === "string" && obj.name.trim()) {
						title = obj.name.trim();
					} else if (obj.type === "message" && obj.message && typeof obj.message === "object") {
						const msg = obj.message as Record<string, unknown>;
						if (msg.role === "user" || msg.role === "assistant") {
							messageCount++;
						}
						if (msg.role === "user" && !firstUserText) {
							if (typeof msg.content === "string") {
								firstUserText = msg.content.trim();
							} else if (Array.isArray(msg.content)) {
								for (const part of msg.content) {
									if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text") {
										const t = String((part as Record<string, unknown>).text ?? "").trim();
										if (t) {
											firstUserText = t;
											break;
										}
									}
								}
							}
						}
					}
				} catch {
					/* ignore */
				}
			}
			const finalTitle = (title || firstUserText || tr.sessionId.slice(0, 8)).replace(/\s+/g, " ").slice(0, 80);
			let filePath = tr.fileName;
			try {
				filePath = join(SessionManager.create(cwd).getSessionDir(), basename(tr.fileName));
			} catch {
				/* ignore */
			}
			out.push({
				sessionId: tr.sessionId,
				fileName: tr.fileName,
				title: finalTitle,
				scopeKey: tr.scopeKey,
				scopeName,
				cwd,
				filePath,
				messageCount,
				updatedAt: tr.updatedAt || 0,
			});
		}
		return out.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * 从用户发言中自动提取长期背景事实/硬件环境/个人目标/偏好并存入记忆库
	 * （当会话未开启「独立记忆」时生效，解决模型未主动输出 [[memory:...]] 导致记忆为 0 的问题）。
	 */
	ingestUserMessage(userText: string, cwd: string, sessionKey?: string): MemoryItem[] {
		if (!userText || this.isSessionIsolated(sessionKey)) return [];
		const clean = userText.trim();
		if (clean.length < 4 || clean.length > 2000) return [];
		const added: MemoryItem[] = [];

		// 1. 显式要求记住的内容：「记住…」「请记住…」「我的偏好是…」
		const explicitRe = /(?:请?帮我记住|请?记住|记一下|我的偏好是|以后默认|remember that)\s*[:：，,]?\s*([^\n。；;]{4,180})/gi;
		let m: RegExpExecArray | null;
		while ((m = explicitRe.exec(clean)) !== null) {
			const fact = m[1]?.trim();
			if (fact) added.push(this.addItem("global", fact, cwd));
		}

		// 2. 硬件与系统环境自述（例如包含显卡/内存/操作系统组合）
		const hasOs = /\b(ubuntu|windows|macos|arch\s*linux|debian|wsl2?)\b/i.test(clean);
		const hasHw = /\b(rtx\s*\d{3,4}|gtx\s*\d{3,4}|[1-9]\d*\s*g(?:b)?\s*(?:ddr\d|ram|内存|显存)|ddr[45]|m[1-4]\s*(?:pro|max|ultra)?|a100|h100|4090|3090|3080)\b/i.test(clean);
		if (hasOs && hasHw) {
			const clauses = clean
				.split(/[。\n；;，,]|(?=(?:[1-9][、.\s]*)?(?:当前基础|目前基础|最终目的|目的是|目标是))/)
				.map((s) => s.trim())
				.filter(Boolean);
			for (const c of clauses) {
				if (/\b(ubuntu|windows|macos|rtx|ddr|ram|3080|3090|4090|显存|内存)\b/i.test(c) && c.length <= 160) {
					added.push(this.addItem("global", `硬件与系统环境：${c}`, cwd));
					break;
				}
			}
		}

		// 3. 个人技术基础与学习/求职目标自述
		const bgMatch = /(?:当前基础|目前基础|个人基础|我的基础)\s*(?:是|为|[:：])?\s*([^\n。；;]{4,140}?)(?=\s*(?:[1-9][、.\s]*)?(?:最终目的|学习目的|目的是|目标是|$))/i.exec(clean);
		if (bgMatch?.[1]) {
			added.push(this.addItem("global", `技术基础：${bgMatch[1].trim()}`, cwd));
		}
		const goalMatch = /(?:最终目的|学习目的|目的是|目标是)\s*(?:是|为|[:：])?\s*([^\n。，,；;]{3,100})/i.exec(clean);
		if (goalMatch?.[1]) {
			added.push(this.addItem("global", `当前目标：${goalMatch[1].trim()}`, cwd));
		}

		return added;
	}

	/** 判断指定会话是否开启了「🔒 独立记忆（不读写共享记忆）」。 */
	isSessionIsolated(sessionKey: string | undefined): boolean {
		if (!sessionKey) return false;
		return (this.doc.isolatedSessionIds ?? []).includes(sessionKey);
	}

	setSessionIsolated(sessionKey: string, isolated: boolean): boolean {
		this.syncFromDiskIfNewer();
		if (!sessionKey) return false;
		const set = new Set(this.doc.isolatedSessionIds ?? []);
		if (isolated) set.add(sessionKey);
		else set.delete(sessionKey);
		this.doc.isolatedSessionIds = [...set].slice(-500);
		this.doc.updatedAt = Date.now();
		this.saveToDisk();
		this.notifyChange();
		return isolated;
	}

	/** 供前端面板展示的当前工作区记忆快照。 */
	getView(cwd: string): MemorySnapshotView {
		this.syncFromDiskIfNewer();
		this.captureChatTranscriptsFromDisk(false);
		const chatSpaceCwd = resolveChatSpaceDir(this.dataDir);
		const chatProjectsRoot = resolveChatProjectsRoot(this.dataDir);
		const workProjectsRoot = resolveWorkProjectsRoot(this.dataDir);
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		const bucket = this.doc.projects[id.projectKey];
		const rawBucketName = bucket?.name;
		const folderName = basename(resolve(cwd));
		// 若旧 bucket.name 存的是未美化过的原始远程目录名，则自动升级显示为 🌐 远端目录名 (IP)
		const effectiveProjectName =
			rawBucketName && rawBucketName.toLowerCase() !== folderName.toLowerCase()
				? formatRemoteWorkspaceDisplayName(rawBucketName) || rawBucketName
				: id.name;
		const projectNames: Record<string, string> = {};
		for (const b of Object.values(this.doc.projects)) {
			if (!b || b.deletedAt || !b.name) continue;
			const cleanName = formatRemoteWorkspaceDisplayName(b.name) || b.name;
			projectNames[b.projectKey.toLowerCase()] = cleanName;
			if (b.slug) {
				projectNames[`slug:${b.slug.toLowerCase()}`] = cleanName;
			}
			if (b.folderName && b.name.toLowerCase() !== b.folderName.toLowerCase()) {
				projectNames[`dir:${b.folderName.toLowerCase()}`] = cleanName;
			}
		}
		return {
			chatSpaceCwd,
			chatProjectsRoot,
			workProjectsRoot,
			isChatSpace: id.isChatSpace,
			projectKey: id.projectKey,
			projectName: effectiveProjectName,
			projectInstructions: bucket?.deletedAt ? "" : (bucket?.instructions ?? ""),
			globalItems: this.listActiveItems("global"),
			projectItems: this.listActiveItems("project", cwd),
			chatProjects: this.listChatProjects(),
			projectNames,
			syncedTranscripts: this.listSyncedTranscripts(),
		};
	}

	/**
	 * 组装注入到系统提示词的 <user_memory> XML 段落。
	 * 若会话处于「独立记忆（memoryIsolated=true）」，调用方不调用此方法。
	 */
	buildPromptInjection(cwd: string): string {
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		const bucket = this.doc.projects[id.projectKey];
		const globalActive = this.doc.global.filter((i) => !i.deletedAt && i.enabled && i.content);
		const projectActive = id.isChatSpace
			? []
			: (bucket?.items ?? []).filter((i) => !i.deletedAt && i.enabled && i.content);
		const instructions = !id.isChatSpace && bucket?.instructions?.trim() ? bucket.instructions.trim() : "";

		if (globalActive.length === 0 && projectActive.length === 0 && !instructions) return "";

		const sections: string[] = ["<user_memory>"];
		if (instructions) {
			sections.push(
				`<project_custom_instructions project="${bucket?.name || id.name}">\n${instructions}\n</project_custom_instructions>`,
			);
		}
		if (globalActive.length > 0) {
			const lines = globalActive.map((i) => `- [${i.id}] ${i.content}`).join("\n");
			sections.push(`<global_memories>\n${lines}\n</global_memories>`);
		}
		if (projectActive.length > 0) {
			const lines = projectActive.map((i) => `- [${i.id}] ${i.content}`).join("\n");
			sections.push(`<project_memories project="${bucket?.name || id.name}">\n${lines}\n</project_memories>`);
		}
		sections.push("</user_memory>");
		return sections.join("\n\n");
	}
}

const storesByDataDir = new Map<string, MemoryStore>();

export function getMemoryStore(dataDir: string | undefined): MemoryStore | null {
	if (!dataDir) return null;
	const key = normalizePathKey(resolve(dataDir));
	let store = storesByDataDir.get(key);
	if (!store) {
		store = new MemoryStore(dataDir);
		storesByDataDir.set(key, store);
	}
	return store;
}
