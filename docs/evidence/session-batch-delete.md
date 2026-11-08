# Session 批量删除验收

## 范围与复现轴

- 现有 `/memory-sessions` 列表只支持单选，并只排除当前会话；其他进程占用的会话仍会进入可选列表。删除仍依赖已经停写的会话索引并移入回收目录。
- 本次保留现有管理入口，增加空格勾选和删除键批量处理；占用项禁选，执行前再次核对，每项如实报告成功或失败。直接删除，不创建备份或回收副本，不增加指令，不加强命令预检。
- `clean` 继续只处理已确认的旧回收清理候选，不扩展到全部历史会话；批量失败必须可见，不把部分完成当作全部失败或全部成功。
- 会话切换使用真实 `AgentSessionRuntime` 与原生占用记录验证：切换前受保护，切换成功后旧 owner、定时器、路径/ID 引用及磁盘占用记录释放，新会话仍受保护。未复现的生命周期行为不另加替代机制。
- 所有复现使用任务临时目录下的合成数据，不操作真实会话或记忆。

## 实现与验收

- 保留 `/memory-sessions`，以空格勾选、Delete 或现有删除键提交已选项。未勾选时不删除；Enter 不执行删除。确认取消后保留选择，部分失败刷新后保留失败原因和可重试的选择。
- 占用状态在列表加载及用户勾选时读取；原生发布锁覆盖每个文件的最终路径/ID 占用检查和 unlink。当前会话及其他 owner 的占用都参与检查。
- 删除停写的 SQLite 会话索引维护和新回收副本创建逻辑；旧回收目录仍只能通过已有 `clean` 明确确认后清理，每个文件分别报告结果。
- 原生 resume 基线已正确释放旧 owner。本次只加强真实 runtime 回归：旧 session 的 lease 引用、心跳/预约定时器、路径/ID getter 和磁盘记录释放；新会话仍受保护。没有另加生命周期机制。
- Windows / Node v26.13.0：6 个相关测试文件 **47/47** 通过（含真实命令处理器的取消、部分失败、刷新、重试；原生切换与删除；界面与 AST 不变量）；根类型检查通过；本地离线构建 **12/12** 包通过。

## 热路径证据

审计链：`memory-sessions` → `selectSessions` / `selectBounded` → `InteractiveMode.showExtensionCustom` 的挂载/关闭边界 → `BoundedMemorySelector.handleInput/render` → `TuiAltScreen` 布局/帧生成 → `TerminalFrameQueue` → terminal write/flush/dispose。

- 显式命令、对话框创建/关闭、勾选和最终删除是低频边界；磁盘占用读取不进入导航或 render。新勾选状态是每项固定布尔字段及实例计数，没有每帧扫描全部会话。
- 普通热方法没有新增闭包、Promise、AbortController、wrapper、集合或全量帧复制；只产生已有的可视行输出和有界行字符串。组件最多输出 24 行、8 个会话行、4 行详情；单实例详情数组仅保存当前路径的换行结果，选项/宽度变化时替换，关闭/取消/dispose 时释放全部项目与回调。不引入对象池。
- 扩展现有生产基准为一个旧清理界面和一个批量勾选界面，100 次迭代：**618** 次 render、**206** 次写帧、**4** 次详情换行；101 次显式勾选对应 **101** 次占用回调，重绘未额外调用。详情缓存最大 11 行，可视详情最多 4 行，最大帧 2,185 UTF-16 code units。
- 独立 HeapProfiler 采样：selector 阶段 **35,227,616 B**，约 **171,008 B/写帧**，包含建组件、文字宽度计算、布局和清理，不能当作新增功能的净分配。主要已有分配在 `truncateToWidth` 和字符宽度计算；站点表有截断，遍历无截断。本记录只有候选运行证据，没有宣称相对基线提速。
- 独立受控 GC：12/12 持有字段清空，2/2 selector owner、2/2 初始详情缓存、2/2 resize 后缓存回收；最终净 heap 变化 -859,456 B，不能解释为累计分配量。
- 独立 queue-only 基准（2,000 个 64 KiB 帧）：flush 后 active/pending 引用与字节均为 0；每帧闭包/Promise/AbortController/wrapper、队列帧物化和完整帧复制计数均为 0。采样 235.1 B/帧主要来自计时/采样仪器；受控 GC 净变化 +128,608 B，无额外泄漏结论。

## 复跑

先将子进程 `TMP/TEMP/TMPDIR` 指向任务独占 `.task-tmp` 目录；离线构建后运行源码测试，确保扩展解析到最新的原生内部接口。

```text
npm run build:offline
npm run check
node --experimental-strip-types --test tests/session-manager-delete.test.ts tests/session-clean-timeout-boundaries.test.ts tests/session-lease-lifecycle.test.ts tests/session-selector-deletion.test.ts tests/tui-hot-paths.test.ts tests/tui-frame-hot-paths.test.ts
node --expose-gc --experimental-strip-types scripts/bench/session-clean-timeout-boundaries.ts --warmup 1 --runs 3 --iterations 100 --sample
node --expose-gc --experimental-strip-types scripts/bench/session-clean-timeout-boundaries.ts --warmup 1 --runs 3 --iterations 100 --lifecycle
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --warmup 100 --frames 2000
```
