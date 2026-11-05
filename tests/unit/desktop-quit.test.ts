import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
	collectDescendants,
	killProcessTree,
	queryActiveConversations,
	shutdownSidecar,
	sweepSurvivors,
	type RunCommand,
	type SidecarLike,
} from "../../desktop/quit.js";

const LISTING = ["1 0", "100 1", "200 100", "201 100", "300 200", "999 1", "  400   300  ", "garbage", ""].join("\n");

describe("collectDescendants", () => {
	it("returns the full subtree, excluding root and unrelated pids", () => {
		expect(collectDescendants(LISTING, 100).sort((a, b) => a - b)).toEqual([200, 201, 300, 400]);
	});
	it("handles CRLF and unknown roots", () => {
		expect(collectDescendants("5 4\r\n6 5\r\n", 4)).toEqual([5, 6]);
		expect(collectDescendants(LISTING, 12345)).toEqual([]);
	});
	it("does not loop on cycles", () => {
		expect(collectDescendants("2 3\n3 2\n", 2)).toEqual([3]);
	});
});

describe("killProcessTree", () => {
	it("uses taskkill /F /T on Windows", async () => {
		const run = vi.fn<RunCommand>(async () => "");
		await killProcessTree(42, { platform: "win32", run });
		expect(run).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "42"], expect.any(Number));
	});
	it("SIGKILLs root and every descendant on POSIX", async () => {
		const run = vi.fn<RunCommand>(async () => LISTING);
		const kill = vi.fn();
		await killProcessTree(100, { platform: "linux", run, kill });
		const killed = kill.mock.calls.map((c) => c[0]).sort((a, b) => a - b);
		expect(killed).toEqual([100, 200, 201, 300, 400]);
		expect(kill.mock.calls.every((c) => c[1] === "SIGKILL")).toBe(true);
	});
});

describe("sweepSurvivors", () => {
	it("kills only pids that are still alive", () => {
		const alive = new Set([2, 4]);
		const kill = vi.fn((pid: number, sig?: NodeJS.Signals | 0) => {
			if (!alive.has(pid)) throw new Error("ESRCH");
			if (sig === "SIGKILL") alive.delete(pid);
		});
		expect(sweepSurvivors([1, 2, 3, 4], { platform: "linux", kill })).toEqual([2, 4]);
	});
});

class FakeChild extends EventEmitter implements SidecarLike {
	pid = 100;
	connected = true;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	sent: unknown[] = [];
	onSend: (msg: unknown) => void = () => {};
	send(msg: unknown): boolean {
		this.sent.push(msg);
		this.onSend(msg);
		return true;
	}
	exit(code = 0) {
		this.exitCode = code;
		this.connected = false;
		this.emit("exit");
	}
}

describe("queryActiveConversations", () => {
	it("returns the server's answer for the matching id", async () => {
		const c = new FakeChild();
		c.onSend = (m) => {
			const msg = m as { id: number };
			setTimeout(() => {
				c.emit("message", { type: "status", id: msg.id + 1000, activeConversations: 99 });
				c.emit("message", { type: "status", id: msg.id, activeConversations: 2 });
			}, 1);
		};
		await expect(queryActiveConversations(c)).resolves.toBe(2);
	});
	it("returns 0 on timeout / no channel / null child", async () => {
		const c = new FakeChild();
		await expect(queryActiveConversations(c, 20)).resolves.toBe(0);
		c.connected = false;
		await expect(queryActiveConversations(c)).resolves.toBe(0);
		await expect(queryActiveConversations(null)).resolves.toBe(0);
	});
});

describe("shutdownSidecar", () => {
	it("graceful: sends shutdown, server exits, survivors swept", async () => {
		const c = new FakeChild();
		c.onSend = (m) => {
			if ((m as { type: string }).type === "shutdown") setTimeout(() => c.exit(0), 5);
		};
		const run = vi.fn<RunCommand>(async () => LISTING);
		const alive = new Set([300]); // 一个孙进程没被 server 收掉
		const kill = vi.fn((pid: number, sig?: NodeJS.Signals | 0) => {
			if (!alive.has(pid)) throw new Error("ESRCH");
			if (sig === "SIGKILL") alive.delete(pid);
		});
		const r = await shutdownSidecar(c, { platform: "linux", run, kill, graceMs: 500 });
		expect(c.sent).toContainEqual({ type: "shutdown" });
		expect(r).toEqual({ mode: "graceful", swept: [300] });
	});

	it("timeout: falls back to tree kill", async () => {
		const c = new FakeChild();
		const run = vi.fn<RunCommand>(async (cmd) => {
			if (cmd === "taskkill") setTimeout(() => c.exit(1), 1);
			return "100 1\n200 100\n";
		});
		const kill = vi.fn(() => {
			throw new Error("ESRCH");
		});
		const r = await shutdownSidecar(c, { platform: "win32", run, kill, graceMs: 20 });
		expect(r.mode).toBe("killed");
		expect(run).toHaveBeenCalledWith("taskkill", ["/F", "/T", "/PID", "100"], expect.any(Number));
	});

	it("short-circuits for exited / missing child", async () => {
		const c = new FakeChild();
		c.exitCode = 0;
		await expect(shutdownSidecar(c, { platform: "linux" })).resolves.toEqual({ mode: "already-exited", swept: [] });
		await expect(shutdownSidecar(null, { platform: "linux" })).resolves.toEqual({ mode: "no-pid", swept: [] });
	});
});
