import { useCallback, useEffect, useState } from "react";
import { getDesktopQuitBridge } from "../desktop";
import { useT } from "../i18n";
import { Modal } from "./Modal";

/**
 * 桌面版退出确认（redesign P1）。
 *
 * 主进程在用户关窗 / Cmd+Q / Alt+F4 时先问 server 是否有正在执行的会话；有则经
 * preload 发来 {id, active}，这里弹应用内确认框，把用户决定回传主进程。
 * 浏览器 / 旧版桌面壳拿不到 bridge，组件渲染为空。
 */
export function DesktopQuitConfirm() {
	const t = useT();
	const [req, setReq] = useState<{ id: number; active: number } | null>(null);

	useEffect(() => {
		const bridge = getDesktopQuitBridge();
		if (!bridge) return;
		return bridge.onConfirmRequest((r) => setReq(r));
	}, []);

	const decide = useCallback(
		(ok: boolean) => {
			if (!req) return;
			const bridge = getDesktopQuitBridge();
			setReq(null);
			void bridge?.decide(req.id, ok);
		},
		[req],
	);

	if (!req) return null;
	return (
		<Modal
			onClose={() => decide(false)}
			title={t("desktopQuitTitle")}
			className="desktop-quit-modal"
			showCloseButton={false}
			ariaLabel={t("desktopQuitTitle")}
		>
			<div className="modal-body" data-testid="desktop-quit-confirm">
				<p>{t("desktopQuitBody", { n: req.active })}</p>
				<div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 16 }}>
					<button
						type="button"
						className="btn secondary"
						data-testid="desktop-quit-cancel"
						autoFocus
						onClick={() => decide(false)}
					>
						{t("desktopQuitCancel")}
					</button>
					<button
						type="button"
						className="btn primary"
						data-testid="desktop-quit-confirm-btn"
						onClick={() => decide(true)}
					>
						{t("desktopQuitConfirm")}
					</button>
				</div>
			</div>
		</Modal>
	);
}
