# 会话权限与沙箱

直接运行 `superpi`，进入会话后输入 `/permissions`（也支持 `/permission`）选择权限。普通启动无需额外的沙箱参数。

| 选项 | 执行位置 | 项目文件行为 |
| --- | --- | --- |
| 只读（沙箱） | Windows MXC ProcessContainer | 直接读取授权工作区；操作系统阻止项目写入。 |
| 沙箱读写（默认） | Windows MXC ProcessContainer | 直接读写授权工作区，修改即时保存在宿主项目。 |
| 宿主机受限 | 当前宿主系统 | 工作区（含 `/add-dir`）内文件操作、只读命令及目标在工作区内的已识别文件命令直接执行；其余命令、MCP 和工作区外访问按原生策略询问。敏感目标与外部覆盖仍拒绝。 |
| 宿主机受限 · Auto 审查 | 当前宿主系统 | 与宿主机受限相同，由当前模型回答允许自动审查的审批请求。 |
| 宿主机完全权限 | 当前宿主系统 | 明确确认后使用完整宿主工具；仍保留显式拒绝、文件版本检查及元数据保护。旧记录 `host-write` 对应此档。 |

前两档使用 MXC，后三档使用宿主环境。切换保留会话 ID 和历史，先撤销旧授权、停止并等待旧任务与隔离进程退出，再接入新环境。切换失败则停止执行。没有 VM 后端、后端切换配置或自动回退。

首次文件或命令调用才准备 MXC 运行资源；同一权限代次复用工具发现与目录身份，每次操作启动独立的隔离进程。`/reload` 或重新选择模式释放旧资源。恢复同机同一会话保留用户选择的模式和附加目录；新建、分叉、导入、复制或更改主目录不继承授权。本机授权记录绑定会话文件、ID、目录、机器和用户，存于 `~/.sp/agent/session-execution/`，不从对话恢复权限。

`/add-dir <directory>` 添加工作区，`/remove-dir <directory>` 移除，`/dirs` 列出。支持空格、外层引号和 Windows 大小写别名；至多 16 个不重叠的附加目录。更改目录先关闭旧执行环境，再绑定新目录的真实身份。不会从命令文本自动扩大范围，也不授予整块磁盘的文件读写权限。

## 沙箱的工作范围

当前后端要求 Windows x64、支持原生 ProcessContainer 的系统、完整 PowerShell 7 安装和固定的 `@microsoft/mxc-sdk@1.0.1`。执行器校验包版本和 SHA-256，探测必须返回原生 `base-container`；缺失、不兼容或清理无法确认时明确失败。不降级到 DACL 修改、VM、宿主或更宽权限。

**沙箱只提供 `powershell` 命令工具，使用 PowerShell 7。** 优先使用 `powershellPath`，否则从 PATH/标准位置发现；不会回退 PowerShell 5、cmd、Bash 或 WSL，关闭隐式 Windows PowerShell 模块兼容。交互 `!` / `!!` 也用 PowerShell 7，不触发宿主 Bash 扩展钩子。SDK/RPC 中明确请求 Bash 的接口在沙箱内返回不支持，不把 Bash 源码当成 PowerShell 执行。宿主模式保留 Bash、PowerShell 和完整宿主工具列表。没有新增通用 `exec_command` 工具。

文件工具、CodeMode 嵌套调用和子代理请求共用父会话授权与 MXC 执行入口。子代理不能靠更换 cwd 扩大目录授权。MCP、浏览器、LSP、自定义宿主执行和后台任务尚无 MXC 实现的入口明确拒绝。

工作区使用原路径，**不扫描或复制整个项目**；原先 20,000 项和快照总大小限制已移除。`.git` / `.sp` 元数据只读。目录和盘符的查询权限支持 Node/npm 初始化，可能看到工作区外的目录名、文件名；这些名称可见性不代表可以读取其内容或写入。链接的真实文件访问仍受操作系统授权限制，搜索不跟随链接。

