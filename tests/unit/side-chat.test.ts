import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import express from "express";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { ClientStateStore } from "../../server/client-state.js";
import {
	SideChatStore,
	buildSideChatPrompt,
	deriveSideChatTitle,
	promoteSideChatToMainSession,
	registerSideChatRoutes,
} from "../../server/side-chat-service.js";
import { buildAnchorFromTranscript, drainNdjsonLines } from "../../web/src/side-chat-store.js";
import { BUILTIN_UI_ITEMS } from "../../web/src/ui-slots.js";
import type { UiMessage } from "../../web/src/types.js";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const d = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(d);
	return d;
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const d = tempDirs.pop();
		if (d) rmSync(d, { recursive: true, force: true });
	}
});

describe("SideChatStore 多话题持久化与主会话隔离", () => {
	it("按 mainSessionId 创建、更新、重开与删除侧边话题", () => {
		const dataDir = makeTempDir("pi-sidechat-store-");
		const store = new SideChatStore(dataDir);

		const t1 = store.createThread({
			mainSessionId: "sess-alpha",
			cwd: "/tmp/proj",
			anchor: {
				selectedText: "const safe = restoreWorkspaceUriFromSessionDir(raw);",
				messageId: "msg-10",
				role: "assistant",
				turnContext: "User: 怎么还原路径\n\nAssistant: 用 restoreWorkspaceUriFromSessionDir",
			},
			contextMode: "turn",
		});
		expect(t1.id).toMatch(/^sc-/);
		expect(t1.anchor?.messageId).toBe("msg-10");

		const afterUser = store.appendUserMessage("sess-alpha", t1.id, "这个函数在无标记文件时返回什么？");
		expect(afterUser?.title).toBe("这个函数在无标记文件时返回什么？");
		expect(afterUser?.messages).toHaveLength(1);

		const afterAssistant = store.appendAssistantMessage("sess-alpha", t1.id, {
			id: "scm-reply-1",
			role: "assistant",
			text: "当目录没有 `.pi-remote-uri` 时原样返回传入路径。",
			timestamp: Date.now(),
			model: "anthropic/claude-sonnet-4-5",
			tools: [{ id: "tc-1", name: "read", argsPreview: "server/remote-ssh-service.ts", status: "done" }],
		});
		expect(afterAssistant?.messages).toHaveLength(2);

		// 另一个主会话互不串数据
		store.createThread({
			mainSessionId: "sess-beta",
			cwd: "/tmp/proj",
			title: "Beta thread",
		});

		// 重新实例化验证落盘持久化恢复
		const reloaded = new SideChatStore(dataDir);
		expect(reloaded.listThreads("sess-alpha")).toHaveLength(1);
		expect(reloaded.listThreads("sess-alpha")[0].messages).toHaveLength(2);
		expect(reloaded.listThreads("sess-beta")).toHaveLength(1);

		// 更新模式与钉选模型
		const patched = reloaded.updateThread("sess-alpha", t1.id, {
			contextMode: "full",
			model: "google/gemini-2.5-flash",
		});
		expect(patched?.contextMode).toBe("full");
		expect(patched?.model).toBe("google/gemini-2.5-flash");

		// 删除后清空
		expect(reloaded.deleteThread("sess-alpha", t1.id)).toBe(true);
		expect(reloaded.listThreads("sess-alpha")).toHaveLength(0);
	});
});

