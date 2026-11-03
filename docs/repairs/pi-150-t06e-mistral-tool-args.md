# T06-E：Mistral 参数增量解析与剩余入口核对

日期：2026-11-04。状态：**已通过 #187 交付**。基线为 T06-D #186 合并提交 `fd14e54638b24cbeb9aae8207cbceebc20bd74ae`，最终 head `c21e4d43da9133828f9790522d76612002271fe4` 已获 Codex completed/no findings、CI 6/6，相关本地/远端分支已删除，main 已同步。当前分支 `codex/t06e-mistral-incremental-tool-args`，只使用 Node v26.13.0。

## 范围与核对结果

Mistral 当前通过原生 `v1/chat/completions` HTTP/SSE → `readMistralEvents` → `consumeChatStream`，不是 Conversations SDK 的另一条备用调用。工具按 tool index（缺失时按该 chunk 的位置）关联，支持 id/name 后到；string arguments 累计到 partialArgs 后逐片全文 parse，object arguments 先 stringify 成当前片段再追加。保持该既有协议解释，不凭 union 类型引入整段 replacement 语义。

全局源码检索还发现 `pi-messages.ts` 的 toolcall_delta 在 toolJson Map 中累计文本后完整 parse。虽然它的 ownership 标签为 replacement-object，实际仍属于累计解析入口。**新增独立 T06-F**，在 E 合并后单独审计其权威 toolcall_end 对象、hydrator 生命周期和 ownership 迁移；不得把 metadata 标签当作排除证据或在 E 中顺手改写。Google/Vertex 等接收完整 arguments 对象的入口继续按实际实现核对。E 完成后 T06 尚不能标交付。

## 完整调用链与最小设计

已读取 `docs/performance/hot-path-allocation-contract.md`。本项审计：request header deadline/caller signal → fetch body/reader → incremental SSE boundary scan → parseMistralEvent → consumeChatStream/tool lookup → parser → EventStream → Agent latest snapshot → AgentSession observer bridge → InteractiveMode/ToolExecutionComponent → display/layout → frame queue → terminal write；结束、取消、异常与 release 均在范围内。

1. consumeChatStream 持有私有 parser 数组，按 output contentIndex 保存；现有 toolBlocksByKey 只关联 wire tool index。工具创建时设置 generation=0，普通 string delta 只 append 新输入、递增数字 generation；object 仅 stringify 当前到达片段，不重新序列化累计历史。parser/raw 不进入 output graph。
2. 迭代结束按既有顺序结束 text/thinking、每个工具一次 finalize 并清 parser slot/generation，再发 toolcall_end。缺失 finish_reason、length、错误和取消仍交由原有 wrapper 判断，不增加调用/重试/备用解析。finally dispose 所有剩余 parser，清私有数组/工具索引，清公开临时 generation；catch 不再负责已消失的 partialArgs。
3. 完整传输审计发现两个普通事件分配：parseMistralEvent 为已解析 wire JSON 再包一层私有 `{data}`，decoder.decode 每次创建 `{stream:true}`。前者改为私有链直接传递已解析 chunk、后者提升为固定只读选项；不改变公共事件/API。readMistralEvents finally 清累计 buffer，保持现有 cancel/releaseLock 与 abort listener 解绑。
4. 保留现有单 read chunk 1 MiB、单 SSE event 1 Mi 字符容量与原错误，不添加 per-tool 累计上限或深度限制。单行 SSE 普通路径不创建 data-line 数组；真实多行 SSE 的拼接属于有界协议解码，继续覆盖其语义。必要 wire JSON/工具事件/结果节点与异步 reader 成本单列，不能宣称整条传输零 Promise/零分配。
5. 不改 tool index/id fallback 规则、reasoning/text 顺序、Mistral 认证/headers/deadline/HTTP 错误行为和缓存统计，不增加过度防御、池化或全局可变 scratch。

## 验证顺序

1. 固定旧完整 adapter 副本和真实原生 SSE 夹具，证明 N/2N/4N 累计完整 parse 的红灯；预建 bytes 后采样，不能以 UI 构造事件代替 Mistral producer。
2. 语义覆盖并行工具和晚到 id/name、无 index 时既有位置规则、string/object 输入、text/thinking 交错、Unicode/escape 分割、空/截断终态、length、无 finish_reason、HTTP/SSE/传输异常与 abort。沿用 mistral-header-timeout、mistral-transient-retry 和原生 wire 合约，验证 capacity、CRLF、多行和 [DONE] 等现有规则没有改变。
3. Agent 集成与 built ai 使用同一 completeness WeakSet，验证完整参数一次执行、incomplete 不执行、observer 冻结隔离。可变 partial 在 push 边界检查，消费者检查固定 event generation；不会增加 producer 等待或复制以迁就测试。
4. AST/source 明确 ordinary argument append、chunk loop、SSE reader 和 event parser 的分配边界；去掉私有 `{data}` wrapper 和 decoder options 的逐事件构造。五个已迁移累计 adapter 的 ownership 门禁统一证明数字 generation 与 scratch 释放，不留下空的 legacy 断言循环。
5. 五组同机 Node26 串行交替 A/B，记录输入/scanner/final parse、每 delta Promise、protocol envelope/options 构造、leading allocation stacks、bytes/input byte、p95、CPU、peak/GC heap。normal/abort/error 保持 stream/result 活着做受控 GC，区分结果拥有的 preview 与 parser/raw/stack/map 应释放的引用。
6. 先定向检查，再 check/build:offline/当前 Node26 全套和 stream/session-event/paced-tool-args/frame-queue 下游 benchmark。完成证据 JSON 后独立 PR，等待最终 head reviewer completed 和六个 CI 成功；有问题修复推送并额外独立 Codex review，无问题自动合并、精确清分支、同步 main，然后进入 T06-F。保留用户未暂存的 patch 删除。

