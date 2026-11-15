/**
 * agy-env-handoff.test.ts — 内核级环境隔离 + 跨内核接力清洗的回归测试。
 *
 * 目标：切换内核时「各家用各家的 Key」与「历史只传纯文本」两件事都不可回退。
 */
import { describe, expect, it } from "vitest";
import {
	AGY_STRIPPED_ENV_KEYS,
	blockedEnvKeys,
	buildAgyEnv,
	detectAgyConfigConflicts,
} from "../../server/agy/agy-env.js";
import {
	isSignatureField,
	renderHandoffContext,
	sanitizeCrossEngineHistory,
	stripReasoningSignatures,
	stripSignatureFields,
} from "../../server/agy/agy-handoff.js";

describe("环境隔离：agy 进程看不到别家内核的密钥", () => {
	const base = {
		PATH: "/usr/bin",
		HOME: "/home/u",
		LANG: "zh_CN.UTF-8",
		HTTPS_PROXY: "http://127.0.0.1:7890",
		GEMINI_API_KEY: "AIza-super-secret",
		GOOGLE_GEMINI_BASE_URL: "https://evil.example",
		AGY_ADC_AUTH: "1",
		DEEPSEEK_API_KEY: "sk-deepseek",
		ANTHROPIC_API_KEY: "sk-ant",
		OPENAI_API_KEY: "sk-openai",
		OPENAI_BASE_URL: "https://api.example/v1",
		SOME_RANDOM_SECRET: "nope",
	};

	it("剥掉 Gemini / Vertex / Antigravity 凭证与端点覆盖", () => {
		const env = buildAgyEnv(base);
		for (const key of ["GEMINI_API_KEY", "GOOGLE_GEMINI_BASE_URL", "AGY_ADC_AUTH"]) {
			expect(env[key], key).toBeUndefined();
		}
		expect(AGY_STRIPPED_ENV_KEYS).toContain("GEMINI_API_KEY");
	});

	it("别家内核的 API Key 也不会透传（白名单制）", () => {
		const env = buildAgyEnv(base);
		expect(env.DEEPSEEK_API_KEY).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.SOME_RANDOM_SECRET).toBeUndefined();
	});

	it("运行必需项保留（PATH/HOME/语言/代理）", () => {
		const env = buildAgyEnv(base);
		expect(env.PATH).toBe("/usr/bin");
		expect(env.HOME).toBe("/home/u");
		expect(env.LANG).toBe("zh_CN.UTF-8");
		expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
	});

	it("显式 extra 也不能绕过黑名单", () => {
		const env = buildAgyEnv(base, { GEMINI_API_KEY: "leak", AGY_UI_THEME: "dark" });
		expect(env.GEMINI_API_KEY).toBeUndefined();
		expect(env.AGY_UI_THEME).toBe("dark");
	});

	it("诊断只暴露键名，不暴露值", () => {
		expect(blockedEnvKeys(base)).toContain("GEMINI_API_KEY");
		expect(JSON.stringify(blockedEnvKeys(base))).not.toContain("super-secret");
	});
});

describe("官方配置冲突检测（只读，不写入）", () => {
	it("modelProvider=gemini 时给出提示", () => {
		const conflicts = detectAgyConfigConflicts(() => JSON.stringify({ modelProvider: "gemini" }), "/x/settings.json");
		expect(conflicts).toHaveLength(1);
		expect(conflicts[0].issue).toContain("modelProvider");
	});

	it("没有文件 / 正常配置 → 无冲突", () => {
		expect(
			detectAgyConfigConflicts(() => {
				throw new Error("ENOENT");
			}, "/x/settings.json"),
		).toEqual([]);
		expect(detectAgyConfigConflicts(() => JSON.stringify({ theme: "dark" }), "/x/settings.json")).toEqual([]);
	});
});

describe("跨内核接力：只传纯文本，剥离推理签名", () => {
	it("识别签名字段名", () => {
		expect(isSignatureField("thinkingSignature")).toBe(true);
		expect(isSignatureField("encrypted_content")).toBe(true);
		expect(isSignatureField("text")).toBe(false);
	});

	it("深度剥离对象里的签名与供应商元数据", () => {
		const cleaned = stripSignatureFields({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "思考正文", thinkingSignature: "AAAA".repeat(100) },
				{ type: "text", text: "回答", providerMetadata: { internal: true } },
			],
			encrypted_content: "zzz",
		}) as Record<string, unknown>;
		expect(JSON.stringify(cleaned)).not.toContain("AAAA");
		expect(JSON.stringify(cleaned)).not.toContain("encrypted_content");
		expect(JSON.stringify(cleaned)).not.toContain("providerMetadata");
	});

	it("文本里的签名块被剪掉", () => {
		const raw =
			"答案\n<thinking_signature>YmFzZTY0</thinking_signature>\n[thought signature] abc\nsignature: " + "A".repeat(80);
		const cleaned = stripReasoningSignatures(raw);
		expect(cleaned).toContain("答案");
		expect(cleaned).not.toContain("thinking_signature");
		expect(cleaned).not.toContain("A".repeat(80));
	});

	it("历史清洗只保留正文与工具文本", () => {
		const lines = sanitizeCrossEngineHistory([
			{ role: "user", content: [{ type: "text", text: "改一下 a.ts" }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "内部推理", thinkingSignature: "SIG" },
					{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "a.ts" } },
					{ type: "text", text: "读完了" },
				],
			},
			{ role: "toolResult", content: [{ type: "text", text: "file body" }] },
		]);
		const joined = JSON.stringify(lines);
		expect(joined).toContain("改一下 a.ts");
		expect(joined).toContain("read_file");
		expect(joined).toContain("读完了");
		expect(joined).not.toContain("内部推理");
		expect(joined).not.toContain("SIG");
		expect(joined).not.toContain("call_1");
	});

	it("超长历史被截断且带省略标记", () => {
		const lines = sanitizeCrossEngineHistory(
			[
				{ role: "user", content: "a".repeat(60) },
				{ role: "assistant", content: "b".repeat(60) },
			],
			{ maxChars: 70 },
		);
		expect(lines.at(-1)?.text).toContain("省略");
	});

	it("渲染带说明头，避免下游把它当新指令", () => {
		const text = renderHandoffContext([{ role: "user", text: "继续" }]);
		expect(text).toContain("另一个内核");
		expect(text).toContain("### user");
		expect(renderHandoffContext([])).toBe("");
	});
});
