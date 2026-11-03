# T04：会话追加失败一致性

日期：方案 2026-11-03，实施记录更新 2026-11-04。状态：**方案先行，已实施，验收中**。基线：已合并 T03 #179，`1702ac609ee3d4262196295416286b0397e824e3`；分支：`codex/t04-session-append-consistency`。仅使用当前 Node 26.13.0。以下设计部分在生产代码修改前写入；执行结果在末尾单独追加。

## 目标与证据台账

SessionManager 只有在持久化成功，或现有策略明确允许暂存尚无对话的初始化条目时，才能确认一次追加。失败必须保留原始异常，撤销该条目的内存索引；如果文件可能已经改变，则要求显式重载或开始新会话后才能继续写入。

| 已观察事实 | 推论及验证方式 |
| --- | --- |
| `_appendEntry` 在 `_persist` 前修改数组、计数、byId 和 leaf | 注入真实 fs 失败，对照磁盘、getEntries/getEntryCount/getEntry/getLeafId；失败条目不得成为上下文或分支父节点 |
| `branchWithSummary` 提前修改 leaf | 必须移除提前赋值；以不同于当前 leaf 的目标分支复现，失败后仍指向原 leaf |
| `_persist` 先补换行再序列化 | 序列化失败也可能写文件；改为先序列化，再一次写入包含可选分隔符的记录 |
| 首次 flush 使用 exclusive link 安装临时文件 | 安装前失败可以重试；安装后清理/关闭失败不能假定目标不存在；仅失败路径核对目标是否存在 |
| 后续 appendFileSync 隐藏打开/写入/关闭阶段 | 用显式 fd 区分打开失败与写入/关闭结果不确定；fd 关闭一次，双重失败保留写入异常 |
| label 映射在 `_appendEntry` 返回后更新 | 沿用现有顺序，无需复制 label maps |
| 现有 operation crash fixture 在 appendFileSync 注入半条历史记录 | 随写入 API 调整该测试切点，保持相同真实故障语义，不在生产代码加故障开关 |

这张表是实现前证据；测试执行结果单独记录，不将源码推论写成已验证结果。

## 生产调用链与所有权

已审计：Agent.processEvents → critical event delivery → AgentSession._handleAgentEvent → appendMessage/appendCustomMessageEntry → SessionManager._appendEntry → _persist → 首次原子安装/后续 JSONL 追加 → 文件描述符释放。普通 delta、latest observer、UI 帧队列不改动。Agent 的实时消息及 UI 通知可能早于持久化，本项不承诺回滚已经显示的消息或外部工具副作用。

其他入口包括启动的 model/thinking/sessionInfo，扩展 custom/label，Bash 结果，compaction，branch summary 与 runtime permission。统一在 SessionManager 持久化所有者处理，调用者继续收到原异常。branch summary 的提前 leaf 修改需在该入口修正。

Protected operation 在执行前调用 ensureOperationStorage，完成后通过 appendCustomMessageEntry 发布 receipt notice。结果不确定时也必须阻止 ensureOperationStorage 及 createBranchedSession，避免把旧内存状态当作新写入依据；已有 durable receipt 不回滚，不自动重放外部操作。operation-journal 共用的 atomic-session-file helper 保持现有协议。

## 最小实现

1. 在 `_appendEntry` 保留原 leaf 这一原始值，失败时 pop 本次尾项、减少计数、删除本次 byId、恢复 leaf；不复制历史或 maps，不改变 historyGeneration。
2. 增加一个 owner 级 boolean 表示写入结果不确定。序列化和 open 失败不设置；write/close 失败设置。后续写入在同一所有者边界抛错，读取仍可用，不自动重试、换路径或截断。
3. 常规追加先构造单条 JSONL（必要时前置一个换行），再 open/write/close；成功才清除 separator。close 必须执行一次，write 和 close 同时失败时传播最初 write 异常。
4. 首次 flush 与 ensureOperationStorage 共用一个小方法；成功才设置 flushed。原子安装失败时仅检查目标是否存在，存在则结果不确定；不存在允许下一次显式追加。保留 exclusive 安装，不能覆盖现有目标。
5. newSession 清除不确定状态；成功的 setSessionFile 重载后清除。失败重载不得解除写入限制。已有 loader 可忽略不完整尾行；下一次追加通过 separator 隔开原始尾行，不能自动删除或重写证据。
6. 移除 branchWithSummary 的提前 leaf 赋值。结果不确定时不允许 fork；成功切换新分支文件后清除旧 separator 状态。已有 fork 安装失败的独立事务设计不在本项扩大重写。

