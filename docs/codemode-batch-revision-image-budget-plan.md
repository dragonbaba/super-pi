# CodeMode 批量、文件修订与多图请求预算修改方案

实施记录：A [PR #289](https://github.com/dragonbaba/super-pi/pull/289)、B [PR #290](https://github.com/dragonbaba/super-pi/pull/290)、C [PR #291](https://github.com/dragonbaba/super-pi/pull/291)；交付状态以各 PR 的当前提交审查、CI 与合并结果为准，[验收证据](evidence/codemode-batch-image-2026-11-12.md)记录实测范围。D 仅评估（2026-11-12）。初始源码基线 `main` = `1b8f5de167512ac716edc2cd19e8c129f4872b64`。

A、B、C 三个 PR 均已合并；本文保留方案决策和验收标准，并明确尚存缺口。A 的行为与设置见[请求图片预算](request-image-budget.md)。单图默认保留 2000×2000/4.5 MiB 与 PNG；1568/600 KiB 仅为显式可配的紧缩视图。以下按原实施顺序 A → B → C 编排，C 的提示与已交付的 B 一致。

### 交付后核验与未完成项（2026-11-12）

- 已确认单批 6×约 2.2 MiB 超过 12 MiB 后持续阻塞的缺陷：旧实现永久保护最后一个含图批次。补充修正把保护限定为尚待模型接收的当前工具批；后续模型消息或新的用户提交后，该批按历史偏移淘汰。首次仍无法容纳时明确告知“发送新文本继续但部分历史图会省略”或显式调预算，不重放工具。实际 session/serializer 回归和计量见[补充证据](evidence/image-budget-followup-2026-11-12.md)。
- **跨协议预算仍未交付。** SDK 准备、投影、body 观察和自动图片恢复都只接入 full-history `openai-completions`。Anthropic、Google、Responses/Codex Responses 仍可能遇到原有 413；不能用本轮修正宣称已解决。后续须逐 adapter 验证签名/历史连续性、实际序列化字节、首次旧会话恢复、追加调用和一次更小的恢复请求；不得通过删除 thinking、失效远端状态或扩大限制来绕过。
- **真实模型批量行为仍未验证。** 原证据的 +714 字符是提示成本，不是批量比例。按用户选择暂不调用真实模型；可重复对照步骤见[真实模型测量方案](#真实模型批量对照待执行)。D 仍仅评估，不算已交付自动去重。
- A 验收 5 补充实际默认摘要 serializer 用例：图片块/base64 不进入摘要，单条工具正文沿用已有 2000 字符截断。用户正文、思考和总摘要输入没有统一字节硬上限；合成 16 MiB 用户正文的 413 明确失败，两层重试均不重发，不提交摘要。这是有限失败处理，**不表示任意文本都能自动压缩成功**。
- A 验收 3 补充棋盘、细字、透明斜边和渐变的合成像素对照。默认限内及 autoResize=false 保留原字节；紧缩 PNG 保留格式/alpha，但棋盘与细字明显改变，细字为满足 600 KiB 进一步缩到 1176×78。该证据支持继续保留兼容默认；真实 HD-2D/照片的主观质量验收仍待进行，不能把合成对照当作通过。
- UTF-8 body 计量已核对 Node/Bun 与浏览器入口：Node/Bun 使用 `Buffer.byteLength`，浏览器无 Buffer 时保留无整包分配的扫描后备；不静态导入 Node 模块，不再在 Node 上逐字符扫描 11 MiB 请求。

## 1. 核实结果与证据边界

### 1.1 会话聚合复核

对反馈指定的会话只做本地聚合，不在仓库记录真实项目目录、会话路径、提示、脚本或图片。测试使用合成数据。

| 项目 | 本轮核实结果 |
| --- | --- |
| CodeMode 调用 | 170 次 |
| 历史图片 | 44 张，均为工具结果中的 PNG；用户消息图片为 0 |
| 图片 base64 | 50,111,832 个字符；base64 是 ASCII，此处字符数等于编码后的字节数，不是解码文件大小 |
| 会话文件 | 51,957,836 字节；仅图片 base64 已占约 96.4% |
| 含 REVISION_REQUIRED 的工具结果 | 14 条 |
| 请求体错误 | 1 条 `413 Failed to buffer the request body: length limit exceeded`；它之前紧邻 1 条 `Connection error.`（同样零 usage），两条之间没有新的工具结果 |
| 最近成功响应的输入统计 | usage.input=827，另有 cacheRead=207872；不能只用 input 字段判断整个上下文大小 |

“约 110 分钟、125 次单子调用、64 次单文本读取、16 段连续单读、9 次未变区间重读共 258 行”仍是 Claude 的分析结果，本轮未逐段重新归因，不作为已复现的验收数字。配置的百万 token 窗口也不等于 HTTP 上传容量。

原稿按会话增长估计请求由约 42 MB 增至约 51 MB，这不是实际 HTTP body 的测量。不能断言“DeepSeek 的上限在 42–51 MB 之间”：拒绝可能来自兼容接口前的网关，消息转换、schema、图片前缀和 JSON 开销尚未计入。只确认请求体超限，不探测远端极限。

### 1.2 源码核对

以下 coding-agent 路径相对于 `packages/coding-agent/src/`，实施定位用函数名而非易漂移的行号。

| 事实 | 当前实现与修正含义 |
| --- | --- |
| 单图处理 | utils/image-resize-core.ts 默认 2000×2000、base64 4.5 MiB；尺寸和字节都符合时保留原表示。不透明 PNG 可能转 JPEG，透明图不转 JPEG，缩放用 Lanczos3。只改数值不能保证像素细节。 |
| 图片入口 | 原生 read、MXC 的 WorkspaceSandboxTools.readImage、附件、MCP/扩展结果、CodeMode image/show 均需核对。normalizeToolResultImages 位于结果 hook 后，处理失败可能保留原图，并非硬预算。 |
| 请求投影可选 | sdk.ts:convertToLlmWithBlockImages 调用 AgentSession.projectToolResultMessagesForModel；无 presentation owner 时后者直接返回。不能让图片预算依赖可选正文投影或 budgetTokens。 |
| 413 分类 | packages/ai/src/utils/overflow.ts 已将 request_too_large 混入 context overflow，但不匹配本次完整错误；需独立字节分类，并保留既有 provider 对照。 |
| 默认摘要 | compaction/utils.ts:serializeConversation 取文本，compaction.ts 构造纯文本 user 消息，不附带图片块。不能再列为完全未核实；仍需 serializer 对照，文本本身也可能过大。 |
| 原生修订 | files/file-service.ts 变更后作废路径修订，snapshot-line-edit.ts 提交后还 forget 旧 ID；结果日志失败可将已提交操作改判 partial。新修订须等最终回执确定。 |
| 精确文本与行锚 | files/revision-mutations.ts:prepareRevisionMutation 校验整文件版本并做精确唯一匹配，不依赖可见行区间；行锚依赖 firstSeenLine/lastSeenLine。版本已知不等于新锚已展示。 |
| MXC 不同 | sandbox/workspace-tools.ts 的 edit 必填 SHA-256 snapshot，write 的 snapshot 可选：mxc-file-worker.mjs 要求新建文件不带 snapshot、覆盖已有文件必须带且与当前字节哈希一致。worker 只在 read 时填 reply.snapshot，mutate 成功目前不返回新 snapshot。仅改 FileRevisions 无法让 MXC 连续编辑免补读。 |
| allSettled 已可用 | 真实 CodemodeSandbox 探针返回 fulfilled/rejected/fulfilled，scriptOk=true，runtime calls 为 ok/error/ok；关闭后活动执行归零、worker 1 启动/1 退出。待改的是父调用判定。 |
| 多层失败状态 | core/codemode.ts 的 invocation.failed、result.ok、result.calls，加上 packages/agent/src/nested-tool-dispatch.ts 的 hasErrors 共同决定父失败；store 还经过 afterToolCall/finalizeStore。不能只改摘要。 |

CodeMode 源文件是 `core/codemode.ts`，不是 `core/tools/codemode.ts`。

### 1.3 外部参考的可证实范围

- Claude 视觉规则按模型分档，包含长边和视觉 token 限制；1568 不是通用边界。服务端缩图不代表上传前字节已经缩小，600 KiB 也不是由这些资料得出的客户端统一值。[Claude Vision](https://platform.claude.com/docs/en/build-with-claude/vision)
- Claude Code 官方说明可支持 agent loop/上下文管理的参考；本轮未证实其“固定压到 600 KB”或与本方案相同的父调用/store 语义。[How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- OpenAI 官方确认 Codex 的 view_image 将本地图片附到上下文，视觉处理因模型和 detail 而异；本轮未证实 Codex CLI 一律缩到固定边界或按本方案清理历史图。API 规则不等于客户端实现。[Codex 工具说明](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.3-codex)、[OpenAI Images and vision](https://developers.openai.com/api/docs/guides/images-vision)
- 官方 Programmatic Tool Calling 支持程序并行编排与结果处理，不规定本仓库的 isError、store 和拒绝处理策略。C 是本产品的明确变更。[OpenAI Programmatic Tool Calling](https://developers.openai.com/api/docs/guides/tools-programmatic-tool-calling)
- 部分 Claude 模型校验 thinking 的历史前缀，重编码旧图或改写旧 tool_result 会使后续 thinking 失效；官方建议使用匹配的服务端 context editing/compaction。不能无条件跨 provider 客户端清图。[Preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)、[Context editing](https://platform.claude.com/docs/en/build-with-claude/context-editing)

删除“两个产品能带更多图只因图片小和旧图退场，而非上限更高”的因果断言。客户端、模型和接口限制不同，方案以自己的计量和验收为依据。

## 2. 目标及不变边界

1. 在兼容链路控制历史工具图上传体积，旧会话恢复同样生效；服务端仍报请求体过大时，最多一次有实际缩减的恢复尝试。
2. 自己干净提交的 edit/write 可延续精确文本版本，覆盖原生文件服务和 MXC，保留身份、哈希、权限与生命周期校验。
3. 普通子失败经正常处理后不抹去其他结果；顺序依赖链的未捕获失败仍结束脚本。成功副作用不回滚、不自动重放。
4. 改善批量及读取指引，保留单调用、shell 和合法 JavaScript。不得新增严格命令解析、命令白名单、最低调用数、强制批量或额外审批。

## 3. A：图片预算与请求体恢复（P0）

### A1. 原记录、请求图片表示与配置

位置：utils/image-process.ts、image-resize-core.ts、tool-result-images.ts，read/附件/MXC 入口及请求准备链路。

- 1568 长边与 **600 KiB base64 数据**只是待测候选，不是已验证默认值、API 上限或原图文件 600 KiB。600 KiB base64 对应解码数据约 450 KiB；常量、设置和指标写清单位。
- 紧缩表示用于模型请求；新图可在首次发送前准备一次衍生图，不能把唯一可恢复的历史图片覆盖为有损版本。保留现有历史/附件恢复方式，不增加第二份无界全图存储；旧会话只投影，不重写 JSONL。旧图先前已被有损处理的细节无法还原，不承诺从历史恢复不存在的原图。
- 泛型 MCP 图片未必有磁盘原图。只在有可信来源时附路径、原尺寸、衍生尺寸和变换说明。core/codemode-images.ts 已有有界私有 manifest，但保存可失败、临时文件可失效，不能承诺永久可 read。
- 尊重 images.autoResize=false，不得偷偷开启有损缩放。PNG/像素检查默认避免新增 JPEG 损失；缩放本身也改变像素。原图/无缩放模式须可用，无法在预算内保留细节时明确说明，不能声称完成原始像素检查。裁剪参数不在本轮范围。
- 现有编码器会为不透明 PNG 选择更小的 JPEG，因此“算法完全不改，只传更小限制”不足以满足上述要求。显式约束编码策略，透明 PNG 不丢 alpha；对像素棋盘、细字、HD-2D 边缘和普通渲染图验收。
- read 已处理的图不能在 afterToolCall 再无条件处理一次。按原图片身份及策略代次复用衍生图，定义缓存字节上限、淘汰、释放；模型/设置变化从原表示推导，禁止反复 JPEG 转码。

本地 models-store 聚合为 55 个模型，其中 9 个带 inputLimits.images.resize，键为 maxWidth/maxHeight/maxBytes/jpegQuality；并非每个模型都有。packages/scripts/tests/.sp 源码搜索没有该字段的直接读写方。models-store.json 是可刷新的 provider 目录缓存，raw 模型透传会留下未知字段；字段存在不证明是有效用户设置，最初来源尚未证实。

**更正默认决定：不直接接通缓存字段作为权威配置。** 在现有 images 设置/宿主策略处设计有类型、可说明的覆盖入口；如按模型覆盖，区分 API/provider 技术要求与用户策略，写清优先级。旧字段默认无效，不宣称已支持。确认真实写入方后才做精确迁移/退役，不要求删除未找到的写入方，不扫描或重写用户模型缓存。

### A2. 请求投影与有界计量

链路：packages/agent/src/agent-loop.ts 的 transformContext/convertToLlm → sdk.ts:convertToLlmWithBlockImages → 图片策略及正文投影 → provider 转换/序列化。Agent loop 已 await convertToLlm；需要异步编码时使用已有异步准备边界，不在同步逐块回调中阻塞解码。

- 图片预算独立于可选 presentation owner 和 budgetTokens。保留 blockImages 优先级，已屏蔽图片不解码；明确与正文 token 投影的顺序，防止双重处理或续读源绑定失真。
- 请求计量涵盖用户图、工具图及 provider 包装；默认只回收工具历史图。用户图不静默删除，但计入总上传量。因此“工具图 <= B”不是“整个请求 <= B”；正文、schema、URI 前缀、JSON 等也占字节。
- 在既有 serializer 边界量实际 UTF-8 body，日志只记数字，不另做整段 JSON.stringify，不复制或输出图片、正文及凭据。

**修正分步淘汰算法。** 同一分支/策略代次中，第 i 张工具图权重为 wi，累计区间 `[si, ei)`，T=sum(wi)。KEEP/STEP 暂取 8 MiB/4 MiB，硬工具图预算 B=KEEP+STEP，单位均为 base64 字节：

```text
cutoff = max(0, floor((T - KEEP) / STEP) * STEP)
保留 si >= cutoff 的完整图片；si < cutoff 的图片省略，包括跨界图片。
```

原稿只淘汰 ei<=cutoff 的图，会留下跨界图：两张各 7 MiB，T=14、cutoff=4，仍保留 14 MiB，超过 12 MiB。本轮合成反例已确认。改用起始偏移后，保留权重不超过 T-cutoff，严格小于 B，上界成立；跨界图可能被省略，不能保证保留量一定不少于 KEEP。图片按从旧到新排列。最新一张只要大于 KEEP 就可能落在 cutoff 之前，不必超过 B：T=16.2 MiB、最新图 8.3 MiB 时 si=7.9、cutoff=8，这张刚产生的图会被省略。因此下面“边界跨过本次图片”的收敛规则是常规路径，不是只在超 B 时才触发的边角情况。

- wi 等于最终图片表示的 base64 字节，或其已验证上界，不能用解码大小。可以按原表示长度保守选取，但须证明衍生图不更大；重编码增大时重新计量、收敛后发送。旧图先按已知长度选取，省略图不先全部解码。
- 当前尚待查看的工具批超 B、单图超 B、边界跨过本次图片时，按显式质量/缩放策略收敛或报告不足；不无条件保留而突破预算，也不静默省掉需要检查的图后声称成功。保护不是永久绑定最后一个含图批：后续模型消息或用户新提交会使旧批成为历史，后续纯文本工具批不再保护它。
- 占位文本注明本次请求省略、toolCallId/图片序号、可信来源及恢复限制。历史仍有原图不等于有公开 read 路径；不自动重放产生图片的工具。
- 表示、顺序和权重稳定时 cutoff 只在跨 STEP 时前进；只承诺本投影稳定性，不保证整个请求前缀不变。切模型/设置/分支、压缩、恢复模式均重建策略代次。
- 首次旧会话初始化允许一次受测量的扫描；追加请求处理增量元数据，缓存有界。正常、异常、取消、切分支、关闭释放引用；不为累计长度逐图创建对象、闭包、Promise 链或图片副本。

**provider 兼容不能省略。** 首先覆盖复现的 full-history openai-completions。Anthropic preserved thinking、Google thought signature、Responses previous_response_id/增量历史需真实 adapter 形状对照，不能改旧图后沿用失效签名或远端状态。服务端 context editing 可供兼容 provider 使用，但不会缩小已经上传的 body，不能冒充上传恢复。未证明安全的协议不直接启用破坏前缀的投影，不靠静默丢弃 thinking 或新增命令限制规避；明确标记兼容范围未交付及可用恢复方式。

### A3. 字节超限分类与有限恢复

- 新增独立分类，优先实际可取得的 HTTP status/错误类型；只剩 errorMessage 时先核实信息在哪层丢失。413、明确 request_too_large 或本次 buffering 错误是证据；仅出现 request body、length、too large 不够。限流、认证、格式错误、普通工具输出及 token overflow 均有反例。
- 审计 overflow.ts 已有 request_too_large、Cerebras 无正文 400/413 例外，不直接删模式而破坏旧恢复；字节/上下文分类有明确优先级，避免双重重试。
- 复现会话里 413 之前先出现一条 `Connection error.`。超大请求体可能先表现为连接错误，再由通用重试（provider-retry.ts 及 agent-session 的 retry 设置）整份重新上传。`Connection error.` 本身不能判为字节超限；需核对通用重试是否会对同一份超大 body 重复上传，并用 A2 的发送前预算避免走到这一步，重试次数与耗时列入证据。
- 请求体恢复独立于 compaction.enabled，不能放在 _checkCompaction 的关闭设置早退后；遵守取消、同一模型/分支、当前请求归属与生命周期。
- 最多一次恢复：新的策略代次进一步缩小图片预算/表示，确认**实际请求比失败请求更小**才重试 LLM。已只剩最新一组或该组本身超限时也须收敛；不原样重发，不重放工具及成功副作用。流式响应若已产生工具执行记录，先核实归属与结算，不能当作完全未执行的请求重试。
- _overflowRecoveryAttempted 属于 token 压缩流程，只参考防重入方式；按当前用户提交维护有限状态，约束与通用重试/token 恢复的组合，不能交替重置而无限重试。
- 无可缩图片、正文主导、用户原图必须保留或协议不允许安全改写时，停止图片自动恢复并说明原因；摘要须符合既有设置/授权，不因任意 413 自动触发付费摘要。
- 再失败时保留会话和已执行结果，提示压缩、减少本次图、调整明确策略或新会话等实际选项；不保证所有旧会话无条件恢复。

### A 的验收

1. 新图与约 50 MB base64 的旧历史经真实请求转换验证；presentation 开/关、budgetTokens 未配置、blockImages 开/关均覆盖。JSONL 不变，用户图计量但不静默回收。
2. 覆盖两张 7 MiB、精确 STEP 边界、跨界图、单图/最新组超限、透明图、空历史；最终工具图满足 B，body 另量，未跨边界时图片前缀稳定。
3. PNG 像素图、细字、HD-2D 与照片对照原图/衍生图；覆盖 autoResize=false、alpha、质量说明、编码失败、来源未知/失效。1568/600 KiB 未过质量验收不定为生产默认。
4. 模拟本次 413，最多一次实际缩减后的重试；二次 413、429、认证、body 格式错、无图大文本、取消、compaction 关闭均验证，无工具重放。
5. 默认摘要经 serializer 验证无图片 base64；已有单条工具正文截断有效，总文本过大时 413 明确失败且不循环、不提交半成品摘要。总输入字节预算/多段摘要未交付，不能只靠固定图片 token 估算证明可发送。
6. 签名/增量 provider 矩阵逐项声明通过或未支持，不能只测 mock/full-history 就宣称跨 provider 交付。

## 4. B：自己提交后的精确文本版本延续（P0）

### B1. 原生文件服务

位置：files/file-service.ts、snapshot-line-edit.ts、revision-mutations.ts、file-commit.ts、session-files.ts。

- edit/write 最终干净成功后，用已提交的有界 UTF-8 字节签发新整文件修订，旧 ID 仍失效；新建文件同样适用。延续版本不等于展示新行锚，行锚继续使用相应读取版本及可见范围。
- 条件至少为最终 ok、status=succeeded、stateChanged=true、commit.outcome=committed（适用时），无 requiresVerification/retainedTemporary，结果日志和提交后回调成功，同一 session/generation 有效。outcome 是嵌套字段，不误读为顶层。
- 使用原始 commit receipt 的 publication identity，再稳定核对当前目标身份及候选 sha256，不只信任可复制的 details 或路径存在；新建路径使用创建流程的原始身份凭证，不伪造 commit 回执。原子替换会改变 inode，不要求新身份等于旧身份。后续外部变化仍由 readSnapshotSource、prepare 和 commit 校验拦截。
- 通过内部交接把候选字节、身份、代次交给 FileRevisions，避免整文件字符串副本或 Buffer 进入工具 details；所有退出路径释放引用。
- 日志/回调失败、提交不确定、临时文件残留、取消/权限暂停/会话切换不延续；后续失败撤销过早建立的候选。缓存不足/文件超范围只报告无法延续，不把已成功提交伪装成可安全重试的失败。
- 精确文本不依赖 firstSeenLine/lastSeenLine；复用回执类型也不能虚构模型看过全部新行。沿用单文件 2 MiB、128 份/8 MiB 容量和淘汰，不扩展大文件能力。

### B2. MXC 单独覆盖

- MXC 不使用 FileRevisions：worker 成功写入/替换后验证并返回新 SHA-256，backend 校验，WorkspaceSandboxTools 暴露为 details.snapshot。
- 模型用刚完成修改的 details.snapshot 继续 edit/write，无需补读。保留显式 snapshot 参数及提交前哈希/身份校验，不移除校验，不严格解析 shell 变更。
- 新文件也返回可续用的 snapshot；原生修订 ID 与 MXC hash 不混用。MXC 错误/回执不同，测试不全部强行断言原生 SNAPSHOT_EDIT_STALE。
- MXC 跨调用仍按内容 hash 表示版本，不新增必填身份 token。同内容的外部替换沿用现有语义，不强行升级为原生回执的跨调用身份规则；本次修改过程中的 pinned identity/内容变化仍按原校验拒绝。
- 不改 file_batch 事务语义：部分成功逐项报告、已成功项不回滚、失败/不确定项不延续；批次及同路径互斥保持现状。

### B 的提示与验收

同步 session-files 和 MXC 工具说明：自己干净成功后使用有效新版本继续；外部变更、冲突、淘汰或未获延续时读取确切目标。行锚需要相应新锚；read 可在同一脚本接 edit，不强制额外模型轮次。

- 原生/MXC 各测 read→edit→edit→edit、write 新文件→edit，无补读；覆盖不同区域及多项 edits[]。
- 已过期的 ID/hash 被拒绝；内容变化、journal/afterCommit 失败、残留临时文件、取消/切分支/关闭、大文件/淘汰均无错误延续。原生另测同内容替换导致身份变化；MXC 按 B2 的现有 hash 语义验收，不新增限制。
- 行锚与精确文本的可见范围分开验收，旧锚不能对新版本静默成功；缓存失败不重放成功修改。
- 覆盖 native-file-service、codemode-session、snapshot/revision 和实际 MXC fixture/live，不能只修改断言文字。

## 5. C：已处理失败、批量及读取指引（P1）

### C1. 状态语义

| 情形 | 目标 |
| --- | --- |
| 普通子失败，未捕获 | 脚本失败，保留已完成结果/副作用，不提交新 store 写入 |
| try/catch、allSettled 或 allowFailure 正常处理普通失败，脚本正常结束 | 父完成、isError=false，列出失败及计数，成功结果可展示；store 在最终结果观察成功后提交 |
| 观察/记录失败、取消、超时、生命周期失效、既有必须暂停的权限边界 | 不因捕获/正常返回洗成部分成功，保留原控制效果 |
| 未 await/丢弃 Promise，或结束时仍有子调用 | 维持 owner 结算/取消和失败规则，不能只因顶层正常返回就当作已处理 |

- 贯通 core/codemode.ts、nested-tool-dispatch、runtime result.calls 和 store finalization。先用真实 VM/agent 证明已处理失败如何识别，不扫描源码 try/catch、不禁止合法 Promise 写法、不强制 allowFailure，不用新增 Promise monkey patch 代替运行语义。
- allSettled 已可用，但仍需对照跨 VM 的实际调用身份/拒绝处理；未 await、catch 后重抛、Promise.all 提前拒绝、finally 发出调用和宿主观察失败都要测试，不能直接清零所有 sticky failed 标志。
- 复用已有 details.codemode.handledFailures/calls，补齐 succeeded/failed/unhandled 或等价结构化状态，按调用身份去重；不漏执行前失败，不重复计 runtime call 和 nested fact，保留旧字段兼容。
- allowFailure 继续返回真实的子结果 isError，不改成抛出或伪装子成功；正常处理后的父完成和 store 提交语义保持。统一使用 PARTIAL 展示属于明确的摘要/UI 变更，应同步文档及相应断言。
- 已处理失败可用 [CODEMODE_PARTIAL]；成功子调用为 0 时写“脚本完成，包含已处理失败”，不得宣称任务成功。逐项原因、真实状态及副作用始终可见。
- 守卫/TUI 读实际子结果/结构化计数；父成功不清空子失败历史，也不通过新计数把所有正常处理的父调用又统一判错。既有重复失败、取消、权限控制保持职责，不新增限制。
- store 不在脚本结束时提前提交，保留 afterToolCall、结果 hook、观察失败、分支代次和 finalizeStore 最终确认。

C 实现已替换 [recovery repair plan](codemode-recovery-repair-plan.md) 的 F-C2“仅 try/catch 父仍失败、store 不提交”旧验收，并同步 codemode.md；历史事实保留适用版本，不再作为执行要求。交付状态见 [PR #291](https://github.com/dragonbaba/super-pi/pull/291)。

### C2. 失败后的执行事实与展示

- 未捕获错误结束顺序依赖链，但不能一律写“后续调用没有执行”：已发出的并行兄弟调用可能执行，finally 也可发出调用。按实际回执列 completed/failed/not-started/cancelled/unknown，只对确未发出的步骤说未执行，不能推断任意脚本语句。
- 失败不抹去已 show/返回的成功内容；allSettled 不会自动展示每个 ref，子成功也不等于正文已进入下次请求。
- 保留“不回滚副作用、不自动重试修改”，展示受限与执行失败分开，部分成功不跳过既有输出容量和续读。

C 交付后的目标示例：

```javascript
const results = await Promise.allSettled([
  tools.read({ path: "a.txt" }),
  tools.read({ path: "missing.txt" }),
  tools.read({ path: "b.txt" }),
]);
for (const result of results) {
  if (result.status === "fulfilled") await show(result.value.ref);
  else text(String(result.reason));
}
store("readStatuses", results.map(result => result.status));
```

store 保存有界状态，不保存本脚本 ref。结果处理循环不改变生产扫描或工具并发规则。

### C3. 批量指引

替换 CODEMODE_DESCRIPTION、动态 describeTools 尾部和 core/codemode.ts 重复说明，不持续追加多份提示：

- 多个独立、无需中途模型判断的读取/搜索适合一个脚本一起发起，用 allSettled 逐个检查/展示。单调用合理时照常使用，不设置最低调用数。
- 有依赖的修改→运行→检查按顺序 await，失败先判断实际状态，不自动执行依赖步骤或重放已完成修改。
- 同一文件适合一次 edits[] 的修改合并表达，不简单并发修改同一路径。
- 一起发起不等于一定并行执行：保留 nested read 分类、写互斥、权限核验、MXC 串行 owner，不为吞吐绕过。
- 当前 reuseWorker=true，不能把每脚本说成全新 worker 启动；比较模型轮次、租约、桥接次数，实际启动数另测。

### C4. read 与 shell 分工

替换 read.ts 的 “Use read ... instead of cat or sed” 排他句，对齐 session-files/MXC 实际机制：

- 准备编辑、需要可靠原文及相应版本时优先 read；shell 读取正常，但不自动给原生编辑签发修订。
- 小文件可整份读；大文件优先足够任务的连续函数/段落，尊重现有容量。超大函数/长行按实际边界处理，不强制整段一次读完。
- 搜索、计数、多片段可用一条合适 shell 命令，如 rg、sed、cat、Select-String；使用可用工具及原生 shell，保留真实退出状态/错误诊断。
- 已有内容且无已知变更时不预防性重读；冲突、淘汰、无法延续时再读，不为证明未变每轮新增全文件扫描。

### C 的验收及提示成本

1. 真实 session/VM allSettled 读三文件一项不存在：两份成功正文实际进入下次模型请求，保留失败原因，父 isError=false；下一脚本 load 已提交状态，工具各只执行一次。
2. try/catch 替代成功、全部子调用失败但正常处理、allowFailure、重抛、未 await、观察失败、取消/权限暂停分别符合 C1，不只看总结文字验证 store。
3. Promise.all 提前失败且兄弟修改已启动：摘要符合真实副作用、已完成修改不重放；finally 调用也记录，不虚报后续均未执行。
4. 子失败计数不因父成功重置，执行状态与展示受限分开，TUI 正确显示完成但含失败。
5. 提示采用替换，比较真实 provider 转换后的 promptChars/toolsChars 和 token 估计，记录净增/收益。不为减字删除权限/验证边界，也不把净增必须为零设成阻碍正确说明的硬门槛。

## 6. D：重复读取去重（仅评估）

[MXC 计划](super-pi-mxc-tools-plan.md) 第 9 节将模型可见去重列为后续。反馈的 9 次/258 行尚未逐段复算，本轮不据此实施自动省略原文。A/B/C 后用同类合成任务重测，再评估是否破坏准确文本、修订可见范围及前缀。

### 真实模型批量对照（待执行）

用户选择本轮仅准备方案，不发真实模型请求。测量时固定同一 provider/model/API、推理级别、配置、工具目录、模型参数和同一干净合成工作区；每组使用新会话，不复用 prefix/store，不加载真实项目上下文。旧提示取 C 前的 `239fd88577123edabf49406153d886a3d8ad6c3c`，新提示取当前实现，只替换 C3/C4 的描述文字（CODEMODE_DESCRIPTION、describeTools 尾部、read 描述），两组均运行当前代码与 C 的失败语义，避免把旧引擎失败行为混作提示效果。`git show` 读取旧文字即可，无须回退工作区或更改正常产品设置。

1. 合成三个任务：读三个独立小文件并汇总；搜索/计数/多片段定位；read→修改→运行→检查的依赖链。文件内容和用户任务在两组逐字相同；独立任务不在用户提示中暗示必须批量。依赖任务验证正常顺序，不把单调用记作错误。
2. 首轮每个任务旧/新提示各一次，共 6 个独立 session；总模型回合预算 12，达到时停止并报告未完成，不以限制产品工具调用实现实验预算。后续重复增加样本须单独记录。以 JSON 事件流或 SDK `session.subscribe` 记录 `tool_execution_start` 的 toolCallId/parentToolCallId、CodeMode 执行结果及 assistant 回合；不解析脚本源码推断调用。准备输出到 `.task-tmp/<task-id>/`，不把真实凭据/对话写入 evidence。
3. 报告独立任务中“含至少两个真实已发子调用的 CodeMode 脚本数 / 含已发子调用的脚本总数”，连同分子分母；另报模型回合数、子调用数、耗时、usage/cacheRead、工具与提示字符数、成功率、已完成修改次数。Promise.allSettled 不等于实际并发；并发调度另计。依赖任务单列。
4. D 的指标为同一文件同一内容版本、同一可见范围的重复读取次数/行数；把冲突、内容变更、版本失效、补读未见范围区分出来。首次评估只计数，不省略工具原文、不伪造 read 修订。保留样本差异与失败，不用字符下降代替行为改善。
5. 当前 **0 个真实模型样本**；小样本结果只说明此次任务分布，不证明普遍提升。只有实际运行后才能改写此状态与证据。

## 7. 性能、退役与交付

- A 的图片 admission/请求准备/provider 转换、C 的子交付/大结果处理按 [热路径契约](performance/hot-path-allocation-contract.md) 审计完整链路。B 若触及进度、结果投影或 ledger 也适用；确未触碰时写一行并跳过分配基准。
- 容量常量、编码策略、错误正则保持模块级；循环不创建内部闭包、Promise 尾链或完整结果副本，字节累加不解码全部图片。对象池仍需 profiler 证明，本轮不预设池化。
- 证据含确定性计数、分配 profile/主站点、真实 body、旧会话首次恢复及追加请求的 CPU/峰值堆；四次受控 GC 和正常/异常/取消/切分支/关闭的引用释放。衍生缓存的容量、所有者、失效点可验收。
- 合成 44 图覆盖尺寸、熵、透明度及像素图，禁止提交真实会话/配置/图片/凭据。每任务一份简明 evidence，原始探针放 .task-tmp/<task-id>-<unique-id>/。
- B/C 交付时同步 codemode.md、testing.md、schema/描述及旧计划；退役“修改后一律重读”“捕获后一律父失败”等被实现替代的有效指令，历史事实注明适用版本。
- 每次推送手动 @codex 审查当前提交，反馈先复现核实再改；当前 head 审查和 CI 通过后合并，再清理本次已合并分支并同步 main。

## 8. 实施前决策/门禁

| 项目 | 决定 |
| --- | --- |
| 1568/600 KiB、KEEP=8 MiB/STEP=4 MiB | 候选值，按最终上传、质量及分配定稿，不冒充外部产品默认 |
| inputLimits.images.resize | 不直接用目录缓存作设置；来源未明，先设计正式策略入口/迁移边界 |
| 旧会话恢复 | full-history 复现路径必须有效；总 body、当前图或协议不满足时明确失败，不作跨 provider 无条件承诺 |
| 已处理失败识别 | 真实 VM 对照先行，不严格解析源码/命令，不仅支持某一种 catch 写法 |
| 部分成功父 isError | 正常处理的普通失败为 false，保留真实计数；系统失败和最终观察/store 规则保留 |
| 裁剪、大文件延续、自动读去重 | 不在本轮实现，提示不承诺已有接口 |
