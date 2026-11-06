/**
 * attachments — 附件构建：把 prompt.attachments（文件/目录路径引用、行范围引用、
 * 粘贴图片 imageData、上传 fileData、网页/对话引用）转成独立的 custom message（asides）。
 *
 * **一律只给路径引用**：工作区文件与上传文件都不把内容注入 prompt（小文件也不例外），
 * 只发 `<file path=… />`，模型用自己的 read 工具按需读（自带截断/分页）。
 * 只有图片走 image 内容块。视觉桥（纯文本主模型看图）也在这里接线：图片交给
 * 视觉模型转写成文字证据。
 *
 * 从 agent-service.ts 抽出，行为保持不变；上下文经 AttachmentContext 注入。
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { PromptAttachment, ServerMessage } from "./protocol.js";
import { uploadLimitBytes, isUploadDataTooLong } from "./payload-limits.js";
import { formatTextQuote, readTextQuote } from "./text-quote.js";
import type { ServerLang } from "./i18n.js";
import { sniffImageMime } from "./text-sniff.js";
import { resolveDataDir, saveUpload, uploadsRoot } from "./uploads.js";
import { isSafeGraphId, loadCanvasGraph } from "./canvas/canvas-store.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isAbsoluteWirePath, wireToAbs } from "./files-service.js";
import { buildVisionBridgePrompt, findVisionModels, transcribeImages } from "./vision-bridge.js";
import { supportsModelVision } from "./reasoning-registry.js";
import { saveAttachment } from "./attachment-store.js";
import type { ClientSettings } from "./client-state.js";
import {
	getGlobalRemoteSshService,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveRemoteWorkspacePath,
} from "./remote-ssh-service.js";

/** Resolve reference metadata without creating the store's implicit default graph. */
export function getCanvasReference(graphId: string): { id: string; title: string } {
	const dataDir = resolveDataDir();
	if (!isSafeGraphId(graphId) || !existsSync(join(dataDir, "canvas", `${graphId}.json`))) {
		throw new Error("Invalid or missing canvas reference");
	}
	const graph = loadCanvasGraph(dataDir, graphId);
	if (graph.id !== graphId) throw new Error("Canvas graph id mismatch");
	return { id: graphId, title: graph.name || graphId };
}

/** 跨快照的视觉转写缓存：批次 hash（名称 + base64 头 + 提示词）→ 转写文本。
 *  编辑重问重发相同图片不再重复耗视觉 token。进程级共享即可。
 *  长驻进程下无界 Map 会随图片种类缓慢吃内存（单条转写可达数十 KB），
 *  超过 VISION_BRIDGE_CACHE_MAX 按插入序 FIFO 淘汰最旧。 */
const VISION_BRIDGE_CACHE_MAX = 256;
const visionBridgeCache = new Map<string, string>();

function cacheVisionTranscript(key: string, value: string): void {
	visionBridgeCache.set(key, value);
	if (visionBridgeCache.size > VISION_BRIDGE_CACHE_MAX) {
		// Map 迭代序 = 插入序，第一个 key 即最旧。
		const oldest = visionBridgeCache.keys().next().value;
		if (oldest !== undefined) visionBridgeCache.delete(oldest);
	}
}

/** "provider/id" 解析；非法格式返回 null。 */
export function parseModelSpec(spec?: string | null): {
	provider: string;
	id: string;
	spec: string;
} | null {
	if (!spec) return null;
	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) return null;
	return { provider: spec.slice(0, slash), id: spec.slice(slash + 1), spec };
}

/** buildAttachmentMessages 所需的会话侧上下文。 */
export interface AttachmentContext {
	/** 当前工作区（相对路径解析根）。 */
	cwd: string;
	/** 上传文件归属的浏览器客户端。 */
	clientId: string;
	emit: (msg: ServerMessage) => void;
	settings: ClientSettings;
	session: AgentSession;
	/**
	 * 服务端语言（issue #91，可选）：当前推 UI 的 notice 已全是 text+textEn
	 * 双字段、无需 pick；此钩子为未来单字段返回文本预留，避免接口反复 churn。
	 * 缺省英文。agent-service 接线 getLang: () => this.getLang()。
	 */
	getLang?: () => ServerLang;
}