describe("buildSideChatPrompt 上下文档位拼装", () => {
	const sampleAnchor = {
		selectedText: "return evaluateWhen(entry.when, ctx);",
		messageId: "m-2",
		role: "assistant",
		turnContext: "User:\n右键置灰怎么算？\n\nAssistant:\n调用 evaluateWhen。",
		fullContext: "[User]\n第一轮背景\n\n[Assistant]\n第二轮回复",
	};

	it("selection 档仅注入选区片段，不带单轮或全量历史", () => {
		const prompt = buildSideChatPrompt({ anchor: sampleAnchor, contextMode: "selection" }, "ctx 为空时会怎样？");
		expect(prompt).toContain("<selected_excerpt");
		expect(prompt).toContain("return evaluateWhen(entry.when, ctx);");
		expect(prompt).not.toContain("<source_turn_context>");
		expect(prompt).not.toContain("<main_conversation_context>");
	});

	it("turn 档注入单轮上下文 + 选区片段 + 历史追问", () => {
		const prompt = buildSideChatPrompt({ anchor: sampleAnchor, contextMode: "turn" }, "那 ! 前缀呢？", [
			{ id: "1", role: "user", text: "ctx 为空时会怎样？", timestamp: 1 },
			{ id: "2", role: "assistant", text: "未知肯定条件会被忽略。", timestamp: 2 },
		]);
		expect(prompt).toContain("<source_turn_context>");
		expect(prompt).toContain("<selected_excerpt");
		expect(prompt).toContain("<side_chat_history>");
		expect(prompt).toContain("未知肯定条件会被忽略。");
	});

	it("full 档注入完整上文块", () => {
		const prompt = buildSideChatPrompt({ anchor: sampleAnchor, contextMode: "full" }, "总结一下");
		expect(prompt).toContain("<main_conversation_context>");
		expect(prompt).toContain("第一轮背景");
	});

	it("deriveSideChatTitle 自动压缩空白并截断超长文本", () => {
		expect(deriveSideChatTitle("  第一行\n  第二行  ")).toBe("第一行 第二行");
		expect(deriveSideChatTitle("a".repeat(50)).endsWith("…")).toBe(true);
	});
});

describe("promoteSideChatToMainSession 升级为正式主对话", () => {
	it("将侧边问答固化为合法的 SDK .jsonl 会话文件", () => {
		const dataDir = makeTempDir("pi-sidechat-promote-data-");
		const workspaceDir = makeTempDir("pi-sidechat-promote-ws-");
		const store = new SideChatStore(dataDir);
		const th = store.createThread({
			mainSessionId: "main-1",
			cwd: workspaceDir,
			anchor: {
				selectedText: "const MAX_INFLIGHT = 4;",
				messageId: "msg-1",
				role: "assistant",
			},
		});
		store.appendUserMessage("main-1", th.id, "为什么要限制并发为 4？");
		const fullThread = store.appendAssistantMessage("main-1", th.id, {
			id: "a-1",
			role: "assistant",
			text: "避免瞬时并发请求打满上游配额。",
			timestamp: Date.now(),
			model: "openai/gpt-4.1",
		})!;

		const promoted = promoteSideChatToMainSession(fullThread, {
			dataDir,
			defaultCwd: workspaceDir,
		});
		expect(existsSync(promoted.sessionPath)).toBe(true);
		expect(promoted.title).toContain("💬");

		const opened = SessionManager.open(promoted.sessionPath);
		expect(opened.getSessionName()).toBe(promoted.title);
		const ctx = opened.buildSessionContext();
		expect(ctx.messages).toHaveLength(2);
	});
});

describe("前端辅助纯函数与 UI 槽位登记", () => {
	it("buildAnchorFromTranscript 提取对应轮次与前序完整上下文", () => {
		const msgs: UiMessage[] = [
			{ id: "u1", role: "user", content: [{ type: "text", text: "介绍架构" }], timestamp: 1 },
			{ id: "a1", role: "assistant", content: [{ type: "text", text: "采用快照驱动架构" }], timestamp: 2 },
			{ id: "u2", role: "user", content: [{ type: "text", text: "增量快照怎么自愈？" }], timestamp: 3 },
			{
				id: "a2",
				role: "assistant",
				content: [{ type: "text", text: "靠 baseRev 链检测缺口后重拉全量" }],
				timestamp: 4,
			},
		];
		const anchor = buildAnchorFromTranscript(msgs, "a2", "baseRev 链检测缺口");
		expect(anchor.selectedText).toBe("baseRev 链检测缺口");
		expect(anchor.turnContext).toContain("增量快照怎么自愈？");
		expect(anchor.turnContext).toContain("靠 baseRev 链检测缺口后重拉全量");
		expect(anchor.fullContext).toContain("[User]\n介绍架构");
	});

	it("drainNdjsonLines 正确处理跨 chunk 截断的半行 JSON", () => {
		const first = drainNdjsonLines('{"type":"text_delta","delta":"hel"}\n{"type":"text_del');
		expect(first.events).toEqual([{ type: "text_delta", delta: "hel" }]);
		expect(first.rest).toBe('{"type":"text_del');

		const second = drainNdjsonLines(`${first.rest}ta","delta":"lo"}\n`);
		expect(second.events).toEqual([{ type: "text_delta", delta: "lo" }]);
		expect(second.rest).toBe("");
	});

	it("BUILTIN_UI_ITEMS 登记右栏侧边聊天 Tab 与选区右键菜单动作", () => {
		expect(BUILTIN_UI_ITEMS.some((i) => i.id === "host:right-sidechat" && i.slot === "rightpanel.tabs")).toBe(true);
		const ctxIds = BUILTIN_UI_ITEMS.filter((i) => i.slot === "contextmenu.message").map((i) => i.id);
		expect(ctxIds).toContain("host:msg-ctx-side-chat");
		expect(ctxIds).toContain("host:msg-ctx-side-explain");
		expect(ctxIds).toContain("host:msg-ctx-side-translate");
		expect(ctxIds).toContain("host:msg-ctx-side-check");
		expect(ctxIds).toContain("host:msg-ctx-copy-selection");
		expect(ctxIds).toContain("host:msg-ctx-quote-selection");
	});
});

