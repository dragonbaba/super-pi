# 动态 find 循环与执行前参数校验

基线：PR #70 合并后的 `874d91469`。分支：
`codex/dynamic-find-loop-and-preexec-validation`。本批未提交、推送或创建 PR。
Windows / PowerShell / Node 26.4.0，Git Bash `D:/Git/bin/bash.exe`。

## 范围与实现

### A：有限的动态文件列表

`readonly-find-loop.ts` 对整条源命令做有界、保留引号身份的识别。生命周期检查、
高风险扫描、权限分类使用同一判定，成功后仍执行原始字节。最多 4096 个字符、
256 个词和 32 个循环体命令；正则和固定集合位于模块内。请求边界分配的词数组
和谓词参数数组只属于本次扫描，无全局结果缓存，不进入进度或渲染路径。

接受的列表是 `$(find <一个字面相对起始路径> <只读谓词> [| sort <安全选项>])`。
沿用 find 谓词白名单：布尔组合、name/iname、type f/d、maxdepth、print/print0；
没有 exec、ok、delete、fprint 等动作。起始路径不接受选项、绝对路径、盘符、
网络路径或变量。sort 仅接受 stdin 与短选项 u/r/n/V/f（可组合），不接受文件
参数、输出/临时目录/压缩程序选项；同一规则也用于独立 sort 分类。

循环体只接受以下最小集合：

- `node --check -- "$f"`、`cat -- "$f"`、`head -n N -- "$f"`、`wc -l -- "$f"`；
- echo 标签中的双引号变量引用，含 `${f}`；
- 命令末尾的 `2>&1`、`;`/LF、`&&`、`||`，以及仅通向 `head -n N` 的管道。

仍拒绝原反馈中的 `out=$(...)`、没有 `--` 的动态文件参数、动态 `< "$f"`、
嵌套/后台循环、输出重定向和通向 sh 的管道。未识别的命令交回原扫描器。
循环生命周期拒绝提示增加了可接受的 Node 检查示例，不会自动修改或重试命令。

未加引号的 find 输出仍会被 Bash 按空白拆分并做 glob 展开。本批不保证处理了
每个原始文件名，也不转换成 NUL 分隔迭代；拆出的字符串只能成为 `--` 后的
单个引号操作数或 echo 数据，不能成为选项或 shell 输入重定向目标。真实夹具
包含拆出 `--require=payload.cjs` 的文件名及可写入隔离 `.git/config` 的载荷，
接受的命令没有加载该载荷。这不是任意 shell 脚本的沙箱，也没有扩展 zsh 支持。

### B：由 agent 证明尚未进入 execute

mutation-guard-write 的 edit 使用新可选同步钩子 `validateInput`，检查缺 snapshot、
exact 模式字段、快照操作字段和插入形状。调用位置是最终授权检查与 consume 之后、
execute 之前。输入已通过原 schema 校验；钩子契约要求纯形状检查，不得修改参数、
执行 I/O 或返回异步操作。文件、快照仓库与读取凭据检查仍留在 execute 内。
原有错误文本与 Retry 内容保持，不再新增一遍公共 schema 检查。
复审后补充：edit 的 execute 开头也调用同一纯校验函数，以防包装器丢失可选钩子。
正常错参仍在 execute 前拒绝；钩子缺失时退回原先的执行内拒绝，不声称 not_executed。
有效 edit 多一次纯形状检查，位于调用边界，不进入进度、事件或渲染热路径。

两个原生 edit 的 prepareArguments 恢复原有字段归一化，空 edits 数组移到
validateInput；保留直接 execute 的防御检查。原校验辅助函数改为返回 void，
execute 直接使用 input 的字段，避免成功路径为提取两个字段再分配对象。
ToolDefinition 与 AgentTool 两个转换方向都直接转发钩子，不包装闭包、不生成上下文。

首方工具审计：write 必填字段已有 schema 执行前校验；file_batch 的额外字段与
模式检查已在 tool_call 预备阶段完成；delete/move 路径形状由权限阶段的
prepareNativeOperation 校验。它们不新增重复准备流程。文件身份、缺失/失效
快照、读取凭据、提交与写入状态检查保留在原边界。

