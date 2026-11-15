# 会话故障与远端压缩核实（2026-11-16）

## 已确认的问题

- 排查开始时，最新长会话有 1,306 条记录、约 89.2 MB；存在三条 `provider_completed` 远端压缩用量记录，没有本地 `compaction` 条目。这证明三次返回已被解析，不能证明本地检查点完成。旧版失败事件只发给当时的界面，无法从已关闭的界面恢复具体错误。本记录不保存私人会话内容、配置或真实请求。
- Browser Harness 在执行 Python 脚本前启动守护进程，启动代码未指定 cwd，继承 CLI 的临时工作目录。Windows 隔离进程验证：进程存活时删除该目录返回 `EBUSY`，退出后同路径删除成功。空标签归属文件也不代表目录可删除。
- 已激活的 `subagent` 是顶层编排工具，CodeMode 故意排除它；原先 `describeTools` 却把它描述为未激活，并引导重复搜索。未激活工具搜索为空又被误读为子代理缺失。

## 修改

- Browser CLI 从稳定父目录启动，预置 Python 在运行模型脚本前进入任务工作目录；脚本相对路径和标签归属保持不变。清理仍等待真实进程退出、只关闭记录的标签、使用现存 daemon；失败仍保留归属，不自动重连或停止共享 daemon。旧进程仍可能占用旧目录，本次未删除它。
- CodeMode 将顶层工具标为 `TOOL_DIRECT_ONLY`，使用顶层 schema；说明 `ALL_TOOLS` 的脚本范围，空搜索结果也明确只涉及未激活工具。没有开放嵌套编排或改变工具权限。
- 宿主把压缩失败/取消写为 `compaction-failure-v1`。仅保留触发原因、取消及扩展标记、512 字符以内单行界面错误，不复制请求体、响应、headers 或栈；诊断写入失败不应替换原始错误。它用于下次失败后的重启诊断，不是此次历史失败的根因修复。

## 压缩与更新核实

