# Pi 1.5.0 借鉴与修复实施方案

日期：2026-11-04。状态：**方案 #175、SDK 前置修复 #176、T01 #177、T02 #178、T03 #179、T04 #180、T05-A #181、T05-B #182、T06-A #183、T06-B #184 和 T06-C #185 已合并；T06-D Chat Completions 正在实施；其余 T06 切片及 T07–T12 尚未实施**。#175 交付 GPL-3.0-only、README、差异评估与本方案；先完成逐项规划，再进入独立修复。不得把“读过源码”“写了测试”或“CI 启动了”记成实施完成。

## 1. 基线、范围与交付顺序

- Super Pi 生产基线：`b81db72154ff703d2378d58362f03cb83e14adc1`，核心包 `1.0.0`。
- 上游参考：Pi `v1.5.0` / `f9a26365568127461c47a07a37dcb42c140a3ac5`；发布记录和本地证据见[差异评估](upstream-pi-1.5.0-diff-assessment.md)及[JSON 记录](evidence/upstream-pi-1.5.0-review.json)。不将未发布 main 内容混入本轮。
- 约束依据：[AGENTS.md](../AGENTS.md)、[Hot-path allocation contract](performance/hot-path-allocation-contract.md)、[测试与 CI 说明](testing.md)。发生冲突时不得用本方案降低契约。
- 方案交付后按 T01 → T02 → T03 → T04 → T05 → T06 → T07–T09 → T10–T12 顺序实施；F 项先做需求/兼容性判定，不自动纳入修复。
- 每个独立根因使用独立实施分支和 PR；共用的锁文件、认证、session 或 provider 模块串行修改，以已合并基线为准。T01 的 SDK transport 前置 [#176](https://github.com/dragonbaba/super-pi/pull/176)、依赖更新 [#177](https://github.com/dragonbaba/super-pi/pull/177) 与 T02 [#178](https://github.com/dragonbaba/super-pi/pull/178) 已依次合并；T03 从 `57e623a2840a1709d0aad92fdd380f5cf78e7367` 开始。不把未合并候选当已交付。
- 用户在 T05-B 开始前明确授权后续各功能：等待 reviewer 对最终 head 完成审核，无问题且检查通过后自动合并、删除对应本地/远端分支、同步 main 并执行下一项；有问题则修复、推送并额外 `@codex review`，等待复审完成。此授权不包含安装到全局环境或发布 npm。

### 1.1 任务索引

| ID | 任务 | 证据 | 路径性质 | 前置条件 |
| --- | --- | --- | --- | --- |
| T01 | 生产依赖公告与兼容升级 | 审计快照 | 依赖触及的生产链按需审计 | 实施日重新核对公告 |
| T02 | 保存的拒绝信任决定 | 源码确认 | 启动/显式命令 | 无 |
| T03 | 登录 URL 和终端字符 | 源码确认 | 登录低频入口；渲染不加校验 | 保留通用打开文件用途 |
| T04 | 会话追加失败一致性 | 方法级故障注入复现 | 持久化/事件链，按热路径要求评估 | 梳理完整成功与失败写入语义 |
| T05 | 扩展 exec 的输出与生命周期 | 部分运行复现 | stdout/stderr chunk 热路径 | 明确跨平台进程所有权 |
| T06 | provider 工具参数增量解析 | 源码确认 | delta → UI → 终端全链热路径 | T01 稳定；先建立基线 |
| T07 | 分支摘要继承推理级别 | 源码确认 | 摘要请求低频；事件保持现状 | 模型能力夹具 |
| T08 | 分支摘要输出上限 | 源码确认 | 大历史处理及请求边界 | T07；先核对现有配置与成本语义 |
| T09 | 摘要 OAuth/key 来源语义 | 待复现 | 认证低频边界 | T07/T08 后串行审计认证链 |
| T10 | 图片编码选择 | 源码确认 | 大结果/图片处理 | 图片质量与透明度夹具 |
| T11 | 多语言工具检索 | 部分已有，部分待改进 | 显式搜索；不能搬进每帧/每请求 | 保留工具准入和 browser 路由 |
| T12 | Windows 路径等价性 | 待复现 | 路径边界及调用者 | 分入口复现，按根因拆分 |
| F01–F06 | Schema、文档、更新说明、账单、目录、Worker 等待 | 产品/兼容性选择 | 见第 6 节 | 不与缺陷修复捆绑 |

每项状态统一为：`待复现/待设计核对 → 可实施 → 实施中 → 待验收 → 已交付`。排除项记录理由及覆盖范围，不打“修复完成”勾。T01 见[依赖实施记录](repairs/pi-150-t01-dependencies.md)；T02 见[保存信任决定实施记录](repairs/pi-150-t02-saved-trust.md)；T03 见[登录 URL 实施记录](repairs/pi-150-t03-login-url-safety.md)。T04 见[会话追加失败实施记录](repairs/pi-150-t04-session-append.md)，已通过 #180 合并为 `423f4e98acecb225ff83cf8b66a051b43198be39`。T05 两个子项已依次合并，见[输出记录](repairs/pi-150-t05-extension-exec.md)和[进程所有权记录](repairs/pi-150-t05b-exec-process-tree.md)。T06-A 先行设计及执行记录见[Anthropic 增量参数](repairs/pi-150-t06a-anthropic-tool-args.md)；其余 T06 切片、T07–T12 和 F01–F06 尚未实施。

用户最新验收约束：**只使用当前 Node 26.13，失败定位根因并修复，不扩展多版本测试来绕过失败。** 现有 Linux/Windows CI 分片统一使用该版本；各任务原先提到的最低版本测试不再作为本轮执行项，包的 engines 元数据不因此自动修改。

T05-A #181 已合并为 `92d5adb8642839140f0229749a0f0b3829f3c550`；T05-B #182 已合并为 `c37c9d6e509ff41650eef21dc81ea97f4ec8cfa5`。两项最终 head 均获 Codex completed/no findings、CI 6/6，通过后删除对应本地/远端分支并同步 main。

T06-A #183 已合并为 `23fd4b6e15e25886dc22e69e703deb278de4ae7c`；最终 head `1044154f9e3b585dc00da02e87a6283cd300905f` 已获 Codex completed/no findings、CI 6/6，本地/远端对应分支已删除。T06-B 的先行设计和证据见 [Responses 增量参数](repairs/pi-150-t06b-responses-tool-args.md)。

T06-B #184 已合并为 `35dc8d10b6e350ecf01fe24007adbf7e1473496b`；最终 head `2458a88685c4d8202d61dc266869bb3a349cba21` 已获 Codex completed/no findings、CI 6/6，相关本地/远端分支已删除。T06-C 见 [Bedrock 增量参数](repairs/pi-150-t06c-bedrock-tool-args.md)。

T06-C #185 已合并为 `4d82e1de7b4c62fe75483dce98d405b01764e3dd`；最终 head `6bdc04e48eca353c1818fb96d10b721a2ac298a8` 已获 Codex completed/no findings、CI 6/6，相关本地/远端分支已删除。T06-D 见 [Chat Completions 增量参数](repairs/pi-150-t06d-chat-tool-args.md)。

## 2. 实施前必须完成的设计门禁

### 2.1 不过度防御、不增加兜底链

1. **在拥有数据或权限的边界校验一次。** 外部 URL、配置、provider 数据、路径在相应入口完成必要验证/规范化，内部消费已建立的事实；不要逐层重复 `typeof`、schema parse、JSON 序列化或文件身份查询。实际写入/授权使用前的变更关键校验仍必须保留。
2. **用真实故障支撑错误分支。** 只为已经复现或协议明确允许的失败建立处理。禁止为了“也许会坏”增加备用解析器、备用 provider、备用身份、备用目录和多级默认值。
3. **错误不能伪装成成功。** 不吞错后返回空串/空对象/默认成功；取消、未执行、执行失败、结果截断、结果不确定分别保留真实含义。不得 catch 后自动换宿主执行、解除信任限制、修改认证来源或重放外部操作。
4. **修复要落在实际所有者。** 复用现有进程等待、流、存储、认证和权限机制；不为单一修复引入通用“安全执行框架”、第二套状态机或全局注册表。仅在现有抽象确实不表达必要状态时增加最小字段。
5. **默认无新重试、无静默降级。** 原有协议规定的重试若仍需要，应说明触发原因、次数、owner、截止时间和副作用安全；本方案不授权复制现有兜底模式到新代码。格式损坏、持久化失败、认证失败不靠重试掩盖。
6. **测试验收行为，不复刻代码。** 使用必要的代表性输入与故障边界；不为可逆文档改动增加运行时测试，不把相同矩阵在单测、集成测试、多个脚本里反复运行。
7. **保持简单。** 小修复优先局部函数/已有类型；不增加没有当前消费者的配置开关、兼容版本分支、缓存和对象池。兼容性分支必须对应当前支持的入口/平台，而不是推测未来需求。

每个实施 PR 必须列出“保留的必要校验、移除/避免的重复校验、失败传播方式”。安全边界校验和真实资源释放不是可删的“过度防御”。

### 2.2 热路径硬约束

实施者必须从生产者一路审计到释放边界，包括已有 helper、SDK 适配、回调、观察者和消费者；第 4 节的调用链是定位起点，不等于已完成全部生产审计。

| 约束 | 必须满足的设计/证据 |
| --- | --- |
| 高频闭包 | 常规帧、delta、progress、chunk 回调内新增 inline arrow/function、Promise executor、then/catch/finally、定时器回调为 0；稳定回调随 owner 创建一次 |
| 异步状态 | 常规帧/provider-delta/tool-progress 每次 Promise、AbortController、signal/options wrapper、Promise tail/数组为 0；只允许契约点名的生命周期边界 |
| 临时对象 | 无每次 wrapper、对象 spread、`Object.assign`、Map/Set；字段形状稳定，可选引用用 `undefined` 释放 |
| 数组与字符串 | 无无界 chunk/行数组；不反复扫描、复制、序列化完整参数/结果/帧。必要 scratch 明确容量、owner、所有退出路径清空及超大 backing store 丢弃条件 |
| 终端帧 | active write ≤ 1、pending latest ≤ 1、queue high-water ≤ 2；每帧完整物化 ≤ 1、应用层完整副本 = 0、busy cycle deferred ≤ 1 |
| 事件交付 | Agent latest observer → AgentSession → 内置 InteractiveMode 的普通交付维持同步；不逐次创建 rejection observer 或 async 包装 |
| 取消与释放 | 区分逻辑取消与物理写入完成；迟到 callback/drain 不得解锁错误代次。正常完成、异常、取消、clear、dispose 的引用/监听器/定时器均有证据 |
| 例外 | 只点名真实的低频启动、关闭、显式命令和生命周期 deadline 函数；不得整文件、整类豁免，不把每帧 helper 改名成生命周期函数 |

默认不新增对象池。确需例外时，先满足契约全部准入条件，再证明采样分配至少下降 20%、CPU p95 回退不超过 5%、最终堆增长不超过 10%。消息、事件、工具结果、provider payload、Promise 和跨异步边界对象等禁池对象仍不得池化。

### 2.3 证据包与停止条件

每个热路径实施项需同时提供：**确定性结构计数 + allocation profile/精确分配计数 + 受控 GC/引用释放证据**。计时、单个 heap delta、旧提交的 CI 或断言“没有新增分配”均不能替代。

记录基线/候选 SHA、fixture 版本、OS/Node、配置、warmup、轮次、采样间隔、调用链、已有/新增分配、每次扫描/复制量和峰值保留字节。结构计数在 CI 执行；同机、同 fixture、串行运行基线与候选进行采样及 CPU 对照，不能让并行基准互相争用。

以下情况停止当前实施、先补设计：结果需要扩大权限/变更默认计费/破坏公开协议；无法确定持久化副作用；需要整体豁免热路径规则；测量只证明移动了分配而未减少工作；必要平台或生命周期验证缺失。停止的是该项，不把不相关项都阻塞，也不通过自动降级绕过问题。

## 3. 共用验收与测试策略

先运行当前项的必要行为回归和命中的 source/AST invariants，再运行对应 allocation benchmark。代码变更完成后执行 `npm.cmd run check`、`npm.cmd run build:offline` 和必要的完整测试；使用已有 runner 的隔离 HOME、session 和 fixture 规则，不读取真实凭据。

已核对存在的公共命令：

```powershell
node scripts/test.mjs --suite all --list
npm.cmd run check
npm.cmd run build:offline
npm.cmd run test:hot
npm.cmd run test:contract
npm.cmd test
npm.cmd run bench:stream
npm.cmd run bench:tui-session-event-allocations
npm.cmd run bench:tui-paced-streamed-tool-args
npm.cmd run bench:tui-frame-queue-allocations
```

这些是按影响选择的工具箱，不是要求每项顺序重复执行所有子集再执行全套。部分 source-invariant 文件按 runner 命名规则归入 unit，不能假定 `test:hot` 已覆盖所有不变量；须核对实际清单。第 4–6 节标注“拟新增”的文件只在对应实施项创建，不把尚不存在的测试或基准写成已可运行。

最终运行时 PR 保留现有 Linux 2 分片、Windows 4 分片 CI，统一 Node 26.13，并记录最终 SHA 对应的结果，不降低断言、不跳过失败、不放宽 job 时限。平台特有能力由对应平台验收；普通 CI 不重放已冻结的 Windows Sandbox 手工验收。原方案/许可文档 PR 的本地验收为许可证/pack 清单、JSON、Markdown 链接和 diff 检查。

## 4. P0/P1 详细任务

### T01 — 生产依赖公告

**问题与范围。** 2026-11-03 生产审计为 16 个受影响包（8 high、8 moderate）。这是锁文件公告匹配，尚非全部调用链可利用性证明。优先处理当前直接依赖和其必要传递依赖，尤其 Undici、glob/minimatch 与 MCP 相关链；不要顺便整体升级所有 provider SDK。

**步骤。** 实施时重新执行生产 audit，结合 `npm.cmd explain <包名>` 确认引入者、使用的 API 和最低修复版本；对照当前 manifest 精确更新。安全公告对应的版本修复优先，只有上游补丁无法覆盖明确可达问题时才设计本地代码改动。新增 override 必须说明无法由父包版本解决的原因。

依赖选择核对项目声明的 engines；按用户最新要求，本轮验收和 CI 只使用当前 Node 26.13，不执行其他版本测试。若修复版要求提高运行时下限，先独立记录兼容性决策，不在安全升级中悄悄抬高 engines。

**边界。** 使用 provider `fetch`/连接、MCP transport/auth、文件工具 glob 的真实链路审计；不在每次请求添加 URL/证书/glob 的多层重复检查。外部 SDK 的分配变化不能被“仅改锁文件”排除，若命中 delta/progress 链则需要相关 profile。

**验收。** 锁文件仅有目标依赖闭包变更；离线安装/构建；按实际升级包运行 provider contract、`mcp-oauth.test.ts`、`mcp-auth-lifecycle.test.ts` 和相关 glob 工具行为。记录修复/剩余公告及适用条件，不承诺不存在无法由当前稳定版本解决的公告。无真实凭据、无自动请求生产 MCP/provider。

### T02 — 保存的拒绝信任决定

**根因。** `resolveProjectTrusted()` 对“没有需信任资源”的目录提前返回 `true`，早于读取保存决定。实施前审计还确认 CLI `main.ts:createRuntime` 的共享启动分支有相同短路，须同时修正，不能只测公共函数。

**最小设计。** 在上述两个现有分支消费 trust store 的有效结果；没有保存决定时才保持原自动信任行为。保留显式 override、会话内决定与有资源目录的 extension hook 优先级，不借此重排所有信任来源。直接 SDK 由宿主传入 SettingsManager/resource loader 的信任状态，不新增隐式磁盘读取策略。

**调用链/文件。** CLI/SDK 资源启动 → [project-trust.ts](../packages/coding-agent/src/core/project-trust.ts) → [trust-manager.ts](../packages/coding-agent/src/core/trust-manager.ts) → resource/package/extension 消费者；检查 TUI/print/RPC/SDK 是否共用决定。低频入口，不增加 watcher、永久缓存或每次工具调用的磁盘查询。

**验收。** `tests/project-trust-decisions.test.ts` 使用独立临时目录验证无资源+保存 false/true/null、父级拒绝、显式 override、有资源 hook、无 UI、坏存储错误与锁释放。已有 `alpha-cli.test.ts` 增加仅含 AGENTS.md 的保存拒绝场景，实际启动 CLI 验证上下文中的有效信任状态。计数确认同次解析只读取必要的 trust 决定；不发起真实 package 安装。安全结论只覆盖信任决策，不宣称验证了 VM 隔离。

### T03 — 登录 URL 与终端控制字符

**根因。** 登录 UI 将外部 URL/文案直接拼接为 OSC 8，而通用 `openBrowser()` 也服务于打开文件，不能直接把它全局改成 HTTP-only。

**最小设计。** 在 provider 登录展示入口解析 Web URL、拒绝不允许协议和控制字符；合法值用于显示、复制和启动。认证/device-code/info 的链接共用同一边界规则。普通提示文本保留必要换行，终端控制序列不能穿透。非法链接明确报告错误，不静默改成主页、不尝试第二个 launcher。

**调用链/文件。** OAuth callback → [login-dialog.ts](../packages/coding-agent/src/modes/interactive/components/login-dialog.ts) 的 showAuth/showDeviceCode/info → Text/OSC 8 与 [open-browser.ts](../packages/coding-agent/src/utils/open-browser.ts)；平台进程出口用测试替身。校验在登录事件中完成一次，不进入 Text.render 或每帧路径。现有 MCP secureUrl/issuer 校验保留，不新增第二套 MCP 校验器。

**状态/验收。** 对话 owner 持有当前 URL，替换/结束时沿用 clearAuthUrl 释放；不增全局 URL cache。扩展 `tests/login-url-copy.test.ts`，覆盖 https、允许的 http、本地/自定义协议、BEL/ESC/C0、复制失败、取消与迟到完成。验证非法输入没有发起 launcher，渲染输出没有注入控制串；不真正打开恶意 URL。普通复制 UI 不回归。

### T04 — 会话追加失败一致性

**根因。** `_appendEntry()` 在 `_persist()` 成功前改变 entries/count/index/leaf；已复现失败后内存条目仍增加。只复制上游 `pop/delete/leaf` 不够，本地还有 `entryCount` 和首次 flush/分隔符状态。

**完整链路。** Agent message_end/custom/session mutation → AgentSession 持久化调用 → `appendMessage`/其他 append → `_appendEntry` → `_persist` → 首次原子创建/已有文件追加/分隔符 → session context、分支、resume、operation storage。入口见 [session-manager.ts](../packages/coding-agent/src/core/session-manager.ts) 和 [agent-session.ts](../packages/coding-agent/src/core/agent-session.ts)。实施前逐个枚举 append 调用者与状态，不只测私有方法。

**最小设计。** 以本次 entry 的固定原始字段保存必要前态；写入明确失败时恢复本次内存变更并传播原错误。不能复制整个 session、重建 byId、遍历全部历史或加第二份事务日志。首次文件创建和已有文件追加分别判断是否可能部分落盘；对结果不确定的追加，阻止当前 writer 继续产生子节点并要求显式重载/既有恢复流程，不自动截断文件或重放消息。该状态只在确有不确定写入时产生，不将普通业务错误升级为全局熔断。

**性能/所有权。** 常规追加新增扫描整段历史 = 0、完整 session 克隆 = 0、临时 map/数组/wrapper = 0；仅允许必要前态原始值和现有 entry。原始 entry 由 session 所有，失败引用立即从本次索引/leaf 撤回。不改变逐条 JSONL 语义，也不以每次重写整文件换原子性。

**验收。** 在 `tests/session-first-user-persistence.test.ts` 与 `tests/operation-write-session.test.ts` 的现有语义上增加首次写入失败、正常追加失败、部分写入不确定、失败后的 parent 链、fork/restore 验证；使用隔离文件和受控故障，不操作真实 session。新增必要的 session append source invariant 与拟新增 `scripts/bench/session-append.ts`：固定历史 0/1,000/10,000 条，对比成功/失败路径扫描量、序列化量、分配和释放。现有 session event allocation benchmark 只覆盖交付，不替代磁盘追加测量。

### T05 — 扩展 exec 输出与资源生命周期

**根因。** [exec.ts](../packages/coding-agent/src/core/exec.ts) 无输出上限；逐块 `toString()` 损坏 UTF-8；spawn 错误被吞；强杀用 `proc.killed` 判断进程是否退出。后两类输出正确性问题已有运行证据。

**完整链路。** extension API/[loader.ts](../packages/coding-agent/src/core/extensions/loader.ts) → execCommand → spawn/stdout/stderr → [waitForChildProcess](../packages/coding-agent/src/utils/child-process.ts) → ExecResult → extension 消费者/工具结果 → 现有展示和大结果链。普通 Bash/PowerShell 后台任务是不同入口，不能因它们有上限而跳过本项。

**最小设计。** 增加一个可选 `maxBuffer`，表示 stdout+stderr 原始字节合计上限；默认按上游 256 MiB 与运行时字符串安全上限的较小者，0 代表不保留输出，非有限/负数/非整数在 spawn 前报错。结果用 `truncated` 标记因容量截断，截断不得返回成功；不新增第二套 maxLines/maxChars 配置。使用每流一个解码器保持分块 UTF-8；进程 owner 持有两路输出、计数、解码器、取消监听和至多一个强杀 timer。先核对公开 ExecResult 消费者再决定类型兼容改法。

**终止设计。** timeout/abort/cap 进入同一已有终止流程，实际 exit/signal/close 事实决定强杀是否仍必要。正常完成清理未触发 timer。Windows 保留本项目要求的 owned process/进程族生命周期，先审查可复用的实现，不能把 POSIX 信号行为当 Windows 证明；不按模糊名称查杀进程。若扩展入口需要进程族补齐，作为 T05 的独立子交付设计，不挪用不相干 shell 权限。

**热路径门禁。** data 回调无新 Promise/closure/controller/options wrapper，不收集无界 chunk 数组；保留输出 ≤ cap，绝不在每个 chunk 做完整 join/hash/JSON/log。解码与必要输出构建属于协议数据分配，必须记录原始字节、解码量和完整结果物化次数；不得将“返回值必要”用作重复全量复制的豁免。

**验收。** 拟新增 `tests/extension-exec.test.ts` 与对应 source invariant/`scripts/bench/extension-exec-output.ts`。覆盖正常/无输出、stdout+stderr 共用额度、边界 UTF-8、缺失命令、cap、超时、已取消、运行中取消、POSIX 忽略 SIGTERM、Windows 所属后代、关闭后迟到输出。超量测试用小 cap，不制造内存耗尽；进程用握手而非猜测 sleep 达到时序。所有 fixture 按实际 PID/owner 清理。最终 timers/listeners/输出引用归零，失败结果含原始诊断。

### T06 — provider 工具参数增量解析

**根因。** Anthropic、Bedrock、OpenAI 等累计字符串后重解析历史参数。先度量各 adapter，而不是直接引入新 parser 后宣布 O(N)。

**完整链路。** transport chunk → `packages/ai/src/api/*` → [json-parse.ts](../packages/ai/src/utils/json-parse.ts) → EventStream → Agent observer snapshot → AgentSession → InteractiveMode/ToolExecutionComponent → render/layout → frame queue → physical write；终态、错误、取消和 release 必须覆盖。审计 `mutation-with-generation`/`replacement-object` 两种参数所有权及 snapshot freeze。

**最小设计。** 每个活动 tool call 一个 parser state，以新增 fragment 前进；结束时进行必要的最终语义校验。不同工具、provider、session 不共享状态，不池化外部可见 arguments。JSON 和 grammar 工具分开建模，不能通过累计全文的隐藏 helper 伪装增量。保留仍属协议需要的最终修复边界，但不在每个 delta 自动尝试多个解析器。

**范围与容量。** 第一切片完成共享解析器及 Anthropic 生产链，第二切片按 Responses 家族和其他累计解析 adapter 分组；每切片各自验收。每 tool state 绑定既有请求/工具输入限制，达到既有上限显式终止；不得无故降低公开输入能力或给所有 provider 发明不兼容深度限制。尚未存在的上限需先补明确产品语义，不能在编码时临时猜值。

**计数/性能门禁。** 记录每 tool 累计输入字节、parser 消费字节、完整重解析次数、完整副本数、活动 parser 数与 retained bytes；固定 N、2N、4N 输入及不同 delta 粒度验证累计扫描随输入线性增长，常规 delta 不扫描完整历史，终态校验最多一次。取消/结束后 parser scratch 和工具大引用按 owner 清空；保留外部拥有的最终结果不算泄漏。

**验收。** 扩展 `tests/provider-contract/streamed-tool-argument-ownership.contract.test.ts`、`tool-argument-recovery.contract.test.ts`、`responses-terminal-tool-calls.contract.test.ts`；覆盖字符串/escape/Unicode 分割、嵌套、数值边界、并行工具、错误结束、取消、grammar 与迟到 delta。运行 stream/tui/codemode 相关 AST/source invariants；拟新增 `scripts/bench/provider-tool-args.ts` 测真实 adapter，再运行 `bench:stream`、`bench:tui-session-event-allocations`、`bench:tui-paced-streamed-tool-args` 和受影响的 frame queue benchmark。现有 paced fixture 从 Agent 侧构造参数，不能独自证明 provider parser 已优化。

### T07 — 分支摘要推理级别

**根因与改动。** AgentSession 分支摘要未传当前 thinking level；在现有 BranchSummaryOptions 中贯通单个字段，并通过现有模型能力规则生成摘要请求。不要为每个模型增加手写白名单，不把不支持的 level 静默改成另一个计费模式。

**链路。** 用户 tree/fork summary → `AgentSession` → [branch-summarization.ts](../packages/coding-agent/src/core/compaction/branch-summarization.ts) → `completeSummarization` → 当前 stream/provider。低频请求边界；不改变普通 delta/event lane。

**验收。** 用假的 stream 捕获请求，覆盖 reasoning off/on、模型能力限制、切换 level、abort 和重试继承。扩展现有 `tests/provider-contract/openai-compaction-lifecycle.contract.test.ts` 或建立一个聚合的 branch-summary contract 文件；只测必要分支。每个摘要只生成一次请求配置，不另建长期缓存，取消后释放 callbacks/auth snapshot。

### T08 — 分支摘要输出上限

**根因。** 固定 `maxTokens: 2048` 可能不足以容纳推理和文本；上游改为模型上限，但本项目不能未经评估默认扩大费用。

**先决策再修改。** 先检查现有分支摘要配置与 provider 参数语义，用离线 fixture 区分输出上限、输入 reserveTokens、可见文本上限。优先复用已存在的输出配置；确无可用字段时，单独设计可选摘要输出上限，默认保持现有成本边界。扩大默认值必须作为明确产品选择，不夹带在 T07 修复中。

**设计/验收。** 用户显式值按已知模型 maxTokens 限制一次，未知能力不猜测无限上限；不因 length 失败自动二次付费重试。准备大历史时只做必要遍历与序列化，不增加第二份完整 conversation。覆盖合法上限、模型限制、空摘要、reasoning-only/length 终态和取消；测序列化次数、峰值 retained bytes 和释放。`scripts/bench/compaction-summary.ts` 是可能访问真实 provider 的语义评估工具，不将 `--run` 纳入普通 CI 或自动执行。

### T09 — 摘要认证来源语义

**证据边界。** 本地会将解析到的 `apiKey` 传入摘要流，但已有专用 auth snapshot/stream 边界；尚未证明与上游 OAuth 问题等同。

**复现先行。** 审计 `_getSummarizationRequestAuth` → `_createSummarizationStream`/SDK runtime → provider auth，比较普通 prompt、compaction、branch summary 的存储 OAuth、显式 key、headers、model/baseUrl；全部使用虚构凭据和假 transport。

**若成立。** 在现有类型/边界保留认证来源，避免把存储 OAuth 当显式 API key 再解析；优先消费已有 auth 结果，不新建凭据缓存，不再次读文件、不在每个 delta 刷新或捕获失败后改用环境变量。若已有等效行为则以证据关闭，不为迎合上游补丁重构。

**验收。** 同一次摘要只解析必要认证，重试按既有事务语义使用有效快照；模型切换/取消/登出后旧 owner 不能继续请求。沿用 compaction lifecycle 与 OAuth refresh transaction 回归，记录 auth lookup/refresh/request 次数和引用释放；严禁日志记录 token/header 值。

## 5. P2 详细任务

### T10 — 图片编码选择

**链路。** 输入草稿/图片来源 → [image-resize.ts](../packages/coding-agent/src/utils/image-resize.ts) → worker 协议 → [image-resize-core.ts](../packages/coding-agent/src/utils/image-resize-core.ts) → provider payload → 取消/Worker 清理。图片是大结果路径，不能只对编码 helper 测耗时。

**最小设计。** 避免“PNG 只要低于上限就优先返回”；对不透明照片选择满足质量要求的较小候选，透明图保持 alpha，截图保留文字质量。只保留当前最优与当前候选，不同时 materialize 所有 JPEG 档位的 base64。最终选定后才做一次 base64；不引入第二个图像库、全局图片 cache 或新主线程兜底。现有 worker/fallback 是否有必要另按已知协议审计，不扩张其触发条件。

**验收。** 照片、透明 PNG、文本截图、旋转、极小图/维度上限、编码失败、取消各一组代表输入；扩展 `tests/image-resize-worker.test.ts` 和 `tests/image-review-boundaries.test.ts`，保持现有图片 owner 测试。拟新增 `scripts/bench/image-encoding-selection.ts`，记录编码次数、base64 次数、峰值同时候选字节、请求尺寸、CPU/分配及 photon/native buffer/Worker 释放。质量和透明度未满足不得用字节更小宣布通过。

### T11 — 多语言工具检索

**现状。** 已有 Unicode 字母/数字分词与完全工具名高权重。修复只针对规范等价字符串、无空格词边界、多词覆盖和名称/描述排序，不重新实现整套工具发现。

**链路/设计。** 显式 tool_search → [tool-classification](../packages/tool-classification/src/index.ts) 的 catalog/filter/score → activation → 现有权限边界。先用中文、日文、拉丁组合字符和英文多词夹具确定排序；在搜索入口规范化 query 一次，名称权重与普通描述词区分，精确匹配保持优先。先评估已有平台 `Intl.Segmenter`，不为模糊召回默认安装大分词依赖。

**状态/验收。** 第一版不引入新永久索引；若 profiling 证明 catalog 文本重复处理占主导，再按 catalog generation 定义单 owner 有界缓存和 reload/dispose 失效。保留 unavailable、active、policy-owned、browser/browser_debug 排除；不因查询命中而恢复授权。扩展 `tests/policy-diagnostics.test.ts` 或拟新增 `tests/tool-search-ranking.test.ts`，固定 100/1,000 工具规模，记录词数、比较数、分配和稳定排序；不加到每次模型请求或每帧。

### T12 — Windows 路径等价性

**先定位。** [paths.ts](../packages/coding-agent/src/utils/paths.ts) 的 realpath 成功/失败语义不等于所有消费者正确。分别复现 trust、Skills 去重、session resume、自定义目录和 package remove；相同根因才复用同一个修复。

**最小设计。** 规范化与比较由路径身份边界负责，已有文件使用实际 identity/realpath；缺失路径使用明确的词法规则。Windows 盘符、大小写、UNC、junction 与支持大小写敏感目录的语义分开；不能对所有路径 `toLowerCase()`，不能用字符串前缀冒充目录包含判断。保存记录只在已有格式确需迁移时显式迁移，不能猜测合并两条授权记录。

**验收/性能。** Windows 与 POSIX 对照，覆盖存在/不存在路径及同名不同对象。首次解析可做必要 I/O；高频查找消费已得到的身份，不新增逐次 realpath/stat。不同消费者若生命周期不同则拆 PR。每项记录实际 I/O 次数，旧 session/权限不得被自动覆盖；无复现的入口记录排除，不为了统一美观大规模重构。

## 6. 功能候选：先决策，不混入缺陷修复

| ID | 候选与最小方案 | 准入/验证及性能边界 |
| --- | --- | --- |
| F01 | `pi-schema`/TypeBox 验证迁移 | 先列本地 TypeBox 专有能力、MCP、Codemode 与公开扩展兼容矩阵；证明规范化后的同一份参数用于授权和执行。禁止“新验证失败再试旧验证”的双 validator。只在收益和兼容性明确后另开迁移方案。 |
| F02 | 从 schema 生成配置文档 | 在构建/维护阶段生成，定义唯一权威 schema，人工内容只解释语义；普通运行不启动文档生成器。校验生成结果确定性、链接与覆盖字段，不新增运行时配置默认值。 |
| F03 | 扩展更新说明 | 先确认项目需要。只在显式更新/冷启动读取受限大小的 changelog，并记录已读版本；不每帧读文件、不自动联网拉取说明、不为读失败阻止核心启动。合法不可用状态以单次明确提示表达，不轮询重试。 |
| F04 | 费用实际来源标记 | 审计 provider reported total 与 catalog estimate 的当前类型/聚合消费者；复用已有 usage，不按 delta 扩展一套账本。混合来源不能冒充全部实付，缺少账单不能猜 0。用已知计费响应离线验证，总结阶段更新来源标记。 |
| F05 | OpenRouter 账户模型目录 | 先核对本地是否已等效支持；若需要，按账户身份与 endpoint 明确 cache key、刷新和登出失效，不用原始 key 作日志/持久索引。请求失败不得把公共目录伪装成账户授权结果；不在常规推理路径重拉目录。 |
| F06 | Codemode 等待空闲 Worker | 先量化现有容量拒绝是否造成实际问题；不默认加队列。若成立，单 owner、有界接纳、明确取消与关闭；不得悄悄增加并发/预算，不复用已释放 VM 或恢复旧权限。不为队列引入对象池，必须给出队列计数与 GC 证据。 |

`durable`、`chord`、classifier、Radius、后台付费 cache warming、替换本地 Sandbox 均不在修复范围；独立需求应先说明用户价值、费用/权限与兼容边界。

## 7. 每项实施记录模板

实际开始一项时，在独立记录中填写以下字段；没有数据写“未验证”，不先填成功：

| 字段 | 必填内容 |
| --- | --- |
| 身份 | Task ID、根因、基线 SHA、候选 SHA、PR、影响文件 |
| 复现 | 最小输入、预期/实际、证据级别、排除项 |
| 设计 | 完整调用链、校验入口、成功/失败/取消语义、公开兼容性 |
| 状态 | owner、容量、缓存失效、normal/error/abort/clear/dispose 释放点 |
| 分配 | 已有/新增 closure、Promise、controller、wrapper、array、完整复制/物化及例外精确位置 |
| 验证 | 精确命令、fixture、结构计数、allocation/CPU 对照、GC/引用释放、平台覆盖 |
| 审查 | 最终 diff、不过度防御检查、未解决风险、对应最终 SHA 的 CI/审查结果 |
| 交付 | 状态、已授权操作及实际结果；仅规划/仅请求审查不算完成 |

方案 PR #175 已交付固定基线与差异证据、逐项设计、性能门禁、验证映射和许可/文档；SDK 前置修复、T01、T02 已通过 #176/#177/#178 合并。T03 进入独立验收，合并前不计入已交付修复；其余任务未实施。
