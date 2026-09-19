# Changelog

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
