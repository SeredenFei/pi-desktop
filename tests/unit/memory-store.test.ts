import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	MAX_MEMORY_ITEM_CHARS,
	MAX_TRANSCRIPT_BYTES,
	MemoryStore,
	mergeMemoryDocuments,
	type MemoryDocument,
} from "../../server/memory-store.js";
import { MemorySyncService } from "../../server/memory-sync.js";
import { parseMarkers } from "../../server/markers/marker.js";
import { memoryMarker } from "../../server/markers/builtins/memory.js";

describe("MemoryStore & cross-device merge", () => {
	const tempDirs: string[] = [];
	const makeTempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-memory-test-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		vi.restoreAllMocks();
		for (const d of tempDirs.splice(0)) {
			try {
				rmSync(d, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		}
	});

	it("manages global and project memories, custom instructions, and prompt injection", () => {
		const dir = makeTempDir();
		const store = new MemoryStore(dir);
		const projDir = join(dir, "my-app");

		const g = store.addItem("global", "Prefer concise TypeScript answers");
		const p = store.addItem("project", "Use Vitest for all unit tests", projDir);
		store.setProjectInstructions(projDir, "Always follow hexagonal architecture.");

		const promptBlock = store.buildPromptInjection(projDir);
		expect(promptBlock).toContain("<user_memory>");
		expect(promptBlock).toContain("Prefer concise TypeScript answers");
		expect(promptBlock).toContain("Use Vitest for all unit tests");
		expect(promptBlock).toContain("Always follow hexagonal architecture.");

		// In standalone chat-space, only global memories are injected (no project leakage)
		const chatSpaceBlock = store.buildPromptInjection(store.getView(projDir).chatSpaceCwd);
		expect(chatSpaceBlock).toContain("Prefer concise TypeScript answers");
		expect(chatSpaceBlock).not.toContain("Use Vitest for all unit tests");
		expect(chatSpaceBlock).not.toContain("Always follow hexagonal architecture.");

		// Disable item -> omitted from prompt injection
		store.updateItem("global", g.id, { enabled: false });
		expect(store.buildPromptInjection(projDir)).not.toContain("Prefer concise TypeScript answers");

		// Delete project item
		expect(store.deleteItem("project", p.id, projDir)).toBe(true);
		expect(store.listActiveItems("project", projDir)).toEqual([]);
	});

	it("supports session-level isolated memory toggle", () => {
		const dir = makeTempDir();
		const store = new MemoryStore(dir);
		expect(store.isSessionIsolated("s-1")).toBe(false);
		store.setSessionIsolated("s-1", true);
		expect(store.isSessionIsolated("s-1")).toBe(true);
		store.setSessionIsolated("s-1", false);
		expect(store.isSessionIsolated("s-1")).toBe(false);
	});

	it("merges multi-device documents deterministically with tombstones", () => {
		const docA: MemoryDocument = {
			version: 1,
			updatedAt: 100,
			global: [
				{ id: "m1", content: "old fact", enabled: true, createdAt: 10, updatedAt: 50 },
				{ id: "m2", content: "to be deleted on B", enabled: true, createdAt: 20, updatedAt: 40 },
			],
			projects: {},
		};
		const docB: MemoryDocument = {
			version: 1,
			updatedAt: 200,
			global: [
				{ id: "m1", content: "updated fact on B", enabled: true, createdAt: 10, updatedAt: 90 },
				{ id: "m2", content: "to be deleted on B", enabled: true, createdAt: 20, updatedAt: 80, deletedAt: 80 },
				{ id: "m3", content: "added on B", enabled: true, createdAt: 70, updatedAt: 70 },
			],
			projects: {},
		};

		const merged = mergeMemoryDocuments(docA, docB);
		const active = merged.global.filter((i) => !i.deletedAt);
		expect(active.map((i) => [i.id, i.content])).toEqual([
			["m1", "updated fact on B"],
			["m3", "added on B"],
		]);
	});

	it("applies [[memory:global:...]], [[memory:project:...]], and [[memory:forget:...]] inline markers", async () => {
		const ops: unknown[] = [];
		const tokens = parseMarkers(
			"Sure! [[memory:global:User prefers dark mode]] [[memory:project:Database is PostgreSQL 16]] [[memory:forget:abc123]]",
		);
		expect(tokens).toHaveLength(3);
		for (const tk of tokens) {
			const res = await memoryMarker.apply(
				tk,
				{
					conversationId: "c1",
					notify: () => {},
					applyMemoryOp: (op) => {
						ops.push(op);
						return true;
					},
				},
				undefined as never,
				"zh",
			);
			expect(res.applied).toBe(true);
		}
		expect(ops).toEqual([
			{ op: "add", scope: "global", text: "User prefers dark mode" },
			{ op: "add", scope: "project", text: "Database is PostgreSQL 16" },
			{ op: "forget", id: "abc123" },
		]);
	});

	it("captures and materializes Chat space & Chat Project transcripts across devices", () => {
		const deviceADir = makeTempDir();
		const storeA = new MemoryStore(deviceADir);
		const chatProjA = storeA.createChatProject("Paper Reading");

		// Simulate a JSONL transcript inside device A's Chat Project session directory
		const sessionDirA = SessionManager.create(chatProjA.path).getSessionDir();
		const sampleFile = join(sessionDirA, "chat-session-1.jsonl");
		const lines = [
			JSON.stringify({ type: "session", id: "sid-chat-1", cwd: chatProjA.path, timestamp: new Date().toISOString() }),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "Summarize this paper", timestamp: Date.now() },
			}),
		];
		writeFileSync(sampleFile, `${lines.join("\n")}\n`, "utf8");

		expect(storeA.captureChatTranscriptsFromDisk(false)).toBe(true);
		const exportedDoc = storeA.getDocument();
		expect(exportedDoc.chatTranscripts?.["sid-chat-1"]).toBeDefined();
		expect(exportedDoc.chatTranscripts?.["sid-chat-1"]?.jsonl).toContain("__PI_CHAT_PROJECT__:Paper-Reading");

		// Merge into Device B and verify the transcript is materialized with Device B's local path
		const deviceBDir = makeTempDir();
		const storeB = new MemoryStore(deviceBDir);
		storeB.mergeRemote(exportedDoc);

		const chatProjBPath = join(deviceBDir, "chat-projects", "Paper-Reading");
		const sessionDirB = SessionManager.create(chatProjBPath).getSessionDir();
		const restoredFile = join(sessionDirB, "chat-session-1.jsonl");
		expect(existsSync(restoredFile)).toBe(true);
		const restoredHeader = JSON.parse(readFileSync(restoredFile, "utf8").split("\n")[0]!);
		expect(restoredHeader.cwd).toBe(chatProjBPath);

		// Verify listSyncedTranscripts exposes the transcript summary in getView()
		const viewB = storeB.getView(chatProjBPath);
		expect(viewB.syncedTranscripts).toHaveLength(1);
		expect(viewB.syncedTranscripts[0]?.title).toContain("Summarize this paper");

		// Verify deleting the Chat Project removes its directory, adds a tombstone, and prevents remote resurrection
		expect(storeB.deleteProjectByCwd(chatProjBPath)).toBe(true);
		expect(existsSync(chatProjBPath)).toBe(false);
		expect(storeB.listChatProjects()).toHaveLength(0);
		storeB.mergeRemote(exportedDoc);
		expect(storeB.listChatProjects()).toHaveLength(0);
	});

	it("auto-extracts user hardware, background, and goals from chat messages", () => {
		const dir = makeTempDir();
		const store = new MemoryStore(dir);
		const extracted = store.ingestUserMessage(
			"有ram32G DDR5 3080 20G ubuntu ,机器人的话都想有涉猎 当前基础 是控制基础都有了解会用但是理解不够 RL学过PPO做过一些简单locomotion在gymnasium&mujoco上 4目的是未来找工作找实习",
			store.getView(dir).chatSpaceCwd,
		);
		expect(extracted.length).toBeGreaterThanOrEqual(2);
		const allTexts = store
			.listActiveItems("global")
			.map((i) => i.content)
			.join(" | ");
		expect(allTexts).toContain("3080");
		expect(allTexts).toContain("找工作找实习");
	});

	it("preserves long memory items up to 1000 chars and syncs >512KB transcripts", () => {
		expect(MAX_MEMORY_ITEM_CHARS).toBe(1000);
		expect(MAX_TRANSCRIPT_BYTES).toBe(8 * 1024 * 1024);

		const dir = makeTempDir();
		const store = new MemoryStore(dir);
		const longFact = `Rule: ${"a".repeat(850)}`;
		const item = store.addItem("global", longFact);
		expect(item.content.length).toBe(longFact.length);

		const chatProj = store.createChatProject("Large Sim2Sim");
		const sessionDir = SessionManager.create(chatProj.path).getSessionDir();
		const bigBody = "x".repeat(700 * 1024);
		const lines = [
			JSON.stringify({
				type: "session",
				id: "sid-large-700k",
				cwd: chatProj.path,
				timestamp: new Date().toISOString(),
			}),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: bigBody, timestamp: Date.now() },
			}),
		];
		writeFileSync(join(sessionDir, "large-session.jsonl"), `${lines.join("\n")}\n`, "utf8");

		expect(store.captureChatTranscriptsFromDisk(false)).toBe(true);
		const doc = store.getDocument();
		expect(doc.chatTranscripts?.["sid-large-700k"]).toBeDefined();
		expect(Buffer.byteLength(doc.chatTranscripts?.["sid-large-700k"]?.jsonl ?? "", "utf8")).toBeGreaterThan(512 * 1024);
	});

	it("pulls >1MB transcripts via Git Blobs fallback and queues concurrent syncs", async () => {
		const dir = makeTempDir();
		const store = new MemoryStore(dir);
		const sync = new MemorySyncService(dir, store);
		writeFileSync(
			join(dir, "memory-sync.json"),
			JSON.stringify({
				account: { token: "gho_test_token", username: "tester", repo: "pi-memory-sync" },
			}),
			"utf8",
		);

		const remoteJsonl = [
			JSON.stringify({
				type: "session",
				id: "sid-blob-1",
				cwd: "__PI_CHAT_SPACE__",
				timestamp: "2026-11-13T00:00:00.000Z",
			}),
			JSON.stringify({
				type: "message",
				message: { role: "user", content: "Pulled via Git Blob API", timestamp: 1794500000000 },
			}),
		].join("\n");
		const remoteIndexDoc: MemoryDocument = {
			version: 1,
			updatedAt: 1794500000000,
			global: [],
			projects: {},
			transcriptIndex: {
				"sid-blob-1": {
					sessionId: "sid-blob-1",
					fileName: "sid-blob-1.jsonl",
					title: "Blob Session",
					scopeKey: "chat-space",
					lineCount: 2,
					messageCount: 1,
					updatedAt: 1794500000000,
				},
			},
		};

		let indexPutCount = 0;
		let unblockFirstBlob!: () => void;
		const firstBlobGate = new Promise<void>((resolve) => {
			unblockFirstBlob = resolve;
		});

		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			if (url.endsWith("/repos/tester/pi-memory-sync") && method === "GET") {
				return new Response("{}", { status: 200 });
			}
			if (url.endsWith("/contents/memory-store.json") && method === "GET") {
				return new Response(
					JSON.stringify({
						sha: "sha-index-1",
						content: Buffer.from(JSON.stringify(remoteIndexDoc), "utf8").toString("base64"),
					}),
					{ status: 200 },
				);
			}
			if (url.endsWith("/contents/transcripts/sid-blob-1.jsonl") && method === "GET") {
				// Simulate GitHub Contents API >1MB 403 too_large response
				return new Response(JSON.stringify({ errors: [{ code: "too_large" }] }), { status: 403 });
			}
			if (url.endsWith("/contents/transcripts") && method === "GET") {
				return new Response(
					JSON.stringify([{ name: "sid-blob-1.jsonl", path: "transcripts/sid-blob-1.jsonl", sha: "blob-sha-large" }]),
					{ status: 200 },
				);
			}
			if (url.endsWith("/git/blobs/blob-sha-large") && method === "GET") {
				await firstBlobGate;
				return new Response(
					JSON.stringify({
						sha: "blob-sha-large",
						content: Buffer.from(`${remoteJsonl}\n`, "utf8").toString("base64"),
					}),
					{ status: 200 },
				);
			}
			if (method === "PUT" && url.endsWith("/contents/memory-store.json")) {
				indexPutCount++;
				return new Response(JSON.stringify({ content: { sha: `sha-index-${indexPutCount + 1}` } }), { status: 200 });
			}
			if (method === "PUT") {
				return new Response(JSON.stringify({ content: { sha: "sha-put-ok" } }), { status: 200 });
			}
			return new Response("Not Found", { status: 404 });
		});

		const firstSync = sync.syncNow();
		// Trigger a new memory mutation + second syncNow while the first sync is mid-flight
		await Promise.resolve();
		store.addItem("global", "Added during in-flight sync");
		const queuedSync = sync.syncNow();
		unblockFirstBlob();

		const [res1, res2] = await Promise.all([firstSync, queuedSync]);
		expect(res1.lastError).toBeNull();
		expect(res2.lastError).toBeNull();
		expect(indexPutCount).toBe(2);
		expect(store.getDocument().chatTranscripts?.["sid-blob-1"]?.jsonl).toContain("Pulled via Git Blob API");
	});
});
