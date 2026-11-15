# Antigravity（agy acp）平级内核

> 状态：v1 已实现并实测（agy 1.5.9 / 2026-11-15）。引擎 id：`agy`；`PI_WEB_ENGINE=agy` 或界面「引擎」下拉热切。
> 与 `pi-agy-acp` 插件的根本差别：插件是把 agy 拆成底层模型接口塞进 pi 的 Agent 循环（套娃）；
> 本实现是让**官方 agy acp 子进程当整个内核**，宿主只做标准 ACP 客户端。

---

## 1. 为什么「桌面端平级切内核」是合规的

| 维度     | 插件套娃（已弃）                                 | 平级内核（本实现）                                     |
| -------- | ------------------------------------------------ | ------------------------------------------------------ |
| 谁跑循环 | pi 的 Agent 循环，模型接口来自 agy               | agy 自己（对话、文件读写、命令执行全在官方进程内）     |
| 工具执行 | 宿主替 agy 执行工具（能力边界被重写）            | 官方进程执行，宿主只按 ACP 权限请求弹窗放行            |
| 凭证     | 需要把登录态/端点接进宿主                        | 宿主完全不碰凭证，官方进程自管                         |
| 会话驱动 | 程序可自动续跑                                   | 每条 prompt 都来自人工输入，无自动追问                 |
| 结论     | 相当于自研 Agent 循环调用订阅登录态 → 高风险违规 | 与 Zed / T3 Code 同类：**人工驱动的交互式 ACP 客户端** |

---

## 2. 实测协议面（ground truth）

探针：`tests/agy-driver-smoke.mjs`（零 token）、`tests/agy-permission-probe.mjs`（真实一轮）。

### 2.1 方法

| 方向       | 方法                         | 说明                                                                                        |
| ---------- | ---------------------------- | ------------------------------------------------------------------------------------------- |
| client→agy | `initialize`                 | 返回 `agentInfo`(=Antigravity ACP Server 1.5.9)、`authMethods`、`_meta`                     |
| client→agy | `session/new`                | `{cwd, mcpServers}` → `sessionId / models / modes / configOptions / _meta.antigravity.tier` |
| client→agy | `session/load`               | agy 声明 `loadSession=true`；失效会话自动回落新建                                           |
| client→agy | `session/prompt`             | `{sessionId, prompt:[{type:"text"\|"image",…}]}` → `{stopReason, usage}`                    |
| client→agy | `session/cancel`             | 中断当前轮（会话保留，可继续对话）                                                          |
| client→agy | `session/set_config_option`  | `{configId:"model"\|"thought_level", value}` → 新 `configOptions`                           |
| client→agy | `session/set_mode`           | `default / accept-edits / auto / plan`（**宿主固定 default**）                              |
| agy→client | `session/update`             | 通知（见 2.2）                                                                              |
| agy→client | `session/request_permission` | 工具放行请求（见 2.3）                                                                      |

### 2.2 `session/update` 通知种类（实测）

`agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk` / `tool_call` / `tool_call_update` /
`usage_update {used,size}` / `session_info_update {title}` / `available_commands_update` /
`config_option_update` / `current_mode_update` / `plan`。

映射到宿主事件槽（`server/universal/drivers/agy-acp.ts`）：

| ACP                                  | 宿主                                       |
| ------------------------------------ | ------------------------------------------ |
| `agent_message_chunk.content.text`   | `sink.onTextDelta`                         |
| `agent_thought_chunk.content.text`   | `sink.onThinkingDelta`（可折叠思考块）     |
| `tool_call`                          | `sink.onToolStart(toolCallId, name, args)` |
| `tool_call_update(completed/failed)` | `sink.onToolEnd`                           |
| `tool_call_update(in_progress)`      | `sink.onToolUpdate`（进度文本）            |
| `usage_update`                       | 底栏上下文占用（`used/size`），不用轮询    |
| `session/prompt` 回包 `usage`        | `onTurnComplete` 的四桶 Token 统计         |

### 2.3 权限请求（人在回路）

