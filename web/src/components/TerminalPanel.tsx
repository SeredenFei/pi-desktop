import { useEffect, useRef, useState, type ReactNode } from "react";
import { randomUuid } from "../uuid";
import { FiEdit2, FiMenu, FiPlay, FiPlus, FiRefreshCw, FiTerminal, FiTrash2, FiX } from "react-icons/fi";
import type { ChatState, TerminalMeta } from "../use-chat";
import type { CommandDef } from "../types";
import { TermXterm } from "./TermXterm";
import { useT } from "../i18n";
import { shellBaseName, useTerminalShells } from "../terminal-shells";
import { appSend } from "../app-globals";
import type { TerminalOwnerKind } from "../terminal-bridge";

const tabKey = (t: TerminalMeta) =>
	JSON.stringify([t.ownerKind ?? "client", t.ownerKind === "conversation" ? t.conversationId : "", t.id]);
import type { UiSlotEntry } from "../ui-slots";
// 工具条通用渲染已抽到 ../slot-toolbar（本模块静态 import 会把 xterm 拉进主包）；
// 这里 re-export 保持旧 import 路径兼容。
import { renderMergedToolbar, renderSlotToolbar } from "../slot-toolbar";
// 旧 import 路径兼容：之前各渲染层从本模块 import，本模块瘦身后继续 re-export。
export { renderSlotToolbar };

interface TerminalPanelProps {
	chat: ChatState;
	terminal: {
		create: (meta: TerminalMeta) => void;
		close: (id: string, ownerKind?: TerminalOwnerKind, conversationId?: string) => void;
		register: (
			conversationId: string,
			id: string,
			writer: { write(data: string): void; dispose(): void },
			ownerKind?: TerminalOwnerKind,
		) => () => void;
		restart: (id: string) => void;
		select: (id: string) => void;
	};
	/** `terminal.toolbar` 槽位的最终条目（全量，含 hidden；宿主 chrome + 插件按槽位顺序合并渲染）。
	 *  不传 = 未接线，回落默认顺序（与旧硬编码一致）。 */
	uiTerminalToolbar?: UiSlotEntry[];
	/** 点击一条工具条目：交回 App 分发给贡献它的插件（与顶栏 onUiAction 同通道）。 */
	onUiAction?: (item: UiSlotEntry) => void;
}

interface Draft {
	name: string;
	command: string;
	cwd: string;
}

const EMPTY_DRAFT: Draft = { name: "", command: "", cwd: "${pwd}" };

/**
 * Built-in terminal — two panes:
 *   left : user command list (.pi/commands.json) on top + terminal tabs below
 *          (on mobile this whole column slides in as a drawer)
 *   right: the active terminal (one xterm per tab, kept mounted)
 */
