/**
 * markers/index.ts — 聚合内置标记并提供便捷初始化。
 */

import { registerMarker } from "./registry.js";
import { notifyMarker } from "./builtins/notify.js";
import { renameMarker } from "./builtins/rename.js";
import { actionMarker, suggestMarker } from "./builtins/action.js";
import { memoryMarker } from "./builtins/memory.js";

let initialized = false;

export function ensureMarkersRegistered(): void {
	if (initialized) return;
	registerMarker(notifyMarker);
	registerMarker(renameMarker);
	registerMarker(actionMarker);
	registerMarker(suggestMarker);
	registerMarker(memoryMarker);
	initialized = true;
}

export { notifyMarker, renameMarker, actionMarker, suggestMarker, memoryMarker };
export * from "./marker.js";
export * from "./registry.js";
export * from "./store.js";