```json
{
	"jsonrpc": "2.0",
	"id": "1",
	"method": "session/request_permission",
	"params": {
		"sessionId": "…",
		"toolCall": {
			"toolCallId": "call_…",
			"name": "run_command",
			"kind": "execute",
			"title": "echo hi",
			"args": { "CommandLine": "echo hi" },
			"content": [{ "type": "diff", "path": "…", "newText": "…" }]
		},
		"options": [
			{ "optionId": "allow", "name": "Allow", "kind": "allow_once" },
			{ "optionId": "deny", "name": "Deny", "kind": "reject_once" }
		]
	}
}
```

回包：`{ "jsonrpc":"2.0", "id":"1", "result": { "outcome": { "outcome":"selected", "optionId":"allow" } } }`

宿主链路：`AgyAcpClient.onPermission` → `sink.onPermissionRequest` →
`UniversalSession` 发 `tool_approval_pending` → 前端 `ToolApprovalDialog` 点击 →
`tool_approval_response` → `resolveToolApproval` → 回 ACP。
**没有审批 UI、超时（5 分钟）、用户拒绝 → 一律回官方 deny 选项。**

### 2.4 两个必须知道的坑

1. **agy 的服务端请求 id 是字符串**（`"1"`）。当数字处理会静默丢弃，表现为工具卡在
   `pending`、界面永远等不到放行弹窗。客户端把 pending 表统一按 `String(id)` 建键，回包原样回。
2. **`/usage` 不是 ACP 斜杠命令**：`session/prompt` 发 `/usage` 会被当成普通文本喂给模型
   （实测模型甚至开始翻 skill 文档）。额度只能走 `agy -p /usage --output-format json` 单次查。
3. **权限请求是官方安全策略决定的**：只读/临时目录写入可能被判为 safe 而不弹窗；
   一旦弹出就必须人工确认（我们绝不自动放行）。`session/set_mode(auto)` 这类自动化模式宿主不启用。

---

## 3. 代码地图

```
server/agy/
├── agy-types.ts        # ACP 线协议类型（实测事实源）+ AcpRpcError
├── agy-acp-client.ts   # stdio JSON-RPC 2.0 客户端（spawn/握手/通知/权限/pending/杀进程）
├── agy-compliance.ts   # 五条红线（可执行护栏 + 常量 + 配额守卫）
├── agy-quota.ts        # 按需单次额度查询（agy -p /usage --output-format json）
├── agy-workspace.ts    # 技能软链（.agents/skills）+ 项目 MCP 配置（.agents/mcp_config.json）
├── agy-env.ts          # 内核级环境隔离（裁剪子进程 env）+ 官方配置冲突只读检测
└── agy-handoff.ts      # 跨内核接力清洗（剥推理签名，只传纯文本）
server/universal/drivers/agy-acp.ts   # BaseAgentDriver 适配（事件映射/模型目录/思考档位/斜杠命令）
server/engine-capabilities.ts         # DEFAULT_AGY_CAPABILITIES
server/engine-probe.ts                # probeAgy()：agy --version；不参与 npm 升级/卸载
server/index.ts                       # ensureEngine("agy") + switch_engine 分支
web/src/components/EnginePicker.tsx   # 引擎下拉元数据（ANTIGRAVITY）
```

宿主复用：`UniversalAgentService` / `UniversalSession`（会话落盘、文件树、终端、SCM、后台服务检测）。

---

## 4. 五条防封红线 → 代码落点

| #   | 红线                              | 实现                                                                                        |
| --- | --------------------------------- | ------------------------------------------------------------------------------------------- |
| 1   | 原样拉起子进程，不传跳过权限参数  | `spawn("agy",["acp"])` + `assertSpawnArgsCompliant()`（spawn 前硬断言）；权限走 UI 点击     |
| 2   | 走原生终端登录，不碰 OAuth 凭证   | 无任何凭证读写代码；`isCredentialPath()` 只用于拒绝；登录：终端 `agy acp --login`           |
| 3   | 前端/服务端只暴露 Gemini 系列模型 | `filterGeminiModels()`（目录过滤）+ `assertGeminiModelId()`（切模型拦截）                   |
| 4   | 允许并行开窗，严禁自动追问协调    | 驱动层无定时器、无自动重发；`AUTO_CONTINUE_FORBIDDEN` + 单测静态扫描 `setInterval`          |
| 5   | 按需单次查额度，禁止后台定时轮询  | `QuotaCallGuard.assertUserInitiated(reason)`：无用户动作抛错、连点视为轮询；只挂在 `/usage` |

