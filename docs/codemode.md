# Codemode 使用说明

Super Pi 默认通过 Codemode 执行普通工具。模型直接调用 `codemode`，在脚本内调用 read、bash、edit、MCP 等工具。subagent、ask_user、Plan/Goal 等编排和控制工具保持直接调用。CodeMode 的 `ALL_TOOLS` 只列脚本可用工具；`describeTools` 对已激活的顶层工具返回 `TOOL_DIRECT_ONLY`，应按模型收到的顶层 schema 调用。`tool_search` 激活未激活工具，并报告准确名称或类别中已激活的工具；搜索为空不代表顶层工具不存在。工具白名单、Plan mode、权限和取消规则继续生效；`--no-tools` 可以禁用工具。

## 基本调用与树状卡片

`code` 是非空 JavaScript 字符串，不设独立字符硬上限；结构化参数与原生源码调用一致。完整源码交给 VM 编译和执行，不自动截断或拆分。沿用 256 MiB QuickJS 堆上限和现有执行时间、取消及桥接配额，语法或资源失败报告实际结果，成功子调用绝不自动重放。VM 堆上限不代表整个 Node 进程的内存上限，桥接参数、返回值和 store 配额也不是源码上限。脚本保持为工具调用和小型变换，文件内容使用文件工具。

VM 解析失败时，工具结果和折叠卡片会显示失败原因与「脚本尚未开始执行」。如果 QuickJS 提供位置，结果会标出原脚本的行和 UTF-8 字节列。展开卡片可查看短源码片段。`String.raw` 模板仍以反引号为边界。嵌入含有反引号的 Python 或 Markdown 时，可以用普通 JavaScript 字符串逐行拼接。

```js
const python = ["print('Markdown: `code`')", "print('done')"].join("\n");
```

文件内容检索优先使用已注册的 `grep`，文件名和目录枚举使用 `find` / `ls`；复杂命令使用所请求的 Bash 或 PowerShell，让程序返回真实结果。不单独解析 rg/Git 参数、预检命令中的路径或运行额外的版本/可用性子进程。原生 grep/find 固定使用主工作区及附加工作区外已安装的 rg/fd 真实路径，检索本身不启动安装器；缺少可信程序时使用已知可用的其他接口或按原有授权进行安装。不要重复执行 `rg --version`、帮助查询或可用性检查；环境事实核实一次后复用，只有安装、PATH 或执行环境确实变化时才重新核实。修改文件前仍须确认实际文件和匹配，遵循原有工作区授权与版本保护。

工具名称和参数以当前目录与 schema 为准，旧会话调用、压缩摘要和保存文档不是当前工具契约。已知有效工具直接复用；只在需要未激活工具时发现。核对历史名称用 `tools.tool_search({query:name,exact:true})`，只匹配完整注册名，不因其中的关键词激活其他工具。查无匹配后，选择当前可用的同类能力；目录未改变前不重复查找，不猜兼容别名，也不重跑历史成功项。默认不传 `exact` 时仍按能力或类别搜索。顶层控制工具按直接 schema 调用，MCP 工具发现仍由其当前注册服务器目录负责。

独立调用使用 `batch` 的字符串工具名描述符。`tools.NAME` 不存在会在读取属性时同步抛错；即使用 `Promise.allSettled([tools.NAME(...)])`，异常也会在数组构造期间发生，早于组合器调用。未捕获的 Script 异常结束执行并取消仍未完成的子调用，已经完成的效果保留且不自动重试。

```js
const result = await tools.read({ path: "package.json" });
await show(result.ref);
```

工具返回 `{ content, details, isError, ref, outputs }`。`ref` 是宿主为本次脚本签发的展示引用；`show(ref)` 展示未被脚本改写的原生结果。`text(value)`、`console.log(value)` 和 `return` 用于报告计算结果，`image(...)` 用于图片，`exit()` 成功结束脚本。

### 原始输出与结构化数据

`content` 用于展示，可能包含尾部截断、诊断和分页提示，不能当作数据文档。原生前台 Bash/PowerShell 的原始组合输出和 MCP `structuredContent` 单独返回 `outputs: [{ ref, format, complete }]`。读取数据用 `readOutput`，无需重新执行生产命令：

```js
const result = await tools.bash({ command: "node report.cjs" });
const page = await readOutput(result.outputs[0].ref, {
  format: "json", path: ["results"], offset: 0, limit: 20,
});
text(page); // { data, complete, nextOffset }
```

