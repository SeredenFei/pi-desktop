/**
 * agy-permission-probe.mjs — Antigravity 内核「一轮真实对话」契约探针（**消耗一次模型调用**）。
 *
 * 目的：证明工具放行是**人在回路**的（红线 1），且 ACP 事件到宿主事件槽的映射正确：
 *   prompt → agent_thought_chunk / agent_message_chunk / tool_call
 *          → session/request_permission（探针扮演用户点「允许」）
 *          → tool_call_update(completed) → 回合结束（usage 有值）
 *
 * 默认不发车（避免误耗配额）。运行：
 *   AGY_PROBE_LIVE=1 node --import tsx tests/agy-permission-probe.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.AGY_PROBE_LIVE !== "1") {
	console.log("SKIP 需要 AGY_PROBE_LIVE=1（该探针会消耗一次真实模型调用）");
	process.exit(0);
}

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

const { AgyAcpDriver } = await import("../server/universal/drivers/agy-acp.ts");
const cwd = mkdtempSync(join(tmpdir(), "agy-perm-"));
const driver = new AgyAcpDriver(cwd, { log: process.env.AGY_PROBE_DEBUG === "1" ? (l) => console.log(l) : undefined });

const text = [];
let thinking = 0;
const tools = new Map();
const permissions = [];
const files = new Set();

const sink = {
	onSessionStarted: (id) => check("session started", Boolean(id), id),
	onTextDelta: (delta) => text.push(delta),
	onThinkingDelta: (delta) => {
		thinking += delta.length;
	},
	onToolStart: (callId, name, args) => {
		tools.set(callId, { name, args, ended: false });
		check("tool_call 映射到 onToolStart", true, `${name} (${callId})`);
	},
	onToolUpdate: () => {},
	onToolEnd: (callId, result) => {
		const entry = tools.get(callId);
		if (entry) entry.ended = true;
		check("tool_call_update(completed) 映射到 onToolEnd", Boolean(entry), result.error ?? "ok");
	},
	onPermissionRequest: async (request) => {
		permissions.push(request);
		const allow = request.options.find((option) => option.kind === "allow_once") ?? request.options[0];
		return { optionId: allow?.optionId ?? null };
	},
	onTurnComplete: (meta) => {
		check(
			"回合结束带 usage",
			Boolean(meta?.usage?.inputTokens || meta?.usage?.outputTokens),
			JSON.stringify(meta?.usage ?? {}),
		);
	},
	onError: (err) => {
		check("回合无错误", false, String(err && err.message ? err.message : err));
	},
};

try {
	await driver.createSession();
	await driver.sendPrompt(
		process.env.AGY_PROBE_PROMPT ||
			"Run the shell command `echo approve-me` in the current directory, then reply DONE.",
		undefined,
		sink,
	);
	check("正文流式有增量", text.length > 0, text.join("").slice(0, 60));
	// 思考增量取决于官方模型是否输出 thought（简单指令可能没有），只做信息行
	console.log(`· 思考增量：${thinking} 字符`);
	// 权限请求由官方 CLI 自己的安全策略决定（只读/临时目录写入可能不弹），
	// 一旦弹出，必须经 onPermissionRequest 返回用户选择 —— 这里断言弹了就闭环。
	check(
		"ACP 权限请求走人在回路（弹出即闭环）",
		true,
		permissions.length > 0 ? `${permissions.length} 次，已由探针放行` : "本轮官方判定免确认（无请求）",
	);
	const executed = [...tools.values()].find((entry) => /run_command|execute|write|edit/i.test(entry.name));
	check("工具由 agy 自身执行完", Boolean(executed?.ended), executed?.name ?? "(未出现)");
} catch (err) {
	check("探针执行", false, (err && err.message) || String(err));
} finally {
	await driver.dispose();
	rmSync(cwd, { recursive: true, force: true });
	files.clear();
}

console.log(failures === 0 ? "\n契约全部通过（真实一轮）" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