/** XML attribute escaping — page titles can contain quotes/brackets. */
function attr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function buildAttachmentMessages(
	ctx: AttachmentContext,
	attachments: PromptAttachment[] | undefined,
): Promise<{ message: Parameters<AgentSession["sendCustomMessage"]>[0] }[]> {
	if (!attachments || attachments.length === 0) return [];
	const fs = await import("node:fs/promises");
	const { resolve, sep, relative, extname, basename, posix } = await import("node:path");

	const isRemote = isRemoteWorkspaceUri(ctx.cwd);
	const remoteParsed = isRemote ? parseRemoteWorkspaceUri(ctx.cwd) : null;
	const remoteRoot = remoteParsed ? remoteParsed.remotePath : "/";
	const sshSvc = isRemote ? getGlobalRemoteSshService() : null;
	const root = isRemote ? "" : resolve(ctx.cwd);

	const resolveTarget = (attPath: string): { abs: string; rel: string; isOutside: boolean } | null => {
		if (isRemote) {
			let clean = attPath.trim();
			if (isRemoteWorkspaceUri(clean)) {
				const p = parseRemoteWorkspaceUri(clean);
				if (p) clean = p.remotePath;
			}
			if (clean.startsWith("/")) {
				const abs = posix.normalize(clean);
				const rawRel = posix.relative(remoteRoot, abs);
				const isOutside = rawRel.startsWith("..") || rawRel.includes("/..");
				return { abs, rel: isOutside ? abs : rawRel || ".", isOutside: false };
			}
			const w = resolveRemoteWorkspacePath(remoteRoot, clean);
			if (!w) return null;
			return { abs: w.abs, rel: w.rel || ".", isOutside: false };
		}
		const absPath = isAbsoluteWirePath(attPath);
		const abs = absPath ? wireToAbs(attPath) : resolve(root, attPath);
		const rawRel = absPath ? null : relative(root, abs);
		const isOutside = !absPath && (rawRel!.startsWith("..") || rawRel!.includes(`${sep}..`));
		const rel = absPath ? abs.split(sep).join("/") : rawRel!.split(sep).join("/");
		return { abs, rel, isOutside };
	};

	const MAX_ATTACHMENT_BYTES = 200 * 1024;
	const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
	const MIME: Record<string, string> = {
		".png": "image/png",
		".jpg": "image/jpeg",
		".jpeg": "image/jpeg",
		".gif": "image/gif",
		".webp": "image/webp",
		".bmp": "image/bmp",
		".svg": "image/svg+xml",
	};

	const out: { message: Parameters<AgentSession["sendCustomMessage"]>[0] }[] = [];

	/** Push the aside for a raw uploaded file (fresh fileData or a restored
	 *  uploadPath re-read from disk). Uploads are NEVER inlined: the model gets
	 *  the persisted absolute path and reads it on demand with its read tool.
	 *  `upload: true` marks the card as a restorable upload — the browser
	 *  re-sends it by path when editing & re-asking a question. */
	const pushUploadAside = (name: string, wirePath: string, buf: Buffer): void => {
		out.push({
			message: {
				customType: "file",
				content: [
					{
						type: "text",
						text: `<file path="${wirePath}" size="${buf.length}" />`,
					},
				],
				display: true,
				details: {
					name,
					path: wirePath,
					mode: "reference",
					size: buf.length,
					upload: true,
				},
			},
		});
	};

	// -- Vision bridge ------------------------------------------------------
	// When the active model can't accept images (DeepSeek, GLM, …), pasted
	// images are transcribed by a configured vision model first and the
	// transcript is fed to the text-only model as text evidence (see
	// vision-bridge.ts — any model in models.json whose input includes
	// "image" works, zero extra config). Vision-capable main models keep
	// the raw image-content path untouched.
	const mainModel = ctx.session.model;
	const mainSupportsVision = supportsModelVision(mainModel);
	const bridgedImages: {
		idx: number;
		att: (typeof attachments)[number];
		raw: string;
		mimeType: string;
		bytes: number;
	}[] = [];
	/** Raw image bytes for path-referenced image files (idx → info), pre-read
	 *  so the loop below doesn't re-read them. SVG stays a plain text file —
	 *  the model reads its source, far more useful than a rasterized blob. */
	const pathImageData = new Map<number, { raw: string; mimeType: string; bytes: number }>();
	/** Cap for path images (fully read + base64'd); larger ones fall back to
	 *  a plain path reference (the model can still attempt to read them). */
	const MAX_PATH_IMAGE_BYTES = 5 * 1024 * 1024;
	for (const [idx, att] of attachments.entries()) {
		if (att.imageData) {
			const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
			const mimeType = att.mimeType?.startsWith("image/") ? att.mimeType : "image/png";
			const bytes = Buffer.byteLength(raw, "base64");
			// Only images that would actually be sent (non-empty, under the cap).
			if (bytes > 0 && bytes <= 2 * 1024 * 1024) {
				if (!mainSupportsVision) {
					bridgedImages.push({ idx, att, raw, mimeType, bytes });
				}
			}
			continue;
		}
		if (att.mode === "canvas" || att.fileData || !att.path) continue;
		const ext = extname(att.path).toLowerCase();
		if (!IMAGE_EXT.has(ext) || ext === ".svg") continue;
		const target = resolveTarget(att.path);
		if (!target || target.isOutside) continue;
		let st: { size: number; isFile: boolean } | undefined;
		if (isRemote) {
			if (!sshSvc) continue;
			try {
				const s = await sshSvc.sftpStat(ctx.cwd, target.abs);
				st = { size: s.size, isFile: s.isFile };
			} catch {
				continue;
			}
		} else {
			try {
				const s = await fs.stat(target.abs);
				st = { size: s.size, isFile: s.isFile() };
			} catch {
				continue;
			}
		}
		if (!st.isFile || st.size === 0 || st.size > MAX_PATH_IMAGE_BYTES) {
			continue;
		}
		let buf: Buffer;
		try {
			buf = isRemote
				? (await sshSvc!.sftpReadFile(ctx.cwd, target.abs, MAX_PATH_IMAGE_BYTES)).data
				: await fs.readFile(target.abs);
		} catch {
			continue;
		}
		const mime = sniffImageMime(buf, ext);
		if (!mime) continue;
		const raw = buf.toString("base64");
		pathImageData.set(idx, { raw, mimeType: mime, bytes: st.size });
		if (!mainSupportsVision) {
			bridgedImages.push({ idx, att, raw, mimeType: mime, bytes: st.size });
		}
	}
	/** Transcript per attachment index (filled below, keyed by bridgedImages idx). */
	const bridgeTranscripts = new Map<number, string>();
	if (bridgedImages.length > 0) {
		if (!ctx.settings.visionBridgeEnabled) {
			ctx.emit({
				type: "notice",
				level: "warning",
				text: `当前模型（${mainModel?.name ?? mainModel?.id ?? "未知"}）不支持识图，且视觉桥已在设置中关闭：图片将原样发送、可能被忽略。`,
				textEn: `Current model (${mainModel?.name ?? mainModel?.id ?? "unknown"}) cannot see images and the vision bridge is off in settings: images will be sent as-is and may be ignored.`,
			});
		} else {
			const visionModels = findVisionModels(ctx.session.modelRuntime);
			// Preferred model from settings ("provider/id") — validated to exist
			// and actually accept images; falls back to the first auto-detected.
			let chosen = visionModels[0] ?? null;
			const pref = ctx.settings.visionBridgeModel;
			if (pref) {
				const spec = parseModelSpec(pref);
				if (spec) {
					const pm = ctx.session.modelRuntime.getModel(spec.provider, spec.id);
					if (pm && supportsModelVision(pm)) {
						chosen = {
							provider: spec.provider,
							id: spec.id,
							label: `${pm.name ?? pm.id} (${spec.provider})`,
						};
					}
				}
			}
			if (!chosen) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `当前模型（${mainModel?.name ?? mainModel?.id ?? "未知"}）不支持识图，且未找到可用的视觉模型：图片将原样发送、可能被忽略。在模型配置里添加任意支持图片的模型（如 qwen-vl、GLM-4V、Gemini）即可自动启用视觉桥转写。`,
					textEn: `Current model (${mainModel?.name ?? mainModel?.id ?? "unknown"}) cannot see images and no vision model is available: images will be sent as-is and may be ignored. Add any vision-capable model (e.g. qwen-vl, GLM-4V, Gemini) in model settings to enable vision-bridge transcription.`,
				});
			} else {
				// Batch hash so re-sending identical images (edit & re-ask) reuses
				// the transcript instead of re-burning tokens on the vision API.
				// issue #91：转写提示词按客户端 UI 语言选用（英文默认），语言进缓存键。
				const vLang = ctx.getLang?.() ?? "en";
				// The active transcription prompt is part of the key: changing
				// the custom prompt must invalidate cached transcripts made with
				// the old prompt.
				const batchHash =
					bridgedImages.map((b) => `${b.att.name ?? "img"}:${b.raw.slice(0, 48)}`).join("|") +
					"::" +
					buildVisionBridgePrompt(ctx.settings.visionBridgePromptMode, ctx.settings.visionBridgePrompt, vLang) +
					"::" +
					vLang;
				let transcript = visionBridgeCache.get(batchHash);
				if (transcript === undefined) {
					ctx.emit({
						type: "notice",
						level: "info",
						text: `当前模型不支持识图，正在用视觉桥（${chosen.label}）转写 ${bridgedImages.length} 张图片…`,
						textEn: `Current model cannot see images; transcribing ${bridgedImages.length} image(s) via the vision bridge (${chosen.label})…`,
					});
					try {
						const chosenModel = ctx.session.modelRuntime.getModel(chosen.provider, chosen.id);
						transcript = await transcribeImages(
							ctx.session.modelRuntime,
							bridgedImages.map((b) => ({
								data: b.raw,
								mimeType: b.mimeType,
								name: b.att.name,
							})),
							{
								model: chosenModel ?? undefined,
								systemPrompt: buildVisionBridgePrompt(
									ctx.settings.visionBridgePromptMode,
									ctx.settings.visionBridgePrompt,
									vLang,
								),
								lang: vLang,
							},
						);
						cacheVisionTranscript(batchHash, transcript);
						ctx.emit({
							type: "notice",
							level: "info",
							text: `✅ 图片已由视觉桥转写完成（${chosen.label}）`,
							textEn: `✅ Images transcribed by the vision bridge (${chosen.label})`,
						});
					} catch (err) {
						transcript = "";
						ctx.emit({
							type: "notice",
							level: "error",
							text: `图片转写失败（${chosen.label}）：${(err as Error).message}。图片将原样发送、可能被忽略。`,
							textEn: `Image transcription failed (${chosen.label}): ${(err as Error).message}. Images will be sent as-is and may be ignored.`,
						});
					}
				}
				for (const b of bridgedImages) bridgeTranscripts.set(b.idx, transcript ?? "");
			}
		}
	}

	for (const [idx, att] of attachments.entries()) {
		if (att.mode === "quote") {
			const quote = readTextQuote(att.quote);
			if (!quote) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: "引用内容无效，请重新选择文字",
					textEn: "Select the text again to add a quote.",
				});
				continue;
			}
			out.push({
				message: {
					customType: "file",
					content: [{ type: "text", text: formatTextQuote(quote) }],
					display: true,
					details: { mode: "quote", quote },
				},
			});
			continue;
		}
		// Quoted conversation (left-panel right-click / global-search quote):
		// `path` is unused — the reference travels in conversationId (running
		// conversation, incl. subagents) or sessionPath (history transcript).
		// The transcript is NOT inlined here (it can be huge and goes stale);
		// the model fetches it on demand with the conversation tool.
		if ((att as { mode?: string }).mode === "conversation") {
			const convId = (att as { conversationId?: unknown }).conversationId;
			const sessPath = (att as { sessionPath?: unknown }).sessionPath;
			const id = typeof convId === "string" && convId.trim() ? convId.trim() : undefined;
			const sp = typeof sessPath === "string" && sessPath.trim() ? sessPath.trim() : undefined;
			const title = att.name ?? id ?? sp ?? "conversation";
			if (!id && !sp) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `对话引用缺少 id/path，已跳过`,
					textEn: `Conversation reference without id/path, skipped`,
				});
				continue;
			}
			const ref = id ? `id="${attr(id)}"` : `path="${attr(sp!)}"`;
			const how = id
				? `Use the conversation tool with action="read", id="${attr(id)}" to read its messages.`
				: `Use the conversation tool with action="read", path="${attr(sp!)}" to read its transcript.`;
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: `\n<conversation-ref ${ref} title="${attr(title)}">\nThe user quoted another conversation "${attr(title)}". ${how} Do not guess its contents.\n用户引用了另一个对话，别猜它的内容，用 conversation 去读。\n</conversation-ref>`,
						},
					],
					display: true,
					details: { name: title, path: id ?? sp, mode: "conversation", conversationId: id, sessionPath: sp },
				},
			});
			continue;
		}
		// Canvas identifiers are not filesystem paths. Resolve only through the canvas store.
		if (att.mode === "canvas") {
			const graphId = att.path;
			try {
				const { title } = getCanvasReference(graphId);
				out.push({
					message: {
						customType: "file",
						content: [
							{
								type: "text",
								text: `
<canvas-ref id="${attr(graphId)}" title="${attr(title)}">
The user referenced this canvas. First use canvas(action="get", graphId="${attr(graphId)}") to inspect its topology and status. Only when the user requests execution, use canvas(action="run_all", graphId="${attr(graphId)}", prompt="the user requirements"); prompt supplies the run initialPrompt. Use canvas(action="get_log", graphId="${attr(graphId)}") for logs, and action="get" for status. This reference alone does not authorize or start a run.
</canvas-ref>`,
							},
						],
						display: true,
						details: { mode: "canvas", path: graphId, name: title, title },
					},
				});
			} catch {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `画布引用无效或不存在，已跳过：${graphId}`,
					textEn: `Invalid or missing canvas reference, skipped: ${graphId}`,
				});
			}
			continue;
		}
		// Granted web page (page-picker extension): `path` is the page origin,
		// NOT a workspace path — never stat/read it. The model gets the exact
		// browser_page target plus the fact that this page is already granted,
		// so it doesn't have to guess an origin out of the prose.
		if (att.mode === "page") {
			const url = att.path;
			let target = url;
			try {
				// The extension matches pages by origin — keep the hint in the same
				// shape as `browser_page`'s `target` (sub-paths are not part of it).
				target = new URL(url).origin;
			} catch {
				// Not a full URL (hand-written string) → pass it through as-is and
				// let the extension decide.
			}
			const pageTitle = att.name ?? url;
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: `\n<browser-page url="${attr(url)}" title="${attr(pageTitle)}">\nThe user attached this web page; it is already granted to the AI through the browser extension. Use the browser_page tool with target="${attr(target)}" to read or act on it — do not fetch it over the network.\n</browser-page>`,
						},
					],
					display: true,
					details: { name: pageTitle, path: url, mode: "page" },
				},
			});
			continue;
		}

		// Raw pasted/dropped/uploaded image — no workspace path involved (the
		// browser downscales client-side; this guard only prevents abuse).
		if (att.imageData) {
			const raw = att.imageData.replace(/^data:[^;]*;base64,/, "");
			const mimeType = att.mimeType?.startsWith("image/") ? att.mimeType : "image/png";
			const bytes = Buffer.byteLength(raw, "base64");
			const MAX_PASTED_IMAGE_BYTES = 2 * 1024 * 1024;
			if (bytes === 0) {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `图片数据为空，已跳过`,
					textEn: `Image data is empty, skipped`,
				});
				continue;
			}
			if (bytes > MAX_PASTED_IMAGE_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `图片过大已跳过（>2MB）：${att.name ?? "粘贴图片"}`,
					textEn: `Image too large, skipped (>2MB): ${att.name ?? "pasted image"}`,
				});
				continue;
			}
			let attachmentUrl: string | undefined;
			let attachmentHash: string | undefined;
			try {
				const rec = await saveAttachment(Buffer.from(raw, "base64"), mimeType);
				attachmentUrl = rec.url;
				attachmentHash = rec.hash;
			} catch {
				/* CAS 保存失败不阻断流程 */
			}
			const transcript = bridgeTranscripts.get(idx);
			if (transcript) {
				// Bridged: the text-only main model can't see images, so it gets the
				// vision model's transcript as text evidence; the image block is
				// kept so the card still shows the original thumbnail.
				out.push({
					message: {
						customType: "file",
						content: [
							{
								type: "text",
								text: `\n<vision-bridge>\n${transcript}\n</vision-bridge>`,
							},
							{
								type: "image",
								data: raw,
								mimeType,
								...(attachmentUrl ? { source: { type: "url", url: attachmentUrl } } : {}),
							},
						],
						display: true,
						details: {
							name: att.name ?? "image.png",
							path: undefined,
							mode: "bridged",
							size: bytes,
							attachmentUrl,
							attachmentHash,
						},
					},
				});
				continue;
			}
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "image",
							data: raw,
							mimeType,
							...(attachmentUrl ? { source: { type: "url", url: attachmentUrl } } : {}),
						},
					],
					display: true,
					details: {
						name: att.name ?? "image.png",
						// No workspace path — the card renders without the path line.
						path: undefined,
						mode: "image",
						size: bytes,
						attachmentUrl,
						attachmentHash,
					},
				},
			});
			continue;
		}

		// Raw uploaded file (base64) — no workspace path involved. The bytes are
		// persisted under <dataDir>/uploads/<clientId>/ so the model can read
		// them on demand with its read tool (absolute path, no traversal guard
		// needed — the path is server-generated). Always a path reference.
		if (att.fileData) {
			const maxBytes = uploadLimitBytes(ctx.settings, "chat");
			if (isUploadDataTooLong(att.fileData.length, maxBytes)) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `文件过大已跳过（>${maxBytes / 1024 / 1024}MB）：${att.name ?? "上传文件"}`,
					textEn: `File too large, skipped (>${maxBytes / 1024 / 1024}MB): ${att.name ?? "uploaded file"}`,
				});
				continue;
			}
			const buf = Buffer.from(att.fileData, "base64");
			if (buf.length === 0) {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `文件数据为空，已跳过`,
					textEn: `File data is empty, skipped`,
				});
				continue;
			}
			if (buf.length > maxBytes) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `文件过大已跳过（>${maxBytes / 1024 / 1024}MB）：${att.name ?? "上传文件"}`,
					textEn: `File too large, skipped (>${maxBytes / 1024 / 1024}MB): ${att.name ?? "uploaded file"}`,
				});
				continue;
			}
			// Uploaded files live in a GLOBAL per-user dir (not inside the project
			// or the per-client session store) so browsing a repo never picks up
			// uploaded junk: <dataDir>/uploads/<clientId>/（保留期自动清理，见 uploads.ts）。
			// saveUpload 对非法 clientId/displayName 抛错（消毒失败整条拒绝，绝不
			// 落到别的目录）—— 这里报错跳过该附件，不让一条坏附件中断整条消息。
			let saved: { abs: string; displayName: string };
			try {
				saved = saveUpload(ctx.clientId, att.name ?? "file", buf);
			} catch (err) {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `上传文件保存失败，已跳过：${(err as Error).message}`,
					textEn: `Failed to save uploaded file, skipped: ${(err as Error).message}`,
				});
				continue;
			}
			const { abs, displayName: safeName } = saved;
			// Wire format: forward-slash absolute path (the read tool accepts
			// absolute paths; Windows uses "C:/..." — safe inside the XML-ish tag).
			const wirePath = abs.split(sep).join("/");
			pushUploadAside(safeName, wirePath, buf);
			continue;
		}

		// Restored upload from edit-and-re-ask: the browser re-sends the
		// server-generated absolute path of a previously uploaded (fileData)
		// file instead of the original base64 (the fork drops the original
		// aside card, so the bytes must be re-read from the uploads dir).
		// Validate the path stays inside THIS client's uploads/ folder, then
		// re-read the persisted bytes and attach by the same path — no
		// re-save (the file already exists; retention sweeping governs its
		// lifetime, same as the original card).
		if (att.uploadPath) {
			const rootDir = uploadsRoot();
			const abs = resolve(rootDir, att.uploadPath);
			const relToRoot = relative(rootDir, abs);
			const inClientDir =
				!relToRoot.startsWith("..") &&
				!relToRoot.includes(`${sep}..`) &&
				(relToRoot === ctx.clientId || relToRoot.startsWith(`${ctx.clientId}${sep}`));
			if (!inClientDir) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `无法恢复已上传文件（路径不在本客户端上传目录）：${att.name ?? att.uploadPath}`,
					textEn: `Cannot restore uploaded file (outside this client upload dir): ${att.name ?? att.uploadPath}`,
				});
				continue;
			}
			let buf: Buffer;
			try {
				buf = await fs.readFile(abs);
			} catch {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `无法恢复已上传文件（已被清理或不可读）：${att.name ?? att.uploadPath}`,
					textEn: `Cannot restore uploaded file (cleaned up or unreadable): ${att.name ?? att.uploadPath}`,
				});
				continue;
			}
			if (buf.length === 0) continue;
			pushUploadAside(att.name ?? basename(abs), abs.split(sep).join("/"), buf);
			continue;
		}

		const target = resolveTarget(att.path);
		if (!target || target.isOutside) {
			ctx.emit({
				type: "notice",
				level: "warning",
				text: `附件路径超出工作区：${att.path}`,
				textEn: `Attachment path is outside the workspace: ${att.path}`,
			});
			continue;
		}
		const { abs, rel } = target;
		let stat: { size: number; isFile(): boolean; isDirectory(): boolean } | undefined;
		if (isRemote) {
			if (!sshSvc) {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `远程 SSH 服务不可用：${att.path}`,
					textEn: `Remote SSH service not available: ${att.path}`,
				});
				continue;
			}
			try {
				const s = await sshSvc.sftpStat(ctx.cwd, abs);
				stat = {
					size: s.size,
					isFile: () => s.isFile,
					isDirectory: () => s.isDirectory,
				};
			} catch {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `附件不存在：${att.path}`,
					textEn: `Attachment does not exist: ${att.path}`,
				});
				continue;
			}
		} else {
			try {
				stat = await fs.stat(abs);
			} catch {
				ctx.emit({
					type: "notice",
					level: "error",
					text: `附件不存在：${att.path}`,
					textEn: `Attachment does not exist: ${att.path}`,
				});
				continue;
			}
		}

		const name = att.path.split(/[\\/]/).pop() ?? att.path;

		// Folders can't be inlined — always a path reference the model browses
		// on demand with its own tools (ls/read).
		if (stat.isDirectory()) {
			out.push({
				message: {
					customType: "file",
					content: [{ type: "text", text: `<folder path="${rel}" />` }],
					display: true,
					details: {
						name,
						path: rel,
						mode: "reference",
						type: "folder",
					},
				},
			});
			continue;
		}

		if (!stat.isFile()) {
			ctx.emit({
				type: "notice",
				level: "warning",
				text: `跳过非文件附件：${att.path}`,
				textEn: `Skipped non-file attachment: ${att.path}`,
			});
			continue;
		}

		const ext = extname(att.path).toLowerCase();
		if (IMAGE_EXT.has(ext) && ext !== ".svg") {
			const pathImg = pathImageData.get(idx);
			const transcript = bridgeTranscripts.get(idx);
			if (transcript) {
				// Text-only main model: the vision bridge transcribed this image —
				// the model gets the transcript as text evidence (+ thumbnail).
				out.push({
					message: {
						customType: "file",
						content: [
							{
								type: "text",
								text: `
<vision-bridge>
${transcript}
</vision-bridge>`,
							},
							...(pathImg
								? ([
										{
											type: "image",
											data: pathImg.raw,
											mimeType: pathImg.mimeType,
										},
									] as const)
								: []),
						],
						display: true,
						details: {
							name,
							path: rel,
							mode: "bridged",
							size: stat.size,
						},
					},
				});
				continue;
			}
			if (pathImg) {
				// Vision-capable main model (or bridge failed): send the raw image
				// content straight from the pre-read bytes.
				out.push({
					message: {
						customType: "file",
						content: [
							{
								type: "image",
								data: pathImg.raw,
								mimeType: pathImg.mimeType,
							},
						],
						display: true,
						details: { name, path: rel, mode: "image", size: stat.size },
					},
				});
				continue;
			}
			// Pre-read failed (unsupported sniff / too large): fall back to the
			// legacy inline-cap behavior.
			if (stat.size > MAX_ATTACHMENT_BYTES) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `图片附件过大已跳过（>200KB）：${att.path}`,
					textEn: `Image attachment too large, skipped (>200KB): ${att.path}`,
				});
				continue;
			}
			let data: string;
			try {
				data = isRemote
					? (await sshSvc!.sftpReadFile(ctx.cwd, abs, MAX_ATTACHMENT_BYTES)).data.toString("base64")
					: await fs.readFile(abs, "base64");
			} catch {
				continue;
			}
			out.push({
				message: {
					customType: "file",
					content: [{ type: "image", data, mimeType: MIME[ext] ?? "image/png" }],
					display: true,
					details: { name, path: rel, mode: "image", size: stat.size },
				},
			});
			continue;
		}

		/** Path-only aside — no file content is read or injected. */
		const makeReference = (): {
			message: Parameters<AgentSession["sendCustomMessage"]>[0];
		} => ({
			message: {
				customType: "file",
				content: [
					{
						type: "text",
						text: `<file path="${rel}" size="${stat.size}" />`,
					},
				],
				display: true,
				details: { name, path: rel, mode: "reference", size: stat.size },
			},
		});
		// Everything else is a PATH REFERENCE: the file content is never injected
		// into the prompt (small files included) — the model reads what it needs
		// with its own read tool (built-in truncation/pagination).
		// Line-range mode adds the `lines` attribute so the model knows which
		// slice the user picked and only reads that part.
		// A legacy `mode: "inline"` (old client / persisted draft) lands here too.
		if (att.mode === "lines") {
			const range = att.lines;
			if (!range || range.start < 1 || range.end < range.start) {
				ctx.emit({
					type: "notice",
					level: "warning",
					text: `行范围无效，已改为仅引用：${att.path}`,
					textEn: `Invalid line range, switched to reference-only: ${att.path}`,
				});
				out.push(makeReference());
				continue;
			}
			out.push({
				message: {
					customType: "file",
					content: [
						{
							type: "text",
							text: `<file path="${rel}" lines="${range.start}-${range.end}" size="${stat.size}" />`,
						},
					],
					display: true,
					details: {
						name,
						path: rel,
						mode: "lines",
						size: stat.size,
						lines: range.end - range.start + 1,
						startLine: range.start,
						endLine: range.end,
					},
				},
			});
			continue;
		}
		out.push(makeReference());
	}
	return out;
}

