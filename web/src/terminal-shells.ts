/// <reference lib="dom" />
/**
 * 服务端探测到的可用 shell（`list_terminal_shells` → `terminal_shells`）。
 *
 * 低频、整棵树都可能用（设置面板 + 终端面板「按 shell 新建」），所以放模块级单例，
 * 与 title-settings.ts / app-globals.ts 同构：listener 集合 + useSyncExternalStore。
 * 快照引用只在内容真正变化时替换，避免订阅者无谓重渲染。
 */
import { useEffect, useSyncExternalStore } from "react";
import { appSend } from "./app-globals";

export interface TerminalShellOption {
	path: string;
	label: string;
}

export interface TerminalSshHostOption {
	label: string;
	uri: string;
	source: "profile" | "ssh_config";
}

export interface TerminalShellsState {
	shells: TerminalShellOption[];
	/** 「自动」当前解析到的 shell 路径（PI_WEB_SHELL > 登录 shell > $SHELL > bash）。 */
	autoShell: string;
	/** 已保存 SSH 配置与 ~/.ssh/config 主机快捷列表。 */
	sshHosts: TerminalSshHostOption[];
	/** 是否已收到过服务端回复。 */
	loaded: boolean;
}

const EMPTY: TerminalShellsState = { shells: [], autoShell: "", sshHosts: [], loaded: false };
let state: TerminalShellsState = EMPTY;
const listeners = new Set<() => void>();

/** 路径末段（兼容 / 与 \），用于下拉里显示 `zsh — /usr/bin/zsh`。 */
export function shellBaseName(p: string): string {
	return p.split(/[\\/]/).pop() || p;
}

export function setTerminalShells(next: {
	shells?: TerminalShellOption[];
	autoShell?: string;
	sshHosts?: TerminalSshHostOption[];
}): void {
	const shells = Array.isArray(next.shells)
		? next.shells.filter((s) => s && typeof s.path === "string" && typeof s.label === "string")
		: [];
	const autoShell = typeof next.autoShell === "string" ? next.autoShell : "";
	const sshHosts = Array.isArray(next.sshHosts)
		? next.sshHosts.filter(
				(h) =>
					h &&
					typeof h.label === "string" &&
					typeof h.uri === "string" &&
					(h.source === "profile" || h.source === "ssh_config"),
			)
		: [];
	if (
		state.loaded &&
		state.autoShell === autoShell &&
		state.shells.length === shells.length &&
		state.shells.every((s, i) => s.path === shells[i].path && s.label === shells[i].label) &&
		state.sshHosts.length === sshHosts.length &&
		state.sshHosts.every(
			(h, i) => h.uri === sshHosts[i].uri && h.label === sshHosts[i].label && h.source === sshHosts[i].source,
		)
	)
		return;
	state = { shells, autoShell, sshHosts, loaded: true };
	for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
	listeners.add(l);
	return () => listeners.delete(l);
}

/** 订阅探测结果；`enabled` 为 true 时挂载就向服务端要一次最新列表。 */
export function useTerminalShells(enabled = true): TerminalShellsState {
	useEffect(() => {
		if (enabled) appSend({ type: "list_terminal_shells" });
	}, [enabled]);
	return useSyncExternalStore(
		subscribe,
		() => state,
		() => EMPTY,
	);
}
