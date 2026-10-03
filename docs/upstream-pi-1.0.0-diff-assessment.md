# Super Pi 对照 Pi v1.0.0：差异审查与后续拆分

> 本文是审查结论和拆分计划，不是修复报告。已复现的问题、已核对等价的项目和暂缓评估的项目分开列出；尚未实测的利用路径、性能收益和外部兼容影响，不写成已验证的结论。

## 1. 基线与方法

- **Super Pi**：`main` 的 `7434ba7ab`（已合入 PR #55）。上一次系统吸收上游止于 v0.99.1，见 [upstream-pi-0.99.1-diff-assessment.md](upstream-pi-0.99.1-diff-assessment.md)。
- **官方**：`earendil-works/pi` 的 **v1.0.0 标签**，单独对照。本地目录当前为 `v1.0.0-15-g221cbcb02`，标签之后的提交记为“**发布后修复**”，不算 v1.0.0 已包含的内容。
- 范围：v0.99.2、v1.0.0 和发布后修复。逐项对照 Super Pi 源码；能调用生产函数或真实入口复现的都复现了，只有远端授权服务的响应用夹具。
- 本地证据保存在 `.git/pi100-review-20261004/`，不提交：`npm-audit.json`、`oauth-probes.json`、`lifecycle-probe.json`、`mcp-tests.log`。

## 2. 依赖安全

`npm audit --omit=dev` 报告 **6 个受影响的生产依赖包**：`brace-expansion`、`undici`、`fast-uri` 为 high，`hono`、`ip-address`、`qs` 为 moderate。都有不需要升主版本的修复。

- 统计单位是“包”，部分包涉及多个公告；尚未证明每个公告在 Super Pi 中都有可触发的利用路径。例如 Hono、Express 相关依赖经 MCP SDK 引入，需要区分客户端实际会走到的路径和服务端依赖。
- 固定 `brace-expansion` 5.0.12 是上游的**发布后修复**（`0495646a8`），v1.0.0 不包含。
- 处理方式：逐包升到兼容版本，更新锁文件，重新审计并跑相关回归。不使用 `npm audit fix --force`。

**PR 1 结果（`fix/prod-dependency-audit`）**：

| 包 | 引入路径 | 原版本 | 新版本 |
| --- | --- | --- | --- |
| `undici` | coding-agent 直接依赖（精确版本） | 8.9.0 | 8.11.2 |
| `brace-expansion` | coding-agent → minimatch `^5.0.5` | 5.0.9 | 5.0.12 |
| `fast-uri` | MCP SDK → ajv `^3.0.1` | 3.1.5 | 3.1.8 |
| `hono` | MCP SDK `^4.11.4` | 4.13.3 | 4.13.12 |
| `ip-address` | MCP SDK → express-rate-limit `^10.2.0` | 10.5.0 | 10.7.2 |
| `qs` | MCP SDK → express / body-parser `^6.15.2` | 6.15.3 | 6.16.0 |

- 除 `undici` 改了精确版本外，其余都在父包已声明的范围内更新，锁文件只改动这 6 项。
- 修复后 `npm audit --omit=dev` 为 0。
- 全量审计仍有 5 个 high，都只在开发依赖里，路径为 `shx@0.4.0 → shelljs → fast-glob → micromatch → braces`。npm 给出的唯一修复是把 `shx` 降到 0.3.4，属于主版本变化。`shx` 只在构建时处理固定的 glob（`copy-assets`），不接收不可信输入，所以本 PR 不处理，留待替换构建脚本时一并解决。
- 验证：`npm run check`、`npm run build:offline`、`git diff --check` 均退出 0；全量 `npm test` 共 219 个执行单元，3,258 项中 3,168 通过、90 跳过，失败为 0。

## 3. MCP OAuth

### 3.1 已复现的问题

复现路径为真实的 `McpOAuth.login`、SDK 授权流程、文件存储和本地 HTTP 回调；只有远端授权服务的响应使用夹具。