| 边界 | 当前上限/行为 |
| --- | --- |
| 文本读取 | 单文件 2 MiB（字节）；单次至多 2,000 行和 32,768 UTF-16 code units 正文；返回完整文件字节的 SHA-256 snapshot |
| 图片读取 | 按签名识别 JPEG、PNG、GIF、WebP、BMP；单图 16 MiB，独立字节附件，不放进 stdout/base64 文本窗口 |
| 搜索 | `ls` 列路径，`find` / `grep` 为字面子串；200 条记录、32,768 UTF-16 code units 正文（含路径与分隔符）、20,000 遍历项；grep 单行前缀最多 256 UTF-16 code units；完整 JSON 加换行在 256 KiB 字节内；达到预算应缩小范围 |
| 文本修改 | 单次调用写入/编辑正文合计 1 MiB；覆盖和编辑需要读取或干净自提交返回的 SHA-256 snapshot；成功后返回新哈希；原子替换前后校验版本 |
| 复制/删除/移动/批量 | 不设目标数量上限；全调用预检和一次授权后逐项执行。copy/move 支持文件与目录、不同授权工作区；move 使用校验复制后删源。目录不覆盖或合并；失败可能已有部分操作完成 |
| 文件操作传输与查询 | 内部分块请求最多 4 MiB、回复最多 256 KiB（实际 JSON 字节）。`file_result` 每页最多 128 条、64 KiB；这些预算不限制原调用的目标总数 |
| 命令 | 原样传入 PowerShell 7；默认 30 秒、最多 120 秒；串行执行；stdout/stderr 各保留末尾 32 KiB |
| 生命周期 | Windows Job 管理执行器和后代进程；完成、超时、取消均等待物理清理；不能确认清理则禁止复用 |
| 网络和 UI | 默认禁网；按用户决定共享宿主剪贴板；独立 desktop，禁用输入注入；模型 provider 仍在宿主通信 |

`target`、`.venv`、`__pycache__`、`node_modules` 都是普通工作区目录：已有内容可访问，新内容留在宿主项目。`sandboxPrivateDirectories` 和“仅 VM 保留、不写回”的规则已退役，旧字段不再生效。关闭会话只清理本次运行器的临时资源，不删除工作区依赖和产物。命令失败、超时或取消不回滚已发生的修改，也不自动重跑。

### 文件结果的完整性

`copy` / `move` 接受单值 `path` + `destination` 或非空 `items: [{path, destination}]`；`delete` 接受 `path` 或非空 `paths`，两种形式互斥。copy 默认不覆盖，`overwrite: true` 只替换已有普通文件；删除非空目录须用 `recursive: true`。copy 跳过目录内链接并计数，move 预检拒绝含链接或特殊文件的源树；recursive delete 只删除链接本身。包含 `.git` / `.sp` 的目录树在预检时整体拒绝。`dryRun` 完整预检，返回总数、总字节和有界路径样本，不写变更记录；正式执行重新预检并授权。

这些工具和 `file_batch` 的新调用均返回 v3 汇总：`succeeded`、`failed`、`partial`、`unknown`、`cancelled`、`notStarted`、`coverageComplete` 和 `resultRef`。小结果附 `details.items`；大结果明确 `itemsOmitted: true`。用 `file_result({ref: resultRef, cursor?, limit?})` 查询当前会话分支的记录，按 `nextCursor` 续页。引用与 Codemode 的展示 `ref` 不同，既不读取任意宿主文件，也不签发文件读取版本。历史 v1/v2 会话保留原有读取预算。

查询页的 `coverageComplete` 表示已读完一个已结束调用的完整记录链；`pageComplete` 表示已到链尾，`callComplete` 表示调用发布了结束记录。它们不证明所有文件操作成功或目录内部覆盖完整；须同时检查各项终态、`requiresVerification` 和该项的 `coverageComplete`，以及原工具结果的汇总。

copy/delete/move 数组在明确的 `failed_no_change` 或 `partial` 后继续其余独立目标；`file_batch` 首次失败即停止。取消、撤销授权、权限代次或会话改变、日志或传输丢失以及 `state_unknown` 都停止剩余项。成功项不回滚，也不为恢复回复而重放。目录内部明细只留有界样本；覆盖不完整时须重新列目录核对。`/changes` 按页恢复全部顶层目标；沙箱中的现状核对仍由当前授权下的 MXC 观察入口执行，不回退到宿主读取。

成功返回只表示调用正常结束。`details.search` 的版本为 1，区分 `scanComplete`（当前模式的扫描自然结束）、`coverageComplete`（范围完整覆盖）、`outputTruncated`（已观察记录未全部显示）、`excerptTruncated`（显示了行首片段）。`stopReason` 为 `none`、`row-limit`、`text-limit` 或 `entry-limit`。过大、非 UTF-8、含 NUL 的候选文件分别计入 `skippedTooLarge`、`skippedNonUtf8`、`skippedNul`；目录扫描结束也可能存在这些覆盖缺口。`.git/.sp` 子项和链接的既有遍历排除独立计数，不当成覆盖异常；显式读取规则不变。I/O 错误仍返回失败。

