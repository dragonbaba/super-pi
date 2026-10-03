# 默认 Codemode 执行记录

本文件记录 [实施方案](codemode-default-execution-plan.md) 的实际进展和检查证据。目标是完成本地实现与审查后交由用户决定提交、推送及合并时间。

## 当前状态

2026-10-03 用户授权“开始修复”后，已按 R-A 至 R-E 完成实现、针对性回归、分配采样和最终完整验证。`npm run verify` 退出 0：219 个执行单元全部成功，3,224 项测试中 3,134 通过、90 项环境跳过，0 失败/取消/todo。起点仍为 `0949fc33f`，分支 `codex/default-codemode`。修复前的问题和证据保留在 [审查复核](codemode-review-verification.md)，本轮修复记录及限制位于本文件末尾；下方较早的测试数字均为历史记录。本地修复验收完成，停在未暂存、未提交状态，由用户决定提交、推送、创建 PR 及合并时间。

## 用户文件保护

开始时已有未跟踪路径：`.codegraph/`、`.sp/project-context.json`、`.sp/project-context.md`、`.sp/project-index.jsonl`、`SUPER_PI_CODEX_PHASED_OPTIMIZATION_PLAN.md`、`SUPER_PI_NEXT_PHASE_CODEX_START.txt`、`SUPER_PI_NEXT_PHASE_COMPLETE_PLAN.md`、`SUPER_PI_NEXT_PHASE_NATIVE_FILES_BATCH_CWD.md`、`SUPER_PI_V087_BOUNDED_OPTIMIZATION_PLAN.md`、`docs/super-pi-pr53-pending-targeted-review.md`、`docs/super-pi-pr54-initial-review-notes.md`。这些路径不属于本任务。

## 证据与限制

- 已读取仓库 AGENTS、热路径契约和测试入口。根测试运行器发现 `tests/`，新增测试须进入该入口。
- 官方依赖比较点固定为 `v1.0.0`，已引入独立 `@super-pi/codemode` 工作区和锁定的 QuickJS WASI `3.6.2`。保留 MIT 许可证；依赖安装使用 `--ignore-scripts`，未重跑原生依赖脚本。
- 先前调研测试结果仅为历史信息；本轮验证结果在实际执行后逐项追加。
- 五项 Shell 日志的事实与不确定性见方案样例表，不能统一归因于解析过严。
- 当前宿主为 Windows；未执行的平台已在文末明确列出。

## PR 分组检查记录

### B0 基线

修改嵌套调度前，以 `scripts/bench/tui-session-event-allocations.ts --updates 4096 --warmup 256` 记录原有分配基线：message_update 42.818 bytes/update、p95 0.0004184 ms；tool update 42.582 bytes/update、p95 0.0002092 ms。内建监听器 Promise、拒绝观察器及被审计的源代码闭包/包装/Promise 尾链/数组计数均为 0。

完整 observer fixture 的 4096 次输入合并 4095 次，只交付一次、快照一次；逐输入/交付 Promise 为 0，543.275 bytes/raw，p95 0.0014072 ms。该 fixture 使用交互层 stub，不包含真实 Markdown、布局和终端帧；GC 单点差值不作为泄漏结论。组合完成后再与同口径结果比较。

### B1 嵌套调度与工具暴露（初期验收记录）

增加每编排调用独占的 `NestedToolDispatch`，256 次总调用、可信读并发最多 4、写操作隔离串行。每个子调用经过当前 Agent 的参数、before/after hook、最终授权和执行前目录/实现/控制属性检查。子调用只产生一次带 parentToolCallId 的生命周期事件，不生成无对应模型声明的协议工具消息。父完成等待子调用取消/收尾；隐藏错误不能被脚本或结果 hook 改为成功。

新增 `modelExposure: nested` 和工具数组版本所有的模型展示缓存，低层 Agent 仍不依赖 WASM。普通 Agent 无隐藏工具时复用工具数组；被隐藏工具只能走编排入口，直接模型调用明确拒绝。工具定义适配保留既有扩展上下文参数。

相关嵌套回归 11 项通过；加沙箱与源代码门禁合计 31 项通过。更早相关源代码/进度/证据/分配门禁批次 28 项通过，类型检查通过。测试覆盖异步权限期间禁用/替换工具、递归、直接控制工具、同轮父子事件、未等待调用和强制保留失败。

`scripts/bench/codemode-dispatch.ts`：100 次所有者生命周期、800 子调用、最大并发 4；1100 个 WeakRef 跟踪对象回收后保留为 0。抽样宿主分配 3,302,272 bytes（4,127.84 bytes/call），包含调用生命周期分配，不包括 VM/UI；逐进度适配器的 AST 门禁通过。

### B2 独立 Worker 沙箱（初期验收记录）

固定官方源码经适配后保留每执行独立 Worker，并缓存编译 WASM（最多 4 个路径）。默认内存 256 MiB、默认期限 60 s、最长 300 s；脚本 128 Ki 字符、参数 256 Ki、单返回值/累计输出各 1 Mi、1024 输出项、256 桥接调用、单方向累计桥接 8 Mi。字符单位为 UTF-16 code unit。VM 输出前和 Worker postMessage 前检查，宿主独立复核；超限结果具有不可被脚本捕获后清除的失败状态。

存储单值 256 Ki、总值 1 Mi、4096 键/写入、单键 1024 字符；使用无原型对象承载 `__proto__` 等键，失败执行不提交存储写入。宿主有界序列化提前拒绝大叶子并限制遍历，精确长度二次校验。取消释放监听器、timer、工具表和 Worker 事件引用。

`tests/codemode-runtime.test.ts` 19 项通过，覆盖计算/微任务死循环、10 MiB 单行、空输出洪泛、调用/参数/存储洪泛、捕获超限、悬挂 Promise、错误、取消、旧目录失效、闭合状态和无 Node/网络全局能力。包独立构建、根类型检查通过。

`scripts/bench/codemode-runtime.ts`（Windows、Node v26.4.0）：WASM 编译 3.616 ms；首次执行 69.520 ms；随后 30 次独立执行中位数 40.363 ms、p95 42.420 ms；一脚本内 100 次轻量工具调用共 45.787 ms。Worker started/stopped 均为 32；128 个弱引用回收后保留为 0；宿主抽样分配 2,683,056 bytes。该结果不包含 Worker 内堆采样、真实策略、AgentSession 或 UI，也不代表 Linux/Node 22 性能。

### A1 上游正确性

修改 `provider-retry.ts`、`overflow.ts`、`constrained-sampling.ts`、`anthropic-messages.ts`、新增 `anthropic-strict-schema.ts`、修复 `openai-responses-shared.ts` 及 CLI 模型选择验证。所有变动发生在请求准备、错误分类或重试边界，没有改变 provider delta 热循环。

新增 provider 契约测试修复前 27 项中 14 项失败，覆盖 NaN/Infinity 延时、Anthropic prefer/require、嵌套 schema、跨模型和跨 provider 工具回放。修复后与 CLI、已有降级和自定义工具流测试合计 43 项通过。请求被离线捕获，真实网络请求数为零；重试取消后监听器为零。类型检查通过后再进入下一组。

命令：`node --experimental-strip-types --test tests/provider-contract/upstream-v1-compatibility.contract.test.ts tests/cli-args-terminator.test.ts tests/provider-contract/openai-custom-tool-generation.contract.test.ts tests/provider-contract/capability-downgrade.contract.test.ts`。

### A2 Shell 只读 find 组合

从 `resource-lifecycle-guard/core.ts` 的独立 cd 尾部检查提取 `readonly-find.ts`。静态只读逻辑运算符与 stdout 打印动作使用模块私有只读集合；按 token 消费有参谓词，保留删除、执行、文件输出和状态变更拒绝。没有增加动态正则、逐 token 闭包、Promise 或输出分配，也没有修改执行脚本。

新增 17 项测试修复前 8 项失败；修复后全部通过，包括真实 Git Bash 的 cd 成功和失败分支。该宿主 Git Bash 位于 `D:/Git/bin/bash.exe`，测试显式使用该已知安装位置；最初测试因默认路径未找到 Bash 而失败，属于夹具配置问题，未放宽生产发现规则。

相关四文件回归首次运行 261 项：259 通过，1 项新夹具路径失败，1 项既有 Windows 平台跳过。修正夹具后新增文件 17 项全通过，其他三个文件未发生新的变更。既有测试同时验证包装器、PowerShell、非零退出、超时与结果不可伪造。没有把 grep 退出 1 改成普遍成功，没有执行 NW GUI。