/**
 * 判断一个会话 entry 是否是提问前置注入的 aside 卡片（附件/并行提醒等）。
 * 这些消息由服务端的 prompt 前置阶段通过 sendCustomMessage 注入在用户提问消息之前。
 */
export function isPromptAsideEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as {
		type?: string;
		customType?: string;
		message?: { role?: string; customType?: string };
	};
	const customType =
		e.customType ?? (e.type === "message" && e.message?.role === "custom" ? e.message.customType : undefined);
	return (
		(e.type === "custom_message" || (e.type === "message" && e.message?.role === "custom")) &&
		(customType === "file" || customType === "parallel-work-reminder")
	);
}

/**
 * 判断一个 entry 是否为用户提问消息。
 */
export function isUserMessageEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as {
		type?: string;
		role?: string;
		message?: { role?: string };
	};
	return (e.type === "message" && e.message?.role === "user") || e.type === "user" || e.role === "user";
}

/**
 * 判断一个 entry 是否为上一轮对话结束时的有效业务节点
 * （例如助手回复、工具返回、bash 执行、分支或压缩摘要，或者更早一轮的用户提问）。
 */
export function isConversationTurnEntry(entry: unknown): boolean {
	if (!entry || typeof entry !== "object") return false;
	const e = entry as {
		type?: string;
		role?: string;
		message?: { role?: string };
	};
	if (e.type === "compaction" || e.type === "branch_summary") return true;
	if (e.type === "message" && e.message) {
		const role = e.message.role;
		return (
			role === "assistant" ||
			role === "toolResult" ||
			role === "bashExecution" ||
			role === "branchSummary" ||
			role === "compactionSummary" ||
			role === "user"
		);
	}
	return false;
}

/**
 * 从给定的 entry 节点开始，向上追溯跳过属于该轮提问的前置附件 aside 节点（customType === "file" 等）、
 * SDK 注入的系统截面（role === "system"）以及配置变更节点，
 * 返回该轮提问之前的基准 entry id（作为 fork/分支截断点）。
 * 如果追溯到会话根（即该提问是会话第一轮提问），返回 null。
 */
export function findTurnBaseEntryId(sm: { getEntry(id: string): unknown }, entryId: string): string | null {
	const target = sm.getEntry(entryId);
	if (!target) return null;
	// 只有针对用户消息，才需要向上跳过属于该提问的前置附件 aside 卡片和系统截面
	if (!isUserMessageEntry(target)) {
		const parentId = (target as { parentId?: string | null }).parentId;
		return parentId ?? null;
	}

	let currentId: string | null | undefined = entryId;
	while (currentId) {
		const entry = sm.getEntry(currentId);
		if (!entry) break;
		const parentId = (entry as { parentId?: string | null }).parentId;
		if (!parentId) return null;
		const parentEntry = sm.getEntry(parentId);
		if (!parentEntry) return null;
		if (isConversationTurnEntry(parentEntry)) {
			return parentId;
		}
		currentId = parentId;
	}
	return null;
}