必要校验只有文件写入边界和一个不确定状态检查。无通用事务框架、error wrapper、备用存储、后台重试、锁轮询或对象池；原子 helper 的目录 fsync 策略不变。本项不把普通追加承诺为断电持久化，也不支持多个 writer 并发修改同一会话文件。

## 故障验收矩阵

| 切点 | 内存 | 磁盘及后续行为 |
| --- | --- | --- |
| 首次安装前失败 | 原条目/leaf/count/index | 目标不存在；允许显式重试，临时文件释放 |
| 首次安装后失败 | 回滚本次追加 | 原始目标保留；阻止继续写，重载采用实际已安装内容 |
| JSON 序列化失败，包括无末尾换行的文件 | 原状态 | 零文件写入；允许修正输入后再追加 |
| 打开失败 | 所有 append 入口保持原状态，label/branch 不提前提交 | 文件不变；恢复 I/O 后可再次追加 |
| 部分写入或 write 抛错 | 原状态、无失败对象残留 | fd 关闭一次；禁止追加、operation storage、fork；重载恢复有效 JSONL，不截断尾行 |
| 写成功但 close 抛错 | 原状态 | 保留完整记录，重载后恢复该记录并使用其 id 作为父节点 |
| write 与 close 都失败 | 原状态 | 保留首个异常，禁止继续写入 |
| 重载失败 / 显式 newSession | 失败重载仍限制写入 / 新会话新所有权 | 无隐式修复或外部操作重放 |

扩展真实文件测试及 operation notice/recovery 回归。Windows 不伪造 Linux protected-operation 支持，沿用现有 capability predicate，由 Linux CI 执行真实 crash/recovery。保留已有首次用户消息、session manager、branch、compaction 回归。

## 性能契约与测量

已阅读 hot-path-allocation-contract 全文。正常追加保持 O(单条记录长度)，不扫描/复制历史；只在首次初始化 flush 沿用现有 `_hasConversation` 扫描与原子全文件写入。新增保存状态为原始 leaf 引用及 boolean，没有每次 Promise、闭包、AbortController、数组、Map、Set、spread 或包装对象。

增加 `scripts/bench/session-append.ts`，同一 fixture 对照基线与候选，历史 0/1,000/10,000 条，实际文件追加。分开测 CPU 与 inspector allocation sampling，串行运行五组配对，记录 Node/OS、warmup、次数、采样间隔、模块 SHA/源文件哈希。基线使用按精确路径登记的 detached worktree，结束后删除该任务资源。

- 确定性计数：每次一个 JSON.stringify、一个文件记录写入、历史数组元素读取为零；源/AST invariant 限制常规方法的新增异步对象、闭包、容器及历史扫描。初始 flush 是明确点名的生命周期例外。
- 分配证据：inspector HeapProfiler sampling，包括 minor/major GC 已回收分配；报告 bytes/append 与主要栈，不能用净 heap delta 替代。
- 生命周期：失败条目及大 payload 通过 WeakRef 和受控 GC 验证，在仍存活的 manager 中不可达；成功条目由 manager 保留，newSession 后释放。真实 fs 故障测试另外验证 fd 关闭与原始文件保持。
- CI 运行结构计数/生命周期 smoke；既有事件链 source invariants 和 session event allocation benchmark 用作调用链回归，不能替代新磁盘追加基准。

先跑最小故障复现，修复后跑相关 session/operation 与热路径门禁，再跑 check、build:offline、当前 Node26 全量测试和新 PR 最终提交的 Linux/Windows CI。发生失败先定位具体根因，不切换 Node 版本。

## 执行顺序与交付

1. 写入本方案（本次变更），再增加可失败的故障回归与基准。
2. 在基线上记录复现和计数/分配/引用证据，再实施最小 owner 修复。
3. 完成候选验证，补充真实结果、限制与性能差异；更新总计划 T03 已交付、T04 待验收。
4. 只提交本项文件，创建独立 PR，等待该 head 的检查结果。用户的未暂存文件删除保持原样。新 PR 未获合并授权前不合并。

## 执行结果

### 故障复现与实现

基线新增测试首次运行 16 项均未通过。其中安装前后失败、9 个追加入口及序列化失败实际复现了内存残留；3 个 fd 关闭断言依赖候选的显式 fd 边界，不能把基线未调用这些切点算成独立故障复现。实现后追加失败恢复 entries/count/byId/leaf，label 更新仍在确认追加之后；branchWithSummary 不再提前移动 leaf。

