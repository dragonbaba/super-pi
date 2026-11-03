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
