/**
 * engine-capabilities.ts — 智能体底座能力声明规范与出厂事实源。
 *
 * 职责：
 * 1. 为 pi / dsh / 通用基座（Claude Code 等）及未来第三方驱动提供标准能力声明契约；
 * 2. 提供各内置引擎的开箱即用能力事实源（Pi 全能力、DSH 差异化子集、通用基座保守默认）；
 * 3. 辅助生成安全归一化的 AgentEngineCapabilities 对象。
 */

import type { AgentEngineCapabilities } from "./protocol.js";

/** Pi 原生引擎能力：全功能全集 */
export const DEFAULT_PI_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: true,
	sandboxes: true,
	workspaceRoots: true,
	conversationRef: true,
	pageRef: true,
	presentFiles: true,
	planMode: true,
	delegateMode: true,
	subagents: true,
	toolPromptOverride: true,
	lazyTools: true,
	softCap: true,
	treeFork: true,
	messageEdit: true,
	steer: true,
	ephemeralChat: true,
});

/** DSH 引擎能力：外部独立进程运行时（缺失 SSH 透明接管、conversation_read 等宿主特性） */
export const DEFAULT_DSH_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: false,
	conversationRef: false,
	pageRef: false,
	presentFiles: false,
	planMode: false,
	delegateMode: false,
	subagents: false,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: false,
	messageEdit: false,
	steer: false,
	ephemeralChat: false,
});

/** 通用基座保守默认能力：外部 CLI / 子进程默认仅支持纯线性消息对话 */
export const DEFAULT_UNIVERSAL_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: false,
	conversationRef: false,
	pageRef: false,
	presentFiles: false,
	planMode: false,
	delegateMode: false,
	subagents: true,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: false,
	messageEdit: false,
	steer: false,
	ephemeralChat: true,
});

/** Pi Durable 引擎能力：事务化、任务图驱动的持久执行底座 */
export const DEFAULT_DURABLE_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: true,
	conversationRef: true,
	pageRef: true,
	presentFiles: true,
	planMode: false,
	delegateMode: false,
	subagents: true,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: true,
	messageEdit: true,
	steer: true,
	ephemeralChat: true,
});

/**
 * Antigravity（agy acp）引擎能力：官方 Agent 进程自带对话循环与工具执行，
 * 宿主只做标准 ACP 客户端（工具放行必须人工点击），因此不声明树分叉/计划模式等宿主深水区特性。
 */
export const DEFAULT_AGY_CAPABILITIES: Readonly<AgentEngineCapabilities> = Object.freeze({
	remoteSsh: false,
	sandboxes: false,
	workspaceRoots: false,
	conversationRef: false,
	pageRef: false,
	presentFiles: false,
	planMode: false,
	delegateMode: false,
	// 不把 agy 自带的 team/swarm 编排包装成宿主子代理调度
	subagents: false,
	toolPromptOverride: false,
	lazyTools: false,
	softCap: false,
	treeFork: false,
	messageEdit: false,
	steer: false,
	ephemeralChat: true,
});

/** 合并并归一化能力声明（默认回落到通用基座保守值） */
export function resolveEngineCapabilities(
	caps?: Partial<AgentEngineCapabilities> | null,
	base: AgentEngineCapabilities = DEFAULT_UNIVERSAL_CAPABILITIES,
): AgentEngineCapabilities {
	return {
		...base,
		...caps,
	};
}
