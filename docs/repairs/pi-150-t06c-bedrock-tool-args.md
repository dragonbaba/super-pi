# T06-C：Bedrock Converse 工具参数增量解析

日期：2026-11-04。状态：**先行设计已落实，Bedrock 已实现，验收中**。基线为 T06-B #184 合并提交 `35dc8d10b6e350ecf01fe24007adbf7e1473496b`；其最终 head `2458a88685c4d8202d61dc266869bb3a349cba21` 已获 Codex completed/no findings，Windows/Linux CI 6/6 成功，相关本地/远端分支已删除，main 已同步。当前分支 `codex/t06c-bedrock-incremental-tool-args`，仅验证 Node v26.13.0。

## 范围与现状

只接入 Bedrock Converse 的工具 JSON 参数，复用 T06-A/B 的共享 parser；之后再分别处理 Chat Completions、Mistral 等累计入口，T06 全部交付后才进入 T07。先记录方案、固定旧生产代码基线，再实施、验证、独立 PR。等待最终 head reviewer 完成且 CI 全绿后自动合并清分支；若有问题，修复推送并额外独立请求 Codex review。保留用户未暂存的 patch 删除。

当前 `handleContentBlockDelta` 通过 `blocks.findIndex` 为每事件创建闭包、查找活动 block，累积 partialJson 后每片段完整重解析；stop 再次解析。`blocks` 就是 output.content。工具由 contentBlockStart 创建，text/thinking 在首次 delta 时创建；stop 清除 index，迟到 tool delta 因找不到活动 block 而忽略。传输错误、异常事件及 abort 会进入原有错误格式化和诊断边界。

Bedrock 没有 Responses 的 output_item.done 授权条件，不能把该规则跨协议移植。正常 messageStop 后若缺少 block stop，旧实现会保留最后一次逐片 parse 的结果。本次在成功/length 终态补一次语义校验，从而保留合法 JSON 与 incomplete 区分，不能让可变 preview 因取消最终解析而改变工具执行资格。错误/取消保留 incomplete preview，释放私有 scratch。

## 实现设计

1. 每请求一个私有 `Map<wireIndex, contentIndex>` 和按 contentIndex 存放的 parser 数组；这些 owner 不进入 output/snapshot。工具 start 建立 parser 与数字 generation=0；text/thinking 首次 delta 建立索引映射。普通 delta 用 Map.get，不创建 findIndex 闭包或扫描完整 content 列表。
2. 工具 delta 仅 parser.append 新 input，复用 arguments 图并递增数字 generation，事件携带 generation。没有 per-delta options/changes 数组、Promise/controller、全文 parse/stringify、open-path copy 或诊断对象。JSON 容器与必要语法 frame 按真实输入结构分配；不引入池、深度/字节上限或新修复链。
3. block stop 删除活动索引映射，工具一次 finalize，清 parser slot 和 generation，再发既有 end 事件。迟到工具 delta 不重建 parser。正常结束时对仍活动 parser 做一次 finalize，保留原先对缺少 block stop 的完整性语义；不伪造额外 delta/end。
4. finally 统一释放所有仍活动 parser、清数组/Map 和临时 metadata。中途 SDK 迭代错误、服务异常事件、abort 和 stopReason 错误继续走原有诊断/取消分类；不加备用请求或重试。公开最终/部分参数归调用者，不能通过清空其 arguments 来伪造释放。
5. 只修改相关 lookup/parser 接线。AWS 认证、region/profile、请求配置、thinking、模型能力、cache/usage 的行为保持原状。低频 finalization/disposal 与普通 delta 明确分开，源码门禁精确命名豁免，不整文件豁免。

## 完整调用链与性能约束

已读取 `docs/performance/hot-path-allocation-contract.md`。本项链路为 BedrockRuntimeClient.send/SDK stream → adapter event loop → handleContentBlockStart/Delta/Stop → parser → AssistantMessageEventStream → Agent.processEvents/prepareMessageUpdate/latest snapshot → AgentSession observer bridge → InteractiveMode → ToolExecutionComponent.updateArgs → display/layout → frame queue → ProcessTerminal.writeFrame。下游所有权、数字 generation 与快照/释放边界沿用 A/B 已审计实现，运行相关 AST/source 和 allocation/GC 门禁确认没有回退。

离线夹具仅在 SDK send 边界返回预建事件，真实 adapter/helpers/parser/EventStream 均执行；它不测 AWS HTTP/eventstream 解码，不将结果误报为整个网络传输成本。夹具精确恢复其替换的 SDK prototype 方法。只有本次记录的临时基线副本会被删除，不广泛扫描/清理资源。

## 验证顺序与验收

1. 保存旧 adapter，真实 producer 的 N/2N/4N 与不同 delta 粒度产生累计全文 parse 红灯；大字符串、宽对象分开采样。构造输入在采样前完成，同机 Node26 串行交替 A/B，分配与时间分开测，保留 sampled bytes/input byte、leading stacks、p95、CPU、peak/GC heap。
2. 语义测试覆盖并行工具、text/thinking 与工具交错和 contentIndex 映射、Unicode/escape 分割、空/截断/合法终态、遗漏 block stop、迟到工具 delta、length、异常事件、SDK 迭代失败与 abort。Agent 集成使用一致的 built ai 模块图，验证完整参数一次执行、不完整参数不执行、observer snapshot 冻结隔离。
3. 确定性计数记录输入/scanner/完整 parse 次数与字符量、parser 数、generation、append Promise、容器与活动栈；normal/abort/error 受控 GC 保持 stream/result 存活，验证 parser/raw/token/parent/stack 释放。必要返回参数由调用者保留不算泄漏。
4. 更新 provider ownership 与 AST/source 门禁，确保普通 delta 无闭包和全文重解析，同时证明最终校验与 finally 接线；先最小定向 tests，再 check/build:offline/当前 Node26 全量。运行 stream/session-event/paced-tool-args/frame-queue 下游 benchmark，不以 UI 合成 fixture 代替真实 Bedrock producer。
5. 补全方案中的实测结果和原始证据 JSON，独立 PR → 最终 head reviewer/六个 CI 分片 → 修复复审或合并 → 精确删对应分支并同步 main → 下一 T06 项。

