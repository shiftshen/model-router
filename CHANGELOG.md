## 3.2.4 · 会话隔离与旧模型元数据修复

- 窗口启动和项目整理只维护本窗口项目分组，不再从官方及其他窗口合并元数据。历史导入仅保留显式操作入口。
- 为旧模型别名补齐隐藏的模型元数据，使旧会话能识别当前条目，又不在下拉菜单重复列出别名。
- 官方登录与第三方供应商混合切换仅在隔离实验中探索，未加入稳定版。

验证：205 项提交内测试通过；安装版 Codex app-server 能识别旧别名并返回正确显示名。Windows 为 Preview，未替代实机 GUI 验收。

# Changelog

## 3.2.3

- 固定保存每个条目的路由标识，编辑上游模型、增加同名模型或归档其他模型不会改变旧会话归属。
- 临时限流、认证、权限和上下文错误分别报告，不再把所有 HTTP 429 都伪装成额度耗尽。
- 模型保存后同步可切换窗口目录，默认打开入口明确标为「打开可切换窗口」。

- Do not block model startup on optional /models discovery. Validate local configuration and let actual inference determine upstream availability.
- Preserve manually entered model aliases in discovery; unsupported catalog endpoints retain the current model instead of preventing selection.
- Saving a route synchronizes existing stopped dedicated/continuation homes, including model catalogs. Running homes explicitly require reopening.
- Reproduce ark-code-latest with the real Codex CLI and a shell file round trip; add regressions for missing catalogs, aliases, authorization failures and stale home configuration.

## 3.2.2

- Official entry activates the detected default-profile PID instead of an arbitrary application instance sharing the same bundle ID.
- macOS sends a targeted reopen event and waits for its reply, restores hidden/minimized windows, and verifies both foreground ownership and a visible window before reporting success.
- Cold launch explicitly starts a default-profile instance with router environment variables removed, then discovers and verifies the actual instance rather than trusting the launcher exit code.
- Coalesce concurrent official requests and guard SwiftUI entry actions against repeated clicks. Reject unconfirmed activation instead of displaying false success.
- Exclude custom profiles using either --user-data-dir argument spelling.

## 3.2.1

- Package a single Universal Node runtime with compatibility aliases, removing the Intel-only helper from the macOS bundle. Require both architectures for the app and runtime in builds and CI.
- Declare and close reasoning stream items correctly, preserve output indices across reasoning/text/tool calls, and emit tool item lifecycle events.
- Decode custom-tool inputs consistently for raw text, JSON strings and input wrappers in streaming and buffered responses.
- Remove inherited ELECTRON_RUN_AS_NODE when launching desktop GUI processes from the Windows Electron service.
- Reopening a window with a removed recent model now uses that window's starting model instead of an unrelated catalog entry.
- Health checks no longer lower the configured context window of an already running, externally managed Bonsai service.

## 3.2.0

### Codex runtime profiles
- Added Auto / Lite / Full selection to the macOS and Windows model editors. Auto selects Lite for local endpoints without an API key and Full for cloud models.
- Lite homes use a small configuration and short AGENTS file, without inheriting global plugins, MCP servers, skills, hooks or historical project rules.
- Preserve core terminal/editing tools and project requirements; Full requests retain their original tools and instructions.
- Resolve each window's environment from its current or starting model, including legacy instances and continuations. Running windows apply environment changes after reopening.
- Safely remove shared symlinks/junctions/hard links without modifying global source assets.
- Filter oversized tool catalogs before forwarding Lite requests and use the filtered request when rechecking context limits.
- Context-overflow retries now regenerate the Lite payload after compaction; system/developer requirements survive history summarization.

### Validation and scope
- Added payload, config-size and shared-asset regression coverage.
- Global configuration cleanup is a local opt-in operation, not an automatic change on other users' machines. See `docs/RELEASE-3.2.md` for scope and measured examples.
- Windows remains Preview pending real desktop GUI acceptance; Windows CI builds and verifies Setup and Portable packages.

## 3.1.0

### ChatGPT Desktop compatibility
- Replaced the hard-coded macOS Codex.app dependency with dynamic ChatGPT Desktop discovery using the current ChatGPT.app, bundle id `com.openai.codex`, Spotlight, and legacy fallback.
- Official activation now uses macOS `open`, so it does not depend on Accessibility permission.
- Routed work windows use the same current official desktop resolver.

### GitHub updater
- Added startup and 6-hour GitHub Release update checks with a manual Check for Updates action.
- macOS downloads the notarized DMG, verifies SHA256/codesign/Gatekeeper, atomically replaces the app and reopens it.
- Windows installed builds download/verify the Setup installer; Portable builds download the new portable EXE without unsafe self-overwrite.

## 3.0.3

### Conversation attribution
- Route and fallback logs now persist the Codex session/thread id for each real request.
- Live-thread accounting can recover a missing thread model only from an exact same-session route-log match; it never guesses from window defaults.
- Active thread rows now show the owning window/scope and Thread ID and can open the corresponding Codex window.
- Fallback banners explicitly describe fallback as a per-request event, distinguish stale history from current fallback configuration, and link to the matching live thread when available.

## 3.0.2

### macOS model library
- Fixed the Add Model (+) and Edit Model actions appearing unresponsive while the model library sheet is open.
- Moved add/edit/discovery/diagnostics presenters onto the model-library sheet itself so nested sheets are presented by the active macOS view hierarchy.
- Root diagnostics now opens the model library first and then presents diagnostics from the correct sheet layer.

## 3.0.1

### Intelligence consistency
- All isolated Codex homes now share the global `AGENTS.md` in addition to auth, skills, plugins and hooks.
- Routed and switchable windows preserve global reasoning, plan-mode and `[agents]` configuration while overriding only model/provider routing.
- Existing local Model Router homes are migrated to Medium reasoning / Medium plan defaults and the shared global agent rules.
- Added regression coverage so future isolated environments cannot silently lose AGENTS or reasoning configuration.

## 3.0.0

### Brand
- Rebranded the product to **Model Router / 模型路由助手**.
- Added new logo, app icon, hero artwork and brand guide.
- Renamed user-facing macOS and Windows application/package names.

### Product
- Preserves routing, fallback, multi-window, billing-ledger and disk-management functionality from 2.x.
- Keeps the official ChatGPT Desktop / Codex launcher separate from routed third-party workspaces.
- Keeps internal compatibility IDs and data paths unchanged for safe upgrades.

### Platforms
- macOS: Universal arm64 + x86_64, macOS 12+.
- Windows: x64 Preview, NSIS + Portable builds.

## 2.9.0-windows-preview.2
- Improved Windows model library layout and fixed official-app entry visibility.

## 2.8.5
- Reworked macOS model library layout.

## 2.8.4
- Added a fixed official Codex entry on the macOS home screen.

## 2.8.3
- Unified the official launcher and removed legacy proxy model entries.
