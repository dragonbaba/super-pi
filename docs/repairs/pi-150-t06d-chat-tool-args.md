# T06-D：Chat Completions 工具参数增量解析

日期：2026-11-04。状态：**已通过 #186 交付**。基线为 T06-C #185 合并提交 `4d82e1de7b4c62fe75483dce98d405b01764e3dd`，最终 head `6bdc04e48eca353c1818fb96d10b721a2ac298a8` 已获 Codex completed/no findings、Windows/Linux CI 6/6，相关本地与远端分支已删除，main 已同步。当前分支 `codex/t06d-chat-incremental-tool-args`，只使用 Node v26.13.0。

## 范围与事实

接入 `openai-completions.ts` 的累计 JSON 工具参数，复用已交付的共享 parser；Mistral 等剩余入口另行切片，T06 全部完成后再进入 T07。先写本方案、固定真实 producer 基线，再实施与独立 PR。等待最终 head reviewer completed 和六个 CI 成功后自动合并清分支；有问题修复推送并额外发送独立 Codex review 请求。保留用户未暂存的 patch 删除。

该 adapter 用 stream index 与 id 两个 Map 关联工具 block，支持 id/index/name 分批到达和 encrypted reasoning detail 的先后绑定。每个 function.arguments delta 加入 block.partialArgs 后完整 parse；请求迭代结束由 finishBlock 再 parse 一次。custom/grammar 有单独原始文本 buffer 和 generation，元数据先到时可能先创建 JSON 占位 block，随后转为 custom。

finishBlock 当前位于 finish_reason/abort 最终检查之前；本项不调整这些控制语义。缺失 finish_reason 的兼容规则、length/error 分类、reasoning detail、所有工具关联逻辑及 grammar 输出仍按原有边界处理。getContentIndex 的 indexOf 不创建临时对象，其工作按实际 block 数计；此次不扩展为新的索引系统。请求内稳定 helper 闭包在进入循环前创建，不是每片段创建。

## 最小实现

1. 请求私有 `Map<ToolCall, IncrementalToolArguments>` 按稳定 block 身份拥有 parser，定义在 try 外使 finally 可释放。不得以可能晚到/变更的 id/index 作为 parser 的第二套关联规则。parser/raw 不挂在公开 output graph 上。
2. 创建 JSON 工具 block 时建立 parser 并设置数字 generation=0；普通 function.arguments delta 只 append 新片段、更新 arguments 引用、递增 generation。元数据空 delta 保留现有事件行为，generation 只在实际参数变化时前进。无普通 delta 全文 parse、字符串 join/hash、深复制、新 Promise/controller、changes/options wrapper 或回退解析链。
3. finishBlock 的 JSON 分支执行一次 finalize，删除 Map entry，清 transient generation/streamIndex 后发 toolcall_end；合法 JSON 只完整解析一次，空/畸形/截断终态沿用既有 helper 与 incomplete WeakSet。custom 分支继续使用原来的 raw input 序列化规则。
4. 元数据占位 block 转为 custom 时，先 dispose 并删除该 block 的 JSON parser，再建立原有 grammar 状态；不让两种参数格式同时拥有活跃 parser。请求 finally dispose 所有尚未结束 parser 并 clear Map；catch 保持原有 output metadata 清理和错误格式化，只移除已失去来源的 partialArgs 字段清理。
5. 不引入池、字节/深度硬上限、重复认证、备用网络调用或额外重试，不改 SDK 请求/兼容参数和下游 UI。必要 JSON 节点/语法 frame 按真实输入分配；所有诊断对象只在测试/冷边界物化。
6. 完整循环复查发现既有 reasoningFields 三项数组在每个 choice.delta 内创建（包括普通工具片段）。将固定字段顺序提升为模块只读常量，补充整个 chunk loop 的数组/闭包门禁；不改变字段优先级。custom 格式切换替换了 arguments 图，generation 需前进而非重置，尤其首片 custom input 为空时；以回归测试约束该替换事件。

## 完整链路与性能证据

遵守已读取的 `docs/performance/hot-path-allocation-contract.md`。实际链路为 SDK HTTP/SSE → openaiStream → tool block 关联/参数 append → AssistantMessageEventStream → Agent.processEvents/prepareMessageUpdate/latest snapshot → AgentSession observer bridge → InteractiveMode → ToolExecutionComponent.updateArgs → display/layout → frame queue → ProcessTerminal.writeFrame。继续使用已审计的数字 generation、真正 observer delivery 才冻结快照和 owner release；源码/AST 与下游分配/GC 门禁共同验收。

离线 fetch 预先编码 SSE，只替换网络入口，实际 SDK 解码、adapter 与 EventStream 均运行。fixture body 应模拟真实 fetch 对 abort signal 的响应，不能因假 fetch 忽略取消而误判 producer 生命周期。实际 caller/result 保持存活后再进行受控 GC，区分 parser scratch 与结果仍合法拥有的 preview。

## 验证顺序