## 执行记录

### 实现与测试诊断

每请求的 blockPositions Map 取代逐事件 findIndex 闭包与线性查找，区分 wire contentBlockIndex 和 output.content 的实际位置；toolParsers 数组仅由该请求拥有。工具增量直接 append，公开事件只有数字 generation，没有 parser/raw/index scratch。首次 text/thinking delta 的建块和工具的 start/stop 顺序保持原有协议。

block stop 一次 finalize 并释放 slot，删除索引映射使迟到工具 delta 不重建 parser。成功/length 终态对遗漏 block stop 的 parser 也执行一次既有完整性校验。错误先清 generation 并保留原有错误分类/诊断，finally 释放 parser/数组/Map；未新增恢复请求、重试、池或容量限制。

专用测试覆盖 text/thinking 与两个工具交错、wire/output 索引不同、迟到工具 delta、并发请求、empty/合法/截断参数及 omitted stop、length、服务异常事件、SDK 迭代失败和取消。Agent 集成使用与生产一致的 built ai completeness WeakSet，并验证 observer snapshot 冻结隔离和工具执行次数。

第一次定向 130 项中有一个测试错误地假设消费队列事件时，event.partial 仍处于该事件发出时的 generation。SDK fixture 的快速迭代会让生产者先行；partial 是既有 producer-owned 可变引用，而 event.toolArgsGeneration 是发出时固定值。将原位预览检查放在实际 push 边界、消费端检查事件 generation 后，专用 16/16 和 parser/provider 热路径合计 22/22 通过。未为测试增加生产等待、深复制或兜底。其余定向 129 项原本通过，完整构建后全套再统一验收。

### 分配、计数和释放

[完整 JSON 证据](../evidence/pi-150-t06c-bedrock-tool-args.json)保存五组串行交替 A/B、源码 hash、allocation stacks、peak/GC heap。Node v26.13.0 / Windows 10.0.26300；每组 2 warmup、8 timing、4 allocation runs，1024-byte sampling；provider 采样期间没有并发构建/测试。SDK send 返回预建事件，实际 adapter/helpers/parser/EventStream 执行；不把结果当作 AWS HTTP/eventstream 解码性能。

| 场景 / delta | 采样 bytes/input byte 中位：旧 → 新 | 墙钟 p95 ms 中位：旧 → 新 |
| --- | --- | --- |
| 16 KiB 字符串 / 128 | 2360.20 → 21.37 | 10.808 → 0.438 |
| 32 KiB 字符串 / 128 | 4656.93 → 16.83 | 41.116 → 0.502 |
| 64 KiB 字符串 / 128 | 9272.43 → 14.56 | 176.566 → 1.453 |
| 32 KiB 字符串 / 32 | 18546.17 → 43.32 | 172.493 → 0.912 |
| 2048 成员宽对象（28513 bytes）/ 128 | 6205.85 → 31.70 | 123.955 → 1.514 |

64 KiB 场景采样分配下降约 99.8%。N/2N/4N 为 8206/16398/32782 字符，64 字符分片：旧完整参数 parse 为 130/258/514 次，传入字符累计 544796/2138140/8470556（尚未计 repair/partial-json 扫描）；新 scanner 精确 N、终态 parse 各一次。旧新完整 producer Promise 均为 1121/2139/4187，新增普通 append Promise 为 0；普通 lookup 不再创建 findIndex 闭包。实际协议事件、JSON 容器与最终图仍是必要分配，不宣称整个 provider 零 Promise/零物化或所有 V8 flatten 严格线性。

受控 GC 保持 stream/result 存活：normal/abort/error 的 parser 弱引用均为 0，dispose 后 raw/token/stack/root/parent 全部释放；normal 的旧 preview 也可回收，abort/error 的部分 preview 仍由最终结果持有。临时旧 adapter 已按记录的唯一精确路径删除；fixture 精确恢复其替换的 SDK send 方法。

类型检查、离线构建、四个下游 benchmark 和当前 Node26 全套均通过：**401/401 执行单元成功，5341 tests / 5243 pass / 98 skip / 0 fail / 0 cancelled**。全量包括构建后实际 Agent 集成与 stream/TUI 源码门禁。stream 100000 更新合并为 1 次 snapshot/delivery；session listener Promise/wrapper/array 为 0；paced args 每 flush 一次 snapshot，缺失 generation 和语义兜底为 0，metadata/调度状态释放；frame queue 100000 请求只生成/写入 2 帧，全尺寸副本和新增 Promise/controller/wrapper 为 0，active/pending 清空。最终 PR reviewer/CI 尚待验收，未先标交付。日志与原始采样位于 `.git/pi150-t06c`。