agent-loop 用模块私有 WeakSet 标记自己构造的执行前错误结果。新增形状校验失败
仍走普通失败收尾，记录内部 inputRejected，不设置 authorizationVeto，因此
afterToolCall/tool_result 照常运行。授权否决仍按旧语义跳过结果钩子。
只有执行前返回、授权否决或 agent 记录的校验失败能消费这个标记，再把布尔事实
保存在本次嵌套调用中。结果钩子替换内容与结束观察失败都不丢失它。实际进入
execute 后，即使工具返回曾经观察
到的同一个 agent 错误对象，仍不采信其标记。WeakSet 不强持有结果、不向工具
开放写入口，也不从 details、错误文本或工具返回的同名字段推导权限。

NestedToolResultMessage 携带可选 executionStatus: "not_executed"；Codemode 据此构造非 Shell
ChildFact。折叠树沿用原 mayHaveSideEffects 逻辑，未修改组件：全未执行时去掉
副作用警告；已执行、未知结果或混合调用继续提示。模型摘要由 `edit: failed`
变成 `edit: not_executed`，不附加 Shell exit 字段；原错误、失败状态及模型端
“不要自动重试变更”提醒保留。没有修改持久写入凭据或结果内容的可信规则。

原先把校验移入 prepareArguments 的方案被撤回：它会跳过 guardrails 的结果处理。
最终方案未改变 agent 的事件流程，也未让 schema/prepare 失败额外发出结果钩子。
两条原恢复测试的测试体和预期保持不变。夹具将“已获准调用的结果处理次数”与
“真正进入 execute 的次数”分开，后者仍逐 ID 检查不得重放；原 32 次调用/结果
处理、8 次 steering、8 次提交的断言保留。新增真实 AgentSession/Codemode 回归
验证同一脚本前两次缺 snapshot 都产生 tool_result、第三次 REPEATED_CALL_BLOCKED、
实际 execute 为 0、折叠卡片无副作用警告、下一模型请求恰有一条隐藏 steering。
另以真实 guardrails 的 failureRecoveryHint 验证结果变换仍被交付到子调用结束事件。

## 验证与性能证据

证据目录 `.git/dynamic-find-preexec-20261006/`。新增核心回归在基线下复现：
动态循环被 lifecycle 拒绝；非 Shell 准备失败没有状态；缺 snapshot 仍显示警告。
既有拒绝行为作为安全对照保留。真实 Agent/Guard/Bash 覆盖三种权限模式；静态
与实际执行测试分开，保护路径只位于测试自己创建并登记清理的临时目录。

调用链审计：prepareArguments/schema → prepareToolCall/tool_call → 最终授权 consume →
validateInput → executePreparedToolCall 的失败收尾 /
finalizeExecutedToolCall → runNestedToolCall → Codemode.runChild → 完成摘要 →
AgentSession / InteractiveMode → CodemodeTree → terminal frame queue。
tool progress 的 ToolProgressDelivery → emitNested → Agent observer → Session
同步事件桥和树组件方法未改。新增状态只在一次调用的准备/收尾边界处理，不按
进度重复创建对象、闭包、Promise、控制器、正则、数组或完整结果字符串。

校验钩子直接转发并同步调用，无新增闭包、Promise、上下文对象或 await 边界；
AST 回归对此检查。错误路径仍分配原错误、结果和通知。agent 新增一个模块 WeakSet，
只向其中登记执行前失败对象；正常执行不登记、不新增状态对象。未新增动态正则、
String 构造调用或对象池。

纵深防御补充前的本机采样（本轮未重跑）：

- 正常 SDK 会话基线/最终候选的采样宿主分配为 25,898,848 / 26,264,912 bytes；
  first-batch p95 为 44.421 / 42.614 ms，warm-batch p95 为 43.944 / 42.805 ms。
  两侧均 242 次子调用、22 个 Worker 启停配对、55 个跟踪引用 GC 后无残留、
  未完成读取证据为 0。单次采样有波动，不据此宣称加速。