## 执行记录

### 实现和协议边界

Mistral 私有 parser 数组按稳定 contentIndex 保存；toolBlocksByKey 保留原有 wire index/缺失 index 时 chunk 位置规则。普通参数片段只 append 并递增数字 generation，迭代完成一次 finalize，finally 清所有 parser/数组/索引和临时 generation。object 输入仍 stringify 当前片段后追加。原生 SSE 直接交付解析后的 wire 对象，移除了私有 data 包装；TextDecoder 使用固定 options，finally 清 buffer 并解绑/取消/释放 reader。

必要 wire schema、header deadline、既有 read chunk/event 容量校验保留；没有增加深度/累计参数上限、重试、备用解析或对象池。保留 HTTP/SSE/finish_reason 错误与取消传播。完整链 audit 包括文本/推理 helper、Unicode 清理、成本计算、EventStream 和既有下游；文本正规化只处理本次片段，协议事件和必要 JSON 节点仍按输入物化。

初始定向 91/91，构建后的 adapter/Agent 及新增 SSE 边界 25/25。新增用例覆盖 CRLF 与逐 byte UTF-8、multiline data、EOF 未终止事件、原有 chunk/event 容量和非法事件形状；验证错误分类及 reader 解锁/取消。首次取消断言发现 fixture 默认预读已关闭流，关闭流的 cancel 不触发 underlying cancel callback；夹具改为 highWaterMark=0 按需读取，使失败确实覆盖尚打开 body 的取消，不改变生产语义。

### 分配、计数和释放

[完整 JSON 证据](../evidence/pi-150-t06e-mistral-tool-args.json)保存五组同机串行交替 A/B，所有候选 sourceHash 与最终生产文件一致。Node v26.13.0 / Windows 10.0.26300，2 warmup、8 timing、4 allocation runs、1024-byte sampling；采样期间没有并发构建/测试。预编码 HTTP/SSE 输入，真实 native decoder/adapter/EventStream 均执行。

| 场景 / delta | 采样 bytes/input byte 中位：旧 → 新 | 墙钟 p95 ms 中位：旧 → 新 |
| --- | --- | --- |
| 16 KiB 字符串 / 128 | 2365.24 → 31.86 | 10.792 → 0.636 |
| 32 KiB 字符串 / 128 | 4670.33 → 29.96 | 42.568 → 1.085 |
| 64 KiB 字符串 / 128 | 9281.57 → 26.60 | 179.951 → 2.001 |
| 32 KiB 字符串 / 32 | 18605.09 → 97.14 | 176.049 → 2.987 |
| 2048 成员宽对象 / 128 | 6218.09 → 44.25 | 123.993 → 1.958 |

64 KiB 场景采样分配下降约 99.7%。N/2N/4N 为 8206/16398/32782 字符、64 字符分片：旧完整参数 parse 为 130/258/514 次，累计输入 544796/2138140/8470556 字符（不含 repair/partial-json 额外扫描）；新 scanner 精确 N，最终 parse 各一次。完整传输 Promise 数旧新同为 1737/3401/6729，普通 parser append Promise=0。仍保留协议 JSON 解码、异步 reader/EventStream Promise、必要事件和 JSON 节点；不宣称全链零分配或所有 V8 字符串 flatten 都线性。

normal/abort/error 受控 GC 保持 stream/result 活着，parser 弱引用全部释放，dispose 后 raw/token/stack/root/parent 清空。正常旧 preview 可回收；异常部分 preview 仍归结果拥有。私有索引/数组在 finally 清空，临时 baseline 已按唯一记录的精确路径删除。源码门禁约束普通 append 和 SSE wrapper/options 构造，下游 benchmark 单独覆盖实际 observer/UI/frame 链，不能将 UI 合成事件当作 producer 解析证明。

类型检查、离线构建和四个串行下游 benchmark 均通过；当前 Node26 全套：**403/403 执行单元成功，5389 tests / 5291 pass / 98 skip / 0 fail / 0 cancelled**。stream 100000 更新合并为 1 次 snapshot/delivery；session listener Promise/wrapper/array=0；paced args 每 flush 一次 snapshot、generation 缺失/语义兜底=0，metadata/调度状态释放；frame queue 100000 请求仅 2 次生成/写入，active≤1，无全尺寸副本或新增 Promise/controller/wrapper，结束 active/pending 清空。最终 head `e126710468e1ca49089b6860825e0f51762d5579` 已获 Codex completed/no findings、CI 6/6；#187 合并为 `a95e9dc3d36f1a29a6d26ac01ffd86147d08093a`，对应本地/远端分支已删除，main 已同步。日志位于 .git/pi150-t06e。T06-F Pi Messages 仍需单独先行设计、实现与验收；T06 不在此提前标交付。