| 场景 | 当前结果 | 结论 |
| --- | --- | --- |
| 回调 `iss` 与预期授权服务器一致 | 登录成功 | 正常对照 |
| 回调 `iss` 指向另一个授权服务器 | **仍然登录成功，并完成令牌交换** | 缺陷 |
| 元数据声明支持 `iss`，回调却没有携带 | **仍然登录成功** | 缺陷，与上一项一起修 |
| 令牌响应 `scope: ""` | 登录成功 | 已兼容 |
| 令牌响应 `scope: null` | **登录失败，报 `invalid_type`** | 兼容缺陷 |
| 令牌响应 `expires_in: null` | **登录成功但令牌立即过期，再次取令牌要求重新登录** | 兼容缺陷 |

修复约束：

- `iss` 必须在**令牌交换之前**校验。回调带了 `iss` 时，必须与预期 issuer 精确一致；服务端元数据声明支持（`authorization_response_iss_parameter_supported`）而回调没带时，拒绝。不要求所有旧服务端都返回 `iss`。依据为 [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)。
- 空值兼容只针对**允许缺省的可选字段**，规范化为“未提供”。必填的令牌、授权服务器和凭据仍然严格校验。
- 原有的 `state` 校验、PKCE 和凭据隔离行为保持不变。入口在 `packages/mcp-bridge/src/oauth.js` 的回调接收和 `login` 流程。

### 3.2 能力差距（不属于安全修复，单独立项）

- **`oauth.authServerMetadataUrl`**：目前不能手动指定授权服务器的元数据地址。
- **`insufficient_scope` 之后的增量授权**：目前没有完整的挑战处理，也没有“已有 scope 加新增 scope”的流程。要作为一项完整能力来做，不能只移植上游合并 scope 的小函数。

## 4. 小型正确性修复

都已通过调用当前生产函数或真实扩展加载入口复现。

| 项目 | 当前结果 | 上游来源 | 位置 |
| --- | --- | --- | --- |
| `"Selected model is at capacity"` 重试 | 被判为不可重试 | **发布后修复** `3874b3e98` | `packages/ai/src/utils/retry.ts` |
| `--models a,b,` | 得到 `["a","b",""]` | **发布后修复** `9b3c19da5` | `packages/coding-agent/src/cli/args.ts:141` |
| ANSI 列切片顺序 | 红色 `A`、复位、再接 `B` 时，截取 `B` 得到的颜色序列顺序颠倒 | v1.0.0 `17f3dccbe` | `packages/tui/src/utils.ts:1325` 起 |
| 前导空格的斜杠命令补全 | `/he` 能补全，`  /he` 不能 | v1.0.0 `65117e31f` | `packages/tui/src/autocomplete.ts:326` |
| 扩展命令注册校验 | 名称不是字符串、缺少 handler、handler 不是函数，都被接受 | v0.99.2 `dc83372f8` | `packages/coding-agent/src/core/extensions/loader.ts:321` |

修复约束：

- ANSI 修复要适配 Super Pi 现有的切片实现，保留复用的工作对象；不要整体替换成上游版本而把分配带回来。这里是渲染热路径，按[热路径分配契约](performance/hot-path-allocation-contract.md)提供不变量检查、确定性计数和释放证据。
- 斜杠补全要同时检查前缀、命令名和参数的定位，不能只改判断条件。

## 5. MCP 生命周期（已复现）

- **未缓存的服务器阻塞启动**：扩展的 `session_start` 会等所有未缓存服务器连接并完成工具发现，`AgentSession` 又会等这个启动事件。夹具中工具发现有延迟时，`session_start` 确实被阻塞（50 ms 时仍未完成，总计约 492 ms）。最长等待是连接超时：默认 30 秒，配置上限 300 秒。上游 0.99.2 改为后台连接、按需等待。
- **reload 丢失通过搜索激活的工具**：用 `mcp_search_tools` 激活 `mcp__fixture__lookup` 后，再触发 reload，这个工具从活动集合里消失。reload 已复现；**会话恢复没有单独做端到端实验**，这个验证边界保留。

修复约束：保存“激活意图”，再根据新一代运行时的服务、配置和工具目录重新确认是否仍然有效。直接去掉 `deactivateRemoteTools` 会留下过期的工具。入口在 `packages/mcp-bridge/src/index.js:63`。

## 6. 已等价（不要重复做）

