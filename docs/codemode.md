# Codemode 使用说明

Super Pi 默认通过 Codemode 执行普通工具。模型直接调用 `codemode`，在脚本内调用 read、bash、edit、MCP 等工具。ask_user、Plan/Goal 等控制工具保持直接调用。工具白名单、Plan mode、权限和取消规则继续生效；`--no-tools` 可以禁用工具。

## 基本调用与树状卡片

```js
const result = await tools.read({ path: "package.json" });
await show(result.ref);
```

工具返回 `{ content, details, isError, ref }`。`ref` 是宿主为本次脚本签发的引用；`show(ref)` 展示未被脚本改写的原生结果。`text(value)`、`console.log(value)` 和 `return` 用于报告计算结果，`image(...)` 用于图片，`exit()` 成功结束脚本。

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

```js
text(ALL_TOOLS.filter(tool => tool.name.includes("search")));
text(await describeTools(["read"]));
```

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
