# T06-B：Responses 家族增量 JSON 工具参数

日期：2026-11-04。状态：**先行设计已落实，Responses 已实现，验收中**。基线为 T06-A #183 合并提交 `23fd4b6e15e25886dc22e69e703deb278de4ae7c`；最终 head `1044154f9e3b585dc00da02e87a6283cd300905f` 已获 Codex completed/no findings，CI 6/6 成功。对应本地和远端分支已删除，main 已同步。当前分支 `codex/t06b-responses-incremental-tool-args`，仅使用 Node v26.13.0。

## 范围与顺序

复用 T06-A parser，接入 OpenAI Responses、Azure Responses、Codex Responses SSE/WebSocket 共用的 `processResponsesStream`。本项独立 PR，等最终 head reviewer completed 和全部 CI 成功后按授权合并、清理对应分支，再进入其余 T06 累计解析入口。若 reviewer 提出问题，修复并推送后额外发送独立 `@codex review` 评论，等待复审。用户未暂存的 `super-pi-clipboard-fix.patch` 删除保持原状。

custom/grammar 的原始文本协议保持独立；不改请求/重试/transport/工具执行策略，不加输入容量、深度限制、池化或备用解析链。最终畸形 JSON 仍由现有 `parseStreamingJson` 处理，进行中的预览继续带 incomplete 标记。

## 事实与完整调用链

- `function_call_arguments.delta` 在 block.partialJson 累计后每次重解析全文。`arguments.done` 可补充后缀，也可替换成完全不同的参数；只在存在后缀时发 delta。`output_item.done` 用非空 item.arguments 优先、否则用累计文本，随后发 toolcall_end。
- 没有 output_item.done 的 completed/toolUse 响应必须报 unfinished tool call；即使 arguments.done 已到，也不能放行。缺少 output_index 会让 slot 碰撞，但旧 block 仍需要保持未完成状态以阻止执行。length/error/abort 也必须释放私有 parser。
- 当前 block 上的 partialJson 会被 snapshot 看见；新 parser 和原始参数必须只放在请求私有 slot 内。数字 toolArgsGeneration 可直接复用已上线的 Agent/UI 接线。
- 生产链：SDK SSE（OpenAI/Azure）或 Codex parseSSE/parseWebSocket → mapCodexEvents → processResponsesStream → 私有工具 parser → AssistantMessageEventStream → Agent.processEvents/prepareMessageUpdate/latest observer snapshot → AgentSession observer bridge → InteractiveMode message_update → ToolExecutionComponent.updateArgs → display/layout → frame queue → terminal write。
- 已有异步 transport、协议 event、实际 observer snapshot 是既有成本；不能把 parser append 的零 Promise 称为整条链零 Promise。沿用 T06-A 已审计的下游边界，运行相关源码/AST、分配及释放门禁验证未回退。

## 具体设计

1. function slot 持有可选 parser，block 只保留可变 arguments 与数字 generation。创建时扫描已有 item.arguments（若有），每个普通 delta 仅 append 新片段并递增 generation；不会做历史 startsWith、完整 parse、序列化、深复制或创建新控制对象。
2. 为 parser 增加仅用于整段终态事件的后缀查询，以及 finalize 的可选权威全文参数。后缀查询不在普通 delta 调用。arguments.done 若是前缀扩展则 append 后缀；若整段替换则 dispose 旧 parser、在该边界建立新 parser 扫描权威文本。保留原有“只有非空后缀发 delta”的事件语义，替换本身递增 generation。不同全文替换的工作计入真实替换输入，不伪称仅初始 N 字符。
3. output_item.done 只 finalize 一次，传入非空权威全文或使用 parser 累计文本；合法 JSON 一次完整 parse。清空 parser/generation 后发送 toolcall_end 并删除 slot。arguments.done 只更新预览，不重复最终语义解析。
4. slot 被新的 output item 覆盖时先释放旧 parser，旧 block 的 generation 保持未完成标记；结束检查依据该标记识别缺失 done/碰撞，不以 map 当前仅剩的 slot 数掩盖旧未完成调用。
5. 整个 shared processor 使用 finally 释放剩余 slot/parser，清空 map、reasoning 引用和 block 临时 metadata（包括 grammar 状态）。三个 wrapper 中已失去来源的 partialJson 清理代码删除；公共部分结果仍归调用者所有。不可把 parser/dispose 方法挂在 output graph 上。

## 验证与证据

- 先固定真实共享 producer 的旧实现副本与红灯：离线 Codex SSE 经过实际 transport/shared processor/EventStream，N/2N/4N、不同片段粒度、宽对象；只替换请求入口，不以 UI 模拟代表 provider。
- 语义：初始 arguments、逐片预览、并行工具、arguments.done 后缀/整段替换/相同全文、output_item.done 再覆盖、空终态回退、空/截断 JSON、遗漏 done、output_index 碰撞、custom/grammar 混合，以及正常/length/error/abort 释放。
- Agent 集成使用一致的已构建 ai 模块图，验证完整参数执行一次、不完整参数不执行，observer snapshot 冻结隔离；不因源码/构建 WeakSet 身份不同引入生产兜底。
- AST/source：普通 parser 和 Responses function delta 无闭包、Promise/controller、数组/changes wrapper、历史全文扫描；私有 parser 不泄入 partial block，终态和 finally 清理明确，旧 generation ownership 断言改为新的数字断言而非删除。
- 计数：输入/扫描字符、完整 parse 次数与输入量、parser 数、每 delta generation、普通 append Promise、容器/活动栈、终态和错误后 retained refs。保持 stream/result 活着受控 GC 验证 parser/旧预览可回收。
- 同机串行交替 A/B，预先编码请求输入；分别采样分配/时间，记录 bytes/input byte、leading stacks、p95、CPU、peak/GC heap。保留必要 JSON/字符串物化；不将 V8 backing storage 推断为已证实零复制。
- 先最小定向测试，再 check、build:offline、当前 Node26 全套；运行 stream/session-event/paced-args/frame-queue 下游 benchmark。没有新失败不盲目重复扩测。PR 最终 head 的 reviewer 与六个 CI 分片完成后才合并。

