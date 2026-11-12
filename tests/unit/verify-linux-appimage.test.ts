import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	auditNativeAddonBuffer,
	compareVersionTuple,
	extractElfInfo,
	parseVersionTuple,
	verifyUnpackedLinuxDir,
} from "../../scripts/verify-linux-appimage.mjs";
import { loadNodePtySpawn } from "../../server/terminals.js";

const ROOT = resolve(__dirname, "..", "..");
const SHT_STRTAB = 3;
const SHT_GNU_VERNEED = 0x6ffffffe;

/**
 * Construct a minimal valid little-endian ELF64 binary containing `.dynstr` and
 * `.gnu.version_r` (`SHT_GNU_verneed`) sections for deterministic unit testing
 * across Linux, macOS, and Windows.
 */
function buildSyntheticElf64(eMachine: number, needs: Array<{ file: string; versions: string[] }>): Buffer {
	// Build .dynstr table (starts with NUL byte)
	const strOffsets = new Map<string, number>();
	const strChunks: Buffer[] = [Buffer.from([0])];
	let strLen = 1;
	const intern = (s: string): number => {
		const existing = strOffsets.get(s);
		if (existing !== undefined) return existing;
		const off = strLen;
		const b = Buffer.from(`${s}\0`, "utf8");
		strChunks.push(b);
		strLen += b.length;
		strOffsets.set(s, off);
		return off;
	};

	for (const n of needs) {
		intern(n.file);
		for (const v of n.versions) intern(v);
	}
	const dynstr = Buffer.concat(strChunks);

	// Build .gnu.version_r payload: each Verneed is 16 bytes followed by N * 16-byte Vernaux
	const verneedChunks: Buffer[] = [];
	for (let i = 0; i < needs.length; i++) {
		const item = needs[i];
		const totalEntryBytes = 16 + item.versions.length * 16;
		const vn = Buffer.alloc(16);
		vn.writeUInt16LE(1, 0); // vn_version
		vn.writeUInt16LE(item.versions.length, 2); // vn_cnt
		vn.writeUInt32LE(intern(item.file), 4); // vn_file
		vn.writeUInt32LE(16, 8); // vn_aux (immediately follows Verneed)
		vn.writeUInt32LE(i + 1 < needs.length ? totalEntryBytes : 0, 12); // vn_next
		verneedChunks.push(vn);

		for (let j = 0; j < item.versions.length; j++) {
			const vna = Buffer.alloc(16);
			vna.writeUInt32LE(0, 0); // vna_hash
			vna.writeUInt16LE(0, 4); // vna_flags
			vna.writeUInt16LE(j + 2, 6); // vna_other
			vna.writeUInt32LE(intern(item.versions[j]), 8); // vna_name
			vna.writeUInt32LE(j + 1 < item.versions.length ? 16 : 0, 12); // vna_next
			verneedChunks.push(vna);
		}
	}
	const verneed = Buffer.concat(verneedChunks);

	// Layout:
	// [0..64)                    ELF64 header
	// [64..64+dynstr.length)     .dynstr (section #1)
	// [verneedOff..verneedEnd)   .gnu.version_r (section #2)
	// [shoff..shoff+3*64)        Section header table (NULL, .dynstr, .gnu.version_r)
	const dynstrOff = 64;
	const verneedOff = dynstrOff + dynstr.length;
	const shoff = verneedOff + verneed.length;
	const shdrSize = 64;
	const shnum = 3;
	const out = Buffer.alloc(shoff + shnum * shdrSize);

	// ELF64 header
	out[0] = 0x7f;
	out[1] = 0x45; // E
	out[2] = 0x4c; // L
	out[3] = 0x46; // F
	out[4] = 2; // ELFCLASS64
	out[5] = 1; // ELFDATA2LSB
	out[6] = 1; // EV_CURRENT
	out.writeUInt16LE(3, 16); // ET_DYN
	out.writeUInt16LE(eMachine, 18);
	out.writeUInt32LE(1, 20); // EV_CURRENT
	out.writeBigUInt64LE(BigInt(shoff), 40); // e_shoff
	out.writeUInt16LE(64, 52); // e_ehsize
	out.writeUInt16LE(shdrSize, 58); // e_shentsize
	out.writeUInt16LE(shnum, 60); // e_shnum

	dynstr.copy(out, dynstrOff);
	verneed.copy(out, verneedOff);

	// Section #1: .dynstr
	const sh1 = shoff + 1 * shdrSize;
	out.writeUInt32LE(SHT_STRTAB, sh1 + 4);
	out.writeBigUInt64LE(BigInt(dynstrOff), sh1 + 24);
	out.writeBigUInt64LE(BigInt(dynstr.length), sh1 + 32);

	// Section #2: .gnu.version_r (sh_link = 1 -> .dynstr, sh_info = needs.length)
	const sh2 = shoff + 2 * shdrSize;
	out.writeUInt32LE(SHT_GNU_VERNEED, sh2 + 4);
	out.writeBigUInt64LE(BigInt(verneedOff), sh2 + 24);
	out.writeBigUInt64LE(BigInt(verneed.length), sh2 + 32);
	out.writeUInt32LE(1, sh2 + 40); // sh_link -> section #1
	out.writeUInt32LE(needs.length, sh2 + 44); // sh_info

	return out;
}

