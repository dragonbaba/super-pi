# Codemode 使用说明

Super Pi 默认通过 Codemode 执行普通工具。模型直接调用 `codemode`，在脚本内调用 read、bash、edit、MCP 等工具。ask_user、Plan/Goal 等控制工具保持直接调用。工具白名单、Plan mode、权限和取消规则继续生效；`--no-tools` 可以禁用工具。

## 基本调用与树状卡片

```js
const result = await tools.read({ path: "package.json" });
await show(result.ref);
```

工具返回 `{ content, details, isError, ref }`。`ref` 是宿主为本次脚本签发的引用；`show(ref)` 展示未被脚本改写的原生结果。`text(value)`、`console.log(value)` 和 `return` 用于报告计算结果，`image(...)` 用于图片，`exit()` 成功结束脚本。

Bash / PowerShell 正常结束时返回原始输出和 `details.shellExecution.exitCode`，非零退出码本身不会抛工具异常，也不需要 `allowFailure`。例如搜索无匹配和编译失败都可能返回非零，含义由调用方根据结果判断；`isError: false`、`CODEMODE_OK` 或后台 `completed` 仅表示工具调用完成，不能作为编译或测试通过的证明。启动失败、超时、取消、输入/输出不完整等工具故障仍按错误返回。依赖命令成功的脚本须检查实际退出码，原有编译/测试验证检查仍要求退出 0。

原生模式中，第一次修改已有文件需要有效读取版本。自己干净成功的 `edit`/`write` 会在 `details.revisionContinuation="available"` 时自动保留新版本，下一次精确文本编辑或覆盖无需补读；新建文件也适用。旧 ID 失效，新行锚仍须通过相应 `read` 获取，不能把提交版本当作已经展示的 `LINE#ID`。外部变化、冲突、淘汰、超过 2 MiB 或延续不可用时再读取确切目标。缓存最多 128 份、合计 8 MiB；提交后的日志/观察失败、取消和生命周期切换不会保留可误用的新版本。单次写入的既有 1 MiB 上限保持不变。

MXC 沙箱覆盖已有文本文件或执行 `edit` 时，显式传入读取或自己干净修改返回的 SHA-256：

```js
const r = await tools.read({ path: "notes.txt" });
const written = await tools.write({ path: "notes.txt", content: "updated", snapshot: r.details.snapshot });
await tools.edit({ path: "notes.txt", snapshot: written.details.snapshot, edits: [{ oldText: "updated", newText: "continued" }] });
```

新建文件的 MXC `write` 不带 snapshot，成功后同样返回新哈希。`r.ref` 仅用于展示，不能作为 `snapshot`。哈希过期时读取并核对内容，不能忽略版本检查。MXC 跨调用按内容哈希表示版本，同内容的外部替换沿用既有语义；本次修改期间的固定身份和内容检查仍生效。`file_batch` 的 `details.items` 逐项返回 succeeded/unknown/not_started 与成功项的新哈希；成功项不回滚，失败或不确定项没有新哈希，不自动重放。

目标已创建后的写入、stat、关闭或发布校验失败，move 已产生目标但未完成源删除，或临时候选未能清理时，MXC 返回 `requiresVerification:true`。这些不确定修改不能靠捕获异常变成可提交 store 的普通部分完成；先核对当前文件。创建前拒绝、旧哈希和目标冲突等明确未进入发布的失败仍可正常处理。

需要短暂等待时可用 `await new Promise(resolve => setTimeout(resolve, 1000))`。
`setTimeout(callback, ms, ...args)` 返回数值 ID，`clearTimeout(id)` 可取消它。每次脚本最多创建 256 个定时器，延时必须是 0～300000 ms 的有限数值；回调必须是函数。等待计入脚本 `timeout_ms`，即使同时存在待完成的工具调用。脚本返回、`exit()`、失败或取消时释放剩余定时器，未等待的回调不会延长已完成脚本的生命周期。没有 `setInterval`。对 `SANDBOX_CLOSED` 等终态错误，等待后重复工具调用不能恢复工作区。

`image(...)` 和 `show(ref)` 展示的图片会在脚本结束后尝试保存为私有临时文件，结果中的 `Image files: read .../images.json` 指向清单。下一回合用普通 `read` 读取清单，按其中的绝对路径读取、复制或移动图片；文件操作仍受原有工具权限控制。清单中的 `image` 是本次结果里从 1 开始的图片序号，重复图片共用文件。

每次调用最多处理前 16 张图片，单张最多 8 MiB、解码输入合计最多 16 MiB，支持 PNG/JPEG/GIF/WebP；同次调用按内容去重，不建立跨会话缓存。文件在 POSIX 上为 `0600`，Windows 上使用创建时即生效的当前用户私有 DACL。保存失败或超限时仍保留原有图片、已完成工具结果和脚本状态，并报告未保存数量；不要重跑已完成操作恢复图片。若图片文件占用的空间导致文本恢复写入失败，会回收本次图片文件并重试一次文本保存，图片附件仍保留。独立的 CodemodeSandbox API 仍只返回内容块。