命令：`node --experimental-strip-types --test tests/shell-cd-find-compatibility.test.ts tests/policy-diagnostics.test.ts tests/shell-result-contract.test.ts tests/shell-common-compatibility.test.ts`；夹具修正后单独重跑 `tests/shell-cd-find-compatibility.test.ts`。相关输出分配 gate 随既有套件通过，具体新增代码属于每调用预检，不进入逐输出增量链。

### C3 模型目录合并

新增 `core/model-catalog-merge.ts`，替换远程目录合并中的逐模型 findIndex。保留基线顺序、基线重复 ID 的首项替换、动态重复 ID 的最后值、对象身份和既有缓存；动态目录为空时不创建 Map。临时索引仅属于一次刷新调用，不被结果或缓存引用。

新增及相关目录回归合计 13 项通过。4000 条基线加 4000 条覆盖目录的确定性 ID 读取数为 8000；100 次 getModels 命中同一数组且只读取基线一次。

Windows x64、Node v26.4.0、同进程 5 次预热及 20 次采样：旧实现中位数 32.615 ms、p95 34.463 ms；索引合并中位数 0.212 ms、p95 0.292 ms。这是刷新阶段的合成负载结果，不代表整应用启动速度或所有硬件。

命令：`node --experimental-strip-types --test tests/model-catalog-merge.test.ts tests/provider-catalog-profile.test.ts`；`node --experimental-strip-types scripts/bench/model-catalog-merge.ts`。

## 官方 1.0.0 对照与采用决定

比较对象为 `D:/RMProjects/TempPi/pi` 的固定标签 `v1.0.0` / `a13d35a74`，而非该目录后来包含未发布改动的 HEAD。

| 方面 | 官方标签的做法 | 本次 Super Pi 的处理 |
| --- | --- | --- |
| Codemode 默认 | CLI 内置扩展但初始不激活；SDK 需添加扩展，支持 on/only 模式 | 根据用户要求成为 SDK 与产品入口默认；普通工具隐藏到脚本目录，交互/完成控制保留直调；禁止排除默认入口造成工具不可用 |
| 代码执行 | QuickJS/WASI、每执行独立 Worker、代码格式及描述生成 | 引入独立包，保留 MIT 来源；增加输入/桥接/输出/存储硬限、宿主复核、失败粘性和当前运行内调度 |
| 工具与 MCP | 代码编排配合工具目录与发现 | 复用现有 MCP bridge 和权限体系；当前脚本可调用新激活工具；不凭远端只读提示并行 |
| 读取与会话 | 代码结果与脚本状态管理 | 接入 Super Pi 原有读写保护；只接受实际模型视图中的宿主读取凭据；分支恢复存储且不重放副作用 |
| 正确性 | retry、ZAI overflow、Anthropic 严格 schema、Responses 调用 ID、CLI 校验 | 分组移植和正反例验证，不进行整库版本替换 |
| OAuth | MCP HTTP 授权能力 | 对现有 bridge 补充显式登录、PKCE、回调、带锁刷新和独立凭据文件 |
| 性能 | 模型目录与消息布局中的可复用做法 | 目录按 ID 索引合并；用户消息移除重复 Box padding，保留 ANSI/OSC 语义 |

官方 Codemode 的入口证据：`packages/coding-agent/src/extensions/codemode/index.ts`；本次运行时代码来源保存在 `packages/codemode/LICENSE`。没有引入 Durable/Chord、另一套模型账号系统或扩大项目默认权限。

## B3/B4：默认入口、结果和恢复

- `AgentSession` 持有 Codemode controller；低层 Agent 仅处理工具暴露与嵌套调度，不加载 VM。未调用脚本的启动创建 0 个 Worker；没有 opt-in 配置。
- JSON/专用代码格式进入同一工具，模型不支持 grammar 时保留 JSON schema。provider 请求预览/压缩也使用模型展示目录。`--no-tools`、工具白名单、Plan mode 与直接 Goal/交互控制均有测试。
- 子调用复用参数校验、策略 hook、最终授权、原生执行、结果 hook、图片规范化、进度与取消链；等待策略后重查目录身份、执行函数、控制属性以及并发只读资格。终止请求遵循既有“该批结果全部要求停止”的规则。
- 子调用只发一次带 parentToolCallId 的事件，不写无对应模型调用的子工具协议消息。Shell summary 保留执行状态和退出码；脚本捕获错误不能报告整体成功。
- 原生结果小于限额时保留 content 身份；大结果通过原有 OutputAccumulator 有界预览并落盘，文件上限 5 MiB，截断时明确注明后续数据未保存。回收当前脚本的引用不删除用户需要的恢复文件。
- 读取证据只由宿主 `show(ref)` 建立，且必须原文通过实际模型投影。测试覆盖隐藏、打印副本、伪造、同脚本、截断、文件已变化、context 过滤及 payload 来源无法证明等拒绝条件。采用保守整块判断；截断时需重新读取更小窗口。
- `store` 在父工具最终 hook/图片规范化成功后才提交；保存失败会恢复内存快照。资源重载与切换旧分支恢复对应值，失败脚本不提交。权限结论及读取授权不写入 store。
- `/changes` 原先依赖原生协议调用/结果配对。补充有界的 `codemode-tool-call-v1` 与 `codemode-tool-result-v1` 自定义条目，沿用原有哈希、顺序、重复项和副作用验证。真实默认 SDK 覆盖预览、部分失败、已完成状态确认、剩余请求草稿及磁盘重开；不把 VM 声称的成功当作写入凭据。
- Evidence Ledger 的原生协议优化保持原有条件；嵌套读取不凭不存在的子协议结果宣称缓存命中。pending 证据保持 128 项/64 KiB 上限并在 turn 完成/销毁清理，实测 SDK 周期结束后为 0。

测试迁移分两类：产品默认场景使用未经修改的 SDK 和 Codemode；专门测原生协议历史、schema 成本、原生 ToolResult 预算的夹具显式使用 `native-protocol-session`，这是测试适配器而非产品开关。跨 checkout 成本夹具的适配函数放在无生产依赖的 `next-phase-model.ts`，避免把当前 checkout 的 SDK 混入基线。既有 measurement guard 继续原样校验这一边界。

## C1/C2：MCP 目录与 OAuth

目录刷新按规范化 schema/description 的 SHA-256 判断变化；相同目录复用注册定义，变化时重新注册，远端已移除工具在调用前拒绝。真实 bridge 经 Codemode 的发现和两次嵌套调用验证串行执行，不信任 remote readOnlyHint 获得并发资格。

OAuth 使用已安装的 MCP SDK 与宿主 FileAuthStorageBackend；普通连接不会自行注册客户端或启动浏览器。`/mcp-login <server>` 显式进行 PKCE 与随机 state 校验，回调只监听 loopback；取消、重载、结束会话会关闭回调。凭据按服务地址/配置身份隔离，刷新全过程持有文件锁，持久化成功后才更新缓存，401 最多一次刷新重试。metadata/token 请求不继承 MCP 头，禁止跨域带头和重定向。固定 clientId 要求配置已注册的回调端口。

6 项离线 OAuth 测试通过：真实 loopback 回调、错误 state、PKCE、持久化/注销、两个独立 owner 的锁内合并刷新、token 轮换/过期、缺少显式登录、服务隔离、取消清理、响应限制及跨域头拒绝。两个 owner 同属一个测试进程；未声称完成独立操作系统进程或外部真实授权服务的互操作验证。scope 变化需重新配置并显式登录，未实现 403 自动追加授权。

## 热路径审计与最终性能样本

环境：Windows x64、Intel Core i7-14700KF、Node v26.4.0；各基准串行运行，无真实模型网络请求。耗时是本机合成负载，不能推导为整应用或其他平台百分比。

审计调用链：

1. Agent 调度 → NestedToolDispatch 目录缓存/队列 → 原有 before/execute/after/ToolProgressDelivery → AgentSession → extension observer / InteractiveMode → 原有帧队列。新增父 ID 在已创建的内部事件上赋值，未按进度创建适配器。
2. QuickJS prelude → Worker 协议检查 → 宿主 BridgeBudget / 稳定回调 → shared tool pipeline → bounded result → Worker / model projection → owner.close / dispose。
3. 用户消息 → Markdown 内置 padding/style → Container 返回数组 → OSC marker → 终端；Markdown 缓存仍不被 marker 修改。
4. 模型目录版本刷新 → Map 索引合并 → 既有缓存；没有逐 getModels 重建索引。

没有引入对象池。固定模式、schema、协议值和默认上限放模块常量；序列化 scratch、队列、结果和存储仅由实例/单次调用持有。执行级 Promise/闭包是有界生命周期分配；逐进度路径的 AST/source gate 要求闭包、String/RegExp 构造、Promise 尾链、options/数组工厂为 0。WASM bridge 的 `.toString()` 是边界转换，不是 JavaScript String 构造函数。

