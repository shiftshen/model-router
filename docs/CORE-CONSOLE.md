# 本机核心管理页（源码版）

这个入口运行在独立的 Node 进程中，只绑定 `127.0.0.1:18794`。它读取现有 Model Router 模型库和网关，不修改已安装的 App，也不会改动正在进行的 Codex 对话。

## 启动与接入

先确保 Model Router 网关运行，再在本仓库执行 `node src/core-console.mjs`。终端会输出一次本机管理页地址；地址 `#` 后是本机管理令牌，不要发给其他人。打开管理页后可以查看现有路线和验证时间、更新上游 Key、查看网关可用模型、为每个智能体生成独立代理密钥，以及撤销代理密钥。

给支持 OpenAI Responses API 的智能体配置：

- Base URL：`http://127.0.0.1:18794/v1`
- API Key：管理页为该智能体生成的 `mr-...` 代理密钥
- Model：管理页“查看网关可用模型”列出的一个模型标识

代理密钥只显示一次；核心只保存 SHA-256 摘要。上游 Key 留在现有 `~/.codex/model-assistant/credentials`，不会复制到智能体。管理页暂不自动改写其他智能体的配置；每个智能体首次接入时仍须配置一次 Base URL 和代理密钥。代理密钥撤销后立即失效。

此入口目前只代理 `GET /v1/models` 和 `POST /v1/responses`。不支持 Chat Completions 协议的客户端需要适配。它复用已经运行的 Model Router 网关；网关未运行时代理请求会失败。管理页显示各智能体请求数、HTTP 完成数和失败数；HTTP 成功不代表任务验收通过。费用与 token 用量暂无可靠数据，显示“未知”，不会凭请求数或标价猜测账单。

当前只有本机回环地址可用。需要从其他机器接入时应另行设计身份验证、TLS、网络边界与配额，不能直接开放本端口到局域网或互联网。

## 成本与第三方面板评估

截至 2026-09-24，供应商公开标价必须按**实际结算渠道、模型、服务档位、上下文长度、缓存与时段**分别处理。例如 [OpenAI 官方价目表](https://developers.openai.com/api/docs/pricing)中 `gpt-6-sol` Standard 短上下文为输入 $2、缓存输入 $0.20、输出 $10 / 百万 token；长上下文和其他服务档位不同。[DeepSeek 官方价目表](https://api-docs.deepseek.com/quick_start/pricing/)中 `deepseek-flash` 的输入缓存命中、未命中与输出分别计费，且有峰谷时段。因此页面不能只凭模型名和请求数算费用；尤其通过转售平台的路线，要以该平台实际账单和自定义费率为准。

[LiteLLM Proxy](https://docs.litellm.ai/docs/proxy/virtual_keys)已有虚拟密钥、模型权限、预算和费用跟踪，但密钥管理依赖 PostgreSQL，作为单机小项目的核心依赖偏重。[New API](https://github.com/QuantumNous/new-api/blob/main/README.en.md)具备渠道和令牌管理，可作为多用户或多机器场景的独立网关候选。`api.vdamo.com` 是一条实际可配置的上游地址；未验证它提供可自托管的管理面板或可信费率 API，不把它当作现成的本机控制台。

下一步要做可信金额，需要在每次网关请求中采集供应商返回的 `usage`，把实际路线、模型、输入、缓存、输出 token 和计费档位与带来源日期的费率快照关联；缺失的用量或费率显示“未知”，并与供应商账单对账。本版先交付本机统一 Key 入口和按智能体请求数，避免显示虚假的金额。
