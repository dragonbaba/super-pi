# T06-A：共享增量 JSON 状态机与 Anthropic 工具参数

日期：2026-11-04。状态：**先行设计已落实，共享 parser 与 Anthropic 已实现，验收中**。基线为 T05-B #182 合并提交 `c37c9d6e509ff41650eef21dc81ea97f4ec8cfa5`；该 PR 最终 head `8670a659839f13d44dda36fdf35b702830ebe416` 已获 Codex completed/no findings，Linux/Windows CI 6/6 通过。本地与远端对应分支已删除并同步 main。本项分支 `codex/t06a-anthropic-incremental-tool-args`，只验证当前 Node 26.13.0。

## 顺序与范围

总方案已约定 T06 分切片交付。A 只实现共享增量状态机及 Anthropic 生产 adapter；合并后再按 Responses 家族、Bedrock/Chat Completions/Mistral 等实际累计解析入口依次交付。pi-messages/Google 的 replacement-object 协议不能因为文件相邻被改写；grammar/custom 工具不使用 JSON 状态机。T06 全部切片完成前不进入 T07。

每项继续执行用户最新授权：先写方案，实施并创建独立 PR，等待 reviewer 对最终 head completed，无问题且 CI 全绿后合并；有问题则修复推送并手动额外 `@codex review`，等待复审。清理对应本地/远端分支后同步 main 再进入下一项。保留用户未暂存的 patch 删除，不发布 npm 或安装全局版本。

## 已审计事实

1. Anthropic `input_json_delta` 把片段加入 `partialJson`，每次调用 `parseStreamingJson`；该 helper 对累计全文依次尝试完整 parse、repair 和 partial parse。闭合前每片段都会重新访问此前的文本；需要真实 adapter 基线，不以合成 UI fixture 代替。
2. `content_block_stop` 再调用同一 helper，并清空 `partialJson`。错误路径清空 buffer。现有 `hasIncompleteToolArguments` 用 WeakSet 标记 salvage 结果，Agent 依此拒绝执行不完整工具参数；不能照搬上游返回含完整参数文本的 argumentsError，改变本地恢复和隐私语义。
3. 上游固定参考为 `earendil-works/pi@f9a26365568127461c47a07a37dcb42c140a3ac5` 的 `packages/ai/src/utils/streaming-json.ts`。其 append 返回 changes 数组并创建 path/slot/change 对象，snapshot 复制 open path 容器。思路可借鉴，但该整套输出/快照层不满足本地常规片段分配契约。
4. 本地 Anthropic 已声明 `mutation-with-generation`。Agent 的 `getToolUpdateGeneration` 优先读 event/block.toolArgsGeneration，随后才读 partialJson/partialArgs。每个工具的 latest 元数据独立，真正 observer delivery 才 structuredClone/deepFreeze；UI 对 generation 判定是否更新。这允许复用可变解析结果而不复制 open path。
5. parser 不能挂在 output.content 上：output 会被 observer snapshot 和持久化读取。工具 parser 应由当前请求私有数组按 contentIndex 拥有，terminal/error/abort 都清空 slot；公开事件只携带现有 block 和数字 generation。
6. 当前 Anthropic 入口没有 per-tool 字节/深度产品上限；本项明确保持现有可接受输入范围，不临时添加 32/64 层或固定 MiB 硬限制。状态随该 tool 实际输入增长，上界为已有 JS 字符串可表示范围及实际请求输出；运行时资源错误仍走现有 error/release。若要额外产品容量限制，须单独设计，不能夹带为优化的兼容性降级。

## 实施设计

### 共享 parser

- 每活动工具一个实例；append 只消费新增 fragment，并保留一份原始文本供终态语义校验。常规片段没有完整重解析、join/hash/stringify、结果深克隆、Promise/controller 或 changes 数组。
- 使用迭代状态机处理 object/array、字符串与 escape/Unicode、number/literal。栈仅保存仍开启的容器；pop 立即释放 frame 引用，dispose 清空整个栈和 token/root/raw 引用。无递归深度限制、对象池或共享全局可变 scratch。
- 结果容器只按实际 JSON 结构创建。字符串/标量使用实例固定字段与原始 parent/key/index 状态，不为每片段或每字符构造 slot/change/options wrapper。`__proto__` 作为普通自有 JSON key 定义，不能变成原型写入；重复 key 遵循最终 JSON 语义。
- 连续普通字符串采用 fragment 内区间一次追加，escape 跨块保留最多一个固定短状态；未完成 escape 不提前显示错误字符。必要的 token/结果字符串分配与容器创建按输入内容计数，不能宣称物理零复制。
- 进行中的 number/literal 预览仅检查固定长度 token 前缀；过长标量在完成时解析，不扫描其累计内容来刷新每个 delta。该策略只约束预览工作，最终完整数值能力不降低。补充合法数字、负零、指数和非 JSON 数值的兼容夹具。
- 结束时只调用一次既有 `parseStreamingJson(raw)` 边界：合法 JSON 完整 parse 一次；非法/截断文本继续沿用已有 repair/salvage 与 incomplete 标记，不在 append 执行该兜底链。报告非法终态 helper 的实际多次尝试，不把“一次 helper 调用”伪称为一次底层 parse。
- 显式冷 diagnostics 记录累计输入、实际 scanner 消费、finalize 次数、当前 depth/raw/token 引用长度；热路径只增加原始计数，无每片段诊断对象或 hook 闭包。release 后保留数字统计即可，不保留结果/原始参数。

