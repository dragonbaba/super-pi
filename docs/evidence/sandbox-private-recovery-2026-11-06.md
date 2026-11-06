# D.b：沙箱无副作用恢复与私有目录验收

日期：2026-11-06；Windows，Node v26.13.0。基于 D.a 合并 `e5d00744f6cd163b9e3b4f74b28ed86fe7cf8bdd`。本批只处理 D7/D8；不扩展命令预检、识别、过滤或执行环境切换，也不修改工作区路径规范化和来宾盘符映射。

## 行为与证据

- D7：host 的参数翻译/容量拒绝发生在 VM 操作之前；guest 的 `WorkspaceInputError` 或普通只读 ENOENT/ENOTDIR 仅在 request/read 阶段可声明 `noEffects`。修改、创建附件、命令启动前先改变阶段。host 校验无执行事实、候选和附件，才保留失败后的 VM。非明确无副作用、取消、身份/完整性或清理失败继续既有处理。
- 批次第一项已修改、第二项 snapshot 拒绝仍为 mutation；命令启动失败不按只读处理；路径重定向不是普通读取错误。复用原有 `WorkspaceOperationError`，无新恢复框架或错误码猜测。
- D8：全局 `sandboxPrivateDirectories` 默认 `target/.venv/__pycache__` 三个独立名字；数组替换默认，空数组关闭可选排除。单名任意层级，含分隔符条目按各工作区相对目录匹配，忽略大小写；64 条上限。固定五类既有排除仍保留，普通文件 `target` 不被排除。
- 配置在 owner 创建时复制冻结，项目配置、模型参数、调用者后续修改数组都不能改变该 owner。导入和命令枚举在容量计数前跳过目录；原生文件变更不生成私有候选；宿主收到私有候选会在首项发布前拒绝整批。既有符号链接规则不变。
- 捕获实测：同一测试树配置排除后捕获 4 个条目、2 文件、4 B；空数组捕获 12 条目、6 文件、56 B；`.git` 始终不导入，宿主哨兵保留。相对目录配置不误匹配 `other/build/private`，VM 原生写入、命令候选和宿主拒绝共享分类。

相关功能文件 `settings-json-schema`、`sandbox-search-scope`、`sandbox-image-read`、`session-permission-modes`、`sandbox-workspace-shutdown` 共 61 个原测试与修改后测试，首次 59 通过；新增测试误用批次 `type` 字段及在 host 阶段测试相对路径拒绝，改为既有 `operation` 和明确外部绝对路径后定向 2/2 通过。新捕获用例、两个源码回归及共享策略热路径检查 4/4 通过。最终分类相关 6 项覆盖通过（一次使用不受既有原生文件路径语法支持的 `.` 组件，撤回该额外假设，保持既有路径规则）。图片附件身份、哈希、取消与清理失败检查均保持通过。

真实 VM 验收扩展既有 `tests/sandbox-snapshot-recovery-live.test.ts`，经原生授权 → CodeMode → 嵌套派发 → 沙箱 → 原生发布完整链：

1. 三个宿主私有目录的 `host.txt` 未导入。VM 写入各自 `vm.txt`，宿主没有该文件。
2. 普通文件 read/write 成功；旧 snapshot 写入拒绝；重新读取得到已更新内容，并能读取 VM 私有文件。此时 starts=1。
3. PowerShell 实际写入私有目录后退出 9。失败不发布，下一次读取捕获新快照，starts=2；旧 VM 私有文件消失，已发布宿主普通文件仍为更新内容，三个宿主私有哨兵不变。
4. 关闭后 vm=false，ownedArtifacts=0，sourceFiles=0，owner 父目录为空。首轮失败仅因测试第二次复用已结束的 NestedToolDispatch；每次 CodeMode 调用使用独立 owner 后真实 VM 1/1 通过。23.5 秒为整个验收耗时，不是 VM 冷启动测量。

## 性能契约

审查链：SettingsManager getter → backend 构造/请求快照 → capture → worker catalog/selected → changes/commandChanges → host validateChanges/publish/release；读取/search 的 local/read/needInput 与错误返回 → backend 保留或 discardSnapshot/close。正常搜索/进度交付未增加调度、计时器或异步 owner。

- 新 privateDirectoryMatches、isVmPrivateDirectory、isVmPrivatePath 在每个目录/候选上执行：内联闭包、Promise、AbortController、包装对象、数组均为 0。不创建逐条 regex，不引入缓存或对象池；仍有大小写/分隔符归一化和组件字符串切片。
- 精确冷路径例外 `parseSandboxPrivateDirectories`：每次设置读取/owner 创建/guest 请求产生最多 64 条的不可变列表，单条小于 4096 字符，校验时可产生临时组件数组；不在条目循环中解析配置。静态默认列表为模块常量；自定义列表归 owner/request，调用结束或 owner 释放后可回收。
- 现有 capture 的 stack、source Map，selected/catalog 的 Map/哈希缓冲、候选数组及 host contents 数组保持既有容量/生命周期；不是新“零分配”承诺。搜索两数组最多 200 个结果、20,000 个待遍历路径，正常/溢出/异常均在 finally 清空。文件服务发布及附件验证仍按原有限额和清理处理。
- 实际 helper 基准 `sandbox-workspace-paths.mjs` 各 200,000 次：既有 local 约 4,187 B/次（含 path 库）；新私有分类约 137 B/次。初版 for-of 迭代器采样约 522 B/次，改为下标循环后减少；仅是同机采样，不宣称整链速度提升。3 个 WeakRef 经 4 轮 GC 后存活 0。
- 真实 search helper 的 synthetic filesystem：256 次/操作及 32 次预热；ls/find/grep 分别约 35,918 / 875,751 / 890,031 B/次，包含测试文件系统和 path 库。每次列表读取 1；内容读取 0/0/201；stat 1/202/403。逐条 callback/Promise/AbortController/options=0，全工作区 catalog=0。16 个 WeakRef 在正常、溢出、异常和重试后均释放。

## 复现与构建

```powershell
node --experimental-strip-types --test --test-concurrency=1 tests/settings-json-schema.test.ts tests/sandbox-search-scope.test.ts tests/sandbox-image-read.test.ts tests/session-permission-modes.test.ts tests/sandbox-workspace-shutdown.test.ts
node --experimental-strip-types --test --test-name-pattern='sandbox text editing|guest writes, edits' tests/source-invariants.test.ts
node --expose-gc scripts/bench/sandbox-workspace-paths.mjs
node --expose-gc scripts/bench/sandbox-search.mjs
node node_modules/@typescript/native-preview/bin/tsgo.js --noEmit
node node_modules/@typescript/native-preview/bin/tsgo.js -p packages/coding-agent/tsconfig.build.json
node scripts/build-windows-sandbox-runtime.mjs
```

真实 VM 在 child 环境设置 `SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE=1` 后运行上述 live 文件。TMP/TEMP/TMPDIR 使用任务拥有目录，并由 preload 验证；PID/启动身份与 stdout/stderr 记录于 `.task-tmp/permission-repair-883e92408b` 的清单和进程账本。日志前缀 `sandbox-private-*`；子 fixture 已按身份释放，原始日志随总任务结束清理。

类型检查、coding-agent 编译及 41 个运行器资源打包通过；worker/policy 源码与 dist SHA-256 各自一致。全仓最终离线构建仍在阶段 F，本批不把局部编译当作该最终验收。PR 审查、最新 CI 和合并状态见任务计划完成记录。
