import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkspaceSessionDir } from "../../server/remote-ssh-service.js";
import { TerminalManager } from "../../server/terminals.js";

/** safeCwd 是私有方法：经真实实例（emit 空实现）转发调用。
 *  远程工作区根是 ssh:// URI——本地边界（realpath/relative）无法解析它，
 *  修复前远程终端的每次创建/接管命令都会被「必须位于工作区内」拒掉。 */
const safeCwdOf = (
	workspaceRoot: string | (() => string),
	ownerKind: "client" | "conversation" = "conversation",
): ((raw: string) => string | null) => {
	const mgr = new TerminalManager(() => {}, workspaceRoot, undefined, ownerKind);
	return (mgr as unknown as { safeCwd(raw: string): string | null }).safeCwd.bind(mgr);
};

describe("safeCwd：远程 ssh:// 工作区（0.103 审计修复）", () => {
	it("远程 URI 与相对路径都挂到远程根下解析", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev:22/srv/app/logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("./logs")).toBe("ssh://root@dev:22/srv/app/logs");
		expect(safeCwd("")).toBe("ssh://root@dev:22/srv/app");
	});

	it("无端口 URI 规范化补全 22（spawnShell 的 URI 正则要求带端口）", () => {
		const safeCwd = safeCwdOf("ssh://root@dev/srv/app");
		expect(safeCwd("")).toBe("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev/srv/app/sub")).toBe("ssh://root@dev:22/srv/app/sub");
	});

	it("跨主机/跨用户拒绝", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@other:22/srv")).toBeNull();
		expect(safeCwd("ssh://adm@dev:22/srv")).toBeNull();
		expect(safeCwd("ssh://root@dev:2222/srv")).toBeNull();
	});

	it("同主机绝对 URI 也不能越出远程项目根", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("ssh://root@dev:22/etc")).toBeNull();
		expect(safeCwd("ssh://root@dev:22/srv/app/../../etc")).toBeNull();
		expect(safeCwd("ssh://root@dev:22/srv/application")).toBeNull();
		expect(safeCwd("ssh://root@dev:22/srv/app/sub/..")).toBe("ssh://root@dev:22/srv/app");
	});

	it("相对路径越出远程根拒绝", () => {
		const safeCwd = safeCwdOf("ssh://root@dev:22/srv/app");
		expect(safeCwd("../../etc")).toBeNull();
		expect(safeCwd("..\\..\\etc")).toBeNull();
	});

	it("本地映射会话目录（含 .pi-remote-uri）自动还原为远程 ssh:// URI", () => {
		const dataDir = mkdtempSync(join(tmpdir(), "pi-term-safecwd-"));
		try {
			const remoteUri = "ssh://ubuntu@10.0.0.8:2222/home/ubuntu/proj";
			const mappedSessionDir = resolveWorkspaceSessionDir(dataDir, remoteUri);
			const safeCwd = safeCwdOf(mappedSessionDir, "client");
			expect(safeCwd(mappedSessionDir)).toBe(remoteUri);
			expect(safeCwd("")).toBe(remoteUri);
			expect(safeCwd("sub")).toBe("ssh://ubuntu@10.0.0.8:2222/home/ubuntu/proj/sub");
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("用户终端（ownerKind=client）允许在本地项目下直接打开任意合法 ssh:// 主机，非法 URI 拒绝", () => {
		const safeCwdClient = safeCwdOf(process.cwd(), "client");
		expect(safeCwdClient("ssh://dev@192.168.1.10:22/~")).toBe("ssh://dev@192.168.1.10:22/~");
		expect(safeCwdClient("ssh://dev@192.168.1.10/var/log")).toBe("ssh://dev@192.168.1.10:22/var/log");
		expect(safeCwdClient("ssh://invalid-uri-without-user")).toBeNull();
		expect(safeCwdClient("ssh://")).toBeNull();

		// 会话级 AI 终端（ownerKind=conversation）在本地项目下仍拒绝跨主机 ssh://
		const safeCwdConv = safeCwdOf(process.cwd(), "conversation");
		expect(safeCwdConv("ssh://dev@192.168.1.10:22/~")).toBeNull();
	});
});
