import { useCallback, useEffect, useRef, useState } from "react";
import {
	FiArrowUp,
	FiBriefcase,
	FiCheck,
	FiCloud,
	FiCopy,
	FiFolder,
	FiFolderPlus,
	FiLock,
	FiMessageCircle,
	FiPlus,
	FiRefreshCw,
	FiTrash2,
	FiUnlock,
} from "react-icons/fi";
import { withToken } from "../auth-token";
import { appUrl } from "../base-url";
import { isZhLocale, useI18n } from "../i18n";
import { useCopyFeedback } from "../use-copy-feedback";
import { Modal } from "./Modal";

export interface MemoryItem {
	id: string;
	content: string;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
}

export interface ChatProjectEntry {
	slug: string;
	name: string;
	path: string;
	instructions: string;
	itemCount: number;
	updatedAt: number;
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
	chatProjectsRoot?: string;
	workProjectsRoot?: string;
	isChatSpace: boolean;
	projectKey: string;
	projectName: string;
	projectInstructions: string;
	globalItems: MemoryItem[];
	projectItems: MemoryItem[];
	chatProjects: ChatProjectEntry[];
	projectNames?: Record<string, string>;
	syncedTranscripts?: SyncedTranscriptSummary[];
}

export interface MemorySyncStatus {
	loggedIn: boolean;
	username?: string;
	avatarUrl?: string;
	repo: string;
	lastSyncedAt?: number;
	syncing: boolean;
	lastError?: string | null;
	deviceFlow?: {
		userCode: string;
		verificationUri: string;
		expiresAt: number;
	} | null;
}

export interface MemoryApiState {
	view: MemorySnapshotView | null;
	isolated: boolean;
	sync: MemorySyncStatus | null;
}

async function apiGetMemory(cwd: string, sessionId: string): Promise<MemoryApiState | null> {
	try {
		const q = new URLSearchParams();
		if (cwd) q.set("cwd", cwd);
		if (sessionId) q.set("sessionId", sessionId);
		const res = await fetch(withToken(appUrl(`/api/memory?${q.toString()}`)));
		if (!res.ok) return null;
		const data = (await res.json()) as {
			view?: MemorySnapshotView;
			isolated?: boolean;
			sync?: MemorySyncStatus;
		};
		return {
			view: data.view ?? null,
			isolated: Boolean(data.isolated),
			sync: data.sync ?? null,
		};
	} catch {
		return null;
	}
}

