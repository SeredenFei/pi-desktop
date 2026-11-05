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
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizePathKey } from "./client-state.js";

export const MAX_MEMORY_ITEM_CHARS = 300;
export const MAX_MEMORIES_PER_SCOPE = 100;
export const MAX_PROJECT_INSTRUCTIONS_CHARS = 4000;
export const MAX_SYNCED_CHAT_TRANSCRIPTS = 40;
export const MAX_TRANSCRIPT_BYTES = 120 * 1024;

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

export interface MemoryDocument {
	version: 1;
	updatedAt: number;
	global: MemoryItem[];
	projects: Record<string, ProjectMemoryBucket>;
	/** 开启了「🔒 独立记忆（不读写共享记忆）」的会话 ID 列表。 */
	isolatedSessionIds?: string[];
	/** 跨端同步的 Chat 空间（独立对话 + Chat Projects）轻量对话记录。 */
	chatTranscripts?: Record<string, SyncedChatTranscript>;
}

export interface MemorySnapshotView {
	chatSpaceCwd: string;
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
}

function emptyDocument(): MemoryDocument {
	return {
		version: 1,
		updatedAt: 0,
		global: [],
		projects: {},
	};
}

function clampText(raw: string, maxChars: number): string {
	const trimmed = raw.trim().replace(/\r\n/g, "\n");
	return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
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

/** 计算任意工作区目录对应的稳定项目记忆键与展示名。 */
export function resolveProjectMemoryIdentity(
	dataDir: string,
	cwd: string,
): { projectKey: string; name: string; isChatSpace: boolean; chatProjectSlug?: string } {
	const chatSpace = resolveChatSpaceDir(dataDir);
	const normCwd = normalizePathKey(resolve(cwd));
	if (normCwd === normalizePathKey(chatSpace)) {
		return { projectKey: "chat-space", name: "Chats", isChatSpace: true };
	}
	const chatProjectsRoot = resolveChatProjectsRoot(dataDir);
	const normRoot = normalizePathKey(chatProjectsRoot);
	if (normCwd.startsWith(`${normRoot}/`)) {
		const rel = normCwd.slice(normRoot.length + 1);
		const slug = rel.split("/")[0] || "project";
		return {
			projectKey: `chat-project:${slug}`,
			name: slug,
			isChatSpace: false,
			chatProjectSlug: slug,
		};
	}
	const gitKey = detectGitRemoteKey(cwd);
	const folderName = basename(resolve(cwd)) || "workspace";
	if (gitKey) {
		return { projectKey: gitKey, name: folderName, isChatSpace: false };
	}
	return { projectKey: `dir:${folderName.toLowerCase()}`, name: folderName, isChatSpace: false };
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
			const aInstAt = a.instructionsUpdatedAt ?? a.updatedAt ?? 0;
			const bInstAt = b.instructionsUpdatedAt ?? b.updatedAt ?? 0;
			const newerInst = bInstAt >= aInstAt ? b : a;
			const newerMeta = (b.updatedAt ?? 0) >= (a.updatedAt ?? 0) ? b : a;
			projects[key] = {
				projectKey: key,
				name: newerMeta.name || a.name || b.name || key,
				...(newerInst.instructions
					? { instructions: clampText(newerInst.instructions, MAX_PROJECT_INSTRUCTIONS_CHARS) }
					: {}),
				instructionsUpdatedAt: Math.max(aInstAt, bInstAt),
				...(a.isChatProject || b.isChatProject ? { isChatProject: true } : {}),
				...(newerMeta.slug || a.slug || b.slug ? { slug: newerMeta.slug || a.slug || b.slug } : {}),
				updatedAt: Math.max(a.updatedAt ?? 0, b.updatedAt ?? 0),
				items: mergeMemoryItems(a.items ?? [], b.items ?? []),
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
		const chosen = lt && rt ? ((rt.updatedAt ?? 0) >= (lt.updatedAt ?? 0) ? rt : lt) : (lt ?? rt);
		if (chosen && chosen.sessionId && chosen.jsonl && chosen.jsonl.length <= MAX_TRANSCRIPT_BYTES) {
			transcriptList.push(chosen);
		}
	}
	transcriptList.sort((a, b) => b.updatedAt - a.updatedAt);
	for (const t of transcriptList.slice(0, MAX_SYNCED_CHAT_TRANSCRIPTS)) {
		mergedTranscripts[t.sessionId] = t;
	}

	return {
		version: 1,
		updatedAt: Math.max(local.updatedAt ?? 0, remote.updatedAt ?? 0, Date.now()),
		global: mergeMemoryItems(local.global ?? [], remote.global ?? []),
		projects,
		isolatedSessionIds: [...new Set([...(local.isolatedSessionIds ?? []), ...(remote.isolatedSessionIds ?? [])])].slice(
			-500,
		),
		chatTranscripts: mergedTranscripts,
	};
}

export class MemoryStore {
	readonly dataDir: string;
	readonly filePath: string;
	private doc: MemoryDocument;
	private changeListeners = new Set<() => void>();

	constructor(dataDir: string) {
		this.dataDir = resolve(dataDir);
		this.filePath = join(this.dataDir, "memory-store.json");
		this.doc = this.loadFromDisk();
		this.ensureChatProjectDirs();
	}

	onChange(cb: () => void): () => void {
		this.changeListeners.add(cb);
		return () => this.changeListeners.delete(cb);
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

	private loadFromDisk(): MemoryDocument {
		try {
			if (!existsSync(this.filePath)) return emptyDocument();
			const raw = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<MemoryDocument>;
			if (!raw || typeof raw !== "object") return emptyDocument();
			return mergeMemoryDocuments(emptyDocument(), {
				version: 1,
				updatedAt: Number(raw.updatedAt) || 0,
				global: Array.isArray(raw.global) ? raw.global : [],
				projects: raw.projects && typeof raw.projects === "object" ? raw.projects : {},
				isolatedSessionIds: Array.isArray(raw.isolatedSessionIds)
					? raw.isolatedSessionIds.filter((x): x is string => typeof x === "string")
					: [],
				chatTranscripts: raw.chatTranscripts && typeof raw.chatTranscripts === "object" ? raw.chatTranscripts : {},
			});
		} catch {
			return emptyDocument();
		}
	}

	private saveToDisk(): void {
		try {
			mkdirSync(this.dataDir, { recursive: true });
			writeFileSync(this.filePath, JSON.stringify(this.doc, null, "\t"), "utf8");
		} catch {
			/* ignore */
		}
	}

	/** 确保所有同步过来的话题项目在本地 <dataDir>/chat-projects/<slug> 下有实体目录。 */
	ensureChatProjectDirs(): void {
		const root = resolveChatProjectsRoot(this.dataDir);
		for (const bucket of Object.values(this.doc.projects)) {
			if (bucket.isChatProject && bucket.slug) {
				try {
					mkdirSync(join(root, sanitizeProjectSlug(bucket.slug)), { recursive: true });
				} catch {
					/* ignore */
				}
			}
		}
	}

	getDocument(): MemoryDocument {
		return JSON.parse(JSON.stringify(this.doc)) as MemoryDocument;
	}

	/** 与远端文档合并并落盘（返回合并后的文档，同时将远端 Chat 对话记录还原到本地会话目录）。 */
	mergeRemote(remote: MemoryDocument): MemoryDocument {
		this.captureChatTranscriptsFromDisk(false);
		this.doc = mergeMemoryDocuments(this.doc, remote);
		this.ensureChatProjectDirs();
		this.materializeChatTranscriptsToDisk();
		this.saveToDisk();
		return this.getDocument();
	}

	/**
	 * 扫描本机 Chat 空间（chat-space 与 chat-projects/*）下的 .jsonl 会话记录，
	 * 打包进 doc.chatTranscripts 以便随 GitHub 云同步上传。
	 */
	captureChatTranscriptsFromDisk(notify = true): boolean {
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
					if (st.size === 0 || st.size > MAX_TRANSCRIPT_BYTES) continue;
					const rawText = readFileSync(fp, "utf8");
					const nl = rawText.indexOf("\n");
					const firstLine = (nl >= 0 ? rawText.slice(0, nl) : rawText).trim();
					if (!firstLine) continue;
					let header: Record<string, unknown>;
					try {
						header = JSON.parse(firstLine) as Record<string, unknown>;
					} catch {
						continue;
					}
					const sid = typeof header.id === "string" ? header.id : "";
					if (!sid || this.isSessionIsolated(sid)) continue;
					header.cwd = t.placeholder;
					const portableJsonl = JSON.stringify(header) + (nl >= 0 ? rawText.slice(nl) : "\n");
					const prev = nextMap[sid];
					const mtime = Math.round(st.mtimeMs);
					if (!prev || mtime > prev.updatedAt || prev.jsonl.length !== portableJsonl.length) {
						nextMap[sid] = {
							sessionId: sid,
							fileName: f,
							scopeKey: t.scopeKey,
							updatedAt: mtime,
							jsonl: portableJsonl,
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
	 * 并把首行 cwd 占位符还原为本机的真实目录路径。
	 */
	materializeChatTranscriptsToDisk(): void {
		const map = this.doc.chatTranscripts ?? {};
		for (const item of Object.values(map)) {
			try {
				if (!item?.sessionId || !item?.jsonl || !item?.fileName) continue;
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
				if (existsSync(destPath)) {
					try {
						const st = statSync(destPath);
						if (Math.round(st.mtimeMs) >= item.updatedAt) continue;
					} catch {
						/* overwrite */
					}
				}
				const nl = item.jsonl.indexOf("\n");
				const firstLine = (nl >= 0 ? item.jsonl.slice(0, nl) : item.jsonl).trim();
				const header = JSON.parse(firstLine) as Record<string, unknown>;
				header.cwd = localDir;
				const localJsonl = JSON.stringify(header) + (nl >= 0 ? item.jsonl.slice(nl) : "\n");
				writeFileSync(destPath, localJsonl, "utf8");
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
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		if (id.isChatSpace) return;
		const bucket = this.ensureProjectBucket(cwd);
		const now = Date.now();
		bucket.instructions = clampText(instructions, MAX_PROJECT_INSTRUCTIONS_CHARS);
		bucket.instructionsUpdatedAt = now;
		bucket.updatedAt = now;
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
	}

	/** 创建或更新一个云端可同步的「话题项目」（位于 <dataDir>/chat-projects/<slug>）。 */
	createChatProject(name: string, instructions = ""): { slug: string; name: string; path: string } {
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
			items: existing?.items ?? [],
		};
		this.doc.updatedAt = now;
		this.saveToDisk();
		this.notifyChange();
		return { slug, name: trimmedName, path: dir };
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
		for (const b of Object.values(this.doc.projects)) {
			if (!b.isChatProject || !b.slug) continue;
			const slug = sanitizeProjectSlug(b.slug);
			seen.add(slug);
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
				if (!entry.isDirectory() || seen.has(entry.name)) continue;
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

	/** 判断指定会话是否开启了「🔒 独立记忆（不读写共享记忆）」。 */
	isSessionIsolated(sessionKey: string | undefined): boolean {
		if (!sessionKey) return false;
		return (this.doc.isolatedSessionIds ?? []).includes(sessionKey);
	}

	setSessionIsolated(sessionKey: string, isolated: boolean): boolean {
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
		const chatSpaceCwd = resolveChatSpaceDir(this.dataDir);
		const id = resolveProjectMemoryIdentity(this.dataDir, cwd);
		const bucket = this.doc.projects[id.projectKey];
		return {
			chatSpaceCwd,
			isChatSpace: id.isChatSpace,
			projectKey: id.projectKey,
			projectName: bucket?.name || id.name,
			projectInstructions: bucket?.instructions ?? "",
			globalItems: this.listActiveItems("global"),
			projectItems: this.listActiveItems("project", cwd),
			chatProjects: this.listChatProjects(),
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
