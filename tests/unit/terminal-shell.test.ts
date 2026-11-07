import { describe, expect, it } from "vitest";
import { TerminalManager } from "../../server/terminals.js";
import {
	listAvailableSshHosts,
	normalizeTerminalShell,
	parseEtcShells,
	parseSshConfigHosts,
	pickUserShell,
	resolveConfiguredShell,
	shellArgsFor,
	validateRequestedShell,
	type ShellDeps,
} from "../../server/terminal-shell.js";

function deps(over: Partial<ShellDeps> & { files?: string[] } = {}): ShellDeps {
	const files = new Set(over.files ?? []);
	return {
		platform: "linux",
		env: {},
		loginShell: () => null,
		exists: (p) => files.has(p),
		homedir: () => "/home/u",
		...over,
	};
}

describe("shellArgsFor", () => {
	it("bash keeps -i (never -l: would skip ~/.bashrc)", () => {
		expect(shellArgsFor("/bin/bash")).toEqual(["-i"]);
		expect(shellArgsFor("C:\\Program Files\\Git\\bin\\bash.exe")).toEqual(["-i"]);
	});
	it("zsh / fish are login+interactive so .zprofile PATH is loaded", () => {
		expect(shellArgsFor("/usr/bin/zsh")).toEqual(["-l", "-i"]);
		expect(shellArgsFor("/opt/homebrew/bin/fish")).toEqual(["-l", "-i"]);
	});
	it("everything else gets no args", () => {
		for (const s of ["/bin/sh", "/usr/bin/dash", "cmd.exe", "C:\\Windows\\System32\\wsl.exe", "pwsh.exe"])
			expect(shellArgsFor(s)).toEqual([]);
	});
});

describe("pickUserShell — POSIX priority", () => {
	const files = ["/usr/bin/zsh", "/bin/bash", "/usr/bin/fish", "/bin/sh"];

	it("PI_WEB_SHELL beats the setting, even if the file is unchecked", () => {
		const r = pickUserShell("/usr/bin/zsh", deps({ files, env: { PI_WEB_SHELL: "/x/custom" } }));
		expect(r).toEqual({ shell: "/x/custom", args: [] });
	});
	it("setting beats login shell and $SHELL when it exists", () => {
		const r = pickUserShell(
			"/usr/bin/zsh",
			deps({ files, loginShell: () => "/bin/bash", env: { SHELL: "/usr/bin/fish" } }),
		);
		expect(r).toEqual({ shell: "/usr/bin/zsh", args: ["-l", "-i"] });
	});
	it("setting that does not exist is skipped", () => {
		const r = pickUserShell("/nope/zsh", deps({ files, loginShell: () => "/usr/bin/fish" }));
		expect(r.shell).toBe("/usr/bin/fish");
	});
	it("bare command name in the setting is resolved through PATH", () => {
		const r = pickUserShell("zsh", deps({ files, env: { PATH: "/nope:/usr/bin" } }));
		expect(r.shell).toBe("/usr/bin/zsh");
	});
	it("login shell (passwd) beats $SHELL — macOS GUI launch with stripped env", () => {
		const r = pickUserShell("", deps({ files, loginShell: () => "/usr/bin/zsh", env: { SHELL: "/bin/bash" } }));
		expect(r.shell).toBe("/usr/bin/zsh");
	});
	it("nologin / missing login shell falls through to $SHELL", () => {
		const f = [...files, "/usr/sbin/nologin"];
		expect(
			pickUserShell("", deps({ files: f, loginShell: () => "/usr/sbin/nologin", env: { SHELL: "/usr/bin/fish" } }))
				.shell,
		).toBe("/usr/bin/fish");
		expect(
			pickUserShell("", deps({ files, loginShell: () => "/gone/zsh", env: { SHELL: "/usr/bin/fish" } })).shell,
		).toBe("/usr/bin/fish");
	});
	it("falls back to bash when nothing is known", () => {
		expect(pickUserShell("", deps())).toEqual({ shell: "bash", args: ["-i"] });
	});
	it("survives userInfo() having no passwd entry", () => {
		const r = pickUserShell(
			"",
			deps({
				files,
				loginShell: () => {
					throw new Error("ENOENT");
				},
				env: { SHELL: "/bin/bash" },
			}) as ShellDeps,
		);
		expect(r.shell).toBe("/bin/bash");
	});
});

describe("pickUserShell — Windows keeps its order, setting inserted after PI_WEB_SHELL", () => {
	const gitBash = "C:\\Program Files\\Git\\bin\\bash.exe";
	const base = {
		platform: "win32" as const,
		env: { ProgramFiles: "C:\\Program Files", COMSPEC: "C:\\Windows\\System32\\cmd.exe" },
	};

	it("setting wins over Git Bash", () => {
		const pw = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";
		const r = pickUserShell(pw, deps({ ...base, files: [gitBash, pw] }));
		expect(r).toEqual({ shell: pw, args: [] });
	});
	it("without setting: $SHELL > Git Bash > busybox > COMSPEC", () => {
		expect(pickUserShell("", deps({ ...base, files: [gitBash] })).shell).toBe(gitBash);
		expect(
			pickUserShell("", deps({ ...base, files: ["/s/bash.exe"], env: { ...base.env, SHELL: "/s/bash.exe" } })).shell,
		).toBe("/s/bash.exe");
		expect(
			pickUserShell(
				"",
				deps({ ...base, files: ["C:\\Users\\u\\.pi-web\\bin\\bash.exe"], homedir: () => "C:\\Users\\u" }),
			).shell,
		).toBe("C:\\Users\\u\\.pi-web\\bin\\bash.exe");
		expect(pickUserShell("", deps(base))).toEqual({ shell: "C:\\Windows\\System32\\cmd.exe", args: [] });
	});
	it("does not use the POSIX login-shell path on Windows", () => {
		const r = pickUserShell("", deps({ ...base, loginShell: () => "/usr/bin/zsh", files: ["/usr/bin/zsh"] }));
		expect(r.shell).toBe("C:\\Windows\\System32\\cmd.exe");
	});
	it("resolves wsl via PATH with .exe", () => {
		const r = resolveConfiguredShell(
			"wsl",
			deps({ ...base, env: { PATH: "C:\\Windows\\System32" }, files: ["C:\\Windows\\System32\\wsl.exe"] }),
		);
		expect(r).toBe("C:\\Windows\\System32\\wsl.exe");
	});
});

