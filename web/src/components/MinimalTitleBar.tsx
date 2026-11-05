import { useMemo } from "react";
import { FiArrowLeft, FiChevronDown, FiCommand, FiFolder, FiMenu, FiSidebar, FiTerminal } from "react-icons/fi";
import { appSend, useAppField } from "../app-globals";
import { appUrl } from "../base-url";
import { useT } from "../i18n";
import type { UiSlotEntry } from "../ui-slots";
import type { ChatState } from "../use-chat";
import { BarItem, type ViewName } from "./BarItem";
import { ProjectPicker } from "./ProjectPicker";
import { WindowControls } from "./WindowControls";

export interface MinimalTitleBarProps {
	chat: ChatState;
	view: ViewName;
	isMobile: boolean;
	sidebarOpen: boolean;
	onToggleSidebar: () => void;
	filesOpen: boolean;
	onToggleFiles: () => void;
	terminalOpen: boolean;
	onToggleTerminal: () => void;
	onOpenPalette: () => void;
	onBackToChat: () => void;
	/** host:working 条目（运行中计时 / 队列 / tps），空闲时 BarItem 自己渲染为 null。 */
	workingEntry?: UiSlotEntry;
	plugins?: { id: string; name?: string }[];
	/** 项目选择器开关（受控：命令面板的「打开项目」也要能打开它）。 */
	projectPickerOpen: boolean;
	onProjectPickerOpenChange: (open: boolean) => void;
}

function basename(p: string): string {
	const parts = p.split(/[\\/]+/).filter(Boolean);
	return parts[parts.length - 1] ?? p;
}

/**
 * 极简外壳标题栏（redesign P2）：40px，整条是窗口拖拽区（按钮除外）。
 * 左：侧栏开关 + 项目名（点开项目选择器）；中：会话标题 / 当前视图；
 * 右：运行状态、文件抽屉、终端面板、命令面板、窗口按钮（Windows/Linux）。
 */
export function MinimalTitleBar({
	chat,
	view,
	isMobile,
	sidebarOpen,
	onToggleSidebar,
	filesOpen,
	onToggleFiles,
	terminalOpen,
	onToggleTerminal,
	onOpenPalette,
	onBackToChat,
	workingEntry,
	plugins,
	projectPickerOpen,
	onProjectPickerOpenChange,
}: MinimalTitleBarProps) {
	const t = useT();
	const cwd = useAppField("cwd");
	const workspaceRoots = useAppField("workspaceRoots");

	const convTitle = useMemo(() => {
		const id = chat.activeConversationId || chat.state?.conversationId;
		return chat.conversations.find((c) => c.id === id)?.title ?? "";
	}, [chat.activeConversationId, chat.conversations, chat.state?.conversationId]);

	const viewTitle = useMemo(() => {
		switch (view) {
			case "chat":
			case "terminal":
				return null;
			case "git":
				return t("scmTab");
			case "canvas":
				return t("canvasTab");
			case "devices":
				return t("deviceCenter");
			case "worktrees":
				return t("worktreeViewTitle");
			default: {
				const id = view.slice("plugin:".length);
				return plugins?.find((p) => p.id === id)?.name ?? id;
			}
		}
	}, [plugins, t, view]);

	const isMac = typeof document !== "undefined" && document.body.classList.contains("is-desktop-mac");

	return (
		<header className={`mtb${isMac ? " mtb-mac" : ""}`} data-testid="minimal-titlebar">
			<div className="mtb-left">
				<img
					className="mtb-logo"
					src={appUrl("/favicon.svg")}
					alt="pi-web-ui"
					width={20}
					height={20}
					draggable={false}
				/>
				<button
					type="button"
					className={`mtb-btn${sidebarOpen ? " on" : ""}`}
					onClick={onToggleSidebar}
					title={t("openHistory")}
					aria-label={t("openHistory")}
					aria-pressed={sidebarOpen}
					data-testid="mtb-sidebar"
				>
					{isMobile ? <FiMenu /> : <FiSidebar />}
				</button>
				<button
					type="button"
					className="mtb-project"
					onClick={() => onProjectPickerOpenChange(true)}
					title={cwd || t("openProject")}
					data-testid="mtb-project"
				>
					<span className="mtb-project-name">{cwd ? basename(cwd) : t("openProject")}</span>
					<FiChevronDown aria-hidden />
				</button>
			</div>

			<div className="mtb-center">
				{viewTitle ? (
					<button type="button" className="mtb-back" onClick={onBackToChat} data-testid="mtb-back">
						<FiArrowLeft aria-hidden />
						<span>{viewTitle}</span>
					</button>
				) : (
					<span className="mtb-title" title={convTitle}>
						{convTitle}
					</span>
				)}
			</div>

			<div className="mtb-right">
				{workingEntry && <BarItem entry={workingEntry} bar="top" chat={chat} view={view} />}
				<button
					type="button"
					className={`mtb-btn${filesOpen ? " on" : ""}`}
					onClick={onToggleFiles}
					title={t("openFiles")}
					aria-label={t("openFiles")}
					aria-pressed={filesOpen}
					data-testid="mtb-files"
				>
					<FiFolder />
				</button>
				<button
					type="button"
					className={`mtb-btn${terminalOpen ? " on" : ""}`}
					onClick={onToggleTerminal}
					title={`${t("terminal")} (Ctrl+\`)`}
					aria-label={t("terminal")}
					aria-pressed={terminalOpen}
					data-testid="mtb-terminal"
				>
					<FiTerminal />
				</button>
				<button
					type="button"
					className="mtb-btn"
					onClick={onOpenPalette}
					title={`${t("commandPalette")} (${isMac ? "⌘" : "Ctrl+"}K)`}
					aria-label={t("commandPalette")}
					data-testid="mtb-palette"
				>
					<FiCommand />
				</button>
				<WindowControls />
			</div>

			{projectPickerOpen && (
				<ProjectPicker
					open
					currentCwd={cwd}
					pathCompletions={chat.pathCompletions ?? []}
					workspaceRoots={workspaceRoots}
					onClose={() => onProjectPickerOpenChange(false)}
					onSelectDirectory={(path) => appSend({ type: "set_cwd", path })}
					onCreateProject={(path) => appSend({ type: "make_dir", path, setAsCwd: true })}
				/>
			)}
		</header>
	);
}
