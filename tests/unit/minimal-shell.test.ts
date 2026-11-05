import { describe, expect, it } from "vitest";
import { filterCommands, groupRows, scoreMatch, type PaletteCommand } from "../../web/src/command-palette.js";
import { clampDockHeight, TERM_DOCK_MIN } from "../../web/src/components/TerminalDock.js";
import { resolveScheme } from "../../web/src/shell-mode.js";

const nop = () => {};
const CMDS: PaletteCommand[] = [
	{ id: "new-chat", group: "对话", label: "新对话", keywords: ["new chat"], run: nop },
	{ id: "toggle-term", group: "布局", label: "显示 / 隐藏终端", keywords: ["terminal", "shell"], run: nop },
	{ id: "view-git", group: "视图", label: "Git", keywords: ["scm", "diff"], run: nop },
	{ id: "scheme-light", group: "外观", label: "浅色", keywords: ["light", "theme"], run: nop },
	{ id: "scheme-dark", group: "外观", label: "深色", keywords: ["dark", "theme"], run: nop },
];

describe("command-palette", () => {
	it("returns all commands in order on empty query", () => {
		expect(filterCommands(CMDS, "  ").map((c) => c.id)).toEqual(CMDS.map((c) => c.id));
	});

	it("matches by label, group+label, and English keywords", () => {
		expect(filterCommands(CMDS, "浅色")[0]?.id).toBe("scheme-light");
		expect(filterCommands(CMDS, "外观 深")[0]?.id).toBe("scheme-dark");
		expect(filterCommands(CMDS, "shell")[0]?.id).toBe("toggle-term");
		expect(filterCommands(CMDS, "scm")[0]?.id).toBe("view-git");
	});

	it("prefers prefix/substring hits over scattered subsequence hits", () => {
		expect(scoreMatch("Git", "git")).toBeGreaterThan(scoreMatch("Get more", "git"));
	});

	it("groups consecutive items by group title", () => {
		expect(groupRows(CMDS).map((g) => [g.group, g.items.length])).toEqual([
			["对话", 1],
			["布局", 1],
			["视图", 1],
			["外观", 2],
		]);
	});
});

describe("shell-mode & terminal-dock helpers", () => {
	it("resolveScheme respects explicit light/dark and falls back to system", () => {
		expect(resolveScheme("light", true)).toBe("light");
		expect(resolveScheme("dark", false)).toBe("dark");
		expect(resolveScheme("system", true)).toBe("dark");
		expect(resolveScheme("system", false)).toBe("light");
	});

	it("clampDockHeight bounds between TERM_DOCK_MIN and 70% of viewport", () => {
		expect(clampDockHeight(20, 900)).toBe(TERM_DOCK_MIN);
		expect(clampDockHeight(300, 900)).toBe(300);
		expect(clampDockHeight(900, 900)).toBe(630);
	});
});
