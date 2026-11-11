# Super Pi MXC 文件工具与搜索改进执行方案

版本：1.2
日期：2026-11-11（JST）
状态：本方案的 P0–P3 候选已实现并完成本地验证。原生 MXC 两档、图片与子代理验收已经实际运行，最终定向矩阵 147/147 通过、零跳过。P0/P1 已通过当前提交的 Codex 审查和六个 CI 分片，P2/P3 按顺序交付。实际数字与复跑命令见 [证据记录](evidence/mxc-file-tools-2026-11-11.md)。

本文保留实施时的目标、门禁和参考锚点。当前操作说明见[执行环境](execution-environments.md)和[测试](testing.md)。

## 1. 目标和执行范围

在现有 **MXC ProcessContainer + PowerShell 7** 架构上，修复文件读取、搜索结果容易被误解为完整结果的问题，并借鉴 dsh-ops 的按需输出设计，为 MXC `grep` 增加文件名和匹配行计数两种输出。

默认执行 **P0 → P1 → P2 → P3**。每个阶段边实现边验证，形成可独立审查的改动；P1 的契约验证通过后再实施 P2。阶段内自主推进，无需逐项等待用户确认。长行游标、批量读取、索引和运行时替换不属于这轮范围。

实施完成后，模型应能准确区分：

1. 工具调用正常结束，但只检查了部分搜索范围。
2. 搜索已经得到结果，但返回条数或正文受预算限制。
3. 某条搜索记录显示的是截短片段。
4. 已完整返回用户请求的读取窗口，但文件后面仍有内容。
5. 只需要文件名或计数时，可以直接请求对应结果。

## 2. 审查基线与既定架构

| 仓库 | 本方案核对的提交 | 用途 |
| --- | --- | --- |
| Super Pi | `b9843f859441d9aa00a88c694cbd8f8a13f5ea56` | 实现与验收基线 |
| dsh-ops | `156ba1eedc187bf4905a1beb828304e211c5d751` | 参考结果契约、输出投影和基准方法 |

这些提交是审查锚点，不要求执行者回退到这些版本。实施时先检查当前 HEAD；已经修好的项目记录证据后跳过，其他项目按实际调用链调整落点。

当前事实如下：

- `read-only` 和 `sandbox-write` 使用 MXC；三个 `host-*` 权限模式使用宿主工具。
- 旧 Windows Sandbox VM 后端已通过 PR #275 退役；历史验收材料仍保留。
- MXC 直接访问授权的原工作区，不做旧 VM 的整树复制和候选写回。
- MXC 命令入口为 PowerShell 7。Bash/MSYS/Git 子进程兼容性是既定限制，本方案不以修复微软上游问题为前置。
- `mxc-file-worker.mjs` 是当前生产文件工具，不是旧 VM 遗留 worker。
- MXC 已有 SHA-256 snapshot 校验与原子文件替换；宿主工具也已有独立文件服务和读取能力。本轮不重复开发这些设施。

依据：[当前执行环境][s01]、[会话分流][s02]、[MXC 后端][s03]、[迁移 PR][s04]、[迁移验收记录][s05]。

### 2.1 2026-11-11 再审：现状与借鉴取舍

两仓库 main 的树查询仍分别返回上表提交，与 1.0 方案完全一致。本次没有发现新的上游代码差异，不把同一源码重复审查描述为新增功能。后续执行时仍须检查届时 HEAD 和本地修改。

| 能力/问题 | Super Pi 当前事实 | dsh-ops 可借鉴部分 | 本轮决定 |
| --- | --- | --- | --- |
| 执行后端 | 已迁移唯一 MXC；PS7；两档沙箱与三档宿主 | 宿主插件的 shell 适配与可选 Niubash 不对应 MXC 生产边界 | 已实现，移出待开发项；不更换运行时 |
| 文件修改正确性 | 已有完整字节 SHA-256 snapshot 和原子替换 | revision、短回执、effectState 的表达方式 | 复用现有实现；本轮不改修改协议 |
| 搜索完整性 | 过大/非 UTF-8/NUL 文件静默跳过；只返回正文 | observed/total、覆盖缺口与显示完整性分开 | P1，优先修复 |
| 读取完整性 | 行窗口和 32,768 code units 截断缺少状态 | 窗口完整、文件剩余、行内裁剪分开 | P1，优先修复 |
| grep 输出 | 仅有命中片段；MXC schema 没有 outputMode | content、files_with_matches、count 按需投影 | P2，采用本项目 content/files/count 命名 |
| 长行续读 | 当前行号接口不能无遗漏恢复被切掉的后缀 | 不跳过未显示后缀；稳定观察与过期校验 | P1 暴露限制；游标列后续，不搬整套分页 |
| 多文件读取 | 可用 CodeMode 编排，MXC owner 顺序执行 | 多窗口共用批次预算、逐项错误与续读 | 后续候选，先量化现有往返成本 |
| 结果引用/恢复 | 已有 CodeMode ref、Evidence Ledger、恢复能力 | 有界保留、失效与模型展示的清晰契约 | 不新建第二套结果库或 ledger |
| 重复读取去重 | 不能仅凭文件没变就推断模型已见正文 | 以实际模型请求中的精确正文作为证据，失效即退回完整输出 | 仅研究候选，先审现有 read evidence/投影链 |
| 工具发现 | 已有按需目录与激活 | 渐进披露的可测量 schema 成本 | 不重复开发；有实际 schema/调用数据再排期 |
| 性能比较 | 已有扫描、分配及生命周期基准 | 同机同语料、交替版本、先判正确性再比较成本 | P3 复用基准，不照搬 benchmark 平台 |
| 索引、定义提取、文档解析 | 与本轮最小只读修复无直接依赖 | 可选能力，不是正确性前置 | 暂不排入执行范围 |

