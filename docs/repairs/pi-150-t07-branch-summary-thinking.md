# T07：分支摘要继承当前推理级别

状态：先行设计已落实，T07 已通过 #189 合并。T06-F #188 最终提交 ecccb60013e733be36aed57072ceacc0b91c28fc 的 Codex 审核已 completed，同 head 无问题回执、无行内/正式 review 发现，六个 CI 全部成功；结构化发现布尔值为空，未将其冒称为 false。#188 已合并为 521f84f2316f19548c3f8e76021e808d1c0f1f60；对应本地/远端分支已删除、main 已同步。本项从该基线开启 codex/t07-branch-summary-thinking，仅 Node v26.13.0。

## 已确认的缺口

AgentSession.navigateTree 的 generateBranchSummary 参数包含 model/auth/signal/reserveTokens/stream/retry/callbacks，却缺少 this.thinkingLevel。GenerateBranchSummaryOptions 没有该字段，实际 requestOptions 固定为 apiKey/headers/env/signal/maxTokens:2048。普通 compaction 已通过 createSummarizationOptions 传入非 off 的 thinkingLevel。

会话 setThinkingLevel 已根据 getAvailableThinkingLevels 规范化用户选择；provider streamSimple 再按自身模型能力映射协议。T07 只补摘要入口缺失的单个值，不增加模型名白名单、第二套能力映射、fallback 或认证解析。T08 另行设计输出上限，本项保持 2048 和现有 length 失败语义。

## 最小改动

1. GenerateBranchSummaryOptions 增加可选 thinkingLevel，复用 agent-core 的既有 ThinkingLevel 类型。未提供时保持调用者原有行为。
2. navigateTree 在构造该次摘要 options 时传入 this.thinkingLevel；与现有 model/auth guard 位于同一请求边界，不挂新的全局缓存或 owner，不改 Agent 普通消息状态。
3. generateBranchSummary 构造 requestOptions 时，在支持推理且 level 非 off 的情况下附加 reasoning，语义与已有 compaction 一致；复用既有 provider/model 能力处理，不引入另一个手写 clamp。该值在同一次 completeSummarization 的已存在 requestOptions 中固定，既有 transient retry 复用同一配置。
4. 不改 createSummarizationStream/auth snapshot、普通 delta/event lane、maxTokens/reserveTokens 解释、summary prompt 或持久化格式。若源码核对发现必须改变这些边界，先补设计，不捆绑实施。

## 性能与生命周期边界

遵守已读 hot-path allocation contract。本改动位于显式 tree navigation / 一次摘要启动的低频配置边界，只增加标量字段；不为每 delta 创建 options、闭包、Promise、controller、数组或重试状态。不改大历史 prepare/serialize 的遍历次数，不重复生成完整 conversation。

审计链：navigateTree 的 execution boundary/model/session guard → auth snapshot → generateBranchSummary → prepare/serialize → completeSummarization 已有 retry owner → session/provider stream → 已交付 observer/terminal 链 → 原有 branch abort controller/finally release。此次只对配置传递增加行为验证，现有高频模块不借本项做结构重构。

## 验证顺序

1. 先用离线 stream 捕获 requestOptions，证明当前会话推理级别在 branch summary 丢失，再实施。覆盖 off、有效 level、无推理能力模型、未提供字段；模型能力映射用现有真实 provider 边界验证，不凭假 stream 断言它会替 provider 处理能力。
2. 真实 AgentSession tree summary 覆盖改变 level 后下一次摘要继承最新值，已启动摘要和既有 transient retry 复用请求快照；最大输出仍 2048，不增加请求次数或自动 length 重试。
3. abort/model owner 失效沿用现有 guards 和 compaction lifecycle 回归，验证取消不写摘要、listener/callback 释放；全部虚构认证与离线 transport，不访问真实凭据/provider。
4. 先新增最小聚合 branch-summary contract，再现有 compaction 生命周期定向回归、check/build:offline、当前 Node26 全套。记录实际结果与未改热路径的调用链证据，不虚称重新 profile 整个传输。
5. 独立 PR，主动 Codex review；等最终 head completed/no findings、六 CI success 后自动合并、精确删除本地/远端分支、同步 main，再进入 T08。有发现就修复推送并额外独立请求复审。

## 实施与验证记录

### #189 reviewer 修复设计（先于修复代码）

Codex 行内发现 4459750772：Google/Vertex budget 模式将 medium 映射为 8192，现有 requestThinkingTokens → resolveRequestOutputFloor 要求额外保留 1024 回答空间，超过摘要请求的 2048，因此请求在发送前失败。此前只测 Chat 的 level 映射，没有覆盖此预算型真实边界。

