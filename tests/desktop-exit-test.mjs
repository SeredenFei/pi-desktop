#!/usr/bin/env node
/**
 * 桌面版退出测试（redesign P1，docs/redesign-plan.md「交付与验收」）。
 *
 * 验收标准：开着终端关掉应用后，Electron + server sidecar + 全部子孙进程（pty shell、
 * conhost …）一个不剩。三平台通用，CI 见 .github/workflows/desktop-ci.yml。
 *
 * 场景：
 *   close   — 经 CDP 调 window.piDesktop.window.close()（= 点自绘 ✕，与原生 ✕ 同一个 close 事件）
 *   sigterm — 给 Electron 主进程发 SIGTERM（≈ 注销 / kill；仅 POSIX）
 *   crash   — 强杀 Electron 主进程（不带树杀），server 必须靠 IPC 断开自行退出
 *
 * 前置：npm run build && npm run build:desktop
 * 用法：node tests/desktop-exit-test.mjs [--scenario=close,sigterm,crash]
 * Linux 无显示环境：xvfb-run -a node tests/desktop-exit-test.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const electronBin = require("electron");

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(ROOT, "dist", "desktop", "main.js");
const IS_WIN = process.platform === "win32";

const argScenario = process.argv.find((a) => a.startsWith("--scenario="))?.split("=")[1];
const SCENARIOS = (argScenario ? argScenario.split(",") : ["close", "sigterm", "crash"]).filter(
	(s) => !(s === "sigterm" && IS_WIN),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SENTINEL_SECONDS = 297; // 独特时长，便于人工排查残留
/**
 * 哨兵必须是「pty 关闭后自己不会死」的进程，否则无法区分修复前后：
 * - POSIX：nohup 后台进程忽略 SIGHUP，shell 退出后被重挂到 init；
 * - Windows：ConPTY 关闭时会终止所有挂在该伪控制台上的进程（nohup 也挡不住），
 *   所以用 Start-Process 起一个自带（隐藏）控制台的 ping，模拟脱离终端的后台程序；
 *   外层 powershell 留在前台 Start-Sleep，保证退出快照时 ping 仍在父链上。
 */
const SENTINEL_CMD =
	process.platform === "win32"
		? `powershell.exe -NoProfile -Command "Start-Process ping.exe -ArgumentList '-n','${SENTINEL_SECONDS}','127.0.0.1' -WindowStyle Hidden; Start-Sleep 600" &\r`
		: `nohup sleep ${SENTINEL_SECONDS} >/dev/null 2>&1 &\r`;
const SENTINEL_NAME = process.platform === "win32" ? /^ping\.exe$/i : /(^|\/)sleep$/;

function freePort() {
	return new Promise((resolve, reject) => {
		const s = createServer();
		s.once("error", reject);
		s.listen(0, "127.0.0.1", () => {
			const { port } = s.address();
			s.close(() => resolve(port));
		});
	});
}

/** 全系统进程表 [{pid, ppid, name}] */
function processTable() {
	const out = IS_WIN
		? execFileSync(
				"powershell.exe",
				[
					"-NoProfile",
					"-NonInteractive",
					"-Command",
					'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name)" }',
				],
				{ encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
			)
		: execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	const rows = [];
	for (const line of out.split(/\r?\n/)) {
		const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
		if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), name: m[3].trim() });
	}
	return rows;
}

function descendants(root, table = processTable()) {
	const out = [];
	const seen = new Set([root]);
	const queue = [root];
	while (queue.length) {
		const cur = queue.shift();
		for (const p of table) {
			if (p.ppid === cur && !seen.has(p.pid)) {
				seen.add(p.pid);
				out.push(p);
				queue.push(p.pid);
			}
		}
	}
	return out;
}

function stillAlive(procs) {
	const live = new Map(processTable().map((p) => [p.pid, p.name]));
	// 同 PID 且同名才算同一个进程（降低 PID 复用误报）
	return procs.filter((p) => live.get(p.pid) === p.name);
}