dsh 的字段名不能逐字映射成本项目相同语义。例如 dsh 的 scanComplete 合并了若干覆盖条件；本文保留 scanComplete 与 coverageComplete 的独立定义。dsh 的分页会重扫有界查询，不等于保存快照或从中断处续扫；输出模式、续读参数和精确总数也有额外成本，不能据功能多推定性能更好。[搜索覆盖说明][d04]、[上下文读取去重][d05]、[多文件读取契约][d06]

### 2.2 已复现问题及证据边界

在 Windows、Node v26.13.0 上导出固定提交的原始 mxc-file-worker.mjs 与其生产 image-signature 依赖，直接启动 worker，三项夹具均正常退出且 ok=true：

| 夹具 | 实际返回 | 问题 |
| --- | --- | --- |
| 2 MiB + 6 B 文件，唯一 NEEDLE 在容量边界之后 | 正文只有 (no matches)，无覆盖字段 | 把未检查内容隐藏为无条件零命中 |
| 一条 40,003 字符长行，请求 offset=1、limit=1 | 正文仅前 32,768 code units，另带 snapshot，无 read 完整性状态 | 无法判断请求窗口被切在行中 |
| 400 个 a 后跟 NEEDLE 的命中行 | 路径/行号加 256 个 a，无命中内容或片段标记 | 行首前缀被误当成匹配上下文 |

这只是**未修改生产 worker 的宿主进程复现**，不是 MXC 隔离、AgentSession、CodeMode 或 provider 的端到端通过。此次没有修改生产代码，没有重新测量性能或付费模型 usage。P1/P3 仍必须按第 7 节完成真实链路验证。

### 2.3 文档状态与清理范围

- 当前产品行为以 docs/execution-environments.md、正式 launcher 和源码为准。
- 已完成方案按“已交付历史”标记，退役 VM 设计按“已退役历史”标记；保留原章节和锚点，避免破坏证据引用。
- 混合了完成项与待验证项的旧计划不能整份判为已完成；尤其 CodeMode R1–R5、OpenCode OC 后续、上游历史 V/F、PF 外部验收项须单独核对。
- P0 已更新根中英文 README、coding-agent README、testing、导航与文档状态清单。原工作区的候选保留，交付在隔离工作树进行。
- 个人文档中的旧权限/VM 草案转为历史归档；完全相同的重复方案只保留当前主文件。不同历史版本不按“重复”删除。

### 2.4 必须保留的边界

- 保留 MXC、PowerShell 7、原有权限档位、授权工作区和顺序执行机制。
- 保留当前文件、遍历、输出、协议和命令时限；不能通过调大上限掩盖不完整结果。
- 本轮改变 MXC 文件工具及必要的文档、测试和测量，并清理已退役 VM 的脚本与专用验收夹具；不改变宿主 `read/grep` 的正则、ignore、分页等既有语义。
- 保留 `snapshot`、图片读取、写入、编辑、删除、移动及批次错误语义。
- 保留现有网络同意、路径授权、取消和资源释放行为。
- 不引入 Bash/Niubash、另一套 worker 运行时、后台索引、全局结果框架或自动宿主回退。

## 3. 实施前检查

1. 阅读执行环境中的全局 AGENTS 规则、仓库 `AGENTS.md`，以及待修改目录下适用的规则。记录实际 HEAD 和工作区状态，保留用户已有改动。
2. 阅读 `docs/performance/hot-path-allocation-contract.md`。本轮会修改大结果处理和搜索扫描，属于需要审计的热路径。
3. 核对生产链：`AgentSession → WorkspaceSandboxTools → WorkspaceSandboxBackend → MXC worker → 工具结果 → CodeMode/提供者投影`。
4. 在当前源码上重现“超过 2 MiB 的文件被搜索跳过”和“单行超过输出预算时未明确说明裁剪”两个行为。若已修复，验证修复是否已到模型可见结果，不重复实现。
5. 为这项任务创建唯一的 `.task-tmp/<task-id>-<unique-id>/`。探针、语料、原始日志和测量产物放在该目录；测试子进程的 `TMP/TEMP/TMPDIR` 指向本任务目录。
6. 使用当前有效工作分支或隔离工作树。方案默认产出本地可审查改动；提交、推送、PR 和合并按用户届时的明确指令处理。

