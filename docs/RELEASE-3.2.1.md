# Model Router 3.2.1 · 原生运行时与协议修复

- macOS 主程序和 Node 均为 Universal（arm64 + x86_64）。移除包内 Intel-only Node 文件，旧运行路径保留为兼容别名。Apple Silicon 使用原生 arm64；Intel Mac 仍可使用同一安装包。
- 修复 reasoning 流缺少输出项声明、文本/工具输出索引错位及工具生命周期事件不完整的问题。
- 统一 custom tool 参数解析，兼容原文、JSON 字符串与 input 包装，避免把额外 JSON 引号送进 apply_patch。
- 修复 Windows 服务的 ELECTRON_RUN_AS_NODE 标志泄漏到桌面 GUI 子进程的问题。
- 修复最近使用模型被删除后，窗口可能回退到无关模型的问题。
- 已运行的 Bonsai 服务保留其配置的上下文长度，健康检查不再自行降低。

## 验证与边界

实际 Codex → Bonsai 编码检查已完成读文件、apply_patch 和测试命令，独立复核通过，约 66 秒；修复后该样本未再出现 ReasoningRawContentDelta without active item。该次运行中模型曾生成一次无效 patch 后恢复，不能据此保证所有模型输出都正确。

Lite 的网关请求裁剪持续生效。但当前 ChatGPT Desktop 会在启动时自行安装内置插件，并重写独立 home 的部分配置；不能承诺该客户端运行后目录始终只有两个配置 section。Router 不修改官方客户端二进制，也不靠删除用户全局插件强制实现隔离。

Windows Setup / Portable 继续标记为 Preview：真实 Windows CI 验证测试和打包，不能替代所有 Windows 实机 GUI/MSIX 场景。
