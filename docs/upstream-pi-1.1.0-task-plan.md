# Pi 1.1.0 对照复核与后续任务清单

状态：截至 2026-10-13（Asia/Tokyo），T01–T10 优先修复/核查项均已完成或按证据排除，独立 PR #78–#112 全部合并，实施与审查记录见 §9–§43.1。最近的 T09.4 / PR #112 最终提交六个 CI 分片全部通过、Codex 审查无重大问题，经用户授权合并为 `92cbab2d3480c6636d02157cf4d527d9cc75584b`。优先清单无剩余未实施项；用户已选择 F01，按两个独立目标交付 PR #113（工具表达式）和 #114（禁用 MCP），详见 §45–§46。#113 / #114 已经用户授权依次合并，最终候选六分片 CI 和 Codex 审查均完成，合并记录见 §47。F02.1 项目级局部覆盖已合并 PR #115，详见 §48–§49；F02.2 manager 已授权合并 PR #116，详见 §50–§51；F02.3 CIMD 已授权合并 PR #117，详见 §52–§53；F03.1 独立 renderer 已授权合并 PR #118，详见 §54–§55；F03.2 已授权合并 PR #119，见 §57；F03.3 已授权合并 PR #120，见 §59；F04.1 已授权合并 PR #121，见 §61；F04.2 已授权合并 PR #122，见 §63；F05.1 已授权合并 PR #123，见 §65；F05.2 已授权合并 PR #124，见 §67；F06.1 Anthropic SDK 兼容底座已授权合并 PR #125，见 §69；F06.2 inline 工具与权限/提示同步已授权合并 PR #126，见 §71；F07 已授权合并 PR #127，见 §73；F08 已授权合并 PR #128；T01–T10 与 F01–F08 编号范围全部关闭，剩余候选与交付边界见 §75。后续选定的交互补齐 PR #129–#135 全部合并，见 §78–§87；§88 完成收尾核对（按需候选不视为遗留缺陷），§89 完成分支清理与全局离线交付，本轮开发收尾。原差异复核日期为 2026-10-09，固定基线见 §1；此状态更新不表示重新扫描了更新的上游版本。勾选框表示实施及交付验收完成，不能用“已查过源码”代替“已修复”。

证据说明：文中 `.git/...` 下的证据目录（探针脚本、结果 JSON、日志与哈希等）只保存在当时本机仓库的 `.git` 内，不随版本库提交，克隆后无法查看。可公开核对的依据是文中链接的 PR、CI 记录与合并提交。

**先处理生产依赖与凭据刷新，再补 worker、provider、输出和终端缺口。** 用户已授权从第一条开始实施。严格执行 §3.1 的性能设计门禁和 §3.2 的交付流程：每类问题独立新建 PR，创建 PR 后立即评论 `@codex review` 请求审查。合并与安装更新仍按对应步骤的授权执行。

## 1. 固定基线与证据等级

| 项目 | 本次核对基线 |
| --- | --- |
| Super Pi | `main`，`d2ae1be9f48a5a5b52ed92142a046c5749d5fa7a`；PR [#77](https://github.com/dragonbaba/super-pi/pull/77) 已合并 |
| 上游最新稳定版 | [v1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0)，`abe508e1b89912adde45528136c3221eb69acdd7` |
| 稳定版发布时间 | 2026-10-07 22:26:31 UTC，即日本时间 2026-10-08 07:26:31 |
| 上游 main 快照 | `6fb2e7815167e6b19006fc526d1a5d0f5f998787`，比稳定版多 10 个提交；未发布内容单独列出 |
| 核对范围 | v1.0.0 基线遗留项，以及 v1.0.1、v1.0.2、v1.0.3、v1.0.4、v1.1.0 的发布说明、相关提交、当前本地实现及定向探针；第二次复核额外检查 AI/MCP 包 changelog 与区间内 139 个提交的清单 |
| 旧记录 | [Pi 1.0.0 差异评估](upstream-pi-1.0.0-diff-assessment.md)，保留其历史时间和验证边界 |

Super Pi 的 `0.84.1` 包版本属于本项目版本体系，不能据此计算落后版本数，也不应为对齐数字整体覆盖上游代码。

证据标记：

- **R：本地复现。** 调用当前生产函数的离线探针已观察到具体行为；不等同于真实服务端或终端全链路验收。
- **S：源码确认。** 当前实现存在明确缺口，尚未完成对应环境的运行复现。
- **V：待定向验证。** 上游问题与本项目可能相关，先复现，再决定是否修改。
- **E：已有等效实现。** 保留边界验证，不重复移植。
- **F：功能差异。** 单独决定是否采用，不作为缺陷自动实施。

本次依赖审计是当日快照。后续实施前重新核对公告和锁文件，不把审计数量当成长期常量。

## 2. 本次补充及纠正

| 结论 | 复核结果与影响 |
| --- | --- |
| “生产依赖没有公告”已经过时 | 当前 `npm audit --omit=dev --json` 报告 2 个受影响包：MCP SDK 为 high，`proxy-addr` 为 critical。全部依赖报告 7 个受影响包；其余 5 个位于 `shx` 构建链。详见 T01。包严重性不等于本项目已被利用。 |
| MCP issuer 校验不能笼统算全部完成 | 当前有发现文档校验、回调 `iss` 校验、同次登录 issuer 绑定；SDK 新公告还涉及**已保存凭据与授权服务器的绑定**及旧凭据迁移。两类边界必须分别验收。 |
| 默认 worker 不能完成写入型职责 | 实际解析仓库 `.sp/agents/worker.md` 后，即使允许修改，工具仍只有 `read/grep/find/ls`，见 T03。用户级同名角色可能改变最终配置，不能推广为所有 worker 都只读。 |
| Codemode 原型修改没有复现宿主崩溃 | 两个原型修改探针以 `Invalid Codemode store writes` 结束；后续正常调用成功，4 个 worker 全部关闭。应处理隔离环境内的序列化兼容，不宣称主进程崩溃或跨调用污染。 |
| Codemode 工具发现提示确有本地缺口 | 未知工具报错建议调用 `searchTools()`，当前集成实际提供 `ALL_TOOLS` 和异步 `describeTools()`；错误提示会引导模型再次失败。 |
| 终端断开、MCP 连接中关闭已有实现 | 已存在死终端错误处理、连接取消及等待连接结束的清理逻辑，不重新建立同名修复任务；登录操作的完成等待仍需独立核查。 |
| `outputPad`、图片回传、定价 tiers 不是整体缺失 | `outputPad` 类型已存在；Codemode 已支持图片内容；成本计算已有 tiers。需要核查的是应用范围、展示边界及目录数据传递，不能重写整套机制。 |
| 登录端口问题要区分 provider | 上游修复的是 `openai-chatgpt.ts`；本地旧 `openai-codex.ts` 也会吞掉监听错误再继续浏览器登录，需按本地流程修复。Anthropic 订阅登录在本项目已禁用，其动态回调端口改动不适用。 |

## 3. 执行边界

沿用已确认的产品选择：子代理不新增 token 或回合数预算；派发前明确职责、文件范围、交付物、完成条件、可用能力及运行边界。保留并发/任务容量提示、长任务预拆分、checkpoint 交接、退出确认和所属后台进程清理。

不得借上游同步扩大默认工具权限、绕过项目信任、恢复已禁用的订阅登录，或新增自动跨重启执行。`durable`、`chord`、`evals`、classifier、图像生成及 Radius 不在本轮实施范围。

第二次复核后的建议顺序为 **T01 → T02 → T10 → T03 → T04–T09**；T10 是新发现的完整目录正确性问题，编号保留追加顺序。T04 内优先处理已复现的错误恢复和 Haiku 能力错配，T04.6 先校准再决定改动。任务编号是计划分组，不能作为合并不同问题到同一个 PR 的理由；每类问题必须按 §3.2 独立新开 PR。同一认证、provider、渲染或锁文件不得由多个修改任务并行写入。子任务派发必须携带具体任务 ID、问题类别、性能门禁和停止条件，完成后回报证据，不继续自行扩展范围。

### 3.1 实施前的性能设计门禁（强制）

所有修复必须从设计阶段遵守 [Hot-path allocation contract](performance/hot-path-allocation-contract.md)，不得先实现功能、再把性能合规留给后续 PR。开始编码前，记录问题根因、最小复现、改动边界、是否触及热路径及判断依据；非热路径也要说明新增状态、缓存和资源的所有者、容量与释放时机。

触及热路径时，以下各项都是设计与验收条件：

1. **审计完整生产调用链。** 从 provider/工具/输入生产者，到事件交付、交互更新、布局渲染、终端输出或大结果处理，再到完成、失败、取消、清空和 dispose 的释放边界，列出实际经过的链路。现有 helper、间接调用、订阅回调和 SDK 适配同样纳入审计，不能只看新增代码。
2. **按契约限制分配。** 常规高频路径的内联闭包为 0；常规帧、provider delta、工具进度路径的 Promise、AbortController、signal/options 包装、Promise tail/数组为 0。稳定回调随所属生命周期创建一次。临时数组和 scratch 仅限契约允许的有界用途，明确最大容量、所有者、所有退出路径的清空，以及超大 backing store 的丢弃条件。对象形状保持稳定，用 `undefined` 释放可选引用。
3. **限制完整数据复制与积压。** 不重复构造、序列化、复制或扫描完整帧和大工具结果。涉及终端帧时，满足 active write ≤ 1、pending latest frame ≤ 1、queue high-water mark ≤ 2、每帧应用层完整副本为 0、完整帧物化至多 1 次、每个 busy cycle deferred 至多 1 个；替换 pending 值后立即释放旧引用，并保留背压与物理写入所有权约束。
4. **例外必须精确、有证据。** 低频生命周期例外仅使用契约允许的边界，并在测试中点名具体函数；不得整文件或整类豁免，也不得为让 CI 通过而降低、跳过或删除性能不变量。高频调用的 helper 不能改名后算作低频。
5. **默认不引入对象池。** 如确需采用，必须先有 profiler 证明，并逐项满足契约全部准入条件，包括容量、所有权、重入/异常/取消安全、引用清空与生命周期测试；测量须达到采样分配下降至少 20%、CPU p95 回退不超过 5%、最终堆增长不超过 10%。不得池化消息、事件、工具结果、provider payload、Promise 或其他契约禁止的对象。
6. **验证三类性能证据。** 必须提供确定性结构计数、allocation profile 或精确分配计数，以及受控 GC/引用释放证据；运行相关 AST/source invariants 和 allocation benchmark。按同机、同 fixture 比较基线与候选，记录源码提交/哈希、环境和命令。一次耗时或单张堆快照不能替代上述证据，无法验证的门禁不得写成通过。

修复后的行为回归、资源释放和性能门禁必须同时满足。PR 正文须包含完整调用链摘要、已有/新增分配、计数和测量结果、证据位置与未覆盖环境；只写“遵守性能规范”不算验收材料。

### 3.2 每类问题独立 PR 与 Codex 审查流程（强制）

1. **每次开始修复一类问题，都使用独立分支并新建一个 PR。** 分支默认使用 `codex/<任务ID>-<问题描述>`。同一根因不可分割的跨包实现、必要依赖、回归测试和文档可放在同一 PR；独立根因或独立验收目标必须拆开。例如 issuer 绑定、刷新取消、MCP 分页和 ANSI 分块分别建 PR，不能因为属于同一个任务组就混在一起。不得复用已合并/关闭的 PR，也不得向其他类别正在审查的 PR 追加修复。
2. **先复现、设计、修复、验证和自审，再交付 PR。** 按 §3.1 和 §7 完成当前候选所需检查，检查最终 diff/status 和资源释放，确认只包含本类问题的预期变更。已有用户改动不得混入提交。
3. **修复后提交、推送并创建 PR，随即发布审查评论。** 创建成功后，在同一个 PR 中单独评论准确文本 `@codex review`；这是每个修复 PR 的必做交付步骤，不能仅在正文中提及、只在本地记录，或等全部修复结束后批量请求。记录 PR URL、审查评论 URL 和对应 head commit；评论发送失败时明确记录并补发，未成功发布前不得宣称已经请求审查。
4. **在原 PR 内完成同类问题的审查闭环。** 对审查意见逐条核实；成立的意见修复后自审，运行受影响的行为/性能验证，提交并推送，再次评论 `@codex review` 请求审查。不采纳的意见记录理由与证据。审查发现其他独立问题时，新建任务和 PR，不扩大当前 PR。原问题已合并后出现新的修复轮次，也必须新开 PR。
5. **审查结果和 CI 必须对应最终提交。** 评论成功只表示已请求审查，CI 通过也不代替审查完成；后续代码变更不能沿用旧 head 的结论。获得合并授权且最终候选的必要检查通过、审查意见已处理后，才进入合并。任务关闭记录包含最终 SHA、PR/评论链接、审查结论、CI 和性能/生命周期证据。

进入已授权的修复实施任务后，上述提交、推送、创建 PR 和请求审查构成该任务的交付流程；本次补充规范本身不启动生产修复，也不代表已经创建 PR 或获得审查结果。

## 4. 优先任务

### T01 — 生产依赖与 MCP 凭据绑定（优先）

证据：依赖版本已确认；公告适用范围与本地防护缺口为 **S**，未实施恶意服务端端到端复现。

- [x] **T01.1（已合并并关闭）** 将 MCP SDK 升到兼容的已修复 1.x 版本，并修复 `proxy-addr` 锁定版本。已合并 [PR #78](https://github.com/dragonbaba/super-pi/pull/78)：SDK 1.32.1、`proxy-addr` 2.0.8；生产审计 0 项，最终 CI 与 Codex 审查完成，详见 §9。
- [x] **T01.2（已合并并关闭）** 补齐 token/client 信息的 issuer 保存、读取、刷新和重新发现边界，覆盖旧缓存与固定 `clientId`；无法可靠绑定的旧凭据要求重新登录，不推测其可信归属。已合并 [PR #79](https://github.com/dragonbaba/super-pi/pull/79)，最终 CI 与 Codex 审查完成，详见 §10。
- [x] **T01.3（已合并并关闭）** 处理开发依赖审计：核对实际构建命令并验证兼容性后，将五处 `shx` 固定为 0.3.4，移除 `braces → micromatch/fast-glob → shelljs/shx` 告警链；全依赖和生产审计均为 0。独立 [PR #80](https://github.com/dragonbaba/super-pi/pull/80) 最终 CI 与 Codex 审查完成，已授权合并，详见 §11。

本地入口：[MCP OAuth](../packages/mcp-bridge/src/oauth.js)、[配置](../packages/mcp-bridge/src/config.js)、[包依赖](../packages/mcp-bridge/package.json)、[锁文件](../package-lock.json)。

复核基线链路为 `mcp-bridge → @modelcontextprotocol/sdk@1.30.0 → express@5.2.1 → proxy-addr@2.0.7`；`@google/genai` 也共享 SDK。SDK 公告给出的 1.x 修复起点是 1.31.0，本次实施已选用 1.32.1。升级本身不能替代旧凭据迁移检查。[SDK 官方公告](https://github.com/advisories/GHSA-6qxp-vccf-f47h)

`proxy-addr` 的修复起点为 2.0.8，其风险依赖代理信任配置和客户端 IP 的使用方式。本次在项目源文件中未找到直接使用 Express 信任代理/IP 判定的入口，因此记录为受影响传递依赖，**没有证明本项目存在可利用路径**。[proxy-addr 官方公告](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)

完成条件：用虚构凭据和本地响应夹具覆盖“旧 issuer → 新 issuer”重新发现、刷新、重登、固定客户端及失败保留；不得把旧凭据发送给改变后的 issuer。锁文件只含预期变更，相关 MCP 测试及离线构建通过；重新记录生产/开发审计及剩余项。普通有效 token 读取不增加重复发现或 JSON 解析。

### T02 — 凭据刷新、登录与关闭边界

- [x] **T02.1（R；已合并）** 保护已经开始的 OAuth 刷新事务：用户取消请求后仍允许在独立有限时限内完成轮换凭据的落盘；等待锁阶段保持可取消。请求认证和模型目录刷新两条入口已修复并覆盖三种存储后端，独立 [PR #81](https://github.com/dragonbaba/super-pi/pull/81)，最终 CI/Codex 审查通过并经用户授权合并，详见 §12。
- [x] **T02.2（R；已合并）** Codex 浏览器登录遇到回调端口占用时，在打开登录流程前给出简短准确的原因；关闭本次登录的旧回调连接，通知异常与取消统一清理。保留设备码登录与必要的手工输入行为。独立 [PR #82](https://github.com/dragonbaba/super-pi/pull/82)，最终 CI/Codex 审查通过并经用户授权合并，详见 §13。
- [x] **T02.3（R；已合并）** MCP loopback OAuth 注册声明 native client；保留现有 PKCE、回调 issuer 校验或 server 身份。独立 [PR #83](https://github.com/dragonbaba/super-pi/pull/83)，最终 CI/Codex 审查通过并经用户授权合并，详见 §14。
- [x] **T02.4.1（R；已合并）** MCP 登录/登出命令的取消与关闭等待。已确认宿主命令 promise 不由 shutdown/reload 自动加入等待，扩展旧 shutdown handler 仅 abort 后等待连接生命周期，可能提前返回并留下旧命令通知/reload。修复保留并等待当前认证操作，串行完成替代操作的清理，阻止旧代次及关闭后的命令继续执行。独立 [PR #84](https://github.com/dragonbaba/super-pi/pull/84) 最终 CI/Codex 审查通过，并经用户授权合并，见 §15；后台刷新事务的 transport 关闭等待另列 T02.4.4。
- [x] **T02.4.2（R：事务边界；已合并）** MCP 刷新完成后、提交前的取消会阻止保存：已用真实 SDK 的虚构凭据夹具复现旧代次保留，并随 T02.1 在 [PR #81](https://github.com/dragonbaba/super-pi/pull/81) 修复，最终 CI/Codex 审查通过并经用户授权合并。覆盖文件锁、跨进程登录/登出、独立 180 秒事务截止时间和迟到响应；每次 OAuth 请求仍为 15 秒超时。会话关闭对已开始事务的完整等待从原 T02.4.1 核查范围中单列为 T02.4.4，未以本项替代，详见 §12。
- [x] **T02.4.3（排除：当前默认关闭链）** 当前 SDK 1.30.0 的 `StreamableHTTPClientTransport.close()` 只取消流，不调用独立的 `terminateSession()`；本地关闭链没有后者的调用。三组带虚构 token owner 的 runtime 探针在显式 close 阶段均为 0 次 token 读取、0 个 fetch，因此不移植上游“DELETE 前刷新 token”的修复。此结论不代表服务端 session 已收到 DELETE；若以后新增主动终止会话，再重新检查认证和关闭时限。
- [x] **T02.4.4（R：关闭等待边界；已合并）** transport 关闭对已开始刷新事务的完整等待。生产 `McpOAuth.refreshTransaction` 与 `McpBridgeRuntime.closeRuntime` 配合受控存储/授权夹具复现：close 返回时旧 refresh token 尚在存储中、state.oauth 已清空，释放授权响应后才提交轮换值。独立 [PR #85](https://github.com/dragonbaba/super-pi/pull/85) 已实现连接失败、会话关闭对原子提交/解锁的等待，关闭时取消等锁事务、禁止新刷新进入并释放缓存；保留 T02.4.2 的及时取消与保护落盘语义。最终 CI/Codex 审查通过，并经用户授权合并。SDK 1.32.1 的 close 仍不调用 terminateSession，本问题与 T02.4.3 排除的 DELETE 前刷新不同。实施和验证见 §16，原探针证据见 `.git/t02-4-1-mcp-login-shutdown-20261009/refresh-close-probe.log`。

入口：[认证解析](../packages/ai/src/auth/resolve.ts)、[模型目录](../packages/ai/src/models.ts)、[内存存储](../packages/ai/src/auth/credential-store.ts)、[文件存储](../packages/coding-agent/src/core/auth-storage.ts)、[Codex 登录](../packages/ai/src/auth/oauth/openai-codex.ts)、[MCP 命令](../packages/mcp-bridge/src/index.js)、[MCP transport](../packages/mcp-bridge/src/bridge.js)。

参考上游：[刷新取消修复](https://github.com/earendil-works/pi/commit/bde882c747)、[ChatGPT 回调端口](https://github.com/earendil-works/pi/commit/eeac84ca92)、[native client](https://github.com/earendil-works/pi/commit/147b502816)。T02.3 在 T01 SDK 选版后实施，避免对旧 SDK 行为重复适配。

完成条件：用可控 promise/信号在刷新开始前、服务端轮换后、存储提交前分别取消；新凭据保留，调用方取消及时结束，后台事务有有限寿命。跨进程锁、并发 logout/重登不被旧事务覆盖。端口冲突不启动无效浏览器流程，成功/错误/取消均关闭自己的监听器、连接、定时器。不得通过全局忽略 abort 解决问题。

### T03 — 默认 worker 能力与职责匹配

- [x] **T03.1（已合并并关闭）** 仓库默认 worker 已显式声明 `read/grep/find/ls/write/edit`，维持既有 source 与授权过滤；独立 [PR #87](https://github.com/dragonbaba/super-pi/pull/87)，见 §18。
- [x] **T03.2（已合并并关闭）** PR #87 使用真实角色定义和离线子进程验证 user/project × writable/read-only 四种最终工具集合，均无 shell；父代理派发提示说明 child 的命令验证能力及父代理职责，worker 标记未执行的命令，见 §18。

入口：[worker 角色](../.sp/agents/worker.md)、[角色解析](../packages/extensions/subagent/agents.ts)、[effectiveTools 与派发](../packages/extensions/subagent/index.ts)。

完成条件：允许修改的默认 worker 能使用写入工具；只读委派仍不能写。不能为了让 worker 跑测试而给全部角色增加 shell 权限，验证可由父代理负责。保留任务范围、停止条件、长任务预拆分和 checkpoint 提示；无新 token/回合预算。复用 [subagent-management](../tests/subagent-management.test.ts) 的角色/能力断言，仅在实际触及热路径时运行其性能门禁。

### T04 — Provider 错误恢复与请求兼容

- [x] **T04.1（已合并）** 已补齐 `server_busy`、`servers are currently busy`、HTTP/2 pending stream cancellation 的瞬态错误识别，并为 Mistral `finish_reason: error` 保留 server-error 语义；独立 [PR #88](https://github.com/dragonbaba/super-pi/pull/88) 已通过最终 CI 与 Codex 审查并合并。真实会话验证有界恢复、取消和工具不重放，见 §19。
- [x] **T04.2（已合并；上游 main 未发布改动）** Mistral 建连/响应头超时与活跃响应体分离，防止已经持续输出的长流被初始 60 秒计时器取消。独立 [PR #90](https://github.com/dragonbaba/super-pi/pull/90) 已通过最终 CI 六个分片与 Codex 审查，经用户授权合并，见 §21。
- [x] **T04.3（已合并）** Codex 请求允许配置的 `originator`、`User-Agent` 按模型/调用方优先级覆盖默认值，支持 null 删除与显式空值；认证头固定优先。独立 [PR #91](https://github.com/dragonbaba/super-pi/pull/91) 已通过最终 CI 六个分片与 Codex 审查，经用户授权合并，见 §22。
- [x] **T04.4（S，已合并）** Bedrock OpenAI reasoning effort 的独立 [PR #92](https://github.com/dragonbaba/super-pi/pull/92) 已通过最终 CI/Codex 审查并经用户授权合并，见 §23。适用 Claude 模型的 thinking block binding 与所需签名回放能力由独立 [PR #93](https://github.com/dragonbaba/super-pi/pull/93) 补齐；两轮审查修复覆盖 GovCloud 工具续接及 reasoning 关闭边界，本地行为/类型/构建/完整/分配/生命周期检查通过，最终 CI 六个分片成功、Codex 复审未报告重大问题，2026-10-10 经用户授权合并为 `ea5b7e0878621eaeff73c3298853a0fbfc7b4597`，见 §24。
- [x] **T04.5（已合并并关闭）** Haiku 5.5 能力适配与 T05.3 中 Haiku 目录记录已通过独立 [PR #89](https://github.com/dragonbaba/super-pi/pull/89) 的最终 CI/Codex 审查并经用户授权合并。已修复 Bedrock 普通 ID、点号 ID 和名称识别的 application inference profile 的 adaptive/effort/cache/binding/temperature，补齐 off、签名回放与共享 profile 区域边界；补齐 Anthropic 离线记录、生成器及远程/缓存恢复。保留用户显式覆盖、GovCloud 例外与旧模型行为，见 §20。
- [x] **T04.6（R，已合并）** 将原 F06 的输入估算校准移入请求正确性核查。完成中英文、代码、JSON、日志、工具 schema、图片和已有 usage 尾部增量的离线校准后，`utils/estimate.ts → api/simple-options.ts` 文本估算采用 3.5 字符/token，图片保持 1200-token 占位，服务端 usage 锚点不重算。独立 [PR #94](https://github.com/dragonbaba/super-pi/pull/94) 最终提交通过 CI 六个分片，Codex 审查未报告重大问题，无遗留讨论；经本轮用户授权合并为 `97074eff8c78197dbf4e91ed492e3d7db400d5cc`，见 §25。工具结果 Token estimator/G2 与独立 compaction 估算不变；参考 tokenizer 不是所有 provider 的精确计数，尚未调用真实服务端验收。

入口：[retry](../packages/ai/src/utils/retry.ts)、[Mistral](../packages/ai/src/api/mistral-conversations.ts)、[Codex](../packages/ai/src/api/openai-codex-responses.ts)、[Bedrock](../packages/ai/src/api/bedrock-converse-stream.ts)。

参考：[server busy](https://github.com/earendil-works/pi/commit/8b5708dbb1)、[HTTP/2 cancellation](https://github.com/earendil-works/pi/commit/5b6c792b42)、[Mistral error](https://github.com/earendil-works/pi/commit/7fb59f995b)、[Mistral 超时](https://github.com/earendil-works/pi/commit/6b07b4e57269ebc4b3fe2b7cd3caba2d95e26cc0)、[Codex headers](https://github.com/earendil-works/pi/commit/0cf65d2bf7)、[Bedrock effort](https://github.com/earendil-works/pi/commit/2989eb581f)、[Bedrock binding](https://github.com/earendil-works/pi/commit/69f0be6f0a)。

补充入口：[Bedrock 能力 profile](../packages/ai/src/providers/bedrock-profile.ts)、[统一能力模型](../packages/ai/src/model-capabilities.ts)、[请求输入估算](../packages/ai/src/utils/estimate.ts)、[请求输出上限](../packages/ai/src/api/simple-options.ts)。上游依据：[Haiku 完整能力改动](https://github.com/earendil-works/pi/commit/f76c1db662)、[请求估算修复](https://github.com/earendil-works/pi/commit/27075fe075)。Haiku 的运行证据限于本地能力判定，尚未验证真实 Bedrock/Anthropic 服务端接收结果。

完成条件：瞬态错误按现有次数和退避策略恢复；取消、账单/额度耗尽、确定性参数错误不重试，不重复执行已完成的有副作用工具。用模拟流和可控计时验证长流、迟迟无响应头、空闲超时和取消，避免等待真实 60 秒。用请求载荷夹具验证 headers、SSE/WebSocket 与 Bedrock 模型差异，不消耗真实模型额度。触及 delta/事件路径须提交性能证据。

### T05 — 模型目录与分层成本数据

- [x] **T05.1（R，已合并）** 已审计生成、在线合并、缓存恢复到成本计算的 tiers 传递，补齐 models.dev 全部转换、OpenRouter、Gateway 及 Azure 派生；独立 [PR #95](https://github.com/dragonbaba/super-pi/pull/95) 最终 head 通过 CI 六个分片、Codex 审查无重大问题，2026-10-10 经本轮用户授权合并为 `2336b4aed9a26c288f499e039cd0c0c01f13752c`，见 §26。当前随包快照未从变化中的目录重新生成，记录更新仍归 T05.3。
- [x] **T05.2（R，已合并）** 直接传递部分 tiers 会扩大缺省价格被清零的问题，因此缺省继承是 T05.1 的必要前提，在同一 [PR #95](https://github.com/dragonbaba/super-pi/pull/95) 修复并完成最终验收合并；逐 tier 继承基价、保留显式零，验证阈值、缓存读写和单位转换，见 §26。没有新增币种换算或变更 Moonshot 固定规则。
- [x] **T05.3（已合并并关闭）** 本清单核实的模型记录与默认值已逐类验收：Haiku 5.5 [PR #89](https://github.com/dragonbaba/super-pi/pull/89)、NVIDIA 默认模型 [PR #96](https://github.com/dragonbaba/super-pi/pull/96)、Together DeepSeek 新 ID 控制 [PR #97](https://github.com/dragonbaba/super-pi/pull/97)、Cloudflare Claude ID 与旧缓存恢复 [PR #98](https://github.com/dragonbaba/super-pi/pull/98) 均通过各自最终 CI/Codex 审查并经用户授权合并，见 §20、§27–§29.2。范围为这四项已核实差异，不表示未来所有供应商目录永久同步。
- [x] **T05.4（已合并并关闭）** 2026-10-11 的[国际官方缓存说明](https://platform.kimi.ai/docs/guide/context-caching)和[中国官方说明](https://platform.kimi.com/docs/guide/context-caching)均确认 K3 已按 TTL 单独计缓存写入费用；5m 写入价等于输入价、1h 为两倍。因此原 [a2eef9eb60](https://github.com/earendil-works/pi/commit/a2eef9eb60) 的“写入固定为 0”前提不再作为验收规则。**T05.4.1** 默认 5m 生成定价及两个随包记录由 PR #99 修复并合并，保留既有 USD 成本约定、其他价格与外部覆盖优先级，见 §30。**T05.4.2** Moonshot 1h 响应头到 `usage.cacheWrite1h` 的映射由独立 PR #100 修复，最终六个 CI 分片通过、Codex 无重大问题，2026-10-11 经用户授权合并，见 §31.2。两项均不得套用到 OpenRouter/其他转售商或 Kimi Coding 订阅估值。

入口：[目录生成](../packages/ai/scripts/generate-models.ts)、[运行时目录与成本](../packages/ai/src/models.ts)、[默认模型](../packages/coding-agent/src/core/model-resolver.ts)。参考：[tiers 传递](https://github.com/earendil-works/pi/commit/943a10e744)、[Bedrock tiers](https://github.com/earendil-works/pi/commit/4665fafb4d)。

完成条件：固定数据夹具验证 tier 前/等于/超过阈值、零价及缺省继承；在线加载与离线快照一致，用户覆盖不丢失。默认模型变更提供 provider 官方依据或固定目录证据。保留现有成本引擎，不引入使用预算或每个 delta 重建目录；目录合并/恢复采用已有 [merge benchmark](../scripts/bench/model-catalog-merge.ts) 和 [restore benchmark](../scripts/bench/model-catalog-restore.ts) 中与改动相关的部分。

### T06 — 命令输出完整性与临时文件权限

- [x] **T06.1（R，已合并）** 用有界流式状态处理跨 chunk 的 ANSI 控制序列，覆盖交互 `!` 和 RPC bash 共用的输出路径。独立 [PR #101](https://github.com/dragonbaba/super-pi/pull/101) 最终六个 CI 分片通过、Codex 复审未发现重大问题，合并为 `99d22f3013a62acf94070028a2526d02dd002992`；见 §32.2。
- [x] **T06.2（S/V，已合并）** bash 完整输出临时文件已补 `wx`/POSIX `0600`、成功 open 后所有权和关闭等待；普通工具与 MCP 生产入口核查见 §33。[PR #102](https://github.com/dragonbaba/super-pi/pull/102) 六个 CI 分片全部通过、Codex 最终复审无重大问题，合并为 `73a00c92f4038a00b14965e515ef8506ed2ab817`。Windows 实际 ACL 发现另列 T06.3。
- [x] **T06.3（S，已合并）** Windows 日志及所属标记在创建时采用保护的当前用户 DACL，并核验 owner/权限/Node fd 身份；覆盖用户 bash 与普通 bash/PowerShell spill，失败/取消/精确清理及性能证据见 §34。[PR #103](https://github.com/dragonbaba/super-pi/pull/103) 最终六个 CI 分片全部通过、Codex 复审无重大问题，无遗留审查线程；2026-10-11 经用户授权合并为 `215280db9b38fc2d5b093d77957978bc85c2b5dd`，见 §34.1。核心无扩展依赖或逐 chunk IPC。

入口：[bash executor](../packages/coding-agent/src/core/bash-executor.ts)、[ANSI 工具](../packages/coding-agent/src/utils/ansi.ts)、[MCP 结果](../packages/mcp-bridge/src/result.js)。参考：[跨 chunk ANSI](https://github.com/earendil-works/pi/commit/27c7b6ff48)。

完成条件：整块与任意边界分块输入产出相同文本，覆盖 CSI、OSC、UTF-8 分界、尾部未完成序列及超长无终止输入；状态容量有上限，结束/取消释放引用。临时文件有明确所有者与清理时机，POSIX 验证权限，Windows 单独核查实际保护方式，不能把 `mode: 0o600` 当成 Windows ACL 证明。沿完整输出→存储→进度→渲染链审计分配，避免通过逐字符拼接或反复全量扫描扩大成本。

第二次复核缩小 T06.2 的目标：[OutputAccumulator](../packages/coding-agent/src/core/tools/output-accumulator.ts) 已采用 `openSync(path, "wx", 0o600)`，并记录所有权、限制 spill 大小；普通 bash/PowerShell 工具这条路径不需要重复移植安全创建。仍有明确缺口的是 `bash-executor.ts` 中交互 `!`/RPC 的直接 `createWriteStream(tempFilePath)`。`mcp-bridge/src/result.js` 当前走有界 typed source，并不是上游同名的二进制临时文件实现，不能把它列为已确认的文件权限漏洞。

### T07 — 图片 worker 协议与终端图片格式

- [x] **T07.1（R；已合并并关闭）** 图片 worker 响应加入明确类型标识和校验；忽略 Node 的额外消息，直到有效结果、错误或退出再完成。真实图片 worker 夹具已复现并修复，等待终止和监听器清理已覆盖；独立 [PR #104](https://github.com/dragonbaba/super-pi/pull/104)，最终 CI/Codex 审查通过并经用户授权合并，见 §35–§35.1。
- [x] **T07.2（R；已合并并关闭）** 扩展直接传入 JPEG/GIF/WebP 给 `Image` 时，在 Kitty 路径转换为支持的格式；PNG 快路和其他协议保持明确。已复现并在构造/显式失效准备阶段转换，render 不转码，成功后替换原编码内容；独立 [PR #105](https://github.com/dragonbaba/super-pi/pull/105)，最终 CI/Codex 审查通过并经用户授权合并，见 §36–§36.1。
- [x] **T07.3（R；已合并并关闭）** 对照上游 WezTerm 全屏滚动图片裁剪修复，已在当前生产布局和上传缓存链复现绘制顺序及覆盖行变更漏重绘，独立 [PR #106](https://github.com/dragonbaba/super-pi/pull/106)，最终 CI/审查通过并经用户授权合并，见 §37–§37.2。协议断言与真实终端目视验收分开记录。

入口：[图片缩放](../packages/coding-agent/src/utils/image-resize.ts)、[Image 组件](../packages/tui/src/components/image.ts)、[终端图片](../packages/tui/src/terminal-image.ts)。参考：[worker 响应](https://github.com/earendil-works/pi/commit/b30a6dd779)、[非 PNG 图片](https://github.com/earendil-works/pi/commit/a276dabe57)、[WezTerm 裁剪](https://github.com/earendil-works/pi/commit/672000c80c)。

完成条件：额外消息先到不丢图片，异常和取消不二次完成，worker 确认终止且监听器释放。使用小型格式夹具；转换发生在受控准备阶段并缓存，不在每帧转码。验证滚动、清空、会话切换的 image ID/缓存释放；协议断言与真实终端目视验收分开记录。不能为了修正 worker 通信把图片处理搬回交互主线程。

### T08 — 多行高亮与全屏选区生命周期

- [x] **T08.1（R；已合并并关闭）** 多行字符串/注释每个输出行正确恢复颜色，覆盖嵌套 scope、插值和空行。已复现并修复，独立 [PR #107](https://github.com/dragonbaba/super-pi/pull/107)，最终 CI/审查通过并经用户授权合并，见 §38–§38.1。
- [x] **T08.2（R；已合并并关闭）** 同一布局内 session 切换及 transcript 重建的旧选区残留已复现，在统一条目重建边界清除选区、连续点击和自动滚动状态；普通增量和追加式压缩保留选区，独立 [PR #108](https://github.com/dragonbaba/super-pi/pull/108)，最终 CI/审查通过并经用户授权合并，见 §39–§39.1。

入口：[语法高亮](../packages/coding-agent/src/utils/syntax-highlight.ts)、[交互会话重建](../packages/coding-agent/src/modes/interactive/interactive-mode.ts)、[Alt Screen](../packages/tui/src/tui-alt-screen.ts)。参考：[多行高亮](https://github.com/earendil-works/pi/commit/b9ab918c62)、[选区重置](https://github.com/earendil-works/pi/commit/83c9e26453)。

现有 `releaseLayoutInteractionOwners()` 会在布局所有权转移时清理，但 transcript 重建不一定转移布局；这也是 T08.2 必须先做行为验证的原因。

完成条件：渲染后的每行保有预期颜色；切换、新建、恢复和压缩后的选区引用不指向旧内容，普通增量输出不无故丢失用户选区。遵循现有 AST/source invariants 与 [选区分配检查](../tests/tui-alt-overlay-selection-allocation.test.ts)。不要直接移植上游 `split/map/join` 到热路径，也不新增无 profiler 证据的对象池。

### T09 — Codemode 错误引导与隔离环境内的兼容

- [x] **T09.1（R；已合并并关闭）** 未知工具报错改为检索 ALL_TOOLS，并说明宿主提供 describeTools 时使用 await describeTools([names])；独立 Sandbox 不凭空新增发现 API，独立 [PR #109](https://github.com/dragonbaba/super-pi/pull/109)，见 §40–§40.1。
- [x] **T09.2（R；已合并并关闭）** 处理用户脚本修改内建对象后桥接序列化失败的问题。先比较冻结必要内建对象与独立安全序列化的兼容代价，保留确定结束和错误归属。独立 [PR #110](https://github.com/dragonbaba/super-pi/pull/110)，实施与证据见 §41–§41.1。
- [x] **T09.3（V→E；已合并并关闭）** 实际 provider 消息转换后，多条非空 `text()/console` 结果已有换行或独立内容块边界。三个真实脚本结果经过十个 API 适配器验证，覆盖末尾空项归一化及转换后图片数据；保留生产实现，只补定向检查与证据，不引入额外包装。独立 [PR #111](https://github.com/dragonbaba/super-pi/pull/111) 最终提交六个 CI 分片通过、Codex 复审无重大问题，经用户授权合并，见 §42–§42.1。
- [x] **T09.4（V→R；已合并并关闭）** 已复现 worker 入口/依赖文件消失后只有底层错误、缺少恢复指引。在启动/致命错误边界按缺失文件错误码补充有界重启与重建/重装提示，不自动重试脚本；源码与 dist worker 的恢复/释放检查通过。独立 [PR #112](https://github.com/dragonbaba/super-pi/pull/112) 最终提交六个 CI 分片通过、Codex 审查无重大问题，经用户授权合并，见 §43–§43.1；不复制 pnpm 专用假设。

入口：[prelude](../packages/codemode/src/runtime/prelude-source.ts)、[host](../packages/codemode/src/runtime/host.ts)、[集成](../packages/coding-agent/src/core/codemode.ts)、[runtime 测试](../tests/codemode-runtime.test.ts)、[热路径检查](../tests/codemode-hot-paths.test.ts)。参考：[内建对象防护](https://github.com/earendil-works/pi/commit/b223082bb)。

完成条件：原型修改不能破坏宿主、污染后续执行或让调用悬空；成功/失败均释放 worker，保留现有脚本与输出/存储容量限制。错误提示指向可用 API；输出分隔开销有界且不重复嵌套。不得放宽当前输出限制到上游更大的默认值。

### T10 — MCP 分页发现与完整目录缓存（新增，优先）

证据：**R**。这是重新检查 v1.0.0 基线时发现的遗留差异，不是 v1.1.0 才引入的新功能。官方 `McpClient.listTools()` 收集所有页，并兼容空/null 结束游标；本地使用的 SDK `Client.listTools()` 只返回一页，本地桥接没有继续请求 `nextCursor`。

- [x] **T10.1（已合并并关闭）** 完整读取 `tools/list` 的后续页，再统一登记和缓存。原夹具只有 1 次 list 请求，第二页工具未注册，第一页仍以 `catalogReady: true` 写入缓存。独立 [PR #86](https://github.com/dragonbaba/super-pi/pull/86) 已实现完整收集及登记前名称冲突预检，三页目录可搜索/调用/缓存/恢复，见 §17。
- [x] **T10.2（已合并并关闭）** 区分“没有游标”“空字符串”“null”“非法类型”。原 null 在 SDK schema 阶段触发 `protocol-error`。PR #86 在实际 SDK 列表结果 schema 边界兼容 null/空结束游标，非法类型和超长游标仍拒绝，与 T10.1 同属完整目录问题。
- [x] **T10.3（已合并并关闭）** PR #86 的全部页共用原 startup deadline，累计工具数按配置最多 128、页数最多 128、游标最多 4096 字符、累计工具数据最多 2 MiB；保留每 schema 16 KiB/depth 32 及 transport 容量限制。绕过 SDK 单页便利方法，仅在完整目录收集后一次编译全部 metadata，保留首末页输出校验和 required-task 约束。重复游标/失败/取消/超限不发布半套目录，v3 缓存 envelope/domain 安全失效旧 v2 第一页缓存，见 §17。

入口：[连接与登记](../packages/mcp-bridge/src/bridge.js)、[SDK 适配](../packages/mcp-bridge/src/client.js)、[目录缓存](../packages/mcp-bridge/src/schema-cache.js)。上游依据：[v1.1.0 MCP client](https://github.com/earendil-works/pi/blob/v1.1.0/packages/mcp/src/client.ts)、[MCP changelog 的 v1.0.0 兼容修复](https://github.com/earendil-works/pi/blob/v1.1.0/packages/mcp/CHANGELOG.md)。

完成条件：两页以上工具全部可搜索/调用/恢复；首末页、空/null、重复游标、无穷空页、累计超限、第二页失败、取消与旧缓存迁移均有夹具。失败保留上次完整缓存且允许显式重试，不注册半套新目录。T01 升 SDK 后重新确认返回与验证器缓存语义；不增加另一套 transport 或无界缓存。目录处理触及大结果路径时，按性能契约提交累计处理量和生命周期证据。

## 5. 功能差异：单独确认采用范围

以下保留原 F 类候选及适配前提；F01–F08 后续均逐阶段获得授权并已完成合并。此状态不自动扩大到本节低优先级核查和 §6 的其他候选；最新核对见 §75。

| ID | 候选 | 本项目适配前提 |
| --- | --- | --- |
| F01（已合并 #113/#114） | 工具通配符、`+name/-name`、`--no-mcp` | 先定义现有 allowlist、Codemode 可调用集合、显式排除和 MCP 的优先级；不能直接照搬上游“`--tools` 默认保留 MCP”的语义。 |
| F02（已合并 #115–#117） | MCP 项目级局部覆盖、交互 manager、CIMD | F02.1 同名 server 局部覆盖已合并 PR #115；F02.2 manager 已合并 PR #116；F02.3 CIMD 已合并 PR #117。覆盖必须维持项目可信度与身份隔离；CIMD 使用 Super Pi 自己的身份/元数据，不能借用 pi.dev。manager 需要异步状态与取消验收。 |
| F03（已合并 #118–#120） | `registerToolRenderer()`、响应/工具耗时持久化、`outputPad` 应用范围 | 耗时覆盖 `AssistantMessage`、`ToolResultMessage`、执行结束事件、render context 与历史恢复，不能只补实时 `Took`。本地 `lazyStream` 探针确认 setup 失败消息使用失败时刻作 timestamp，需在统一计时前修正；旧记录没有 duration 时不伪造。独立 renderer 不授予执行权；保留本地流的结构类型兼容，不机械移植上游私有字段导致的 SDK 类型破坏。本地已有 `outputPad`，只核对缺少的展示路径。 |
| F04（已合并 #121/#122） | `samplingParamsByThinkingLevel`、Azure Foundry Chat Completions | 保留现有配置优先级；Azure provider 改名需兼容旧认证、模型键、设置和 session，不能直接破坏旧名称。 |
| F05（F05.1 已合并 #123；F05.2 已合并 #124） | OSC 7501 状态、`agent_settled.aborted` | 区分结束、取消、失败、等待输入；保持 JSON/扩展事件向后兼容和终端能力检测，不在高频事件上重复写状态。 |
| F06（已合并 #125/#126） | Anthropic inline tools | 已接入工具与动态提示变更历史、权限/模型门禁、会话恢复和代理完成元数据，见 §69–§71。请求输入估算保持既有算法，只补 native 声明覆盖；不引入子代理预算。 |
| F07（已合并 #127） | Codemode 图片保存及后续回合可寻址文件 | 完成时异步保存私有图片及清单，后续回合经普通工具读取；同次去重、大小/数量上限、权限和临时生命周期明确。投影完整保留地址或以 continuation 恢复；空间不足时精确回收本次图片、仅重试文本持久化，不重放工具。最终同 head 六分片 CI 及 Codex 复审通过，见 §71–§72.4。 |
| F08（已合并 #128） | 登录界面的应用名参数 | 已增加可选 `LoginOptions.agentName` 并贯通 Models/ModelRuntime/lazy OAuth；Super Pi 交互登录使用 `Super Pi`，旧 SDK 缺省仍为 `pi`。OAuth client ID、授权主体、设备码登录与 T04.3 请求头优先级保持原行为；同 head CI/审查完成，见 §73–§75。 |

来源按对应版本归档：[v1.0.1](https://github.com/earendil-works/pi/releases/tag/v1.0.1)、[v1.0.2](https://github.com/earendil-works/pi/releases/tag/v1.0.2)、[v1.0.3](https://github.com/earendil-works/pi/releases/tag/v1.0.3)、[v1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4)、[v1.1.0](https://github.com/earendil-works/pi/releases/tag/v1.1.0)。这些是差异定位来源，实施仍以当前本地入口和测试为准。

低优先级适配核查另行记录：登录 URL 复制快捷键、Home/End 与全屏滚动键位、Termux 剪贴板和安装提示、Herdr 链接、`!!` 标题颜色。均须先确认当前入口和目标环境；没有复现或实际使用需要时，不为了发布说明逐项创建修复 PR。隐藏工具的内建提示规则已按当前路径排除，见 §6。

## 6. 已有实现、未发布内容及不适用项

下表保留原始复核分类和适配条件；其中引用 T 类任务的旧“仍需处理”描述已由 §4 的完成记录覆盖。当前剩余候选与交付事项统一见 §75.1，历史记录中的“待完成/未启动”不代表当前仍未完成。

| 项目 | 处理结论 |
| --- | --- |
| `Selected model is at capacity` 重试 | E：本地探针已返回可重试，不重复修改。 |
| `--models` 尾随逗号 | E：当前参数解析已经 trim 并过滤空项，不重复移植。 |
| Codemode 输出泛滥、图片读取回传 | E：已有更小的输出/条目限制、独立 worker 和图片内容路径。检查边界即可，不移植整套上游。 |
| 终端断开 EIO/EPIPE/ENOTCONN | E：本地已有错误分类和关闭处理；不能再列为未修复崩溃。 |
| MCP 连接未完成时 shutdown | E：当前 close 会取消连接并等待 `connectPromise`；T02.4 仅查登录/刷新剩余边界。 |
| MCP 请求超时与流程取消 | E（部分）：已有 15 秒单请求上限、180 秒流程时限和 shutdown abort；完成等待不是仅凭 abort 就能证明。 |
| MCP 关闭前刷新 token | 当前默认链排除，见 T02.4.3；登录/刷新事务问题仍按 T02.4.1–T02.4.2 处理。 |
| 普通 shell 工具 spill 文件 | E（创建方式）：OutputAccumulator 已有 `wx`、`0600`、容量与所有权管理；交互 `!`/RPC 的另一条输出链仍需 T06.2。 |
| 隐藏工具的系统提示 | E（当前模型暴露路径）：`_rebuildSystemPrompt()` 按有效工具收集规则，nested 工具的规则标明在 Codemode 内使用；没有 callable `read` 时不附 skills。无需为上游 `prepareLoadout` 接口另造同名机制，第三方自定义提示不在此结论内。 |
| 子代理并发、checkpoint、退出保护 | 以已合并 PR #77 及此前实现为基线保留；T03 修补默认角色能力，不重做调度体系。 |
| main 的 Mistral 超时改动 | 纳入 T04.2，但明确不是 v1.1.0 已发布内容。 |
| main 的配置 JSON Schema | F：后续可做；需覆盖 `.sp` 和本项目扩展字段，不直接生成 `.pi` 配置约束。 |
| main 的硬件光标/假光标、模型元数据 | 先做当前实现差异与目标终端验证；价格/模型数据随 T05 固定来源核对。 |
| main 的 npm 12 pack JSON 修复 | 上游目标是新 `scripts/package-artifacts.mjs`。本项目没有这条同名执行链，未证明适用，不能泛化为本地 npm 12 构建故障。 |
| Anthropic 浏览器登录端口回退 | 不适用：本项目已禁用该订阅登录，不能通过同步恢复。 |
| Nix、上游 managed install 保留策略、Bun 二进制 `.env` | 与本项目当前交付路径不同；若将来采用对应打包方式再评估，不默认修改全局安装。 |
| classifier、图像生成、Radius、durable/chord/evals | 保持既定范围外状态。 |
| 新增 `pi-env` / SSH 远程执行环境 | F，建议继续范围外：这是基于 Durable ExecutionEnv 的独立 Rust daemon/SSH 部署包，本地 client/server/RPC 不等同于该能力。若以后需要远程工作区执行，单独立项，不当作普通 CLI 缺陷补丁。 |

本地全局离线安装的更新属于交付步骤，应在相关 PR 合并并获得该步骤授权后执行。不能把源码已合并等同于用户机器上的全局版本已更新。

## 7. 验证记录与性能要求

### 本轮实际执行

环境：Windows / PowerShell；定向生产函数探针使用 Node 22.19.0。未调用付费模型、真实 OAuth 登录或外部 MCP 服务，未读取用户凭据。

| 探针 | 观察到的结果 | 证明边界 |
| --- | --- | --- |
| 认证取消 | `AbortError`，刷新信号已取消，返回的新轮换凭据未保存 | 使用生产 resolver 与内存存储、虚构 provider；磁盘/跨进程事务留待 T02 验收 |
| 瞬态错误分类 | 四种候选错误均为 false；capacity 为 true | 证明当前分类行为，不等同于服务端真实重试成功 |
| 默认 worker | `read, grep, find, ls`，`allowBash: false` | 使用真实角色文件、解析器及 `effectiveTools(agent, true)` |
| 分块 ANSI | 完整输入输出 `red`；分块输入仍含 `ESC[31m` | 生产 strip 函数；完整命令流及尾部处理留待 T06 |
| 多行高亮 | JSON 表示为 `"\u001b[31ma\nb\u001b[39m"`，第二行无新颜色前缀 | 生产 HTML 高亮函数；真实终端每行渲染留待 T08 |
| 原型修改 | 修改 Array/Object 的 `toJSON` 均以 sandbox 错误结束，下一次 `return 7` 成功 | 未复现宿主崩溃或跨执行污染，不据此承诺所有原型修改都安全 |
| 未知工具 | 报错包含不存在的 `searchTools()` 建议 | 当前生产 prelude 的真实错误内容 |
| worker 生命周期 | 4 started、4 stopped、0 active | 本轮 4 次 Codemode 探针均完成关闭；不是完整 GC 分析 |
| 依赖审计 | 生产 2 包（high 1、critical 1）；全部 7 包（high 6、critical 1） | 当日依赖/公告快照；不等同于 7 条独立可利用漏洞 |

### 后续 PR 的验收规则

1. 先读目标和适用说明，再改代码。S/V 项先补最小行为夹具；不能通过只断言源码字符串来代替行为验证。
2. 使用 [测试规范](testing.md) 的单一执行清单，先跑受影响范围；只有改动影响、失败或仓库规定要求时扩大。文档变更不触发全量测试；最终代码候选完成规定检查后，不无变化重复跑整套测试。
3. 触及 provider delta、工具进度、事件、布局、终端帧或大结果处理，必须读 [Hot-path allocation contract](performance/hot-path-allocation-contract.md)，审计从生产者到释放边界的完整调用链。
4. 热路径证据缺一不可：确定性结构计数、allocation profile 或精确计数、受控 GC/引用释放证据；运行相关 AST/source invariants 和 allocation benchmark。不能用一次耗时或堆快照宣称性能改进，也不能把分配移入 helper 后排除审计。
5. 分配上限、例外和对象池准入严格执行 §3.1 与性能契约；检查完整调用链的实际计数，不能以“没有新增”代替达到契约门禁。
6. 严格执行 §3.2：每类问题独立新开 PR；完成修复、自审和验证后提交/推送，创建 PR 随即单独评论 `@codex review`。同类审查修复更新原 PR 并再次请求审查，其他类别另开 PR。合并前核对最终提交的 CI、审查状态和未解决意见，不把旧提交的通过记录套到新提交。
7. 按本任务记录的身份释放文件、worker、监听器、进程及计时器；不扫描猜测并终止用户进程。Windows 与 Linux、协议夹具与真实终端、源码与全局安装的验证分别记录，未执行项明确保留。

### 每个任务的关闭记录

勾选任务时补充：问题类别、PR URL、最终提交 SHA、`@codex review` 评论 URL 及对应提交、审查结论与意见处理情况、实际改动范围、最小复现与修复后结果、性能证据位置（适用时）、资源释放证据、最终 CI，以及仍未验证的环境。V 类未复现的任务可以以“排除，附理由和证据”关闭，不需要制造代码修改或修复 PR；其余修复不能仅凭本地完成就标为交付完成。

## 8. 第二次差异复核记录（2026-10-09）

### 覆盖与结论

重新查询官方 releases/latest、tags 及 compare API 后，最新稳定版仍为 v1.1.0；Super Pi HEAD、稳定 tag 和 main 快照均与 §1 一致。完整取得 v1.0.0 → v1.1.0 的 **139 个提交元数据**，核对各版发布说明、AI/MCP 包 changelog、新增 env 包定位及相关生产入口；并非对 139 个提交的每一行代码做了行为验证。原文中的实施步骤仅作为待办资料，本次没有据此执行升级、提交、推送、PR 或安装。

**需要补充，原 T01–T09 的主要方向成立。** 新增优先项是 T10 分页目录；扩充 T04.5 的 Haiku 能力适配、T04.6 的请求估算校准及 T05.4 的生成器定价防回退；将图片落盘和应用名作为 F07/F08 独立功能差异。T02 的事务取消增加本地证据，关闭刷新子项排除。T06 缩小到已确认的生产输出入口。F03 补齐 AI 消息与历史持久化层，避免只比较 CLI changelog 而漏掉包 API 的变化。

补充来源：[AI v1.1.0 changelog](https://github.com/earendil-works/pi/blob/v1.1.0/packages/ai/CHANGELOG.md)、[Codemode 图片文件](https://github.com/earendil-works/pi/commit/d677d0ee71)、[统一耗时](https://github.com/earendil-works/pi/commit/36a686ee8d)、[应用名](https://github.com/earendil-works/pi/commit/9ad083102a)、[pi-env 的 Durable/SSH 定位](https://github.com/earendil-works/pi/blob/v1.1.0/packages/env/README.md)。faux provider 的逐消息缓存比较属于模拟 provider 的分配优化，使用量算法不变，暂不升为生产缺陷；如后续测得本地 faux 压测成本再处理。

### 本次新增证据

环境为 Windows / PowerShell、**Node 26.4.0**，与 §7 首次探针的 Node 22.19.0 分开记录。脚本只调用本地生产函数与 SDK，HTTP 响应、存储提交和 provider 输入使用虚构夹具，没有真实 MCP/OAuth 连接或付费模型请求，也未读取用户凭据。

| 探针/检查 | 本次观察 | 边界与归属 |
| --- | --- | --- |
| MCP 两页目录 | 第一次响应携带 `page-2`，实际仅请求 1 页；只注册/缓存 `first`，仍 `catalogReady=true` | 生产 runtime + SDK，fetch 替换为本地响应；T10.1 |
| MCP 结束游标 | 空字符串可接受；null 导致 `protocol-error`，未注册或缓存 | SDK 的真实解码/验证路径；T10.2 |
| MCP close | 虚构 token owner 在连接期各读取 4 次；显式 close 阶段 3/3 为 0 token 读取、0 fetch；client、transport、connectPromise 均清空，activeCalls=0 | 无真实服务端；结合 SDK 源码排除当前默认链上的关闭刷新，不证明服务端 session 已删除 |
| Bedrock Haiku 5.5 | 直接模型 ID 和匿名 profile ARN + Haiku 名称均判定为 `budget`；Sonnet 5.5 对照为 `adaptive` | 调用生产 profile/capability 函数；未向 Bedrock 发送请求，T04.5 |
| MCP 事务提交前取消 | 模拟轮换完成后 abort，抛 `AbortError`，提交存储保留 generation 1 | 调用生产 transact，存储和轮换操作为夹具；未证明跨进程锁行为，T02.4.2 |
| lazy setup 错误时间戳 | 可控时钟在 1000 开始、2000 失败，最终 timestamp=2000，无 durationMs | 生产 lazyStream；统一计时/诊断需考虑，F03 |
| 随包模型数据 | Anthropic 快照无 Haiku 5.5；Moonshot 两目录 Kimi K3 cacheWrite 都为 0 | 仅当前随包 JSON；不代表在线目录或用户覆盖内容，T04.5/T05.3/T05.4 |
| 生产依赖重审 | 2 个受影响包：SDK high、proxy-addr critical | 与首次快照一致；本轮未重跑开发依赖审计，未做利用路径复现 |

证据保存于 `.git/pi110-rereview-20261009/`：原任务文档快照、比较元数据、官方包 changelog、上游 MCP client 源码、`probe.mjs` / `probe-results.json`、`model-and-event-probe.mjs` / `model-and-event-results.json`、生产审计 JSON 和本地源码哈希。官方下载文件仅作为阅读材料，没有执行。探针进程均正常退出，fetch/时钟替换均在 finally 恢复，未启动监听服务器或长期后台进程；证据文件保留供复查。

本次仅补充本文，生产实现和锁文件未修改；既有 `docs/README.md` 用户改动保留。文档和定向审查不运行全量测试或 allocation benchmark，首次复核的测试数字不能当作本轮新执行结果。实施仍需按每项完成条件验证，真实服务端、Linux 权限和终端目视验收仍未覆盖。

## 9. T01.1 实施与交付记录（2026-10-09）

问题类别：生产依赖安全升级。分支 `codex/t01-1-production-dependencies`，最终审查提交 `e7cc84133b37667352979e180f3caae4a124512d`，独立 [PR #78](https://github.com/dragonbaba/super-pi/pull/78)。创建后已立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/78#issuecomment-6074920799)，对应同一提交。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/78#issuecomment-6074946391)已完成，未发现主要问题；未解决讨论为 0。[最终候选 CI](https://github.com/dragonbaba/super-pi/actions/runs/37888785732)的 Linux 2 个、Windows 4 个分片全部成功。经用户授权，2026-10-09 14:38:41（Asia/Tokyo）以 squash 合并至 main，合并提交 `35bb1900f953c6bd418f6317c695841417af3674`，T01.1 已关闭。

实现仅包含 4 个文件：MCP bridge 固定 SDK 1.32.1、锁文件将传递依赖 `proxy-addr` 更新至 2.0.8、客户端适配器版本注释及 OAuth 兼容断言。锁文件仅改变两项安装依赖和 MCP workspace 的 SDK 版本项；安装实际更新 2 个包。测试明确要求新 SDK 的 client/token issuer 字段持久化，未删除安全字段来迁就旧断言。用户既有文档改动单独保留，未混入修复提交。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1；GitHub CI 的 Node 22.19 Linux/Windows 六个分片全部通过 |
| 生产依赖审计 | `npm audit --omit=dev --json`：0 项；升级前 2 项 |
| 全部依赖审计 | 剩余 5 项 high，均在开发构建链；留给 T01.3 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 定向回归 | 15 个 MCP 测试文件 + 通用源码约束 + presentation 源码约束：400 通过、0 失败/跳过 |
| 完整测试 | `npm test`：234 个测试单元成功退出；各进程汇总 3703 项，3611 通过、92 跳过、0 失败/取消 |
| SDK 实际进度路径 | 升级前后 100000 次进度交付均为 0 个新增 Promise；晚到进度被忽略；媒体验证不解码完整 base64 |
| 调用释放 | 4 路并发调用在成功、错误、取消、runtime dispose 后 activeCalls=0，晚到回调不再更新 |
| 大结果确定性计数 | small/structured/mixed：tokens=56/122/123，artifacts=0/1/1，continuations=0/4/4；每个活动 owner 的 sourceEntries=1，mixed progress=100；前后相同 |
| 受控 GC | 前后均 9 个 WeakRef、0 retained；owner 清理计数由 benchmark 断言 |
| allocation profile | peak heap 33583224 → 34038648 B；最大采样点仍为既有 byteLength 1048592 B；不把采样波动当作性能提升或泄漏结论 |
| 大结果投影/恢复 p95 | small 0.0111 → 0.0096 ms，structured 6.6105 → 6.4436 ms，mixed 8.5799 → 7.3531 ms；仅当前本地夹具 |

按性能规范审计了 transport → SDK protocol/client → `McpClient._onnotification` / `_onprogress` → `McpCall.notify` → agent progress delivery → AgentSession / InteractiveMode → tool component → render / frame queue / terminal writer，以及 result schema → typed MCP normalization → presentation / recovery → owner dispose 的边界。SDK client/index、types 及普通进度处理未变；协议变化集中于 task/session 隔离，本地不设置 task store。新版 SDK 的 redirect 防护在 HTTP 请求发起处增加有界 wrapper/Promise continuation；本地 fetch 仍强制 `redirect: "error"` 与 origin 校验，测试已覆盖。既有进度 envelope、结果投影元数据和 UI 状态仍存在，不能把本次“进度 Promise=0”写成整条链无任何对象分配；未引入对象池。

原始证据位于 `.git/t01-1-production-dependencies-20261009/`，包括升级前后审计、SDK 源码差异、定向/完整测试、构建和 `scripts/bench/mcp-output-bounds.ts` 的 timing/allocation/gc 日志。测试进程已正常退出，fixture 的连接/监听器/临时目录按测试自身的清理钩子释放；证据文件保留供复查。PR 正文包含可重跑命令、调用链和具体数值，审查者无需依赖本地隐藏目录理解结论。

**本项边界：依赖升级不能替代 T01.2 的旧凭据与固定客户端、重新发现/刷新修复；T01.2 后续实施见 §10。** T01.3 开发依赖修复另开 PR。本项未运行真实外部 MCP 服务或终端目视验收；只更新源代码工作区依赖，未执行全局 CLI 安装。

## 10. T01.2 实施与交付记录（2026-10-09）

问题类别：MCP 已保存凭据的 issuer 绑定与迁移。分支 `codex/t01-2-mcp-credential-issuer`，最终审查提交 `ca664845653c4f8744ca95ba9dfbee2e4a05f989`，独立 [PR #79](https://github.com/dragonbaba/super-pi/pull/79)。创建后已立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/79#issuecomment-6075210881)，对应同一提交。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/79#issuecomment-6075247285)已完成，未发现主要问题；未解决讨论为 0。[最终候选 CI](https://github.com/dragonbaba/super-pi/actions/runs/37890875873)的 Linux 2 个、Windows 4 个分片全部成功，确认运行对应上述最终提交。经用户授权，2026-10-09 15:18:24（Asia/Tokyo）以 squash 合并至 main，合并提交 `f6bf1ebd82e106720119b1488cf6d6767d7045bd`，T01.2 已关闭。

根因与修复：SDK 仍允许缺失 issuer 的旧凭据，原有 `token()` 读取及刷新中的新 token 快捷返回未检查绑定；SDK 的 `invalidateCredentials("all")` 还会清空唯一保存的 issuer 上下文，使后续重新发现与固定客户端回退失去绑定。现改为在冷缓存发布和刷新事务边界检查 client/token 与 discovery 的 issuer，一次授权操作独立保留 issuer，SDK 清除记录后也不能改变它。固定 clientId 在显式登录中先绑定 issuer，自动刷新不再发起替代注册或恢复未绑定客户端。

缺少 issuer 的旧记录须显式重新登录：仅登录草稿清除旧 client/token/discovery，不推测旧秘密的归属；新授权成功后才原子替换存储。失败或取消保留原记录，但不允许该未绑定记录继续用于请求。已绑定服务器发生变化时须确认新服务器，再 logout/login。26 项新增行为/性能检查与现有锁、回调、PKCE、scope、轮换和取消测试共同验收；修复前的 21 项定向回归全部失败，修复后全部通过。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1；CI 的 Node 22.19 Linux/Windows 六个分片全部通过 |
| 定向回归与源码约束 | 15 个 MCP 测试文件 + `source-invariants.test.ts`，421 通过、0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | 234 个单元成功退出；3729 项，3637 通过、92 跳过、0 失败/取消 |
| 依赖审计 | 生产 0 项；开发构建链仍 5 项 high，留给 T01.3；本项未修改锁文件 |
| 有效缓存读取 | 前后 10000 次读取均为 0 次加锁、fetch、JSON.parse、URL 构造；Promise 均为 40002（原有每次异步读取 4 个加测量循环 2 个），无新增 |
| 受控 GC | logout 后 owner 仍存活，4 个缓存 WeakRef 全部释放；前后均 0 retained |
| 分配与耗时 | 100000 次 warm read：peak heap 86343888 → 88636024 B；5000 次批次 p50/p95 为 2.6373/6.1022 → 2.7339/5.7092 ms；属于同机夹具，不代表真实网络耗时或性能提升 |

性能设计审计覆盖 transport → `fetchWithHeaders` → `token/read` → 缓存发布，以及失效/401 → 文件锁刷新事务 → SDK discovery/provider/token → 有界 OAuth fetch → 原子落盘 → 缓存提交；登录的 reservation/回调/清理、logout 和 runtime 释放也已核查。新增校验仅位于冷加载、登录和刷新边界，普通有效缓存读取不重复校验；新增 issuer 字符串属于当前授权操作，受既有 metadata 1 MiB/store 2 MiB 上限约束，随操作结束释放，没有新增队列、全局缓存或对象池。请求认证原有 async 成本与 progress/frame 零 Promise 路径分别记录，不宣称所有 token 读取零分配。

新增 [缓存读取基准](../scripts/bench/mcp-oauth-cache.ts) 的 `counts`、`allocation`、`gc` 模式；counts/GC 已纳入正常测试清单。证据在 `.git/t01-2-mcp-credential-issuer-20261009/`，含修复前失败、前后源码哈希与基准、完整/定向测试、构建和审计日志，PR 正文列出重跑命令和数字。测试进程已退出，回调和临时目录按 fixture 清理；原始证据保留供复查。既有任务文档改动未混入生产修复提交。真实外部 OAuth/MCP 服务、终端目视验收和全局 CLI 安装不在本项已执行范围；T02 刷新取消事务仍是下一类独立工作。

## 11. T01.3 实施与交付记录（2026-10-09）

问题类别：开发构建依赖审计。分支 `codex/t01-3-development-dependencies`，最终审查提交 `6f74d13cc9c4e71ded41fee5b1b4d2dc8b6ee05f`，独立 [PR #80](https://github.com/dragonbaba/super-pi/pull/80)。创建后已立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/80#issuecomment-6075674148)。同一提交的 [CI](https://github.com/dragonbaba/super-pi/actions/runs/37893901954) 六个分片全部成功；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/80#issuecomment-6075706170)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 15:50:35（Asia/Tokyo）以 squash 合并，合并提交 `efc316cd38461fce44286c072621213aa30f9c65`，T01.3 已关闭。

根因与取舍：5 个 high 受影响包来自同一条 `shx@0.4.0 → shelljs@0.9.2 → fast-glob@3.3.3 → micromatch@4.0.8 → braces@3.0.3` 链，而非 5 项独立漏洞。[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) 当前未列出修复版；npm registry 的最新 braces 为 3.0.3，最新 ShellJS 0.10.0 仍使用 fast-glob。核对仓库实际仅使用 rm、cp、mkdir、chmod，再以跨平台行为夹具和实际构建验证后，选择 shx 0.3.4 / ShellJS 0.8.5。未执行强制 audit fix，未更改构建命令接口。

改动为根目录、client、protocol、server、coding-agent 的五处开发依赖精确版本、锁文件，以及 `tests/build-file-commands.test.mjs`。锁文件新增 8 个、移除 32 个开发包；已逐条比较所有生产 node_modules 记录，0 项变化。npm 顺带更新的 hasown、is-core-module、resolve 已恢复原锁定记录并重新安装验证。生产 glob 13.0.6、minimatch 10.2.5 保持一致。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1；Node 22.19 的 Linux/Windows CI 六个分片全部通过 |
| 构建命令兼容性 | 修复前后均 3 项通过：递归目录替换、清理幂等、保留相邻文件、通配符、多源与空格路径、两个 CLI 入口 chmod、缺失输入非零退出；POSIX 权限位由非 Windows 测试断言 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过；49 个实际复制资源逐字节一致，provider data 目录结构一致 |
| 完整测试 | `npm test`：235 个执行单元全部成功；3731 项，3639 通过、92 跳过、0 失败/取消 |
| 依赖审计 | 全依赖 5 high → 0；`npm audit --omit=dev --json` 仍为 0；开发依赖计数 143 → 119 |
| 性能适用性 | 本项仅修改构建开发依赖与测试，没有生产热路径变更；不适用运行时 allocation/GC 新门禁，也不据此宣称性能提升 |
| 资源生命周期 | shx 使用独立构建进程和同步 glob；测试子进程有 10 秒上限并等待退出，临时目录按各测试创建的确切路径校验、释放；全部本地测试进程正常退出 |

已知限制：glob 7 / inflight 带弃用提示，当前审计为 0 不等于消除了维护风险。已核查 ShellJS 使用 glob.sync，未调用 inflight 的异步请求合并路径；本项没有新增运行时缓存、队列或对象池。后续替换构建工具应单独评估。真实外部服务和全局 CLI 安装未执行；POSIX 文件权限与干净安装已由最终 CI 验证。

原始证据在 `.git/t01-3-development-dependencies-20261009/`，包括修复前后审计、兼容性夹具、完整测试及汇总、构建、资源比对、锁文件语义差异和最终 PR 快照。PR 正文给出重跑命令、结果与取舍；现有任务文档保持本地修改，没有混入本项提交。下一类独立工作为 T02。

## 12. T02.1 / T02.4.2 实施与交付记录（2026-10-09）

问题类别：取消请求时保存已经轮换的 OAuth 凭据。分支 `codex/t02-1-oauth-refresh-transactions`，最终审查提交 `245c1ec843356e4bce5752559ce9ed8a3de901b2`，独立 [PR #81](https://github.com/dragonbaba/super-pi/pull/81)。创建后已立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/81#issuecomment-6076227105)。同一提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37897488479)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/81#issuecomment-6076273582)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 17:11:15（Asia/Tokyo）以 squash 合并，合并提交 `afba59304343b7921338816b65a32a2e5253e1b0`，T02.1 / T02.4.2 已关闭。

根因：请求认证和目录刷新把调用方取消传到刷新请求，CredentialStore / FileAuthStorageBackend 又在提交前检查同一个信号。即使服务端已轮换 token，取消仍会抛弃唯一有效的新凭据。MCP 的 authorize → transact 同样受影响。修复前，三种存储后端 × 两条 AI 入口的 6 项提交前取消回归全部失败，真实 MCP SDK 的受控 token 响应也复现旧 refresh token 保留。

实现：请求认证和目录刷新共用 `refreshStoredOAuthCredential`，等待锁可取消，在锁内确认需要刷新后解除调用方取消传播，使用事务独立的 15 秒截止时间保护交换与保存。公共入口仍及时结束调用方等待；目录取消或被新一代替代后不再启动旧目录网络阶段。MCP 的 refresh 采用相同边界，整个事务独立限时 180 秒，每次 OAuth 请求仍限时 15 秒。超时抛弃当前提交资格并释放本地锁，迟到结果不能覆盖后续登录/登出。未修改通用存储取消规则，也未改变 issuer、PKCE、scope 或原子文件写入规则。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 新增覆盖 | 41 项；三种存储、两条 AI 入口、实际 MCP SDK、等待/刷新中/提交前取消、目录替代、并发和跨进程登录/登出、超时、迟到提交、计时器与监听器清理、计数和 GC |
| 定向检查 | `oauth-refresh-transactions`、`mcp-oauth`、`openai-codex-auth-diagnostics.contract`、`source-invariants`：273 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：236 个执行单元全部成功；3772 项，3680 通过、92 跳过、0 失败/取消 |
| AI 有效凭据读取 | 前后 10000 次均 120000 个既有 Promise，0 个新增 controller/timer，0 次刷新；结束后 caller 监听器为 0 |
| MCP 有效缓存读取 | 前后 10000 次均 40002 个既有 Promise，锁/fetch/JSON.parse/URL 构造均为 0 |
| 事务受控 GC | 取消后完成提交再清理，AI/MCP 两个 owner 保持存活，8 个事务 WeakRef 全释放，retained=0 |
| 缓存受控 GC | MCP logout 后 owner 保持存活，4 个缓存 WeakRef 全释放，retained=0 |
| MCP 分配采样 | 前后 100000 次读取 peak heap 89533592 → 87201992 B，final heap 49950728 → 49983824 B；5000 次批次 p50 2.6277 → 2.6389 ms，p95 5.9329 → 6.5964 ms；是同机观测，未据此声称耗时改善或证明所有分配归零 |

调用链审计覆盖 Models / ImagesModels → resolveProviderAuth → store.modify / 文件锁 → provider refresh → 原子落盘 → 解锁；Models.refresh 的代次控制与 network phase；MCP transport → token / 401 refresh → SDK discovery/token → 有界 OAuth fetch → transact → 原子文件写入 → cache 发布。流式 delta、事件交付和终端帧路径未改动；正常 request-auth 原有 Promise、结果对象成本分别记录，不能套用 frame/progress 零 Promise 结论。

低频生命周期分配例外精确限定为 `refreshStoredOAuthCredential`、`McpOAuth.refreshTransaction`、`waitForOAuth`：每个刷新尝试最多一个事务 controller，每个真正开始的刷新最多一个截止计时器；caller 监听器在交换开始前解除，事务 finally 清除定时器。有效缓存读取不进入这些函数。没有新增对象池、生产全局队列或无界缓存。新增 [事务计数/GC 基准](../scripts/bench/oauth-refresh-transactions.ts) 的 counts/gc 模式已进入普通测试；MCP 沿用已有缓存 counts/allocation/gc 基准。首轮 after allocation 与定向测试并行，另记录测试结束后的 idle 样本用于上表，保留全部原始日志。

证据在 `.git/t02-1-oauth-refresh-transactions-20261009/`：修复前失败、定向/完整测试、检查与构建、前后计数、采样和 GC、PR 状态。AI 基线以 HEAD 原解析器只重定位两个未改变的工具导入后运行，未回退工作区文件。测试使用自己创建的隔离 auth 文件；跨进程 fixture 记录精确子进程并等待退出，完整测试进程均成功结束。既有任务文档保留为本地修改，未混入修复提交。

边界：截止时间之后或服务端已轮换但响应丢失的凭据无法由本地事务恢复；无法强制停止任意不响应 signal 的第三方 Promise，但迟到响应不能重新提交。使用虚构凭据与受控网络响应，未连接真实外部 OAuth 服务，未安装全局 CLI。T02.2 回调端口、T02.3 native client、T02.4.1 会话关闭等待仍留给各自下一类独立 PR；本次不关闭整个 T02。

## 13. T02.2 实施与交付记录（2026-10-09）

问题类别：Codex 浏览器登录回调端口与连接生命周期。基于 PR #81 的合并提交 `afba59304343b7921338816b65a32a2e5253e1b0`，新建分支 `codex/t02-2-codex-oauth-callback`，最终审查提交 `9e3bb70505061e0471e2eba50b1d7a6e4924e59d`，独立 [PR #82](https://github.com/dragonbaba/super-pi/pull/82)。创建后立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/82#issuecomment-6077292637)。同一提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37904921733)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/82#issuecomment-6077332263)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 17:56:50（Asia/Tokyo）以 squash 合并，合并提交 `78821a99647eacc49c2183a9e4d8cace6155c53b`，T02.2 已关闭。

根因与最小复现：`startLocalOAuthServer` 吞掉绑定错误并返回空回调结果，导致占用端口时仍通知浏览器登录、请求手工输入并继续 token 交换；仅 `server.close()` 不能清理尚未完成请求的连接。`notify` 位于 finally 保护范围外，抛错会遗留监听器；取消只唤醒回调等待，随后又等待手工输入，而手工输入的 abort 直到 finally 才触发。原基线运行同一组五项关键回归，4 项断言失败、1 项取消等待达到 5 秒测试上限；成功登录后仍有 1 条未完成请求连接。初始仅测试普通空闲连接时，Node 26 已能自动关闭，不能把这一结果当成未完成请求也安全。

设计与实现：绑定失败先报错，不再发出 auth URL；`EADDRINUSE` 给出简短的 1455 端口占用、重试或选择设备码登录提示，其他错误保留原始原因。当前登录拥有幂等 cleanup，先停止监听，再 `closeAllConnections()` 并结束回调等待。运行中的 server error 传回登录流程；通知、prompt 和取消均进入 finally。取消检查避免继续打开浏览器流程或等待手工输入。既有 PKCE、state 校验、重定向地址、手工输入格式和设备码分支保持兼容。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 新增覆盖 | 20 项；真实本地 HTTP 监听与虚构 token 响应，覆盖占用端口、其他绑定错误、通知/prompt/server/token 错误、取消边界、4 种手工输入格式、state/PKCE、设备码和端口复用 |
| 定向检查 | callback、现有诊断 contract、source-invariants：34 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：237 个执行单元全部成功；3793 项，3701 通过、92 跳过、0 失败/取消 |
| 端口冲突 | auth URL、手工输入和 token 请求均为 0；既有占用端口的 listener 仍在运行 |
| 资源释放 | 在测试兜底 teardown 前，成功/失败/取消后的本次登录监听端口关闭、连接数为 0，caller/manual abort listener 为 0；同一端口连续登录 3 次均成功 |
| 性能适用性 | 仅显式登录生命周期，未修改正常认证读取、delta、事件或渲染热路径；不适用新的热路径 allocation/GC 基准，也不据此宣称性能提升 |

调用链核查为 InteractiveMode.loginProvider → model runtime / Models.login → openaiCodexOAuth.login → createAuthorizationFlow / startLocalOAuthServer → notifyAuthDialog / showAuthPrompt 或 HTTP callback → token exchange → credential commit；直接 AI CLI 登录入口也已核查。宿主的手工输入 prompt 观察其 signal 并在 finally 移除监听。变更限定在 `loginOpenAICodex`、`startLocalOAuthServer` 两个显式登录函数；低频例外在测试中点名。每次登录新增一个 error 引用、一个 closed 布尔值与一个共用 close 闭包；waitForCode 增加一次 async 包装/await，用于传递监听后的错误。既有 controller、deferred 仍属于本次登录；没有新增计时器、缓存、队列或对象池。端口、HTTP 连接、手工输入和调用方监听器的释放边界由真实连接计数及 signal listener 断言验证。

证据在 `.git/t02-2-codex-oauth-callback-20261009/`，包含原基线仅重定位导入后的源码与测试副本、失败日志、定向/完整测试、汇总、构建、源码哈希与 PR 快照。夹具使用自己创建的临时端口，不占用真实 1455；HTTP server 和 socket 均记录实例并清理，测试进程全部正常退出。既有任务文档继续保留为本地修改，未混入修复提交。未执行真实账号/浏览器 OAuth 登录、全局 CLI 安装或本地 Linux 验证；T02.3 与 T02.4.1 仍为后续独立工作。

## 14. T02.3 实施与交付记录（2026-10-09）

问题类别：MCP loopback OAuth 动态注册的 native client 声明。基于 PR #82 合并提交 `78821a99647eacc49c2183a9e4d8cace6155c53b`，新建分支 `codex/t02-3-mcp-native-client`，最终审查提交 `19cd15813737e11f2081c91687afd33a1313419b`，独立 [PR #83](https://github.com/dragonbaba/super-pi/pull/83)。创建后立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/83#issuecomment-6077883857)。同一提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37909178819)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/83#issuecomment-6077954410)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 19:24:37（Asia/Tokyo）以 squash 合并，合并提交 `8bb0c977aa0fd96ca3c980b9bb024958538d0c4d`，T02.3 已关闭。

根因：`McpOAuth.authorize` 的注册元数据遗漏 application_type，SDK 1.32.1 的 registerClient 将其直接序列化发送；按 OIDC 默认 web 类型处理的注册端点会拒绝 HTTP loopback redirect。修复前，真实 SDK 配合 OAuth/OIDC 两种发现夹具，均收到注册服务的 `invalid_redirect_uri` 错误并登录失败。实现仅在既有 clientMetadata 对象中增加 `application_type: "native"`。本项目 callbackReceiver 固定监听 127.0.0.1 并生成 HTTP 回调，因此无需 URL 分类器或新配置项。已有注册客户端继续复用，固定 clientId 仍跳过动态注册。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1 / MCP SDK 1.32.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 新增回归 | 2 项；OAuth/OIDC discovery → 实际 SDK 注册 JSON → 严格 native 注册响应 → 本地回调与 token 交换；修复前 2 失败，修复后均通过 |
| 兼容与释放 | 检查 S256 verifier/challenge、redirect_uri、scope、state、issuer 绑定；刷新与重新登录共复用 1 次注册，回调关闭，logout 后缓存与存储项清空 |
| 定向检查 | MCP OAuth 全套与 source-invariants：232 通过，0 失败/跳过；含既有固定客户端、issuer 错误、取消和刷新事务用例 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：237 个执行单元全部成功；3795 项，3703 通过、92 跳过、0 失败/取消 |
| 有效缓存读取 | 前后 10000 次均 40002 个既有 Promise；锁、fetch、JSON.parse、URL 构造均为 0 |
| 受控 GC | 前后均在 logout 后保持 OAuth owner 存活，4 个缓存 WeakRef 全释放，retained=0 |

性能与所有权：核查 `/mcp-login` → login → 文件锁内登录 reservation → callbackReceiver → authorize → SDK discovery/registerClient → 有界 fetch → state/issuer/PKCE 校验 → 原子凭据提交 → receiver.close；refresh 复用 authorize 的已有元数据对象，但不能注册替代客户端。正常 token/read 使用已验证缓存，不进入 authorize。新增 literal 字段仅使既有操作对象与注册 JSON 增加固定大小；没有新增对象、闭包、Promise、controller、计时器、URL 解析、队列、缓存或对象池，也没有改变释放边界。没有热路径修改；重跑相邻缓存路径的精确分配计数和 GC，不宣称耗时或内存改善。

原始证据、实施前设计记录、前后源码哈希、基线失败、基准、构建、完整测试与汇总、PR 快照在 `.git/t02-3-mcp-native-client-20261009/`。测试使用虚构凭据与受控网络响应，真实本地回调已关闭，临时 auth 目录和测试进程已按 fixture 清理。既有任务文档保留为本地修改，未混入本项提交。未连接真实外部 OAuth 服务、安装全局 CLI 或在本地执行 Linux 验证；下一类独立工作为 T02.4.1 的会话关闭与登录完成等待。

## 15. T02.4.1 实施与交付记录（2026-10-09）

问题类别：MCP 登录/登出命令的关闭与清理等待。基于 PR #83 合并提交 `8bb0c977aa0fd96ca3c980b9bb024958538d0c4d`，新建分支 `codex/t02-4-1-mcp-login-shutdown`，最终审查提交 `3c23f9ce76c4ac9f5f60537f6232f53fa3d28f8b`，独立 [PR #84](https://github.com/dragonbaba/super-pi/pull/84)。创建后立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/84#issuecomment-6079240596)。同一提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37918923195)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/84#issuecomment-6079279942)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 19:56:15（Asia/Tokyo）以 squash 合并，合并提交 `3c8416b5b2dbced7c63a09c6a89b94d6d52b3531`，T02.4.1 已关闭。

根因与宿主核查：AgentSession._tryExecuteExtensionCommand 只为当前 prompt 等待命令；reload 和 AgentSessionRuntime teardown 等待 session_shutdown，然后 invalidate/dispose，不额外等待扩展命令 promise。MCP 旧 shutdown 只 abort 控制器、等待连接关闭，会先于登录 finally 返回；旧命令随后仍可能通知或 reload。动态 import 完成前还没有发布控制器，故登录甚至可能在关闭后才开始。初始四项基线测试中，取消/迟到成功的关闭等待及 import 后启动共 3 项失败，正常成功后 reload 为通过对照。

实现：一个正在执行的 authOperation 包含模块加载、owner 创建、login/logout 及其清理，配合既有 controller、新增 generation 和 admission 标志。替代命令取消并等待同一个操作，仅最新代次可继续，不构造 Promise 队列。session_start/shutdown 禁止新操作进入并等待旧操作；连接关闭失败时 finally 仍等待认证清理。关闭、替代或 caller 取消后抑制旧通知与 reload；正常失败仍显示原有脱敏信息。成功命令在自身 reload 之前释放 authOperation，避免 reload → shutdown → 等待自身的死锁。parent signal 在 await 前读取，后续不读取旧上下文 getter。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 新增回归 | 15 项；login/logout 清理、迟到结果、import、关闭后及排队命令、替代会话、连接清理失败、caller 取消、错误恢复、自身 reload、真实回调/文件锁、真实 AgentSession.reload、GC |
| 定向检查 | auth lifecycle、OAuth、background activation、source-invariants：294 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：238 个执行单元全部成功；3810 项，3718 通过、92 跳过、0 失败/取消 |
| 操作容量 | 20 个替代请求只启动最后一个后继，live auth operation 峰值 1、结束 0；旧命令无迟到通知/reload |
| 真实资源 | 关闭实际 loopback listener 后仍等待被文件锁阻塞的 reservation 清理；释放锁后 shutdown/命令完成，reservation 清空 |
| 认证受控 GC | 扩展 owner 仍可达时，成功/错误/关闭三条路径共 9 个 owner/signal/ctx WeakRef 全释放，retained=0；普通测试通过有界子进程执行此检查 |
| 相邻缓存门禁 | OAuth 源码与 T02.3 相同；10000 次有效读取仍为 40002 个既有 Promise，锁/fetch/JSON.parse/URL 均为 0；4 个缓存 WeakRef 全释放 |

性能与所有权：变更仅位于显式命令、session_start 和 session_shutdown，低频边界在测试中点名为 runAuthCommand、stopAuth 和对应 handler。每个真正进入的操作增加一个生命周期 Promise，关闭增加生命周期等待；原 controller/signal 仍随操作创建。没有新增热路径分配、计时器、池或缓存，未更改 progress/delta/frame 路径。原有 OAuth 单请求/流程时限和失败登录清理锁等待上限保持不变，不通过提前放弃清理来宣称关闭完成。

独立剩余项：生产函数探针证实 runtime.close 返回时，已开始的 refreshTransaction 仍未提交且 state.oauth 已脱离；释放受控授权响应后才保存轮换凭据。此处属于 transport/刷新事务 owner，按每类独立 PR 规范单列 T02.4.4，下一步处理，不与当前命令生命周期 PR 混合，也不据此关闭整个 T02。SDK 1.32.1 的 close 已复查仍不调用 terminateSession，不属于此前排除的 DELETE 前刷新。

证据在 `.git/t02-4-1-mcp-login-shutdown-20261009/`：实施前设计、基线失败、定向/完整检查与汇总、构建、源码哈希、受控 GC/缓存计数、独立刷新关闭探针和 PR 快照。夹具拥有的回调、锁、临时 auth 目录和子进程均已释放；既有任务文档保留为本地修改，未混入实现提交。未连接真实 OAuth 服务、读取真实凭据或安装全局 CLI；本地未执行 Linux 验证。

## 16. T02.4.4 实施与交付记录（2026-10-09）

问题类别：MCP transport 关闭对后台 OAuth 刷新事务的完整等待。基于 PR #84 合并提交 `3c8416b5b2dbced7c63a09c6a89b94d6d52b3531`，新建分支 `codex/t02-4-4-mcp-refresh-shutdown`，最终审查提交 `5855fa55483f27491952ded7a4fe7a0e399aaaa4`，独立 [PR #85](https://github.com/dragonbaba/super-pi/pull/85)。创建后立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/85#issuecomment-6079635998)。同一提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37921641228)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/85#issuecomment-6079666551)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 22:19:49（Asia/Tokyo）以 squash 合并，合并提交 `a230d1d544d66d777474c3bf2681bf8544053b68`，T02.4.4 已关闭。

根因与实现：SDK close 结束请求等待，但 T02.4.2 保护的 refreshTransaction 仍可能持有文件锁等待响应或提交；原 closeRuntime 和 connectState 失败分支直接清空 state.oauth。修复前，响应尚未返回、提交前和连接失败三条生产路径均在关闭提前完成的断言处失败。现在 OAuth owner 用固定计数器覆盖整个事务直到原子写入、解锁及 finally，关闭时只创建一个共享 drain deferred。关闭取消尚在等锁的事务并禁止新 token/refresh 操作；已开始交换的事务继续使用独立 deadline。runtime 关闭及连接失败都等待 drain 后再释放 state.oauth，transport.close 抛错也不跳过等待。关闭立即释放缓存，迟到的冷读取、已 yield 的暖 token 和事务提交均不能重新挂回缓存。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | 本地 Windows / Node 26.4.0 / npm 12.0.1 / MCP SDK 1.32.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 新增回归 | 14 项；真实 SDK 401 刷新、实际文件锁/原子写、响应与提交前取消、关闭与替换、连接取消/失败、transport close 抛错、等锁取消、并发/迟到请求、失败/deadline、缓存竞态、受控 GC |
| 定向检查 | refresh shutdown、OAuth、auth lifecycle、MCP lifecycle、background activation、source-invariants：314 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：239 个执行单元全部成功；3824 项，3732 通过、92 跳过、0 失败/取消 |
| 关闭行为 | caller 取消及时返回；关闭等待落盘，完成时轮换值已保存、锁目录已释放；SDK 只允许既有取消通知，不重复 initialize |
| 所有权容量 | 1 个在途交换 + 20 个等锁刷新；关闭取消全部等锁者，只保留 1 个共享 drain；最终计数为 0，drain/resolver 均为 undefined |
| 事务受控 GC | 保持两个已关闭 owner 存活，成功/失败并伴随 caller 取消后，12 个事务、缓存、signal、drain WeakRef 全释放，retained=0；普通测试清除子进程 NODE_TEST_CONTEXT 并要求实际 GC 完成诊断 |
| 有效缓存读取 | 前后 10000 次均为 40002 个既有 Promise；锁、fetch、JSON.parse、URL 构造均为 0；既有缓存 GC 的 4 个 WeakRef 也全部释放 |
| 分配采样 | 前后 100000 次读取 peak heap 89504832 → 86394408 B，final heap 49889216 → 49895200 B；5000 次批次 p50 2.7193 → 2.6999 ms，p95 4.9449 → 5.7751 ms；仅为同机观测，不宣称耗时改善 |

完整调用链审计：session_shutdown / 会话替换 → McpRuntimeLifecycle → closeRuntime / connectState 失败清理 → SDK transport.close → fetchWithHeaders → token / 401 refresh → refreshTransaction → authorize / SDK auth → 有界 OAuth fetch → transact → FileAuthStorageBackend 原子写入与 finally 解锁 → cache 发布/清理。新增分配例外限定在 McpOAuth constructor、refreshTransaction、close、closeMcpState 和既有 closeRuntime 生命周期；暖缓存 token/read 仅增加 primitive closed 判断，无新增对象、闭包、Promise、controller 或数组。每个 OAuth owner 新增一个 controller；每次刷新新增一个组合 wait signal 及最多两个源 signal 的数组，交换开始前移除取消监听；每个关闭 owner 最多一个共享 deferred，最后事务 finally 清除引用。closeRuntime 原有临时 closes 数组按配置最多 16 个 server、每 server 最多 connect/drain 两项，调用结束即释放。没有生产操作队列、Promise tail 或对象池，未修改 delta/progress/frame 路径。

边界：原 180 秒事务 deadline 和每请求 15 秒 timeout 保持不变；关闭不提前放弃原子写与解锁。不响应 signal 的第三方响应可迟到，但 deadline 后不能再写凭据。测试使用虚构凭据、受控网络响应与真实本地文件锁，未使用真实外部 OAuth 账号，也未安装全局 CLI；本地未执行 Linux 验证。SDK 取消连接时可能额外发送 notifications/cancelled，测试区分该既有行为和错误重试。

证据在 `.git/t02-4-4-mcp-refresh-shutdown-20261009/`：实施前设计、三项基线失败、定向/完整验证、汇总、前后精确计数/分配采样/GC、源码哈希、PR #84 合并和 PR #85 状态快照。最初一个连接失败夹具在 connect 入口前已经 abort，只验证到入场拒绝；已调整为进入连接后取消，再录制三项基线失败。GC 子进程要求实际完成标记，避免继承测试上下文而未执行。测试创建的隔离 auth 目录、锁、子进程按已记录实例释放。既有任务计划和 README 索引继续保留为本地修改，不混入实现提交。待本项最终审查通过并经用户授权合并后，下一优先阶段为 T10 的 MCP 完整分页目录。

## 17. T10 实施与交付记录（2026-10-09）

问题类别：MCP 完整目录发现与缓存。T10.1 的分页、T10.2 的游标解码和 T10.3 的容量/元数据/旧缓存边界是同一问题的交付条件，一起构成独立 PR。基于 PR #85 合并提交 `a230d1d544d66d777474c3bf2681bf8544053b68`，新建分支 `codex/t10-mcp-paginated-catalog`，提交 `6f225abd6d22874c1027fe69c8300f98ae53843d`，独立 [PR #86](https://github.com/dragonbaba/super-pi/pull/86)。创建后立即尝试发布 `@codex review`，GraphQL 连接 EOF 且查询确认没有写入评论后，通过 REST 补发成功：[审查请求](https://github.com/dragonbaba/super-pi/pull/86#issuecomment-6082035281)。该提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37938072021)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/86#issuecomment-6082105224)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 22:52:29（Asia/Tokyo）以 squash 合并，合并提交 `0537797d8fab01b9f433f59d86b18b524791864c`，T10 已关闭。

根因与实现：本地 connectState 只调用一次 SDK listTools；SDK 1.32.1 每次单页调用还会清空输出校验及 task metadata，直接循环会丢失前页校验。原基线三项用例分别因漏页、null schema 拒绝、第二页失败却提前发布而失败。新增 discovery-only listAllTools 复用 SDK request/transport，只扩展 tools/list 的结束游标 schema；逐页追加引用、验证输入/输出 schema，完整后只调用一次 SDK cacheToolMetadata。全部页共用启动时限；SDK request 保留 signal listener，故一个父级 forwarder 只指向当前页 controller，完成的页不会累积父监听器或收到后续取消。完整目录先做规范化名称碰撞预检，再登记及写缓存。v3 envelope/HMAC domain 在既有安全缓存路径失效 v2 数据；失败保留上次完整磁盘缓存并允许重试。关闭 runtime 释放自身 tools/serverInfo 引用。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1 / SDK 1.32.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 新增回归 | 36 项；首末页 absent/空/null、非法/超长/循环游标、128 页、累计工具/字节及单 schema 深度/字节、跨页名称、首末页输出校验/task 约束、共享总时限、取消/关闭、v2 失效、完整缓存懒恢复、计数/GC/AST |
| 定向测试 | pagination、schema cache、background activation、SDK client boundary、OAuth、refresh shutdown、source-invariants：347 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | 240 个执行单元全部成功；3860 项，3768 通过、92 跳过、0 失败/取消 |
| 精确累计计数 | 128 个工具分成 1/8/128 页，均只编译一次 metadata、序列化工具 128 次、schema 256 次；增长前缀序列化为 0，父 signal 监听器峰值为 1 |
| 请求分配 | 实际 SDK Client/Server/InMemoryTransport 夹具分别为 21/154/2434 个 Promise，按页线性增长；controller 3/17/257，包含每页客户端与服务端各一个、runtime 一个，不是流式 progress 计数 |
| 既有热路径 | 100000 次真实 SDK progress 交付仍为 0 个 Promise，未修改 delta/progress/frame 路径 |
| 受控 GC | 保持关闭后的 runtime 可达；成功 410、分页失败 41、取消 41 个 client/page/tool/schema/signal WeakRef 均释放，retained=0；普通测试有界子进程执行 counts/gc |
| 采样 | 20 个目录，每目录 8 页/128 工具；peak heap 47245680 B，final heap 25355952 B；p50 39.9409 ms、p95 56.9333 ms，最大采样站点为既有 AJV compileSchema（263792 B）；不宣称性能提升 |

性能调用链覆盖 index 的 startup/cache/search/activation → runtime 启动截止时间 → SDK protocol/transport → 分页解码/收集 → schema admission → SDK metadata → 宿主登记/cache put → 缓存恢复后的真实调用和输出校验。计数和采样针对实际 SDK 发现/校验/关闭路径，不能替代磁盘 I/O 或 TUI 基准；生产 runtime/cache/restore 由集成用例覆盖。输入 schema normalization 从登记移到收集，实时登记不重复复制；缓存加载仍走既有验证。登记自身原有的 JSON hash/大小计算、描述净化、工具闭包，以及缓存的有界 normalization/serialization/eviction 仍存在，未包装为零分配结论。

容量与生命周期：每目录工具引用数组最多 128，游标 Set 最多 128×4096 字符，名称预检 Set 最多 128。另有一个受 transport/schema 限制的当前页对象。每次发现新增一个 abort forwarder、每页一个 active controller 和 request/options 包装；逐工具循环无 Promise/controller/闭包或前缀复制。validateJsonShape/canonicalJsonShape 仍复制已限制的图，输出 schema 新增同样的容量门禁。失败清空临时工具数组，finally 清空游标、移除父监听器和 activeRequest 引用；正常完成只让完整工具集进入明确的 state/host/SDK/cache owner。关闭 runtime 清理其目录；仍存活的宿主 registry 或磁盘缓存 owner 合理保留自身数据。未引入对象池、另一套 transport 或无界队列。

原始证据在 `.git/t10-mcp-paginated-catalog-20261009/`：设计、完整性能调用链审计、基线失败、定向/完整结果、计数/分配/GC、源码哈希、PR #85 合并与新 PR 快照。首轮 AST 将错误分支的 Error 构造也当作正常分配，已精确豁免 throw Error；首轮 GC 的一个 signal 由测试局部 no-op host 方法闭包保留，改用模块级 no-op 后原有断言通过，无需改变生产逻辑。测试缓存、临时目录、transport 和子进程按已记录实例清理。既有任务文档与 README 索引继续保留为本地修改，未混入实现提交。未连接真实外部 MCP 服务、安装全局 CLI 或在本地执行 Linux 验证；下一优先阶段为 T03 默认 worker 工具能力。

## 18. T03 实施与交付记录（2026-10-09）

问题类别：默认 worker 实施职责与实际工具集合不一致。基于 PR #86 合并提交 `0537797d8fab01b9f433f59d86b18b524791864c`，新建分支 `codex/t03-worker-tool-capabilities`，提交 `684195fb8d581866f83d8e193658593ba57e9146`，独立 [PR #87](https://github.com/dragonbaba/super-pi/pull/87)。创建后立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/87#issuecomment-6082440431)。该提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37940959872)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/87#issuecomment-6082484453)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-09 23:17:12（Asia/Tokyo）以 squash 合并，合并提交 `2240b5131d051375a5a5f5d6d3a843c6d79e48ed`，T03 已关闭。

根因与实现：默认 `.sp/agents/worker.md` 未声明 tools，parseAgentDefinition 返回 undefined，effectiveTools 因而回退到 read/grep/find/ls，即使 allowMutation=true 也不能编辑。现显式声明 read/grep/find/ls/write/edit。保留原来源、授权与只读过滤，其他角色及 shell 权限不变。父代理派发指导要求说明 child 是否能执行验证命令；默认 worker 没有 shell，由父代理负责命令验证，worker 提交具体命令并明确标为未执行。原任务范围、停止条件、长任务预拆分、checkpoint 与无 token/回合配额规则保留。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 基线复现 | 实际仓库角色经 user/project 发现和真实离线子进程启动，两条可写路径因缺少 write/edit 失败，两条只读路径通过 |
| 新增回归 | 四种来源/授权组合均通过；可写最终 6 个工具、只读 4 个工具，SP_SUBAGENT_ALLOW_BASH 均为 0；父/子验证职责文字已断言 |
| 定向验证 | subagent-management + subagent-hot-paths：33 项，32 通过、1 项 POSIX 专用检查在 Windows 跳过、0 失败 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：240 个执行单元全部成功；3864 项，3772 通过、92 跳过、0 失败/取消 |

性能与生命周期：阅读性能契约后，将生产改动限定为角色元数据与静态提示。核查链路为角色发现/解析 → effectiveTools 来源与 allowMutation 过滤 → runSingleAgent 的 --tools/环境和临时 prompt → 既有子进程生命周期及 finally 清理。未更改事件/进度/渲染或其他热路径，没有新增生产状态、缓存、队列、Promise、controller、计时器或对象池。沿用最多 32 个工具标识的解析上限，本角色最多 6 个（只读 4 个），由 discovery/launch 的既有 owner 持有；无新增释放边界。本次没有相关热路径变更，不把 allocation/GC 基准写成新增通过证据；既有 AST/source 不变量已运行且通过。

验证边界：测试以实际仓库角色替代原合成 writer，运行真实发现、授权过滤和子进程启动，读取最终 argv 与环境；离线 fixture 不执行模型或 write/edit 工具，因此不宣称真实模型实施验收。本地未执行 Linux、连接真实模型或安装全局 CLI。夹具使用既有隔离目录、session_shutdown 与 test.after，子进程及临时资源按已记录实例清理。

证据在 `.git/t03-worker-tool-capabilities-20261009/`：实施前设计、两项基线失败、定向检查、类型/构建/完整日志及汇总、源码哈希、PR #86 合并和 PR #87 状态快照。提交仅包含角色定义、静态派发指导及相关测试/夹具四个文件；既有任务计划和 README 索引保留为本地修改。待本项最终 CI/审查通过并经授权合并后，下一阶段为 T04.1 的 provider 瞬态错误恢复。

## 19. T04.1 实施与交付记录（2026-10-09）

问题类别：Provider 瞬态错误分类与自动恢复。基于 PR #87 合并提交 `2240b5131d051375a5a5f5d6d3a843c6d79e48ed`，新建分支 `codex/t04-1-provider-transient-retry`，最终审查提交 `40a9bf8d852b175ba19147b00c82d07dce0d355a`，独立 [PR #88](https://github.com/dragonbaba/super-pi/pull/88)。创建后立即发布 [`@codex review` 评论](https://github.com/dragonbaba/super-pi/pull/88#issuecomment-6082931720)。该提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37944409454)全部通过；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/88#issuecomment-6082967068)未发现主要问题，未解决讨论为 0。经用户授权，2026-10-10 02:19:35（Asia/Tokyo）以 squash 合并，合并提交 `7c7a72a993906a6ad95f3460e62e3effe874e6a1`，T04.1 已关闭。

根因与实现：共享分类器缺少 server_busy、servers are currently busy、pending stream has been canceled 三个模式，原 Mistral error finish reason 也只输出不可重试的泛化描述。生产变更仅增加三个模块级模式，并将该终止描述改为 `Provider stopped with: error (server error)`。保留原始 rawStopReason、caller abort、额度/账单终止规则、未知 finish reason、次数和退避策略。没有改动请求 timeout、正常 delta、工具执行和会话历史策略。上游依据为 T04 已列出的 8b5708dbb1、5b6c792b42、7fb59f995b 三个提交，本地实际行为决定验收。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 基线 | 27 项中 11 项失败：5 条分类/恢复样例、1 条有界退避、1 条真实 Mistral SSE error、4 条真实 AgentSession 恢复；16 项负例/既有行为通过 |
| 新增回归 | 17 项；格式化错误、终止限制、取消、禁用/零预算、1/2ms 指数退避、原始 stop reason、reader/监听器释放、实际会话恢复与副作用 |
| 真实会话 | 四种失败均为工具成功 → provider 失败 → assistant 恢复；请求 3 次、工具副作用 1 次；失败响应中的工具不执行，恢复载荷保留完成证据，失败记录保留于 history |
| 定向检查 | retry、Mistral、stream hot paths、source invariants、length recovery、effective dispatch：86 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：241 个执行单元全部成功；3881 项，3789 通过、92 跳过、0 失败/取消 |
| 精确计数 | 基线/候选各 256-delta 成功、错误流均为 2096 个既有 Promise；取消流均为 35 个，每流 terminal event=1；分类器 100000 次调用均为 0 个 Promise |
| 释放证据 | reader lock=false、abort listener=0；保持 6 个 caller controller 可达，成功/错误/取消的 24 个 stream/output/body/signal WeakRef 全释放，retained=0 |

性能调用链：stream/streamSimple → requestMistralStream → readMistralEvents 的 reader/decoder/有界 buffer → consumeChatStream → 终止 mapChatStopReason → formatMistralError/error event → AssistantMessageEventStream → agent-loop streamAssistantResponse（错误在 executeToolCalls 之前返回）→ AgentSession _isRetryableError/_prepareRetry → 有界可取消退避/continuation；摘要路径通过 retryAssistantCall 使用相同分类器。原失败后的 tool partialArgs、reader、监听器和 retry controller 继续按原 finally 释放。

分配与容量：正常流 AST token 除终止字符串外与基线一致；regex 在模块初始化时编译，没有新的高频函数、状态、缓存、队列、Promise、controller、计时器或对象池。沿用原终止 wrapper/Error/event、重试 sleep/controller 及 SSE 1MiB、错误正文 16KiB/4000 字符界限。计数探针对基线和候选使用相同 TypeScript 转译配置及本地依赖，测量真实模块配合离线 fetch 的 transport/iterator 整体，不能据此宣称每 delta 零 Promise、真实网络或端到端 TUI 零分配，也不宣称耗时提升。

探针边界与修正：首版使用裸 scanner，未处理模板字面量重扫描，误将新增注释视作流逻辑变化，已改为解析 AST 的叶节点 token 比较。受控 GC 初版使用默认 DOMException abort reason，在基线和候选各保留取消夹具的四个引用；改用 primitive reason 隔离测试自身异常堆栈对 fetch 闭包的持有，全部引用释放。默认 abort reason 仍由独立行为测试覆盖。首轮候选会话断言误把 Mistral 工具内容数组当字符串，修正为 text block 断言后完整会话通过；构建后的实际 session 也验证共享分类器生效。

证据在 `.git/t04-1-provider-transient-retry-20261009/`：实施前设计、基线失败、定向/类型/构建/完整日志与汇总、基线源文件、可重跑 performance.mjs、精确计数/GC、源码哈希、PR #87 合并与 PR #88 状态。夹具使用隔离目录和离线 Response，按已记录实例释放 session/reader/临时目录；未使用真实模型账号、消耗模型额度、安装全局 CLI 或在本地执行 Linux。最初 origin 的 SSH fetch 被网络关闭，改用同仓库 HTTPS 完成拉取，未修改持久 remote 配置。

本次仅提交两个生产文件和两个回归文件；既有本地任务计划与 README 索引保留。已通过最终 CI/审查并经授权合并，按 §3 的已复现问题优先顺序，继续 T04.5/T05.3 的 Haiku 5.5 能力与目录匹配；T04.2 的 Mistral timeout 留待独立 PR。

## 20. T04.5 / T05.3 Haiku 部分实施与交付记录（2026-10-10）

问题类别：Haiku 5.5 的模型目录与供应商能力匹配。基于 PR #88 合并提交 `7c7a72a993906a6ad95f3460e62e3effe874e6a1`，新建分支 `codex/t04-5-haiku-55-capabilities`，初始提交 `2e822df97f7867a61b2dd81e4daac2efb406b0b3`，独立 [PR #89](https://github.com/dragonbaba/super-pi/pull/89)。两轮审查反馈在 §20.1–20.2 修复，最终提交 `340c59166be0259b345296d0cbb7272fc1223e65` 的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37972050493)全部通过；[最终 Codex 审查](https://github.com/dragonbaba/super-pi/pull/89#issuecomment-6086733806)未发现主要问题，五条已修复讨论均已关闭。经用户授权，2026-10-10 04:44:14（Asia/Tokyo）以 squash 合并，合并提交 `2324ae3437fbf9bf3bbfb9b85a7d0b7df40e973b`，T04.5 及 T05.3 的 Haiku 部分已关闭。

实现：增加幂等 Anthropic fallback（1M context / 128K output），采用官方 100k 输入以上阶梯价格，同时覆盖生成器元数据和运行时目录 profiler。Bedrock 普通/区域 ID、点号变体及仅名称可识别的 application inference profile 均可获得 adaptive、xhigh/max；发送 prompt cache、Haiku binding beta/drop_block，并默认省略不支持的 temperature。GovCloud 省略 display 与 binding。显式 compat、thinkingLevelMap、capabilities 保持优先，effort 映射优先于 native-xhigh 推断，Bedrock strict-tool 默认仍为 false。原有 13 条 Anthropic 记录和其他 provider 数据分片均保持不变。

依据：[上游 Haiku 提交](https://github.com/earendil-works/pi/commit/f76c1db66271570d763d1c17b6a467f20a58d7b8)、[上游 binding 提交](https://github.com/earendil-works/pi/commit/69f0be6f0a)、[官方模型说明](https://platform.claude.com/docs/en/models/haiku-5-5/overview)、[迁移说明](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide)。仅补齐已核实的 Anthropic 内置价格，没有推定或新增 Bedrock 价格记录。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；最终提交的 Node 22.19 Linux/Windows CI 六个分片全部通过 |
| 修复前 | 7 项回归中 6 项失败；旧模型对照通过，缺口为目录缺失和 budget/adaptive 请求不匹配 |
| 新增回归 | 13 项；离线目录/重复 fallback、普通/点号/name-only ID、GovCloud、xhigh/max、缓存关闭、旧模型、显式能力/兼容覆盖、远程同 ID 替换、当前/旧版缓存恢复、100k 含 cache 输入阈值两侧计价 |
| 定向检查 | Haiku、catalog profile、capability matrix、成本和 source-invariants：51 通过，0 失败/跳过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：242 个执行单元全部成功；3894 项，3802 通过、92 跳过、0 失败/取消 |
| 匹配分配 | 实际新模块源码 AST 插桩，30000 次匹配中 20000 命中；应用级对象/数组/闭包/构造调用/运行时 regexp 创建均为 0 |
| 目录分配 | 10000 次 Haiku profiler，30000 个自有对象（model/map/compat 每模型 3 个）；数组/闭包/构造调用为 0 |
| 受控 GC | 三轮各 100 个模型，每轮 600 个 input/enriched/runtime/compat/map/capability WeakRef 全部释放，retained=0 |
| 相邻目录基准 | merge 4000+4000 → 6000，索引版 median 0.186ms / p95 0.299ms；既有 restore 20 轮维持 13 个 profile / 1 个恢复，p95 0.062ms，仅作为回归观察 |

性能设计与完整调用链已在实现前记录：catalog generation/ingress → provider profile → withModelProfile → static/fetch/raw-store restore → streamSimple/clamp → request builder/conversion → SDK send → delta handlers → event stream/result release。修改在目录加载和请求准备阶段；Bedrock 四个 start/delta/stop/metadata 函数与基线逐字一致。匹配器使用模块级非 global 正则，避免 candidate 数组和 lowercase/replace 字符串；新增对象仅随目录模型持有，无新全局缓存、对象池、计时器或 Promise owner。计数覆盖 JavaScript 应用分配，不代表 V8 正则内部实现零分配；不据此宣称整个网络/流处理零分配或耗时提升。

验证修正：首版覆盖夹具给 none capability 携带多余字段，与严格 schema 不符，已改为有效 manifest 并断言无重建诊断；测试中 off 请求以 API 约定的 undefined 表达；泛型 compat 使用与 API 判定对应的类型标注。首版性能转译探针缺失 CommonJS exports 容器，已补齐探针环境。修正后上述检查及完整套件通过。

证据保存在 `.git/t04-5-haiku-55-capabilities-20261010/`，包含实施前设计、基线/候选日志、完整汇总、可重跑分配/GC 探针、定向目录生成与结构差异验证、基准和 PR 状态。测试使用本地 loopback catalog 和 SDK onPayload 截获，不发送真实模型请求；夹具服务器和临时资源均按实例释放。本 PR 仅提交 11 个实现/数据/测试文件，既有 README 与本地任务计划保留在工作区。

独立剩余范围：T04.4 的其他 Claude binding 和 OpenAI effort、Anthropic 更广泛的 binding 控制、F03 的中途消息/effort 特性，以及 T05.3 其他供应商记录不在本 PR 内。已完成最终 CI/审查并经授权合并，下一阶段继续 T04.2 的 Mistral timeout。

### 20.1 PR #89 审查反馈修复（2026-10-10）

用户要求修复已有反馈，本次继续同一 Haiku PR。修复提交 `2e382ba27cc0cdccc22c52ac8e8aa16732fade4e` 已推送；更新 PR 描述后再次发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/89#issuecomment-6086349367)。[该提交 CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37969630363)已全部通过；[Codex 复审](https://github.com/dragonbaba/super-pi/pull/89#issuecomment-6086000034)补充了一条共享 profile 区域反馈，继续在 §20.2 修复。

| 反馈 | 修复与回归 |
| --- | --- |
| [P1 off 被降为 low](https://github.com/dragonbaba/super-pi/pull/89#discussion_r4232896715) | 移除默认 `off:null`；Anthropic 原 serializer 按支持的 off 发送 disabled，Bedrock 补齐显式 disabled。Simple API 省略 reasoning 与 JS 显式 off、Bedrock 直接 API 两种入口均覆盖；显式 off:null 保持优先。依据[官方 thinking 文档](https://platform.claude.com/docs/en/build-with-claude/thinking)，纠正上游该条元数据。 |
| [P2 生成器覆盖权威目录设置](https://github.com/dragonbaba/super-pi/pull/89#discussion_r4232896725) | Anthropic/Bedrock 生成分支复用运行时 profiler，其他 API 按默认在前/显式值在后合并；执行实际生成器 Haiku AST 分支验证 off/minimal/xhigh/max、compat、幂等性，避免仅测试 fallback helper。 |
| [P2 GovCloud 端点识别](https://github.com/dragonbaba/super-pi/pull/89#discussion_r4232896732) | 将 SDK 配置最终选定的 region 字符串传入请求字段生成，复用 ARN / 显式配置 / 选中端点优先级；覆盖标准/FIPS GovCloud 端点、区域覆盖、ARN 优先，不增加重复 URL 解析。 |
| [P2 签名空文本回放](https://github.com/dragonbaba/super-pi/pull/89#discussion_r4232896749) | 完整调用链发现能力声明也会提前丢弃签名；provider enrichment 为 Haiku 启用 thoughtSignatureRoundTrip，并修复 Bedrock convertMessages 保留签名及原始空白文本。真实 adapter 测试签名分片 → tool call → tool result → 下一请求，覆盖 unsigned/cross-model/显式禁用；当前和旧缓存恢复验证签名能力。 |

新增 14 项回归；修复前首批 12 项中 11 项失败，显式禁止 off 的负例通过。最终定向 65 项全通过；类型检查、离线构建、完整 `npm test` 全通过：243 个执行单元，3908 项测试，3816 通过、92 跳过、0 失败/取消。初次缓存测试加载了未重建的 dist capability 模块，完成离线构建后以实际生产导出重新验证通过。

性能：四个 Bedrock stream handler 与 main 仍逐字一致；新增 signature enrichment 是目录阶段的 primitive 字段，无新 delta 分配或持有者。重复执行原匹配/目录精确计数和 GC，结果保持：30000 匹配应用级分配为 0、每个匹配 profiler 3 个自有对象、三轮各 600 引用释放。新增实际 adapter AST 请求转换探针：1000 请求共回放 100000 个 signature-only 块，301000 个 adapter 对象（每块 3 个 wire 对象 + 每请求 1 个 assistant envelope）、2000 个请求数组，闭包/构造调用为 0。10000 次 off 字段生成仅 20000 个请求自有对象。未改变的 imported transform/sanitize 与 V8 内部分配不在这些局部计数内，不宣称全链路零分配。真实 adapter 成功/失败/取消三条生命周期路径各 8 个 history/payload/stream/result WeakRef 全释放，模型仍可达。

证据：`.git/t04-5-haiku-55-review-20261010/` 保存四条反馈、实施前设计、失败/通过日志、完整汇总、可重跑转换与 GC 探针、结构差异验证和新 PR 快照。全部验证使用离线 payload 和 SDK fixture；未调用真实模型。提交仅包含对应实现/数据/测试，README 原有修改保持原 SHA256，任务计划继续留在本地。

### 20.2 PR #89 共享 profile 区域反馈修复（2026-10-10）

最新 [P2 反馈](https://github.com/dragonbaba/super-pi/pull/89#discussion_r4233095118)指出：共享 AWS profile 的区域由 SDK 延迟解析，读取构造配置的 `config.region` 会漏掉 GovCloud。继续同一问题类别和 PR，修复提交 `340c59166be0259b345296d0cbb7272fc1223e65` 已推送，更新 PR 描述后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/89#issuecomment-6086676926)。该提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37972050493)全部通过，[Codex 复审](https://github.com/dragonbaba/super-pi/pull/89#issuecomment-6086733806)未发现主要问题；已关闭已修复讨论并经用户授权合并，合并记录见本节开头。

根因与修复：先前将构造输入等同于最终区域，既漏掉共享文件解析，也漏掉 SDK 对 FIPS 区域别名的规范化；仅检查环境级 profile 的逻辑还会让显式 `options.profile` 和作用域 `AWS_PROFILE` 被目录默认端点覆盖。现在统一按选中的 `config.profile` 决定目录端点和默认区域是否参与，在请求字段构建前等待 SDK 的 `client.config.region()`，保留 ARN / 显式区域 / 环境区域优先级及自定义端点。构造 client 前和区域解析后检查取消；已取消请求不读取 profile，读取期间取消不会继续调用载荷 hook 或发送请求。未增加自己的配置解析器或缓存。

| 验证 | 本次结果 |
| --- | --- |
| 基线复现 | 隔离的真实 AWS 配置文件 + SDK 区域解析器；14 项中 10 项失败，4 项区域优先级对照通过 |
| 新增回归 | 15 项；环境/作用域/显式 profile、冲突覆盖、ARN/区域覆盖、FIPS、缺失区域、读取期间/预先取消、2000-delta 缓存和解析边界 |
| 定向检查 | Haiku、profile、capability matrix、成本及 AST/source invariants 共 80 项全通过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：244 个执行单元全部成功；3922 项测试，3830 通过、92 跳过、0 失败/取消 |
| 请求与流边界 | 仅请求准备阶段新增一次 SDK provider 调用/await；2000 个 delta 中区域解析调用 0，配置文件读取共 1 次 |
| 受控 GC | 真实共享 profile 的成功/载荷错误/区域缺失/读取期间取消/预先取消五条路径共 48 个 WeakRef 全释放，模型仍可达 |

性能审计覆盖 streamSimple → request-start → SDK client / region provider / shared-file memoizer → 请求转换与字段 → hook/send → 原有 delta handler → event/result 释放。四个 Bedrock start/delta/stop/metadata 函数仍与 main 逐字一致。AST 结构差异仅增加一个 await 和 provider 调用点，object/array/closure/new-expression 增量均为 0；这是应用源码计数，不宣称 SDK Promise 或 I/O 零分配。没有新对象池、全局缓存、计时器或 controller。原匹配/目录/转换精确计数、三轮各 600 个目录引用释放、成功/错误/取消各 8 个回放引用释放均重复验证通过。

新增生命周期探针中，配置读取/载荷 hook/send 数分别为成功 1/1/1、载荷错误 1/1/0、缺失区域 1/0/0、读取期间取消 1/0/0、预先取消 0/0/0；所有历史、options/controller/signal、载荷及已创建的 client/command/stream/result 观察引用均释放。首版取消检查位于构造后，探针发现 SDK 构造器已发起配置读取，遂移到构造前。长流测试最初误把已清为 undefined 的 scratch index 当作不存在，已改为断言公开文本字段，未改变生产稳定对象形状。

证据位于 `.git/t04-5-haiku-55-profile-region-20261010/`，含实施前台账、反馈、基线、定向/完整日志、汇总、可重跑 AST/共享配置生命周期探针及 PR 快照。测试只读取隔离配置、mock 网络发送；未读取真实 AWS 凭据或调用真实模型。临时目录按已记录路径清理、环境和 mock 已恢复。首次 HTTPS 推送挂在本次启动的 Git Credential Manager，按记录的进程身份清理后，以命令级 GitHub CLI credential helper 成功推送；没有改动持久认证配置。提交仅含一个生产文件及一个测试文件，README 哈希保持不变，任务计划继续留在本地。

## 21. T04.2 实施与交付记录（2026-10-10）

问题类别：Mistral 响应头超时与响应体生命周期分离。基于 PR #89 合并提交 `2324ae3437fbf9bf3bbfb9b85a7d0b7df40e973b`，新建分支 `codex/t04-2-mistral-header-timeout`，提交 `d9219636e32c9fa5486eebe7e5e72568d048c28c`，独立 [PR #90](https://github.com/dragonbaba/super-pi/pull/90)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/90#issuecomment-6088224482)，并附加到当前任务。最终提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37983545019)全部通过，[Codex 审查](https://github.com/dragonbaba/super-pi/pull/90#issuecomment-6088269215)未发现主要问题，无未解决讨论。经用户授权，2026-10-10 05:10:37（Asia/Tokyo）以 squash 合并，合并提交 `799b5e148b2204354fb113f74133a9e6ce51ca6c`，T04.2 已关闭。

根因与实现：原 requestMistralStream 将默认 60000ms 的 AbortSignal.timeout 同时用于 fetch 和 SSE reader，收到响应头后仍可能取消正常长流。按[上游 6b07b4e572](https://github.com/earendil-works/pi/commit/6b07b4e57269ebc4b3fe2b7cd3caba2d95e26cc0)的边界，改为请求自有 controller 与可清除计时器，fetch 成功或失败的 finally 立即清除。计时回调为模块级函数，仍保留 caller signal 对 fetch、onResponse 后续阶段、HTTP 错误体和 SSE 的控制；不照搬同时断开 caller 的方案。响应头超时保留明确时长，预先取消不发请求；迟到响应或 onResponse 异常时取消尚未移交给 iterator 的 body。默认值、有效 timeout 范围、unref 行为、错误体/事件容量和重试规则保持。响应体空闲超时继续由所选 HTTP transport 负责，不新增每片段或整段生成计时器。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；最终提交 Linux/Windows CI 六个分片全部通过 |
| 基线复现 | 初始 17 项中 16 项失败；非法 timeout 的对照通过；用可控时钟验证，不等待真实 60 秒 |
| 新增回归 | 18 项；长 thinking/text、静默响应体、延迟/异常 hook、默认/自定义头部超时、请求前/头部/成功体/错误体取消、网络/HTTP/SSE/idle 错误、无 body、迟到响应及参数边界 |
| 真实传输 | 本地 HTTP + 原生 fetch：超过 1 秒头部 deadline 后仍完整交付；下一请求取消后服务端观察到连接关闭，测试所属 server/连接全部清理 |
| 定向检查 | transport、retry、能力矩阵、工具参数 ownership、dispatch、stream/source invariants 共 88 项全通过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：245 个执行单元全部成功；3940 项，3848 通过、92 跳过、0 失败/取消 |
| 分配计数 | 成功/错误流的 256 delta 在基线/候选均为 2094 个既有 Promise、1 个 timer；adapter literal 533 个对象、4 个数组、6 个闭包，增量增长一致 |
| 释放证据 | timer 峰值 1，fetch 结束后存活 0；reader lock=false、abort listeners=0；四个 caller controller 保持可达时，成功/hook 错误/取消/头部超时共 36 个 WeakRef 全释放 |

完整性能调用链：streamSimple → stream payload 转换 → requestMistralStream / header timer / fetch → onResponse / bounded error body 或 readMistralEvents → reader / decoder / bounded buffer / parser → consumeChatStream 的 text/thinking/tool delta → AssistantMessageEventStream → 既有 agent/session 交付 → done/error/abort / reader cancel / releaseLock。两个公开 stream 函数及 35 个既有 helper（除 request setup 外）与基线逐字一致。正常成功流每请求显式增加一个 controller 构造调用，替代原 native timeout signal；计时器仍为一个且可立即清除。requestMistralStream 请求准备/致命清理和模块级 abortMistralHeaderRequest 是精确的生命周期边界，没有新的 per-delta 闭包、Promise、数组、wrapper、controller、计时器、缓存或对象池。fetch 返回时已取消的路径提前结束，fixture Promise 从 33 降至 21，不将其描述为正常流提速。

计数边界：async_hooks 统计离线 transport/iterator 的 Promise/Timeout；AST 插桩统计本 adapter literal/closure/new，未包含 imported helper 或 V8 内部分配。不能据此宣称全链路零分配。GC 观察 context/messages/message/payload/options/event/result/body/composed signal；四条路径各 9 个引用释放。已有 1MiB chunk/event 和 16KiB/4000 字符错误体限制未改动。

证据在 `.git/t04-2-mistral-header-timeout-20261010/`：实施前设计、上游 commit 依据、基线/定向/完整日志与汇总、baseline source、可重跑 AST/分配/GC 探针、源码哈希与 PR 状态。没有真实模型请求、外部账号凭据、全局 CLI 安装或本地 Linux 验证；提交仅含一个生产文件及一个测试文件，既有 README 保持原哈希，任务计划继续留在本地。当前 PR 已通过最终 CI/审查并经授权合并，继续 T04.3 的 Codex 请求头覆盖规则。

## 22. T04.3 实施与交付记录（2026-10-10）

问题类别：Codex 客户端请求头覆盖规则。基于 PR #90 合并提交 `799b5e148b2204354fb113f74133a9e6ce51ca6c`，新建分支 `codex/t04-3-codex-header-overrides`，提交 `7619a72f69f5994fe4a2a520993e579dd4da3700`，独立 [PR #91](https://github.com/dragonbaba/super-pi/pull/91)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/91#issuecomment-6088631629)，并附加到当前任务。最终提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37986582937)全部通过，[Codex 审查](https://github.com/dragonbaba/super-pi/pull/91#issuecomment-6088667379)未发现主要问题，无未解决讨论。经用户授权，2026-10-10 05:38:09（Asia/Tokyo）以 squash 合并，合并提交 `57fb42784ad84baa0af99a24cf17b39f9c60e84a`，T04.3 已关闭。

根因与实现：buildBaseCodexHeaders 原先在合并模型/调用方请求头后强制写入 originator 和 User-Agent，使配置值、null 删除及空字符串失效。按[上游 0cf65d2bf7](https://github.com/earendil-works/pi/commit/0cf65d2bf7cad7a58437a6c8a9172f29dbc43ea7)，保留现有 Headers(model.headers)，先补缺失默认值，再处理调用方覆盖/删除，最后固定 Authorization 与 chatgpt-account-id。Headers.has 的大小写无关语义保留空值；Super Pi 默认 UA 与浏览器回退保持。本地方案避免新增模型 headers 的对象和 entries 遍历。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；最终提交 Linux/Windows CI 六个分片全部通过 |
| 基线复现 | 最终同组 24 项中 18 项失败，6 项默认值/认证保护对照通过；loader 载入实际 base 源码，不回退工作区 |
| 新增回归 | 24 项全部通过；SSE/WebSocket × 默认/模型/调用方/大小写/null/空值/认证，冻结输入，回退、连接复用/变更重连、原生压缩一致性及变更前置拒绝 |
| 定向检查 | transport/dispatch/native compaction/auth diagnostics/source invariants/stream 共 119 项全部通过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：246 个执行单元全部成功；3964 项，3872 通过、92 跳过、0 失败/取消 |
| 精确计数 | 四组各 10000 次请求对（SSE+WS），每组各 20000 Headers、20000 既有 entries 结果数组；无 caller 时 20000 fallback 对象，有两个 caller 字段时 40000 entry pairs；基线/候选计数一致，builder 闭包/Promise/controller 均为 0 |
| 默认 UA 开销 | 模型提供 UA 时每组省去 20000 次默认 UA 模板计算及 60000 次 OS accessor 调用；默认/caller-only 情形保持基线 |
| 生命周期 | 真实 provider SSE/WS 的成功、错误、取消及所属 session 清理共 45 个 WeakRef 全释放，六个 caller controller 保持可达；默认 abort 错误的 lazy stack 条件见下文 |

实现前审计完整链：streamSimple/stream → SSE/WS header builders → buildBaseCodexHeaders → fetch 或 acquire/connectWebSocket → processStream/processWebSocketStream → recordSuccessfulDispatch；压缩路径共享 builders → compareCompactionToSuccessfulDispatch → SSE 或既有 WebSocket。仅请求准备函数改变，其他 89 个顶层函数及 stream 入口与基线逐字一致。socket header fingerprint 已覆盖客户端头变化，compaction header hash 已包含 originator/UA，均无需增加缓存或字段。新增 per-delta 分配为 0，没有新对象池、wrapper、Promise、controller、timer、listener 或持有者；现有 request Headers 与 session 生命周期保持。

计数范围为提取的实际生产 header builders 的 AST literal/closure/template/new 及 Object.entries 结果；不包含 Headers/V8 内部和未改变的完整流处理分配，不宣称全链路零分配或耗时提升。浏览器 VM 另外验证 `_os=null` 时的默认/模型覆盖/null 删除。

验证修正与边界：首版测试 session 名称超过缓存 key 长度限制，已改成短稳定 ID 并按确切 identity 清理；WebSocket 压缩使用实际支持 continuation 的 websocket-cached 和真实 assistant 回放转换。关闭验证检查全部自有 socket 已关闭、listener 为空，避免误将既有幂等 close 调用次数当作资源数量。受控 GC 使用 primitive abort reason 时直接释放 45 个引用；Node 默认 DOMException 的 lazy stack 通过仍可达的 caller signal.reason 保留六个同步 fixture-frame 引用，基线/候选表现完全相同，读取 reason.stack 后均释放全部 45 个引用。原始诊断及双版本验证均保留，不将其描述为本次新增或修复的泄漏。

证据在 `.git/t04-3-codex-header-overrides-20261010/`：实施前设计、基线 loader/失败日志、定向/完整日志与汇总、可重跑 AST 分配/GC/browser 探针和 PR 快照。全部请求为离线合成数据；全局 WebSocket 已恢复，自有 session/timer/continuation 按实例清理。仅提交一个生产文件及一个回归测试，README 保持原 SHA256，任务计划留在本地。T04.3 已完成最终 CI/审查并经授权合并，继续 T04.4；Bedrock OpenAI effort 与其他 Claude binding 按独立问题类别分别交付。

## 23. T04.4 Bedrock OpenAI effort 部分实施与交付记录（2026-10-10）

问题类别：Bedrock Converse 未发送 OpenAI reasoning effort。基于 PR #91 合并提交 `57fb42784ad84baa0af99a24cf17b39f9c60e84a`，新建分支 `codex/t04-4-bedrock-openai-effort`，提交 `1f5f1854f5cb58b1fd993af67669d3c965246970`，独立 [PR #92](https://github.com/dragonbaba/super-pi/pull/92)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/92#issuecomment-6088961538)，并附加到当前任务。最终提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/37989108158)全部通过，[Codex 审查](https://github.com/dragonbaba/super-pi/pull/92#issuecomment-6088995171)未发现主要问题，无未解决讨论。经用户授权，2026-10-10 11:02:38（Asia/Tokyo）以 squash 合并，合并提交 `c89acea863a0dac61fe70d49ae42ad93fe3cd8f4`；T04.4 的 OpenAI effort 部分已完成。

根因与实现：原 buildAdditionalModelRequestFields 只处理 Claude，OpenAI 的已选 reasoning 档位丢失。按[上游 2989eb581f](https://github.com/earendil-works/pi/commit/2989eb581f95627618d40387ac527dc3ba061b1c)，GPT 请求补 nested reasoning.effort，minimal 转 low，保留其他档位及显式 string thinkingLevelMap；gpt-oss 补 flat reasoning_effort，minimal 转 low、xhigh/max 转 high，限定 low/medium/high。既有 Simple API capability/null 档位裁剪仍生效；none/off、Claude/GovCloud、其他模型与 onPayload 覆盖行为保持。请求字段位置遵循 [AWS Converse OpenAI 说明](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-openai.html)，GPT 档位另参照 [AWS 模型说明](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-openai-gpt-6-luna.html)。未调用真实 Bedrock 验证服务端接收。

模型识别按 id/name 支持不透明 application inference profile，大小写不敏感并兼容连字符、空白、下划线、点号、冒号。使用两个模块级非 global 正则，先 OSS 再通用 GPT，保持 Claude 分支优先；避免新增候选数组、lowercase/replace 临时字符串或匹配闭包。没有调整模型目录或通用能力定义。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；最终提交 Linux/Windows CI 六个分片全部通过 |
| 基线复现 | 20 项中 18 项失败，禁用 reasoning 与其他家族两项对照通过 |
| 新增回归 | 20 项全部通过；SDK send 实际载荷，六档位、direct/Simple、现有内置目录、profile name/case/separators、显式映射/null 裁剪、关闭能力、Claude/GovCloud 及 hook 覆盖 |
| 定向检查 | Bedrock/Haiku/capability matrix/source invariants/stream 共 88 项全部通过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：247 个执行单元全部成功；3984 项，3892 通过、92 跳过、0 失败/取消 |
| 精确计数 | 每组 10000 次，GPT 新增 20000 个请求自有对象，OSS 新增 10000 个，off/none/unknown 新增 0；数组/闭包/new/运行时 regexp/template 均为 0，既有字符串转换计数不变 |
| 生命周期 | 两类模型各成功/hook 错误/流错误/取消，及 1-delta 对照，共 81 个 WeakRef 全释放；两个 model 与十个 caller controller 保持可达 |
| 请求/流边界 | 1 和 256 delta 均只构建一次 payload、发送一次；hook 错误构建一次、发送 0 次；两个正则仅模块加载时创建 |

实现前审计完整链：catalog/profile → withModelProfile/getModelCapabilities → streamSimple/buildBaseOptions/clampThinkingLevel → stream SDK region/auth → context/messages/system/tools 转换 → additional fields → onPayload/effective dispatch → ConverseStreamCommand/send → start/delta/stop/metadata handlers → AssistantMessageEventStream → done/error/abort 释放。仅请求字段构建函数和两个常量改变，其他 39 个函数/入口与基线逐字一致，包含四个流处理函数。新增对象仅表达必须发送的 wire 字段，没有新 per-delta 对象、闭包、数组、Promise、controller、timer、listener、全局缓存或对象池。既有流内 findIndex callback/event 分配未被本次修改，不将其描述为全链路零分配。

计数范围为实际生产 builder 及本地匹配/effort helpers 的 AST literal/closure/new/regexp/template 和字符串转换调用；不包含 SDK、imported capability/profile helper 或 V8 regexp 内部分配，不宣称耗时改善。GC 观察 context/options/payload/fields/nested effort/client/command/event stream/result；取消使用 primitive reason，SDK send 在 finally 恢复。初始 fixture 修正为本项目 amazonBedrockProvider().getModels() 入口、合法的 reasoning:false/none 组合与 provider-catalog 来源；修正后的基线与候选验证如上，未修改生产能力 schema。

证据在 `.git/t04-4-bedrock-openai-effort-20261010/`：实施前设计、基线/候选/定向/完整日志与汇总、可重跑分配/GC 探针、源码哈希、PR #91 合并及 PR #92 状态。全部请求离线合成并 mock SDK send，无真实模型额度或账号凭据读取；未创建外部服务或额外子进程资源。仅提交一个生产文件与一个回归测试，README 保持原 SHA256，任务计划留在本地。OpenAI effort 已完成最终 CI/审查并经授权合并，继续 T04.4 中其余 Claude thinking block binding 兼容，独立 PR 交付。

## 24. T04.4 Bedrock Claude thinking binding 实施与交付记录（2026-10-10）

问题类别：Bedrock Claude signed thinking 在 prompt/tools 前缀变化后的回放兼容。基于 PR #92 合并提交 `c89acea863a0dac61fe70d49ae42ad93fe3cd8f4`，分支 `codex/t04-4-bedrock-claude-binding`，独立 [PR #93](https://github.com/dragonbaba/super-pi/pull/93)。首次提交 `5c745e75e` 和第一轮修复 `7e3a6d713` 的 CI 六个分片均已通过，但复审又指出 GovCloud 工具续接 P1 和关闭 reasoning 的签名回放 P2。两项已在同一问题类别、同一 PR 修复，最终提交 `6115cc1011b8b2b58455d65d0d268051d5c2b13d` 的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38027415339)全部成功，[Codex 复审](https://github.com/dragonbaba/super-pi/pull/93#issuecomment-6094218600)未报告重大问题，三条历史讨论均 resolved。按用户本轮授权于 2026-10-10 15:33:13（Asia/Tokyo）合并为 `ea5b7e0878621eaeff73c3298853a0fbfc7b4597`，随后实施 T04.6，见 §25。下文保留历史证据，最终行为与本地验证以 §24.2 为准。

根因与实现：binding 请求字段原先仅覆盖 Haiku 5.5；其他适用模型还缺少 thoughtSignatureRoundTrip 声明，导致 transformMessages 在进入 Bedrock 转换前移除签名，仅扩展字段无法覆盖真实回放路径。按[上游 69f0be6f0a6](https://github.com/earendil-works/pi/commit/69f0be6f0a6ca1bf66a2a9cf59c821b632e6bca1)与 [AWS binding 文档](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-thinking-block-binding.html)，共用一个模型判定补齐 capability enrichment 和 adaptive 请求字段：Opus 4.7/4.8/5 系列、Sonnet 5 系列、Fable 5 系列发送 thinking.block_binding.prefix_mismatch_behavior=drop_block 及 thinking-binding-controls-2026-08-01 beta，保留 Haiku 5.5 现状。支持普通/区域 ID、opaque inference profile 名称、大小写与分隔符，并避免匹配 4.70/4.80/50 等相邻版本。

本地保留原始 signed thinking，由服务端丢弃前缀不匹配的 block；不自行比较前缀、不重写签名或历史。旧 4.6 adaptive、budget 模型、GovCloud、none/off、显式 mode/signature capability、effort/display 与 interleaved 设置仍遵循既有规则。损坏或不能解密的签名不在此兼容范围内；没有真实 Bedrock 服务端验收。

| 验证 | 本次结果 |
| --- | --- |
| 环境 | Windows / Node 26.4.0 / npm 12.0.1；最终提交 Linux/Windows CI 待完成 |
| 基线复现 | 24 项新增回归中 14 项失败、10 项兼容对照通过；连同原有目录测试的基线共 36 项，14 失败、22 通过 |
| 新增回归 | 24 项全通过；direct/Simple SDK send、模型/版本/名称匹配、能力/区域门禁、静态/远程/新旧缓存恢复、signature chunks → tool result → 修改 system/tools → 回放与输入不变 |
| 定向检查 | Bedrock/Haiku/catalog/capability contracts/source invariants/stream hot paths 共 132 项全通过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 完整测试 | `npm test`：248 个执行单元全部成功；4008 项，3916 通过、92 跳过、0 失败/取消 |
| 新识别函数 | 30000 次调用的 object/array/closure/new/runtime regex/template/string transform/native array 均为 0；新增 1 个模块级 regex |
| 请求字段计数 | Opus/Sonnet/Fable 各 10000 次，对象 40000 → 50000、数组 0 → 10000；Haiku/旧 adaptive/GovCloud/budget/off 各 10000 次所有计数与基线一致 |
| 目录 profile 计数 | Opus/旧 Sonnet 每 10000 次均为 40000 个既有对象、30000 literal 数组、10000 flatMap 数组；Haiku 为 70000 个既有对象；基线/候选计数一致 |
| 生命周期 | 三类模型分别成功/hook 失败/流错误/取消，外加 1-delta 对照，159 个 WeakRef 全释放；3 个 model、15 个 caller controller、15 份 signed history 保持可达 |

实施前审计链路：static/remote/raw-cache catalog → profileBedrockModel/enrichModelCapabilities/withModelProfile → getModelCapabilities → streamSimple/clampThinkingLevel 或 stream → SDK region/profile/endpoint → contextForModelCapabilities/transformMessages/convertMessages 与 system/tools 转换 → additional fields/onPayload/effective dispatch → ConverseStreamCommand/send → start/delta/stop/metadata → AssistantMessageEventStream/既有 agent-session 交付 → done/error/abort。adapter 除请求字段 builder 外其余 39 个函数/入口、原有 adaptive profile 的两个 helper、通用能力/消息转换实现均与基线逐字一致。

每个新适用请求仅增加 1 个协议必需 binding 对象与 1 个长度为 1 的 beta 数组，归请求所有、对 onPayload/SDK 可见，随 payload 释放；1 与 256 delta 均仅构建/发送一次，hook 异常构建一次、发送零次。没有新增 per-delta Promise/闭包/数组/controller、listener、timer、全局缓存或对象池。原有 profile 候选数组/字符串归一化和流处理 findIndex callback/event 分配保持，不能描述为全链路零分配。

精确计数范围为实际生产 builder/profile/matcher 及直接 helper 的 AST literal/closure/new/regex/template/字符串转换和 flatMap 返回数组；不包含 SDK、V8 regexp/string 内部或其他 imported capability 分配，也不宣称耗时改善。受控 GC 观察 options/payload/fields/thinking/binding/beta/replay/client/command/events/result；取消使用 primitive reason，SDK send 在 finally 恢复。首次类型检查指出 SDK DocumentType 联合需先缩窄字段，修正测试断言类型后 check 与全部验证通过，生产代码没有因此增加类型转换或运行时操作。

证据保存在 `.git/t04-4-bedrock-claude-binding-20261010/`：实施前设计、基线/候选/定向/完整日志、汇总、可重跑分配/GC 探针、源码哈希、PR #92 合并记录和 PR #93 快照。目录夹具使用本地测试 server 并在 finally 关闭，SDK 为离线合成数据 mock；无真实模型请求或账号凭据读取、无额外常驻资源。提交仅含两个生产文件和三个测试文件；README 保持原 SHA256，任务计划留在本地。完成本 PR 最终 CI/审查及合并验收后，下一项为 T04.6 请求输入估算校准，先校准再决定改动，不预先把系数差异认定为超限缺陷。

### 24.1 GovCloud 签名回放审查修复（2026-10-10）

核实并修复 [P2 反馈](https://github.com/dragonbaba/super-pi/pull/93#discussion_r4236001557)：GovCloud 虽省略 binding 控制，仍回放签名；前缀变化后可能按默认行为持续拒绝请求。目录能力无法预知最终 option/env/profile/endpoint 区域，故不修改共享模型的 capability，而是在 SDK region 解析后计算一次 request-local GovCloud boolean，传入消息与字段两个转换函数。

该轮行为（已被 §24.2 更正）：GovCloud 不回放 signed reasoning；可读 thinking 使用普通文本回退，signature-only/空白/redacted 加密内容省略，工具调用/结果保持。规则同样覆盖 Haiku；原 Haiku 签名保留测试转到商业区域，新测试覆盖 GovCloud 限制。输入历史和 capability 对象不变，同一模型 GovCloud → commercial 切换后恢复商业签名回放；显式 capability=false、跨模型、onPayload 覆盖继续有效。没有修改通用 transformMessages 或任何 delta handler。

| 修复后验证 | 结果 |
| --- | --- |
| 同组基线复现 | loader 加载审查提交 `5c745e75e` 的实际 adapter；43 项中 14 失败、29 通过，候选全部通过 |
| 回归范围 | 新增 5 项并增强既有用例；Opus/Sonnet/Fable/Haiku × 可读/空/空白/加密 × direct/Simple，真实 stream 签名与工具续接，冻结输入，shared profile/FIPS/ARN/prefix/endpoint、商业区域复用 |
| 类型、构建、定向 | `npm run check`、`npm run build:offline` 通过；137 项定向测试通过，含 source invariants 与 stream hot paths |
| 完整测试 | 248 个执行单元全部成功；4013 项，3921 通过、92 跳过、0 失败/取消 |
| AST/请求分配 | PR 基线相比 adapter 仅 stream 请求准备、convertMessages 和字段 builder 改变，37 个其他函数/入口及四个流处理函数不变；原模型匹配与 profile 计数保持 |
| 消息转换精确计数 | 每组 1000 请求 × 1/256 thinking 块；商业区域计数不变，GovCloud 文本每块 3 → 1 个 wire 对象，空/加密每块 3 → 0；256 块组对象 772000 → 260000 或 4000，数组均 3000，闭包/new 均 0 |
| 请求准备成本 | 共享既有 GovCloud 判断，正常 Claude 的字段/区域检测计数保持；off/non-Claude 商业区域每请求新增 2 次 lowercase 调用，无新增对象/数组/闭包，非 per-delta 操作 |
| 释放证据 | 商业/GovCloud × 三类模型 × 成功/hook 错误/流错误/取消及 1-delta 对照：288 个 WeakRef 全释放；3 个 model、30 个 controller、30 份原始 signed history 保持可达 |

完整链重新审计至请求转换、SDK/event delivery 与 done/error/abort 释放，新增状态只有一个布尔值，无缓存、池、listener、timer、controller 或 per-delta 分配。converter 探针调用真实 transformMessages，但其未改动的 imported 内部分配不计入 converter literal 计数；其他计数边界与首次证据一致，不宣称 SDK/V8 全链路零分配。首次 Simple API fixture 误用了仅 direct API 接受的 region 字段，已改为显式 env.AWS_REGION；最终基线 loader 与候选均使用修正后相同夹具。

修复提交 `7e3a6d71367273b22b3eb8d657a4e13afc3bbc19` 已推送原 PR，PR 正文已按该轮实现重写，随后重新发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/93#issuecomment-6092884864)。对应讨论已标记 resolved。该提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38017781458)随后全部通过，但复审否定了全量剥离策略，并指出 reasoning 关闭分支遗漏；后续修复见 §24.2。

本轮证据为同目录的 `review-design.md`、`review-baseline-loader.mjs`、`review-baseline-final.log`、`review-focused.log`、`review-full-summary.json`、`review-performance.mjs/log`、`review-source-hashes.json` 和 `review-pr93-status.json`。此轮提交一个生产文件及三个测试文件，整个 PR 累计两个生产文件及五个测试文件。README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，计划保持本地；SDK mock、夹具目录和 server 均按所属实例清理。未调用真实 Bedrock，也未合并或进入 T04.6。

### 24.2 工具回合与 reasoning 关闭的复审修复（2026-10-10）

修复 [P1 GovCloud 工具续接](https://github.com/dragonbaba/super-pi/pull/93#discussion_r4236092569) 和 [P2 reasoning 关闭仍回放绑定签名](https://github.com/dragonbaba/super-pi/pull/93#discussion_r4236092570)。使用 complex-debugging-protocol，在编辑前记录 failure matrix、精确基线与两轮错误假设。此前测试把“GovCloud 全量剥离”当作成功，SDK mock 又未检查真实协议要求；CI 通过不能证明该假设正确。

依据 [AWS extended thinking](https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html)，工具结果属于同一回合，必须完整保留该回合的 thinking；依据 [preserved thinking](https://platform.claude.com/docs/en/build-with-claude/preserved-thinking)，允许移除最早的连续 thinking 前缀，而 disabled 不接受 block_binding。因此先构建一次实际附加字段，再据此转换历史：有 binding 则保留既有回放；无 binding 则省略已结束回合的 signed/redacted thinking，保留最后真实 user 消息之后当前工具回合的签名序列。省略的 signed thinking 不改成普通文本。无 binding 时，关闭/省略 reasoning 的新用户回合不再回放旧签名；若当前工具回合仍依赖 signed thinking，发送前明确报错，要求完成回合后再关闭。没有静默启用 reasoning 或发送 disabled+binding。

当前工具回合的完整性覆盖多次工具迭代、多个连续 thinking 块、signature-only/空白、合成工具结果和 aborted/空消息尾部。输入历史与 capability 不变，显式 capability=false、跨模型、区域/profile/ARN/FIPS/endpoint 规则保持。此轮仅修改 adapter 的请求准备和消息转换，无 delta handler 改动。

| 第二轮修复验证 | 结果 |
| --- | --- |
| 精确基线复现 | loader 加载 `7e3a6d713` 实际 adapter；最终相同 54 项测试中 23 失败、31 通过；候选 54 项全通过 |
| 新增/增强回归 | 新增 11 项；四类 Claude × direct/Simple × off/omitted × system/tools 编辑 × 商业/GovCloud；连续两轮工具回放逐块对照 SDK payload 的前缀与完整签名序列 |
| 类型、构建、定向 | `npm run check`、`npm run build:offline`、148 项定向检查全部通过，含 source invariants、stream hot paths、能力契约 |
| 完整测试 | `npm test`：248 个执行单元全部成功；4024 项，3932 通过、92 跳过、0 失败/取消 |
| AST 与完整链 | 相对 PR 基线，37 个其他 API 函数及四个 stream handler 逐字不变；profile/matcher/builder 计数维持首次及第一轮证据 |
| 边界判断 | 仅 primitive boolean/index，无新增容器/闭包/序列化/cache/pool；256 轮工具对 512 条消息扫描 511 步，新 user 回合扫描 0 步；每请求仅一次，不随 delta 重复 |
| 精确 converter 分配 | 每组 1000 请求 × 256 thinking：商业 adaptive 772000 对象不变；已完成 GovCloud 文本组 260000 → 4000；当前工具回合恢复每块协议所需的 3 个 wire 对象，数组/闭包计数不增加 |
| reasoning 关闭 | 有效新回合每个旧 signed block 减少 3 个 wire 对象；非法工具回合每次 1 个 Error、0 payload hook、0 dispatch/SDK send |
| 构建产物生命周期 | 使用 packages/ai/dist 的实际 stream，商业/GovCloud × 三类模型 × 成功/hook 错误/流错误/取消/本地拒绝及 1/256-delta 对照，366 个 WeakRef 全释放；3 个 model、36 个 caller controller、36 份原历史保持可达 |

完整链重新审计：目录/能力 → direct/Simple options → SDK region → contextForModelCapabilities/transformMessages → fields/messages/system/tools → onPayload/effective dispatch → command/send → 四个流处理函数 → event delivery → done/error/abort。新增状态仅请求局部 primitive；输出 wire 对象归请求所有并随请求释放。计数含 converter 的实际本地 helper，保留其既有工具参数转换分配；不含未修改的 imported transformMessages 或 SDK/V8 内部分配，不宣称全链路零分配或耗时改善。首次 check 发现 SimpleStreamOptions 的类型不包含 off；仅对故意模拟非 TS 调用方的测试加窄类型断言，生产 API 类型未改。

明确边界：GovCloud 当前工具回合仍要求 system/tools/前序消息不变；Context 没有原始前缀来源，不能可靠识别回合内的前缀编辑。此次回退基于可安全省略的已结束回合，不把未知签名称为“已知陈旧”。损坏签名及新增 redacted stream 解码不在本轮范围；未调用真实 Bedrock。

提交 `6115cc1011b8b2b58455d65d0d268051d5c2b13d` 已推送 PR #93，正文按最终行为重写，并重新发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/93#issuecomment-6094187326)。两条本轮反馈均标记 resolved；该 head 的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38027415339)全部成功，[最终 Codex 复审](https://github.com/dragonbaba/super-pi/pull/93#issuecomment-6094218600)未报告重大问题。经本轮用户授权，以 match-head-commit 核对后 squash 合并为 `ea5b7e0878621eaeff73c3298853a0fbfc7b4597`；T04.4 已关闭，T04.6 交付见 §25。

证据保存为 `.git/t04-4-bedrock-claude-binding-20261010/review2-*`，含实施前 ledger、错误假设、基线 loader/最终日志、候选/定向/check/build/full 日志及汇总、独立性能探针、源码与构建产物 SHA256、PR 状态。本轮提交一个生产文件和两个测试文件，整个 PR 仍为两个生产文件和五个测试文件。README SHA256 保持不变，任务计划仍仅本地保存。临时 SDK mock、profile 目录与 server 按实例清理，无额外常驻资源。

## 25. T04.6 请求输入估算校准实施与交付记录（2026-10-10）

问题类别：请求预算文本估算偏低，以及调整文本系数时意外改变图片占位。基于 PR #93 合并提交 `ea5b7e0878621eaeff73c3298853a0fbfc7b4597`，分支 `codex/t04-6-request-input-estimate`，最终提交 `c94a0b058cce664ae2e04edff0cfb6f840daf36d`，独立 [PR #94](https://github.com/dragonbaba/super-pi/pull/94)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/94#issuecomment-6094802254)。该 head 的 [Linux/Windows CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38032161241)全部成功；[Codex 审查](https://github.com/dragonbaba/super-pi/pull/94#issuecomment-6094819281)明确审查 `c94a0b058c` 且未报告重大问题，review threads 为空。经本轮用户授权，按 match-head-commit 核对后于 2026-10-10 16:01:19（Asia/Tokyo）squash 合并为 `97074eff8c78197dbf4e91ed492e3d7db400d5cc`；T04.6 已关闭，T05.1 的独立 PR 见 §26。

先比较 4/4800、上游 3.5/4800 和本地 3.5/4200 三组实际生产估算器，再选定文本 3.5 字符/token、图片固定 1200 token。校准使用既有开发依赖 js-tiktoken 的 cl100k_base/o200k_base，覆盖八类文本 × 新请求/2000-token usage 锚点，以及 schema、新增工具和图片边界。完整数据、权衡、调用链与复跑命令见 [性能校准报告](performance/request-input-estimate-calibration.md)。英文更保守，日志/JSON/混合内容的低估收敛，中文仍可能显著低估；参考 tokenizer 不含 provider framing 或图片计费，不能视为 DeepSeek/Claude 精确计数。

实现仅改两个模块常量及说明：文本系数 4 → 3.5，图片字符占位改为 `1200 * CHARS_PER_TOKEN`。服务端 usage、cache total 及其已有锚点规则不变，只估算未知尾部和新工具；图片 data 不读取。14 个估算函数体及七个调用链文件逐字不变，无新扫描、tokenizer 运行时依赖、容器、闭包、缓存或对象池。工具输出 estimator/G2、独立 compaction 估算、最小回答预算与 safety reserve 保持既有规则。

具体离线请求复现：32000 context window、4096 reserve、512 行日志，参考文本为 16384 token。旧估算允许 16896 输出，合计 33280，超出 1280；新估算允许 15323 输出，合计 31707，剩余 293（尚未计入 wire framing）。真实 SimpleChat adapter 的 mock fetch 校验实际 payload 与 clamp；原文保持不变。此证据说明该夹具的预算改善，不代表任意请求不会超限，未调用真实 provider。

| 验证 | 结果 |
| --- | --- |
| 精确基线复现 | loader 加载 `ea5b7e0` 的实际生产估算器；11 项新增回归中 10 失败、1 通过，候选 11 项全通过 |
| 回归范围 | 实际 SimpleChat wire clamp、usage/cache 锚点、尾部/新增工具、时间戳插入、失败/取消响应、schema/参数、图片禁止读取 data、循环参数、模型/调用方/最小预算 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 定向检查 | 109 项：108 通过、1 跳过、0 失败，含 source invariants、stream hot paths、工具预算及恢复 |
| 完整测试 | `npm test`：249 个执行单元成功；4035 项，3943 通过、92 跳过、0 失败/取消 |
| AST / 文本长度 | 14 个估算函数体、七个调用链文件不变；1 字符及 10 MiB 文本各 10000 次均仅 10000 次 length 读取，0 对象/数组/闭包/new/JSON |
| 上下文确定性计数 | 每组 10000 次：cold 20000 对象、30000 length；usage anchor 30000 对象、70000 length；schema/new tools/参数沿用原有 JSON 次数与字符量；基线与候选一致 |
| 构建产物释放 | 实际 dist streamSimple，新请求/usage 锚点 × 成功/hook 错误/fetch 错误/取消/预算拒绝，80 个 WeakRef 全释放；共享 model 和十个 caller controller 保持可达 |
| 大结果投影 | 1 × 10 MiB、2/4/8 × 256 KiB，投影次数均为 25/50/100/200，active 0/high-water 1；clear/dispose 后 entries、retained chars、retained WeakRefs 全为 0，无完整结果复制/序列化 |
| 三组成对性能复测 | 1/2/4/8 结果的 p95 中位数（ms）基线 .1266/.1801/.2534/.3425，候选 .1238/.1736/.2645/.3421；最大增加约 4.4%，不宣称吞吐提升 |

实施前审计 SDK/agent 请求准备 → simple-options clamp → estimate 与 usage/tail/schema helper → provider payload/send，以及 tool-result projection → event delivery → done/error/abort。正常请求一次 payload/send，hook 错误一次 payload、零 send，预算拒绝零 payload/send；数值变化不增加请求或 delta 分配。AST 计数不包含 SDK/V8 内部，沿用既有序列化，不宣称全链路零分配。

首次参考校准使用过长的重复字符输入，参考 tokenizer 耗时异常；只中断本任务 exec session，随后将此压力夹具限制为 512 字符。首次类型检查发现测试中只抛错的图片 getter 被推断为 void，补充 string 返回类型后通过。首次投影单对测量有一项 p95 波动，完整测试结束后追加三组独立配对测量，上表使用中位数，原始波动仍保留在报告。没有为降低观测值修改生产逻辑。

证据位于 `.git/t04-6-request-input-estimate-20261010/`，包括实施前设计、校准 JSON、实际基线 loader、基线/候选/定向/check/build/full 日志、完整汇总、可重跑性能/GC 探针、初始与三组成对 benchmark、源码/构建产物哈希及 PR #93 合并/最终审查和 PR #94 状态。提交包含一个生产文件、两个测试文件、一个夹具、一个校准脚本和性能报告；无依赖变更。README SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，本计划保持本地未跟踪；mock 与本任务子进程均已收尾，无真实模型请求或凭据读取。

## 26. T05.1 / T05.2 目录分层价格转换实施与交付记录（2026-10-10）

问题类别：生成目录时丢失或错误填充 tier 费率。基于 PR #94 合并提交 `97074eff8c78197dbf4e91ed492e3d7db400d5cc`，分支 `codex/t05-1-model-cost-tiers`，提交 `36479c8c1928e16bd0457dc0f756c339fef3570c`，独立 [PR #95](https://github.com/dragonbaba/super-pi/pull/95)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/95#issuecomment-6095043077)；最终 head 的 [Linux/Windows CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38033952112)全部成功，[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/95#issuecomment-6095078265)未报告重大问题，无遗留审查线程。2026-10-10 16:52:11 JST 经本轮用户授权合并为 `2336b4aed9a26c288f499e039cd0c0c01f13752c`，T05.1/2 完成交付验收；后续 T05.3 按独立问题分别处理。

实施前确认：运行时 merge/profile/raw-store/restore 已能保留 `cost.tiers`，缺口位于手工重建基础价格的生成器和 Azure 派生。现有 models.dev helper 又把 tier 缺省价格填成 0，直接扩展调用会扩大错误定价；因此 T05.2 是本次安全传递部分 tiers 的必要前提，合入同一价格转换问题，未把独立模型默认值或 Moonshot 固定规则混入。

全部 models.dev 转换共用 helper，逐 tier 继承基价且保留显式零。OpenRouter prompt overrides 按上游严格超过阈值转换，时段/星期价格不进入不支持该语义的 ModelCost；Gateway 的四项独立价格区间合并为请求级 tiers，包含起点、终点、零起点和间隙回退。Azure 复制完整 tiers。Vertex cache-write 存储费继续排除，Gemini 2.5 Flash cache-read 固定修正在各 tier 保持；Mistral fallback、Kimi/Moonshot 原基础规则、未知成本与用户覆盖保持。

| 验证 | 结果 |
| --- | --- |
| 精确基线 | 实际未修改生成器、固定 HTTP 响应、最终 JSON 输出；37 项中 36 失败，既有 Copilot 完整 tier 路径 1 通过 |
| 候选行为 | 43 项全通过；34 个 provider 输出含 Azure，部分 tier/显式零、阈值前/等于/超过、cache/1h write、单位转换与特殊价格规则 |
| 运行时闭环 | 本地真实 HTTP 200/304/400、原始缓存持久化、旧/新 profile 离线恢复及用户替换/清空 tiers 均通过，原输入不变 |
| 类型、构建、定向 | `npm run check`、`npm run build:offline` 通过；86 项定向检查通过，含 source invariants 与 stream hot paths |
| 完整测试 | 251 执行单元成功；4078 项，3986 通过、92 跳过、0 失败/取消 |
| 运行时不变证据 | 九个成本/目录/覆盖/usage adapter 文件与基线逐字相同；100000 次带 tiers 的实际 calculateCost 对象/数组/闭包/new 计数全部为 0，不含引擎内部 |
| 生成时精确计数 | 每 10000 次两级 models.dev 转换：对象 40000→30000，literal arrays 20000→10000，native arrays 10000→0，闭包 10000→0；无 tiers 每次一个成本对象 |
| 生命周期 | 46 个 WeakRef 全释放：保留三份输出时原目录 9 个引用释放，输出清理 11 个引用释放，正常/旧缓存/失败/取消后 26 个引用释放；四个已清理 registry 保持可达 |
| 既有 benchmark | merge 4000+4000→6000，indexed p95 0.3120 ms；离线 restore p95 0.0614 ms。未修改这两个运行时实现，不把已有 indexed 优势归为本 PR 收益 |

完整调用链、既有/新增分配与所有权、计数边界和复跑命令见 [性能报告](performance/model-catalog-pricing.md)；新增 [分配/释放探针](../scripts/bench/model-catalog-pricing.mjs) 固定比较本轮基线。生成结果 cost/tiers 归模型所有、不保留原目录；Gateway 临时 set/array 至多为源区间数两倍，最坏 O(B²+B log B)，仅发生于生成阶段。无新增 per-delta/request 状态、全局缓存、listener、timer、controller 或对象池。

边界：本轮没有从变化中的公开目录重生成随包快照，模型记录更新仍归 T05.3；生成夹具的 JSON、在线消费和离线恢复价格一致。models.dev 延用既有美元/百万 token 口径，OpenRouter/Gateway 美元/token 只转换一次，不进行币种换算；不代表真实 provider 账单验收。价格为启发式目录核算，时段条件暂不支持。

证据位于 `.git/t05-1-model-cost-tiers-20261010/`：实施前设计、上游 diff、确定性编辑预览、基线/候选/定向/check/build/full 日志与汇总、计数/GC、merge/restore、源码哈希及 PR 状态。初始夹具的浮点计算顺序、MiniMax ID 与 auth 元数据问题在探针中修正；首个 GC 探针的顶层循环变量保留在返回 helper 中消除，没有据此修改生产代码。七个提交文件均属于本问题；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，任务计划留在本地。服务器、临时 models.json 目录和本任务执行进程均已收尾，无真实模型请求或凭据读取。

## 27. T05.3 NVIDIA 默认模型对齐实施与交付记录（2026-10-10）

问题类别：NVIDIA 默认模型未同步 pi 1.1.0。基于 PR #95 合并提交 `2336b4aed9a26c288f499e039cd0c0c01f13752c`，分支 `codex/t05-3-nvidia-default`，提交 `ba3c1003126652b4c9f2158847b43bd523701171`，独立 [PR #96](https://github.com/dragonbaba/super-pi/pull/96)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/96#issuecomment-6095528683)；最终 head 的 [Linux/Windows CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38036819415)全部成功，[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/96#issuecomment-6095542721)未报告重大问题，无遗留审查线程。2026-10-10 23:53:57 JST 经本轮用户授权合并为 `eaa63e4df7375df340659128d7c898bf17369e6d`，NVIDIA 子项完成验收。T05.3 整体保持未勾选，后续 Together 与 Cloudflare 分别独立处理。

[上游提交](https://github.com/earendil-works/pi/commit/49b9df48952b155937e62fed11f03ad2e15ff3c1)已将默认值改为 `nvidia/nemotron-3-ultra-550b-a55b`；[NVIDIA 官方模型页](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b)提供相同 ID 的调用示例。当天公开 `/v1/models` 实际同时列出 Super 和 Ultra，因此不将上游历史“Super 已不再服务”的说明当作当前下线证明。现有随包目录已含 Ultra，无需重新生成目录或删除 Super。

生产变更仅替换默认映射中的一个字符串。新会话无显式选择时采用 Ultra；CLI、限定列表、设置默认以及可恢复模型的选择优先级保留。回归使用真实随包 NVIDIA provider 目录，验证正序、逆序和无 Super 的目录；另验证显式选择、恢复 helper 成功与回退、缺少 Ultra 和缺少认证。没有修改 Together/Cloudflare、模型能力、价格或选择算法。

| 验证 | 结果 |
| --- | --- |
| 基线复现 | 修改生产代码前，9 项中 2 项失败，启动和恢复回退仍选 Super；候选 9 项全通过 |
| 类型与构建 | `npm run check`、`npm run build:offline` 通过 |
| 最终完整测试 | `npm test -- --jobs 4`：251 执行单元成功；4083 项，3991 通过、92 跳过、0 失败/取消，含源码不变量、既有生命周期/GC 和原生打包检查 |
| 精确源码检查 | 相对基线只有 1 个生产文件、1 个字符串替换；归一该字面量后其余源码逐字相同，0 个函数体变化、0 个新增分配点或资源，两个 ID 均为 33 code units |

性能边界：审计 CLI `resolveCliModel/options.model` → SDK 显式/会话/设置选择 → `findInitialModel` → ModelRuntime snapshot/catalog；同时检查导出的 `restoreModelFromSession` 兼容 helper 及交互登录 `completeProviderAuthentication` → `setModel` → generation 校验、footer 和有所有者的目录刷新及 finally 清理。默认值替换发生于启动、登录和恢复回退等低频边界；已有 available 数组复制、Object.keys、find 闭包及 async 结果不变。映射为模块生命周期，返回已有目录 model 引用；无新增缓存、对象池、worker、timer、controller 或 listener。未修改 delta/进度/布局/终端写入，不为静态字面量替换新增分配 benchmark，也不宣称运行时性能提升。

验证过程保留两次中断记录：首个 8 并发完整运行的既有 `fullscreen/active-stream/stdout-close` 用例达到 15 秒超时，返回 null 且无 shutdown；该夹具显式选择 `alpha-process-fixture/fixture`。隔离复核 880 ms 通过，退出码 129、shutdown 一次、raw 模式恢复；后续两次整份 CLI 文件均通过，间歇超时根因尚未确定。第二次直接用 Node 启动完整脚本，原生交付检查因缺少 npm 提供的 `npm_execpath` 失败；改用正确 npm 入口后最终完整清单通过。未修改 shutdown、测试超时或放宽断言。

证据位于 `.git/t05-3-nvidia-default-20261010/`：实施前设计、上游 diff、公开目录响应、基线/候选/隔离复核日志、精确源码检查及 hash、三次完整运行与最终汇总、check/build、PR 正文和状态。提交仅含 resolver 与兼容性回归两个文件。README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，本计划继续留在本地；没有真实模型推理或终端登录验收，Linux 等待 CI。执行进程已结束，测试夹具按其自身所有权清理。

## 28. T05.3 Together DeepSeek 新 ID 推理控制实施与交付记录（2026-10-11）

问题类别：Together DeepSeek V4 Pro 改名后生成器未匹配新 ID。基于 PR #96 合并提交 `eaa63e4df7375df340659128d7c898bf17369e6d`，分支 `codex/t05-3-together-deepseek`，提交 `251265f54ff24d8f44d12db2dd1eef025b292c74`，独立 [PR #97](https://github.com/dragonbaba/super-pi/pull/97)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/97#issuecomment-6098877879)；交付时对应提交的 [Linux/Windows CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38062207253)运行中，审查已请求、结论待完成，尚未合并。本项不关闭整个 T05.3；下一独立项为 Cloudflare Claude dashed ID。

[上游修复](https://github.com/earendil-works/pi/commit/28eaccb8e87d075562593073282cc0774f2c2e3b)将推理控制匹配改为 `deepseek-ai/DeepSeek-V4-Pro-0813`。[Together 官方文档](https://docs.together.ai/docs/deepseek-v4-quickstart)确认该 ID、`high/max` 及 `reasoning.enabled=false`。Super Pi 已有新 ID 目录记录，但其 `supportsReasoningEffort=false`，实际请求不发送强度；显式能力清单还要求声明 `max` 才能提供该等级。修复生成器识别新 ID，并仅为该 ID 补齐 off/high/max；旧 ID 仍在随包目录，保留其既有控制，不将旧名移除或自动迁移配置。

只用既有名称、价格、限制和模态构造固定输入，经真实生产生成器重新产出 `-0813` 条目；确定性预览/断言仅 reasoning metadata 变化，再用既有 manifest 工具更新哈希与生成时间。其他模型记录和其他 provider 文件哈希不变，未进行全目录在线刷新。保留 Flash、GPT-OSS、非推理模型、用户覆盖和现有更新优先级。

| 验证 | 结果 |
| --- | --- |
| 精确基线 | loader 从合并基线加载实际生成器与 Together JSON；13 项最小复现中 10 失败、3 通过，明确观察到缺失 effort，不以源码字符串代替行为 |
| 最终定向回归 | 14 项全通过：真实生成结果、随包能力、off/high/max wire、low/xhigh 收敛、旧 ID/Flash/GPT-OSS/非推理模型隔离、当前/旧 profile 离线恢复与旧目录失效 |
| 类型、构建与数据完整性 | `npm run check`、`npm run build:offline`、`check-model-data.ts`、`git diff --check` 通过 |
| 完整测试 | `npm test -- --jobs 4`：252 执行单元成功；4097 项，4005 通过、92 跳过、0 失败/取消 |
| 生成时精确计数 | 基线/候选每 10000 次 helper pair 都为 10000 个 map 对象，数组/闭包/new 为 0；模块初始化对象 8→9，增加一个有限常量 map，其余不变 |
| 请求参数分支计数 | off/high/max 分别 10000 次，基线/候选均为 10000 个既有 reasoning wrapper，数组/闭包/new 为 0；启用 effort 仅增加既有 primitive 属性赋值 |
| 生命周期 | off/high/max × 成功/HTTP 失败/取消：9 payload、9 mock send，63 个 WeakRef 全释放；9 个 caller controller 与共享 model 保持可达 |
| 运行时源码 | 10 个相关文件相对基线逐字相同（忽略行尾），无 provider delta/事件/TUI 热路径修改 |

完整调用链与既有分配边界见 [性能报告](performance/together-deepseek-reasoning.md)，可重跑 [AST 计数/GC 探针](../scripts/bench/together-reasoning.mjs)。生成 map 归目录所有，请求 payload 归单次请求所有；无新增运行时缓存、对象池、worker、listener、controller 或 timer。计数不包含 V8/SDK 内部，也不是完整请求零分配证明，不宣称吞吐提升。较新的外部目录仍按既有策略优先；本次不强制改写任意未来目录或用户覆盖。

证据目录 `.git/t05-3-together-deepseek-20261010/` 沿用实施开始日命名，包含实施前设计、上游 diff、固定输入重生成/预览脚本、正确基线 loader 与日志、候选/性能/check/build/full 汇总、PR 正文和状态。初始生成夹具错误读取 provider.api、SimpleStreamOptions 的 off 表达与恢复模型泛型类型已纠正；有效基线复现采用修正后的夹具重新执行，未将夹具错误记为产品问题。六个提交文件均属于本问题；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，本计划留在本地。所有执行进程已结束，日志记录的精确临时根目录确认移除；首次清理核对误用了外层 shell 的 TEMP，随后按测试日志中的完整路径重新核对。没有真实模型推理/服务端验收，Linux 等待 CI。

### 28.1 PR #97 首轮反馈修复：局部元数据修正保留全局目录时间戳（2026-10-11）

[审查反馈](https://github.com/dragonbaba/super-pi/pull/97#discussion_r4238078888)成立：初次提交只改变 Together 单个条目，却将全局 generatedAt 从 `2026-10-09T17:48:08.865Z` 推进至 `2026-10-10T14:58:05.220Z`。ModelRuntime 将该时间传给所有 withRemoteCatalog，导致两个时间之间的远端更新被当作过期目录；相同 Last-Modified 的后续响应也不能恢复覆盖层。原提交的六个 CI 分片通过不代表此场景已覆盖。

修复提交 `419b486771d1631859852c7c6ac2e7b19358ff20` 留在同类问题的原 PR #97：恢复完整快照的原始时间，只保留 Together 内容哈希变化。本次未获取完整供应商目录，因此不推进供应商级时间戳，避免同一 Together 中其他未更新条目也被误判。运行时算法及远端目录优先级不变；较新的外部目录仍可能覆盖内置模型元数据。已修正本地确定性重生成脚本，重复执行不再推进时间。

验证结果：
- 修复前真实 ModelRuntime 探针将 OpenAI 的中间更新回退成 GPT-4 内置记录，时间戳不变量也失败；修复后覆盖 OpenAI 与 Together Flash，4 次当前/旧 profile 缓存恢复、4 次 HTTP 200（含重复 Last-Modified）、2 次 304 全通过。
- 30 项定向回归通过；`npm run check`、`npm run build:offline`、目录完整性及 `git diff --check` 通过。
- `npm test -- --jobs 4`：252 单元、4097 项，4005 通过、92 跳过、0 失败/取消。
- 性能探针检查 38 个其他 provider 哈希和全局时间不变；12 个完整调用链相关运行时文件相对固定基线不变，含两个时间戳消费者。AST 计数维持 §28 结果，9 次请求的 63 个 WeakRef 全释放，无新增生产分配点或资源。
- 新鲜度夹具最初未设置虚拟凭据，网络阶段按现有认证门禁跳过；仅修正夹具为内存假凭据，随后 6 次 loopback HTTP 请求完整验证通过。该夹具问题与有效的修复前离线复现分别记录。

推送后立即[再次评论 `@codex review`](https://github.com/dragonbaba/super-pi/pull/97#issuecomment-6099043207)，并[回复原反馈](https://github.com/dragonbaba/super-pi/pull/97#discussion_r4238128774)。PR 正文和性能报告已更新。对应新提交的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38063335612)运行中，复审已请求，尚未合并。

证据位于 `.git/t05-3-together-deepseek-20261010/review-1/`，含修复前设计、失败复现、重生成记录、定向/性能/check/build/full 日志与汇总、审查回复。测试临时根 `C:\Users\ADMINI~1\AppData\Local\Temp\super-pi-test-run-QBIZsz` 已确认不存在；loopback server 在 finally 关闭，缓存条目按 provider 身份删除。提交只含 manifest、探针及性能说明三文件；README 原编辑未改动、未提交，本计划仍留在本地。没有真实服务商推理调用。
### 28.2 PR #97 最终验收与合并（2026-10-11）

最终提交 `419b486771d1631859852c7c6ac2e7b19358ff20` 的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38063335612)全部成功；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/97#issuecomment-6099063830)明确审查该 head 且未报告重大问题。全局时间戳反馈已修复并回复，核对后将历史线程标记 resolved。按本轮用户授权，使用 match-head-commit 于 2026-10-11 00:47:02 JST squash 合并为 `8ed7d79e8d81c197274a95725358cb92c3cec68e`。Together 子项验收完成，随后基于该合并提交实施 Cloudflare。

## 29. T05.3 Cloudflare Claude dashed ID 实施与交付记录（2026-10-11）

问题类别：Cloudflare AI Gateway 的 Anthropic 透传 ID 与生成目录不一致。基于 PR #97 合并提交，独立分支 `codex/t05-3-cloudflare-claude-ids`，提交 `d12784d9f744275eaa44c53aa26189d6299adcbf`，新建 [PR #98](https://github.com/dragonbaba/super-pi/pull/98)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/98#issuecomment-6099418865)；当前 [Linux/Windows CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38065877237)运行中，审查已请求，尚未合并。

[上游修复 c10bfb0](https://github.com/earendil-works/pi/commit/c10bfb0d79dbbc998539a0a3e6c6a736a4e6db06)确认 models.dev 点号形式被透传至 Anthropic。[Cloudflare 官方示例](https://developers.cloudflare.com/ai-gateway/usage/providers/anthropic/)使用原生 `claude-sonnet-4-5` 与 `/anthropic/v1/messages`。本次只在 Cloudflare Anthropic 的生成分支将点号转连字符；OpenAI、Workers AI 和其他供应商的 ID 规则不变。

随包目录确定性更正 7 对 key/id：Haiku 4.5，Opus 4.5/4.6/4.7/4.8，Sonnet 4.5/4.6。价格、名称、能力、限制和其他模型记录全部逐字段保留；更新 Cloudflare 哈希及 structureHash，全局 generatedAt 仍为 `2026-10-09T17:48:08.865Z`，其他 38 个供应商哈希不变，避免局部修正误作全目录刷新。生产运行时代码未改动，不在每次请求/delta 中规范化 ID；已有自定义 ID、模型覆盖、目录合并策略保留。显式配置这些内置模型时应使用修正后的连字符 ID；不自动迁移任意旧配置或改写较新的远端目录。

| 验证 | 结果 |
| --- | --- |
| 精确基线复现 | loader 加载真实基线生成器与 Cloudflare JSON；22 项中 21 失败、1 通过，wire 用例实际观察点号 ID |
| 定向回归 | 22 项全通过；生成/随包 × direct/Simple × 7 模型共 28 次 mock send 校验 endpoint 和 payload ID；另含新版本/日期/已 dashed/去重、其他 provider 路由、tiers、当前/旧 profile 缓存恢复、显式自定义与费率覆盖 |
| 相关回归 | 75 项目录/价格/profile 测试通过 |
| 类型/构建/完整性 | `npm run check`、`npm run build:offline`、生成数据校验与 `git diff --check` 通过 |
| 完整测试 | `npm test -- --jobs 4`：253 单元、4119 项，4027 通过、92 跳过、0 失败/取消 |
| AST/源码 | 恢复一条 ID 赋值后整个生成器 AST 与基线一致；生产 diff 仅生成器和两个 JSON；0 运行时函数变化 |
| ID 转换计数 | 基线/候选各 20000 次表达式执行；对象/数组/闭包/构造调用语法点均为 0，候选每目录行多一次有界 string replaceAll，ID 长度不变；不声明 V8 字符串存储或整个 SDK 零分配 |
| 能力比较 | Cloudflare Anthropic 全部 10 条记录的旧/新 ID 派生能力相同 |
| 生命周期对照 | 基线/候选各 direct/Simple × 成功/HTTP 失败/取消，6 send、6 payload。保留 caller controllers 时默认 abort reason 的延迟堆栈均保留同样 11 个引用；读取仅夹具拥有的 stack 后，受控 GC 均释放全部 54 个被监测引用，provider/model/6 controllers 仍保持可达。显式 primitive reason 对照无需 stack 步骤也全释放 |

完整调用链和重跑命令见 [性能报告](performance/cloudflare-claude-ids.md) 与 [探针](../scripts/bench/cloudflare-model-ids.mjs)。归属链为生成目录 ID → 静态 profile → Cloudflare endpoint wrapper → Anthropic adapter/SDK → SSE settlement。既有 URL 占位符处理、model spread、请求数组/参数及异步工作不变；无新增运行时缓存、pool、worker、listener、controller 或 timer，不宣称吞吐提升。

证据目录 `.git/t05-3-cloudflare-claude-20261011/` 包含实施前设计、上游 diff、确定性迁移预览/脚本、修正后的基线 loader/复现、定向/关联/check/build/full/性能对照日志、汇总、PR 正文和状态。初始回归夹具错误假定 tiers 自动升序，改为断言既有输入顺序保留后重新执行基线与候选；未修改生产 tiers 逻辑。取消引用初次探针观察到的保留现象及 primitive reason/错误堆栈对照均完整留档。

提交仅含 6 个本类问题文件；README 原编辑 SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，未提交，本计划留在本地。测试目录按具体 mkdtemp 返回路径在 finally 清理；完整测试日志的临时根 `C:\Users\ADMINI~1\AppData\Local\Temp\super-pi-test-run-Z5YLYs` 已确认不存在。没有真实 Cloudflare/Anthropic 推理或服务端收费验收；Linux 待 CI。

### 29.1 PR #98 反馈修复：旧缓存 Claude ID 在合并前规范化（2026-10-11）

[P1 反馈](https://github.com/dragonbaba/super-pi/pull/98#discussion_r4238263460)成立：保留全局目录时间戳后，较新的持久目录仍可携带旧点号 ID；按 ID 精确匹配的合并会将它追加到连字符记录旁，离线、4 小时新鲜度窗口及 304 都无法消除无效条目。修复前在 `d12784d9f` 上新增回归共 27 项，其中 4 项失败，覆盖当前/旧 profile 缓存、304 覆盖层及真实 FileModelsStore → ModelRuntime 恢复。

生产修复只在 `profileRemoteModel` 已有目录入口增加一个条件块：Cloudflare + anthropic-messages + claude- 前缀 + 含点号时替换 ID。复用 strip profile 已创建的私有 raw 对象，不增加对象复制，不改输入/原始持久事实/ETag/时间戳。每次缓存恢复或 HTTP 200 接收都会在 profile 与 merge 前完成投影，因此旧源数据继续保留也不会再次暴露无效 ID。重复 canonical ID 保持既有后记录优先语义。

未将修正放入 provider.profileModel，因为 models.json/extension 显式模型也经过该 hook；显式自定义 ID（包括 `claude-custom-4.5`）应仍由用户控制。旧会话保存的点号目录引用按既有 missing-model 提示与回退处理，本次不引入别名或任意配置迁移。真实 runtime direct/Simple 请求验证回退后发送连字符 ID。

验证：27 项本类回归及合并后的 46 项相关测试通过，包含 4 次 loopback 304/200/304/400、重复 canonical 条目、未来/日期 ID、OpenAI/Workers/其他供应商隔离、旧缓存重开与 4 次 runtime 请求。类型检查、离线构建、git diff --check 通过。`npm test -- --jobs 4`：253 单元、4124 项，4032 通过、92 跳过、0 失败/取消。日志中的精确临时根 `C:\Users\ADMINI~1\AppData\Local\Temp\super-pi-test-run-zF4vQj` 已确认不存在；loopback server 和条目按所有权清理，无真实服务商推理。

性能：全生成器 AST 仅允许原始 ID 赋值变化；全 remote-provider AST 仅允许新增入口条件块，其余生产差异限于 Cloudflare JSON/manifest。40,000 次真实条件块执行产生 20,000 次字符串替换，20,000 次 canonical 输入不替换；新增对象/数组/闭包/构造语法点为 0。只有一个低频入口函数变化，请求/事件/delta 函数变化为 0。当前/旧 profile × 替换/清空覆盖 1,024 条记录，保留 4 组 registry/provider/store owner 时全部 3,076 个 WeakRef 释放。请求对照保留原有 caller lazy abort stack 边界：同样 11 个引用在读取仅夹具拥有的 reason.stack 前保留，之后 54 个全释放。

完整调用链及边界见更新后的 [性能报告](performance/cloudflare-claude-ids.md)。证据位于 `.git/t05-3-cloudflare-claude-20261011/review-1/`，原 README 编辑未改动。本次属于同一未合并 PR 的审查修复，提交 `1cc86fbfd2af33ca730e25b7f3f2b86da5fcc427` 已推送原 PR #98；推送后第一次评论调用遇到 GitHub EOF，读取评论确认未落地后重试成功：[再次请求 `@codex review`](https://github.com/dragonbaba/super-pi/pull/98#issuecomment-6099627110)，并[回复原审查问题](https://github.com/dragonbaba/super-pi/pull/98#discussion_r4238316923)。PR 正文已更新，Codex 摘要确认正在审查 `1cc86fb`；该 head 的 [CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38067303227)运行中。提交仅含运行时入口、回归、性能探针及报告 4 文件，README 和本计划未提交；本轮未合并或开始下一类别。

### 29.2 PR #98 最终复审确认与合并（2026-10-11）

本轮用户报告审查评论仍显示 👀。读取完整 review threads 后确认：[Codex 最终结论](https://github.com/dragonbaba/super-pi/pull/98#discussion_r4238343786)位于原反馈线程的回复中，明确审查 `1cc86fbfd2` 且未发现重大问题；摘要于 2026-10-11 01:29:52 JST 已标为 Completed，单独请求评论的 👀 未清除。不能仅以表情推断审查卡住或无问题。

该 head 的 [Linux/Windows CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38067303227)全部成功；完整读取确认只有已修复的旧缓存线程，无分页遗漏。核对后 resolve 历史线程，并按本轮授权使用 match-head-commit squash 合并，于 2026-10-11 02:25:26 JST 合并为 `076c36f44946a5e7c0644e09cc9aa864fa9cbb40`。T05.3 四个已核实子项均完成，随后基于该合并提交新建 T05.4 分支。

## 30. T05.4.1 Moonshot K3 默认缓存写入价格实施（2026-10-11）

当前官方证据推翻原“固定为 0”验收前提，详见更新后的 T05.4。国际/中国官方缓存说明均规定默认 5m 写入等于输入价，1h 为两倍；Chat Completions 的读、写、普通输入互斥。当前 models.dev 两个 Moonshot K3 记录均提供 input/output/cache_read/cache_write = 3/15/0.3/3；中国官方以人民币报价，本项目保留原有 USD 成本元数据约定，不引入货币换算。原上游提交与当前官方语义的冲突明确保留，不机械移植旧修复。

问题复现：适配器已有 `prompt_tokens - cached_tokens - cache_write_tokens` 拆分，随包 cacheWrite=0 导致默认写入少计，生成器也会接受缺失、零或冲突写入费率。最小基线 18 项中 15 项失败，涵盖实际生产生成器、随包模型和 direct/Simple 用量成本。

本轮生产实现仅修改生成期：复用 getModelsDevCost 拥有的基础/分层价格对象，对两个 Moonshot provider 的 `kimi-k3` 设置 cacheWrite=input。其余模型、转售商、Kimi Coding 订阅估值、输入/输出/读取价格及缺省继承不变。两个随包条目仅 cacheWrite 0→3，manifest 仅更新两项内容哈希；generatedAt、structureHash 和其他 37 个 provider 哈希不变。新鲜远端覆盖与显式用户覆盖仍保持优先，不强制改写任意旧持久价格。

验证：18 项本类及共 65 项相关回归通过；32 次离线 adapter send 覆盖双 provider × generated/shipped × direct/Simple × 混合/全命中/全写入/无缓存。类型检查、离线构建、git diff --check 和定向分配/GC 探针通过。完整 `npm test -- --jobs 4`：254 单元、4142 项，4050 通过、92 跳过、0 失败/取消；日志中的精确测试根 `C:\Users\ADMINI~1\AppData\Local\Temp\super-pi-test-run-4V9vI8` 已确认不存在。

性能门禁：完整生成器 AST 除成本表达式上移和 primitive 赋值条件块外与固定基线一致，所有生产运行时文件未改。对真实表达式/helper 的 AST 插桩计数：每 10000 次，无 tiers 都是 10000 对象；两 tiers 都是 30000 对象/10000 数组；基线/候选一致，新增条件块的对象/数组/闭包/构造/调用语法点为 0。双 provider direct/Simple × 成功/失败/取消共 12 请求，保留 12 caller controller 与 provider 时 96 个请求引用全部释放；4 次当前/旧 profile 缓存恢复与清空的 16 个引用全部释放。取消夹具用 primitive reason 排除 caller lazy Error stack 保留，生产取消逻辑未改。

另发现的 1h 响应头用量映射独立列为 T05.4.2，后续另开 PR；本轮不关闭整个 T05.4、不宣称已修复 1h 计费。完整证据位于 `.git/t05-4-moonshot-cache-pricing-20261011/`；链路、所有权和测量限制见 [性能报告](performance/moonshot-cache-pricing.md)。无真实推理或收费验收，README 编辑保持原 hash，本计划继续留在本地。

交付：基于 PR #98 的合并提交建立分支 `codex/t05-4-moonshot-cache-pricing`，提交 `c3674dd6d1716c9b62d969207a16755a5326adf6`，独立 [PR #99](https://github.com/dragonbaba/super-pi/pull/99)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/99#issuecomment-6100308941)，当前 Codex 摘要确认正在审查 `c3674dd`；[CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38072305127)已启动，待最终验收，未合并。提交仅含本类 7 文件；README 原修改及本地计划未提交。所有本地执行进程结束，测试目录已确认清理。

### 30.1 PR #99 最终验收与合并（2026-10-11）

本轮核对最终 head `c3674dd6d1716c9b62d969207a16755a5326adf6` 的 Linux/Windows 六个 CI 分片全部通过；[Codex 最终结论](https://github.com/dragonbaba/super-pi/pull/99#issuecomment-6100334680)明确对应此提交且没有发现主要问题。完整 GraphQL reviewThreads 为空且无下一页；无未解决反馈。按用户授权，以 match-head-commit squash 于 2026-10-11 04:11:26 JST 合并为 `1257a336fdbee6f97e0aa60e5a706fd4cae0501e`。随后基于该提交创建独立分支 `codex/t05-4-moonshot-long-cache-usage`。

## 31. T05.4.2 Moonshot K3 1h 缓存写入用量实施（2026-10-11）

再次核对双地区官方缓存说明：TTL 在首次写入锁定，请求字段无法确定实际计费档位；响应头 `Msh-Usage-Cache-Write-Tokens-1h` 才是本次实际长写入量。现有 calculateCost 已支持长写入按选中 input 费率两倍计价，但 Chat Completions 适配器未传入对应子集。初始 60 项生产适配器回归中 41 项在修改前失败。

实现仅在成功响应/重试边界读取一次头，保留 decimal safe integer primitive；仅适用于两个 Moonshot provider 的 `kimi-k3`。两处 usage 路径接收该数字，按正文非负总写入量限幅，填写现有 `cacheWrite1h` 字段；重复/累计 chunk 不累加。缺失或非法头维持既有默认价估计，不凭请求 TTL 推断。未修改请求 TTL、币种、目录、其他 API、转售商或订阅政策；类型和成本函数只更新注释。

69 项新增回归及合计 95 项相关测试通过，覆盖空 choices 最终用量、partial/重复用量、缓存全命中/零/混合写入、两种入口和 usage 位置、重试后响应头、请求与锁定 TTL 不一致、其他 provider 隔离及自定义分层/未知价格。类型检查、离线构建和完整 `npm test -- --jobs 4` 已通过：255 单元、4211 项，4119 通过、92 跳过、0 失败/取消；日志记录的临时根 `C:\Users\ADMINI~1\AppData\Local\Temp\super-pi-test-run-ptpEbN` 已确认不存在。

性能：完整 adapter AST 除明确的 primitive 接入点外与基线一致；其他生产 AST 无变化。实际头解析器 10000 次无应用对象/数组/闭包/构造分配；实际 usage parser + cost helper 每 10000 次仍是 20000 对象，无 tiers 时 10000 数组、有 tiers 时 0，前后相同。双 provider × direct/Simple × 成功/流中途错误/取消 12 请求，各有一个 delta、成功 5 个事件/失败或取消 4 个；响应头读取从基线 0 次变为每成功响应 1 次。已审查上下游 SDK、事件队列、cost、session 汇总和 compaction 链路；原有分配及所有权边界保留在[性能报告](performance/moonshot-long-cache-usage.md)。

GC 证据明确保留已有 SDK 限制：候选与旧版本对照均有 34 个中途错误请求引用被 SDK 的惰性 AbortError stack 保留；成功及 caller primitive abort 无此保留。仅探针读取 SDK reason.stack 后，保留 12 caller controllers 和双 provider 时两版全部 144 个监测引用释放。未将“读取 stack 后释放”误报为生产错误路径无条件释放。证据位于 `.git/t05-4-moonshot-long-cache-20261011/`，无真实推理或收费验收；README SHA256 保持不变，本计划仍仅本地保留。

交付：提交 `8ba914087aba45983291d00f5c9c5c74077793d6` 已推送独立 [PR #100](https://github.com/dragonbaba/super-pi/pull/100)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/100#issuecomment-6101248949)，[CI 六个分片](https://github.com/dragonbaba/super-pi/actions/runs/38079343922)已排队/启动，待最终 CI 与审查结论，未合并。提交仅包含本类 6 文件，README 与本地计划不在提交中；测试/构建/探针进程均已结束。T05.4 待本 PR 最终验收后关闭。

### 31.1 PR #100 审查修复：采样证据与 gitfile 兼容（2026-10-11）

本轮确认原 head `8ba914087` 的六个 CI 分片全部成功，但 Codex 有两项有效反馈：
[P1 缺少采样字节数及主要分配位置](https://github.com/dragonbaba/super-pi/pull/100#discussion_r4238898216)，以及 [P2 将 .git 错当目录](https://github.com/dragonbaba/super-pi/pull/100#discussion_r4238898217)。同一未合并 PR 内修复；生产计费代码未改动。

新增真实生产适配器的同机 V8 HeapProfiler 探针，1KB 采样间隔，包含已被大小 GC 回收的分配；双方相同转译/封装并预热，三组顺序交替对照，保存 24 个原始 profile。实际 Headers 解析中位数从基线近 0 增加为 48.75 字节/响应；escaping usage + cost 从 243.25 增加为 248.43 字节/update；SDK direct / Simple 全链路分别 8134.81→8063.23、7901.18→7826.11 字节/update，变化落在波动范围内，不宣称性能提升。报告列出每轮数值、主要位置和 JIT/采样限制，明确对象计数不变不等于字节零开销。

基准模块改用单独 mkdtemp 临时目录，相对及包导入都解析到当前 checkout，finally 按记录路径清理，失败导入也清理。实际 managed linked worktree 中先重现旧命令 ENOTDIR，再确认相同 --baseline 命令在修复后通过结构/生命周期门禁；另增两项 CI 回归覆盖 gitfile 与成功/失败导入清理。验证工作树 `C:\Users\Administrator\.codex\worktrees\moonshot-benchmark-gitfile\Pi` 已通过应用归档工具清理，主依赖目录完整。手动联接清理曾被自动审批拒绝；未重试该命令，改用正式归档工具完成。

验证：75 项聚焦测试、类型检查、离线构建、原结构计数与双版本 GC 对照全部通过。完整 `npm test -- --jobs 4`：256 单元、4213 项，4121 通过、92 跳过、0 失败/取消。精确测试根 `C:\Users\ADMINI~1\AppData\Local\Temp\super-pi-test-run-vE0d4b` 已确认不存在。SDK 既有 34 引用惰性栈保留及读取后 144 引用释放边界未改变。日志、原始采样和清理记录在 `.git/t05-4-moonshot-long-cache-20261011/review-1/`；README 原 hash 保持不变。

交付：修复提交 `215a05317e656df8de92cf99ad9b082a9ead2bec` 已推送原 PR #100，立即再次评论 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/100#issuecomment-6101436116)，并分别回复 [P1](https://github.com/dragonbaba/super-pi/pull/100#discussion_r4238951980) / [P2](https://github.com/dragonbaba/super-pi/pull/100#discussion_r4238952082)。PR 正文已更新；最终 CI/复审待完成，未合并。该修复提交仅含本类 5 个基准/回归/报告文件，生产运行时代码和 README 均未修改，本计划仍不提交。

### 31.2 PR #100 最终验收与合并（2026-10-11）

本轮用户授权合并并进入下一项。重新核对最终 head `215a05317e656df8de92cf99ad9b082a9ead2bec`：六个 [CI 分片](https://github.com/dragonbaba/super-pi/actions/runs/38080651743)全部成功，[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/100#issuecomment-6101456853)未报告重大问题。完整读取审查线程，只有已修复并已回复的两个历史反馈，均已 resolve；以 match-head-commit squash 合并，于 2026-10-11 09:59:39 JST 生成 `2beef1bad09661b35881294c4c48bfb1397910af`。T05.4 两类问题均完成验收，现关闭；随后从该合并提交新建 `codex/t06-1-streaming-ansi`。

## 32. T06.1 分块 ANSI 与命令输出一致性实施（2026-10-11）

问题类别：交互 `!` 与 RPC bash 共享输出链按 chunk 正则过滤，导致 CSI/OSC 被切开时漏出控制码片段，结束时还遗漏未刷新的 UTF-8 前缀。参考 [上游 27c7b6ff48](https://github.com/earendil-works/pi/commit/27c7b6ff48)；本实现按性能规范使用单个数字状态，无未完成字符串缓冲、match 数组或每块 wrapper。普通文本原样通过，控制序列仅丢弃，按可见连续区间生成输出；结束时丢弃未完成控制，UTF-8 刷新一次，flush observer 失败不被取消掩盖。控制块不进入滚动缓冲、日志或进度回调。

验收中另复现同类 chunk 依赖：大块可见输出后跟小块结尾，旧滚动逻辑整块丢弃导致结果仅剩结尾；改为精确裁剪超限前缀，保证保留同一尾部，完整日志仍先于裁剪写入。保留逻辑上限 102400 UTF-16 code units；不把 V8 slice 的 backing storage 误称为严格同值物理堆上限。成功/错误/取消均清空解析器、解码器、观察者和滚动引用，已结束的自定义 producer 回调失效。

源代码编辑前八项最小复现均失败；新增大输出反例也先确认失败再修复。最终新增 25 项覆盖逐字节切分、100 组确定性随机切分、长 CSI/OSC、C1/BEL/ST、非法控制恢复、中文/emoji/尾部 UTF-8、取消/异常/flush observer、日志一致性与精确清理、AgentSession 事件及交互组件。完整调用链、既有分配、可重跑 AST/GC/HeapProfiler 探针见 [性能报告](performance/bash-streaming-ansi.md)。T06.2 文件权限独立留待后续 PR；用户 README 编辑与本地任务计划不提交。

最终类型检查、离线构建及尾部修复后的 coding-agent 重建通过；最终完整 `npm test -- --jobs 4`：258 单元、4238 项，4146 通过、92 跳过、0 失败/取消。两轮完整运行根 `super-pi-test-run-A4aT8o` / `super-pi-test-run-EOY2lB` 均已确认不存在；探针的两个随机模块目录也按记录路径清除。README 保持 SHA256 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。

性能：热方法结构门禁每块闭包/对象/数组/new 都为零，原每块 decoder options wrapper 从 1 变为 0。12 个成功/错误/取消 command 在 producer 仍保留旧回调时，候选 48 个 decoder/parser/observer/callback WeakRef 全释放；旧版本 36 个保留到 producer 释放后才消失。三组交替真实 V8 采样的每输入块中位字节：plain 290.47→252.84，colored 433.31→397.90，split 239.94→172.86，实际交互渲染 41738.91→41820.54。小彩色块 p95 command-mean CPU 约 0.68→1.73 微秒，明确是有界正确性带来的额外扫描，不宣称整体加速。队列 20000 帧门禁与 flush 零引用通过，实际采样 112.12 字节/帧主要来自计时/夹具。全部原始 profile、结构/生命周期证据与最终源 hash 保留在 `.git/t06-1-streaming-ansi-20261011/`。

交付：提交 `9640b5d215efd99762afe97f212fe7564bc5eb9b` 已推送独立 [PR #101](https://github.com/dragonbaba/super-pi/pull/101)，创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/101#issuecomment-6104125923)。[Linux/Windows CI 六分片](https://github.com/dragonbaba/super-pi/actions/runs/38101391263)均已启动，最终 CI 与审查待完成，未合并。本类六个文件独立提交，README 和本地计划保持不提交；本地测试、构建及采样进程均已结束。下一独立项为 T06.2 临时输出文件安全创建。

### 32.1 PR #101 审查修复：stdout/stderr 状态隔离（2026-10-11）

旧 head 的六个 CI 分片全部成功，但 [P2 反馈](https://github.com/dragonbaba/super-pi/pull/101#discussion_r4239850087)有效：stdout 未结束的 OSC/CSI 会吞掉或改写期间到达的 stderr，反向也一样；共用 UTF-8 decoder 还可能拼接不同来源的残缺字节。本轮在同一未合并 PR 修复，不进入 T06.2。

`BashOperations.onData` 新增可选 primitive 来源，内置本地后端用两个命令级稳定回调标记 stdout/stderr，并在原 finally 删除精确 listener；旧的一参数消费者和 producer 兼容。executor 固定拥有两套 decoder/parser，根据来源选择，过滤后的可见输出按到达顺序进入既有日志、滚动缓冲和会话事件。未标记的自定义输出视为单条逻辑流，已合并的远程输出不能凭空恢复来源。结束先停接收，再逐路 flush；成功/错误/取消均清空两路引用。

修改前新隔离测试确认两路 OSC/CSI、UTF-8 和真实来源标签失败；最初模拟管道夹具错误地先发 close 后发 readable EOF，已修正夹具事件顺序，未放宽生产完整性判断。另修正了测试中只读 ChildProcess.exitCode 的静态类型。当前 106 项定向验证为 101 通过、5 平台跳过；新增 10 项隔离/兼容回归和 1 项 listener 配对门禁。既有日志和 AgentSession/交互组件夹具也改为在 stdout 控制序列中插入 stderr。

类型检查、离线构建和最终完整 `npm test -- --jobs 4` 均通过：259 单元，4249 项，4157 通过、92 跳过、0 失败/取消。固定双来源状态的 72 个 decoder/parser/callback/observer WeakRef 在 producer 保留回调时全部释放；每块仍无新增对象、数组、闭包、Promise 或 controller。两套真实 V8 对照分别使用原 main 和审查 head，共 72 个 raw profile；新增实际本地后端 + Node 管道夹具，包含来源回调与监听器清理，只有 spawn 模拟。对审查 head，中位字节/输入块 plain 255.89→253.27、colored 396.32→402.48、交互 42008.30→41927.45、本地管道 956.98→965.37；新路径保留原先被吞的诊断，不按不同正确性的输出宣称加速。详细采样、CPU、主要分配位置及主分支对照见性能报告。

20000 帧队列基准复核通过，flush 零引用/字节，应用级热分配计数保持 0；采样为 109.61 字节/帧，主要来自计时夹具。本轮证据在 `.git/t06-1-streaming-ansi-20261011/review-1/`；完整测试根 `super-pi-test-run-Z3CDnw` 和八个已记录模块目录均已删除，所有本地执行进程已结束。README hash 保持不变，本地计划不提交。

交付：修复提交 `c286830d9998773d97d9030dcde34ea808359eec` 已推送原 [PR #101](https://github.com/dragonbaba/super-pi/pull/101)，立即再次发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/101#issuecomment-6104327063)，并[回复 P2 线程](https://github.com/dragonbaba/super-pi/pull/101#discussion_r4239898273)。PR 正文已按当前实现与验证更新。最终 head 的[六个 CI 分片](https://github.com/dragonbaba/super-pi/actions/runs/38102984553)均已启动，CI 与复审待完成，未合并；本次仅提交本类八个文件。

### 32.2 PR #101 合并（2026-10-11）

最终 head `c286830d9998773d97d9030dcde34ea808359eec` 的六个 CI 分片全部成功；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/101#issuecomment-6104344707)明确未发现重大问题。已解决过期 P2 线程，按用户授权匹配该 head squash 合并，合并提交 `99d22f3013a62acf94070028a2526d02dd002992`，时间 2026-10-11T02:15:47Z。新阶段从该 main 建立独立分支 `codex/t06-2-secure-output-files`。

## 33. T06.2 用户 bash 临时输出安全创建与生命周期（2026-10-11）

交互 ! / RPC bash 的日志采用异步 `wx` + `0600`，仅成功 open 后取得精确路径清理所有权；碰撞/符号链接/打开失败不修改或删除已有对象。首次 spill 只创建一个 close waiter，捕获创建与异步 I/O 错误，返回结果前等待关闭；失败仅删除本次创建的文件，取消不能掩盖存储失败，生产者观察错误仍优先。每块无新增 Promise/controller/闭包/数组/wrapper；既有滚动尾部上限和写入内容保持。

14 个新回归覆盖正常/取消、POSIX 权限、碰撞/符号链接、创建/open/write/close 失败、真实本地进程排空、延迟关闭、错误优先级及低字节行截断。改动前三个创建/关闭反例失败。最终定向 120 项（115 通过、5 跳过），类型检查和离线构建通过；完整 `npm test -- --jobs 4`：260 单元、4263 项、4171 通过、92 跳过、0 失败/取消。测试根 `super-pi-test-run-nr9dbk` 已不存在。

扩展现有 benchmark 覆盖真实 120000 字节落盘；42 个最终 raw profile、确定性计数、GC与释放证据见本地 `.git/t06-2-secure-output-20261011/` 和[性能报告](performance/bash-output-file-security.md)。1354 个日志与四个模块目录逐个验证删除；72 个普通、84 个落盘 WeakRef 在 producer 保留回调时全部释放，settled stream 的队列字节和监听器归零。落盘中位分配 4534.65→4524.99 字节/块；局部管道最后 p95 5.214→6.392 微秒，前一次采样相反，已如实记录时序波动，不宣称整体加速。20000 帧队列应用级热分配计数为零，flush 零引用，实际采样110.18字节/帧。

Windows 实际 ACL 探针发现六个继承 Allow 条目（当前用户、SYSTEM、Administrators 和另外三个 SID），不能声称当前用户独占。本项落实排他创建、POSIX 权限及生命周期；新增 T06.3 独立处理 Windows 创建时私有 DACL，安排在 T07.1 前，范围包括普通 shell spill。审计确认普通 OutputAccumulator 已有 wx/0600；MCP 结果走有界 typed source/虚拟 artifact，不是上游二进制临时文件写入。用户 README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，README 与本地计划不提交。

交付：提交 `ab1bcd83d169e1111690da847234d4654008c822` 已推送独立 [PR #102](https://github.com/dragonbaba/super-pi/pull/102)，创建后立即评论 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/102#issuecomment-6104607233)。[Linux/Windows 六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38105180404) 已启动，最终 CI/审查待完成，未合并。只提交本类五个文件，README 与本地计划保持不提交；本地验证进程均已结束。

### 33.1 PR #102 合并（2026-10-11）

最终 head `ab1bcd83d169e1111690da847234d4654008c822` 的六个 CI 分片全部成功；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/102#issuecomment-6104629329)明确未发现重大问题，无遗留审查线程。按用户授权匹配该 head squash 合并，合并提交 `73a00c92f4038a00b14965e515ef8506ed2ab817`，时间 2026-10-11T02:36:01Z。新阶段从该 main 建立独立分支 `codex/t06-3-windows-output-dacl`。

## 34. T06.3 Windows 输出文件创建时私有 DACL（2026-10-11）

用户 bash 日志、普通 bash/PowerShell accumulator spill 及 `.sp-owned` 标记统一经过核心私有文件边界。Windows `CreateFileW(CREATE_NEW)` 在创建时提供保护的 DACL，仅允许当前进程用户 FullControl，并显式设置同一用户为 owner、禁止句柄继承。写入任何输出前读取实际 owner/DACL 核验；不支持所需安全属性则失败，无不安全回退。POSIX 保持排他 `wx/0600`。原生句柄通过当前 Node 导出的 `uv_open_osfhandle` 转成同一运行时的 fd，再核对 Node/native 文件身份，由既有 Node 流负责 write/writev/close。失败在仍持有的精确句柄上标记删除，避免按可替换路径回滚；未确认清理保留路径/原因诊断。

原生绑定和最大 172 字节不可变 descriptor 延迟到首次 Windows spill；不依赖扩展、不创建 worker、不做逐块 IPC。创建/核验为文件级同步工作，实测首次完整 204800 字节命令（包括加载）10.17ms。系统 ucrtbase 的 fd 表与 Node 不一致的初始候选已被实际 EBADF/身份核验拒绝；最终仅使用 Node 自身公开 libuv 转换，源码与 dist 探针均验证真实二进制 writev/stat/close。实测 Windows x64，arm64 ABI 布局受支持但未本机实测。

修改前 3 个真实 Windows ACL 反例失败；最终 20 个 Windows ACL/native 故障测试通过，覆盖宽松继承父目录、首字节前权限、显式 owner、无 native 的小输出、native 加载/token/核验/转换/身份/继承/回滚失败，以及 marker 创建/写入/stream 构造清理。31 项 AST/source 门禁通过。类型检查、离线构建通过；完整 `npm test -- --jobs 2`：263 单元，4285 项，4193 通过、92 平台跳过、0 失败/取消。最初四路并发触发 Windows V8 VirtualAlloc/Zone 内存失败，同期独立 Node 探针也无法分配；原有 worker 结束后以两路执行同一套测试全部通过，未放宽断言。

完整 producer→storage→progress→render→terminal→release 审计和 48 份真实 V8 profile 见[性能报告](performance/windows-private-output.md)。落盘中位分配：用户日志 4525.24→4561.19 字节/块（约 +0.8%），普通工具 5179.44→5272.73（约 +1.8%）；新增成本在创建/核验边界，每块没有新增 native 调用、IPC、Promise/controller/回调/wrapper/数组，不宣称整体加速。72 个普通与 84 个用户落盘 WeakRef、48 个 accumulator owner/stream WeakRef 全部释放；settled stream 队列/监听器和 native/token 所有权计数归零。1354 个用户日志、745 组工具日志/标记和六个精确记录的模块目录均已删除；完整测试根 `super-pi-test-run-g3nMpk` 已不存在。20000 帧 gate flush 零引用/字节，应用级热分配计数 0，采样 110.92 字节/帧主要来自计时夹具。

本地证据保存于 `.git/t06-3-windows-output-dacl-20261011/`。README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`；用户 README 与本地计划不提交。下一独立项仍为 T07.1 图片 worker 响应协议，待本项审查合并后进入。

交付：提交 `9b7b76891fb8545bb2c046bda3a35802927a051e` 已推送独立 [PR #103](https://github.com/dragonbaba/super-pi/pull/103)，创建后立即评论 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/103#issuecomment-6104815826)。[Linux/Windows 六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38106840260) 全部进行中，[Codex 审查](https://github.com/dragonbaba/super-pi/pull/103#issuecomment-6104816000) 已针对该 head 启动，尚未取得最终结果，未合并。本项仅提交十个相关文件；README 与本地任务计划保持不提交，本地验证进程均已结束。

### 34.1 PR #103 合并及剩余范围核对（2026-10-11）

最终 head `9b7b76891fb8545bb2c046bda3a35802927a051e` 的[六个 CI 分片](https://github.com/dragonbaba/super-pi/actions/runs/38106840260)全部成功；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/103#issuecomment-6104839728)明确未发现重大问题。完整审查线程查询为空，无分页遗漏。按用户本轮授权匹配最终 head squash 合并，合并提交 `215280db9b38fc2d5b093d77957978bc85c2b5dd`，时间 2026-10-11T03:28:20Z。T06 已全部关闭，本地 main 已快进到该提交；README 原有改动和本地任务计划保留且未提交。

本轮只合并并盘点剩余范围，没有启动新的实现。按本清单的固定版本基线，优先修复/核查仍剩 9 项：T07.1、T07.2、T08.1、T09.1、T09.2 为 5 项已复现或源码确认缺口；T07.3、T08.2、T09.3、T09.4 为 4 项待定向验证候选，未复现时应附证据排除，不能直接计为 4 个确定缺陷。下一顺序为 T07.1 → T07.2 → T07.3 → T08 → T09，每类成立的问题独立 PR 并评论 `@codex review`。

F01–F08 是另行决定采用范围的 8 组功能候选，不属于上述 9 项必做修复/核查；§5 的低优先级适配、§6 的上游 main 配置 schema/光标候选也未默认启动。已排除或有等效实现的条目不重复计入遗留问题。本次没有重新扫描更新的上游版本，也没有更新本机全局安装；合并记录不替代尚未执行的真实服务、真实终端或 Windows arm64 验证。

## 35. T07.1 图片 worker 协议实施与交付（2026-10-11）

独立分支 `codex/t07-1-image-worker-response`，候选 `c05d79fb3cc28fa64a0f0dbaf7b4b8ac60c08057`，[PR #104](https://github.com/dragonbaba/super-pi/pull/104)。创建后已立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/104#issuecomment-6105107482)，对应同一 head。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/104#issuecomment-6105118913)已完成，明确未发现重大问题；GraphQL 审查线程为空且 hasNextPage=false，无待处理意见或分页遗漏。[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38109154577)已全部进入 npm test，仍在运行中，未合并、未关闭任务、未更新全局安装。

先在基线 `215280db9` 调用公开 `resizeImage`，在真实 PNG worker 的结果前注入无关消息，复现提前返回 null。修复为共享 `image-resize-result` 响应类型、固定字段校验和持续监听，无关/畸形消息不触发完成或 fallback。有效 null、空字符串错误均正确区分；所有退出路径等待 worker terminate，再释放独占监听器。图片解码/缩放仍在 worker 中，已有 worker 失败 fallback 保留。

本地 Windows x64 / Node 26.4.0：定向测试 8/8、`npm.cmd run check`、coding-agent 包构建均通过。7 个父操作夹具逐个确认 1 次 exit、threadId=-1、message/error/exit 监听器为 0，另有直接 worker 协议夹具在 finally 等待终止；read 取消后迟到图片不会二次完成。没有重复本地全量测试；跨平台完整测试由规定 CI 执行。

设计门禁、实际生产调用链、复现与生命周期证据见 [实施记录](repairs/image-resize-worker-protocol.md)。本项仅改一次性图片准备的 worker 协议/生命周期，不改 provider/progress/render 热路径；忽略消息的固定字段检查不扫描/复制图片，不新增缓存、池、队列、计时器或控制器。没有用无关 benchmark 代替本项证据。resize API 原本无 AbortSignal/超时，仍不承诺即时中断 WASM；Bun 编译布局、真实终端未验收，T07.2/T07.3 未启动。原有 README 改动和此本地任务计划未混入提交。

### 35.1 PR #104 合并（2026-10-11）

用户授权合并并开启下一阶段后，重新核对 head `c05d79fb3cc28fa64a0f0dbaf7b4b8ac60c08057`、六个 CI 分片全部 success、审查线程为空且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `0caf5b6707051d36904dd5c0298c29cbcbfcb800`，时间 2026-10-11 12:48:51（Asia/Tokyo）。本地 main 快进后创建 T07.2 独立分支；README 原改动和本地计划保留，未更新全局安装。

## 36. T07.2 Kitty 非 PNG 图片实施与交付（2026-10-11）

独立分支 `codex/t07-2-kitty-image-formats`，候选 `7514271f5ff83455dc820d345dcb5809b6ebe9cc`，[PR #105](https://github.com/dragonbaba/super-pi/pull/105)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/105#issuecomment-6105236288)，对应同一 head；审查和[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38110152396)待最终结果，未合并。

在真实小型 JPEG 夹具上复现：Image 发送的 Kitty f=100 数据并非 PNG。新增公开 transcoder 注册入口，由 Kitty 启动阶段加载既有 Photon 并在扩展 session_start 前注册，await 后保留初始化代次检查。Image 构造或显式 invalidate 时准备，成功后用 PNG 及其尺寸替换原表示，不重复保留两份编码内容；失败每个转换器版本最多尝试一次，render 只输出已准备结果或文字占位。PNG/iTerm2 不调用转换器，现有工具图片转换、worker、滚动裁剪机制保留。

Windows x64 / Node 26.4.0：6 项定向行为/源码验证、61 项相关已有不变量/生命周期测试、类型检查、TUI 与 coding-agent 构建全部通过。未重复本地全量测试。配对基准 2048 次生产重绘中转码次数为 0，候选准备阶段为 1 次；帧 Promise/controller/wrapper/完整副本计数均 0，每帧物化 1 次，队列高水位 1。布局等既有采样开销 3609.87→3678.19 字节/帧，20000 帧纯队列 110.91→110.03 字节/帧；不据单次计时宣称加速。dispose 后上传条目/队列字节/布局所有权均为 0，Image WeakRef 经受控 GC 释放。

完整调用链、缓存容量/释放、源哈希、测量局限和命令见 [性能与实施记录](performance/kitty-image-formats.md)，raw profiles 与日志位于 `.git/t07-2-kitty-image-formats-20261011/`。转换器只持有 codec 模块，不捕获图片或 session；无全局图片缓存、对象池、计时器或新 worker。真实终端目视、Bun 编译布局未验证，T07.3 裁剪候选未启动。README 原改动和本地任务计划未提交。

### 36.1 PR #105 合并（2026-10-11）

用户授权合并并开启下一阶段后，重新核对最终 head `7514271f5ff83455dc820d345dcb5809b6ebe9cc`、六个 CI 分片全部 success、审查线程为空且无分页。Codex 对同一 head 的[最终审查](https://github.com/dragonbaba/super-pi/pull/105#issuecomment-6105254705)无重大问题。使用 match-head-commit 约束 squash 合并，合并 SHA `a0abead84df9ab30ce261e79d3a543cf41dd8b40`，时间 2026-10-11 13:13:09（Asia/Tokyo）。本地 main 快进后创建 T07.3 独立分支，未更新全局安装。

## 37. T07.3 WezTerm 图片覆盖行重绘实施与交付（2026-10-11）

独立分支 `codex/t07-3-wezterm-image-redraw`，初始候选 `d149ae7701fd62aaddf705ebf49c1466125e50b4`，[PR #106](https://github.com/dragonbaba/super-pi/pull/106)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/106#issuecomment-6105389408)，对应同一 head；[初次审查](https://github.com/dragonbaba/super-pi/pull/106#issuecomment-6105406686)无重大问题，但首轮六分片 CI 发现基准脚本源码不变量失败，修复及最终状态见 §37.1，未合并。

该候选从 V 升为 R：生产 TuiAltScreen + layout + frame queue 的夹具复现首帧图片后清行、覆盖行变更而图片首行不变时漏发 placement，以及实际 scroll 裁剪后的输出顺序问题。根因是 WezTerm 会擦除被后续清行/文字写入触及的图片单元。启动时检测 WezTerm，既有行比较循环用数字边界判断覆盖行变化，并在清行和文字后放置图片；显式裁剪 r 优先原始高度。沿用代次感知的上传缓存，普通 Kitty 增量文本路径保持原行为。无每帧变化数组、转码、池或新增图片内容缓存。

Windows x64 / Node 26.4.0：7 项定向行为/源码检查、66 项相关现有不变量/布局测试、5 项定向队列失败/取消/引用释放测试、类型检查及 TUI 构建全部通过。未重复本地全量测试。配对基准每场景 2048 帧：全屏 WezTerm 6749.18→6621.83 B/frame，普通 Kitty 全屏对照 6629.27→6483.89，覆盖行更新 2099.24→4737.43（从漏画到补发 2048 个 placement），覆盖范围外更新 2214.76→2484.19；warmup 后均无图片重传。纯队列 20000 帧为 108.98→108.38 B/frame。每帧 Promise/controller/wrapper/完整副本为 0，物化 1 次，队列高水位 1；flush/dispose 后相关计数归零，Image WeakRef 经受控 GC 释放。

设计门禁、完整调用链、已有/新增分配与控制头 regex 开销、源码哈希、峰值堆采样局限和命令见 [性能与实施记录](performance/wezterm-image-redraw.md)。raw profiles/logs 位于 `.git/t07-3-wezterm-image-redraw-20261011/`。所有测试/基准进程已退出，无新 worker/后台服务；未做真实 WezTerm 目视或 Bun 可执行文件验收。用户原有 README 改动和本地计划保留，未混入提交；T08.1 未启动。

### 37.1 PR #106 CI 修复（2026-10-11）

首轮 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38111340636) 的 Linux 2/2 和 Windows 4/4 均在 `source-invariants.test.ts` 失败：基准脚本有三处 `delete process.env...`，违反覆盖 packages/scripts 的统一源码规则；另两个分片被 fail-fast 取消，两个 Windows 分片已通过。本地同一测试准确复现。此前只运行 TUI 特定源码门禁，漏跑了全局源码不变量。

提交 `5634c3abb86e3a15924a5d539453e1a5d6987cb3` 将基准启动环境复制一次，使用空字符串屏蔽 inherited WEZTERM_PANE，在 finally 恢复原环境对象；生产源码和测量循环完全未变，不修改/豁免不变量。4 项全局源码不变量、类型检查通过；基准在预置 pane/program 环境下运行一次，四场景 placement 计数、零重传、Image WeakRef 释放及原环境对象/值恢复断言全部通过，生产源哈希与原性能证据一致。

已推送到原 PR，并再次发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/106#issuecomment-6105981252)；最终 head `5634c3abb86e3a15924a5d539453e1a5d6987cb3` 的[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38116068794)全部 success（Linux 2 个、Windows 4 个）。同一提交的 [Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/106#issuecomment-6106001570)无重大问题，审查线程为空且无后续分页。PR 保持开放待合并。原始日志与验证结果保存在同一 evidence 目录的 `ci-*` 文件中。未重复本地全量测试。

### 37.2 PR #106 合并（2026-10-11）

用户授权合并并开启下一阶段后，重新核对最终 head `5634c3abb86e3a15924a5d539453e1a5d6987cb3`、六个 CI 分片全部 success、同提交 Codex 无重大问题、审查线程为空且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `c46b4dd938908418c513d4c9889d328e1f1a8769`，时间 2026-10-11 14:59:51（Asia/Tokyo）。本地 main 快进后创建 T08.1 独立分支；未更新全局安装。

## 38. T08.1 多行语法高亮实施与交付（2026-10-11）

独立分支 `codex/t08-1-multiline-syntax-colors`，最终候选 `960729d5d1b22223a3337f5ed35b51703751db9d`，[PR #107](https://github.com/dragonbaba/super-pi/pull/107)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/107#issuecomment-6106116528)，对应同一 head。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/107#issuecomment-6106133470)已完成，未发现重大问题；GraphQL 审查线程为空且 hasNextPage=false，无待处理意见或分页遗漏。同一提交的[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38117155691)全部 success（Linux 2 个、Windows 4 个）。本地 CI 等待进程已正常退出，PR 保持开放待合并。

生产 theme/highlight.js/HTML renderer/Markdown 夹具复现多行 token 仅包一层颜色、后续行失色，以及嵌套 subst 继承外层字符串色。现在按换行偏移逐段格式化非空行，保留空行、CRLF、实体解码和 scope 回退；单行不切片，插值使用文本颜色。没有移植上游 split/map/join 临时数组。审计发现该 renderer 的旧全局 ObjectPool 缺少其准入性能证据，按契约移除，改为调用内 output/text 变量及一个作用域栈；重入独立，返回/抛错后不保留全局渲染状态，无新增池或高亮内容缓存。

Windows x64 / Node 26.4.0：6 项新定向检查，加 runtime utilities、全局 source invariants（含 scripts）、帧热路径和 Markdown 所有权共 40 项通过；类型检查及 coding-agent 构建通过。未重复本地全量测试。每场景 1024 次配对基准：单行 helper 523.62→553.30 B/call，多行 helper 505.38→938.58（formatter 从每 span 1 次变为每非空行 1 次）；Main 31796.09→35683.55 B/frame，Alt 27885.17→31231.05，纯队列 20000 帧为 107.80→109.35 B/frame。增加来自逐行颜色及下游 ANSI 处理；不宣称分配降低或单次计时加速。

两个生产场景高亮/物化均各 1024 次，帧 Promise/controller/wrapper/完整副本均 0，队列高水位 1；flush 后队列字节/引用为 0。dispose 后缓存和 Main/Alt final-render 计数清零，释放夹具所有者后 Markdown WeakRef 经受控 GC 回收；正常/重入与抛错的 formatter owner 同样释放。设计门禁、完整链路、已有/新增分配、峰值堆采样局限及源码哈希见 [性能记录](performance/multiline-syntax-colors.md)，原始证据在 `.git/t08-1-multiline-syntax-colors-20261011/`。无新 worker、主题 watcher 或后台服务；未做在线 provider、真实终端目视或 Bun 可执行文件验收。README 原改动和本地计划未混入提交；T08.2 未启动。

### 38.1 PR #107 合并（2026-10-11）

用户授权合并并开启下一阶段后，重新核对最终 head `960729d5d1b22223a3337f5ed35b51703751db9d`、六个 CI 分片全部 success、同提交 Codex 无重大问题、审查线程为空且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `6ae1f2e74e7c25bf63c5539d077c0b8f2d46751a`，时间 2026-10-11 15:46:14（Asia/Tokyo）。本地 main 快进后创建 T08.2 独立分支；未更新全局安装。

## 39. T08.2 全屏选区重建边界实施与交付（2026-10-11）

独立分支 `codex/t08-2-transcript-selection-reset`，最终候选 `1f60fd11137519db1c25d70c9e2734d2e3b8160c`，[PR #108](https://github.com/dragonbaba/super-pi/pull/108)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/108#issuecomment-6106431925)，对应同一 head。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/108#issuecomment-6106447219)已完成，未发现重大问题；GraphQL 审查线程为空且 hasNextPage=false。同一提交的[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38119611769)全部 success（Linux 2 个、Windows 4 个）。本地 CI 等待进程已正常退出，PR 保持开放待合并。

从 V 升为 R：生产 Alt 鼠标/布局和 InteractiveMode 重建方法的离线夹具复现，同一 ScrollView 内换掉内容不会触发布局转移清理，选区、连续点击与自动滚动仍指向旧坐标。新增同步 resetTextSelection，在 renderSessionEntries 的条目转换/渲染前调用，清空选区、连续点击、拖动、链接和自动滚动计时器；出现重建异常也不会恢复旧状态。普通流式更新与当前追加摘要式压缩不替换可见 transcript，因此保留选区；压缩条目后续重建经过统一重置边界。不新增池、缓存、持有者或逐帧调用。

Windows x64 / Node 26.4.0：6 项新定向行为/生命周期/AST 检查、33 项已有选区/帧热路径/全局源码/runner 检查、类型检查、TUI 与 coding-agent 构建均通过，未重复本地全量测试。GC 用例登记在标准 runner 的 GC_TESTS 中，在 CI 同样执行而非跳过。计时器同步销毁、迟到拖动/松开不复制新内容；TUI 和 ScrollView 仍存活时，四个旧选区对象 WeakRef 经 8 次事件循环/受控 GC 释放，reset/失败/dispose 后选区引用计数归零。

配对串行基准：5000 条 retained 内容、2048 帧普通选区路径，采样 58247.34→58599.33 B/frame；20000 帧纯队列 104.54→109.68。选区每帧访问/合成 11 行，viewport 访问 32 项，完成项重渲染 0；每帧物化 1 次，Promise/controller/wrapper/完整帧复制均 0，队列高水位 1，最终队列字节/引用与布局/合成引用归零。单次 CPU p95 0.1855→0.2253 ms 不用于声称加速或归因回退；frame 路径没有新增 reset 调用，新增边界的 AST 分配站点为 0。完整链路、已有分配、源码哈希与测量局限见 [性能记录](performance/transcript-selection-reset.md)，raw evidence 位于 `.git/t08-2-transcript-selection-reset-20261011/`。

仅提交五个相关文件；README 原改动 SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地任务计划均未混入提交。无新 worker/服务/主题 watcher；离线夹具不代替在线 provider、真实终端鼠标目视或 Bun 可执行文件验收。T09.1 未启动。

### 39.1 PR #108 合并（2026-10-11）

用户授权合并并开启下一阶段后，重新核对最终 head `1f60fd11137519db1c25d70c9e2734d2e3b8160c`、六个 CI 分片全部 success、同提交 Codex 无重大问题、审查线程为空且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `4a4d12f2e39fdbfec21abb04c7da103e85b12e86`，时间 2026-10-11 16:12:25（Asia/Tokyo）。本地 main 快进后创建 T09.1 独立分支；未更新全局安装。

## 40. T09.1 Codemode 未知工具发现提示实施与交付（2026-10-11）

独立分支 `codex/t09-1-codemode-tool-discovery-hint`，最终候选 `aa803e46575dd5df385563ce3dc51351ecf50709`，[PR #109](https://github.com/dragonbaba/super-pi/pull/109)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/109#issuecomment-6106588688)，对应同一 head。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/109#issuecomment-6106603192)已完成，未发现重大问题；GraphQL 审查线程为空且 hasNextPage=false。同一提交的[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38120812396)全部 success（Linux 2 个、Windows 4 个）。等待命令曾因 GitHub API EOF 退出，随后重新查询确认 CI 成功，该连接错误不是测试失败；无遗留等待进程。PR 保持开放待合并。

两个离线生产 worker/session 夹具复现错误提示推荐不存在的 searchTools(query)，并遗漏 describeTools 的等待要求。生产改动仅替换一条固定提示：按名称/描述检索 ALL_TOOLS，宿主提供 describeTools 时使用 await describeTools([names]) 获取声明。独立 Sandbox 不保证注入该 global，因此保留条件说明；没有添加同义 API，也没有改变别名、相似名称建议、成员检查、调用授权、输出限制或错误归属。

Windows x64 / Node 26.4.0：两个新增失败/恢复检查和三个已有目录/名称冲突检查通过，8 项 Codemode 热路径与 4 项全局源码不变量通过，共 17 项；类型检查、Codemode 包构建通过。运行时使用源码 worker，session 使用重新构建后的包；成功恢复能读取真实 fixture。未知工具没有分派任何 child call；失败/恢复后 activeExecutions=0，workersStarted=2、workersStopped=2，sandbox.close 已等待完成。已有 session fixture 负责关闭与精确临时目录清理，未遗留测试进程。

本项只改 VM 初始化捕获的诊断字符串，未知成员时追加到既有有界错误消息；无新增执行表达式、闭包、Promise、controller、集合、缓存、池或所有权状态，不触及 provider/progress/render/大结果热路径。已审计 Proxy→有界错误桥→host finish→worker terminate/listener 清理→session error result 与恢复链路。未重复本地全量测试、未运行与文本改动无关的分配基准。详见 [实施记录](repairs/codemode-tool-discovery-hint.md)，raw logs 在 `.git/t09-1-codemode-tool-discovery-hint-20261011/`。

仅提交四个相关文件；README 原改动 SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地任务计划均未混入提交。未做在线 provider 或 Bun 可执行文件验收；T09.2 内建对象防护、T09.3 输出边界与 T09.4 安装替换仍独立，未启动。

### 40.1 PR #109 合并（2026-10-11）

用户授权合并并开启下一阶段后，重新核对最终 head `aa803e46575dd5df385563ce3dc51351ecf50709`、六个 CI 分片全部 success、同提交 Codex 无重大问题、审查线程为空且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `b92d5df0140bacb008d8def133b9ec3dcda80e52`，时间 2026-10-11 17:26:58（Asia/Tokyo）。本地 main 快进后创建 T09.2 独立分支；未更新全局安装。

## 41. T09.2 Codemode 内建对象防护实施与交付（2026-10-11）

独立分支 `codex/t09-2-codemode-builtins`，最终候选 `12a6c53bb9b20f97af6215e9b56332d80858579c`，[PR #110](https://github.com/dragonbaba/super-pi/pull/110)。首个候选 d8b051bf3 创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/110#issuecomment-6107173633)，首轮六分片 CI 全部成功。审查指出宿主允许注入 JSON/Math 等名称但初始化冻结会使执行报错；探针复现后，在构造阶段明确拒绝 VM 内建/helper 名称冲突，真实 VM 名称表同时检查顶层 global 和 namespace，自定义 namespace 和 tools.Math 仍可用。修复已[回复并解决原线程](https://github.com/dragonbaba/super-pi/pull/110#discussion_r4240925327)，推送后立即[重新请求审查](https://github.com/dragonbaba/super-pi/pull/110#issuecomment-6107251494)。[最终提交的 Codex 复审](https://github.com/dragonbaba/super-pi/pull/110#issuecomment-6107276811)已完成，未发现重大问题；GraphQL 确认唯一原审查线程已解决且无分页。[最终候选 CI](https://github.com/dragonbaba/super-pi/actions/runs/38125868857) 六个分片全部 success（Linux 2 个、Windows 4 个），head 与复审一致。PR 保持开放待合并。

重新复现 Array/Object 原型 toJSON 修改导致 `Invalid Codemode store writes`，后续调用成功且 4 个 worker 全关闭。编码前比较独立安全序列化与启动冻结：独立编码仍需保护 Map/Promise/iterator，且改变原生 JSON 语义或额外扫描大结果；采用上游相关启动冻结与实例 override accessor，保留实例/用户类 toJSON、Date、Error 子类、宿主 globals 和原生 JSON 限额。严格改写及 defineProperty/setPrototypeOf 返回 script TypeError，无法描述的抛出值返回稳定 script 错误，不扩大到已经等效的 host 防护重写。

本地 39 项相关检查通过：24 项运行时、8 项 Codemode 热路径、4 项全局源码不变量、3 项真实 session；类型检查及 Codemode 包构建通过。新增 3 项 runtime + 1 项 session，原型成功/拒绝与恢复路径合计 12 个运行时 worker 全停止，activeExecutions=0；session 覆盖真实 read/show/callTool/describeTools 和成功提交、失败回滚。没有重复本地全量测试。

审查修复后重新运行 4 项 runtime、2 项 session 和 12 项热路径/源码不变量，共 18 项，构建与类型检查均通过；累计覆盖 40 个不同测试。新增真实 VM 名称表检查的 1 个 worker 同样关闭，四个新增 runtime 用例合计 13/13 worker 停止。静态保留名称沿用已有固定 Set，只在宿主模块启动创建，不新增热路径缓存或逐调用分配。

完整调用链和启动所有权见 [实施记录](repairs/codemode-builtins.md)。新增遍历只在每个 VM 的 lockdown 初始化执行，无逐调用/输出/帧的编码器、完整结果副本、池或缓存。最终修订重新串行测量，同机基线→最终 warm median 40.4603→42.1876 ms、p95 43.3090→45.3543 ms，host 采样分配 2502776→2715632 bytes；不以一次测量宣称加速或精确 VM 分配。两侧各 32 个 worker 全停止，128 个 host owner WeakRef 在五轮受控 GC 后全部释放；host 采样不覆盖 worker 内 QuickJS 堆。raw evidence 在 `.git/t09-2-codemode-builtins-20261011/`。

仅提交六个相关文件；README 原改动 SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地计划均未混入提交。首轮 CI 等待命令曾因 GitHub API EOF 退出，随后查询恢复并确认成功；该网络错误不是 CI 测试失败，无遗留等待或测试进程。未做在线 provider、真实终端或 Bun 可执行文件验收；T09.3/T09.4 未启动。

### 41.1 PR #110 合并（2026-10-11）

用户授权后，重新核对 head `12a6c53bb9b20f97af6215e9b56332d80858579c`、六个 CI 分片全部 success、同提交 Codex 复审无重大问题；唯一审查线程已解决且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `569961d6eb5830a26a0c113fbc82d764fa1e6427`，时间 2026-10-11 18:16:46（Asia/Tokyo）。本地 main 快进后创建 T09.3 独立分支；未更新全局安装。

## 42. T09.3 Codemode 输出边界验证与交付（2026-10-11）

独立分支 `codex/t09-3-codemode-output-boundaries`，最终候选 `50ec44a37f946870890916ed9ea1f4f083543d93`，[PR #111](https://github.com/dragonbaba/super-pi/pull/111)。首个候选 d2b9c5828 创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/111#issuecomment-6107563516)。首轮审查指出末尾空项与转换后图片断言缺失，均成立：复用原三个脚本，在混排输出末尾增加空项，明确断言 Mistral 裁剪末尾换行，并在十个适配器各自的实际 payload 位置检查唯一图片及原始数据。文档将保证收窄为非空输出间边界，明确 Mistral 外侧空白与 Bedrock 空块归一化。两条意见已回复并解决，推送后立即[重新请求审查](https://github.com/dragonbaba/super-pi/pull/111#issuecomment-6107637693)；最终候选[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38128891701) 全部 success（Linux 2 个、Windows 4 个），与复审对应同一 head。PR 保持开放待合并。

本项从 V 归为 E：通过真实 AgentSession 执行三个脚本，覆盖 text/中间与末尾空项/console JSON/多行/return、图片混排及失败前输出，再把下一回合实际 context 送入十个 API 适配器并在 onPayload 停止。Chat、Responses/Azure/Codex、Google/Vertex、Mistral 和 Anthropic 纯文本均已有换行；Anthropic 混排、Bedrock 与 Pi Messages 保留内容块边界。逐项精确比较结果文本、图片数据和保留历史，未复现非空输出无分隔粘连或重复包装，因此不改生产代码；不承诺精确保留空项或任意多行 text 调用的原始分组。

只增加一个集成检查及 [证据记录](repairs/codemode-output-boundaries.md)。新检查复用三次 VM 执行结果，十个 adapter 子项共报告 11 项；再运行已有 6 项 output/limit/recovery 检查、12 项热路径/全局源码不变量，共 29 项通过、0 跳过，类型检查通过。审查补强后仅重跑受影响的同一组 11 项和类型检查，全部通过，未增加 VM 执行次数。没有重复本地全量测试或无关构建；没有生产热路径修改，不运行无法对应改动的分配基准。输出限额保持原值，文本连接在归一化前只增加现有每边界一个换行，不增加完整结果副本、包装器、缓存或池。

最终候选 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/111#issuecomment-6107656467)已完成，未发现重大问题；GraphQL 确认两条原线程均已解决、hasNextPage=false。查询 GitHub 状态时曾遇一次 EOF，稍后正常恢复并确认 CI 全部成功；这不是 CI 测试失败，无遗留等待或测试进程。

证据边界是生产适配器的请求转换，未验证服务端分词、在线模型理解或多模态接收。既有 fixture 负责 session/worker 与临时文件的关闭清理；无新增后台服务或 watcher。原始日志在 `.git/t09-3-codemode-output-boundaries-20261011/`。原 README 改动与本地计划不混入提交；T09.4 未启动。

### 42.1 PR #111 合并（2026-10-11）

用户授权后，重新核对 head `50ec44a37f946870890916ed9ea1f4f083543d93`、六个 CI 分片全部 success、同提交 Codex 复审无重大问题；两条审查线程均已解决且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `b94c3e5e49985453b5afde17e15a81cf230347e2`，时间 2026-10-11 18:51:29（Asia/Tokyo）。GitHub 曾返回 EOF、SSH fetch 曾断开，先查询确认实际合并状态，再重试读取/拉取成功；未盲目重复合并。本地 main 快进后创建 T09.4 独立分支；未更新全局安装。

## 43. T09.4 Codemode worker 文件缺失恢复提示实施与交付（2026-10-11）

独立分支 `codex/t09-4-codemode-worker-recovery`，最终候选 `a5b2b47cce17375cd506841456e1fbc2f2ebea42`，[PR #112](https://github.com/dragonbaba/super-pi/pull/112)。创建后立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/112#issuecomment-6107811338)，对应同一 head。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/112#issuecomment-6107830911)已完成，未发现重大问题；GraphQL 确认审查线程为空且 hasNextPage=false。[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38130263136) 全部 success（Linux 2 个、Windows 4 个），对应同一最终 head。期间状态查询曾遇 EOF，间隔后恢复并确认成功；没有将网络查询错误视为测试失败，无遗留等待进程。PR 保持开放待合并。

从 V 升为 R：真实 worker 在隔离安装目录预热后移走目录，保留 URL 的下一次调用返回 Cannot find module，但没有恢复指引。源码入口、Codemode 惰性导入和默认 sibling worker 路径，以及 2026-10-05 的全局交付记录均已核对；不把旧全局记录当成本轮安装验收。最小修复仅在 worker 构造异常/致命 error 回调按 ENOENT、MODULE_NOT_FOUND、ERR_MODULE_NOT_FOUND 加有界提示：安装更新或替换后重启应用并恢复会话，持续失败则重建/重装。保留 sandbox 分类和原始诊断，不猜测新目录或重放脚本；无 pnpm 假设，不修改安装器或 WASM/包导入错误路径。

本地 20 项检查通过：源码/dist 真实 worker 的预热→入口缺失→依赖缺失→显式恢复，加普通错误识别、16,384 字符上限和同步非法入口共 4 个报告项；4 个已有正常/失败回滚/取消/关闭检查；8 个 Codemode 热路径与 4 个全局源码不变量。类型检查及 Codemode 包构建通过，未重复本地全量测试或无关构建。新夹具共 10/10 worker 停止，同步路径错误启动 0；失败后工具调用数不变、无输出/调用/提交写入，abort listener 与 activeExecutions 均归零，精确临时根在 close 后删除并确认不存在。

完整链路和取舍见 [实施记录](repairs/codemode-worker-recovery.md)。新增 helper 仅在启动/致命失败边界运行，不经过 provider delta、输出/调用消息、进度、渲染或大结果热路径。新增工作仅为有界诊断字符串，无新 Promise、callback、controller、计时器、集合、缓存、池或引用所有者；既有 finish 清空与等待终止机制不变。未为冷错误提示运行分配基准或受控 GC；确定性释放断言不冒充堆保留测量。

仅提交三个相关文件，README 原 SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地规划均未混入提交。原始日志在 `.git/t09-4-codemode-worker-recovery-20261011/`；没有改动真实全局安装或新增服务/watcher，未做真实交互会话或 Bun 可执行文件验收。F01–F08 功能候选仍需单独决定范围。

### 43.1 PR #112 合并（2026-10-11）

用户授权后，重新核对 head `a5b2b47cce17375cd506841456e1fbc2f2ebea42`、六个 CI 分片全部 success、同提交 Codex 审查无重大问题；审查线程为空且无分页。使用 match-head-commit 约束 squash 合并，合并 SHA `92cbab2d3480c6636d02157cf4d527d9cc75584b`，时间 2026-10-11 19:20:29（Asia/Tokyo）。本地 main 已快进同步；原 README 改动保留，本地规划未混入提交，未更新全局安装。没有新代码改动，未重复测试。

## 44. 下一阶段 F 类功能范围准备（2026-10-11，用户后续已选择 F01）

用户要求合并并继续下一阶段。T01–T10 已全部合并，§5 将 F01–F08 定义为单独确定采用范围的功能候选。已向用户询问按顺序实施 F01、先做 F08，或先整理全部候选采用建议；当时选择尚未返回，已完成 F01 只读核查。用户后续明确回复 F01，采纳以下两项拆分；不表示已批准全部 F 类功能。

现有事实：CLI `args.ts` 将 `--tools` / `--exclude-tools` 解析为精确名称列表；`main.ts` 传给 SDK，SDK 的显式 `tools` 优先于默认抑制，显式排除随后生效。`AgentSession` 在注册与动态刷新时统一过滤内建、扩展及自定义工具；Codemode 的 child 可调用集合仍受此边界限制。MCP bridge 在 session_start 加载/连接，并通过搜索与历史激活加入远程工具；只隐藏工具不等于停止 MCP 连接。现有回归入口为 `tests/codemode-session.test.ts` 的 SDK allowlist 用例和 `tests/mcp-background-activation.test.ts`。

建议按两个独立目标交付：

1. **F01.1 工具选择表达式。** 保留普通 `--tools read,grep` 的严格 allowlist 含义，扩展 CLI 的名称通配符与 `+/-` 表达式；只有修饰项时以当前默认集合为基集，存在普通正向项时以其匹配集为基集，再合并 `+` 项，最后应用 `-` 与 `--exclude-tools` 的排除。动态工具刷新必须再次遵守同一规则，不能借 Codemode 或 MCP 恢复绕开。保留 SDK 既有精确名称接口兼容。具体匹配语法、无匹配提示与 Windows PowerShell 默认选择在设计门禁中明确。
2. **F01.2 禁用 MCP。** 独立实现 `--no-mcp` 的 MCP 生命周期开关；应在连接/后台发现前生效，并阻止搜索和历史激活重新开启 MCP。与普通工具选择分开验收，明确 CLI/SDK 入口及禁用范围；不用名称前缀替代 MCP 来源身份，不删除配置或凭据。

采用项确定后按 §3.1 完成完整生产链与设计审计，以独立分支和 PR 按 §3.2 交付。后续实施记录见 §45–§46。

## 45. F01.1 工具选择表达式实施与交付（2026-10-11）

用户选择 F01 后，从 main `92cbab2d3480c6636d02157cf4d527d9cc75584b` 创建独立分支 `codex/f01-1-tool-selection-expressions`，提交 `d93ec9c02dbf6ef0a129abba4b20e002038edbe2`，[PR #113](https://github.com/dragonbaba/super-pi/pull/113)。首次创建请求遇 EOF，先查询确认未创建，再成功创建并立即发布 [`@codex review`](https://github.com/dragonbaba/super-pi/pull/113#issuecomment-6108173904)。[Codex 审查](https://github.com/dragonbaba/super-pi/pull/113#issuecomment-6108200100) 未发现重大问题；GraphQL 线程为空、无分页。[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38132829860) 全部 success，对应同一最终提交。PR 开放待合并。

CLI 新增全名称大小写敏感 `*`/`?` 和 `+`/`-`；普通正项保持严格名单，只有修饰项时从现有默认集合增减，排除最后生效。无匹配保持为空，延迟 MCP/扩展注册和 reload 再次应用同一策略；Codemode transport 不可被排除；通配符不能重新启用不可用 PowerShell。SDK 旧 tools/excludeTools 保持精确语义，新增 toolSelection 与其取交集，不扩大旧接口权限。详见 [设计与证据](repairs/tool-selection-expressions.md)。

8 项定向行为、12 项已有源码不变量通过，最后命令另匹配到 2 项已有 Codemode 检查，共 22 项通过，类型检查和 coding-agent 构建通过；未重复本地全量测试。真实 SDK/Codemode/MCP adapter、CLI services、动态注册、拒绝调用和重载均覆盖。规则所有者上限 256 项/单项 1,024/总 16,384 字符，无新缓存/池；匹配不进入常规流式/进度/渲染/调用链。分配采样促使改用索引遍历并去掉重复排除扫描；最终 2,560,000 次检查/1,280,000 次允许，采样 25,856 字节（不承诺稳定零分配）。实际 SDK 256 工具、128 child + Codemode、0 worker；session 仍存活时 dispose 后策略 WeakRef 经四次任务边界 GC 已释放。原始日志 `.git/f01-1-tool-selection-20261011/`。

## 46. F01.2 禁用 MCP 实施与交付（2026-10-11）

独立分支 `codex/f01-2-disable-mcp`，[PR #114](https://github.com/dragonbaba/super-pi/pull/114)，创建后立即[请求审查](https://github.com/dragonbaba/super-pi/pull/114#issuecomment-6108228422)。原独立候选 b2777eaa3 与 F01.1 在相邻 SDK/CLI 位置存在整合冲突，已本地整合并将 PR base 设为 F01.1；PR diff 仍仅 13 个 MCP 开关相关文件。最终候选 `6dd3467ac7bbc2376939bfbc96c3ea1f565c7e1d` 推送后立即[请求复审](https://github.com/dragonbaba/super-pi/pull/114#issuecomment-6108240069)。须先合并 #113，再将 #114 base 改为 main 并复核；本轮未合并任何 PR。

CLI --no-mcp / SDK noMcp:true 在 session_start 传递生命周期策略，MCP bridge 在配置/缓存/历史/连接/目录发现之前返回；reload/tree 不会激活历史。host 以 requiresMcp 标记过滤搜索与远程工具，显式激活或通配符不能绕过；普通 mcp 前缀名称不受误伤。配置、缓存、activation key 和历史保持不变，新开启的启用会话仍可恢复。第三方 bridge 可采用同一事件字段和标记，此开关不是任意第三方代码的隔离沙箱。详见 [设计与证据](repairs/disable-mcp.md)。

5 项定向行为 + 12 项源码不变量通过，类型检查和构建通过；整合 F01.1 后仅重跑受影响的 13 项行为并检查类型/构建，全部通过。实际本地 HTTP 禁用阶段新增 initialize/list/call 均 0；真实 CLI 配置 stdio 未启动，未生成 MCP key/cache。新状态仅 session/bridge 各一布尔值，启动有界事件副本，常规 context/事件/进度热路径不变，无新引用所有者、集合、池、定时器或 listener；不跑无关分配基准/GC soak。夹具关闭 session、HTTP server/连接和精确临时目录，原始日志 `.git/f01-2-disable-mcp-20261011/`。最终候选 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/114#issuecomment-6108258887) 未发现重大问题，GraphQL 审查线程为空且 hasNextPage=false；[最终 CI](https://github.com/dragonbaba/super-pi/actions/runs/38133351370) 六分片全部 success，对应同一最终 head。F01 两项交付验收完成，两个 PR 保持开放，未将旧候选检查沿用为新提交结论。期间 API 查询偶发 EOF，已核对实际状态后继续，不属于 CI 测试失败。

两个 PR 均保留用户 README 原 SHA256 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，本地规划未提交。未改真实全局安装，未做外部 MCP/OAuth 或真实终端验收；F02–F08 未启动。

## 47. F01 两项依次合并与下一阶段授权（2026-10-11）

用户确认两个 PR 没有问题并授权依次合并、开启下一步。PR #113 在已审查 head `d93ec9c02dbf6ef0a129abba4b20e002038edbe2` 上 squash 合并，main 提交 `14d6ef38412b0e99a3b20b0a1df639f236d740b0`，日本时间 21:43:53。PR #114 随后改以 main 为 base；消解前一项 squash 后的相邻行历史冲突，合并历史提交 `73a89889454cf007aceac2f054a8f933cbf4ede9` 的完整 tree `0a8a5cb0fa4606c6c2e29fd1c23861352ce49b83` 与原已审查 head 完全一致，未重复本地行为套件。

#114 新 head 推送后重新[请求 Codex 审查](https://github.com/dragonbaba/super-pi/pull/114#issuecomment-6109157679)，[结果无重大问题](https://github.com/dragonbaba/super-pi/pull/114#issuecomment-6109182803)，GraphQL reviewThreads 为空且 hasNextPage=false；[六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38140451823) 全部 success。确认 head 后 squash 合并为 `501a660683e7ebbcdc2b7c60673b085cdbf274dc`，日本时间 21:53:14。本地 main 已 fast-forward 至该提交。GitHub API 偶发 EOF 时先查询实际状态再重试，未重复创建或假定成功。

按下一步授权，从 main 创建 `codex/f02-1-mcp-project-overrides`，只推进 F02.1 项目级局部覆盖；交互 manager 和 CIMD 为独立验收目标，后续分开实施。原 README 改动与本地规划继续排除出提交，不更新真实全局安装。

## 48. F02.1 项目级局部覆盖实施与交付（2026-10-11）

基线 `501a660683e7ebbcdc2b7c60673b085cdbf274dc`；真实配置加载探针复现可信项目仅覆盖全局同名 server 的 toolTimeoutMs 仍被 duplicates global server id 拒绝。编码前记录设计门禁，见 [MCP project overrides](repairs/mcp-project-overrides.md)。先组合原始字段再按既有 normalizer 验证；数组/对象整字段替换，空值清除语义和 target 变化时不继承凭据规则均明确。两道信任门禁不变，项目目录参与 OAuth/schema/activation 身份，全局凭据键兼容，旧项目凭据保留但不复用。

15 项定向行为和 4 项源码不变量、类型检查通过；实际 loopback initialize/list/call 为 2/2/0，禁用阶段新增均 0；三个 OAuth 身份读取无网络请求，配置和凭据字节不变。仅修改配置加载及身份构建的低频链路，无常规远程调用、流式、进度、渲染热路径改动，无新增池/缓存/定时器/listener，未跑无关分配基准。夹具在 finally/after 关闭 OAuth owner、host、HTTP 连接并清理精确临时目录。日志 `.git/f02-1-mcp-project-overrides-20261011/`。已提交 `4cc16e003ec1b8e627decfcf6a18c10886d85236` 并创建独立 [PR #115](https://github.com/dragonbaba/super-pi/pull/115)，创建后立即[请求 Codex 审查](https://github.com/dragonbaba/super-pi/pull/115#issuecomment-6109291883)，并附加到当前任务。最终 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38141508738) 的 2 个 Linux / 4 个 Windows 分片全部 success，head 与上述提交一致；[Codex 审查](https://github.com/dragonbaba/super-pi/pull/115#issuecomment-6109321946) 未发现重大问题，GraphQL reviewThreads 为空且 hasNextPage=false。F02.1 实施与交付验收完成，PR #115 开放待用户合并授权。已核实日志中记录的 7 个夹具目录全部清理；README 哈希保持原值，工作区仅余原 README 改动和未跟踪本地规划。
## 49. F02.1 合并与 F02.2 启动（2026-10-11）

用户授权依次合并并开启下一步。当前仅 PR #115 待合并；再次确认 head `4cc16e003ec1b8e627decfcf6a18c10886d85236`、六分片 CI success、Codex 审查无重大问题、reviewThreads 为空且 hasNextPage=false，使用 match-head squash 合并为 `0486f3b04c34532f106f97f2e99812be2ec5d24a`，日本时间 23:38:55。API EOF 后先查询确认尚未合并，再重试成功；未假定第一次请求成功。本地 main 已同步，随后建立独立分支 `codex/f02-2-mcp-manager`。

## 50. F02.2 MCP 交互管理入口实施与交付（2026-10-11–12）

编码前探针确认已注册 status/tools/login/logout/reload 五个独立命令、尚无 `/mcp`，设计门禁见 [MCP manager](repairs/mcp-manager.md)。新增 `/mcp` 复用既有 selector 和认证所有权：查看服务器来源/状态/传输/工具，显式刷新快照，登录/登出及重载。查看工具不激活或调用；认证状态显示 URL，取消、关闭、重载均等待所属工作清理，迟到结果不通知或重载。配置编辑、持久开关继续使用配置文件，CIMD 独立待办；本项不自动登录或改写配置。

新增 8 项管理入口行为与既有 14 项相关认证/selector 回归，共 22 项不同检查，以及 4 项源码不变量、类型检查通过。真实 MCP initialize/list/call=1/1/0、新增激活 0、配置字节不变；取消关闭真实 OAuth callback 并清除 reservation。progress 最大同时 1 个 selector、初始/URL 两个视图、完成后 0，owner 关闭 1，迟到 UI/reload=0；真实 AgentSession 重载及锁等待清理通过；共享认证链既有受控 GC 检查 9 个 WeakRef 全部释放。初次测试夹具 excess-property 类型错误已修正，最终类型检查通过。

改动限显式命令/start/stop 边界，审计命令→selector→认证→OAuth/callback/文件锁→重载→shutdown/start 完整链；不修改既有渲染、provider、进度、普通远程调用热路径，无 polling、订阅、池或长期缓存，未重复本地全量或无关分配基准。原始证据 `.git/f02-2-mcp-manager-20261011/`；已提交 `c7229098164946c5ff4c8f0175dba20fa21a3278`，创建独立 [PR #116](https://github.com/dragonbaba/super-pi/pull/116)，创建后立即[请求 Codex 审查](https://github.com/dragonbaba/super-pi/pull/116#issuecomment-6110277272)，并附加当前任务。[CI](https://github.com/dragonbaba/super-pi/actions/runs/38149001237) 与审查运行中，尚不宣称验收完成。日志中的 22 个临时夹具目录已核实全部清理。原 README 哈希及未跟踪本地规划继续排除出提交，未更新真实全局安装。
### 50.1 CI / Codex 同源兼容夹具修正（2026-10-12）

初始 head `c7229098164946c5ff4c8f0175dba20fa21a3278` 的 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38149001237) 在 Linux 1/2 和 Windows 3/4 同时报告旧宿主兼容夹具缺少新静态依赖 manager.js，其余四分片因 fail-fast 取消。[Codex P1](https://github.com/dragonbaba/super-pi/pull/116#discussion_r4242022176) 指向同一问题。已本地复现 1 pass / 1 fail，随后将 manager.js 补入该夹具的明确复制清单，保留全部兼容断言；定向 2/2 通过。未扩展生产行为，也未重复其余本地套件；累计 24 项不同的行为/生命周期检查加 4 项源码不变量通过。

自审后提交并推送 `0c2aec68f78197fcd7443ac50bfa8475456d79e2`，立即[请求复审](https://github.com/dragonbaba/super-pi/pull/116#issuecomment-6110337018)，原审查线程 PRRT_kwDOUC6EIs6rOnVM 已解决，PR 正文补充兼容验收。最终 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38149440069) 的 2 个 Linux / 4 个 Windows 分片全部 success，对应 head `0c2aec68f78197fcd7443ac50bfa8475456d79e2`；[Codex 复审](https://github.com/dragonbaba/super-pi/pull/116#issuecomment-6110378696) 未发现重大问题。GraphQL 已确认唯一审查线程 isResolved=true、hasNextPage=false，无未处理意见。F02.2 实施与交付验收完成，PR #116 保持开放待用户合并授权。
最终仅提交 7 个 F02.2 相关文件。README SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地规划均未提交；工作区仅这两项原有/本地状态。兼容夹具的 finally 精确清理也已通过，未留下当前任务的后台服务或 watcher。首轮 CI 失败及修正已记录，未降低或删除检查；未做外部服务/真实人工终端登录验收，未改全局安装。F02.3 CIMD 留待下一项独立实施。
## 51. F02.2 合并与 F02.3 启动（2026-10-12）

用户授权合并并继续下一阶段。合并前复核 PR #116 head `0c2aec68f78197fcd7443ac50bfa8475456d79e2`、六分片 CI success、最终 Codex 无重大问题；GraphQL reviewThreads 唯一线程已解决且 hasNextPage=false。以 match-head 约束 squash 合并为 `3fdc4c32cb43b165205f2af6fc2c0548322b6409`，日本时间 00:32:20。同步 main 后创建 `codex/f02-3-mcp-cimd`。

F02.3 采用现有 SDK 1.32.1 clientMetadataUrl 接口，显式配置自有 Super Pi HTTPS 元数据和固定 callbackPort，保留已有客户端优先、服务端支持标志与 DCR 回退。仓库无已配置公开元数据托管地址，按可配置入口和 Super Pi 模板交付，不假设线上托管完成，不借用 pi.dev。开始生产代码修改前已记录性能设计门禁与 CIMD-only 基线失败；详见 [设计与证据](repairs/mcp-cimd.md)。本项不改常规流式/进度/渲染/工具调用热路径。
## 52. F02.3 CIMD 实施与交付（2026-10-12）

独立分支 `codex/f02-3-mcp-cimd`，候选 `31d66471bd00274a27e9934cd60e471cfef04a80`，[PR #117](https://github.com/dragonbaba/super-pi/pull/117) 创建后立即[请求 Codex 审查](https://github.com/dragonbaba/super-pi/pull/117#issuecomment-6110693220)。当前等待最终候选 CI 与审查，PR 未合并。

新增显式 oauth.clientMetadataUrl，必须为原样保留的规范 HTTPS 文档 URL（4096 字符上限），必须配套固定 callbackPort；不支持 credentials/fragment/dot-segment normalization。沿用 SDK 的已有/预注册客户端优先、广告支持时使用 CIMD、否则 DCR 回退。文档示例使用 Super Pi MCP 和本仓库 client_uri，无内置默认托管端点，部署者负责发布自有文档。凭据 issuer、项目作用域、URL/端口变化隔离、state/PKCE、存储锁与回调释放边界保持不变。详见 [设计及验证](repairs/mcp-cimd.md)。

CIMD-only 基线错误已复现；7 项新增定向用例 + 27 项受影响的既有 OAuth 回归 + 4 项源码不变量与类型检查通过。每条 CIMD-only 成功链 registration/exchange/refresh=0/1/1，普通登录前 token lookup discovery=0，reopen/refresh 新增 discovery=0；真实回调关闭，取消清空 reservation/cache 并可重试。没有本地全量重复测试、无关 allocation benchmark 或新热路径状态；生产新增 13 行配置和 1 行 provider 属性。原始证据 `.git/f02-3-mcp-cimd-20261012/`。README 用户改动哈希未变，本地规划不提交；未变更真实全局安装、未部署元数据或测试外部 OAuth 服务。

### 52.1 OIDC 审查核对（2026-10-12）

首轮审查认为普通 OIDC discovery 会丢弃 CIMD 支持标志。核对锁定 SDK 1.32.1 可见 OpenIdProviderMetadataSchema 明确定义该字段，Discovery schema 展开其 shape；与缺失 RFC9207 标志不同。新增自动发现探针在原生产实现上即通过：OAuth metadata 404 后确实请求 openid-configuration，缓存支持标志 true，没有 registration endpoint 仍完成登录/刷新。因此不采纳额外恢复标志的生产改动，保留有价值的定向回归。

仅测试和证据文档更新为 `7b9c9c1ce9470c77ae84a11ab905d42fa8f73928`，8 项 CIMD 用例及类型检查通过。已在[原讨论](https://github.com/dragonbaba/super-pi/pull/117#discussion_r4242168872) 回复源码与探针依据并解决线程，推送后立即[请求复审](https://github.com/dragonbaba/super-pi/pull/117#issuecomment-6110750246)。新候选 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38152607338) 与复审尚在运行；不沿用旧 head 的 CI/审查结论。

### 52.2 最终验收（2026-10-12）

最终候选 `7b9c9c1ce9470c77ae84a11ab905d42fa8f73928` 的 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/117#issuecomment-6110770916) 未发现重大问题；唯一审查线程已解决，GraphQL hasNextPage=false。[CI run 38152607338](https://github.com/dragonbaba/super-pi/actions/runs/38152607338) 六分片全部 success，运行 head 与 PR 最终 head 完全一致。最终本地 8 项 CIMD 定向用例、27 项受影响既有回归、4 项源码不变量和类型检查通过；后续仅测试/证据变更，没有重复生产无关测试。

PR #117 可合并且保持开放，等待用户授权。验收边界仍为可配置接入和自有 Super Pi 文档模板，公开元数据托管未部署、外部 OAuth 未实测。无全局安装更新，无新后台进程，临时资源按夹具所持路径与监听器清理。README 用户改动 SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`；本地规划未提交。GitHub CLI 两次状态查询 EOF 后改用公开 REST API 成功核对，没有将查询故障误记为 CI 失败。最终证据 `review-final.json`、`ci-final.json` 保存在 `.git/f02-3-mcp-cimd-20261012/`。F03–F08 未启动。
## 53. F02.3 合并与 F03.1 启动（2026-10-12）

用户授权合并并推进下一阶段。PR #117 最终 head `7b9c9c1ce9470c77ae84a11ab905d42fa8f73928` 的六分片 CI 全通过、Codex 无重大问题、唯一审查线程已解决且 hasNextPage=false。第一次合并请求返回 API EOF，查询确认仍 OPEN 后再以 match-head 约束合并成功；main 合并提交 `c41850fd60eb3ec4e2e11de7d362051bf83e7f5e`，日本时间 01:15:24。

独立分支 `codex/f03-1-tool-renderers` 已快进到合并 main。F03 分为独立 renderer、响应/工具耗时持久化（含 lazy setup timestamp 前置修正）、outputPad 展示范围核查；本轮只实施第一项，不混合不同验收目标。开始生产修改前已读取性能契约、记录 [设计门禁](repairs/tool-renderer-registration.md)，运行缺失 API 探针和生产 tool-leaf 基线。采用上游 resolver/next 接口，使用稳定 continuation 和可重入 primitive slots 适配本地分配约束，不复制上游 flatMap/递归闭包。独立展示注册不进入工具执行目录、不激活工具、不扩大 noMcp/工具选择权限。
## 54. F03.1 独立工具 renderer 实施与交付（2026-10-12）

基线为 PR #117 的合并提交 `c41850fd60eb3ec4e2e11de7d362051bf83e7f5e`。独立分支 `codex/f03-1-tool-renderers`，候选 `561df5799a55f274fea5f1748ce416e8595341e7`，[PR #118](https://github.com/dragonbaba/super-pi/pull/118)，创建后立即[请求 Codex 审查](https://github.com/dragonbaba/super-pi/pull/118#issuecomment-6111233573)，已附加当前任务。首个 [Codex 摘要](https://github.com/dragonbaba/super-pi/pull/118#issuecomment-6111266444) 报告无重大问题，当时线程为空；随后出现有效行内意见，见 §54.1。[初始六分片 CI](https://github.com/dragonbaba/super-pi/actions/runs/38156198243) 全部通过，但不作为后续修正提交的验收结论。

新增 registerToolRenderer 同步 resolver/next 接口及公共类型，展示查找独立于执行注册；实时行、历史恢复和 HTML 导出共用。保留 getToolDefinition 执行语义和旧 HTML getter；显式 read/Codemode 覆盖可替换专用展示，默认 read 仍分组。真实 session 证明失联/缺失工具不进入可执行、模型或激活目录，100 次进度不增加 resolver 调用。

6 项行为及 51 项相关工具叶节点/源码/AST/帧/retained 检查通过；最终命名整理后重跑 7 项受影响检查、类型检查及 coding-agent 构建，均通过，未跑本地全量。编码前已完成生产链审计和基线；100,000 次查找调用 200,000 次 resolver，runner 生命周期一个稳定 continuation，普通查找无新增闭包/列表/包装/Promise/controller/名称缓存/池。采样 13,296 字节，不宣称 V8 零分配。正常/失败查询 base 及失败加载 resolver 三个 WeakRef 在四个 GC/任务边界后全部释放；查询临时槽清空。帧队列 20,000 帧结构计数为 0，flush 后活动/待写引用及字节为 0。工具叶节点前后输出哈希和确定性计数相同，短时 profile 存在波动（image p95 0.0036 → 0.0066 ms），不宣称耗时等价或性能提升。

完整设计、数值与兼容边界见 [实施记录](repairs/tool-renderer-registration.md)，使用方式见 [独立 renderer](tool-renderers.md)。原始日志、提交前候选源码哈希、资源清理核查保存在 `.git/f03-1-tool-renderers-20261012/`；基准记录的 base SHA 与已提交候选通过源码哈希关联。未改真实全局安装，未做真实终端/provider 验收。用户 README 原 SHA256 保持不变，本地规划未提交。响应/工具耗时（含 lazy setup timestamp 前置修正）及 outputPad 保持后续独立目标。

### 54.1 内建工具 HTML 覆盖遗漏修正（2026-10-12）

最终复核发现首轮摘要之后新增一条 [P2 行内意见](https://github.com/dragonbaba/super-pi/pull/118#discussion_r4242360451)。核实成立：preRenderCustomTools 对 bash/read/write/edit/ls 硬跳过，模板 renderToolCall 又只在 default 分支读取预渲染 HTML。补充完整导出链设计审计，新增真实持久化导出加实际模板函数回归，原 head 在 both:bash 缺少预渲染 HTML 断言失败。

新增可选 hasRendererOverride 判定，只允许显式覆盖越过模板过滤；模板已有预渲染内容优先。普通内建和旧导出接口保留模板。新增用例覆盖五个工具的完整/仅调用/仅结果覆盖及默认模板；最终 7 项行为加 1 项 AST（8 项）、类型检查和 coding-agent 构建通过。修正限显式导出及其离线 HTML 视图，无 live delta/progress/帧链变更，不重复无关性能基准和本地全量。

修正提交 `eb60e7d61f67169d902489d2b799e4cc79d6a21d` 推送后立即[请求复审](https://github.com/dragonbaba/super-pi/pull/118#issuecomment-6111350908)，已在原意见[回复依据](https://github.com/dragonbaba/super-pi/pull/118#discussion_r4242385965)并解决线程；[新 CI](https://github.com/dragonbaba/super-pi/actions/runs/38157054670) 与复审等待完成。PR 保持开放。

### 54.2 导出按行保持 renderer 选择（2026-10-12）

复审指出 [同一导出行重复选择](https://github.com/dragonbaba/super-pi/pull/118#discussion_r4242400743)。意见成立，hasRendererOverride、renderCall、renderResult 原先各自解析，返回新对象/闭包状态的扩展会使用不同实例。先增强既有真实导出用例，每次解析返回新 renderer；修正前五行实际解析 15 次，断言失败。

新增仅由一次导出持有、以 toolCallId 为键的选择 Map，连 undefined 也保存，三个阶段共用；数量受已导出行数约束，与既有组件/state/args Map 同生命周期，导出返回/抛错后随 owner 释放，无进度/帧或全局缓存。最终四种导出变体均五次解析，调用与结果 renderer 身份一致；8 项相关检查、类型检查及构建通过。未为冷导出所有者额外宣称受控 GC 测量，既有热路径基准未变化。

新提交 `4282be490dea1992fc6e683b7f40e9a8efb5b5c9` 推送后立即[请求 Codex 复审](https://github.com/dragonbaba/super-pi/pull/118#issuecomment-6111420596)，在[原意见回复](https://github.com/dragonbaba/super-pi/pull/118#discussion_r4242410371)并解决线程。[最终候选 CI](https://github.com/dragonbaba/super-pi/actions/runs/38157579998) 和复审正在运行，尚待验收；PR 保持开放。

### 54.3 最终验收（2026-10-12）

最终提交 `4282be490dea1992fc6e683b7f40e9a8efb5b5c9` 的 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/118#issuecomment-6111454528) 无重大问题；重新核对两条审查线程均已解决，hasNextPage=false，无新增遗漏。[CI run 38157579998](https://github.com/dragonbaba/super-pi/actions/runs/38157579998) 的 2 个 Linux / 4 个 Windows 分片全部 success，运行 head、PR head 和本地提交一致。PR #118 为 OPEN / MERGEABLE / CLEAN，等待用户合并授权。

本地共 7 项行为与 51 项相关检查，最终导出修正后只重跑受影响的 8 项（7 行为 + AST）、类型检查和 coding-agent 构建，均通过，未重复本地全量或无关基准。热路径计数、分配采样和受控 GC 证据见 §54 及实施记录；后续导出修正不改变 live progress/帧链。13 个记录的临时目录全部不存在，未新建后台进程或改全局安装。用户 README 原 SHA256 保持不变，工作区仅余原 README 改动和未跟踪本地规划。

最终 CI/审查快照、候选源码哈希、资源清理记录保存在 `.git/f03-1-tool-renderers-20261012/ci-final.json`、`review-final.json`、`source-hashes-after-review.json`、`resource-final.json`。短时性能波动未被解释为性能提升；真实终端/provider 未验收。下一独立目标为 F03.2 响应/工具耗时持久化，先处理 lazy setup timestamp；outputPad 另行核查。

## 55. F03.1 合并与 F03.2 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 #118 最终 head `4282be490dea1992fc6e683b7f40e9a8efb5b5c9`、六分片 CI 全部 success、Codex 无重大问题、两条线程均解决且 hasNextPage=false。PR #118 于日本时间 2026-10-12 02:30:34 squash 合并为 `9fcbd5983973ba7be7942f570f9a7a27f83627e0`。

以合并 main 为基线创建独立分支 `codex/f03-2-duration-persistence`。修改生产代码前读取完整性能契约，记录 [设计门禁](repairs/duration-persistence.md)，运行缺失 duration/lazy timestamp 的失败探针及 stream/tool-leaf 基线。F03.2 只交付耗时持久化与渲染上下文，不加入新的默认 Took 展示或 outputPad 改动。

## 56. F03.2 耗时持久化实施与交付（2026-10-12）

助手流以单调时钟记录完成/错误耗时，转发保留已有值，早于流创建的历史/deferred 消息保持未知；lazy setup 失败 timestamp 改为请求开始。通过每个流一条仅含两个数字的 WeakMap 记录保持 EventStream 结构类型兼容，完成/end 删除，逐 delta 不读时钟、不增加包装对象。工具只测量实际 execute，排除前置策略/输入验证与后续 progress drain/result hook；已执行的正常、失败和取消保留耗时，未执行调用保持 undefined。

duration 贯通消息、工具结束事件、扩展事件、实时/延迟 read/历史 renderer context 与 HTML。结果生产者不被改写，旧记录不补估算；分组 read/Codemode 保留现有紧凑布局。独立 server protocol v1 继续省略宿主 timing 元数据，只更新字段穷尽清单，不扩大 wire schema。

64 项定向行为/源码/AST 检查、全仓类型检查以及 AI 离线、agent-core、coding-agent 构建通过。stream 100000 deltas 时钟读取为 0，队列/等待者清空，10 个 WeakRefs 在 4 次任务/GC 边界后全部释放；tool-leaf 四类最终哈希与确定性分配计数不变，短时采样结果及边界详见设计文档。20000 帧 queue 探针的闭包/Promise/controller/wrapper/完整副本为 0，结束后 active/pending 引用和字节为 0。证据位于 `.git/f03-2-duration-persistence-20261012/`；没有运行全量本地测试或更改全局安装。待独立 PR 的最终 head CI 与 Codex 审查闭环后验收。

候选 `f0b07ca4a6ad9de4531a8c9fc34625aad06f2754` 已推送并创建 [PR #119](https://github.com/dragonbaba/super-pi/pull/119)，创建后立即发布准确文本 [@codex review](https://github.com/dragonbaba/super-pi/pull/119#issuecomment-6111888984)，已附加当前任务。首次 SSH 推送因连接中断失败，核实远端分支不存在后改用临时 HTTPS 参数成功；没有改写全局 Git 配置或重复创建 PR。CI 和审查等待结果，PR 尚未验收或合并。

### 56.1 审查兼容性修正（2026-10-12）

首轮审查提出三项有效意见：普通 EventStream 缺少计时、冻结终态消息写入抛错、pi-messages 本地失败仍使用结束 timestamp。对应失败探针和修订前设计记录已保存。计时下移至已有 EventStream 终态分支，每个流保留两个原始时钟数值，移除 WeakMap 和子类 override，保留结构类型兼容；普通结果不处理。助手终态只浅拷贝消息/事件外层，不改写冻结生产者，不复制 content/usage，已计时/历史结果保持身份。pi-messages converter 与本地失败统一使用请求开始 timestamp。

修订通过 66 项定向检查、35 项 provider 兼容/ownership 检查、类型检查及三个包构建。10 万 delta 身份不变、时钟读取 0；新增终态外层分配为消息 1、事件 1，end-only 为消息 1，AST 门禁限制在精确完成分支。19 个原消息/终态消息/流 WeakRefs 在完成、错误、取消、有结果 end、无结果 end 与放弃路径全部释放。最终 leaf 确定性计数和四类哈希不变，queue 的所有零分配/引用计数通过。详细采样与边界见修订后的设计文档和 `*-review.json`；下一步推送复审，旧 head CI 不代替最终候选验收。

修订提交 `c95c90459` 已推送，随即[请求 Codex 复审](https://github.com/dragonbaba/super-pi/pull/119#issuecomment-6112009290)。已在三条意见中分别回复修复与验证证据并解决线程：[普通流](https://github.com/dragonbaba/super-pi/pull/119#discussion_r4242615260)、[冻结终态](https://github.com/dragonbaba/super-pi/pull/119#discussion_r4242615377)、[pi-messages timestamp](https://github.com/dragonbaba/super-pi/pull/119#discussion_r4242615469)。PR 正文已按最终设计、101 项相关检查和修订后性能数据重写，最终 CI/复审等待中。

### 56.2 最终验收（2026-10-12）

最终提交 `c95c90459c962f88966bc5052c35d4894e328c88` 的 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/119#issuecomment-6112043210) 无重大问题；重新核对三条审查线程均已解决，hasNextPage=false，comments/reviews 也无分页遗漏。[CI run 38162091979](https://github.com/dragonbaba/super-pi/actions/runs/38162091979) 的 2 个 Linux / 4 个 Windows 分片全部 success，CI head、PR head 与本地提交一致。PR #119 为 OPEN / MERGEABLE / CLEAN，等待用户合并授权。

最终证据为 `.git/f03-2-duration-persistence-20261012/pr-final.json`、`ci-final.json`、`review-final.json`、`source-hashes-review.json`、`resource-final.json`。查询期间 GitHub API 短暂 EOF，最终通过完整 PR check rollup 与 run API 交叉确认，没有将查询中断当成 CI 失败。三个已记录临时目录全部不存在，没有遗留本任务后台进程。README 用户改动 SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`；本地规划未提交。性能与生命周期门禁通过，短时采样不宣称性能提升；真实 provider/终端未实测。下一独立目标为 F03.3 outputPad 展示范围核查。

## 57. F03.2 合并与 F03.3 启动（2026-10-12）

用户本轮授权“可以合并，然后下一阶段”。合并前重新确认 PR #119 最终 head `c95c90459c962f88966bc5052c35d4894e328c88`、六个 CI 分片全部成功（run `38162091979`）、[最终 Codex 审查无重大问题](https://github.com/dragonbaba/super-pi/pull/119#issuecomment-6112043210)，三个审查线程已解决且分页完整。于日本时间 2026-10-12 03:14:51 squash 合并为 `8966e9be872056c6e2050336dd7096436d64129d`。

main 快进后创建独立分支 `codex/f03-3-output-padding`。依据固定 v1.1.0 比较与本地复现，确认已有 outputPad 的工具、命令、摘要/技能和 fallback 盒子缺少应用；运行中切换遗漏工具与 pending 命令。修改前记录[设计门禁](repairs/output-padding.md)，五组探针失败并采集 tool-leaf 基线。沿用 0/1 设置，新增 primitive 参数及缓存失效，不迁移会话或扩展无关设置。

## 58. F03.3 outputPad 应用范围实施与交付（2026-10-12）

已覆盖实时/历史工具、分组 Read、Codemode 外壳、自绘 edit、`!`/`!!` 输出、摘要/技能、自定义消息 fallback 与自定义 entry 错误 fallback。上下文新增可选 outputPad（宿主提供，旧上下文默认 1），HTML 保持导出默认 1。运行切换直接更新 chat/pending 现有组件，更新 retained settingsVersion 与高度索引，不重建运行状态；args-only renderer 标脏刷新。

本地 81 项相关定向/回归检查通过（首轮 80 项后扩充并重跑六项 padding 用例）；typecheck 与 TUI/coding-agent 构建通过。生产 tool-leaf 前后确定性计数一致；queue gate 的 Promise/controller/wrapper/full-size-copy 均为零，flush 后引用/字节为零。专门生命周期 fixture 的 20 个 Loader owner 清零、100 个弱引用全部回收、40 个相同 padding 调用命中缓存。完整采样数值与复现命令见[验证记录](repairs/output-padding.md)，原始证据位于 `.git/f03-3-output-padding-20261012/`。短时分配采样存在波动，不宣称性能提升；未跑本地全套或真实 provider/终端。README 用户改动保持原 SHA256，本地规划不提交。独立 [PR #120](https://github.com/dragonbaba/super-pi/pull/120) 已创建，head `e29ac93dd71b23ee56aff5563a4cfe79acf38969`，随即发送 [@codex review](https://github.com/dragonbaba/super-pi/pull/120#issuecomment-6112259846)。CI 与审查进行中；F04 未启动。
### 58.1 交付自查补充

保持原地更新时，本地辅助视觉结果和错误提示的 plain Text 不再经过原来的 history rebuild，需同样参与 outputPad setter。使用无新增状态的 Text 子类接入两处显示，保留行身份和底层缓存；技能历史夹具修正为生产解析格式并断言实际组件。36 项受影响检查、typecheck、coding-agent 构建通过。提交 `7c8fa09ff` 已推送，随即再次发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/120#issuecomment-6112279406)，最终 CI/审查待完成。没有扩大到 F04。
### 58.2 Codex 审查修正：工具内联图片

最终提交 `7c8fa09ff` 六个 CI 分片全部通过，但 [Codex P2](https://github.com/dragonbaba/super-pi/pull/120#discussion_r4242722458) 指出工具图片为独立子节点，text shell 边距不影响图片。核实成立，修改前补设计门禁、失败探针与 image production 基线；在 Image 增加默认 0 的 primitive padding，工具提供设置值并原地更新，分组 Read 保留预览缩进。Kitty ID、图片实例、已准备源与缓存所有者保持；cache miss 才构造行前缀，不引入包装组件或热路径闭包/数组。

75 项相关图片/渲染/AST 检查通过，增强后的七项 padding 用例覆盖 Kitty Alt 与 iTerm Main 实际帧，typecheck 和两个包构建通过。三组各 2048 帧的 image benchmark（修改前、修改后 pad=0、pad=1）计数门禁全部通过，GC 回收 image owner，最终缓存/队列引用与字节为零；详细采样见 repairs 文档。修正提交 `dd0ee6fb6` 已推送，随即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/120#issuecomment-6112382865)，并[回复证据](https://github.com/dragonbaba/super-pi/pull/120#discussion_r4242742800)、解决该线程。新 head 的 CI/复审仍待完成，不能沿用旧 head 通过结论。
### 58.3 Codex 复审修正：排队消息预览

`dd0ee6fb6` 六个 CI 分片全部通过，但[第二条 P2](https://github.com/dragonbaba/super-pi/pull/120#discussion_r4242765516) 指出 steering/follow-up 预览及 dequeue hint 使用 hard-coded TruncatedText padding。复现成立，新增 primitive setter 和无状态 output adapter，三处构造使用当前设置，保留截断与排队语义。修改前更新设计门禁与失败探针；八组 padding 用例和相关源码门禁共 38 项通过，typecheck/两个包构建通过。生命周期增加 TruncatedText owner 和 40 次设置更新，120 个 WeakRef 全部回收。

修正提交 `8baf332df08c51f0f66c9e36647d2445184f7b29` 已推送，立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/120#issuecomment-6112471267)，[回复证据](https://github.com/dragonbaba/super-pi/pull/120#discussion_r4242774277)并解决线程；最新 CI/复审仍待完成。状态/header chrome 和扩展 widget 属于独立 UI，本次不扩大其布局设置。
最终 head `8baf332df0` 的 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/120#issuecomment-6112499584) 于 2026-10-12 03:54:49 JST 完成，无重大问题。两个线程均已解决且分页完整；对应 CI 仍在运行，尚未记为最终验收通过。
### 58.4 最终验收完成

最终提交 `8baf332df08c51f0f66c9e36647d2445184f7b29` 的 [CI run 38165585280](https://github.com/dragonbaba/super-pi/actions/runs/38165585280) 六个分片全部通过（Linux 2/2、Windows 4/4），PR check rollup 交叉确认全部 SUCCESS；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/120#issuecomment-6112499584) 无重大问题，两个线程均解决且分页完整。PR #120 为 OPEN / MERGEABLE / CLEAN，保留待用户下一次合并授权。F03.3 实施与交付验收完成；下一独立目标为 F04.1 `samplingParamsByThinkingLevel`，Azure Foundry 兼容另拆目标。

最终证据 `pr-final.json`、`ci-final.json`、`review-final.json`、`source-hashes-final.json`、`resource-final.json` 位于 `.git/f03-3-output-padding-20261012/`。无新增后台服务或遗留终端会话，本轮测试/benchmark 进程均已退出，fixture 的计时器与引用按自身 owner 清理。README 用户改动 SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`；规划继续作为本地未跟踪文件。未更新全局安装，未进行真实 provider 调用或实体终端视觉验收。
## 59. F03.3 合并与 F04.1 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 PR #120 最终 head `8baf332df08c51f0f66c9e36647d2445184f7b29`：六个 CI 分片 SUCCESS、Codex 同 head 无重大问题、两个线程均解决、分页完整，状态 CLEAN / MERGEABLE。使用 match-head squash 合并，于 2026-10-11T19:11:58Z（JST 2026-10-12 04:11:58）生成 `494e790145b20fd7e55927143d0b82f3566817b4`。本地 main 快进后创建独立分支 `codex/f04-1-thinking-sampling`。

F04.1 仅实施 `samplingParamsByThinkingLevel`；Azure provider 名称/认证/模型/session 兼容仍属下一独立目标 F04.2。实施前设计门禁见 [thinking-level-sampling](repairs/thinking-level-sampling.md)：变更限配置组合和单次请求准备，不改 provider delta、事件、TUI、帧或大结果估算；新增字段随 model owner，合并记录随 request owner，无缓存/池/后台资源。固定上游仍为 v1.1.0 `abe508e1b89912adde45528136c3221eb69acdd7`，未重新追踪浮动上游。

离线真实适配器夹具在修复前 8 组失败（默认值未按等级覆盖、配置组合丢字段）；原始证据 `.git/f04-1-thinking-sampling-20261012/baseline.log`。实现按模型默认、有效 Pi 等级、请求参数逐键覆盖；保留能力过滤与最终 onPayload，modelOverrides 最终层逐等级合并及 OAuth 深复制隔离。本地 README 用户改动与规划继续排除提交。
## 60. F04.1 独立 PR 交付（待最终 CI/审查）

提交 `b131a070a6785db246cef9bcd44d3db218063b0f` 已推送并创建 [PR #121](https://github.com/dragonbaba/super-pi/pull/121)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/121#issuecomment-6112728191)。本地 Windows / Node v26.4.0：65 项相关行为回归、4 项源码不变量、npm run check、AI offline/coding-agent/server 三个包构建通过。变更为请求初始化和配置组合，不触及流式热路径；未运行全量本地测试或无关帧 benchmark。公开配置与证据文档已随 PR 交付。

当前 head 的 CI run `38167410682` 已启动（Linux 两分片、Windows 四分片），Codex 已请求，结果未完成。不得以本地通过代替最终 CI/审查；PR #121 保留开放，未取得其合并授权。本地工作树只有用户 README 修改和本地规划；README SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。

### 60.1 Codex 审查修正：采样与实际 effort 一致

[Codex P2](https://github.com/dragonbaba/super-pi/pull/121#discussion_r4242884648) 指出 direct Responses 在显式 capability 排除 off 时，采样回退 high 而 payload 仍为 none。生产夹具复现 Responses/Azure 的 none，以及同根因 Chat 的 effort 缺省。修正前三组均失败，设计门禁先记录于 repairs 文档；修正后，三个请求构造器在 provider 映射前夹取 Pi 等级，并用同一等级选择采样；Chat 所有格式和预算分支共用已规范化的 request-local options。

最终修正提交 `c34485baef8f5578818a406af73b76c9f5d7cacc`，43 项受影响采样/能力测试加 18 项 Together/source 检查通过，typecheck 与 AI offline 构建通过。未改动的配置/profile/请求估算保留前次通过证据。随推送立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/121#issuecomment-6112804822)，[逐条回复](https://github.com/dragonbaba/super-pi/pull/121#discussion_r4242895106)并解决线程。新 head 的 CI 和复审待完成，旧 head 结论不沿用。

`c34485baef` 的 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/121#issuecomment-6112825015) 于 2026-10-11T19:27:44Z 完成，未发现重大问题。唯一线程已解决，reviews/comments/threads 及线程评论分页完整。最终 CI run 为 `38167968815`，仍在运行；审查证据保存为 `.git/f04-1-thinking-sampling-20261012/review-final.json`。

### 60.2 F04.1 最终验收完成

最终提交 `c34485baef8f5578818a406af73b76c9f5d7cacc` 的 [CI run 38167968815](https://github.com/dragonbaba/super-pi/actions/runs/38167968815) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run headSha 与 PR head 一致；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/121#issuecomment-6112825015) 未发现重大问题。唯一审查线程已解决，所有分页完整。PR #121 为 OPEN / MERGEABLE / CLEAN，等待用户下一次合并授权。下一独立目标为 F04.2 Azure Foundry Chat Completions，须兼容旧 provider 认证、模型键、设置和 session。

证据 `.git/f04-1-thinking-sampling-20261012/` 包含 `pr-final.json`、`ci-final.json`、`review-final.json`、`source-hashes-final.json` 及本地检查日志。当前任务没有新增常驻进程、worker、worktree 或服务；测试的自身临时目录已随注册 cleanup 释放，本地命令均退出。没有真实 provider 调用、全量本地测试或全局安装更新。README 用户修改与未跟踪规划继续保留，未进入两个提交；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。
## 61. F04.1 合并与 F04.2 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前核对 PR #121 最终 head `c34485baef8f5578818a406af73b76c9f5d7cacc`：六个 CI 分片 SUCCESS、Codex 同 head 无重大问题、唯一线程已解决、分页完整。match-head squash 合并于 2026-10-11T19:35:12Z，生成 `edb51ab2feaf994b1d16ed19a9219350d7d9d382`。本地 main 快进后创建独立分支 `codex/f04-2-azure-foundry`。

F04.2 保留旧 provider ID `azure-openai-responses`、factory、认证键、旧模型、设置和 session，新增 Foundry Chat 路由与 DeepSeek V4 Pro。设计门禁见 [azure-foundry](repairs/azure-foundry.md)，变更仅请求初始化/目录生成，不增加事件转发层或逐 delta 分配。两组生产适配器离线复现先失败：模型不存在，Chat 空地址回落到 OpenAI 默认 URL；证据 `.git/f04-2-azure-foundry-20261012/baseline.log`。固定上游仍为 v1.1.0，不追踪浮动更新。
## 62. F04.2 独立 PR 交付（待最终 CI/审查）

提交 `cfe2c4d7f1ceb7fd3810dd539ecbf5e0df7102e9` 已推送并创建 [PR #122](https://github.com/dragonbaba/super-pi/pull/122)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/122#issuecomment-6113010971)。本地 65 项相关行为/所有权检查、4 项 source invariants、npm run check、AI offline/coding-agent/server 构建通过。旧 Azure 38 个模型记录保持不变；新增目录、生成器与请求路由均已验证。

额外发现 Foundry DeepSeek 工具续接需要显式 thoughtSignatureRoundTrip 能力；先记录设计门禁和失败用例，再在 provider ingress 补齐单一模型声明，不改变通用流处理/其他 provider。所有变更为请求或模型初始化，不增加 per-delta 分配，无额外事件转发层、缓存、池或后台资源。最终 CI run `38169496140`（Linux 2、Windows 4）及 Codex 审查待完成，不能以本地验证代替最终验收。README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。

### 62.1 CI 夹具修正

首轮 CI run `38169496140` 的 Windows 1/4 在 `openai-completions-strict-default.test.ts` 失败：全目录夹具未提供 Azure 租户端点，新目录项在 fetch 前被正确拦截。本地七项用例复现一项失败；记录门禁后，仅给离线夹具补充虚构 azureBaseUrl，原严格模式断言和生产缺地址保护不变。受影响 strict + Azure 共 15 项通过；累计独立检查 72 项，加四项源码不变量。

修正提交 `f4d239bf6c9a7f6a2bfc33669f2ba36e43699e52` 已推送，随即再次发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/122#issuecomment-6113057978)。最终候选 CI run `38169849158` 已创建。尝试按明确 ID 取消首轮 run `38169496140` 的剩余任务时，GitHub 返回该 run 已完成，未执行取消；失败日志已保留。新 head 的 CI/审查仍待完成。

最终提交 `f4d239bf6c` 的 [Codex 复审](https://github.com/dragonbaba/super-pi/pull/122#issuecomment-6113088520) 于 2026-10-11T19:55:49Z 完成，未发现重大问题，无待处理审查线程，reviews/comments/threads 分页完整。对应 CI run `38169849158` 仍在运行，尚未记为最终验收通过。

### 62.2 F04.2 最终验收完成

最终提交 `f4d239bf6c9a7f6a2bfc33669f2ba36e43699e52` 的 [CI run 38169849158](https://github.com/dragonbaba/super-pi/actions/runs/38169849158) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run headSha 与 PR head 一致；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/122#issuecomment-6113088520) 无重大问题，无审查线程且分页完整。PR #122 为 OPEN / MERGEABLE / CLEAN，保留等待用户下一次合并授权。F04.2 实施与交付验收完成，下一独立目标为 F05（OSC 7501 状态、agent_settled.aborted），实施前按调用链与兼容边界拆分。

最终证据 `.git/f04-2-azure-foundry-20261012/` 包含 pr-final、ci-final、review-final、source-hashes-final、resource-final、目录审计及相关日志。共 72 项本地相关行为/所有权检查、4 项源码不变量与三个包构建通过；没有本地全量测试、真实 Azure 调用或全局安装更新。无新增常驻进程、worktree、worker 或服务，测试 owner 已释放自身状态。README 用户修改和本地规划继续排除提交，README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。
## 63. F04.2 合并与 F05.1 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 PR #122 最终 head `f4d239bf6c9a7f6a2bfc33669f2ba36e43699e52`：六个 CI 分片 SUCCESS、同 head Codex 无重大问题、无审查线程且分页完整。match-head squash 合并于 2026-10-11T22:43:16Z，生成 `34b0fd328f825c938a3f3d123981f31fde11a113`。合并命令遇到 EOF，后续读取确认 MERGED，未重复合并。本地 main 快进并创建 `codex/f05-1-agent-settled-aborted`。

F05 按 §3.2 拆分：F05.1 交付结束事件取消标记；F05.2 再实施 OSC 7501 终端能力检测、结束/失败/等待输入状态和去重。固定上游 v1.1.0 不变。修改前完整阅读分配合同并审计生产调用链，设计门禁见 [agent-settled-aborted](repairs/agent-settled-aborted.md)。通过两个 primitive 标记区分显式取消与错误清理，兼容直接 Agent 取消、会话取消、重试和自动压缩取消，在扩展回调前固定结果；不修改逐 delta 投递链。

初始八项真实会话测试均因缺失字段失败。最终 11 项新增用例及 116 项相关回归/source 检查通过，typecheck 和 Agent/coding-agent/server 三包构建通过。运行前后事件分配 benchmark（每组 100,000 updates、10,000 warmup），确定性 Promise/包装/闭包计数保持零，最终值正确；9 个生命周期 WeakRef 零存活，控制器和 idle waiter 释放。测量范围和非零总体分配采样均如实记入 repairs。未运行全量本地套件。README 用户修改和本地规划排除提交。
## 64. F05.1 独立 PR 交付（待最终 CI/审查）

提交 `2c03dab4420838d7e1786ee7ce2d46e9885468ec` 已推送并创建 [PR #123](https://github.com/dragonbaba/super-pi/pull/123)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/123#issuecomment-6114826160)。最终候选 CI run `38182322714` 已启动，Linux 两分片、Windows 四分片；Codex 审查待完成，不以本地结果替代。PR 保留开放等待本阶段最终验收及下一次用户合并授权。

工作树仅保留用户 README 改动与本地未跟踪规划。README SHA256 为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，两个文件未进入提交。没有新建常驻进程、worktree 或服务，本地检查进程已退出；未更新全局安装或调用真实 provider。

最终候选 `2c03dab442` 的 [Codex 审查](https://github.com/dragonbaba/super-pi/pull/123#issuecomment-6114847555) 于 2026-10-11T22:58:19Z 完成，未发现重大问题；无审查线程，reviews/comments/threads 分页完整。六个 CI 分片均进入测试阶段，尚未记为最终验收通过。审查快照已保存为 `review-final.json`。

### 64.1 F05.1 最终验收完成

最终提交 `2c03dab4420838d7e1786ee7ce2d46e9885468ec` 的 [CI run 38182322714](https://github.com/dragonbaba/super-pi/actions/runs/38182322714) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run headSha、PR head 与已审查提交一致；[Codex 审查](https://github.com/dragonbaba/super-pi/pull/123#issuecomment-6114847555) 无重大问题，无审查线程且分页完整。PR #123 为 OPEN / MERGEABLE / CLEAN，等待下一次用户合并授权。F05.1 实施与交付验收完成，下一独立目标为 F05.2 OSC 7501，需先完成终端能力检测、状态映射和写入去重的热路径设计门禁。

最终证据 `.git/f05-1-agent-settled-20261012/` 包含 pr-final、ci-final、review-final、source-hashes-final、resource-final、行为与源码检查日志，以及事件分配前后采样。11 项新增用例、116 项相关回归/source 检查、typecheck 和三个包构建通过。九个生命周期 WeakRef 零存活；无新增常驻进程、worktree 或服务。没有全量本地测试、真实 provider 调用或全局安装更新。README 用户修改和本地未跟踪规划均保留且未提交，README SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。
## 65. F05.1 合并与 F05.2 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 PR #123 最终 head `2c03dab4420838d7e1786ee7ce2d46e9885468ec`：六个 CI 分片 SUCCESS、同 head Codex 无重大问题、无审查线程且分页完整，状态 CLEAN / MERGEABLE。match-head squash 于 2026-10-11T23:10:07Z 合并，生成 `4a4e60a56911152944b394b47032d204b6916ced`。本地 main 快进后创建 `codex/f05-2-terminal-program-status`。

F05.2 实施前阅读完整分配合同、固定 v1.1.0 上游源文件和 OSC 7501 协议，门禁记录于 [terminal-program-status](repairs/terminal-program-status.md)。调用链覆盖 Agent/Session 到 InteractiveMode、StdinBuffer 能力回复、ProcessTerminal 的实际 output/callback/drain/失败与生命周期边界。先复现缺少生产能力，再用 primitive 状态、两个固定对话框槽位、支持查询与有界最新状态写入适配，未机械移植每次报告创建对象/数组和 JSON 序列化的上游实现。

22 项新增行为/生命周期检查、118 项相关回归/source 检查、typecheck 和 TUI/coding-agent 构建通过。真实 Main/Alt 模式验证完成、取消、权限弹窗和 renderer handoff；四个生命周期 WeakRef 零存活。事件和 queue 分配前后基准记录采样波动，确定性计数满足契约；高频增量状态写入与 Promise 为零，慢写仅一条 active 加最新 pending。未做全量本地测试或实体支持终端视觉验收，README 用户修改和本地规划排除提交。
## 66. F05.2 独立 PR 交付（待最终 CI/审查）

提交 `8bbd66bc2cc4bfe0d86c573c42dc81f0eda47291` 已推送并创建 [PR #124](https://github.com/dragonbaba/super-pi/pull/124)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/124#issuecomment-6115070874)。CI run `38184111880` 已启动，Linux 两分片、Windows 四分片；Codex 审查待完成，不能以本地结果替代最终验收。PR 保留开放，未获得本阶段合并授权。下一规划候选为 F06 Anthropic inline tools，待 F05.2 交付验收完成后启动。

README 用户改动和本地未跟踪规划继续保留，未混入提交。README SHA256 为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。所有本地检查命令已退出，测试 fixture 释放自身临时目录/监听/计时器；无新增常驻进程、服务、worktree 或全局安装变更。

### 66.1 Codex 审查反馈闭环

首轮提交 `8bbd66bc2` 的 CI run `38184111880` 六分片全部 SUCCESS。Codex 首轮提出五条 P2：四条在生产夹具中复现并修正，包括压缩状态被历史等待输入遮盖、状态写入异常打断对话框清理、重复消息先清洗后去重、能力声明子集未被遵守；另一条关于 dispose/reset 的意见与当前代码不符，扩展清理断言在修正前即通过，已附证据解释。五个线程均已逐条回复并解决。

修正提交 `05ba491571b28c21014dde0b8a49e439b405b8de` 已推送，随即再次发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/124#issuecomment-6115194490)。26 项行为/生命周期检查、118 项相关回归/source 检查、typecheck 和 TUI/coding-agent 构建通过；10 万次相同短消息调用清洗次数为零。事件分配基准再次覆盖实际 reporter，高频状态写入、Promise 和拒绝观察器保持零，四个生命周期 WeakRef 零存活。帧队列算法未变，保留已完成的前后分配采样并重跑确定性门禁。新 head 的 CI run `38185082636` 与复审仍待完成，不沿用旧 head 的验收结论。

`05ba491571` 的 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/124#issuecomment-6115227450) 于 2026-10-11T23:43:19Z 完成，未发现重大问题。五个线程均已解决，reviews/comments/threads 及线程评论分页完整。审查证据保存为 `review-final.json`；最终 CI run `38185082636` 尚未完成。

### 66.2 F05.2 最终验收完成

最终提交 `05ba491571b28c21014dde0b8a49e439b405b8de` 的 [CI run 38185082636](https://github.com/dragonbaba/super-pi/actions/runs/38185082636) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run headSha、PR head 与 Codex 已复审提交一致；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/124#issuecomment-6115227450) 未发现重大问题。五个线程全部解决，所有分页完整。PR #124 为 OPEN / MERGEABLE / CLEAN，保留等待下一次用户合并授权。F05.2 实施与交付验收完成，下一独立目标为 F06 Anthropic inline tools，依规划先处理 SDK 兼容并联动现有权限/动态工具提示。

最终证据 `.git/f05-2-program-status-20261012/` 包含 pr-final、ci-final、review-final、13 个交付文件的 source-hashes-final、resource-final、行为与源码检查日志，以及事件/队列分配采样。26 项行为/生命周期检查、118 项相关回归/source 检查、typecheck 和两个包构建通过；四个生命周期 WeakRef 零存活。无新增常驻进程、worktree、服务或全局安装更新；未运行全量本地套件或调用真实 provider。OSC 7501 通过生产调用链与 fake Writable 字节流验证，尚未进行实体支持终端的视觉验收。README 用户修改与本地未跟踪规划继续保留且未提交，README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。

## 67. F05.2 合并与 F06.1 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 PR #124 最终 head `05ba491571b28c21014dde0b8a49e439b405b8de`：六分片 CI SUCCESS、同 head Codex 无重大问题、五个线程全部解决、分页完整，状态 CLEAN / MERGEABLE。使用 match-head squash 于 2026-10-12T00:02:42Z 合并，生成 `4c091608757f7305c11029ac7ad4b4ea0f381423`。本地 main 快进后建立独立分支 `codex/f06-1-anthropic-sdk`。

F06 依“SDK 兼容先行”和 §3.2 拆为两个独立验收目标：F06.1 固定 SDK 0.129.0 并验证现有适配器兼容；F06.2 再引入工具变更记录、支持模型门禁、权限/动态提示同步。固定上游仍为 v1.1.0。现有 Context 只有当前 tools 和 toolResult.addedToolNames，没有上游 system-role 工具声明历史，不能只复制 inline blocks。实施前设计与生产调用链审计见 [anthropic-inline-sdk](repairs/anthropic-inline-sdk.md)。旧版 0.91.1 的实际类型检查复现不接受 tool_addition/tool_removal/system role，记录于 `.git/f06-inline-tools-20261012/type-baseline.log`。SDK 通过 asResponse 交还原始响应，生产 SSE parser 与后续热路径保持不变。

## 68. F06.1 独立 PR 交付（待最终 CI/审查）

提交 `177786bd4a63fe775dd977ea2feeebbb86c68323` 已推送并创建 [PR #125](https://github.com/dragonbaba/super-pi/pull/125)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/125#issuecomment-6115477194)。SDK 固定为 0.129.0；根测试显式声明相同开发依赖。新版 ToolUnion 的无 name 工具集合使现有请求指纹遗漏标识，先复现后以协议 type 补齐；不启用新工具或 beta。锁文件仅六个相关条目变化。

99 项相关行为检查、12 项 source/ownership 检查、typecheck 和 AI offline/coding-agent/server 构建通过。两版各三组 20,000 增量、2,000 预热的真实 SDK→生产适配器采样：SDK SSE decoder 调用为零，每请求一个 fetch、两个生命周期 controller，全部增量/结束事件正确；16 个 WeakRef 在完成/失败/取消及 owner dispose 后零存活。既有异步流链的 Promise 总数为 280112→280118/请求，未把现有非零分配表述为零；完整 stream 及五个 SSE helper 的 AST 源码不变。两版 SDK 的 settled caller signal 均保留一个 once 监听直到 owner abort，清理后为零。采样中位数为 4070.910→4100.452 字节/增量，时间/堆采样限制已记录，不宣称性能提升。

最终候选 CI run `38187204244`（Linux 两分片、Windows 四分片）与 Codex 审查已启动，尚未完成。PR 保留开放，F06.2 尚未启动。本地只保留用户 README 改动和未跟踪规划；README SHA256 为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。未运行全量本地套件、真实 API 调用或全局安装更新；无新增常驻进程、服务或 worktree。

### 68.1 SDK 认证边界审查修正

首轮提交 `177786bd4` 的 CI run `38187204244` 六分片全部通过。Codex 提出 [P1：新版 SDK 延迟认证可能绕过订阅禁用边界](https://github.com/dragonbaba/super-pi/pull/125#discussion_r4243845042)。源码与三组离线失败探针确认：credentials/config/profile、构造阶段自动发现以及环境自定义认证头需显式约束。修正前先记录设计门禁；内置客户端关闭 SDK 默认发现，注入客户端的新认证模式在 payload hook/取 token/API 传输前拒绝，统一检查 SDK 合并后的默认认证头。显式静态 key/token 及禁用发现的自定义客户端保留兼容。外部客户端在注入前已执行的构造副作用无法撤销，文档明确边界；测试在构造前替换发现方法，没有访问真实凭据文件。

修正提交 `b3d03bc9f89e7f5c63cbb741589a9511b2cd14ed` 已推送，随即再次发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/125#issuecomment-6115616627)，并[回复证据](https://github.com/dragonbaba/super-pi/pull/125#discussion_r4243873735)、解决唯一线程。三组失败探针转为通过，重跑 17 项受影响检查、typecheck 及三个包构建通过；累计独立行为检查为 102 项。重新采样的中位字节/增量为 4087.622，确定性计数与 16 个 WeakRef 的释放结论不变；认证后的 stream 与五个 SSE helper 仍与合并基线一致。

最终候选 CI run `38188225893` 和复审待完成，首轮结果不沿用。本地 SDK 重复安装目录通过 npm 去重；npm 顺带产生的 11 条无关锁文件/依赖更新已按原记录恢复，最终锁文件范围仍为六个相关条目。工作树仅保留用户 README 和本地规划，未新增常驻进程或 worktree。

`b3d03bc9f8` 的 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/125#issuecomment-6115648815) 于 2026-10-12T00:33:26Z 完成，未发现重大问题。唯一审查线程已解决，reviews/comments/threads 及线程评论分页完整，审查快照保存为 `review-final.json`。最终 CI run `38188225893` 尚未完成，未提前记为验收通过。

### 68.2 F06.1 最终验收完成

最终提交 `b3d03bc9f89e7f5c63cbb741589a9511b2cd14ed` 的 [CI run 38188225893](https://github.com/dragonbaba/super-pi/actions/runs/38188225893) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run headSha、PR head 与 Codex 已复审提交一致；[Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/125#issuecomment-6115648815) 未发现重大问题。唯一审查线程已解决，所有分页完整。PR #125 为 OPEN / MERGEABLE / CLEAN，保留等待下一次用户合并授权。F06.1 实施与交付验收完成，下一独立目标为 F06.2：接入 inline 工具变更历史，联动支持模型门禁、现有权限及动态提示。

最终证据 `.git/f06-inline-tools-20261012/` 包含 pr-final、ci-final、review-final、九个交付文件的 source-hashes-final、resource-final、行为与源码检查日志，以及两版 SDK 和最终修正的分配/生命周期采样。首次 99 项行为检查与 12 项 source/ownership 检查通过；认证修正后重跑 17 项受影响检查，累计独立行为用例为 102 项，typecheck 和 AI offline/coding-agent/server 三包构建通过。最终每请求 20,000 个增量、一个 fetch、两个生命周期 controller、零 SDK SSE decoder 调用，既有异步链 Promise 为 280118/请求；16 个 WeakRef 在 owner 释放后零存活。未宣称全链路零分配或性能提升。

无新增常驻进程、服务、worker 或 worktree；本地命令均已退出。未运行全量本地套件、真实 API 调用或全局安装更新。实际 inline 功能仍属 F06.2，当前仅完成 SDK 和请求兼容底座。README 用户修改和未跟踪规划继续保留且未进入提交，README SHA256 为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。

## 69. F06.1 合并与 F06.2 启动（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 PR #125 最终 head `b3d03bc9f89e7f5c63cbb741589a9511b2cd14ed`：六分片 CI SUCCESS、同 head Codex 无重大问题、唯一线程已解决、分页完整，状态 CLEAN / MERGEABLE。match-head squash 于 2026-10-12T00:56:40Z 合并，生成 `ac5c4e15c5668ccf5647879043d4de085d71bacd`。本地 main 快进后建立独立分支 `codex/f06-2-anthropic-inline-tools`。

F06.2 实施前完整读取分配合同并审计请求准备、SDK、SSE、Agent/Session 到终端及释放链路；门禁见 [anthropic-inline-tools](repairs/anthropic-inline-tools.md)。生产适配器先复现工具变更会重写前缀，再引入成功响应的可选 checkpoint，以现有消息持久化承载工具与动态提示状态。明确模型门禁、权限/嵌套暴露不扩张、旧模型回退、扩展覆写隔离和恢复/裁剪重建边界；未引入新的通用消息角色。

本地累计 109 项不同检查通过（97 行为、12 source/ownership），包括真实 AgentSession 工具切换、JSONL 重开、动态提示和移除工具拒绝执行。typecheck 及 AI offline/coding-agent/server 构建通过。流式循环与五个 SSE helper 保持基线，checkpoint 只在完成副本中携带，慢消费者的排队 partial 不含工具快照。20,000 增量三组采样的 Promise 为 280118/请求，两个 controller、一个 fetch、零 SDK SSE decoder 调用；25 个 WeakRef 释放后零存活。未运行全量本地测试或真实 API 调用；README 用户改动与规划排除提交。

## 70. F06.2 独立 PR 交付（待最终 CI/审查）

提交 `6f8fe34a312701be33b5908c3091954ee7d7ae47` 已推送并创建 [PR #126](https://github.com/dragonbaba/super-pi/pull/126)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/126#issuecomment-6116034577)。当前候选 CI run `38191282788` 已启动（Linux 两分片、Windows 四分片），Codex 审查待完成，不以本地验证代替最终验收。

PR 保留开放，下一规划目标为 F07。README 用户修改与未跟踪规划排除提交，README SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。本地命令全部退出，无新增常驻进程、服务、worker 或 worktree；未更新全局安装。最终原始证据保存于 `.git/f06-2-inline-tools-20261012/`。

提交 `6f8fe34a3` 的 [CI run 38191282788](https://github.com/dragonbaba/super-pi/actions/runs/38191282788) 六分片全部 SUCCESS，headSha 一致，保存为 `ci-final.json`。Codex 审查仍在运行，未提前记为本阶段验收通过。

### 70.1 F06.2 审查修正闭环

首轮 Codex 提出四条 P2，均先通过离线生产夹具复现失败，再修正：beta 端点覆盖客户端请求头、代理完成消息丢失 checkpoint、新前缀重建沿用旧 usage 少计声明，以及有效请求指纹忽略 inline 更新。修正分别合并已有 beta flags、在代理完成副本携带可选 checkpoint/rawStopReason、按首个保留 checkpoint 索引补计重建声明、从最终 payload 重放指令和活跃工具定义。外部代理服务须转发可选字段，旧服务保留兼容但不能保留 inline 连续性。

修正提交 `c914ae1ed2c30916f8221f55825eb268759b9511` 已推送，随即再次发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/126#issuecomment-6116193169)。四个线程已分别[回复请求头证据](https://github.com/dragonbaba/super-pi/pull/126#discussion_r4244074592)、[代理证据](https://github.com/dragonbaba/super-pi/pull/126#discussion_r4244074839)、[估算证据](https://github.com/dragonbaba/super-pi/pull/126#discussion_r4244075049)、[指纹证据](https://github.com/dragonbaba/super-pi/pull/126#discussion_r4244075224)，均已解决。新的 [CI run 38192469645](https://github.com/dragonbaba/super-pi/actions/runs/38192469645) 与复审待完成，不沿用旧 head 验收结果。

受影响的 61 项检查通过，累计 113 项不同检查（101 行为、12 source/ownership）；typecheck 和 AI offline/Agent/coding-agent/server 四包构建通过。开启有效请求观察后的三组 20,000 增量采样保持 280118 Promises/请求、两个 controller、一个 fetch、零 SDK SSE 解码，25 个 WeakRef 释放后零存活。代理三组 10,000 增量保持 40028 Promises/请求、15 个 WeakRef 释放后零存活；实际 reader/delta 源码不变。代理已有 reader 在外部 owner 持有 body 时仍为 locked，采样只证明 owner dispose 后回收，未宣称即时解锁。未扩大全量本地测试或调用真实 provider；具体分配值及测量限制见 repairs 与原始证据。

`c914ae1ed2` 的 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/126#issuecomment-6116221066) 于 2026-10-12T01:38:29Z 完成，未发现重大问题。四个线程均已解决，reviews/comments/threads 及线程评论分页完整，快照保存为 `review-final.json`。最终 CI run `38192469645` 尚未完成，未提前记为验收通过。

### 70.2 F06.2 最终验收完成

最终提交 `c914ae1ed2c30916f8221f55825eb268759b9511` 的 [CI run 38192469645](https://github.com/dragonbaba/super-pi/actions/runs/38192469645) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run headSha、各 job head、PR head 和 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/126#issuecomment-6116221066) 的提交一致。复审未发现重大问题，四个线程全部解决，reviews/comments/threads 及线程评论分页完整。PR #126 为 OPEN / MERGEABLE / CLEAN，保留等待下一次用户合并授权。F06.2 实施及交付验收完成；下一独立目标为 F07 Codemode 图片保存及后续回合可寻址文件，尚未启动。

最终证据 `.git/f06-2-inline-tools-20261012/` 包含 REST 原始 CI/run/jobs/PR、归一化 ci-final/pr-final、review-final、12 个交付文件的 source-hashes-final、resource-final，以及行为/源码检查与两条生产传输链的分配/生命周期采样。累计 113 项不同检查，修正后 61 项受影响检查、typecheck 和四包构建通过；Anthropic 25 个、代理 15 个 WeakRef 在 owner 释放后零存活。现有 Promise 与事件分配仍非零，未宣称全链路零分配或性能提升。GitHub CLI 查询期间出现 EOF，最终状态通过公共 REST 重读，并重新获取完整 GraphQL 审查快照核实。

未运行全量本地套件、真实 provider 调用或真实服务端缓存命中验证；外部代理需转发可选完成元数据。无新增常驻进程、worker、服务或 worktree，本地命令均已退出，未更新全局安装。工作树仅保留原有 README 修改和本地未跟踪规划，均未进入提交；README SHA256 为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。

## 71. F06.2 合并与 F07 实施（2026-10-12）

用户授权“可以合并，然后下一阶段”。合并前复核 PR #126 最终 head `c914ae1ed2c30916f8221f55825eb268759b9511`：六个 CI 分片 SUCCESS、同 head Codex 无重大问题、四个线程已解决且分页完整，状态 CLEAN / MERGEABLE。match-head squash 于 2026-10-12T02:07:15Z 合并，生成 `f87094539cf8386ab723b361300c5ae2366218b7`。本地 main 快进后创建 `codex/f07-codemode-image-files`，保留原有 README 和未跟踪规划。

F07 按固定 v1.1.0 规划推进，先完整读取性能契约并审计 Worker 到工具结果、会话存储/模型投影、UI/终端及释放链；门禁见 [codemode-image-files](repairs/codemode-image-files.md)。实际 AgentSession 先复现缺少后续回合文件地址；保存发生在脚本完成边界，覆盖 `image()` 和 `show(ref)`，最多前 16 张、单张 8 MiB、合计 16 MiB，同次内容去重。复用创建时私有文件机制，清单路径进入正常会话历史；不增加 VM 文件权限。临时文件跨会话关闭保留，系统/用户可清理，无应用定时清理或自动跨重启执行。

第二个失败探针确认小输出预算和磁盘错误会连带触发原有文本 spill 失败；现在仅在图片完成路径保留有界文字、图片和已完成状态，并明确恢复不可用，未重放子工具。39 项不同检查通过（15 集成、24 图片/输出/源码），最终受影响检查 18 项通过，typecheck 和 coding-agent 构建通过。Windows 实际检查文件及清单的 owner/protected DACL，native handle 为零。普通 AgentSession 基准 22 个 Worker 均退出、55 个 WeakRef 全部回收；图片实际 Controller/Worker 完成基准三组四调用，Promise 都为 180，每四调用新增八次私有打开，105 个 WeakRef 在正常/失败/取消/磁盘失败后零存活。分配增加是新增文件功能成本，未声称性能提升。具体值与边界见 repairs、`.git/f07-codemode-images-20261012/`；没有全量本地测试或真实 provider 调用。

## 72. F07 独立 PR 交付（待最终 CI/审查）

提交 `e6ff85dddaf692cbab4c1a7b45cd2a77082c6bb9` 已推送并创建 [PR #127](https://github.com/dragonbaba/super-pi/pull/127)，随即发布准确的 [@codex review](https://github.com/dragonbaba/super-pi/pull/127#issuecomment-6116630458)。[CI run 38195663238](https://github.com/dragonbaba/super-pi/actions/runs/38195663238) 已启动，Codex 审查待完成；不以本地检查代替远端最终验收。PR 保留开放等待本阶段验收及下一次用户合并授权，下一规划项 F08 尚未启动。

最终候选八个交付文件已记录 SHA256，source audit 与实际源码一致；README 原有修改和本地规划未进入提交。README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。任务创建的 fixture 文件按记录身份清理，所有本地命令已退出，无新增常驻进程、服务或 worktree。

### 72.1 F07 CI 与审查修正

初始 CI run `38195663238` 的 Linux 分片 2 暴露原有读取投影边界：加入图片元数据后，四次缩减算出的最后候选未检查就被丢弃，落入完全省略。Windows 同例复现；调整提示位置或缩短提示单独不能可靠修复。固定字符串夹具确认根因，现保持四次缩减与原预算，增加最后候选检查；图片提示放回宿主摘要，不延长原生 read 组。新增 16 种路径长度回归与 20 项相关集成通过。

首轮 Codex 两条 P2 均先复现后修正：临时目录先转绝对路径，避免更改 cwd 后历史路径失效；恢复提示超过 256-token 预算时先省略文本 spill 路径，仍放不下则明确指向保存结果元数据中的完整图片路径，保留附件与完成状态。深路径 fixture 在 Windows 使用 namespace 形式，确保确实到达预算边界。六项文件检查、20 项集成、14 项输出/热路径最终重跑通过，前一轮 49 项投影/源码检查通过；累计 74 项不同检查。typecheck 和 coding-agent 构建通过，未扩大全量本地测试。

修正提交 `efc8c01f00c4b903290f56c4c6dd3cdff258d9cb` 已推送，立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/127#issuecomment-6116853374)。两个线程分别附上[预算证据](https://github.com/dragonbaba/super-pi/pull/127#discussion_r4244313758)和[绝对路径证据](https://github.com/dragonbaba/super-pi/pull/127#discussion_r4244313963)，均已解决。新 head 的 [CI run 38197292467](https://github.com/dragonbaba/super-pi/actions/runs/38197292467) 正在运行。首个复审请求报告服务端 Unknown error，重新请求审查；不把错误视为通过。

最终图片真实 Controller/Worker 三组四调用保持 180 Promises、16 次私有打开；105 个 WeakRef 和 native handles 全部释放。新增加的投影前后基准每组 96 次，保留可容纳读取由 79/96 到 96/96，0 Promises、401 个数组、96 次完整扫描均不变；1152 个 WeakRef 零存活。采样成本、时间波动和审计边界记录在 repairs 中。九个交付文件 SHA256 与资源记录已更新。工作树仅保留原 README 修改和本地规划，均未提交；无新增常驻进程、服务或 worktree。F08 尚未启动。

### 72.2 F07 后续模型投影可见性修正

`efc8c01f0` 的 CI run `38197292467` 六分片均 SUCCESS。复审提出第三条 P2：图片提示位于多个长失败摘要之后，会被下游 head/tail 投影置于省略区。真实 AgentSession 使用八个失败摘要、8192-token 脚本预算和 512/1024-token 模型预算复现了两次缺失；现将原有提示移至固定摘要标题之后、可变子工具记录之前，两种情况均能在下一模型请求看到完整清单路径并在后续调用读取成功。未新增内容块、容器、Promise 或扫描，也未改变原生 read 偏移。

修正提交 `fcd7d4752cb09dd4b7df748677d7a09e70004d26` 已推送并立即请求 [@codex review](https://github.com/dragonbaba/super-pi/pull/127#issuecomment-6116947877)，第三个线程[回复证据并解决](https://github.com/dragonbaba/super-pi/pull/127#discussion_r4244346387)。新 head 的 [CI run 38197960582](https://github.com/dragonbaba/super-pi/actions/runs/38197960582) 与复审正在运行，不能沿用上一提交的通过状态。

22 项受影响集成/provider 检查、热路径源码检查、typecheck 和 coding-agent 构建通过，累计 76 项不同检查。最终变化仅调整完成时已有语句顺序，原图片分配基准零子工具记录，摘要文本和顺序完全不变，保留已记录分配/释放证据；源码 audit 再次通过。九个文件的最终 SHA256、资源和去重测试清单已更新。工作树仍仅有 README 原改动与本地规划，README SHA256 保持不变，未更新全局安装或执行全量本地测试。

### 72.3 F07 长路径原子性、异步写盘与空间恢复闭环

`fcd7d4752` 的 [CI run 38197960582](https://github.com/dragonbaba/super-pi/actions/runs/38197960582) 六分片全部 SUCCESS。复审继续提出三条 P2，均已先复现后修复：深临时路径在字符投影中仍被切断；大图片同步写入阻塞事件循环；图片先占用可用空间使原有文本恢复失败。

现使用数值布局提示完整保留摘要中的图片地址前缀，或 cap 的完整末尾恢复提示；无法连同 continuation 放入预算时整体省略并可恢复，提示参与 source identity、不授予读取权限。实际深路径/密集尾部 AgentSession 用例恢复完整地址，128-token 整体省略通过 JSONL-shaped resume 取回原文，篡改布局提示会使旧 cursor 失效。保存图片的 payload/清单通过原有私有 fd 异步写入，无图片分支不创建 Promise；8 MiB 用例证实写入结束前事件循环能够推进。text spill 的 ENOSPC 可精确回收本次图片和清单后仅重试一次持久化，不重放工具；复用至多 16 条清理记录，返回会话元数据前清空引用。

提交 `009939e9b966f67930e8ac4cba002771ce3ff558` 已推送并立即请求 [@codex review](https://github.com/dragonbaba/super-pi/pull/127#issuecomment-6117210695)。三条意见分别附上[原子路径证据](https://github.com/dragonbaba/super-pi/pull/127#discussion_r4244446942)、[异步写入证据](https://github.com/dragonbaba/super-pi/pull/127#discussion_r4244447055)、[空间恢复证据](https://github.com/dragonbaba/super-pi/pull/127#discussion_r4244447180)，现六个审查线程全部解决。新提交的 [CI run 38199894004](https://github.com/dragonbaba/super-pi/actions/runs/38199894004) 与复审待完成。

最终受影响组 44 项输出/投影/源码、23 项会话/provider、14 项文件/源码检查通过，累计 85 项不同检查；typecheck 和 coding-agent 构建通过。真实图片完成链每四次调用 180→220 Promises、16 次私有打开，正常/脚本失败/取消/磁盘失败/空间回收后 112 个 WeakRef 零存活、native handles 为零。普通读取投影保持 401 arrays/96，原子路径夹具 192→576 arrays/96，完整地址保留 0/96→96/96；两组均 0 Promises、96 次完整扫描、1152 个 WeakRef 零存活。最多七个有界投影候选，不声称零分配或性能提升；private setup、base64 检查、解码和哈希仍为有界同步工作。具体采样和边界已更新 repairs。

最终九个交付文件 hashes、资源记录和证据 ledger 已更新；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。工作树只保留原 README 修改和本地规划，未执行全量本地测试、真实 provider 调用或全局安装更新，无新增常驻进程、服务或 worktree。

`009939e9b9` 的 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/127#issuecomment-6117243271) 于 2026-10-12T03:32:10Z 完成，明确未发现重大问题，bot 同时以 👍 标记本轮；六个线程已解决，reviews/comments/threads 和线程评论分页完整。审查快照及 reaction 已保存。CI 仍在收尾，尚未记为最终验收完成。

补充直接缓冲区释放核验：正常保存、清单失败和写入失败三种路径共解码五个 8 MiB Buffer（40 MiB），跟踪 Buffer、其独立 ArrayBuffer、结果对象与记录数组共 16 个 WeakRef，全部回收，native handles 为零。该辅助核验仅记录生命周期，不混入分配采样和行为用例计数；原始脚本及结果为 `decode-lifecycle.mts/json`。主 head 没有变化。

### 72.4 F07 最终验收完成

最终提交 `009939e9b966f67930e8ac4cba002771ce3ff558` 的 [CI run 38199894004](https://github.com/dragonbaba/super-pi/actions/runs/38199894004) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4），run、各 job、PR head 和 [Codex 最终复审](https://github.com/dragonbaba/super-pi/pull/127#issuecomment-6117243271) 的提交一致。复审明确未发现重大问题，六个线程全部解决，全部分页完整。[PR #127](https://github.com/dragonbaba/super-pi/pull/127) 为 OPEN / MERGEABLE / CLEAN，等待下一次用户合并授权。F07 实施与交付验收完成；下一独立目标为 F08 登录界面的应用名参数，尚未启动。

最终证据 `.git/f07-codemode-images-20261012/` 包含 pr-final、ci-final、jobs-final、review-final、review-reactions、九个文件的 source-hashes-final、resource-final、去重后的 85 项检查清单，以及源码审计、分配/释放基准和复现日志。最终受影响的 44+23+14 项检查、typecheck 和 coding-agent 构建通过，另保留此前相关边界检查证据。22 个 Session Worker 全部退出；会话 55、图片完成链 112、两种投影各 1152、直接解码缓冲区/记录 16 个 WeakRef 均零存活。异步写入和原子投影有明确、有限的新增成本，未声称全链零分配或性能提升。

所有本地命令已退出，无新增常驻进程、服务或 worktree；未运行全量本地测试、调用真实 provider 或更新全局安装。图片仍受用户/OS 临时目录清理影响；base64 检查、解码、哈希和 private setup 仍为有界同步工作，未宣称最坏延迟上界。工作树只保留原 README 修改及本地未跟踪规划，均未进入提交；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。


## 73. F07 合并与 F08 登录应用名

用户于 2026-10-12 明确授权合并 #127 并开始 F08。合并前复核最终 head `009939e9b966f67930e8ac4cba002771ce3ff558`：六分片 CI 全部 SUCCESS，Codex 无重大问题，六个审查线程全部解决且分页完整。PR #127 于 2026-10-12T04:41:19Z squash 合并为 `bf2aa4ebd843ba59ba8326a445b97fcb724c732a`。本地 main 快进到该提交，新建 `codex/f08-login-agent-name`。

F08 根因与最小复现：浏览器授权 URL builder 已支持 originator，但 Models、ModelRuntime、lazyOAuth 和 Codex login 尚未传递应用名。两个真实生产链离线用例传入自定义名称均仍得到 `pi`，失败日志存于 `.git/f08-login-agent-name-20261012/reproduction.log`；断言前完成登录并核实回调资源释放。

编码前已记录设计于 `docs/repairs/login-agent-name.md` 并阅读性能契约。新增可选 LoginOptions.agentName，沿 Models/ModelRuntime → lazyOAuth → Codex browser 参数透传；InteractiveMode.loginProvider 传 APP_TITLE（Super Pi）。旧 SDK 默认 pi；保留 OAuth client ID、授权主体、scope、redirect、token/account 处理、设备码登录、扩展回调兼容及 T04.3 请求头优先级。未引入 getDeviceId 或安装 ID。

这是显式登录命令边界，不触及 provider delta、工具进度、交互输入更新、渲染或终端帧。新增一个 UI 登录 options 对象及字符串引用，逐层传递、无复制或缓存，登录结束后释放；无新增 Promise/闭包/控制器/数组/计时器/监听器/文件或池。原 callback/manual input 的 finally 负责现有资源；未触及热路径，因此不额外运行无关 allocation benchmark。

本地 22 项 callback/login 与 1 项 UI 登录取消检查通过；全仓 typecheck、AI 离线构建、coding-agent 构建通过。使用内存凭据、虚构 token 和自有临时端口，确认正常/失败/取消关闭 listener、连接数及 abort listener 为零。未调用真实 provider、未执行本地全量测试或更新全局安装。README 原改动及本地规划不纳入提交；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。下一步独立 PR、立即 @codex review，并等待同 head CI/审查闭环。


## 74. F08 PR 交付与审查

最终本地候选 `26444293f3727f4ac415f66c7cd6555c55fbce0a` 已提交、推送并创建 [PR #128](https://github.com/dragonbaba/super-pi/pull/128)，创建后立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/128#issuecomment-6117926228)，PR 已附加本任务。[CI run 38205166149](https://github.com/dragonbaba/super-pi/actions/runs/38205166149) 的 Linux 2 / Windows 4 分片已开始，审查与 CI 尚未记为完成。

十个文件交付：六个生产文件、两个现有测试文件、AI README 与 repairs；源文件 SHA256 存于 `.git/f08-login-agent-name-20261012/source-hashes.json`。Windows Node v26.4.0 的本地检查为 22+1 项不同用例，最后仅重跑受新增断言影响的设备码用例；根 typecheck 与两个受影响包构建均通过。所有本地命令退出，无新增常驻进程/服务/worktree；自有回调端口及连接按夹具记录释放。README 原改动和未跟踪规划保持在工作树，未提交。本次没有获得 #128 的合并授权。


Codex 已于 2026-10-12T04:49:25Z 对 `26444293f3` 完成[最终审查](https://github.com/dragonbaba/super-pi/pull/128#issuecomment-6117951165)，明确未发现重大问题；本轮没有 review thread。CI 六分片已进入测试，尚未完成。此时不记为最终验收通过。


### 74.1 F08 最终验收完成

最终提交 `26444293f3727f4ac415f66c7cd6555c55fbce0a` 的 [CI run 38205166149](https://github.com/dragonbaba/super-pi/actions/runs/38205166149) 六分片全部 SUCCESS（Linux 2/2、Windows 4/4）；run、六个 job、PR head 和 [Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/128#issuecomment-6117951165) 对应同一提交。审查无重大问题、无 review thread、全部分页完整。PR #128 为 OPEN / MERGEABLE / CLEAN，等待用户后续合并授权。

本地仅运行 23 项不同的定向检查，以及最后受断言修改影响的单项设备码复核；typecheck 和两个受影响包构建通过。最终 evidence 保存 pr-final、ci-final、jobs-final、review-final、十文件 source-hashes、resource-final 及复现/本地验证日志。CI 观察命令曾因 GitHub API EOF 退出，已改用直接查询确认全部 job 成功；这不是 CI 失败，也未重跑 CI。

所有本地命令（包括 CI 观察进程）均已退出，无新增常驻进程、服务或 worktree。工作树仅保留原 README 修改与本地未跟踪规划，均未提交；README hash 未变。未真实登录 OpenAI 或验证其服务端页面呈现，未更新全局安装。F08 为当前功能补齐清单最后一项；未自行启动低优先级核查或范围外功能。


## 75. PR #128 合并与规划收尾核对（2026-10-12）

用户明确授权合并 #128 并核对规划剩余项，要求避免过度测试。合并前再次核对最终 head `26444293f3727f4ac415f66c7cd6555c55fbce0a`：PR OPEN / MERGEABLE / CLEAN，[CI run 38205166149](https://github.com/dragonbaba/super-pi/actions/runs/38205166149) 六分片 SUCCESS；[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/128#issuecomment-6117951165) 对应同一提交、无重大问题，review threads 为零，reviews/comments/threads 分页完整。

[PR #128](https://github.com/dragonbaba/super-pi/pull/128) 于 2026-10-12T05:05:26Z（日本时间 14:05:26）以 match-head 约束 squash 合并，合并提交 `f73c19c7db64116b82f77b7eaf09be940b157613`。本地 main 已快进至该提交。

核对结果：§4 共 37 个 T 类勾选项，未勾选项为 0；其中包括 T02.4.3 的有证据排除和 T09.3 的已有能力边界验证，不把排除项说成新增实现。§5 的 F01–F08 八组功能全部完成并合并。GitHub 状态确认 PR #78–#128 共 51 个全部 MERGED，逐个 merge commit 均为当前 main 的祖先；没有编号范围内未合并的交付 PR。早期阶段记录保留为历史，后续同项验收/合并记录覆盖其“待完成/未启动”状态。

### 75.1 尚未开展的候选与交付边界

| 类别 | 剩余内容 | 当前结论 / 启动条件 |
| --- | --- | --- |
| §5 低优先级适配 | 登录 URL 复制快捷键；Home/End 与全屏滚动键位；Termux 剪贴板和安装提示；Herdr 链接；`!!` 标题颜色 | 尚未开展这五组专门适配核查。先确认当前入口、目标环境和实际需要；没有复现或需求不自动创建修复 PR。 |
| §6 上游 main 候选 | 本项目 `.sp` 配置 JSON Schema；硬件光标/假光标及模型元数据的剩余差异核对 | 尚未单独立项。Schema 需覆盖本地扩展字段；光标需目标终端验证。T05 已完成固定范围的模型/价格项，不等于所有后续目录变化永久同步。 |
| §8 条件性性能候选 | faux provider 逐消息缓存比较的分配优化 | 尚未升为生产修复；仅在测得本地 faux 压测成本后再决定。 |
| 本地交付 | 更新本机全局离线安装 | 尚未执行。源码 main 已更新，不能据此声称全局安装已更新；按 §6 单独的交付授权执行。 |
| F02.3 可选部署 | 公开托管自有 Super Pi CIMD 元数据文档，连接真实外部授权服务器 | 代码及文档模板已完成；未部署公开端点、未外部实测。部署者启用 CIMD 前须发布自有文档；见 repairs/mcp-cimd.md。 |
| 验证覆盖边界 | 各项已记录的真实 provider/OAuth、真实目标终端目视、Bun 二进制、Windows arm64 等环境 | 保留原验收限制，不以离线夹具或 Linux/Windows x64 CI 冒充这些环境通过；也不自动将其扩大为本次全量测试任务。 |

§6 已排除/已有等效实现的项目保持原结论。classifier、图像生成、Radius、durable/chord/evals 和 pi-env/SSH 等保持范围外；Anthropic 订阅登录保持禁用。未因本次收尾核对重新扫描更新的上游版本、价格或安全公告，§1 固定基线仍适用。

本次仅执行远端状态复核、合并、main 快进、规划与 Git 祖先关系核对；新增测试/构建/性能基准次数均为 0，未改生产代码、未创建新 PR/分支/worktree、未更新全局安装或部署服务。证据在 `.git/plan-closeout-20261012/`：pr-statuses.json 记录 51 个 PR 的合并状态，audit.json 记录 37 项清单、零未勾选项及 main 包含关系。原 `docs/README.md` SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`；该修改及本地未跟踪规划均保留且未提交。

## 76. 已合并分支清理与本机全局离线交付（2026-10-12）

用户明确要求先删除全部已合并的本地和远端分支，再切回主分支、构建本机全局 Super Pi，最后评估剩余候选的实施价值。本次授权中的候选工作为探测与评估，尚未开始新的生产功能开发。

清理结果：删除 **55 个远端分支和 55 个本地分支**。每个被删除的 ref 都精确匹配已合并 PR 的最终 head，并验证其 merge commit 已进入 main；没有根据名称、提交时间或模糊模式判断。远端以单次 atomic push 和逐 ref 的旧 SHA lease 删除；本地删除前重新验证对应 SHA。共核对 128 个 PR，全部为 MERGED。清理后本地仅 `main`，远端仅 `origin/main`（另有 `origin/HEAD -> origin/main` 符号引用）；没有未合并分支。本地 `main` 与远端同为 `f73c19c7db64116b82f77b7eaf09be940b157613`。已有 detached worktree、标签、README 修改和未跟踪规划保留。清单、删除日志及清理后的远端 ref 在 `.git/merged-branch-cleanup-20261012/`。

全局交付：执行一次 `npm run build:offline`，全部包构建成功。本机 npm 全局包 `D:\Nodes\26.4.0\node_modules\super-pi-monorepo` 是指向当前仓库的 junction，因此构建结果直接供全局入口使用，无需重新安装。实际优先入口 `C:\Users\Administrator\.nvmd\bin\superpi.exe` 的两项离线冒烟通过：`--offline --version` 返回 `0.84.1`，`--offline --help` 正常退出。观察到它使用 `D:\Nodes\26.4.0\node.exe`、当前仓库 `scripts/superpi.mjs` 和 `packages/coding-agent/dist/cli.js`；两次网络拦截计数均为 0。此次代码更新没有修改包版本号，以 main 提交与输出文件 SHA256 确认交付身份。

证据在 `.git/global-superpi-rebuild-20261012/`：build.log、global-summary.json、两项命令日志、入口观察与验证脚本。验证使用独立 HOME/agent/session/cwd/tmp，临时目录按记录身份精确清理。已运行的 Super Pi 进程需要重新启动才能加载新构建，本次未中止用户进程。

## 77. 剩余候选的价值探测（2026-10-12）

以 §1 的固定 v1.1.0 与 main 快照为上游依据、当前 `f73c19c7db` 为本地基线；没有扩大为最新版本全量追踪。执行一份离线探针，覆盖八组候选行为，网络尝试为 0。以下是“是否值得继续做”的判断，不表示这些候选已实现或成为原 T/F 清单的新增必做项。

| 候选 | 当前证据 | 价值与建议 |
| --- | --- | --- |
| Home/End 与全屏滚动 | 实际 TuiAltScreen 输入链中，Home 把 viewportTop 从 15 变成 0，编辑光标仍在 4；End 把 viewportTop 从 0 变成 15，编辑光标仍在 0。Ctrl+Home/End 反而改变编辑光标。默认键位和 viewport listener 优先级共同造成差异。 | **优先做**。全屏编辑的常用键受影响，收益明确、变更范围小。目标为 Home/End 留给编辑器、Ctrl+Home/End 控制全文滚动；必须保留用户显式键位覆盖，补足键位文档。上游依据 [6100fe5a83](https://github.com/earendil-works/pi/commit/6100fe5a8358709a26050b8da97ccd188ae93101)。 |
| 登录 URL 复制 | `app.message.copy` 默认为 Ctrl+X，但真实登录组件在显示设备授权 URL 后仍把该键交给 Input；showAuth/handleInput 源码也没有保留 URL 或复制分支。现有可点击 URL 和自动开浏览器不能覆盖复制场景。 | **值得做，排在常用键修正之后**。复用已有复制能力和快捷键，降低手动复制长链接的成本；需要覆盖等待授权、手动输入、取消和完成后的 URL 生命周期。未真实打开浏览器或操作剪贴板。 |
| `!!` 命令标题颜色 | 真实 BashExecutionComponent 在初始显示使用 dim；appendOutput 后、setComplete 后都恢复 bashMode。边框仍为 dim，排除上下文的语义没有改变。 | **值得作为小修复**。可复现且修复范围小，恢复持续可见的状态提示；优先级低于键位和登录复制。属于输出更新/渲染路径，实施时仍遵守热路径门禁。 |
| 硬件光标与假光标 | 开启 showHardwareCursor 后，实际全屏终端帧同时包含显示硬件光标的序列和 Input 假光标反色序列。 | **有价值，但单独处理**。启用系统光标的用户会收到两套光标表现，帧级缺口已确认。先在实际使用的终端确定视觉效果；实施要审计 Input/Editor、主屏/全屏、overlay 与 IME 标记的完整链，不能只删一个反色字符。上游依据 [1cedd32724](https://github.com/earendil-works/pi/commit/1cedd32724abfcb0915f76cc61b6827e2c16dbad)。本次不声称已验证真实终端显示。 |
| `.sp` 配置 JSON Schema | 当前仅有 theme JSON Schema，models 有运行时校验。SettingsManager.fromStorage 实际接受字符串 `showHardwareCursor: "false"`，getter 返回 string、布尔转换为 true；错误列表为空，`editorPadingX` 拼写错误被忽略并得到默认 padding 0。 | **值得后续独立做**，主要收益是编辑器补全、字段说明和及时提示拼写/类型错误；投入高于前三个小修复。Schema 必须覆盖 Super Pi 扩展字段、可信项目规则、现有兼容字段和发行包路径。编辑器 Schema 不自动等于运行时校验，不在同一目标下擅自改变配置加载的兼容语义。 |
| 模型元数据 | 当前构建的 Anthropic 随包目录有 Haiku 5.5，但没有 Opus 5.5 / Sonnet 5.5。固定上游 main 的 [ce950d78f4](https://github.com/earendil-works/pi/commit/ce950d78f424dcaf9f5d6a03ce80ab141130eb1d) 主要删除三款模型的临时生成器记录；本地 Haiku fallback 已遵循“远端存在时保留远端记录”，不能照搬删除。 | **按需做一轮有限目录补齐**：需要这两款模型的默认离线发现时有明确价值；不能把当前 T05 的四项范围视为整个目录已同步。实施前固定权威来源并核对能力、价格、随包/缓存/远端优先级。当前证据仅确认随包缺项，未证明用户自定义记录或在线恢复也不可用，也没有宣称最新价格已核验。 |
| Termux 剪贴板与安装提示 | `termux-clipboard-set` 和 `pkg install fd/ripgrep` 提示已有；读取路径没有 Android/Termux 分支，Termux 环境下 native clipboard 禁用。注入 Android 环境的实际 readClipboardText 返回 null。 | **仅在需要 Android/Termux 时做**，范围缩为文本剪贴板读取；安装提示和复制能力不重复实现。需要设备或专用命令夹具核实 termux-api 可用/缺失行为；本次为分支探针，未冒充 Android 实机验收。 |
| Herdr 超链接 | 去掉其他终端提示、设置 TERM_PROGRAM=herdr 后，实际 detectCapabilities 返回 hyperlinks=false；源代码没有 Herdr 分支。 | **使用 Herdr 时再做**。改动小，但收益限定在该终端。保持 tmux/screen 先行判断，取得目标终端显示证据再扩展白名单。 |
| faux prompt-cache 逐消息比较 | 本地仍整段序列化、扫描公共字符前缀并缓存完整字符串。固定上游 [fe11328b0d](https://github.com/earendil-works/pi/commit/fe11328b0d31d8666c8e9b662c00097291132483) 跳过相同消息后再比较不同尾部，仍构造消息数组/尾部串，不能据此推断零分配。 | **暂缓**。这是 faux 模拟器的优化候选，没有本地实际瓶颈证据；本轮不为可选项新增压力测试。只有 faux 大上下文压测成为瓶颈时才测量，并保留本地 systemPrompt/tools 序列化及缓存估算语义。 |
| CIMD 公开托管与真实外部 OAuth | §F02.3 的配置与桥接已完成；公开元数据端点仍是部署者的可选前提，仓库没有预设自有托管地址。 | **明确接入需要 CIMD 的服务器时再部署**。当前没有必须为一般使用新增的代码，也不在本次授权下创建公开端点。 |

建议下一轮先处理 **Home/End → 登录链接复制 → `!!` 标题颜色**；硬件光标作为独立的有条件修复，配置 Schema 作为独立功能。模型目录按实际模型需求决定，Termux/Herdr 按目标环境决定；faux 优化和 CIMD 部署暂不启动。§75.1 的“尚未开展专门核查/未更新全局安装”已由 §76–§77 覆盖，原 T01–T10 与 F01–F08 的完成结论保持不变。

行为证据为 `.git/remaining-candidates-20261012/probe.mjs`、probe-results.json、stdout/stderr 日志。探针运行一次，使用当前 dist 的实际组件、设置加载器、终端帧生成和能力检测；只将终端传输替换为内存接收器，并注入独立环境。TUI dispose 后 listener/帧回调已释放，Bash loader 停止并释放，自有临时目录精确清理。没有执行 shell 工具命令、真实复制/粘贴、浏览器授权或 provider 请求；没有改生产代码、增加仓库测试、运行全量套件/性能基准、重新跑 CI 或新建 PR/分支/worktree。本轮总验证为一次全仓离线构建、两项全局入口冒烟和一次八组候选探针。

工作树仍仅保留原 README 修改与本地未跟踪规划，均未提交；README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。原生目标终端、Android 实机、真实外部授权与 provider 的边界继续保留，不因这些离线探针扩大验收声明。

## 78. 三项交互补齐实施与独立 PR（2026-10-12）

用户认可 §77 的下一轮顺序，明确授权实施并新建 PR，同时要求注意代码写法、避免过度测试。按照 §3.2，将三个独立根因分别交付；都从 `f73c19c7db64116b82f77b7eaf09be940b157613` 创建独立分支，以 main 为目标，不互相叠加、不提前合并。编码前已阅读性能契约并在各自 repairs 文档记录设计与完整调用链。

| 项目 | PR / 当前 head | 实施与本地验证 |
| --- | --- | --- |
| Home/End 与全屏导航 | [PR #129](https://github.com/dragonbaba/super-pi/pull/129)，`54942555c` | Home/End 留给编辑器，Ctrl+Home/End 控制全文边界；Windows Console 使用有明确输入编码的 Ctrl+Up/Down 备用键。新 viewport 默认键在冷态配置解析时让位于用户显式覆盖。六项实际输入路由回归通过；见 repairs/fullscreen-navigation.md。 |
| 登录 URL 复制 | [PR #130](https://github.com/dragonbaba/super-pi/pull/130)，`0ac8c2fe4013e1d4822b8610c80018fa722d5e4c` | 浏览器与设备码登录均支持 app.message.copy（默认 Ctrl+X）；保留手动输入，单个复制任务与状态提示，失败不终止登录，取消/替换/完成后忽略迟到反馈并清空 URL 引用。七项行为/源码检查及两项既有取消检查通过；见 repairs/login-url-copy.md。 |
| `!!` 标题颜色 | [PR #131](https://github.com/dragonbaba/super-pi/pull/131)，`92ba7ffe0c992eb930dc3c89b9cf1e5a5fec9207` | 只新增 readonly 颜色名字段，刷新时复用；不改变命令执行、历史或模型上下文排除语义。普通/排除两项回归覆盖成功、错误、取消、主题、padding 与 cache 重建；另一次既有资源释放回归通过。见 repairs/excluded-bash-title.md。 |

三个 PR 创建后分别立即请求审查：[129 初审](https://github.com/dragonbaba/super-pi/pull/129#issuecomment-6119069830)、[130](https://github.com/dragonbaba/super-pi/pull/130#issuecomment-6119169102)、[131](https://github.com/dragonbaba/super-pi/pull/131#issuecomment-6119210036)，并附加到当前任务。129 首轮 CI 六分片成功，审查提出编辑器单独覆盖优先级和 Windows Console 键编码两条 P2；两项均先复现后修正，附上[覆盖优先级证据](https://github.com/dragonbaba/super-pi/pull/129#discussion_r4245336045)与[Console 备用键证据](https://github.com/dragonbaba/super-pi/pull/129#discussion_r4245336254)，线程已解决。修正后立即请求[复审](https://github.com/dragonbaba/super-pi/pull/129#issuecomment-6119260399)，不沿用旧提交的 CI/审查结论。

130 已取得同 head 六分片 CI 成功和[Codex 无重大问题](https://github.com/dragonbaba/super-pi/pull/130#issuecomment-6119206893)，无 review thread。131 已取得同 head [Codex 无重大问题](https://github.com/dragonbaba/super-pi/pull/131#issuecomment-6119242488)，无 review thread，CI 尚在运行。129 最终 head 的 CI/复审仍待完成，本节不记为全部验收通过。

本轮累计 21 项不同的定向检查：导航六项、登录九项、标题三项、共用帧 AST/source 三项；各候选 typecheck 通过。既有问题先复现，再只运行修改后的受影响范围。没有全量本地测试或重复 CI 触发，没有真实浏览器/剪贴板/provider/终端键盘操作。未重新构建全局安装，保留上轮已经交付的 main 构建。

性能与释放证据：三组每组 128 次采样，登录前后 16021/15895/15816 → 16597/15974/15171 B/update，标题 49354/49874/50268 → 50780/48314/49005，导航审查修正 12796/12906/13825 → 12957/11813/13780（均为采样观测、取整）。每组 128 帧、同步更新链 0 Promise、队列高水位 1、frame wrapper/controller/full-copy 为 0、末尾 active/pending bytes 为 0；每条链各九个 WeakRef 零存活。独立队列基准只运行一次 512 帧、每帧 4 KiB，保持门禁。标题四个方法的 AST 分配站点前后相同；既有 map 回调、Text/预览构造和输入键解析成本明确保留，不宣称整条链零分配或性能提升。新增登录匹配及导航备用键会继承既有 matcher 的临时解析数组/记录成本，无新增对象池或常驻资源。

原始证据在 `.git/ui-followups-20261012/`，含复现/验证日志、独立组件与导航采样、源 AST 审计、队列采样、PR 正文和完整审查快照。所有探针已退出，TUI/loader/listener 已释放，没有创建 worktree、常驻服务或需终止的进程；证据文件保留供复核。原 README 修改与本地未跟踪规划没有进入任一提交，README SHA256 保持不变。真实目标终端目视/键盘、外部 OAuth 与 native clipboard 的边界仍然保留。

### 78.1 导航扩展边界与最终交付核对

PR #129 复审提出两条后续意见，均在该 PR 内修正：扩展已获准覆盖的快捷键仍被 viewport 提前消费；修饰键顺序及 return/enter 别名的语义等价没有参与冲突判断。前者仅在扩展 setup/reset 和冷态配置 rebuild 中保存规范化键名，不保存 handler，不改写用户配置；后者复用既有 key-ID parser，在配置期统一逻辑键身份。空扩展 reload 恢复 viewport 键并清空 editor callback。新补的两个生产路由场景同时覆盖默认/显式 viewport 键、保留键拒绝、重复 setup、空 reload、修饰键顺序和别名；先复现丢失调用，再验证修复。导航累计八项通过；既有 parser/matcher/formatter/viewport/editor 共六个方法经 AST 抽取比较未改变。两条线程均已回复并解决：[扩展覆盖](https://github.com/dragonbaba/super-pi/pull/129#discussion_r4245462031)、[键位规范化](https://github.com/dragonbaba/super-pi/pull/129#discussion_r4245527595)。

扩展覆盖启用后的有限分配采样为 12588/12175/12248 B/input，每组 128 帧、0 measured Promise、队列高水位 1、零 active/pending bytes；清空覆盖后键位恢复，12 个 manager/TUI/input/terminal WeakRef 全部释放。规范化修正只改变冷态配置逻辑，因此只重跑受影响的八项路由回归、typecheck 和方法源码比较，复用已有热路径分配证据。本轮累计 23 项不同的定向测试，没有运行全量本地套件。

复审另发现用户 JSON 中大写 `CTRL+HOME`/`CTRL+END` 未参与统一优先级比较，两条审查记录指向同一根因。冷态 rebuild 新增临时规范化 claim 集合，保留原配置和冲突诊断的拼写；既有编辑器覆盖用例加入大写 JSON 变体，先复现 `abcdx` 而非 `xabcd`，修正后导航八项、typecheck 和六个生产方法源码比较通过。相关[第一条](https://github.com/dragonbaba/super-pi/pull/129#discussion_r4245594394)、[重复条目](https://github.com/dragonbaba/super-pi/pull/129#discussion_r4245594636)均回复并解决；129 累计五个独立根因、六个审查线程，未因此扩大本地测试范围。

最终候选：129 `96e9d374a77872bed4994aa4212ae01a2af191a9`；130 `0ac8c2fe4013e1d4822b8610c80018fa722d5e4c`；131 `92ba7ffe0c992eb930dc3c89b9cf1e5a5fec9207`。三个候选各自的六分片 CI 均成功（[129](https://github.com/dragonbaba/super-pi/actions/runs/38217967076)、[130](https://github.com/dragonbaba/super-pi/actions/runs/38213952409)、[131](https://github.com/dragonbaba/super-pi/actions/runs/38214252573)），同 head 审查均无重大问题（[129](https://github.com/dragonbaba/super-pi/pull/129#issuecomment-6119836843)、[130](https://github.com/dragonbaba/super-pi/pull/130#issuecomment-6119206893)、[131](https://github.com/dragonbaba/super-pi/pull/131#issuecomment-6119242488)）。最终重新读取三个 PR 的 reviews/comments/reviewThreads，确认分页完整、无未解决线程，均为 OPEN/MERGEABLE。分支和文件哈希记录于 `delivery-manifest.json`，验收快照为 `final-acceptance.json`；没有使用旧 head 的成功结果代替最终候选验收。三个 PR 尚未合并。

本地已切回 main `f73c19c7db64116b82f77b7eaf09be940b157613`。再次核对上轮全局构建记录的七项文件哈希，全部未变；README 原始修改哈希未变，工作区只保留原 README 修改和本地未跟踪规划。所有本轮探针、测试进程已退出，无新建 worktree/常驻服务/待清理进程。实体 Windows Console 键盘、真实 OAuth 和 native clipboard 仍属于未执行的环境边界。

## 79. 三项交互 PR 合并、分支清理与全局离线交付（2026-10-12）

用户明确授权依次合并 #129、#130、#131，清理已合并分支，回到主分支执行全局 Super Pi 离线构建，并继续避免过度测试。每个 PR 在合并前重新读取最终 head、六项 CI、同 head Codex 结论及完整审查讨论，确认 CLEAN/MERGEABLE、全部检查成功、无未解决线程，再使用 match-head squash 合并；不使用旧提交的验收结果。

| 顺序 | PR | 合并时间（UTC） | main 合并提交 |
| --- | --- | --- | --- |
| 1 | [#129](https://github.com/dragonbaba/super-pi/pull/129) | 2026-10-12 07:42:33 | `a8f78c30bda369aa24459e03a3dde6779f417e11` |
| 2 | [#130](https://github.com/dragonbaba/super-pi/pull/130) | 2026-10-12 07:42:52 | `4e9e43313ae6fed68cc4fa92537a1b0335f72767` |
| 3 | [#131](https://github.com/dragonbaba/super-pi/pull/131) | 2026-10-12 07:43:11 | `4414b318f43d636a3e8039edae4cfd924d661c60` |

本地 main 快进到最后一项提交，并与 origin/main 一致。清理前精确核对三个分支的本地/远端 SHA 与已合并 PR 的最终 head 相同、合并提交已进入 main、分支没有被 worktree 使用；远端用 atomic push 和逐 ref 旧 SHA lease 删除，本地删除前再次验证 SHA。已删除三个远端和三个本地分支：`codex/ui-fullscreen-navigation`、`codex/ui-login-url-copy`、`codex/ui-excluded-bash-title`。完成后本地仅 main，远端仅 main（另有 origin/HEAD 符号引用）；已有 detached worktree 与标签未改动。

只运行一次全仓 `npm run build:offline`，全部包成功构建。本机全局 `super-pi-monorepo` junction 仍指向当前仓库，因此更新构建产物直接更新全局入口，无需重装。实际入口 `C:\Users\Administrator\.nvmd\bin\superpi.exe` 的两项隔离状态离线冒烟通过：`--offline --version` 返回 `0.84.1`，`--offline --help` 正常退出，网络拦截计数均为 0。观察到 Node、launcher 和 dist CLI 都指向当前仓库交付链。包版本号未变，以 main SHA 和十一项交付文件 SHA256 标识此次构建。

本轮没有新增生产代码，没有重跑全量本地测试、性能基准或人工触发 CI，也没有真实 provider/OAuth/剪贴板/终端交互操作。验证用临时目录按记录路径清理，所有自建进程退出；原 README 修改保留且哈希不变，本地规划只追加本节，均未提交。审查快照、合并记录、精确分支清单、构建日志及全局入口验证在 `.git/ui-followups-delivery-20261012/`。

## 80. 硬件光标与模拟光标重复显示（2026-10-13）

用户认可 §77 光标候选，授权先确认、修复并新建独立 PR，继续遵守代码约束并避免过度测试；未授权合并或更新全局安装。用户补充平时使用 Windows PowerShell，记得之前版本有光标重叠闪烁。当前 `4414b318f43d636a3e8039edae4cfd924d661c60` 的主屏/全屏 Input、Editor 四条实际帧路径均复现同时显示硬件光标和反色模拟光标；不以此宣称已观察当前真实终端像素或 IME 候选窗。

独立分支 `codex/hardware-cursor-display`，提交 `5159f7c7f51bc574d186652a668c95f5f14ac588`，[PR #132](https://github.com/dragonbaba/super-pi/pull/132)。创建后立即发布 [@codex review 请求](https://github.com/dragonbaba/super-pi/pull/132#issuecomment-6132082843)。当前等待同一提交的 CI 六分片和审查结果，本节后续追加最终闭环状态。

设计门禁与完整链审计先于生产修改，记录在 `.git/hardware-cursor-20261013/design-gate.md`。Input/Editor 以零宽 APC 标记模拟光标，renderer 根据每个 TUI 的设置决定反色显示；开启硬件光标时仅抑制焦点位置的模拟光标，保留文字/列宽、IME、无焦点模拟光标和普通反色样式。覆盖主屏完整/有界渲染、全屏、嵌套缓存弹层和正常退出回显。合成时保留右边界定位标记，选择高亮不再把 APC 定位标记当作样式重复继承。raw render 的返回标记变化与自定义组件 opt-in 已写入 TUI README。复用调用方持有的帧数组，不增加全帧 map/copy、逐帧回调、Promise/AbortController、包装对象、定时器、对象池或新持有引用。

本地验证：12 项新光标行为回归通过，相关帧/合成 AST 与正则源码门禁、ANSI 边界/选择回归和既有队列 abort 引用释放检查通过；`npm run check` 通过。未执行本地全量测试或离线构建。Windows x64、Node 26.4.0，同机同 fixture 的生产输入/渲染链每种路径 16 次预热 + 3×128 次采样，最终中位采样字节/更新：主屏 Input 8,274→8,299，主屏 Editor 13,096→12,957，全屏 Input 12,631→12,391，全屏 Editor 13,715→14,952（约 +9%）。标记及行替换有有界字符串成本，短采样存在噪声，不将此称为零分配或性能提升。确定性计数每组 128 帧、队列上界 1、正常路径 Promise/Controller/wrapper/full-frame-copy 为 0、结束时 active/pending 字节 0；dispose 后受控 GC 回收全部 36 个 owner WeakRef。

选择路径新增修正另做一次有界生产 Alt 基线/候选对照（32 项、16 预热、128 帧）：采样 14,404→14,167 字节/帧，布局/合成计数不变，dispose 后全部布局与合成引用计数为 0。一次既有 512 帧队列基准和 abort 行为检查确认 flush/abort 释放引用。证据、源码哈希和基线归档在 `.git/hardware-cursor-20261013/`；全局交付十一项文件哈希全部与 §79 一致。

范围外记录：审计发现原有 `ViewportContainer.renderViewportTail` 对单个普通多行 child 的尾部取样存在偏移问题：5 行 child、tail height=4 会返回前 4 行并标 startLine=1。相关生产方法未被本 PR 修改；独立根因不混入本次光标修复，留待后续单独确认与定界。光标的 Main 有界渲染测试使用普通单行组件栈，单独验证 renderer 的光标设置变化。

原 README 修改及本地规划未提交；README SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。没有创建 worktree、常驻服务或遗留任务子进程。

§80 CI 修正记录：首轮 CI 的 Linux 2/2 与 Windows 2/4 均在同一个旧菜单 golden 断言失败，差异仅为 Input 的 raw cursor 从反色 SGR 变为延迟 APC 标记。保留固定 golden 数据，用生产光标解析器解析后再比较可见输出；测试的 jiti 显式指向源码 TUI，避免依赖本机全局 dist 重建。仅复跑失败的菜单检查及 no-emit 类型检查，均通过，未改生产代码、未重跑性能基准。修正提交 `27dac208cbd1a18d828b91929c1ab608e6f7196c` 已推送，同步补发 [@codex review](https://github.com/dragonbaba/super-pi/pull/132#issuecomment-6132154946)，最终候选的 CI 为 [38305133853](https://github.com/dragonbaba/super-pi/actions/runs/38305133853)，审查服务已确认切换到新 head。当前待该轮结束。

§80 最终交付闭环：PR #132 最终 head 为 `27dac208cbd1a18d828b91929c1ab608e6f7196c`，上述 CI 的 **2 个 Linux + 4 个 Windows 分片全部成功**。[Codex 最终审查](https://github.com/dragonbaba/super-pi/pull/132#issuecomment-6132215217) 明确审查 `27dac208cb` 且未发现重大问题；再次核对当前 head 的未解决审查讨论为 0。PR 保持 OPEN/MERGEABLE，未合并。当前本地分支为 `codex/hardware-cursor-display`，已推送；仅原 README 修改与本地未跟踪规划留在工作区。最终再次核对 7 个性能测量源码哈希、11 个全局交付文件哈希及原 README 哈希均符合记录。最终远端快照与交付摘要在 `.git/hardware-cursor-20261013/final-*.json` / `delivery.json`。

资源说明：没有活动任务子进程或服务。尝试清理记录在案的 `.git/hardware-cursor-20261013/selection-baseline` 解压基线目录时，自动审批策略在执行前拒绝，理由仅为 `blocked by policy`；没有执行删除，也未换用其他删除方式。该目录及源码归档保留作复现证据，不属于 PR 内容，不影响全局安装。

## 81. PR #132 授权合并（2026-10-13）

用户授权“可以合并，然后合并后进入下一阶段”。合并前重新核对 PR #132 head `27dac208cbd1a18d828b91929c1ab608e6f7196c`、六分片 CI 全成功、同 head Codex 审查无重大问题、未解决线程为 0。按 head 锁定 squash 合并，GitHub 确认合并提交 `6821e5d3e9c1111e6f79d86e4decfe6f1c9f8704`，时间 2026-10-13 06:17:44 JST；本地主分支已 fast-forward 到 origin/main 同一提交。没有清理此前分支或重建全局安装；本次授权合并和下一阶段，不将未请求的全局发布混入。

## 82. 普通多行组件尾部裁剪偏移（2026-10-13）

依照 §80 独立问题记录启动下一阶段，分支 `codex/viewport-tail-offset`。在 main 基线 `6821e5d3` 的生产 Main 单 ViewportContainer 和复合根两条路径均复现：五行组件在四行窗口返回前四行、startLine=1，最后输入行及光标丢失。首次七项定向用例中六项红灯，混合索引 offset 控制用例原本通过。修改前设计门禁及完整生产/释放链审计见 `.git/viewport-tail-20261013/design-gate.md`。

修复普通完整数组的行号基准，只复制可见源区间；索引组件继续保留自己的 startLine。复用原范围渲染的 Kitty 边界查找，保留跨边界图片及 Main 回退。将子组件采集移入已有 finally 覆盖范围，成功和异常均清空借用数组和图片引用。无新池、缓存、逐帧闭包、Promise、Controller 或全帧副本；保留原有可见区输出分配及按 owner 生命周期持有的 scratch。

候选 `fc4cbac46f46079f4cd385f0bebd05b7b1715e6b`，[PR #133](https://github.com/dragonbaba/super-pi/pull/133)，创建后立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/133#issuecomment-6132888183)。本地共 34 项不同的相关检查通过（8 项新回归、12 项光标、12 项帧 AST/source、2 项既有普通根/图片边界），`npm run check` 通过。没有本地全量测试或压力/长稳测试。当前等待 [CI 六分片](https://github.com/dragonbaba/super-pi/actions/runs/38310480671) 和同 head 审查。

Windows x64 / Node 26.4.0，同机同 fixture 两种 Main 根路径各 16 次预热、3×128 更新：采样字节/更新中位数单根 10,074→11,870，复合根 10,173→10,649。短样本包含 fixture 字符串生成和正确尾部文本，存在波动；不据此宣称性能提升。确定性计数每组 128 次普通组件 render/128 帧、全历史回退 0、Promise/Controller/wrapper/full-frame-copy 0，队列上界 1，active/pending 字节归零。512 行普通文本仅读取 4 个可见行及 1 个边界行。dispose 后缓存计数全零（组件语义子节点随 owner 存活），受控 GC 回收全部 24 个 owner WeakRef。既有 512 请求队列基准仅生成/写入 2 帧、active write 上界 1、flush 引用归零。完整原始摘要、源码哈希、失败复现及队列结果保存在上述证据目录。最后提交相对采样只移除两个空白行，不需要重跑 profile。

README 原改动哈希仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地规划均未提交；全局 11 项文件哈希与 §79 一致。无新 worktree、常驻进程或临时服务。未宣称真实 Windows 控制台像素/IME 窗口验收，终端证据来自生产 renderer 和模拟终端/布局。

§82 最终交付闭环：PR #133 最终 head `fc4cbac46f46079f4cd385f0bebd05b7b1715e6b` 的 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38310480671) **2 个 Linux + 4 个 Windows 分片全部成功**。[Codex 审查](https://github.com/dragonbaba/super-pi/pull/133#issuecomment-6132928449) 明确审查 `fc4cbac46f`，未发现重大问题，未解决审查线程为 0。PR 当前 OPEN/MERGEABLE，未合并；本地和远端 `codex/viewport-tail-offset` 均指向最终 head。工作区仅用户原 README 修改及本地规划未提交。没有新增运行中的任务进程；当前证据保存在 `.git/viewport-tail-20261013/final-*.json` 与 `delivery.json`。

## 83. PR #133 授权合并（2026-10-13）

用户授权“可以合并，然后继续下一步”。合并前复核最终 head `fc4cbac46f46079f4cd385f0bebd05b7b1715e6b`、六分片 CI 全成功、同 head Codex 无重大问题、未解决讨论为 0。以 match-head 约束 squash 合并 [PR #133](https://github.com/dragonbaba/super-pi/pull/133)，合并提交 `251438c4fc158760bf09b13ec3cc4dc8fcdde0f6`，时间 2026-10-13 07:00:04 JST；本地 main 随后 fast-forward 与 origin/main 一致。本轮未清理既有分支或重建全局安装。

## 84. 全局与项目 settings.json 的编辑器 Schema（2026-10-13）

按 §77 剩余候选启动独立 Schema 功能，先覆盖实际使用的全局 `~/.sp/agent/config/settings.json` 与项目 `.sp/config/settings.json`。models/keybindings/MCP/扩展独立配置不混入此 PR。分支 `codex/settings-json-schema`，基线为 §83 合并提交。设计门禁先于修改，记录于 `.git/settings-schema-20261013/design-gate.md`；审计当前 Settings 与全部嵌套接口、getter、兼容迁移、路径、项目信任加载和启动代理入口。

新增 coding-agent 包根目录两个静态 draft-07 Schema，覆盖本地扩展字段、旧 queueMode/websockets/skills/retry 写法，诊断未知字段和类型错误；项目 schema 提示 global-only 的 PowerShell 路径/状态、默认信任和 HTTP 代理项。项目 schema 以相邻文件引用全局定义，不设置会使本地引用转向网络的绝对 $id，文档提供在线/离线使用方法。局部对象字段继续可继承，例如项目只开启 toolResultPresentation、预算来自全局；不在每个局部文件强制要求完整有效配置。运行时加载仍宽松，不导入/获取/验证这些 Schema，也不改变 trust 或迁移。draft-07 引用带说明的字段通过 allOf 保留注释语义。

本地仅 5 项定向测试，覆盖 schema 离线编译、接口字段覆盖、合法本地/旧/分层配置、错误字段和值、全局项目限制、原运行时信任/兼容语义；全部通过。`npm run check` 与 diff 检查通过；一次离线 npm pack dry-run（禁止脚本）确认包清单包含两个 schemas/*.json，无发布包生成。本机 npm 输出为按 workspace 名称索引的对象，已据实际结构读取清单，不再重复打包。测试使用已经安装并锁定的 Ajv 8.20.0，显式声明为根开发依赖，锁文件只增加该根声明，没有升级任何版本。没有本地全量测试、分配基准或全局构建，因为生产 TypeScript/JavaScript 未改，settings-manager/main/http-dispatcher 前后源码哈希一致，Super Pi 无新增缓存、资源或热路径分配。

候选 `6dfbdb1b7b343e7f81ae9213da29afb73dbaae60`，[PR #134](https://github.com/dragonbaba/super-pi/pull/134)，创建后立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/134#issuecomment-6133495432)。当前等待同 head 的 [CI 六分片](https://github.com/dragonbaba/super-pi/actions/runs/38314794666) 与审查完成。未进行编辑器 GUI 实测；schema 规则、离线引用、包路径已验证。

用户原 README 修改及本地规划未提交，README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。全局交付 11 项文件哈希仍与 §79 相同。无新 worktree、常驻进程、定时器或临时服务，证据保存在 `.git/settings-schema-20261013/`。

§84 最终交付闭环：PR #134 最终 head `6dfbdb1b7b343e7f81ae9213da29afb73dbaae60` 的 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38314794666) **2 个 Linux + 4 个 Windows 分片全部成功**。[Codex 审查](https://github.com/dragonbaba/super-pi/pull/134#issuecomment-6133555343) 明确审查 `6dfbdb1b7b`，未发现重大问题；再次读取审查线程为 0。PR 当前 OPEN/MERGEABLE，未合并；本地与远端 `codex/settings-json-schema` 均指向该最终提交。仅原 README 修改和本地规划留在工作区，没有新增活动进程或服务。最终远端快照和交付摘要位于 `.git/settings-schema-20261013/final-*.json` 与 `delivery.json`。

## 85. PR #134 授权合并（2026-10-13）

用户明确授权合并 #134 后继续下一步。合并前复核最终 head `6dfbdb1b7b343e7f81ae9213da29afb73dbaae60`：六分片 CI 全部成功，同 head Codex 无重大问题，审查线程为零，PR OPEN/MERGEABLE。以 match-head 约束 squash 合并 [PR #134](https://github.com/dragonbaba/super-pi/pull/134)，合并提交 `291091731395ab3419390c5e2913b7079b665e1d`，时间 2026-10-12T22:42:09Z（日本时间 2026-10-13 07:42:09）。本地 main 已快进与 origin/main 一致。本轮未清理既有分支或重建全局安装。

## 86. 全局 keybindings.json 的编辑器 Schema（2026-10-13）

继续 §6/§77 的配置 Schema 候选，作为 §84 settings Schema 的独立后续。分支 `codex/keybindings-json-schema`，基线为 §85 合并提交。编码前记录 `.git/keybindings-schema-20261013/design-gate.md`，审计 KeybindingsManager.create → getConfigDir(agentDir)/keybindings.json → JSON/BOM 加载 → 名称迁移 → 值过滤 → TUI 绑定解析，以及 normalizeKeyId/matchesKey 与独立 registerShortcut API。配置仅从全局目录加载，不增加项目键位文件入口。

新增 coding-agent 包根静态 draft-07 `schemas/keybindings.schema.json`：覆盖当前 85 个内置动作、59 个兼容旧名称、动作说明、string/string[] 与空数组解绑、$schema 元数据。未知动作名和错误类型由编辑器诊断；现名优先于旧名、未配置动作的默认值、非法值过滤、文件不回写均保持。按键字符串不另立语法，大小写、修饰符顺序、esc/return 等兼容能力保留；schema 不承诺识别无效按键、冲突或终端支持。无平台相关默认键位副本，使用 /hotkeys 查看有效配置。内部引用支持单文件离线使用，文档给出在线与本地路径。

本地 4 项定向检查全部通过：离线编译、源码动作/旧名全覆盖、接受/拒绝类型、真实 BOM 配置加载与迁移优先级/解绑/默认值/不回写；`npm run check` 与 diff 检查通过。一次禁止脚本的离线 npm pack dry-run 确认三个 schema 文件全部包含。没有本地全量测试、重复渲染测试、分配基准或全局构建：生产 TypeScript/JavaScript 完全未改，四个审计源文件 SHA256 前后一致，零新增运行时状态/缓存/池/监听器/定时器/热路径分配。测试只创建一个自有临时目录并在 finally 中按精确身份删除。未声称编辑器 GUI 或真实终端显示验收。

候选 `fad7f7f3e550d06dc6cd1aaadb14edaf999fb149`，[PR #135](https://github.com/dragonbaba/super-pi/pull/135)，创建后立即发布 [@codex review](https://github.com/dragonbaba/super-pi/pull/135#issuecomment-6134096804)，已附加本任务。当前等待同 head 的 [CI 六分片](https://github.com/dragonbaba/super-pi/actions/runs/38318691027) 与审查，不把已发起写成已完成。

用户原 README 修改和本地规划均未提交，README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`。全局 11 项文件哈希仍与 §79 相同，无新 worktree、常驻进程或临时服务。证据保存在 `.git/keybindings-schema-20261013/`。本轮没有获得 #135 合并授权。

§86 审查已完成：[Codex](https://github.com/dragonbaba/super-pi/pull/135#issuecomment-6134130566) 明确审查 `fad7f7f3e5`，未发现重大问题。首轮 CI Windows 4/4 在既有 bash-running-responsiveness 的 shell failure 用例失败：预期退出码 1，实际发生 8 秒超时及 taskkill exit=128；本轮新增 schema 测试尚未执行。相关生产代码、fixture 和测试 runner 均与 main 相同。其余 Windows 分片被矩阵 fail-fast 取消，Linux 尚在运行。已保留失败 job 原始日志和诊断记录；不将现象直接说成已证明的主机原因，也不修改断言或放宽超时。待该轮结束后，仅对未通过分片进行一次同提交重跑，以核实偶发性。

§86 CI 定向复核：首轮 Linux 2/2 全部成功后，已在原 run `38318691027`、原 head `fad7f7f3e550d06dc6cd1aaadb14edaf999fb149` 上请求一次 failed-jobs 重跑，仅包含 Windows 失败/取消的四个分片；保留 Linux 成功结果。原始六个 job 快照保存在 `ci-attempt1.json`，请求记录为 `rerun-request.json`。没有修改代码、放宽测试、创建额外提交或启动本地全量验证。

§86 最终交付闭环：PR #135 最终 head `fad7f7f3e550d06dc6cd1aaadb14edaf999fb149` 的 [CI](https://github.com/dragonbaba/super-pi/actions/runs/38318691027) **2 个 Linux + 4 个 Windows 分片全部成功**；run 与六个最终 job 的 head_sha 全部一致。一次仅重跑未通过 Windows 分片后，原超时用例明确 `ok 5`，整个 bash-running-responsiveness 文件退出 0，日志保存在 `retry-windows4.log`。未更改代码、断言或超时，没有第二次重跑；首轮超时原因未被证明，保留原失败证据。[Codex](https://github.com/dragonbaba/super-pi/pull/135#issuecomment-6134130566) 同 head 无重大问题，审查线程为零，comments/reviews/threads 分页完整。PR 当前 OPEN/MERGEABLE，尚未合并。

最终远端快照为 `final-pr.json`、`final-ci.json`、`final-jobs.json`、`final-review.json`，交付摘要为 `delivery.json`。本地与远端 `codex/keybindings-json-schema` 均指向该提交；仅用户原 README 修改与本地未跟踪规划留在工作区。无新常驻进程、服务或 worktree，全局 11 个文件哈希仍与 §79 一致。

## 87. PR #135 授权合并（2026-10-13）

用户授权“可以合并”，并询问是否基本没有剩余工作。合并前再次复核 PR #135 最终 head `fad7f7f3e550d06dc6cd1aaadb14edaf999fb149`：六个 CI 分片全成功，同 head Codex 无重大问题，审查线程为零，comments/reviews/threads 分页完整，PR OPEN/MERGEABLE。以 match-head 约束 squash 合并 [PR #135](https://github.com/dragonbaba/super-pi/pull/135)，合并提交 `af067d5efe3bc61128a4cda3162d23e908d3ece5`，时间 2026-10-12T23:11:17Z（日本时间 2026-10-13 08:11:17）。本地已切回 main 并 fast-forward，与 origin/main 一致。合并记录保存在 `.git/keybindings-schema-20261013/pr135-merged.json`。

## 88. 本轮开发收尾核对（2026-10-13）

此节更新 §75/§77 的当前状态，不改写历史探测或验收边界。§4 的 37 个 T 类条目全部勾选，未勾选为 0（包括有证据的排除/已有实现，不全部算新增修复）；§5 的 F01–F08 八组均已完成并合并。后续选定的 Home/End 与全屏导航、登录 URL 复制、!! 标题颜色、硬件/模拟光标、尾部裁剪偏移、settings 与 keybindings 编辑器 Schema，分别经 PR #129–#135 交付并全部合并。当前 GitHub 开放 PR 为 0。

原规划的必做开发工作及已选定补齐可以收尾。仍保留以下按需候选，不视为必须继续开发的遗留缺陷：

- 模型元数据：明确需要相应模型的默认离线发现时，再固定权威来源做有限补齐。
- Termux 文本剪贴板读取、Herdr 超链接：实际使用对应平台/终端时再做。
- faux 缓存比较优化：测得本地瓶颈后再决定，不为该候选追加压力测试。
- CIMD 公开托管与外部服务器实测：明确部署/接入需求时执行。

本轮 Schema 已覆盖选定的 settings/keybindings 文件；不把 models/MCP/扩展独立配置自动扩展为新的必做 Schema 任务。真实终端目视、原生剪贴板、真实 OAuth/provider、其他架构/打包环境等仍保持各 PR 已记录的验证边界。§86 的既有 Shell CI 超时在一次同提交重跑中未再出现，底层原因尚未确定；若复现再专项诊断，本次不新开性能/稳定性项目。

尚有交付收尾可安排：清理 #132–#135 的已合并分支，主分支执行一次全局离线构建并做最小入口冒烟。本轮仅授权合并和核对，没有执行删除或全局构建；四个已合并本地分支仍保留。全局十一项文件哈希与 §79 的 `4414b318f43d636a3e8039edae4cfd924d661c60` 一致，说明当前全局构建仍为 #131 合并后版本，不能把源码 main 更新说成全局运行时已更新。

本轮新增测试、构建、性能基准、生产代码修改与新 PR 均为 0。证据为 `.git/keybindings-schema-20261013/closeout-open-prs.json` 与 `closeout-audit.json`。原 README SHA256 保持 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`；该修改及本地规划未提交。无新 worktree、常驻进程或服务。

## 89. 最终分支清理与全局离线交付完成（2026-10-13）

用户明确要求“收尾”，承接 §88 的建议，授权清理已合并分支、主分支全局离线构建和最小入口检查。本地与远端 main 均为 `af067d5efe3bc61128a4cda3162d23e908d3ece5`，包含 PR #135。

删除四个远端分支及四个本地分支：`codex/hardware-cursor-display`（#132）、`codex/viewport-tail-offset`（#133）、`codex/settings-json-schema`（#134）、`codex/keybindings-json-schema`（#135）。删除前逐一确认 PR 已合并、分支 SHA 精确匹配最终审查 head、merge commit 已进入 main、没有 worktree 占用；远端以单次 atomic push 和逐 ref 旧 SHA lease 删除，本地删除前再次核对 SHA。现仅保留本地 main、远端 main（另有 origin/HEAD 符号引用）。既有 detached worktree 与标签未改动。

只运行一次全仓离线构建，全部包成功，构建期间 npm 设置为 offline；既有构建脚本的三个递归清理目标已逐一确认属于当前仓库且路径不含重解析链接。全局 npm 包 `D:\Nodes\26.4.0\node_modules\super-pi-monorepo` 仍是指向当前仓库的 junction，无需重新安装。本次构建已把 #132 光标及 #133 尾部裁剪修复纳入全局运行产物；#134/#135 的三个 Schema 是包根静态文件，同样可用。

实际全局入口 `C:\Users\Administrator\.nvmd\bin\superpi.exe` 的两项离线冒烟通过：`--offline --version` 返回 `0.84.1`，`--offline --help` 正常退出，两次网络拦截计数均为 0。入口观察确认 Node 为 `D:\Nodes\26.4.0\node.exe`，launcher 与 dist CLI 来自当前仓库。包版本号未调整，以本次 main SHA 和 24 项文件 SHA256 标识交付。验证使用独立 agent/session/cwd/tmp，自有临时目录按已记录绝对路径验证后清理；未访问真实 provider/OAuth 或做真实终端显示验收。

没有新增生产代码、提交或 PR，没有运行本地全量测试、性能基准或重复 CI。原 README 修改的 SHA256 仍为 `6AA4BD1A5AADF98DBC1A17E0F8B405EC9ECCBB8A0E36DF2096A04C603528519E`，与本地规划均保留且未提交。所有本轮构建和验证进程均退出，无新增 worktree、常驻进程或服务，未中止用户进程；已打开的 Super Pi 需重新启动才能加载新构建。

证据在 `.git/final-delivery-20261013/`：精确分支清单、PR/远端身份快照及删除日志、构建日志与结果、全局入口观察、两项冒烟日志、源码交付哈希和 `delivery.json`。本轮开发和本机交付均已收尾；§88 的按需候选及未覆盖环境继续保留原边界。