### Anthropic 接线

`tool_use start` 建立 parser owner 和现有工具 block；input_json_delta 调用 append，将现有 arguments 指向 parser 的可变预览，递增数字 toolArgsGeneration，保持原有事件顺序与内容索引。start 的初始 input、空 stream 和终态 incomplete 行为以已有语义为准，不顺便改协议。

`content_block_stop` 使用一次 finalization，清空 parser slot 和 transient generation 后发 toolcall_end。现有 blockPositions=-1 拒绝迟到 delta；并行工具状态不共享。请求的 finally 统一 dispose 所有仍开启 parser（包含成功但缺少 block_stop、传输错误、abort）；不能仅清空 output 上一个字段而继续持有 parser/raw。若成功响应缺少工具 stop，需要以现有完整性恢复语义验收，不能让可变预览变成未校验可执行参数。

现有 `markIncompleteToolArguments` 仅作内部 utils 导出供预览标记；不改 packages/ai 顶层公开 API。最终保留 `hasIncompleteToolArguments` 供 Agent 的既有判定，避免同一部分参数被误认为完整。

## 完整生产链与性能门禁

Anthropic response body/read → TextDecoder/SSE 事件 → iterateAnthropicEvents → input_json_delta/parser → AssistantMessageEventStream → Agent.processEvents/prepareMessageUpdate → latest observer snapshot → AgentSession observer bridge → InteractiveMode message_update → ToolExecutionComponent.updateArgs → display/layout → TUI frame queue → terminal write。

现存 transport async iterator/事件协议对象、SSE 解码和 observer structuredClone 在报告中单列，不能把新增 parser 的零 Promise 说成整条 transport 零 Promise。此次不复制/重写 transport 或 UI；源码门禁必须继续覆盖它们，性能夹具验证数字 generation 接线后 snapshot/flush、pending metadata、调用次数和释放没有回退。

- 新 parser AST：append 及普通 token helper 无 inline closure、Promise/AbortController、临时数组/变更 wrapper、历史 parse/stringify；精确豁免仅 constructor、实际 JSON 容器开启/自有特殊 key 写入、finalize、dispose 和 diagnostics。必要 JSON 结构分配按 node/input 记录，而非按 delta。
- 真实 Anthropic 离线 response fixture：固定 N/2N/4N 大字符串、宽对象、嵌套与不同 delta 粒度。记录 argument scanner 消费单位、终态解析扫描量、generation、parser 数、normal delivery Promise、复制/解析调用数。SSE JSON 解码的计数与工具参数重解析分开。
- 分配/时间分开采样；同机同 Node 串行 A/B，记录 sampled bytes/input byte、leading stacks、p95、peak heap、受控 GC 后 heap。若只能证明近线性输入访问，不能冒充所有 V8 字符串 flatten 都是严格 O(N)。
- 保持 caller/stream/最终 result 活着验证 parser、旧预览 graph、raw input 与 stack 不再被 invocation 保留；结束、取消、错误、多个并行工具均需要生命周期证据。
- 运行 `stream-hot-paths`、TUI frame/real hot paths、ownership/recovery provider contracts，以及 `bench:stream`、`bench:tui-session-event-allocations`、`bench:tui-paced-streamed-tool-args` 和 frame queue benchmark。使用真实 adapter 测 parser，使用现有下游 fixture 测 UI，两者不互相替代。

## 逐条执行与验收

1. 固定旧 adapter 的大输入扫描/分配基线和完整/截断语义；先产生可复核红灯计数。
2. 实现共享 parser，测试所有字符串切点、escape/Unicode、嵌套/数组/重复与特殊 key、数字边界、不完整/畸形终态、finish/dispose 和迟到 append 生命周期。
3. 接入真实 Anthropic adapter，保留事件顺序、finalize、不完整标记，验证并行工具及旧 snapshot 的冻结隔离。更新 source invariant 接受数字 generation，不能通过删除旧断言隐藏未接线。
4. 补齐性能三类证据，运行最小相关 checks，随后 check/build:offline/完整当前 Node26 suite。只有发生实际失败才扩大诊断或重复测试。
5. 独立 PR → 最终 head reviewer completed 与 CI → 有问题修复并额外 @codex review → 无问题合并清分支 → 下一 T06 切片。

## 执行记录

### 根因、实现与行为

真实 Anthropic adapter 基线：8206 个 ASCII 输入字符按 64 字符分片，参数的完整 JSON.parse 调用 130 次，累计传入 544796 字符；16398/32782 输入时分别为 258/514 次、2138140/8470556 字符。该计数尚未包含 repair/partial-json 的额外全文扫描，已是平方增长的下界。候选三种输入均只在终态 parse 一次、scanner 精确消费 N 个字符，不再重读原始历史。

