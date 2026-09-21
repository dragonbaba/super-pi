# Super Pi

面向真实工程任务的可扩展终端 AI 编程助手，聚焦可控执行、持续项目上下文和长会话终端体验。

[English](README.md) · [文档导航](docs/README.md)

Super Pi 是一个 source-first 的终端 coding agent。它把模型 API、项目文件和本地工具组合成一个可持续的工作环境：你可以在自己的项目目录中检查代码、规划任务、执行经过检查的操作、恢复会话，并按需要加载扩展。

## 适合什么工作

Super Pi 适合需要多轮探索和修改的工程任务，例如：

- 理解一个已有仓库，定位相关文件、配置和调用路径。
- 在明确范围内实现功能、修复问题，并保留会话中的工作记录。
- 先用 Plan mode 探索，再把已接受的计划交给实现流程。
- 为长期任务保存项目上下文、目标状态或经过确认的记忆。
- 在终端中切换模型、会话和工具范围，同时保留可检查的历史。

如果你只需要发送一次提示并读取一次模型文本，直接调用模型 API 可能更简单。Super Pi 围绕模型请求提供持续的工程工作流：

| 直接调用模型 API | Super Pi 增加的能力 |
| --- | --- |
| 应用自己组织工具调用和上下文 | 内置读、搜索、编辑、写入和 Shell 工具，并记录工具结果 |
| 每次请求通常独立 | 会话、恢复、分支、导入/导出和上下文压缩 |
| 应用自己实现审批 | 工具策略、项目可信度、预检查和最终授权 |
| 应用自己维护 UI 和流式状态 | 常规和全屏 TUI、选择器、进度与结果展示 |
| Provider 集成各自实现 | 多 provider 目录、认证存储、扩展、Skills、MCP 和 RPC |

这些能力仍受 provider、模型能力、项目配置和当前工具策略限制。它们是应用层控制，不是操作系统沙箱，也不保证任意模型输出或外部服务行为。

## 核心能力

### 代码工具与项目理解

coding agent 提供 `read`、`grep`、`find`、`ls`、`edit`、`write`、`bash`，以及 Windows 上的 `powershell` 工具。各工具有自己的读取窗口和字节/行数限制；TUI 折叠控制屏幕上的可见内容。这些不等于模型 Token 预算。独立的 `toolResultPresentation` 流程需要 `enabled: true`；模型 Token 预算投影还需要配置正整数 `budgetTokens`，它没有生产默认值。支持时，较大输出可以保存在本地 artifact 中按需查看。配置和边界见 [tool-result presentation](docs/performance/phase5b-budgeted-model-view.md)。

项目理解分成几层：

- Project Context 用 `/project-status`、`/project-init` 和 `/project-refresh` 管理项目规则、轻量仓库索引和上下文状态。
- CodeGraph 通过 `/codegraph-status`、`/codegraph-init` 和 `/codegraph-sync` 显式管理；它要求项目可信，不会在启动时自动完整扫描仓库。
- LSP 工具需要配置 server，提供目标诊断、source fix 预览和符号导航。仓库自己的 typecheck、build 和 test 仍是最终依据。

文件编辑使用有范围和身份检查的读写流程。快照、行定位和批量编辑有助于缩小修改范围，但不构成任意多文件事务，也不保证语义正确；每次写入仍经过正常权限和结果检查。

### Goal、Plan、会话和记忆

- **Plan mode** 通过 `/plan` 或 `--plan` 进入，以只读探索、澄清问题和形成完整实现计划为主。计划接受前会收紧可用工具。
- **Goal mode** 通过 `/goal` 管理持续目标、暂停、恢复和完成状态。顺序 Goal 队列和 managed-run RPC 属于实验能力，默认关闭。
- 会话支持继续、恢复、分支、树导航、命名、导入和导出。会话历史保存在本地；每次模型请求仍只接收该请求允许的上下文。
- Memory 将全局记忆、项目记忆、会话搜索和 Skills 分开管理，通过 `/memory-review` 提供人工审阅的记忆提取流程。普通 memory 工具操作遵守内容检查及当前工具策略，具体确认方式取决于入口。启动不会把所有历史记忆自动塞进 system prompt。

