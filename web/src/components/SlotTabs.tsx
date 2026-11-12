/**
 * slot 驱动的 tab 容器：`role="tablist"` 的 tab 条 + 单个内容区。
 *
 * 用途：右栏的 `rightpanel.tabs`（宿主内置的文件树 tab + 插件贡献的 tab 同排），
 * 以及设置面板这类「内置页 + 插件页（`settings.pages`）」的场合 —— 两边都需要
 * 「内置 element 或插件页」二选一渲染，所以只做一个容器，不复制两份。
 *
 * 核心取舍：**除当前选中项外，其它 tab 的内容一律不挂载**。
 *   - 省内存：插件页各自带自己的 DOM/定时器/网络请求，全留着会随插件数量线性增长。
 *   - 让 cleanup 生效：插件 mount() 返回的清理函数在切走的**那一刻**被调用，插件能
 *     收干净副作用（与 PluginView 的「display:none 保状态」是有意不同的策略）。
 *   - 代价：tab 内部状态（滚动位置、表单草稿、树展开态）在来回切换时丢失。
 *     调用方要保状态，就把状态提到**上层组件**里（例如选中项、过滤词），或用 CSS
 *     自己隐藏（那属于调用方自己的 tab 条，不必走本容器）。
 *
 * 子项缺省 id 记忆：`localStorage["pi-web-ui:<storageKey>:tab"]`。隐私模式/被禁用时
 * 读写静默失败 → 退化成「当前会话内存态」，功能不降级（只是下次打开回到第一个可用 tab）。
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { JSX } from "react";
import { PluginIcon } from "../plugin-icon";
import { PluginPage } from "./PluginPage";
import type { UiPluginInfo } from "../types";
import type { UiSlotEntry } from "../ui-slots";

export interface SlotTab {
	/** 稳定 id（持久化选中态用）。 */
	id: string;
	label: string;
	icon?: string;
	/** 内联 SVG 图标（有则优先于 icon 渲染）。 */
	iconSvg?: string;
	/** 该 tab 的内容（内置 tab 由调用方传 element；插件 tab 传 null 并在 onRenderPlugin 里渲染）。 */
	element?: ReactNode;
	/** 悬浮提示（插件条目的 `hint`；没有就用 label）。 */
	hint?: string;
	/** 插件贡献的 tab：给出插件与条目，容器用 PluginPage 渲染内容。 */
	pluginPage?: { plugin: UiPluginInfo; entry: UiSlotEntry };
}

interface SlotTabsProps {
	/** 持久化命名空间（localStorage key 前缀，如 "rightpanel" / "settings"）。 */
	storageKey: string;
	tabs: SlotTab[];
	/** 渲染插件页时用（App 注入 send 与 epoch）。 */
	epoch: number;
	send: (msg: { type: "plugin_message"; pluginId: string; payload: unknown }) => void;
	/** 顶栏右侧附加内容（可选，比如「全部收起」按钮）。 */
	extra?: ReactNode;
	className?: string;
	/** 宿主程序化切换请求（nonce 递增时强制切到指定 tab id）。 */
	requestedTab?: { id: string; nonce: number } | null;
	/** 当前激活 tab 变化回调。 */
	onTabChange?: (id: string) => void;
}

/** 持久化 key：与其它前端偏好同前缀（`pi-web-ui:`），便于一次性清理。 */
function tabStorageKey(storageKey: string): string {
	return `pi-web-ui:${storageKey}:tab`;
}

/**
 * 读持久化的选中 tab。返回 null = 当作「没存过」，由调用方回落第一个：
 *   - localStorage 不可用（隐私模式/被策略禁用）
 *   - 存下来的 id 已经不在 tabs 里（插件被禁用/卸载）——这里就判掉，免得先渲染一帧
 *     不存在的 tab 再靠 effect 纠正。
 */
function loadActiveId(storageKey: string, tabs: SlotTab[]): string | null {
	try {
		const raw = localStorage.getItem(tabStorageKey(storageKey));
		if (!raw) return null;
		return tabs.some((x) => x.id === raw) ? raw : null;
	} catch {
		return null;
	}
}

/** 写持久化选中 tab（不可写时静默忽略：内存态照常工作）。 */
function saveActiveId(storageKey: string, id: string): void {
	try {
		localStorage.setItem(tabStorageKey(storageKey), id);
	} catch {
		// 隐私模式 / 配额满：忽略。
	}
}

/**
 * 图标要不要当文本画：`UiSlotEntry.icon` 既可能是 emoji/单字符（插件给的字面 glyph），
 * 也可能是宿主的图标词表名（folder/settings/…，需要 react-icons 映射）。本容器不认识那套
 * 词表（映射属于顶栏渲染层的职责），所以**只画不含 ASCII 字母的字面 glyph**，词表名留空
 * ——绝不把 "folder" 这样的词当文字显示出来。
 */
function isGlyphIcon(icon: string): boolean {
	return icon.length > 0 && !/[a-z]/i.test(icon);
}

/** tab 文案兜底：label 为空串时退到条目文案 → 插件名 → id（有总比空白 tab 强）。 */
function labelOf(tab: SlotTab): string {
	if (tab.label) return tab.label;
	const page = tab.pluginPage;
	return page?.entry.label || page?.plugin.name || tab.id;
}

