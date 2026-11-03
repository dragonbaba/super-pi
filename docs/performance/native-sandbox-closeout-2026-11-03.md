# 原生能力与 Windows Sandbox 最终性能检查

检查日期：2026-11-03；Windows x64，Node 26.13.0，当前未提交工作树。依据 [hot-path-allocation-contract.md](hot-path-allocation-contract.md)。检查覆盖本次新增链路与已整合生产链，不以单次耗时证明性能提升，不使用对象池。

## 调用链与分配边界

| 链路 | 已核对的生产调用与释放边界 | 分配结论 |
| --- | --- | --- |
| 沙盒命令 | AgentSession → CodeMode → SessionSandbox → 原 powershell 授权 → 输入 snapshot/workspace lease → WSB/Job → CapturedProcess → 候选捕获 → 原 file_batch → finish/drain | 进程输出固定两个 16 KiB buffer；逐 chunk 无新闭包、数组、Promise、controller 或包装对象。任务启动、授权与关闭是显式异步边界；不是逐输出异步任务。 |
| 原生权限 | beforeToolCall → ExtensionRunner → SessionExecutionPolicy → 原生文件准备 → 最终 consume → finally/revoke/drain | 工作区复核已移除 for-of 迭代器；无权限/钩子准备的普通调用共用一个可撤销 epoch。真正异步准备仍最多 128 个 owner，每个至多 32 个已接收 grant 加 1 个失败交付槽。 |
| 事件与进度 | Provider / 工具 → Agent delivery 合并 → snapshot → AgentSession 稳定桥 → InteractiveMode → render request | 普通 delivery 同步；每更新 Promise、拒绝观察器、Promise tail/array、工具包装对象均为 0。snapshot 在真实交付时复制/冻结一次；不把 snapshot 成本称为 0。 |
| TUI | Main / Alt render → 有界 viewport/layout → frame queue → ProcessTerminal callback/drain → flush/abort/dispose | 每帧最终字符串最多 1 次，完整复制 0；队列 Promise/controller/wrapper 0。保留既有有界 viewport 数组和 Alt 布局记录，不声称整个渲染过程零分配。 |
| 文件、结果与证据 | 原生 read/revision → prepare/commit → result projection → token estimate / truncation / Evidence Ledger → clear/dispose | 原始文件与大结果保留既有有界所有权；完整结果额外复制 0。write 渲染迁入原生层，旧入口仅 re-export，无第二份实现。 |
| 任务、Provider、服务 | tasks owner/history、请求快照/摘要、MCP directory/reader cancel、LSP client/pool → shutdown/reload | 持续更新复用原 owner；MCP 修复仅在关闭异常分支辨认已终止 reader，不增加正常 SSE 分配。关闭失败仍保留精确资源。 |

全量回归覆盖取消、超时、晚到授权、部分提交、flush/abort/dispose 与实际进程退出。AST/source 检查新增 CapturedProcess 回调、工作区复核和 OrdinaryToolEpoch 的约束，并复核生产导入链，不能只检查新 diff。

## 本机实测

20 个基准场景均已通过。原始命令及各次退出码见 [cases](../../.artifacts/final-performance-cases.json)、[results](../../.artifacts/final-performance-results.jsonl)。CodeMode 首次因夹具复用已释放 runtime 失败；夹具现在等待会话释放并 reload，复验通过，首次失败日志保留。

