# Model Router 3.3.3

稳定功能维护版，撤下未完成的统一登录实验。

- 官方入口恢复到 ChatGPT 默认资料，保留原账号、原历史。
- API 工作窗口相互独立，可在会话内切换第三方模型。
- API 窗口目录不再显示实验性的官方订阅模型；旧选择也不会借用全局账号扣费。历史和模型配置不删除。
- 移除未验收的独立官方登录、账号混用和同步官方模型入口。
- 修复真实验证误判：空响应和未返回验证词的响应不能标为成功。
- 保留实际渠道、请求模型和上游返回模型记录，以及真实供应商错误提示。
- 改进官方窗口激活和 macOS Universal 运行时。

此版本不支持在官方原生模型菜单内混用官方订阅与第三方 API，也不宣称支持原生多账号统一窗口。
火山 ark-code-latest 返回 auto 时，只确认渠道和别名，不能确认供应商内部底层模型。

macOS：Universal，Developer ID，App/DMG 公证和装订。
Windows：x64 Setup/Portable，仍为 Preview；GitHub windows-latest 验证不等同于 Windows GUI/MSIX 实机验收。