回归：`tests/unit/agy-compliance.test.ts`（18 例，含「agy 模块里不许出现 setInterval」的静态扫描）。

---

## 5. 切内核后怎么复用原有工作流

### 5.1 技能库软链接直通

```bash
# 界面里发一条命令即可（幂等，不覆盖已有目录）
/agy-skills
```

等价于把 `<~/.pi/agent/skills>`、`<project>/.pi/skills` 下的每个技能目录软链到
`<project>/.agents/skills/<name>`（只链含 `SKILL.md` 的目录）。两个内核读同一份技能规范，
改一处两边生效。实现：`linkSkillsIntoProject()`（`server/agy/agy-workspace.ts`）。

### 5.2 自定义工具走标准 MCP（不做工具反向桥接）

```bash
/agy-mcp        # 查看路径与当前项目声明的服务
```

- 项目级：`<project>/.agents/mcp_config.json`（`{"mcpServers":{"memory":{"command":"node","args":["memory-mcp.mjs"],"env":{…}}}}`）
  → 由 `session/new` 的 `mcpServers` 参数原生交给 agy 连接。
- 全局级：`~/.gemini/config/mcp_config.json`，用 `agy mcp add <name> <command> [args…]` 管理。

**不要**把宿主的基础工具（bash/read/write…）反向桥接成 ACP 工具：那会把工具执行权搬回宿主，
既毁掉「官方进程自己执行」的合规前提，也会出现双重身份。

### 5.3 两套额度分工

| 场景                                     | 建议内核                                   |
| ---------------------------------------- | ------------------------------------------ |
| 轻量对话 / 强依赖 pi 插件与低 Token 逻辑 | `pi` 内核（GEMINI_API_KEY / 赠金）         |
| 重度多文件重构、需要 20x 滚动配额        | `agy` 内核（Ultra 20x 的 5 小时 + 周配额） |

额度查看：`/usage`（单次、零 token、不轮询）→ 例如
`Gemini Models: Weekly 95% · Five Hour 94%`。
订阅档位在握手时随 `_meta.antigravity.tier` 一起下发（如 `Google AI Ultra`），只读展示。

---

## 6. 多内核并存时的隔离（密钥 / 登录态 / 历史）

### 6.1 按内核独立注入环境（`agy-env.ts`）

拉起 `agy acp` 时不再继承整份 `process.env`，而是**白名单 + 黑名单**双保险：

- 黑名单（命中即剥）：`GEMINI_API_KEY`、`GOOGLE_API_KEY`、`GOOGLE_GEMINI_BASE_URL`、`GEMINI_BASE_URL`、
  `GOOGLE_GENAI_USE_VERTEXAI`、`AGY_ADC_AUTH`、`ANTIGRAVITY_*`、`CLOUD_CODE_ENDPOINT`，
  以及 `DEEPSEEK_*` / `ANTHROPIC_*` / `OPENAI_*`（别家内核的 Key 也不许串进来）。
- 白名单（只透传）：`PATH`、`HOME`、`XDG_*`、`TMPDIR`、`LANG/LC_*`、`TERM`、`TZ`、代理与 CA 变量、
  Windows 运行必需项（`SystemRoot`、`APPDATA`…）。
- 官方配置只做**只读**冲突检测（`detectAgyConfigConflicts`）：若 `settings.json` 里写了
  `modelProvider: gemini` / `apiKey`，提示可能改走 API Key 计费；**绝不修改**官方文件。

反方向：`pi` / `claude` / `codex` / `dsh` 内核不经过这套裁剪，继续用完整 env（它们本来就要用你的第三方 Key）。
所以「切到其他内核跑自己的 API」与「agy 内核走订阅额度」互不干扰。

