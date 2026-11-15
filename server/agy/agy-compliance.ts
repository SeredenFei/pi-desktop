/**
 * agy-compliance.ts — Antigravity 内核适配层的「防封红线」护栏（可执行版本）。
 *
 * 五条红线在代码里的落点：
 *   1. 原样拉起 `agy acp` + 不传 `--dangerously-skip-permissions`
 *      → `FORBIDDEN_ARGS` + `assertSpawnArgsCompliant()`（客户端 spawn 前硬断言）。
 *   2. 不读 OAuth 凭证、不拦截本地授权回调
 *      → `CREDENTIAL_PATH_PATTERNS` 只用于**拒绝**（`isCredentialPath`），本模块
 *        与 ACP 客户端没有任何读写凭证文件的代码路径；登录交给 `agy acp --login`。
 *   3. 个人订阅下自研 ACP 客户端只调 Gemini 系列模型
 *      → `isGeminiModelId()` / `filterGeminiModels()` / `assertGeminiModelId()`
 *        （服务端过滤，前端下拉永远看不到 Claude / GPT-OSS）。
 *   4. 允许并行开窗、严禁自动追问协调
 *      → 驱动层没有定时器与「任务完成后自动发下一条」的路径；`AUTO_CONTINUE_FORBIDDEN`
 *        是文档化断言，`tests/unit/agy-compliance.test.ts` 对 agy 模块做静态扫描兜底。
 *   5. 按需单次查额度、禁止后台轮询
 *      → `QuotaCallGuard`（无 `reason` 直接抛错；同一次用户动作只允许一次调用）。
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** 绝不允许出现在 `agy acp` 参数表里的开关（含历史别名）。 */
export const FORBIDDEN_ARGS: readonly string[] = Object.freeze([
	"--dangerously-skip-permissions",
	"--dangerously_skip_permissions",
	"--yolo",
	"--no-permission-prompt",
]);

/**
 * 校验要传给 `agy acp` 的参数：命中红线开关直接抛错。
 * 注意：这里只做「拒绝」，不做任何参数改写 —— 保持子进程原样拉起。
 */
export function assertSpawnArgsCompliant(args: readonly string[]): void {
	for (const arg of args) {
		const normalized = arg.split("=")[0]?.trim().toLowerCase();
		if (normalized && FORBIDDEN_ARGS.some((forbidden) => normalized === forbidden)) {
			throw new Error(
				`[agy-compliance] 禁止向 agy acp 传入 ${arg}：工具放行必须走 ACP session/request_permission 由用户在界面确认`,
			);
		}
	}
}

/** Gemini 系列模型 ID 判定（官方个人订阅下自研 ACP 客户端唯一允许的模型族）。 */
export function isGeminiModelId(modelId: string): boolean {
	return /^gemini[-_.]/i.test(modelId.trim());
}

/**
 * 过滤模型目录：只保留 Gemini 系列；非 Gemini（Claude / GPT-OSS 等）在服务端就剔除。
 * 目录条目的 id 字段名由调用方给出（ACP 是 `modelId`，宿主下拉是 `id`）。
 */
export function filterGeminiModels<T>(
	models: readonly T[],
	getId: (model: T) => string = (model) => (model as { id: string }).id,
): T[] {
	return models.filter((model) => isGeminiModelId(getId(model)));
}

/** 切换模型时的红线校验：非 Gemini 直接拒绝（不静默回退，避免用户以为切成功了）。 */
export function assertGeminiModelId(modelId: string): void {
	if (!isGeminiModelId(modelId)) {
		throw new Error(
			`[agy-compliance] 个人订阅下自研 ACP 客户端只允许调用 Gemini 系列模型（请求：${modelId}）；如需 Claude / GPT，请在终端用官方 agy 交互会话`,
		);
	}
}

/**
 * 凭证文件路径特征：**只用于拒绝**。
 * 适配层不读、不复制、不落盘这些文件；登录态由官方进程自管。
 */
export const CREDENTIAL_PATH_PATTERNS: readonly RegExp[] = Object.freeze([
	/(^|[\\/])oauth_creds\.json$/i,
	/(^|[\\/])jetski-standalone-oauth-token$/i,
	/(^|[\\/])google_accounts\.json$/i,
	/(^|[\\/])\.gemini[\\/]config[\\/]config\.json$/i,
	/(^|[\\/])antigravity-cli[\\/]auth/i,
]);

/** 环境里真正常见的会话凭证目录（仅用于给报错文案指路，不作读取）。 */
export function credentialDirs(): string[] {
	const home = homedir();
	return [join(home, ".gemini"), join(home, ".antigravity")];
}

/** 判定某个路径是否是 ACP 适配层绝对不该碰的凭证文件。 */
export function isCredentialPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	return CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(normalized));
}

/** 自动追问协调：红线 4 明确禁止（保留常量供文档/测试引用）。 */
export const AUTO_CONTINUE_FORBIDDEN = true as const;

/**
 * 配额调用守卫：只允许**用户动作**触发单次查询。
 * - 没有 reason（= 后台/定时器触发）→ 直接抛错；
 * - 同一 reason 的连续两次调用若间隔小于 `minGapMs` → 视为轮询，抛错。
 */
export class QuotaCallGuard {
	private lastAt = 0;
	private lastReason = "";
	constructor(private readonly minGapMs = 1000) {}

	/** 记录一次用户主动触发的配额查询；非用户触发一律拒绝。 */
	assertUserInitiated(reason: string): void {
		const trimmed = reason.trim();
		if (!trimmed) {
			throw new Error("[agy-compliance] 配额查询必须由用户动作触发（禁止后台定时轮询）");
		}
		const now = Date.now();
		if (this.lastReason === trimmed && now - this.lastAt < this.minGapMs) {
			throw new Error(`[agy-compliance] 配额查询过于频繁（${reason}），请稍后再试（禁止轮询）`);
		}
		this.lastAt = now;
		this.lastReason = trimmed;
	}
}

/** 红线清单（文档与测试共用同一份事实源）。 */
export const COMPLIANCE_INVARIANTS: ReadonlyArray<{ id: string; rule: string; enforcedBy: string }> = Object.freeze([
	{
		id: "raw-subprocess",
		rule: "原样拉起 agy acp 子进程，不传 --dangerously-skip-permissions，不放行自动批准模式",
		enforcedBy: "assertSpawnArgsCompliant()（spawn 前）+ ACP session/request_permission → 界面点击",
	},
	{
		id: "no-credentials",
		rule: "不读 OAuth 凭证、不拦截 127.0.0.1 授权回调；登录走 agy acp --login",
		enforcedBy: "无凭证读写代码路径；isCredentialPath() 仅用于拒绝",
	},
	{
		id: "gemini-only",
		rule: "个人订阅下自研 ACP 客户端只调用 Gemini 系列模型",
		enforcedBy: "filterGeminiModels() + assertGeminiModelId()",
	},
	{
		id: "no-auto-followup",
		rule: "并行开窗合规，但不得写后台协调逻辑自动替人发下一条指令",
		enforcedBy: "驱动层无定时器/无自动重发；AUTO_CONTINUE_FORBIDDEN",
	},
	{
		id: "manual-quota",
		rule: "额度只在打开设置页或手动刷新时单次查询，禁止定时轮询",
		enforcedBy: "QuotaCallGuard.assertUserInitiated()",
	},
]);
