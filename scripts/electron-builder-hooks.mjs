/**
 * electron-builder lifecycle hooks for Linux AppImage compatibility & smoke gating.
 *
 * Wired in `desktop/electron-builder.yml` (`beforePack`, `afterPack`,
 * `afterAllArtifactBuild`) so BOTH GitHub Actions (`desktop-release.yml`, even
 * when `ubuntu-latest` rolls to Ubuntu 26.04 / GLIBC 2.42) and local
 * `npm run desktop:dist` builds automatically:
 *
 *  1. `beforePack`: inspects compiled Linux native addons (`node-pty`, `ssh2`,
 *     `cpu-features`) in `node_modules/`. When built on a host whose glibc /
 *     libstdc++ exceeds Ubuntu 22.04 LTS (`GLIBC_2.35` / `GLIBCXX_3.4.30`),
 *     automatically rebuilds those native addons from source inside an
 *     `ubuntu:22.04` Docker container BEFORE `electron-builder` copies
 *     `node_modules` into `release/linux-unpacked`.
 *  2. `afterPack`: audits all production Linux ELF `.node` binaries in
 *     `release/linux-unpacked` against `GLIBC <= 2.35` and `GLIBCXX <= 3.4.30`.
 *  3. `afterAllArtifactBuild`: boots the final `.AppImage` inside a real
 *     `ubuntu:22.04` (GLIBC 2.35) container under `xvfb-run`, verifying
 *     `/api/health` readiness and a live WebSocket `node-pty` terminal spawn +
 *     echo roundtrip before allowing release upload.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	auditNativeAddonBuffer,
	compareVersionTuple,
	runAppImageSmokeTest,
	verifyUnpackedLinuxDir,
} from "./verify-linux-appimage.mjs";

const MAX_GLIBC = "2.35";
const MAX_GLIBCXX = "3.4.30";
const UBUNTU_2204_VERIFY_IMAGE = "pi-ubuntu2204-verify:local";

const RUNTIME_NATIVE_ADDON_PATHS = [
	"node_modules/node-pty/build/Release/pty.node",
	"node_modules/ssh2/lib/protocol/crypto/build/Release/sshcrypto.node",
	"node_modules/cpu-features/build/Release/cpufeatures.node",
];

function archNameFromBuilderArch(arch) {
	// electron-builder Arch enum: 0=ia32, 1=x64, 2=armv7l, 3=arm64, 4=universal
	if (arch === 1 || arch === "x64") return "x64";
	if (arch === 3 || arch === "arm64") return "arm64";
	return process.arch;
}

function nodeDistArch(archName) {
	if (archName === "arm64") return "arm64";
	return "x64";
}

function isDockerAvailable() {
	try {
		execFileSync("docker", ["info"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

let imageBuiltForArch = null;

function ensureUbuntu2204ContainerImage(archName) {
	if (imageBuiltForArch === archName) return;
	const distArch = nodeDistArch(archName);
	const dockerfile = `
FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates curl xz-utils python3 make g++ pkg-config binutils file \\
    xvfb xauth libgtk-3-0 libnss3 libgbm1 libasound2 \\
    libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxshmfence1 \\
    && rm -rf /var/lib/apt/lists/*
RUN NODE_TARBALL="$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | awk '/linux-${distArch}\\.tar\\.xz$/ {print $2; exit}')" \\
    && test -n "$NODE_TARBALL" \\
    && curl -fsSL "https://nodejs.org/dist/latest-v22.x/\${NODE_TARBALL}" | tar -xJ -C /usr/local --strip-components=1 \\
    && node -v && npm -v && ldd --version | head -n 1
`;
	console.log(`[linux-hooks] Building ${UBUNTU_2204_VERIFY_IMAGE} (Ubuntu 22.04 / GLIBC 2.35, arch=${distArch})…`);
	execFileSync("docker", ["build", "-t", UBUNTU_2204_VERIFY_IMAGE, "-"], {
		input: dockerfile,
		stdio: ["pipe", "inherit", "inherit"],
	});
	imageBuiltForArch = archName;
}

function inspectProjectRuntimeAddons(projectDir) {
	const ptyFull = join(projectDir, "node_modules/node-pty/build/Release/pty.node");
	if (!existsSync(ptyFull)) {
		return { needsRebuild: true, reason: "node_modules/node-pty/build/Release/pty.node is missing" };
	}
	for (const rel of RUNTIME_NATIVE_ADDON_PATHS) {
		const full = join(projectDir, rel);
		if (!existsSync(full)) continue;
		const audit = auditNativeAddonBuffer(rel, readFileSync(full), {
			maxGlibc: MAX_GLIBC,
			maxGlibcxx: MAX_GLIBCXX,
		});
		if (audit.violations.length > 0) {
			const summary = audit.violations.map((v) => `${v.kind}_${v.version} > ${v.limit}`).join(", ");
			return { needsRebuild: true, reason: `${rel} requires ${summary}` };
		}
	}
	return { needsRebuild: false, reason: "" };
}

export async function beforePack(context) {
	if (context.electronPlatformName !== "linux") return;
	const projectDir = context.packager.projectDir;
	const archName = archNameFromBuilderArch(context.arch);

	const check = inspectProjectRuntimeAddons(projectDir);
	if (!check.needsRebuild) {
		console.log(
			`[linux-hooks] ✔ Runtime native addons in node_modules already satisfy GLIBC <= ${MAX_GLIBC} and GLIBCXX <= ${MAX_GLIBCXX}`,
		);
		return;
	}

	console.log(
		`[linux-hooks] Host native addons exceed Ubuntu 22.04 baseline (${check.reason}); rebuilding in ubuntu:22.04 container…`,
	);
	if (!isDockerAvailable()) {
		throw new Error(
			`Cannot build compatible Linux AppImage: ${check.reason}, and Docker is not available to rebuild inside ubuntu:22.04.`,
		);
	}

	ensureUbuntu2204ContainerImage(archName);
	const uid = typeof process.getuid === "function" ? process.getuid() : 1000;
	const gid = typeof process.getgid === "function" ? process.getgid() : 1000;

	execFileSync(
		"docker",
		[
			"run",
			"--rm",
			"-e",
			`HOST_UID=${uid}`,
			"-e",
			`HOST_GID=${gid}`,
			"-v",
			`${projectDir}:/work`,
			"-w",
			"/work",
			UBUNTU_2204_VERIFY_IMAGE,
			"bash",
			"-exc",
			[
				'trap "chown -R ${HOST_UID}:${HOST_GID} /work/node_modules/node-pty /work/node_modules/ssh2 /work/node_modules/cpu-features 2>/dev/null || true" EXIT',
				"rm -rf node_modules/node-pty/build node_modules/ssh2/lib/protocol/crypto/build node_modules/cpu-features/build",
				"npm rebuild node-pty ssh2 cpu-features",
			].join("\n"),
		],
		{ stdio: "inherit" },
	);

	const postCheck = inspectProjectRuntimeAddons(projectDir);
	if (postCheck.needsRebuild) {
		throw new Error(`Native addon rebuild inside ubuntu:22.04 still failed ABI check: ${postCheck.reason}`);
	}
	console.log(`[linux-hooks] ✔ Rebuilt Linux native addons against Ubuntu 22.04 (GLIBC <= ${MAX_GLIBC})`);
}

export async function afterPack(context) {
	if (context.electronPlatformName !== "linux") return;
	const archName = archNameFromBuilderArch(context.arch);
	const report = verifyUnpackedLinuxDir(context.appOutDir, {
		maxGlibc: MAX_GLIBC,
		maxGlibcxx: MAX_GLIBCXX,
		expectedArch: archName,
	});
	if (!report.foundMatchingPtyNode) {
		throw new Error(`afterPack gate failed: missing Linux ${archName} pty.node in ${context.appOutDir}`);
	}
	if (report.violations.length > 0) {
		const msg = report.violations
			.map((v) => `${v.relPath}: ${v.violations.map((x) => `${x.kind}_${x.version}`).join(", ")}`)
			.join("; ");
		throw new Error(`afterPack ABI gate failed (exceeds GLIBC ${MAX_GLIBC} / GLIBCXX ${MAX_GLIBCXX}): ${msg}`);
	}
	console.log(
		`[linux-hooks] ✔ afterPack verified ${report.elfAudits.length} Linux ELF .node addon(s) in ${context.appOutDir}`,
	);
}

function getHostGlibcVersion() {
	try {
		const rep = process.report?.getReport?.();
		const ver = rep?.header?.glibcVersionRuntime;
		if (typeof ver === "string" && /^\d+\.\d+/.test(ver)) return ver;
	} catch {
		/* ignore */
	}
	return null;
}

