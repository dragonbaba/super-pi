# 2026-11-03 性能、稳定性与回退复核

本轮审查已完成，确认的十类缺陷已修复，两个性能改进候选保留为后续事项。依据 [hot-path allocation contract](hot-path-allocation-contract.md)，同时检查闭包、临时对象、正则、取消、权限和资源释放。没有引入对象池。初次审查时未提交，后续已按用户要求汇总至 PR #174；CI/Codex 追加修复记录见文末。

## 范围与方法

对 `packages` 和 `scripts` 中 1,060 个 JS/TS 文件（约 25.36 万行）建立指纹及 AST 清单，排除依赖、生成产物、vendor、测试、示例和 benchmark。第二遍扫描记录了约 1.62 万个函数、1,101 处正则及 10 处动态构造；这些是待分类线索，不是缺陷数。固定验收脚本与正常产品入口分开判断。

手工深入检查：Session/权限与分支历史 → CodeMode → 工作区 VM/来宾 worker/C# 命令监管 → 候选验证 → 原生 FileService → 记录与清理；MCP 启动/stdio/HTTP/取消；Provider 与压缩回退；交互事件/Esc/渲染队列；ANSI 输入清理与工具输出展示。复现先于功能修复，红灯记录保留。自动静态覆盖不等于逐行手审全部代码；依赖实现、所有原生平台分支和所有 Provider 的在线服务行为不属于已实测结论。

清单与原始证据在 `.artifacts/review-static.json`、`review-alloc-regex.json`、`review-evidence.md` 和 `review-closeout.json`。

## 修复结果

| 问题 | 原行为与影响 | 当前行为 |
| --- | --- | --- |
| 普通沙箱失败永久关闭 owner | 缺失文件或非零退出码会使后续操作一直报已关闭 | 清理 VM/快照后允许下一次操作建立新快照；不重放失败命令。清理失败仍锁住并保留两类错误 |
| 多文件候选逐项验证 | 后面的坏路径、重复项、编码错误可能在前面已落盘后才发现；宿主缺少总容量检查 | 写入前验证整组路径、大小、重复项、Base64、UTF-8；32 项、16 MiB 总量、2 MiB/项。实际提交仍不是事务，后续冲突报告已确认发布数量 |
| 文本编辑替换无效字节 | `toString('utf8')` 的替换字符可能被当作真实原文回写 | 读/编辑明确拒绝无效 UTF-8；grep 跳过非 UTF-8 文件 |
| 源身份校验的测试旁路 | 未初始化 sourceRoot 时直接返回 | 生产路径明确拒绝；注入测试自行 mock 身份检查 |
| 清理中断无法重试 | 已删除文件还保留在 owned Map 中，下次 cleanup 在 ENOENT 失败 | 每项成功后移除对应身份；剩余项继续保留，可按原身份重试 |
| MCP 清理失败 Promise 永久缓存 | 进程族第一次清理失败后，显式重试仍返回旧拒绝 | 失败时释放该 Promise，保留 Job/进程身份；后续 close 重新确认清理 |
| 捕获文件增长突破分配预算 | lstat 后使用无界 readFile，持续增长文件可能超出已准入大小 | 文件身份/版本/大小再检查；只分配已准入大小，短读和读中变化拒绝；部分目标写入也先登记归属 |
| 授权反复生成完整历史数组 | 每次工具授权 O(历史长度)，产生完整 branch 数组 | 同一叶子直接返回，新增条目增量扫描；不同分支重新核对，WeakRef 不强持有历史，dispose 清空 |
| 压缩/重试覆盖 Esc 导航 | 显示回到底部提示时按 Esc 却先取消操作；每次 start 新建捕获闭包 | 统一先回到底部，第二次 Esc 才取消；使用生命周期稳定回调 |
| ANSI OSC 正则二次方扫描 | 重复未闭合 OSC 起始符导致每次都重扫剩余后缀 | OSC 线性扫描，CSI 使用模块级 sticky 正则；无新匹配数组、每次调用正则或闭包，保留旧 stateless 语义 |

候选验证还移除了逐路径分量创建的临时数组/闭包，固定正则提到模块级，路径长度先限定。保留必要的有界候选数组、解码缓冲和结果字符串；没有把必要结果对象包装成“零分配”结论。

## 性能与释放证据

