# Model Router 3.1.0

## 主题：ChatGPT Desktop 更新兼容 + GitHub 在线升级

### 官方 ChatGPT Desktop 动态兼容

- macOS 不再写死旧 `/Applications/Codex.app`。
- 优先发现 `/Applications/ChatGPT.app`，同时通过 bundle id `com.openai.codex` / Spotlight 动态发现，最后兼容旧 Codex.app。
- 官方入口使用 macOS `open` 激活当前官方 App，不依赖 Accessibility / System Events。
- Model Router 的隔离工作窗口也使用同一个当前官方 App resolver。
- Windows 继续按 AppX/MSIX 清单动态发现官方 ChatGPT/Codex。

### GitHub 在线更新

更新源完全使用 `shiftshen/model-router` GitHub Releases，不需要自建服务器。

- 启动时静默检查新版本。
- 每 6 小时后台检查一次。
- macOS 菜单支持“检查更新…”，有新版时标题栏显示版本提示。
- macOS 下载正式 notarized DMG，验证 Release SHA256、DMG、codesign、Gatekeeper 后，退出旧 App、原子替换并自动重开。
- Windows 安装版下载 Setup EXE，验证 `SHA256SUMS-windows.txt`，退出后启动安装器。
- Windows Portable 下载新版 Portable 并定位文件，不强制覆盖正在运行的便携 EXE。
- 更新不会修改 `~/.codex/model-assistant`，模型、API Key、窗口、会话继续保留。
- 从 3.0.x 升到 3.1.0 仍需最后一次手工安装；从 3.1.0 开始后续版本可在 App 内更新。

## 验证

- 动态发现已在当前新版 `/Applications/ChatGPT.app` 上真实验证。
- GitHub updater 已真实发现 3.0.3 Release。
- 已真实下载 3.0.3 的 134 MB DMG，并与 Release SHA256 校验完全一致。
