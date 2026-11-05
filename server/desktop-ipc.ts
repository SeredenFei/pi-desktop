/**
 * Desktop shell ⇄ server sidecar IPC (redesign P1, docs/redesign-plan.md §4).
 *
 * Only active when the Electron shell spawned us with an IPC channel
 * (`stdio: [..., "ipc"]`) AND set `PI_WEB_DESKTOP_IPC=1`. Browser / CLI /
 * system-service launches never have both, so this is a no-op there.
 *
 * Protocol (JSON over Node IPC):
 *   → { type: "status", id }   ← { type: "status", id, activeConversations }
 *   → { type: "shutdown" }      (graceful shutdown, same path as SIGTERM)
 *   parent disconnect           (Electron crashed / was killed) → shutdown
 */

export interface DesktopIpcDeps {
	/** Conversations with an in-flight run. */
	activeConversations: () => number;
	/** Graceful shutdown (idempotent-ish: second call force-exits). */
	shutdown: () => void;
	/** Whether a shutdown is already running. */
	isShuttingDown: () => boolean;
}

/** Minimal slice of `process` we need — injectable for unit tests. */
export interface DesktopIpcProcess {
	env: Record<string, string | undefined>;
	send?: (msg: unknown) => boolean;
	on(event: "message", cb: (msg: unknown) => void): unknown;
	on(event: "disconnect", cb: () => void): unknown;
}

export function wireDesktopIpc(deps: DesktopIpcDeps, proc: DesktopIpcProcess = process as DesktopIpcProcess): boolean {
	if (proc.env.PI_WEB_DESKTOP_IPC !== "1" || typeof proc.send !== "function") return false;
	proc.on("message", (raw: unknown) => {
		const msg = raw as { type?: unknown; id?: unknown } | null;
		if (!msg || typeof msg !== "object") return;
		if (msg.type === "status") {
			let active = 0;
			try {
				active = deps.activeConversations();
			} catch {
				// session pool being torn down — report idle rather than hang the quit
			}
			try {
				proc.send?.({ type: "status", id: msg.id, activeConversations: active });
			} catch {
				// channel closed mid-reply: parent is gone, disconnect handler takes over
			}
		} else if (msg.type === "shutdown") {
			if (!deps.isShuttingDown()) deps.shutdown();
		}
	});
	proc.on("disconnect", () => {
		if (deps.isShuttingDown()) return;
		console.log("[desktop-ipc] 桌面壳已断开，server 自行退出");
		deps.shutdown();
	});
	return true;
}
