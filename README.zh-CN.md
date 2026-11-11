# Super Pi

面向真实工程任务的可扩展终端 AI 编程助手，聚焦可控执行、持续项目上下文和长会话终端体验。

[English](README.md) · [快速开始](#快速开始) · [文档导航](docs/README.md) · [上游补漏进度](docs/upstream-pi-history-followup-plan.md) · [GPL-3.0-only](LICENSE)

Super Pi 是一个优先从源码运行的终端编程助手。它把模型 API、项目文件和本地工具组合成一个可持续的工作环境：你可以在自己的项目目录中检查代码、规划任务、执行经过检查的操作、恢复会话，并按需要加载扩展。

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
| 应用自己维护 UI 和流式状态 | 全屏 TUI、选择器、进度与结果展示 |
| Provider 集成各自实现 | 多 provider 目录、认证存储、扩展、Skills、MCP 和 RPC |

这些能力仍受 provider、模型能力、项目配置和当前工具策略限制。选定的执行模式决定已接入的工具是否使用 Windows MXC ProcessContainer；应用权限不保证模型输出或外部服务行为。

MXC 沙箱命令严格使用 **PowerShell 7**，不回退其他 shell 或宿主执行。默认从宿主 PATH 发现工具安装目录。通过 `/add-dir <directory>`、`/remove-dir <directory>` 和 `/dirs` 管理附加工作目录。文件与命令工具直接访问授权的原工作区；修改即时生效，失败前已发生的修改也会保留。网络默认关闭，可通过全局 `sandboxNetwork` 或明确的会话同意开启。详见[工作区路径与网络配置](docs/execution-environments.md#工作区路径与网络配置)。

## 快速开始

### 环境

- 包的 `engines` 声明要求 Node.js 22.19 或更高版本；当前 [CI](.github/workflows/ci.yml) 在 Linux 和 Windows 上验证 Node.js 26.13.x。
- npm。
- 使用默认沙箱权限需要 Windows x64、原生 MXC ProcessContainer 支持和 PowerShell 7；具体要求见[执行环境](docs/execution-environments.md)。宿主访问通过 `/permissions` 明确选择。
- 已配置的模型 provider。构建脚本中的 offline 只描述构建阶段，不代表模型推理离线。

### 从源码构建

在 PowerShell 7 中：

示例使用 `npm`。如果 PowerShell 执行策略拦截已安装的 `npm.ps1`，可用 npm 自带的 `npm.cmd` 执行相同命令。这个 Windows 后缀与是否在线发布 npm 包无关，也不需要额外的仓库构建包装脚本。

```powershell
git clone https://github.com/dragonbaba/super-pi.git
Set-Location .\super-pi
npm ci
npm run build:offline
npm run superpi -- --help
```

`npm ci` 按锁文件安装依赖，可能需要联网及原生构建环境；请保留仓库的 `.npmrc`，不要用 `npm update` 替代。依赖安装完成后，`npm run build:offline` 使用仓库内已有的模型数据，将本地各包运行时和资源构建到 `packages/*/dist/`，自动为构建子进程启用 npm 离线模式，不会在线刷新模型目录或配置 provider。CLI 的独立 `--offline` 参数禁用启动阶段的网络操作。两者都不会把远程模型推理变成本地推理。

构建按工作区依赖顺序执行，默认最多同时构建两个包。需要串行执行时用 `npm run build:offline -- --jobs 1`，查看构建计划时用 `--list`。原来带 npm 外层 `--offline` 的命令仍可使用。失败处理和实测结果见[构建说明](docs/building.md)。

启动交互界面：

```powershell
npm run superpi
```

支持的源码入口是 `scripts/superpi.mjs`。它会检查构建的 CLI，并把仓库中的 `.sp` 扩展、Skills 和 prompt resources 传给 coding-agent。直接启动 `packages/coding-agent/dist/cli.js` 会跳过资源装配，不是默认路径。

### 更新已有源码后重新构建

更新源码后，在仓库根目录重新构建。如果 `package-lock.json` 发生变化，先运行 `npm ci` 安装匹配的依赖。依赖已经安装时：

```powershell
npm run build:offline
npm run superpi -- --offline --version
npm run superpi -- --offline --help
```

launcher 只检查构建的 CLI 是否存在，不会自动重新构建，也不会判断它是否匹配更新后的源码。版本命令显示包版本，单看版本号不能确认某个提交已经构建。构建成功后运行这两个 CLI 检查可以验证本地启动入口；provider 访问需按下文另行配置。

### 配置认证和模型

启动后：

1. 运行 `/login`，选择 provider 和认证方式。API key 可以通过交互流程保存；OAuth provider 使用自己的流程。
2. 运行 `/model`，选择已认证 provider 下的模型。
3. 若要列出模型并在不打印凭据的情况下检查是否就绪，可退出交互界面后运行（以下以 OpenAI 为例）：

```powershell
npm run superpi -- --list-models
npm run superpi -- auth check --provider openai --no-refresh
```

也可以在启动时指定模型。执行下面的示例前，将 `REPLACE_WITH_MODEL_ID_FROM_THE_LIST` 替换为列表中的实际 OpenAI 模型 ID；出现在列表中不等于当前账户具有访问权限：

```powershell
$model = "openai/REPLACE_WITH_MODEL_ID_FROM_THE_LIST"
npm run superpi -- --model "$model"
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
npm link
```

然后：

```powershell
Set-Location "C:\work\my-project"
superpi
```

`npm link` 创建 `superpi`，不创建 `pi`，也不会替换 PowerShell 的 `sp` alias。链接依赖源码目录，移动或删除 checkout 会使命令失效。

## 核心能力

### 代码工具与项目理解

普通工具默认通过内置 `codemode` JavaScript 工具调用，CLI、TUI、JSON/RPC 和 SDK 一致，无需开关。脚本使用 `await tools.read({path: "README.md"})`、`await callTool(name, args)` 和 `await show(result.ref)`；交互及 Plan/Goal 控制工具仍直接调用。不支持专用代码格式的模型使用 JSON `code` 参数进入同一运行时。每个子调用继续遵守工具白名单、Plan mode、权限与取消规则；`--no-tools` 仍可禁用工具。

Codemode 首次调用才加载隔离的 QuickJS Worker，并限制执行时间、桥接流量、存储和输出。只有实际展示的原生读取才能在后续模型轮次授权受保护编辑；隐藏读取、打印副本及被截断内容不能授权。子调用失败时，即使脚本捕获异常，父调用也会保留失败状态。成功的分支内 `store` 写入会持久保存，恢复会话不重放脚本；外部工具副作用不会回滚。相关操作可合并到一个脚本以摊薄 Worker 启动成本。详见 [使用说明](docs/codemode.md)、[默认 Codemode 契约](docs/codemode-default-execution-plan.md) 和 [验证记录](docs/codemode-default-execution-log.md)。

coding agent 提供 `read`、`grep`、`find`、`ls`、`edit`、`write`、`bash`，以及 Windows 上的 `powershell` 工具。各工具有自己的读取窗口和字节/行数限制；TUI 折叠控制屏幕上的可见内容。这些不等于模型 Token 预算。独立的 `toolResultPresentation` 流程需要 `enabled: true`；模型 Token 预算投影还需要配置正整数 `budgetTokens`，它没有生产默认值。支持时，较大输出可以保存在本地 artifact 中按需查看。配置和边界见 [tool-result presentation](docs/performance/phase5b-budgeted-model-view.md)。

项目理解分成几层：

- Project Context 用 `/project-status`、`/project-init` 和 `/project-refresh` 管理项目规则、轻量仓库索引和上下文状态。
- CodeGraph 通过 `/codegraph-status`、`/codegraph-init` 和 `/codegraph-sync` 显式管理；它要求项目可信，不会在启动时自动完整扫描仓库。
- LSP 工具需要配置 server，提供目标诊断、source fix 预览和符号导航。仓库自己的 typecheck、build 和 test 仍是最终依据。

文件编辑使用有范围和身份检查的读写流程。快照、行定位和批量编辑有助于缩小修改范围，但不构成任意多文件事务，也不保证语义正确；每次写入仍经过正常权限和结果检查。

### 会话内后台任务

在宿主执行的 TUI/RPC 会话中，Bash 和 PowerShell 可使用 `background: true` 和明确的 `cwd`；沙箱两档目前仅支持前台命令。提交前模型会获知实际容量；`/tasks` 和直接工具 `tasks` 统一管理普通命令与子代理任务。普通命令默认同时运行 16 个、接纳 64 个，可配置到 64/256。命令保留正常授权、有限结果和完成通知，会话关闭时停止。持久会话重启后可查看有限历史结果；缺少完成记录的任务标记为中断，不自动重跑或恢复旧授权。参见[后台任务用法与限制](docs/background-tasks.md)。

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

直接运行 `superpi`，通过 `/permissions` 选择 MXC 的“只读（沙箱）”“沙箱读写（默认）”，或三个宿主模式：“宿主机受限”“宿主机受限 + Auto 审批”“宿主机完全权限”。宿主访问需要明确选择。切换保留对话并等待旧任务关闭；新会话不继承宿主授权。工作区访问、工具限制与迁移规则见[会话权限与沙箱](docs/execution-environments.md)。项目扩展初始化和 provider 代码仍在宿主应用运行。

长 `node -e` 脚本不会仅因长度而一律拒绝。能够可靠传参的一次性脚本可以直接运行；复杂引号、多段维护或需要重复运行时，可以选择明确文件或受支持的 stdin。写文件不是绕过授权的方式，写入和执行仍分别经过检查。

### 图片和终端体验

图片先进入输入草稿，用户提交后才成为模型请求的一部分。当前模型支持图片时，Super Pi 按 provider 能力发送；文本模型需要图像理解时，可以显式配置 Auxiliary Vision，让另一个有视觉能力的模型生成描述。辅助视觉需要自己的模型和认证，可能产生额外服务调用。

交互界面固定使用终端备用屏幕的全屏模式，每帧只布局可见视口。旧的 `tuiMode` 和 `fullscreenExitOutput` 设置会被忽略，`--tui-mode` 只输出警告。`--mode json` 用于非交互输出，`--mode rpc` 面向嵌入式 host；RPC 协议、client 和 server 包仍是实验接口，server 包本身不提供独立 coding-agent 服务。普通路径粘贴、内部文字选择和图片草稿是不同输入来源，项目没有承诺外部 Explorer 文件拖入终端的原生接收。

向上翻阅时显示 `↓ Back to bottom · Esc`，点击或按 Esc 回到底部并继续跟随新输出，输入草稿保留。会话滚动条固定占用最右一列：默认 `fullscreenScrollbar: "auto"` 在滚动时或鼠标悬停该列时显示；按住滑块可拖拽，点击该列其他位置会直接跳到对应位置并继续拖拽。`"always"` 常显，`"hidden"` 把这一列还给正文。退出时恢复进入前的终端，只留下会话恢复提示。

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
npm run superpi -- list
npm run superpi -- config
npm run superpi -- config --local
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

页脚 `CH%` 是最近一条 assistant 响应报告的缓存读取量占归一化 prompt tokens 的比例；`/session` 使用累计 token 加权用量。provider 未报告缓存时，无法据此确定服务端实际命中率。可选的 **Cache overlap estimates**（兼容原设置键 `showCacheMissNotices`，默认关闭）只显示长度上限，并明确重复内容和缓存原因未知，不推断过期或节省金额。

页脚累计用量涵盖全部会话，普通追加只处理新增记录。可选的长度重叠估计跟随活动分支，在显式上下文变更后重建。完整汇总和 transcript 重建仍扫描所需历史；范围与测量见[增量统计验证](docs/performance/pf05-incremental-stats-validation.md)。

前缀诊断会复用同次 manifest 构建中的相同计算，并继续观察每次实际 provider 派发。可变 schema 和上下文缺少可靠版本时仍重新计算，不跨请求猜测复用。终端关闭保留输入 drain、最终输出和资源清理，重复 Sandbox close 共享完成点。[性能验证方案](docs/super-pi-performance-followup-plan.md)汇总了测量和剩余限制，包括不能从本地微基准推断的原生终端/provider 验收。

## 安全、隐私和已知边界

配置、会话和部分记忆保存在本地，但这不表示输入永远不离开本机。提示、工具 schema、文件片段、工具结果和图片可能发送给选定 provider；配置的 MCP server 会收到发给它的调用和数据。使用前请检查 provider、MCP、扩展和环境变量的信任关系。

权限规则和项目可信度属于应用层控制；选择前两档时，已接入的文件与命令工具另有 MXC ProcessContainer 隔离。宿主完全权限仍保留显式拒绝、版本与受保护元数据检查；它不会恢复旧 `full-access` 授权。“未执行”只表示可信的执行前拒绝；后端启动后的失败需要按实际结果判断。

Compaction 会减少部分旧历史的直接可见性。Memory、Project Context 和 CodeGraph 各有自己的范围、上限和启用条件，不保证自动理解完整仓库或永久记住全部会话。辅助视觉需要单独配置；provider-native compaction 按扩展配置和兼容条件工作，`enabled` 如上所述默认回退为 `true`。两者均可能产生额外服务调用和费用。

## 文档、开发和贡献

- [文档导航](docs/README.md)：按用户和贡献者任务组织的链接。
- [模型能力参考](docs/model-capabilities.md)：模型输入、工具、推理、上下文和 provider 能力。
- [Coding-agent 说明](packages/coding-agent/README.md)：全屏行为、PowerShell 和运行时细节。
- [AI/provider API](packages/ai/README.md)：provider、模型、认证、工具和图片。
- [NOTICE.md](NOTICE.md)：来源、作者和许可证说明。

常用源码检查：

```powershell
npm ci
npm run check
npm run build:offline
npm test
```

`npm test` 包含 unit、热路径不变量、provider-contract 三类测试，并运行一次 memory workspace。`test:unit`、`test:hot` 和 `test:contract` 用于定向选择子集，不需要在完整测试前额外重复运行。runner 记录各文件的启动、退出和耗时，为子进程提供隔离的离线 HOME/agent/session 环境，并为需要 GC 的所有权回归启用 GC。回归覆盖与基准测量的边界见[测试执行说明](docs/testing.md)。

开发临时文件统一放在 `.task-tmp/<task-id>/`，包括日志、临时夹具、缓存和资源清单。先将验收证据保存到 `docs/` 或 `docs/evidence/`，等待任务进程和句柄退出，再删除该任务登记的临时文件；清空共享目录前先确认没有活动任务。删除已完成任务的临时数据不会移除 `packages/*/dist/` 构建产物、`node_modules/` 依赖或 `~/.sp/agent/` 运行数据，后续任务会重新创建自己的临时目录。所有权和清理规范见 [AGENTS.md](AGENTS.md)。

文档任务先做 Markdown、链接、命令和事实核对；生产代码再按影响范围选择测试。修改热路径前阅读性能契约，不要用一次计时或一个 heap 数字替代生命周期证据。

## 上游关系与版本

Super Pi 最初派生自 [Pi](https://github.com/earendil-works/pi) v0.84.1，现在在本仓库独立维护，使用自己的 `@super-pi` 包作用域、`superpi` 命令和 `.sp` 数据根目录。它不是官方 Pi 发行版，也不继承上游发布通道；来源见 [NOTICE.md](NOTICE.md)。

Super Pi 核心包当前版本为 **1.0.0**，与 Pi 独立编号。截至 **2026-11-04**，选定的 [Pi 1.5.0 实施任务](docs/upstream-pi-1.5.0-implementation-plan.md)和后续 [H00–H10 历史补漏任务](docs/upstream-pi-history-followup-plan.md)均已合并。补漏记录包含独立 PR、审查与 CI 结果、性能证据和资源清理状态。

[Pi 1.5.0 差异评估](docs/upstream-pi-1.5.0-diff-assessment.md)是固定历史对照，不是持续更新的上游版本公告。历史清单的 1,150 条来源记录不等于 1,150 个已修复缺陷，也不代表全部完成语义审计；V01–V04 和其他未验证条目仍开放，功能候选仍需独立产品决策。默认不启动后台付费 cache warming。

## 许可证与合理使用

当前修订版采用 **[GNU GPL v3.0 only](LICENSE)**（`GPL-3.0-only`）。分发受 GPL 覆盖的修改版本或二进制时，必须遵守相应的许可证、版权声明和对应源码提供义务；不得以剥夺接收者 GPL 权利或拒绝提供所需源码的方式闭源分发。

项目反对违法使用、未经授权的访问、侵权和其他滥用。这是项目立场，不是额外的 GPL 用途限制。GPL 允许商业使用；私人修改、内部使用和仅提供网络服务并不自动要求向公众开源。使用 Super Pi 编写自己的项目，也不会仅因此改变该项目的许可证。

改许可不追溯撤销旧版 MIT 授权；上游 MIT 代码及其版权声明继续保留。许可范围、分发说明、来源和报告入口见 [NOTICE.md](NOTICE.md)。贡献前请阅读 [AGENTS.md](AGENTS.md)、相关包说明和性能契约。
