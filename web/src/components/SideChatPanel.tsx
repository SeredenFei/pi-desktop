import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
	FiCheck,
	FiCompass,
	FiCopy,
	FiCornerDownLeft,
	FiExternalLink,
	FiGlobe,
	FiMessageSquare,
	FiPlus,
	FiSearch,
	FiSend,
	FiSquare,
	FiTrash2,
	FiX,
	FiZap,
} from "react-icons/fi";
import type { ModelInfo } from "../types";
import { useT } from "../i18n";
import { Markdown } from "./Markdown";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { copyTextToClipboard } from "../use-copy-feedback";
import { randomUuid } from "../uuid";
import {
	abortSideChatStream,
	askSideChat,
	clearSideChatDraftAnchor,
	deleteSideChatThread,
	jumpToSideChatAnchor,
	promoteSideChatToMain,
	selectSideChatThread,
	setSideChatContextMode,
	setSideChatPinnedModel,
	startBlankSideChatDraft,
	useSideChatState,
	type SideChatContextMode,
	type SideChatToolTrace,
} from "../side-chat-store";

interface SideChatPanelProps {
	models?: ModelInfo[];
}

function formatShortModel(spec: string): string {
	if (!spec) return "";
	const slash = spec.indexOf("/");
	return slash >= 0 ? spec.slice(slash + 1) : spec;
}

function ToolTraceList({ tools }: { tools?: SideChatToolTrace[] }) {
	if (!tools || tools.length === 0) return null;
	return (
		<div className="side-chat-tools">
			{tools.map((tool) => (
				<span
					key={tool.id}
					className={`side-chat-tool-chip is-${tool.status}`}
					title={`${tool.name}${tool.argsPreview ? `: ${tool.argsPreview}` : ""}`}
				>
					<span className="side-chat-tool-dot" aria-hidden="true" />
					<span className="side-chat-tool-name">{tool.name}</span>
					{tool.argsPreview && <span className="side-chat-tool-arg">{tool.argsPreview}</span>}
				</span>
			))}
		</div>
	);
}

