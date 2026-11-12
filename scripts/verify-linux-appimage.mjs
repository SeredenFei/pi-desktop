#!/usr/bin/env node
/**
 * Linux AppImage compatibility & runtime smoke gate.
 *
 * Prevents shipping broken Linux AppImages caused by building native addons
 * (such as `node-pty`, `ssh2`, `cpu-features`) on runners with newer glibc /
 * libstdc++ than target user distributions (Ubuntu 22.04 LTS baseline:
 * GLIBC <= 2.35, GLIBCXX <= 3.4.30).
 *
 * Gate 1 (Static ELF ABI gate):
 *   - Scans every `.node` file in `release/linux-unpacked` (or extracts the
 *     `.AppImage` via `--appimage-extract` when `linux-unpacked` is absent).
 *   - Verifies a Linux ELF `pty.node` exists for the target CPU architecture.
 *   - Parses ELF `.gnu.version_r` (`SHT_GNU_verneed`) directly in pure JS to
 *     inspect required `GLIBC_*` and `GLIBCXX_*` symbol versions across all
 *     bundled Linux `.node` addons, failing immediately if any exceed the
 *     configured baseline (and enriching the report via `objdump -T` when
 *     available).
 *
 * Gate 2 (Packaged AppImage cold-start + PTY smoke gate):
 *   - Launches the packaged `.AppImage` in an isolated sandbox (`--user-data-dir`,
 *     `PI_WEB_DATA_DIR`, `PI_WEB_CWD`, `PI_CODING_AGENT_DIR`, free `PI_WEB_PORT`,
 *     `APPIMAGE_EXTRACT_AND_RUN=1`), automatically wrapping with `xvfb-run -a`
 *     in headless CI environments.
 *   - Waits for `/api/health` 200 OK, opens a WebSocket `/ws`, creates a real
 *     `node-pty` terminal (`terminal_create`), runs `echo __PI_APPIMAGE_PTY_OK__`,
 *     and asserts the echoed marker arrives over `terminal_output`.
 *
 * Usage:
 *   node scripts/verify-linux-appimage.mjs [options]
 *     --appimage <path>     Explicit .AppImage path (default: release/*.AppImage)
 *     --unpacked <dir>      Unpacked dir (default: release/linux-unpacked if present)
 *     --max-glibc <ver>     Max allowed GLIBC version (default: 2.35)
 *     --max-glibcxx <ver>   Max allowed GLIBCXX version (default: 3.4.30)
 *     --arch <x64|arm64>    Expected ELF architecture (default: process.arch)
 *     --no-smoke            Run static ELF symbol gate only (skip AppImage launch)
 *     --xvfb                Force running smoke test under xvfb-run -a
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAX_GLIBC = "2.35";
const DEFAULT_MAX_GLIBCXX = "3.4.30";
const SHT_GNU_VERNEED = 0x6ffffffe;
const EM_X86_64 = 62;
const EM_AARCH64 = 183;
const PTY_SMOKE_MARKER = "__PI_APPIMAGE_PTY_OK__";

/**
 * Parse a dotted numeric version (e.g. "2.42" or "3.4.30") into number tuple.
 * @param {string} raw
 * @returns {number[]}
 */
export function parseVersionTuple(raw) {
	if (typeof raw !== "string" || !/^\d+(?:\.\d+)*$/.test(raw.trim())) {
		throw new Error(`Invalid version tuple: ${JSON.stringify(raw)}`);
	}
	return raw
		.trim()
		.split(".")
		.map((part) => Number.parseInt(part, 10));
}

/**
 * Compare two dotted numeric version strings or tuples.
 * @param {string | number[]} a
 * @param {string | number[]} b
 * @returns {-1 | 0 | 1}
 */
