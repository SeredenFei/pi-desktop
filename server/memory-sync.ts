/**
 * 跨端记忆云同步引擎（server/memory-sync.ts）。
 *
 * 方案：
 * - 登录：支持 GitHub OAuth Device Flow（8 位设备码网页授权，零外部 CLI 依赖）与 Personal Access Token 登录；
 * - 存储：自动在用户 GitHub 账号下创建/连接私有仓库 `pi-memory-sync`（默认 private: true）；
 * - 合并：拉取远端 `memory-store.json` 与本地 MemoryStore 执行逐条时间戳 + 墓碑合并（mergeMemoryDocuments），
 *         再将合并后的最新文档写回远端，确保多端（Mac / Windows / Ubuntu）任意顺序登录修改都不丢数据。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MemoryDocument, MemoryStore } from "./memory-store.js";

/** GitHub 官方 OAuth App Public Client ID（支持 Device Flow 申请 repo scope）。 */
const GITHUB_DEVICE_CLIENT_ID = "178c6fc778ccc68e1d6a";
const DEFAULT_SYNC_REPO = "pi-memory-sync";
const REMOTE_FILE_PATH = "memory-store.json";

export interface MemorySyncAccount {
	token: string;
	username: string;
	avatarUrl?: string;
	repo: string;
	lastSyncedAt?: number;
}

export interface MemorySyncStatus {
	loggedIn: boolean;
	username?: string;
	avatarUrl?: string;
	repo: string;
	lastSyncedAt?: number;
	syncing: boolean;
	lastError?: string | null;
	deviceFlow?: {
		userCode: string;
		verificationUri: string;
		expiresAt: number;
	} | null;
}

interface StoredSyncConfig {
	account?: MemorySyncAccount | null;
}

export class MemorySyncService {
	private readonly configPath: string;
	private readonly store: MemoryStore;
	private account: MemorySyncAccount | null = null;
	private syncing = false;
	private lastError: string | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private devicePollTimer: ReturnType<typeof setTimeout> | null = null;
	private activeDeviceFlow: {
		deviceCode: string;
		userCode: string;
		verificationUri: string;
		intervalSec: number;
		expiresAt: number;
	} | null = null;
	private statusListeners = new Set<(status: MemorySyncStatus) => void>();

	constructor(dataDir: string, store: MemoryStore) {
		this.configPath = join(resolve(dataDir), "memory-sync.json");
		this.store = store;
		this.account = this.loadAccount();
		this.store.onChange(() => this.scheduleAutoSync());
		if (this.account) {
			// 启动后后台静默拉取合并一次远端记忆
			setTimeout(() => {
				void this.syncNow().catch(() => {});
			}, 1500);
		}
	}

	onStatusChange(cb: (status: MemorySyncStatus) => void): () => void {
		this.statusListeners.add(cb);
		return () => this.statusListeners.delete(cb);
	}

	private emitStatus(): void {
		const snap = this.getStatus();
		for (const cb of this.statusListeners) {
			try {
				cb(snap);
			} catch {
				/* ignore */
			}
		}
	}

	private loadAccount(): MemorySyncAccount | null {
		try {
			if (!existsSync(this.configPath)) return null;
			const raw = JSON.parse(readFileSync(this.configPath, "utf8")) as StoredSyncConfig;
			if (raw?.account?.token && raw?.account?.username) {
				return {
					token: String(raw.account.token),
					username: String(raw.account.username),
					...(raw.account.avatarUrl ? { avatarUrl: String(raw.account.avatarUrl) } : {}),
					repo: String(raw.account.repo || DEFAULT_SYNC_REPO),
					...(raw.account.lastSyncedAt ? { lastSyncedAt: Number(raw.account.lastSyncedAt) } : {}),
				};
			}
		} catch {
			/* ignore */
		}
		return null;
	}

	private saveAccount(): void {
		try {
			mkdirSync(resolve(this.configPath, ".."), { recursive: true });
			writeFileSync(this.configPath, JSON.stringify({ account: this.account }, null, "\t"), "utf8");
		} catch {
			/* ignore */
		}
	}

