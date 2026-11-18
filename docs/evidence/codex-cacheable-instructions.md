# Codex Astra 与 Sol 的指令缓存

GPT-6.2 会将顶层 `instructions` 放在缓存断点之后。官方 Codex 路由的 Astra 和 Sol 在支持 developer 角色时将会话指令发送为首条 developer 消息，顶层保留简短默认指令。旧模型、自定义端点及显式关闭 developer 角色的配置继续使用顶层字段。[OpenAI 缓存指南](https://developers.openai.com/api/docs/guides/prompt-caching)

在线合成对照通过 Super Pi 的 ModelRuntime 分别调用两个模型。每组使用独立 session ID、相同的 320 行合成词表、三条简短请求及此前的回复。所有回复均为 READY，每轮输出 5 token。

| 模型 | 放置位置 | 首轮未命中 | 后两轮未命中 | 后两轮缓存读取 |
|---|---|---:|---:|---:|
| Astra | 顶层 | 3,552 | 3,567 / 3,582 | 0 / 0 |
| Astra | 首条 developer 消息 | 3,562 | 121 / 136 | 3,456 / 3,456 |
| Sol | 顶层 | 3,552 | 3,567 / 3,582 | 0 / 0 |
| Sol | 首条 developer 消息 | 3,562 | 121 / 136 | 3,456 / 3,456 |

Astra 在编译后的候选实现上复测得到相同用量。本次为单一合成负载，每个位置和模型各一条三轮对话。服务端路由、负载及真实指令长度会影响结果。

发送边界测试覆盖首次完整请求、WebSocket 增量、原生压缩、压缩后指令变化、原始端点兼容性。压缩历史保留当前请求的 developer 前缀；从旧会话恢复时使用当前会话生成的指令。运行 `node --import tsx --test tests/codex-request-body.test.ts tests/codex-transport-owner.test.ts tests/effective-dispatch.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts`。
