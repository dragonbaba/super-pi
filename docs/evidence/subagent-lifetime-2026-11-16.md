# 子代理执行期限与编排指引

子代理原先在启动时创建总执行计时器，默认 30 分钟、最高 2 小时；到期后杀掉进程树，与任务是否仍在取得进展无关。现在移除这层计时器、超时状态以及 single/tasks/chain 的 `timeoutMs` 参数。运行到完成、明确取消或会话撤销为止；provider/IPC 请求超时、进程树升级终止和真实退出后的资源释放仍保留。

`tasks` / `subagent_tasks` 的 `wait.timeoutMs` 保持原语义：等待到期或取消等待不会终止任务。普通 Bash/PowerShell 的显式命令运行时限也保持原语义。并发、排队、检查点保留容量和结果容量是独立的资源边界。

## 已有能力与本次对齐

原有实现已具备共享 FIFO、任务身份、前台转后台、完成通知、运行中检查点纠偏和显式检查点续接。本次在现有入口补齐指引：后台运行时继续独立工作、优先消费完成通知；用 `tasks steer` 纠正同一运行任务；结束后先验收交付物，复用成功成果，只委派未解决部分。子代理同时收到直接使用搜索工具、复用已核实环境事实的指引。没有新增自动代理、自动工具重放、语义脚本限制或确认流程。

对照来源为 [Claude Code 子代理文档](https://code.claude.com/docs/en/sub-agents) 与 Codex 固定提交 `630c0d75abbe74784a35673926868cc4133ef6fa` 的 [wait](https://github.com/openai/codex/blob/630c0d75abbe74784a35673926868cc4133ef6fa/codex-rs/core/src/tools/handlers/multi_agents/wait.rs)、[v2 wait](https://github.com/openai/codex/blob/630c0d75abbe74784a35673926868cc4133ef6fa/codex-rs/core/src/tools/handlers/multi_agents_v2/wait.rs)。前者提供聚焦职责、独立上下文及前后台工作的公开依据；后两者把期限施加在等待上，没有因此终止代理。这里没有把 Claude 的公开使用说明当作闭源内部实现，也没有把 hosted API 功能视作 Codex OAuth CLI 能力。

## 验证与范围

- 前台、后台各一个真实子进程回归：用受控父进程时钟推进超过原 2 小时上限，原实现两个用例均失败；修改后同一 PID 和任务仍运行。恢复真实时钟后明确取消、等待退出，再显式启动下一任务；无残留进程、无自动重跑，保留的 ready 标记仅对应两次显式任务。
- 工具 schema 的三层执行 `timeoutMs` 均已移除；子进程收到的新职责与提示已经验证。管理工具的等待参数仍存在。
- `npm run check` 和 `npm run build:offline`（12/12）通过。受影响回归覆盖调度、进程/IPC、CodeMode、统一后台任务、源代码和分配不变量；一处旧提示文字断言修正后，管理回归 45 成功、1 平台跳过，0 失败。
- 改动位于启动、schema、提示和关闭生命周期。正常 stdout/stderr、消息、progress 和渲染调用链未修改；已有热路径 AST 不变量通过。这里跳过分配基准，不声称性能数值改善。

上述是离线夹具和真实本地子进程验证，没有调用远端模型，也不能替代真实长任务/provider/沙箱服务验收。实际时长由受控时钟推进；不声称持续运行了两小时。

按任务顺序最后完成的桌面能力核实见 [computer use 评估](computer-use-assessment-2026-11-16.md)。
