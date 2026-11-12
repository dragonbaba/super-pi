# Responses 请求体与 Claude 兼容审计（2026-11-12）

基线 `2a9471b242163f43f471c9c99903883994a3b96a`。问题：现有图片预算仅接入 Chat Completions；Responses/Codex 的真实上传、reasoning 回放及 Claude thinking 前缀需要分开确认。初始审计未改生产代码或个人模型配置，未向 OpenAI/DeepSeek 发送真实请求；用户授权的 Opus 5.5 中转探针仅使用合成短文本。

下表保留初始基线观测；R0/R1/R2 的交付和 R3 最新复测单列于后文，不把旧的“未接入”描述作为当前实现状态。

| 对照 | 初始实测结果 |
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

## R1：普通/Azure 完整历史图片预算

接入 SDK 准备→presentation→图片投影→普通/Azure serializer→已有 fetch observer→AgentSession 一次缩小恢复；共用原先的有界 owner 与原生 UTF-8 计量。将原 Chat 的请求体错误结算提成共享函数，保留 SDK 包裹的准备失败及空正文 413 的真实分类；API/provider/model 不匹配时不恢复旧请求。预算数值沿用现有 8/4 MiB 策略，不增设命令/脚本解析限制或自动付费摘要；Codex 不进入此完整历史策略。

真实 session 60 例覆盖三种 adapter、presentation 开/关、实际 PNG 编码、加密 reasoning 与全部工具配对、6×2.2 MiB 当前批阻塞后新消息/纯文本工具继续、单次恢复、第二次失败、无缩减、普通连接错误、非视觉模型、blockImages、空正文 413、纯文本超限及 API 切换。相关 owner/source/摘要回归共 **114/114**，类型检查通过；普通/Azure 的 44 图首次 body 11,416,877 B→恢复 5,717,622 B，原 50,160,000 图片字符保持不变。8 MiB 纯文本在 compaction=true 时只上传一次、0 compaction；每次 assistant 结算后 requestViewBytes=0。

分配审计继续沿 R0 的 parser/session/context 链，并覆盖异步准备、缓存、projection、serializer、fetch observer、413 结算与清理。每个被观察的普通/Azure 请求边界增加 1 个与 Chat 相同的 fetch adapter 闭包；每个 provider delta、工具进度或终端帧新增闭包/Promise/AbortController/数组均 0。计量直接读取 SDK 的已有字符串，不增加整包副本。缓存上限及 clear/error/abort/代次规则沿用既有 owner，无新池或长期 body 引用。

8 次同机热请求基准（合成 44 图，包含 SDK/harness）：普通 Responses body 50,170,727→11,415,715 B，采样分配 100,667,912→23,132,699 B/请求，p50/p95 51.686/64.896→11.132/11.895 ms；Azure body 同值，分配 100,690,194→23,116,249 B/请求，p50/p95 52.029/65.462→11.019/11.679 ms。两者首次准备分别 382.440/387.341 ms、10 次编码，热编码 0，图片字节元数据 44 次；超限批恢复准备分别 0.239/0.220 ms，图片 13,841,208→9,227,472 B，后续 8 次新增字节扫描 0。各基准四次 GC 后 10 个跟踪对象全部释放，完成时 requestViewBytes=0。Chat 对照仍通过，p50/p95 10.914/12.303 ms。

