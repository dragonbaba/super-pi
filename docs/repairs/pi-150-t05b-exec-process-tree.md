# T05-B：扩展 exec 进程所有权

日期：2026-11-04。状态：**已通过 #182 合并**。基线为 T05-A #181 合并提交 `92d5adb8642839140f0229749a0f0b3829f3c550`。#181 最终 head `901358d9ed88a61286dad19986987062098919c0` 已获 Codex completed/no findings，CI 6/6 通过；对应分支已清理。

## 授权与交付门禁

用户本轮明确授权后续功能按顺序自动执行：每项先规划后实施、独立 PR；**等待 reviewer 对最终 head 完成审核**，没有问题且检查通过才合并；有问题就修复、推送，并手动发布 `@codex review` 请求额外复审。禁止用空评论列表或 CI 绿灯替代 reviewer completed。合并时指定已经审核的 SHA，删除该远端/本地分支并同步 main。只测试当前 Node 26.13.0，保留用户的未暂存 patch 删除。T05-B 合并后才进入 T06。

## 审计事实与范围

| 已核对事实 | 需要的行为 |
| --- | --- |
| T05-A spawn 未创建 POSIX group；kill 只针对直接 child | POSIX detached spawn 建立独立组，用现有 track/untrack 登记；终止及完成后清理该组 |
| Windows 已有 WindowsShellJob：host 加入 job 后才派发命令，KILL_ON_JOB_CLOSE，无输出 JS 转发 | 复用该 owner，不能改成按名称扫描或未等待的 taskkill；正常/取消/错误结束都 await stop |
| Windows owner 的 launchError/dispatchError 是实际启动/派发诊断 | 合入 exec 失败结果，不能把 host 的退出 0 或空 stderr 当命令成功 |
| stopOwnedProcessGroup 只操作已拥有 PGID，SIGKILL 后最多 5s 检查是否消失 | 复用其收尾和错误语义，不增加另一套目录/PID 扫描器；ESRCH 是组已退出，其他错误不能默认成功 |
| extension runtime 已有 SessionExecutionBoundary，提供 signal、service participant 和 drain deadline | 一个 runtime 拥有一个 exec service；停止接纳、撤销、等待在途 exec 复用该边界，不再造全局注册表 |
| statusline 使用 pi.exec git status，3s timeout | 核对 Windows host/native admission 的冷启动成本及 timeout 余额；输出 chunk 路径保持 T05-A 结构 |

范围：exec 的平台 spawn/stop、runtime service 接线、真实进程与性能回归。继续使用 T05-A 输出收集器及 waitForChildProcess；不改普通 Bash/后台任务权限、不复写 Windows Job native bindings、不新增持久化任务日志或自动重试。POSIX 所有权为本次创建的 process group；主动 setsid/换组不构成受控沙箱承诺。Windows job 按既有不允许 breakaway 的机制拥有成员。

## 最小设计

1. Windows 使用 WindowsShellJob.spawn(command,args,cwd,process.env,false,...)；POSIX 使用现有 spawn，设置 detached=true，并在获得 PID 后登记为本次拥有的 PGID。Windows native 初始化/分配失败直接失败，不退回无 job 的运行路径。
2. 普通 chunk 仍只处理新字节，无 platform 查询、Promise、额外 wrapper/controller/容器。owner 与稳定回调只在 invocation/start/stop 边界创建；force callback 与 process cleanup Promise 各至多一个。
3. POSIX abort/timeout/cap 对拥有的组发送 SIGTERM，仍保留 5s escalation；终态清理调用现有 stopOwnedProcessGroup。Windows cancellation 直接调用 job.stop（Windows 不冒充 POSIX 的信号宽限）。两平台正常完成也清理仍存活的组/job 成员，然后返回。
4. cleanup 在同一个 finally 所有权边界完成。必须保留原始命令非零退出；cleanup/launch/dispatch failure 不得返回成功，并保留诊断。仅在清理结束后取消登记及释放 signal/data callbacks 和输出引用。不能将 kill 请求、输出 EOF 或根进程退出当作进程族已清理。
5. Windows admission 有异步点：在真正 dispatch 前同时检查调用者和 runtime 的取消事实及 timeout 截止时间；建立 child 后注册终止回调时再消费已经发生的取消，避免取消落在两者之间。不为每个 chunk 合并 signal，不建立后台轮询 timer。deadline 余额用于实际运行 timeout；同步 native 调用不可被 JS timer 抢占，不能承诺硬实时。
6. 一个 ExtensionExecOwner 注册为既有 executionBoundary 的 service participant，维护本 runtime 的在途调用 Set，只有显式 exec admission/finish 修改。撤销使用 boundary 已有 signal；drain 等待清理完成，不因一个正常非零命令退出而判定资源泄漏。内部 cleanup 失败由 invocation 报告给 owner，drain 保留错误，不允许新边界把不确定清理当作完成。该状态仅用于真实 cleanup 失败，不用于 maxBuffer 截断或命令业务失败。
7. loader.exec 交给上述 owner；runtime invalidate/dispose/transition 通过已有 executionBoundary 关闭，不改 provider 权限来源。直接内部 execCommand 没有 runtime 时仍拥有自身 job/group。新增参数为内部生命周期 owner，公开 pi.exec options/result 保持 T05-A 的形状。

