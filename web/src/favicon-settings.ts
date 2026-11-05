/// <reference lib="dom" />
/**
 * 标签页图标（Favicon）颜色与实例名称设置（纯前端 localStorage 存储，支持服务端配置同步）。
 *
 * - 解决多机部署（Issue #763）：浏览器打开多个实例标签页时，图标颜色完全一致导致难以区分。
 * - 多维区分方案：
 *   1. 图标颜色：支持预设高对比度色彩、基于主机名自动散列（Auto Hash）、自定义 Hex 颜色；
 *   2. 实例名称：支持配置机器别名（如 [Server-1]），在标签页标题显示；
 *   3. 部署级环境变量支持：服务端 PI_WEB_FAVICON_COLOR 与 PI_WEB_INSTANCE_NAME。
 *
 * 纯函数可单测（见 tests/unit/favicon-settings.test.ts）。
 */

import { useSyncExternalStore } from "react";
import { appUrl } from "./base-url";

const FAVICON_SETTINGS_KEY = "pi-web-ui:favicon-settings";

export interface FaviconPresetColor {
	id: string;
	hex: string;
	nameKey: string;
}

/** 精选现代、高对比度的预设调色板 */
export const PRESET_FAVICON_COLORS: readonly FaviconPresetColor[] = [
	{ id: "violet", hex: "#8b5cf6", nameKey: "colorViolet" }, // 原生默认紫
	{ id: "blue", hex: "#3b82f6", nameKey: "colorBlue" }, // 宝石蓝
	{ id: "cyan", hex: "#06b6d4", nameKey: "colorCyan" }, // 青空蓝
	{ id: "emerald", hex: "#10b981", nameKey: "colorEmerald" }, // 翡翠绿
	{ id: "amber", hex: "#f59e0b", nameKey: "colorAmber" }, // 活力橙
	{ id: "rose", hex: "#ef4444", nameKey: "colorRose" }, // 珊瑚红
	{ id: "pink", hex: "#ec4899", nameKey: "colorPink" }, // 樱花粉
	{ id: "indigo", hex: "#6366f1", nameKey: "colorIndigo" }, // 靛青
	{ id: "slate", hex: "#64748b", nameKey: "colorSlate" }, // 沉稳灰
] as const;

export const DEFAULT_FAVICON_COLOR = "#8b5cf6";

export interface FaviconSettings {
	/**
	 * 图标颜色标识：
	 * - 'default': 原生默认紫色 (#8b5cf6)
	 * - 'auto': 基于 hostname 稳定散列匹配预设颜色
	 * - 预设颜色 id (如 'blue', 'emerald')
	 * - 'custom': 使用 customHex
	 */
	color: string;
	/** 自定义十六进制颜色代码（如 '#10b981'） */
	customHex?: string;
	/** 实例标识名称（显示在浏览器标签页标题前缀，如 [GPU-1]） */
	instanceName?: string;
}

export const DEFAULT_FAVICON_SETTINGS: FaviconSettings = {
	color: "default",
	customHex: "",
	instanceName: "",
};

/** 简单规范化 hex 颜色：校验是否是有效的 3/6 位十六进制，若是则返回 #xxxxxx */
export function sanitizeHexColor(raw: string | undefined): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	const match = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(trimmed);
	if (!match) return null;
	const hex = match[1];
	if (hex.length === 3) {
		return `#${hex[0]}${hex[0]}${hex[1]}${hex[1]}${hex[2]}${hex[2]}`.toLowerCase();
	}
	return `#${hex.toLowerCase()}`;
}

/** 规整设置对象：容错并回退安全默认值 */
export function normalizeFaviconSettings(raw: unknown): FaviconSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_FAVICON_SETTINGS };
	const o = raw as Record<string, unknown>;
	const color = typeof o.color === "string" && o.color.trim() ? o.color.trim() : DEFAULT_FAVICON_SETTINGS.color;
	const customHex = typeof o.customHex === "string" ? o.customHex.trim() : "";
	const instanceName = typeof o.instanceName === "string" ? o.instanceName.trim() : "";

	return {
		color,
		customHex,
		instanceName,
	};
}

/** 基于字符串（如 hostname 或 host）生成稳定的预设色彩 */
export function hashStringToColor(str: string, palette: readonly FaviconPresetColor[] = PRESET_FAVICON_COLORS): string {
	if (!str || palette.length === 0) return DEFAULT_FAVICON_COLOR;
	let hash = 0;
	for (let i = 0; i < str.length; i++) {
		hash = (hash << 5) - hash + str.charCodeAt(i);
		hash |= 0;
	}
	const index = Math.abs(hash) % palette.length;
	return palette[index].hex;
}

/** 判断背景色是否偏浅（如果是浅色背景，π 符号前景色使用深色保证对比度） */
export function isLightColor(hex: string): boolean {
	const sanitized = hex.replace("#", "").trim();
	if (sanitized.length !== 3 && sanitized.length !== 6) return false;
	let r = 0,
		g = 0,
		b = 0;
	if (sanitized.length === 3) {
		r = parseInt(sanitized[0] + sanitized[0], 16);
		g = parseInt(sanitized[1] + sanitized[1], 16);
		b = parseInt(sanitized[2] + sanitized[2], 16);
	} else {
		r = parseInt(sanitized.slice(0, 2), 16);
		g = parseInt(sanitized.slice(2, 4), 16);
		b = parseInt(sanitized.slice(4, 6), 16);
	}
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return false;
	const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
	return luma > 180;
}

