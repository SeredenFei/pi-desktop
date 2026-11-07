/**
 * 用户终端 shell 解析与探测（纯函数 + 异步探测，零同步子进程）。
 *
 * 优先级（见 docs/architecture-terminal.md「终端 shell 解析」）：
 *   PI_WEB_SHELL > 设置 terminalShell（磁盘上存在才用）> POSIX 登录 shell
 *   （passwd，`os.userInfo().shell`）> $SHELL > bash。
 * Windows 保持原有顺序，仅在 PI_WEB_SHELL 之后插入设置值。
 *
 * 与 `resolveBashShell()`（ai-bash 永远 bash）无关，本模块不碰它。
 */
import { existsSync } from "node:fs";
import { access, constants, readFile, realpath } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join, posix, win32 } from "node:path";
import { formatRemoteWorkspaceUri, getGlobalRemoteSshService } from "./remote-ssh-service.js";
import type { RemoteSshProfileSummary } from "./protocol.js";

export interface ShellChoice {
	shell: string;
	args: string[];
}

/** 面向设置面板 / 新建下拉的可选 shell。 */
export interface ShellOption {
	path: string;
	label: string;
}

/** 面向新建终端下拉菜单的可选远程 SSH 主机。 */
export interface SshHostOption {
	label: string;
	uri: string;
	source: "profile" | "ssh_config";
}

/** 解析器的外部依赖——全部可注入，单测不碰真实磁盘/系统。 */
export interface ShellDeps {
	platform: NodeJS.Platform;
	env: Record<string, string | undefined>;
	/** passwd 里的登录 shell（`os.userInfo().shell`）；不可得为 null/undefined。 */
	loginShell: () => string | null | undefined;
	exists: (path: string) => boolean;
	homedir: () => string;
}

export function systemShellDeps(): ShellDeps {
	return {
		platform: process.platform,
		env: process.env,
		loginShell: () => {
			try {
				return userInfo().shell;
			} catch {
				// 无 passwd 记录（容器里用任意 uid 运行）——退回 $SHELL。
				return null;
			}
		},
		exists: existsSync,
		homedir,
	};
}

/** passwd 里给服务账号用的“假 shell”，不是交互 shell。 */
const NON_INTERACTIVE = new Set(["nologin", "false", "true", "sync", "shutdown", "halt"]);

function baseName(p: string): string {
	return p.split(/[\\/]/).pop() ?? p;
}

function stem(p: string): string {
	return baseName(p)
		.toLowerCase()
		.replace(/\.exe$/, "");
}

export function isInteractiveShellPath(p: string): boolean {
	return !!p && !NON_INTERACTIVE.has(stem(p));
}

/**
 * 交互参数。
 * - bash 只给 `-i`：加 `-l` 会让 bash 改读 ~/.bash_profile 而跳过 ~/.bashrc，
 *   不少用户的 bash_profile 不 source bashrc → 行为回退。
 * - zsh / fish 给 `-l -i`：服务进程常由 launchd/systemd/桌面壳拉起，环境里没有登录
 *   shell 才会设的 PATH（~/.zprofile 里的 brew shellenv、nvm 等）；`-l -i` 对这两者
 *   是 `-i` 的超集（.zshrc / config.fish 照读），不会丢配置。
 * - 其它（sh、cmd.exe、powershell、wsl.exe…）本身交互或无需参数 → []。
 */
export function shellArgsFor(shell: string): string[] {
	const s = stem(shell);
	if (s === "bash") return ["-i"];
	if (s === "zsh" || s === "fish") return ["-l", "-i"];
	return [];
}

function isAbs(p: string): boolean {
	return posix.isAbsolute(p) || win32.isAbsolute(p);
}

/**
 * 把设置值落到磁盘上的真实可执行文件：绝对路径直接校验；裸命令名（如 `zsh`）
 * 沿 PATH 查找。不存在返回 null（调用方继续下一优先级）。
 */
