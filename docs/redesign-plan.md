# pi-web-ui 极简桌面化重构方案

> 基线：上游 `xing-shuyin/pi-web-ui` @ `ab2f150c`。本文件是 grill 会话确认后的方案单，实施以此为准。

## 前提

- Fork 上游；后端基本不动以保持可合并，前端布局层/样式接受分叉。
- 目标平台：Windows / macOS / Ubuntu。

## 桌面外壳与进程

1. 沿用 Electron；三平台独立安装包、内置运行时（`.exe` / `.dmg` / `.AppImage`·`.deb`）。自动更新、代码签名后置。
2. 单实例：沿用 `requestSingleInstanceLock`，二次启动聚焦已有窗口。
3. 三平台统一「关窗即退出」（含 macOS）；无托盘、无后台常驻；最小化正常。
4. 进程模型保持「Electron + server 子进程」，退出三步：
   - 通过 IPC 请求 server 优雅关闭，最多等 5 秒；
   - 超时树杀：Windows `taskkill /F /T /PID`，macOS/Linux 杀进程组（server 以 `detached` 启动）；
   - server 发现与 Electron 的 IPC 通道断开即自行退出（防 Electron 崩溃遗留）。
5. 有任务运行时，关窗 / Cmd+Q / Alt+F4 统一弹应用内确认框（无「不再提示」）。
6. 保留 `--web` 无窗口模式（现有 CLI）。

## 界面

7. 布局：可折叠左侧栏（会话 + 子代理）+ 中间对话流 + 底部输入框；右侧文件抽屉默认收起。
8. 终端：对话流下方底部面板，Ctrl+` 展开/收起，多标签；默认收起，记住状态与高度；按项目而非会话。
9. 移除两侧 SideDock、FooterBar、大部分 TopBar；Git、Canvas、Worktrees、设备中心、插件经命令面板或侧栏「更多」进入，功能不删。
10. GoalBar / PlanBoard 以紧凑卡片贴在输入框上方，有内容才显示。
11. Ctrl/Cmd+K 升级为「搜索 + 执行命令」命令面板。
12. 视觉：Claude 风主体 + Codex 风代码/diff；背景暖米白 `#FAF9F5` / 暖深灰 `#262624`；单一强调色 `#D97757`；系统无衬线 + 等宽；圆角 8–12px；动效 ~150ms。
13. 标题栏：自绘无边框；macOS `hiddenInset` 保留红绿灯；Windows/Linux 自绘按钮，保留 Win11 贴靠布局。
14. 主题：仅浅色 / 深色 / 跟随系统；移除 35 套旧主题。
15. 文案中文默认、可切英文，全部走 i18n。

## 实现策略

16. 新写顶层布局与命令面板；MessageList、ChatInput 等功能组件保留逻辑只换样式。
17. 新样式放 `@layer minimal` 覆盖；旧 `styles.css` 随组件换皮逐步清理。
18. 新组件关键元素统一加 `data-testid`。

## 交付与验收

| 期 | 内容 | 验收 |
|---|---|---|
| P1 外壳与进程 | 三步退出、macOS 关窗即退、退出确认框、标题栏、Linux 桌面环境测试 | 开着终端 / MCP / claude 引擎任务关窗，三平台零残留进程 |
| P2 新布局 | 设计变量、新布局、侧栏与抽屉、底部终端面板、命令面板、面板迁移 | 首屏仅会话列表 / 对话流 / 输入框，旧功能均有入口 |
| P3 组件换皮 | 消息、输入框、工具调用块、代码/diff、设置等；清理旧 CSS 与旧主题 | 浅/深两套视觉统一；旧主题代码移除 |

- 每期独立分支与 PR。
- 测试：单测与 server 测试必须常绿；浏览器测试只修选择器不删；新增桌面端退出测试。
- CI：GitHub Actions 新增 PR 触发的三平台工作流作为硬门槛；Ubuntu 手测用虚拟机，macOS 依赖 CI + 截图。