describe("Linux AppImage GLIBC / native addon verification gate", () => {
	const tempDirs: string[] = [];
	const makeTempDir = () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-verify-appimage-test-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const d of tempDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true });
		}
	});

	it("compares dotted GLIBC and GLIBCXX version tuples numerically", () => {
		expect(parseVersionTuple("2.35")).toEqual([2, 35]);
		expect(compareVersionTuple("2.42", "2.35")).toBe(1);
		expect(compareVersionTuple("2.34", "2.35")).toBe(-1);
		expect(compareVersionTuple("2.2.5", "2.35")).toBe(-1);
		expect(compareVersionTuple("2.35", "2.35.0")).toBe(0);
		expect(compareVersionTuple("3.4.32", "3.4.30")).toBe(1);
	});

	it("parses ELF64 .gnu.version_r and flags GLIBC_2.42 / GLIBCXX_3.4.32 violations", () => {
		const brokenPty = buildSyntheticElf64(62, [
			{ file: "libc.so.6", versions: ["GLIBC_2.2.5", "GLIBC_2.34", "GLIBC_2.42"] },
			{ file: "libstdc++.so.6", versions: ["GLIBCXX_3.4.21", "GLIBCXX_3.4.30"] },
		]);
		const info = extractElfInfo(brokenPty);
		expect(info.isElf).toBe(true);
		expect(info.eMachine).toBe(62);
		expect(info.versionNeeds).toEqual([
			{ file: "libc.so.6", versions: ["GLIBC_2.2.5", "GLIBC_2.34", "GLIBC_2.42"] },
			{ file: "libstdc++.so.6", versions: ["GLIBCXX_3.4.21", "GLIBCXX_3.4.30"] },
		]);

		const audit = auditNativeAddonBuffer("resources/app/node_modules/node-pty/build/Release/pty.node", brokenPty, {
			maxGlibc: "2.35",
			maxGlibcxx: "3.4.30",
		});
		expect(audit.maxGlibcFound).toBe("2.42");
		expect(audit.maxGlibcxxFound).toBe("3.4.30");
		expect(audit.violations).toEqual([
			{
				relPath: "resources/app/node_modules/node-pty/build/Release/pty.node",
				library: "libc.so.6",
				kind: "GLIBC",
				version: "2.42",
				limit: "2.35",
			},
		]);

		// Non-ELF (e.g. Windows PE "MZ..." or macOS Mach-O prebuilds) is ignored cleanly
		const fakePe = Buffer.from("MZ\x90\x00not-an-elf-binary-at-all-padding-to-exceed-52-bytes................");
		const peAudit = auditNativeAddonBuffer("node-pty/prebuilds/win32-x64/pty.node", fakePe);
		expect(peAudit.isElf).toBe(false);
		expect(peAudit.violations).toEqual([]);
	});

	it("verifies unpacked directory requires matching-arch pty.node and blocks high-glibc addons", () => {
		const dir = makeTempDir();
		const ptyDir = join(dir, "resources", "app", "node_modules", "node-pty", "build", "Release");
		mkdirSync(ptyDir, { recursive: true });

		// 1. Missing pty.node -> foundMatchingPtyNode = false
		expect(verifyUnpackedLinuxDir(dir, { expectedArch: "x64" }).foundMatchingPtyNode).toBe(false);

		// 2. Wrong CPU arch (arm64 e_machine=183 when expecting x64=62) -> foundMatchingPtyNode = false
		writeFileSync(
			join(ptyDir, "pty.node"),
			buildSyntheticElf64(183, [{ file: "libc.so.6", versions: ["GLIBC_2.34"] }]),
		);
		expect(verifyUnpackedLinuxDir(dir, { expectedArch: "x64" }).foundMatchingPtyNode).toBe(false);

		// 3. Matching x64 arch with GLIBC_2.42 -> foundMatchingPtyNode = true, violations non-empty
		writeFileSync(
			join(ptyDir, "pty.node"),
			buildSyntheticElf64(62, [{ file: "libc.so.6", versions: ["GLIBC_2.34", "GLIBC_2.42"] }]),
		);
		const badReport = verifyUnpackedLinuxDir(dir, { expectedArch: "x64", maxGlibc: "2.35" });
		expect(badReport.foundMatchingPtyNode).toBe(true);
		expect(badReport.violations).toHaveLength(1);
		expect(badReport.violations[0].violations[0].version).toBe("2.42");

		// 4. Matching x64 arch compiled on Ubuntu 22.04 (GLIBC_2.34) -> clean pass
		writeFileSync(
			join(ptyDir, "pty.node"),
			buildSyntheticElf64(62, [
				{ file: "libc.so.6", versions: ["GLIBC_2.2.5", "GLIBC_2.34"] },
				{ file: "libstdc++.so.6", versions: ["GLIBCXX_3.4.30"] },
			]),
		);
		const goodReport = verifyUnpackedLinuxDir(dir, { expectedArch: "x64", maxGlibc: "2.35" });
		expect(goodReport.foundMatchingPtyNode).toBe(true);
		expect(goodReport.violations).toEqual([]);
	});

	it("lazy-loads node-pty on demand without poisoning cache when load fails", () => {
		let attempts = 0;
		const brokenLoader = () => {
			attempts++;
			throw new Error("pty.node: version `GLIBC_2.42' not found");
		};
		expect(() => loadNodePtySpawn(brokenLoader)).toThrow(/GLIBC_2\.42/);
		expect(() => loadNodePtySpawn(brokenLoader)).toThrow(/GLIBC_2\.42/);
		expect(attempts).toBe(2);

		const fakeSpawn = (() => ({})) as unknown as typeof import("node-pty").spawn;
		expect(loadNodePtySpawn(() => ({ spawn: fakeSpawn }))).toBe(fakeSpawn);
	});

	it("guards electron-builder.yml hooks so Linux AppImage rebuilds and smoke-tests in ubuntu:22.04 before release", () => {
		const builderYml = readFileSync(join(ROOT, "desktop", "electron-builder.yml"), "utf8");
		expect(builderYml).toContain("beforePack: ./scripts/electron-builder-hooks.mjs");
		expect(builderYml).toContain("afterPack: ./scripts/electron-builder-hooks.mjs");
		expect(builderYml).toContain("afterAllArtifactBuild: ./scripts/electron-builder-hooks.mjs");

		const hooksSrc = readFileSync(join(ROOT, "scripts", "electron-builder-hooks.mjs"), "utf8");
		expect(hooksSrc).toContain("FROM ubuntu:22.04");
		expect(hooksSrc).toContain("scripts/verify-linux-appimage.mjs");
	});
});