describe("registerSideChatRoutes HTTP API 端到端契约", () => {
	it("支持创建/更新/查询/升级会话/删除侧边话题 HTTP 路由", async () => {
		const dataDir = makeTempDir("pi-sidechat-http-data-");
		const agentDir = makeTempDir("pi-sidechat-http-agent-");
		const workspaceDir = makeTempDir("pi-sidechat-http-ws-");
		const stateStore = new ClientStateStore(dataDir);

		const app = express();
		const sideStore = registerSideChatRoutes(app, {
			dataDir,
			agentDir,
			defaultCwd: workspaceDir,
			stateStore,
		});

		const srv = createServer(app);
		await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
		const port = (srv.address() as AddressInfo).port;
		const base = `http://127.0.0.1:${port}`;

		try {
			// 1. 创建侧边话题
			const createRes = await fetch(`${base}/api/side-chat/threads`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					mainSessionId: "sess-http-1",
					cwd: workspaceDir,
					anchor: { selectedText: "export const PROTOCOL_VERSION = 44;", messageId: "m-99", role: "assistant" },
					contextMode: "turn",
				}),
			});
			expect(createRes.status).toBe(200);
			const created = (await createRes.json()) as { thread: { id: string; title: string } };
			expect(created.thread.id).toMatch(/^sc-/);

			// 写入一轮对话以测试升级
			sideStore.appendUserMessage("sess-http-1", created.thread.id, "为什么要同步双端版本号？");
			sideStore.appendAssistantMessage("sess-http-1", created.thread.id, {
				id: "ans-1",
				role: "assistant",
				text: "用于在原地升级未重启时向旧页面展示刷新提示。",
				timestamp: Date.now(),
			});

			// 2. 查询列表
			const listRes = await fetch(`${base}/api/side-chat/threads?mainSessionId=sess-http-1`);
			const listed = (await listRes.json()) as { threads: Array<{ id: string }> };
			expect(listed.threads).toHaveLength(1);

			// 3. 升级为正式主对话
			const promoteRes = await fetch(`${base}/api/side-chat/promote`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mainSessionId: "sess-http-1", threadId: created.thread.id }),
			});
			expect(promoteRes.status).toBe(200);
			const promoted = (await promoteRes.json()) as { ok: boolean; sessionPath: string };
			expect(promoted.ok).toBe(true);
			expect(existsSync(promoted.sessionPath)).toBe(true);

			// 4. 删除话题
			const delRes = await fetch(
				`${base}/api/side-chat/threads/${encodeURIComponent(created.thread.id)}?mainSessionId=sess-http-1`,
				{ method: "DELETE" },
			);
			expect(delRes.status).toBe(200);
			const afterDel = (await delRes.json()) as { threads: unknown[] };
			expect(afterDel.threads).toHaveLength(0);
		} finally {
			await new Promise<void>((resolve) => srv.close(() => resolve()));
		}
	});
});
