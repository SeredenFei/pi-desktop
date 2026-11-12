import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { TextQuote } from "../types";
import { useT } from "../i18n";
import { readQuoteSelection } from "../quote-selection";
import { composeToComposer, focusComposer } from "../composer-bridge";
import { openSideChatFromSelection } from "../side-chat-store";
import { randomUuid } from "../uuid";

export function SelectionQuoteButton({
	rootRef,
	sessionId,
	enabled = true,
	onSelect,
}: {
	rootRef: RefObject<HTMLDivElement | null>;
	sessionId: string;
	enabled?: boolean;
	onSelect?: () => void;
}) {
	const t = useT();
	const [pending, setPending] = useState<{ quote: TextQuote; left: number; top: number } | null>(null);
	useEffect(() => {
		setPending(null);
		const root = rootRef.current;
		if (!root || !enabled) return;
		let selecting = false;
		let frame = 0;
		const clear = () => {
			cancelAnimationFrame(frame);
			setPending(null);
		};
		const update = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const selection = window.getSelection();
				const quote = readQuoteSelection(root, selection, sessionId);
				if (!quote || !selection) {
					setPending(null);
					return;
				}
				const rect = selection.getRangeAt(0).getBoundingClientRect();
				if (!rect.width && !rect.height) {
					setPending(null);
					return;
				}
				onSelect?.();
				setPending({
					quote,
					left: Math.max(8, Math.min(rect.right - 168, window.innerWidth - 184)),
					top: Math.max(8, Math.min(rect.top >= 44 ? rect.top - 40 : rect.bottom + 8, window.innerHeight - 42)),
				});
			});
		};
		const down = (event: MouseEvent) => {
			if ((event.target as Element)?.closest?.(".selection-floating-bar, .quote-selection-button")) return;
			selecting = event.button === 0 && root.contains(event.target as Node);
			clear();
		};
		const up = (event: MouseEvent) => {
			selecting = false;
			if (event.button === 0) update();
		};
		const change = () => {
			if (!selecting) update();
		};
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") clear();
		};
		document.addEventListener("mousedown", down);
		document.addEventListener("mouseup", up);
		document.addEventListener("selectionchange", change);
		document.addEventListener("keydown", key);
		window.addEventListener("scroll", clear, true);
		window.addEventListener("resize", clear);
		window.addEventListener("blur", clear);
		return () => {
			cancelAnimationFrame(frame);
			document.removeEventListener("mousedown", down);
			document.removeEventListener("mouseup", up);
			document.removeEventListener("selectionchange", change);
			document.removeEventListener("keydown", key);
			window.removeEventListener("scroll", clear, true);
			window.removeEventListener("resize", clear);
			window.removeEventListener("blur", clear);
		};
	}, [rootRef, sessionId, enabled, onSelect]);
	if (!pending || !enabled || pending.quote.sessionId !== sessionId) return null;
	return createPortal(
		<div className="selection-floating-bar" style={{ left: pending.left, top: pending.top }}>
			<button
				type="button"
				className="side-chat-selection-button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					openSideChatFromSelection({
						selectedText: pending.quote.text,
						messageId: pending.quote.messageId,
						role: pending.quote.role,
					});
					setPending(null);
					window.getSelection()?.removeAllRanges();
				}}
			>
				<span aria-hidden="true">💬</span> {t("sideChatShort")}
			</button>
			<span className="selection-floating-sep" aria-hidden="true" />
			<button
				type="button"
				className="quote-selection-button"
				onMouseDown={(event) => event.preventDefault()}
				onClick={() => {
					const accepted = composeToComposer({
						attachments: [{ path: "", name: t("quoteText"), mode: "quote", quote: pending.quote, key: randomUuid() }],
					});
					if (!accepted) return;
					setPending(null);
					window.getSelection()?.removeAllRanges();
					focusComposer();
				}}
			>
				<span aria-hidden="true">↪</span> {t("quoteSelection")}
			</button>
		</div>,
		document.body,
	);
}