定向验收 36 项：27 通过、9 项沿用 Linux protected-operation 能力条件在 Windows 跳过、0 失败。包含全部 16 项新文件故障测试、2 项结构/GC 门禁、既有首次消息持久化和 operation 回归。新增 receipt notice 的真实部分写入测试由 Linux CI 执行，未用平台伪装绕过生产限制。

修正过两个测试假设：Windows 可以成功打开目录，写入时才报错，故明确的 open 失败改用移走任务目录使父路径不存在；JSONL 不保存 undefined 属性，重载比较采用 JSON 表示。没有更换 Node 或放宽生产失败语义。

额外的冷路径检查：setSessionFile 失败时，loader 可能已替换部分状态，因此保留写入限制，成功重载或 newSession 才解除。普通序列化/open 错误仍不触发该限制。首次原子安装 helper 保持原实现；本项的 fd 单次关闭保证和计数针对常规追加，不扩张为该共享 helper 所有清理失败的保证。

### 性能与引用证据

完整数值、五组原始配对、采样栈和限制见 [JSON 证据](../evidence/pi-150-t04-session-append.json)。基线 SHA 如上；候选由证据中的生产源码 SHA-256 精确标识，避免提交内嵌自身 SHA。Windows 10.0.26300、Node v26.13.0，单条消息固定约 400 字符，已加载历史 0/1,000/10,000，warmup 64，每组 4,096 次追加，五组串行配对；CPU/时间与 inspector 分配采样分开，采样间隔 1,024 字节，包含 minor/major GC 已回收对象。初步 512 次测量的 CPU 量化误差明显，正式采样增加到 4,096，未挑选较好的轮次。

| 历史条目 | 采样 bytes/append，基线 → 候选（五组中位数） | CPU µs/append，基线 → 候选 | 墙钟 p95 ms，基线 → 候选 |
| --- | --- | --- | --- |
| 0 | 2,666.79 → 2,449.13（−8.16%） | 72.75 → 76.17 | 0.1174 → 0.1149 |
| 1,000 | 2,593.75 → 2,378.80（−8.29%） | 76.42 → 76.42 | 0.1091 → 0.1152 |
| 10,000 | 2,397.50 → 2,207.14（−7.94%） | 79.83 → 79.83 | 0.1158 → 0.1134 |

1,000 条历史的墙钟 p95 增加 5.59%，绝对值约 6.1 µs；Windows CPU 计数和文件系统时延有波动，不将本结果宣传为稳定提速。修复未使用对象池，不套用对象池的改进准入阈值。分配主体仍是既有单条 JSONL、fs 字符串处理、ID、timestamp 与会话 entry；没有新增整段历史副本或按事件生成的异步状态。

每组每种历史确定性计数均为：4,096 次 stringify、4,096 次文件记录写入、历史元素读取 0；候选显式 open/close 各 4,096、残留 fd 0。基线的 open/close 在 Node 内部执行，不能把未被 JS 拦截的计数 0 理解为没有系统调用。AST 门禁检查常规三个方法的调用目标、同步属性、闭包/容器/循环，以及首次 flush helper 仅在 `!flushed` 的 then 分支出现。

受控 GC 在 manager 仍存活时检查失败 entry 与 1 MiB 逻辑消息 payload：基线保留 2 个引用，候选 0；newSession 后两者均为 0。成功 entry 在 owner 存活时保留 1，newSession 后为 0。字符串逻辑长度不是物理堆占用估计。磁盘部分写入、异常时 fd 释放和原始尾行保留另由真实文件测试证明。

事件链回归使用既有 benchmark：100,000 updates、10,000 warmup，直接 message/tool 更新及 coalesced observer → AgentSession → InteractiveMode 的普通交付均维持每次 Promise/拒绝观察者/状态报告为 0、终态正确；仍存在的上游 observer 调度采样分配如实保留，未宣称整条链零分配。本项不改这段交付代码。

### 检查状态

Node 26 类型检查、离线构建及上述定向测试已通过。全量 **392/392 执行单元成功，5,230 tests / 5,133 pass / 97 skip / 0 fail / 0 cancelled**；相比 T03 增加 18 项可在 Windows 执行的测试，以及 1 项沿用 Linux protected-operation 能力条件的测试。新的 AST 门禁完善后又单独通过该文件和类型检查，不重复无关全量测量。

原始日志哈希记录在 JSON 证据的 validation 中，原始文件保留于 `.git/pi150-t04`。基线 detached worktree 在配对测量结束后按登记路径清理。远端最终提交的 Linux/Windows CI 以本项 PR 检查列表为准；此状态不代表已合并。
