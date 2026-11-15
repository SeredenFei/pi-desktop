/**
 * agy-quota.ts — Antigravity 额度查询（**按需单次**，绝不轮询）。
 *
 * 官方 CLI 提供零 token 的 `/usage` 命令：`agy -p /usage --output-format json`
 * 返回结构化分桶（weekly / 5h 的 remaining_fraction 与 reset_time），
 * 本次实测 num_turns=0、usage 全 0，因此不消耗模型配额。
 *
 * 本模块没有任何定时器、没有缓存轮询、没有后台预热：每次调用都必须带
 * 用户动作 reason（`QuotaCallGuard` 强制），UI 只在「打开设置页 / 手动刷新」时调用。
 */

import { execFile } from "node:child_process";
import { QuotaCallGuard } from "./agy-compliance.js";
import type { AgyUsageReport } from "./agy-types.js";

export interface AgyUsageBucket {
	id: string;
	name: string;
	description?: string;
	window?: string;
	/** 剩余比例 0..1 */
	remainingFraction: number;
	/** 重置时间（ISO8601） */
	resetTime?: string;
}

export interface AgyUsageGroup {
	name: string;
	description?: string;
	buckets: AgyUsageBucket[];
}

export interface AgyUsageSnapshot {
	groups: AgyUsageGroup[];
	/** 失败原因（调用方展示；成功时 undefined） */
	error?: string;
	/** 查询时刻 */
	at: number;
}

/** 进程级守卫：同一用户动作 1 秒内只允许一次（防止前端连点变成轮询）。 */
const guard = new QuotaCallGuard(1000);

/**
 * 解析 `agy -p /usage --output-format json` 的输出。
 * 兼容两种形态：结构化 `command.data.groups` 与纯文本 `response` 行。
 */
export function parseAgyUsageOutput(stdout: string): AgyUsageReport {
	const text = stdout.trim();
	if (!text) throw new Error("agy /usage 返回为空");
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		throw new Error("agy /usage 返回不是 JSON（请确认 agy >= 1.5.5）");
	}
	const payload = parsed as {
		command?: { data?: { groups?: AgyUsageReport["groups"] } };
		response?: string;
		status?: string;
	};
	if (payload.status && payload.status !== "SUCCESS") {
		throw new Error(`agy /usage 状态异常：${payload.status}`);
	}
	const structured = payload.command?.data?.groups;
	if (Array.isArray(structured) && structured.length > 0) {
		return { groups: structured, raw: parsed };
	}
	// 文本兜底：`Gemini Models\tWeekly Limit Remaining\t95%\t2026-11-21T09:58:06Z`
	const groups: AgyUsageReport["groups"] = [];
	for (const line of (payload.response ?? "").split(/\r?\n/)) {
		const cells = line.split("\t");
		if (cells.length < 3) continue;
		const [groupName, bucketName, remaining] = cells;
		const fraction = Number.parseFloat(String(remaining).replace("%", "")) / 100;
		if (!Number.isFinite(fraction)) continue;
		let group = groups.find((g) => g.name === groupName);
		if (!group) {
			group = { name: groupName, buckets: [] };
			groups.push(group);
		}
		group.buckets.push({
			id: `${groupName}:${bucketName}`,
			name: bucketName,
			window: /weekly/i.test(bucketName) ? "weekly" : /5.?hour|five.?hour/i.test(bucketName) ? "5h" : undefined,
			remaining_fraction: fraction,
		});
	}
	return { groups, raw: parsed };
}

/** 归一化成 UI 快照（比例转 0..1，未知字段忽略）。 */
export function toUsageSnapshot(report: AgyUsageReport, at = Date.now()): AgyUsageSnapshot {
	return {
		groups: report.groups.map((group) => ({
			name: group.name,
			description: group.description,
			buckets: (group.buckets ?? []).map((bucket) => ({
				id: bucket.id,
				name: bucket.name,
				description: bucket.description,
				window: bucket.window,
				remainingFraction:
					typeof bucket.remaining_fraction === "number" ? Math.max(0, Math.min(1, bucket.remaining_fraction)) : 0,
				resetTime: bucket.reset_time,
			})),
		})),
		at,
	};
}

/** 单行摘要（通知/日志用，zh + en 各一行）。 */
export function formatUsageLines(snapshot: AgyUsageSnapshot, lang: "zh" | "en" = "zh"): string[] {
	if (snapshot.error)
		return [lang === "zh" ? `额度查询失败：${snapshot.error}` : `Quota query failed: ${snapshot.error}`];
	const lines: string[] = [];
	for (const group of snapshot.groups) {
		const parts = group.buckets.map((bucket) => {
			const pct = `${Math.round(bucket.remainingFraction * 100)}%`;
			const label = lang === "zh" ? bucket.name : bucket.name;
			return `${label} ${pct}${bucket.resetTime ? (lang === "zh" ? `（重置 ${bucket.resetTime}）` : ` (resets ${bucket.resetTime})`) : ""}`;
		});
		lines.push(`${group.name}: ${parts.join(" · ")}`);
	}
	return lines;
}

/**
 * 查询一次额度（用户动作驱动）。
 *
 * @param reason 用户动作标识（例如 `slash:/usage`、`settings:refresh`）；空值会被守卫拒绝。
 */
export async function queryAgyUsage(options?: {
	reason: string;
	command?: string;
	cwd?: string;
	timeoutMs?: number;
}): Promise<AgyUsageSnapshot> {
	const reason = options?.reason ?? "";
	guard.assertUserInitiated(reason);
	const command = options?.command ?? "agy";
	const timeoutMs = options?.timeoutMs ?? 25_000;
	const at = Date.now();
	try {
		const stdout = await new Promise<string>((resolve, reject) => {
			execFile(
				command,
				["-p", "/usage", "--output-format", "json"],
				{
					cwd: options?.cwd,
					timeout: timeoutMs,
					windowsHide: true,
					maxBuffer: 4 * 1024 * 1024,
					env: { ...process.env, NO_COLOR: "1" },
				},
				(err, out) => {
					if (err) reject(err instanceof Error ? err : new Error(String(err)));
					else resolve(String(out));
				},
			);
		});
		return toUsageSnapshot(parseAgyUsageOutput(stdout), at);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return { groups: [], at, error: message };
	}
}
