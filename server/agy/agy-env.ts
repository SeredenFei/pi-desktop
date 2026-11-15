/**
 * agy-env.ts — 内核级环境隔离（多内核共享一台机器时，密钥/代理/登录态不许串台）。
 *
 * 背景：pi-desktop 的每个内核都是独立子进程。pi / claude / codex / dsh 各自吃自己的
 * 登录态或 API Key；而 agy 走的是 **Google 个人订阅登录 + 20x 配额**，一旦父进程
 * 环境里有 `GEMINI_API_KEY` / `GOOGLE_GEMINI_BASE_URL` / `AGY_ADC_AUTH` 之类的变量，
 * 官方 CLI 可能改走 API Key 计费或第三方端点，既可能误扣赠金，也会打乱订阅额度统计。
 *
 * 因此拉起 `agy acp` 时使用**独立裁剪过的 env**：
 *   - 剥掉 Gemini / Vertex / Antigravity 相关凭证与端点覆盖；
 *   - 保留 PATH / HOME / 语言 / 代理等运行必需项；
 *   - 不做任何写入（不碰官方配置文件）。
 *
 * 反方向：pi / claude / codex / dsh 内核不经过本模块，继续用完整 env（它们本来就要
 * 用你的第三方 Key），两边的密钥互不可见。
 */

/** 拉起 agy 时必须剥离的环境变量（大小写敏感，按官方 CLI 实际读取的名字）。 */
export const AGY_STRIPPED_ENV_KEYS: readonly string[] = Object.freeze([
	"GEMINI_API_KEY",
	"GOOGLE_API_KEY",
	"GOOGLE_GEMINI_BASE_URL",
	"GEMINI_BASE_URL",
	"GEMINI_API_BASE_URL",
	"GOOGLE_GENAI_USE_VERTEXAI",
	"GOOGLE_VERTEX_AI_ENDPOINT",
	"AGY_ADC_AUTH",
	"ANTIGRAVITY_API_KEY",
	"ANTIGRAVITY_BASE_URL",
	"CLOUD_CODE_ENDPOINT",
	"DEEPSEEK_API_KEY",
	"DEEPSEEK_BASE_URL",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_BASE_URL",
	"OPENAI_API_KEY",
	"OPENAI_BASE_URL",
]);

/**
 * 允许透传的变量（其余变量一律不透传，避免把别家内核的密钥带进来）。
 * 说明：现代 CLI 依赖 PATH、HOME、XDG_ 前缀目录、TMPDIR、语言与代理变量等，白名单比黑名单更稳。
 */
export const AGY_PASSTHROUGH_ENV_KEYS: readonly string[] = Object.freeze([
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TERM",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"SystemRoot",
	"WINDIR",
	"COMSPEC",
	"PATHEXT",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMDATA",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"NO_COLOR",
	"FORCE_COLOR",
]);

const PASSTHROUGH_SET = new Set(AGY_PASSTHROUGH_ENV_KEYS);
const STRIPPED_SET = new Set(AGY_STRIPPED_ENV_KEYS);

/**
 * 构造 `agy acp` 子进程的 env。
 *
 * @param base 基准环境（默认 process.env；测试可注入）
 * @param extra 显式追加（优先级最高；仍然会被红线黑名单拒绝）
 */
export function buildAgyEnv(base: NodeJS.ProcessEnv = process.env, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined) continue;
		if (STRIPPED_SET.has(key)) continue;
		if (PASSTHROUGH_SET.has(key)) env[key] = value;
	}
	for (const [key, value] of Object.entries(extra)) {
		if (value === undefined) continue;
		if (STRIPPED_SET.has(key)) continue;
		env[key] = value;
	}
	return env;
}

/** 从 base 里被裁掉的键（诊断/日志用；不含值，避免泄漏密钥）。 */
export function strippedEnvKeys(base: NodeJS.ProcessEnv = process.env): string[] {
	return Object.keys(base).filter((key) => STRIPPED_SET.has(key) || !PASSTHROUGH_SET.has(key));
}

/** 本次 truly 被红线命中的键（用于启动时提示「已为你隔离了这些变量」）。 */
export function blockedEnvKeys(base: NodeJS.ProcessEnv = process.env): string[] {
	return Object.keys(base).filter((key) => STRIPPED_SET.has(key));
}

export interface AgyConfigConflict {
	path: string;
	issue: string;
}

/**
 * 只读检查官方配置里是否存在会把订阅登录态改道的设置（**绝不写入**）。
 *
 * 目前检查：`<appDataDir>/settings.json` 的 `modelProvider`。
 * 找不到文件 / 解析失败一律视为「无冲突」——不猜、不改、不报错打断用户。
 */
export function detectAgyConfigConflicts(
	readFile: (path: string) => string,
	settingsPath: string,
): AgyConfigConflict[] {
	let raw: string;
	try {
		raw = readFile(settingsPath);
	} catch {
		return [];
	}
	const conflicts: AgyConfigConflict[] = [];
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		const provider = parsed.modelProvider ?? parsed.model_provider;
		if (typeof provider === "string" && /gemini|api[-_]?key/i.test(provider)) {
			conflicts.push({
				path: settingsPath,
				issue: `settings.json 里设置了 modelProvider=${provider}，可能让官方 CLI 改走 API Key 计费而不是订阅额度`,
			});
		}
		if (parsed.apiKey || parsed.api_key) {
			conflicts.push({
				path: settingsPath,
				issue: "settings.json 里写了 apiKey：订阅模式建议清掉，避免与 20x 配额串台",
			});
		}
	} catch {
		/* 配置不是 JSON：交给官方进程自己报错 */
	}
	return conflicts;
}
