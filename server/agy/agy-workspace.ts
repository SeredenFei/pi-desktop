/**
 * agy-workspace.ts — 切到 agy 内核后「原工作流无缝共享」的两块接线：
 *
 *   1. **技能库软链接直通**：Antigravity CLI 原生支持渐进式技能目录
 *      （`<project>/.agents/skills/<name>/SKILL.md`）。这里把已有的技能目录
 *      （默认 `~/.pi/agent/skills` 与项目 `.pi/skills`）软链到项目 `.agents/skills/`，
 *      两个内核读同一份技能规范，不复制、不改写、不接管。
 *   2. **自定义工具走标准 MCP**：不做反向桥接、不把宿主的全套基础工具塞进去；
 *      只把用户自己的极简 stdio MCP 服务写进项目 `.agents/mcp_config.json`，
 *      由 ACP `session/new` 的 `mcpServers` 参数原生交给 agy 连接。
 *
 * 两者都是**幂等、显式**操作：不在内核启动时偷偷改盘（只在用户点击 / 命令行动作里执行）。
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	realpathSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AcpMcpServerStdio } from "./agy-types.js";

/** 项目内 Antigravity 自定义根目录。 */
export function agyProjectRoot(projectRoot: string): string {
	return join(projectRoot, ".agents");
}

/** 项目技能目录（agy 原生发现的渐进式技能根）。 */
export function agySkillsDir(projectRoot: string): string {
	return join(agyProjectRoot(projectRoot), "skills");
}

/** 项目 MCP 配置文件（stdio 服务声明；由 ACP session/new 透传给 agy）。 */
export function agyMcpConfigPath(projectRoot: string): string {
	return join(agyProjectRoot(projectRoot), "mcp_config.json");
}

/** 全局 MCP 配置文件（`agy mcp add` 写入的那份；仅供文档/提示引用）。 */
export function agyGlobalMcpConfigPath(): string {
	return join(homedir(), ".gemini", "config", "mcp_config.json");
}

/** 默认技能来源：全局 pi 技能库 + 项目内 pi 技能库（存在才纳入）。 */
export function defaultSkillSources(projectRoot: string): string[] {
	const candidates = [join(homedir(), ".pi", "agent", "skills"), join(projectRoot, ".pi", "skills")];
	return candidates.filter((dir) => existsSync(dir));
}

export interface SkillLinkResult {
	linked: string[];
	existing: string[];
	skipped: Array<{ name: string; reason: string }>;
	errors: Array<{ name: string; reason: string }>;
}

/**
 * 把技能目录软链到 `<project>/.agents/skills/`。
 *
 * - 目标已存在且是**指向同一路径**的软链 → 记为 existing（幂等）。
 * - 目标已存在但是真实目录/文件 → 跳过且**绝不覆盖**（用户手工放进去的优先）。
 * - 源目录没有 `SKILL.md` → 跳过（agy 只认渐进式技能规范）。
 */
export function linkSkillsIntoProject(projectRoot: string, sourceDirs?: string[]): SkillLinkResult {
	const result: SkillLinkResult = { linked: [], existing: [], skipped: [], errors: [] };
	const target = agySkillsDir(projectRoot);
	const sources = sourceDirs ?? defaultSkillSources(projectRoot);
	mkdirSync(target, { recursive: true });

	for (const sourceDir of sources) {
		let entries: string[] = [];
		try {
			entries = readdirSync(sourceDir, { withFileTypes: true })
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => entry.name);
		} catch (err) {
			result.errors.push({ name: sourceDir, reason: (err as Error).message });
			continue;
		}
		for (const name of entries) {
			const src = resolve(sourceDir, name);
			if (!existsSync(join(src, "SKILL.md"))) {
				result.skipped.push({ name, reason: "缺少 SKILL.md（不是渐进式技能目录）" });
				continue;
			}
			const dst = join(target, name);
			try {
				const stat = lstatSync(dst, { throwIfNoEntry: false });
				if (stat) {
					if (stat.isSymbolicLink() && existsSync(dst) && realpathSync(dst) === realpathSync(src)) {
						result.existing.push(name);
					} else {
						result.skipped.push({ name, reason: "目标已存在（不覆盖）" });
					}
					continue;
				}
				// junction 在 Windows 上无需管理员权限；POSIX 走普通目录软链
				symlinkSync(src, dst, process.platform === "win32" ? "junction" : "dir");
				result.linked.push(name);
			} catch (err) {
				result.errors.push({ name, reason: (err as Error).message });
			}
		}
	}
	return result;
}

/** 读取项目 `.agents/mcp_config.json`（不存在 = 空表；损坏时抛错，不静默吞）。 */
export function readProjectMcpConfig(projectRoot: string): AcpMcpServerStdio[] {
	const path = agyMcpConfigPath(projectRoot);
	if (!existsSync(path)) return [];
	const raw = JSON.parse(readFileSync(path, "utf8")) as {
		mcpServers?: Record<
			string,
			{ command?: string; args?: string[]; env?: Record<string, string> | Array<{ name: string; value: string }> }
		>;
	};
	const servers: AcpMcpServerStdio[] = [];
	for (const [name, def] of Object.entries(raw.mcpServers ?? {})) {
		if (!def?.command) continue;
		const env = Array.isArray(def.env)
			? def.env
			: Object.entries(def.env ?? {}).map(([key, value]) => ({ name: key, value: String(value) }));
		servers.push({ name, command: def.command, args: def.args ?? [], env });
	}
	return servers;
}

/** 合并写入项目 `.agents/mcp_config.json`（保留未知字段；同名覆盖）。 */
export function upsertProjectMcpServer(
	projectRoot: string,
	server: { name: string; command: string; args?: string[]; env?: Record<string, string> },
): string {
	const path = agyMcpConfigPath(projectRoot);
	mkdirSync(agyProjectRoot(projectRoot), { recursive: true });
	let config: Record<string, unknown> = {};
	if (existsSync(path)) {
		try {
			config = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		} catch {
			config = {};
		}
	}
	const servers = (config.mcpServers as Record<string, unknown> | undefined) ?? {};
	servers[server.name] = {
		command: server.command,
		args: server.args ?? [],
		env: server.env ?? {},
	};
	config.mcpServers = servers;
	writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
	return path;
}

/** 技能目录名（文档/日志展示用）。 */
export function skillDirName(path: string): string {
	return basename(path);
}