| 场景 | 本轮观测 |
| --- | --- |
| 权限历史 | 10,000 条历史；旧 getBranch 1,000 次产生 1,000 个完整数组，采样 236,032,064 B。新 restoreHistory 200,000 次：历史查找 0、branch 数组 0、Promise 0，采样 55,872 B（包括夹具）。新增两条只查找两条，分叉回归通过。次数不同，不把总量直接相除宣称加速倍数 |
| 候选容量 | 8 × 2 MiB 共解码 8 个缓冲、16,777,216 B；第九项导致总量超限时额外解码 0。V8 采样 45,720 B 不包含全部 Buffer backing store/字符串，精确字节计数单列。4 WeakRefs、4 轮 GC 后 live=0，权限叶子/拒绝集合/边界参与者/快照残留均 0 |
| 捕获增长 | 源文件从 1 MiB 增至 65 MiB，捕获拒绝，实际读取缓冲最大仍为 1 MiB，清理后 ownedArtifacts=0 |
| ANSI | 旧 1k/2k/4k/8k OSC 起始符约 0.55/1.72/6.71/26.96 ms；新 8k 约 0.19 ms、65,536 个约 1.52 ms，仅作为本机观察。确定性门禁：131,072 code units、327,678 次字符读取，小于 4 倍线性上限；1,011 组旧语义对照一致 |
| 完整输出链 | `getTextOutput → stripAnsi → sanitizeBinaryOutput`，100 次 × 128 Ki code units 极端控制字符输入，Promise=0，4 轮 GC 后请求 owner=0。此完整链仍有约 216 MB 总采样分配，见下方未关闭事项 |
| 全屏帧 | 5,000 帧，约 10,112 B/frame，p95 0.038 ms；hint 字符串缓存/最终帧/队列及四轮组件生命周期计数在 `review-tui-perf.json`。释放后组件、行、source、cache 引用归零。该采样包含现有布局/队列，不能说所有渲染都零分配 |

真实 Windows Sandbox 验证：先执行“写 dirty.txt 后 exit 7”，宿主无 dirty.txt，旧 VM/快照完全释放；同一会话随后重新建立快照并成功 read/find/write/grep，写回中文成功。共 2 次 VM 启动、5 次调用；最终 VM=false、sourceFiles=0、ownedArtifacts=0、4 轮 GC 后 owner=0。详见 `review-real.json`。这不是联网依赖安装或任意大型工程构建验收。

## 验证记录

- 扩展回归 339 项：318 通过、21 个平台前置条件跳过、0 失败，涵盖原生文件、CodeMode、MCP、Provider/压缩和全屏导航。见 `review-regression.txt`。
- 最终变更定向检查 38 项全部通过，见 `review-final-changed-tests.txt`。历史增量检查、源不变量与压缩/重试 Esc 的专门记录见 `review-policy-tests.txt`、`review-final-targeted.txt`。各批次有交集，不累加声称独立测试总数。
- `npm run check`、coding-agent 构建和 40 文件 Windows runtime 打包通过；当前 `superpi --version` 为 `1.0.0`。更新已有本地构建，无新启动方式。
- 未重复执行全量 CI，也未自动运行冻结的沙箱验收入口。修复变化后的必要复验保留，未删用户测试。

## 回退判断与剩余事项

保留：仅在 auto 传输选择中的 WebSocket/HTTP 兼容，取消检查后不继续回退；可重建的 MCP schema cache 失效；无在线摘要证明时的明确取消；仍有 owner 的清理失败阻止新权限发布。这些各自有明确条件。未增加宿主降级、跨 Provider 偷换、自动重放有副作用操作或忽略清理错误。

仍需专项优化，不能写成已关闭：

1. 极端密集控制字符的完整文本展示链分配仍偏高，约 2.16 MB/次（输入 128 Ki code units）。检查发现清理函数拼接许多短可见片段；试验模块级字符类 replace 后整体采样约 218 MB/100 次，没有证明改进，已撤回该改写，保留原实现与对照证据。线性时间修复已完成；进一步减少结果字符串构造需要独立方案和全链比较。
2. `tui-kit` 的 browse/multi-select renderer 仍有条件展开、临时行数组等结构性热点候选。此次没有为其所有菜单形态建立代表性 allocation profile，因此没有未经量测地加入缓存或池，也未宣称满足整个仓库每个 renderer 的零临时分配要求。Markdown/LaTeX 等构建型 helper 则须结合上层缓存失效频率判断，不能仅凭函数名或字面量计数定性。