## 故障与生命周期验收

- 基线真实复现：短命父进程留下 stdio=ignore 的同组/同 job 后代；exec 返回后后代仍存活。夹具通过任务拥有的 loopback 握手记录每个 PID/连接，最后只按该身份释放；不按进程名扫描。
- 候选：正常退出、abort、timeout、cap、父进程先退出、stderr/启动失败后都验证 root 和后代不再执行；Windows job/process handle counters 为 0，POSIX group 由既有 helper 确认消失。Linux PID 1 不及时收割的 zombie 不能误报运行成功；保留 helper 真实清理失败结果，不绕过。
- 已取消、admission 中取消、过期 deadline 均不派发命令；native admission 失败不能转为普通 spawn。fake child 的 PGID 不得发到真实 process.kill，测试边界按该确切 ID 拦截。
- runtime invalidate/transition 取消活动 exec，drain 等到清理完成；正常 nonzero/ENOENT 不污染后续边界；注入 cleanup failure 时 drain 必须失败，不能解除限制。
- 保留 T05-A 的 UTF-8、共享 cap、迟到 data、定时器释放、真实 Linux SIGTERM-ignore 回归。测试 ready 握手适应 Windows async admission，不靠 sleep 猜测 callback 是否已注册。

## 性能契约与证据

调用链新增：loader → runtime exec owner → 平台 admission → exec output/wait helper → job/group stop → owner drain → executionBoundary completion。Windows native helper 的 output 仍由 OS handle 直达父进程，不能在 host 加 JS data 转发。已有 source invariants 同时覆盖 Job 回调；常规 output delivery 的分配和 AST 门禁不得因改名或移动 helper 失效。

使用同一 T05-A output fixture 比较 chunk 分配/确定性计数/受控 GC；fixture 只替换平台 admission/stop，不复制生产收集器。另新增真实冷启动基准：同机、同 Node、串行配对 A/B 的空 Node 命令和 git status，记录首调用、warm p50/p95、job handles、native init、输出字节及结束后的引用。区分 admission 固定成本与每 chunk 成本，真实子进程计时不能用于声称 chunk 零分配。

先写方案 → 最小红灯 → 实现 → 定向行为/AST/GC及配对分配、冷启动 → check/build:offline/完整 Node26 suite → 独立 PR → reviewer completed 与最终 head CI → 必要修复并 `@codex review` → 合并/删分支/同步 → T06。拒绝对象池、备用执行路径、静默清理成功及放宽平台约束。

## 执行记录

### 复现与实现

基线真实红灯：Windows 后代使用 detached spawn、stdio=ignore，私有 loopback 握手交付 PID；根进程退出且 exec 返回后，`process.kill(pid, 0)` 仍成功。测试最后只按记录 PID 终止后代。普通 Windows Node 子进程的默认归属可掩盖此问题，因此夹具只在 Windows 设置 detached；POSIX 保持本次创建的进程组，不用 setsid 绕过验收范围。候选正常/abort/timeout/cap 均通过，并新增继承输出的后代场景。

根进程 exit 回调立即启动同一缓存 stop，避免持续输出的后代让 wait helper 永远无法进入 idle。Windows Job 和 POSIX stop helper 生产实现保持原样。POSIX cleanup 失败保留已有精确 PGID 登记供退出清理，runtime owner 记录真实 cleanup failure；不把它改写为成功或自动重启命令。