export function compareVersionTuple(a, b) {
	const ta = Array.isArray(a) ? a : parseVersionTuple(a);
	const tb = Array.isArray(b) ? b : parseVersionTuple(b);
	const len = Math.max(ta.length, tb.length);
	for (let i = 0; i < len; i++) {
		const va = ta[i] ?? 0;
		const vb = tb[i] ?? 0;
		if (va < vb) return -1;
		if (va > vb) return 1;
	}
	return 0;
}

/**
 * Read a NUL-terminated ASCII/UTF-8 string from `buf` starting at `offset`.
 * @param {Buffer} buf
 * @param {number} offset
 * @returns {string}
 */
function readCString(buf, offset) {
	if (offset < 0 || offset >= buf.length) return "";
	let end = offset;
	while (end < buf.length && buf[end] !== 0) end++;
	return buf.subarray(offset, end).toString("utf8");
}

/**
 * Extract ELF header metadata and `.gnu.version_r` (`SHT_GNU_verneed`) entries
 * directly from a binary Buffer without requiring external `binutils`.
 *
 * @param {Buffer} buf
 * @returns {{
 *   isElf: boolean;
 *   eiClass?: 1 | 2;
 *   eMachine?: number;
 *   versionNeeds: Array<{ file: string; versions: string[] }>;
 * }}
 */
export function extractElfInfo(buf) {
	if (!Buffer.isBuffer(buf) || buf.length < 52) {
		return { isElf: false, versionNeeds: [] };
	}
	if (buf[0] !== 0x7f || buf[1] !== 0x45 || buf[2] !== 0x4c || buf[3] !== 0x46) {
		return { isElf: false, versionNeeds: [] };
	}
	const eiClass = buf[4]; // 1 = ELF32, 2 = ELF64
	const eiData = buf[5]; // 1 = little-endian, 2 = big-endian
	if ((eiClass !== 1 && eiClass !== 2) || (eiData !== 1 && eiData !== 2)) {
		return { isElf: false, versionNeeds: [] };
	}
	const le = eiData === 1;
	const u16 = (off) => (le ? buf.readUInt16LE(off) : buf.readUInt16BE(off));
	const u32 = (off) => (le ? buf.readUInt32LE(off) : buf.readUInt32BE(off));
	const u64 = (off) => Number(le ? buf.readBigUInt64LE(off) : buf.readBigUInt64BE(off));

	const eMachine = u16(18);
	let eShoff = 0;
	let eShentsize = 0;
	let eShnum = 0;
	if (eiClass === 2) {
		if (buf.length < 64) return { isElf: true, eiClass, eMachine, versionNeeds: [] };
		eShoff = u64(40);
		eShentsize = u16(58);
		eShnum = u16(60);
	} else {
		eShoff = u32(32);
		eShentsize = u16(46);
		eShnum = u16(48);
	}

	if (!eShoff || !eShentsize || !eShnum || eShoff + eShentsize * eShnum > buf.length) {
		return { isElf: true, eiClass, eMachine, versionNeeds: [] };
	}

	const readShdr = (index) => {
		const base = eShoff + index * eShentsize;
		const shType = u32(base + 4);
		if (eiClass === 2) {
			return {
				shType,
				shOffset: u64(base + 24),
				shSize: u64(base + 32),
				shLink: u32(base + 40),
				shInfo: u32(base + 44),
			};
		}
		return {
			shType,
			shOffset: u32(base + 16),
			shSize: u32(base + 20),
			shLink: u32(base + 24),
			shInfo: u32(base + 28),
		};
	};

	/** @type {Array<{ file: string; versions: string[] }>} */
	const versionNeeds = [];
	for (let i = 0; i < eShnum; i++) {
		const sh = readShdr(i);
		if (sh.shType !== SHT_GNU_VERNEED) continue;
		if (sh.shLink >= eShnum) continue;
		const strTab = readShdr(sh.shLink);
		if (strTab.shOffset + strTab.shSize > buf.length) continue;
		const dynstr = buf.subarray(strTab.shOffset, strTab.shOffset + strTab.shSize);

		let vnPos = sh.shOffset;
		const vnEnd = Math.min(buf.length, sh.shOffset + sh.shSize);
		const maxEntries = sh.shInfo > 0 ? sh.shInfo : 1024;
		for (let n = 0; n < maxEntries && vnPos + 16 <= vnEnd; n++) {
			const vnCnt = u16(vnPos + 2);
			const vnFile = u32(vnPos + 4);
			const vnAux = u32(vnPos + 8);
			const vnNext = u32(vnPos + 12);
			const file = readCString(dynstr, vnFile);
			/** @type {string[]} */
			const versions = [];

			let auxPos = vnPos + vnAux;
			for (let a = 0; a < vnCnt && auxPos + 16 <= vnEnd; a++) {
				const vnaName = u32(auxPos + 8);
				const vnaNext = u32(auxPos + 12);
				const verName = readCString(dynstr, vnaName);
				if (verName) versions.push(verName);
				if (vnaNext === 0) break;
				auxPos += vnaNext;
			}
			versionNeeds.push({ file, versions });
			if (vnNext === 0) break;
			vnPos += vnNext;
		}
	}

	return { isElf: true, eiClass, eMachine, versionNeeds };
}

