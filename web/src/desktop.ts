import { THEME_CHANGE_EVENT } from "./theme";

/**
 * 桌面壳（Electron）检测与沉浸式窗口装饰。
 *
 * `desktop/preload.ts` 经 contextBridge 在主世界挂了 `window.piDesktop = { isDesktop: true, … }`，
 * 这是主判定；UA 里带 `Electron/` 当兜底（preload 未来改名也不至于全瞎）。
 *
 * 参数注水（`win?`）是为了单测：浏览器里直接调 `isDesktopShell()` 读全局 window 即可。
 */
export interface DesktopWindowBridge {
	minimize: () => Promise<boolean>;
	toggleMaximize: () => Promise<boolean>;
	close: () => Promise<boolean>;
	isMaximized: () => Promise<boolean>;
	onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
}

export interface DesktopQuitBridge {
	onConfirmRequest: (cb: (req: { id: number; active: number }) => void) => () => void;
	decide: (id: number, ok: boolean) => Promise<boolean>;
}

export interface DesktopShellWindow {
	piDesktop?: {
		isDesktop?: unknown;
		platform?: unknown;
		setTitleBarOverlay?: (opts: { color?: string; symbolColor?: string }) => Promise<unknown>;
		onFullScreenChange?: (cb: (isFullScreen: boolean) => void) => () => void;
		window?: DesktopWindowBridge;
		quit?: DesktopQuitBridge;
		updater?: unknown;
	};
	navigator?: { userAgent?: unknown };
}

export function isDesktopShell(win?: unknown): boolean {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w) return false;
	if (w.piDesktop?.isDesktop === true) return true;
	const ua = w.navigator?.userAgent;
	return typeof ua === "string" && ua.includes("Electron/");
}

/** 兼容别名 */
export const isDesktopApp = isDesktopShell;

/** 获取桌面端窗口控制桥（最小化/最大化/关闭）。 */
export function getDesktopWindowBridge(win?: unknown): DesktopWindowBridge | null {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w || !w.piDesktop?.window) return null;
	return w.piDesktop.window;
}

/** 获取桌面端退出确认桥（旧版桌面壳 / 浏览器返回 null）。 */
export function getDesktopQuitBridge(win?: unknown): DesktopQuitBridge | null {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	return w?.piDesktop?.quit ?? null;
}

/** 获取桌面操作系统类型，供沉浸式顶栏做平台避让（macOS 避让交通灯，Windows/Linux 避让右上角三键）。 */
export function getDesktopPlatform(win?: unknown): "darwin" | "win32" | "linux" | null {
	if (!isDesktopShell(win)) return null;
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w) return null;
	const p = w.piDesktop?.platform;
	if (p === "darwin" || p === "win32" || p === "linux") return p;
	const ua = typeof w.navigator?.userAgent === "string" ? w.navigator.userAgent : "";
	if (ua.includes("Macintosh") || ua.includes("Mac OS")) return "darwin";
	if (ua.includes("Windows")) return "win32";
	if (ua.includes("Linux")) return "linux";
	return null;
}

/** 动态同步 Windows / Linux 的系统控制按钮图标颜色，确保深色/浅色主题下均清晰可见。 */
export function syncDesktopTitleBarTheme(win?: unknown): void {
	const w =
		(win as DesktopShellWindow | undefined) ??
		(typeof window === "undefined" ? undefined : (window as unknown as DesktopShellWindow));
	if (!w || !w.piDesktop?.setTitleBarOverlay) return;

	let isLight = false;
	if (typeof document !== "undefined") {
		try {
			isLight =
				document.body?.classList.contains("theme-light") ||
				document.documentElement?.getAttribute("data-theme-scheme") === "light" ||
				Boolean(document.getElementById("theme-stylesheet")?.getAttribute("href")?.includes("light"));
		} catch {
			// 忽略 DOM 读取异常
		}
	}
	const symbolColor = isLight ? "#334155" : "#cbd5e1";
	void w.piDesktop.setTitleBarOverlay({
		color: "#00000000",
		symbolColor,
	});
}

/**
 * 在应用启动时初始化桌面端窗口沉浸式装饰：
 * 1. 注入 body 类名（is-desktop, is-desktop-mac / is-desktop-win 等）
 * 2. 监听全屏切换，动态避让/解除交通灯与控制按钮 padding
 * 3. 监听主题切换，动态更新控制按钮图标颜色
 */
export function setupDesktopWindowDecorations(): () => void {
	if (typeof window === "undefined" || !isDesktopShell()) return () => {};

	const platform = getDesktopPlatform();
	const body = document.body;
	body.classList.add("is-desktop");
	if (platform === "darwin") body.classList.add("is-desktop-mac");
	else if (platform === "win32") body.classList.add("is-desktop-win");
	else if (platform === "linux") body.classList.add("is-desktop-linux");

	const updateFullScreen = (isFs: boolean) => {
		if (isFs) body.classList.add("is-desktop-fullscreen");
		else body.classList.remove("is-desktop-fullscreen");
	};

	// DOM 全屏事件监听
	const domFsHandler = () => {
		updateFullScreen(Boolean(document.fullscreenElement));
	};
	document.addEventListener("fullscreenchange", domFsHandler);

	// Electron 全屏事件监听
	const cleanupFs = (window as unknown as DesktopShellWindow).piDesktop?.onFullScreenChange?.((isFs) =>
		updateFullScreen(isFs),
	);

	// 主题切换同步
	const themeHandler = () => syncDesktopTitleBarTheme();
	window.addEventListener(THEME_CHANGE_EVENT, themeHandler);
	syncDesktopTitleBarTheme();

	return () => {
		body.classList.remove(
			"is-desktop",
			"is-desktop-mac",
			"is-desktop-win",
			"is-desktop-linux",
			"is-desktop-fullscreen",
		);
		document.removeEventListener("fullscreenchange", domFsHandler);
		window.removeEventListener(THEME_CHANGE_EVENT, themeHandler);
		cleanupFs?.();
	};
}