- 新增 `scripts/bench/codemode-preexecution.ts` 使用真实 mutation 校验钩子、
  Agent/SDK/Codemode/Worker：校验、tool_result、结束事件各 176 次，执行/进度
  均为 0；11 个
  Worker 全部关闭，220 个跟踪引用在 abort/disposal 后的受控 GC 中全部释放。
  排除预热的 10 轮宿主采样分配为 14,950,120 bytes，包含恢复后的结果处理链。
- 折叠树基线/最终候选分配为 4083.38 / 4075.65 bytes/update，p95 为
  0.0056 / 0.0055 ms。每侧 4352 次进度只创建一个行对象，事件 Promise、
  进度结果投影与结果引用为 0；释放后行/文本/计时器/结果引用均为 0，两个
  WeakRef 全部释放。终端队列 20000 帧样本的逐帧 Promise、AbortController、
  包装对象及完整帧复制均为 0，flush 后活动/待写帧及字节均为 0。

纵深防御补充前的联合定向验证：11 个文件共 387 项，386 通过、1 跳过、0 失败，包含 A 的
三种权限模式真实执行与拒绝矩阵、B 的原生/嵌套调用、原恢复测试与热路径检查。
全量 npm test：225 个执行单元全部 exit=0，3,597 项中 3,507 通过、90 跳过、
0 失败、0 取消。独立文件发现清单、--list、START/END 清单逐项一致且无重复；
memory workspace 计入独立单元，计数按每个执行单元的最终测试汇总累加。

该候选的 npm run check、离线构建、20 个修改/新增源码与测试/基准脚本语法检查、
git diff --check 均通过。日志明确登记的 137 个夹具路径与可定位的 2 个 runner
根目录均已释放；未据此声称扫描或清理了整台机器的临时目录。A 的 6 个源码/
测试文件与复审前记录哈希一致；原恢复测试从第一条测试起的全部测试体与 HEAD
一致，只有共享夹具增加了独立的结果/执行计数。

上述补充前结果与源码哈希见 `final-summary.json`。`partial-summary.json` 和早期失败日志
只用于保留被撤回方案的排查证据，不代表当前候选。四份该轮分配基准日志均以
`final-` 开头，沿用 main 基线样本；测试与基准顺序运行，避免采样时争抢资源。
本批 GitHub CI、Linux / Node 22.19 和真实交互终端人工检查未执行；没有提交、
推送或创建 PR，交 Claude 复审。

### 复审补充：execute 内的防御校验

在 mutation-guard-write 的 edit execute 开头加回 `validatePublicEditInput(input)`，
与两个原生 edit 的防御一致。本轮没有更改 agent 事件流、可信标记或 A 的识别规则。
新增回归先移除实际工具的 validateInput，再直接调用 execute：缺 snapshot 的
输入仍须抛出 SNAPSHOT_REQUIRED，目标内容保持不变。补充前该用例失败，错误
落成 NO_OP_EDIT；加回校验后通过。正常 Codemode 的提前拒绝、重复拦截、steering、
恢复提示及伪造标记对照也一并重跑。

mutation-contract-recovery、nested-tool-dispatch、codemode-session 三个文件共
136 项，全部通过，0 跳过；npm run check、两个修改 TS 文件的语法与 diff 检查通过。
按本轮要求未重跑全量、离线构建或分配基准；上面的 3,597 项全量结果属于补充前
候选，不能当作当前新增测试的全量结果。日志为 `defense-red.log`、
`defense-targeted.log`、`defense-check.log`，当前源码哈希见 `defense-summary.json`。
保持未提交；仍待 GitHub CI、Linux / Node 22.19 和真实终端人工检查。

## 文档同步

`codemode-compact-policy.md` 的当前状态已改为 #70 已合并，历史验证保留其时间边界。
基线中的 upstream 差异表已是“后续 C（已合并 #68）”，本轮核对后无需重复改写。