/**
 * Audit a single `.node` binary buffer against maximum allowed GLIBC / GLIBCXX
 * symbol versions.
 *
 * @param {string} relPath
 * @param {Buffer} buf
 * @param {{ maxGlibc?: string; maxGlibcxx?: string }} [opts]
 */
export function auditNativeAddonBuffer(relPath, buf, opts = {}) {
	const maxGlibc = opts.maxGlibc ?? DEFAULT_MAX_GLIBC;
	const maxGlibcxx = opts.maxGlibcxx ?? DEFAULT_MAX_GLIBCXX;
	const info = extractElfInfo(buf);
	if (!info.isElf) {
		return {
			relPath,
			isElf: false,
			eMachine: undefined,
			maxGlibcFound: null,
			maxGlibcxxFound: null,
			violations: [],
		};
	}

	/** @type {string | null} */
	let maxGlibcFound = null;
	/** @type {string | null} */
	let maxGlibcxxFound = null;
	/** @type {Array<{ relPath: string; library: string; kind: "GLIBC" | "GLIBCXX"; version: string; limit: string }>} */
	const violations = [];

	for (const need of info.versionNeeds) {
		for (const tag of need.versions) {
			if (tag.startsWith("GLIBC_")) {
				const ver = tag.slice("GLIBC_".length);
				if (!/^\d+(?:\.\d+)*$/.test(ver)) continue;
				if (!maxGlibcFound || compareVersionTuple(ver, maxGlibcFound) > 0) {
					maxGlibcFound = ver;
				}
				if (compareVersionTuple(ver, maxGlibc) > 0) {
					violations.push({
						relPath,
						library: need.file,
						kind: "GLIBC",
						version: ver,
						limit: maxGlibc,
					});
				}
			} else if (tag.startsWith("GLIBCXX_")) {
				const ver = tag.slice("GLIBCXX_".length);
				if (!/^\d+(?:\.\d+)*$/.test(ver)) continue;
				if (!maxGlibcxxFound || compareVersionTuple(ver, maxGlibcxxFound) > 0) {
					maxGlibcxxFound = ver;
				}
				if (compareVersionTuple(ver, maxGlibcxx) > 0) {
					violations.push({
						relPath,
						library: need.file,
						kind: "GLIBCXX",
						version: ver,
						limit: maxGlibcxx,
					});
				}
			}
		}
	}

	return {
		relPath,
		isElf: true,
		eMachine: info.eMachine,
		maxGlibcFound,
		maxGlibcxxFound,
		violations,
	};
}

