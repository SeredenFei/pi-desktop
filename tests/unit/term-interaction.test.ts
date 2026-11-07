import { describe, expect, it } from "vitest";
import {
	DEFAULT_TERM_INTERACTION,
	TERM_FONT_SIZE_DEFAULT,
	TERM_FONT_SIZE_MAX,
	TERM_FONT_SIZE_MIN,
	applyZoomShortcut,
	clampTermFontSize,
	isLinkModifier,
	isSafeTermLink,
	isSelectionMouseDown,
	matchTermShortcut,
	normalizeTermInteraction,
	rightClickAction,
} from "../../web/src/term-interaction";

describe("normalizeTermInteraction", () => {
	it("falls back to defaults (everything on, 13px) for garbage", () => {
		for (const raw of [null, undefined, "x", 1, []]) {
			expect(normalizeTermInteraction(raw)).toEqual(DEFAULT_TERM_INTERACTION);
		}
		expect(DEFAULT_TERM_INTERACTION).toMatchObject({ copyOnSelect: true, middlePaste: true, fontSize: 13 });
	});
	it("keeps valid fields and repairs bad ones individually", () => {
		const out = normalizeTermInteraction({ copyOnSelect: false, search: "yes", fontSize: 99 });
		expect(out.copyOnSelect).toBe(false);
		expect(out.search).toBe(true);
		expect(out.fontSize).toBe(TERM_FONT_SIZE_MAX);
	});
});

describe("clampTermFontSize / applyZoomShortcut", () => {
	it("clamps, rounds and rejects non-numbers", () => {
		expect(clampTermFontSize(2)).toBe(TERM_FONT_SIZE_MIN);
		expect(clampTermFontSize(100)).toBe(TERM_FONT_SIZE_MAX);
		expect(clampTermFontSize(14.4)).toBe(14);
		expect(clampTermFontSize("14")).toBe(TERM_FONT_SIZE_DEFAULT);
		expect(clampTermFontSize(Number.NaN)).toBe(TERM_FONT_SIZE_DEFAULT);
	});
	it("steps by 1, stops at the bounds, resets to default", () => {
		expect(applyZoomShortcut(13, "zoomIn")).toBe(14);
		expect(applyZoomShortcut(13, "zoomOut")).toBe(12);
		expect(applyZoomShortcut(TERM_FONT_SIZE_MAX, "zoomIn")).toBe(TERM_FONT_SIZE_MAX);
		expect(applyZoomShortcut(TERM_FONT_SIZE_MIN, "zoomOut")).toBe(TERM_FONT_SIZE_MIN);
		expect(applyZoomShortcut(20, "zoomReset")).toBe(TERM_FONT_SIZE_DEFAULT);
	});
});

describe("matchTermShortcut", () => {
	it("search: Ctrl+Shift+F off macOS, Cmd+F on macOS; plain Ctrl+F stays with the shell", () => {
		expect(matchTermShortcut({ key: "F", ctrlKey: true, shiftKey: true }, false)).toBe("search");
		expect(matchTermShortcut({ key: "f", ctrlKey: true }, false)).toBeNull();
		expect(matchTermShortcut({ key: "f", metaKey: true }, true)).toBe("search");
		expect(matchTermShortcut({ key: "f", ctrlKey: true, shiftKey: true }, true)).toBeNull();
		expect(matchTermShortcut({ key: "f", metaKey: true }, false)).toBeNull();
	});
	it("zoom: = and + enlarge, - shrinks, 0 resets; modifier is Cmd on macOS, Ctrl elsewhere", () => {
		expect(matchTermShortcut({ key: "=", ctrlKey: true }, false)).toBe("zoomIn");
		expect(matchTermShortcut({ key: "+", ctrlKey: true, shiftKey: true }, false)).toBe("zoomIn");
		expect(matchTermShortcut({ key: "-", ctrlKey: true }, false)).toBe("zoomOut");
		expect(matchTermShortcut({ key: "0", ctrlKey: true }, false)).toBe("zoomReset");
		expect(matchTermShortcut({ key: "=", metaKey: true }, true)).toBe("zoomIn");
		expect(matchTermShortcut({ key: "-", ctrlKey: true }, true)).toBeNull();
		expect(matchTermShortcut({ key: "-", metaKey: true }, false)).toBeNull();
	});
	it("ignores Alt combos, shifted -/0 (Ctrl+_ is readline undo) and unrelated keys", () => {
		expect(matchTermShortcut({ key: "=", ctrlKey: true, altKey: true }, false)).toBeNull();
		expect(matchTermShortcut({ key: "_", ctrlKey: true, shiftKey: true }, false)).toBeNull();
		expect(matchTermShortcut({ key: "-", ctrlKey: true, shiftKey: true }, false)).toBeNull();
		expect(matchTermShortcut({ key: "c", ctrlKey: true }, false)).toBeNull();
		expect(matchTermShortcut({ key: "v", ctrlKey: true, shiftKey: true }, false)).toBeNull();
		expect(matchTermShortcut({}, false)).toBeNull();
	});
});

describe("rightClickAction", () => {
	it("copies with a selection, pastes without, defers to the native menu when the clipboard is unreadable", () => {
		expect(rightClickAction(true, true)).toBe("copy");
		expect(rightClickAction(true, false)).toBe("copy");
		expect(rightClickAction(false, true)).toBe("paste");
		expect(rightClickAction(false, false)).toBe("native");
	});
});

describe("isSelectionMouseDown", () => {
	it("only the plain left button starts a copy-on-select press; macOS Ctrl+click is a right click", () => {
		expect(isSelectionMouseDown({ button: 0 }, false)).toBe(true);
		expect(isSelectionMouseDown({ button: 0, ctrlKey: true }, false)).toBe(true);
		expect(isSelectionMouseDown({ button: 0, ctrlKey: true }, true)).toBe(false);
		expect(isSelectionMouseDown({ button: 1 }, false)).toBe(false);
		expect(isSelectionMouseDown({ button: 2 }, true)).toBe(false);
	});
});

describe("links", () => {
	it("requires Ctrl or Cmd", () => {
		expect(isLinkModifier({ ctrlKey: true })).toBe(true);
		expect(isLinkModifier({ metaKey: true })).toBe(true);
		expect(isLinkModifier({})).toBe(false);
	});
	it("allows only plain http(s) URLs", () => {
		expect(isSafeTermLink("https://example.com/a?b=1")).toBe(true);
		expect(isSafeTermLink("http://localhost:3000")).toBe(true);
		expect(isSafeTermLink("javascript:alert(1)")).toBe(false);
		expect(isSafeTermLink("file:///etc/passwd")).toBe(false);
		expect(isSafeTermLink("https://user:pw@evil.com")).toBe(false);
		expect(isSafeTermLink("not a url")).toBe(false);
	});
});
