# Laya Typed-Decisions 与 Jev 路由验收（2026-09-23）

## 结论

本机 Laya CoreML 推理可运行，但目前不能独立决定 Model Router 的生产模型路由。复杂任务的实验链路先尝试 Laya Typed-Decisions；只有返回完整、合法的任务画像且置信度达到门槛时才采用，否则交给 Jev。所有候选仍须通过能力、上下文、隐私与凭据状态的硬过滤。两者都失败时不选择模型。

该链路仅用于受控比较；当前桌面应用仍使用用户明确选择的模型，不自动改变正在进行的对话。没有在 macOS/Windows 安装包中内置 Python、CoreML 模型权重或 Jev 凭据。

## 已有配对实测

2026-09-22 的冻结样本含 72 个合成情景的中文、泰文、英文版本，共 216 条。测试前冻结了 gold、政策和输入；Laya/Jev 收到相同的有限选项问题。结果保存在本机独立评测目录，原始文件未纳入产品包。

| 路径 | 正确 / 216 | 准确率 | Jev 调用比例 |
| --- | ---: | ---: | ---: |
| Laya Typed-Decisions | 88 | 40.74% | 0% |
| Jev 1.13.0 | 210 | 97.22% | 100% |
| 规则 + Laya + Jev | 210 | 97.22% | 41.67% |
| 规则 + Jev | 213 | 98.61% | 41.67% |

Laya 在这 216 条的 choice confidence 全部小于 0.5。因此 0.5 门槛会把全部语义判断交给 Jev，不能宣称它在这组样本中省下了 Jev 调用。Laya 的 216 条首轮调用平均约 178 ms（含不同输入形状的首次开销）；冷加载约 4.66 秒，常驻内存约 1.17 GiB，峰值约 2.79 GiB。其 1024 token 输入上限要求长任务只能使用受控摘要，不能直接读完整项目历史。

2026-09-23 另以同一冻结样本 `drama-001-zh` 重新调用：本机 Laya 返回 `PASS`、confidence 0.0965，含冷启动耗时 5.31 秒；Jev API 返回 `PASS`，约 452 ms。这是一次可用性复核，不计入上表准确率。

同日还完成了一次新规划器的真实端到端调用：显式指定本机 CoreML Python 与缓存模型、由钥匙串向官方 SDK 提供 Jev 密钥；规划器先尝试 Laya，再因低置信转 Jev，最终选中测试注册表的 `test-coder`，状态 `resolved`。记录为 `layaCalls=1`、`jevCalls=1`、`fallbackReason=laya_low_confidence`，耗时约 5.85 秒。这证明接口和接管路径可运行，不能证明该选择的模型完成了真实编码任务。

作为历史模型能力的独立实测，本机还经 Model Router 网关对已配置的 `gpt-5.6-sol` 路由发起六项实际推理验证：17 个格式/内容检查通过 16 个，综合 94 分；规划题的 `task_type` 返回 `feature_design` 而非要求的 `planning`，其余五类检查全通过。该记录证明此路由在这六道短题上的响应质量与网关可用性，不证明上游底层模型身份，也不证明 Laya 的选模质量。未配置 API Key 的条目会被拒绝验证，不能以请求失败生成零分能力报告。

## 发布判断

Laya 主尝试、Jev 兜底的代码路径需要继续保持受控实验状态。发布默认自动路由前，须用 Model Router 自己的任务和已验证模型做冻结样本对照，记录每次 Laya/Jev 实际调用、接管原因、最终模型、质量和耗时；还须验证 Windows 上的本地运行方式。现有 216 条属于其他业务情景，不能直接证明 Model Router 的任务路由质量。

上游 Laya Typed-Decisions 专用于四类训练工作流；上游也说明该 checkpoint 不会由 Router 默认自动选择。参考：[Laya 项目说明](https://github.com/artificial-intelligence-works/laya-jev)、[checkpoint 模型卡](https://huggingface.co/convaiinnovations/laya-typed-decisions)。