| 场景 | 确定性计数、采样与释放证据 |
| --- | --- |
| 沙盒输出与授权 | 17 MiB 实际子进程输出，272 chunks，固定保留 32768 B；200000 次工作区检查及 200000 次普通 epoch 检查；hot Promise/controller 为 0。对应函数采样 1104 B / 2848 B（含冷路径），各低于 65536 B 门限；9 WeakRefs、4 轮 GC 后 live=0。 |
| 原生切换 / 交互授权 | 30000 次准入、3 次切换，15 引用 live=0，deadline=0，采样 130960 B；100 次交互批准采样 4387.84 B/次，timer 高水位 1，pending timer/owner/reference 均为 0。 |
| 队列 | 20000 帧，采样 111.266 B/帧（含夹具）；frame Promise/controller/wrapper/copy 全 0；flush 后 active/pending 引用与字节全 0。 |
| Main / Alt 生产帧 | 各 20000 帧，7006.856 / 9756.174 B/帧；每帧最终字符串 1 次、完整复制 0、队列高水位 1。4 次生命周期后所有组件/行/source/cache/overlay/selection 引用为 0。Alt 保留原有有界布局记录，不新增对象池。 |
| 会话事件 | message/tool 各 100000 次，10.967 / 21.589 B/更新；内建 listener Promise=0。完整 observer 合并链 100000 次更新只交付一次，snapshot=1，各层 Promise/拒绝观察器均为 0。完整链包含通知、快照与夹具成本，不能将其采样全部归到单次 snapshot。 |
| 流与工具进度 | 各 100000 次 burst，实际交付 1 次，pending slot/key 最大 1；InteractiveMode burst 实际交付 2 次，结束 active/pendingTools=0。 |
| 图片 | 普通文本更新 10000 次与大单行截断；retainedText=0；图片添加及提交在异步操作边界分配。真实桌面发送另见验收档案，不能由此基准代替。 |
| 原生文件 | regular/fullscreen 各 5 个会话，真实批量提交；结束 pending tools、输入/resize listeners 均为 0。首次模块加载后的 heap 增长单独记录，不称为泄漏归零。 |
| CodeMode | 10 个测量周期 + 1 个 warmup；242 子调用；11 workers 启动/11 关闭；55 WeakRefs live=0，pending evidence=0。采样 host 29556216 B，不包含 Worker heap；首调用 p95 29.816 ms 仅为本机观察。 |
| 任务历史 | 144 个引用全部释放；各场景 8 个任务，有界历史数据库；不保留任务 owner。 |
| Provider / 压缩 | 请求预览 160、原生摘要 143、portable 摘要 209 个引用全部释放；每次分别约 114438 / 409610 / 1323434 B，均为真实组装、离线 transport fixture。 |
| MCP / Evidence Ledger | MCP 32 次搜索、128 个引用在 runtime 仍存活时释放；19037.25 B/操作。Ledger 4 个 WeakRefs 释放，metadata/source 引用为 0；Windows 禁用不可靠 identity 命中，不伪造 Linux hit profile。 |
| 大结果 | 完整结果额外复制 0；默认路径不创建 shadow estimate/telemetry；各视图 dispose 后 observer/observation 引用 0。 |

完整数据分别在 `.artifacts/final-perf-*.txt`。采样包含 V8、模块/夹具和既有有界布局成本；受控 GC 的进程总 heap 并不等于对象存活计数，报告未把正 heap 差值解释为已证明泄漏，也未把引用归零解释为所有 V8/OS 内存均已计量。

## 复核中修正的问题

1. workspace assert 热循环原有迭代器采样约 10 MB / 200000 次，改为索引循环；保留独立采样门限与源不变量。
2. CodeMode 沙盒兄弟 dispatch 改为稳定回调加显式状态，避免每次构造转发闭包。
3. 原权限容量测试后加 hook 不会重建缓存索引，未实际覆盖 128 个异步准备。改为预注册，真实执行 256 个 hook 后冷路径预算明确增加每准备 64 KiB；保留原 4 MiB 生命周期额度。此数值是工作负载变更，不宣称优化；普通热检查由独立 200000 次基准及 AST 门禁约束。
4. LSP fixture 的 Unix 风格 URI 在 Windows 每次触发 NodeError。改为合法平台 URI后，原 16 MiB 门限保持，3000 diagnostics / 3 稳定 callback / 3 settle timer / 24 WeakRefs live=0 通过；最终采样 13643536 B，包含 VM fixture。
5. 运行时包的兼容入口现在按声明 peer 测试真实 core tarball，不再假设原生 worker 仍由扩展拥有；无下载、联网安装或 workspace 路径依赖。

## 验证与结论

`npm run check`、`npm run build:offline`、`git diff --check` 通过。全量 385 个单元共 5165 项，最后 3 组失败修复后定向 34 项全部通过；最终汇总 5069 通过、96 个明确平台/可选场景跳过、0 未解决失败。另一次最终 `test:hot` 14 文件 / 81 项全部通过。冻结的 16 个手动验收入口保持不参与普通 suite；新会话验收入口实际执行真实 WSB，成功、exit23、超时、取消均已有记录。

源码指纹与验证档案在 `.artifacts/native-sandbox-closeout-manifest.json`。结论限于本次 Windows/Node 支持范围及记录的契约，不外推未运行的 Linux/NVX、Bun 或任意第三方组合。没有新增对象池，没有未解决的已复现热路径阻断。

## 三档会话权限追加检查（2026-11-03）