`path` 是精确字段名或数组下标；`offset/limit` 对选中的数组或字符串分页。不传选择参数返回完整的小值，超出既有桥接预算时选择更小的字段或页。MCP 数据默认 JSON；shell 默认 text，只有输出确为一个 JSON 文档时才选择 JSON，因为 stdout/stderr 合并捕获。JSON 要求 `complete: true`，被截断的保存文件、不确定的捕获和无效 JSON 会明确报数据错误，原始执行状态保持不变。后台 shell 的日志随任务结束清理，不签发这种引用。

数据引用与 `show` 的脚本内展示引用分开：数据引用可在当前活跃分支的后续脚本使用，也不会随脚本失败或 store 未提交而消失。脚本摘要和 `details.codemode.calls[].outputRefs` 保留引用。会话分支持有最多 256 项和 1 Mi UTF-16 内联数据，大数据使用私有捕获文件；淘汰、分支恢复、reload 和关闭使引用失效。保存文件沿用原生命令的 5 MiB 上限或 MCP 既有的 10 MiB 传输边界及临时文件寿命。文件身份、长度或摘要变化会拒绝解析。模型不能向此接口提交任意文件路径；历史结果不授予修改文件所需的当前读取证据。扩展改写/脱敏原生展示后，旧的原始数据通道失效；无数据引用的工具通过其已有结果接口读取。

Bash / PowerShell 正常结束时返回原始输出和 `details.shellExecution.exitCode`，非零退出码本身不会抛工具异常，也不需要 `allowFailure`。例如搜索无匹配和编译失败都可能返回非零，含义由调用方根据结果判断；`isError: false`、`CODEMODE_OK` 或后台 `completed` 仅表示工具调用完成，不能作为编译或测试通过的证明。启动失败、超时、取消、输入/输出不完整等工具故障仍按错误返回。依赖命令成功的脚本须检查实际退出码，原有编译/测试验证检查仍要求退出 0。

原生模式中，第一次修改已有文件需要有效读取版本。自己干净成功的 `edit`/`write` 会在 `details.revisionContinuation="available"` 时自动保留新版本，下一次精确文本编辑或覆盖无需补读；新建文件也适用。旧 ID 失效，新行锚仍须通过相应 `read` 获取，不能把提交版本当作已经展示的 `LINE#ID`。外部变化、冲突、淘汰、超过 2 MiB 或延续不可用时再读取确切目标。缓存最多 128 份、合计 8 MiB；提交后的日志/观察失败、取消和生命周期切换不会保留可误用的新版本。单次写入的既有 1 MiB 上限保持不变。

MXC 沙箱覆盖已有文本文件或执行 `edit` 时，显式传入读取或自己干净修改返回的 SHA-256：

```js
const r = await tools.read({ path: "notes.txt" });
const written = await tools.write({ path: "notes.txt", content: "updated", snapshot: r.details.snapshot });
await tools.edit({ path: "notes.txt", snapshot: written.details.snapshot, edits: [{ oldText: "updated", newText: "continued" }] });
```

新建文件的 MXC `write` 不带 snapshot，成功后同样返回新哈希。`r.ref` 仅用于展示，不能作为 `snapshot`。哈希过期时读取并核对内容，不能忽略版本检查。MXC 跨调用按内容哈希表示版本，同内容的外部替换沿用既有语义；本次修改期间的固定身份和内容检查仍生效。成功项不回滚，失败或不确定项没有新哈希，不自动重放。

`copy`、`delete`、`move` 和 `file_batch` 不设目标数量上限，新调用共用 v3 会话记录。copy/move 可传 `items`，delete 可传 `paths`，与单值形式互斥；`file_batch` 支持 copy 与递归 delete。组装批量前，先用当前读取或干净自提交版本确认源文件和唯一匹配；新建与覆盖要明确区分。不确定时先 `dryRun`，核对失败项后再提交。工具会在任何修改前检查全部项，再进行所需授权。

