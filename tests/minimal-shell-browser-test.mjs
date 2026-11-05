/* 极简外壳 E2E（redesign P2，docs/redesign-plan.md）：启动编译后的 server，headless Chrome 打开 UI，
 * 验证新外壳的每个入口都能用、经典外壳仍可切回：
 *
 *   1. 默认即极简外壳：标题栏在、旧 TopBar / FooterBar / SideDock 不在、旧主题样式表不挂
 *   2. 跟随系统配色（emulateMedia）→ data-scheme 跟着变；命令面板切浅/深色
 *   3. Ctrl/Cmd+K 命令面板：过滤、↑↓/Enter 执行、底部「搜索」转交全局搜索（带查询词）
 *   4. Ctrl+` 底部终端面板：展开即自动建终端（xterm 出现）、再按收起、记住开关
 *   5. 文件抽屉默认收起、标题栏按钮开关；侧栏开关
 *   6. 侧栏底部「更多」→ Git 视图 → 标题栏「返回」回到对话
 *   7. 输入框下方状态行（引擎 / 上下文 / 费用）
 *   8. 命令面板「切换到经典布局」→ TopBar 回来；再切回极简
 *   9. 手机宽度：标题栏汉堡按钮拉出左侧抽屉
 *
 * Run:  npm run build && node tests/minimal-shell-browser-test.mjs */
import { CHROME_PATH } from "./lib/chrome.mjs";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

if (!CHROME_PATH && !process.env.CHROME_PATH) {
	console.log("SKIP: 未找到 Chrome（设置 PI_WEB_CHROME 指定路径）");
	process.exit(0);
}