| 基准 | 结果 | 范围与释放证据 |
| --- | --- | --- |
| nested dispatch | 800 调用，抽样 3863.6 bytes/call，最大并发 4 | 100 owner 周期；1100 WeakRef 保留 0；不含 VM/UI |
| QuickJS runtime | 编译 3.610 ms；首次 69.093 ms；30 次后续中位 39.085 ms / p95 41.899 ms；单脚本 100 轻量调用 47.204 ms | Worker 32 启动/32 关闭；128 WeakRef 保留 0；宿主抽样 2,470,152 bytes，不含 Worker 内堆 |
| 真实 SDK | 每批 11 个内置 read；首次批中位 40.771 ms / p95 42.399 ms；后续批中位 41.483 ms / p95 42.213 ms | 10 采样周期 + 1 预热，总计 242 子调用、22 Worker 全部关闭；55 WeakRef 保留 0，pending evidence 0 |
| 模型目录 | 4000+4000 条：旧中位 33.103 ms → 0.218 ms，p95 33.666 → 0.296 ms | 确定性 ID 访问 8000；100 缓存读取只取基线一次 |
| 用户消息缓存渲染 | 302 行 × 2000 次，抽样 101267.596 → 7333.384 bytes/render；中位 0.1372 → 0.0046 ms，p95 0.1807 → 0.0069 ms | 每帧少 300 次 padding 行复制；540 组 ANSI/OSC/换行布局等价；10 WeakRef 保留 0 |

SDK 计时不包括一次性 resource loader 初始化，但包括创建会话、策略 hook、真实读取、模型视图、VM、store 和销毁；“启动中位 0.585 ms”只指这种预加载 fixture 的 session 创建，不代表 CLI 冷启动。SDK 宿主抽样 25,170,760 bytes/10 周期，主要采样点为 split、join、createContext、stringify、fstat。共享测试 loader 会持有最后一次绑定的 runtime；生命周期检查先释放这个测试持有者，再验证所有会话回收。UI、Worker 堆和磁盘 session 不在该基准口径内。

原有 4096-update 事件基准复测：message 44.574 bytes/update、p95 0.0003884 ms；tool 42.064 bytes/update、p95 0.0002470 ms；observer 551.705 bytes/raw、p95 0.0013782 ms。4096 输入仍合并 4095 次，交付 1 次，快照 1 次，逐增量 Promise/适配器/尾链等确定性计数为 0。与 B0 单次样本相比，极短 tool p95 有波动，不能用这一单次样本声称稳定满足 5% 时间阈值；没有隐藏这一点或扩大为全应用性能保证。

命令：上述新增基准位于 `scripts/bench/codemode-{dispatch,runtime,session}.ts`、`model-catalog-merge.ts`、`user-message-render.ts`；使用 `node --expose-gc --experimental-strip-types`。事件基准使用 `scripts/bench/tui-session-event-allocations.ts --updates 4096 --warmup 256`。

## 组合验证与审查

最终 `npm run check`、`npm run build:offline`、`npm test` 均通过。完整 runner 的 215 个执行单元（包括 memory 工作区）全部退出 0：3190 项测试中 3100 通过、90 跳过、0 失败、0 取消、0 todo。跳过来自既有 Windows/非 Windows 文件身份、POSIX 信号、Linux ACL/procfs/宿主操作等条件，不计为通过。

新增 Codemode 边界与嵌套资格回归、AST 门禁、measurement guard 已进入上述完整 runner。`git diff --check` 通过，暂存区为空，HEAD 仍为 `0949fc33f`。目录中的既有用户文件未纳入修改。

打包检查：`npm pack --workspace @super-pi/codemode --ignore-scripts --dry-run --json` 验证 51 个包文件，包含 worker、入口、source、declarations 和 LICENSE；预估压缩 60894 bytes / 解压 221545 bytes。已构建 dist 实际执行 QuickJS `6*7` 得到 42，Worker 启动/关闭各 1，结束后 active 为 0。此项是打包清单 + 当前已安装依赖的 dist smoke，不声称完成从 registry 全新安装。

结构化基准原始样本与测试计数保存在 [codemode-validation-sample.json](performance/codemode-validation-sample.json)。事件基准再做 5 次独立进程复测：message p95 中位 0.0003686 ms、抽样 46.346 bytes/update；tool p95 中位 0.0002368 ms、抽样 40.785 bytes/update；observer p95 中位 0.0013734 ms、抽样 547.490 bytes/raw。确定性增量工厂计数继续为 0。与早期单次基线的极小时间差仍不能作为跨环境 5% 保证。

本地审查已修正：

- 隐藏子协议结果后 `/changes` 丢失调用参数/结果的问题。
- provider 请求预览仍使用原生目录的问题。
- 子调用停止请求丢失，以及策略等待期间只读资格变化的问题。
- 渲染夹具使用父 ID 而非子 ID，导致实际计时器未被观察的问题；六种默认 Codemode Shell 场景通过，实际输出写入并发为 1，退出后的派生引用/计时器为 0。
- Windows 既有符号链接夹具清理 ENOTEMPTY：只处理自身 mkdtemp 目录，先 unlink 链接再删除目标；故意悬空的 LSP 链接在完成断言后恢复自身目标以便清理，不修改生产文件访问逻辑。
- 跨 checkout 成本 fixture 意外引入当前 SDK：恢复无生产依赖的静态 fixture 边界，原有 measurement guard 12 项通过。

完整套件使用当前命令进程的 `D:/Git/bin` 路径找到已安装 Git Bash；没有修改用户 PATH 或放宽产品 Shell 发现规则。

自动审批拒绝了两次诊断资源清理，工具仅返回 `blocked by policy`，未提供更具体原因。未绕过拒绝：系统临时目录 `C:/Users/Administrator/AppData/Local/Temp/sp-lsp-scope-JZhhdo` 仍保留；工作区的 `scripts/.codemode-test-audit.mjs`、`.tmp-codemode-failures.txt`、`.tmp-codemode-failure-summary.txt` 及 `.tmp-*.log` 为本次诊断材料，不属于拟议 PR。前两轮失败测试还产生过记录在诊断日志中的临时夹具；最后一轮套件的夹具正常清理。提交时应按表选择本次产品、测试、文档及基准文件，不能直接 `git add .`。

## 拟议 PR 文件划分与顺序

这些是本地审查单元，不是已创建的 PR。建议按依赖拆分提交，随后由用户决定推送与合并；共享文件按对应功能 hunk 分开，不把测试绕过夹具移入产品。

| 组 | 主要文件/目录 | 独立验收 |
| --- | --- | --- |
| B0 文档与门禁 | 本方案/执行记录；测试清理 helper 及四个调用点 | 复现环境、基线、清理边界、最终报告 |
| A1 provider/CLI 正确性 | ai retry/overflow/strict schema/Responses、cli args/main | upstream-v1-compatibility、CLI 与 provider contract |
| A2 Shell 兼容 | resource-lifecycle-guard readonly-find/core | find 正反例、cwd、wrapper、真实退出状态 |
| B1 Agent 调度 | agent types/agent-loop/agent、nested-tool-dispatch、tool-exposure；必要 wrapper 签名 | 嵌套与 AST、取消、授权变更、失败/停止语义 |
| B2 runtime 包 | packages/codemode、lockfile、构建顺序/解析映射 | runtime、边界、Worker 生命周期、打包 |
| B3 结果与证据 | coding-agent core/codemode*、AgentSession hooks/恢复、mutation-guard | session/output、file-change-recovery、可见读取证据 |
| B4 默认接入 | SDK/AgentSession registry、工具分类、Plan、prefix、入口 fixtures、双语 README | 默认入口、allowlist/noTools、控制工具、迁移后全套回归 |
| C1 MCP 目录 | bridge/schema-cache 中目录签名、刷新与当前目录检查 | mcp-lifecycle、Codemode 中真实 bridge |
| C2 MCP OAuth | oauth.js、config/index/bridge 的授权部分、FileAuthStorageBackend 导出、MCP README | mcp-oauth 与既有 MCP 安全/生命周期套件 |
| C3 模型目录 | model-catalog-merge、remote-catalog-provider | 顺序/身份/缓存与目录基准 |
| C4 渲染 | user-message、legacy 对照 fixture、render test/bench | 视觉等价、AST、分配及释放 |
| C5 Codemode 树 | core/codemode-display、codemode/codemode-constants 的显示与说明增量；components/codemode-tree、tool-execution、interactive-mode；codemode-tree test/bench、codemode-hot-paths 和 Bash 响应夹具增量 | 唯一父卡片、历史恢复、精确输出关联、真实失败、计时/滚动、AST 与释放 |

