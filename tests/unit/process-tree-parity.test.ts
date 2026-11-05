import { describe, expect, it } from "vitest";
import * as desktop from "../../desktop/quit.js";
import * as server from "../../server/process-tree.js";

// desktop/quit.ts 与 server/process-tree.ts 因 rootDir 不同各存一份进程树算法，这里防漂移。
const CASES: [string, number][] = [
	["1 0\n100 1\n200 100\n201 100\n300 200\n999 1\n  400   300  \ngarbage\n", 100],
	["5 4\r\n6 5\r\n", 4],
	["2 3\n3 2\n", 2],
	["7 7\n8 7\n", 7],
	["", 1],
];

describe("process-tree parity (desktop vs server)", () => {
	it.each(CASES)("collectDescendants matches for root case %#", (listing, root) => {
		expect(server.collectDescendants(listing, root)).toEqual(desktop.collectDescendants(listing, root));
	});

	it("sweepSurvivors matches", () => {
		const mk = () => {
			const alive = new Set([2, 4]);
			return (pid: number, sig?: NodeJS.Signals | 0) => {
				if (!alive.has(pid)) throw new Error("ESRCH");
				if (sig === "SIGKILL") alive.delete(pid);
			};
		};
		expect(server.sweepSurvivors([1, 2, 3, 4], mk())).toEqual(
			desktop.sweepSurvivors([1, 2, 3, 4], { platform: "linux", kill: mk() }),
		);
	});

	it("listProcesses picks the same command per platform", async () => {
		for (const platform of ["win32", "linux", "darwin"] as const) {
			const a: string[] = [];
			const b: string[] = [];
			await server.listProcesses(platform, async (cmd, args) => (a.push(cmd, ...args), ""));
			await desktop.listProcesses(platform, async (cmd, args) => (b.push(cmd, ...args), ""));
			expect(a).toEqual(b);
		}
	});
});
