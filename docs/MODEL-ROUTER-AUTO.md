# 自动选模执行入口

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