依赖：B0 → B1 → B2 → B3 → B4 → C1；A1、A2、C2、C3、C4 可独立审查。README 中承诺的默认切换应与 B4 同时交付。B1–B4 是主线，不应只合入“隐藏普通工具”而缺少运行时。

## 真实限制与发布前条件

### Codemode 树状卡片后续修正（已完成，本地待用户决定提交）

用户样本暴露了上一轮生命周期夹具未覆盖的 UI 问题：`InteractiveMode.handleEvent` 忽略子事件的 `parentToolCallId`，因此父结果与原生子卡片重复展示。一个父调用、两个子调用并不表示重复执行。原有 Shell 响应夹具过滤父事件，只能证明原生叶子计时器，不能证明合并卡片正确。

本轮按独立审查单元 C5 执行：按父 ID 路由到一个树状组件；保留子调用顺序、命令/路径、运行/失败/退出码；结果与恢复历史共用有界元数据；精确内容摘要关联已报告输出，原始模型结果与证据保持原样；验证恢复、取消、孤立事件、折叠/展开和释放。先运行针对性回归，再运行类型/构建、热路径 AST 和分配基准。

已审计调用链：NestedToolDispatch → agent-loop 子事件 → Agent/AgentSession 合并交付 → InteractiveMode → ToolExecutionComponent → 树行/Text → retained transcript → TUI frame queue。新行只在调用开始/历史恢复时创建，进度只更新对应行；不引入对象池、逐更新闭包、动态正则、String 构造或 Promise。父结果完成时的摘要匹配不进入进度/逐帧路径。Shell `grep -vc` 输出 0/退出 1 属于程序语义，不能通过全局忽略退出 1 修复；说明与示例应指导显式处理查询状态。

最终交互示意（耗时为示例）：

```text
• Codemode (2 child calls) — completed
├─ • 1. bash — exited; exit=0 (2.4s)  curl …
└─ • 2. read — completed (0.1s)  package.json
ctrl+o to expand script and child output
```

展开显示 Script、各子节点的对应输出及独立 Script output。失败子项即使折叠也显示错误正文、真实退出码和“副作用不回滚”提示。子事件直接更新父组件，不再注册独立子卡片或不存在的子协议结果发现记录。没有父节点时保留原来的工具展示路径。

父完成结果新增纯 UI 元数据：请求顺序、命令/路径摘要、调用耗时、预览和文本 SHA-256 摘要。摘要使用增量 hash 接收原文本，不创建第二份完整序列化结果；只在完成边界计算。原始模型 `content`、读取证据、失败传播、store 提交语义均未改变。相同内容对应多个调用时不猜来源，显示为 Script output 并给子节点提示；附加 JSON 字段、未知输出、旧会话元数据不足时原样保留可见文本。显示归属不是权限证据。

边界：最多 256 行；每行参数摘要 512 字符、预览 2048 字符、恢复路径 1024 字符、最多 16 个文本摘要；代码与最终可分配文本各限制 64 Ki 字符，超出明确提示，原始结果仍归会话所有。图片只由父卡片的原生图片通道显示一次，文本树保留图片提示。未经脚本报告的长子输出展示有界预览及可用的原生恢复路径，不承诺无限展开。旧历史缺少参数或摘要时不虚构命令与关联。

每个活动父节点最多一个 1 s 稳定计时回调；全部子调用结束就停表，迟到的部分结果不能重启已完成子项。暂停会保留恢复所需的有界行事实并停表；完成/取消后的缓存释放清除行、父结果引用和派生文本。受控 GC 在基准的 async 所有者作用域返回后检查，避免将仍存活的基准局部变量误判为产品泄漏。

最后检查：`npm run check`、完整 `npm run build:offline`、最后一次 coding-agent 工作区重建通过；`npm test` 的 216 个执行单元全部退出 0，3201 项测试中 3111 通过、90 环境条件跳过。最后追加的显示边界修正之后，Codemode tree/hot-path/session/output 与真实 Shell 响应共 46 项重新通过。`git diff --check` 通过；暂存区为空、HEAD 保持 `0949fc33f`。

真实 SDK + InteractiveMode 验证了“一父、两次执行、一张卡片、一个协议结果”，恢复前后树一致；另覆盖 JSON 精确关联、共享内容、失败、逆序到达、长文本、额外 JSON 字段、图片提示、原始 grammar 参数、迟到进度、暂停恢复。六种合并 Shell 场景与一项独立原生 Shell 对照均通过：每场景六次运行中滚动均产生完成帧，终端写入并发最高 1，结束后计时器、输入引用和树派生结果引用为 0。此处终端是模拟异步 sink，不等同真实 ConPTY。

最终同机样本如下，完整数据在 [codemode-tree-validation.json](performance/codemode-tree-validation.json)。树基准为真实 InteractiveMode → retained transcript → Text/Box；对照使用同样的事件但省略父 ID，得到独立卡片，不是历史 checkout。输出为 4 KiB 长单行；合并卡片采用新的 2 KiB 子预览，折叠隐藏正常输出，所以不能把差值当成显示完全相同内容的底层渲染器加速。

| 场景，4096 更新 + 256 预热 | 独立卡片对照 | 合并树 |
| --- | --- | --- |
| 折叠 p95 / 抽样 bytes/update | 1.0323 ms / 1,308,762.8 | 0.0059 ms / 4,244.6 |
| 展开 p95 / 抽样 bytes/update | 0.9622 ms / 1,324,680.9 | 0.5364 ms / 707,288.9 |

两种状态都只创建 1 行，4352 次热更新不重新分配行/Text，不做结果摘要计算；事件返回 Promise 为 0，热方法 AST 检查内联闭包、临时对象/数组、动态构造为 0。每次渲染仍有必要的行数组、字符串及既有 Text/ANSI 换行分配；展开时主要分配点是 `breakLongWord`、`splitIntoTokensWithAnsi`，不声称整个渲染为零分配。折叠峰值堆 64,694,048 bytes，GC 后 46,892,568；展开峰值 80,292,096，GC 后 46,976,128。各组组件 WeakRef 保留 0，完成/销毁后行、结果、文本、计时器引用计数均为 0。未使用对象池。

补充完整链路检查：4096 次原始观察事件仍只交付/快照 1 次，逐更新 Promise、尾链、包装对象为 0；20,000 帧队列测试 flush 后 active/pending bytes 为 0，帧 Promise/AbortController/包装对象/完整帧复制为 0；生产 Alt 4096 帧每帧只生成一次完整字符串，写入 HWM=1、所有布局源引用在 dispose 后归零。真实 SDK 242 次子读取、22 Worker 全部关闭，55 WeakRef 保留 0；首批中位 42.31 ms、后续批中位 42.57 ms。以上是 Windows/Node 26.4 同机采样，不是跨平台或全部负载的性能保证。

对于预期“无匹配”的查询，应在该查询的 Shell 片段里明确区分状态，而不是对整个复合脚本统一忽略退出 1。例如单独的 grep 查询可写成：

```bash
grep -vc 'excluded-pattern' input.txt
query_exit=$?
case "$query_exit" in
  0) ;;
  1) printf 'query_status=no_matches; grep_exit=1\n' ;;
  *) exit "$query_exit" ;;
esac
```

这个例子将“查询无匹配”明确报告为正常业务结果，文件读取/语法等其他错误继续失败。不要把这个处理套在混有网络请求或变更操作的复合脚本末尾。生产 Shell 的真实退出码判定没有被放宽。

- 当前完成的是 Windows / Node v26.4.0 的本地检查；未执行 Linux、最低支持 Node 22.19、真实 ConPTY 或在线模型/provider/MCP OAuth 互操作。发布或合并前应在相应环境补验。
- 能终止 VM 不等于能强杀宿主 JavaScript。自定义 host 工具若完全忽略 AbortSignal，父调用会等待它结束以记录副作用；60 s VM 默认期限不是这种工具的绝对墙钟截止。
- 不对未知外部工具自动重试；多次写入不是事务，部分成功会持久记录。截断的读取需要更小范围重读，store 与 read 引用不能绕过权限。
- OAuth 文件锁使用既有宿主后端，双 owner 离线刷新已验证，真实跨进程轮换和各服务登记要求仍须按部署环境验证。
- 性能比较是同机合成负载；新 VM 有约 40 ms 的每脚本固定成本。未证明所有工作负载更快，也没有引入 Worker 池掩盖这个成本。

## 外部审查后的修复执行（R-A 至 R-E）

