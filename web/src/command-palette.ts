/**
 * 命令面板的纯逻辑（redesign P2 §11）：命令模型 + 过滤排序。组件见 components/CommandPalette.tsx。
 */

export interface PaletteCommand {
	id: string;
	label: string;
	/** 分组标题（如「对话」「视图」「外观」）。 */
	group: string;
	/** 额外的匹配词（英文名、拼音缩写、旧按钮名等），不显示。 */
	keywords?: string[];
	/** 右侧提示：快捷键或当前值。 */
	hint?: string;
	/** 当前处于选中/开启态（外观 · 深色 等），列表里显示 ✓。 */
	checked?: boolean;
	run: () => void;
}

/** 子序列匹配得分：连续命中、词首命中加分；不匹配返回 -1。 */
export function scoreMatch(text: string, query: string): number {
	const s = text.toLowerCase();
	const q = query.toLowerCase().trim();
	if (!q) return 0;
	const idx = s.indexOf(q);
	if (idx >= 0) return 1000 - idx * 2 + (idx === 0 || /[\s:·/-]/.test(s[idx - 1] ?? "") ? 200 : 0);
	let si = 0;
	let score = 0;
	let streak = 0;
	for (const ch of q) {
		if (ch === " ") continue;
		const found = s.indexOf(ch, si);
		if (found < 0) return -1;
		streak = found === si ? streak + 1 : 0;
		score += 10 + streak * 5;
		si = found + 1;
	}
	return score;
}

/** 过滤 + 排序：空查询保持原顺序（按分组）；有查询时按得分降序。 */
export function filterCommands(commands: PaletteCommand[], query: string): PaletteCommand[] {
	if (!query.trim()) return commands;
	const scored: { c: PaletteCommand; s: number; i: number }[] = [];
	commands.forEach((c, i) => {
		const hay = [c.label, `${c.group} ${c.label}`, ...(c.keywords ?? [])];
		const s = Math.max(...hay.map((h) => scoreMatch(h, query)));
		if (s >= 0) scored.push({ c, s, i });
	});
	scored.sort((a, b) => b.s - a.s || a.i - b.i);
	return scored.map((x) => x.c);
}

/** 按分组串成渲染用的行（保持出现顺序）。 */
export function groupRows(commands: PaletteCommand[]): { group: string; items: PaletteCommand[] }[] {
	const out: { group: string; items: PaletteCommand[] }[] = [];
	for (const c of commands) {
		const last = out[out.length - 1];
		if (last && last.group === c.group) last.items.push(c);
		else out.push({ group: c.group, items: [c] });
	}
	return out;
}
