# C2：既有 Shell 结果接入原生授权

日期：2026-11-06。Windows，Node v26.13.0 / V8 14.6.202.34，基线 `6639235f222fa8d47438edb25cd6df23b4f789c5`。严格执行任务计划 1.5：不加强命令预检，不新增语法、正则、控制流推断或防绕过体系，不改变实际 Shell 路径语义和执行环境。

## 改动边界

14 个已有分析模块迁至 coding-agent，避免原生授权反向依赖可选扩展；旧扩展文件保留重导出，现有测试与守卫使用同一份编译模块。复核基线与新文件：排除 import 调整、core/permission-bash 的已识别目标观察、已有 move/find 操作数角色传递，以及 PowerShell 转交已有 owner 后，13 个非 owner 模块的语句完全相同。owner 的既有分析、容量与缓存逻辑不变，只增加调用内最多 34 个目标的观察、转交及释放。编译后 Node 别名和 Bun 虚拟模块补齐相应注册。

`SessionExecutionPolicy` 在 host-write 使用已有 `inspectHighRiskBashMutation` / permission scope 结果。只有 `mutationDetected` 为真才消费目标及不确定状态。没有已识别变更的不透明脚本保持原有授权行为；不把解析器的不确定性变成通用拒绝。读取操作数、可执行文件及 cwd 标记不是覆盖证据。git 的既有目录标记也不等于已有文件覆盖。

已识别的普通外部删除询问一次；敏感删除直接拒绝并向模型和用户说明；外部已有文件覆盖拒绝并通知，整轮暂停留在 C3。附加工作区仍通过既有 native 身份判断。复用原生授权的请求身份、取消/拒绝恢复、权限代次及执行前 cwd 校验。CodeMode 子调用和后台启动使用相同入口。

## 实际行为验证与限制

新增 `tests/host-shell-permissions.test.ts` 以 4 个代表用例覆盖：

1. 真实 Bash/PowerShell 删除独占夹具中的工作区外文件：取消后内容仍在，再次批准后才删除，询问计数准确；附加工作区内实际删除不询问。
2. 外部已有文件写入不执行且通知；外部读取与本地删除组合正常执行。项目根、`.git`、盘符根的敏感删除只验证授权拒绝，绝不实际执行；普通 git 操作不受目录写入标记误拦。
3. 既有 `rm -rf "$X"` 识别结果要求询问。Windows Bash `/tmp/example` 不展示虚构的 `D:\tmp\example`，保留原命令供用户确认。真实 `cd /tmp`、`cd missing-directory || ...` 和 npm 从子目录查找父级 package.json 正常执行，不增加询问。
4. 实际 Agent → CodeMode 嵌套派发以及受管理后台 Bash：取消无删除、批准执行、每次只询问一次，后台任务完成且 exitCode=0。

初次测试中子进程 TMP 登记不接受独立 fixture 根，修正任务级登记后通过；CodeMode 测试误用只允许单工具的 host dispatch，改为受控离线模型驱动实际 Agent 调度。均未为适应测试修改生产调度或 Shell 逻辑。

首轮审查两项适配缺陷均先复现：同一路径写入和删除不能全局改成删除；已有 find 搜索范围不能当作文件覆盖。保留独立 write，仅把既有 move 操作数按原 destructiveTargets 结果归类；已有 find 分支传递 contents 角色。两个失败子项修复后通过，增加普通 move 对照；不增加识别分支或参数分析。修改后行为/AST 共 18/18 通过。CI 的另外两类根因是编译后加载别名漏迁移、UI 夹具假定一个 tick 足够等待异步授权；修正后原 launcher 8/8、两个真实交付入口 2/2、真实倒计时/Escape/再次允许 1/1 通过，类型检查/编译通过。UI 生产超时及授权语义不变。

