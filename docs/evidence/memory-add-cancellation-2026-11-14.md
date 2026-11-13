# 记忆添加的取消边界

日期：2026-11-14。基线 main `d370715a0dfc34972b9bc45a98a422a461cd14ce`，Node 26.13.0 / Windows。只修复显式 memory add 的取消语义，含 failure 分支。

## 问题与生产复现

使用构建后的 registerMemoryTool → MemoryStore → SQLite Markdown 写锁 → checked publication，不替换写入算法，不读取个人记忆。独立任务目录内的生产探针在改代码前确认：预先取消、写锁排队期间取消、failure 添加取消、临时文件准备好但尚未发布时取消，四种情况均仍保存并返回 success。普通添加、下一调用及发布开始后取消三个对照均成功。

根因是 _add 的 signal 仅传递而未使用；锁等待及发布入口没有取消检查，failure 工具分支没有把信号传给 addFailure。该逻辑早于本轮 LSP 改动。

## 修复与提交边界

- 复用现有信号、SQLite 锁和 checked publication；锁的上限、过期与所有权规则不变。排队的 abortable delay 只服务显式写入调用，取消不释放另一个调用的 lease。
- 添加前、锁等待、取得锁后、读取规范文件后及第一条 canonical link/rename 派发前检查取消。FIFO 与 failure 添加复用相同路径；取消时重新装入磁盘状态，清除本次暂存文件，旧条目与搜索结果保留。
- 第一条 canonical link/rename 派发后不再用取消信号打断本轮发布：完成身份/内容核验、恢复与索引对账，按实际结果返回。保留既有外部修改检测、冲突处理和错误传播。
- 修改属于显式写入、锁等待及清理生命周期，未触及通知、进度、渲染或 Evidence Ledger 热路径；跳过额外热路径分配基准。不增加审批、命令预检、条目上限或后台工作。

## 回归与验证

四项新增生产回归覆盖：取消的普通/failure 添加与索引不变；取消排队者在持锁者释放前退出且下一调用正常；发布前取消保留普通条目及 FIFO 将被淘汰的条目、清除临时目录；新建/替换的发布开始后取消仍完成落盘与索引对账，并可继续下一调用。最小选择运行 5/5 通过（含既有菜单取消回归）。

冻结候选验证：根 check、memory check 通过；memory test 33/33；离线构建 12/12；完整根测试 461/461 单元退出成功，共 6172 项，6056 通过、116 按既有条件跳过、0 失败。memory lifecycle 注册/启动/关闭为 2.160/4.232/1.063ms、4 个工具；smoke:rpc 的 12/12 构建及真实 RPC 查询通过，仅注册 memory。实际 TypeScript LSP 对三个变更源文件 3/3 确认、0 诊断。最终生产探针的四个发布前取消均拒绝且不落盘，三个对照保持成功。PR 审查与原有六个 CI job 必须对应最终 head。真实 5 万文件压测不属于本任务。

## 重跑

先将子进程 TMP/TEMP/TMPDIR 指向专属 `.task-tmp/<task-id>-<unique-id>/`，构建与消费 dist 的测试顺序执行：

```powershell
npm run build --workspace packages/memory
node --test --test-name-pattern='cancel' packages/memory/tests/memory-management.test.mjs
npm run check
npm run check --workspace packages/memory
npm test --workspace packages/memory
npm run build:offline
npm test -- --keep-going
npm run benchmark:lifecycle --workspace packages/memory
npm run smoke:rpc --workspace packages/memory
```

生产阶段注入的复现方法：通过实际注册的 memory 工具传入已取消信号；持有实际 acquireMarkdownMutationLock 的 lease 后观察第二次 tryAcquire，取消排队者；在实际 readFileState 完成且 `.tmp-*` 存在时取消；在 canonical link/rename 完成时取消作为提交后对照。每项都核对规范文件字节、工具终态及下一调用，临时探针不进入日常测试发现。