export function resolveConfiguredShell(configured: string, deps: ShellDeps): string | null {
	const v = configured.trim();
	if (!v) return null;
	if (isAbs(v)) return deps.exists(v) ? v : null;
	// 含路径分隔符的相对路径不解析（避免依赖 cwd）。
	if (/[\\/]/.test(v)) return null;
	const win = deps.platform === "win32";
	const dirs = (deps.env.PATH ?? deps.env.Path ?? "").split(win ? ";" : ":").filter(Boolean);
	const exts = win && !/\.[a-z0-9]+$/i.test(v) ? [".exe", ".cmd", ".bat", ""] : [""];
	const j = win ? win32.join : posix.join;
	for (const d of dirs)
		for (const e of exts) {
			const cand = j(d, v + e);
			if (deps.exists(cand)) return cand;
		}
	return null;
}

function windowsGitBash(deps: ShellDeps): string[] {
	const pf = deps.env.ProgramFiles;
	const pf86 = deps.env["ProgramFiles(x86)"];
	return [
		pf ? win32.join(pf, "Git", "bin", "bash.exe") : "",
		pf86 ? win32.join(pf86, "Git", "bin", "bash.exe") : "",
	].filter(Boolean);
}

/** 用户终端 shell 的选择（纯函数；每次建终端时调用）。 */
export function pickUserShell(configured: string, deps: ShellDeps): ShellChoice {
	const explicit = deps.env.PI_WEB_SHELL;
	if (explicit) return { shell: explicit, args: shellArgsFor(explicit) };
	const chosen = resolveConfiguredShell(configured, deps);
	if (chosen) return { shell: chosen, args: shellArgsFor(chosen) };

	if (deps.platform === "win32") {
		const she = deps.env.SHELL;
		if (she && deps.exists(she)) return { shell: she, args: shellArgsFor(she) };
		for (const cand of windowsGitBash(deps)) {
			if (deps.exists(cand)) return { shell: cand, args: ["-i"] };
		}
		const busybox = win32.join(deps.homedir(), ".pi-web", "bin", "bash.exe");
		if (deps.exists(busybox)) return { shell: busybox, args: ["-i"] };
		return { shell: deps.env.COMSPEC || "powershell.exe", args: [] };
	}

	let login: string | null | undefined;
	try {
		login = deps.loginShell();
	} catch {
		login = null; // 无 passwd 记录 → 退回 $SHELL
	}
	if (login && isAbs(login) && isInteractiveShellPath(login) && deps.exists(login)) {
		return { shell: login, args: shellArgsFor(login) };
	}
	const she = deps.env.SHELL;
	if (she && isInteractiveShellPath(she) && (!isAbs(she) || deps.exists(she))) {
		return { shell: she, args: shellArgsFor(she) };
	}
	return { shell: "bash", args: ["-i"] };
}

// ---------------------------------------------------------------------------
// 异步探测（fs.promises；禁 spawnSync/execSync）
// ---------------------------------------------------------------------------