/** 生成 SVG 图标数据字符串 */
export function generateFaviconSvg(bgFill: string): string {
	const symbolFill = isLightColor(bgFill) ? "#1e1e2e" : "#ffffff";
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${bgFill}"/><rect x="14" y="17" width="36" height="6.5" rx="3.25" fill="${symbolFill}"/><rect x="17.5" y="23.5" width="6.5" height="25" rx="3.25" fill="${symbolFill}"/><rect x="40" y="23.5" width="6.5" height="25" rx="3.25" fill="${symbolFill}"/></svg>`;
}

/** 服务端传入的环境级默认（通过 API 或环境变量） */
interface ServerConfig {
	faviconColor?: string;
	instanceName?: string;
}

let serverConfig: ServerConfig = {};

export function setServerFaviconConfig(cfg: ServerConfig): void {
	serverConfig = { ...serverConfig, ...cfg };
	applyFavicon();
	for (const l of listeners) l();
}

export function getServerFaviconConfig(): ServerConfig {
	return serverConfig;
}

/** 异步拉取服务端的环境变量配置并应用（若有），静默容错 */
export async function syncServerFaviconConfig(): Promise<void> {
	if (typeof window === "undefined" || typeof fetch === "undefined") return;
	try {
		const res = await fetch(appUrl("/api/health"));
		if (!res.ok) return;
		const data = (await res.json()) as { instanceName?: string; faviconColor?: string };
		if (data && (data.instanceName || data.faviconColor)) {
			setServerFaviconConfig({
				instanceName: data.instanceName,
				faviconColor: data.faviconColor,
			});
		}
	} catch {
		/* ignore */
	}
}

/** 根据配置、主机名与服务端设置计算最终生效的 Hex 颜色 */
export function resolveFaviconColor(
	settings: FaviconSettings,
	host: string = typeof window !== "undefined" ? window.location.host : "",
	serverColor: string | undefined = serverConfig.faviconColor,
): string {
	// 1. 如果用户显式选择了 custom 且 hex 有效
	if (settings.color === "custom" && settings.customHex) {
		const valid = sanitizeHexColor(settings.customHex);
		if (valid) return valid;
	}

	// 2. 如果用户选择了 auto
	if (settings.color === "auto") {
		return hashStringToColor(host || "localhost");
	}

	// 3. 如果用户显式匹配到了某个预设颜色
	const preset = PRESET_FAVICON_COLORS.find((p) => p.id === settings.color);
	if (preset) {
		return preset.hex;
	}

	// 4. 如果用户选了自定义并且直接是 hex
	const directHex = sanitizeHexColor(settings.color);
	if (directHex) {
		return directHex;
	}

	// 5. 如果处于 default 态，但服务端配置了环境变量 PI_WEB_FAVICON_COLOR
	if (settings.color === "default" && serverColor) {
		// 服务端可能是预设名（如 "emerald"）或具体 hex
		const serverPreset = PRESET_FAVICON_COLORS.find((p) => p.id === serverColor.toLowerCase());
		if (serverPreset) return serverPreset.hex;
		const serverHex = sanitizeHexColor(serverColor);
		if (serverHex) return serverHex;
	}

	return DEFAULT_FAVICON_COLOR;
}

/** 计算最终生效的实例标识名称 */
export function resolveInstanceName(
	settings: FaviconSettings,
	serverName: string | undefined = serverConfig.instanceName,
): string {
	if (settings.instanceName && settings.instanceName.trim()) {
		return settings.instanceName.trim();
	}
	if (serverName && serverName.trim()) {
		return serverName.trim();
	}
	return "";
}

/** 动态更新 DOM 中的 <link rel="icon"> */
export function updateFavicon(color: string): void {
	if (typeof document === "undefined") return;
	let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
	if (!link) {
		link = document.createElement("link");
		link.rel = "icon";
		document.head.appendChild(link);
	}
	link.type = "image/svg+xml";
	const svg = generateFaviconSvg(color);
	link.href = `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** 读取持久化配置 */
export function loadFaviconSettings(): FaviconSettings {
	try {
		const raw = localStorage.getItem(FAVICON_SETTINGS_KEY);
		if (!raw) return { ...DEFAULT_FAVICON_SETTINGS };
		return normalizeFaviconSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_FAVICON_SETTINGS };
	}
}

/** 应用当前配置到浏览器标签页 */
export function applyFavicon(): void {
	const settings = cached ?? loadFaviconSettings();
	if (settings.color === "default" && !serverConfig.faviconColor) {
		if (typeof document !== "undefined") {
			let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
			if (!link) {
				link = document.createElement("link");
				link.rel = "icon";
				document.head.appendChild(link);
			}
			link.type = "image/svg+xml";
			link.href = appUrl("/favicon.svg");
		}
		return;
	}
	const host = typeof window !== "undefined" ? window.location.host : "";
	const color = resolveFaviconColor(settings, host);
	updateFavicon(color);
}

/** 保存并广播配置 */
export function saveFaviconSettings(s: FaviconSettings): void {
	const norm = normalizeFaviconSettings(s);
	try {
		localStorage.setItem(FAVICON_SETTINGS_KEY, JSON.stringify(norm));
	} catch {
		/* ignore */
	}
	cached = norm;
	applyFavicon();
	for (const l of listeners) l();
}

// ---- React Hook 订阅机制 ----------------------------------------------------

let cached: FaviconSettings | null = null;
const listeners = new Set<() => void>();

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

function getSnapshot(): FaviconSettings {
	if (!cached) cached = loadFaviconSettings();
	return cached;
}

export function useFaviconSettings(): FaviconSettings {
	return useSyncExternalStore(subscribe, getSnapshot);
}
