import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryStore, mergeMemoryDocuments, type MemoryDocument } from "../../server/memory-store.js";
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
	});
});
