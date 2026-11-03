# T05：扩展 exec 输出与资源生命周期

日期：2026-11-04。基线：T04 #180 合并提交 `423f4e98acecb225ff83cf8b66a051b43198be39`。状态：**方案先行，T05-A 已实现、验收中；T05-B 未实施**。本次分支 `codex/t05a-extension-exec-output`；只使用当前 Node 26.13.0，保留用户未暂存的 patch 删除。以下设计在生产代码变更前写入，实际执行记录在末尾追加。

## 顺序与范围

依照总方案 T05 的独立子交付约定，拆成两个功能 PR，前一个合并后再开始后一个。T05-B 未交付前不能将 T05 标成完成，不能进入 T06。

- **T05-A（本 PR）**：扩展 exec 的合并字节上限、UTF-8、明确截断/失败结果、直接 child 的终止、输出管道和监听器/timer 释放。保持现有 spawn 入口及环境/权限；不改变普通 shell 工具或后台任务的所有权协议。
- **T05-B（下一 PR）**：复用 WindowsShellJob 和已有 POSIX process-group owner，补齐扩展 exec 的后代进程生命周期；评估 statusline 调用增加 Windows host 的启动成本，验证真实后代/重定向 stdio/启动失败/取消时的 job/group 释放。不把单个 PID 退出当作进程族退出。

拆分原因：输出容量/结果契约与进程族启动属于独立行为变化。Windows Job 需要先启动受控 host、分配 job 后才派发命令；POSIX group 需要 detached spawn 和 shutdown 登记，均超出替换 UTF-8 收集器。T05-A 明确只保证直接 child 及本地读取端释放，不能宣称其后代已经终止。

## 实施前证据台账

| 已观察事实 | 对照/验收 |
| --- | --- |
| exec.ts 逐块 `toString()`、无输出上限 | 相同 UTF-8 字节整块与分块输入；小 cap 下 stdout/stderr 合计保留量 |
| wait 错误被转换为 code=1、空 stderr | 不存在命令与正常退出对照，保留 ENOENT 原始诊断 |
| 已取消 signal 仍先 spawn；强杀检查 proc.killed | 验证已取消零启动；SIGTERM 已发送但 child 未退出时仍执行 SIGKILL |
| force-kill timer 没有句柄，不清理 data listener | 正常、失败、取消、cap 后 timer/listener 为零；保留回调后注入迟到 data 不能重新持有输出 |
| waitForChildProcess 在 exit 后按 data 刷新同一个 100ms idle timer | 保持该 helper；取消/cap 关闭本次读取端，避免持续写入的继承管道拖住返回 |
| 仓库内实际 pi.exec 消费者为 statusline 的 git status | 依赖 code/killed/stdout；新增字段不需要修改解析/每帧渲染；零输出、小输出仍不分配大缓冲区 |
| loader 只在启动检查 runtime 是否 active，调用者提供 signal | 不临时增加全局 child registry 或 extension-dispose controller；runtime 级撤销接入由 T05-B 审计所有权后处理 |

基线及候选使用相同真实 Node 子进程和受控 EventEmitter/Readable 故障夹具。真实进程以 IPC/输出/文件完成握手，不用猜测 sleep 定位取消时序；故障夹具只替换 spawn 边界，不在生产加入测试开关。

## T05-A API 与最小设计