	getStatus(): MemorySyncStatus {
		return {
			loggedIn: Boolean(this.account),
			username: this.account?.username,
			avatarUrl: this.account?.avatarUrl,
			repo: this.account?.repo ?? DEFAULT_SYNC_REPO,
			lastSyncedAt: this.account?.lastSyncedAt,
			syncing: this.syncing,
			lastError: this.lastError,
			deviceFlow: this.activeDeviceFlow
				? {
						userCode: this.activeDeviceFlow.userCode,
						verificationUri: this.activeDeviceFlow.verificationUri,
						expiresAt: this.activeDeviceFlow.expiresAt,
					}
				: null,
		};
	}

	private async ghFetch(url: string, init: RequestInit = {}, token?: string): Promise<Response> {
		const authToken = token ?? this.account?.token;
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"User-Agent": "PI-Desktop-MemorySync",
			"X-GitHub-Api-Version": "2022-11-28",
			...((init.headers as Record<string, string>) ?? {}),
		};
		if (authToken) headers.Authorization = `Bearer ${authToken}`;
		return fetch(url, {
			...init,
			headers,
			signal: init.signal ?? AbortSignal.timeout(20000),
		});
	}

	/** 用 GitHub Personal Access Token（或 OAuth access_token）直接登录并立即执行首次同步。 */
	async loginWithToken(rawToken: string, repoName = DEFAULT_SYNC_REPO): Promise<MemorySyncStatus> {
		const token = rawToken.trim();
		if (!token) throw new Error("Token 不能为空");
		this.lastError = null;
		const res = await this.ghFetch("https://api.github.com/user", {}, token);
		if (!res.ok) {
			throw new Error(`GitHub 鉴权失败（HTTP ${res.status}）`);
		}
		const user = (await res.json()) as { login?: string; avatar_url?: string };
		if (!user.login) throw new Error("无法获取 GitHub 用户名");
		this.cancelDeviceFlow();
		this.account = {
			token,
			username: user.login,
			avatarUrl: user.avatar_url,
			repo: repoName.trim() || DEFAULT_SYNC_REPO,
		};
		this.saveAccount();
		this.emitStatus();
		await this.syncNow();
		return this.getStatus();
	}

	/** 发起 GitHub OAuth Device Flow 网页登录（返回 8 位 userCode 与验证网址，后台自动轮询完成登录）。 */
	async startDeviceLogin(): Promise<MemorySyncStatus> {
		this.cancelDeviceFlow();
		this.lastError = null;
		const res = await fetch("https://github.com/login/device/code", {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
				"User-Agent": "PI-Desktop-MemorySync",
			},
			body: JSON.stringify({
				client_id: GITHUB_DEVICE_CLIENT_ID,
				scope: "repo",
			}),
			signal: AbortSignal.timeout(20000),
		});
		if (!res.ok) {
			throw new Error(`无法发起 GitHub 设备码登录（HTTP ${res.status}）`);
		}
		const data = (await res.json()) as {
			device_code?: string;
			user_code?: string;
			verification_uri?: string;
			expires_in?: number;
			interval?: number;
		};
		if (!data.device_code || !data.user_code) {
			throw new Error("GitHub 未返回有效的设备码");
		}
		this.activeDeviceFlow = {
			deviceCode: data.device_code,
			userCode: data.user_code,
			verificationUri: data.verification_uri || "https://github.com/login/device",
			intervalSec: Math.max(5, Number(data.interval) || 5),
			expiresAt: Date.now() + (Number(data.expires_in) || 900) * 1000,
		};
		this.emitStatus();
		this.scheduleDevicePoll();
		return this.getStatus();
	}

	cancelDeviceFlow(): void {
		if (this.devicePollTimer) {
			clearTimeout(this.devicePollTimer);
			this.devicePollTimer = null;
		}
		if (this.activeDeviceFlow) {
			this.activeDeviceFlow = null;
			this.emitStatus();
		}
	}

	private scheduleDevicePoll(): void {
		if (!this.activeDeviceFlow) return;
		const delay = this.activeDeviceFlow.intervalSec * 1000;
		this.devicePollTimer = setTimeout(() => void this.pollDeviceToken(), delay);
	}

	private async pollDeviceToken(): Promise<void> {
		const flow = this.activeDeviceFlow;
		if (!flow) return;
		if (Date.now() >= flow.expiresAt) {
			this.activeDeviceFlow = null;
			this.lastError = "设备码已过期，请重新点击登录";
			this.emitStatus();
			return;
		}
		try {
			const res = await fetch("https://github.com/login/oauth/access_token", {
				method: "POST",
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					"User-Agent": "PI-Desktop-MemorySync",
				},
				body: JSON.stringify({
					client_id: GITHUB_DEVICE_CLIENT_ID,
					device_code: flow.deviceCode,
					grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				}),
				signal: AbortSignal.timeout(15000),
			});
			const data = (await res.json()) as { access_token?: string; error?: string; interval?: number };
			if (data.access_token) {
				await this.loginWithToken(data.access_token);
				return;
			}
			if (data.error === "slow_down") {
				flow.intervalSec = (data.interval || flow.intervalSec) + 5;
			} else if (data.error && data.error !== "authorization_pending") {
				this.activeDeviceFlow = null;
				this.lastError = `授权失败：${data.error}`;
				this.emitStatus();
				return;
			}
		} catch {
			/* 网络抖动继续下一轮轮询 */
		}
		this.scheduleDevicePoll();
	}

	logout(): MemorySyncStatus {
		this.cancelDeviceFlow();
		this.account = null;
		this.lastError = null;
		this.saveAccount();
		this.emitStatus();
		return this.getStatus();
	}

	private scheduleAutoSync(): void {
		if (!this.account) return;
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			void this.syncNow().catch(() => {});
		}, 3000);
	}

	private async ensureRemoteRepo(acc: MemorySyncAccount): Promise<void> {
		const check = await this.ghFetch(`https://api.github.com/repos/${acc.username}/${acc.repo}`);
		if (check.status === 200) return;
		if (check.status !== 404) {
			throw new Error(`检查同步仓库失败（HTTP ${check.status}）`);
		}
		const create = await this.ghFetch("https://api.github.com/user/repos", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				name: acc.repo,
				description: "PI Cross-Device Shared Memory & Projects Sync",
				private: true,
				auto_init: true,
			}),
		});
		if (!create.ok && create.status !== 422) {
			throw new Error(`创建私有同步仓库 ${acc.repo} 失败（HTTP ${create.status}）`);
		}
	}

	/** 立即执行一次双向无损合并同步（Pull 远端 → 逐条时间戳合并 → Push 回远端）。 */
	async syncNow(): Promise<MemorySyncStatus> {
		if (!this.account) return this.getStatus();
		if (this.syncing) return this.getStatus();
		this.syncing = true;
		this.lastError = null;
		this.emitStatus();

		const acc = this.account;
		try {
			this.store.captureChatTranscriptsFromDisk(false);
			await this.ensureRemoteRepo(acc);
			const fileUrl = `https://api.github.com/repos/${acc.username}/${acc.repo}/contents/${REMOTE_FILE_PATH}`;
			const getRes = await this.ghFetch(fileUrl);
			let remoteSha: string | undefined;
			let mergedDoc: MemoryDocument = this.store.getDocument();

			if (getRes.status === 200) {
				const payload = (await getRes.json()) as { sha?: string; content?: string; encoding?: string };
				remoteSha = payload.sha;
				if (payload.content) {
					const rawText = Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
					const remoteDoc = JSON.parse(rawText) as MemoryDocument;
					mergedDoc = this.store.mergeRemote(remoteDoc);
				}
			} else if (getRes.status !== 404) {
				throw new Error(`读取远端记忆失败（HTTP ${getRes.status}）`);
			}

			const bodyText = JSON.stringify(mergedDoc, null, "\t");
			const putRes = await this.ghFetch(fileUrl, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					message: `sync memory (${new Date().toISOString()})`,
					content: Buffer.from(bodyText, "utf8").toString("base64"),
					...(remoteSha ? { sha: remoteSha } : {}),
				}),
			});
			if (!putRes.ok) {
				throw new Error(`推送远端记忆失败（HTTP ${putRes.status}）`);
			}
			acc.lastSyncedAt = Date.now();
			this.saveAccount();
		} catch (err) {
			this.lastError = (err as Error).message || String(err);
		} finally {
			this.syncing = false;
			this.emitStatus();
		}
		return this.getStatus();
	}
}
