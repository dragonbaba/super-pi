# T06-F：Pi Messages 参数解析、终态权威对象和 SSE 生命周期

状态：已通过 #188 交付。T06-E #187 最终 head e126710468e1ca49089b6860825e0f51762d5579 已获 Codex completed/no findings、CI 6/6，合并为 a95e9dc3d36f1a29a6d26ac01ffd86147d08093a；对应本地/远端分支已删除，main 已同步。本项分支 codex/t06f-pi-messages-incremental-tool-args，从该合并 SHA 开始，仅 Node v26.13.0。

## 源码事实与范围

pi-messages.ts 并非完整对象替换型 producer：createEventConverter 的 toolJson Map 将每个 delta 累加后 parseStreamingJson。只有 toolcall_end 才使用服务器发送的权威 arguments 对象，且它可以修正流式预览。因此普通 delta 需要迁移到私有增量 parser，终态不能拿本地累计文本覆盖服务器对象。

传输链另有普通读取的 decoder options、累计 buffer.replace/indexOf、split/find 行数组和闭包、convertEvent 的对象 spread。完整调用链审计要求一并去除这些控制分配和反复扫描；SSE wire JSON 解析、最终 host/protocol 事件、真正 observer delivery 的冻结快照依然是必要物化。Google/Vertex 直接用 part.functionCall.args 创建工具对象，没有累计文本解析，保持 replacement-object。

本项聚焦内置 Pi Messages adapter；SDK streamProxy 是另一个可选接入，存在旧累计 partialJson，但不在 packages/ai/src/api 内置 producer 链上。不将它说成已迁移，另行记录后续范围，不顺手扩展本 PR。

## 所有权与最小实现

1. 将 converter 变成单请求 owner，持有 partial 和按 contentIndex 的私有 parser 数组，提供 convert/dispose 两个操作。固定 owner 在请求入口创建，不增加每事件闭包、状态包装或注册表。
2. toolcall_start 创建 block（数字 generation=0）和 parser；toolcall_delta 只 append 本次字符串，generation 加一。parser/raw/stack 不进入公开消息。与当前 converter 一样按 contentIndex 关联，不引入 id 查找兜底。
3. toolcall_end 保留白名单 id/name/arguments/thoughtSignature/namespace 字段；直接接受 wire arguments 为权威对象，dispose parser 并清 slot/generation。不再 parse/序列化此对象或把本地 raw 作为备用结果。保留原型字段隔离。
4. 服务器 done 未发 toolcall_end 时，按既有行为保留可以恢复的参数：剩余 parser 仅在 done 冷边界 finalize 一次，空/截断继续采用共享 helper 的 incomplete 标记；不捏造 toolcall_end、不把完整 JSON 擅自视作协议错误。服务器 error 与本地 throw/abort/EOF 路径释放剩余 parser；原有本地错误返回空 content 的分类和 timestamp 语义保持不变，不自动重试。
5. 普通 wire event 在解析后的私有对象上附加 host partial/数字 generation，避免再次 spread/包装；terminal 继续物化公开协议需要的 done/error/toolcall_end。只复用当前请求独占的 wire event，不池化、不复用已交付对象。
6. implementation/lazy ownership 声明一起迁移到 mutation-with-generation，更新 registry contract 与 UI ownership 矩阵；只属于 host metadata，不进入 model identity、请求 payload 或持久化。

## SSE 增量扫描与释放

保持当前 first-data-line 规则和 [DONE] 忽略规则；真正完成仍要求 done/error，否则 EOF 报错。不要借此次优化增加 multiline 拼接语义或引入新容量/深度限制。

TextDecoder 使用模块固定 options。逐次只扫描本次 decoded chunk，使用几个数字/布尔状态识别 LF/LF、CRLF/CRLF 及混合分隔符，跨 read 保持状态。累计事件 raw 只拼接本次 segment，不再扫描累计 buffer 或全量 replace；只有完整事件到达时进行一次必要 parse。不能仅将 indexOf 起点后移却继续触碰/flatten 完整累计 rope，也不引入无界 chunk/行数组。

parsePiMessagesEvent 以索引寻找首个 data 行，不 split/find/inline callback；输入 event JSON 只 parse 一次。处理跨 byte UTF-8、跨 read CRLF、EOF 最后一段和未知 event 行；保留当前终态转换边界。

