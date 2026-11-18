# Codemode 折叠输出与 Windows 浏览器冷启动

Codemode 的 `readOutput()` 是运行时帮助函数。回读证据并调用 `text()` 的真实 worker 回归中，子调用计数为零，生产树组件原先折叠后只显示完成状态。现在折叠显示输出的前两行，若还有输出则第三行显示 `+N`。长行按终端实际宽度裁切，行数按可展开的输出计算。原结果记录、模型视图和展开内容沿用原路径。

热路径核实覆盖 worker 结果投影 → 交互事件 → 工具组件 → Codemode 树 → 保留式视口。结果投影仅提取前两行，用换行符计数其余行。预览组件只在输出或视口宽度变化时重建至多三行，进度与帧刷新没有新增回调、Promise、控制器或包装对象。回归测得同一结果只投影一次，窄视口内长行只占一行，16,001 个隐藏行的计数准确，释放后结果引用、保留文本和计时器均为零。Windows Node 26.13.0 的同机等价分组进度基准（4,096 次，按字符预览 → 按行预览）测得 p95 4.8 → 4.9 µs，采样 3,614 → 3,501 B/次，峰值堆 67.00 → 67.07 MB，GC 后 52.44 → 52.51 MB。主要分配点仍是 Box 缓存比较和保留式布局渲染。事件 Promise 和释放后可达的采样引用均为零。

Browser Harness 0.1.13 本机日志出现 `chrome-not-running` 后，CLI 返回默认 daemon 启动失败。Chrome 运行并由用户确认调试连接后，真实 CLI 的只读探针退出码为 0，健康检查显示一条本地连接。Windows 兼容分支仅在捕获指定的默认 daemon 启动失败且脚本入口未到达时检查进程。确认没有受支持的浏览器后，可启动已安装的 Chrome，并在原期限内重新连接一次。进程检查、启动顺序和失败分支使用夹具验证，真实已连接调用实测一次 CLI 调用、零启动探测，未关闭用户的浏览器来复演冷启动。Browser Use 1.0.6 的发布依赖仍固定在 Browser Harness 0.1.13，冷启动上游修复见 [Browser Harness PR #912](https://github.com/browser-use/browser-harness/pull/912)。

本机安装新版 `browser-use` CLI 后，`browser-use --version` 报告 `1.0.6 (browser-harness 0.1.13)`，只读标签页计数测试复用已授权连接成功。Super Pi 的执行入口仍解析独立的 `browser-harness`。

Codex CLI 的 `--search` 启用 Responses 原生实时搜索。Claude Code 的 `WebSearch` 使用 Anthropic 的搜索后端返回标题和链接，`WebFetch` 按需读取指定页面。公开资料搜索走服务端时省掉本地 Chrome 启动和调试连接，页面交互仍由浏览器工具完成。仓库内的文件和内容定位使用本地搜索。参考 [Codex CLI 命令](https://learn.chatgpt.com/docs/developer-commands?surface=cli) 与 [Claude Code 工具参考](https://code.claude.com/docs/en/tools-reference#websearch-tool-behavior)。

从仓库根目录复跑。

按行预览的最终构建通过类型检查与 12 包离线构建。构建后运行 Codemode 树、会话和热路径测试，177 项通过。

```text
node --experimental-strip-types --test tests/codemode-tree.test.ts tests/codemode-session.test.ts tests/codemode-hot-paths.test.ts tests/tool-reliability-recovery.test.ts tests/bundled-extensions.test.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-tree.ts
npm run check
npm run typecheck --workspace @super-pi/browser-use
npm run build:offline
```
