/// <reference lib="dom" />
/**
 * 终端交互小插件的偏好与纯函数（选中即复制 / 右键 / 中键 / 搜索 / 链接 / 字号）。
 *
 * 存储选择：纯前端 localStorage，不走 server settings 链路。理由——这些都是
 * 「本设备」属性：剪贴板权限与安全上下文（https vs http）、系统快捷键习惯
 * （macOS Cmd vs Ctrl）、屏幕 DPI 决定的字号，跨设备同步反而会把一台机器的
 * 偏好强加给另一台。与 chat-width-settings.ts 同构：模块级缓存 + 监听集合 +
 * useSyncExternalStore，设置面板改动后已打开的终端即时生效，无需重建 xterm。
 *
 * 判定逻辑（快捷键匹配、右键动作、字号夹取）全部是可单测的纯函数
 * （tests/unit/term-interaction.test.ts）；DOM 副作用（剪贴板）集中在文件下半部分。
 */

import { useSyncExternalStore } from "react";

const TERM_INTERACTION_KEY = "pi-web-ui:term-interaction";

export const TERM_FONT_SIZE_MIN = 8;
export const TERM_FONT_SIZE_MAX = 32;
export const TERM_FONT_SIZE_DEFAULT = 13;

export interface TermInteractionSettings {
	/** 鼠标松开后，若本次拖选产生了选区，则自动写入剪贴板。 */
	copyOnSelect: boolean;
	/** 右键：有选区=复制并清除选区，无选区=粘贴。 */
	rightClick: boolean;
	/** 中键粘贴。 */
	middlePaste: boolean;
	/** Ctrl+Shift+F（macOS Cmd+F）终端内搜索。 */
	search: boolean;
	/** Ctrl/Cmd+点击打开 http(s) 链接。 */
	links: boolean;
	/** Ctrl/Cmd + = / - / 0 调整字号。 */
	fontShortcuts: boolean;
	/** 当前字号（px），夹在 [MIN, MAX]。 */
	fontSize: number;
}

export const DEFAULT_TERM_INTERACTION: TermInteractionSettings = {
	copyOnSelect: true,
	rightClick: true,
	middlePaste: true,
	search: true,
	links: true,
	fontShortcuts: true,
	fontSize: TERM_FONT_SIZE_DEFAULT,
};

type TermInteractionFlag = Exclude<keyof TermInteractionSettings, "fontSize">;

/** 字号夹取：非数字回退默认，小数四舍五入。 */
export function clampTermFontSize(n: unknown): number {
	if (typeof n !== "number" || !Number.isFinite(n)) return TERM_FONT_SIZE_DEFAULT;
	return Math.min(TERM_FONT_SIZE_MAX, Math.max(TERM_FONT_SIZE_MIN, Math.round(n)));
}

/** 规整设置值：非对象 / 字段类型错误逐项回退默认值。 */
export function normalizeTermInteraction(raw: unknown): TermInteractionSettings {
	const d = DEFAULT_TERM_INTERACTION;
	if (!raw || typeof raw !== "object") return { ...d };
	const o = raw as Record<string, unknown>;
	const flag = (k: TermInteractionFlag): boolean => (typeof o[k] === "boolean" ? o[k] : d[k]);
	return {
		copyOnSelect: flag("copyOnSelect"),
		rightClick: flag("rightClick"),
		middlePaste: flag("middlePaste"),
		search: flag("search"),
		links: flag("links"),
		fontShortcuts: flag("fontShortcuts"),
		fontSize: "fontSize" in o ? clampTermFontSize(o.fontSize) : d.fontSize,
	};
}

export type TermShortcut = "search" | "zoomIn" | "zoomOut" | "zoomReset";

export interface KeyLike {
	key?: string;
	ctrlKey?: boolean;
	metaKey?: boolean;
	shiftKey?: boolean;
	altKey?: boolean;
}

/**
 * 识别终端快捷键。
 * - 搜索：macOS = Cmd+F；其它 = Ctrl+Shift+F（不抢 Ctrl+F：readline 里是 forward-char）。
 * - 字号：macOS = Cmd + = / - / 0；其它 = Ctrl + = / - / 0。macOS 上不认 Ctrl，
 *   因为 Ctrl+- 之类仍应交给 shell。`+`（Shift+=）与 `=` 都算放大。
 */
export function matchTermShortcut(e: KeyLike, isMac: boolean): TermShortcut | null {
	if (e.altKey) return null;
	const key = (e.key ?? "").toLowerCase();
	if (key === "f") {
		if (isMac) return e.metaKey && !e.ctrlKey && !e.shiftKey ? "search" : null;
		return e.ctrlKey && e.shiftKey && !e.metaKey ? "search" : null;
	}
	const mod = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
	if (!mod) return null;
	if (key === "=" || key === "+") return "zoomIn";
	if (e.shiftKey) return null;
	if (key === "-") return "zoomOut";
	if (key === "0") return "zoomReset";
	return null;
}

