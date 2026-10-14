# Codemode 使用说明

Super Pi 默认通过 Codemode 执行普通工具。模型直接调用 `codemode`，在脚本内调用 read、bash、edit、MCP 等工具。ask_user、Plan/Goal 等控制工具保持直接调用。工具白名单、Plan mode、权限和取消规则继续生效；`--no-tools` 可以禁用工具。

## 基本调用与树状卡片

```js
const result = await tools.read({ path: "package.json" });
await show(result.ref);
```

工具返回 `{ content, details, isError, ref }`。`ref` 是宿主为本次脚本签发的引用；`show(ref)` 展示未被脚本改写的原生结果。`text(value)`、`console.log(value)` 和 `return` 用于报告计算结果，`image(...)` 用于图片，`exit()` 成功结束脚本。

`image(...)` 和 `show(ref)` 展示的图片会在脚本结束后尝试保存为私有临时文件，结果中的 `Image files: read .../images.json` 指向清单。下一回合用普通 `read` 读取清单，按其中的绝对路径读取、复制或移动图片；文件操作仍受原有工具权限控制。清单中的 `image` 是本次结果里从 1 开始的图片序号，重复图片共用文件。

每次调用最多处理前 16 张图片，单张最多 8 MiB、解码输入合计最多 16 MiB，支持 PNG/JPEG/GIF/WebP；同次调用按内容去重，不建立跨会话缓存。文件在 POSIX 上为 `0600`，Windows 上使用创建时即生效的当前用户私有 DACL。保存失败或超限时仍保留原有图片、已完成工具结果和脚本状态，并报告未保存数量；不要重跑已完成操作恢复图片。若图片文件占用的空间导致文本恢复写入失败，会回收本次图片文件并重试一次文本保存，图片附件仍保留。独立的 CodemodeSandbox API 仍只返回内容块。

文件跨会话关闭保留，同机恢复会话可继续使用历史清单路径。它们没有应用自动过期定时器，由用户或系统临时目录清理；跨机器迁移会话不迁移文件，文件被清理后路径可能失效。需要长期保存时及时通过普通工具复制到目标位置。临时目录路径过长、无法放入脚本输出预算时，文本会明确提示省略路径，完整位置仍在保存的结果元数据 `details.codemode.imageFiles` 中，原始图片和脚本状态保留。后续模型投影会完整保留清单提示前缀；若连同恢复提示也无法放入模型预算，则整体省略，通过 continuation 读取原文，避免输出不能使用的半截路径。脚本内的 `ref` 仍仅在当前调用有效，`image()` 不返回文件路径。

一张父卡片对应一次 Codemode 调用，树中每一行对应一次子工具调用。`Child calls: 2` 表示本脚本调用了两个子工具，并不表示同一命令执行了两遍。折叠时显示工具、路径或命令、状态和耗时；失败输出保留可见，展开后显示脚本和子结果。相同输出无法唯一归属某个调用时保留在脚本输出区。

独立任务可以在同一脚本中安排；有依赖的操作按顺序 await。宿主只对可信读取允许最多 4 个并发，写入顺序执行。扩展覆盖的工具不因自己声称“只读”就自动得到并发权限。

```js
const results = await Promise.allSettled([
  tools.read({ path: "package.json" }),
  tools.read({ path: "README.md" }),
]);
for (const result of results) {
  if (result.status === "fulfilled") await show(result.value.ref);
}
```

## 读取与修改

受保护的编辑要求前一个**已完成轮次**里对模型可见的原生读取。先完成读取脚本，再依据实际结果提出修改：

```js
// 第一轮：让模型看到将要修改的范围。
await show((await tools.read({ path: "example.txt" })).ref);
```

```js
// 后一轮：仅当此前读到的内容确实包含 oldText，且文件身份仍有效。
await tools.edit({
  path: "example.txt",
  edits: [{ oldText: "old value", newText: "new value" }],
});
await show((await tools.read({ path: "example.txt" })).ref);
```

同一脚本里的首次 read→edit 不能替代前轮读取。隐藏读取、用 text() 打印的复制内容、伪造引用、旧分支引用以及被模型预算截断的范围也不能授权修改；需要重新显示足够小的范围。

脚本内允许再次调用已经结束的读取或检查，用于变更后验证；并行重叠的相同子调用仍受去重约束。失败循环、原生同批重复调用和变更保护不会因此关闭。

## 失败与结果记录

子调用失败、被拒绝或被取消，会使父调用失败，即使脚本使用了 catch 或 Promise.allSettled。多步操作不构成事务，已经完成的副作用不会回滚。

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