新增 `IncrementalToolArguments`：固定 token/escape/slot 字段，迭代的活动 frame 栈；普通字符串通过片段区间追加，只有真实 JSON 容器/必要 syntax frame 才创建对象。开启的大结果按既有 mutation-with-generation 更新，parser 和 raw 留在请求私有数组，数字 generation 上事件。终态复用既有 parseStreamingJson，不新增一条修复链；未出现 tool stop 的成功响应也进入该终态完整性校验。错误/取消由 finally 释放仍活动的 parser，最终结果的部分参数归调用者所有。

单元覆盖全部 split point、Unicode/escape、raw control、无效 escape 终态修复、重复与 `__proto__` key、数组、指数、负零、超长数字、1000 层嵌套和 dispose。真实 adapter 覆盖并行工具、独立 generation、无 parser 泄入事件、缺失 stop、空/截断输入、取消及传输错误。Agent 集成同时验证完整参数恰好执行一次、不完整参数返回 TOOL_ARGS_INCOMPLETE 而不执行、已交付 observer snapshot 保持冻结且不被后续片段改变。

集成测试第一次误把源码 adapter 与 Agent 引用的已构建 ai 包混合；两份 json-parse 模块各持有独立 WeakSet，造成“参数不完整却执行”的夹具红灯。沿 Agent 的实际包依赖改用已构建 Anthropic adapter 后通过；未添加跨模块全局标记、备用执行或生产兜底。源码 parser 单元与真实 adapter 解析测量仍在同一源码模块图内。顶层 ai barrel 改为列出原有七个 JSON helper，保持公共 API 原样，不意外导出新增内部标记函数；构建产物验证通过。

### 性能与生命周期

[完整 JSON 证据](../evidence/pi-150-t06a-anthropic-tool-args.json)保存五轮交替 A/B、hash、allocation stacks、peak/GC heap 和下游门禁。Windows 10.0.26300 / Node v26.13.0；真实 provider 测量串行，无同时运行的构建；2 warmup、8 timing、4 allocation runs、1024-byte sampling。只有离线 request admission 被替换，实际 SSE、provider 和 EventStream 均执行；输入在采样前编码。

| 场景 / delta | 采样 bytes/input byte 中位：旧 → 新 | 墙钟 p95 ms 中位：旧 → 新 |
| --- | --- | --- |
| 16 KiB 字符串 / 128 | 2375.26 → 39.20 | 10.82 → 0.584 |
| 32 KiB 字符串 / 128 | 4683.44 → 40.34 | 41.68 → 1.009 |
| 64 KiB 字符串 / 128 | 9288.28 → 37.08 | 178.99 → 1.812 |
| 32 KiB 字符串 / 32 | 18662.73 → 137.78 | 180.69 → 2.662 |
| 2048 成员宽对象（28513 bytes）/ 128 | 6226.30 → 55.27 | 124.99 → 1.721 |

64 KiB 场景采样分配下降约 99.6%；N/2N/4N 的单位输入分配稳定，较小 delta 的协议交付固定成本仍明显。CPU duration 的短样本受 Windows 计数量化影响，部分为 0，不用它宣称零 CPU。没有池化，也没有把这些小规模测量夸大为所有 V8 flatten 都严格线性。

parser append 的 Promise=0。完整 provider fixture 的 Promise 分别为 2295/4469/8821，旧新完全一致，来自现有异步 transport/event iteration，不能声称整条 provider 为零 Promise。容器按 JSON 结构计数，常规 delta wrapper/数组/深克隆=0；终态必要结果图只物化一次，旧预览随 owner 释放。原始全文仍仅为终态校验保存，不把它写到公开 partial graph。

受控 GC 时保持返回 stream/result 存活：normal/abort/error 的 parser 弱引用均为 0，dispose 后 raw/token 长度、活动栈、root/parent 引用均清空。normal 的旧预览也可回收；abort/error 的部分预览仍由返回结果拥有，明确不把它计成泄漏。没有根据一次 heap 差值声称引擎不保留共享字符串 backing storage。

下游结果：100000 raw stream 更新合并为 1 次 snapshot/delivery、pending key 最大 1；session-event 普通 listener Promise、wrapper、数组等门禁为 0；paced args 的 1/2/4/8/16 工具场景每 flush 恰好一次消息 snapshot，generation 缺失与语义兜底为 0、metadata/调度状态释放；frame queue 100000 请求只生成/写入 2 帧，active/pending 清空，新增 frame Promise/controller/wrapper 与全尺寸副本均为 0。paced 下游测量后半段与离线构建重叠，因此仅作为结构、分配与释放回归证据，不将其耗时用于 A/B 性能结论。

### 验收状态

定向 101/101 tests 通过，补充实际 Agent 集成后的 Anthropic 文件 12/12 通过。类型检查、离线构建、公开 API 检查以及四个下游 benchmark 均通过。全量当前 Node26：**399/399 执行单元成功，5302 tests / 5204 pass / 98 skip / 0 fail / 0 cancelled**。最终 head CI 和 reviewer completed 由独立 PR 验收，不先标已交付。临时旧 adapter 已按记录的精确路径删除，日志与原始采样保留于 `.git/pi150-t06`。