// 返回值必须允许 null（空 tabs 什么都不画），所以比 PluginPage 多一个 `| null`。
export function SlotTabs({
	storageKey,
	tabs,
	epoch,
	send,
	extra,
	className,
	requestedTab,
	onTabChange,
}: SlotTabsProps): JSX.Element | null {
	// aria 关联用的 DOM id 前缀：useId 保证多实例（右栏 + 设置面板同时开着）不撞车。
	// 插件 id 可能含怪字符，所以 id 里只放**索引**，不放业务 id。
	const baseId = useId();
	const [activeId, setActiveId] = useState<string>(() => loadActiveId(storageKey, tabs) ?? tabs[0]?.id ?? "");
	const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
	/** 最后一次真正写进 localStorage 的 `<storageKey>:<id>`，避免每帧重复写。 */
	const savedRef = useRef<string>("");
	const lastRequestNonceRef = useRef<number>(0);

	useEffect(() => {
		if (!requestedTab || requestedTab.nonce === lastRequestNonceRef.current) return;
		lastRequestNonceRef.current = requestedTab.nonce;
		if (tabs.some((x) => x.id === requestedTab.id)) {
			setActiveId(requestedTab.id);
			savedRef.current = `${storageKey}:${requestedTab.id}`;
			saveActiveId(storageKey, requestedTab.id);
		}
	}, [requestedTab, storageKey, tabs]);

	const index = tabs.findIndex((x) => x.id === activeId);
	// 选中项不存在时**渲染期就**回落第一个（而不是等 effect），避免空内容闪一帧。
	const active = index >= 0 ? tabs[index] : tabs[0];
	const activeIndex = active ? tabs.indexOf(active) : -1;

	useEffect(() => {
		if (!active) return;
		// 选中项失效（插件被禁/卸载、调用方重排 tab）→ 同步回落到第一个。
		if (activeId !== active.id) setActiveId(active.id);
		onTabChange?.(active.id);
		const key = `${storageKey}:${active.id}`;
		if (savedRef.current !== key) {
			savedRef.current = key;
			saveActiveId(storageKey, active.id);
		}
	}, [active, activeId, onTabChange, storageKey]);

	const selectTab = (tab: SlotTab): void => {
		setActiveId(tab.id);
		savedRef.current = `${storageKey}:${tab.id}`;
		saveActiveId(storageKey, tab.id);
	};

	/**
	 * 键盘切换：←/→ 环绕、Home/End 跳首尾，并**同时移动焦点**（roving tabindex：只有
	 * 选中项 tabIndex=0，其余 -1）。选中即激活（ARIA 推荐的 automatic activation）——
	 * 本容器的 tab 切换代价只是挂载一个 element/插件页，不需要「先移动焦点再回车确认」。
	 */
	const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number): void => {
		const count = tabs.length;
		let next = -1;
		if (e.key === "ArrowRight") next = (i + 1) % count;
		else if (e.key === "ArrowLeft") next = (i - 1 + count) % count;
		else if (e.key === "Home") next = 0;
		else if (e.key === "End") next = count - 1;
		else return;
		const target = tabs[next];
		if (!target) return;
		e.preventDefault(); // 别让方向键顺带滚动内容区
		selectTab(target);
		tabRefs.current[next]?.focus();
	};

	// 空 tabs（插件全被禁、调用方的内置 tab 也被隐藏）→ 整块不占位。
	if (!active) return null;

	const panelId = `${baseId}-panel-${activeIndex}`;
	const cls = className ? `slot-tabs ${className}` : "slot-tabs";
	return (
		<div className={cls}>
			<div className="slot-tabs-bar" role="tablist">
				{tabs.map((tab, i) => {
					const selected = i === activeIndex;
					return (
						<button
							key={tab.id}
							type="button"
							role="tab"
							id={`${baseId}-tab-${i}`}
							className={selected ? "slot-tab active" : "slot-tab"}
							title={tab.hint ?? labelOf(tab)}
							aria-selected={selected}
							aria-controls={`${baseId}-panel-${i}`}
							// roving tabindex：tab 条本身只有一个 Tab 停靠点，条内切换靠方向键。
							tabIndex={selected ? 0 : -1}
							ref={(node) => {
								tabRefs.current[i] = node;
							}}
							onClick={() => selectTab(tab)}
							onKeyDown={(e) => onKeyDown(e, i)}
						>
							{tab.iconSvg ? (
								<PluginIcon iconSvg={tab.iconSvg} className="slot-tab-icon" />
							) : tab.icon && isGlyphIcon(tab.icon) ? (
								<span className="slot-tab-icon">{tab.icon}</span>
							) : null}
							<span className="slot-tab-label">{labelOf(tab)}</span>
						</button>
					);
				})}
				{extra ? <div className="slot-tabs-extra">{extra}</div> : null}
			</div>
			<div className="slot-tabs-body" id={panelId} role="tabpanel" aria-labelledby={`${baseId}-tab-${activeIndex}`}>
				{active.pluginPage ? (
					// 只挂当前选中项：换 tab 即卸载 → 插件 mount 返回的 cleanup 被调用（见文件头取舍）。
					<PluginPage plugin={active.pluginPage.plugin} epoch={epoch} send={send} />
				) : (
					(active.element ?? null)
				)}
			</div>
		</div>
	);
}
