import { useEffect, useRef, useState } from "react";
import { appSend, useServiceInfo } from "../app-globals";
import { isDesktopShell } from "../desktop";
import { desktopReleasesUrl, useDesktopUpdater } from "../desktop-updater";
import { useT } from "../i18n";
import type { CommandDef } from "../types";
import { buildUpdateCommand } from "../update-command";
import type { ChatState, UpdateAllItem } from "../use-chat";
import { randomUuid } from "../uuid";
import type { ViewName } from "./BarItem";

/** 「安装全局引擎」按钮的目标（issue #321）：buildUpdateCommand 对 pi-core 生成
 *  `npm i -g <name>@latest`，装完重启服务即由 resolve-global-sdk 自动切到更新的那份。 */
const PI_CORE_ITEM: UpdateAllItem = {
	name: "@earendil-works/pi-coding-agent",
	kind: "pi-core",
	current: "",
	latest: null,
	upToDate: false,
};

export interface UpdatePanelTerminal {
	create: (meta: {
		id: string;
		conversationId: string;
		title: string;
		cwd: string;
		cols: number;
		rows: number;
		running: boolean;
		exitCode: number | null;
		command?: CommandDef;
	}) => void;
	restart: (id: string) => void;
	select?: (id: string) => void;
}

/**
 * 更新面板（web UI 自更新 / 桌面应用内更新 / 全部组件更新 / 重启服务）。
 *
 * 原样抽自 TopBar（redesign P2）：经典顶栏的更新下拉与极简外壳的「更新」弹窗共用这一份，
 * 行为逐字节一致。`onRan` 在发起一次更新命令后调用（顶栏用来收起下拉）。
 */