当活动模型接近上下文限制时，Compaction 会整理较早上下文，保留可继续工作的边界，但不等于保存模型的全部内部状态，也不保证跨 provider 完全一致。

Provider-native `openai-server-compaction` 扩展的 `enabled` 默认回退为 `true`。扩展加载后，在模型兼容及触发条件满足时按实际配置工作。可在 `~/.sp/agent/config/openai-server-compaction.json` 中设置 `enabled: false`，或设置 `SP_OPENAI_SERVER_COMPACTION_ENABLED=false` 显式关闭（环境变量优先）。参见 [配置源码](packages/openai-server-compaction/src/config.ts)。远端压缩可能产生额外请求和费用；Auxiliary Vision 是另一项需要单独配置的集成。

### 多模型、扩展、Skills 和 MCP

Super Pi 使用 `@super-pi` 包作用域和 `superpi` CLI。AI 层包含内置 provider 和模型目录，`models.json` 可以定义自定义 provider 或模型覆盖。模型是否可用取决于目录、认证、provider 设置以及 tool、image、reasoning 能力。

源码入口会从 `.sp/config/settings.json` 加载随源码提供的扩展、Skills 和 prompt templates。也可以使用 `superpi install`、`superpi list`、`superpi config`、`superpi remove` 和 `superpi update` 管理资源。扩展可以增加工具、命令、provider 或 UI；项目本地资源受项目可信度限制。

MCP 是显式配置的集成。需要在 `~/.sp/agent/config/mcp.json` 中配置可信 server，再按需使用 `/mcp-status`、`/mcp-tools` 和 `/mcp-reload`。发现、连接和调用可能增加启动时间、网络传输和 provider 成本。MCP 结果的模型 Token 预算投影同样需要上述显式启用的 `toolResultPresentation` 及 `budgetTokens` 配置，并非所有远端结果默认都会投影。失败调用不会自动重放。

### 提问、权限和失败恢复

当模型需要决定重大歧义、冲突需求或无法推导的偏好时，应调用 `ask_user`。工具会显示问题并等待明确的选项或文字回答；回答前，依赖该答案的业务调用不会开始。正文中的“请确认”不会自动形成同样的边界，工具禁用或没有可用 UI 时也不算已回答。回答本身不等于文件、Shell 或外部服务权限。

权限检查结合工具策略、项目可信度、路径和操作检查。`full-access` 只改变授权范围，不能让无法检查的复杂 Shell 语法自动通过；它也不是操作系统沙箱。项目扩展、MCP server、Shell 命令和模型生成的修改都应视为需要审阅的输入。

长 `node -e` 脚本不会仅因长度而一律拒绝。能够可靠传参的一次性脚本可以直接运行；复杂引号、多段维护或需要重复运行时，可以选择明确文件或受支持的 stdin。写文件不是绕过授权的方式，写入和执行仍分别经过检查。

### 图片和终端体验

图片先进入输入草稿，用户提交后才成为模型请求的一部分。当前模型支持图片时，Super Pi 按 provider 能力发送；文本模型需要图像理解时，可以显式配置 Auxiliary Vision，让另一个有视觉能力的模型生成描述。辅助视觉需要自己的模型和认证，可能产生额外服务调用。

常规模式适合保留终端历史，全屏模式提供更集中的工作区；两者共享会话、工具和权限边界。`--mode json` 用于非交互输出，`--mode rpc` 面向嵌入式 host；RPC 协议、client 和 server 包仍是实验接口，server 包本身不提供独立 coding-agent 服务。普通路径粘贴、内部文字选择和图片草稿是不同输入来源，项目没有承诺外部 Explorer 文件拖入终端的原生接收。

## 快速开始

### 环境

- Node.js 22.19 或更高版本。
- npm。
- 已配置的模型 provider。构建脚本中的 offline 只描述构建阶段，不代表模型推理离线。

### 从源码构建

在 PowerShell 中：

```powershell
git clone https://github.com/dragonbaba/super-pi.git
Set-Location .\super-pi
npm.cmd ci
npm.cmd run build:offline
npm.cmd run superpi -- --help
```