外部协议核实：[DeepSeek Responses](https://api-docs.deepseek.com/guides/responses_api/)明确无状态，previous_response_id 不支持，明文 reasoning.content 可回放，unsupported 顶层参数忽略；[OpenAI 会话状态](https://developers.openai.com/api/docs/guides/conversation-state)支持完整历史与服务端续接两种不同方式；[Claude preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)要求对应模型保持历史前缀，旧 tool_result/图片改写可能导致签名失效。具体实施顺序与验收见[方案第 9 节](../codemode-batch-revision-image-budget-plan.md#9-responses-请求体与-claude-兼容补充审计2026-11-12分阶段实施)。

## R2：Codex 实际传输计量与超限结算

旧代码在 maxRetries=1 时，对空正文 413 及 request_too_large 都上传同包两次，onRequestBodyBytes 为 0 次；新测试先在旧代码复现。现于既有 SSE JSON/zstd 和 WS 完整/增量帧边界发出两个数字：实际 body/frame 字节、压缩前 JSON 字节。HTTP 413 一次停止；WS 1009 与普通断连分开，只有无输出、无 compaction 边界且最终 SSE 严格更小时允许回退，较大完整历史不替换被拒绝的小 delta。body 错误不自动付费摘要；一般网络/503 的有限重试保留。回调失败、取消、owner 重置均在发送前停止；未发出的 compaction 不消费 commitment。Codex 旧图淘汰、首次图准备尚未交付，不能保证大历史恢复。

完整审计链：SDK/model runtime → owner admission/代次 → body/onPayload → WS 前缀比较/full/delta → 单次 frame stringify → send → parser/terminal/commitment → fallback SSE 单次 stringify/zstd/fetch → compaction parity/dispatch → release/reset/dispose。诊断改用弱键数字元数据，不为诊断序列化完整历史；instructions 字节数改用原生 byteLength，不生成编码副本。每次发送仍需原有的最终序列化与前缀 hash；新增计量无 per-delta 闭包、Promise、AbortController、对象/数组或整包副本，无对象池。WS 帧局部变量在 await 响应前 finally 清空，错误元数据只含数字，不保留 payload。

传输/owner/compaction/source 回归 **164/164**；真实 session **61/61**，含 Codex 8 MiB 正文、compaction=true、空正文 413：1 次上传、0 compaction，JSON 与压缩 body 计量分别和真实 body 一致。类型检查通过。另先复现 HTTP 400/500 仅在 error.code 中报告 request_too_large、message 泛化时丢失分类且 500 重传；现保留原 code/type、在重试前识别，4 例均 1 次停止，不伪造 HTTP 413。错误正文复用首次读取字符串，不再构造临时 Response 重读。WS 失败计数与 fallback 激活分离；拒绝较大回退后，下次小请求仍实际走 WS。发送前取消保留仍有效的连接/continuation，compaction 可用新 signal 重试；已经发送、连接关闭或 owner 失效仍清理。测试覆盖 Unicode、SSE 压缩/不压缩、WS full/delta、缺 ID 重建、普通断连、输出开始后关闭、post-compaction、回调失败/取消/重置；原始历史和旧签名不改。

同机 16 组/32 请求每模式，数值为关闭→开启数字回调（含现有 serializer/hash、离线传输及探针分配）：未压缩 SSE 采样 4,329,084→4,321,194 B/请求，成对 p50/p95 5.975/7.212→5.834/6.807 ms；zstd SSE 4,350,567→4,344,884 B/请求，12.003/12.953→11.816/13.396 ms；WS 3,299,243→3,288,067 B/请求，4.533/5.096→4.397/5.050 ms。这只计量回调成本，不宣称较旧版本减少全部分配。主分配站点为既有 sha256Json、JSON serializer、WS prefix 比较；峰值堆分别 42.4→54.7、56.2→58.3、58.8→55.8 MB，单次采样波动不当成泄漏结论。合成 JSON 524,665 B、zstd body 270,067 B；WS 首帧 524,690 B→增量 343 B。每次尝试计量 1 次；四次 GC 后 36/36 跟踪 owner/context/payload/error 释放，正常/失败/取消 dispose 的所有诊断计数和残余监听器为 0。

## R3：中转 Opus 5.5 基础调用复测

按授权复测配置中的 superapi-claude/claude-opus-5-5，使用正常 ModelRuntime 认证入口，未修改个人配置。仅一次原生 `/v1/messages` 请求：145 B 合成纯文本 JSON、thinking disabled、maxTokens=128、maxRetries=0。最新返回 HTTP 403、application/json、new_api_error，原因是当前凭据无权访问所选上游分组；没有 Cloudflare challenge，没有模型输出。此前 503/model_not_found 是初始审计的历史观测，不能沿用为最新状态。证据不包含私人分组、request ID 或凭据。

探针在基础调用失败处停止，未发送后续工具、thinking 或图片请求。Claude 的签名保留、未改前缀续接、旧 tool_result/图片改写负例均尚未验证；未实施 Anthropic 历史投影，也未替换模型、凭据或分组冒充通过。上游授权恢复后，按方案 R3 的相同 system/tools/历史与显式 prefix_mismatch_behavior 对照继续；Gemini 继续暂停真实测试。本项仅更新复测证据和文档，未触及热路径，跳过新增分配基准。

探针位于任务临时目录，保留给本机复跑；源码路径固定在该目录内，不含 key 或私人会话。复跑先将子进程 TMP/TEMP/TMPDIR 指向任务根：

```powershell
node --experimental-strip-types .task-tmp/responses-claude-d3182d90/responses-wire.mjs
node .task-tmp/responses-claude-d3182d90/reasoning-replay.mjs
node --experimental-strip-types --test tests/provider-contract/responses-terminal-tool-calls.contract.test.ts tests/provider-contract/model-capability-matrix.contract.test.ts tests/provider-contract/model-capability-authority.contract.test.ts tests/provider-contract/codex-sse-framing.contract.test.ts
node --experimental-strip-types --test tests/provider-contract/responses-reasoning-replay.contract.test.ts
node --expose-gc --experimental-strip-types scripts/bench/responses-replay.ts
node --expose-gc --experimental-strip-types --test tests/request-image-budget-session.test.ts tests/request-image-budget.test.ts tests/request-image-budget-hot-paths.test.ts tests/request-image-summary.test.ts tests/source-invariants.test.ts
node --expose-gc --experimental-strip-types scripts/bench/request-image-budget.ts --responses
node --expose-gc --experimental-strip-types scripts/bench/request-image-budget.ts --azure
node --experimental-strip-types --test tests/codex-request-body.test.ts tests/codex-transport-owner.test.ts tests/openai-codex-callback.test.ts tests/provider-contract/codex-sse-framing.contract.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts tests/request-body-observer.test.ts tests/request-image-budget-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/codex-request-body.ts
```

中转真实生成与目录脚本会从本机正常认证入口解析配置，不应复制配置或凭据到证据；生成脚本的后续步骤仅在基础调用成功后运行。Gemini 暂不测试，DeepSeek 的真实 Responses 集成与 Claude 签名/图片兼容仍未验证。
