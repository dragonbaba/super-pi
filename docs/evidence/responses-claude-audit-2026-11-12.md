# Responses 请求体与 Claude 兼容审计（2026-11-12）

基线 `2a9471b242163f43f471c9c99903883994a3b96a`。问题：现有图片预算仅接入 Chat Completions；Responses/Codex 的真实上传、reasoning 回放及 Claude thinking 前缀需要分开确认。初始审计未改生产代码或个人模型配置，未向 OpenAI/DeepSeek 发送真实请求；用户授权的 Opus 5.5 中转探针仅使用合成短文本。

| 对照 | 实测结果 |
| --- | --- |
| 普通 Responses SDK，44 张合成 PNG | 最终 body 50,170,675 B，44 图、44 个 call/output 配对、store:false、无 previous_response_id；原生 onRequestBodyBytes 调用 0 次 |
| 手动组合现有投影/observer | 11,415,629 B，10 图，44 对工具关系保留；observer 1 次，等于实际 body。这只是提案可行性探针，SDK 尚未交付该接入 |
| reasoning 默认能力与显式正确能力 | 默认能力时，原始 plain reasoning item 在 serializer 中消失；探针显式打开 round-trip 后，与输入 item 深相等。包含该 item 的原始/投影 body 分别 50,170,781 / 11,415,735 B，原历史仍为 44 图 |
| 真实 parser→下一请求 serializer | 每组 2 个离线 SDK 请求；两组均收到 19 字符 thinking 并保存原始 reasoning item。默认能力下下一包 reasoning item 为 0，显式正确能力后为 1 且与原项相等；工具调用/结果配对两组均保留 |
| 内置 OpenAI 模型能力核实 | gpt-5.1 的 openai-responses 默认派生 thoughtSignatureRoundTrip=false；问题不只限于自定义 DeepSeek 模型。流解析器已有 reasoning_text.delta/content 支持，丢失发生在下一请求的历史转换 |
| Codex SSE 实际 fetch | 原 JSON 50,170,765 B，发送 zstd 后 8,923 B，onRequestBodyBytes 调用 0 次。图片重复且包含合成填充；该数字仅证明 JSON/wire 计量不同，不用于估计真实压缩比 |
| 用户授权 Opus 5.5 中转生成 | 原生 /v1/messages，145 B 合成文本请求，HTTP 503、JSON model_not_found/no available channel，无 Cloudflare challenge、无模型输出；重试设置 0。目录 GET 返回 200，列有目标模型，不能据此声称通道可用。工具、thinking、图片续接尚未执行 |

初始审计未触及热路径，未运行分配基准；实现阶段的性能证据单列如下，不能把 body 探针当作性能验收。

## R0：reasoning 回放

修复只补全默认能力派生中的 openai-responses、azure-openai-responses、openai-codex-responses；显式 manifest/enrichment 的 false 继续生效，不改跨 provider/API/model 的既有隔离。真实 parser→下一次实际 fetch 的 36 例覆盖加密空 thinking、DeepSeek 明文、assistant phase、工具配对、落盘重载、显式关闭和跨目标边界；另 3 例覆盖当前原始目录缓存、旧派生缓存迁移及显式 false。旧实现普通/Azure 默认回放 4 例先失败。

审计完整调用链：能力派生/目录恢复 → 模型 profile → provider parser 保存原 reasoning JSON → Agent/session 持有历史 → context 转换 → transformMessages → convertResponsesMessages → SDK 单次 serializer → fetch → 请求结束释放。现有 JSON.parse(reasoning item) 在保留回放后执行；不新增整包解析/序列化、循环闭包、Promise 尾链、数组或缓存，不引入对象池。source invariants 与生命周期/分配基准见复跑命令。

同机 32 条、每条约 2 KiB 合成 reasoning 的实际 SDK 请求，32 次：旧行为遗漏全部 reasoning，body 5,401 B；修复后保留 32 项，body 74,821 B。采样分配 172,284 → 376,055 B/请求，p50/p95 0.511/0.774 → 0.580/1.025 ms；新增开销主要为原 item JSON.parse、SDK serializer 与探针解析，属于恢复必需内容的成本，不宣称分配下降。没有新增整包副本或 per-delta 闭包/Promise/数组；四次 GC 后 6 个 context/history/message 跟踪对象全部释放，未新增长期 payload owner。

既有 Responses terminal、model capability matrix/authority、Codex SSE framing 回归 **61/61** 通过，diff whitespace 检查通过；这些通过不代表上述 reasoning 问题已修复，新探针已暴露它们尚未覆盖的多轮边界。

外部协议核实：[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)明确无状态，previous_response_id 不支持，明文 reasoning.content 可回放，unsupported 顶层参数忽略；[OpenAI 会话状态](https://developers.openai.com/api/docs/guides/conversation-state)支持完整历史与服务端续接两种不同方式；[Claude preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)要求对应模型保持历史前缀，旧 tool_result/图片改写可能导致签名失效。具体实施顺序与验收见[方案第 9 节](../codemode-batch-revision-image-budget-plan.md#9-responses-请求体与-claude-兼容补充审计2026-11-12待实现)。

探针位于任务临时目录，保留给本机复跑；源码路径固定在该目录内，不含 key 或私人会话。复跑先将子进程 TMP/TEMP/TMPDIR 指向任务根：

```powershell
node --experimental-strip-types .task-tmp/responses-claude-d3182d90/responses-wire.mjs
node .task-tmp/responses-claude-d3182d90/reasoning-replay.mjs
node --experimental-strip-types --test tests/provider-contract/responses-terminal-tool-calls.contract.test.ts tests/provider-contract/model-capability-matrix.contract.test.ts tests/provider-contract/model-capability-authority.contract.test.ts tests/provider-contract/codex-sse-framing.contract.test.ts
node --experimental-strip-types --test tests/provider-contract/responses-reasoning-replay.contract.test.ts
node --expose-gc --experimental-strip-types scripts/bench/responses-replay.ts
```

中转真实生成与目录脚本会从本机正常认证入口解析配置，不应复制配置或凭据到证据；生成脚本的后续步骤仅在基础调用成功后运行。Gemini 暂不测试，DeepSeek 的真实 Responses 集成与 Claude 签名/图片兼容仍未验证。