runtime 仅增加一个 `extension-exec` service。它复用 boundary.signal，在途 Set 只在显式 exec 的开始/结束变动；transition/invalidate/dispose 都等待该命令的实际清理。普通退出 17、非法 maxBuffer 不污染后续边界；注入 job cleanup 失败时不发布新边界。Windows native admission 等待中取消/超时以及派发后恢复前的取消均有定向验证。

### 性能与引用释放

见 [JSON 证据](../evidence/pi-150-t05b-exec-process-tree.json)。同机 Windows 10.0.26300 / Node v26.13.0，五轮基线与候选串行配对，轮次交替先后顺序；输出 benchmark 4 warmup、16 次分配采样、1,024-byte sampling，timing 每场景累计 256 MiB。平台 admission/stop 使用精确假 child/job，实际生产输出与 wait helper 不替换；启动耗时另测真实进程。完整 raw samples、hash 和峰值/GC 后 heap 均保留。

| 输入 / chunk / cap | 中位采样 bytes/chunk：A → B | 中位墙钟 p95 ms：A → B |
| --- | --- | --- |
| 256 KiB / 1 KiB / 全部 | 1209.38 → 1210.45 | 0.1379 → 0.1413 |
| 512 KiB / 1 KiB / 全部 | 1162.11 → 1155.33 | 0.1766 → 0.1760 |
| 1 MiB / 1 KiB / 全部 | 1141.87 → 1131.53 | 0.2497 → 0.2656 |
| 1 MiB / 64 B / 全部 | 119.21 → 120.22 | 1.0464 → 1.0426 |
| 1 MiB / 1 KiB / 8 KiB | 79.37 → 78.72 | 0.1257 → 0.1145 |

常规输出无新增 Promise、controller、wrapper、数组或整段重处理；仅必要解码字符串与两路结果构建。超限首次触发是明确 stop 边界：mock Windows job 在该次交付产生 1 个缓存 Promise，后续迟到 chunk 为 0；没有将 stop 分配隐入“常规零分配”。单个 prefix Buffer view 至多 1。正常、abort、cap、error 的 input/callback/result 弱引用及 data/abort listeners、timer 均为 0；保留 runtime owner 时结果仍可回收，dispose 后 owner 可回收且 participant=0。runtime GC 小节固定测试候选 service，不用于声称旧实现拥有该服务。

没有对象池，也没有额外完整结果副本；V8 内部 flatten 不作零物理复制承诺。1 MiB / 1 KiB p95 增加约 15.9 µs（6.4%），不能声称所有场景提速。主分配仍为解码文本；新增成本位于 invocation/stop。

真实 Windows 启动每轮每命令 21 次（首调用 + 20 warm）。空 Node 首调用中位数 35.88 → 71.24 ms，warm p50 33.37 → 63.77 ms；git status warm p50 28.63 → 59.78 ms，p95 33.57 → 65.04 ms。B 增加约 30 ms 固定 host 启动成本，属于进程归属保证的明确代价；远小于该调用已有 3000 ms timeout，但不以此声称无性能回退。只有每轮第一条 Node 命令包含 native binding 初始化，git 首次样本不再是 native 冷启动；模块 import 时间未计入。真实基准每次结束后 Job/process handles=0，没有备用无 Job 执行路径。

### 验收状态

定向 83 tests / 82 pass / 1 POSIX 条件 skip / 0 fail（随后增加继承输出场景）；类型检查与离线构建通过。全量当前 Node26：**396/396 执行单元成功，5263 tests / 5165 pass / 98 skip / 0 fail / 0 cancelled**，包含继承输出场景。基线控制模块已按登记路径删除；日志留在 `.git/pi150-t05b`，hash 记录于证据。最终 head 的跨平台 CI 及 reviewer completed 仍由独立 PR 验收，不能先记已交付。

最终交付：[#182](https://github.com/dragonbaba/super-pi/pull/182) 的 head `8670a659839f13d44dda36fdf35b702830ebe416` 获 Codex completed/no findings；[CI 41681868683](https://github.com/dragonbaba/super-pi/actions/runs/41681868683) 6/6 通过。Linux 实际 SIGTERM-ignore 用例执行 5044 ms 后由 SIGKILL 回收，真实进程族验收通过。按用户授权合并为 `c37c9d6e509ff41650eef21dc81ea97f4ec8cfa5`，对应远端/本地分支已删除、main 已同步；随后才开始 T06-A。