- 对照 [OpenAI Codex 当前远端 V2 实现](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2.rs)及[结果安装流程](https://github.com/openai/codex/blob/main/codex-rs/core/src/compact_remote_v2_installation.rs)：基本协议仍为 `compaction_trigger` → `compaction`；近期 retained-history、采样 hook 和 rollout-budget 修改不足以证明本次失败由上游更新导致。
- 本地相关历史：`492070c2e`（11 月 10 日）延迟构建保留消息分词器；`104355803`（11 月 12 日）传输计量和大请求处理。尚无复现证据把任一提交定位为此次压缩回归。
- 长历史的隔离副本以模拟提供商响应重放，压缩可完成；这是离线控制，不是原始失败的真实重现。
- 当前账号、相同模型、纯合成历史真实探测两次：源码工厂和路径加载扩展均完成普通请求、远端 V2 压缩和本地落盘；压缩前分别为 7,220 / 7,222 token，每次各保存一个检查点。这排除当前接口全面失效，不覆盖约 49 万 token 的原会话和当时的服务状态。
- 三次旧远端结果只有 hash/用量，具体错误和 opaque artifact 未保存；本轮不能恢复原始 artifact，也未重发私人历史或重跑已完成工具。

## 批量文件操作复核

会话中有 13 次 `file_batch`：11 次成功，40 个顶层文件项的 intent、commit、result 逐项对应，每次批量有一条 complete；另两次分别是后续编辑的原文不存在、匹配不唯一。两个失败回执均为 `executed: false`，没有该调用的提交日志，之后修正的四文件批量成功。现有证据不支持把这两次预检拒绝认定为部分执行或假成功。

上述是旧版整批拒绝行为的历史审计。用户要求改为：先确认实际文件/唯一匹配，每项先预检，普通失败后继续其他独立项，成功只反馈成功，失败仅提炼失败部分，成功项绝不自动重试。

当前 Native 与 MXC 的 v3 `file_batch` 在任何效果前检查全部项；文件或原文不存在、匹配不唯一、版本变化等明确未修改失败作为原序号的 `failed_no_change` 保存，其余独立项继续。失败项不获得执行能力，全部失败时不进入文件执行器。结构/路径冲突和权限校验仍保持整次调用边界；取消、授权失效、未知效果、需核验修改、日志/传输故障仍停止。失败占位记录复用授权的规范路径，保留请求、intent 和分页结果的绑定。

CodeMode 保留子工具的失败事实，对已完成且仅有明确未修改失败的批量返回 `CODEMODE_PARTIAL`，自动展示有界失败诊断并继续脚本；显式 `show` 不重复展示。正文仅有成功计数、失败序号/路径/原因和结果引用，失败样本上限 8 项，完整结果仍可分页查询。工具说明和 schema 要求组装批量前核实源路径及唯一匹配，不确定时先 dryRun，修正时只提交失败项。

回归覆盖 Native 缺失/歧义编辑、只重试修正项且成功项 mtime 不变；MXC 首/中/尾失败、验证阶段源变化、全部失败、无效拒绝协议及精确归属的临时清理；40 个全失败项保留完整分页结果、8 个摘要样本；真实 SDK 脚本在批量部分完成后继续并提交 store。MXC 夹具运行真实 worker 和宿主编解码/归属管理，仅替代进程启动，不声称真实 MXC 进程验收。

授权对话框期间路径改向仍在第一个效果前拒绝；执行期间把已批准目录替换为指向其他位置的链接时，停止后续项并保留两个位置的文件，下一次独立请求成功。任务完成检查继续阻止未修复失败，成功项不会进入修复请求或重开会话后的执行。

Native 发布/创建异常及 MXC 验证/执行回执共享无副作用的致命失败判定，跨包装保留 `stopInvocation`。MXC 的父目录改向和准备清单的完整性、写入、发布失败不能降为普通文件拒绝；只读预检中的文件内容变化仍按项失败。旧候选回放三个 worker 回归均失败，修复后通过；宿主集成覆盖验证/执行两个阶段、首/末项改向、同 inode 清单污染及 ENOSPC，并验证 0 越界文件效果和归属清理。新增共享模块同时加入宿主包和 MXC 的精确运行时资产表。

## 验证

在旧源码上回放新增断言，两例分别复现临时 daemon cwd 和错误的 `TOOL_UNAVAILABLE` 引导；修复后通过。Python 离线夹具验证脚本 cwd、三次搜索复用、八标签边界和只关闭归属标签；生命周期夹具验证失败保留、取消等待和引用释放。模拟检查点写入失败后，重开 JSONL 能读到 provider receipt 和有界失败诊断，下一次普通请求不自动重新付费压缩。

`npm run check` 和离线构建通过（12/12 包）。全量 runner 完成 461 个执行单元，6,094 项通过、116 项平台跳过、0 失败。最后补充最终项授权失效的停止边界后重新检查、构建，受影响的 Native/MXC、SDK、权限、恢复、协议和源码分配约束检查 367 项：366 通过、1 平台跳过、0 失败。失败生命周期断言继续验证原消息/提供商上下文不变、撤销授权后 0 请求、0 陈旧检查点及引用释放；允许的新增条目只有精确检查的诊断记录。这里不是声称原始真实长会话的压缩失败已被复现或解决。

致命失败标记与 MXC 清单边界补全后，重新检查及构建通过；扩展后的相关检查 405 项，402 通过、3 平台跳过、0 失败。新增错误标记仅分配在失败生命周期，MXC 顶层预检复用同一次身份采集，没有新增逐目录叶子、delta、progress 或 frame 回调；异常包装只保留布尔归因，不保留原始请求或大对象。

分配审计覆盖 `SessionFiles.prepareInvocation → FileMutation.prepare/execute → FileService.withPreparedItems / SandboxFileService → worker → FileResultWriter/Reader`，以及 `CodemodeController.runChild → boundCodemodeResult → show → parent completion/disposal`。新增分配是请求级失败占位/Map、仅存在预检失败时的有效项引用数组、有界失败展示和每个结果一个布尔标记；未新增 per-delta/progress/frame 回调、Promise、AbortController 或 wrapper。数组/Map 归属于单次调用，结束、异常、取消与 disposal 清空并释放；无对象池。

同机 Node 26.13、每种操作 100 目标，以 `9cd726d6c` 和最终候选运行相同成功工作负载；两版均验证 copy/move/delete/file_batch 的全部磁盘结果、完整分页和 1,620 条历史记录。HeapProfiler 采样总字节 345,586,784 → 339,685,112；峰值 heap 55,081,360 → 52,513,808，峰值 RSS 162,504,704 → 165,908,480；四次受控 GC 后 heap 26,997,464 → 26,762,848，RSS 101,294,080 → 99,258,368。两版 701 个计划弱引用均剩余 0，pending/revision 均为 0。批量 CPU user+system 500 → 563 ms，四类合计 2,501 → 2,624 ms，批量耗时 486.68 → 487.78 ms；单次采样不支持性能改善结论。主要分配点仍是路径解析、文件系统状态/异常和日志解析；新增失败行为另由上述回归验证。

CodeMode 同机等量 SDK 基准（10 采样周期、1 预热周期）：两版均完成 242 子调用，11 Worker 启动/停止，55 个弱引用经 GC 后剩余 0，待处理 evidence 为 0。宿主采样 30,079,568 → 30,151,992 字节；首次批量中位数 26.30 → 26.29 ms，暖批量中位数 12.59 → 12.60 ms。主要分配点为 split/join、createContext 和 stringify；这是离线提供商和宿主 heap，不覆盖 UI 或 Worker heap。

维护的复跑入口：

```powershell
npm.cmd run check
npm.cmd run build:offline
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/tool-reliability-recovery.test.ts tests/codemode-session.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts tests/alpha-task-quit.test.ts tests/alpha-compaction-quit.test.ts tests/bundled-extensions.test.ts tests/codemode-hot-paths.test.ts tests/allocation-cleanup-hot-paths.test.ts
node --expose-gc --experimental-strip-types --test tests/file-mutation-v3.test.ts tests/file-sandbox-service-v3.test.ts tests/mxc-file-mutation-worker-v3.test.mjs tests/file-rpc-chunks-v3.test.ts tests/file-mutation-source-v3.test.ts
# 设置 SP_FILE_BENCH_TARGETS=100 后运行等量分配检查
node --expose-gc --experimental-strip-types --test scripts/bench/file-mutations-v3.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts
npm.cmd test -- --keep-going
```

测试子进程的 `TMP`、`TEMP`、`TMPDIR` 应指向各自 `.task-tmp/<task-id>-<unique-id>/`，并设置隔离的 `SP_CODING_AGENT_DIR` 和 `SP_OFFLINE=1`。真实提供商探测与上述离线回归分别计量。
