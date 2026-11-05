/**
 * 外壳模式与配色方案（redesign P2，docs/redesign-plan.md）。
 *
 * - shell：`minimal`（新极简外壳，默认）| `classic`（旧 TopBar/SideDock/FooterBar 布局，P3 后移除）
 * - scheme：`light` | `dark` | `system`（跟随系统，默认）
 *
 * 写到 <html> 上：`data-shell="minimal|classic"`、`data-scheme="light|dark"`（已解析）、
 * `data-theme-scheme`（与旧逻辑共用的明暗标记，见 desktop.ts syncDesktopTitleBarTheme）。
 * minimal 模式的设计变量在 web/src/minimal/tokens.css，只认这两个属性。
 *
 * 首屏防闪：main.tsx 在 render 之前调用 applyShellAttrs()。
 */
import { useCallback, useEffect, useState } from "react";
import { THEME_CHANGE_EVENT } from "./theme";

export type ShellMode = "minimal" | "classic";
export type Scheme = "light" | "dark" | "system";
export type ResolvedScheme = "light" | "dark";

export const SHELL_KEY = "pi-web-ui:shell";
export const SCHEME_KEY = "pi-web-ui:scheme";
export const SHELL_PREFS_EVENT = "pi-web-ui:shell-prefs";

function safeGet(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function safeSet(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// storage 不可用：本次会话内仍生效
	}
}

export function readShellMode(): ShellMode {
	return safeGet(SHELL_KEY) === "classic" ? "classic" : "minimal";
}

export function readScheme(): Scheme {
	const v = safeGet(SCHEME_KEY);
	return v === "light" || v === "dark" ? v : "system";
}

export function systemPrefersDark(): boolean {
	try {
		return window.matchMedia("(prefers-color-scheme: dark)").matches;
	} catch {
		return true;
	}
}

export function resolveScheme(scheme: Scheme, prefersDark = systemPrefersDark()): ResolvedScheme {
	if (scheme === "system") return prefersDark ? "dark" : "light";
	return scheme;
}

/** 把外壳模式与已解析的明暗写到 <html>，并通知依赖 CSS 变量的组件（xterm、标题栏按钮）重取颜色。 */
export function applyShellAttrs(shell: ShellMode, scheme: Scheme): ResolvedScheme {
	const resolved = resolveScheme(scheme);
	if (typeof document === "undefined") return resolved;
	const root = document.documentElement;
	root.dataset.shell = shell;
	if (shell === "minimal") {
		root.dataset.scheme = resolved;
		root.setAttribute("data-theme-scheme", resolved);
		root.style.colorScheme = resolved;
		const meta = document.querySelector('meta[name="color-scheme"]');
		meta?.setAttribute("content", resolved);
	} else {
		delete root.dataset.scheme;
		root.removeAttribute("data-theme-scheme");
		root.style.colorScheme = "";
		document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", "dark");
	}
	window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT));
	return resolved;
}

/** React：外壳模式 + 配色偏好（持久化、跨组件同步、跟随系统变化）。 */
export function useShellPrefs() {
	const [shell, setShellState] = useState<ShellMode>(readShellMode);
	const [scheme, setSchemeState] = useState<Scheme>(readScheme);
	const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);

	useEffect(() => {
		let mq: MediaQueryList | null = null;
		try {
			mq = window.matchMedia("(prefers-color-scheme: dark)");
		} catch {
			return;
		}
		const onChange = (e: MediaQueryListEvent) => setPrefersDark(e.matches);
		mq.addEventListener("change", onChange);
		return () => mq?.removeEventListener("change", onChange);
	}, []);

	// 同一页面里多个组件共用：任一处修改后广播，其余实例同步
	useEffect(() => {
		const sync = () => {
			setShellState(readShellMode());
			setSchemeState(readScheme());
		};
		window.addEventListener(SHELL_PREFS_EVENT, sync);
		return () => window.removeEventListener(SHELL_PREFS_EVENT, sync);
	}, []);

	useEffect(() => {
		applyShellAttrs(shell, scheme);
	}, [shell, scheme, prefersDark]);

	const setShell = useCallback((next: ShellMode) => {
		safeSet(SHELL_KEY, next);
		setShellState(next);
		window.dispatchEvent(new CustomEvent(SHELL_PREFS_EVENT));
	}, []);

	const setScheme = useCallback((next: Scheme) => {
		safeSet(SCHEME_KEY, next);
		setSchemeState(next);
		window.dispatchEvent(new CustomEvent(SHELL_PREFS_EVENT));
	}, []);

	return {
		shell,
		setShell,
		scheme,
		setScheme,
		resolvedScheme: resolveScheme(scheme, prefersDark),
	};
}
