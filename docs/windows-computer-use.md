# Windows 桌面操作

Super Pi 可以通过 MCP 在当前交互式 Windows 桌面查找窗口、读取和操作控件，也可以截取指定窗口，按窗口相对坐标操作自绘区域。驱动作为外部进程在当前 Windows 用户权限下运行。宿主机桌面与 MXC 隔离桌面是不同的执行环境。

## 配置

安装 PowerShell 7，从上游发布页下载并解压 `windows-mcp-server-1.3.28-win-x64.zip`。此版本实测归档 SHA-256 为 `9ca69685222d3c4934680218b4a2b3b7ae5bd0c8d2ce8bc2220925f4bd924fe4`。[Windows MCP 发布页](https://github.com/sbroenne/mcp-windows/releases/tag/v1.3.28)

在 `~/.sp/agent/config/mcp.json` 的现有 `servers` 中加入 `desktop`。下面三个可执行文件或脚本路径均需替换为本机绝对路径。启动脚本随 MCP bridge 提供。

```json
{
  "version": 1,
  "servers": {
    "desktop": {
      "transport": "stdio",
      "onDemand": true,
      "command": "C:/Program Files/PowerShell/7/pwsh.exe",
      "args": [
        "-NoProfile", "-NonInteractive", "-File",
        "D:/SuperPi/packages/mcp-bridge/src/windows-desktop.ps1",
        "D:/Tools/windows-mcp/Sbroenne.WindowsMcp.exe"
      ]
    }
  }
}
```

配置生效后，在 Codemode 中使用 `tools.mcp_search_tools({query:"desktop window_management"})`。首次发现需要把服务器 ID 作为独立词。已有工具目录可按能力名称搜索，调用时复用会话连接。用返回的工具名执行 `describeTools([name])` 并通过 `callTool(name, args)` 调用。消息所用模型需要支持图像输入才能读图。

## 定位、操作与恢复

- 用 `window_management` 的 `find` 确认标题、进程和句柄，再用 `ui_find` 在该窗口内唯一定位控件。按需用 `ui_read` 获取结果。精确输入优先用控件支持的 `ui_type` value 模式。切换窗口或驱动会话后重新发现目标。
- 多步交互可用 `ui_batch`，将步骤序列化为 `steps` JSON 字符串，使用 `stopOnError: true`，按控件状态等待。提交后的步骤失败或取消时，先观察当前状态和已完成的效果，避免重复提交。批次没有回滚语义。
- 自绘控件可用 `screenshot_control`，指定 `action: "capture"`、`target: "window"`、`windowHandle`、`includeImage: true`、`annotate: false` 和 `outputMode: "inline"`。按同一窗口的相对坐标和预期标题调用 `mouse_control`。窗口移动或缩放后刷新截图。
- 原生对话框打开后可定位其窗口，核实所属进程，再操作文件名输入框和确认按钮。本机中文系统的 `file_open` 快捷工具曾在对话框实际打开后报告超时。此时应观察对话框。
- 使用同一启动脚本的 Pi 会话共享当前 Windows 登录会话的桌面互斥锁。桌面正在使用时，第二个会话会报告连接错误。第一个会话退出或执行 `/mcp-reload` 释放进程后，在第二个会话重新加载并发现。其他桌面程序和用户仍可切换焦点。`/mcp-status` 显示连接状态，`--no-mcp` 禁用 MCP。

测试范围、时延和复现命令见[本机验收记录](evidence/windows-computer-use-2026-11-19.md)。