文件跨会话关闭保留，同机恢复会话可继续使用历史清单路径。它们没有应用自动过期定时器，由用户或系统临时目录清理；跨机器迁移会话不迁移文件，文件被清理后路径可能失效。需要长期保存时及时通过普通工具复制到目标位置。临时目录路径过长、无法放入脚本输出预算时，文本会明确提示省略路径，完整位置仍在保存的结果元数据 `details.codemode.imageFiles` 中，原始图片和脚本状态保留。后续模型投影会完整保留清单提示前缀；若连同恢复提示也无法放入模型预算，则整体省略，通过 continuation 读取原文，避免输出不能使用的半截路径。脚本内的 `ref` 仍仅在当前调用有效，`image()` 不返回文件路径。

一张父卡片对应一次 Codemode 调用，树中每一行对应一次子工具调用。`Child calls: 2` 表示本脚本调用了两个子工具，并不表示同一命令执行了两遍。折叠时显示工具、路径或命令、状态和耗时；失败输出保留可见，展开后显示脚本和子结果。相同输出无法唯一归属某个调用时保留在脚本输出区。

多个独立读取或搜索、且中途不需要模型判断时，适合一个脚本用 `Promise.allSettled` 发起并检查每项。单调用照常使用；有依赖的修改 → 运行 → 检查按顺序 await，失败先核对实际状态。同一文件的修改优先合成一次 `edits[]`。宿主只对可信读取允许最多 4 个并发，写入顺序执行；MXC 保持自己的串行 owner。扩展覆盖的工具不因自己声称“只读”就自动得到并发权限。

```js
const results = await Promise.allSettled([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
]);
for (const result of results) {
  if (result.status === "fulfilled") await show(result.value.ref);
  else text(String(result.reason));
}
```

## 读取与修改

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

当前本地工具的声明按有界预算列在 Codemode 描述中；省略时会给出提示。MCP 声明按需查看，远端工具加入活动集不会仅因名字增加而改变整段内联描述。

内联声明包含简短用途、参数类型与可容纳的约束标签（如 `@integer`、`@minimum`、`@maxLength`、`@default`），返回值统一声明为实际的 `ToolResult`。`ALL_TOOLS` 用于找名字和简述；长说明会明确标记为摘要。使用不熟悉的工具前，先通过 `describeTools` 读取完整说明，不要根据名字猜测函数或参数。

```js
text(ALL_TOOLS.filter(tool => tool.name.includes("search")));
text(await describeTools(["read"]));
```

`describeTools(names, options?)` 每次最多接受 16 个当前可用工具名，也接受目录中的脚本别名。默认返回最多 8,000 字符的文档正文；可用 `limit` 调整为 256–16,000 字符。长文档带有下一页 `offset` 和定义版本 `revision`；续页必须同时带回这两个值，并保持名字和格式一致。若 MCP 后台更新等原因使定义改变，会要求丢弃旧页、从 `offset:0` 重读，不会混合两个版本。页头和续读提示不计入正文限额。

```js
// TypeScript 是便于阅读的摘要；精确约束和无法展开的类型可查询原始 JSON Schema。
text(await describeTools(["browser_exec"], { format: "json", limit: 8000 }));
// 若返回续读提示，按其给出的 offset、limit 和 revision 发起下一次请求。
// offset/limit 以 UTF-16 计数；分页保留完整 Unicode 字符，页尾可能比 limit 少一个代码单元。
```

连续翻页复用当前选择的已序列化 Schema，避免每页重新遍历全部 Schema。每个控制器只保留一组，最多 16 个、每个 65,536 个 UTF-16 代码单元，不保留工具对象或完整说明；读完、选择或目录变化、运行失败、取消和关闭时释放。每页仍重新核对当前工具权限及版本。

单个输入 Schema 沿用 65,536 字符及结构遍历保护；不可序列化或超限时明确报告限制，不能将 `unknown` 理解为任意参数都有效。工具目录变动后应从第一页重读。详情查询只读取当前工具元数据，不执行目标工具，也不激活被禁用的工具。资料较多时分轮展示，避免汇总全部文档后再次超过模型输出预算。

MCP 的完整说明通过宿主 `fullDescription` 元数据保留，内联工具说明继续使用摘要；实时发现和缓存恢复都不会先截掉 1,000 字符之后的内容。完整目录和缓存仍受 MCP 的 2 MiB 边界约束，旧摘要缓存会重新发现。

`ALL_TOOLS` 是本次脚本开始时的目录快照。`tools.tool_search(...)` 可以发现并激活允许使用的工具；MCP 搜索负责远端目录。激活后若工具不在脚本起始快照中，用 `await callTool(name, args)` 调用。发现结果不扩大权限，执行前仍检查当前活动工具和授权。

## 分支状态与限制

```js
store("nextPage", "cursor-value");
text(load("nextPage"));
```

store 只在脚本及最终结果处理成功后提交，随会话分支恢复；失败更新保留此前快照。`store(key, undefined)` 删除该键。恢复快照损坏或超限时会明确报告一次恢复失败，该次调用不执行工具，原历史文件不被修改；后续调用从空 store 继续。

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