const PORT = 30000 + Math.floor(Math.random() * 10000);
const workdir = mkdtempSync(join(tmpdir(), "piweb-minimal-"));
const HERE = fileURLToPath(new URL("../", import.meta.url));
const server = spawn(process.execPath, [join(HERE, "dist", "server", "index.js")], {
	cwd: HERE,
	env: {
		...process.env,
		PI_WEB_PORT: String(PORT),
		PI_WEB_CWD: workdir,
		PI_WEB_DATA_DIR: join(workdir, ".data"),
		PI_WEB_PLUGIN_CATALOG_URL: "",
	},
	stdio: ["ignore", "pipe", "pipe"],
	detached: process.platform !== "win32",
	windowsHide: true,
});
server.stderr.on("data", (d) => process.stdout.write(`[srv!] ${d}`));
process.on("exit", () => {
	try {
		if (process.platform === "win32")
			execFileSync("taskkill", ["/F", "/T", "/PID", String(server.pid)], { stdio: "ignore" });
		else process.kill(-server.pid, "SIGKILL");
	} catch {
		/* gone */
	}
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const check = (name, cond, detail) => {
	if (cond) {
		passed++;
		console.log(`  ✓ ${name}`);
	} else {
		console.log(`  ✗ FAIL: ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ""}`);
		process.exitCode = 1;
	}
};

async function waitServer() {
	for (let i = 0; i < 160; i++) {
		try {
			if ((await fetch(`http://localhost:${PORT}/api/health`)).ok) return;
		} catch {
			/* not up yet */
		}
		await sleep(250);
	}
	throw new Error("server did not start");
}

async function main() {
	await waitServer();
	const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH ?? CHROME_PATH });
	const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
	const pageErrors = [];
	page.on("pageerror", (e) => pageErrors.push(String(e)));
	await page.addInitScript(() => {
		if (!sessionStorage.getItem("__seeded")) {
			sessionStorage.setItem("__seeded", "1");
			localStorage.setItem("pi-web-ui:lang", "zh");
			localStorage.setItem("pi-web-ui:theme", "nord"); // 旧主题选择：极简外壳下必须被忽略
		}
	});
	await page.emulateMedia({ colorScheme: "light" });
	await page.goto(`http://localhost:${PORT}/`);
	await page.waitForSelector('[data-testid="minimal-titlebar"]', { timeout: 30000 });
	await page.waitForSelector(".inputbox textarea", { timeout: 30000 });
	await sleep(800);

	console.log("1. 默认极简外壳");
	const legacy = await page.evaluate(() =>
		[".topbar", ".statusbar", ".side-dock"].filter((s) =>
			[...document.querySelectorAll(s)].some((e) => e.getClientRects().length),
		),
	);
	check("旧 TopBar / FooterBar / SideDock 均不渲染", legacy.length === 0, legacy);
	check("data-shell=minimal", (await page.getAttribute("html", "data-shell")) === "minimal");
	check("不挂旧主题样式表", (await page.locator("#theme-stylesheet").count()) === 0);

	console.log("2. 配色");
	check("跟随系统：浅色", (await page.getAttribute("html", "data-scheme")) === "light");
	await page.emulateMedia({ colorScheme: "dark" });
	await sleep(200);
	check("跟随系统：系统切深色后跟着变", (await page.getAttribute("html", "data-scheme")) === "dark");
	const bgDark = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
	check("深色设计变量生效（--bg = #262624）", bgDark === "#262624", bgDark);

	console.log("3. 命令面板");
	await page.keyboard.press("Control+K");
	await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 3000 });
	check("Ctrl+K 打开命令面板", true);
	const total = await page.locator(".cmdk-item").count();
	check("命令数量 ≥ 15", total >= 15, total);
	await page.fill('[data-testid="command-palette-input"]', "浅色");
	await sleep(150);
	const first = await page.locator(".cmdk-item").first().getAttribute("data-cmd");
	check("过滤后第一项是「浅色」", first === "scheme-light", first);
	await page.keyboard.press("Enter");
	await sleep(300);
	check("Enter 执行：切到浅色", (await page.getAttribute("html", "data-scheme")) === "light");
	check("执行后面板关闭", (await page.locator('[data-testid="command-palette"]').count()) === 0);
	await page.keyboard.press("Control+K");
	await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 3000 });
	await page.fill('[data-testid="command-palette-input"]', "hello-search");
	await page.locator('.cmdk-item[data-cmd="search"]').click();
	const gsInput = await page.waitForSelector(".gs-input-row input", { timeout: 5000 }).catch(() => null);
	check("「搜索」把查询词转交全局搜索", (await gsInput?.inputValue()) === "hello-search");
	await page.keyboard.press("Escape");
	await sleep(300);

	console.log("4. 底部终端面板");
	check("终端面板默认收起", !(await page.isVisible('[data-testid="terminal-dock"]')));
	await page.keyboard.press("Control+Backquote");
	await page.waitForSelector('[data-testid="terminal-dock"]', { state: "visible", timeout: 5000 });
	check("Ctrl+` 展开终端面板", true);
	const xterm = await page
		.waitForSelector('[data-testid="terminal-dock"] .xterm', { timeout: 15000 })
		.catch(() => null);
	check("展开时自动新建终端（xterm 出现）", !!xterm);
	await page.keyboard.press("Control+Backquote");
	await sleep(300);
	check("再按收起", !(await page.isVisible('[data-testid="terminal-dock"]')));
	check("记住开关", (await page.evaluate(() => localStorage.getItem("pi-web-ui:term-dock-open"))) === "0");
	await page.click('[data-testid="mtb-terminal"]');
	await sleep(300);
	check("标题栏终端按钮也能展开", await page.isVisible('[data-testid="terminal-dock"]'));
	await page.click('[data-testid="terminal-dock-close"]');
	await sleep(200);

	console.log("5. 文件抽屉 / 侧栏");
	check("文件抽屉默认收起", !(await page.isVisible(".panel-right")));
	await page.click('[data-testid="mtb-files"]');
	await sleep(300);
	check("标题栏按钮打开文件抽屉", await page.isVisible(".panel-right"));
	await page.click('[data-testid="mtb-files"]');
	await sleep(200);
	const leftBefore = await page.isVisible(".panel-left");
	await page.click('[data-testid="mtb-sidebar"]');
	await sleep(300);
	check("侧栏开关", (await page.isVisible(".panel-left")) !== leftBefore);
	await page.click('[data-testid="mtb-sidebar"]');
	await sleep(300);

	console.log("6. 侧栏「更多」→ 视图");
	await page.click('[data-testid="sidebar-more"]');
	await page.waitForSelector('[data-testid="sidebar-more-git"]', { timeout: 3000 });
	await page.click('[data-testid="sidebar-more-git"]');
	await page.waitForSelector('[data-testid="mtb-back"]', { timeout: 3000 });
	check("切到 Git 视图，标题栏出现「返回」", true);
	await page.click('[data-testid="mtb-back"]');
	await sleep(300);
	check("「返回」回到对话", await page.isVisible(".inputbox textarea"));

	console.log("7. 状态行");
	const statusItems = await page
		.locator('[data-testid="composer-status-line"] [data-bar-item]')
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-bar-item")));
	check("状态行含引擎", statusItems.includes("host:engine"), statusItems);
	check("状态行含上下文", statusItems.includes("host:ctx"), statusItems);

	console.log("8. 切到经典布局再切回");
	await page.keyboard.press("Control+K");
	await page.waitForSelector('[data-testid="command-palette-input"]', { timeout: 3000 });
	await page.fill('[data-testid="command-palette-input"]', "经典布局");
	await page.keyboard.press("Enter");
	await page.waitForSelector(".topbar", { timeout: 10000 });
	check("经典布局：TopBar 回来", await page.isVisible(".topbar"));
	check("经典布局：旧主题恢复", (await page.getAttribute("html", "data-theme")) === "nord");
	check("经典布局：极简标题栏消失", (await page.locator('[data-testid="minimal-titlebar"]').count()) === 0);
	await page.locator(".plugin-topbar-more > button").first().click();
	await page.waitForSelector('[data-testid="switch-to-minimal"]', { timeout: 5000 });
	await page.click('[data-testid="switch-to-minimal"]');
	await page.waitForSelector('[data-testid="minimal-titlebar"]', { timeout: 10000 });
	check("顶栏 ⋯ → 「切换到极简布局」切回极简", true);

	console.log("9. 手机宽度");
	await page.setViewportSize({ width: 390, height: 800 });
	await sleep(500);
	await page.click('[data-testid="mtb-sidebar"]');
	await sleep(500);
	const drawerOpen = await page.evaluate(() => {
		const r = document.querySelector(".panel-left")?.getBoundingClientRect();
		return !!r && r.left >= -1 && r.width > 100;
	});
	check("汉堡按钮拉出左侧抽屉", drawerOpen);
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
	check("手机宽度无横向溢出", !overflow);

	check("无页面 JS 异常", pageErrors.length === 0, pageErrors.slice(0, 3));
	await browser.close();
	console.log(`\n${process.exitCode ? "✗" : "✓"} minimal-shell: ${passed} checks passed`);
}

main()
	.catch((err) => {
		console.error("FATAL:", err);
		process.exitCode = 1;
	})
	.finally(() => process.exit());