本节对应 `/permissions` 的只读沙箱、沙箱读写、宿主读写新工作区后端。前文的旧任务协议数据保留；不能拿旧协议的 4 KiB 文件上限描述当前交互入口。新实现没有增加逐事件或逐帧工作，没有新增对象池。

生产链已复核：InteractiveMode 显式菜单 → AgentSessionRuntime 原会话替换/执行屏障 → AgentSession 工具目录 → CodeMode/原工具授权 → WorkspaceSandboxTools → WorkspaceSandboxBackend → CapturedProcess/Windows Sandbox → 来宾 worker/Job/Pump → 候选校验 → 原生 FileService → 逐项 receipt → 代次切换、reload 或 dispose。失败 receipt 现在明确失败，不能作为成功写回；旧授权和迟到结果不能越过代次。

- 菜单、工作区捕获、VM 创建、授权、提交与关闭属于明确的低频操作边界，允许其 Promise、局部状态和闭包。Provider → AgentSession → InteractiveMode → render/ProcessTerminal 的普通事件链没有新分配。
- CapturedProcess 继续使用两个固定 16 KiB 输出缓冲；272 chunks / 17 MiB 实际输出，仅保留 32768 B；逐 chunk 闭包、数组、包装、Promise、controller 计数均为 0。200000 次工作区检查与 200000 次普通 epoch 检查通过，工作区采样 0 B、普通检查 2248 B；9 个 WeakRef、4 轮 GC 后 live=0。原始数据 `.artifacts/permission-modes-allocation.txt`，采样包含初始化/关闭，不能解释成整个命令零分配。
- 新后端只保留至多 20000 个源版本记录、同规模的私有文件身份表；已结束 CLI 记录压缩至最近 16 条。目录扫描、候选与序列化均有容量上限。来宾哈希每轮复用一个 256 KiB scratch，仅末个短块创建 view；普通列举不读取或哈希所有文件。文本窗口不 split 整个文件，worker 进程退出释放该次字符串/候选。
- 文本搜索原来会逐行重复扫描剩余正文，已改成单调推进匹配位置。真实生产 helper 的确定性检查：100000 行无匹配时正文模式扫描 1 次、行扫描 0；仅末行匹配时模式扫描 2 次、行扫描 100001 次；密集匹配最多 200 行/200 个片段，行数组 0。AST 检查拒绝 helper 内的闭包、Promise/await、临时对象/数组和 split。
- Pi 仓库真实捕获 4864 文件、5084 私有节点，同一个只读 VM 完成 README 读取及 Node 命令。关闭后 sourceFiles=0、ownedArtifacts=0、pending=false、vm=false、root 已移除。新后端分配采样 101344 B，含冷捕获/编排，不含 Buffer 外部内存和来宾进程 heap；4 轮受控 GC 后 owner live=0。证据 `.artifacts/permission-repository-probe.json` 与 `.heapprofile`。初次被 `.codegraph` 生成索引阻断，修正排除范围后通过；原失败也保留在收尾记录中，不声称全仓库构建已完成。
- 真实 CodeMode 四类结果已验证：成功写回、exit7 不写回、超时不写回、运行中切换不产生迟到写回。9 个会话 owner 结束后 participant/deadline=0，VM/目录释放。补充真实 reload 验证旧 VM 关闭、新 VM 可用、会话 ID 保留，以及宿主模式写工作区外文件；另 3 个 owner 结束后同样清理完成。

验证记录：`npm run check`、coding-agent 增量构建与 `superpi --version`（1.0.0）通过。定向回归的覆盖并集为 103 项，99 通过、4 个 Windows 不适用的 POSIX 信号场景跳过；首次 4 个自定义宿主工具用例被新默认沙箱拒绝，夹具改走真实 `/permissions` 菜单后 4 项复验通过。最终权限/源不变量 15 项、配置 schema 5 项通过。保留各次日志，不把合并结果称为一次全绿运行。此前已通过的整套性能矩阵和未受影响的全量 CI 不在本轮重复执行；新真实 VM 与 allocation probe 不加入默认 CI。

限制：这是有界工作区后端，256 MiB 快照、2 MiB 文本候选、32 文件/16 MiB 写回、命令最多 120 秒，不带联网依赖安装与后台工作。后续复核已修正失败恢复：确认旧快照清理完成后，下一次调用可以直接建立新快照；清理无法确认时保留原 owner 并拒绝继续。多文件不是事务，部分成功按原生回执保留，不自动回滚。完整当前行为见[会话权限与沙箱](../execution-environments.md)和[性能与稳定性复核](code-review-2026-11-03.md)。