async function waitFor(fn, timeoutMs, stepMs = 300) {
	const t0 = Date.now();
	for (;;) {
		const v = await fn();
		if (v) return v;
		if (Date.now() - t0 > timeoutMs) return null;
		await sleep(stepMs);
	}
}

/** 经 CDP 在主窗口里执行 JS。 */
async function cdpEvaluate(debugPort, expression) {
	const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
	const page = targets.find((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:/.test(t.url));
	if (!page) throw new Error(`CDP: 找不到应用页面 target：${JSON.stringify(targets.map((t) => t.url))}`);
	const ws = new WebSocket(page.webSocketDebuggerUrl);
	await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
	ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, awaitPromise: false } }));
	await new Promise((r) => {
		ws.on("message", (raw) => {
			if (JSON.parse(String(raw)).id === 1) r();
		});
		setTimeout(r, 3000);
	});
	ws.terminate();
}

/** 经应用自己的 WS 协议开 n 个终端，返回确认创建成功的 terminalId。 */
async function openTerminals(port, cwd, n) {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
	let convId = null;
	const ok = new Set();
	ws.on("message", (raw) => {
		let m;
		try {
			m = JSON.parse(String(raw));
		} catch {
			return;
		}
		const find = (o, d = 0) => {
			if (convId || !o || typeof o !== "object" || d > 4) return;
			for (const [k, v] of Object.entries(o)) {
				if (/^(conversationId|activeConversationId)$/.test(k) && typeof v === "string") {
					convId = v;
					return;
				}
				if (v && typeof v === "object") find(v, d + 1);
			}
		};
		find(m);
		if (m.type === "terminal_output" && m.terminalId) ok.add(m.terminalId);
	});
	await new Promise((r, j) => (ws.once("open", r), ws.once("error", j)));
	ws.send(JSON.stringify({ type: "hello", clientId: `desktop-exit-${port}`, locale: "en" }));
	if (!(await waitFor(() => convId, 30000))) throw new Error("WS：30s 内没拿到 conversationId");
	const ids = Array.from({ length: n }, (_, i) => `exit-test-${i + 1}`);
	for (const terminalId of ids) {
		ws.send(JSON.stringify({ type: "terminal_create", terminalId, cwd, cols: 80, rows: 24, conversationId: convId }));
	}
	await waitFor(() => ok.size === n, 20000);
	// 哨兵：在终端 1 里放一个抗 SIGHUP 的后台进程（模拟 agent 拉起的 dev server / git fetch）。
	// pty 关闭时 shell 会自己退，但 nohup 的后台进程不会——只有进程树清理才能收掉它。
	if (ok.size) {
		ws.send(
			JSON.stringify({
				type: "terminal_input",
				terminalId: [...ok][0],
				conversationId: convId,
				data: SENTINEL_CMD,
			}),
		);
	}
	await sleep(300);
	ws.close();
	return [...ok];
}

