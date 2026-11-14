# 人工交互等待与取消边界（2026-11-14）

## 问题与修复

| 遗漏 | 最终行为 |
| --- | --- |
| 原生审批选择、拒绝原因输入有 60 秒期限 | 不设置人工等待期限；未回答时不交付执行许可 |
| TUI/RPC 共享入口仍执行扩展传入的旧 `timeout` | 统一忽略对话超时；旧字段保留类型兼容，RPC 不再发送超时字段，显式 signal 取消继续生效 |
| 沙箱联网审批有独立的 60 秒期限 | 持续等待，命令执行及联网授权均在回答之后 |
| 沙箱审批的迟到答复仍能在取消或权限切换后启用联网 | 授权提交前重查执行信号；下一条命令仍需询问 |
| 扩展 `project_trust` 的外层机器预算包含人工等待 | 复用 `ToolCallDeadline`，仅在真实 select/input/confirm 期间暂停；回答后恢复剩余机器预算 |
| 原生权限测试要求倒计时；浏览器 schema/README 要求扩大父脚本时限来等子调用 | 测试改验无倒计时及明确取消；工具提示说明父脚本计算时钟在子调用期间暂停 |

核对原有 71 个直接 UI 调用点及外层计时入口。`ask_user` 已无超时并隔离同批业务调用，普通 tool_call hook 与 CodeMode 的人工等待计时沿用现有暂停机制。Auto 模型审查保留独立的请求期限，未完成时转人工等待；浏览器子进程自身的连接/执行期限保持原含义。取消的人工审批不是 Auto 拒绝，因此 `/permissions auto` 不会列出它。

既有设计依据：[CodeMode D4](../codemode-recovery-repair-plan.md#3-用户已确认的决定) 中审批等待不消耗脚本时限的约定，以及[兼容权限说明](../../packages/extensions/resource-lifecycle-guard/README.md) 中对话无自动超时、等待明确选择或取消的规则。本文不记录真实用户会话或配置。

本次不触及 delta、progress、渲染或分配热路径。`invokeProjectTrustHook` 只在启动/重新判断信任时建立；每个 hook 独占一个期限 owner，完成后 dispose，真实 handler/dialog 的跟踪沿用既有 owner。`InteractiveMode.showExtensionSelector`、`showExtensionInput` 和 `createRpcDialogPromise` 的变化只在建立低频人工交互时发生，组件 render 和计时器组件不变；删除审批期限及校验联网授权也在交互边界。跳过分配基准；相关 AST/source invariants 已通过。

## 验证

原生授权连接实际 TUI selector/input，模拟时钟推进 24 小时仍等待；拒绝原因再推进 24 小时也等待。覆盖允许、填写原因后拒绝、主动取消、停止回合；对话框结束后取消监听器为 0。

共享入口的真实 TUI 三种对话，以及 RPC 三种请求均验证：即使扩展传入旧的 10 ms 超时，推进 24 小时仍等待；用户回答或显式 abort 后完成，待处理请求和取消监听器均清零。修复前新增共享入口回归 4 项全部失败。

沙箱联网等待、取消/切换后的迟到授权、项目信任的三种 UI 等待均先复现失败再修复。下一次联网请求仍询问，active/queued/reservations 均为 0。项目信任回答后只恢复剩余预算：100 ms 中先用 20 ms，人工等待 24 小时，随后 79 ms 尚未超时、再 1 ms 正确失败。过期 handler 不能再打开审批窗，新的信任判断可正常批准。全屏权限测试验证 3 次真实渲染、明确取消后再询问、零对话计时器及零取消监听器。

宿主文件权限的真实删除/拒绝测试同样验证无倒计时，并在文件准备完成、真实 UI 已打开后再操作，替代固定次数的事件循环轮询。允许时文件实际删除，拒绝时原文件保留；关闭后 selector/overlay、详情和终端引用、取消监听器均释放，敏感目标仍拒绝执行。

- `npm run check`：通过。
- 原生权限、Auto、沙箱联网、信任 hook、全屏权限、共享 TUI/RPC、RPC client、宿主文件权限和 source invariants：构建后 152 通过、1 项 POSIX FIFO 平台跳过。
- CodeMode D4 串行子调用/审批计时、`ask_user` 阻断和嵌套交互边界：6 通过；合计 158 通过、1 跳过、0 失败。
- `npm run build:offline`：12/12 包成功；CLI 离线版本返回 `1.0.0`。构建产物核对原生、沙箱、TUI、RPC 均已去除人工交互期限；AST 核对直接设置对话 timeout 的调用点为 0。

均为离线受控验证，未重放真实用户会话或清理命令；运行中的 Super Pi 需重启以加载新的原生授权模块。

重跑入口：

```powershell
node --experimental-strip-types --test tests/native-execution-policy.test.ts tests/auto-review.test.ts tests/sandbox-stop-network.test.ts tests/extension-hook-timeout.test.ts tests/session-permission-modes.test.ts tests/source-invariants.test.ts tests/permission-interaction.test.ts tests/rpc-client-dispatch.test.ts tests/host-file-permissions.test.ts
node --experimental-strip-types --test --test-name-pattern="F-C6 D4|ask_user|interaction boundaries" tests/codemode-recovery/execution.regression.ts tests/interactive-control-images.test.ts tests/nested-tool-dispatch.test.ts
```

按仓库临时目录规则，将测试子进程的 `TMP`、`TEMP`、`TMPDIR` 指向本次独占任务根。
