import { useEffect, useRef, useState } from "react";
import { FiMoreHorizontal, FiSettings } from "react-icons/fi";
import { useT } from "../i18n";

export interface SidebarFooterItem {
	id: string;
	label: string;
	active?: boolean;
	onSelect: () => void;
}

/**
 * 极简外壳侧栏底部（redesign P2 §9）：「更多」弹出视图入口（Git / Canvas / Worktrees /
 * 设备中心 / 插件视图 / 后台任务），右侧齿轮打开设置。
 */
export function SidebarFooter({ items, onOpenSettings }: { items: SidebarFooterItem[]; onOpenSettings: () => void }) {
	const t = useT();
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

	return (
		<div className="sb-footer" ref={rootRef} data-testid="sidebar-footer">
			<button
				type="button"
				className={`sb-footer-btn${open ? " on" : ""}`}
				onClick={() => setOpen((v) => !v)}
				aria-haspopup="menu"
				aria-expanded={open}
				data-testid="sidebar-more"
			>
				<FiMoreHorizontal aria-hidden />
				<span>{t("sidebarMore")}</span>
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