async function runScenario(scenario) {
	const port = await freePort();
	const debugPort = await freePort();
	const sandbox = mkdtempSync(join(tmpdir(), `pi-desktop-exit-${scenario}-`));
	const env = {
		...process.env,
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: join(sandbox, "data"),
		PI_WEB_CWD: join(sandbox, "work"), // 非 git 目录：避免启动期 git fetch 干扰进程统计
		PI_WEB_PLUGIN_CATALOG_URL: "",
		ELECTRON_ENABLE_LOGGING: "1",
	};
	delete env.ELECTRON_RUN_AS_NODE;
	const args = [MAIN, `--remote-debugging-port=${debugPort}`];
	if (process.platform === "linux") args.push("--no-sandbox"); // CI 容器无 SUID chrome-sandbox / userns
	const app = spawn(electronBin, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	let log = "";
	app.stdout.on("data", (d) => (log += d));
	app.stderr.on("data", (d) => (log += d));
	let exitInfo = null;
	const exited = new Promise((r) =>
		app.once("exit", (code, signal) => {
			exitInfo = { code, signal };
			r();
		}),
	);
	const fail = (msg) => {
		const err = new Error(`[${scenario}] ${msg}`);
		err.log = log;
		return err;
	};

	try {
		const healthy = await waitFor(async () => {
			try {
				return (await fetch(`http://127.0.0.1:${port}/api/health`)).ok;
			} catch {
				return false;
			}
		}, 90000);
		if (!healthy) throw fail("server 90s 内未就绪");
		// 等窗口真正加载（CDP 能看到页面且 piDesktop 桥可用）
		const winReady = await waitFor(async () => {
			try {
				const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
				return targets.some((t) => t.type === "page" && /^http:\/\/127\.0\.0\.1:/.test(t.url));
			} catch {
				return false;
			}
		}, 30000);
		if (!winReady) throw fail("30s 内窗口未加载");

		const terms = await openTerminals(port, env.PI_WEB_CWD, 2);
		if (terms.length !== 2) throw fail(`终端未全部创建成功（${terms.length}/2）`);
		const sentinel = await waitFor(() => descendants(app.pid).find((p) => SENTINEL_NAME.test(p.name)), 15000, 500);
		if (!sentinel) throw fail("哨兵后台进程未出现在进程树里，测试无效");
		await sleep(1000);
		const before = descendants(app.pid);
		console.log(`[${scenario}] 关闭前进程树 ${before.length} 个：${before.map((p) => p.name).join(", ")}`);

		const t0 = Date.now();
		if (scenario === "close") {
			await cdpEvaluate(debugPort, "window.piDesktop.window.close()");
		} else if (scenario === "sigterm") {
			process.kill(app.pid, "SIGTERM");
		} else if (scenario === "crash") {
			if (IS_WIN) execFileSync("taskkill", ["/F", "/PID", String(app.pid)], { windowsHide: true });
			else process.kill(app.pid, "SIGKILL");
		}

		await Promise.race([exited, sleep(20000)]);
		if (!exitInfo) throw fail("Electron 20s 内未退出");
		console.log(`[${scenario}] Electron 退出 ${JSON.stringify(exitInfo)}，用时 ${Date.now() - t0}ms`);
		if (scenario !== "crash" && exitInfo.code !== 0) throw fail(`退出码非 0：${JSON.stringify(exitInfo)}`);

		// close / sigterm：Electron 退出前已收尾，给 2s 让系统回收；crash：server 需自行退出 + dispose pty
		const graceMs = scenario === "crash" ? 15000 : 2000;
		const clean = await waitFor(() => stillAlive(before).length === 0, graceMs, 500);
		if (!clean) {
			const left = stillAlive(before);
			throw fail(`残留 ${left.length} 个进程：${left.map((p) => `${p.pid}:${p.name}`).join(", ")}`);
		}
		console.log(`[${scenario}] ✔ 零残留`);
	} finally {
		if (!exitInfo) {
			try {
				if (IS_WIN) execFileSync("taskkill", ["/F", "/T", "/PID", String(app.pid)], { windowsHide: true });
				else process.kill(app.pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
		await sleep(500);
		try {
			rmSync(sandbox, { recursive: true, force: true });
		} catch {
			/* Windows 上偶发文件占用，不影响结论 */
		}
	}
}

if (!existsSync(MAIN)) {
	console.error("✖ 找不到 dist/desktop/main.js，请先 npm run build && npm run build:desktop");
	process.exit(2);
}

let failed = 0;
for (const s of SCENARIOS) {
	try {
		await runScenario(s);
	} catch (err) {
		failed++;
		console.error(`✖ ${err.message}`);
		if (err.log) {
			console.error("---- app log (tail) ----");
			console.error(err.log.split(/\r?\n/).slice(-60).join("\n"));
		}
	}
}
console.log(failed ? `\n✖ ${failed}/${SCENARIOS.length} 个场景失败` : `\n✔ ${SCENARIOS.length} 个场景全部通过`);
process.exit(failed ? 1 : 0);