修复限定在摘要请求配置处：保留 reasoning 级别，复用 requestThinkingTokens 判断现有能力映射后的固定预算；只有预算超过摘要可用空间时，通过已有 thinkingBudgets 覆盖该次请求的实际有效级别。输出额度复用 resolveRequestOutputTokens，回答空间复用 minimumRequestOutputTokens，级别/key 复用 clampThinkingLevel/clampReasoning，不维护第二套模型名或级别表。预算已经足够小、动态 -1、level/adaptive/非 Google 模式不增加覆盖。模型上限不足以同时容纳回答和正 thinking 时仍由已有预算错误拒绝，不静默关闭推理或扩大请求额度。重试继续复用同一请求快照。

增加真实 Google/Vertex streamSimple payload 回归：8192 → 1024，模型上限更小、级别降到模型支持项、小预算不变、动态预算不变，以及无法容纳时只失败一次。先复现输出预算错误，再实现和运行定向/类型/构建/Node26 全套。修复推送后独立发送额外 `@codex review`，等新 head 审核和 CI。

语义澄清：本项保留 SimpleStreamOptions.maxTokens=2048 的原有 provider 解释。Google/Vertex 共享输出额度；Chat 测试的 wire cap 为 2048；非 adaptive Anthropic/Claude Bedrock 的已有实现会在基础回答额度上加 thinking，再受模型/上下文限制，不能宣称所有 provider 的最终 wire 总量都是 2048。本项不修改全局 token 语义。新增计算和最多一个预算对象都只发生在一次摘要请求入口，不改大历史/流式/终端路径。

初版生产改动在 GenerateBranchSummaryOptions 增加可选 ThinkingLevel、navigateTree 传入本次会话级别、requestOptions 条件附加 reasoning。review 修复增加 Google 共享额度的请求级预算调整，复用既有模型能力和预算函数；最多增加一个 request-owned thinkingBudgets 对象，既有 retry 复用同一对象。未新增模型白名单、重试、认证读取或高频回调。prepare/serialize、completeSummarization 和下游事件/终端代码均未改动，故本项没有宣称新的全链 allocation profile。

先行红灯证明 high 在旧分支摘要 stream options 中为 undefined；初版定向 **105/105** 通过（11 项新 branch-summary cases、现有 compaction 生命周期与 provider 能力矩阵）。真实 AgentSession tree summary 在 low → high 变化后分别继承新值；相同摘要的 transient retry 共享同一个 requestOptions 对象，调用方随后修改选项不改变该次快照。off/缺省/无推理模型保留原行为；真实 Chat adapter 夹具确认已有能力映射仍生效。摘要 options 与 Chat wire 的 maxTokens 均保持 2048，取消返回 aborted 并移除 listener。其他 provider 的额度语义见上述澄清。

测试过程中修正了两个 fixture 假设：conservativeModelCapabilities 返回冻结共享对象，测试先复制再提供显式能力；RetryPolicy 即使禁用也要求完整字段，补齐 maxRetries/baseDelayMs。未因此增加生产兜底。类型检查与离线构建通过；当前 Node26 全套 **405/405 执行单元成功，5429 tests / 5331 pass / 98 skip / 0 fail / 0 cancelled**。[证据记录](../evidence/pi-150-t07-branch-summary-thinking.json)包含源码 hash、行为计数及验证结果；原始日志在 .git/pi150-t07。最终 PR reviewer/CI 尚未验收。

Reviewer 修复已复现真实 output-reservation 红灯并完成：12 个 Google/Vertex case 覆盖固定/动态预算、能力级别映射、较小模型上限和无剩余推理空间；扩大后的定向 **119/119** 通过。修复版本 check/build:offline 通过，Node v26.13.0 全套 **405/405 执行单元成功，5441 tests / 5343 pass / 98 skip / 0 fail / 0 cancelled**。请求配置每摘要一次，单次成功捕获或明确失败均为 1 次 stream 调用，没有付费补偿重试。修复后将主动额外请求 Codex review，尚不把旧 head 的 CI 当新 head 验收。

## 交付结果

最终 head `1b2452c034fb89ddf8bc6f31035ff9a9f3b2f921` 的 Codex review completed、has_any_findings=false、has_unresolved_findings=false；修复后独立复审请求为 issuecomment-6614252775。CI 41709593698 六个分片全部成功，#189 合并为 `4e004f4af1b10f91e9137632608b9421c32ed728`，对应两端分支已删除，main 已同步。
