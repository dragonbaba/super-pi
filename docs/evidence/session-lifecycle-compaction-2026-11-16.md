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

新增两个原生 V3 回归覆盖这些错误形态：后续编辑失败时，前后创建项和原文件均不变化、无失败调用的结果日志；修正后的下一次批量继续成功，读取版本没有被错误消耗。没有放宽匹配唯一性、读取版本或批量预检。批量/回执/取消边界/版本延续/实际 SDK 组合回归共 101 项，100 通过、1 平台跳过、0 失败。

## 验证

在旧源码上回放新增断言，两例分别复现临时 daemon cwd 和错误的 `TOOL_UNAVAILABLE` 引导；修复后通过。Python 离线夹具验证脚本 cwd、三次搜索复用、八标签边界和只关闭归属标签；生命周期夹具验证失败保留、取消等待和引用释放。模拟检查点写入失败后，重开 JSONL 能读到 provider receipt 和有界失败诊断，下一次普通请求不自动重新付费压缩。

`npm run check` 和离线构建通过（12/12 包）。全量 runner 完成 461 个执行单元：459 个首次通过；剩余两个分别修正诊断元数据断言、通过 npm 提供打包测试所需的 `npm_execpath` 后复测，23 项通过、0 失败。失败生命周期断言继续验证原消息/提供商上下文不变、撤销授权后 0 请求、0 陈旧检查点及引用释放；允许的新增条目只有精确检查的诊断记录。这里不是声称原始真实长会话的压缩失败已被复现或解决。

本次代码只修改请求文档查询、浏览器请求启动和失败生命周期，不修改 delta、进度、渲染或大型结果处理热路径；不运行分配基准。

维护的复跑入口：

```powershell
npm.cmd run check
npm.cmd run build:offline
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/tool-reliability-recovery.test.ts tests/codemode-session.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts tests/alpha-task-quit.test.ts tests/alpha-compaction-quit.test.ts tests/bundled-extensions.test.ts tests/codemode-hot-paths.test.ts tests/allocation-cleanup-hot-paths.test.ts
npm.cmd test -- --keep-going
```

测试子进程的 `TMP`、`TEMP`、`TMPDIR` 应指向各自 `.task-tmp/<task-id>-<unique-id>/`，并设置隔离的 `SP_CODING_AGENT_DIR` 和 `SP_OFFLINE=1`。真实提供商探测与上述离线回归分别计量。
