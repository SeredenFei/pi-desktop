/**
 * agy-smoke-test.mjs — Antigravity（agy）平级内核的**服务级零 token 冒烟**。
 *
 * 覆盖「能不能像 pi / dsh 一样在界面里热切」这件事本身：
 *   1. `PI_WEB_ENGINE=agy` 启动 → ready.engine === "agy"
 *   2. 初始推送齐全（conversations / settings_state / slash_commands / snapshot）
 *   3. list_models 只回 Gemini 系列（红线 3 在服务端就过滤）
 *   4. slash_commands 含 /usage（按需单次额度查询的入口）
 *   5. switch_engine pi → ready.engine=pi → switch_engine agy → ready.engine=agy（零重启平级热切）
 *
 * 零 token：全程不发 prompt（不消耗 20x 配额）。agy 未安装 → SKIP 退出 0。
 *
 * 用法：npm run build:server && node tests/agy-smoke-test.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { portUp } from "./lib/port-utils.mjs";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = fileURLToPath(new globalThis.URL("../", import.meta.url));
const PORT = 8946;
const CLIENT_ID = "agy-smoke";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

try {
	execFileSync("agy", ["--version"], { timeout: 5000 });
} catch {
	console.log("⏭ SKIP：未安装 Antigravity CLI（agy）");
	process.exit(0);
}

const dataDir = mkdtempSync(join(tmpdir(), "agy-smoke-data-"));
const server = spawn("node", ["dist/server/index.js"], {
	cwd: REPO,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: REPO,
		PI_WEB_ENGINE: "agy",
		PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "agy-smoke-agent-")),
	},
	stdio: ["ignore", "ignore", "pipe"],
});
let srvErr = "";
server.stderr?.on("data", (d) => {
	srvErr += d.toString();
	if (process.env.AGY_SMOKE_DEBUG === "1") process.stderr.write(`[srv] ${d}`);
});

for (let i = 0; i < 80; i++) {
	await sleep(250);
	try {
		if (await portUp(PORT)) break;
	} catch {
		/* retry */
	}
	if (i === 79) {
		console.error(`✗ server 未在 20s 内启动\n${srvErr.slice(-1500)}`);
		server.kill();
		process.exit(1);
	}
}
console.log("server up (engine=agy)");

function connect(clientId) {
	return new Promise((resolveConnect, reject) => {
		const ws = new WebSocket(`ws://localhost:${PORT}/ws`);
		const inbox = [];
		const waiters = [];
		ws.on("message", (d) => {
			let msg;
			try {
				msg = JSON.parse(d.toString());
			} catch {
				return;
			}
			const idx = waiters.findIndex((w) => w.pred(msg));
			if (idx >= 0) {
				const [w] = waiters.splice(idx, 1);
				w.resolve(msg);
			} else inbox.push(msg);
		});
		ws.on("open", () =>
			resolveConnect({
				ws,
				send: (m) => ws.send(JSON.stringify(m)),
				wait: (pred, timeout = 30000) =>
					new Promise((res, rej) => {
						const i = inbox.findIndex(pred);
						if (i >= 0) {
							res(inbox.splice(i, 1)[0]);
							return;
						}
						const t = setTimeout(() => {
							const at = waiters.findIndex((w) => w.pred === pred);
							if (at >= 0) waiters.splice(at, 1);
							rej(new Error("timeout waiting for message"));
						}, timeout);
						waiters.push({
							pred,
							resolve: (m) => {
								clearTimeout(t);
								res(m);
							},
						});
					}),
				close: () => ws.close(),
			}),
		);
		ws.on("error", reject);
	});
}

async function main() {
	const c = await connect(CLIENT_ID);
	c.send({ type: "hello", clientId: CLIENT_ID, protocolVersion: 1 });

	const ready = await c.wait((m) => m.type === "ready");
	check("ready.engine === 'agy'", ready.engine === "agy", `engine=${ready.engine} proto=${ready.protocolVersion}`);

	await c.wait((m) => m.type === "conversations");
	await c.wait((m) => m.type === "settings_state");
	const slash = await c.wait((m) => m.type === "slash_commands");
	await c.wait((m) => m.type === "snapshot" || m.type === "snapshot_delta");
	check("初始推送齐全（conversations/settings_state/slash_commands/snapshot）", true);

	c.send({ type: "list_models" });
	const models = await c.wait((m) => m.type === "models");
	const ids = (models.models ?? []).map((m) => m.id);
	// 宿主会加引擎前缀（agy/gemini-4-carbon）；红线 3 断言的是「族」而不是前缀
	const bare = ids.map((id) => String(id).replace(/^[^/]+\//, ""));
	check("模型目录只含 Gemini 系列", bare.length > 0 && bare.every((id) => /^gemini[-_.]/i.test(id)), bare.join(", "));

	const names = (slash.commands ?? []).map((cmd) => cmd.name);
	check("slash_commands 含 /usage（按需单次额度）", names.includes("usage"), names.join(", "));

	// 平级热切换：agy → pi → agy（同一个 socket，零重启）
	c.send({ type: "switch_engine", engine: "pi" });
	const back = await c.wait((m) => m.type === "ready" && m.engine === "pi", 20000);
	check("switch_engine → pi", back.engine === "pi", `engine=${back.engine}`);

	c.send({ type: "switch_engine", engine: "agy" });
	const again = await c.wait((m) => m.type === "ready" && m.engine === "agy", 20000);
	check("switch_engine → agy（平级切回）", again.engine === "agy", `engine=${again.engine}`);

	c.close();
}

try {
	await main();
} catch (err) {
	check("smoke 执行", false, (err && err.message) || String(err));
} finally {
	server.kill();
}

console.log(failures === 0 ? "\n全部通过（零 token）" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