async function isExecutable(p: string): Promise<boolean> {
	try {
		await access(p, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** 解析 /etc/shells 文本：去注释/空行，只留绝对路径，去重保序。 */
export function parseEtcShells(text: string): string[] {
	const out: string[] = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.replace(/#.*/, "").trim();
		if (!line || !posix.isAbsolute(line) || out.includes(line)) continue;
		out.push(line);
	}
	return out;
}

async function filterExisting(paths: string[]): Promise<string[]> {
	const ok: string[] = [];
	const seen = new Set<string>();
	for (const p of paths) {
		if (!isInteractiveShellPath(p) || !(await isExecutable(p))) continue;
		// /bin/bash 与 /usr/bin/bash（usrmerge）指向同一文件时只列第一项。
		let key = p;
		try {
			key = await realpath(p);
		} catch {
			/* 取不到就按原路径去重 */
		}
		if (seen.has(key)) continue;
		seen.add(key);
		ok.push(p);
	}
	return ok;
}

async function detectWindowsShells(env: Record<string, string | undefined>): Promise<ShellOption[]> {
	const pf = env.ProgramFiles;
	const pf86 = env["ProgramFiles(x86)"];
	const sysRoot = env.SystemRoot || env.windir || "C:\\Windows";
	const sys32 = win32.join(sysRoot, "System32");
	const cands: ShellOption[] = [
		...(pf ? [{ path: win32.join(pf, "Git", "bin", "bash.exe"), label: "Git Bash" }] : []),
		...(pf86 ? [{ path: win32.join(pf86, "Git", "bin", "bash.exe"), label: "Git Bash (x86)" }] : []),
		...(pf ? [{ path: win32.join(pf, "PowerShell", "7", "pwsh.exe"), label: "PowerShell 7 (pwsh)" }] : []),
		{ path: win32.join(sys32, "WindowsPowerShell", "v1.0", "powershell.exe"), label: "Windows PowerShell" },
		{ path: env.COMSPEC || win32.join(sys32, "cmd.exe"), label: "Command Prompt (cmd)" },
		{ path: win32.join(sys32, "wsl.exe"), label: "WSL (wsl.exe)" },
	];
	const out: ShellOption[] = [];
	for (const c of cands) {
		if (await isExecutable(c.path)) out.push(c);
	}
	return out;
}

/** 探测本机可用 shell：POSIX 读 /etc/shells 并过滤存在项；Windows 列候选。 */
export async function detectShells(deps: ShellDeps = systemShellDeps()): Promise<ShellOption[]> {
	if (deps.platform === "win32") return detectWindowsShells(deps.env);
	let listed: string[] = [];
	try {
		listed = parseEtcShells(await readFile("/etc/shells", "utf8"));
	} catch {
		// /etc/shells 不存在（容器/Termux）：退回登录 shell、$SHELL 与常见位置。
		const login = deps.loginShell();
		listed = [login ?? "", deps.env.SHELL ?? "", "/bin/bash", "/bin/zsh", "/bin/sh"].filter(isAbs);
	}
	return (await filterExisting(listed)).map((path) => ({ path, label: baseName(path) }));
}

const SHELL_LIST_TTL_MS = 30_000;
let shellListCache: { at: number; list: ShellOption[] } | null = null;
let shellListInflight: Promise<ShellOption[]> | null = null;

/** 带 30s 缓存的探测（设置面板 / 新建下拉每次打开都会问，避免反复读盘）。 */
export function listAvailableShells(): Promise<ShellOption[]> {
	if (shellListCache && Date.now() - shellListCache.at < SHELL_LIST_TTL_MS) return Promise.resolve(shellListCache.list);
	shellListInflight ??= detectShells()
		.then((list) => {
			shellListCache = { at: Date.now(), list };
			return list;
		})
		.finally(() => {
			shellListInflight = null;
		});
	return shellListInflight;
}

/** 同步读取最近一次探测结果（`create()` 校验用；调用方须先 `await listAvailableShells()`）。 */
export function cachedShellList(): ShellOption[] {
	return shellListCache?.list ?? [];
}

/** 仅测试用：清空探测缓存。 */
export function resetShellListCacheForTest(): void {
	shellListCache = null;
	shellListInflight = null;
}

/**
 * `terminal_create.shell` 的白名单校验：必须在探测列表内，或等于当前设置值。
 * 通过才返回可 spawn 的路径；任何其它值（含带参数/拼接命令的字符串）一律 null，
 * 杜绝经协议注入任意可执行文件。
 */
export function validateRequestedShell(
	requested: string,
	configured: string,
	detected: readonly ShellOption[],
	deps: ShellDeps = systemShellDeps(),
): string | null {
	const r = requested.trim();
	if (!r || r.length > 1024 || /[\0\r\n]/.test(r)) return null;
	if (detected.some((s) => s.path === r)) return r;
	if (configured.trim() && r === configured.trim()) return resolveConfiguredShell(r, deps);
	return null;
}

/** 设置值归一：去首尾空白、拒绝控制字符、限长。非法返回 ""（= 自动）。 */
export function normalizeTerminalShell(v: unknown): string {
	if (typeof v !== "string") return "";
	const s = v.trim();
	if (!s || s.length > 1024 || /[\0\r\n]/.test(s)) return "";
	return s;
}

function defaultSystemUsername(): string {
	try {
		const u = userInfo().username?.trim();
		if (u) return u;
	} catch {
		/* ignore */
	}
	return process.env.USER?.trim() || process.env.USERNAME?.trim() || "root";
}

/**
 * 解析 `~/.ssh/config` 文本中的非通配 Host 条目（纯函数，无磁盘/子进程调用）。
 * 提取 Host 别名、HostName、User（缺省用 defaultUser）、Port（缺省 22），生成 `ssh://user@host:port/~`。
 */
export function parseSshConfigHosts(content: string, defaultUser = defaultSystemUsername()): SshHostOption[] {
	const out: SshHostOption[] = [];
	const seenUris = new Set<string>();
	let currentAliases: string[] = [];
	let hostName = "";
	let user = "";
	let port = 22;

	const flush = () => {
		if (currentAliases.length === 0) return;
		const effUser = (user || defaultUser || "root").trim();
		const effPort = Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22;
		for (const alias of currentAliases) {
			const effHost = (hostName || alias).trim();
			if (!effHost || !effUser || /[\s@]/.test(effHost) || /[\s@]/.test(effUser)) continue;
			const uri = `ssh://${effUser}@${effHost}:${effPort}/~`;
			if (seenUris.has(`${alias}::${uri}`)) continue;
			seenUris.add(`${alias}::${uri}`);
			const label = hostName && hostName !== alias ? `${alias} (${effUser}@${effHost})` : `${alias} (${effUser})`;
			out.push({ label, uri, source: "ssh_config" });
		}
		currentAliases = [];
		hostName = "";
		user = "";
		port = 22;
	};

	for (const rawLine of content.split(/\r?\n/)) {
		const line = rawLine.replace(/#.*/, "").trim();
		if (!line) continue;
		const m = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=|\s)\s*(.+)$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const rawVal = m[2].trim().replace(/^["']|["']$/g, "");
		if (!rawVal) continue;

		if (key === "host") {
			flush();
			currentAliases = rawVal
				.split(/\s+/)
				.map((p) => p.replace(/^["']|["']$/g, "").trim())
				.filter((p) => Boolean(p) && !/[*?!]/.test(p));
		} else if (key === "match") {
			flush();
		} else if (currentAliases.length > 0) {
			if (key === "hostname" && !hostName) {
				hostName = rawVal;
			} else if (key === "user" && !user) {
				user = rawVal;
			} else if (key === "port" && port === 22) {
				const p = parseInt(rawVal, 10);
				if (Number.isInteger(p) && p >= 1 && p <= 65535) port = p;
			}
		}
	}
	flush();
	return out;
}

/**
 * 异步汇总已保存的 SSH 配置（`ssh-profiles.json`）与 `~/.ssh/config` 主机列表（纯 fs.promises，无同步子进程）。
 */
export async function listAvailableSshHosts(
	sshProfiles?: RemoteSshProfileSummary[],
	sshConfigText?: string,
	defaultUser = defaultSystemUsername(),
): Promise<SshHostOption[]> {
	const out: SshHostOption[] = [];
	const seenUris = new Set<string>();

	let profiles = sshProfiles;
	if (!profiles) {
		try {
			profiles = (await getGlobalRemoteSshService()?.listProfiles()) ?? [];
		} catch {
			profiles = [];
		}
	}
	for (const p of profiles) {
		if (!p?.host || !p?.username) continue;
		const port = p.port || 22;
		const remotePath = p.remotePath?.trim() || "/~";
		const uri =
			remotePath === "/~" || remotePath === "~"
				? `ssh://${p.username}@${p.host}:${port}/~`
				: formatRemoteWorkspaceUri(p.username, p.host, port, remotePath);
		if (seenUris.has(uri)) continue;
		seenUris.add(uri);
		const label =
			p.name && p.name !== `${p.username}@${p.host}`
				? `${p.name} (${p.username}@${p.host})`
				: `${p.username}@${p.host}`;
		out.push({ label, uri, source: "profile" });
	}

	let cfgText = sshConfigText;
	if (cfgText === undefined) {
		try {
			cfgText = await readFile(join(homedir(), ".ssh", "config"), "utf8");
		} catch {
			cfgText = "";
		}
	}
	if (cfgText) {
		for (const item of parseSshConfigHosts(cfgText, defaultUser)) {
			if (seenUris.has(item.uri)) continue;
			seenUris.add(item.uri);
			out.push(item);
		}
	}
	return out;
}