本节记录用户授权后的实际修复，与前述初次只读复核和历史验收分开。针对性测试发现的类型错误、OAuth 清理属性违反 source invariant 的问题均已修正；不将失败运行当作最终通过。

| 分组 | 实现及验收内容 | 纳入原 PR 单元的主要文件 |
| --- | --- | --- |
| R-A 提示与去重 | 系统提示只列模型可调用工具，嵌套工具明确通过 Codemode 使用；子调用按父项跟踪尚未完成的相同调用，结束后允许验证性重读；重复拒绝的结果不释放原 owner 的占用；原生批次、失败循环与编辑证据保护保留 | B1/B4：core/system-prompt、agent-session、codemode；extensions/tool-loop-guardrails core/index；codemode-session、codemode-guardrails、codemode-default-config 测试 |
| R-B JSON 与状态 | 数组索引不算对象键，数值使用真实下界计数；转义后精确核验，独立遍历上限；boxed/cross-realm string 与 rawJSON 保持原生编码语义；restore 原子替换，损坏恢复显式报告；变更参数预检、结果处理失败保存最小真实状态；最终存储/扩展失败同步修改完整或截断的可信摘要 | B2/B3：packages/codemode/src/bounded-json；core/codemode、codemode-store、agent-session；agent-loop；codemode-bounded-json/session/output 测试 |
| R-C OAuth | 浏览器等待移出锁；按服务预留有期限的登录 attempt，防止并发登录和 logout 后晚到授权回写；提交时重读合并；同步/异步采用同一 30s stale、5s 心跳；刷新保持原有独占轮换 | C2：core/auth-storage、mcp-bridge/src/oauth、MCP README；mcp-oauth 与 fixtures/oauth-lock-writer |
| R-D 目录与性能 | MCP 声明按需获取，本地省略明确给出发现方式；静态签名选项/正则复用；编译 Worker 不传 strip-types 且仍显式隔离 execArgv/env；子调用计数代替 Set 与两个 settlement 闭包；只检查最近的父投影；树行缓存有界前缀/label，展开仍显示最新状态 | B2/B3/C1/C5：codemode host/declarations/identifier/regex；core/codemode/constants；components/codemode-tree；hot-path/tree/session 测试与 codemode-json 基准 |
| R-E 完整组合及说明 | 加载实际默认设置的 14 包、22 扩展（确认 MCP 已启用）；离线模型驱动真实失败检查→修改→同命令通过→读取；同轮首次读取仍不授权修改；新增独立使用说明 | B4/最终验收：tests/codemode-default-config、docs/codemode.md、README/文档索引、审查及本执行记录、performance 修复证据 |

这些是本地文件/hunk 的归属，不是已经创建的 PR。R-A/R-B 共享 AgentSession 和 Codemode 控制器，拆分时按功能 hunk 携带必要测试；R-C 可单独审查。不要只取“默认隐藏普通工具”而遗漏主线依赖，也不要把兼容测试的原生协议夹具当成产品后门。

修复后使用原探针入口，结果另存为 `docs/performance/codemode-review-probes-after.json`，保留修复前原件。9 组均完成、probe errors 为 0、owned temp cleaned=true。变更模拟的副作用次数=1、调用记录=1、结果记录=1；父结果明确失败并要求验证，不自动重复变更。OAuth 等待授权期间读取不再 ELOCKED，其他条目在最终提交后仍保留。完整默认配置集成使用实际扩展加载器和 Shell/编辑工具，网络请求计数=0。

### 完整热路径审计与测量

审计链为：VM/Worker 消息→host 有界 JSON→Codemode invoke/runChild→Agent 嵌套调度及 result hooks→变更/store 持久化→模型投影；显示链为 InteractiveMode 子事件→唯一父 ToolExecutionComponent→CodemodeTree 行→Text/保留布局→既有终端帧队列。修改点位于前两条链，帧队列实现没有改动；既有帧/事件结构门禁仍纳入完整回归。

[修复采样数据](performance/codemode-review-repair-validation.json) 保留优化前、后及重复采样。环境是 Windows / Node v26.4.0。树比较采用相同合并显示、相同输入，使用 grouped-before 对 grouped-after，不把合并前不同显示内容的对照作为本轮优化收益。

| 样本 | 修复前 | 修复后 | 解释 |
| --- | --- | --- | --- |
| 折叠树 p95 / sampled bytes 每 update | 0.0059 ms / 4,533.84 | 0.0055 ms / 3,913.76 | 抽样分配减少约 13.7%；计时极短，非所有工作负载保证 |
| 展开树 p95 / sampled bytes 每 update | 0.4796 ms / 710,107.79 | 0.5114 ms / 704,117.37；复测 0.4729 ms / 703,366.13 | 时间存在噪声，保留较慢样本，不宣称稳定提速 |
| JSON 最终同负载中位 / sampled bytes 每 result | 0.0476 ms / 19,044.58 | 0.0498 ms / 18,923.41 | 编码相同 9,299 字符，1,024 次；中位约 +4.6%，分配约 -0.6%，主要收益是纠正误拒 |
| JSON 最终 p95 | 0.0809 ms | 0.0526 ms | 早一组为 0.0510→0.0513 ms，单组 p95 改善不能当作稳定收益 |

确定性计数和释放：JSON 两组回调访问均为 1,056,768，每 serializer 生命周期 1 个回调、每值回调分配 0；校正计数接受此前被误拒的 40,001 字符数组。最终峰值宿主堆约 10.56/11.12 MB，GC 后约 8.93/8.96 MB，输入 WeakRef 保留 0。树在 4,352 次变化前缀更新中只建 1 行/1 Text/1 次 label；必要的新前缀仍有 4,352 次保存。另有 1,024 次相同前缀回归，preview/label 各仅 1 次；折叠→展开显示正确最新输出，缩短输出清除截断提示。完成/销毁后行、结果、计时器及派生文本引用归零，受控 GC 的组件 WeakRef 保留 0。

真实 SDK 采样含 242 次子调用、22 个 Worker，全部关闭；55 个 WeakRef 保留 0、待读取证据 0，宿主总抽样分配 26,023,608 bytes。首批/后续批中位 41.44/41.98 ms，独立 Worker 固定启动成本仍存在。invoke 不再分配两条子调用收尾闭包，但 request 边界仍有必要 Promise 等分配；不声称每次子调用或整个渲染零分配。没有对象池、共享可变 scratch 或按工具对象身份缓存可变 schema。

AST/source invariants 覆盖新增与既有热方法，禁止逐进度闭包、动态 RegExp、String 构造及 Promise 尾链；BoundedJson 恰有一个构造期稳定回调。数组/keys/编码结果等必要边界分配计入实测，不为绕过门禁而藏到热 helper。

### 验收范围与诊断归属

本轮测试覆盖 Windows / Node v26.4.0、本地真实文件/Shell、受控模型与 OAuth 服务；新增跨进程写入用于检验交互授权期间的锁范围和最终合并。租约竞争另用 11.5s 锁时间戳复现旧参数窗口；不冒充真实长时生产授权或跨进程令牌轮换测试。Linux、最低 Node 22.19、真实 ConPTY、在线 provider 和真实 OAuth 服务尚未实测。Windows Evidence Ledger 保留既有 uncertain-identity 回退；其他平台命中率需在其环境验证。

本轮 `.tmp-codemode-fix-*` 是已记录身份的诊断材料；基准内容归档到 performance JSON，测试日志不纳入 PR。此前被拒绝清理的诊断文件和用户原有未跟踪文件继续排除，不能使用笼统暂存。MIT 许可证和上游来源说明仍随 runtime 包分发，未增加新的依赖版本。

最终打包预检：`npm pack --dry-run --json --workspace @super-pi/codemode` 退出 0，runtime 包元数据 63,115 bytes / unpacked 229,323 bytes；所有导出的 JS/types、Worker、公共 regex 产物和 MIT LICENSE 均存在。已安装 QuickJS WASI 仍为 3.6.2。8 份本轮临时基准文件逐一与归档 JSON 深层比较一致后按明确文件名移除；归档保留原文件名作为样本来源，测试日志保留且排除出 PR。

最终完整验证：`npm run verify` 退出 0，包含 `npm run check`、`npm run build:offline`、全套 `npm test`。219 个执行单元（含 memory 工作区）全部退出 0；3,224 项测试中 3,134 通过、90 跳过，失败/取消/todo 均为 0。完整默认配置、9 扩展对照、序列化/状态、并行去重、OAuth 跨进程合并、树状显示与热路径门禁均进入根测试入口。原有平台条件跳过继续保留，未降低断言或关闭保护以取得通过。