export function TerminalPanel({ chat, terminal, uiTerminalToolbar, onUiAction }: TerminalPanelProps) {
	const t = useT();
	const [activeId, setActiveId] = useState<string | null>(null);
	// Mobile: the left column (commands + tabs) slides in as a drawer.
	const [sideOpen, setSideOpen] = useState(false);
	// Command list editing state.
	const [isNew, setIsNew] = useState(false);
	const [editingIdx, setEditingIdx] = useState<number | null>(null);
	const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
	// Two-step delete confirmation.
	const [confirmDel, setConfirmDel] = useState<number | null>(null);
	const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	// 终端接管 bash 的「AI bash」折叠分组开关（默认展开）。
	const [aiBashOpen, setAiBashOpen] = useState(true);
	const [renamingTab, setRenamingTab] = useState<string | null>(null);
	const [renameDraft, setRenameDraft] = useState("");

	// Follow the authoritative list after reconnect, close and conversation switches.
	useEffect(() => {
		if (chat.terminals.length === 0) setActiveId(null);
		else if (!chat.terminals.some((t) => tabKey(t) === activeId)) {
			setActiveId(tabKey(chat.terminals[chat.terminals.length - 1]));
		}
	}, [chat.terminals, activeId]);

	// The SCM / settings panel asked to focus a specific terminal tab (git write
	// ops, uninstall runs) — follow the request so the user sees the command run.
	useEffect(() => {
		if (chat.terminalActiveId) {
			const tab = chat.terminals.find((t) => t.id === chat.terminalActiveId && (t.ownerKind ?? "client") === "client");
			if (tab) setActiveId(tabKey(tab));
			setSideOpen(false);
		}
	}, [chat.terminalActiveId]);

	useEffect(() => {
		return () => {
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		};
	}, []);

	// -- tab management --------------------------------------------------------

	// 终端接管 bash 的 ai-bash 终端单独归到「AI bash」折叠分组，与用户终端分开。
	const userTabs = chat.terminals.filter((t) => !t.agentBash);
	const agentTabs = chat.terminals.filter((t) => t.agentBash);

	const openTab = (
		meta: Omit<TerminalMeta, "running" | "exitCode" | "id" | "conversationId" | "cols" | "rows"> &
			Partial<Pick<TerminalMeta, "cols" | "rows">>,
	) => {
		if (!chat.ready) return; // topbar already shows the connection state
		const id = randomUuid();
		const conversationId = chat.activeConversationId || chat.state?.conversationId || "";
		terminal.create({
			...meta,
			id,
			conversationId,
			cols: meta.cols ?? 80,
			rows: meta.rows ?? 24,
			running: true,
			exitCode: null,
		});
		setActiveId(JSON.stringify(["client", "", id]));
		setSideOpen(false);
	};

	const openShell = (shell?: string) =>
		openTab({
			title: t("terminalTitle", { n: userTabs.length + 1 }),
			cwd: chat.state?.cwd ?? "",
			shell,
		});
	// 探测到的 shell 列表（服务端异步读 /etc/shells 等；挂载时请求一次）。
	const shellState = useTerminalShells();

	const runCommand = (cmd: CommandDef) => {
		const title = cmd.name || cmd.command;
		// Reuse a terminal with the same title (VSCode-style task reuse): the
		// command is re-run in the SAME tab — a running process is interrupted
		// first (the server kills the PTY's process group and starts fresh).
		const existing = chat.terminals.find((t) => t.title === title && (t.ownerKind ?? "client") === "client");
		if (existing) {
			terminal.restart(existing.id);
			setActiveId(tabKey(existing));
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
			return;
		}
		openTab({ title, cwd: chat.state?.cwd ?? "", command: cmd });
	};

	const closeTab = (key: string) => {
		const tab = chat.terminals.find((item) => tabKey(item) === key);
		if (!tab) return;
		appSend({
			type: "terminal_kill",
			terminalId: tab.id,
			conversationId: tab.conversationId,
			ownerKind: tab.ownerKind ?? "client",
		});
		terminal.close(tab.id, tab.ownerKind ?? "client", tab.conversationId);
		if (activeId === key) setActiveId(null);
	};

	// 单个终端标签（用户终端 + ai-bash 分组共用）。
	const renderTab = (tab: TerminalMeta) => (
		<div key={tabKey(tab)} className={`term-tab ${tabKey(tab) === activeId ? "active" : ""}`}>
			<button
				type="button"
				className="term-tab-main"
				title={`${tab.cwd}${tab.command ? `\n> ${tab.command.command}` : ""}`}
				onClick={() => {
					if (renamingTab) return;
					setActiveId(tabKey(tab));
					setSideOpen(false);
				}}
			>
				<span className={`term-tab-dot ${tab.running ? "run" : "exit"}`} />
				<span className="term-tab-title">
					{renamingTab === tabKey(tab) ? (
						<input
							autoFocus
							className="term-tab-rename-input"
							value={renameDraft}
							placeholder={tab.title}
							onClick={(e) => e.stopPropagation()}
							onChange={(e) => setRenameDraft(e.target.value)}
							onKeyDown={(e) => {
								e.stopPropagation();
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									const title = renameDraft.trim();
									if (title)
										appSend({
											type: "rename_terminal",
											terminalId: tab.id,
											conversationId: tab.conversationId,
											ownerKind: tab.ownerKind ?? "client",
											title,
										});
									setRenamingTab(null);
								} else if (e.key === "Escape") {
									setRenamingTab(null);
								}
							}}
							onBlur={() => setRenamingTab(null)}
						/>
					) : (
						tab.title
					)}
					{!tab.running && (
						<span className="term-tab-exit">
							{t("exited", {
								code: tab.exitCode === null ? "" : ` ${tab.exitCode}`,
							})}
						</span>
					)}
				</span>
			</button>
			<button
				type="button"
				className="term-tab-close term-tab-rename"
				title={t("renameTerminal")}
				onClick={(e) => {
					e.stopPropagation();
					setRenameDraft(tab.title);
					setRenamingTab(tabKey(tab));
				}}
			>
				<FiEdit2 />
			</button>
			<button type="button" className="term-tab-close" title={t("closeTerminal")} onClick={() => closeTab(tabKey(tab))}>
				<FiX />
			</button>
		</div>
	);

	// -- command list editing --------------------------------------------------

	const startNew = () => {
		setIsNew(true);
		setEditingIdx(null);
		setDraft(EMPTY_DRAFT);
	};

	const startEdit = (idx: number) => {
		const c = chat.commands[idx];
		if (!c) return;
		setIsNew(false);
		setEditingIdx(idx);
		setDraft({ name: c.name, command: c.command, cwd: c.cwd ?? "" });
	};

	const cancelEdit = () => {
		setIsNew(false);
		setEditingIdx(null);
	};

	const saveDraft = () => {
		const name = draft.name.trim();
		const command = draft.command.trim();
		if (!name || !command) return;
		const cwd = draft.cwd.trim();
		const def: CommandDef = { name, command, cwd: cwd ? cwd : undefined };
		const next = isNew
			? [...chat.commands, def]
			: editingIdx !== null
				? chat.commands.map((c, i) => (i === editingIdx ? def : c))
				: chat.commands;
		appSend({ type: "save_commands", commands: next });
		cancelEdit();
	};

	const requestDelete = (idx: number) => {
		if (confirmDel === idx) {
			const next = chat.commands.filter((_, i) => i !== idx);
			appSend({ type: "save_commands", commands: next });
			setConfirmDel(null);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
		} else {
			setConfirmDel(idx);
			if (confirmTimer.current) clearTimeout(confirmTimer.current);
			confirmTimer.current = setTimeout(() => setConfirmDel(null), 2500);
		}
	};

	const editing = isNew || editingIdx !== null;

	/** 命令列表头与终端 tab 头按槽位分别排序（插件 historically 落 tab 头；命令行/标签行是数据，不动）。 */
	const TERM_DEFAULT_ORDER = ["host:term-cmd-refresh", "host:term-cmd-new", "host:term-tab-new"];
	const allTermEntries: UiSlotEntry[] =
		uiTerminalToolbar === undefined
			? TERM_DEFAULT_ORDER.map((id) => ({ id, source: "host" }) as UiSlotEntry)
			: uiTerminalToolbar.filter((e) => !e.hidden);
	const termZone = (ids: string[], withPlugins: boolean): UiSlotEntry[] => {
		const set = new Set(ids);
		return allTermEntries.filter((e) => set.has(e.id) || (withPlugins && e.source !== "host"));
	};
	/** 布局页改名 / 插件 arrange 指定过文案（`labelExplicit`）→ 用那一条，否则内置 i18n 文案。
	 *  这三个条目是纯图标按钮，名字落在 `title` 上。 */
	const termLabel = (id: string, fallback: string): string => {
		const e = allTermEntries.find((x) => x.id === id);
		return e?.labelExplicit ? e.label : fallback;
	};
	const termHostNodes: Record<string, ReactNode> = {
		"host:term-cmd-refresh": (
			<button
				type="button"
				className="panel-refresh"
				title={termLabel("host:term-cmd-refresh", t("rerun"))}
				onClick={() => appSend({ type: "list_commands" })}
			>
				<FiRefreshCw />
			</button>
		),
		"host:term-cmd-new": (
			<button
				type="button"
				className="panel-new"
				title={termLabel("host:term-cmd-new", t("newCommand"))}
				onClick={startNew}
			>
				<FiPlus />
			</button>
		),
		// 一键新建仍用默认 shell；旁边的小下拉按 shell 新建（列表来自服务端探测，服务端再校验白名单）。
		"host:term-tab-new": (
			<>
				<button
					type="button"
					className="panel-new"
					title={termLabel("host:term-tab-new", t("newTerminal"))}
					onClick={() => openShell()}
				>
					<FiPlus />
				</button>
				{(shellState.shells.length > 0 || shellState.sshHosts.length > 0) && (
					<select
						className="panel-new panel-new-shell"
						aria-label={t("newTerminalWithShell")}
						title={t("newTerminalWithShell")}
						value=""
						onChange={(e) => {
							const val = e.target.value;
							if (!val) return;
							if (val.startsWith("ssh-host:")) {
								const idx = Number(val.slice("ssh-host:".length));
								const host = shellState.sshHosts[idx];
								if (host) {
									openTab({ title: host.label, cwd: host.uri });
								}
							} else {
								openShell(val);
							}
						}}
					>
						<option value="">▾</option>
						{shellState.shells.length > 0 && (
							<optgroup label={t("terminalLocalShellsGroup")}>
								{shellState.shells.map((sh) => (
									<option key={sh.path} value={sh.path}>
										{sh.label === shellBaseName(sh.path) ? sh.label : `${sh.label} (${shellBaseName(sh.path)})`}
										{sh.path === shellState.autoShell ? ` · ${t("terminalShellDefaultTag")}` : ""}
									</option>
								))}
							</optgroup>
						)}
						{shellState.sshHosts.length > 0 && (
							<optgroup label={t("terminalRemoteSshGroup")}>
								{shellState.sshHosts.map((host, idx) => (
									<option key={`${host.source}-${host.uri}-${idx}`} value={`ssh-host:${idx}`}>
										🌐 {host.label}
									</option>
								))}
							</optgroup>
						)}
					</select>
				)}
			</>
		),
	};

	return (
		<div className="terminal-view">
			{/* ---------------- left: command list + terminal tabs ---------------- */}
			<aside className={`term-side term-commands ${sideOpen ? "open" : ""}`}>
				<div className="panel-header">
					<span className="panel-title">{t("commands")}</span>
					<div className="panel-header-actions">
						{renderMergedToolbar(
							termZone(["host:term-cmd-refresh", "host:term-cmd-new"], false),
							termHostNodes,
							onUiAction,
						)}
					</div>
				</div>

				<div className="panel-body">
					{editing ? (
						<div className="cmd-form">
							<label htmlFor="cmd-name">{t("name")}</label>
							<input
								id="cmd-name"
								className="cmd-input"
								value={draft.name}
								placeholder={t("exampleName")}
								autoFocus
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
							<label htmlFor="cmd-command">{t("command")}</label>
							<input
								id="cmd-command"
								className="cmd-input"
								value={draft.command}
								placeholder={t("exampleCommand")}
								onChange={(e) => setDraft({ ...draft, command: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										saveDraft();
									}
								}}
							/>
							<label htmlFor="cmd-cwd">
								{t("directory")} <span className="cmd-hint">{t("cwdHint")}</span>
							</label>
							<input
								id="cmd-cwd"
								className="cmd-input"
								value={draft.cwd}
								placeholder="${pwd}"
								onChange={(e) => setDraft({ ...draft, cwd: e.target.value })}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing) {
										saveDraft();
									}
								}}
							/>
							<div className="cmd-form-actions">
								<button type="button" className="btn" onClick={cancelEdit}>
									{t("cancel")}
								</button>
								<button
									type="button"
									className="btn primary"
									disabled={!draft.name.trim() || !draft.command.trim()}
									onClick={saveDraft}
								>
									{t("save")}
								</button>
							</div>
						</div>
					) : (
						<>
							{chat.commands.length === 0 && <div className="panel-empty">{t("noCommands")}</div>}
							{chat.commands.map((c, i) => (
								<div key={i} className="cmd-item">
									<button type="button" className="cmd-run" title={t("clickToRun")} onClick={() => runCommand(c)}>
										<FiPlay />
									</button>
									<button type="button" className="cmd-main" title={t("clickToRun")} onClick={() => runCommand(c)}>
										<span className="cmd-name">{c.name}</span>
										<span className="cmd-command">{c.command}</span>
										{c.cwd && <span className="cmd-cwd">{c.cwd}</span>}
									</button>
									<button type="button" className="cmd-act" title={t("edit")} onClick={() => startEdit(i)}>
										<FiEdit2 />
									</button>
									<button
										type="button"
										className={`cmd-act del ${confirmDel === i ? "confirm" : ""}`}
										title={t("delete")}
										onClick={() => requestDelete(i)}
									>
										{confirmDel === i ? t("confirmQ") : <FiTrash2 />}
									</button>
								</div>
							))}
						</>
					)}
				</div>

				{/* ---------------- tabs (below the command list) ---------------- */}
				<div className="term-tabs-block">
					<div className="panel-header">
						<span className="panel-title">{t("terminal")}</span>
						{renderMergedToolbar(termZone(["host:term-tab-new"], true), termHostNodes, onUiAction)}
					</div>
					<div className="panel-body">
						{chat.terminals.length === 0 && <div className="panel-empty">{t("noTerminal")}</div>}
						{userTabs.map(renderTab)}
						{agentTabs.length > 0 && (
							<div className="term-folder">
								<button
									type="button"
									className={`term-folder-header ${aiBashOpen ? "open" : ""}`}
									title={t("aiBashGroup")}
									onClick={() => setAiBashOpen((v) => !v)}
								>
									<span className="term-folder-caret">{aiBashOpen ? "▾" : "▸"}</span>
									<span className="term-folder-title">{t("aiBashGroup")}</span>
									<span className="term-folder-count">{agentTabs.length}</span>
								</button>
								{aiBashOpen && <div className="term-folder-body">{agentTabs.map(renderTab)}</div>}
							</div>
						)}
					</div>
				</div>
			</aside>

			{/* ---------------- right: terminals ---------------- */}
			<div className="term-main">
				{sideOpen && <div className="drawer-backdrop" onClick={() => setSideOpen(false)} />}
				<button type="button" className="term-side-toggle" title={t("commands")} onClick={() => setSideOpen((v) => !v)}>
					<FiMenu />
				</button>
				{chat.terminals.length === 0 ? (
					<div className="term-empty">
						<FiTerminal className="term-empty-icon" />
						<div className="term-empty-title">{t("builtinTerminal")}</div>
						<div className="term-empty-sub">{t("termEmptySub")}</div>
					</div>
				) : (
					chat.terminals.map((t) => (
						<TermXterm
							key={tabKey(t)}
							ownerKind={t.ownerKind ?? "client"}
							conversationId={t.conversationId}
							terminalId={t.id}
							command={t.command}
							cwd={t.cwd}
							title={t.title}
							agentBash={t.agentBash}
							active={tabKey(t) === activeId}
							running={t.running}
							exitCode={t.exitCode}
							register={terminal.register}
						/>
					))
				)}
			</div>
		</div>
	);
}
