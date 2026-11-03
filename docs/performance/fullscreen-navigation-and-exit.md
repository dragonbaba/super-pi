# 全屏回到底部与退出检查

2026-11-03，Windows x64 / Node 26.13.0 / Super Pi 1.0.0 未提交工作树。依据 [hot-path-allocation-contract.md](hot-path-allocation-contract.md)。

## 行为与范围

全屏向上翻阅时，输入区上方显示 `↓ Back to bottom · Esc`。左键点击或编辑器的 Escape 动作回到底部，恢复跟随输出，保留输入草稿；已在底部时沿用原中断/双 Escape 行为。补全和对话框先处理自己的 Escape。窄终端使用短标签，更窄时隐藏按钮；原 Ctrl+End/Ctrl+Down 仍可使用。按钮不覆盖其他横向面板，选区拖动、滚动条拖动和覆盖对话框期间隐藏。

`fullscreenExitOutput` 默认从 `transcript` 改为 `resume-hint`。退出直接离开 alternate screen，恢复进入前的终端，只输出正常的会话恢复提示。完整会话重印仅在用户显式选择 `transcript` 时执行。常规模式的历史保留行为不改动；本机现有配置是 fullscreen、未显式指定退出策略，因此本地启动直接采用新默认值。

## 生产调用链

- 键盘：CustomEditor 补全/附件处理 → InteractiveMode.onEscape → TuiAltScreen.scrollToBottomIfNeeded → ScrollView.scrollToEnd → requestRender/scheduleRender。
- 点击：ProcessTerminal 输入 → TuiBase.handleTerminalInput → handleViewportInput → handleBottomHintMouse → 同一滚动入口；鼠标释放归原按钮处理，不进入文本选择。
- 绘制：renderLayoutFrame → selection → compositeBottomHint → flashes → diff/frame → TerminalFrameQueue → ProcessTerminal callback/drain。新步骤原地修改现有 viewport 的一行，不复制屏幕数组或完整帧。
- 退出：InteractiveMode.stop/performStop → stopInteractiveTui → Alt before/afterTerminalStop → ProcessTerminal 恢复输入/光标。默认退出不再经过 fullscreen → regular 的完整会话重绘。

按钮只保留行号、左右边界等 primitive 字段，以及一条按宽度缓存的字符串。模块常量保存标签；相同宽度的持续刷新不重新构造按钮行。宽度上限 4096 列，超限隐藏并释放缓存；回到底部、隐藏、布局更换、stop/dispose 都释放该行。没有新 timer、Promise、AbortController、每帧闭包、包装对象或数组，没有对象池。既有 viewport 数组和布局记录仍存在，不把整条渲染链称为零分配。

## 验证

类型检查、TUI 与 coding-agent 构建、`superpi --version`（1.0.0）通过。针对本次变更的 127 项检查通过：导航/默认配置/AST 26 项，真实 CLI 退出与输出断开 8 项，帧队列/生命周期/覆盖层/快捷键 93 项。CLI 在界面内放置标记，确认它实际绘制过，并断言离开 alternate screen 后不再出现该标记或行重绘。CLI 使用真实生产进程、管道终端夹具；不是原生桌面截图验收。

同机串行基准，5000 项历史、120×40 终端、1000 帧 warmup、5000 帧测量：

| 证据 | 结果 |
| --- | --- |
| 同样向上翻阅，未开启按钮 | 9976.8144 B/帧采样；CPU p95 0.0362 ms |
| 开启按钮 | 10103.872 B/帧采样；CPU p95 0.0392 ms；整个运行按钮行 materializations=1，保留 145 code units |
| 完整帧与队列 | 每帧最终字符串 1，完整帧复制 0；frame Promise/controller/wrapper 0；队列高水位 1，flush 后 active/pending bytes=0 |
| 关闭与受控 GC | 按钮 lineReferences/codeUnits=0；布局 component/line/source/cache 引用均 0；4 次生命周期后最大残留引用数 0 |
| 独立队列基准 | 5000 写入；每帧 closure/Promise/controller/wrapper/materialization/copy 均 0；flush 后 active/pending=0 |

采样包含既有布局与基准夹具。主要分配仍在 layoutComponent、renderComponentsViewport 和 renderCached。按钮开启后采样增加约 127 B/帧、p95 增加约 0.003 ms；不以这一轮噪声较大的采样宣称优化或回归阈值证明。确定性门禁约束的是按钮行只构造一次、无完整帧复制、无逐帧异步对象，以及生命周期释放。受控 GC 的总 heap 差值不等同于泄漏结论。

原始结果在 `.artifacts/tui-navigation-tests.txt`、`tui-navigation-cli.txt`、`tui-navigation-lifecycle.txt` 与 `tui-navigation-perf-{baseline,hint,queue}.json`。源码/日志指纹见 `.artifacts/tui-navigation-closeout.json`。未重复全量 CI、未提交或推送。
