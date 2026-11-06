import { useEffect, useRef, useState } from "react";
import { FiGithub, FiLock, FiMoreHorizontal, FiSettings } from "react-icons/fi";
import { isZhLocale, useI18n, useT } from "../i18n";

export interface SidebarFooterItem {
	id: string;
	label: string;
	active?: boolean;
	onSelect: () => void;
}

/** 左下角账户卡片所需的记忆 / 同步状态（由 App 从 useMemoryState 派生）。 */
export interface SidebarAccount {
	/** 已通过 GitHub 登录跨端同步 */
	loggedIn: boolean;
	username?: string;
	avatarUrl?: string;
	/** 当前生效（启用）的共享记忆条数 */
	memoryCount: number;
	/** 当前对话是否为「独立记忆」 */
	isolated: boolean;
	syncing: boolean;
	onOpen: () => void;
}

/** GitHub 头像：优先用服务端返回的 avatar_url，否则按用户名拼公开头像地址；加载失败回落首字母。 */
function AccountAvatar({ username, avatarUrl }: { username?: string; avatarUrl?: string }) {
	const src = avatarUrl || (username ? `https://github.com/${encodeURIComponent(username)}.png?size=64` : "");
	const [failed, setFailed] = useState(false);
	useEffect(() => setFailed(false), [src]);
	if (!src) {
		return (
			<span className="sb-avatar sb-avatar-empty" aria-hidden>
				<FiGithub />
			</span>
		);
	}
	if (failed) {
		return (
			<span className="sb-avatar sb-avatar-letter" aria-hidden>
				{(username ?? "?").slice(0, 1).toUpperCase()}
			</span>
		);
	}
	return <img className="sb-avatar" src={src} alt="" draggable={false} onError={() => setFailed(true)} />;
}

/**
 * 极简外壳侧栏底部（redesign P2 §9）：左侧账户卡片（GitHub 头像 + 记忆 / 同步状态，点击打开
 * 「记忆与跨端同步」），右侧「更多」弹出视图入口（Git / Canvas / Worktrees / 设备中心 /
 * 插件视图 / 后台任务）与齿轮设置。
 */
export function SidebarFooter({
	items,
	onOpenSettings,
	account,
}: {
	items: SidebarFooterItem[];
	onOpenSettings: () => void;
	account?: SidebarAccount;
}) {
	const t = useT();
	const { locale } = useI18n();
	const zh = isZhLocale(locale);
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		const onDown = (e: MouseEvent) => {
			if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [open]);

	const accountSub = !account
		? ""
		: account.isolated
			? zh
				? "独立记忆 · 不读写共享记忆"
				: "Isolated memory"
			: account.loggedIn
				? zh
					? `${account.memoryCount} 条记忆 · ${account.syncing ? "同步中…" : "已同步"}`
					: `${account.memoryCount} memories · ${account.syncing ? "syncing…" : "synced"}`
				: zh
					? `${account.memoryCount} 条记忆 · 仅本机`
					: `${account.memoryCount} memories · local only`;

	return (
		<div className={`sb-footer${account ? " has-account" : ""}`} ref={rootRef} data-testid="sidebar-footer">
			{account && (
				<button
					type="button"
					className={`sb-account${account.isolated ? " isolated" : ""}`}
					onClick={account.onOpen}
					title={zh ? "记忆与跨端同步" : "Memory & Cloud Sync"}
					data-testid="open-memory-modal"
				>
					<span className="sb-avatar-wrap">
						<AccountAvatar username={account.username} avatarUrl={account.avatarUrl} />
						{account.loggedIn && <span className={`sb-avatar-dot${account.syncing ? " syncing" : ""}`} />}
					</span>
					<span className="sb-account-text">
						<span className="sb-account-name" data-testid="sidebar-account-name">
							{account.loggedIn ? account.username : zh ? "登录 GitHub 同步" : "Sign in to sync"}
						</span>
						<span className="sb-account-sub">
							{account.isolated && <FiLock aria-hidden />}
							{accountSub}
						</span>
					</span>
				</button>
			)}
			<button
				type="button"
				className={`sb-footer-btn${account ? " sb-footer-icon" : ""}${open ? " on" : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open}
				aria-label={t("sidebarMore")}
				title={account ? t("sidebarMore") : undefined}
				data-testid="sidebar-more"
			>
				<FiMoreHorizontal aria-hidden />
				{!account && <span>{t("sidebarMore")}</span>}
			</button>
			<button
				type="button"
				className="sb-footer-btn sb-footer-icon"
				onClick={onOpenSettings}
				title={t("settings")}
				aria-label={t("settings")}
				data-testid="sidebar-settings"
			>
				<FiSettings aria-hidden />
			</button>
			{open && (
				<div className="sb-menu" role="menu">
					{items.map((it) => (
						<button
							key={it.id}
							type="button"
							role="menuitem"
							className={`sb-menu-item${it.active ? " active" : ""}`}
							data-testid={`sidebar-more-${it.id}`}
							onClick={() => {
								setOpen(false);
								it.onSelect();
							}}
						>
							{it.label}
						</button>
					))}
				</div>
			)}
		</div>
	);
}
