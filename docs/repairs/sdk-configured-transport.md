# SDK transport 配置传递修复方案

状态：方案先写入后已实施，待完整验收及 PR 合并。基线 `6ad356fd254f557c4dc3e5af3172720bbede6c8f`；独立于 T01 依赖更新。验收只使用当前 Node.js 26.13.0，遵循用户最新要求，不再增加 Node 版本矩阵。

## 复现与根因

Node 26.13 的完整测试和隔离运行均在 `openai-compaction-lifecycle.contract.test.ts` 的 manifest 组装测试超时（原上限 10 秒），随后一项测试的 WebSocket 请求数为 3 而非 2。独立 checkout 使用旧锁文件、全新依赖及离线构建后同样复现，排除了本次依赖升级。

临时内存诊断显示，两轮扩展顺序中的普通 prompt、扩展摘要、reload 均很快，耗时发生在禁用远程 compaction 后的原生摘要。`sdk.ts:streamRequest` 已计算 `configuredTransport = options?.transport ?? settingsManager.getTransport()`，但只传给 prefix manifest；发给 `modelRuntime.streamSimple` 的 options 缺失这个值。普通 Agent prompt 自带 transport，原生摘要没有，因此落到 provider 的默认 auto 路径。Node 26 的 WebSocket 会实际尝试连接并等待，超时测试未完成的异步工作又进入下一项的全局 WebSocket 夹具。

## 最小实施

1. 在现有请求 options 中写入已计算的 `transport: configuredTransport`。不改变选择优先级，不增加默认值、重试、网络兜底或新状态。
2. 在已有 compaction contract 文件增加行为回归：原生摘要使用 settings 的 SSE；显式 Agent 请求 transport 仍优先。通过真实 SDK → ModelRuntime 边界捕获最终 options，provider 网络由现有离线 fetch 夹具提供。
3. 原 manifest/后续 WebSocket 测试保持原断言与 10 秒上限；用 Node 26.13 运行。通过后执行 typecheck、离线构建和完整测试。按用户最新要求，现有 Linux 2 / Windows 4 个 CI 分片统一改为 Node 26.13，不扩展多版本矩阵。
4. 按根因单独创建 PR。T01 可以在此候选之上建立独立 PR；这是一项已记录的阻塞修复依赖，未合并前不记为已交付，也不混入 T02 等后续功能。

## 性能与生命周期

已读 hot-path allocation contract。调用链为 AgentSession compact/summary → createSummarizationStream → SDK streamRequest → ModelRuntime → 当前 provider → SSE/事件流 → Agent/Session observer → InteractiveMode/终端队列；取消与关闭由原请求 signal、transport owner 和 SessionRuntime 负责。

改动位于每个请求的配置边界，复用已有 options 对象和已有 transport 字符串；新增 closure、Promise、AbortController、wrapper、数组、缓存及对象池均为 0，不改变 provider delta/progress/frame 代码。已有请求边界仍有 auth/header/prefix diagnostics 的必要对象，不能宣称整条调用链零分配。

复用 `stream-hot-paths` 不变量、compaction 的正常/错误/取消/所有者释放测试，以及 stream/session allocation 夹具记录计数和 GC；不为单字段传递添加基准框架或放宽门禁。临时诊断仅在 `.git/pi150-t01` 中通过 Node load hook 注入内存，不修改产品源码，交付前确认源码没有诊断残留。

## 验证结果

确定性回归先失败：实际摘要请求 transport 为 `undefined`，预期 `sse`。单字段修复后 `openai-compaction-lifecycle.contract.test.ts` 和 `stream-hot-paths.test.ts` 共 **78 pass / 0 fail / 0 skip**；原 manifest 用例约 2.7 秒完成，后续 WebSocket 断言正常。typecheck、离线构建及 Node 26.13 完整测试均通过；完整测试的 387 个执行单元全部退出 0。最终 SHA 的 CI 尚待结束。

[性能证据](../evidence/sdk-configured-transport.json)保存同机 Node 26.13 基线/候选：100,000 updates、交付/快照各 1、pending key≤1 不变；Session message/tool 的 wrapper、inline closure、Promise tail/array、内置 listener Promise、rejection observer 均为 0，最终更新正确。采样分别为 message 0.62568→0.59680、tool 0.52008→0.69424 B/update；受控 GC 的实际差值全部保留，不用单次样本声称优化。stream p95 25.2881→26.8365 ms 是未改动事件夹具的波动，未新增对象池或改变门禁。

复现命令：`node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/provider-contract/openai-compaction-lifecycle.contract.test.ts tests/stream-hot-paths.test.ts`、`npm.cmd run check`、`npm.cmd run build:offline`、`npm.cmd run bench:stream`、`npm.cmd run bench:tui-session-event-allocations`、`npm.cmd test -- --keep-going`。