/** 缩放动作 → 新字号（reset 回默认；结果夹在范围内）。 */
export function applyZoomShortcut(current: number, action: Exclude<TermShortcut, "search">): number {
	if (action === "zoomReset") return TERM_FONT_SIZE_DEFAULT;
	return clampTermFontSize(current + (action === "zoomIn" ? 1 : -1));
}

export type RightClickAction = "copy" | "paste" | "native";

/**
 * 右键动作：有选区 → 复制；无选区且能读剪贴板 → 粘贴；否则放行浏览器原生菜单
 * （http 非安全上下文读不了剪贴板，此时拦掉原生菜单只会让用户什么都做不了）。
 */
export function rightClickAction(hasSelection: boolean, clipboardReadable: boolean): RightClickAction {
	if (hasSelection) return "copy";
	return clipboardReadable ? "paste" : "native";
}

/**
 * 这次 mousedown 是否可能开始一次「拖选」：仅左键；macOS 上 Ctrl+点击是系统层面的
 * 右键（会触发 contextmenu），不能当成选区起点。
 */
export function isSelectionMouseDown(e: { button: number; ctrlKey?: boolean }, isMac: boolean): boolean {
	if (e.button !== 0) return false;
	return !(isMac && e.ctrlKey);
}

/** 链接点击是否带了修饰键：Ctrl（Win/Linux）或 Cmd（macOS）。 */
export function isLinkModifier(e: { ctrlKey?: boolean; metaKey?: boolean }): boolean {
	return Boolean(e.ctrlKey || e.metaKey);
}

/** 只放行 http(s) 链接，且不带内嵌账号密码（钓鱼 URL）。 */
export function isSafeTermLink(raw: string): boolean {
	try {
		const u = new URL(raw);
		return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password;
	} catch {
		return false;
	}
}

// ---- 持久化与订阅 ---------------------------------------------------------

function loadTermInteraction(): TermInteractionSettings {
	try {
		const raw = localStorage.getItem(TERM_INTERACTION_KEY);
		if (!raw) return { ...DEFAULT_TERM_INTERACTION };
		return normalizeTermInteraction(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_TERM_INTERACTION };
	}
}

let cached: TermInteractionSettings | null = null;
const listeners = new Set<() => void>();

/** 当前设置（稳定引用，仅在 save 后替换）。 */
export function getTermInteraction(): TermInteractionSettings {
	if (!cached) cached = loadTermInteraction();
	return cached;
}

/** 保存并广播（localStorage 不可写时仍保留内存值，本会话照常生效）。 */
export function saveTermInteraction(next: Partial<TermInteractionSettings>): void {
	const norm = normalizeTermInteraction({ ...getTermInteraction(), ...next });
	try {
		localStorage.setItem(TERM_INTERACTION_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cached = norm;
	for (const l of listeners) l();
}

export function subscribeTermInteraction(onChange: () => void): () => void {
	listeners.add(onChange);
	return () => {
		listeners.delete(onChange);
	};
}

export function useTermInteraction(): TermInteractionSettings {
	return useSyncExternalStore(subscribeTermInteraction, getTermInteraction);
}

// ---- 平台 / 剪贴板（DOM 副作用）--------------------------------------------

export function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	const uaData = (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform;
	const p = uaData || navigator.platform || navigator.userAgent || "";
	return /mac|iphone|ipad/i.test(p);
}

/** 异步剪贴板读写仅在安全上下文（https / localhost / Electron）可用。 */
function canUseAsyncClipboard(): boolean {
	return (
		typeof navigator !== "undefined" && typeof window !== "undefined" && window.isSecureContext && !!navigator.clipboard
	);
}

export function canReadClipboard(): boolean {
	return canUseAsyncClipboard() && typeof navigator.clipboard.readText === "function";
}

/** 隐藏 textarea + execCommand('copy')：http 非安全上下文的回退，需在用户手势内调用。 */
function copyViaTextarea(text: string): boolean {
	if (typeof document === "undefined") return false;
	const prev = document.activeElement as HTMLElement | null;
	const ta = document.createElement("textarea");
	ta.value = text;
	ta.setAttribute("readonly", "");
	ta.setAttribute("aria-hidden", "true");
	ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;";
	document.body.appendChild(ta);
	let ok = false;
	try {
		ta.select();
		ok = document.execCommand("copy");
	} catch {
		ok = false;
	} finally {
		ta.remove();
		prev?.focus?.();
	}
	return ok;
}

/** 写剪贴板：优先异步 API，失败/不可用时回退 execCommand。返回是否成功。 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
	if (!text) return false;
	if (canUseAsyncClipboard() && typeof navigator.clipboard.writeText === "function") {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			/* fall through to execCommand */
		}
	}
	return copyViaTextarea(text);
}

/** 读剪贴板；不可用/被拒绝时返回 null（调用方静默）。 */
export async function readTextFromClipboard(): Promise<string | null> {
	if (!canReadClipboard()) return null;
	try {
		return await navigator.clipboard.readText();
	} catch {
		return null;
	}
}
