# 原生压缩与 CLI 钩子超时（2026-11-16）

基线 `46527635dac884f77ed8cb93a36ed539852783ce`，Windows、Node 26.13.0。手动 Codex 压缩越过缺失 commitment 的前置检查后，被报告为 `session_before_compact` 钩子在 30000 ms 超时，外层随后中止操作。原始用户会话保持只读。

## 机制与修改

CLI 的 `CLI_EXTENSION_HOST_POLICY` 为安全/否决钩子设置 30 秒且 fail-closed。原生策略注册器已将同步选择与实际压缩操作分开，但选中的 handler 仍经通用 `invokeHook(..., "session_before_compact")` 执行；其完整网络操作因此也被套上安全决策的固定期限。此前 SDK 夹具默认没有 CLI 超时策略，快速完成的回归未覆盖该组合。

`executeCompactionStrategy` 改用现有 `invokeOwnedHook` 调用选定操作，继续登记和等待实际 Promise，保留执行前后的模型、generation、取消信号及结果验证。正常错误仍直接传播，不能启动其他策略或自动回退。原生操作由调用者取消和 provider 的既有超时负责；没有新设更大的固定期限。通用 hook timeout、项目/工具安全检查和 legacy veto 行为不变。

## 验证与边界

- 将真实 CLI policy 与可控 scheduler 注入 SDK 首次创建及恢复构造，使用原生 Codex extension 的实际请求路径；虚拟时间推进至 60 秒后再释放 provider，验证 checkpoint 和下一轮 artifact。
- 同一路径覆盖主动取消、shutdown、provider 错误和配置的 provider deadline；独立注入的 45 秒 provider deadline 确认仍传递到请求并能中断它。取消后无 checkpoint，shutdown 等待实际 provider Promise，错误后下一次普通请求仍只执行一次。
- runner 控制组证明 legacy compact veto 仍在 30 秒 fail-closed，且不会执行选定策略；原生操作取消后拒绝迟到结果，drain 等待实际收尾。
- 八项定向回归：基线六项失败、两项控制通过；修正后八项通过。虚拟时钟验证截止逻辑，不声称真实服务端长会话已完成压缩。
- 构建产物的独立离线探针使用真实 CLI policy 和真实时钟，策略实际等待 32 秒后成功（32,003 ms，hook timeout 计数为 0）。该探针只验证 dist runner 的操作边界，不发网络请求，不替代原始长会话的真实 provider 验证。

类型检查、12/12 包离线构建及 240 项相关测试通过。变更仅触及低频压缩策略执行边界，不改普通 provider delta、工具进度、渲染或结果处理热循环，不新增回调/Promise 类别；沿用既有 ownership，跳过性能 benchmark。完整套件、最终头提交的 CI/复审和合并状态在 PR 中独立记录。

```powershell
npm.cmd run check
npm.cmd run build:offline
node --experimental-strip-types --test tests/extension-hook-timeout.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts tests/alpha-compaction-quit.test.ts
```
