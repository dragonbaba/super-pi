# 扩展命令执行

扩展通过 `pi.exec(command, args, options)` 执行命令，返回 `stdout`、`stderr`、`code`、`killed`、`truncated`。命令和参数分别传入，默认不经过 shell；`cwd` 默认使用扩展上下文目录。

```ts
const result = await pi.exec("git", ["status", "--porcelain=v1"], {
  cwd: ctx.cwd,
  timeout: 3000,
  maxBuffer: 1024 * 1024,
});
if (result.code !== 0 || result.killed || result.truncated) {
  // 处理失败或不完整结果；不要将 stdout 当作完整清单。
  return;
}
// 使用 result.stdout
```

`maxBuffer` 限制 **stdout 与 stderr 合计的原始字节数**，默认 256 MiB，并受 Node 运行时字符串长度上限约束。必须是 0 到该运行时上限之间的整数，非法值在启动前抛出 `RangeError`。它不是每个流各自的额度，也不是字符数。两个流按实际收到的顺序共享预算。

达到额度本身不会中止命令；收到超出额度的字节时才截断，保留额度内的前缀并终止本次拥有的进程族。`maxBuffer: 0` 允许没有输出的命令正常退出；出现输出则返回 `truncated: true`。UTF-8 跨块字符会正确解码；容量切点留下的半个字符会丢弃。

- 正常完成：`killed: false`、`truncated: false`，`code` 为实际退出码。
- 输出超限：`killed: true`、`truncated: true`、`code` 非零，两路输出可能不完整。
- timeout/abort：`killed: true`、`code` 非零；`truncated` 仅标记容量超限。已取消的 signal 不启动命令。
- 启动失败（如 ENOENT）：`code: 1`，`stderr` 包含原始诊断。该诊断不是子进程输出，不受原始输出字节额度裁剪。
- 信号终止或无法取得退出码时，`code` 非零。API 不把未观察到的退出当作成功。

Windows 使用独立 Job Object，命令派发前完成归属，不允许 breakaway；取消时终止整个 job。POSIX 为命令创建独立进程组，取消时向该组发送 SIGTERM，5 秒后仍未退出则 SIGKILL。POSIX 后代主动 `setsid` 或换组会脱离本接口的所有权范围；这不是进程沙箱。

根进程退出时立即清理仍存活的 job／进程组成员，等待清理确认后才返回。清理失败会返回非零 `code` 和 `stderr` 诊断，并阻止所属运行时继续接纳命令或发布新执行边界。运行时切换、重载、失效会取消在途命令并等待同一清理操作。需要长期后台进程时应使用项目已有的受管理任务入口。

`timeout` 包含 Windows native 初始化等待；在派发前检查剩余时间与取消状态。同步原生调用不能被 JavaScript 定时器抢占，因此它不是硬实时保证。Windows Job 初始化失败直接报告失败，不回退到无所有权的执行方式。

`ExecResult.truncated` 是新增的必填结果字段。调用者直接消费 `pi.exec` 返回值即可；自行构造或模拟 `ExecResult` 的适配器需补上该布尔字段。
