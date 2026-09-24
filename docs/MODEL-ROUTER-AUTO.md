# 自动选模执行入口

## Codex API 工作窗口中的每轮自动选择

在 Model Router 创建的 API 工作窗口里，选择「自动选择模型」后，网关会对该对话的每一轮请求重新判定任务类别和难度，从当前连接检查、真实能力验证、额度失败记录与上下文限制生成合格候选快照，再交给本机 Laya / Jev 引擎选择一个实际模型。手动选择具体模型时不会被自动路由覆盖。有合格 API 模型时，本地模型只作备用。自动路线在首选上游尚未输出正文就失败时，只能转向同一轮快照里同样合格的备用模型；已开始输出正文就不能拼接另一家模型的回答。

Model Router 首页每个窗口的「本窗口路线」会显示最近的选中路线、实际请求路线、选模来源、网关请求 ID、响应模型与失败/备用原因，并自动刷新。网关成功完成的记录才标记为已完成；客户端提前取消、供应商出错或没有返回完整结果会如实显示失败。供应商自称的模型名不是模型权重证明。

这只作用于 Model Router 管理的第三方 API Codex 工作窗口，不修改官方 ChatGPT Work 的模型菜单，也不会改动已在运行的旧对话。能力验证是短任务测试，不证明模型广告里的 1M 上下文；超过保守窗口的请求会拒绝自动分配。没有合格规划模型时明确报错，不能凭公开排名或模型名称替它通过本机验收。

**当前建议入口：**Mac 应用「智能执行任务」或 `node src/product-cli.mjs run-task`，使用近期真实验证生成候选并逐次验收。详见 [智能执行任务](TASK-EXECUTION.md)。以下 `model-router-auto-run.mjs` 是早期显式适配器，候选文件由调用者提供，不包含新的任务级验收，不应以其 HTTP 成功代替任务成功。

`scripts/model-router-auto-run.mjs` 是显式的 `auto` 执行入口。它先调用独立的 Model Router Engine，根据结构化任务画像和已验证的候选清单选出 Codex 模型目录中的 slug，再把完整 Responses 请求发送给现有的本机 Model Router 网关。任务原文只发送给最终选中的模型，不发送给 Laya/Jev 决策引擎。

准备四份输入：工作窗口生成的 `model-catalog.json`、人工或宿主验证后的 `candidates.json`、本次任务的结构化 `profile.json`，以及符合 Responses API 的 `request.json`。请求中的 `model` 必须是 `"auto"`（或省略）；明确指定了其他模型时程序拒绝覆盖。候选格式和资格要求见 [建议接口](MODEL-ROUTER-ENGINE.md)。

```sh
node scripts/model-router-auto-run.mjs \
  --engine /path/to/model-router-engine/bin/model-router-engine.mjs \
  --catalog /path/to/window/model-catalog.json \
  --candidates /path/to/candidates.json \
  --profile /path/to/profile.json \
  --request /path/to/request.json
```

命令使用 `CMA_ROUTE_TOKEN`，未设置时使用本机 Model Router 的 router token；不输出令牌。它把模型响应写到标准输出，把所选 slug 与决策来源写到标准错误。没有合格模型、后端不可用或模型身份校验失败时，不发送执行请求。实际模型请求可能产生费用。

这个入口可由 Codex 智能体或其他本机调度器自动生成 profile 后调用；已安装的 `model-router-engine` Skill 也说明了智能体如何按结果选择子智能体模型。现有 Codex 窗口的顶部手动选模仍按原行为工作，窗口内正在运行的同一轮对话不会被这个脚本中途改模。视频工作台的编剧选择由其独立适配器处理，不通过这个 Codex 网关命令。