MXC `grep` 的 `outputMode` 为 `content`（默认，每条匹配行的有界前缀）、`files`（每个匹配文件一个路径）或 `count`（`路径:匹配行数`）。一行重复出现模式仍只计一行。files 在完整文件的 UTF-8/NUL 检查后确认首个匹配即可停止匹配扫描；count 完整统计该文件后才返回数值。`observedRecords/returnedRecords` 在 content 中以匹配行为单位，在 files/count 中以匹配文件为单位。没有完整项目总量或搜索游标；200 条上限按当前模式的记录单位计算。宿主 grep 的既有语义不变。缩小范围可以处理遍历或输出早停。过大、非 UTF-8 或含 NUL 的文件需要适合其容量和编码的读取方式。

`visitedEntries` 沿用遍历计数：不计初始范围本身及受保护/链接排除项；`scannedFiles` 是 grep 实际检查资格的普通文件候选数，含容量/编码跳过项。`excludedProtected/excludedLinks` 只计实际遇到的排除项，不估计其子树。`outputUnits` 是正文预算占用，每条记录保守预留一个分隔符，不含状态前缀，也不是 JSON 字节数。

`details.read` 的版本为 1；`offset/limit` 表示本次有效请求窗口，`returnedLines` 只计完整返回的物理行。`windowComplete` 与 `hasMore` 独立：完整返回请求的 10 行后，文件仍可有更多内容。输出预算在完整行边界停下时提供 `nextOffset`。只有 LF 或 CRLF 终止符未容纳时，已完整显示的行可以从下一行续读；切在行中时设置 `lineTruncated/incompleteLine`，不提供会跳过未显示后缀的续读位置。现有行号参数不能恢复这种长行后缀。Unicode 裁剪不切坏 surrogate pair。图片保留独立分支，不带文本行字段。

覆盖缺口、扫描早停、输出省略及行内裁剪也会在正文前部提示；完整的小结果保持简洁。CodeMode 的 ref 和模型输出预算仍独立生效，不能用其 `resultComplete` 推断整个工作区已被搜索。

原生文件覆盖/编辑使用内容 snapshot；直接命令遵循程序自身写入行为。PowerShell 启动只为本进程设置脚本执行策略和固定 UTF-8 输出初始化，不修改系统策略，不分析或改写用户命令主体。正文通过受控、沙箱内只读的临时脚本文件传入，避免 Windows 命令行长度限制；PowerShell 从该文件创建并执行 ScriptBlock，保留显式退出码。正常退出的命令保留真实退出码，即使非零也不抛成工具异常，编译或测试的非零仍表示未通过。启动、超时、协议或清理失败保留为执行错误。

### 路径、网络与工具安装

相对路径以主工作区为基准，绝对路径可访问主工作区或 `/add-dir` 目录。PowerShell 的 `$PWD` 和文件工具看到同一份文件；`cwd` 只接受授权工作区内的实际目录。文件工具拒绝越界参数。**不预检 shell 的文件路径，不改写命令，不按命令白名单隔离正常指令**；操作系统执行后返回真实结果。现有网络询问及基于实际失败输出的诊断仍保留：能确认未授权路径导致失败时提示 `/add-dir` 并暂停，不能确认时保留原始错误。

全局 `~/.sp/agent/config/settings.json` 的 `sandboxNetwork` 为 `"disabled"`（默认）或 `"enabled"`，项目配置不能启用。修改后 `/reload`。禁网时，交互界面遇到现有识别范围内的联网命令会询问是否允许本会话联网；同意只改变后续进程策略，不写全局设置，不重建项目。拒绝则本次不执行；无界面或未识别命令仍按禁网策略执行并报告实际失败。MXC 网络授权不是域名白名单，宿主防火墙、DNS 和代理仍可能影响连接。它与 `build:offline` / `--offline` 无关。