export function useUpdatePanel({
	chat,
	terminal,
	onViewChange,
	onRan,
}: {
	chat: ChatState;
	terminal: UpdatePanelTerminal;
	onViewChange: (view: ViewName, opts?: { skipAutoCreate?: boolean }) => void;
	onRan?: () => void;
}) {
	const t = useT();
	const service = useServiceInfo();
	const [restarting, setRestarting] = useState(false);
	// 「重启服务」会断开连接（进程退出→supervisor 拉起）：重新连上（open）后
	// 把按钮恢复可用，否则它会永远停在「重启中…」。
	useEffect(() => {
		if (restarting && chat.status === "open") setRestarting(false);
	}, [restarting, chat.status]);

	// 桌面壳（issue #180）：包内服务不受 npm 全局包影响，更新走主进程的
	// electron-updater（preload IPC），npm 那套终端命令在这里不画。
	// hook 必须在组件顶层调用 —— renderUpdateBody 会被调两次（桌面下拉 +
	// 移动端 ⋯ 面板），hook 放闭包里一次渲染就跑两遍了。
	const inDesktopShell = isDesktopShell();
	const desktopUpdater = useDesktopUpdater();

	/** Run `npm i -g pi-web-ui@latest` in a visible terminal tab (SCM-style):
	 *  reuse the tab with the same title, otherwise create one; switch to the
	 *  terminal view so the user watches the install live. */
	const updateTermIdsRef = useRef<Set<string>>(new Set());

	useEffect(() => {
		if (updateTermIdsRef.current.size === 0) return;
		let finished = false;
		for (const tid of Array.from(updateTermIdsRef.current)) {
			const tm = chat.terminals.find((t) => t.id === tid);
			if (tm && !tm.running) {
				updateTermIdsRef.current.delete(tid);
				finished = true;
			}
		}
		if (finished && chat.ready) {
			appSend({ type: "check_update" });
			appSend({ type: "check_updates_all", force: true });
		}
	}, [chat.terminals, chat.ready]);

	const runUpdate = () => {
		if (!chat.ready) return;
		const title = t("updateTabTitle");
		const cmd: CommandDef = {
			name: title,
			command: "npm i -g pi-web-ui@latest",
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		const targetId = existing ? existing.id : randomUuid();
		if (existing) {
			updateTermIdsRef.current.add(existing.id);
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			updateTermIdsRef.current.add(targetId);
			terminal.create({
				id: targetId,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		onRan?.();
		terminal.select?.(targetId);
		onViewChange("terminal", { skipAutoCreate: true });
	};

	/** Run the right update command for one or more components in a visible
	 *  terminal tab (same SCM-style pattern as the self-update above): pi
	 *  extensions go through `pi update npm:<name>` (they live under
	 *  <agentDir>/npm), everything globally installed via `npm i -g`.
	 *  Multi-target runs are chained with `;` so one failing step never
	 *  blocks the rest. Reuses the tab with the same title, else creates one. */
	const runPkgUpdate = (items: UpdateAllItem[], title: string) => {
		if (!chat.ready || items.length === 0) return;
		const cmd: CommandDef = {
			name: title,
			command: buildUpdateCommand(items),
			cwd: "${pwd}",
		};
		const existing = chat.terminals.find((tm) => tm.title === title);
		const targetId = existing ? existing.id : randomUuid();
		if (existing) {
			updateTermIdsRef.current.add(existing.id);
			terminal.restart(existing.id);
			appSend({
				type: "run_command",
				terminalId: existing.id,
				conversationId: existing.conversationId,
				command: cmd,
				cols: 80,
				rows: 24,
			});
		} else {
			updateTermIdsRef.current.add(targetId);
			terminal.create({
				id: targetId,
				conversationId: chat.activeConversationId || chat.state?.conversationId || "",
				title,
				cwd: chat.state?.cwd ?? "",
				cols: 80,
				rows: 24,
				running: true,
				exitCode: null,
				command: cmd,
			});
		}
		onRan?.();
		terminal.select?.(targetId);
		onViewChange("terminal", { skipAutoCreate: true });
	};

	// Shared by the desktop update dropdown and the mobile "⋯" panel.
	const allUpdates = chat.updatesAll ?? [];
	// issue #321：pi SDK 副本状态（服务随 update_status_all 下发）。
	// pi-core 行显示的是全局 CLI 的版本 —— 「已是最新」只对那份成立；会话实际跑哪份
	// （自带 or 跟随的全局）由此处下发，行和面板都要把差距说出来。
	const sdkInfo = chat.updatesSdk;
	const sdkSplit =
		sdkInfo && sdkInfo.newerInstalled ? { running: sdkInfo.running, installed: sdkInfo.newerInstalled } : null;
	// 本进程跑的是随包自带那份 → 面板亮「安装全局引擎并切换」入口。
	const bundledInUse = sdkInfo?.bundledInUse === true;
	// 入口只在有行动价值时出现：没装全局 pi（没有 pi-core 行），或全局比 npm 最新版旧
	// （pi-core 行有更新）。全局与自带同版本且都最新时完全安静 —— 此时安装全局带不来
	// 任何切换，提了是噪音；行级「更新」按钮（同一条 npm i -g）已覆盖另一情形。
	const coreRow = allUpdates.find((i) => i.kind === "pi-core" && !i.error);
	const bundledRelevant = bundledInUse && (!coreRow || !coreRow.upToDate);
	const bundledButton = bundledRelevant && !coreRow;
	// Pure errors don't count as "updates" — they're shown as failed rows.
	const updatesCount = allUpdates.filter((i) => !i.upToDate && !i.error).length;
	// Packages (+ the pi core) with a real newer version — targets of the
	// per-row and "update all" buttons. The web UI itself is excluded: it has
	// its own dedicated update flow above the all-components section.
	const updatable = allUpdates.filter((i) => !i.upToDate && !i.error && i.kind !== "webui");
	// Git-source rows show `host/path` (what the user put in settings.json and
	// what `pi update` takes) instead of the clone's package.json name, which
	// is often generic and unrecognizable. Full identity stays in the tooltip.
	const gitDisplayName = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source ? item.source : item.name;
	const gitNameTitle = (item: UpdateAllItem) =>
		item.kind === "git-extension" && item.source && item.source !== item.name
			? `${item.source} (${item.name})`
			: item.name;
	// Git SHAs carry no signal for users (`0.1.0 (aaa → bbb)`), so they are
	// hidden from the version cell: outdated rows already stand out via the
	// warn highlight + update button. Full values stay in the tooltip.
	const stripGitSha = (v: string) => {
		const s = v.replace(/ \([0-9a-f]{7}\)$/, "");
		return /^[0-9a-f]{7}$/.test(s) ? "" : s;
	};
	const extractGitSha = (v: string) => {
		const m = v.match(/\(([0-9a-f]{7})\)$/) ?? v.match(/^([0-9a-f]{7})$/);
		return m?.[1] ?? null;
	};
	const shortGitRange = (current: string, latest: string | null) => {
		if (!latest) return stripGitSha(current);
		const c = stripGitSha(current);
		const l = stripGitSha(latest);
		if (c !== l) return `${c} → ${l}`;
		const cSha = extractGitSha(current);
		const lSha = extractGitSha(latest);
		if (cSha && lSha && cSha !== lSha) {
			return c ? `${c} (${cSha} → ${lSha})` : `${cSha} → ${lSha}`;
		}
		return c;
	};
	const renderAllUpdatesBody = () => (
		<div className="dd-updates-all">
			<div className="dd-header">{t("updatesAllTitle")}</div>
			{chat.updatesAll === null ? (
				<div className="dd-note">{t("checkingUpdate")}</div>
			) : allUpdates.length === 0 ? (
				<div className="dd-note">{t("updatesAllUpToDate")}</div>
			) : (
				<ul className="dd-all-list">
					{allUpdates.map((item) => {
						// pi-core 行在分裂时即使「已是最新」也亮警示：行里的版本是全局 CLI 的，
						// 不是会话实际加载的那份。
						const splitRow = sdkSplit != null && item.kind === "pi-core";
						const warn = !item.error && (!item.upToDate || splitRow);
						return (
							<li
								key={`${item.kind}:${item.name}`}
								className={`dd-all-item${item.error ? " err" : warn ? " warn" : ""}`}
							>
								{item.kind !== "webui" && !item.upToDate && !item.error && (
									<button
										type="button"
										className="dd-update-btn"
										onClick={() => runPkgUpdate([item], t("updatePkgTabTitle", { name: item.name }))}
									>
										{t("updateBtn")}
									</button>
								)}
								<span className="dd-all-name" title={gitNameTitle(item)}>
									{gitDisplayName(item)}
								</span>
								<span className="dd-all-meta">
									<span className="dd-all-kind">
										{item.kind === "webui"
											? t("kindWebUi")
											: item.kind === "pi-core"
												? t("kindPiCore")
												: item.kind === "engine"
													? t("kindEngine")
													: item.kind === "git-extension"
														? t("kindGitExtension")
														: item.kind === "plugin"
															? t("kindPlugin")
															: t("kindPackage")}
									</span>
									<span
										className="dd-all-vers"
										title={
											item.error
												? item.error
												: item.kind === "git-extension"
													? item.upToDate
														? item.current
														: `${item.current} → ${item.latest}`
													: undefined
										}
									>
										{item.error ? (
											item.kind === "pi-core" && item.current === "unknown" ? (
												t("piCoreUndetected")
											) : (
												t("updateCheckFailed")
											)
										) : item.kind === "git-extension" ? (
											item.upToDate ? (
												stripGitSha(item.current)
											) : (
												shortGitRange(item.current, item.latest)
											)
										) : item.kind === "plugin" ? (
											item.upToDate ? (
												item.current.startsWith("v") ? (
													item.current
												) : (
													stripGitSha(item.current)
												)
											) : (
												shortGitRange(item.current, item.latest)
											)
										) : item.upToDate ? (
											`v${item.current}`
										) : (
											<>
												v{item.current} → v{item.latest}
											</>
										)}
									</span>
									{splitRow && !item.error && (
										<span className="dd-split-run">{t("piCoreSplitRun", { running: sdkSplit.running })}</span>
									)}
								</span>
							</li>
						);
					})}
				</ul>
			)}
			{sdkSplit && (
				<div className="dd-note warn">
					{t("piSdkSplitNote", { running: sdkSplit.running, installed: sdkSplit.installed })}
				</div>
			)}
			{bundledRelevant && <div className="dd-note">{t("piSdkBundledNote", { running: sdkInfo!.running })}</div>}
			<div className="dd-actions">
				{bundledButton && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate([PI_CORE_ITEM], t("installGlobalEngineTabTitle"))}
					>
						{t("installGlobalEngineBtn")}
					</button>
				)}
				{updatable.length > 0 && (
					<button
						type="button"
						className="dd-refresh accent"
						style={{ flex: 1 }}
						onClick={() => runPkgUpdate(updatable, t("updateAllTabTitle"))}
					>
						{t("updateAllBtn")}
					</button>
				)}
				<button
					type="button"
					className="dd-refresh"
					style={updatable.length > 0 ? { flex: 1 } : undefined}
					onClick={() => appSend({ type: "check_updates_all", force: true })}
				>
					{t("updatesAllRefresh")}
				</button>
			</div>
		</div>
	);
	/** 桌面壳的更新区：electron-updater 查/下/装 + 永远可点的下载页直链。
	 *  无 hook（状态全在组件顶层的 useDesktopUpdater 里），两处面板复用安全。 */
	const renderDesktopUpdater = () => {
		const manualUrl = desktopReleasesUrl(chat.update?.latest ?? desktopUpdater.version);
		const manual = (
			<a className="dd-refresh dd-more-link" href={manualUrl} target="_blank" rel="noreferrer noopener">
				{t("updateDesktopManual")}
			</a>
		);
		// 旧桌面壳（#180 之前）没有 updater 桥：只给下载页指引，不画更新按钮。
		if (!desktopUpdater.bridge)
			return (
				<>
					<div className="dd-note warn">{t("updateDesktopNoBridge")}</div>
					{manual}
				</>
			);
		switch (desktopUpdater.state) {
			case "checking":
				return (
					<>
						<div className="dd-note">{t("updateDesktopChecking")}</div>
						{manual}
					</>
				);
			case "available":
				return (
					<>
						<div className="dd-note warn">
							{t("updateDesktopAvailable", {
								version: desktopUpdater.version ?? chat.update?.latest ?? "",
							})}
						</div>
						<button type="button" className="dd-refresh accent" onClick={() => desktopUpdater.download()}>
							{t("updateDesktopDownload")}
						</button>
						{manual}
					</>
				);
			case "downloading":
				return (
					<>
						<div className="dd-note">{t("updateDesktopDownloading", { n: desktopUpdater.percent })}</div>
						{manual}
					</>
				);
			case "downloaded":
				return (
					<>
						<div className="dd-note ok">{t("updateDesktopDownloaded")}</div>
						<button type="button" className="dd-refresh accent" onClick={() => desktopUpdater.quitAndInstall()}>
							{t("updateDesktopInstall")}
						</button>
						{manual}
					</>
				);
			case "up-to-date":
				return <div className="dd-note ok">{t("upToDate")}</div>;
			case "error":
				return (
					<>
						<div className="dd-note warn">{t("updateDesktopError", { error: desktopUpdater.message ?? "" })}</div>
						<button type="button" className="dd-refresh" onClick={() => desktopUpdater.check()}>
							{t("updateDesktopCheck")}
						</button>
						{manual}
					</>
				);
			default:
				return (
					<>
						<button type="button" className="dd-refresh accent" onClick={() => desktopUpdater.check()}>
							{t("updateDesktopCheck")}
						</button>
						{manual}
					</>
				);
		}
	};
	const renderUpdateBody = () => (
		<>
			<div className="dd-update">
				<div className="dd-row">
					<span>{t("currentVersion")}</span>
					<b>v{chat.update?.current ?? "…"}</b>
				</div>
				<div className="dd-row">
					<span>{t("latestVersion")}</span>
					<b>
						{chat.update === null
							? t("checkingUpdate")
							: chat.update.error
								? chat.update.error
								: chat.update.latest
									? `v${chat.update.latest}`
									: t("checkingUpdate")}
					</b>
				</div>
				{chat.update && chat.update.upToDate && <div className="dd-note ok">{t("upToDate")}</div>}
				{chat.update && !chat.update.upToDate && chat.update.latest && (
					<div className="dd-note warn">{t("updateAvailable", { version: chat.update.latest })}</div>
				)}
				{chat.update?.latestPublishedAt &&
					Date.now() - new Date(chat.update.latestPublishedAt).getTime() < 30 * 60_000 && (
						<div className="dd-note warn">
							{t("updateJustPublished", {
								version: chat.update.latest ?? "",
							})}
						</div>
					)}
				{/* 浏览器：npm 终端命令；桌面壳：npm 对包内服务无效，走应用内更新 */}
				{chat.update && !chat.update.upToDate && chat.update.latest && !inDesktopShell && (
					<div className="dd-note">{t("updateTerminalHint")}</div>
				)}
				{chat.update && !chat.update.upToDate && chat.update.latest && inDesktopShell && (
					<div className="dd-note">{t("updateDesktopNote")}</div>
				)}
			</div>
			<div className="dd-actions">
				<button type="button" className="dd-refresh" onClick={() => appSend({ type: "check_update" })}>
					{chat.update === null ? t("checkingUpdate") : t("checkUpdate")}
				</button>
				{chat.update && !chat.update.upToDate && chat.update.latest && !inDesktopShell && (
					<button type="button" className="dd-refresh accent" onClick={runUpdate}>
						{t("updateNow")}
					</button>
				)}
				{chat.update && !chat.update.upToDate && chat.update.latest && inDesktopShell && renderDesktopUpdater()}
				{service && (
					<button
						type="button"
						className="dd-refresh accent"
						disabled={restarting}
						title={t("restartServiceTip", { name: service.name })}
						onClick={() => {
							if (restarting) return;
							setRestarting(true);
							appSend({ type: "restart_service" });
						}}
					>
						{restarting ? t("restartingService") : t("restartService")}
					</button>
				)}
			</div>
		</>
	);
	return { renderUpdateBody, renderAllUpdatesBody, updatesCount };
}