1. `ExecOptions.maxBuffer` 为 stdout+stderr 原始字节合计上限，默认 `min(256 MiB, buffer.constants.MAX_STRING_LENGTH)`；仅允许 0 到运行时字符串上限之间的整数，非法值在 spawn 前抛 RangeError。0 允许无输出命令正常退出；第一字节输出即截断并终止。与 [Pi v1.5.0 exec](https://github.com/earendil-works/pi/blob/v1.5.0/packages/coding-agent/src/core/exec.ts) 的公开单位一致。
2. `ExecResult` 每次包含 `truncated: boolean`；既有 stdout/stderr/code/killed 保留。`truncated=true` 或主动终止不得返回 code=0；实际非零 exit code 保留，signal/未知退出不再用 0 伪装成功。库内无手工构造的 ExecResult；新增必填结果字段与上游一致，外部自行构造结果的类型适配器需要补 `truncated`。
3. 每路一个 StringDecoder，跨 chunk 维持 UTF-8 状态。正常 EOF 使用 end；cap 人为截断时丢弃 decoder 尚未组成字符的尾字节，不能添加并未被接受的替换字符。按原始字节计费，正常损坏 UTF-8 的替换字符不是原始字节预算的单位。
4. 一个合计计数与一个 truncated 标志；每次接收只检查新 chunk。完整 chunk 直接解码，首次跨 cap 仅创建一个有界 Buffer view，不存 chunk 数组、不按 chunk 扫描/拼接完整历史。结果沿用两路字符串；不预分配 256 MiB 缓冲区，不添加 pool。
5. timeout/abort/cap 进入同一 invocation-owned 终止函数；只触发一次，关闭该调用的 stdout/stderr 读取端。沿用 SIGTERM → 最多一个 5s SIGKILL timer；根据 exitCode/signalCode 判断是否仍需强杀，不用 killed 判断已退出。已取消时零 spawn。
6. 使用已有 waitForChildProcess 等待实际 child 退出；其 idle timer 复用逻辑不改。正常、spawn error、取消、cap 均释放 timeout/force timer、signal listener 和本次两个 data listener。返回后 late callback 不处理输出；结果交给调用者后清空 closure 的大字符串引用。
7. ENOENT 等 child 错误是失败执行，保留原始诊断；非法配置与非 Error 的宿主异常拒绝 Promise。诊断与输出预算分开说明：maxBuffer 限制子进程字节，不删除启动错误消息来满足零字节预算。不增加错误重试、备用 shell 或备用命令。

Node 26 的 [child_process 文档](https://nodejs.org/api/child_process.html#subprocesskilled) 明确区分信号发送和进程退出；[StringDecoder 文档](https://nodejs.org/api/string_decoder.html) 定义跨块解码。只采用这两个实际需要的 API 语义，不扩展 Node 版本矩阵。

## 全链审计与性能门禁

生产链：extensions/loader.ts 的 exec → execCommand → spawn/readable data → 两路 decoder/输出字符串 → waitForChildProcess 的 data/idle/exit/close/error → ExecResult → statusline/readGitStatus → 已有解析和 footer 更新。通用第三方扩展可消费返回值；不复制其结果到第二套全局存储，也不改变 tool/Agent/UI 的事件交付。

常规 chunk 路径新增 Promise、闭包、controller、wrapper、数组、Map/Set 为 0；允许每 invocation 的两路 decoder、稳定回调和既有 wait Promise。超限的 stop、生命周期 deadline、EOF end 和结果对象是明确的边界，不作整文件豁免。已有 helper 中 onData/armIdleTimer/cleanup/finalize 也在 AST 审计范围。stdout/stderr 原始接受字节合计 ≤ cap；decoder 每路最多保留一个未完成 UTF-8 字符；没有完整输出 String/JSON/hash/toString 强制物化循环。

新增 benchmark 使用真实 execCommand + 固定 spawn-boundary 夹具，逐次投递预建 Buffer；不改变生产收集器。固定 N/2N/4N 和多 chunk 粒度，记录 decoder 接收量、截断后的零追加、有效字节、信号次数、timer/listener、结果物化边界；用 inspector allocation sampling、CPU、峰值/受控 GC 及 WeakRef 验证。测试输入构造及输出断言在采样之外；正常输出与超限场景分开，不将性能下降归因于不同输入或异步启动开销。

同机基线/候选五组串行配对，分别记录源码 hash、fixture 参数、warmup、Node/OS、采样间隔和采样栈；正式结果不能只给 heap delta 或时间。基线对照仅替换 exec 模块的文件，复用未修改的 child helper，不创建额外 Node 安装。结构计数与引用释放 smoke 在 CI 执行，采样不作跨机器耗时门槛。

## 有序验收

1. 写入本方案，然后增加 `tests/extension-exec.test.ts` 并记录基线红灯。覆盖正常/空输出/非零退出、UTF-8 任意边界、双流共用 cap/0/精确边界、非法 cap 零 spawn、ENOENT、已取消、运行中取消、timeout、晚到 data、已退出父进程持有的输出管道。
2. 用可控 child/虚拟 timer 验证 force-kill 是单个 5s timer 且正常释放；Linux 再用真实忽略 SIGTERM 的 Node child 验证实际强杀，测试拥有其 PID 和兜底清理，不杀其他进程。
3. 建立分配/引用基线，再只改现有 exec 所有者，运行新行为测试和已有 shell observation/hot-path invariants、extension loader、statusline 相关回归。
4. 增加 `tests/extension-exec-hot-paths.test.ts` 和 `scripts/bench/extension-exec-output.ts`，执行 AST、确定性计数、实际分配与 GC，补写证据和结果。
5. 当前 Node26 check、build:offline、全量测试；创建独立 T05-A PR，等待最终提交 Linux/Windows CI，清理按身份登记的基线/进程/临时资源。
6. T05-A 合并后执行 T05-B，先补写 Windows Job / POSIX group 启动、取消、正常退出、后代/句柄计数及 cold-start 性能方案，再实施独立 PR。

## 执行结果

### 复现与回归

基线定向 8 项全部红灯，实际观察到跨块 UTF-8 损坏、空 ENOENT 诊断、signal 退出被映射为 0，以及已发送 SIGTERM 后未执行强杀；新容量/字段和零启动条件也未满足。未在基线上运行会长时间存活的真实忽略 SIGTERM 进程；强杀区别先由真实生产回调加虚拟 timer/可控 child 证明。

候选定向回归 **67 tests / 61 pass / 6 平台条件 skip / 0 fail**，包括公开 extension API 的 cwd/maxBuffer 透传、真实输出超限/取消、已有 loader 和 shell observation/hot-path 文件。Linux 专属真实 SIGTERM-ignore 用例执行完整 5s escalation，不缩短生产 deadline，由新 PR 的 Linux CI 验收。既有 wait helper 和 Windows Job 生产代码均未修改。

GC smoke 的首次失败定位到 benchmark 自己保留已完成的 Promise，其 fulfillment value 正是被检查的结果对象；显式释放该调用者引用后，生产回调/input/result 的 GC 断言通过，没有放宽断言。初步 timing 仅 16 次调用，小于 Windows CPU 计数量化尺度；正式 timing 改为每个场景总计 256 MiB 投递，采样仍独立进行 16 次调用。未切换 Node 版本。

### 性能与生命周期证据

[JSON 证据](../evidence/pi-150-t05a-extension-exec.json)保存源码 LF-normalized SHA-256、完整五组数值、代表性采样栈、环境和限制。每组先基线后候选，串行；Windows 10.0.26300 / Node v26.13.0；4 warmup、16 allocation invocations、1,024-byte inspector sampling，包含已被 GC 回收的分配。基线控制文件仅调整 helper import 路径，其原始 Git 源码 hash 另外记录。真实 exec/wait helper 保持原样，只有 spawn 边界使用固定夹具；以下数字不包括 OS 创建进程的耗时。

| 输入 / chunk / cap | 采样 bytes/input chunk：基线 → 候选 | 墙钟 p95 ms：基线 → 候选 |
| --- | --- | --- |
| 256 KiB / 1 KiB / 完整 | 1,224.60 → 1,192.60 | 0.1298 → 0.1374 |
| 512 KiB / 1 KiB / 完整 | 1,152.53 → 1,153.44 | 0.1392 → 0.1626 |
| 1 MiB / 1 KiB / 完整 | 1,144.03 → 1,137.55 | 0.3878 → 0.2712 |
| 1 MiB / 64 B / 完整 | 120.39 → 120.08 | 7.0335 → 1.3281 |
| 1 MiB / 1 KiB / 8 KiB | 1,138.83 → 77.02 | 0.3624 → 0.1119 |

正常分配基本持平，输入 N/2N/4N 没有出现重复处理整段历史的增长。超限场景分配下降 93.24%，主要因为基线继续收集全部 1 MiB，候选只解码 8 KiB；这不是相同输出量下的效率对比。256/512 KiB 场景 p95 分别增加约 7.6/23.4 µs（5.86%/16.81%），不隐去回退，也不宣称普遍提速。没有引入对象池，未使用对象池准入阈值作为这次正确性修复的结论。

确定性 smoke 每次投递 4,096 原始字节、64 个 chunk：cap=4,096 时 decoder bytes=4,096、views=0、stop=0；cap=135 时 decoder bytes=135、views=1、stop=1；cap=0 时 decoder bytes=0、views=0、stop=1。三种情况下常规交付 Promise=0，返回后 data listeners=0。超限后原始剩余 chunk 只触发固定状态检查，不继续解码或分配输出。

受控 GC 覆盖 normal/abort/cap/error，并保持 child 存活：候选 input Buffer、回调、result 弱引用全部为 0，data/abort listeners 和未清理 timer 全部为 0。基线每种退出留下两个 data listeners，所观察 stdout capture 回调保留 1；abort 另留下一个 5s timer。基准只按实际捕获 timer identity 清理基线残留，不模糊扫描进程或计时器。峰值/GC 后 heap 数值在证据中保留，不能单独将其解释成精确的输出字符串大小。

应用层只构造必要的两路结果字符串和一次结果对象；没有完整结果的额外 String/JSON/Buffer 副本。V8 cons string 的潜在 flatten 未被伪称为“零物理复制”。最终返回前清空 closure 的大字符串引用，decoder 与回调随 invocation 释放；AST 门禁覆盖生产输出回调及 wait helper 的所有交付、结束和清理函数。

### 交付状态

类型检查和离线构建通过。全量当前 Node26：**394/394 执行单元成功，5,250 tests / 5,152 pass / 98 skip / 0 fail / 0 cancelled**。相对 T04 增加 19 项可在 Windows 执行的测试，以及 1 项 Linux 实际 SIGTERM-ignore 验证；没有修改既有跳过条件或超时。日志 hash 见证据 validation，原始文件保留于 `.git/pi150-t05a`。基线控制模块完成测量后按登记路径删除，任务拥有的 timer/child/临时目录均在对应夹具退出时释放。

新 PR 最终 head 的跨平台 CI 以该 PR 的检查列表为准，不把本地 Windows 验收当作 Linux 实际强杀的证明。使用说明见 [extension-exec.md](../extension-exec.md)。T05-B 尚未实施；本 PR 不宣称进程族管理已经完成。