## 执行记录

### 实现与兼容性

function slot 私有持有 parser；公开 arguments 原位预览，event/block 传数字 generation。普通 delta 只追加新片段。arguments.done 只在该整段事件边界比较前缀，扩展时追加后缀；完全替换时释放旧 parser 并扫描新文本。output_item.done 对权威全文（或空文本回退的累计内容）执行一次最终 helper；保留 empty/incomplete 修复语义和 namespace，随后清除临时状态。

setSlot 在替换 slot 时释放被覆盖的 parser；旧 block 的 generation 仍标记 unfinished。completed/toolUse 的检查在 finally 清理之前执行，因此缺少 output_item.done、缺少 output_index 导致的旧调用碰撞仍会报错。length/error/abort 也统一释放 parser/map/grammar scratch。三个 wrapper 中重复的 scratch 清理循环已移除，公共输出不再携带 partialJson。

新增测试覆盖真实 OpenAI/Azure SDK SSE 和 Codex SSE、并行工具与数字 generation、终态补后缀/完全替换/相同全文/再次覆盖、初始参数和空终态回退、空及截断 JSON、arguments.done 不授权执行、slot 碰撞、length 时 JSON/grammar 释放。现有 terminal、grammar、recovery 和 transport 合约继续作为回归门禁。Agent 集成与 built ai 使用同一 completeness WeakSet，验证完整参数一次执行、截断参数零执行和冻结 observer snapshot 隔离。

### 计数、分配与生命周期

[完整 JSON 证据](../evidence/pi-150-t06b-responses-tool-args.json)保存五组串行交替 A/B、源文件 hash、allocation stacks、peak/GC heap 和下游结果。实测 Windows 10.0.26300 / Node v26.13.0；输入在采样前编码，实际 Codex SSE → shared producer → EventStream 全部运行。2 warmup、8 timing、4 allocation runs、1024-byte sampling；provider 测量没有并发构建/测试。

N/2N/4N 输入为 8206/16398/32782 字符，64 字符分片。旧参数 JSON.parse 为 131/259/515 次，累计传入 553002/2154538/8503338 字符，尚不包含 repair/partial-json 的额外历史扫描。新实现三种输入均一次最终 parse，scanner 各精确消费 N；arguments.done 的一次终态前缀比较另计，不冒充 scanner 零额外访问。普通 append Promise=0；完整 provider 的既有 Promise 2296/4470/8822 旧新一致。

| 场景 / delta | 采样 bytes/input byte 中位：旧 → 新 | 墙钟 p95 ms 中位：旧 → 新 |
| --- | --- | --- |
| 16 KiB 字符串 / 128 | 2381.26 → 44.73 | 11.780 → 0.801 |
| 32 KiB 字符串 / 128 | 4683.28 → 40.45 | 42.625 → 1.326 |
| 64 KiB 字符串 / 128 | 9297.90 → 37.86 | 181.023 → 2.142 |
| 32 KiB 字符串 / 32 | 18628.31 → 112.93 | 177.340 → 2.640 |
| 2048 成员宽对象（28513 bytes）/ 128 | 6224.29 → 57.19 | 126.713 → 2.143 |

64 KiB 场景采样分配下降约 99.6%。该结果不声称所有 V8 字符串 flatten 都严格线性，CPU 短样本受 Windows 计数量化影响也不作为零 CPU 结论。旧完整 parser 控制副本已在采样后按两个记录的精确路径删除。

受控 GC 保持 stream/result 存活：normal/abort/error 三类 parser 弱引用均为 0；dispose 后 raw/token 长度、root/parent 和活动栈均清空。normal 的旧 preview 也可回收；abort/error 的部分 preview 仍由结果拥有。slot 碰撞测试额外确认被替换实例均已 dispose。没有对象池，也没有把必要的协议事件、JSON 容器和最终结果图算作“零分配”。

四个下游 benchmark 均串行通过：100000 stream 更新 → 1 次 observer snapshot/delivery；session 普通 listener Promise/wrapper/array 为 0；paced 工具 1/2/4/8/16 场景每 flush 一次消息 snapshot，generation 缺失和语义兜底均 0，pending metadata/scheduler 清空；100000 frame 请求 → 2 次生成/写入，active/pending 释放，全尺寸 frame copy 和新增 Promise/controller/wrapper 均 0。UI fixture 明确不覆盖 provider parser；两类证据共同验收完整链。

### 验收状态

定向 79/79 测试、类型检查、离线构建和四个下游 benchmark 已通过。全量当前 Node26：**400/400 执行单元成功，5323 tests / 5225 pass / 98 skip / 0 fail / 0 cancelled**。全量包含构建后实际 Agent 集成与 stream/TUI AST/source invariants。最终 head CI/reviewer 尚待独立 PR；未先标已交付。原始日志与采样位于 `.git/pi150-t06b`。
