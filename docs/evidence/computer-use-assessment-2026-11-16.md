# Computer use 能力核实与后续入口

这是当前源码能力核实和后续设计建议，尚未交付桌面控制实现，也未执行桌面、剪贴板或输入注入操作。

| 当前入口 | 已有范围 | 桌面缺口 |
| --- | --- | --- |
| [Browser Use](../../packages/extensions/browser-use/README.md) | Browser Harness 浏览器操作、截图与精确标签页/工作目录所有权 | 没有通用 Windows 应用窗口、鼠标键盘和桌面截图驱动 |
| [Chrome DevTools](../../packages/chrome-devtools/README.md) | CDP 页面、DOM、JavaScript 与网页截图 | 控制范围是浏览器页面 |
| [MCP bridge](../../packages/mcp-bridge/README.md) | 外部工具发现、调用、图片结果、权限与关闭生命周期 | 桥接本身不提供桌面驱动；用户可能另配 server，本次未读取私有配置，不能据此断言用户环境没有桌面服务 |
| [Windows MXC UI preflight](../../scripts/acceptance/windows-mxc-ui-preflight.mjs) | 人工验收脚本，核对窗口站、剪贴板与输入隔离前提 | 验收探针没有注册为模型可用的通用桌面工具 |

源码的普通工具转换位于 `packages/ai/src/api/openai-responses-shared.ts` 和 `anthropic-messages.ts`。当前没有原生 `computer_call` / `computer_call_output` 或 `computer_toolset` 的专用执行闭环；这些协议不能靠加一个模型名称或图像能力标记自动启用。

[OpenAI 官方集成说明](https://developers.openai.com/api/docs/guides/tools-computer-use-integration#use-your-own-ui-tools) 明确支持通过普通函数工具承载自有 UI 驱动并返回文字/图片。[Anthropic computer use 文档](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool) 则说明动作由应用在其控制的环境中执行。两者都需要实际执行端；模型本身不会替应用建立本机桌面控制链路。

基于现有源码，建议下一阶段先复用 MCP bridge 接受一个明确配置的 Windows 桌面驱动，按需发现观察、窗口选择和输入工具，以普通工具结果返回状态和图片；原生 provider 协议另行适配。这个选择是本项目的设计判断，尚未安装或选定第三方服务。

驱动需要以会话为 owner 串行协调桌面输入，按已观察的窗口身份和新鲜状态执行，正确换算多屏/DPI/截图坐标，并在取消、错误和关闭时释放输入与截图引用。复用当前授权和撤销机制，保留实际执行结果，不新加确认流程或任意模型脚本限制。失败后先观察当前界面，只恢复未完成动作，已经成功的点击、输入和提交不可自动重放。清理只能释放本任务创建的资源，不能关闭用户原有窗口。

后续交付至少需要真实 Windows 多屏/DPI、焦点变化、取消中途输入、退出清理和下一次会话的验证；在这些验证之前，能力状态仍是“浏览器自动化可用，通用桌面控制待实现”。