验证日志 `.tmp-codemode-fix-verification-final.log` 的 SHA-256 为 `62c462f39574da5e537781a7c3309720162ad535d3bcef944c48013bbb7786cd`，汇总也写入 performance 修复归档。另有完成边界 29 项 session 回归通过，覆盖完整/截断摘要下的存储失败及扩展 veto。最终 `git diff --check` 通过，暂存区为空，分支和 HEAD 未改变；未提交、推送、创建 PR 或合并。运行时包干运行打包成功；此前审查提出且经复核成立的本地阻塞项已关闭，剩余跨平台/真实服务验证范围如上所列。

### 二次复审补充修复（本地待复审）

复审在修复后的工作区上复跑原探针（9 组完成、退出 0）并另写边界探针，确认三处遗漏，已修复：

| 问题 | 根因 | 修复 | 回归 |
| --- | --- | --- | --- |
| 被后续 hook 拦截、中止或授权否决的子调用使同脚本重试变成 `DUPLICATE_CALL` | guardrails 只在 `tool_result` 释放嵌套占用，而这些路径不触发 `tool_result` | 在每个调用必有的终结事件 `tool_execution_end` 释放占用并清理待配对项；执行过的调用该事件晚于 `tool_result`，重复拒绝的调用不释放原 owner；嵌套重复改用“同脚本仍在执行”的说明 | `codemode-guardrails` 新增无 `tool_result` 的释放用例；真实 SDK 探针：首次被拦截、同参重试成功 |
| 默认配置下系统提示缺少 Shell 文件操作指导 | `hasBash/hasPowerShell/hasGrep/hasFind/hasLs` 只看直接模型工具 | 与 `hasRead` 一致，Codemode 子工具也算可调用（模块级函数，无逐次闭包） | `codemode-session` 断言提示包含文件操作指导 |
| OAuth 登录失败时清理拿锁超时会覆盖原始错误 | 清理位于 `finally` 且 1s 期限失败直接抛出 | 只有失败登录进入清理；清理失败不替换原错误，未释放的 attempt 仍按 `loginUntil` 过期 | `mcp-oauth` 新增锁占用下的失败登录用例；去掉修复后该用例以 AbortError 失败 |

`tool_execution_end` 监听只在扩展加载时注册一次，处理器仅做 Map 查找/删除；默认扩展包中 false-success-guard 已注册同一事件，不改变 Evidence Ledger 的可变 hook 判定。

验证：`npm run check`、`npm run build:offline` 退出 0；codemode/guardrails/OAuth 相关 11 个文件及提示词相关测试通过。全套测试在 Git Bash 启动时，`native-file-metadata`（ACL 前置断言）和 `native-source-delivery`（GNU tar 把 `C:` 当远程主机）失败，均未触及本轮改动；两者在 PowerShell 下重跑通过。其余 217 个执行单元（含 memory 工作区）退出 0。未提交、推送或创建 PR。

### 三次复审补充修复（本地待复审）

复审报告的两项 P2 均已用探针复现：触发条件都是**显式配置** `hookTimeouts.lifecycle` 为 fail-closed（如 `timeoutMs: 20`）。默认 CLI 只配置 safety 超时，不会触发。

| 问题 | 根因 | 修复 | 回归 |
| --- | --- | --- | --- |
| 子调用已执行完成，但 `tool_execution_end` 投递失败后，Codemode 丢失该子调用结果（探针：文件已写入，savedResults 0，`Child calls: 0`） | `runNestedToolCall` 中结束事件抛出的错误直接冒泡，越过结果记录 | 捕获结束事件投递错误，沿用原生 `resultWithObservationFailure` 先例：保留 content/details，标记 `isError`；嵌套路径把 `[TOOL_OBSERVATION_FAILED]` 放在首个文本块，避免摘要把完成的结果显示成“失败 — Successfully wrote…” | `nested-tool-dispatch` 新增：执行 1 次、`isError`、首块为通知、原结果与 details 保留；去掉修复后失败 |
| 较早注册的 end hook 超时后，guardrails 的占用释放不再运行，同脚本重试得到 `DUPLICATE_CALL` | `ExtensionRunner.emit` 遇到 fail-closed 超时立即抛出，跳过后续处理器 | 只对 `tool_execution_end`：继续投递后续处理器，结束后抛出第一个超时；其他事件仍在首个超时处停止 | `extension-hook-timeout` 新增：调用顺序 `first, cleanup, third`、2 次超时、仍以 `ExtensionHookTimeoutError` 拒绝；`turn_end` 仍只到首个处理器；去掉修复后失败 |

原生顶层路径不变：顶层 `tool_execution_end` 抛错仍按既有语义让本次运行失败。成功路径不新增分配，`emit` 只多一个局部变量。另修复了既有的 tsc TS7022（`createNestedToolDispatch` 中 `owner` 自引用推断），给它加了显式类型注解；tsgo/tsc 均退出 0。

验证：agent 包 `npm run build` 和 `tsc -p tsconfig.build.json` 退出 0，`npm run check` 退出 0，`git diff --check` 通过；codemode/guardrails/OAuth/hook 超时/嵌套调度/观测失败相关 18 个文件共 286 项：281 通过、5 跳过（平台条件）、0 失败。`npm run build:offline` 退出 0。全套 `npm test`（PowerShell）：219 个执行单元（含 memory 工作区）全部退出 0，3,228 项中 3,138 通过、90 跳过，失败/取消/todo 为 0。

环境说明：本机 Git 安装在 `D:\Git`，PATH 原先只有 `D:\Git\cmd`。PowerShell 下 shell 解析器（先查 `%ProgramFiles%\Git`，再查 PATH 上的 `bash.exe`，与官方一致）找不到 bash，导致 `codemode-default-config` 失败。按用户要求把 `D:\Git\bin` 追加到用户 PATH（原值已备份）后，该测试及上次仅能在 PowerShell 下通过的两个单元都在同一次全量运行中通过。未提交、推送或创建 PR。

### 四次复审补充修复（本地待复审）

复审发现：结束事件观察失败后，成功写入从 `/changes` 消失。已用真实 `mutation-guard-write` 与 AgentSession 复现：文件写入成功，持久结果记录 1 条，父摘要 `Child calls: 1`，但 `collectChanges` 返回 `[]`。触发条件同上轮，需要显式配置 lifecycle fail-closed 超时。

根因：上轮修复把观察失败合并进了 `isError`，Codemode 再把合并后的状态和成功的变更凭据一起持久化；`session-evidence` 收集 v1 凭据时会跳过 `isError: true` 的写入结果。

修复：执行状态和观察失败分开保存，不放宽凭据校验。

- agent：新增 `NestedToolResultMessage.observationFailure { executionIsError, error }`，只在结束事件投递失败的分支由 agent-loop 设置，工具返回值无法注入。返回消息的 `isError` 仍为 true，父调用和脚本照常报告失败。
- codemode：持久化记录的 `result.isError` 取 `executionIsError`（工具自身结果）；观察错误写在记录顶层的 `observationError`，不进入带凭据的 `result`。details 仍需通过原有全部 v1 凭据校验（`mutationReceiptVersion`、`ok`、`category`、`stateChanged`、sha256 等），不因为 `details.ok` 就认定成功。
- 成功路径：`observationFailure` 不存在，持久化内容与修复前一致；只多两个局部变量，没有新增闭包。

回归：`codemode-session` 新增真实写入用例。断言文件内容、父调用失败且含通知、持久记录 `isError: false` 及 `observationError`；在实时分支和 `SessionManager.open` 重新打开的分支上，`collectChanges` 都返回 1 条 `write/succeeded` 记录，且凭据 sha256 与当前文件一致。去掉修复后该用例以 `collectChanges` 返回 `[]` 失败。`nested-tool-dispatch` 补充断言：失败分支 `executionIsError: false`、`error` 与首块通知一致；正常分支不带该字段。

验证：agent 包 `npm run build`、`tsc -p tsconfig.build.json` 退出 0；`npm run check`、`npm run build:offline` 退出 0；`git diff --check` 通过。相关 22 个文件（含 4 个 `/changes` 恢复测试文件）共 413 项：407 通过、6 跳过、0 失败。全套 `npm test`（PowerShell，刷新后的 PATH）：219 个执行单元全部退出 0，3,229 项中 3,139 通过、90 跳过，失败/取消/todo 为 0。未提交、推送或创建 PR。

提交前清理：按用户确认删除根目录 45 个 `.tmp-*` 诊断文件及 `scripts/.codemode-test-audit.mjs`（上文提及的诊断材料，结论已归档在本文和 performance JSON）；`.codegraph/` 与 `.sp/` 生成索引加入 `.gitignore`。未发现过期或无效测试：全部跳过均为平台条件，无无条件 skip/todo，无重名测试。