function walkNodeAddons(rootDir) {
	/** @type {string[]} */
	const out = [];
	const stack = [rootDir];
	while (stack.length > 0) {
		const cur = stack.pop();
		for (const entry of readdirSync(cur, { withFileTypes: true })) {
			const full = join(cur, entry.name);
			if (entry.isDirectory()) {
				stack.push(full);
			} else if (entry.isFile() && entry.name.endsWith(".node")) {
				out.push(full);
			}
		}
	}
	return out.sort();
}

function findOffendingSymbolsWithObjdump(filePath, maxGlibc, maxGlibcxx) {
	try {
		const out = execFileSync("objdump", ["-T", filePath], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		/** @type {string[]} */
		const hits = [];
		for (const line of out.split(/\r?\n/)) {
			const m = /\((GLIBC|GLIBCXX)_(\d+(?:\.\d+)*)\)\s+(\S+)\s*$/.exec(line);
			if (!m) continue;
			const [, kind, ver, sym] = m;
			const limit = kind === "GLIBC" ? maxGlibc : maxGlibcxx;
			if (compareVersionTuple(ver, limit) > 0) {
				hits.push(`${sym}@${kind}_${ver}`);
			}
		}
		return [...new Set(hits)].sort();
	} catch {
		return [];
	}
}

/**
 * Audit all `.node` files inside an unpacked Linux Electron app directory
 * (`release/linux-unpacked` or extracted `squashfs-root`).
 *
 * @param {string} unpackedDir
 * @param {{ maxGlibc?: string; maxGlibcxx?: string; expectedArch?: string }} [opts]
 */
export function verifyUnpackedLinuxDir(unpackedDir, opts = {}) {
	const maxGlibc = opts.maxGlibc ?? DEFAULT_MAX_GLIBC;
	const maxGlibcxx = opts.maxGlibcxx ?? DEFAULT_MAX_GLIBCXX;
	const expectedArch = opts.expectedArch ?? process.arch;
	const expectedMachine = expectedArch === "x64" ? EM_X86_64 : expectedArch === "arm64" ? EM_AARCH64 : undefined;

	if (!existsSync(unpackedDir)) {
		throw new Error(`Unpacked Linux directory does not exist: ${unpackedDir}`);
	}

	const appNodeModules = join(unpackedDir, "resources", "app", "node_modules");
	const scanRoot = existsSync(appNodeModules) ? appNodeModules : unpackedDir;
	const addonFiles = walkNodeAddons(scanRoot);

	const elfAudits = [];
	const allViolations = [];
	let foundMatchingPtyNode = false;

	for (const fullPath of addonFiles) {
		const rel = relative(unpackedDir, fullPath).replace(/\\/g, "/");
		// Skip explicit musl prebuilds when auditing glibc baseline
		if (rel.includes("musl")) continue;
		const buf = readFileSync(fullPath);
		const audit = auditNativeAddonBuffer(rel, buf, { maxGlibc, maxGlibcxx });
		if (!audit.isElf) continue;
		elfAudits.push(audit);

		const isPtyNode =
			rel.endsWith("node-pty/build/Release/pty.node") ||
			rel.includes(`node-pty/prebuilds/linux-${expectedArch}/pty.node`);
		if (isPtyNode && (!expectedMachine || audit.eMachine === expectedMachine)) {
			foundMatchingPtyNode = true;
		}

		if (audit.violations.length > 0) {
			const symbols = findOffendingSymbolsWithObjdump(fullPath, maxGlibc, maxGlibcxx);
			allViolations.push({
				...audit,
				symbols,
			});
		}
	}

	return {
		scanRoot,
		elfAudits,
		foundMatchingPtyNode,
		expectedArch,
		maxGlibc,
		maxGlibcxx,
		violations: allViolations,
	};
}

function hasCommand(cmd) {
	try {
		execFileSync("sh", ["-c", `command -v "$1" >/dev/null 2>&1`, "--", cmd], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

function freePort() {
	return new Promise((resolvePort, rejectPort) => {
		const s = createServer();
		s.once("error", rejectPort);
		s.listen(0, "127.0.0.1", () => {
			const addr = s.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			s.close(() => resolvePort(port));
		});
	});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, timeoutMs, stepMs = 250) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const val = await fn();
		if (val) return val;
		if (Date.now() >= deadline) return null;
		await sleep(stepMs);
	}
}

/**
 * Cold-start the packaged `.AppImage`, wait for `/api/health`, open `/ws`, and
 * verify `node-pty` spawns a working shell inside the packaged app.
 *
 * @param {string} appImagePath
 * @param {{ forceXvfb?: boolean }} [opts]
 */
export async function runAppImageSmokeTest(appImagePath, opts = {}) {
	const require = createRequire(import.meta.url);
	const WebSocket = require("ws");

	const absAppImage = resolve(appImagePath);
	if (!existsSync(absAppImage)) {
		throw new Error(`AppImage file not found: ${absAppImage}`);
	}

	const port = await freePort();
	const sandbox = mkdtempSync(join(tmpdir(), "pi-appimage-smoke-"));
	const userDataDir = join(sandbox, "user-data");
	const dataDir = join(sandbox, "data");
	const workDir = join(sandbox, "work");
	const agentDir = join(sandbox, "agent");

	const headless = !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
	const useXvfb = Boolean(opts.forceXvfb || headless) && hasCommand("xvfb-run");
	if (headless && !useXvfb) {
		rmSync(sandbox, { recursive: true, force: true });
		throw new Error("No DISPLAY/WAYLAND_DISPLAY and `xvfb-run` is not installed; cannot run AppImage GUI smoke test");
	}

	const env = {
		...process.env,
		APPIMAGE_EXTRACT_AND_RUN: "1",
		PI_WEB_PORT: String(port),
		PI_WEB_DATA_DIR: dataDir,
		PI_WEB_CWD: workDir,
		PI_CODING_AGENT_DIR: agentDir,
		PI_WEB_PLUGIN_CATALOG_URL: "",
		ELECTRON_ENABLE_LOGGING: "1",
	};
	delete env.ELECTRON_RUN_AS_NODE;

	const appArgs = [`--user-data-dir=${userDataDir}`, "--no-sandbox"];
	const cmd = useXvfb ? "xvfb-run" : absAppImage;
	const cmdArgs = useXvfb ? ["-a", absAppImage, ...appArgs] : appArgs;

	console.log(`[smoke] Launching AppImage (${useXvfb ? "xvfb-run" : "display"}): ${absAppImage} (port=${port})`);

	const child = spawn(cmd, cmdArgs, {
		env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});

	let log = "";
	child.stdout.on("data", (d) => {
		log += d.toString();
	});
	child.stderr.on("data", (d) => {
		log += d.toString();
	});

	let earlyExit = null;
	child.once("exit", (code, signal) => {
		earlyExit = { code, signal };
	});

	const killProcessGroup = () => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			try {
				child.kill("SIGTERM");
			} catch {
				/* already exited */
			}
		}
	};

	try {
		const healthy = await waitFor(async () => {
			if (earlyExit) {
				throw new Error(
					`AppImage exited before /api/health became ready (code=${earlyExit.code}, signal=${earlyExit.signal})`,
				);
			}
			try {
				const res = await fetch(`http://127.0.0.1:${port}/api/health`);
				return res.ok;
			} catch {
				return false;
			}
		}, 60_000);

		if (!healthy) {
			throw new Error("Timed out (60s) waiting for AppImage sidecar /api/health");
		}
		console.log(`[smoke] ✔ /api/health ready on 127.0.0.1:${port}`);

		// Open WebSocket and verify real local PTY creation + output roundtrip
		const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
		let convId = null;
		let termOutput = "";
		let serverError = null;

		ws.on("message", (raw) => {
			let msg;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}
			if (msg.type === "error" && msg.message) {
				serverError = msg.message;
			}
			if (msg.type === "terminal_output" && msg.terminalId === "appimage-smoke-1" && typeof msg.data === "string") {
				termOutput += msg.data;
			}
			const findConv = (obj, depth = 0) => {
				if (convId || !obj || typeof obj !== "object" || depth > 4) return;
				for (const [k, v] of Object.entries(obj)) {
					if ((k === "conversationId" || k === "activeConversationId") && typeof v === "string") {
						convId = v;
						return;
					}
					if (v && typeof v === "object") findConv(v, depth + 1);
				}
			};
			findConv(msg);
		});

		await new Promise((res, rej) => {
			ws.once("open", res);
			ws.once("error", rej);
		});

		ws.send(JSON.stringify({ type: "hello", clientId: `appimage-smoke-${port}`, locale: "en" }));
		const gotConv = await waitFor(() => convId, 20_000);
		if (!gotConv) {
			ws.close();
			throw new Error("Timed out waiting for conversationId over /ws");
		}

		ws.send(
			JSON.stringify({
				type: "terminal_create",
				terminalId: "appimage-smoke-1",
				cwd: workDir,
				cols: 80,
				rows: 24,
				conversationId: convId,
			}),
		);
		// Give shell prompt a brief moment, then echo deterministic marker
		await sleep(300);
		ws.send(
			JSON.stringify({
				type: "terminal_input",
				terminalId: "appimage-smoke-1",
				conversationId: convId,
				data: `echo ${PTY_SMOKE_MARKER}\r`,
			}),
		);

		const ptyOk = await waitFor(() => {
			if (serverError) {
				throw new Error(`Terminal creation failed in AppImage: ${serverError}`);
			}
			return termOutput.includes(PTY_SMOKE_MARKER);
		}, 20_000);

		ws.close();
		if (!ptyOk) {
			throw new Error(
				`Timed out waiting for node-pty output marker (${PTY_SMOKE_MARKER}); captured output: ${JSON.stringify(termOutput.slice(-400))}`,
			);
		}
		console.log(`[smoke] ✔ node-pty terminal spawn & echo roundtrip succeeded`);
	} catch (err) {
		err.appLog = log;
		throw err;
	} finally {
		killProcessGroup();
		await waitFor(() => earlyExit !== null, 5_000, 100);
		if (!earlyExit && child.pid) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				/* gone */
			}
		}
		await sleep(200);
		rmSync(sandbox, { recursive: true, force: true });
	}
}

