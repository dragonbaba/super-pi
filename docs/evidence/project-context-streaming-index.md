# 大项目索引构建

扫描使用最多两个打开的目录流，按顶层区域增量计数。待扫目录按 256 条分批溢出到磁盘，索引排序批次上界为 2,048 条或 512 Ki UTF-16 路径单位，单条合法路径始终可以入批。多路归并最多同时打开 8 个 64 KiB 输入缓冲，输出按 64 Ki UTF-16 单位分批写。常规排序采用现有的英文排序规则，等价排序键按原始路径打破平局。索引 SHA-256 仍排除末尾换行。

目录读取、排序、比较和发布都由一次显式命令所属的 Worker 完成。Worker 每 256 条记录或阶段边界检查取消。主线程复用一个周期回调，最多每 150 ms 读取共享阶段和文件计数，只有文本有变化才经 `ctx.ui.setStatus` 触发页脚刷新。终止后停止定时器，清除进度与取消监听。原渲染队列、视口布局和终端写入路径沿用已有机制。

常规回归以 2,051 条文件记录验证宽目录、目录栈溢出、重复刷新字节一致以及摘要哈希。独立压力验收使用 50,001 条真实文件记录并覆盖多轮归并。取消覆盖发布前、Worker 启动和交互加载器关闭。注入第二个产物发布失败后，旧摘要和索引逐字节保留。已提交事务的清理恢复覆盖其中一个旧备份已删除的情况。

Windows、Node 26.13.0，同一独立 Git 工作区与同一已发布状态，24,001 条记录。每种路径各运行三个独立进程，表中是中位数。所有轮次报告产物相同，摘要和索引的组合 SHA-256 均为 `f4516bff4af470bc660a27dbb856c0560f807aa9a8397250ff66d969dd40141b`。

| 路径 | 耗时 | 进程 CPU | 峰值 RSS | 20 ms 定时器最大间隔 |
| --- | --- | --- | --- | --- |
| 旧同步构建 | 231.8 ms | 266 ms | 193,452 KiB | 232.2 ms |
| 新构建器单进程 | 240.3 ms | 250 ms | 173,100 KiB | 240.6 ms |
| 新命令 Worker 路径 | 260.0 ms | 265 ms | 184,704 KiB | 32.5 ms |

Worker 路径的主线程 GC 后堆约 41.4 MB，旧同步路径约 48.5 MB。每轮 Worker 路径记录一次阶段更新，退出后状态清除。该夹具无目录溢出，索引 3,048,059 B，最终归并时临时索引数据上界约为两份 JSONL，加锁记录和有界摘要。定时器间隔衡量主线程响应性，未测量物理终端的绘制耗时。

```powershell
node --experimental-strip-types --test tests/project-context-retirement.test.ts tests/bundled-extensions.test.ts
node --experimental-strip-types --test tests/tui-frame-hot-paths.test.ts tests/tui-frame-queue.test.ts
$env:SP_TEST_PROJECT_INDEX_STRESS = '1'
node --experimental-strip-types --test --test-name-pattern 'indexes 50001' tests/project-context-retirement.test.ts
```