### PR #55 CI 失败与五次复审修复（本地待复审）

CI 失败：`npm run check`（tsgo）在 `tests/codemode-tree.test.ts` 报 TS2307。原因是该测试直接导入 `../packages/tui/dist/tui.js`，CI 在 `check` 之前还没有构建，所以 dist 不存在。修复：`@super-pi/tui` 入口导出 `releaseComponentRenderCaches`，测试改为从包名导入。类型检查映射到 src，运行时解析到 dist，与渲染器使用同一个模块实例（`RELEASE_COMPONENT_RENDER_CACHE` 是未注册 Symbol，src 和 dist 不能混用）。检查范围内没有其他静态 dist 导入。

| 复审问题 | 根因 | 修复 | 回归（去掉修复后均失败） |
| --- | --- | --- | --- |
| 截断后 show 的块已被删，但脚本自己打印的等文本副本让读证据被接纳 | `recordProjection` 在父结果任意位置找等文本 | 读事件携带宿主确定的 `parentContentIndex`（show 时记下块偏移，execute 加上摘要和脚本输出的块数）；只有原块在原位置完整保留才接纳 | `codemode-session`：打印副本完整、show 块被截断，edit 得到 `READ_REQUIRED` |
| 同一条 assistant 消息里多个 Codemode 调用，只有最后一个的 show 可被接纳 | 每次 execute 都清空 `displayedReads`，投影也只看第一个命中 | 一次投影结束一个批次：execute 只在上次投影之后清空；投影扫描最新的连续 toolResult 段，同 ID 只取最新结果；待投影父调用上限 16 | 两个并行 Codemode 调用各自 show，后续两处 edit 都成功 |
| 接纳的 Codemode 读证据在 reload / 会话恢复后丢失 | 恢复只认原生 read 结果消息，嵌套读没有协议消息 | 接纳时追加 `codemode-read-evidence-v1` 自定义条目（binding、父 ID、块位置与数量、window/truncation）；恢复时在同分支前面找到父 codemode 结果，取原位置的块，走原生 `restoreRead` 同一套 binding 校验 | reload 后 edit 成功；篡改条目的 toolCallId 后 edit 得到 `READ_REQUIRED` |
| `prepareNextTurn` 用 `{ ...context, tools }` 替换工具后，模型仍拿到旧声明 | 展开复制了旧的 `modelTools` 缓存 | tools 变了而 `modelTools` 没变时，按新工具重新 `selectModelTools` | `nested-tool-dispatch`：第二轮声明包含新增工具 |
| MCP 登录/注销成功后在 `ctx.reload()` 之后再用 `ctx.ui`（已被替换的命令上下文） | 成功通知写在 reload 之后 | 先通知再 reload，reload 之后不再使用 ctx；失败分支提前返回 | `mcp-oauth`：reload 后访问 `ctx.ui` 会抛错，测试断言只收到 reload 前的成功通知 |

说明：

- reload 测试需要 `bindExtensions` 绑定宿主（交互/RPC 模式都会绑定），否则 `AgentSession.reload` 不发 `session_start`，这是既有行为。
- guard 的证据判定是“证据文本包含 oldText”，与原生 read 恢复一致，不按行判定新鲜度，所以反例用篡改的条目，而不是修改文件。
- 投影路径（`recordProjection`）没有新增闭包或分配，`readSurvived` / `hasNewerResult` 是模块函数。恢复路径不在热路径上。
- MCP：`ctx.reload()` 本身抛错时不再显示“failed or was cancelled”，而是交给扩展命令的错误通道（这时 ctx 已不可用）。

验证：

- 新增 5 个测试单项，各自对应的修复去掉后都失败。
- `npm run check` 与 `npm run build:offline` 退出 0；`git diff --check` 通过。
- 全套 `npm test`（PowerShell，刷新后的 PATH）：219 个执行单元全部退出 0；3,235 项中 3,145 通过、90 跳过（平台条件），失败/取消/todo 为 0。
- 尚未提交或推送。

### PR #55 六次复审修复（9f0abb334 之后，本地待复审）

9f0abb334 的 CI（verify-linux、verify-windows）均通过。Codex 对该提交提出 5 条，逐条核实均成立：

| 复审问题 | 根因 | 修复 | 回归（去掉修复后均失败） |
| --- | --- | --- | --- |
| P2 `prepareNextTurn` 替换工具后声明过期（agent-loop 使用点） | 上轮只在 `prepareNextTurn` 处特判；缓存来自 `agent.state.modelTools` 等其他来源时仍会过期 | 新增 `isModelToolSelection(tools, modelTools)`：一次扫描、零分配，判断缓存是否仍等于 `selectModelTools(tools)`；agent-loop 在使用前校验，不匹配就重建。上轮特判已删除 | `nested-tool-dispatch`：存在 nested 工具时（缓存是独立数组），展开替换后第二轮声明包含新工具 |
| P1 原地修改 `agent.state.tools` 后声明过期 | README 允许原地修改返回的数组，但缓存只在 setter 中重算 | `AgentState.modelTools` getter 读取时校验，变化才重建；不变时保持同一引用 | `push` 后可见新工具，`splice` 后不再声明被删的工具，模型请求同步 |
| P1 不响应 abort 的子工具让 Codemode 永久卡住 | 沙箱超时后 `NestedToolDispatch.close()` 无限期等待子调用 settle | 取消后最多等 `NESTED_CANCEL_GRACE_MS`（5 秒）；超时放弃：拒绝运行中和排队的子调用 promise，计入 `abandonedCalls`，后续 close 不再等待。agent-loop 追加 `[NESTED_TOOL_ABANDONED]`（父调用已失败时也追加），提示子调用可能仍在运行或改变状态 | 单元测试（30ms 宽限）：close 有界、promise 被拒、二次 close 立即返回；`codemode-session` 端到端：`timeout_ms:200` 加永不 settle 的工具，约 5.2 秒返回并带两种标记。修复前该测试一直挂起 |
| P2 规范化后同名的工具（`foo-bar` / `foo_bar`）有一个不可达 | 宿主各自调用 `toCodemodeIdentifier`，第二个被丢弃 | 新增 `assignCodemodeIdentifiers`：本身已是合法标识符的名字保留；其他名字冲突时依次加 `_2`、`_3`…；按排序遍历，结果只取决于名字集合。宿主目录、Codemode 声明和 `describeTools` 共用这份映射；`describeTools` 也接受 `ALL_TOOLS` 中的别名 | `codemode-runtime`：两种注册顺序映射一致，全部可调用并列在 `ALL_TOOLS`；`codemode-session`：声明里有 `foo_bar` 与 `foo_bar_2`，脚本和 `describeTools` 都可用 |
| P2 OAuth 冷读在另一进程刷新期间报 ELOCKED | `read()` 用同步锁，重试约 200ms 并阻塞事件循环；刷新事务在网络请求期间一直持有异步租约 | `read(signal)` 改为 `withLockAsync`（可中止，最长等到租约过期时限）；读取期间已有事务提交时，保留更新的缓存 | 租约持有 600ms：冷读等待并拿到提交的 token；带 signal 的读可以中止 |

性能：`isModelToolSelection` 每轮最多扫描两次，不分配。宽限计时器只在 close 时子调用仍未结束的情况下创建。别名映射只在工具集合变化时计算。热路径上没有新增闭包或正则，也没有用 `String(`。

验证：

- `npm run check`、`npm run build:offline` 退出 0；`git diff --check` 通过。
- 全套 `npm test`（PowerShell）：219 个执行单元全部退出 0；3,241 项中 3,151 通过、90 跳过（平台条件），失败/取消/todo 为 0。
- 调试时修复前的挂起测试进程按 PID 结束（3 个，依据命令行确认）。
- 尚未提交。

### PR #55 七次复审修复（4c82dcacb 之后，本地待复审）

4c82dcacb 的 CI（verify-linux、verify-windows）均通过。Codex 提出 3 条：