reader finally 清 raw/decoded 引用，cancel 尚未消耗的 body 并 releaseLock，避免 terminal event 早退后继续保留 reader。沿用 fetch 的 signal 取消，不创建逐 read AbortController/Promise race。只吞 reader.cancel 的关闭清理错误，原始请求/协议异常仍由 wrapper 返回；不新增正常数据路径 catch/retry。converter 的 finally dispose 覆盖全部退出路径。

## 审计与验证门禁

链路：fetch body → reader/decoder/SSE → converter/parser → EventStream → Agent prepare/latest observer snapshot → AgentSession 同步 bridge → InteractiveMode → ToolExecutionComponent generation → display/layout → frame queue → ProcessTerminal.writeFrame。沿用已经审计的下游 owner，运行对应 AST/source 与实际下游分配/释放门禁，不整文件豁免。

1. 固定旧 adapter 精确副本，原生 SSE fixture 预编码输入，仅替换 fetch；旧实现 N/2N/4N 红灯。正常权威对象终态的参数全文 parse 应为 0（只有必要 wire JSON parse），遗漏 toolcall_end 时最终本地 parse ≤1；不能照搬其他 adapter 的一律一次断言。
2. 语义：并行/交错工具、text/thinking signature、权威终态与预览不同、空/不完整预览、有效/无效 JSON 无 toolcall_end、length、服务器 error、本地错误/abort/EOF、start 后直接 end、原型字段、数字 generation、Agent 完整执行/不完整拒绝/已交付冻结快照。fixture body 按需读取，验证早退取消/解锁，不把已 EOF 无 cancel callback 当泄漏。
3. 普通 converter delta 与 reader scanner 的 AST/source 禁止完整 parse/深复制/spread/临时数组/闭包/options；只对必要 wire 解码和协议对象物化明确边界。大单事件跨小 reads，统计本次 chunk 字符扫描总量，保证 N/2N/4N；正常/abort/error 保持 stream/result 活着做受控 GC，parser/raw/stack 和 reader 释放。
4. 同机串行五组交替 A/B，记录 source hash、实际 parser 扫描、参数 parse、Promise、leading allocation stacks、bytes/input byte、p95/CPU、peak/GC heap。采样不与构建/测试并行。旧 baseline 用后按精确路径删除。
5. 最小定向→check/build:offline→四个串行下游 benchmark→当前 Node26 全套。写入方案与 JSON 证据，再独立 PR/主动 Codex review；等待最终 head reviewer completed 无问题与六个 CI success 后合并、按精确身份删分支、同步 main；若审核有问题则修复推送并额外独立请求复审。

## 执行记录

### 行为与生命周期

私有 converter owner 保存 partial/parser 数组，固定 convert/release/dispose helper 每请求创建一次。参数 append 与数字 generation 只处理新片段。正常 toolcall_end 接受服务器权威对象并 dispose；缺失 end 的 done 才 finalize 一次。start 复用工具下标或切换为 text/thinking 时，先释放旧 owner，避免 done 写回被覆盖的 block。服务器 error 保留部分结果；本地异常/abort/无 terminal EOF 保持原有空 content 错误结果，finally 清 transient generation 和 scratch。

普通 wire event 原位附加 host partial/generation，不再 spread 包装。SSE 仅扫描当前 decoded chunk，通过三个 primitive separator 状态识别 LF/CRLF 跨块分隔；累计 raw 只在完整事件时解析，不再全量 replace/搜索。first-data-line 与 [DONE] 非终态语义不变，finally 清 buffer/decoded、cancel body、releaseLock。没有增加容量限制、深度上限、重试、池或兜底链。

初始 Agent observer 测试暴露 fixture 漏发 start，补齐真实协议起始事件后通过；不是在生产链加等待/复制。类型检查要求先将带 host generation 的对象声明为 StreamingPiToolCall 再赋给公开 content，未扩展 wire ToolCall 类型。构建后 **99/99** 定向检查通过，覆盖权威纠正/空对象、交错工具与 Unicode、缺失 end 的完整/截断/空参数、length、服务器与本地错误、abort/EOF、slot 替换、text/thinking 签名、原型隔离、Agent 执行/拒绝及冻结快照、SSE UTF-8/CRLF 各分块和早退取消/解锁、ownership registry/UI 矩阵。