不声称完整 Shell 覆盖：既有分析不支持的 cmd/PowerShell 写法、间接脚本、参数语义继续是限制。已有 glob/find 搜索范围不冒充精确删除目标；Shell 内部改变 cwd、Windows Bash 绝对路径/HOME 不能使用旧 Node 路径推算，已识别变更按不确定目标询问。移动到目录的实际落点不新增 basename/参数推导。Shell 授权不是原生文件提交的逐项身份保证，也不是对抗性安全边界；这些限制不转成预检增强待办。

## 性能与生命周期

审查链：Agent 准备调用 → ExtensionRunner 原生授权 → 既有分析 owner / high-risk / scope → 已识别目标观察 → native 路径与 C1 分类 → 对话框 → 授权消费 → 既有 Bash/PowerShell cwd 绑定与执行；CodeMode 嵌套和 nativeTasks 在同一授权前经过此链。旧扩展仍对原生 profile 提前返回，没有新增第二轮旧守卫审批。

- 字符扫描和新增结果适配无逐字符闭包、Promise、AbortController、Buffer 副本或新正则；AST/源码不变式通过。已有 scanner 的分段/目标数组和字符串仍存在，不宣称零分配。
- owner 最多 128 条、512 KiB UTF-16 引用预算；新增目标数组最多 34 项，每项目标小于 4,096 字符。它在同步分析结束转交调用者，owner 在 finally 清除 Map、源字符串和未转交目标；结果只由当前授权持有，不挂到会话或最终 token。
- 原生授权中的异步文件身份查询、审批回调与有界路径/操作数组按一次调用持有；没有增加进度/渲染逐事件分配。没有对象池或全局对象缓存。
- 既有基准默认四例每例预热 64 次、测量 512 次，HeapProfiler 4,096 B 采样。prepareCalls 严格为 512/1,024/1,024/512，owner created=released=2,308，liveOwners/liveEntries/liveBytes=0。完成、异常、取消、失效后 16 个 WeakRef 存活 0；这些是旧 owner 生命周期路径，不扩大语法测试。
- 新 `--native` 只测普通输出、已知删除、不确定删除三个代表输入：prepareCalls 均为 512、每次共享一次分析，修复后采样约 7,160 / 9,198 / 9,135 B/调用；主要仍在旧 parseShellSegments/inspectScript/path 处理。owner created=released=1,729，全部 live 计数为 0；返回结果、数组和目标的 3 个 WeakRef 在 GC 后为 0。此同步适配基准只声称返回后引用释放，不把它冒充真实取消测试；取消效果见上面的实际调度用例。采样含基准断言开销，不据此声称速度改善。

## 可复现检查

```powershell
node --test tests/host-shell-permissions.test.ts
node --test tests/host-file-permissions.test.ts
node --test tests/shell-analysis-source-invariants.test.ts tests/shell-analysis-authorization.test.ts tests/shell-analysis-hook-lifecycle.test.ts tests/shell-observation-hot-paths.test.ts tests/shell-common-compatibility.test.ts tests/shell-explicit-cwd.test.ts tests/policy-diagnostics.test.ts
node --test --test-name-pattern='selected hot runtime|image and permission' tests/tui-hot-paths.test.ts
node --expose-gc scripts/bench/shell-authorization-analysis.ts
node --expose-gc scripts/bench/shell-authorization-analysis.ts --native
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/coding-agent/tsconfig.build.json
```

既有相关回归共 228 项：226 通过、2 平台跳过。C1 原生行为 8/8、正则常量位置 2/2 通过；最终新增行为 4/4 与分析不变式 11/11 通过，coding-agent 编译通过。类型检查须使用仓库既定 tsgo；误用普通 tsc 得到未修改 TUI `v` 正则/ES target 的诊断，改回既定检查后通过，不调整编译目标或生产正则。

所有进程 TMP/TEMP/TMPDIR 在启动前设为任务拥有目录，并验证真实 `os.tmpdir()`；新夹具在 `.task-tmp` 建立独立资源清单，结束时释放。原始输出/PID 清单位于任务根 `permission-repair-883e92408b`，随整个任务收尾清理。局部编译不是阶段 F 的最终本地离线构建。PR 审查、CI、合并和分支清理状态以任务计划为准。
