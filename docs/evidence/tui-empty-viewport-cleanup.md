# 视口空清理优化

`RetainedContainer` 的清理函数在没有待释放视口记录时也遍历并清空 `Set`。稳定视口回归在旧实现的十帧中观察到十次入口，优化后遍历和清空均为零，返回行逐帧一致。有待释放记录时继续清除准备行和宽度引用。相关调用链从 InteractiveMode 的保留工具卡和 `ScrollView` 进入 `RetainedContainer`，随后是视口合成、`TuiAltScreen`、终端帧队列和写入。本次改动只发生在 `RetainedContainer` 既有清理边界。

Windows、Node 26.13.0，同机每组各三个独立进程，以下为中位数。采样分配与 CPU 分开测量。

| 夹具 | 指标 | 基线 | 候选 |
| --- | --- | ---: | ---: |
| 已完成的折叠 CodeMode 工具卡，4,096 次渲染 | 采样 B/次 | 1,563.2 | 1,285.6 |
| 5,000 条历史，1,000 帧稳定视口 | 采样 B/帧 | 11,290.9 | 11,059.7 |
| 同一视口，30,000 帧 | 进程 CPU | 437 ms | 406 ms |
| 同一视口，30,000 帧 | P95 | 0.0135 ms | 0.0132 ms |

工具卡基线中，`clearPreparedViewportLines` 三轮都进入前八分配点，候选三轮均未出现。工具卡峰值堆中位数为 57.4 → 55.8 MB，GC 后约 50.7 MB，跟踪弱引用全部可回收。长帧夹具峰值 RSS 中位数为 105.6 → 98.5 MB，释放与受控 GC 后约 15.2 MB。每版每帧访问 32 个视口项，生成总计 5,490,000 UTF-8 字节，Promise、AbortController、包装对象及完整帧复制仍为零。清理后保留引用和活动或待写帧字节归零。CPU 样本范围重叠，结果仅描述该夹具，未测量物理终端延迟。

```powershell
node --expose-gc --experimental-strip-types --test tests/tui-retained-transcript.test.ts tests/tui-layout-frame-scope.test.ts tests/tui-frame-hot-paths.test.ts tests/tui-frame-queue.test.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-tree.ts --handled-failures
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --items 5000 --frames 1000 --warmup 100
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --items 5000 --frames 30000 --warmup 1500 --timing-only
```
