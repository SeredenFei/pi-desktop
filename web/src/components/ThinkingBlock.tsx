import { useCallback, useEffect, useRef, useState } from "react";
import { FiCheck, FiCheckCircle, FiCopy, FiCpu } from "react-icons/fi";
import { useT } from "../i18n";
import { useCopyFeedback } from "../use-copy-feedback";
import { isFlowMode, openToolInspector } from "../tool-inspector-state";
import { CollapsibleHead } from "./CollapsibleHead";
import { HalfRingSpinner } from "./HalfRingSpinner";
import { useSmoothStreamText } from "./StreamMarkdown";

/** 安全截断长度：允许占满 4K 大屏卡头，防止极端超长文本阻塞 DOM 布局 */
const MAX_PREVIEW_LEN = 300;

/** 剥离思考文本开头常见的无意义模板标题行（如 "# Thinking Process" / "思路："） */
function stripLeadingGenericHeader(thinking: string): string {
	const lines = thinking.split("\n");
	let startIdx = 0;
	while (startIdx < lines.length) {
		const line = lines[startIdx].trim();
		if (!line) {
			startIdx++;
			continue;
		}
		const stripped = line.replace(/^[#*>\s]+/, "").toLowerCase();
		if (
			stripped === "thinking" ||
			stripped === "thinking:" ||
			stripped === "thinking process" ||
			stripped === "thinking process:" ||
			stripped === "思考" ||
			stripped === "思考过程" ||
			stripped === "思考过程：" ||
			stripped === "思路" ||
			stripped === "思路："
		) {
			startIdx++;
			continue;
		}
		break;
	}
	return lines.slice(startIdx).join("\n");
}

/** 剥离思考文本中残留的内联标记（如 [[conv:rename:...]] / [[action:suggest:...]]），保证思考区纯净展示 */
export function stripThinkingMarkers(text: string): string {
	if (!text || !text.includes("[[")) return text;
	return text
		.replace(/\[\[(?:conv|todo|action|suggest|notify|goal):[\s\S]*?\]\]/gu, "")
		.replace(/\[\[(?:conv|todo|action|suggest|notify|goal):[^\]]*$/u, "");
}

/**
 * 格式化思考展开态正文：
 * - 剥离首行无意义模板标题与首尾空白/换行，消除模型输出尾随 `\n\n\n` 在
 *   `white-space: pre-wrap` 下撑出的底部大片空白；
 * - 剥离模型在思考开头输出的内联标记指令（如 [[conv:rename:...]]）；
 * - 将段间连续 3 个及以上换行收敛为单空行（`\n\n`），保留正常段落层次。
 */
export function formatThinkingBody(thinking: string): string {
	const cleaned = stripThinkingMarkers(thinking);
	const normalized = cleaned.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n");
	const body = stripLeadingGenericHeader(normalized).trim();
	const source = body || normalized.trim();
	if (!source) return "";
	return source.replace(/\n{3,}/g, "\n\n");
}

/**
 * 将多行思考压平为单行连续文本：
 * - 流式时不因换行而清空闪烁，也不因单行超出宽度而卡住不动；
 * - 结束时不因首行过短而留出大片空白，充分利用整行宽度。
 */
export function flattenThinkingText(thinking: string): string {
	const cleaned = stripThinkingMarkers(thinking);
	const body = stripLeadingGenericHeader(cleaned).trim();
	const source = body || cleaned.trim();
	if (!source) return "";
	return source
		.split(/\n+/)
		.map((l) => l.trim())
		.filter(Boolean)
		.join(" ");
}

/**
 * 折叠预览纯函数：
 * - 流式（streaming=true）：取连续单行流的实时尾部，配合 CSS 右端锚定实时滚动显示最新生成文字；
 * - 结束（streaming=false）：取连续单行流的头部摘要，铺满卡头宽度并由 CSS ellipsis 优雅收尾。
 */
export function thinkingPreview(thinking: string, streaming?: boolean): string {
	const flat = flattenThinkingText(thinking);
	if (!flat) return "";
	return streaming ? flat.slice(-MAX_PREVIEW_LEN) : flat.slice(0, MAX_PREVIEW_LEN);
}

interface ThinkingBlockProps {
	thinking: string;
	/** True while the assistant is still streaming this thinking block. */
	streaming?: boolean;
	/** 设置面板「完整显示思考」开关：true（开）→ 思考始终完整展开并自动换行
	 *  （流式推理过程也实时可见）；false（关）→ 折叠成一行摘要，流式中一行
	 *  实时显示最新文本。 */
	wrap?: boolean;
	/** 会话内搜索打开时强制展开（折叠内容不在 DOM，搜索索引搜到的词会
	 *  “展开后看不到”）。不改变用户的 open 状态，关闭搜索自动恢复。 */
	forceOpen?: boolean;
}

export function ThinkingBlock({ thinking, streaming, wrap = true, forceOpen = false }: ThinkingBlockProps) {
	const t = useT();
	// null = 未手动点过 → 跟随开关：wrap=true（开）→ 完整展开；wrap=false（关）→ 折叠。
	// 极简外壳下：思考流式进行时可展开，思考完成后若未手动点开则自动收起为单行摘要。
	const [open, setOpen] = useState<boolean | null>(null);
	const isMinimalShell = typeof document !== "undefined" && document.documentElement.dataset.shell === "minimal";
	const expanded = open ?? (isMinimalShell && !streaming ? false : wrap);
	// 搜索期间 forceOpen 只是“视口展开”，用户 open 状态不受影响
	const shown = expanded || forceOpen;

	// 余韵收尾（Graceful Tail Drain）：短思考紧接着触发 toolCall 时，streaming 会迅速变为 false；
	// 保持 draining 直至缓冲池内的文字平滑流淌完毕，防止短思考没有过程就直接全部蹦出。
	// 若处于后台标签页（document.hidden），直接禁止进入 draining，并在切换可见性时直接结算，
	// 杜绝多个历史思考块在切换回前台时同时补播文字流动画。
	const live = !!streaming;
	const liveRef = useRef(live);
	liveRef.current = live;
	const isHidden = () => typeof document !== "undefined" && document.hidden;
	const [draining, setDraining] = useState(() => live && !isHidden());
	useEffect(() => {
		if (live && !isHidden()) setDraining(true);
		else if (!live && isHidden()) setDraining(false);
	}, [live]);
	useEffect(() => {
		if (typeof document === "undefined") return;
		const onVis = () => {
			if (!liveRef.current) setDraining(false);
		};
		document.addEventListener("visibilitychange", onVis);
		return () => document.removeEventListener("visibilitychange", onVis);
	}, []);
	const handleStreamSettled = useCallback(() => {
		if (!liveRef.current) setDraining(false);
	}, []);
	const activeStream = live || draining;

	const displayedThinking = useSmoothStreamText(thinking, activeStream, !live && draining, handleStreamSettled);
	const bodyText = formatThinkingBody(displayedThinking);
	// 折叠预览：流式中取最新文本（实时最后一行），结束后取首句实质思路。
	const preview = thinkingPreview(displayedThinking, activeStream);
	const { copied, copy } = useCopyFeedback({ duration: 1200 });
	const copyThinking = () => {
		void copy(thinking);
	};

	const headTitle = shown ? t("collapseMsg") : preview ? `${t("expandMsg")} · ${preview}` : t("expandMsg");

	const rootRef = useRef<HTMLDivElement>(null);
	const isFlow = isFlowMode(rootRef.current);

	const handleOpenInspector = () => {
		openToolInspector({
			isThinking: true,
			title: t("toolInspectorThinkingTitle"),
			status: activeStream ? t("thinkingNow") : t("done"),
			statusClass: activeStream ? "run" : "ok",
			output: bodyText || thinking,
			thinking,
			streaming: activeStream,
		});
	};

	const handleToggle = () => {
		if (isFlowMode(rootRef.current)) {
			handleOpenInspector();
			return;
		}
		setOpen(!expanded);
	};

	if (isFlow) {
		return (
			<div
				ref={rootRef}
				className={`thinking ${activeStream ? "live run" : "ok"}`}
				data-thinking={thinking}
				onClick={(e) => {
					e.preventDefault();
					e.stopPropagation();
					handleOpenInspector();
				}}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === " ") {
						e.preventDefault();
						handleOpenInspector();
					}
				}}
				role="button"
				tabIndex={0}
				title={t("toolInspectorThinkingTitle")}
			>
				<div className="thinking-head chead">
					<span className="thinking-icon chead-icon">
						<FiCpu />
					</span>
					<span className="thinking-name chead-title">think</span>
					<span
						className="thinking-status toolcall-status"
						title={activeStream ? t("thinkingNow") : t("done")}
						aria-label={activeStream ? t("thinkingNow") : t("done")}
					>
						{activeStream ? <HalfRingSpinner className="spin" /> : <FiCheck />}
					</span>
				</div>
			</div>
		);
	}

	return (
		<div
			ref={rootRef}
			className={`thinking ${shown ? "open" : ""} ${activeStream ? "live" : ""} ${activeStream ? "run" : "ok"}`}
			data-thinking={thinking}
			onClick={(e) => {
				if (!isFlowMode(rootRef.current)) return;
				const target = e.target as HTMLElement | null;
				if (target?.closest(".chead-copy, .toolcall-copy, .thinking-copy, a")) {
					return;
				}
				e.preventDefault();
				e.stopPropagation();
				handleOpenInspector();
			}}
		>
			<CollapsibleHead
				open={!isFlow && shown}
				headClassName={`thinking-head${activeStream ? " thinking-live" : ""}`}
				toggleClassName="thinking-toggle"
				titleText={headTitle}
				onToggle={handleToggle}
				icon={<FiCpu />}
				iconClassName="thinking-icon"
				titleClassName="thinking-label"
				after={
					<>
						<span
							className="thinking-status toolcall-status"
							title={activeStream ? t("thinkingNow") : t("done")}
							aria-label={activeStream ? t("thinkingNow") : t("done")}
						>
							{activeStream ? <HalfRingSpinner className="spin" /> : <FiCheck />}
						</span>
						{/* 卡头右端**只有复制键**：消息级按钮一律落在消息底部的 .msg-actions
						    行（思考卡没有正文，不渲染那一行）。 */}
						<button
							type="button"
							className={`chead-copy toolcall-copy thinking-copy${copied ? " copied" : ""}`}
							title={copied ? t("copied") : t("copyMessage")}
							aria-label={t("copyMessage")}
							onClick={(e) => {
								e.stopPropagation();
								copyThinking();
							}}
						>
							{copied ? <FiCheckCircle /> : <FiCopy />}
						</button>
					</>
				}
			>
				<span className="thinking-name">think</span>
				{activeStream && shown ? (
					<span className="thinking-live-label">
						{t("thinkingNow")}
						<span className="dots" />
					</span>
				) : activeStream ? (
					preview ? (
						<span className="thinking-preview-live">
							<span className="thinking-preview-prefix"> · </span>
							<span className="thinking-preview-viewport">
								<span className="thinking-preview-track">
									{preview}
									<span className="stream-cursor" />
								</span>
							</span>
						</span>
					) : (
						<span className="thinking-live-label">
							{t("thinkingNow")}
							<span className="dots" />
						</span>
					)
				) : preview ? (
					<span className="thinking-summary-text"> · {preview}</span>
				) : null}
			</CollapsibleHead>
			{!isFlow && shown && (
				<div className="thinking-body">
					{bodyText}
					{activeStream && <span className="stream-cursor" />}
				</div>
			)}
		</div>
	);
}