`npm.cmd ci` 按锁文件安装依赖；请保留仓库的 `.npmrc` 和原生依赖要求，不要用 `npm.cmd update` 替代。`npm.cmd run build:offline` 构建源码运行时和资源，不会配置 provider，也不会阻断之后的模型网络请求。CLI 的 `--offline` 是另一项设置：它只禁用启动阶段的网络操作，不会把远程 provider 变成本地模型。

启动交互界面：

```powershell
npm.cmd run superpi
```

支持的源码入口是 `scripts/superpi.mjs`。它会检查构建的 CLI，并把仓库中的 `.sp` 扩展、Skills 和 prompt resources 传给 coding-agent。直接启动 `packages/coding-agent/dist/cli.js` 会跳过资源装配，不是默认路径。

### 配置认证和模型

启动后：

1. 运行 `/login`，选择 provider 和认证方式。API key 可以通过交互流程保存；OAuth provider 使用自己的流程。
2. 运行 `/model`，选择已认证 provider 下的模型。
3. 若要列出模型并在不打印凭据的情况下检查是否就绪，可退出交互界面后运行（以下以 OpenAI 为例）：

```powershell
npm.cmd run superpi -- --list-models
npm.cmd run superpi -- auth check --provider openai --no-refresh
```

也可以在启动时指定模型。执行下面的示例前，将 `REPLACE_WITH_MODEL_ID_FROM_THE_LIST` 替换为列表中的实际 OpenAI 模型 ID；出现在列表中不等于当前账户具有访问权限：

```powershell
$model = "openai/REPLACE_WITH_MODEL_ID_FROM_THE_LIST"
npm.cmd run superpi -- --model "$model"
```

建议通过 `/login` 交互输入凭据。也支持 `OPENAI_API_KEY` 等环境变量，但不要把真实 key 放进分享的命令、截图或公开日志。

认证解析顺序是：本次调用显式提供的 `--api-key` 优先；已有 provider 存储凭据时使用存储凭据；没有存储凭据时才检查环境变量、AWS profile、ADC 或其他 provider 支持的来源。存储 OAuth 过期时按 provider 流程刷新；刷新失败不会静默切换到其他来源。

存储凭据位于 `~/.sp/agent/config/auth.json`。`auth print-api-key` 和 `auth print-bearer-token` 用于向明确的外部客户端输出凭据，不是首次登录命令；不要把输出写入日志。`auth check` 只检查 provider readiness，并可按参数决定是否刷新。

Anthropic 旧的自建订阅 OAuth 已停用。使用 Anthropic 时请显式配置支持的 API key 或其他 provider；Super Pi 不会静默切换计费来源。

### 在自己的项目中工作

从目标项目目录启动，使 session cwd、项目可信度、`.sp/config` 和项目上下文都指向该项目：

```powershell
Set-Location "C:\work\my-project"
node "C:\src\super-pi\scripts\superpi.mjs"
```

将 `C:\src\super-pi` 替换成你的 checkout 路径。源码 launcher 仍是正式入口。

如需命令名，可在仓库根目录执行：

```powershell
npm.cmd link
```

然后：

```powershell
Set-Location "C:\work\my-project"
superpi
```

`npm.cmd link` 创建 `superpi`，不创建 `pi`，也不会替换 PowerShell 的 `sp` alias。链接依赖源码目录，移动或删除 checkout 会使命令失效。

## 配置和数据位置

| 位置 | 用途 |
| --- | --- |
| `~/.sp/agent/config/settings.json` | 全局工具、界面、资源和运行时设置 |
| `~/.sp/agent/config/auth.json` | provider 的存储 API key/OAuth 凭据；不要提交 |
| `~/.sp/agent/config/models.json` | 自定义 provider、模型目录和能力覆盖 |
| `~/.sp/agent/config/mcp.json` | 全局 MCP server 配置 |
| `~/.sp/agent/` | session、记忆、缓存、模型目录和其他运行数据 |
| `<project>/.sp/config/` | 可信项目的设置和扩展配置 |
| `<project>/.sp/extensions/`、`<project>/.sp/skills/`、`<project>/.sp/prompts/` | 项目本地资源，受信任状态和启动参数影响 |

`SP_CODING_AGENT_DIR` 可改变全局 agent 数据根目录，`SP_CODING_AGENT_SESSION_DIR` 可改变 session 根目录。不要把 `auth.json`、session JSONL、MCP headers 或模型请求内容提交到项目仓库。