1. 保存旧 adapter 精确副本、N/2N/4N 累计全文 parse 红灯；大字符串/宽对象/不同 delta 粒度，在同机当前 Node26 做五组串行交替 A/B。输入预编码，采样期间不并发构建或测试；记录 bytes/input byte、leading allocation stacks、p95、CPU、peak/GC heap，不能只用耗时或单个 heap 差值断言性能。
2. 专用回归覆盖并行工具、晚到 id/index/name、数字 generation 与 mutable preview、空/合法/截断参数、text/thinking/工具交错、未给 finish_reason 的既有兼容边界、length/error/abort、JSON 占位转 custom、已交付 frozen snapshot。沿用 tool-argument-recovery、openai-custom-tool-generation 及既有 Chat 关联/协议合约。
3. Agent 集成保持 built ai 模块图一致，验证不完整参数不执行、合法 sibling 一次执行和 length 恢复。partial 是 producer-owned 可变引用：原位更新在 push 边界检查，消费端检查固定 event generation；不把排队 partial 当冻结 snapshot。
4. 记录 scanner/input/最终 parse 的次数和字符量、parser 数、generation、append Promise、栈/容器和 normal/abort/error retained refs。AST/source 精确守住 function delta 和 parser 普通 helper，无整文件豁免；保留 grammar 与最后 finalize/clear 接线断言。
5. 先定向 checks，再 check/build:offline/当前 Node26 全套，运行 stream/session-event/paced-tool-args/frame-queue 下游 benchmark。补全方案和 JSON 证据，独立 PR → 等最终 reviewer/CI → 修复复审或合并清分支 → 下一 T06 项。

## 执行记录

### 实现与根因验证

私有 Map 按稳定 ToolCall block 身份关联 parser，因此晚到的 id/index/name 不会另开或混淆参数状态。function delta 只 append 新片段并递增 generation，finishBlock 一次 finalize 后删除 entry，custom 转换和 finally 负责其余释放。原有 streamIndex/id 关联、finish_reason/length/error 语义、reasoning detail 和 grammar 序列化边界保留。

专项回归确认 JSON 占位转 custom 且 input 为空时，替换 arguments 对象也必须推进 generation。初版生成 `[0,0,1,2]` 会让 UI 将第二次参数图误认为未变化；修正为格式切换时递增后，该夹具生成 `[0,1,2,3]`。没有添加等待或复制来绕过 ownership。完整循环 AST 红灯还定位到原有每 choice.delta 的 reasoningFields 数组，提升为模块只读常量后普通循环不再分配该数组，字段优先级与签名保持不变。

真实 SDK SSE 测试覆盖两个并行 JSON 工具、晚到 id/index/name、text/thinking/工具交错、空与截断参数、强制和显式兼容的缺失 finish_reason、length/content_filter、abort/传输错误和 custom 转换。生产者 push 边界验证可变 root 与数字 generation，消费端仅按固定 event generation 验收；实际 Agent 的 built ai 图验证完整参数一次执行、不完整参数不执行和冻结 observer snapshot 隔离。

### 分配、计数与生命周期

[完整 JSON 证据](../evidence/pi-150-t06d-chat-tool-args.json)只收录格式切换 generation 修正和数组提升后的五组串行交替 A/B，候选 sourceHash 已逐组核对。早期 pre-transition/pre-hoist 采样仅保留为调查日志，不混入最终结果。Node v26.13.0 / Windows 10.0.26300，2 warmup、8 timing、4 allocation runs、1024-byte sampling；采样时没有并发构建/测试。

| 场景 / delta | 采样 bytes/input byte 中位：旧 → 新 | 墙钟 p95 ms 中位：旧 → 新 |
| --- | --- | --- |
| 16 KiB 字符串 / 128 | 2413.02 → 71.14 | 11.727 → 1.198 |
| 32 KiB 字符串 / 128 | 4712.86 → 67.09 | 43.865 → 2.062 |
| 64 KiB 字符串 / 128 | 9316.06 → 59.43 | 184.761 → 3.977 |
| 32 KiB 字符串 / 32 | 18734.32 → 226.11 | 181.378 → 5.676 |
| 2048 成员宽对象（28513 bytes）/ 128 | 6257.28 → 78.80 | 128.492 → 2.635 |

64 KiB 场景采样分配下降约 99.4%。N/2N/4N 输入为 8206/16398/32782 字符、64 字符分片：旧完整参数 parse 为 130/258/514 次，累计输入 544796/2138140/8470556 字符（不含 repair/partial-json 的额外扫描）；新 scanner 精确 N，最终 parse 各一次。完整 SDK/adapter/EventStream Promise 数旧新同为 2833/5521/10897，普通 append Promise=0；不能把前者说成零 Promise。必要 SSE 解码、协议事件、JSON 节点和最终结果物化保留，不声称所有 V8 字符串 flatten 都严格线性或 CPU 为零。

normal/abort/error 受控 GC 保持 stream/result 活着，parser 弱引用均释放；dispose 后 raw/token/stack/root/parent 为空。生命周期采样从首个非空参数 delta 记录 preview，避开 Chat 的 metadata-only 事件；正常旧 preview 可回收，异常部分 preview 仍归结果拥有。私有 Map 在 finalize/custom 转换时立即删除 entry，finally 清余项；临时旧 adapter 已按记录的唯一精确路径删除。

初始定向 73/73、边界修正后的 29/29、构建后实际 adapter/Agent 专用 19/19、类型检查和离线构建均通过。四个下游 benchmark 与当前 Node26 全套也通过：**402/402 执行单元成功，5362 tests / 5264 pass / 98 skip / 0 fail / 0 cancelled**。stream 100000 更新合并为 1 次 snapshot/delivery；session listener Promise/wrapper/array 为 0；paced args 每 flush 一次 snapshot、generation 缺失和语义兜底为 0，metadata/调度状态释放；frame queue 100000 请求仅 2 次生成/写入，无全尺寸副本或新增 Promise/controller/wrapper，active/pending 清空。最终 head `c21e4d43da9133828f9790522d76612002271fe4` 已获 Codex completed/no findings、CI 6/6；#186 合并为 `fd14e54638b24cbeb9aae8207cbceebc20bd74ae`，对应本地/远端分支已删除、main 已同步。日志与原始采样位于 `.git/pi150-t06d`。
