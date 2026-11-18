# Windows 桌面驱动与终端实测

Windows x64，单屏，i7-14700KF，Node 26.13.0。选用 sbroenne/mcp-windows。两个候选均复用了 Pi 的 MCP stdio 连接、工具注册、结果转换和关闭流程。FlaUI 在这套控件任务中更快。选定驱动另提供窗口相对坐标、预期前台校验和带条件等待的批处理，自绘控件因此可操作。

| 同机交替运行，各 10 次新建会话 | 冷连接 p50 / p95 | 连接及工具调用耗时之和 p50 / p95 | 完成 |
| --- | --- | --- | --- |
| FlaUI-MCP v0.2.1 | 162 / 167 ms | 272 / 279 ms | 10/10 |
| mcp-windows v1.3.28 | 542 / 567 ms | 811 / 837 ms | 10/10 |

相同任务逐项检查中英文、首尾空格、CRLF、按钮产生一次提交以及窗口 PNG。工具耗时按毫秒取整，分位数取最近秩。表中为驱动直接启动。另以 PowerShell 互斥启动器各做一次，冷连接分别为 347 和 706 ms。两个版本分别暴露 12 和 18 个工具。[FlaUI 发布版本](https://github.com/shanselman/FlaUI-MCP/releases/tag/v0.2.1) · [Windows MCP 发布版本](https://github.com/sbroenne/mcp-windows/releases/tag/v1.3.28)

真实模型在 Pi Agent 中各做了一次相同的限定窗口任务。测试工具写入随机八位数，另一个工具仅返回目标窗口截图，模型正确读回两次。各使用一次填入、一次截图和三次模型请求。FlaUI 总耗时 14.01 秒，Windows MCP 13.49 秒，首个 provider 事件分别为 5.57 秒和 4.38 秒。每组一个样本仅用于验证图像闭环。

Microsoft UFO² 将 Windows UIA、视觉定位和多动作组合用于桌面操作。UI-TARS Desktop 采用视觉模型、截图和鼠标键盘。Super Pi 优先使用控件来完成可验证读写，在自绘界面按需截取窗口，同时通过已有 MCP 工具调用复用连接。[Microsoft UFO](https://github.com/microsoft/UFO#-ufo-desktop-agentos--core-strengths) · [UI-TARS Desktop](https://github.com/bytedance/UI-TARS-desktop#ui-tars-desktop)

## 故障与会话交接

在本机真实 Windows 桌面运行下列命令。脚本创建两个专属窗口，完成后释放进程与临时目录。

```powershell
node scripts/acceptance/windows-computer-use.mjs D:/Tools/windows-mcp/Sbroenne.WindowsMcp.exe (Get-Command pwsh).Source
```

验证了原生打开文件对话框的实际选定路径、自绘区域的命中计数、前台标题不符时的拒绝、窗口截图和中文输入读回。批次在第一次点击已生效、第二步等待时取消，最终提交计数为一。键盘输入中途取消后长度稳定，新会话能重新输入。两个会话争用同一驱动时仅首个成功连接，释放后另一会话接管，旧控件 ID 和已关闭窗口的读取均失败。

首次未缓存的桌面发现需显式命中服务器 ID。普通搜索及启动不会为其创建进程。改动属于配置、发现和连接生命周期，未触及逐帧、逐 delta 或进度热路径。验收范围是本机宿主桌面。异缩放跨屏 DPI 与 MXC 桌面尚未实测。

## 终端与下一处性能瓶颈

使用离线 provider 和真实内置 read，空会话的继承式 ConPTY 首次可输入为 2.70 秒，提交到工具完成为 1.33 秒。真实 Windows Terminal 的独立窗口从启动到可输入为 0.88 秒，提交后 1.15 秒的窗口截图已显示工具完成和最终回复。截图包含采集时间，该值为可见反馈的上界。另在 node-pty 恢复 1000 条合成历史消息后，首次可输入为 1.13 秒，提交到最终文本输出为 1.04 秒。期间执行了一次 resize 和输入，退出时核实两次请求、一次工具执行。单次样本不能代表 p95。独立 ModelRuntime 五次冷启动 p50 / p95 为 269 / 273 ms。

```powershell
node scripts/bench/next-phase-pty-startup.mjs . $env:TEMP/pi-terminal-run.jsonl
```

在真实终端就绪后输入 `n4-probe`，最后输入 `/quit`。报告路径需为新文件。持续增长的 TypeScript 高亮仍是已复现的 CPU 瓶颈，代码块布局复用只能降低其中一部分分配。见[完整输出等价性和分配数据](streamed-code-layout.md)。