不要依赖旧文档里的 VM 验收命令。当前仓库规则要求真实调用链、分配计数和资源释放证据，不能只检查新增 diff。[仓库规则][s06]、[热路径契约][s07]

## 4. P0 同步当前架构文档

P0 已通过 [PR #283](https://github.com/dragonbaba/super-pi/pull/283) 提交、审查和 CI。下文保留实施范围和验收要求。

### 4.1 修改内容

检查并修正以下入口中的过时现状说明：

| 文件 | 本轮应表达的内容 |
| --- | --- |
| `README.md`、`README.zh-CN.md` | MXC 后端、五档权限、PS7 命令入口、直接访问原工作区 |
| `packages/coding-agent/README.md` | 当前权限模式与执行环境；明确宿主 shell 选择规则和 MXC 规则各自适用范围 |
| `docs/execution-environments.md` | 作为当前行为主文档，补入新的完整性与输出模式说明 |
| `docs/testing.md` | 当前 MXC 实机入口及环境变量，移除或清楚标记过时的当前验收指令 |
| `docs/documentation-status.md`、`docs/README.md` | 区分当前文档、已交付历史、退役 VM 材料和待核对事项；保留章节锚点 |
| MXC 工具 description | 正确描述字面搜索、读取范围、输出上限的真实单位及完整性字段 |

历史证据文档保留其历史事实。旧 VM 的启动脚本、专用测试和夹具共 175 个文件已按用户本轮授权清理；先核实消费者，再移除旧测试发现分流与旧输出 benchmark lane。旧源码固定在 `b9843f859`，历史设计和修复记录标注退役并链接[归档位置](documentation-status.md#windows-sandbox-vm-retirement)。

尤其注意：

- 当前 `docs/testing.md` 中仍有旧 VM 验收段落；当前真实入口是 `tests/mxc-workspace-live.test.ts`。
- 宿主 PowerShell 的回退描述不能改写成 MXC 也有回退。
- `sandbox` 目录、权限名、错误码和 Windows Job 对象名称并不表示旧 VM 仍在运行。

依据：[历史夹具声明][s08]、[构建资产清理][s09]、[当前测试说明][s10]、[当前 MXC live 测试][s11]。

### 4.2 验收

新用户从 README 进入执行环境文档，可以准确判断各权限模式使用的后端、命令工具和限制。文档中的当前命令指向存在的文件；历史说明与当前操作指令分开。

## 5. P1 完整性契约和模型可见反馈

### 5.1 最小生产落点

| 文件 | 修改责任 |
| --- | --- |
| `packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs` | 产生有界的读取、搜索事实；计数跳过与裁剪；保留当前 I/O 和修改语义 |
| `packages/coding-agent/src/core/sandbox/workspace-backend.ts` | 扩展 `WorkspaceReply`，验证新增字段的类型、枚举和数值边界 |
| `packages/coding-agent/src/core/sandbox/workspace-tools.ts` | 保留关键事实到 `details.read/details.search`，并放入模型可见文本；更新工具描述 |

尽量保持这三个生产落点，不为本任务引入全局协议框架。若确有必要抽出运行时模块，同时更新打包资源并以 dist 验收，不能出现源码可用、构建产物漏文件。

当前工具封装不会自动透传任意 worker 字段。只改 worker 而没有贯通 `WorkspaceReply → details/content` 不算完成。[worker][s12]、[工具封装][s13]

### 5.2 搜索契约

建议使用有版本的 `details.search`。字段命名可以结合仓库风格收敛，但必须保留下列相互独立的语义：

| 语义 | 建议表达 | 判定要求 |
| --- | --- | --- |
| 当前输出模式所需的扫描是否自然完成 | `scanComplete` | 因遍历、行数或输出预算提前结束时，不得宣称完整扫描 |
| 请求范围内是否存在已知内容覆盖缺口 | `coverageComplete` | 被容量或编码限制跳过的候选文件必须反映为缺口 |
| 已发现记录是否因输出预算未展示 | `outputTruncated` | 只表示已观察到的记录被省略；与未知覆盖缺口、单条片段裁剪区分 |
| 单条命中行是否只显示片段 | `excerptTruncated` 或等价字段 | 256 字符片段不等于整行 |
| 停止原因 | 固定枚举/固定字段 | 至少区分结果条数、输出字符、遍历项限制 |
| 已观察数量 | 固定整数计数 | 说明单位；只计实际扫描或观察到的对象 |
| 跳过原因 | 有界的原因计数 | 至少区分过大、非 UTF-8、含 NUL |
| 已有策略排除 | 独立说明或计数 | 与容量/编码造成的漏检分开 |

具体规则：

1. `ok: true` 仍表示调用正常返回，不等于扫描完整或覆盖完整。
2. 目录遍历结束，但跳过一个过大文件时，可以是 `scanComplete=true`、`coverageComplete=false`、`outputTruncated=false`。
3. 扫描未完成时，只报告已观察值或下界；未知的总量不得填 0，也不得使用 “total” 冒充完整总数。本轮不要求提供全局精确总量。
4. `.git/.sp` 子项及链接的既有遍历排除属于明确策略，不应导致每个普通 Git 仓库都被标为异常不完整。只记录实际遇到的排除，不改变规则。
5. 显式读取受保护元数据的已有能力保持不变；不能把“遍历时排除某些子项”扩成“所有这些路径均不可读取”。
6. `read/lstat/readdir` 失败仍沿当前错误路径返回失败；不借增加 coverage 的机会吞掉 I/O 异常并包装成成功。
7. 未完整覆盖的零命中结果，必须明确表达“已扫描部分未发现匹配；仍有未检查内容”，不能只输出裸 `(no matches)`。
8. 超长命中行必须标注片段裁剪。命中位于原行第 256 字符之后时，不能把当前显示的前缀描述为完整匹配上下文。保留可定位的路径与行号。
9. `find/ls` 共用搜索实现时，保留其现有参数和语义；修改共享逻辑后，验证范围、条数和截断行为。
10. 仅因遍历或执行预算停止、尚未观察到下一条匹配时，应说明扫描未完成；不能因此设置 `outputTruncated=true`，也不能宣称已知遗漏了多少匹配。若执行超时按现有路径整体失败，继续保留失败语义。

新增字段缺失不能默认成“完整”。backend 对新增字段校验操作类型、布尔值、固定枚举及非负安全整数；不需要引入跨版本协商，但不得把未校验的任意对象直接当成完整性证明。

dsh-ops 的参考价值是将覆盖状态、分页/输出状态、观察值和完整总量分开；不需要复制它的 Rust 协议框架。[dsh 搜索契约][d01]、[dsh 工具 schema][d02]

### 5.3 读取契约

在 `details.read` 中表达“本次请求窗口”和“文件剩余内容”，不要只有一个含义不清的 `complete`。

至少可以判断：

- 本次 `offset/limit` 请求的窗口是否完整返回。
- 文件后面是否仍有内容。
- 返回结果是否切在一行中间，以及是哪一行。
- 是否存在能安全使用的下一行 `nextOffset`。

实施要求：

1. 保留现有 `path/offset/limit` 输入。有效 offset 范围沿用原 schema，超出 EOF 的巨大 offset 返回空窗口及 snapshot；直接调用的窗口归一化保持原语义。不在 P1 增加游标系统。
2. 请求 10 行且完整返回这 10 行时，即使文件后面还有内容，本次窗口也可以是完整的。
3. 在完整行边界结束时，可以提供有效的下一行位置。正文完整、仅 LF 或 CRLF 终止符未容纳时，计为完整物理行，从下一行续读；真正丢失行正文后缀时继续禁止跨过该后缀。
4. 在一行中间达到字符预算时，必须说明该行未完整返回；**不得给出会跳掉未显示后缀的下一行续读建议**。
5. 第一轮不承诺用现有行号参数恢复超长行的全部后缀。正确结果是明确暴露限制，而不是伪造可续读位置。
6. `snapshot` 仍是完整文件字节的 SHA-256，保留后续 write/edit 的校验语义；显示窗口不完整不改变它的含义。
7. 图片走原有图片分支，不套用文本行覆盖字段。
8. 截断边界避免制造半个 Unicode surrogate pair；不能将中文、emoji 或 JSON 转义造成的长度变化误算为字节容量。

### 5.4 预算与热路径

以下容量在本轮保持：

| 边界 | 当前限制 | 单位与注意点 |
| --- | --- | --- |
| 文本文件读取/搜索候选容量 | 2 MiB | 文件字节数 |
| 文本 read 请求行数 | 最多 2,000 行 | 行数，不是字符数 |
| 搜索输出记录数 | 最多 200 条 | P2 各模式的记录单位见下一节 |
| 搜索遍历项 | 最多 20,000 项 | 按现有遍历计数规则 |
| 文本正文预算 | 32,768 | UTF-16 code units，不能称为 32 KiB 字节 |
| 搜索单行片段 | 当前最多 256 | 同样需要正确说明片段含义 |
| 文件 worker 接收协议 | 256 KiB | 完整 JSON 响应及换行的字节预算 |

完整性摘要和新增元数据必须有固定上界，并计入最终协议预算；必要时给正文预留空间，不提高总上限。不得同时在 wire 中保留完整文本正文和相同内容的完整逐行 JSON 副本。

遵守已有扫描热路径规则：不逐行创建临时对象、数组、Promise 或闭包，不对大文本做整文件 `split`，不为了统计完整性重复扫描或复制整个结果。每调用一次的有界元数据与每行分配必须分开评估；不引入对象池。

代码约束补充（本轮审查落实）：容量及单位由无副作用的 `mxc-file-limits.mjs` 统一导出，worker、backend 校验、工具 schema 和基准共用；构建必须携带运行时模块。扫描助手使用模块级函数，不在循环中创建回调、绑定函数或 Promise 链。AST 同时检查嵌套函数声明、正则字面量、RegExp 构造与绑定/Promise 回调。字面搜索使用原有 indexOf，正则与固定容量常量保持模块级。回包键校验使用索引循环，每次受 256 KiB 协议上限约束的回包产生一份键数组。沿结果投影到终端帧的调用链检查渲染回归，保持正常帧零新增闭包、Promise、AbortController、包装对象和完整帧副本，保留 active/pending 有界及结束后引用释放证据。

若调整扫描函数签名，要同步让 benchmark 测量真正使用的新生产函数，保留其结构和生命周期约束。[搜索分配基准][s14]

长行的 ` […]` 标记占用既有 256 code-unit 单条片段预算，解释只在摘要出现一次；150 条长行夹具保留原来 121 条记录的输出容量。扫描/条数早停提示缩小范围；容量或编码跳过提示针对已知路径选择适合的读取方式。

### 5.5 模型必须能看到

- `details.read/details.search` 用于结构化消费。
- 搜索不完整、正文裁剪或单行裁剪的关键信息也必须进入 `content`。可用短前缀，避免被后续尾部裁剪首先丢掉。
- 完整的小结果保留简洁输出，不为每次成功调用附加大段协议说明。
- 保留既有 CodeMode 引用、显示和输出裁剪机制，不改造全局结果存储。
- 不复用 CodeMode 的 `resultComplete` 表示“仓库已经搜索完整”；它有现有的输出/恢复语义。

验收必须覆盖：

1. 直接调用返回的 `content` 和 `details`。
2. CodeMode 的 `show(result.ref)`。
3. CodeMode 只输出 `result.content` 或正文文本。
4. 提供者实际收到的下一轮消息/请求投影。

极小 CodeMode 预算下，允许“完整性提示完整保留”，或“整个结果被明确标为裁剪并给出现有恢复提示”；不允许部分正文被呈现为完整结果。复用已有 sandbox owner 与 CodeMode 集成夹具，不能用宿主 read 的测试代替 MXC 路径。[sandbox 集成测试][s15]、[CodeMode 会话测试][s16]

## 6. P2 grep 按需输出

在 P1 验收通过后，为 MXC `grep` 增加可选输出参数，建议命名 `outputMode`，支持 `content | files | count`。

这是 Super Pi 的接口设计。dsh 的真实枚举包括 `content/files_with_matches/count/summary/definitions`，不存在名为 `preview` 的对应模式。本轮只借鉴需要的三种投影。[dsh 工具 schema][d02]

| 模式 | 返回内容 | 必须保持的语义 |
| --- | --- | --- |
| `content` | 当前有界命中片段 | 默认值，旧调用不传参数时行为兼容；一条记录对应一条匹配行 |
| `files` | 匹配文件路径 | 每个文件最多一条；完成原有文件资格检查后，确认首个匹配即可停止匹配扫描 |
| `count` | 每文件匹配行数 | 一行出现多次模式仍只计一行；不是子串出现次数 |

### 6.1 明确的设计决定

- 保留字面子串匹配，不在此轮增加正则、glob、忽略规则、排序、定义提取或多行模式。
- `files` 先完成原有受控读取和整文件 UTF-8/NUL 资格检查，再在首个匹配后停止匹配扫描。不得提前终止 I/O 或跳过后缀校验；由首个匹配也不能推导完整匹配行数。
- `count` 从实际扫描计算，不能从截短预览、已输出条数或路径去重结果推算。
- 确定的每文件 count 必须来自该文件需要的完整统计；遇到中断时不输出伪装成完整数值的 count。
- `content` 的 200 条是匹配行记录；`files/count` 的 200 条是文件记录。所有模式仍受遍历、字符、文件和执行时间边界约束。
- 达到预算时保留 P1 的完整性事实。不要为得到全项目精确总数默认执行额外全扫。
- 不新增持久缓存、索引、跨调用结果全集或搜索游标。
- 未知 `outputMode` 要明确拒绝，不能静默转成另一模式。
- 参数只加入实际支持它的 MXC `grep` schema；不宣称宿主路径已经获得相同能力。
- 保留一份正文及少量元数据，不为每个模式复制同一份大结果。

### 6.2 验收

对同一固定语料：

- 在相同范围、相同文件资格规则且三种模式均完成扫描的配对中，`content`、`files`、`count` 的匹配文件集合一致。
- 达到不同模式的记录预算时，三种返回集合可以不同。例如 content 被单文件的 200 条匹配占满，files/count 仍能继续访问其他文件。此时分别对独立预期值验证已观察结果和完整性，不强求部分集合相同。
- `files` 中没有重复路径。
- `count` 与夹具独立计算的匹配行数一致。
- 一行内重复模式、同一文件多行命中、文件名含中文/空格时语义仍正确。
- 文件前缀命中但后缀含非法 UTF-8 或 NUL 时，三种模式都遵守原有整文件资格检查，不能让 files 提前返回该文件。
- 单个文件超过 200 条匹配时，`files` 可以只返回该文件；`count` 不受“content 已输出 200 行”这种实现细节误限。
- 跨模式比较的是答案和集合，不要求三种不同投影的文本哈希相等。

## 7. P3 验收矩阵和测量

测试应随 P1/P2 一起实现，P3 负责最终汇总与真实 Windows 闭环。

### 7.1 语义与预算矩阵

| 编号 | 输入/场景 | 核心断言 |
| --- | --- | --- |
| T01 | 普通命中、完整零命中 | 正确正文；完整性字段与事实一致 |
| T02 | 唯一命中在超过 2 MiB 的文件中 | 未完整覆盖；有过大文件原因；不能给出无条件“全范围无匹配” |
| T03 | 同时有可读命中和过大/非 UTF-8/NUL 文件 | 保留已找到结果；分类计数准确；不把已知缺口当完整 |
| T04 | 200 与 201 条结果边界 | 不混淆实际完成与因预算早停；不伪造完整总数 |
| T05 | 遍历项、字符预算达到边界 | 停止原因准确；未遍历总量保持未知；未观察到被省略匹配时不声称输出截断 |
| T06 | 超长中文路径、引号/反斜杠/控制字符、emoji | 完整 JSON 加换行不超过 256 KiB；字段可解析 |
| T07 | 超长命中行，匹配在第 256 字符之后 | 路径/行号正确；明确片段裁剪；不宣称显示了完整上下文 |
| T08 | 空文件、offset 越 EOF、最后一行无换行 | 不伪造内容或续读位置；snapshot 保持 |
| T09 | 指定 offset/limit、LF/CRLF | 区分请求窗口完整与文件已结束 |
| T10 | read 恰好达到预算与超过预算、单行切半 | 截断事实准确；不生成会跳过后缀的 nextOffset；不切坏 surrogate pair |
| T11 | 一个文件多命中，一行重复模式；前缀命中但后缀编码不合法 | files 去重；count 按匹配行数；三个模式的整文件资格检查一致 |
| T12 | files/count 受全局预算限制 | 已观察结果正确，完整性如实；不把部分计数当项目总量 |
| T13 | 已有策略排除、显式受保护路径读取、越界输入 | 保留现有访问与排除语义；不扩大读写权限 |
| T14 | 文件消失/变化、权限或 I/O 异常 | 继续返回既有错误；不吞错为完整成功 |
| T15 | 直接工具、CodeMode 引用/正文、提供者投影 | 完整性信息贯通；极小预算裁剪有明确提示 |
| T16 | 图片、旧 snapshot、写保护、共享 find/ls | 已有行为不回归，新增字段不改变修改语义 |
| T17 | 正常结束、失败、取消与 close | 继续释放 pending/rows、worker、句柄和临时目录 |
| T18 | backend 解析合法/缺字段/错类型/越界元数据，原始 worker 收到未知 outputMode | 未知不默认完整；非法字段被拒绝；不改变 worker 失败路径；未知输出模式明确失败 |

对 20,000 遍历项等边界，可用现有可控文件系统夹具验证计数分支，不必为每个组合在磁盘上重复创建两万文件。新增测试验证外部语义，不仅断言某行源码存在。

### 7.2 使用现有测试设施

优先扩展或复用：

- `tests/mxc-file-worker.test.ts` 与 `tests/helpers/mxc-file-fixture.ts`：实际 worker 逻辑与协议预算。
- `tests/sandbox-image-read.test.ts` 的 sandbox owner → CodeMode 接线：新增文本/搜索契约集成测试可另放聚焦文件。
- `tests/codemode-session.test.ts` 中的下一轮消息及提供者请求捕获方式：断言模型实际看到的内容。
- `tests/source-invariants.test.ts` 的搜索热路径约束。
- `scripts/bench/mxc-search.ts`：生产搜索与 readWindow 的确定性计数、分配及释放证据。
- `scripts/bench/mxc-result-render.ts`：实际 MXC 结果经 ToolExecutionComponent 和 TuiAltScreen 的可见状态、分配与释放验证。
- `tests/mxc-workspace-live.test.ts`：最终构建产物的真实 MXC 验收。

单独验证 backend 的真实 JSON 解析和校验路径：可在现有 runner 接缝注入合法与非法响应，保持 `backend.invoke/run` 本身实际执行。覆盖缺字段、错类型、非法枚举、负数、分数、越界值及不适用于当前 operation 的元数据。`mxcFileFixture.attach()` 会替换 `backend.invoke`，因此不能用它证明 backend 校验已经生效；也不要为测试额外开放生产接口。原有 worker 错误仍经过原有失败路径。

当前测试 runner 没有单文件转发参数。定向测试使用 Node 自身参数；下列为已经核对过的现有入口：

~~~powershell
npm.cmd run check
npm.cmd run build:offline

node --experimental-strip-types --test --test-concurrency=1 tests/mxc-file-worker.test.ts

node --experimental-strip-types --test --test-name-pattern="sandbox literal search scans monotonically and bounds rows without line arrays" tests/source-invariants.test.ts

node --expose-gc --experimental-strip-types scripts/bench/mxc-search.ts
~~~

新增集成测试使用实际文件名执行，并确认测试确实命中，不能以零匹配、跳过或仅通过宿主测试代替。

根据实际修改运行相关图片、路径、生命周期和输出投影回归；不把所有单元套件、所有历史验收和所有 benchmark 反复串跑。最终遵守执行时仓库规定的构建、类型和 CI 门禁。本方案核对的类型命令是 `npm run check`，不是 `check:types`。

### 7.3 Windows MXC 实机门禁

在支持当前 MXC 的 Windows x64 + PowerShell 7 环境，先构建，再执行实际 dist 入口。

仅给测试子进程设置：

| 环境变量 | 值 |
| --- | --- |
| `SUPERPI_MXC_LIVE` | `1` |
| `SUPERPI_SANDBOX_USE_DIST` | `1` |
| `TMP`、`TEMP`、`TMPDIR` | 本任务新建的唯一临时目录 |

子进程命令：

~~~powershell
node --experimental-strip-types --test --test-concurrency=1 tests/mxc-workspace-live.test.ts
~~~

要求：

1. `read-only` 与 `sandbox-write` 两档都实际运行，相关测试 `skip=0`。
2. 在原有真实 owner 路径加入完整/受限 read、完整/有覆盖缺口 grep，以及 files/count 的小型断言。
3. 验证新字段和模型文本，确认实际加载的是本次构建的 worker。
4. 保留原有 PowerShell 7、权限和资源释放断言，包括进程不活跃、流引用释放、runtime root 清空和 Job 句柄归零。
5. 使用小型定向语料，不在实机验收中复制整个 Unity 项目。
6. 没有可用 Windows MXC 环境时，交付“实现完成、实机验收待完成”的候选及缺失项；不能把 Linux skip 当通过，不能降级到旧 VM 或宿主路径凑通过。

`SUPERPI_SANDBOX_LIVE` 和旧 `SUPERPI_SANDBOX_WORKSPACE_ACCEPTANCE` 不是当前这个 live 文件的启用变量。[当前 MXC live 测试][s11]

### 7.4 分层测量

| 测量层 | 必须记录 | 结论边界 |
| --- | --- | --- |
| 生产扫描函数 | 确定性计数、分配/采样、输出上界、GC 后保留引用 | 不能当作完整 MXC 调用耗时 |
| 实际 MXC 工具调用 | 基线/候选提交、Windows/Node/PS7/MXC 版本、语料身份、响应字节、覆盖/错误、首次与复用调用 | 不混合冷启动和热调用，不混合宿主与 MXC |
| 模型可见投影 | 最终送给提供者的 schema/工具正文大小、调用次数、额外恢复轮次 | 字节不是计费 token |
| 可选真实模型任务 | 同模型/配置、正确率、实际 usage、重试 | 没有真实 usage 时不宣称 token 或费用节省 |

复用现有脚本与请求捕获方式，不新建 benchmark 平台。提供者投影可用现有 fake fetch 捕获，不要求本轮调用付费 API。

固定任务至少包括：

- 找出哪些文件含某符号：完整配对比较 content 与 files 的正确文件集合和实际输出量；受限结果计入为完成同一答案所需的后续调用，不能直接将不同完成度的输出当作等价性能结果。
- 统计每文件匹配行数：比较独立预期值与 count 结果。
- 在受限搜索中识别覆盖缺口，再缩小已授权路径范围完成定位。
- 读取指定小窗口，判断本次窗口是否完整、文件是否还有剩余。

使用同一语料、相同权限和相同运行环境，交替执行基线与候选，记录实际样本。先验证答案，再讨论输出或耗时。正确性修复可能增加少量状态文本，这是合理成本；不能靠省略不完整提示制造“更省 token”的结果。不预设节省百分比，不添加不稳定的墙钟 CI 阈值。[dsh 基准方法][d03]

## 8. 提交组织与完成条件

建议按以下可审查单元组织本地改动，相关测试随功能实现；提交操作须服从本轮用户授权和全局规则：

1. P0：同步 MXC 文档与当前验收入口。
2. P1：read/grep 完整性事实、协议传递和模型可见反馈。
3. P2：grep content/files/count 投影与语义测试。
4. P3：真实 MXC 验收补充、必要的测量脚本及简洁证据。

如当前仓库已有对应实现，可以合并或跳过相应提交，不能为了凑阶段制造空改动。

### 本地实现与验收清单

- [x] 当前架构和默认执行范围已核对，无旧 VM 路径误入。
- [x] 已知搜索覆盖缺口不再呈现为无条件的全范围零命中。
- [x] read 能区分请求窗口、文件剩余和行内截断。
- [x] 截断提示通过 content、details、CodeMode 和实际提供者投影验证。
- [x] content 默认兼容；files/count 的集合与计数正确。
- [x] 四类容量单位清楚，完整协议不超预算。
- [x] 原权限、错误、snapshot、图片和修改语义保持。
- [x] 热路径结构、分配与释放证据符合仓库契约。
- [x] 构建和类型检查通过；相关定向测试通过。
- [x] Windows dist 实机两档已验证，或如实列为未完成门禁。
- [x] 按用户要求保留本轮任务目录，在最终交付中列出路径供用户清理。
- [x] 没有顺手引入游标、索引、Bash、另一套 ledger 或全局接口重构。

最终在 `docs/evidence/` 留一份简洁记录，包含问题、复现、修改、实际数字、验证平台和复跑命令。原始日志、下载、profile、语料放任务临时目录，不放证据文档，不包含凭据或真实用户配置。

交付说明写明：实际基线与候选提交、修改文件、已完成阶段、测试数字与 skip、Windows 实机状态、分配/资源证据、输出量变化及仍保留的限制。不得把计划中的结果写成已经测得。

## 9. 后续方向（本轮不自动实施）

| 方向 | 触发条件 | 后续应解决的问题 |
| --- | --- | --- |
| 长行/大文本续读游标 | 真实任务持续被行内裁剪阻塞 | 绑定文件版本和位置；编码边界、过期处理、无遗漏续读 |
| 统一预算的多文件读取 | 任务证据显示重复 read 调用成本明显 | 批次总预算、逐项失败和续读；尊重 MXC 串行 owner |
| 宿主输出模式对应 | 用户需要跨权限档一致的调用体验 | 保留宿主 regex/ignore 等语义，单独验证 |
| 命中周边片段 | 行首片段经常不能帮助定位 | 保留列/行定位和预算，不把词法匹配当语义定义 |
| 模型可见重复读取去重 | 已测得重复正文成本，且已有请求证据链可扩展 | 先审 CodeMode read evidence；只有最新成功请求精确包含正文才省略，权限/压缩/投影变化失效 |
| 索引或缓存 | 固定重复查询确有已量化瓶颈 | 文件变更、失效、权限、保留内存和完整性 |
| 批次修改逐项回执 | 有独立的修改恢复需求 | 单独设计副作用与重试语义，不混入只读搜索任务 |

这些方向不阻挡本轮结束。已有 CodeMode、引用系统、Evidence Ledger、CAS 文件修改或 LSP 能力应先核对再扩展，不重复引入 dsh 的整套实现。

## 10. 最初的任务指令（历史）

> 请按本方案执行 P0–P3：先核对当前 HEAD、全局/仓库 AGENTS 及真实生产链，保留 MXC + PowerShell 7。优先完成 read/grep 完整性契约和模型可见反馈，再独立加入 MXC grep 的 content/files/count 输出。不要调大容量上限，不改宿主搜索语义，不引入 Bash、游标、索引或新的全局结果框架。逐阶段完成相应测试，复用现有 CodeMode 与提供者投影夹具，并在支持的 Windows 上以当前 dist 路径做 MXC 实机验收。没有实机环境则明确留下未完成门禁。形成可审查的本地改动和一份简洁证据；提交、推送、PR、合并按我届时的明确指令处理。常规实施选择自行完成，遇到本方案与最新代码差异时用证据调整，不回退到审查基线。

## 参考来源

以下链接固定到本方案的审查提交；实施时以当前对应源码为准。

[s01]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/docs/execution-environments.md
[s02]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/packages/coding-agent/src/core/agent-session.ts#L1045-L1057
[s03]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/packages/coding-agent/src/core/sandbox/workspace-backend.ts
[s04]: https://github.com/dragonbaba/super-pi/pull/275
[s05]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/docs/evidence/mxc-route-review-2026-11-10.md
[s06]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/AGENTS.md
[s07]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/docs/performance/hot-path-allocation-contract.md
[s08]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/scripts/acceptance/retired-sandbox/README.md
[s09]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/scripts/build-mxc-runtime.mjs
[s10]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/docs/testing.md
[s11]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/tests/mxc-workspace-live.test.ts
[s12]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/packages/coding-agent/src/core/sandbox/mxc-file-worker.mjs
[s13]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/packages/coding-agent/src/core/sandbox/workspace-tools.ts
[s14]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/scripts/bench/mxc-search.ts
[s15]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/tests/sandbox-image-read.test.ts
[s16]: https://github.com/dragonbaba/super-pi/blob/b9843f859441d9aa00a88c694cbd8f8a13f5ea56/tests/codemode-session.test.ts
[d01]: https://github.com/T-Auto/dsh-ops/blob/156ba1eedc187bf4905a1beb828304e211c5d751/native/crates/ops-protocol/src/search.rs
[d02]: https://github.com/T-Auto/dsh-ops/blob/156ba1eedc187bf4905a1beb828304e211c5d751/src/capabilities/file.ts
[d03]: https://github.com/T-Auto/dsh-ops/blob/156ba1eedc187bf4905a1beb828304e211c5d751/bench/README.md

[d04]: https://github.com/T-Auto/dsh-ops/blob/156ba1eedc187bf4905a1beb828304e211c5d751/docs/search-coverage.md
[d05]: https://github.com/T-Auto/dsh-ops/blob/156ba1eedc187bf4905a1beb828304e211c5d751/docs/context-read-dedup.md
[d06]: https://github.com/T-Auto/dsh-ops/blob/156ba1eedc187bf4905a1beb828304e211c5d751/docs/file-batching.md
