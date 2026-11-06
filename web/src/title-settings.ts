/// <reference lib="dom" />
/**
 * 浏览器标题显示项目名开关（纯前端 localStorage，不经过 server）。
 *
 * - 默认开启：标题为 `<工作目录文件夹名> — pi-web-ui`，切项目（set_cwd）即时更新。
 *   如需固定应用名，可在设置面板手动关闭。
 * - normalize/load/projectNameFromCwd 为纯函数，可单测（tests/unit/title-settings.test.ts）。
 *
 * 与 chat-width-settings.ts 同构：都是"只影响浏览器端呈现"的偏好，
 * 没必要进 server 的 settings 快照。
 */

import { useSyncExternalStore } from "react";

const TITLE_SETTINGS_KEY = "pi-web-ui:project-title";

interface TitleSettings {
	/** 浏览器标题是否显示当前项目名（false = 固定应用名） */
	projectName: boolean;
}

export const DEFAULT_TITLE_SETTINGS: TitleSettings = { projectName: true };

/** 规整设置值：非对象 / 字段类型错误一律回退默认值。 */
export function normalizeTitleSettings(raw: unknown): TitleSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_TITLE_SETTINGS };
	const o = raw as Record<string, unknown>;
	return {
		projectName: typeof o.projectName === "boolean" ? o.projectName : DEFAULT_TITLE_SETTINGS.projectName,
	};
}

/**
 * 识别远程 SSH 工作区路径（`ssh://user@host[:port]/path` 或本地映射的
 * `remote-workspaces/<user>_<host>_<port>_<path>_<hash>` / `<user>_<ip>`），
 * 返回 `🌐 远端目录名 (主机)` 的简洁展示名；普通本地路径返回 null。
 */
export function formatRemoteProjectName(pathOrUri: string): string | null {
	if (!pathOrUri) return null;
	const trimmed = pathOrUri.trim();
	const sshMatch = /^ssh:\/\/([^@]+)@([^:/]+)(?::\d+)?(\/.*)?$/i.exec(trimmed);
	if (sshMatch) {
		const user = sshMatch[1];
		const host = sshMatch[2];
		const rawPath = (sshMatch[3] || "").replace(/\\/g, "/").replace(/\/+$/, "");
		const segs = rawPath.split("/").filter(Boolean);
		const dir = segs[segs.length - 1] || user || "/";
		return `🌐 ${dir} (${host})`;
	}

	const clean = trimmed.replace(/[\\/]+$/, "");
	const base = clean.split(/[\\/]/).pop() ?? "";
	if (!base) return null;

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
		const user = shortSlug[1].trim();
		const host = shortSlug[2];
		return `🌐 ${user} (${host})`;
	}

	return null;
}

/**
 * 从工作目录取项目名（末级文件夹名；远程工作区自动格式化为 `🌐 目录名 (IP)`）。
 * 兼容 POSIX / Windows 分隔符，容忍尾随分隔符；根目录 / 空串返回 ""。
 */
export function projectNameFromCwd(cwd: string): string {
	if (!cwd) return "";
	const remote = formatRemoteProjectName(cwd);
	if (remote) return remote;
	const trimmed = cwd.replace(/[\\/]+$/, "");
	const name = trimmed.split(/[\\/]/).pop() ?? "";
	return name;
}

/** 读取持久化的开关（localStorage 不可用 / 数据损坏时回退默认值）。 */
function loadTitleSettings(): TitleSettings {
	try {
		const raw = localStorage.getItem(TITLE_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_TITLE_SETTINGS };
		return normalizeTitleSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_TITLE_SETTINGS };
	}
}

/** 保存并广播变更（localStorage 不可写时静默忽略）。 */
export function saveTitleSettings(s: TitleSettings): void {
	const norm = normalizeTitleSettings(s);
	try {
		localStorage.setItem(TITLE_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cached = norm;
	for (const l of listeners) l();
}

// ---- 订阅：单例 listener 集合。----------------------------------------------

let cached: TitleSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): boolean {
	if (!cached) cached = loadTitleSettings();
	return cached.projectName;
}

/** 标题当前是否显示项目名（设置面板切换后即时生效，无需刷新）。 */
export function useProjectTitle(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot);
}