下游 paced replacement-object 夹具原先固定使用 Pi Messages，ownership 改为 mutation 后会误报每 flush 更新数量。该合成场景改用仍为 replacement-object 的 Google adapter，断言不放宽；实际 Pi Messages producer 由本项原生 SSE/Agent 与扫描/GC 证据单独证明。

### 性能与释放证据

[完整 JSON 证据](../evidence/pi-150-t06f-pi-messages-tool-args.json)：Node v26.13.0 / Windows 10.0.26300，五组串行交替 A/B，2 warmup、8 timing、4 profile、1024-byte sampling，采样时无并发构建/测试。候选 sourceHash 全组一致；旧 adapter 仅把 regex import 路径改到基线 helper 快照，避免候选删除 CRLF export 使旧实现无法加载。两个基线文件均记录 hash 后按精确路径删除。

| 场景 / 分片 | 采样 bytes/input byte 中位：旧 → 新 | 墙钟 p95 ms 中位：旧 → 新 |
| --- | --- | --- |
| 参数 16 KiB / 128 | 2371.08 → 28.16 | 10.978 → 0.762 |
| 参数 32 KiB / 128 | 4676.05 → 26.60 | 43.476 → 1.169 |
| 参数 64 KiB / 128 | 9279.03 → 25.72 | 181.915 → 3.196 |
| 参数 32 KiB / 32 | 18614.90 → 85.17 | 179.098 → 2.672 |
| 2048 成员宽对象 / 128 | 6209.15 → 41.42 | 130.089 → 2.129 |
| 大终态 SSE 16 KiB / 32 | 296.66 → 33.80 | 1.269 → 0.837 |
| 大终态 SSE 32 KiB / 32 | 550.15 → 31.61 | 2.870 → 1.046 |
| 大终态 SSE 64 KiB / 32 | 1061.41 → 31.10 | 8.350 → 1.384 |

参数 N/2N/4N 为 8206/16398/32782 字符，旧全文 parse 为 129/257/513 次、累计 536590/2121742/8437774 字符；新 scanner 精确 N，正常权威终态本地参数 parse=0，必要 wire JSON 解码保留。普通 append Promise=0；整个传输 Promise 1746/3410/6738 → 1748/3412/6740，增加固定 2 个属于每请求 reader.cancel 释放边界，不是每 delta 创建。

大终态事件按 32-byte reads：wire 长度 8603/16795/33179，新 charCodeAt 扫描数精确等长；旧 buffer.replace 输入累计 1089491/4274899/16937171 字符，新为 0；旧 line arrays 各 3，新为 0；decoder options 269/525/1037 → 各 1。早退 reader 旧实现仅解锁未取消，新实现 cancelled=true/locked=false；wire 计数与 allocation/timing 独立采集，计数 hook 不混入性能样本。

normal/abort/error 受控 GC 保持 stream/result 活着，parser 和首次 preview 弱引用均释放，dispose 后 raw/token/stack/root/parent 为空。Pi 本地错误结果原本为空 content，所以不会保留 preview；不能套用其他 adapter 仍由结果拥有 partial preview 的解释。服务器 error 的 preview 仍属其部分结果，行为测试单独覆盖。私有数组与公开 generation 在所有退出路径释放，所有必要最终结果仍由 caller 拥有。

类型检查、离线构建和四个下游 benchmark 通过；当前 Node26 全套 **404/404 执行单元成功，5418 tests / 5320 pass / 98 skip / 0 fail / 0 cancelled**。stream 100000 更新合并为 1 次 snapshot/delivery；session listener Promise/wrapper/array=0；paced 每 flush 一次 snapshot，generation 缺失/语义兜底=0，metadata/调度状态释放；frame queue 100000 请求只生成/写入 2 帧，active≤1，完整副本/新增 Promise/controller/wrapper=0，active/pending 最终清空。日志在 .git/pi150-t06f；最终 head ecccb60013e733be36aed57072ceacc0b91c28fc 的 Codex 审核 completed，配套同 head 无问题回执且无行内/正式 review 发现（汇总布尔值为空，不等同于 false）；CI 6/6 成功。#188 合并为 521f84f2316f19548c3f8e76021e808d1c0f1f60，对应远端/本地分支已删除，main 已同步。内置 API producer 范围的 T06 已随本项合并交付；可选 SDK streamProxy 旧路径已明确列为范围外后续记录，不冒称全仓都已迁移。
