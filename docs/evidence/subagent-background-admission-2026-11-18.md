# 子代理后台接纳与完成唤醒

在活动工具仅有 `subagent` 的 TUI/RPC 会话中，提交带 `background: true` 的单项任务会在创建任务记录前被拒绝。Print/JSON 会话会因为模式不支持后台执行而被拒绝。原提示没有给出前台调用参数。

参数描述现在同时声明默认前台行为和后台所需的会话模式、原生管理工具。启动拒绝会说明子代理尚未启动，并给出省略 `background` 或设为 `false` 的前台方式。移交和纠偏的提示只报告当前管理条件。

后台接纳和前台移交回执使用同一条指引。保留任务 ID，独立工作做完后可结束主回合，完成报告会唤醒空闲会话。已接纳的工作按原 ID 查询。报告要求主代理验收并复用已有结果，检查失败任务及工作区后只分配尚未解决的职责。报告继续标明部分成果和容量交接，并保留任务数据的权限边界。Claude Code 也将后台完成结果交给之后的主回合。[Claude Code 后台子代理](https://code.claude.com/docs/en/sub-agents#tools-permissions-and-results-of-background-subagents)

管理回归覆盖两种拒绝、无残留任务 ID、以及禁用管理工具时的显式前台调用。离线集成回归使用受控退出的真实子进程，确认主代理正常结束后子进程仍存活。子进程退出后，仅有一条含原任务 ID 的报告进入下一次模型请求，并且仅启动一个后续主回合。

Windows 上 87 项测试通过，5 项按运行条件跳过，类型检查和 12 包离线构建通过。变更位于工具定义、接纳和终态报告阶段，未触及进度、流式传输和渲染热路径。

```powershell
npm run check
npm run build:offline
node --experimental-strip-types --test tests/subagent-parent-execution.test.ts tests/subagent-management.test.ts tests/custom-message-ordering.test.ts tests/agent-settled-aborted.test.ts
```

- Pi 示例用子进程执行单项、并行和链式任务。Super Pi 也为子任务启动独立进程，启动成本需要按同角色、同模型的首个有效事件单独测量。[Pi 子代理示例](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/subagent/index.ts)
- OpenCode 使用同一个子会话 ID 接受后续指令。Super Pi 当前使用检查点和新任务 ID 继续工作，后续可评估在接纳、通知、终态查询之间保留更完整的关联。[OpenCode 子代理](https://opencode.ai/docs/tools/#subagent)
- Pi Durable 用后台任务和请求 ID 恢复工作及去重通知。Super Pi 当前在会话退出后保留终态历史和可选检查点。跨进程恢复需要独立验证中断的工具、副作用和权限边界。[Pi Durable 后台子代理示例](https://github.com/earendil-works/pi/blob/main/packages/durable/test/examples/22-subagent-background.ts)
