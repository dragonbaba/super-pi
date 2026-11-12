# 文件操作 v3 验收记录

日期：2026-11-13（Asia/Tokyo）。基线为 B 的合并提交 `f6fe77936da78244128e265802325a86cf76d401`。本记录对应 [PR #297](https://github.com/dragonbaba/super-pi/pull/297) 的 `codex/file-ops-v3` 候选；原生 50,000 文件目录已通过，真实 MXC 目录、最终完整回归、PR 审核和 CI 尚待完成，不表示已合并。

## 实现与生产入口

`SessionFiles` 为 native 与 MXC 统一安装 write/edit/copy/delete/move/file_batch，保留现有权限边界。所有参数、路径身份、受保护树和全调用冲突先检查，再一次授权，之后才发布 ready 和逐项 intent。copy 源按读取、目标按写入判定；D5 外部已有目标覆盖仍停止整轮。子代理的文件变更经父执行入口；显式允许的 file_result 只查询本地子会话或当前子任务真实委派的结果，不提供父会话通用读取能力。

新调用不设目标数量上限。内部请求按实际序列化 JSON 分块，最多 4 MiB；回复最多 256 KiB；write/edit 正文合计仍最多 1 MiB。结果日志复用现有会话 custom entries，绑定实际返回的条目 ID、原调用、权限代次和准备清单 Merkle root。无正文或完整 diff 副本。file_result 每页最多 128 条且实际 JSON 不超过 64 KiB，不启动文件 worker，不恢复原生读取版本。

共享的文件创建、树遍历、流式复制与发布 owner 负责两条执行链路；原生同卷 move 保留独占 link → 验证 → unlink，跨卷和 MXC 使用流式复制、目标重读哈希、源身份复核后删源。真实 MXC 在同一挂载和不同授权挂载均拒绝硬链接，故 move 在执行前固定选择 `copy_unlink_verified`，没有失败后回退或重放。目录目标用独占 mkdir，不合并或覆盖已有目录；删源仅用非递归 rmdir。

生产 MXC v2 mutation 分发和独立的 core v2 batch 执行器已退役，随后删除了复制的历史执行器测试 fixture。v1/v2 历史记录解析保留原预算与直接构造的回执夹具。随源码扩展中为旧嵌入 API 保留的兼容实现，在有 SessionFiles 的当前运行时跳过注册；当前 CLI、Codemode 与子代理使用同一个 v3 owner。

## 已观察的实际会话验证

环境：同机 Windows x64、Node 26.13.0，实际 MXC SDK/ProcessContainer 与现有 Job/process owner；没有 provider 请求。下表的时间含输出核对，CPU 为宿主进程累计 user/system 微秒，不能代表隔离 worker 的 CPU，也不能作为等价旧实现的加速对照。

| 执行位置 | 操作 | 顶层目标 | 耗时 ms | 宿主 user/system CPU µs |
| --- | --- | ---: | ---: | ---: |
| native 完整会话 | copy | 2,000 | 33,022.8794 | 9,656,000 / 15,953,000 |
| native 完整会话 | move | 2,000 | 31,432.3754 | 10,734,000 / 20,109,000 |
| native 完整会话 | delete | 2,000 | 17,248.225 | 7,891,000 / 9,063,000 |
| native 完整会话 | file_batch | 2,000 | 21,662.6823 | 9,875,000 / 12,578,000 |
| 真实 MXC 完整会话 | copy | 2,000 | 417,206.1948 | 13,891,000 / 5,500,000 |
| 真实 MXC 完整会话 | move | 2,000 | 426,128.2203 | 15,984,000 / 13,141,000 |
| 真实 MXC 完整会话 | delete | 2,000 | 411,597.7545 | 20,328,000 / 16,547,000 |
| 真实 MXC 独立新 fixture | file_batch | 2,000 | 415,675.6214 | 23,562,000 / 15,484,000 |

每组均逐项核对实际磁盘、全部终态分页和适用的 SHA 连续编辑。这些大样本为初轮 `934b6654a` 候选的历史测量，后续审核修正使用下文的小样本验证，不作为新 head 的等价规模复测。前三个 MXC 操作的最大请求/回复分别为 28,185 / 14,914 字节；独立 batch 为 25,832 / 14,908 字节。每组结束时交换 artifact、队列、reservation 为 0，active process、retained streams、child、Job 均为 false。没有把 worker-only 或 VM fixture 的成功记作实际 MXC 成功。

首轮连续 MXC 压测中 batch 在 1,389 项成功后出现传输不完整，记录 1 项未知、610 项未启动，后续不再派发并清理完成。同期宿主 PowerShell 报 OOM，机器 commit 接近上限；没有证据把根因归到某个用户进程或本改动，也没有结束用户进程。后续以上述独立新 fixture 测试 2,000 项，没有重放未知调用。该首轮不计作成功样本。

原生完整会话另完成一个含 50,000 个单字节文件、101 个目录的 copy → move → delete，每步核对全部文件内容或源目录确实消失，计数、字节与完整记录一致。耗时分别为 362,802.3503 / 78,193.7635 / 30,707.0414 ms，宿主 user/system CPU 分别为 81,172,000/112,157,000、27,906,000/61,203,000、9,641,000/25,234,000 µs。采样峰值 heap 194,345,424、RSS 436,719,616 字节，累计分配采样估计 17,480,554,032 字节（包含逐文件校验，非精确总量）；关闭、清除 fixture mock 历史并受控 GC 后，6 个 item/tree 引用存活数为 0。此为初轮候选的历史测量；后续安全修正通过小样本验证，不为重取规模数字重复压测。

## 定向回归与安全边界

- `file-result-v3` / `file-result-owner-v3` / source invariant：33 项通过，含第 17、513、2,000 项、实际 JSON 页预算、错误分支/cursor/源参数、断链、准备清单篡改、无终态 intent、记录失败与 writer 引用释放。持久化会话日志超过 2 MiB，派生后删除原会话仍能分页读取。
- `file-mutation-v3` / `file-changes-v3` / queue / trie：20 项通过，含完整顶层目标覆盖、剩余草案、数组继续与 batch 停止、最后目标拒绝无前项效果、dryRun 无记录无目录、全量计数和有界样本。后续计数修正的 dryRun/source gate 3 项通过。
- 实际 C: → D: 跨卷文件/目录回归通过；迁移中新增文件和修改尚未迁移文件均保留在源，结果 partial。共享树与 worker 的 22 项定向回归覆盖嵌套复制/移动/删除、源目录变化和大于 4 KiB 的共享创建父目录 artifact。
- 实际 MXC 的独立 C: → D: 文件 copy/move、D: → C: 目录 move 均通过；两个 root 的 device 不同，源/目标独立授权，准备记录固定 `copy_unlink_verified`。9 个实际 RPC 的最大请求/回复为 1,206 / 906 字节，结束后无 artifact、active process、stream、child、Job、排队或 reservation。
- 实际 MXC 小会话 write/read/连续 SHA edit、受保护路径、PowerShell 7 和清理通过。进程替换 fixture 仍使用真实 backend 的序列化、计量、回复验证、artifact registry 和共享 worker，覆盖 12 类发布后丢失/矛盾回复及下一请求的清理边界；不代表实际隔离进程测试。
- Codemode 当前 v3 回执、提交事实与取消回归 10 项通过；真实 CLI 子代理转发及 D5/D6 回归 6 项通过；false-success guard 回归 18 项通过。自动审核附件新旧回执回归 9 项通过、1 个 POSIX FIFO 在 Windows 跳过；大批次早期项和有哈希的 copy 目标可核对，变化后的内容不附入审核请求。
- 审计复现了 commit 与终态 SHA 不一致仍被接受的缺口；增加配对、SHA 格式、snapshot 与失败后继校验后，相关组合回归 45 项通过、1 项平台跳过。当前 v3 worker 的 post-open write/stat/close 三个故障注入均保留目标、报告 partial 和需要核验，且不提供 SHA/snapshot；这些测试未用历史 v2 worker。

## 分配、复杂度与生命周期

完整链路审计范围为 SessionFiles → FileMutation → FileService/SandboxFileService → 原有 SessionManager.appendCustomEntry/条目索引 → FileResultReader → FileChangesV3/false-success consumer。生产进度条目不逐项触发整份 UI 历史重建。FileExecution 在调用锁作用域内只建立一个固定 active slot，源约束检查拒绝在目标循环内创建回调、Promise executor 或 AbortController。OS I/O 的 Promise 属于文件操作边界；审批、调用准备、显式 /changes 命令及关闭为独立生命周期。

native 2,000×4 的初轮 profiler：采样期间峰值 heap 169,571,000 字节、RSS 412,545,024 字节；HeapProfiler 的累计采样估计 5,453,715,416 字节，包含 fixture/profiler 和结果核对，不是精确总分配。清除 node:test mock 的返回 Promise 历史后受控 GC，14,000 个 prepared item/tree WeakRef 的存活数为 0；32,012 条会话历史记录为预期持有，单列而非计作泄漏。用户要求限制测试后，冻结候选只做下文的小样本复核。

按相同路径形状递增 100/1,000/10,000 项，trie 的路径访问数为 4,000/40,000/400,000，节点为 418/4,018/40,018，身份数等于目标数。一次定向运行的耗时 0.685/3.963/39.932 ms，heap 增量约 0.30/1.08/13.37 MiB；数字包含平台绝对路径深度，节点/访问增长为线性，不使用两两路径比较。临时 trie 属调用预检，未存入全局缓存。

## 复现与待完成门禁

普通检查从 `npm test -- --file <相关文件>` 开始；需要完整门禁时使用 `npm test`。默认单进程，Node 老生代上限 768 MiB，memory 文件也串行；不连续重复跑子集与完整套件。CI 每个分片首个失败后停止派发文件，六个最终 head 分片仍须全部通过。构建和消费 dist 的测试不并发。Windows 长嵌套 SQLite fixture 在本次环境使用 task-owned 的短 TMP；相同短 TMP 下的定向复现通过，没有为路径长度修改 SQLite 或产品代码。

上述规模测量仅留为手动命令，当前入口见[测试文档](../testing.md)。native 分配 sampler、目录 probe 和真实 MXC acceptance 分别位于 `scripts/bench/file-mutations-v3.ts`、`scripts/bench/file-tree-v3.ts`、`scripts/acceptance/file-operations-v3.ts`，不在默认测试发现目录。MXC 目录测量 wrapper 只在 task-owned 运行副本记录 worker resourceUsage，不修改生产入口或隔离策略。

2026-11-13 用户报告 Codex 崩溃并要求限制、清理测试后，本轮停止且不自动重跑大规模压测。MXC 50,000 文件仅 copy 完成（562,011.1968 ms，3 个实际 RPC，最大请求/回复 1,095/810 字节）；move 未完成，delete 未开始，不计作通过。原压测进程已不在；两个精确登记的压测临时根已删除。首次 CI run `43303174955` 已取消，不满足最终 head 门禁。

本轮测试清理删除 19 个过期/重复用例及两份复制执行器，将 36/15 会话成本矩阵移到手动 benchmark。默认实际 native 效果回归缩为 70 项，仍跨越 inline/page 边界；2,000 行纯元数据覆盖保持。通过新运行器串行运行 7 个相关文件、50 项检查（单文件约 0.26–5 秒），以及一个实际 SDK changes/reopen 回归和类型检查。没有再次运行大规模分配/目录压测。V8 老生代限制不等于含 Buffer/native 分配的 RSS 硬上限。

最终 head 审核和六个 CI 分片仍待完成。没有等价旧实现全覆盖的同机对照，因此本记录不声称速度或分配总量改善。

## 审核修正与有界复核

初轮审核的五项问题均已在生产路径核实并修正：

1. 同卷 link/unlink 与校验 copy/unlink 都在最后一次目标检查之后重查源身份，再进行源删除。四个单文件回归分别注入源内容变化与源路径替换；均保留源并报告 partial。
2. copy 的独占 open 之后，在写入任何源字节前检查父目录、打开文件与命名对象的身份及单链接所有权。父目录在 open 边界被 junction/symlink 替换时，新目标保持空文件，不泄露源正文。
3. attached manifest writer 只关闭句柄；失败的宿主分配 artifact 由宿主 registry 释放。普通 writer-created artifact 仍由 writer 清理。ENOSPC 回归确认当次无效果、两个 registry 清空且下一请求可以成功，不留下永久 cleanupFailure。
4. native 创建父目录事实在 commit 与终态投影前共用字节有界的样本，并保留完整计数、遗漏数及覆盖标记；准备记录只存可推导的父目录数量与 ancestor。32 层缺失父目录、长既有前缀的两项 batch 不再毒化日志，后项成功。另拒绝矛盾的 worker 父目录/遗漏计数。
5. 显式开启的子代理 file_result 经委派通道进入实际 journal owner，但必须匹配该任务独立前缀、已派发序号和受信任的嵌套来源；无需保存整份结果或无界 ref 集合。实际 CLI 子进程读完自己 70 个被省略的终态，查询其他父调用被拒绝并关闭通道。owner.dispose 清除 session、前缀、任务回调与请求引用。

在新资源约束下，8 个相关文件执行 84 项：80 通过、4 个显式平台/live/GC 跳过；另一个矛盾父目录计数回归通过。类型检查、串行 12 包离线构建与后续 coding-agent 定向构建通过。没有启动本地完整测试或再次运行大规模压测。

分配契约采用 32 项的小样本复核四个真实 native 会话操作、分页、共享新建父目录、分页后继续 edit，以及外部修改拒绝。copy/move/delete/batch 分别耗时 420.138/236.227/129.008/211.074 ms；峰值 heap 41,469,632、RSS 139,853,824 字节，累计分配采样估计 107,786,496 字节。主要采样位置为 V8 API、Node 文件 I/O/async hooks、路径规范化与 parseFileResultPayload；225 个 item/tree 引用受控 GC 后存活为 0，532 条会话历史为预期持有。样本与旧 2,000 项工作负载不同，不作耗时或分配改善对比。

目录 copy/move/delete 及 batch 的 deny/ask 规则覆盖后代路径，显式 ask 不交给自动审核放行。删除在父目录检查和 canonical 解析后最后读取源身份；两个单文件替换注入在修复前会误删新文件，修复后无效果并保留新旧文件。copy 的目标可使用指向已钉住父目录的词法别名，重定向至其他父目录仍不能写入源正文。POSIX 新文件从 0600 创建并通过句柄恢复源的 rwx 权限；新目录仅额外保留 owner 的填充权限，全部填充后从下往上恢复原 rwx 权限，不把 0700 私有目录或 0600 文件改成公共可读。此处不宣称复制 ACL、属主或特殊 mode 位。

对应 7 个文件的定向检查为 73 项通过、1 项 POSIX 平台跳过，类型检查与 coding-agent 构建通过。实际 SDK 混合工具/重开测试改用当前 v3 commit 故障边界和完整分页回执，不再依赖已退役的 v2 执行记录。Windows 的最新 32 项分配复核耗时约 1.47 秒，峰值 heap 44,092,880、RSS 140,750,848 字节；累计采样估计 109,151,960 字节，225 个临时引用存活为 0，532 条历史保留。POSIX rwx 回归由 Linux CI 验证。