实际 VM 与工作区快照已清理。早期注入测试的一处遗留空目录 `C:\Users\Administrator\AppData\Local\Temp\sp-review-recovery-9N83zZ` 及两个空子目录仍保留：自动审批策略拒绝按记录删除，返回仅为 `blocked by policy`，未绕过该限制；不含运行中进程。其余 `.artifacts/review-*` 是有意保留的审查证据。

## PR #174 CI / Codex 追加修复

2026-11-03，修复首轮 CI 的两项失败以及 Codex 的三项审查发现：

- 干净检出类型检查：补齐 windows-shell-job 的源码路径映射；statusline 集成测试保留真实构建产物的运行时加载，类型来自源码，不再要求先有 dist 才能检查。
- 全屏退出测试：故障组件挂入两个渲染器实际拥有的 chatContainer，保留组件错误优先、终端先释放和迟到回调不触碰 UI 的全部断言。
- 搜索权限：grep/find/ls 包含默认工作区范围；deny/ask 匹配任何相交搜索范围，allow 仍要求全部包含。规则与目标均使用实际路径，覆盖目录别名、嵌套目录和越界拒绝。
- LSP 写入：宿主策略为 lsp_fix(write=true) 签发精确文件授权，保留 root/path、输入指纹、受保护路径、Plan 和撤销检查；缺少调用者 signal 时使用执行边界 signal。实际注册工具通过真实 LSP 服务修复文件并落盘。
- 候选上限：原生写入、宿主预验证与来宾请求预算共用 MAX_WRITE_BYTES=1 MiB。来宾写入/编辑结果/命令候选均遵守该预算，读取上限仍为 2 MiB。前文 2 MiB/候选是初次审查时的历史值，以本次修正及 execution-environments.md 为准。

调用链复核覆盖授权入口到单次授权释放、host request → guest mutate/changes → 整组 validateChanges → FileService.prepare/execute → owner 清理。新增文件系统解析位于单次工具准入，规则最多 128、目标最多 34；没有在流式事件、渲染或逐字节循环新增闭包、临时包装对象、正则实例或对象池。

定向测试并集 70 项通过、0 失败（alpha shutdown、native policy、session permission modes、source invariants、LSP、statusline）；npm run check 与 coding-agent 构建/沙箱 runtime 打包通过。只运行相关本地检查，完整 Linux/Windows 矩阵由 PR CI 运行。

分配与释放复验（.artifacts/pr174-perf.json）：16 × 1 MiB 候选仅解码 16 个缓冲，共 16,777,216 B；追加超限项额外解码 0；V8 采样 40,112 B 不含全部外部缓冲，不能代替精确字节计数。200,000 次历史检查无历史查找、branch 数组或 Promise；采样 26,408 B 含夹具开销。4 个 WeakRef 经 4 轮受控 GC 后 live=0，权限叶子、拒绝集合、边界参与者及快照残留均 0。

真实 Windows Sandbox（.artifacts/pr174-real.json）：1 MiB 候选成功落盘；同批次包含先写入的小文件和 1 MiB+1 字节文件时，宿主两者均不存在。1 次 VM 启动、2 次命令调用，最终 vm=false、ownedArtifacts=0、sourceFiles=0。该测试验证新的预算字段实际跨越宿主/来宾边界，不以 mock 代替传输验收。

第二轮 CI 在 Linux/Windows 的 alpha-crash-cleanup 中暴露同类旧挂载点，已改为实际 chatContainer；31 项清理回归通过。仓库中其余 renderer.addChild 用法已核对，output-padding 对全屏明确使用 setLayoutRoot。CI 使用现有 --keep-going 并关闭矩阵 fail-fast，保留非零失败状态和每项一次的分片安排，收集完整独立失败，减少反复重跑；较新推送仍取消旧运行。

完整矩阵追加定位（首个不提前取消的运行 41611716187）：