工具发现从进程及机器/用户持久 PATH 合并安装根，保持进程顺序，当前应用的 Node 安装优先，识别 `bin`、`cmd`、`Scripts` 和 WinGet 链接；只查询安装布局与目录身份，不遍历整棵安装树。安装路径不重写。工具安装只读；用户 HOME、项目根、系统根和 Cargo 凭据目录不能当成普通工具根。Java、Go、.NET 等受支持的安装根变量按授权传入，其他宿主环境和凭据不整份继承。子进程 HOME/TEMP 使用本次运行器临时目录。

需要补充或排除安装时，在全局 `sandboxToolchains` 中设置 `include` / `exclude` 绝对目录数组，之后 `/reload`。排除路径同时保护其真实身份，排除子目录会排除包含它的安装根；最多 128 个安装根。显式补充或必需安装不可用时明确失败，不能靠它扩大项目或用户目录授权。

Git/MSYS 仍有已复现兼容限制：Git Bash 初始化失败；PowerShell 间接启动 `sh.exe` 的 Git 操作也可能失败，部分仓库命令存在所有权/工作树识别问题。用户可在宿主模式初始化仓库后切回沙箱做简单工作，但这不保证完整 Git 工作流兼容，也不放开 `.git` 写入。没有替换第三方运行库、写全局 Git 配置或自动回退。

图片可用 `const r = await tools.read({path: "preview.png"}); await show(r.ref);` 展示；通过校验的附件复用普通图片缩放，处理后释放。超过 16 MiB 先缩小；编码文件上限不代表解码峰值内存上限。非视觉模型仍不能理解图片。


## 默认值与额外规则

全局 `permissionMode` 只决定新会话的 `read-only` / `sandbox-write` 默认值。明确手动选择由本机会话记录保存，不修改全局默认值。历史 `full-access` / `never-ask`、项目配置和导入的消息不能授予宿主权限。

旧交互命令 `add_workspace`、`remove_workspace` 和 `/permissions status|scope|approval|...` 已由原生入口接管并提供退役提示。旧 `executionEnvironment: "sandbox"` 搭配 `inputs/writes` 的 VM 入口已退役；SDK/非交互调用应选择 `read-only` 或 `sandbox-write` 会话权限，旧入口返回迁移提示，不静默转换授权。Windows 首次配置写入 `permissionMode: "sandbox-write"`；没有旧 executionEnvironment 的全局原生沙箱默认也用于 SDK/非交互会话，不写回已退役配置。项目设置不能选择权限，存储的宿主模式不作为新授权。已有宿主配置兼容含义不变。

只读、沙箱读写和宿主机完全权限三档内已支持的操作默认按当前模式允许；宿主机受限按上表默认询问的部分不在此列，匹配的 `allow` 规则可免去这些询问，但不越过敏感目标与外部覆盖拒绝。原 `executionPermissions.rules` 中的精确 `deny` / `ask` 继续生效，拒绝优先于询问、询问优先于允许。规则可限定工具名、精确命令和路径；相对规则路径仍以主工作区为基准，附加目录可用绝对规则路径限定，不改变已有规则含义。不猜测 shell 风险等级。`approval: "never"` 仅表示没有交互批准渠道，需要询问的调用返回 `APPROVAL_REQUIRED`。Plan 模式另行拒绝命令与变更。

宿主机两档中，`rsync --delete` 和 `find … -delete` 删除的是目标目录里的文件，不删目录本身：目标在工作区内的普通目录时，与其他工作区内删除一样不额外询问；目标是工作区根目录、包含或位于 `.git`/`.sp`，或在工作区外时询问一次（工作区根目录下的同步可能删掉 `.git`，所以仍然确认）。

MCP 工具在宿主机完全权限默认允许，在宿主机受限默认询问；远端工具声明 `annotations.destructiveHint: true` 时，即使同时声明了其他较低权限的提示，也会在执行前询问一次（与 Codex 的破坏性注解审批一致）。`readOnlyHint` 不授予任何额外权限。规则的 `tool` 除精确名称和 `*` 外，还可以写 `mcp__<server>`，或以 `*` 结尾的服务器模式，如 `mcp__github__*`、`mcp__github__get_*`（与 Claude Code 的 MCP 规则写法一致）。`<server>` 可写配置中的服务器 ID（如 `GitHub`），也可写工具名里规范化后的写法（如 `github`）；模式其余部分按规范化后的工具名匹配。服务器 ID 可含 `__`，因此按注册该工具的服务器身份判断，不从工具名推断。`allow` 模式必须指明一个服务器，`ask`/`deny` 可用 `mcp__*` 覆盖全部 MCP 工具。指明该工具或其服务器的 `allow` 规则视为用户的长期批准，可免去破坏性注解的询问；全局 `*` 不算。沙箱两档仍不提供 MCP（MCP server 运行在宿主机上，不受 MXC 边界约束）。