describe("parseEtcShells", () => {
	it("drops comments, blanks, relative entries and dupes", () => {
		const text = "# /etc/shells\n/bin/sh\n/bin/bash # main\n\nrbash\n/bin/sh\n/usr/bin/zsh\r\n";
		expect(parseEtcShells(text)).toEqual(["/bin/sh", "/bin/bash", "/usr/bin/zsh"]);
	});
});

describe("validateRequestedShell — terminal_create.shell whitelist", () => {
	const detected = [
		{ path: "/bin/bash", label: "bash" },
		{ path: "/usr/bin/zsh", label: "zsh" },
	];
	const d = deps({ files: ["/opt/custom/sh"] });
	it("accepts detected shells", () => {
		expect(validateRequestedShell("/usr/bin/zsh", "", detected, d)).toBe("/usr/bin/zsh");
	});
	it("accepts exactly the saved setting (when it exists)", () => {
		expect(validateRequestedShell("/opt/custom/sh", "/opt/custom/sh", detected, d)).toBe("/opt/custom/sh");
		expect(validateRequestedShell("/opt/custom/sh", "", detected, d)).toBeNull();
	});
	it("rejects everything else, including injection attempts", () => {
		for (const bad of [
			"/bin/rm",
			"/bin/bash -c 'curl x|sh'",
			"/bin/bash\n/bin/rm",
			"bash",
			"",
			"   ",
			"/usr/bin/zsh;id",
			"x".repeat(2000),
		])
			expect(validateRequestedShell(bad, "", detected, d)).toBeNull();
	});
	it("a saved setting that vanished from disk is rejected", () => {
		expect(validateRequestedShell("/gone/sh", "/gone/sh", detected, d)).toBeNull();
	});
});

describe("normalizeTerminalShell", () => {
	it("trims, and maps junk to auto", () => {
		expect(normalizeTerminalShell("  /usr/bin/zsh ")).toBe("/usr/bin/zsh");
		expect(normalizeTerminalShell(undefined)).toBe("");
		expect(normalizeTerminalShell(42)).toBe("");
		expect(normalizeTerminalShell("a\nb")).toBe("");
		expect(normalizeTerminalShell("x".repeat(1025))).toBe("");
	});
});

describe("TerminalManager.create — per-terminal shell gate", () => {
	it("rejects a shell outside the detected list / saved setting before spawning anything", () => {
		const events: Array<{ type: string; text?: string; textEn?: string }> = [];
		const mgr = new TerminalManager(
			(m) => events.push(m as never),
			process.cwd(),
			undefined,
			"client",
			() => "",
		);
		const info = mgr.create("t1", process.cwd(), 80, 24, process.cwd(), "t", { shell: "/bin/rm" });
		expect(info).toBeNull();
		expect(events.some((e) => e.type === "notice" && /Shell not allowed/.test(e.textEn ?? e.text ?? ""))).toBe(true);
		expect(mgr.has("t1")).toBe(false);
	});
});

describe("parseSshConfigHosts & listAvailableSshHosts", () => {
	it("parses non-wildcard Host blocks from ~/.ssh/config and skips wildcards/Match blocks", () => {
		const cfg = `
# Global defaults
Host *
  User globaluser
  ServerAliveInterval 60

Host dev-box prod-box
  HostName 10.0.1.25
  User ubuntu
  Port 2222

Host gpu-*.internal !bastion
  HostName 10.0.9.9

Host bastion
  User ops

Match host *.corp
  User corpuser
`;
		const hosts = parseSshConfigHosts(cfg, "sereden");
		expect(hosts).toEqual([
			{
				label: "dev-box (ubuntu@10.0.1.25)",
				uri: "ssh://ubuntu@10.0.1.25:2222/~",
				source: "ssh_config",
			},
			{
				label: "prod-box (ubuntu@10.0.1.25)",
				uri: "ssh://ubuntu@10.0.1.25:2222/~",
				source: "ssh_config",
			},
			{
				label: "bastion (ops)",
				uri: "ssh://ops@bastion:22/~",
				source: "ssh_config",
			},
		]);
	});

	it("merges saved SSH profiles with ~/.ssh/config and deduplicates by URI", async () => {
		const merged = await listAvailableSshHosts(
			[
				{
					name: "My GPU Server",
					host: "192.168.1.50",
					port: 22,
					username: "root",
					authType: "key",
					lastConnected: 1700000000000,
					remotePath: "/workspace/llm",
				},
			],
			`
Host gpu-home
  HostName 192.168.1.50
  User root
`,
			"sereden",
		);
		expect(merged).toEqual([
			{
				label: "My GPU Server (root@192.168.1.50)",
				uri: "ssh://root@192.168.1.50:22/workspace/llm",
				source: "profile",
			},
			{
				label: "gpu-home (root@192.168.1.50)",
				uri: "ssh://root@192.168.1.50:22/~",
				source: "ssh_config",
			},
		]);
	});
});
