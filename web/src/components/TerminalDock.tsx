import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { FiX } from "react-icons/fi";
import { useT } from "../i18n";

const OPEN_KEY = "pi-web-ui:term-dock-open";
const HEIGHT_KEY = "pi-web-ui:term-dock-height";
export const TERM_DOCK_MIN = 120;
export const TERM_DOCK_DEFAULT = 280;

function readNum(key: string, fallback: number): number {
	try {
		const n = Number(localStorage.getItem(key));
		return Number.isFinite(n) && n > 0 ? n : fallback;
	} catch {
		return fallback;
	}
}

export function readTermDockOpen(): boolean {
	try {
		return localStorage.getItem(OPEN_KEY) === "1";
	} catch {
		return false;
	}
}

export function saveTermDockOpen(open: boolean): void {
	try {
		localStorage.setItem(OPEN_KEY, open ? "1" : "0");
	} catch {
		/* ignore */
	}
}

/** 高度钳制：不小于 TERM_DOCK_MIN，不超过视口的 70%。 */
export function clampDockHeight(h: number, viewport: number): number {
	const max = Math.max(TERM_DOCK_MIN, Math.floor(viewport * 0.7));
	return Math.min(max, Math.max(TERM_DOCK_MIN, Math.round(h)));
}

/**
 * 底部终端面板（redesign P2 §8）：Ctrl+` 展开/收起，顶边拖拽调高度，记住高度与开关。
 * 首次打开才挂载内容（xterm 很重），之后收起只是隐藏，保留终端会话与滚动缓冲。
 */
export function TerminalDock({ open, onClose, children }: { open: boolean; onClose: () => void; children: ReactNode }) {
	const t = useT();
	const [height, setHeight] = useState(() =>
		clampDockHeight(readNum(HEIGHT_KEY, TERM_DOCK_DEFAULT), window.innerHeight),
	);
	const visited = useRef(open);
	if (open) visited.current = true;
	const drag = useRef<{ startY: number; startH: number } | null>(null);

	const onPointerDown = useCallback(
		(e: React.PointerEvent<HTMLDivElement>) => {
			e.preventDefault();
			(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
			drag.current = { startY: e.clientY, startH: height };
		},
		[height],
	);
	const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
		const d = drag.current;
		if (!d) return;
		setHeight(clampDockHeight(d.startH + (d.startY - e.clientY), window.innerHeight));
	}, []);
	const onPointerUp = useCallback(() => {
		if (!drag.current) return;
		drag.current = null;
		setHeight((h) => {
			try {
				localStorage.setItem(HEIGHT_KEY, String(h));
			} catch {
				/* ignore */
			}
			return h;
		});
		// xterm 按容器尺寸重排
		window.dispatchEvent(new Event("resize"));
	}, []);

	useEffect(() => {
		if (open) window.dispatchEvent(new Event("resize"));
	}, [open]);

	useEffect(() => {
		const onResize = () => setHeight((h) => clampDockHeight(h, window.innerHeight));
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	if (!visited.current) return null;
	return (
		<section
			className={`term-dock${open ? "" : " hidden"}`}
			style={{ height }}
			aria-label={t("terminal")}
			data-testid="terminal-dock"
		>
			<div
				className="term-dock-resize"
				role="separator"
				aria-orientation="horizontal"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
				onPointerCancel={onPointerUp}
				onDoubleClick={() => setHeight(clampDockHeight(TERM_DOCK_DEFAULT, window.innerHeight))}
			/>
			<button
				type="button"
				className="term-dock-close"
				onClick={onClose}
				title={`${t("close")} (Ctrl+\`)`}
				aria-label={t("close")}
				data-testid="terminal-dock-close"
			>
				<FiX />
			</button>
			<div className="term-dock-body">{children}</div>
		</section>
	);
}