### 项目共享规则与“不再询问”

每个项目文件夹有一份规则文件：`~/.sp/agent/projects/<项目路径哈希>/permissions.json`，同一文件夹的所有会话共用。文件放在用户目录下，克隆来的仓库不能自带授权。`/permissions rules` 显示文件位置和当前规则；可以直接编辑，保存后下一次授权生效。删除文件即清空规则。

```json
{ "version": 1, "rules": [
  { "tool": "bash", "decision": "allow", "command": "npm test *" },
  { "tool": "bash", "decision": "deny", "command": "git push *" },
  { "tool": "mcp__docs__search", "decision": "allow" }
] }
```

- `command` 只用于 `bash` 和 `powershell`，按词匹配：单独的 `*` 匹配任意多个词（`npm test *` 也匹配 `npm test`），词内的 `*` 匹配任意字符（`npm run test*`）。PowerShell 规则不区分大小写（逐个字符折叠，非 ASCII 字母也一样）。不写 `command` 时匹配整个工具，与命令能否解析无关；其他工具只能按精确名称写，`file_batch` 中的每项操作也按各自的工具名匹配。`read` 的 `deny`/`ask` 也约束 `/changes` 的“核对当前状态”（它没有对话框，两者都会阻止）。
- 复合命令逐段匹配，`deny`/`ask` 会跳过段首的控制结构关键字（如 `then git push`），PowerShell 脚本块里的命令（`try { git push } catch { … }`，大括号紧贴单词也算）逐条匹配，Bash 的 `command`、`sudo`、`env`、`timeout`、`time`、`xargs` 等分派前缀之后的命令、PowerShell 赋值右侧的命令（`$null = git push`）也参与匹配，`git.exe`、`npm.cmd` 和 `/usr/bin/git` 按去掉目录和启动器后缀的名称匹配，`find -exec`/`-execdir` 执行的命令和 `bash -c '…'`、`pwsh -Command …`、`cmd /c …` 的脚本和 PowerShell `@(…)` 的内容（按调用工具的规则）也参与匹配，Bash `case` 的分支模式（`git)`）、PowerShell 哈希表的键（`@{ npm = "10" }`，带引号的键 `'k'=git push` 的值照常匹配）、`switch` 的分支标签和放在命令位置的字符串（`$label = 'npm'`、here-string `@'…'@`，`& 'npm'` 才是调用）不算命令；程序自己的全局选项不归一化（`git -C repo push` 不匹配 `git push *`，可写 `git * push *`），heredoc 正文按数据跳过，正文之后的命令照常匹配；无法确定 heredoc 结束位置时询问。任一段命中 `deny` 即拒绝，命中 `ask` 即询问；拒绝优先于询问，询问优先于允许。`deny`/`ask` 在所有档位生效，与 `executionPermissions.rules` 一起排序。
- `allow` 只免去宿主机受限的“其他命令”和 MCP 工具询问。要被允许，一段命令须为顶层的字面量简单命令（不含变量、命令替换或后台运行）。允许的命令之后再出现文件命令或文件重定向仍会询问，因为前面的命令可能已经改了文件。含 heredoc 的 Bash 命令不受 `allow` 影响，也不提供“不再询问”。工作区外路径、无法确认的变更目标、写入已有目录、敏感目标拒绝和外部覆盖拒绝都不受 `allow` 影响。
- 文件解析失败时继续使用上一版规则并提示一次，不会放宽；此时“不再询问”也不写入。保存时先按读取时的限制校验整个文件，多个会话用锁文件依次保存，手动编辑若恰好发生在读取与替换之间，会重新合并。

宿主机受限档的审批对话框在可以靠规则免去询问时，多一个“允许，并在本项目不再询问”，并列出将保存的规则：每个需要审批的程序存一条前缀规则（`npm test --grep x` 存为 `npm test *`，`ls -la` 存为 `ls *`，单独的 `make` 原样保存），一条命令最多 5 条；MCP 工具保存该工具名。工作区外路径、显式 `ask` 规则等靠保存规则也免不了的询问，不提供这一项。

**Auto 审查**（`/permissions` 第 4 档）：什么操作需要审批与宿主机受限完全一致，只是由当前会话模型代替用户回答（参照 Codex 的 auto_review）。

