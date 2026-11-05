import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FiCheck, FiSearch } from "react-icons/fi";
import { filterCommands, groupRows, type PaletteCommand } from "../command-palette";
import { useT } from "../i18n";
import { useEscapeKey } from "../shortcut-stack";

/**
 * 命令面板（redesign P2 §11）：Ctrl/Cmd+K。上半是可执行命令（承接原顶栏/侧栏/底栏的全部入口
 * 与插件槽位条目），最底一行把当前输入转交全局搜索（会话全文 / 项目 / 文件 / 插件）。
 */
export function CommandPalette({
	open,
	commands,
	onClose,
	onSearch,
}: {
	open: boolean;
	commands: PaletteCommand[];
	onClose: () => void;
	onSearch: (query: string) => void;
}) {
	const t = useT();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		if (!open) return;
		setQuery("");
		setActive(0);
		inputRef.current?.focus();
	}, [open]);

	useEscapeKey(() => {
		if (!open) return false;
		onClose();
		return true;
	}, open);

	const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
	const rows = useMemo(() => groupRows(filtered), [filtered]);
	// 最后一项固定是「搜索」
	const total = filtered.length + 1;
	const searchIndex = filtered.length;

	useEffect(() => setActive(0), [query]);
	useEffect(() => {
		listRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const runAt = (i: number) => {
		if (i === searchIndex) {
			onClose();
			onSearch(query);
			return;
		}
		const cmd = filtered[i];
		if (!cmd) return;
		onClose();
		// 让面板先卸载，再执行（有的命令会打开新的弹窗 / 抢焦点）
		requestAnimationFrame(() => cmd.run());
	};

	// 挂在 window 上而非 <input>：WS 首帧 / 其它异步回调可能调 focusComposer 抢走焦点，
	// 只要面板还开着，↑↓ / Enter 都必须继续管用。
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive((a) => (a + 1) % total);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive((a) => (a - 1 + total) % total);
			} else if (e.key === "Enter" && !e.isComposing) {
				e.preventDefault();
				runAt(active);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	if (!open) return null;

	let idx = -1;
	return createPortal(
		<div className="cmdk-backdrop" onMouseDown={onClose} data-testid="command-palette">
			<div
				className="cmdk"
				role="dialog"
				aria-modal="true"
				aria-label={t("commandPalette")}
				onMouseDown={(e) => e.stopPropagation()}
			>
				<div className="cmdk-input-row">
					<FiSearch aria-hidden />
					<input
						ref={inputRef}
						autoFocus
						className="cmdk-input"
						value={query}
						placeholder={t("commandPalettePlaceholder")}
						onChange={(e) => setQuery(e.target.value)}
						data-testid="command-palette-input"
					/>
				</div>
				<div className="cmdk-list" ref={listRef} role="listbox">
					{rows.map((row) => (
						<div key={row.group} className="cmdk-group">
							<div className="cmdk-group-title">{row.group}</div>
							{row.items.map((c) => {
								idx += 1;
								const i = idx;
								return (
									<div
										key={c.id}
										role="option"
										aria-selected={i === active}
										data-idx={i}
										data-cmd={c.id}
										className={`cmdk-item${i === active ? " active" : ""}`}
										onMouseMove={() => setActive(i)}
										onClick={() => runAt(i)}
									>
										<span className="cmdk-check">{c.checked ? <FiCheck /> : null}</span>
										<span className="cmdk-label">{c.label}</span>
										{c.hint && <span className="cmdk-hint">{c.hint}</span>}
									</div>
								);
							})}
						</div>
					))}
					<div
						role="option"
						aria-selected={active === searchIndex}
						data-idx={searchIndex}
						data-cmd="search"
						className={`cmdk-item cmdk-search${active === searchIndex ? " active" : ""}`}
						onMouseMove={() => setActive(searchIndex)}
						onClick={() => runAt(searchIndex)}
					>
						<span className="cmdk-check">
							<FiSearch />
						</span>
						<span className="cmdk-label">
							{query.trim() ? t("commandPaletteSearchFor", { q: query.trim() }) : t("searchGlobal")}
						</span>
					</div>
				</div>
			</div>
		</div>,
		document.body,
	);
}