`file_batch` 的文件缺失、原文缺失、匹配不唯一等明确未修改失败按项记录，其余独立项继续。成功只反馈计数，正文提炼失败项的序号、路径和原因；详细回执仍可分页查询。已完成且只有这类失败的批量在 CodeMode 中返回 `CODEMODE_PARTIAL`，自动展示诊断并继续脚本，无需为此设置 `allowFailure`。这不代表所有文件都成功；修正时只提交失败项，成功项绝不自动重试。取消、授权失效、结果未知和日志故障仍停止。具体目录、链接、跨工作区和停止规则见[文件结果的完整性](execution-environments.md#文件结果的完整性)。

工具先返回完整计数和 `resultRef`。最多 16 个且符合字节预算的小结果附 `details.items`；其他结果标记 `itemsOmitted: true`，须通过 `tools.file_result({ref: result.details.resultRef, cursor, limit: 128})` 按 `nextCursor` 翻页。终态为 `succeeded`、`failed_no_change`、`partial`、`state_unknown`、`cancelled` 或未启动；仅干净成功的文本修改提供可继续使用的新 snapshot。分页限制只控制返回量。`resultRef` 绑定当前会话分支，不能作为 snapshot、文件路径或 Codemode 的展示 `ref`。dryRun 只有汇总与有界样本，没有执行记录引用。

目标已创建后的写入、stat、关闭或发布校验失败，move 已产生目标但未完成源删除，或临时候选未能清理时，MXC 返回 `requiresVerification:true`。这些不确定修改不能靠捕获异常变成可提交 store 的普通部分完成；先核对当前文件。创建前拒绝、旧哈希和目标冲突等明确未进入发布的失败仍可正常处理。

文件修改派发后若回执传输丢失、JSON 损坏、身份不匹配或快照事实无效，也按需要核验处理：可能已经发生修改，不能当作“未执行”或自动重放。派发前的明确配置/校验失败，以及工作进程返回的有效拒绝事实保留原有处理方式。

需要短暂等待时可用 `await new Promise(resolve => setTimeout(resolve, 1000))`。

工具的 `content` 是展示文本。通过[原始输出与结构化数据](#原始输出与结构化数据)的 `readOutput` 读取受信来源；无数据引用时再使用工具已有的结果接口或保存路径。不要解析截断尾部、删除显示标记猜补缺失内容，或重新运行已成功的命令。`details.spillFileCapped` 表示日志也不完整。流已排空与返回文本完整是两件事；CodeMode 的 `resultComplete` 表示捕获完成，`outputTruncated` 单独表示原生 shell 返回文本截断。脚本后处理失败仍会显示错误并撤销本次 store 写入，成功的命令及副作用不会回滚。
`setTimeout(callback, ms, ...args)` 返回数值 ID，`clearTimeout(id)` 可取消它。每次脚本最多创建 256 个定时器，延时必须是 0～300000 ms 的有限数值；回调必须是函数。等待计入脚本 `timeout_ms`，即使同时存在待完成的工具调用。脚本返回、`exit()`、失败或取消时释放剩余定时器，未等待的回调不会延长已完成脚本的生命周期。没有 `setInterval`。对 `SANDBOX_CLOSED` 等终态错误，等待后重复工具调用不能恢复工作区。

`image(...)` 和 `show(ref)` 展示的图片会在脚本结束后尝试保存为私有临时文件，结果中的 `Image files: read .../images.json` 指向清单。下一回合用普通 `read` 读取清单，按其中的绝对路径读取、复制或移动图片；文件操作仍受原有工具权限控制。清单中的 `image` 是本次结果里从 1 开始的图片序号，重复图片共用文件。

每次调用最多处理前 16 张图片，单张最多 8 MiB、解码输入合计最多 16 MiB，支持 PNG/JPEG/GIF/WebP；同次调用按内容去重，不建立跨会话缓存。文件在 POSIX 上为 `0600`，Windows 上使用创建时即生效的当前用户私有 DACL。保存失败或超限时仍保留原有图片、已完成工具结果和脚本状态，并报告未保存数量；不要重跑已完成操作恢复图片。若图片文件占用的空间导致文本恢复写入失败，会回收本次图片文件并重试一次文本保存，图片附件仍保留。独立的 CodemodeSandbox API 仍只返回内容块。

文件跨会话关闭保留，同机恢复会话可继续使用历史清单路径。它们没有应用自动过期定时器，由用户或系统临时目录清理；跨机器迁移会话不迁移文件，文件被清理后路径可能失效。需要长期保存时及时通过普通工具复制到目标位置。临时目录路径过长、无法放入脚本输出预算时，文本会明确提示省略路径，完整位置仍在保存的结果元数据 `details.codemode.imageFiles` 中，原始图片和脚本状态保留。后续模型投影会完整保留清单提示前缀；若连同恢复提示也无法放入模型预算，则整体省略，通过 continuation 读取原文，避免输出不能使用的半截路径。脚本内的 `ref` 仍仅在当前调用有效，`image()` 不返回文件路径。

一张父卡片对应一次 Codemode 调用，树中每一行对应一次子工具调用。折叠时显示工具、路径或命令、状态、耗时和失败原因。成功脚本若没有子调用且有输出，折叠时显示前两行，第三行用 `+N` 标记剩余行数。长行按终端宽度裁切。展开可查看脚本和详细输出。相同输出无法唯一归属某个调用时保留在脚本输出区。

多个独立调用、且中途不需要模型判断时，使用 `batch` 明确声明各项独立。普通项失败后其余项继续；摘要只返回完成计数及失败项的序号、工具、结果引用和原因，所有原始结果在 `results[index].result`。修正时只提交失败项，成功项不自动重试。单调用照常使用；有依赖的修改 → 运行 → 检查按顺序 await，失败先核对实际状态。同一文件的修改优先合成一次 `edits[]`。宿主只对可信读取允许最多 4 个并发，写入顺序执行；MXC 保持自己的串行 owner。扩展覆盖的工具不因自己声称“只读”就自动得到并发权限。

```js
const result = await batch([
  { tool: "read", args: { path: "package.json" } },
  { tool: "read", args: { path: "README.md" } },
]);
text(result.summary); // { completed, failed, failures: [{ index, tool, ref, error }] }
```

每项使用普通 `callTool` 桥接、权限、调度、取消和既有调用预算。描述符的 `review: true` 仅传递该项通常的风险审查请求。取消、权限失效、结果未知、要求验证和观察/日志错误仍会失败或停止，不能把这些状态当作普通失败继续。`completed` 表示工具调用完成；命令是否通过仍须检查其真实退出码或应用状态。`Promise.all`、`Promise.allSettled` 和合法 JavaScript 保持标准语义；`batch` 不解析命令，不推断依赖，不授予额外权限。独立 CodeMode 库宿主须提供 `callTool` 才能使用此助手。

## 读取与修改

在 Auto 权限档，普通读取、查询和常规构建/测试无需额外请求审查；宿主自动识别原生文件变更、部分 shell 文件变更和 destructive MCP 声明。主模型判断不透明的 shell、MCP 或自定义调用会删除/覆盖数据、修改项目或应用状态、安装软件、修改系统设置、改写 Git 历史或向外部发送私有数据时，必须在执行前使用 `await callTool(name, args, { review: true })`。可以同时传入 `allowFailure: true` 并检查原始失败结果。`review` 仅请求审查本次调用，不传给底层工具，不覆盖明确的权限规则或边界；被拒绝后不得换一种调用形式重试。完整规则见[执行环境与权限](execution-environments.md)。

已有文件第一次编辑用 `read` 获取可靠原文和相应版本，可在同一个脚本内读取、计算并编辑，不要求 `show()` 或额外模型轮次。权限核验独立于文件版本：

```js
const original = await tools.read({ path: "example.txt" });
// 依据 original 的实际内容选择 oldText，提交时仍验证文件身份与哈希。
await tools.edit({
  path: "example.txt",
  edits: [{ oldText: "old value", newText: "new value" }],
});
// 自己干净提交的版本可继续精确文本修改；新行锚需要对应的 read。
```

小文件可整份读，大文件读取足够的连续函数或段落，尊重实际窗口和长行边界。搜索、计数、同时看几个片段也可使用适当 shell 命令；shell 读取不自动签发原生文件修订。已有且无已知变更的内容、自己的干净提交版本无需预防性重读；冲突、淘汰或延续不可用时再读。伪造 ref、旧分支 ID 和未经读取的新行锚不能作为版本证据。

脚本内允许再次调用已经结束的读取或检查，用于变更后验证；并行重叠的相同子调用仍受去重约束。失败循环、原生同批重复调用和变更保护不会因此关闭。

## 失败与结果记录

普通子失败默认抛出。`try/catch`、`Promise.allSettled` 正常处理失败并让脚本正常结束后，父调用为 `isError:false`，使用 `CODEMODE_PARTIAL`，逐项保留原始失败和 succeeded/failed/handledFailures/unhandled 计数。`callTool(name,args,{allowFailure:true})` 则直接返回真实 `isError`，仍需检查。全部子调用失败但已处理时，只表示脚本完成，不宣称子任务成功。

未捕获/丢弃的失败 Promise、未结束子调用、取消、超时、记录或观察失败仍使脚本或运行失败；需要用户输入的暂停保留原控制效果。判断依据是 VM 拒绝通知与宿主调用身份，没有新增源码解析或 Promise 改写。未捕获错误终止依赖链，但已发出的兄弟调用和 `finally` 可能已经执行；以实际回执为准，不能笼统称“后续没有执行”。多步操作不构成事务，成功副作用不回滚、不自动重放。

`describeTools`、`show` 等宿主辅助调用也返回 Promise；结束时仍未结算或未正常处理的辅助失败会阻止 store 提交，并报告具体调用。辅助调用中的 `callTool` 按原调用身份与子事实匹配，不重复计数。进度观察、变更调用日志和批次项目中的核验要求同样保留系统失败语义，不因脚本捕获而清除。

store 只在结果 hook 和全部关键结果消息观察成功后提交。最终观察或持久化失败会停止运行，保留旧 store；工具已经完成的事实不被改写为未执行。持久化发生在已观察的结果之后，若此时失败，Agent 另行报告运行错误，下一次加载仍使用旧状态。树状卡片保留失败子行并显示“completed with failures”；父调用完成不清空子失败历史。

Shell 保留真实进程状态。grep 退出 1 通常表示无匹配；只有在该具体查询的语义中明确处理这个状态，才能把空结果作为正常业务结果。不能统一忽略退出 1，也不能追加无条件成功命令来掩盖网络或写入错误。

若工具已经返回，但附加详情超限或无法序列化，Codemode 保存有界的实际结果状态并明确报告结果处理失败。这个状态不是完整的变更凭据；应检查 `/changes` 和目标当前状态，不能因为父调用失败就重做已经完成的变更。持久化本身不可用时也不会声称已保存。

## 工具发现

CodeMode 的 provider 入口说明固定。本地和 MCP 工具的激活、顺序、说明及 Schema 更新不再向入口拼接声明；完整契约按需查询。顶层控制工具、明确的系统规则、模型/会话配置和压缩仍可能改变真实请求前缀；固定入口不保证服务端缓存命中。

会话活动工具按准确注册名稳定排序，顶层声明、提示中的工具简述及规则使用一致顺序；仅重排同一工具集合不再改变前缀。普通工具的通用能力提示、Skills 展示条件和作用于该工具的规则，从允许的注册目录生成，激活/停用不会重写这些前置内容。目录和规则不授予权限，实际调用仍检查活动集、当前 Schema、Plan/Goal 及执行授权。真实规则内容更新和顶层控制工具增删仍如实发送，不保留过期契约来制造命中。跨 provider 发送边界验证见[记录](evidence/provider-prefix-matrix-2026-11-16.md)。

`ALL_TOOLS` 包含当前脚本可用工具的简述、`name`（`tools[name]` 的 JavaScript 属性）和 `toolName`（准确注册名）。两者可能因符号规范化或名称冲突而不同；`describeTools`、`callTool` 使用 `toolName`，不要推导别名或 MCP 服务名。使用不熟悉的工具前，先读取当前完整说明和 Schema；TypeScript 摘要包含可容纳的参数约束，返回值为实际 `ToolResult`。

```js
text(ALL_TOOLS.filter(tool => tool.toolName.includes("search")));
text(await describeTools(["read"]));
```

`describeTools(names, options?)` 每次最多接受 16 个当前可用工具名。为兼容旧脚本也接受别名，但注册名优先，冲突时必须使用 `toolName`。默认返回最多 8,000 字符的文档正文；可用 `limit` 调整为 256–16,000 字符。只有返回 `[More tool documentation]` 提示时才请求续页，照抄其中的下一页 `offset` 和定义版本 `revision`，并保持名字和格式一致；所有 `offset > 0` 请求都必须带回该版本。完整文档会标记无需续页，不要自行猜测偏移重读。首页不传 `revision`；若 MCP 后台更新等原因使定义改变，会要求丢弃旧页、从 `offset:0` 且不带版本重读，不会混合两个版本。页头和续读提示不计入正文限额。

```js
// TypeScript 是便于阅读的摘要；精确约束和无法展开的类型可查询原始 JSON Schema。
text(await describeTools(["browser_exec"], { format: "json", limit: 8000 }));
// 若返回续读提示，按其给出的 offset、limit 和 revision 发起下一次请求。
// offset/limit 以 UTF-16 计数；分页保留完整 Unicode 字符，页尾可能比 limit 少一个代码单元。
```

连续翻页复用当前选择的已序列化 Schema，避免每页重新遍历全部 Schema。每个控制器只保留一组，最多 16 个、每个 65,536 个 UTF-16 代码单元，不保留工具对象或完整说明；读完、选择或目录变化、运行失败、取消和关闭时释放。每页仍重新核对当前工具权限及版本。

单个输入 Schema 沿用 65,536 字符及结构遍历保护；不可序列化或超限时明确报告限制，不能将 `unknown` 理解为任意参数都有效。工具目录变动后应从第一页重读。详情查询只读取当前工具元数据，不执行目标工具，也不激活被禁用的工具。资料较多时分轮展示，避免汇总全部文档后再次超过模型输出预算。

MCP 的完整说明通过宿主 `fullDescription` 元数据保留，工具目录说明使用摘要；实时发现和缓存恢复都不会先截掉 1,000 字符之后的内容。完整目录和缓存仍受 MCP 的 2 MiB 边界约束，旧摘要缓存会重新发现。

`ALL_TOOLS` 是本次脚本开始时的目录快照。`tools.tool_search(...)` 可以发现并激活允许使用的工具；MCP 搜索负责远端目录。激活后若工具不在脚本起始快照中，用 `await callTool(name, args)` 调用。发现结果不扩大权限，执行前仍检查当前活动工具和授权。

先检查活动目录，缺少工具时才搜索。准确搜索已激活本地工具会报告原名，不再激活描述碰巧匹配的其他工具；类别已用尽时也报告已激活项。MCP 搜索的结构化结果区分 `activated`、`alreadyActive`、`rejected`；只使用宿主接受的名称。无配置、无匹配和策略拒绝含义不同；搜索不是公网检索，也不执行目标工具。远端内容和发现结果均不能授予权限。

## 分支状态与限制

```js
store("nextPage", "cursor-value");
text(load("nextPage"));
```

store 只在脚本及最终结果处理成功后提交，随会话分支恢复；失败更新保留此前快照。`store(key, undefined)` 删除该键。恢复快照损坏或超限时会明确报告一次恢复失败，该次调用不执行工具，原历史文件不被修改；后续调用从空 store 继续。

只保存 ID、文件路径、游标和短摘要；本次脚本的大块结果留在局部变量，用 `show(r.ref)` 展示，不把完整 read/search/tool 结果存入 store。结果需要跨轮保留时，使用已有 Output 文件路径或通过正常工具保存文件。

`storeInfo({offset:0,limit:16})` 同步返回 `{usedChars,maxChars,maxValueChars,keyCount,entries:[{key,chars}],nextOffset}`，仅含键名和占用，不含值，也不执行工具。默认每页 16 项，`limit` 为 1–4096；`chars` 是键名加 JSON 字符串的 UTF-16 长度，单值上限只计算 JSON。按返回的 `nextOffset` 查看下一页；修改 store 或切换分支后从 0 重新查看。它反映本脚本的暂存状态，不在脚本间保留额外索引；每脚本原有的快照传输成本不变。

```js
// 容量报错后的新脚本：只查看键名和大小。
text(storeInfo());
```

确认哪些键不再需要后，再提交一个只做清理的脚本，例如 `store("已确认不用的键", undefined)`。清理脚本必须成功结束才会提交。若删除后又在同一脚本中报错，删除也不会提交。原来成功的工具操作仍已完成，不能为修复 store 而重跑。可选缓存可以自行捕获 `store()` 错误，并继续使用局部变量中已经获得的结果。

主要限额以 UTF-16 字符数计，图片与 Shell 原生输出另有自身限制：

| 范围 | 限额 |
| --- | --- |
| 每脚本子调用 | 256 次 |
| 默认/最长脚本时间 | 60 秒 / 300 秒 |
| 单 store 值的 JSON | 262,144 字符 |
| store 总体 | 1,048,576 字符，最多 4,096 个键 |
| 模型输出预算 | 默认 8,000，可设 256–16,384 |

宿主同时限制 JSON 遍历次数，防止大量被 JSON 忽略的字段耗尽处理时间。合法数字数组按实际编码长度验收。运行环境不提供 Node、文件系统、网络或计时器全局；这些能力通过宿主工具提供。

```js
// @options: {"timeout_ms":60000,"max_output_tokens":4000}
const result = await tools.read({ path: "README.md" });
await show(result.ref);
```

超出显示预算时保留有界预览和恢复位置；某些完整输出本身也有落盘上限，界面会标明。不要用重放副作用来恢复输出。每脚本独立 Worker 有固定启动成本，适合将相关操作合理合并，不保证单次简单读取比原生调用更快。

开发与验收见 [实施方案](codemode-default-execution-plan.md)、[审查复核](codemode-review-verification.md) 和 [执行记录](codemode-default-execution-log.md)。