- Responses 重放 grammar 工具调用时的 `ctc_` 前缀校验
- `Retry-After` 无法解析时退回指数退避
- 识别 Z.AI 国内端点的上下文超长错误
- `--provider` 必须搭配 `--model`
- Anthropic strict 模式下会被拒绝的 schema 关键字（`anthropic-strict-schema.ts`）
- 远端模型目录线性合并（`model-catalog-merge.ts`）
- 只在 codemode 内可用的工具不进入系统提示
- codemode `image()` 的 base64 与图片签名校验
- 读取不存在的工具成员时提示相近名称
- 用户消息每行只保留一份渲染副本（没有外层 `Box`）
- MCP 凭据按服务器隔离

**划掉一条旧结论**：当前激活 MCP 工具已经不会把远端声明写进 Codemode 的内联描述，相应的稳定性测试也通过了。所以不能再说“激活 MCP 工具必然破坏提示缓存”。活动集合变化时，本地声明和运行时描述对象仍会重建，这是另一项可能的 CPU 和分配优化，尚未测出实际损失（`packages/coding-agent/src/core/codemode.ts:135`）。

## 7. 按既定边界不吸收

以下按 0.99.1 评估 §2.3 和 §5 确定的边界不吸收：

- `durable`、`chord`、`evals` 三个包
- Radius 一键登录、`models.generateImages()` 图片生成、Clef 分类器
- Anthropic 复制授权码登录（自管订阅 OAuth 已禁用）
- 默认全屏（Super Pi 保持 regular，全屏仍可选）、`quietStartup: "header"`、彩蛋

以下按需另行评估：

- Anthropic `inline-tools` beta：中途追加工具时不破坏 prompt 缓存，与暂缓的 D3 是同一个目标，需要把 SDK 升到 0.129。
- Anthropic workload identity federation：用环境变量做企业认证。

## 8. 后续独立评估（不混入本轮正确性修复）

- **Codemode 提示词精简**：在相同工具、模型和请求条件下，测量提示词长度和缓存稳定性后再决定。
- **长会话驻留内存**：测量堆占用、保留的引用和组件释放情况。Super Pi 已有增量 Markdown 缓存和主动释放机制，不能因为没有上游的 `WeakRef` 和字符串展平写法，就认定 Super Pi 的内存表现更差。
- **实验性 harness**：上游 v1.0.0 已从 agent-core 移除。Super Pi 中 `packages/agent/src/harness` 约 8.8k 行，仍通过 **agent-core 根导出和 `./node`** 对外暴露；`coding-agent/src/server/create-harness.ts` 没有任何引用；`packages/server` 和 `session-backends/sqlite-node` 在仓库内没有使用方。内部引用少只能说明值得评估清理，不能证明删除不影响外部使用者，也没有实测构建或启动收益，所以排在正确性修复之后。
- **MCP 工具名冲突**：只在大小写不同的冲突上报错，并让整个服务器注册失败。上游的做法是给冲突的工具加哈希后缀。现有行为是失败即关闭，不算缺陷，可以以后改善体验。

## 9. 拆分计划

| 顺序 | PR 范围 | 主要验收 |
| --- | --- | --- |
| 1 | 生产依赖修复 | 升到兼容版本、更新锁文件、重新审计、跑相关回归 |
| 2 | OAuth issuer 校验 | `iss` 错误或缺失时在令牌交换前拒绝；原有 `state` 和 PKCE 行为不变 |
| 3 | OAuth 兼容能力 | 可选字段空值、元数据地址覆盖、增量授权，各自有测试覆盖 |
| 4 | CLI、重试、扩展注册 | 三项小修复，各带针对性回归 |
| 5 | TUI 正确性 | ANSI 顺序、前导空格补全，附热路径检查 |
| 6 | MCP 启动与激活恢复 | 后台连接、按需等待、reload 和 resume 恢复，覆盖取消和代次边界 |

每项修复都要有一个修复前失败、修复后通过的最小回归，按现有执行日志的格式记录。

## 10. 本轮验证与边界

- 13 个 MCP 测试文件共 153 项通过；Codemode 描述稳定性测试通过；`npm run check` 和 `git diff --check` 通过。
- 没有运行全量测试和性能基准，没有修改生产代码（`bridge.js` 的 33 行清理除外，尚未提交），没有提交或推送；临时夹具已清理。
