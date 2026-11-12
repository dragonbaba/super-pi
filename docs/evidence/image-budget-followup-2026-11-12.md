# 图片批生命周期与验收补充（2026-11-12）

基线 `87d28a9b2667140caae722f29ba030e2a5297281`。问题：单个工具批含 6 张约 2.2 MiB base64 图片时首次超过 12 MiB；旧实现一直保护最后一个含图批，新的用户消息、模型消息和纯文本工具批均不能恢复。三个回归用例在旧实现全部失败。

修正：保护只覆盖当前工具批；后续模型消息或新的用户提交将旧批转为历史，沿用原有偏移/完整图片淘汰。当前批首次超限仍阻止上传，并说明新文本继续（部分图可能省略）和显式调预算两条恢复路径。原历史、用户图片、已完成副作用保持原状。无命令/源码解析、最低调用数、新审批或工具重放。

| 验证 | 结果 |
| --- | --- |
| 真实 session + OpenAI serializer，presentation 开/关 | 原图 13,841,208 B；首次 0 上传，新用户消息后 4 图、9,229,275 B，再追加纯文本工具批 9,229,544 B；原 6 图仍在，重放 0、自动摘要 0；启用通用重试也不重发受阻请求 |
| 当前批保护 | 原批转历史后产生的新超限批仍阻止；同一 assistant 的完整工具批仍保护；共享图片、编码扩张、变代、取消和缓存释放回归通过 |
| 默认摘要的实际 serializer | 图片块/base64 为 0；8 MiB 工具文本沿用已有 2000 字符截断，body 4,081 B；16 MiB 用户文本产生 16,781,277 B body，413 明确失败，provider/summary 均启用重试仍只有 1 次发送 |
| 合成像素对照 | 棋盘、细字、透明斜边、渐变共 4 例。限内默认与 autoResize=false 原 base64 字节相同；1568/600 KiB 的 PNG 视图仍有像素差异，透明边保留 alpha。细字进一步缩到 1176×78、443,292 B，棋盘 1568×105、547,060 B。该对照不等于真实照片/HD-2D 主观质量通过 |
| UTF-8 计量 | Node/Bun 原生 `Buffer.byteLength`；无 Buffer 的独立 VM 模拟浏览器后备。11 MiB、中文/emoji、孤立 surrogate 和 10,000 随机 UTF-16 单元逐项与原生结果一致；每包原生计量恰好 1 次 |
| 相关回归 | 72/72 通过；类型检查、diff whitespace 检查通过；离线构建 12/12 |

审计链路：Agent transformContext → SDK prepareRequestImages → RequestImageBudget.prepare → 文本 presentation/图片投影 → openai-completions SDK 既有 serializer → request-body observer → fetch → assistant/agent 结束释放 → clear/dispose。只读取 SDK 已有字符串，日志/observer 仅接收数字。增量 payload 字节元数据复用；消息遍历仍存在，不将其描述成完全不扫描历史。未改动 provider delta、事件、终端渲染或帧队列。

同机 Node 分配基准（包含计时、断言、SDK harness，不是远端时延）：

- 11,534,369 B 序列化字符串，40 次：旧浏览器扫描基线 p50/p95 **12.707/13.303 ms**，原生计量 **0.730/1.153 ms**；采样 **835.4/261.4 B/调用**。计量新增闭包/Promise/数组/完整 payload 副本均 **0**；四次 GC 后 2 个 payload owner 均释放。
- 44 图完整请求链：无预算 body **50,177,086 B**，预算后 **11,418,674 B**；采样 **100,722,160 → 23,175,270 B/请求**，p50/p95 **55.662/56.551 → 11.880/12.571 ms**。预算首次准备 405.742 ms、10 次编码，热请求编码 0，44 次图片字节计量只发生一次；主要分配仍是 SDK FallbackEncoder，无新增全体序列化。
- 新超限恢复路径：13,841,208 → 9,227,472 图片 B，纯 SDK body 9,228,488 B；恢复准备 0.166 ms，首次失败和新提交共计量 12 张次，后续 8 次准备新增图片字节计量 0，编码 0。完成时 requestViewBytes=0，clear 后投影缓存为 0；上述请求基准四次 GC 后跟踪的 10 个对象全部释放。缓存/错误/取消引用释放另由 GC 回归覆盖。没有引入对象池。

未交付：Anthropic、Google、Responses/Codex Responses 的预算/413 图片恢复；总摘要输入字节预算/多段摘要；真实 HD-2D/照片主观质量验收；D 的自动重复读取去重。真实模型批量对照按用户选择暂不执行，样本数 **0**；原提示净增 714 字符不能证明批量行为改善。可重复测量方案见[执行方案](../codemode-batch-revision-image-budget-plan.md#真实模型批量对照待执行)。

复跑（PowerShell，先把子进程 TMP/TEMP/TMPDIR 指向本任务目录）：

```powershell
node --expose-gc --experimental-strip-types --test tests/request-image-budget.test.ts tests/request-image-budget-hot-paths.test.ts tests/request-image-budget-session.test.ts tests/request-body-observer.test.ts tests/request-image-summary.test.ts tests/request-image-fidelity.test.ts tests/image-resize-worker.test.ts tests/compaction-custom-instructions.test.ts
node --expose-gc --experimental-strip-types scripts/bench/request-body-bytes.ts
node --expose-gc --experimental-strip-types scripts/bench/request-image-budget.ts
npm.cmd run check
npm.cmd run build:offline
```

完整测试必须等构建完成后再启动，避免构建删除 dist 影响并发用例。