- 审查模型看到精简的对话记录和完整请求（参照 Claude Code 的 auto mode）：用户消息，以及助手调用的工具名和参数（参数截断到 800 字符）。助手自己的文字、推理内容、工具输出和扩展记录都不给审查模型，避免助手或外部内容替自己说情。最多 16 条、约 12000 字符；请求即审批对话框里的同一份详情。
- 回答须以 `APPROVE:` 或 `DENY:` 开头。`DENY` 时操作不执行，模型收到 `[AUTO_REVIEW_DENIED]` 及原因。审查没有得出结论（无法解析、请求失败或 60 秒超时）时不算拒绝，也不计入熔断：改为照常询问用户；没有界面时返回 `[APPROVAL_REQUIRED]`，并说明这不代表操作不安全（参照 Codex 把超时与拒绝分开报告）。用户取消本轮不算拒绝。
- 显式 `ask` 规则（全局或项目规则）、工作区外的删除和移动、`approval: "never"` 不交给审查，仍按宿主机受限处理；敏感目标拒绝和外部覆盖拒绝照旧在审查之前生效。
- 连续 3 次拒绝，或最近 50 次审查中拒绝 10 次，即熔断：之后的审批改为询问用户，状态栏显示“Auto 已暂停”。用户在询问中允许一次操作（含“允许，并在本项目不再询问”）后，计数清零，恢复 Auto 审查（参照 Claude Code）。重新选择 `/permissions` 同样会重置。
- `/permissions auto` 列出最近 10 次 Auto 拒绝（参照 Codex 的 `/approve`）。用户选中一条后，模型下次以完全相同的形式（全部参数相同）发起这次调用时会再审查一次，并告诉审查模型用户已允许重试；只生效一次，本身不等于批准。
- 批准只对这一次调用有效，不写入项目规则，也不在会话内复用。每次审查调用一次当前模型，会产生费用；批准和拒绝都以通知显示给用户。

一次授权绑定原工具、原参数、当前会话和权限代次；切换后不能复用。用户拒绝保留在当前会话历史，写回时使用稳定的候选内容和版本作为拒绝身份，不因重新生成原生 revision ID 而再次获准。

搜索路径默认是工作区根目录。子目录的 `deny` / `ask` 同样约束覆盖该目录的搜索；限定子目录的 `allow` 不扩大为整个工作区授权。路径规则和目标均解析实际目录身份，目录别名不能绕过规则。宿主模式的 `lsp_fix(write: true)` 属于变更，授权绑定 `root` 与 `path` 对应的文件，并受 Plan、受保护路径和权限撤销约束；预览不取得写入授权。

宿主读取和搜索使用工具自身的路径规范化规则，授权后执行绑定已核准的实际路径，`@`、`~` 或文件名兼容拼写不能指向另一授权对象。原生写入/编辑按各自的路径规则检查，包括批次内每一项。沙箱搜索支持 `src`、`./src` 和 `src/example.txt`，目录范围不误匹配 `src-other`。

宿主模式为子代理、结构化只读命令及浏览器执行签发当前调用的凭证；子代理逐项绑定工作区身份和读写能力，结构化命令绑定 cwd、参数及精确外部根。路径规则先于凭证签发生效，权限切换撤销未完成调用。Plan 中子代理降为只读，浏览器代码执行被拒绝。子代理通过父进程转交已授权的 MXC 工具调用；其他没有隔离后端的扩展在前两档明确返回不支持。

宿主模式仍属于受信任执行。扩展初始化、provider 与应用自己的会话持久化运行在宿主；沙箱隔离的是已接入的文件/命令工具执行，不把整个插件进程宣称为 MXC 内运行。

## “离线”与启动的关系

`superpi` 是日常启动命令。已有构建可直接运行，不需要另选“离线版”或“沙箱版”。`npm run build:offline` 只是维护者的构建命令，使用本地模型目录数据；`superpi --offline` 仅跳过启动时的更新、目录刷新等网络操作。它们都不选择权限模式，也不会把远程模型变成本地模型。

实现、实机验收与性能证据见[总进度记录](Super%20Pi%20权限简化与原生能力整合方案.md)和[性能检查](performance/native-sandbox-closeout-2026-11-03.md)。旧失败、停止与旧任务协议的记录保留为历史证据；当前交互行为以本页为准。
