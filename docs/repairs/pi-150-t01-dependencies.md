# T01 — Pi 1.5.0 对照后的依赖安全更新

依赖对照基线：`6ad356fd254f557c4dc3e5af3172720bbede6c8f`（方案 PR #175 已合并）。PR 基线为独立 transport 修复 [#176](https://github.com/dragonbaba/super-pi/pull/176) 的 `5fd4859396424a87f3223b6d85475cd7700de474`。分支：`codex/t01-dependency-security`。状态：当前 Node 26.13 本地验收通过，待远端 CI 与合并。对应主方案 [T01](../upstream-pi-1.5.0-implementation-plan.md#t01--生产依赖公告)。

## 设计边界

2026-11-03 重新执行 `npm audit --omit=dev --json`，得到 9 个受影响包（3 high、6 moderate）。前一轮的 16 是历史公告快照，不能把公告库变化算成代码修复。当前任务只调整受影响依赖及必要的依赖闭包，不升级 provider/MCP SDK、不改变运行时权限和认证、不添加应用层兜底。

直接依赖为 Undici 8.12.3、glob 14.0.3、minimatch 11.0.3。minimatch 11.0.4 发布不足两天，保留仓库现有最小发布时间要求；11.0.3 已覆盖本项公告。传递依赖在父包允许的范围内刷新，不添加 override。Zod 的现有消费者允许 `^3.25 || ^4.0`，且 MCP 已导入 `zod/v4`；v3 兼容入口仍存在，实际 MCP schema/通知链通过回归。

| 包 | 原版本 → 候选 | 选择依据 |
| --- | --- | --- |
| undici | 8.11.2 → 8.12.3 | 修复公告，engines 兼容当前 Node 26 |
| glob / minimatch | 13.0.6 → 14.0.3 / 10.2.5 → 11.0.3 | 修复匹配相关公告，兼容当前 Node 26 |
| @hono/node-server | 2.1.1 → 2.1.5 | MCP SDK 允许 `^1.19.9 || ^2.0.5`，避开发行不足两天的 2.1.6 |
| body-parser / qs | 2.3.0 → 2.4.0 / 6.16.0 → 6.17.1 | Express 现有范围内更新 |
| fast-uri / ip-address | 3.1.8 → 3.1.9 / 10.7.2 → 10.7.5 | 保留 AJV 与 express-rate-limit 允许的主版本 |
| zod | 3.25.76 → 4.6.7 | 满足 MCP、OpenAI、Anthropic 和 zod-to-json-schema 的现有范围 |
| path-scurry / @isaacs/nonrecursive-glob-match | 2.0.2 → 3.0.0 / 新增 1.0.3 | glob/minimatch 必要依赖闭包 |

