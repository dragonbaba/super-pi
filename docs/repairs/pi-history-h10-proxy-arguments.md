# H10 — SDK streamProxy 增量工具参数

状态：已通过 [PR #209](https://github.com/dragonbaba/super-pi/pull/209) 合并，两端任务分支已删除；临时目录清理受阻，见末节。基于 H09 merge `5b798165a20014ecb8a9af423253becaba18ab77`，原分支 `codex/h10-proxy-arguments`。任务根 `D:\RMProjects\Pi\.task-tmp\h10-7da5a16b0f09`，Node 26.13.0，child TMP/TEMP/TMPDIR 已验证。

## 实际链与边界

可选 streamProxy → fetch Response reader → UTF-8 decode/SSE data 行 → processProxyEvent → EventStream → agent-loop → Agent processEvents/最新事件合并 → structuredClone + deepFreezeSnapshot（实际交付时）→ AgentSession 同步 bridge → InteractiveMode changedToolUpdates → ToolExecutionComponent generation → Text/布局/TerminalFrameQueue。streamProxy 不作为新默认路由；原 SDK partial 是可变预览，实际 observer 快照仍由 Agent 负责，不能用逐 delta content spread 冒充完整隔离。

已定位旧成本：toolcall_delta 把 partialJson 挂在可见 ToolCall 上，累计全文 parseStreamingJson、复制 block、创建另一份事件包装。SSE 每 read 创建 decode options 和 split 行数组，并重复扫描尚未结束的累计行；reader 未在终态统一取消/releaseLock，EOF 无 terminal 时 stream.result() 可能保持 pending。已有 EventStream 异步迭代和 reader.read 的协议交付 Promise 必须单独计数，不能声称全链零异步。

## 先行方案与所有权

复用现有 IncrementalToolArguments，每活动 content index 一份 parser，私有请求数组持有，raw 不挂到 SDK 消息。ai 根入口增加该既有类的导出供 agent 包真实消费，保持 side-effect-free；不跨包导入源码或新增 parser。delta 只 append 新片段，更新原 block 与数值 generation，并复用解析出的 proxy event 加 host 字段；无新增 closure/Promise/controller/wrapper/数组/spread。明确 start/replace/end/done/error/abort 的 dispose 边界，清除 generation 和 parser 引用。toolcall_end 的对象始终权威，id/name/namespace/thoughtSignature 明确复制；done 缺 tool end 时只在终态 finalize 一次，error/abort 保留现有不完整可见预览而释放 parser 私有状态。重复 start 释放旧 owner；终态后不再修改结果。

SSE 维持当前每 data 行一个 JSON event 的协议，只扫描新 decoded chunk 的换行位置并保存唯一未完成行，不升级为另一套通用 SSE 框架。模块复用 decode options；逐 record JSON.parse 是必需协议解码，工具累计全文重解析门禁不包含它。缺 terminal 的 EOF 明确产生错误，不能让 result 永久 pending；终态与异常统一关闭 reader、移除 abort listener、清理缓冲/parser。新增错误只有实际协议失配/EOF 的明确失败，不做自动重试或补发事件。

容量由请求输入决定：一个未完成协议行、每活动工具一份 raw/token/root 与语法栈；raw/input 扫描线性，返回的最终/不完整预览由结果 owner 保留，不能清掉调用方仍需的数据。完成/异常/取消后内部字符串、语法栈、reader、监听器与 parser 全释放；流与 signal 保持存活做受控 GC。无对象池。

## 验收计划

实际 streamProxy 与离线 Response fixture：Unicode/转义跨块、nested/array/string、交错工具、空 delta、最终对象修正、无 tool end、非法/不完整 JSON、替换/重复边界、abort/网络 error/缺 terminal、尾部持续连接。真实 Agent observer 验证 snapshot 隔离及 generation 到达，不把手工 clone 当作实际交付。

已检查 scripts/bench/provider-tool-args.ts：它期待 provider.stream + fixture.start(factory)，不能直接把原参数当 proxy 数据。新增专门的 proxy fixture/驱动测实际 streamProxy，复用 IncrementalToolArguments diagnostics 与相同 HeapProfiler 方法；固定 16KiB/64KiB payload、64 code-unit delta，计数与 profile 分离。完成以下实际验收，review/CI 最终回执见末节。

## 失败基线与最终功能验证

原先 13 项协议检查在基线 **1 通过、12 失败**，唯一通过项是原有权威 toolcall_end 对照。候选补齐重复 end/关闭后 delta、真实 Agent、提前 abort 后共 **17 项全部通过**。源码 helper 将包入口定向到源码，保证 Agent 和 proxy 使用同一个 incomplete-arguments WeakSet；另用构建后的真实 `@super-pi/agent-core`/`@super-pi/ai` 入口验证导出、generation、缺 end 的 finalize 和 reader 释放，避免仅源码别名通过。

真实 Agent 用显式首 delta 交付闸门验证 observer 快照：完整调用执行一次；缺 end 的截断输入不执行工具，产生 TOOL_ARGS_INCOMPLETE 并允许下一轮恢复。实际交付快照被冻结，保留到运行结束后序列化值不变。闸门只在测试网络边界控制速度，不假定每个网络 delta 都独立送达。实际协议数据皆为合成数据，无真实网络、密钥或会话写入。

必要校验仍在既有协议边界：JSON wire 解码、delta 内容类型/活动 parser 检查；缺终态 EOF、关闭后 delta 明确失败。没有增加逐层 schema 校验、重试、兼容 parser 或另一套关闭 owner。权威 end 直接接收最终对象，不对累计参数重复 parse；done 缺 end 才 finalize 一次。错误/取消保留可见预览，释放私有 raw/语法栈。namespace/thoughtSignature/id/name 和既有终态 usage/元数据规则保留。

## 分配、扫描与释放证据

机器可读结果及主要分配栈见 [H10 evidence](../evidence/pi-history-h10-proxy-allocation.json)。基线 proxy SHA-256 `5f503e8dd8179a2ff64edf0fc4a195320b04527942fac42be669fee5e51a81a2`，候选 `7e8aed2af4748cd20b58e3e8e0cad9d3f78b83afb4b7409d86777f64adb299f7`；同一 benchmark SHA-256 `7f6edf262e91c5be5e4a07487e9d9285ba9be6afdebe001595e45ec63a6824d6`。计数与 profile 串行隔离，无并行构建争抢资源。16/64KiB payload 的完整参数长度分别 16,398 / 65,550 code units。

| 确定性计数 | 16KiB 基线 → 候选 | 64KiB 基线 → 候选 |
| --- | --- | --- |
| 工具 delta 数 | 257 → 257 | 1,025 → 1,025 |
| 累计全文 parse 次数 | 257 → 0 | 1,025 → 0 |
| 全文 parse 输入字符总数 | 2,121,742 → 0 | 33,652,750 → 0 |
| 候选增量扫描字符 | 16,398 | 65,550 |
| delta 对象字面量执行 / spread | 514/257 → 0/0 | 2,050/1,025 → 0/0 |
| parser 内 Promise | 0 → 0 | 0 → 0 |
| 全流 Promise（含 reader/EventStream） | 1,845 → 1,846 | 7,221 → 7,222 |
| 每 read 的 decode options 身份数 | 261 → 1 | 1,029 → 1 |

全流多出的一个 Promise 来自终态 reader cleanup；reader.read/异步迭代的原有成本仍计入，不能把 parser 零 Promise 写成全流零 Promise。AST 门禁检查普通 toolcall_delta 与 SSE 新行扫描体：闭包、数组、对象、spread、正则、new、await 均 0；唯一豁免为非法 delta 的 fatal `new Error`。原来的 abort catch inline callback 改为模块稳定函数；没有新增普通 delta 回调或正则字符串。

另以单条 65,536 字符 text_delta、每块 32 bytes 验证大 SSE 行：基线 split **2,058 次、扫描 67,273,535 code units**，候选 split **0**、只扫描新块 **65,822 code units**（含协议 framing）。一个未完成行仍按输入增长；并未对单条 wire event 增加固定长度限制。

HeapProfiler sampling interval 4,096，2 warmups、6 measured streams；wire fixture 在采样前构造，采样包含实际 proxy/读取/事件迭代。累计采样分配每流：16KiB **76,462,348 → 430,148 B**，64KiB **1,211,885,357.33 → 1,626,213.33 B**。基线主栈为 repairJson/partial-json.parseStr，候选主栈为 proxy、TextDecoder、EventStream/读取交付。完成点观察的 heap 增量分别 **27,436,800 → 2,830,272 B**、**71,382,136 → 5,280,008 B**；这些不是连续采样峰值或 RSS，不声称 CPU 提速。

成功/transport error/abort 保持三个 stream、result、signal 存活，8 次受控 GC 后 **3 个 parser WeakRef 全部释放**；raw/token/root/parent/stack 清零、closed=true；结果 partialJson 长度 `[0,0,0]`、abort listeners `[0,0,0]`、三个 reader 都解锁。基线错误/取消结果仍带 128/320 字符 raw，三个 reader 均持锁。重复 start、text 替换、服务端 error、提前 abort、EOF、保持连接的 terminal 路径另有功能测试。无对象池。

## 完整链回归与边界

相关 parser/provider/source/streamed ownership/frame queue 合并运行 **156 项通过**。最后增加提前 abort 检查后，proxy 协议与结构/生命周期门禁再次运行 **22 项全通过**（17 协议 + 5 gates）。`npm run check`、`npm --offline run build:offline`、构建产物包入口 smoke 均通过。

- session-event：10,000 updates / 1,000 warmup，真实 Agent observer→AgentSession→Interactive stub；内置 listener/bridge/rejection observer Promise 均 0，末次值正确。不包含实际文本组件渲染。
- paced-tool-args：500 history items、2,000 updates、200 warmup，10 个场景全部完成；每 flush 一个 snapshot、AgentSession/Interactive 各一次 delivery，工具更新数匹配 1/2/4/8/16 活动工具；builtInPromises、pendingKeys、schedulerPendingTasks、flush 后工具 metadata 均 0。真实渲染仍有序列化、布局、padEnd/split 等必要分配，采样结果在 evidence 中保留。
- frame-queue：20,000 帧、1,000 warmup、预建 64KiB frame；frame wrapper/Promise/closure/materialization/copy 均 0，flush 后 active/pending 和两者保留字节均 0。采样 110.6836 B/frame 包含诊断/计时等成本；这只是 queue-only 基准。相关 source/行为测试继续验证 active≤1、pending≤1、HWM≤2 和物理背压所有权。

下游三项是原有生产链回归夹具，不能当作一次 proxy→物理终端的完整端到端 profile。proxy→实际 Agent 已单独验证；未增加真实网络/终端环境测试。既有 text/thinking event 包装、实际交付快照、参数序列化与渲染成本仍存在，不宣称完整调用链零分配。最终审查、六分片 CI、合并及精确资源清理回执在本 PR 中记录。

## 审查、合并与资源回执

最终 head `7c83523505140527337d70d68a87ba1a1904813d`。首次 PR 打开后机器人只返回需要环境的提示，未实际启动审查；等待核实后补发一次 [@codex review](https://github.com/dragonbaba/super-pi/pull/209#issuecomment-6625559048)，[reviewer](https://github.com/dragonbaba/super-pi/pull/209#issuecomment-6625563029) 于 07:50:22 UTC 完成同 head 审查，无建议、无未处理线程。期间没有追加推送。[CI 41793721212](https://github.com/dragonbaba/super-pi/actions/runs/41793721212) 六分片全部通过。

合并前重新核验 head/reviewer/六项检查/线程，于 2026-11-04 07:51:41 UTC squash merge 为 `4652be3eeaaa96d54ea02e23eac4e43d34f8a3fb`。本地主分支快进同步，按精确 head 删除远端及本地 `codex/h10-proxy-arguments`。

27 条登记子进程记录均无存活 owner，正式功能/结构计数/profile/生命周期证据已提交。精确删除任务根内 212 文件和 3 子目录的命令被自动审批在执行前拒绝，原文 `blocked by policy`。全部资源仍保留于 `D:\RMProjects\Pi\.task-tmp\h10-7da5a16b0f09`，resources.json 记录 blocked；没有重试、换机制或接管旧根。[合并和清理受阻回执](https://github.com/dragonbaba/super-pi/pull/209#issuecomment-6625639612)。
