<div align="center">

<img src="./web/public/favicon.svg" width="84" height="84" alt="PI logo" />

# PI

**Minimalist cross-platform desktop & web workspace for AI coding and everyday chat.**

**English** · [简体中文](./README.zh-CN.md)

[Latest Release & Installers](https://github.com/feifeifei527/pi-web-ui/releases/latest) · [Design Plan](./docs/redesign-plan.md) · [Architecture](./docs/architecture-core.md)

[![Node version](https://img.shields.io/node/v/pi-web-ui)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

</div>

---

**PI** is a deep redesign and feature evolution built on top of [`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui) (powered by the `@earendil-works/pi-coding-agent` SDK). While preserving the full power of multi-engine coding agents, integrated PTY terminals, Git workflows, Canvas pipelines, and plugins, **PI** reimagines the experience as a clean, single-instance desktop application inspired by **Claude Desktop** and **OpenAI Codex**.

---

## ✨ What's New in This Edition (by [@feifeifei527](https://github.com/feifeifei527))

### 1. Claude + Codex Minimalist UI Redesign

- **Zero-clutter first screen:** Removes the heavy multi-bar cockpit (dual side docks, crowded top bar, and persistent status bar) in favor of a calm three-part layout: **collapsible sidebar + borderless conversation canvas + floating composer**.
- **Warm adaptive palette:** Built on a dedicated `@layer minimal` design token system with Light (`#FAF9F5`), Dark (`#262624`), and System-following schemes accented by terracotta (`#D97757`).
- **Hybrid typography:** Assistant responses render directly on the canvas with generous reading rhythm (Claude style), while tool calls, reasoning blocks, code blocks, and diffs use compact monospace rows (Codex style).
- **Unified Command Palette (`Ctrl/Cmd + K`):** Quick keyboard access to every view (Git, Canvas, Worktrees, Device Center, Plugins), layout toggles, appearance switching, and full-text session/file search.
- **Bottom Terminal Dock (`Ctrl + \``):** Resizable bottom terminal panel with a compact 32px horizontal tab strip so you can watch live command output while chatting.

### 2. Standalone Chat Space & Single-Project Focus

- **Standalone Chats (`💬 独立对话`):** Chat immediately without binding to a local code folder—ideal for everyday Q&A, brainstorming, and writing.
- **Single-Project Focus Sidebar:** Inactive projects display as clean, single-line rows without visual clutter. **Double-click** a project to enter and expand its conversation history; click the collapse arrow (`▾`) to fold and exit back to Standalone Chats.
- **Cloud Topic Projects:** Create lightweight topic projects with custom project instructions that sync across machines alongside local Git workspaces.

### 3. Two-Tier Shared Memory, Session Isolation & GitHub Cloud Sync

- **Global & Project Memories:** Automatically injects `<user_memory>` into the system prompt with both **Global Memories** (personal preferences, coding style, background) and **Project Memories** (repo-specific conventions + custom instructions).
- **Zero-RTT Inline Memory Markers:** Works across all presets—including **Chat-only (`ask`) mode**—via inline markers (`[[memory:global:...]]`, `[[memory:project:...]]`, `[[memory:forget:...]]`), allowing the AI to remember facts on the fly without extra tool-call round trips.
- **Per-Chat Isolated Memory (`🔒 独立记忆`):** One-click toggle to isolate any conversation so it neither reads from nor writes to shared memories.
- **Cross-Device GitHub Cloud Sync:** Sign in via **GitHub OAuth Device Flow** (8-character browser code, zero CLI dependencies) or Personal Access Token. Memories and topic projects automatically sync to a private `pi-memory-sync` repository in your GitHub account using deterministic per-item timestamp + tombstone merging across **Windows, macOS, and Ubuntu**.

### 4. True Single-Instance Desktop Lifecycle (Windows / macOS / Ubuntu)

- **Close Window = Clean Exit:** Unified across Windows, macOS, and Linux—closing the window exits the application instead of leaving background daemons behind, with an in-app confirmation dialog if an agent task is still running.
- **Three-Stage Process Tree Cleanup:**
  1. Snapshots all descendant PIDs of the server sidecar;
  2. Requests graceful IPC shutdown (`5s` budget to dispose PTYs, MCP bridges, and LSP servers);
  3. Enforces tree-kill (`taskkill /F /T` on Windows, process-tree `SIGKILL` on POSIX) plus survivor sweep—verified in CI even when background processes detach from their terminal.

---

## 🚀 Installation & Usage

### Option 1: Prebuilt Desktop App (Windows / macOS / Ubuntu)

Download the installer for your platform from [**GitHub Releases**](https://github.com/feifeifei527/pi-web-ui/releases/latest):

| Platform           | Package                                      | Notes                                                                                                                                                           |
| ------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Windows**        | `PI-<version>-setup.exe` or `*-portable.zip` | Built-in runtime; portable edition includes launcher scripts                                                                                                    |
| **macOS**          | `PI-<version>.dmg`                           | Ad-hoc signed (`identity: "-"`). On first open, if Gatekeeper warns that the app is damaged, run:<br>`sudo xattr -rd com.apple.quarantine /Applications/PI.app` |
| **Ubuntu / Linux** | `PI-<version>.AppImage`                      | `chmod +x PI-*.AppImage && ./PI-*.AppImage`                                                                                                                     |

### Option 2: Run from Source (Desktop or Web Mode)

Requires **Node.js >= 22.19.0**.

```bash
git clone https://github.com/feifeifei527/pi-web-ui.git
cd pi-web-ui
npm ci

# Build web + server + desktop shell
npm run build
npm run build:desktop

# Launch the Electron desktop app
npm run desktop:dev

# Or run in headless / browser mode (http://127.0.0.1:8787)
npm start
```

### Common CLI Flags (Web / Server Mode)

| Flag               | Environment Variable | Description                                                              |
| ------------------ | -------------------- | ------------------------------------------------------------------------ |
| `--cwd <dir>`      | `PI_WEB_CWD`         | Initial workspace directory                                              |
| `--port <n>`       | `PI_WEB_PORT`        | HTTP/WebSocket port (`8787` for web, `8790` default for desktop sidecar) |
| `--host <addr>`    | `PI_WEB_HOST`        | Listen address (`127.0.0.1` by default)                                  |
| `--data-dir <dir>` | `PI_WEB_DATA_DIR`    | Data directory (`~/.pi-web` by default)                                  |
| `--no-browser`     | —                    | Start server without opening a browser window                            |

---

## ⌨️ Keyboard Shortcuts

| Shortcut         | Action                               |
| ---------------- | ------------------------------------ |
| `Ctrl / Cmd + K` | Open Command Palette & Global Search |
| `Ctrl + \``      | Toggle bottom Terminal Dock          |
| `Ctrl / Cmd + ,` | Open Settings                        |
| `Alt + Z`        | Toggle Zen / Focus Mode              |

---

## 🧪 Verification & Quality Gates

```bash
# Typecheck all 5 TypeScript projects (server, web, desktop, tests, extension)
npm run typecheck

# Unit tests (Vitest)
npm test

# Cross-platform desktop exit & zero-orphan process tree test
npm run test:desktop-exit

# Minimal shell end-to-end browser test
node tests/minimal-shell-browser-test.mjs
```

---

## 🙏 Credits & License

- **Upstream Foundation:** Forked from and inspired by [`xing-shuyin/pi-web-ui`](https://github.com/xing-shuyin/pi-web-ui) and the `@earendil-works/pi-coding-agent` SDK.
- **Redesign & Memory/Sync Architecture:** Crafted by [@feifeifei527](https://github.com/feifeifei527).
- **License:** [MIT](./LICENSE)