- POSIX 浏览器清理有实际生命周期缺陷：根进程 close 后最后的清理定时器被 unref，待返回的 Promise 可能随事件循环提前结束。两种有界清理定时器现在保留引用到 settle/dispose，普通执行 deadline 仍随活跃 child 管理。VM 注入增加 referenced 断言，覆盖 POSIX 根先退出和 Windows 清理超时；9 场景 / 8,000 输出更新、每流 8,192 B，39 WeakRef 最终 live=0，pendingTimers=0，采样 5,236,920 B 含 VM 夹具。流式 append/onStdout/onStderr AST 门禁继续通过，未新增热路径分配。
- 旧测试适配原生读取：首次 MIME/source/native revision 共 3 次 open、2 个有 stat 的捕获，后续缓存命中仍禁止新增磁盘打开；证据 artifact 使用实际两块文本及总字符数，重新真实读取签发新 snapshot。极小预算不能容纳成对凭据时必须保留原结果并阻止请求；不再假定带版本凭据的读取只占 1 token。没有放松产品预算、身份精度或证据准入。
- Node 22 的 rmSync 会经过导出的 unlinkSync 并使用 Buffer 路径，删除测试只拦截目标会话文件，允许锁文件按原函数清理。交互测试夹具补齐 settingsManager.getPermissionMode；产品接口不添加兜底。
- 22 个历史 native 检查明确要求已审查的固定 Windows 编译器/PowerShell 指纹；不满足时报告前置条件跳过，匹配时保持原正文与全部安全断言。31 个依赖盘符/NTFS 语义的检查限定 Windows，仍在 Windows CI 自动执行。其他跨平台模型检查保持自动运行；16 个冻结文件未修改。只在工具链匹配时创建干净检出缺少的 .artifacts 父目录。产品固定工具链校验没有改动。

本地追加结果：交互/删除/浏览器/权限批次 154 通过、1 条原有平台跳过；本机固定工具链及 Windows 模型 101 项全过；证据与 source-invariants 48 通过、35 条平台跳过。后者 Linux 专项由远端矩阵验证，不能把本机跳过表述为 Linux 已通过。

## PR #174 后续自动审查修复

提交 e1382be22 的完整 CI（41614082159）六个分片全部通过。等待期间 Codex 又报告路径规范化、原生委派和沙箱搜索范围三处问题，继续修复后交由新提交的 CI 复验：

- 宿主 read/grep/find/ls 的授权现在采用各工具实际使用的路径解析，并在原参数对象上附加不可枚举的单次规范路径凭证；执行消费凭证，不重新选择文件名兼容变体。原参数指纹、调用 ID、会话代次仍检查。原生 write/edit 及批次对应项使用 FileService 的 resolveToolPath；delete/move 保留原有字面路径语义。
- 原有委派合同和结构化 argv 分类器移到核心，扩展保留兼容导出。原生授权完成后签发子代理、结构化只读命令和同链发现的浏览器执行凭证。cwd、目录 dev/ino、参数、单次消费和撤销检查保留；Plan 子代理只读，浏览器执行拒绝。沙箱不增加这些宿主扩展的支持。
- 来宾搜索在 catalog 遍历前只规范化一次范围；匹配支持目录后代和精确文件，不再在每个条目上执行 replace/正则/拼接。保护目录、越界、符号链接和缺失路径仍拒绝。

完整调用链：native authorize → 工具单次路径/委派消费 → 实际读取/结构化进程准备 → 执行边界撤销及释放；沙箱 authorize → 请求封装 → 来宾 searchScope/catalog/matchesScope/grepRows → 有界结果 → owner.close。新增目录探测、数组和冻结凭证均属单次工具准入；子代理最多 HARD_MAX_TASKS=256，结构化外部根最多 16。没有在流式输出、渲染或逐目录条目新增闭包、Promise、正则实例或临时包装对象。

验证：原生策略 13 项通过；沙箱完整 guest 入口在两个模式执行 90 次范围请求，含 `./src`、单文件、前缀碰撞及越界拒绝。真实只读 Windows Sandbox 启动 1 次，grep/find/ls 各验证目录与单文件，共 6 次调用成功，最终 vm=false、sourceFiles=0、ownedArtifacts=0；私有工程目录已按记录删除。结构化 Git 工具实际执行通过。相关委派/进程回归 128 通过、2 个平台跳过；原生文件/读取/source invariants 65 通过、1 个平台跳过。批次存在交集，不累加为独立测试总数。类型检查与最新本地构建通过。

分配证据（.artifacts/pr174-second-perf.json）：200,000 次范围匹配，100,000 次命中，逐项规范化/正则/对象均 0，V8 采样 21,016 B（含夹具）；16 次原生授权/消费及 4 次权限切换采样 590,928 B，已消费附件 0 残留。64 个 WeakRef 经 4 轮 GC 后 live=0，边界参与者和临时根均 0。消费函数及范围匹配的 AST 门禁通过；没有引入池或把单次准入分配宣称为零。
