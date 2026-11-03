# 分支摘要配置 / Branch summaries

在会话树中离开一个分支并选择生成摘要时，Super Pi 使用当前模型及推理级别保留该分支的工作上下文。全局 `~/.sp/agent/config/settings.json` 或受信任项目的 `.sp/config/settings.json` 可设置：

```json
{
  "branchSummary": {
    "maxTokens": 4096,
    "reserveTokens": 16384,
    "skipPrompt": false
  }
}
```

`maxTokens` 是传给 provider 的摘要输出额度，未设置时为 **2048**。显式值必须是正安全整数，并受已知模型输出上限约束。增大该值可能增加费用；不会因为一次摘要达到 length 上限而自动增加额度、再次付费请求。

它不是可见文字长度或跨 provider 的统一总 token 硬限制。Google/Vertex 将 thinking 与回答计入共享额度；摘要会将固定 thinking 预算限制在保留可用回答空间后的额度内。动态 thinking 仍由 provider 决定。非 adaptive Anthropic/Claude Bedrock 的既有实现会在基础回答额度上增加 thinking，最终仍受模型和上下文限制。

`reserveTokens` 控制从历史输入中预留多少空间给提示与输出，默认 **16384**。它不等于 `maxTokens`；设置更大输出时，应同时留出足够的历史输入预留空间。provider 的上下文预算还可能降低实际输出额度，或在空间不足时明确报错。

`skipPrompt: true` 跳过“是否生成摘要”的询问，并默认不生成摘要。它不更改摘要输出额度。

空白、只有推理而没有可见文字、未完成或失败的摘要不会写入新的分支摘要记录，也不会把固定说明前缀当作成功结果。已有暂时性网络错误重试设置仍按原语义生效。直接 SDK 调用 `generateBranchSummary` 可通过同名 `maxTokens` 选项设置输出额度。

## English

When leaving a conversation branch with summarization enabled, Super Pi uses the current model and thinking level. The JSON example above works in global settings or a trusted project's settings.

- `branchSummary.maxTokens` defaults to **2048**. It accepts a positive safe integer, bounded by a known model output limit. Raising it may increase cost. A length-limited summary does not automatically trigger a larger paid request.
- This is the provider output allowance, not a visible-text length or a universal total-token cap. Google/Vertex share the allowance between thinking and the answer; fixed thinking budgets are fitted inside it while reserving answer space. Dynamic thinking remains provider-controlled. Existing non-adaptive Anthropic/Claude Bedrock behavior can add thinking to the base allowance, subject to model and context limits.
- `reserveTokens` defaults to **16384** and reserves input-context space for the prompt and response. It is separate from the output allowance. Leave enough reserve when selecting a larger output; provider context limits can still reduce or reject the request.
- `skipPrompt: true` skips the summary question and defaults to no summary.

Empty, whitespace-only, thinking-only, incomplete or failed results do not create a branch-summary checkpoint. Existing transient-error retries retain their current behavior. SDK callers can set `GenerateBranchSummaryOptions.maxTokens` directly.
