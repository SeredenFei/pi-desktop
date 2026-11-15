/**
 * agy-compliance.test.ts — Antigravity（agy acp）内核适配的「防封红线」回归测试。
 *
 * 全是纯函数/临时目录测试：零 token、零子进程、不碰真实登录态。
 */
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	COMPLIANCE_INVARIANTS,
	QuotaCallGuard,
	assertGeminiModelId,
	assertSpawnArgsCompliant,
	filterGeminiModels,
	isCredentialPath,
	isGeminiModelId,
} from "../../server/agy/agy-compliance.js";
import { formatUsageLines, parseAgyUsageOutput, toUsageSnapshot } from "../../server/agy/agy-quota.js";
import {
	agyMcpConfigPath,
	agySkillsDir,
	linkSkillsIntoProject,
	readProjectMcpConfig,
	upsertProjectMcpServer,
} from "../../server/agy/agy-workspace.js";
import { AgyAcpDriver, buildPromptBlocks, baseModelId } from "../../server/universal/drivers/agy-acp.js";

const tempDirs: string[] = [];
function makeTemp(): string {
	const dir = mkdtempSync(join(tmpdir(), "agy-compliance-"));
	tempDirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("红线 1：原样拉起子进程，不传权限跳过参数", () => {
	it("拒绝 --dangerously-skip-permissions 及其变体", () => {
		for (const arg of ["--dangerously-skip-permissions", "--dangerously-skip-permissions=true", "--YOLO"]) {
			expect(() => assertSpawnArgsCompliant(["--add-dir", "/tmp", arg])).toThrow(/agy-compliance/);
		}
	});

	it("正常参数（acp / --add-dir / --sandbox）不被拦截", () => {
		expect(() => assertSpawnArgsCompliant(["acp", "--add-dir", "/work", "--sandbox"])).not.toThrow();
	});

	it("红线清单公开可读（文档与 UI 同源）", () => {
		expect(COMPLIANCE_INVARIANTS.map((item) => item.id)).toEqual([
			"raw-subprocess",
			"no-credentials",
			"gemini-only",
			"no-auto-followup",
			"manual-quota",
		]);
	});
});

describe("红线 3：个人订阅下只调 Gemini 系列模型", () => {
	it("只保留 gemini-* 目录项", () => {
		const models = [
			{ modelId: "gemini-4-carbon", name: "Gemini 4 Carbon" },
			{ modelId: "claude-opus-5-5", name: "Claude Opus 5.5" },
			{ modelId: "gpt-oss-120b-medium", name: "GPT-OSS 120B" },
			{ modelId: "gemini-3.8-flash", name: "Gemini 3.8 Flash" },
		];
		expect(filterGeminiModels(models, (m) => m.modelId).map((m) => m.modelId)).toEqual([
			"gemini-4-carbon",
			"gemini-3.8-flash",
		]);
	});

	it("isGeminiModelId 判定", () => {
		expect(isGeminiModelId("gemini-4-argon-high")).toBe(true);
		expect(isGeminiModelId("claude-sonnet-5-5-high")).toBe(false);
		expect(isGeminiModelId("gpt-oss-120b-medium")).toBe(false);
	});

	it("切非 Gemini 模型直接抛错（不静默回退）", () => {
		expect(() => assertGeminiModelId("claude-opus-5-5")).toThrow(/只允许调用 Gemini/);
		expect(() => assertGeminiModelId("gemini-4-carbon")).not.toThrow();
	});

	it("驱动 setModel 兼容宿主 canonical id（agy/gemini-…）", async () => {
		const driver = new AgyAcpDriver(makeTemp());
		await driver.setModel("agy/gemini-4-carbon");
		await expect(driver.setModel("agy/claude-opus-5-5")).rejects.toThrow(/Gemini/);
	});

	it("tiered 模型 id 归一化到族名", () => {
		expect(baseModelId("gemini-4-carbon-high")).toBe("gemini-4-carbon");
		expect(baseModelId("gemini-3.8-flash-xhigh")).toBe("gemini-3.8-flash");
		expect(baseModelId("gemini-4-carbon")).toBe("gemini-4-carbon");
	});
});

describe("红线 2：凭证文件只用于拒绝，不读取", () => {
	it("识别 OAuth/账号凭证路径", () => {
		expect(isCredentialPath("/home/u/.gemini/oauth_creds.json")).toBe(true);
		expect(isCredentialPath("/home/u/.gemini/jetski-standalone-oauth-token")).toBe(true);
		expect(isCredentialPath("C:\\Users\\u\\.gemini\\google_accounts.json")).toBe(true);
		expect(isCredentialPath("/work/project/a.ts")).toBe(false);
	});
});

describe("红线 5：配额按需单次查询，禁止轮询", () => {
	it("没有用户动作 reason 直接拒绝", () => {
		const guard = new QuotaCallGuard(50);
		expect(() => guard.assertUserInitiated("")).toThrow(/用户动作/);
	});

	it("同一动作短时间内重复视为轮询", () => {
		const guard = new QuotaCallGuard(10_000);
		guard.assertUserInitiated("slash:/usage");
		expect(() => guard.assertUserInitiated("slash:/usage")).toThrow(/轮询/);
	});

	it("解析结构化 usage（agy -p /usage --output-format json）", () => {
		const stdout = JSON.stringify({
			status: "SUCCESS",
			command: {
				name: "usage",
				data: {
					groups: [
						{
							name: "Gemini Models",
							buckets: [
								{ id: "gemini-weekly", name: "Weekly Limit Remaining", window: "weekly", remaining_fraction: 0.95 },
								{ id: "gemini-5h", name: "Five Hour Limit Remaining", window: "5h", remaining_fraction: 0.9 },
							],
						},
					],
				},
			},
		});
		const snapshot = toUsageSnapshot(parseAgyUsageOutput(stdout));
		expect(snapshot.groups[0].buckets.map((b) => Math.round(b.remainingFraction * 100))).toEqual([95, 90]);
		expect(formatUsageLines(snapshot, "zh")[0]).toContain("Gemini Models");
	});

	it("解析文本兜底输出", () => {
		const stdout = JSON.stringify({
			status: "SUCCESS",
			response: "Gemini Models\tWeekly Limit Remaining\t95%\t2026-11-21T09:58:06Z\n",
		});
		const snapshot = toUsageSnapshot(parseAgyUsageOutput(stdout));
		expect(snapshot.groups[0].buckets[0].remainingFraction).toBeCloseTo(0.95, 5);
	});

	it("非 JSON 输出报错（版本过旧）", () => {
		expect(() => parseAgyUsageOutput("Quota: ok")).toThrow(/JSON/);
	});
});

describe("技能库软链接与 MCP 配置（工作流共享）", () => {
	it("软链技能目录且幂等，不覆盖真实目录", () => {
		const project = makeTemp();
		const skills = join(project, "pi-skills");
		mkdirSync(join(skills, "alpha"), { recursive: true });
		writeFileSync(join(skills, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: A\n---\n");
		mkdirSync(join(skills, "beta"), { recursive: true }); // 无 SKILL.md → 跳过

		const first = linkSkillsIntoProject(project, [skills]);
		expect(first.linked).toEqual(["alpha"]);
		expect(first.skipped.map((s) => s.name)).toContain("beta");
		expect(readdirSync(agySkillsDir(project))).toEqual(["alpha"]);

		const second = linkSkillsIntoProject(project, [skills]);
		expect(second.linked).toEqual([]);
		expect(second.existing).toEqual(["alpha"]);

		// 真实目录不覆盖
		rmSync(join(agySkillsDir(project), "alpha"), { force: true });
		mkdirSync(join(agySkillsDir(project), "alpha"), { recursive: true });
		const third = linkSkillsIntoProject(project, [skills]);
		expect(third.linked).toEqual([]);
		expect(third.skipped.some((s) => s.reason.includes("不覆盖"))).toBe(true);
	});

	it("MCP 配置按项目落地并可读回（env map → ACP 数组）", () => {
		const project = makeTemp();
		upsertProjectMcpServer(project, {
			name: "memory",
			command: "node",
			args: ["memory-mcp.mjs"],
			env: { MEMORY_DB: "/tmp/mem.db" },
		});
		expect(agyMcpConfigPath(project)).toBe(join(resolve(project), ".agents", "mcp_config.json"));
		const servers = readProjectMcpConfig(project);
		expect(servers).toHaveLength(1);
		expect(servers[0]).toMatchObject({ name: "memory", command: "node", args: ["memory-mcp.mjs"] });
		expect(servers[0].env).toEqual([{ name: "MEMORY_DB", value: "/tmp/mem.db" }]);
		// 合并写：第二条不覆盖第一条
		upsertProjectMcpServer(project, { name: "sync", command: "node" });
		expect(readProjectMcpConfig(project).map((s) => s.name)).toEqual(["memory", "sync"]);
	});
});

describe("Prompt 桥接：只做格式适配", () => {
	it("文本 + 图片 data URL + 文件引用", () => {
		const blocks = buildPromptBlocks("hello", [
			{ path: "", mode: "reference", imageData: "data:image/png;base64,AAA" },
			{ path: "/work/a.ts", mode: "lines", lines: { start: 3, end: 9 } },
		]);
		expect(blocks[0]).toEqual({ type: "text", text: expect.stringContaining("hello") });
		expect(blocks[1]).toEqual({ type: "image", mimeType: "image/png", data: "AAA" });
		expect((blocks[0] as { text: string }).text).toContain("/work/a.ts");
	});
});

describe("静态红线扫描（防回归）", () => {
	const agyDir = resolve(__dirname, "../../server/agy");

	it("agy 模块内没有定时器（禁止后台轮询/自动追问）", () => {
		for (const file of readdirSync(agyDir)) {
			const source = readFileSync(join(agyDir, file), "utf8");
			expect(source, file).not.toMatch(/\bsetInterval\s*\(/);
			expect(source, file).not.toMatch(/\bcron\b/i);
		}
	});

	it("只有合规模块把权限跳过参数当代码用（注释解释不算）", () => {
		for (const file of readdirSync(agyDir)) {
			if (file === "agy-compliance.ts") continue;
			const code = readFileSync(join(agyDir, file), "utf8")
				.split(/\r?\n/)
				.filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
				.join("\n");
			expect(code, file).not.toContain("dangerously-skip-permissions");
		}
	});
});