function findDefaultAppImage(releaseDir) {
	if (!existsSync(releaseDir)) return null;
	const files = readdirSync(releaseDir)
		.filter((f) => f.endsWith(".AppImage"))
		.sort();
	return files.length > 0 ? join(releaseDir, files[0]) : null;
}

function extractAppImageToTemp(appImagePath) {
	const tempDir = mkdtempSync(join(tmpdir(), "pi-appimage-extract-"));
	execFileSync(resolve(appImagePath), ["--appimage-extract"], {
		cwd: tempDir,
		env: { ...process.env, APPIMAGE_EXTRACT_AND_RUN: "1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	const squashRoot = join(tempDir, "squashfs-root");
	if (!existsSync(squashRoot)) {
		rmSync(tempDir, { recursive: true, force: true });
		throw new Error(`--appimage-extract did not produce squashfs-root for ${appImagePath}`);
	}
	return { tempDir, squashRoot };
}

function parseCliArgs(argv) {
	const opts = {
		appImage: null,
		unpacked: null,
		maxGlibc: DEFAULT_MAX_GLIBC,
		maxGlibcxx: DEFAULT_MAX_GLIBCXX,
		arch: process.arch,
		smoke: true,
		forceXvfb: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--appimage") opts.appImage = argv[++i];
		else if (arg === "--unpacked") opts.unpacked = argv[++i];
		else if (arg === "--max-glibc") opts.maxGlibc = argv[++i];
		else if (arg === "--max-glibcxx") opts.maxGlibcxx = argv[++i];
		else if (arg === "--arch") opts.arch = argv[++i];
		else if (arg === "--no-smoke") opts.smoke = false;
		else if (arg === "--smoke") opts.smoke = true;
		else if (arg === "--xvfb") opts.forceXvfb = true;
		else throw new Error(`Unknown argument: ${arg}`);
	}
	return opts;
}

async function main() {
	const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const releaseDir = join(root, "release");
	const args = parseCliArgs(process.argv.slice(2));

	const appImagePath = args.appImage ? resolve(args.appImage) : findDefaultAppImage(releaseDir);
	const defaultUnpacked = join(releaseDir, "linux-unpacked");
	let unpackedDir = args.unpacked
		? resolve(args.unpacked)
		: !args.appImage && existsSync(defaultUnpacked) && statSync(defaultUnpacked).isDirectory()
			? defaultUnpacked
			: null;

	let extractedTemp = null;
	try {
		if (!unpackedDir) {
			if (!appImagePath) {
				throw new Error(
					"Neither --unpacked directory nor release/*.AppImage found. Pass --appimage <file> or --unpacked <dir>.",
				);
			}
			console.log(`[abi-gate] Extracting AppImage for native addon inspection: ${appImagePath}`);
			extractedTemp = extractAppImageToTemp(appImagePath);
			unpackedDir = extractedTemp.squashRoot;
		}

		console.log(
			`[abi-gate] Auditing Linux ELF .node addons in ${unpackedDir} (limits: GLIBC <= ${args.maxGlibc}, GLIBCXX <= ${args.maxGlibcxx}, arch=${args.arch})`,
		);
		const report = verifyUnpackedLinuxDir(unpackedDir, {
			maxGlibc: args.maxGlibc,
			maxGlibcxx: args.maxGlibcxx,
			expectedArch: args.arch,
		});

		for (const item of report.elfAudits) {
			console.log(
				`  · ${item.relPath} (e_machine=${item.eMachine}, max GLIBC=${item.maxGlibcFound ?? "none"}, max GLIBCXX=${item.maxGlibcxxFound ?? "none"})`,
			);
		}

		if (!report.foundMatchingPtyNode) {
			throw new Error(`Missing Linux ${args.arch} node-pty native binary (pty.node) inside packaged app!`);
		}

		if (report.violations.length > 0) {
			const lines = report.violations.map((v) => {
				const detail = v.violations
					.map((x) => `${x.kind}_${x.version} > ${x.kind}_${x.limit} (${x.library})`)
					.join(", ");
				const syms = v.symbols.length > 0 ? `\n      offending symbols: ${v.symbols.join(", ")}` : "";
				return `  ✖ ${v.relPath}: ${detail}${syms}`;
			});
			throw new Error(
				`Linux native addon ABI compatibility check FAILED (would crash on Ubuntu 22.04 / older distros):\n${lines.join("\n")}`,
			);
		}

		console.log(
			`[abi-gate] ✔ All ${report.elfAudits.length} Linux ELF .node addon(s) satisfy GLIBC <= ${args.maxGlibc} and GLIBCXX <= ${args.maxGlibcxx}`,
		);
	} finally {
		if (extractedTemp) {
			rmSync(extractedTemp.tempDir, { recursive: true, force: true });
		}
	}

	if (args.smoke) {
		if (!appImagePath) {
			throw new Error("Smoke test enabled, but no .AppImage file found. Pass --appimage <path> or --no-smoke.");
		}
		await runAppImageSmokeTest(appImagePath, { forceXvfb: args.forceXvfb });
	}

	console.log("✔ Linux AppImage verification passed.");
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
	main().catch((err) => {
		console.error(`\n✖ ${err.message}`);
		if (err.appLog) {
			console.error("---- AppImage stdout/stderr (tail) ----");
			console.error(String(err.appLog).split(/\r?\n/).slice(-80).join("\n"));
		}
		process.exit(1);
	});
}
