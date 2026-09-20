# Model Router 3.2.0 · Codex 环境分层

模型编辑器新增“Codex 环境”：Auto / Lite / Full，macOS 与 Windows 共用相同路由规则。

- Auto：本地无 Key 模型默认 Lite；云端模型默认 Full。
- Lite：小配置、短 AGENTS、核心终端与编辑工具，不继承全局 Skills、Plugins、MCP、hooks 或历史项目规则。
- Full：保留原有工具与指令，不通过降低模型或推理级别节省用量。
- 现有窗口按当前或起始模型选择环境；切换环境后重开窗口生效，保留对话。
- 长历史压缩保留 system/developer 要求；Lite 超限重试使用压缩后的请求，避免重复发送旧大请求。
- 共享目录迁移安全处理 macOS symlink 与 Windows junction / hard link，不删除全局源文件。

## 实测范围

开发机器的 Lite 配置生成结果为约 0.8 KB、2 个 section，测试对包含数百个全局配置 section 的输入锁定输出小于 2 KB。

一次真实 Codex → 网关 → Ternary Bonsai 2 27B 问候请求，网关裁剪后的请求约 10.9 KiB，模型报告约 2410 个输入 token 并完成回复。JSON 字节数不是 token 数；不同 Codex 版本、项目规则、图片和对话历史会改变请求大小。这不是所有场景的固定上限，也不代表官方账户的计费值。

全局插件、Skills、MCP 的瘦身需要按机器使用情况选择，并先备份；本版不会自动删除其他用户的全局配置。减少无关上下文不等于保证所有任务质量不变，需要完整工具生态时选择 Full。

## 下载与兼容

- macOS：Universal（Apple Silicon + Intel），macOS 12+；正式发布包使用 Developer ID、App/DMG notarization 和 staple。
- Windows：x64 Setup / Portable，仍为 Preview。GitHub Windows Runner 验证测试和打包；真实桌面 GUI / MSIX 行为尚不能仅由 CI 证明。
- 原有官方入口、在线更新、fallback、独立窗口和会话追踪继续保留。
