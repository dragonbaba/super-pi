# 文件操作 v3 验收记录

日期：2026-11-13（Asia/Tokyo）。基线为 B 的合并提交 `f6fe77936da78244128e265802325a86cf76d401`。本记录对应 `codex/file-ops-v3` 候选；最终完整回归、50,000 文件目录、PR 审核和 CI 尚待完成，不表示已合并。

## 实现与生产入口

`SessionFiles` 为 native 与 MXC 统一安装 write/edit/copy/delete/move/file_batch，保留现有权限边界。所有参数、路径身份、受保护树和全调用冲突先检查，再一次授权，之后才发布 ready 和逐项 intent。copy 源按读取、目标按写入判定；D5 外部已有目标覆盖仍停止整轮。子代理的文件变更经父执行入口，file_result 只查询子会话。

新调用不设目标数量上限。内部请求按实际序列化 JSON 分块，最多 4 MiB；回复最多 256 KiB；write/edit 正文合计仍最多 1 MiB。结果日志复用现有会话 custom entries，绑定实际返回的条目 ID、原调用、权限代次和准备清单 Merkle root。无正文或完整 diff 副本。file_result 每页最多 128 条且实际 JSON 不超过 64 KiB，不启动文件 worker，不恢复原生读取版本。

共享的文件创建、树遍历、流式复制与发布 owner 负责两条执行链路；原生同卷 move 保留独占 link → 验证 → unlink，跨卷和 MXC 使用流式复制、目标重读哈希、源身份复核后删源。真实 MXC 在同一挂载和不同授权挂载均拒绝硬链接，故 move 在执行前固定选择 `copy_unlink_verified`，没有失败后回退或重放。目录目标用独占 mkdir，不合并或覆盖已有目录；删源仅用非递归 rmdir。

生产 MXC v2 mutation 分发和独立的 core v2 batch 执行器已退役，历史生产者仅在明确命名的测试 fixture。v1/v2 历史记录解析保留原预算。随源码扩展中为旧嵌入 API 保留的兼容实现，在有 SessionFiles 的当前运行时跳过注册；当前 CLI、Codemode 与子代理使用同一个 v3 owner。

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

每组均逐项核对实际磁盘、全部终态分页和适用的 SHA 连续编辑。前三个 MXC 操作的最大请求/回复分别为 28,185 / 14,914 字节；独立 batch 为 25,832 / 14,908 字节。每组结束时交换 artifact、队列、reservation 为 0，active process、retained streams、child、Job 均为 false。没有把 worker-only 或 VM fixture 的成功记作实际 MXC 成功。

首轮连续 MXC 压测中 batch 在 1,389 项成功后出现传输不完整，记录 1 项未知、610 项未启动，后续不再派发并清理完成。同期宿主 PowerShell 报 OOM，机器 commit 接近上限；没有证据把根因归到某个用户进程或本改动，也没有结束用户进程。后续以上述独立新 fixture 测试 2,000 项，没有重放未知调用。该首轮不计作成功样本。

## 定向回归与安全边界

- `file-result-v3` / `file-result-owner-v3` / source invariant：33 项通过，含第 17、513、2,000 项、实际 JSON 页预算、错误分支/cursor/源参数、断链、准备清单篡改、无终态 intent、记录失败与 writer 引用释放。持久化会话日志超过 2 MiB，派生后删除原会话仍能分页读取。
- `file-mutation-v3` / `file-changes-v3` / queue / trie：20 项通过，含完整顶层目标覆盖、剩余草案、数组继续与 batch 停止、最后目标拒绝无前项效果、dryRun 无记录无目录、全量计数和有界样本。后续计数修正的 dryRun/source gate 3 项通过。
- 实际 C: → D: 跨卷文件/目录回归通过；迁移中新增文件和修改尚未迁移文件均保留在源，结果 partial。共享树与 worker 的 22 项定向回归覆盖嵌套复制/移动/删除、源目录变化和大于 4 KiB 的共享创建父目录 artifact。
- 实际 MXC 小会话 write/read/连续 SHA edit、受保护路径、PowerShell 7 和清理通过。进程替换 fixture 仍使用真实 backend 的序列化、计量、回复验证、artifact registry 和共享 worker，覆盖 12 类发布后丢失/矛盾回复及下一请求的清理边界；不代表实际隔离进程测试。
- Codemode 当前 v3 回执、提交事实与取消回归 10 项通过；真实 CLI 子代理转发及 D5/D6 回归 6 项通过；false-success guard 回归 18 项通过。自动审核附件新旧回执回归 9 项通过、1 个 POSIX FIFO 在 Windows 跳过；大批次早期项和有哈希的 copy 目标可核对，变化后的内容不附入审核请求。

## 分配、复杂度与生命周期

完整链路审计范围为 SessionFiles → FileMutation → FileService/SandboxFileService → 原有 SessionManager.appendCustomEntry/条目索引 → FileResultReader → FileChangesV3/false-success consumer。生产进度条目不逐项触发整份 UI 历史重建。FileExecution 在调用锁作用域内只建立一个固定 active slot，源约束检查拒绝在目标循环内创建回调、Promise executor 或 AbortController。OS I/O 的 Promise 属于文件操作边界；审批、调用准备、显式 /changes 命令及关闭为独立生命周期。

native 2,000×4 的初轮 profiler：采样期间峰值 heap 169,571,000 字节、RSS 412,545,024 字节；HeapProfiler 的累计采样估计 5,453,715,416 字节，包含 fixture/profiler 和结果核对，不是精确总分配。清除 node:test mock 的返回 Promise 历史后受控 GC，14,000 个 prepared item/tree WeakRef 的存活数为 0；32,012 条会话历史记录为预期持有，单列而非计作泄漏。最终冻结候选将重跑并记录主要分配位置。

按相同路径形状递增 100/1,000/10,000 项，trie 的路径访问数为 4,000/40,000/400,000，节点为 418/4,018/40,018，身份数等于目标数。一次定向运行的耗时 0.685/3.963/39.932 ms，heap 增量约 0.30/1.08/13.37 MiB；数字包含平台绝对路径深度，节点/访问增长为线性，不使用两两路径比较。临时 trie 属调用预检，未存入全局缓存。

## 复现与待完成门禁

普通检查：`npm run check`、`npm run build:offline`、`SP_TEST_JOBS=1 npm test -- --keep-going`，构建和消费 dist 的测试不并发。Windows 长嵌套 SQLite fixture 在本次环境使用 task-owned 的短 TMP；相同短 TMP 下的定向复现通过，没有为路径长度修改 SQLite 或产品代码。

实际 2,000 项：设置 `SUPERPI_FILE_V3_STRESS=1`，运行 `node --expose-gc --experimental-strip-types --test tests/file-operations-v3-live.test.ts`；可用 `SUPERPI_FILE_V3_STRESS_OPERATION=file_batch` 选择独立 fixture。50,000 文件：设置 `SUPERPI_FILE_V3_TREE_STRESS=1` 与 `SUPERPI_FILE_V3_TREE_ENVIRONMENT=native` 或 `mxc`，运行 `tests/file-tree-v3-live.test.ts`。MXC 目录测量 wrapper 只在 task-owned 运行副本记录 worker resourceUsage，不修改生产入口或隔离策略，随 owner 关闭清理。

尚待填入最终目录测量、完整检查结果、最终 head 审核和六个 CI 分片。没有等价旧实现全覆盖的同机对照，因此本记录不声称速度或分配总量改善。