资源管理命令：

```powershell
npm.cmd run superpi -- list
npm.cmd run superpi -- config
npm.cmd run superpi -- config --local
```

`config --local` 编辑当前项目的资源设置；项目资源仍需要明确的信任决定。`--no-extensions`、`--no-skills`、`--no-context-files`、`--no-tools`、`--tools` 和 `--exclude-tools` 可以收紧单次运行，不会修改全局授权。

## 上下文效率和性能设计

Super Pi 的性能工作围绕明确边界：

- 流式更新、工具进度和交互事件使用有界队列、背压或合并更新，避免无界 Promise 累积。
- 展示缓存按实际变化失效；owner 在会话切换、取消和 dispose 时释放引用。
- 工具读取窗口、字节/行数限制和 TUI 折叠各有用途。模型 Token 预算投影需要显式启用 `toolResultPresentation` 并配置正整数 `budgetTokens`；支持的入口可使用 artifact/continuation。
- 高频语法检查使用模块顶层固定正则和已有解析事实；热路径门禁防止意外扫描。
- 取消、超时和失败保留真实执行状态，不把未知副作用改写成“未执行”。

这些是设计和维护约束，不是全路径零分配、固定帧延迟或永不泄漏的承诺。修改 provider streaming、工具、TUI、终端帧或大结果处理前，请阅读 [hot-path allocation contract](docs/performance/hot-path-allocation-contract.md)，并提供可复现证据。

首页不放零散微基准数字。heap delta、采样分配、token 估算和 provider 账单是不同指标，不能互相替代。

## 安全、隐私和已知边界

配置、会话和部分记忆保存在本地，但这不表示输入永远不离开本机。提示、工具 schema、文件片段、工具结果和图片可能发送给选定 provider；配置的 MCP server 会收到发给它的调用和数据。使用前请检查 provider、MCP、扩展和环境变量的信任关系。

权限和项目可信度是应用层控制，不能替代操作系统账户、容器、网络隔离或人工审查。`full-access` 不是“跳过检查”；不支持的 Shell 包装语法仍可能拒绝。“未执行”只表示可信的执行前拒绝；后端启动后的失败需要按实际结果判断。

Compaction 会减少部分旧历史的直接可见性。Memory、Project Context 和 CodeGraph 各有自己的范围、上限和启用条件，不保证自动理解完整仓库或永久记住全部会话。辅助视觉需要单独配置；provider-native compaction 按扩展配置和兼容条件工作，`enabled` 如上所述默认回退为 `true`。两者均可能产生额外服务调用和费用。

## 文档、开发和贡献

- [文档导航](docs/README.md)：按用户和贡献者任务组织的链接。
- [模型能力参考](docs/model-capabilities.md)：模型输入、工具、推理、上下文和 provider 能力。
- [Coding-agent 说明](packages/coding-agent/README.md)：全屏行为、PowerShell 和运行时细节。
- [AI/provider API](packages/ai/README.md)：provider、模型、认证、工具和图片。
- [NOTICE.md](NOTICE.md)：来源、作者和许可证说明。

常用源码检查：

```powershell
npm.cmd ci
npm.cmd run check
npm.cmd run build:offline
npm.cmd run test:hot
npm.cmd test
```

文档任务先做 Markdown、链接、命令和事实核对；生产代码再按影响范围选择测试。修改热路径前阅读性能契约，不要用一次计时或一个 heap 数字替代生命周期证据。

## 上游关系、路线和许可证

Super Pi 最初派生自 [Pi](https://github.com/earendil-works/pi) v0.84.1，现在在本仓库独立维护，使用自己的 `@super-pi` 包作用域、`superpi` 命令和 `.sp` 数据根目录。它不是官方 Pi 发行版，也不继承上游发布通道；来源见 [NOTICE.md](NOTICE.md)。

Pi v0.86.1 的差异评估已经记录，但不代表完成整体升级。EventStream 两栈 FIFO、provider-aware overflow、virtual modules 懒加载和 fuzzy search 推进属于后续独立切片，不是当前已交付的性能收益。默认不启动后台付费 cache warming。

项目遵循 [MIT License](LICENSE)。贡献前请阅读 [AGENTS.md](AGENTS.md)、相关包说明和性能契约。
