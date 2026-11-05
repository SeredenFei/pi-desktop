/* Self-update E2E: the corner chip shows the running version, opening the
 * dropdown triggers a registry check and displays current/latest + status.
 * (The update itself runs in a visible terminal tab — not exercised here;
 * it would really run npm i -g.)
 * Run: npm run build && node update-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { freePort } from "./lib/port-utils.mjs";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { chromium } from "playwright-core";

const PORT = 30000 + Math.floor(Math.random() * 10000);
const base = mkdtempSync(join(tmpdir(), "piweb-update-"));
mkdirSync(join(base, "work"), { recursive: true });
process.env.PI_WEB_PORT = String(PORT);
process.env.PI_WEB_CWD = join(base, "work");
process.env.PI_WEB_DATA_DIR = join(base, "data");

// fileURLToPath（不是 URL.pathname）：Windows 上 ".pathname" 得到 "/E:/..."，
// spawn 的脚本参数不存在 → ENOENT，测试根本起不来。
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const server = spawn(process.execPath, [join(repoRoot, "dist", "server", "index.js")], {
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
});
process.on("exit", () => {
	try {
		// win32 没有负数 PID 的进程组，退回按端口清理。
		if (process.platform === "win32") freePort(PORT);
		else process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 100; i++) {
		try {
			const r = await fetch(`http://localhost:${PORT}/`);
			if (r.ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(200);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	let pkgVersion = "0.0.0";
	try {
		pkgVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version;
	} catch {
		// keep the fallback — the chip assertion below will simply fail loudly
	}
	console.log(`package.json version: ${pkgVersion}`);

	const browser = await chromium.launch({
		executablePath: CHROME_PATH,
	});
	const page = await browser.newPage({
		viewport: { width: 1400, height: 900 },
	});
	await page.addInitScript(() => localStorage.setItem("pi-web-ui:shell", "classic")); // 本测试验证经典外壳（TopBar/SideDock/FooterBar），redesign P3 移除经典外壳前保留
	const consoleErrors = [];
	page.on("console", (m) => {
		if (m.type() === "error") consoleErrors.push(m.text());
	});
	page.on("pageerror", (e) => consoleErrors.push(String(e)));

	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector(".topbar", { timeout: 60000 });
	// 顶栏挂载后还会跑一次实测宽度（topbar-fit）并重建条目，节点会被替换：
	// 等按钮稳定下来再点，并且用 locator.click（每次重新解析节点）而不是 page.click（拿着旧句柄点）。
	const moreBtn = page.locator(".plugin-topbar-more .plugin-topbar-item");
	await moreBtn.waitFor({ state: "visible", timeout: 20000 });
	for (let i = 0; i < 20; i++) {
		await moreBtn.click();
		if ((await page.locator(".plugin-topbar-menu.portal").count()) > 0) break;
		await sleep(200);
	}

	// -- 版本 chip 显示运行中的版本 ---------------------------------------
	// ⚠️ 版本 chip 缺省**不在顶栏流里**：`host:update` 的默认布局是 `hidden: true`
	//（展示型条目 —— 版本号 + 更新红点，收进「⋯」溢出菜单，见 ui-slots.ts 的注释）。
	// 所以先点开 ⋯（上面已点），再从菜单里取 chip —— 这也正是用户实际走到的路径。
	await page.waitForSelector(".plugin-topbar-menu.portal", { timeout: 5000 });
	await page.waitForFunction(
		(v) =>
			[...document.querySelectorAll(".plugin-topbar-menu.portal .chip")].some((el) => el.textContent.includes(`v${v}`)),
		pkgVersion,
		{ timeout: 20000 },
	);
	const chip = page.locator(".plugin-topbar-menu.portal .dropdown", {
		hasText: "v" + pkgVersion,
	});
	check("溢出菜单里的更新 chip 显示 v" + pkgVersion, (await chip.count()) > 0);

	// -- 打开下拉 → 仓库检查完成 -------------------------------------------
	await chip.locator("button.chip").click();
	await page.waitForSelector(".dd-update", { timeout: 5000 });
	await page.waitForFunction(
		() => {
			const rows = [...document.querySelectorAll(".dd-row")];
			const latest = rows.find((r) => r.textContent.includes("最新版本"))?.textContent;
			return latest && !latest.includes("检查中");
		},
		{ timeout: 20000 },
	);
	const rows = await page.locator(".dd-row").allTextContents();
	const currentRow = rows.find((r) => r.includes("当前版本")) ?? "";
	const latestRow = rows.find((r) => r.includes("最新版本")) ?? "";
	check(`current version row shows v${pkgVersion}`, currentRow.includes(`v${pkgVersion}`));
	check(
		"latest version row resolved (version or error)",
		/v\d+\.\d+\.\d+/.test(latestRow) || latestRow.includes("失败"),
	);
	const note = await page
		.locator(".dd-note")
		.first()
		.textContent()
		.catch(() => "");
	check(
		"status note shown (up-to-date / new version / error)",
		note.includes("最新") || note.includes("失败") || note.includes("版本"),
	);
	check("no page errors", consoleErrors.length === 0);

	await browser.close();
	console.log(`\n${passed} checks passed`);
	process.exit(process.exitCode ?? 0);
}

main().catch((e) => {
	console.error("❌", e.message);
	process.exit(1);
});