### 6.2 跨内核接力清洗（`agy-handoff.ts`）

同一任务中途换内核时：**工作区代码 / 技能 / 本地记忆文件 / MCP 配置可以直接共享**，
但历史上下文必须先清洗：

- `stripSignatureFields()`：深度剥掉 `thinkingSignature`、`encrypted_content`、
  `providerMetadata`、`reasoning_details` 等签名与供应商内部字段；
- `stripReasoningSignatures()`：剪掉文本里的 `<thinking_signature>…</thinking_signature>`、
  `[thought signature] …`、超长内联签名串；
- `sanitizeCrossEngineHistory()`：历史 → 纯文本行（user / assistant / tool 各自可见正文 +
  工具名与参数），带长度上限并加「更早历史已省略」标记；
- `renderHandoffContext()`：渲染成注入文本（自带说明头，避免被下游当成新指令）。

agy 驱动的 prompt 构造（`buildPromptBlocks`）在拼装前统一过 `stripReasoningSignatures`，
因此从 pi 内核带过来的任何签名块都不可能进入官方进程。

---

## 7. 验证记录

```bash
# 1) 零 token：驱动握手 + 模型过滤 + 档位 + 红线段言（~3s）
node --import tsx tests/agy-driver-smoke.mjs

# 2) 零 token：服务级（ready.engine=agy / list_models / slash_commands / 零重启热切 agy↔pi）
npm run build:server && node tests/agy-smoke-test.mjs

# 3) 真实一轮：权限请求 → 放行 → 工具执行 → 回合 usage（约 1.5 万 Token）
AGY_PROBE_LIVE=1 node --import tsx tests/agy-permission-probe.mjs

# 4) 纯单测（零 token / 零子进程）
npx vitest run tests/unit/agy-compliance.test.ts tests/unit/agy-env-handoff.test.ts
```

`tests/agy-smoke-test.mjs` 已纳入 `tests/run-smoke.mjs` 的 ALL 名单（agy 未安装时自动 SKIP）。

模型 id 在宿主侧带引擎前缀（`agy/gemini-4-carbon`）；驱动的 `setModel` 会剥掉前缀并归一化到
ACP 的族名（`gemini-4-carbon`），因此下拉框、default_model 记忆、`/model` 命令三种入口都一致。

实测结果：

- `agy-driver-smoke`：createSession ✓ / 目录仅 Gemini（6 个）✓ / 思考档位 low·medium·high ✓ /
  切 Claude 被拒 ✓ / 权限跳过参数被拒 ✓ / 订阅档位 `Google AI Ultra` ✓
- `agy-smoke-test`（服务级）：`ready.engine=agy` ✓、初始推送齐全 ✓、模型目录 6 个全 Gemini ✓、
  `slash_commands` 含 `usage / agy-skills / agy-mcp` ✓、`switch_engine` agy→pi→agy 零重启 ✓
- `agy-permission-probe`：`tool_call → onToolStart` ✓、`request_permission → 探针放行` ✓、
  `tool_call_update(completed) → onToolEnd` ✓、回合 usage ✓、正文流式 ✓
- 单测：19 + 13 例全绿

---

## 8. 已知限制（v1 不做的事）

- **不支持斜杠命令代发**：agy 侧 `/goal`、`/teamwork` 等在 ACP 里是「发给模型的文本」，
  宿主不代发、不模拟；宿主只提供自己的 `/usage`、`/agy-skills`、`/agy-mcp`。
- **不接管 fs/terminal 能力**：客户端不声明 `fs.readTextFile/writeTextFile`、`terminal`，
  文件与命令一律由官方进程执行（这正是合规前提）。
- **不做会话标题同步**：`session_info_update.title` 只记日志，不改宿主会话标题。
- **不做 plan 渲染**：`plan` 通知忽略（宿主计划看板属 pi 引擎特性）。
- **子代理**：agy 自带 team/swarm 编排，但不包装成宿主子代理（`capabilities.subagents=false`）。
- **会话续聊**：会话 id 由官方维护并随宿主会话落盘；官方侧清理后自动回落新会话
  （`onSessionStarted` 通知宿主换 id）。
