/**
 * builtins/memory.ts — 跨会话共享记忆内联标记。
 *
 * 语法：
 *   [[memory:global:<fact>]]    保存全局共享记忆（用户偏好、通用规范、长期背景）
 *   [[memory:project:<fact>]]   保存当前项目专属记忆（项目架构、目录约定、特定决策）
 *   [[memory:forget:<id>]]      按条目 ID 删除过时或用户要求忘记的记忆
 */
import type { ServerLang } from "../../i18n.js";
import type { ApplyResult, MarkerContext, MarkerTool, ParsedToken } from "../marker.js";

const MEMORY_GUIDANCE_ZH: string[] = [
	"- 长期记忆：当用户表达持久偏好、个人背景或要求记住某事时，输出 [[memory:global:<简明事实>]]；若仅适用于当前项目则输出 [[memory:project:<简明事实>]]；需要遗忘某条已有记忆时输出 [[memory:forget:<id>]]。",
];

const MEMORY_GUIDANCE_EN: string[] = [
	"- Long-term memory: when the user states a lasting preference, background fact, or asks you to remember something, emit [[memory:global:<concise fact>]] (or [[memory:project:<concise fact>]] if project-specific); to forget an existing entry emit [[memory:forget:<id>]].",
];

export function getMemoryGuidance(lang: ServerLang = "en"): string[] {
	return lang === "zh" ? MEMORY_GUIDANCE_ZH : MEMORY_GUIDANCE_EN;
}

function extractBody(token: ParsedToken): string {
	const raw = token.raw;
	const firstColon = raw.indexOf(":");
	const secondColon = firstColon >= 0 ? raw.indexOf(":", firstColon + 1) : -1;
	if (secondColon >= 0 && raw.endsWith("]]")) {
		return raw.slice(secondColon + 1, -2).trim();
	}
	return token.args.join(", ").trim();
}

export const memoryMarker: MarkerTool<never> = {
	name: "memory",
	label: "Memory",
	guidance: MEMORY_GUIDANCE_ZH,
	getGuidance: getMemoryGuidance,

	async apply(token: ParsedToken, ctx: MarkerContext, _state: never, lang: ServerLang = "en"): Promise<ApplyResult> {
		if (!ctx.applyMemoryOp) {
			return { applied: false };
		}
		const op = token.op.toLowerCase();
		const body = extractBody(token);
		if (!body) {
			return {
				applied: false,
				error: lang === "zh" ? "memory 标记内容不能为空" : "memory marker content cannot be empty",
			};
		}
		if (op === "global" || op === "add") {
			const ok = ctx.applyMemoryOp({ op: "add", scope: "global", text: body });
			if (ok) {
				ctx.notify(`🧠 已记住（全局）：${body}`, "info", `🧠 Remembered (Global): ${body}`);
			}
			return { applied: ok };
		}
		if (op === "project") {
			const ok = ctx.applyMemoryOp({ op: "add", scope: "project", text: body });
			if (ok) {
				ctx.notify(`🧠 已记住（项目）：${body}`, "info", `🧠 Remembered (Project): ${body}`);
			}
			return { applied: ok };
		}
		if (op === "forget" || op === "delete" || op === "remove") {
			const ok = ctx.applyMemoryOp({ op: "forget", id: body });
			if (ok) {
				ctx.notify(`🧠 已遗忘记忆 #${body}`, "info", `🧠 Forgot memory #${body}`);
			}
			return { applied: ok };
		}
		return {
			applied: false,
			error:
				lang === "zh"
					? `未知 memory 操作: ${token.op}（支持 global / project / forget）`
					: `Unknown memory operation: ${token.op} (supported: global / project / forget)`,
		};
	},
	overlay: undefined,
	init: () => undefined as never,
};