| 复审问题 | 核实 | 修复 | 回归 |
| --- | --- | --- | --- |
| P1 原地修改工具数组后，嵌套调度仍按旧缓存授权 | 成立：`getCurrentTools` 返回 `agent.state.tools` 本身，按数组引用缓存的 `toolsByName` 不会因原地 `splice` 失效。排在写操作后的调用，以及 `isCurrentTool` 授权检查，都会认可已删除的工具 | `findTool` 改为每次线性扫描当前数组（不分配），删除按引用缓存 | 写操作子调用在执行中 `splice` 掉排队的工具：排队调用被拒，被删工具执行 0 次；改回缓存后失败 |
| P2 投影后的读证据要等下一次工具调用才持久化 | 成立：模型以文本结束本轮时没有 `beforeToolCall`，此后 reload 或树导航会丢失读证据 | 成功的 assistant `message_end`（非 error/aborted，非宿主操作）即接纳并持久化读证据；`beforeToolCall` 保留作兜底。该事件的监听逐个 await，在工具执行之前完成 | show 后模型以文本结束、reload 后 edit 成功；去掉修复后失败 |
| P2 规范化后同名工具被隐藏（prelude） | 重复报告：目录只经宿主构建，4c82dcacb 已用 `assignCodemodeIdentifiers` 分配不冲突的标识符，并有真实 prelude 测试覆盖 | 为让不变量明确，prelude 遇到重复标识符时直接让执行失败，不再静默保留第一个；`CodemodeTool.name` 文档补充冲突时的后缀规则 | 既有冲突测试通过 |

验证：

- `npm run check`、`npm run build:offline` 退出 0；`git diff --check` 通过。
- 全套 `npm test`（PowerShell）：219 个执行单元全部退出 0；3,243 项中 3,153 通过、90 跳过（平台条件），失败/取消/todo 为 0。
- 尚未提交。

### PR #55 八次复审修复（ebea295c1 之后）

ebea295c1 的 CI（verify-linux、verify-windows）均通过。Codex 提出 3 条：

| 复审问题 | 核实 | 修复 | 回归（去掉修复后均失败） |
| --- | --- | --- | --- |
| P1 subagent 被强制放进 Codemode | 成立：注册表把非控制工具一律标为 nested；subagent 默认 30 分钟、最长 2 小时，而 Codemode 默认 60 秒、最长 300 秒 | subagent 工具声明 `modelOnly: true`（`ToolDefinition` 已有字段），保持直接声明，脚本内调用会被拒绝 | 加载内置扩展后，subagent 为 `modelOnly`、出现在 provider 声明中；脚本 `callTool("subagent")` 被拒绝 |
| P2 恢复时父结果正好在保留窗口之外 | 成立：`restoreCodemodeRead` 只从 `start` 往前找，条目落在 512 条窗口开头、父结果在窗口外一两条时会丢失 | 和原生调用配对一样，搜索范围扩到有界的 `pairingStart` 前缀 | 填充记录使条目恰好位于窗口首位、父结果在窗口外，reload 后 edit 成功 |
| P2 读证据等下一次工具调用才持久化（agent-session.ts:1108） | 重复报告：ebea295c1 已改为在成功的 assistant `message_end` 时持久化，有"以文本结束一轮后 reload"的测试 | 无代码修改 | 既有测试通过 |

已知限制：bash/powershell 没有默认超时，但在 Codemode 中受脚本上限约束（默认 60 秒、最长 300 秒），超过 5 分钟的命令无法在默认路径完成。这是 Codemode 作为默认执行路径的设计取舍，本轮未改动。

验证：

- `npm run check`、`npm run build:offline` 退出 0；`git diff --check` 通过。
- 全套 `npm test`（PowerShell）：219 个执行单元全部退出 0；3,245 项中 3,155 通过、90 跳过，失败/取消/todo 为 0。

### PR #55 九次复审修复（b0edd20f7 之后）

b0edd20f7 的 CI（verify-linux、verify-windows）均通过。Codex 提出 2 条新问题（另外 3 条是旧评论，GitHub 把它们的 `commit_id` 前移到了新提交，`original_commit_id` 均为更早的提交，且已在前几轮修复）：

| 复审问题 | 核实 | 修复 | 回归（去掉修复后均失败） |
| --- | --- | --- | --- |
| P2 编排工具抛异常时不报告被放弃的子调用 | 成立：抛异常时直接进入 catch，结果在 `finally` 里的 `nested.close()` 标记放弃之前就已构建，调用方看不到 `[NESTED_TOOL_ABANDONED]` | catch 中先关闭嵌套调度（宽限期内等待），有放弃的子调用就把同一条警告追加到失败结果；警告文本提取为 `nestedAbandonedNotice` 共用 | 编排工具启动一个忽略取消的子调用后抛异常：结果同时包含原异常和 `NESTED_TOOL_ABANDONED] 1 child call` |
| P1 大图片被 Codemode 截断后无法展示 | 成立：`boundCodemodeResult` 把图片的 base64 计入 128 KiB 内联上限，超限时把所有内容块（含图片）写进文本溢出文件；browser-use 截图（最多 8 MiB）、`read` 图片都会失去可见图片 | 只按文本计入内联上限，溢出时只溢出文本，最多保留 16 个图片块；图片单独计预算（保留 16 MiB、show 16 MiB），不占文本的 1 MiB/256 KiB 预算；单个结果图片超过 256 KiB 时，脚本里拿到的是文字占位符（避免超过 1 MiB 的跨 VM 上限），图片本体留在宿主，用 `show(result.ref)` 完整附加 | 工具返回 200 KB 文本加图片：4 KiB 图片在脚本内仍是 image 块，可用 `image()`；2 MiB 图片在脚本内是占位符，`show` 后父结果包含完整 2 MiB 图片，文本走溢出。单独还原任一文件都会失败 |

验证：

- `npm run check`、`npm run build:offline` 退出 0；`git diff --check` 通过。
- 全套 `npm test`（PowerShell）：219 个执行单元全部退出 0；3,247 项中 3,157 通过、90 跳过，失败/取消/todo 为 0。

### PR #55 十次复审修复（bea12cfbc 之后）

bea12cfbc 复审提出 5 条：

| 复审问题 | 核实 | 修复 | 回归（去掉修复后均失败） |
| --- | --- | --- | --- |
| P1 嵌套授权没有使用下一轮替换后的工具集 | 成立：`getCurrentTools` 读的是 `agent.state.tools`。宿主在 `prepareNextTurnWithContext` 中只替换上下文工具、不修改状态时，模型声明和直接调用都用新工具集，而嵌套调用仍按旧状态授权 | `NestedToolDispatch` 增加 `turnTools`：以当前轮上下文为准，调度开始时记录实时工具作为基线；同名工具只有在基线之后被实时修改（原地删除、替换、脚本中途激活）时，才以实时状态为准。查找仍是线性扫描、不分配；`getTools()` 只用于列举 | 宿主替换下一轮工具后：被移除的工具执行 0 次，新增工具可调用，脚本中途 push 的工具仍可调用；不传 `turnTools` 时失败 |
| P1 文本截断后，后续图片被丢弃 | 成立：`capCodemodeOutput` 截断文本后直接 `break` | 截断后继续扫描，只保留图片（图片已有自己的预算；有可见文本时估算器不计图片 token） | `max_output_tokens: 256` 加大段文本后 show 1 MiB 截图：图片保留 |
| P2 内联快速路径没有应用 16 张图片上限 | 成立：只有文本超限才走截断路径 | 图片数量超过 16 也进入截断路径 | 短文本加 20 张图片，show 后只保留 16 张 |
| P2 show 按输入和 details 计费 | 成立：`record.chars` 含入参和 details，而 show 只追加 content | 记录 `contentChars`，show 的预算只按追加的内容计 | 两次 200 KB 入参、结果仅为 "ok" 的调用都能 show |
| P2 排除 codemode 后普通工具不可调用 | 部分成立：`createAgentSession`（CLI `--exclude-tools` 和 SDK 都经过它）已拒绝排除 codemode，所以评论描述的场景不会出现；只有直接构造 `AgentSession` 并传 `excludedToolNames` 时可以绕过 | 防御性修复：注册表中没有 codemode 网关时，不把普通工具标为 nested | 拒绝排除 codemode；注册表中没有网关时，read/bash/edit 直接声明 |

补充：热路径 AST 审计（`codemode-hot-paths.test.ts`）要求 `getTools` 不分配。因此 `getTools()` 改为直接返回当前轮工具（没有轮上下文时返回实时工具），`AgentToolExecutionContext` 新增不分配的 `findTool(name)`，按上述规则授权；`describeTools` 改为按名称逐个用 `findTool` 授权（支持脚本标识符的反向映射），能看到脚本中途激活的工具，也会排除被移除的工具。

验证：

- `npm run check`、`npm run build:offline` 退出 0；`git diff --check` 通过。
- 全套 `npm test`（PowerShell）：219 个执行单元全部退出 0；3,250 项中 3,160 通过、90 跳过，失败/取消/todo 为 0。之前一次运行中，`file-change-recovery.test.ts` 的 "N1 … draft placement" 偶发失败（编辑器草稿时序，与本轮改动无关）；单独运行 3 次和全套重跑均通过。