共 10 个已安装包变更、1 个包新增；SDK 版本不变。公告依据包括 [glob](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)、[minimatch](https://github.com/advisories/GHSA-g3hv-75wg-m249)、[Undici 8.12.3](https://github.com/nodejs/undici/releases/tag/v8.12.3)。完整版本、engines、候选锁文件 SHA-256、审计与测量见 [JSON 证据](../evidence/pi-150-t01-dependencies.json)。

## 调用链与性能约束

- CLI/RPC 初始化或显式设置 → `configureHttpDispatcher` → EnvHttpProxyAgent/Client/Pool → npm Undici fetch/body reader → provider SDK 的 SSE/JSON parser → Agent/EventStream → AgentSession → InteractiveMode → frame queue/物理终端。连接配置为低频；body/事件为热路径，审计与测量不能停在 manifest。
- 项目资源解析 → DefaultPackageManager → `globSync`/minimatch → 本地资源集合；模型范围解析 → `resolveModelScopeFromModels` → minimatch。发生在启动、reload 或显式模型范围操作，不增加每帧或每 delta 查询。
- MCP transport → SDK JSONRPC/schema validation（Zod）→ bridge 同步 progress boundary → 工具结果/展示；AJV/fast-uri 负责 schema 编译。Hono/Express/body-parser/qs/ip-address 位于 SDK server 依赖链，当前客户端角色并不证明这些服务端漏洞可被利用。

本项相对 #176 的生产源码保持不变；无新增 closure、Promise、controller、wrapper、缓存、对象池或重试。外部库内部的变化仍通过真实 HTTP body 与 MCP SDK 的 allocation/lifecycle 测量记录。合法输入、取消、断流与资源关闭必须通过；不靠增加重复校验掩盖上游兼容问题。

Undici 可达源码比较包括 HTTP/1 响应解析、fetch body/上传、压缩与错误传播、TLS session cache、重定向和 WebSocket receiver。Codex WebSocket 取全局构造器，因此不能把 npm Undici WebSocket 排除为不可达：新版本给解析器默认容量限制，并在控制帧回复遇到 socket backpressure 时等待 drain。该回调位于网络背压边界，不是新增应用层 provider delta 回调。此项没有声称 vendor 每次 body read 都零分配，也未覆盖真实远程 WebSocket/代理/TLS 服务；普通 WebSocket 会话由已有 provider 测试覆盖。

必要边界由原 dispatcher/库负责解析、取消、错误和资源关闭；应用层不增加二次校验。错误仍作为 rejected fetch/body read 或 SDK 错误传播。HTTP dispatcher 由进程拥有，测试创建的 dispatcher/server 在正常和异常收尾时关闭；MCP transport 由 bridge 拥有，正常关闭和强制退出均验证。没有新的缓存 owner 或长期状态。

## 验证计划

1. 锁文件差异限定到目标依赖闭包，记录原/新版本、engines 和原父级范围；按用户最新要求，只以当前 Node.js 26.13 验收。
2. 生产模型模式匹配/资源发现、HTTP 正常与压缩响应/断流、MCP schema/认证/进度和 lifecycle 回归。
3. 运行 `stream-hot-paths`、MCP 的已有结构计数/采样/WeakRef 回归，比较基线与候选。
4. 运行 `node --expose-gc scripts/bench/http-dispatcher-security.mjs` 对真实 production dispatcher 作同机比较：请求/完成/字节计数、采样字节、CPU、关闭后 socket/reader/response/dispatcher 引用；不冒称这等同于完整 UI。
5. 类型检查、离线构建、完整测试及 PR 六分片 CI；重新审计并报告剩余公告，不调整测试阈值消除失败。

## 已观察到的证据

- 同日生产审计：9 个受影响包（3 high、6 moderate）→ **0**。不将历史快照 16 → 9 计为修复；不宣称审计零公告证明不存在未知漏洞。
- `npm.cmd run check`、`npm.cmd run build:offline` 通过。Node 26.13 完整测试 **388/388 个执行单元成功，5,091 pass / 96 原有 skip / 0 fail**，覆盖模型匹配、MCP 认证/schema/进度、HTTP 正常/压缩/POST/断流/错误/取消及源码不变量。
- 首次验收暴露了 SDK 未传配置 transport 的既有缺陷；旧锁文件独立 checkout 也复现，已先在 #176 修复。根因、失败证据与未放宽的原 10 秒门禁见[独立记录](sdk-configured-transport.md)，不靠切换 Node 版本绕过。
- 真实 HTTP dispatcher：Node 26.13 升级前后均为 120 次请求/响应、31,457,280 字节、600 次 body read；关闭后 socket=0，response/reader/dispatcher WeakRef 全释放。
- HTTP 首轮采样 p95 波动较大，因此在两边都包含相同 #176 修复的条件下，交替执行 5 轮相同夹具。采样字节/响应中位数 **96,122.64 → 96,212.88 B**（约 +0.09%）；p95 中位数 **1.1696 → 1.2940 ms**（约 +10.6%，绝对 +0.1244 ms）。这是含 inspector/本地 server 开销的测量，不宣称加速或零时延回退；无对象池，不套用对象池收益门禁。所有轮次计数与释放断言通过。堆字段 `heapAfterWork` 是工作结束快照，不冒充峰值。
- MCP：1,000 条 stdio 消息、delivery Promise=0、3 个引用释放；100,000 次真实 SDK progress 没有 Promise 历史；2 个进程族正常/强制退出，Windows Job handle=0。采样总量 8,529,912 → 7,476,832 B。
- Agent/Session：100,000 次 message/tool 更新，wrapper、inline closure、Promise tail/数组、内置 listener Promise、rejection observer 均为 0。最终候选 message 采样 0.69496、tool 0.48960 B/update；初始基线分别 0.62568、0.52008。observer 合并后只交付 1 次、snapshot=1；此夹具的 interactive 为 stub，没有冒称实测物理终端。
- 最终候选 stream 20 轮 p95 26.6754 ms、峰值堆 90,012,656 B，初始基线分别 25.2881 ms、94,867,616 B；100,000 updates、1 次交付/快照和最多 1 个 pending key 不变。JSON 保留初始依赖候选、含 #176 的最终候选及 session 受控 GC 实测值，不把单次堆变化解释成引用泄漏或改善。

最终验收和 CI 仅使用当前 Node 26.13。前期其他版本探索不作为验收依据，用户纠正后不再执行。全局 Node 安装未变更。

## 复现命令与覆盖范围

```powershell
npm.cmd audit --omit=dev --json
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/dependency-security-compat.test.ts tests/model-resolution-compat.test.ts tests/mcp-oauth.test.ts tests/mcp-auth-lifecycle.test.ts tests/mcp-schema-cache.test.ts tests/mcp-client-boundary.test.ts tests/stream-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/http-dispatcher-security.mjs
npm.cmd run bench:stream
npm.cmd run bench:tui-session-event-allocations
npm.cmd run check
npm.cmd run build:offline
npm.cmd test
```

性能样本串行采集，不与完整测试并行。HTTP 夹具仅访问本机，未读取 provider 凭据。测试没有降低阈值或增加跳过项；PR 保留 Linux 2、Windows 4 个分片，统一 Node 26.13。当前仍待最终 SHA 的远端 CI 结果与合并，不能提前标记交付。
