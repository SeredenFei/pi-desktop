import type { UiSlotEntry } from "../ui-slots";
import type { ChatState } from "../use-chat";
import { BarItem, type BarItemProps, type ViewName } from "./BarItem";

/**
 * 输入框下方的状态行（redesign P2，取代 FooterBar）：常显「引擎/模型 · 上下文 · 费用 · 运行状态」，
 * 其余底栏指标（缓存命中、消息数、主机资源、插件状态、插件徽标…）悬停时展开。
 * 断线时额外常显连接状态。全部复用 BarItem，行为与旧底栏一致。
 */
export function ComposerStatusLine({
	chat,
	view,
	primary,
	extra,
	itemProps,
}: {
	chat: ChatState;
	view: ViewName;
	primary: UiSlotEntry[];
	extra: UiSlotEntry[];
	itemProps: Omit<BarItemProps, "entry" | "bar" | "chat" | "view">;
}) {
	if (!chat.state) return null;
	return (
		<div className="csl" data-testid="composer-status-line">
			<div className="csl-primary">
				{primary.map((e) => (
					<BarItem key={e.id} entry={e} bar="bottom" chat={chat} view={view} {...itemProps} />
				))}
			</div>
			{extra.length > 0 && (
				<div className="csl-extra">
					{extra.map((e) => (
						<BarItem key={e.id} entry={e} bar="bottom" chat={chat} view={view} {...itemProps} />
					))}
				</div>
			)}
		</div>
	);
}