async function apiPostMemory(
	path: string,
	body: Record<string, unknown>,
): Promise<MemoryApiState & { created?: { path: string }; error?: string }> {
	const res = await fetch(withToken(appUrl(path)), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	const data = (await res.json().catch(() => ({}))) as {
		view?: MemorySnapshotView;
		isolated?: boolean;
		sync?: MemorySyncStatus;
		created?: { path: string };
		error?: string;
	};
	if (!res.ok) {
		throw new Error(data.error || `HTTP ${res.status}`);
	}
	return {
		view: data.view ?? null,
		isolated: Boolean(data.isolated),
		sync: data.sync ?? null,
		created: data.created,
	};
}

export function useMemoryState(cwd: string, sessionId: string, open: boolean) {
	const [state, setState] = useState<MemoryApiState>({
		view: null,
		isolated: false,
		sync: null,
	});

	const refresh = useCallback(async () => {
		const res = await apiGetMemory(cwd, sessionId);
		if (res) setState(res);
	}, [cwd, sessionId]);

	useEffect(() => {
		void refresh();
	}, [refresh, open]);

	useEffect(() => {
		const onRefresh = () => void refresh();
		window.addEventListener("pi-web-ui:memory-refresh", onRefresh);
		return () => window.removeEventListener("pi-web-ui:memory-refresh", onRefresh);
	}, [refresh]);

	// 设备码登录等待期间每 2.5s 自动轮询一次状态
	useEffect(() => {
		if (!open && !state.sync?.deviceFlow) return;
		if (!state.sync?.deviceFlow && !state.sync?.syncing) return;
		const timer = setInterval(() => void refresh(), 2500);
		return () => clearInterval(timer);
	}, [open, state.sync?.deviceFlow, state.sync?.syncing, refresh]);

	const toggleIsolated = useCallback(async () => {
		if (!sessionId) return;
		try {
			const next = await apiPostMemory("/api/memory/isolate", {
				cwd,
				sessionId,
				isolated: !state.isolated,
			});
			setState(next);
		} catch {
			/* ignore */
		}
	}, [cwd, sessionId, state.isolated]);

	const createChatProject = useCallback(
		async (name: string) => {
			const res = await apiPostMemory("/api/memory/chat-project", { name, sessionId });
			setState(res);
			return res.created?.path ?? null;
		},
		[sessionId],
	);

	const deleteChatProject = useCallback(
		async (path: string) => {
			try {
				const res = await apiPostMemory("/api/memory/chat-project", {
					op: "delete",
					path,
					cwd,
					sessionId,
				});
				setState(res);
			} catch {
				/* ignore */
			}
		},
		[cwd, sessionId],
	);

	const renameProject = useCallback(
		async (path: string, name: string) => {
			const trimmed = name.trim();
			if (!path || !trimmed) return;
			try {
				const res = await apiPostMemory("/api/memory/chat-project", {
					op: "rename",
					path,
					name: trimmed,
					cwd,
					sessionId,
				});
				setState(res);
			} catch {
				/* ignore */
			}
		},
		[cwd, sessionId],
	);

	return {
		memory: state,
		setMemory: setState,
		refreshMemory: refresh,
		toggleIsolated,
		createChatProject,
		deleteChatProject,
		renameProject,
	};
}

/**
 * 极简侧栏顶部固定区（Codex 风格 Chat / Work 双模式分栏）：
 * 1. 顶层「💬 Chat | 🛠 Work」分段切换（记忆入口在侧栏左下角账户卡片，见 SidebarFooter）；
 * 2. 在 Chat 模式下：提供「💬 独立对话」行与「+ 新建 Chat 项目」行内快速创建。
 */
export function ChatSpaceHeader({
	mode,
	onModeChange,
	isChatSpace,
	onEnterChatSpace,
	onNewStandaloneChat,
	onCreateChatProject,
}: {
	mode: "chat" | "work";
	onModeChange: (mode: "chat" | "work") => void;
	isChatSpace: boolean;
	onEnterChatSpace: () => void;
	onNewStandaloneChat: () => void;
	onCreateChatProject: (name: string) => void;
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [creatingProj, setCreatingProj] = useState(false);
	const [projName, setProjName] = useState("");
	const newProjRowRef = useRef<HTMLDivElement>(null);
	const newProjBtnRef = useRef<HTMLButtonElement>(null);

	useEffect(() => {
		const onOpenNew = () => {
			onModeChange("chat");
			setCreatingProj(true);
		};
		window.addEventListener("pi-web-ui:open-new-chat-project", onOpenNew);
		return () => window.removeEventListener("pi-web-ui:open-new-chat-project", onOpenNew);
	}, [onModeChange]);

	// 点击输入框与触发按钮以外的任意位置时，自动收回新建项目输入框
	useEffect(() => {
		if (!creatingProj) return;
		const onPointerDown = (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) return;
			if (newProjRowRef.current?.contains(target)) return;
			if (newProjBtnRef.current?.contains(target)) return;
			if (target.closest(".lp-project-action")) return;
			setCreatingProj(false);
			setProjName("");
		};
		document.addEventListener("mousedown", onPointerDown, true);
		return () => document.removeEventListener("mousedown", onPointerDown, true);
	}, [creatingProj]);

	const submitNewProj = () => {
		const trimmed = projName.trim();
		if (!trimmed) return;
		setProjName("");
		setCreatingProj(false);
		onCreateChatProject(trimmed);
	};

	return (
		<div className="cs-header" data-testid="chat-space-header">
			<div className="cs-mode-bar">
				<div className="cs-mode-seg" role="tablist" aria-label="Workspace mode">
					<button
						type="button"
						role="tab"
						aria-selected={mode === "chat"}
						className={`cs-mode-btn${mode === "chat" ? " active" : ""}`}
						onClick={() => onModeChange("chat")}
						data-testid="mode-tab-chat"
					>
						<FiMessageCircle />
						<span>Chat</span>
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={mode === "work"}
						className={`cs-mode-btn${mode === "work" ? " active" : ""}`}
						onClick={() => onModeChange("work")}
						data-testid="mode-tab-work"
					>
						<FiBriefcase />
						<span>Work</span>
					</button>
				</div>
			</div>

			{mode === "chat" && (
				<div className="cs-chat-sub">
					<div className={`cs-space-row${isChatSpace ? " active" : ""}`}>
						<button
							type="button"
							className="cs-space-main"
							onClick={onEnterChatSpace}
							title={zh ? "独立对话（不绑定项目，自动同步记忆与对话）" : "Standalone Chats"}
							data-testid="enter-chat-space"
						>
							<FiMessageCircle className="cs-icon" />
							<span className="cs-label">{zh ? "独立对话" : "Standalone Chats"}</span>
						</button>
						<button
							type="button"
							className="cs-space-add"
							onClick={onNewStandaloneChat}
							title={zh ? "新建独立对话" : "New standalone chat"}
							data-testid="new-standalone-chat"
						>
							<FiPlus />
						</button>
						<button
							ref={newProjBtnRef}
							type="button"
							className="cs-space-add"
							onClick={() => setCreatingProj((v) => !v)}
							title={zh ? "新建 Chat 项目" : "New Chat Project"}
							data-testid="new-chat-project-btn"
						>
							<FiFolderPlus />
						</button>
					</div>
					{creatingProj && (
						<div className="cs-new-proj-row" ref={newProjRowRef}>
							<input
								type="text"
								className="cs-new-proj-input"
								autoFocus
								value={projName}
								placeholder={zh ? "输入 Chat 项目名称，回车创建…" : "Chat project name, Enter to create…"}
								onChange={(e) => setProjName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") submitNewProj();
									else if (e.key === "Escape") {
										setCreatingProj(false);
										setProjName("");
									}
								}}
								data-testid="new-chat-project-input"
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}

export function MemoryModal({
	open,
	cwd,
	sessionId,
	memory,
	setMemory,
	onClose,
	onSwitchCwd,
	onOpenTranscript,
	initialTab = "global",
}: {
	open: boolean;
	cwd: string;
	sessionId: string;
	memory: MemoryApiState;
	setMemory: (next: MemoryApiState) => void;
	onClose: () => void;
	onSwitchCwd: (targetCwd: string) => void;
	onOpenTranscript?: (cwd: string, filePath: string, sessionId: string) => void;
	/** 打开时默认停留的标签（未登录时从左下角账户卡片进入直接落在「跨端登录同步」）。 */
	initialTab?: "global" | "project" | "sync";
}) {
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [tab, setTab] = useState<"global" | "project" | "sync">(initialTab);
	const [newGlobalText, setNewGlobalText] = useState("");
	const [newProjectText, setNewProjectText] = useState("");
	const [instructionsDraft, setInstructionsDraft] = useState("");
	const [instructionsDirty, setInstructionsDirty] = useState(false);
	const [newChatProjName, setNewChatProjName] = useState("");
	const [tokenInput, setTokenInput] = useState("");
	const [repoInput, setRepoInput] = useState("pi-memory-sync");
	const [busy, setBusy] = useState(false);
	const [errMsg, setErrMsg] = useState<string | null>(null);
	const { copied: copiedCode, copy: copyDeviceCode } = useCopyFeedback({ duration: 1800 });

	const view = memory.view;
	const sync = memory.sync;

	useEffect(() => {
		if (view && !instructionsDirty) {
			setInstructionsDraft(view.projectInstructions ?? "");
		}
	}, [view, instructionsDirty]);

	useEffect(() => {
		if (sync?.repo) setRepoInput(sync.repo);
	}, [sync?.repo]);

	if (!open) return null;

	const runOp = async (fn: () => Promise<MemoryApiState>) => {
		setBusy(true);
		setErrMsg(null);
		try {
			const next = await fn();
			setMemory(next);
		} catch (e) {
			setErrMsg((e as Error).message || String(e));
		} finally {
			setBusy(false);
		}
	};

	const globalItems = view?.globalItems ?? [];
	const projectItems = view?.projectItems ?? [];
	const syncedTranscripts = view?.syncedTranscripts ?? [];
	const chatProjects = view?.chatProjects ?? [];
	const isChatSpace = view?.isChatSpace ?? false;

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={zh ? "记忆与跨端同步" : "Memory & Cloud Sync"}
			className="memory-modal"
			ariaLabel={zh ? "记忆与跨端同步" : "Memory & Cloud Sync"}
		>
			<div className="modal-body mem-modal-body" data-testid="memory-modal">
				{/* 顶部：单会话「共享记忆 vs 独立记忆」一键切换 */}
				<div className="mem-iso-bar">
					<div className="mem-iso-info">
						<div className="mem-iso-title">
							{memory.isolated ? (
								<>
									<FiLock /> {zh ? "当前对话：独立记忆（无痕隔离）" : "Current chat: Isolated memory"}
								</>
							) : (
								<>
									<FiUnlock /> {zh ? "当前对话：共享记忆已开启" : "Current chat: Shared memory active"}
								</>
							)}
						</div>
						<div className="mem-iso-desc">
							{memory.isolated
								? zh
									? "本对话不会读取任何全局或项目记忆，AI 也不会向记忆库写入内容。"
									: "This chat neither reads from nor writes to shared global/project memory."
								: zh
									? "自动挂载全局记忆与当前项目记忆；AI 可在对话中自动为你记住偏好与项目约定。"
									: "Global and project memories are injected automatically; AI can remember new facts."}
						</div>
					</div>
					<button
						type="button"
						className={`btn ${memory.isolated ? "primary" : "secondary"}`}
						disabled={!sessionId || busy}
						onClick={() =>
							void runOp(() =>
								apiPostMemory("/api/memory/isolate", {
									cwd,
									sessionId,
									isolated: !memory.isolated,
								}),
							)
						}
						data-testid="toggle-memory-isolated"
					>
						{memory.isolated
							? zh
								? "切回共享记忆"
								: "Enable Shared Memory"
							: zh
								? "设为独立记忆"
								: "Isolate This Chat"}
					</button>
				</div>

				{/* 三个标签页 */}
				<div className="mem-tabs" role="tablist">
					<button
						type="button"
						role="tab"
						aria-selected={tab === "global"}
						className={`mem-tab${tab === "global" ? " active" : ""}`}
						onClick={() => setTab("global")}
					>
						{zh ? `全局记忆 (${globalItems.length})` : `Global (${globalItems.length})`}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "project"}
						className={`mem-tab${tab === "project" ? " active" : ""}`}
						onClick={() => setTab("project")}
					>
						{zh ? `项目记忆 (${projectItems.length})` : `Project (${projectItems.length})`}
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={tab === "sync"}
						className={`mem-tab mem-tab-sync${tab === "sync" ? " active" : ""}`}
						onClick={() => setTab("sync")}
						data-testid="mem-tab-sync"
					>
						<FiCloud style={{ marginRight: 4 }} />
						{sync?.loggedIn
							? zh
								? `已同步 (${sync.username})`
								: `Synced (${sync.username})`
							: zh
								? "跨端登录同步"
								: "Cloud Sync"}
					</button>
				</div>

				{errMsg && <div className="mem-err">{errMsg}</div>}

				{tab === "global" && (
					<div className="mem-pane">
						<div className="mem-add-row">
							<input
								type="text"
								className="mem-input"
								value={newGlobalText}
								placeholder={
									zh
										? "添加一条所有对话共享的记忆（如：偏好用 TypeScript、回答尽量简洁）…"
										: "Add a global memory shared across all chats…"
								}
								onChange={(e) => setNewGlobalText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter" && newGlobalText.trim()) {
										const text = newGlobalText.trim();
										setNewGlobalText("");
										void runOp(() =>
											apiPostMemory("/api/memory/item", { op: "add", scope: "global", content: text, cwd, sessionId }),
										);
									}
								}}
								data-testid="mem-global-input"
							/>
							<button
								type="button"
								className="btn primary"
								disabled={!newGlobalText.trim() || busy}
								onClick={() => {
									const text = newGlobalText.trim();
									setNewGlobalText("");
									void runOp(() =>
										apiPostMemory("/api/memory/item", { op: "add", scope: "global", content: text, cwd, sessionId }),
									);
								}}
								data-testid="mem-global-add"
							>
								<FiPlus /> {zh ? "添加" : "Add"}
							</button>
						</div>

						{globalItems.length === 0 ? (
							<div className="mem-empty">
								{zh
									? "暂无全局记忆。你可以在上方手动添加，或在聊天时直接对 AI 说“记住我喜欢……”"
									: "No global memories yet. Add one above or tell the AI in chat: 'Remember that I prefer…'"}
							</div>
						) : (
							<div className="mem-list">
								{globalItems.map((item) => (
									<div key={item.id} className={`mem-row${item.enabled ? "" : " disabled"}`}>
										<input
											type="checkbox"
											checked={item.enabled}
											onChange={(e) =>
												void runOp(() =>
													apiPostMemory("/api/memory/item", {
														op: "update",
														scope: "global",
														id: item.id,
														enabled: e.target.checked,
														cwd,
														sessionId,
													}),
												)
											}
										/>
										<span className="mem-text">{item.content}</span>
										<button
											type="button"
											className="mem-icon-btn danger"
											title={zh ? "删除" : "Delete"}
											onClick={() =>
												void runOp(() =>
													apiPostMemory("/api/memory/item", {
														op: "delete",
														scope: "global",
														id: item.id,
														cwd,
														sessionId,
													}),
												)
											}
										>
											<FiTrash2 />
										</button>
									</div>
								))}
							</div>
						)}
					</div>
				)}

				{tab === "project" && (
					<div className="mem-pane">
						{isChatSpace ? (
							<div className="mem-empty">
								{zh
									? "当前处于「独立对话」空间（仅使用全局记忆）。双击左侧任意项目或上方新建一个话题项目后，即可配置该项目专属的指令与记忆。"
									: "Currently in Standalone Chats (uses global memory only). Select or create a project to manage project-specific memory."}
							</div>
						) : (
							<>
								<div className="mem-proj-head" title={cwd}>
									<FiFolder className="mem-proj-icon" />
									<span className="mem-proj-name" data-testid="mem-project-name">
										{view?.projectName}
									</span>
									<span className="mem-proj-meta">
										{zh ? `${projectItems.length} 条记忆` : `${projectItems.length} memories`}
									</span>
								</div>
								<div className="mem-sec-label">{zh ? "项目专属指令" : "Project Instructions"}</div>
								<div className="mem-inst-box">
									<textarea
										className="mem-textarea"
										rows={3}
										value={instructionsDraft}
										placeholder={
											zh
												? "仅在该项目下生效的系统指令（如：角色设定、回答格式、项目背景）…"
												: "Custom instructions active only inside this project…"
										}
										onChange={(e) => {
											setInstructionsDraft(e.target.value);
											setInstructionsDirty(true);
										}}
									/>
									{instructionsDirty && (
										<div style={{ display: "flex", justifyContent: "flex-end", marginTop: 6 }}>
											<button
												type="button"
												className="btn primary"
												disabled={busy}
												onClick={() => {
													setInstructionsDirty(false);
													void runOp(() =>
														apiPostMemory("/api/memory/instructions", {
															cwd,
															instructions: instructionsDraft,
															sessionId,
														}),
													);
												}}
											>
												<FiCheck /> {zh ? "保存项目指令" : "Save Instructions"}
											</button>
										</div>
									)}
								</div>

								<div className="mem-sec-label">{zh ? "项目记忆条目" : "Project Memories"}</div>
								<div className="mem-add-row">
									<input
										type="text"
										className="mem-input"
										value={newProjectText}
										placeholder={zh ? "添加仅属于当前项目的记忆…" : "Add a memory specific to this project…"}
										onChange={(e) => setNewProjectText(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Enter" && newProjectText.trim()) {
												const text = newProjectText.trim();
												setNewProjectText("");
												void runOp(() =>
													apiPostMemory("/api/memory/item", {
														op: "add",
														scope: "project",
														content: text,
														cwd,
														sessionId,
													}),
												);
											}
										}}
									/>
									<button
										type="button"
										className="btn primary"
										disabled={!newProjectText.trim() || busy}
										onClick={() => {
											const text = newProjectText.trim();
											setNewProjectText("");
											void runOp(() =>
												apiPostMemory("/api/memory/item", {
													op: "add",
													scope: "project",
													content: text,
													cwd,
													sessionId,
												}),
											);
										}}
									>
										<FiPlus /> {zh ? "添加" : "Add"}
									</button>
								</div>

								{projectItems.length === 0 ? (
									<div className="mem-empty">{zh ? "该项目暂无专属记忆。" : "No project memories yet."}</div>
								) : (
									<div className="mem-list">
										{projectItems.map((item) => (
											<div key={item.id} className={`mem-row${item.enabled ? "" : " disabled"}`}>
												<input
													type="checkbox"
													checked={item.enabled}
													onChange={(e) =>
														void runOp(() =>
															apiPostMemory("/api/memory/item", {
																op: "update",
																scope: "project",
																id: item.id,
																enabled: e.target.checked,
																cwd,
																sessionId,
															}),
														)
													}
												/>
												<span className="mem-text">{item.content}</span>
												<button
													type="button"
													className="mem-icon-btn"
													title={zh ? "提升为全局记忆" : "Promote to global memory"}
													onClick={() =>
														void runOp(() =>
															apiPostMemory("/api/memory/item", {
																op: "promote",
																scope: "project",
																id: item.id,
																cwd,
																sessionId,
															}),
														)
													}
												>
													<FiArrowUp />
												</button>
												<button
													type="button"
													className="mem-icon-btn danger"
													title={zh ? "删除" : "Delete"}
													onClick={() =>
														void runOp(() =>
															apiPostMemory("/api/memory/item", {
																op: "delete",
																scope: "project",
																id: item.id,
																cwd,
																sessionId,
															}),
														)
													}
												>
													<FiTrash2 />
												</button>
											</div>
										))}
									</div>
								)}
							</>
						)}
						{/* 新建或切换云端话题项目 */}
						<div className="mem-create-proj mem-create-proj-foot">
							<FiFolderPlus />
							<input
								type="text"
								className="mem-input"
								value={newChatProjName}
								placeholder={
									zh
										? "新建云端话题项目（如：论文润色、Rust 学习，可跨端同步）…"
										: "New topic project name (synced across devices)…"
								}
								onChange={(e) => setNewChatProjName(e.target.value)}
							/>
							<button
								type="button"
								className="btn secondary"
								disabled={!newChatProjName.trim() || busy}
								onClick={async () => {
									const name = newChatProjName.trim();
									setNewChatProjName("");
									setBusy(true);
									try {
										const res = await apiPostMemory("/api/memory/chat-project", { name, sessionId });
										setMemory(res);
										if (res.created?.path) {
											onSwitchCwd(res.created.path);
										}
									} catch (e) {
										setErrMsg((e as Error).message);
									} finally {
										setBusy(false);
									}
								}}
								data-testid="mem-create-chat-project"
							>
								{zh ? "新建并进入" : "Create"}
							</button>
						</div>
					</div>
				)}

				{tab === "sync" && (
					<div className="mem-pane">
						{sync?.loggedIn ? (
							<div className="mem-sync-card">
								<div className="mem-sync-head">
									<div>
										<div className="mem-sync-user">
											<FiCloud /> GitHub: <b>{sync.username}</b>
										</div>
										<div className="mem-sync-meta">
											{zh ? "私有同步仓库：" : "Private repo: "}
											<code>
												{sync.username}/{sync.repo}
											</code>
											{sync.lastSyncedAt
												? ` · ${zh ? "上次同步" : "Last synced"}: ${new Date(sync.lastSyncedAt).toLocaleTimeString()}`
												: ""}
										</div>
									</div>
									<div style={{ display: "flex", gap: 8 }}>
										<button
											type="button"
											className="btn primary"
											disabled={sync.syncing || busy}
											onClick={() =>
												void runOp(() => apiPostMemory("/api/memory/sync", { action: "sync-now", cwd, sessionId }))
											}
										>
											<FiRefreshCw className={sync.syncing ? "spin" : ""} />{" "}
											{sync.syncing ? (zh ? "同步中…" : "Syncing…") : zh ? "立即同步" : "Sync Now"}
										</button>
										<button
											type="button"
											className="btn secondary"
											disabled={busy}
											onClick={() =>
												void runOp(() => apiPostMemory("/api/memory/sync", { action: "logout", cwd, sessionId }))
											}
										>
											{zh ? "退出登录" : "Sign Out"}
										</button>
									</div>
								</div>
								{sync.lastError && <div className="mem-err">{sync.lastError}</div>}
								<div className="mem-sync-hint">
									{zh
										? "在 Mac、Windows 或 Ubuntu 上打开 PI 并登录同一个 GitHub 账号，即可自动拉取并双向合并全部全局记忆、项目记忆与话题项目。"
										: "Sign in with the same GitHub account on Mac, Windows, or Ubuntu to automatically sync and merge all global memories, project memories, and topic projects."}
								</div>
							</div>
						) : (
							<div className="mem-sync-card">
								<div className="mem-sec-label">
									{zh
										? "登录 GitHub 以开启跨端记忆同步（自动存入你的私有仓库 pi-memory-sync）"
										: "Sign in with GitHub to sync memories across devices (stored in your private repo pi-memory-sync)"}
								</div>

								{sync?.deviceFlow ? (
									<div className="mem-device-box">
										<div className="mem-device-code-row">
											<span className="mem-device-code">{sync.deviceFlow.userCode}</span>
											<button
												type="button"
												className="btn secondary"
												onClick={() => {
													void copyDeviceCode(sync.deviceFlow!.userCode);
												}}
											>
												{copiedCode ? <FiCheck /> : <FiCopy />}{" "}
												{copiedCode ? (zh ? "已复制" : "Copied") : zh ? "复制验证码" : "Copy"}
											</button>
											<a
												className="btn primary"
												href={sync.deviceFlow.verificationUri}
												target="_blank"
												rel="noreferrer noopener"
											>
												{zh ? "打开 GitHub 授权页" : "Open GitHub"}
											</a>
											<button
												type="button"
												className="btn secondary"
												onClick={() =>
													void runOp(() =>
														apiPostMemory("/api/memory/sync", { action: "device-cancel", cwd, sessionId }),
													)
												}
											>
												{zh ? "取消" : "Cancel"}
											</button>
										</div>
										<div className="mem-sync-hint">
											{zh
												? "在打开的 GitHub 页面中输入上方 8 位设备码并点击 Authorize，本窗口会自动完成登录与首次同步…"
												: "Enter the 8-character code on GitHub and click Authorize. This window will sign in automatically…"}
										</div>
									</div>
								) : (
									<div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
										<button
											type="button"
											className="btn primary"
											disabled={busy}
											onClick={() =>
												void runOp(async () => {
													const next = await apiPostMemory("/api/memory/sync", {
														action: "device-start",
														cwd,
														sessionId,
													});
													if (next.sync?.deviceFlow?.verificationUri) {
														window.open(next.sync.deviceFlow.verificationUri, "_blank", "noreferrer,noopener");
													}
													return next;
												})
											}
										>
											<FiCloud /> {zh ? "GitHub 网页一键登录（推荐）" : "Sign in with GitHub (Browser)"}
										</button>
									</div>
								)}

								<div className="mem-sec-label">
									{zh ? "或使用 Personal Access Token 登录" : "Or sign in with Personal Access Token"}
								</div>
								<div className="mem-add-row">
									<input
										type="password"
										className="mem-input"
										value={tokenInput}
										placeholder={
											zh
												? "粘贴具备 repo 权限的 GitHub Token (ghp_... / github_pat_...)"
												: "Paste GitHub token with repo scope…"
										}
										onChange={(e) => setTokenInput(e.target.value)}
									/>
									<input
										type="text"
										className="mem-input"
										style={{ maxWidth: 160 }}
										value={repoInput}
										placeholder="pi-memory-sync"
										onChange={(e) => setRepoInput(e.target.value)}
									/>
									<button
										type="button"
										className="btn secondary"
										disabled={!tokenInput.trim() || busy}
										onClick={() => {
											const tk = tokenInput.trim();
											setTokenInput("");
											void runOp(() =>
												apiPostMemory("/api/memory/sync", {
													action: "token-login",
													token: tk,
													repo: repoInput,
													cwd,
													sessionId,
												}),
											);
										}}
									>
										{zh ? "登录并同步" : "Sign In"}
									</button>
								</div>
								{sync?.lastError && <div className="mem-err">{sync.lastError}</div>}
							</div>
						)}

						{/* 已捕获 / 云端同步内容可视化清单 */}
						<div className="mem-sync-card" style={{ marginTop: 12 }} data-testid="mem-sync-overview">
							<div className="mem-sec-label" style={{ marginBottom: 8 }}>
								{zh
									? `📦 跨端同步数据总览（全局记忆 ${globalItems.length} 条 · Chat 项目 ${chatProjects.length} 个 · Chat 对话记录 ${syncedTranscripts.length} 段）`
									: `📦 Synced Data (${globalItems.length} global memories · ${chatProjects.length} Chat projects · ${syncedTranscripts.length} Chat transcripts)`}
							</div>
							<div className="mem-sync-hint" style={{ marginBottom: 10 }}>
								{zh
									? "同步机制说明：1) 你在对话中提到的硬件环境、个人基础、学习/求职目标或“记住…”会自动提取进记忆库；2) 在 Chat 模式（独立对话及 Chat 项目）下的每轮对话结束后，对话记录与记忆会自动打包并在后台同步到 GitHub 私有仓库。"
									: "How sync works: 1) Personal facts/goals shared in chat are automatically extracted into memory; 2) Every turn in Chat mode (Standalone Chats & Chat Projects) automatically packages the transcript and syncs to your private GitHub repo."}
							</div>
							{syncedTranscripts.length === 0 ? (
								<div className="mem-empty" style={{ padding: "12px 0" }}>
									{zh
										? "暂无已捕获的 Chat 对话记录（在 Chat 模式下发送消息后会自动收录并同步）。"
										: "No Chat transcripts captured yet (send a message in Chat mode to auto-capture and sync)."}
								</div>
							) : (
								<div className="mem-list" data-testid="mem-synced-transcripts">
									{syncedTranscripts.map((tr) => (
										<div key={tr.sessionId} className="mem-row" style={{ justifyContent: "space-between", gap: 10 }}>
											<div style={{ minWidth: 0, flex: 1 }}>
												<div
													style={{
														fontWeight: 600,
														fontSize: 13,
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
												>
													{tr.title}
												</div>
												<div style={{ fontSize: 11.5, color: "var(--text-faint)", marginTop: 2 }}>
													<span>{tr.scopeName}</span>
													<span> · {zh ? `${tr.messageCount} 条消息` : `${tr.messageCount} msgs`}</span>
													{tr.updatedAt > 0 && <span> · {new Date(tr.updatedAt).toLocaleString()}</span>}
												</div>
											</div>
											{onOpenTranscript && (
												<button
													type="button"
													className="btn secondary"
													style={{ flexShrink: 0, padding: "4px 10px", fontSize: 12 }}
													onClick={() => onOpenTranscript(tr.cwd, tr.filePath, tr.sessionId)}
												>
													{zh ? "打开对话" : "Open"}
												</button>
											)}
										</div>
									))}
								</div>
							)}
						</div>
					</div>
				)}
			</div>
		</Modal>
	);
}
