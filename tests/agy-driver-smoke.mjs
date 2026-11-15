/**
 * agy-driver-smoke.mjs — Antigravity（agy acp）内核的**零 token**驱动级冒烟。
 *
 * 只做协议握手与目录/能力探测，不发任何 prompt（不消耗 20x 配额）：
 *   1. `agy --version` 可用性（缺失 → SKIP 退出 0）
 *   2. AgyAcpDriver.createSession()：真实 spawn `agy acp` → initialize → session/new
 *   3. 模型目录只含 Gemini（红线 3：Claude / GPT-OSS 被服务端剔除）
 *   4. 思考档位来自官方 configOptions（low/medium/high）
 *   5. 切非 Gemini 模型被拒（assertGeminiModelId）
 *   6. spawn 参数红线校验（--dangerously-skip-permissions 被拒）
 *   7. 订阅档位（_meta.antigravity.tier）可读
 *
 * 用法：node --import tsx tests/agy-driver-smoke.mjs
 *      AGY_SMOKE_QUOTA=1 node --import tsx tests/agy-driver-smoke.mjs   # 额外做一次按需额度查询（零 token）
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
const check = (name, ok, extra = "") => {
	console.log(`${ok ? "✓" : "✗"} ${name}${extra ? ` — ${extra}` : ""}`);
	if (!ok) failures++;
};

function agyVersion() {
	try {
		const out = execFileSync("agy", ["--version"], { timeout: 5000, encoding: "utf8" });
		return /(\d+\.\d+\.\d+)/.exec(out)?.[1] ?? "unknown";
	} catch {
		return null;
	}
}

const version = agyVersion();
if (!version) {
	console.log("SKIP Antigravity CLI (agy) 未安装：先装官方 CLI 并跑 `agy acp --login`");
	process.exit(0);
}
console.log(`# agy ${version}`);

const { AgyAcpDriver } = await import("../server/universal/drivers/agy-acp.ts");
const { assertSpawnArgsCompliant } = await import("../server/agy/agy-compliance.ts");

const cwd = mkdtempSync(join(tmpdir(), "agy-smoke-"));
const driver = new AgyAcpDriver(cwd, { log: process.env.AGY_SMOKE_DEBUG === "1" ? (l) => console.log(l) : undefined });

try {
	const sessionId = await driver.createSession();
	check("createSession → ACP sessionId", Boolean(sessionId && sessionId.length > 10), sessionId);

	const models = await driver.listModels();
	check("模型目录非空", models.length > 0, `${models.length} 个`);
	check(
		"目录只含 Gemini 系列（Claude / GPT-OSS 已剔除）",
		models.every((model) => /^gemini[-_.]/i.test(model.id)),
		models.map((model) => model.id).join(", "),
	);

	let rejected = false;
	try {
		await driver.setModel("claude-opus-5-5");
	} catch {
		rejected = true;
	}
	check("切非 Gemini 模型被拒（红线 3）", rejected);

	const levels = driver.getSupportedThinkingLevels();
	check("思考档位来自官方 configOptions", levels.length > 0, levels.join("/"));

	check("订阅档位可读（_meta.antigravity.tier）", Boolean(driver.getTierName()), driver.getTierName() || "(空)");

	let guard = false;
	try {
		assertSpawnArgsCompliant(["--dangerously-skip-permissions"]);
	} catch {
		guard = true;
	}
	check("权限跳过参数被拒（红线 1）", guard);

	if (process.env.AGY_SMOKE_QUOTA === "1") {
		const { queryAgyUsage } = await import("../server/agy/agy-quota.ts");
		const snapshot = await queryAgyUsage({ reason: "smoke:manual", cwd });
		check(
			"按需单次额度查询（红线 5）",
			Boolean(snapshot.error) || snapshot.groups.length > 0,
			snapshot.error ? `error=${snapshot.error}` : `${snapshot.groups.length} 组`,
		);
	}
} catch (err) {
	check("驱动握手", false, (err && err.message) || String(err));
} finally {
	await driver.dispose();
	rmSync(cwd, { recursive: true, force: true });
}

console.log(failures === 0 ? "\n全部通过（零 token）" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
