# 连接失败的重试预算与原因显示（2026-11-10）

## 问题

一次 5 分钟的会话里出现 7 次模型请求失败：6 次 `fetch failed`，1 次 `upstream connect error or disconnect/reset before headers. reset reason: connection timeout`。其中两次连续发生，自动重试显示到 2/3。

- 会话中 6 次 `fetch failed` 的耗时为 5,006–5,037 ms，旧消息均未保存底层 `cause`。当前有效 HTTP 空闲超时为 300,000 ms，未设置独立 provider 超时；Codex SSE 路径使用该超时，undici 的连接超时默认是 10 秒。现有证据不能确定原故障来自哪个连接节点，不能把“代理或网关”写成已查明的根因。
- 默认 3 次重试只包含 2、4、8 秒共 14 秒退避，不含请求耗时。用户已确认应用层默认改为 6 次。

## 修复

不涉及热路径：只在请求失败后执行。

- `normalizeProviderError`：`fetch failed` 后追加 `cause` 的错误码（如 `fetch failed (ECONNRESET)`），没有错误码时追加原因文本的前 200 个字符。重试判定仍然匹配。
- 普通对话、压缩和分支摘要共用 `retryDelayMs`，默认 6 次重试（首次调用加重试共最多 7 轮）。单次退避上限 30 秒：2、4、8、16、30、30 秒，累计 90 秒，不含请求耗时。显式 `maxRetries` 仍生效；显式 `baseDelayMs` 仍作为指数退避基数，但同样受 30 秒上限约束。没有改变 provider 内部重试策略。
- 配置 JSON Schema 同步默认次数和退避说明，编辑器补全不再建议旧的 3 次默认值。

## 验证

`tests/provider-retry-policy.test.ts` 共 19 项通过，覆盖错误码、原因文本、无原因、默认次数、六次等待序列、7 次调用上限和取消监听释放。摘要路径原先实际等待 `[2,4,8,16,32,64]` 秒，回归测试先失败，修复后为 `[2,4,8,16,30,30]`；用模拟时钟验证，没有实际等待 90 秒。普通会话的 `mistral-transient-retry` 回归亦通过。

本地 HTTP 对照使用真实 Codex SSE 流和应用 HTTP dispatcher：服务端在第 5 秒断开时，5,026 ms 返回 `fetch failed (UND_ERR_SOCKET)`；正常服务端延迟 6 秒，6,023 ms 成功完成。证明本次配置下没有隐含 5 秒截止，且错误原因能保留到最终消息。原上游故障没有复现，实际恢复率没有测量；旧日志缺失的原因无法事后恢复。

## 重跑

```powershell
node --experimental-strip-types --test tests/provider-retry-policy.test.ts
```