export const SideChatPanel = memo(function SideChatPanel({ models = [] }: SideChatPanelProps) {
	const t = useT();
	const snap = useSideChatState();
	const [input, setInput] = useState("");
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const [promoting, setPromoting] = useState(false);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const copyTimerRef = useRef<number>(0);

	const activeThread = useMemo(
		() => (snap.activeThreadId ? (snap.threads.find((th) => th.id === snap.activeThreadId) ?? null) : null),
		[snap.activeThreadId, snap.threads],
	);

	const streamKey = activeThread?.id ?? "__draft__";
	const liveStream = snap.streamingByThread[streamKey] ?? null;
	const isStreaming = Boolean(liveStream);

	const effectiveAnchor = activeThread ? activeThread.anchor : snap.draftAnchor;
	const effectiveContextMode: SideChatContextMode = activeThread ? activeThread.contextMode : snap.draftContextMode;
	const effectivePinnedModel = (activeThread?.model ?? snap.pinnedModel).trim();

	useEffect(() => {
		if (snap.focusNonce > 0) {
			requestAnimationFrame(() => {
				textareaRef.current?.focus();
			});
		}
	}, [snap.focusNonce]);

	// 流式输出或新增消息时保持贴底滚动
	useEffect(() => {
		const el = scrollRef.current;
		if (!el) return;
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
		if (distanceFromBottom < 140 || isStreaming) {
			el.scrollTop = el.scrollHeight;
		}
	}, [activeThread?.messages.length, liveStream?.text, liveStream?.tools.length, isStreaming]);

	useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

	const handleCopy = async (id: string, text: string) => {
		const ok = await copyTextToClipboard(text);
		if (!ok) return;
		window.clearTimeout(copyTimerRef.current);
		setCopiedId(id);
		copyTimerRef.current = window.setTimeout(() => setCopiedId(null), 1500);
	};

	const handleQuoteToMain = (text: string) => {
		if (!text.trim()) return;
		const accepted = composeToComposer({
			attachments: [
				{
					path: "",
					name: t("quoteText"),
					mode: "quote",
					quote: {
						text,
						messageId: effectiveAnchor?.messageId || "side-chat",
						role: "assistant",
						...(snap.mainSessionId ? { sessionId: snap.mainSessionId } : {}),
					},
					key: randomUuid(),
				},
			],
		});
		if (accepted) focusComposer();
	};

	const handleSend = () => {
		const q = input.trim();
		if (!q || isStreaming) return;
		setInput("");
		void askSideChat(q);
	};

	const handleQuickPrompt = (promptText: string) => {
		if (isStreaming) return;
		void askSideChat(promptText);
	};

	const handlePromote = async () => {
		if (!activeThread || promoting) return;
		setPromoting(true);
		try {
			await promoteSideChatToMain(activeThread.id);
		} finally {
			setPromoting(false);
		}
	};

	const modelOptions = useMemo(() => {
		const seen = new Set<string>();
		const list: Array<{ spec: string; label: string }> = [];
		for (const m of models) {
			const spec = `${m.provider}/${m.id}`;
			if (seen.has(spec)) continue;
			seen.add(spec);
			list.push({
				spec,
				label: `${m.name || m.id} (${m.provider})`,
			});
		}
		return list;
	}, [models]);

	const followLabel = snap.fallbackModel
		? `${t("sideChatFollowMainModel")} (${formatShortModel(snap.fallbackModel)})`
		: t("sideChatFollowMainModel");

	const messages = activeThread?.messages ?? [];

	return (
		<div className="side-chat-panel" data-testid="side-chat-panel">
			{/* 顶栏：话题切换 + 新建 / 升级独立会话 / 删除 */}
			<div className="side-chat-header">
				<select
					className="side-chat-thread-select"
					aria-label={t("sideChatThreadsLabel")}
					value={activeThread?.id ?? "__new__"}
					onChange={(e) => {
						const v = e.target.value;
						if (v === "__new__") startBlankSideChatDraft();
						else selectSideChatThread(v);
					}}
				>
					{!activeThread && (
						<option value="__new__">
							{effectiveAnchor ? `✨ ${t("sideChatNewSelectionThread")}` : `✨ ${t("sideChatNewThread")}`}
						</option>
					)}
					{snap.threads.map((th) => (
						<option key={th.id} value={th.id}>
							💬 {th.title} ({th.messages.filter((m) => m.role === "user").length})
						</option>
					))}
					{activeThread && <option value="__new__">＋ {t("sideChatNewThread")}</option>}
				</select>

				<div className="side-chat-header-actions">
					<button
						type="button"
						className="side-chat-icon-btn"
						title={t("sideChatNewThread")}
						aria-label={t("sideChatNewThread")}
						onClick={startBlankSideChatDraft}
					>
						<FiPlus />
					</button>
					{activeThread && activeThread.messages.length > 0 && (
						<button
							type="button"
							className="side-chat-icon-btn"
							title={t("sideChatPromoteTip")}
							aria-label={t("sideChatPromoteTip")}
							disabled={promoting || isStreaming}
							onClick={() => void handlePromote()}
						>
							<FiExternalLink />
						</button>
					)}
					{activeThread && (
						<button
							type="button"
							className="side-chat-icon-btn danger"
							title={t("sideChatDeleteThread")}
							aria-label={t("sideChatDeleteThread")}
							onClick={() => void deleteSideChatThread(activeThread.id)}
						>
							<FiTrash2 />
						</button>
					)}
				</div>
			</div>

			{/* 锚定选区卡片 + 上下文范围三档切换 */}
			{effectiveAnchor && (
				<div className="side-chat-anchor-card">
					<div className="side-chat-anchor-top">
						<button
							type="button"
							className="side-chat-anchor-jump"
							title={t("sideChatJumpToSource")}
							onClick={() => jumpToSideChatAnchor(effectiveAnchor.messageId)}
						>
							<FiCompass aria-hidden="true" />
							<span className="side-chat-anchor-label">{t("sideChatSelectedExcerpt")}</span>
						</button>
						<div className="side-chat-ctx-pills" role="group" aria-label={t("sideChatContextScope")}>
							{(["selection", "turn", "full"] as const).map((mode) => (
								<button
									key={mode}
									type="button"
									className={`side-chat-ctx-pill${effectiveContextMode === mode ? " active" : ""}`}
									onClick={() => setSideChatContextMode(mode)}
									title={
										mode === "selection"
											? t("sideChatCtxSelectionTip")
											: mode === "turn"
												? t("sideChatCtxTurnTip")
												: t("sideChatCtxFullTip")
									}
								>
									{mode === "selection"
										? t("sideChatCtxSelection")
										: mode === "turn"
											? t("sideChatCtxTurn")
											: t("sideChatCtxFull")}
								</button>
							))}
						</div>
						{!activeThread && (
							<button
								type="button"
								className="side-chat-anchor-clear"
								title={t("clear")}
								aria-label={t("clear")}
								onClick={clearSideChatDraftAnchor}
							>
								<FiX />
							</button>
						)}
					</div>
					{effectiveAnchor.selectedText && (
						<div
							className="side-chat-anchor-excerpt"
							role="button"
							tabIndex={0}
							title={t("sideChatJumpToSource")}
							onClick={() => jumpToSideChatAnchor(effectiveAnchor.messageId)}
							onKeyDown={(e) => {
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									jumpToSideChatAnchor(effectiveAnchor.messageId);
								}
							}}
						>
							{effectiveAnchor.selectedText}
						</div>
					)}
				</div>
			)}

			{/* 消息流 */}
			<div className="side-chat-messages" ref={scrollRef}>
				{messages.length === 0 && !isStreaming && (
					<div className="side-chat-empty">
						<div className="side-chat-empty-icon" aria-hidden="true">
							<FiMessageSquare />
						</div>
						<p className="side-chat-empty-title">
							{effectiveAnchor ? t("sideChatReadyWithSelection") : t("sideChatEmptyHint")}
						</p>
						<p className="side-chat-empty-sub">{t("sideChatReadonlyBadgeTip")}</p>
						{effectiveAnchor && (
							<div className="side-chat-quick-actions">
								<button
									type="button"
									className="side-chat-quick-btn"
									onClick={() => handleQuickPrompt(t("sideChatPromptExplain"))}
								>
									<FiZap aria-hidden="true" />
									<span>{t("sideChatQuickExplain")}</span>
								</button>
								<button
									type="button"
									className="side-chat-quick-btn"
									onClick={() => handleQuickPrompt(t("sideChatPromptTranslate"))}
								>
									<FiGlobe aria-hidden="true" />
									<span>{t("sideChatQuickTranslate")}</span>
								</button>
								<button
									type="button"
									className="side-chat-quick-btn"
									onClick={() => handleQuickPrompt(t("sideChatPromptCheck"))}
								>
									<FiSearch aria-hidden="true" />
									<span>{t("sideChatQuickCheck")}</span>
								</button>
							</div>
						)}
					</div>
				)}

				{messages.map((m) => (
					<div key={m.id} className={`side-chat-msg side-chat-msg-${m.role}`}>
						{m.role === "user" ? (
							<div className="side-chat-bubble-user">
								<Markdown text={m.text} hardBreaks />
							</div>
						) : (
							<div className="side-chat-bubble-assistant">
								<ToolTraceList tools={m.tools} />
								{m.text && (
									<div className="side-chat-md md">
										<Markdown text={m.text} />
									</div>
								)}
								{m.error && <div className="side-chat-msg-error">{m.error}</div>}
								{m.text && (
									<div className="side-chat-msg-actions">
										<button
											type="button"
											className="side-chat-msg-act"
											title={t("copyText")}
											onClick={() => void handleCopy(m.id, m.text)}
										>
											{copiedId === m.id ? <FiCheck /> : <FiCopy />}
											<span>{copiedId === m.id ? t("copied") : t("copy")}</span>
										</button>
										<button
											type="button"
											className="side-chat-msg-act"
											title={t("sideChatQuoteToMain")}
											onClick={() => handleQuoteToMain(m.text)}
										>
											<FiCornerDownLeft />
											<span>{t("sideChatQuoteToMainShort")}</span>
										</button>
									</div>
								)}
							</div>
						)}
					</div>
				))}

				{liveStream && (
					<div className="side-chat-msg side-chat-msg-assistant is-streaming">
						<div className="side-chat-bubble-assistant">
							<ToolTraceList tools={liveStream.tools} />
							{liveStream.text ? (
								<div className="side-chat-md md">
									<Markdown text={liveStream.text} />
								</div>
							) : (
								<div className="side-chat-thinking-dots">{t("sideChatThinking")}</div>
							)}
						</div>
					</div>
				)}

				{snap.error && <div className="side-chat-error-banner">{snap.error}</div>}
			</div>

			{/* 底部输入栏：模型钉选 + 只读标识 + 输入框 */}
			<div className="side-chat-composer">
				<div className="side-chat-composer-bar">
					<select
						className="side-chat-model-select"
						aria-label={t("sideChatModelSelect")}
						value={effectivePinnedModel}
						onChange={(e) => setSideChatPinnedModel(e.target.value)}
						title={t("sideChatModelSelectTip")}
					>
						<option value="">{followLabel}</option>
						{effectivePinnedModel && !modelOptions.some((o) => o.spec === effectivePinnedModel) && (
							<option value={effectivePinnedModel}>{effectivePinnedModel}</option>
						)}
						{modelOptions.map((o) => (
							<option key={o.spec} value={o.spec}>
								📌 {o.label}
							</option>
						))}
					</select>
					<span className="side-chat-readonly-pill" title={t("sideChatReadonlyBadgeTip")}>
						{t("sideChatReadonlyBadge")}
					</span>
				</div>
				<div className="side-chat-input-row">
					<textarea
						ref={textareaRef}
						className="side-chat-textarea"
						rows={2}
						value={input}
						placeholder={effectiveAnchor ? t("sideChatInputPlaceholderSelection") : t("sideChatInputPlaceholder")}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								handleSend();
							}
						}}
					/>
					{isStreaming ? (
						<button
							type="button"
							className="side-chat-send-btn is-stop"
							title={t("stop")}
							aria-label={t("stop")}
							onClick={() => abortSideChatStream(activeThread?.id)}
						>
							<FiSquare />
						</button>
					) : (
						<button
							type="button"
							className="side-chat-send-btn"
							title={t("sideChatSend")}
							aria-label={t("sideChatSend")}
							disabled={!input.trim()}
							onClick={handleSend}
						>
							<FiSend />
						</button>
					)}
				</div>
			</div>
		</div>
	);
});
