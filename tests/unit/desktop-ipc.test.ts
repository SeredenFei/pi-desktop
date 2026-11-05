import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { wireDesktopIpc, type DesktopIpcProcess } from "../../server/desktop-ipc.js";

function fakeProc(env: Record<string, string | undefined>, withSend = true) {
	const em = new EventEmitter();
	const sent: unknown[] = [];
	const proc = {
		env,
		send: withSend ? (m: unknown) => (sent.push(m), true) : undefined,
		on: (ev: string, cb: (...a: unknown[]) => void) => em.on(ev, cb),
	} as unknown as DesktopIpcProcess;
	return { proc, em, sent };
}

function deps(active = 0) {
	let shutting = false;
	const shutdown = vi.fn(() => {
		shutting = true;
	});
	return { activeConversations: () => active, shutdown, isShuttingDown: () => shutting };
}

describe("wireDesktopIpc", () => {
	it("is a no-op without PI_WEB_DESKTOP_IPC=1", () => {
		const { proc } = fakeProc({});
		expect(wireDesktopIpc(deps(), proc)).toBe(false);
	});

	it("is a no-op without an IPC channel", () => {
		const { proc } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" }, false);
		expect(wireDesktopIpc(deps(), proc)).toBe(false);
	});

	it("answers status with activeConversations and echoes id", () => {
		const { proc, em, sent } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		expect(wireDesktopIpc(deps(3), proc)).toBe(true);
		em.emit("message", { type: "status", id: 7 });
		expect(sent).toEqual([{ type: "status", id: 7, activeConversations: 3 }]);
	});

	it("reports 0 when activeConversations throws", () => {
		const { proc, em, sent } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		wireDesktopIpc(
			{
				activeConversations: () => {
					throw new Error("tearing down");
				},
				shutdown: () => {},
				isShuttingDown: () => false,
			},
			proc,
		);
		em.emit("message", { type: "status", id: 1 });
		expect(sent).toEqual([{ type: "status", id: 1, activeConversations: 0 }]);
	});

	it("shutdown message triggers shutdown once", () => {
		const { proc, em } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		const d = deps();
		wireDesktopIpc(d, proc);
		em.emit("message", { type: "shutdown" });
		em.emit("message", { type: "shutdown" });
		expect(d.shutdown).toHaveBeenCalledTimes(1);
	});

	it("parent disconnect triggers shutdown unless already shutting down", () => {
		const a = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		const d1 = deps();
		wireDesktopIpc(d1, a.proc);
		a.em.emit("disconnect");
		expect(d1.shutdown).toHaveBeenCalledTimes(1);

		const b = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		const d2 = deps();
		wireDesktopIpc(d2, b.proc);
		b.em.emit("message", { type: "shutdown" });
		b.em.emit("disconnect");
		expect(d2.shutdown).toHaveBeenCalledTimes(1);
	});

	it("ignores junk messages", () => {
		const { proc, em, sent } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		const d = deps();
		wireDesktopIpc(d, proc);
		em.emit("message", null);
		em.emit("message", "shutdown");
		em.emit("message", { type: "nope" });
		expect(sent).toEqual([]);
		expect(d.shutdown).not.toHaveBeenCalled();
	});
});

describe("wireDesktopIpc orphan sweep", () => {
	it("runs prepareOrphanSweep before shutdown on disconnect", async () => {
		const { proc, em } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		const order: string[] = [];
		const d = deps();
		d.shutdown.mockImplementation(() => order.push("shutdown"));
		wireDesktopIpc(
			{
				...d,
				prepareOrphanSweep: async () => {
					await new Promise((r) => setTimeout(r, 5));
					order.push("prepare");
				},
			},
			proc,
		);
		em.emit("disconnect");
		expect(order).toEqual([]);
		await new Promise((r) => setTimeout(r, 30));
		expect(order).toEqual(["prepare", "shutdown"]);
	});

	it("still shuts down when prepareOrphanSweep rejects", async () => {
		const { proc, em } = fakeProc({ PI_WEB_DESKTOP_IPC: "1" });
		const d = deps();
		wireDesktopIpc({ ...d, prepareOrphanSweep: () => Promise.reject(new Error("ps failed")) }, proc);
		em.emit("disconnect");
		await new Promise((r) => setTimeout(r, 10));
		expect(d.shutdown).toHaveBeenCalledTimes(1);
	});
});
