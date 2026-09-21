# Model Router 3.3.2

- 模型切换改为两阶段审计：请求发出记录为 `started`，只有上游完整成功后才标记 `completed / confirmed`；失败记录为 `failed`，不再把“尝试过”冒充“切换成功”。
- 每条路由证据记录 Thread、路由 ID、上游域名、请求模型、供应商返回模型与协议。macOS / Windows 状态区明确区分“已确认、失败、未确认”。
- 流式响应在路由确认落盘后才向客户端发送 EOF，并处理客户端断开与背压，避免界面显示完成而审计仍未确认。
- Model Router 显示当前官方登录账号，提供“更换账号”和“同步账号”。macOS 工作窗口实时跟随官方 `auth.json`；Windows 在同步时安全复制最新认证，避免官方客户端原子换文件后旧 hard link 继续指向旧账号。
- 官方认证状态只暴露姓名、邮箱、账号尾号和过期状态，不返回任何 access / refresh / ID token。
- 同一 Thread 实机完成 8 轮交替切换：ChatGPT GPT-5.6-Luna 与字节 Coding Plan `ark-code-latest` 各 4 次；全部 HTTP 200、路由/域名/请求模型匹配且 `confirmed=true`。
- Windows 仍为 Preview；正式资产必须通过 `windows-latest` 的测试、Setup、Portable、SHA256 与 Artifact 验证。

说明：供应商可能返回动态路由名。火山 Coding Plan 对 `ark-code-latest` 的响应模型字段为 `auto`；Model Router 同时展示请求模型和真实上游域名，不把供应商自报名称替换成未经证明的具体底层模型。