export async function afterAllArtifactBuild(buildResult) {
	const appImages = (buildResult?.artifactPaths ?? []).filter((p) => p.endsWith(".AppImage"));
	if (appImages.length === 0) return [];

	const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
	const dockerOk = isDockerAvailable();
	const hostGlibc = getHostGlibcVersion();

	for (const appImage of appImages) {
		const absAppImage = resolve(appImage);
		chmodSync(absAppImage, 0o755);

		if (dockerOk) {
			ensureUbuntu2204ContainerImage(process.arch);
			const relAppImage = relative(projectDir, absAppImage).replace(/\\/g, "/");
			console.log(
				`[linux-hooks] Running cold-start + node-pty smoke test on ${relAppImage} inside Ubuntu 22.04 (GLIBC 2.35) container…`,
			);
			execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"-e",
					"APPIMAGE_EXTRACT_AND_RUN=1",
					"-v",
					`${projectDir}:/work:ro`,
					"-w",
					"/work",
					UBUNTU_2204_VERIFY_IMAGE,
					"node",
					"scripts/verify-linux-appimage.mjs",
					"--appimage",
					relAppImage,
					"--xvfb",
				],
				{ stdio: "inherit" },
			);
		} else {
			if (hostGlibc && compareVersionTuple(hostGlibc, MAX_GLIBC) > 0) {
				throw new Error(
					`Host GLIBC is ${hostGlibc} (> ${MAX_GLIBC}) and Docker is unavailable; cannot verify Ubuntu 22.04 runtime compatibility for ${absAppImage}`,
				);
			}
			const report = verifyUnpackedLinuxDir(join(dirname(absAppImage), "linux-unpacked"), {
				maxGlibc: MAX_GLIBC,
				maxGlibcxx: MAX_GLIBCXX,
			});
			if (!report.foundMatchingPtyNode || report.violations.length > 0) {
				throw new Error(`Final Linux unpacked directory failed ABI check before smoke test`);
			}
			await runAppImageSmokeTest(absAppImage);
		}
	}

	return [];
}
