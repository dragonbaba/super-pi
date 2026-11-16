# 恢复会话后手动 Codex 压缩（2026-11-16）

基线：`20dadfdd2c607a87603036c932689ae73aa2cb30`，Windows、Node 26.13.0。用户在已有会话中手动 `/compact`，在 `provider_native_request` 阶段报 `no successful regular request commitment exists for this owner`，随后外层报告 `Compaction cancelled`。只读核对显示历史中存在成功模型回合，最后一轮中止，手动失败发生在数小时之后。这次失败发生在本地前置检查，尚未发出压缩请求；日志本身不能区分内存状态是何时因恢复或 reset 被清除。原始会话不修改，也不纳入仓库。

## 原因与上游对照

原生 Codex transport owner 的成功请求 commitment 及 WebSocket 状态是运行实例内存，不随 JSONL 会话保存。恢复、重载或切换会话后，没有此记录是正常状态；原实现却在重建完整 canonical 请求后仍要求该记录存在。合法的完整历史压缩因此被误当作无效的旧连接续传而拒绝。

核对 [OpenAI Codex `ca0bbbdf` 的远端 V2 attempt](https://github.com/openai/codex/blob/ca0bbbdf0c83cb64f2fb48cf0d5ffbc3d4409ab9/codex-rs/core/src/compact_remote_v2_attempt.rs#L96-L159)：没有可复用客户端时创建新 session，取当前历史，再追加 `compaction_trigger`。协议仍为 Responses 流返回一个原生 `compaction` 项；不要求同一运行实例先执行普通回合。本次根因是本地不适当的前置条件，不能据此认定 OpenAI 服务端更新导致失败。

## 修改与边界

- 有真实成功请求 commitment：保留既有 instructions、input/response、tools、非 input 请求字段、cache key、service tier 和 headers 一致性检查，以及原有 SSE/WS 传输选择。
- 没有 commitment：使用宿主重建的 canonical 完整历史，追加一个 trigger，通过原生 SSE Responses 提交一次；拒绝带旧 `previous_response_id` 的请求。没有普通回合探针、自动重试或工具重放，不伪造成功请求和对照诊断。
- 完整历史的发送边界先确认当前 session 所有 WS 连接不忙，再释放旧的空闲 WS 边界；本地 observer 拒绝或发送前取消不释放。下一次普通请求建立与新历史匹配的状态。
- owner 撤销、取消、drain/dispose、鉴权及会话历史归属保持原有机制。修改仅在低频压缩请求准备/发送边界，不改 provider delta、进度、渲染或大结果热循环；不新增热路径分配，跳过性能 benchmark。

## 验证

四个新回归在基线上失败、候选上通过：新建/reset 后的 owner 不需要普通探针，远端失败后可由调用者显式重试；WS 压缩后再次完整压缩的发送前取消、边界释放及下一轮；忙连接与旧 response ID 拒绝；完整 SDK 恢复会话后立即手动压缩，已完成工具 call/result 只作为历史提交，检查点保存且下一轮使用原生 artifact。

本地类型检查、12/12 包离线构建及 238 项相关选择通过。完整套件与最终提交的远端 CI/复审结果在 PR 中按头提交独立记录；离线回归不声称已对用户原始长会话执行真实压缩。

```powershell
npm.cmd run check
npm.cmd run build:offline
node --experimental-strip-types --test tests/codex-transport-owner.test.ts tests/codex-request-body.test.ts tests/codex-header-overrides.test.ts tests/provider-contract/openai-compaction-lifecycle.contract.test.ts
```
