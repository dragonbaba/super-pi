# Super Pi 对照 Pi v1.0.0：差异审查与后续拆分

> 本文记录审查结论、拆分计划及分批修复结果。历史复现与已完成修复分开列出；尚未实测的利用路径、性能收益和外部兼容影响，不写成已验证的结论。

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

| 场景 | 修复前的审查结果 | 结论 |
| --- | --- | --- |
| 回调 `iss` 与预期授权服务器一致 | 登录成功 | 正常对照 |
| 回调 `iss` 指向另一个授权服务器 | **仍然登录成功，并完成令牌交换** | 缺陷 |
| 元数据声明支持 `iss`，回调却没有携带 | **仍然登录成功** | 缺陷，与上一项一起修 |
| 发现目标与返回元数据的 `issuer` 不一致 | **仍然登录成功并保存凭据** | 基于 `6c21d11ed` 补充复现，官方 v1.0.0 已检查 |
| 令牌响应 `scope: ""` | 登录成功 | 已兼容 |
| 令牌响应 `scope: null` | **登录失败，报 `invalid_type`** | 兼容缺陷 |
| 令牌响应 `expires_in: null` | **登录成功但令牌立即过期，再次取令牌要求重新登录** | 兼容缺陷 |

修复约束：

- `iss` 必须在**令牌交换之前**校验。回调带了 `iss` 时，必须与预期 issuer 精确一致；服务端元数据声明支持（`authorization_response_iss_parameter_supported`）而回调没带时，拒绝。不要求所有旧服务端都返回 `iss`。依据为 [RFC 9207](https://www.rfc-editor.org/rfc/rfc9207)。
- 空值兼容只针对**允许缺省的可选字段**，规范化为“未提供”。必填的令牌、授权服务器和凭据仍然严格校验。
- 原有的 `state` 校验、PKCE 和凭据隔离行为保持不变。入口在 `packages/mcp-bridge/src/oauth.js` 的回调接收和 `login` 流程。

### 3.2 issuer 校验修复（基于 PR #58 合并后的 `6c21d11ed`）

- 新发现、缓存复用和缓存补全都在 SDK 使用元数据注册客户端或请求令牌前校验 issuer；失败不保存本次发现或新凭据。
- 回调在 `state` 检查后保留参数，完成 issuer 校验才交换授权码。声明支持而缺失、值不匹配、空值或重复 `iss` 都拒绝；错误回调也先检查 issuer，再报告授权拒绝。未声明支持的旧服务端仍可省略 `iss`。
- 发现阶段最终选择对齐官方 v1.0.0：两边各去掉至多一个尾斜杠再比较，显式地址、根地址和租户路径统一处理；不做其他 URL 归一化。不同主机、租户、大小写、百分号编码及去掉一个 `/` 后仍不同的标识继续拒绝。原有“SDK 补出根地址”的特殊分支已删除，辅助函数定义在模块级。
- 这是对 [RFC 8414 §3.3](https://www.rfc-editor.org/rfc/rfc8414.html#section-3.3) 精确比较要求的一项明确兼容取舍，依据官方 v1.0.0（`a13d35a742c6ef8462812a28fbe1d8c8b7431c32`）的 [`packages/mcp/src/oauth/discovery.ts:115–119`](https://github.com/earendil-works/pi/blob/v1.0.0/packages/mcp/src/oauth/discovery.ts#L115-L119)。保留元数据中的原始 issuer；回调 `iss` 与授权流程绑定仍按 [RFC 9207 §2.4](https://www.rfc-editor.org/rfc/rfc9207.html#section-2.4) 精确比较，不接受发现地址的尾斜杠别名。
- 授权开始时固定 issuer；SDK 遇到 `invalid_client` 后重新发现时，不能把已收到的授权码带到另一个 issuer。
- SDK 的 OIDC 发现 schema 会丢弃 `authorization_response_iss_parameter_supported`。有界响应在 SDK 请求的同一次 JSON 解析中仅记录 issuer 和支持标志，保存发现时恢复并校验标志，重开缓存后仍生效；没有第二次网络请求或 JSON 解析。
- 旧版已保存的元数据可能已经丢掉标志，因此以发现校验版本标记区分。旧缓存首次登录或刷新时重新发现授权服务器元数据，保留资源发现和客户端注册；成功保存后继续复用，不在每次登录重复请求。升级时无法取得元数据则拒绝，不降级成无元数据的旧服务端；失败保留旧凭据，允许再次尝试。
- 校验函数与路径正则定义在模块内，未新增动态正则、`String()` 或每次请求的观察闭包。改动位于登录、发现及令牌刷新流程；普通有效令牌读取、工具进度和渲染路径不变。没有引入对象池，也没有声称实测性能收益。
- 测试沿用 `mcp-oauth.test.ts` 的真实登录、SDK、文件存储和本地回调夹具，仅模拟远端响应。参数化覆盖差异，不复制整套夹具；成功、失败和重试后检查回调关闭、占位释放与旧凭据保留，目录按创建身份清理。
- 修复前新增的错误 issuer、必需 issuer 缺失、发现 issuer 不匹配三项回归全部失败；复核过程中新增的 OIDC 必需 issuer 缺失与旧 OIDC 缓存升级回归也先复现失败，再修复。
- 首批生产候选验证（补充固定 clientId 用例之前，Windows / PowerShell，Node 26.4.0）：`npm run check`、`npm run build:offline`、修改 JS 的 `node --check`、`git diff --check` 均通过。全量 `npm test` 的 220 个执行单元各执行一次且全部 exit 0；**3,305 项中 3,215 通过、90 跳过、0 失败**。该轮内 13 个 MCP 文件共 190 项通过，其中 OAuth 53 项。本地日志位于 `.git/oauth-issuer-validation-20261004/`。
- 计数更正：原报告的 3,306/3,216 多计了 `tool-result-budget-recovery.test.ts` 的测量子进程输出（`full-test-final.log:5056` 的 `# tests 1`）；该文件自己的最终汇总是第 5065 行的 `ℹ tests 10`。现在按每个执行单元末尾的汇总计数，220 项清单没有重复。`review-counts.mjs` 和 `review-counts.json` 保存算法、逐文件结果和内嵌汇总定位，未将历史局部测试加进总数。
- 复核补充：将 SDK 重试用例参数化为动态注册和固定 `oauth.clientId`，固定客户端使用实际预留后交给生产回调的端口。测试确认 SDK 已重新发现另一个 issuer，元数据也指向新的令牌端点；只向原端点发送一次授权码，且必须报 issuer 绑定的专用错误。
- 变异验证仅在独立 Node 进程的模块加载阶段移除 issuer 绑定，磁盘生产文件不变。两个用例都在错误信息断言处失败，此前的请求地址、次数和清理断言通过：动态客户端报客户端信息缺失，固定客户端报 `Missing MCP PKCE verifier`。因此当前实现还有 PKCE 清理这一层防护，不能声称“去掉 issuer 绑定后，固定客户端必然泄漏授权码”。证据见 `issuer-binding-mutation.log`。
- 固定 clientId 复核阶段仅补测试和文档，当时生产文件 SHA-256 与首批全量候选一致。该阶段 13 个 MCP 文件 **191/191** 通过，其中 OAuth **54/54**；类型、JS 语法和差异检查通过，未重跑全量或离线构建。前述全量数字对应 53 项 OAuth 的历史候选。
- 提交前的尾斜杠兼容调整改变了生产代码：新增根地址/租户地址两种方向、OIDC、发现成功但回调使用别名仍拒绝的六项回归；它们在调整前均失败，调整后通过。沿用参数化夹具覆盖缓存重登，另将原先的两个严格拒绝用例改为验证“只能去掉一个尾斜杠”。
- 提交候选重新验证（Windows / PowerShell，Node 26.4.0）：类型检查、JS 语法、离线构建和差异检查通过；同一候选的全量测试 **220 个唯一执行单元全部 exit 0，3,312 项中 3,222 通过、90 跳过、0 失败**。其中 13 个 MCP 文件 **197/197**，OAuth **60/60**。统计采用每个执行单元的最终汇总，排除内嵌测量汇总；证据为 `full-test-commit-candidate.log`、`build-commit-candidate.log`、`commit-candidate-summary.json`（含生产/测试文件 SHA-256）。
- 合并复核：PR [#59](https://github.com/dragonbaba/super-pi/pull/59) 的最终提交 `bd4459aeed` 已通过六个 CI 分片（Linux 两片、Windows 四片，均为 Node 22.19.x），Codex 对该提交未发现主要问题；普通合并提交为 `58bbc4451`，本地与远端 `main` 已同步，旧分支已删除。仍未连接真实外部 OAuth 服务；端到端测试使用本地回调和远端响应夹具。运行器正常完成各自拥有目录的清理，没有清扫共享系统临时目录或历史输出日志。
- 其余兼容/体验边界保持：无元数据的旧服务端若返回裸 origin 的 `iss`，与 SDK 补出的带 `/` 根标识不同仍拒绝；浏览器页面只提示返回 Super Pi，最终错误在终端显示，不表示授权成功。
- 本批只处理 issuer 安全边界；可选字段空值另见 §3.3，元数据覆盖另见 §3.4，增量授权另见 §3.5。

### 3.3 令牌可选字段空值兼容（基于 PR #59 合并后的 `58bbc4451`）

- 实现分支 `codex/mcp-oauth-token-compat`，仅处理令牌响应兼容。官方依据为 v1.0.0 的 `packages/mcp/src/oauth/types.ts` 中 `absent`、`optionalString` 和 `parseOAuthTokens`。
- 四个可选字段 `scope`、`expires_in`、`refresh_token`、`id_token` 的 `null` 和空字符串统一视为缺省。原本 `scope: ""` 已可登录，本批只把它的保存形式对齐为缺省；空的刷新令牌不再覆盖已有刷新令牌，空的有效期不再被 SDK 转成零。真正的 `expires_in: 0` 仍按过期处理，数字字符串仍由 SDK 转换。
- 在 SDK 请求的同一次 `Response.json()` 中把这四个字段的空值设为 `undefined`，交给原有 SDK schema 校验，存盘时由现有序列化省略；不修改必填字段，也不修正其他错误类型。只识别 SDK 发出的 `POST` + `URLSearchParams` 授权码/刷新请求的成功响应，不依赖令牌端点路径。元数据、客户端注册及错误响应保持原样，issuer 校验、`state`、PKCE、响应大小限制与凭据隔离保持原行为。
- 既有差异留待单独处理：SDK 1.30 对 `token_type` 只要求字符串，因此 `token_type: ""` 仍可被接受；官方 v1.0.0 要求非空。本批不改变这项必填字段校验，也不把它列为已经覆盖的拒绝场景。
- 新增模块级字段清单和响应类，沿用有界响应封装；无额外网络请求、JSON 解析或重新序列化，也没有新增逐请求处理闭包、动态正则、`String()` 或对象池。变更仅在 OAuth 登录/刷新流程，未改普通有效令牌读取等热路径；没有宣称实测性能收益。
- 复用现有真实 `McpOAuth`、SDK、文件存储与本地 HTTP 回调夹具，远端响应可配置；覆盖非 `/token` 端点、登录后重开缓存、刷新时保留旧刷新令牌、无刷新令牌的缓存使用、零有效期与数字字符串、错误响应不能替换旧凭据以及其他 OAuth 响应不被规范化。夹具按创建身份清理目录，成功与失败回调均验证关闭，不复制夹具或新增测试执行单元。
- 修复前运行新增的 22 项集成回归：11 项失败、11 项对照通过；失败包括三类可选字符串 `null`、空有效期和刷新令牌保留。空字符串的“保存为缺省”断言失败不等同于原本不能登录。证据为 `.git/oauth-token-compat-20261004/before.log`。
- 第一轮全量被源码不变量检查拦下：初版用了属性 `delete`。改为赋值 `undefined` 后，OAuth 与源码不变量联合检查 87/87 通过，重新构建并完整重跑全量；首次失败日志单独保留为 `full-test-attempt1.log`，不与最终结果拼接。
- 最终候选验证（Windows / PowerShell，Node 26.4.0）：`npm run check`、修改 JS 的 `node --check`、`npm run build:offline` 和 `git diff --check` 均通过。全量 **220 个唯一执行单元全部 exit 0，3,335 项中 3,245 通过、90 跳过、0 失败**；其中 13 个 MCP 文件 **220/220**，OAuth **83/83**。逐单元名称与运行器 `--list` 完全一致，仅统计各单元最后的汇总，排除内嵌测量子进程的重复计数；运行器临时目录清理正常完成。
- 证据保存在 `.git/oauth-token-compat-20261004/`：`focused-final.log`、`build-final.log`、`full-test.log`、`summarize.mjs` 和 `summary.json`（逐单元清单、去重计数、生产与测试文件 SHA-256）。当时尚未运行 GitHub CI、Linux / Node 22.19 或真实外部 OAuth 服务；合并前的 CI 结果见下条。PR #59 的 CI 不作为本批候选验证。
- 合并复核：PR [#60](https://github.com/dragonbaba/super-pi/pull/60) 的最终提交 `a574f2298` 已通过六个 CI 分片（Linux 两片、Windows 四片，Node 22.19.x），普通合并提交为 `87aa1a120`；本地与远端 main 同步，旧分支已删除。此处补充前述本地候选之后的 CI 结果，真实外部 OAuth 服务仍未验证。

### 3.4 手动指定授权服务器元数据地址（基于 PR #60 合并后的 `87aa1a120`）

- 实现分支 `codex/mcp-oauth-metadata-url`。新增 HTTP/SSE 配置 `oauth.authServerMetadataUrl`，支持 HTTPS 和回环 HTTP，拒绝 URL 凭据、片段、非法类型和超长值；规范化后的配置继续参与原有凭据身份哈希。改变或移除该项需要重新登录，不复用其他配置的凭据。用法见 [MCP Bridge README](../packages/mcp-bridge/README.md)。
- 官方依据：v1.0.0 的 `packages/coding-agent/src/core/mcp-servers.ts` 和 `packages/mcp/src/oauth/discovery.ts`。指定的是完整元数据文档地址，不是 issuer 或授权页面；文档视为显式配置的可信来源，首次 issuer 取文档中的原始值，不与文档地址或资源元数据公布的错误授权服务器比较。仍校验 issuer 的安全 URL 形式、元数据 schema 和支持标志；回调按原样精确比较。
- SDK 1.30 没有该配置入口，因此通过其异步 `discoveryState` 接口加载并提供已校验的发现结果；SDK 仍负责资源元数据发现、资源匹配和 scope 选择。只覆盖授权服务器元数据来源，不改 SDK 或拦截伪装默认发现地址。指定地址出现网络/HTTP 错误、非法 JSON、非法元数据或超限时拒绝，不回退默认授权服务器发现。
- 完整缓存继续复用，不在每次读取令牌或刷新时联网加载元数据；缺少元数据或校验版本陈旧时从指定地址补全，并保留缓存 issuer，拒绝把已有凭据带给变化后的 issuer。SDK 的 `invalid_client` 重试会重新经过该入口，动态注册和固定客户端都受原登录 issuer 绑定保护。OIDC 支持标志在任意文档路径上保留，失败不覆盖旧凭据。
- 缓存复用是有意区别于官方 v1.0.0 的取舍：官方 `packages/mcp/src/oauth/flow.ts` 在指定元数据 URL 时不读写发现缓存，每次授权流程重新获取文档；我们复用已校验的元数据，减少请求并保持缓存 issuer 绑定。代价是服务端接口地址变化不会自动生效，同一配置下再次 `/mcp-login <server>` 也仍复用完整缓存；需要先 `/mcp-logout <server>` 再登录，或更新元数据 URL 配置并登录。新增此配置会改变凭据标识，因此旧版本的普通发现缓存不会自然落入该命名空间；缺失元数据或校验版本的补全分支保留为防御处理。
- 沿用有界 OAuth fetch：1 MiB、超时/取消、禁止重定向、不继承 MCP 请求头。加载函数和请求头对象置于模块内，无动态正则、`String()` 或对象池；不增加第二次 JSON 解析。变更处于配置和 OAuth 登录/刷新冷路径，未改普通有效令牌读取、工具进度或渲染路径，没有宣称实测性能收益。
- 测试复用现有登录、SDK、真实本地回调和文件存储夹具；远端响应由夹具提供。三个先行回归（错误发现、无资源发现、配置字段）在修复前全部失败。补充覆盖自定义/OIDC 路径、HTTP/SSE 配置、资源/scope 保留、回调拒绝、缓存重开和修复、刷新与重发现 issuer 绑定、HTTP/JSON/schema/大小失败、取消、凭据隔离和请求头隔离。夹具按创建身份清理，不增加测试执行单元。
- 最终候选验证（Windows / PowerShell，Node 26.4.0）：`npm run check`、修改 JS 的 `node --check`、`npm run build:offline`、源码不变量与 `git diff --check` 均通过。同一候选的全量 **220 个唯一执行单元全部 exit 0，3,360 项中 3,270 通过、90 跳过、0 失败**；其中 13 个 MCP 文件 **245/245**，OAuth **108/108**。实际执行单元与运行器清单一致，没有重复或遗漏；仅统计各单元末尾汇总，排除内嵌测量子进程的重复计数。运行器正常清理，按日志记录的本次临时目录身份复查也确认不存在。
- 证据位于 `.git/oauth-metadata-url-20261004/`：`before.log`、`focused-final.log`、`build.log`、`full-test.log`、`summarize.mjs` 和 `summary.json`（逐单元清单、去重计数、配置/运行时/测试文件 SHA-256）。本批尚未运行 GitHub CI、Linux / Node 22.19 或真实外部 OAuth 服务，PR #60 的 CI 不作为本批候选验证。

- 合并复核：PR [#61](https://github.com/dragonbaba/super-pi/pull/61) 的最终提交 `b0af2fce0` 已通过六个 CI 分片（Linux 两片、Windows 四片），普通合并提交为 `b22cb52b6`；开始下一批前已核对本地 main 与 origin/main 一致、工作区干净、旧分支已删除。真实外部 OAuth 服务仍未验证。

### 3.5 权限不足后的显式增量授权（基于 PR #61 合并后的 `b22cb52b6`）

- 实现分支 `codex/mcp-oauth-scope-step-up`，提交为 `48cc61918` 并开 PR [#62](https://github.com/dragonbaba/super-pi/pull/62)；Codex 审查后的修复见 §3.5.2。官方依据是 v1.0.0 的 `packages/mcp/src/oauth/flow.ts` 中 `stepUpScope`、缺省 token scope 的保存，以及 coding-agent OAuth provider 的挑战记录与显式登录流程。本批不处理 `token_type: ""`。
- HTTP/SSE 请求遇到 401/403 的 Bearer `insufficient_scope` 时，记录需求并报告 `authorization-required`，由用户执行 `/mcp-login <server-id>`。授权页面的 scope 合并配置、旧令牌授予和挑战需求，保序、区分大小写并去重。该分支不刷新令牌、不自动打开浏览器、不重放被拒工具；没有此挑战的普通 401 保持最多一次刷新/重试，普通 403 不触发重新授权。
- 待授权 scope 保存在原凭据身份下，支持命令创建新 owner 和会话重开。写入时在文件锁内合并；带旧 access token 的迟到响应不能改写已经换 token 或登出的条目。授权中收到的新需求继续保留，拒绝或取消不覆盖旧凭据和需求。成功登录清除本次已消费的提示，logout 清除整个条目；提示没有单独 TTL，最多 4,096 字符。相同 access token 的重复提示不重复写文件。
- 提示不是授权凭据。响应明确给出的 token scope 优先，即使比请求窄；没有给 scope 时保存实际授权 URL 中的请求值，刷新响应缺省时保留旧 grant。挑战缺少 scope 时也提示显式登录，使用已知 scope。没有先前凭据也能记录需求供首次登录使用，不能因此生成令牌。
- 新模块集中保存正则和上限：挑战解析最多 8,192 字符，scope 合并最多 4,096 字符；区分其他认证方案、引号内逗号和转义，不把重复关键字段、歧义、损坏字段或超长头作为增量授权依据。解析失败时回到原状态码处理，401 最多刷新/重试一次，403 原响应交回 SDK，不保存该头的 scope 需求。只消费 scope，不跟随挑战里的 `resource_metadata` 切换发现来源；这是本批与上游完整挑战发现能力的明确边界。原资源匹配、issuer 绑定、元数据地址覆盖、PKCE、state 与回调检查不变。
- SSE 的 EventSource 会丢失原异常类型，因此连接阶段从该 transport 独占的 fetch 函数读取布尔标记；连接成功、失败或关闭都释放额外引用。运行中的 HTTP 工具调用保留固定错误类别，诊断不暴露挑战正文、scope 或令牌。Request 的备用请求体在首发、刷新或重试失败时均释放，保留原异常对象。OAuth 文件操作同时支持 Request 自带和 init 提供的取消信号；收到挑战之后取消，也不能继续保存提示。
- 回归复用 OAuth 夹具，不新建测试执行单元：真实 loopback MCP 请求、SDK HTTP 连接/工具调用、SSE 连接、生产 `/mcp-login`、文件锁与回调均有覆盖。包括跨 owner 合并、授权中新增需求、拒绝/取消、登录和登出后的迟到响应、首次登录、配置隔离、普通响应不改变提示文件、元数据覆盖、较窄 grant、缺省 grant、重试上限与流取消。先行两个生产回归在未修复时失败；新增测试还复现了损坏挑战尾段被接受、SSE 丢失错误类别、重试失败后请求体未释放和 Request 自带取消信号未传到提示事务，修复后通过。
- 性能边界：审计了 fetch → transport → runtime → `McpCall`/结果转换链。新增解析、Set/数组和文件事务仅发生在认证失败或显式登录边界，普通成功请求不解析挑战、不写提示；分块响应限制、progress 通知和大结果转换未改。模块级正则和清理回调复用，没有动态正则、`String()` 或对象池，没有增加每块/每次 progress 分配。认证失败时使用有界冷路径对象，不宣称吞吐提升。
- 首轮实现验证（复审前候选，Windows / PowerShell，Node 26.4.0）：`npm run check`、4 个修改/新增 JS 的 `node --check`、`npm run build:offline` 和 `git diff --check` 通过。MCP 与源码不变量联合 **287/287**；该候选全量 **220 个唯一执行单元全部 exit 0，3,398 项中 3,308 通过、90 跳过、0 失败**，其中 13 个 MCP 文件 **283/283**，OAuth **146/146**（当时新增 38 项）。逐单元核对运行器清单无重复或遗漏，排除内嵌测量子进程的重复统计；没有清理失败，日志里记录的本次临时根目录已确认不存在。取消信号补修后已重新完整运行；下述复审再次更新了候选，不能用本段替代其验证结果。
- 现有 `mcp-output-bounds` 的 allocation、gc 和 timing 模式均退出 0；mixed 场景计数保持 100 次 progress、1 个 artifact、4 个 continuation、1 个 source entry，受控 GC 的 9 个 WeakRef 均释放（retained 0）。这是未改动的结果/进度链回归证据，不是新增挑战解析的性能收益或真实授权服务测试。新增请求边界回归确认：scope 拒绝只发 1 次请求、0 次刷新；普通 401 后遇到 scope 拒绝总计 2 次请求、1 次刷新；每个失败上传底层流只取消 1 次，连接失败或 runtime 关闭清空 client/transport/oauth/connectFetch，activeCalls 为 0。
- 证据在 `.git/oauth-scope-step-up-20261004/`：`before.log`、`expanded.log`、`integration.log`、`sse-before.log`、`cancel-before.log` 记录失败回归，`focused-final.log`、`check.log`、`build.log`、`full-test.log` 为最终验证，`summarize.mjs` / `summary.json` 保存逐单元汇总和源码/测试 SHA-256，`cleanup.json` 保存按身份复查结果，`allocation.log`、`gc.log`、`timing.log` 保存基准。当时尚未提交、推送或创建 PR；GitHub CI、Linux / Node 22.19 与真实外部 OAuth 服务尚未验证，PR #61 的 CI 不作为本批候选结果。

#### 3.5.1 复审：恢复畸形挑战头下的普通 401 重试

- 已复现回归：`fetchWithHeaders` 在判断普通 401 刷新前直接调用严格解析器，未闭合引号、无法识别的非 scope 参数和超过 8,192 字符的头都会抛错，因此只发出一次请求、没有刷新。此前仅覆盖了 scope 语法拒绝，缺少状态码回退的端到端回归。
- 修复只包住同步挑战解析。解析失败后仍按 401/403 处理；只有能成功识别的 `insufficient_scope` 才记录需求并提示显式授权。文件存储、刷新、取消及网络错误不在这个 catch 范围内，继续传播原异常。成功响应与进度/结果处理链不变；没有新增闭包、正则或可复用对象。
- 新增 17 项检查复用生产 OAuth owner、文件存储和 loopback HTTP 夹具，不增加执行单元。15 项覆盖未闭合 realm、错误参数、超长 realm、未闭合 scope、重复 scope，各验证 401→200、401→401 和 403→403；检查请求体、令牌轮换、最多一次刷新、响应状态/头/正文保留、不写无效提示。另 2 项验证 scope 保存和刷新存储失败仍抛出原异常。修复前 16 项失败、1 项通过，修复后 17 项全部通过；原有效挑战、并发/取消、SSE 与真实命令入口回归继续运行。
- 再次核对了 token 一致性检查、锁内 scope 合并、授权前保存旧 grant、登录提交时保留新增需求、缺省/较窄 scope、请求体清理与 runtime 引用释放，未发现其他阻塞问题。保留一项已知体验差异：普通 401 且没有刷新令牌时，HTTP 连接识别为 `authorization-required`，SSE 因 EventSource 丢失异常类型仍为 `protocol-error`；SSE 补救标记目前只记录已确认的 scope 挑战，本次不扩大修复范围。
- 本轮最终候选验证（Windows / PowerShell，Node 26.4.0）：`npm run check`、4 个 JS 的语法检查、`npm run build:offline`、`git diff --check` 全部通过。MCP 与源码不变量联合 **304/304**；全量 **220 个唯一执行单元全部 exit 0，3,415 项中 3,325 通过、90 跳过、0 失败**，其中 13 个 MCP 文件 **300/300**，OAuth **163/163**。按各执行单元最后汇总计数，排除内嵌子进程重复，清单无遗漏或重复；日志记录的本轮临时根目录已清理。
- 与上一候选的 SHA-256 对照确认，生产修改只涉及 `bridge.js`；`oauth.js`、`oauth-scope.js`、`call.js` 和 `config.js` 均未变化。本轮没有重跑性能基准，前一候选数据保留为历史证据，不能当作本次新测量。GitHub CI、Linux / Node 22.19 与真实外部 OAuth 服务仍未验证。
- 证据另存 `.git/oauth-scope-step-up-review-20261004/`：`before.log` / `after.log` 保存新增回归的修复前后结果，`focused-final.log`、`check.log`、`build.log`、`full-test.log` 保存最终验证，`summarize.mjs` / `summary.json` 保存逐单元清单、计数和源码/测试 SHA-256，`cleanup.json` 保存临时根目录按身份复查结果。保留前一候选日志供对照。该候选随后提交为 `48cc61918` 并开 PR #62。

#### 3.5.2 PR #62 审查：增量授权时更新动态注册客户端

- PR #62 的 CI 六个分片通过，Codex 在 `48cc61918` 上提出两条意见。
- P1（已修复）：动态注册会把当时的 scope 一并登记，RFC 7591 把它定义为该客户端可申请的范围。原实现在增量授权时沿用已缓存的动态客户端，SDK 1.30 因此跳过注册，只扩大授权请求；严格执行登记范围的授权服务器会拒绝每次扩权。官方 v1.0.0 的 `signInMcpServer` 同样在回调地址不变时保留客户端，本项是对官方行为的加强。
- 修复：`login()` 处理待授权需求时，若未配置固定 `clientId`，且已登记 scope 没有覆盖本次请求（注册响应未返回 scope 视为未覆盖），只在登录草稿中移除客户端，由 SDK 按合并后的 scope 重新注册。固定 `clientId` 和已覆盖的动态客户端不变；拒绝或取消时文件中的旧客户端和令牌保留，授权服务器上可能多出一个未使用的注册。判断函数 `scopeCovers` 位于 `oauth-scope.js`，只在显式登录时运行。
- 新增 4 项回归：较窄登记和未记录登记的动态客户端重新注册并登记合并后的 scope；已覆盖的动态客户端和固定 `clientId` 不重新注册。修复前前两项失败、后两项通过。原“缺省 token scope”用例的首个客户端只登记了 `tools.read`，期望注册次数随之由 1 改为 2；拒绝授权保留旧条目的原有用例继续通过。
- P2（不改代码，记录边界）：迟到响应只按 access token 文本判断是否过期。若重新登录后服务器恰好返回相同的 access token，旧需求可能写入新条目。`pendingScope` 只在下一次用户显式 `/mcp-login` 时扩大申请的 scope，不阻止工具调用、不强制登录，最坏结果是下次登录多申请已授予的 scope；引入登录代际标记需要改动令牌读取到请求的整条链，本批不做。
- 修复验证（Windows / PowerShell，Node 26.4.0）：`npm run check`、`npm run build:offline`、修改 JS 的 `node --check` 和 `git diff --check` 通过。全量 **220 个唯一执行单元全部 exit 0，3,419 项中 3,329 通过、90 跳过、0 失败**；13 个 MCP 文件 **304/304**，OAuth **167/167**。执行单元与运行器清单一致，只统计各单元末尾汇总。同一改动在提升权限的 Git Bash 下运行时，`native-file-metadata` 的两项 Windows ACL 拒绝用例因管理员权限不会被拒绝而失败；该文件不涉及 MCP，普通 PowerShell 下通过。本轮没有重跑性能基准；改动只在显式登录路径。
- 合并复核：PR [#62](https://github.com/dragonbaba/super-pi/pull/62) 最终提交 `042a8893d` 的六个 CI 分片（Linux 两片、Windows 四片）全部成功，普通合并提交为 `f206b4087`。开始下一批前已核对本地 main 与 origin/main 一致、工作区干净、旧分支已删除。OAuth 计划 3a/3b/3c 已合并；真实外部服务未验证，`token_type: ""` 和 §3.5.1 的 SSE 普通 401 提示差异继续保留为独立后续项。

## 4. 小型正确性修复

都已通过调用当前生产函数或真实扩展加载入口复现。

| 项目 | 修复前复现 | 上游来源 | 位置 |
| --- | --- | --- | --- |
| `"Selected model is at capacity"` 重试 | 被判为不可重试 | **发布后修复** `3874b3e98` | `packages/ai/src/utils/retry.ts` |
| `--models a,b,` | 得到 `["a","b",""]` | **发布后修复** `9b3c19da5` | `packages/coding-agent/src/cli/args.ts:141` |
| ANSI 列切片顺序 | 红色 `A`、复位、再接 `B` 时，截取 `B` 得到的颜色序列顺序颠倒 | v1.0.0 `17f3dccbe` | `packages/tui/src/utils.ts:1325` 起 |
| 前导空格的斜杠命令补全 | `/he` 能补全，`  /he` 不能 | v1.0.0 `65117e31f` | `packages/tui/src/autocomplete.ts:326` |
| 扩展命令注册校验 | 名称不是字符串、缺少 handler、handler 不是函数，都被接受 | v0.99.2 `dc83372f8` | `packages/coding-agent/src/core/extensions/loader.ts:321` |

修复约束：

- ANSI 修复要适配 Super Pi 现有的切片实现，保留复用的工作对象；不要整体替换成上游版本而把分配带回来。这里是渲染热路径，按[热路径分配契约](performance/hot-path-allocation-contract.md)提供不变量检查、确定性计数和释放证据。
- 斜杠补全要同时检查前缀、命令名和参数的定位，不能只改判断条件。

### 4.1 PR 4：CLI、重试与扩展命令注册（基于 `f206b4087`）

- 实现分支 `codex/cli-retry-extension-validation`，本地候选待复核；本批不进入 TUI 或 MCP 后台启动，也不处理剩余 OAuth 项。
- `--models` 在原有逗号分隔和 trim 后过滤空项，保留非空模式的顺序、重复值、glob、provider/model 与 thinking 后缀；全空参数得到空数组。生产 `parseArgs` → `resolveModelScopeFromModels` 回归确认尾逗号原本会把无关模型加入轮换列表，修复后只保留明确选择的模型。依据上游发布后提交 `9b3c19da5`，不算 v1.0.0 已包含。
- 共享重试分类器新增 `model is at capacity`，沿用模块初始化时编译、忽略大小写的固定正则；不使用泛化的 `capacity` 匹配。原有 quota/billing/停用认证等不可重试判断仍优先，重试次数、退避、取消以及成功/中止消息处理不改。生产 `retryAssistantCall` 验证成功重试、预算耗尽和取消，结束时 AbortSignal 监听器为零。依据上游发布后提交 `3874b3e98`；`AgentSession` 的上下文溢出、图像与请求预算拦截仍在共享分类器之前执行。
- 扩展命令在写入 Map 前要求非空字符串名称和函数 handler；错误包含扩展来源与命令上下文，让加载器按现有失败路径给出诊断。校验对齐 v0.99.2 的 `dc83372f8`，不额外 trim 名称、不增加命名格式限制。对齐之外补上加载器字段所有权：展开 options 后固定 name/sourceInfo，并保存已验证的 handler，防止 JavaScript 的额外字段覆盖最终注册项。本地回归已复现 options.name 覆盖为数字的情况。无效替换不覆盖原命令，初始化失败不提交暂存 flag 并解除事件订阅，某个文件失败不阻止后续合法扩展加载。
- 性能边界：检查了 `parseArgs` → 模型范围解析、错误消息 → 重试分类/预算/退避、扩展 factory → 注册 → commit/discard 三条链。修改位于 CLI 启动、错误重试和扩展注册边界，没有修改 provider delta、事件投递、渲染或大结果处理。重试正则仍只在模块初始化构造；不引入按错误重建的正则、`String()` 或对象池。注册校验只增加原始值判断和局部引用，合法注册仍只创建原有的命令描述对象；CLI 使用与现有工具列表参数一致的过滤写法，不宣称启动或吞吐收益。
- 首轮 4 个测试文件 42 项中，修复前 26 项失败、16 项通过，修复后 42 项全部通过。CLI/模型范围回归复用既有测试文件，新增独立的 provider retry policy 与 extension command registration 测试文件，不复制旧用例。文件夹具在写入前登记清理并支持 Windows 文件占用重试；运行时按实例 invalidate 释放订阅，不扫描或清理共享临时目录。
- 最终候选验证（Windows / PowerShell，Node 26.4.0）：`npm run check`、`npm run build:offline`、3 个修改 TS 及 4 个测试文件的 `node --check`、`git diff --check` 均通过。11 个相关测试文件（含源码不变量、流处理与内置扩展检查）**75/75**；同一候选全量 **222 个唯一执行单元全部 exit 0，3,450 项中 3,360 通过、90 跳过、0 失败**。本批新增 31 项测试、2 个执行单元。按单元最后汇总计数，排除内嵌子进程重复，实际清单无重复或遗漏；本次日志记录的临时根目录已确认不存在。本轮没有运行分配或计时基准，不把未测量的性能写成收益。
- 证据在 `.git/cli-retry-extension-20261004/`：`before.log` / `after.log` 保存修复前后结果，`focused-final.log`、`check.log`、`build.log`、`full-test.log` 保存最终检查；`summarize.mjs` / `summary.json` 保存逐单元清单、去重汇总及三个生产文件和四个测试文件的 SHA-256，`cleanup.json` 保存临时根目录按身份复查结果。本地候选验证时尚未提交、推送或创建 PR；GitHub CI、Linux / Node 22.19 尚未验证。PR 开启时由 Codex 自动审查；之后推送修复到已开 PR，由助手评论 `@codex review`，用户决定合并时机。

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
| 2（已合并 #59） | OAuth issuer 校验（实现见 §3.2） | 发现、缓存与回调绑定同一 issuer；错误或必需 `iss` 缺失在令牌交换前拒绝；保留 `state` 和 PKCE |
| 3a（已合并 #60） | OAuth 令牌空值兼容（§3.3） | 可选字段缺省、刷新令牌保留、原校验边界与缓存重开 |
| 3b（已合并 #61） | OAuth 元数据地址覆盖（§3.4） | 配置入口、发现来源和 issuer 绑定，各有针对性回归 |
| 3c（已合并 #62） | OAuth 增量授权（§3.5） | 挑战处理、scope 合并、完整显式重新授权流程 |
| 4（本地实现） | CLI、重试、扩展注册（§4.1） | 三项小修复，各带针对性回归 |
| 5 | TUI 正确性 | ANSI 顺序、前导空格补全，附热路径检查 |
| 6 | MCP 启动与激活恢复 | 后台连接、按需等待、reload 和 resume 恢复，覆盖取消和代次边界 |

每项修复都要有一个修复前失败、修复后通过的最小回归，按现有执行日志的格式记录。

## 10. 本轮验证与边界

- 审查阶段（基于 `7434ba7ab`）：13 个 MCP 测试文件共 153 项通过，Codemode 描述稳定性测试通过，`npm run check` 和 `git diff --check` 通过。这个阶段没有运行全量测试和性能基准，临时夹具已清理。
- 初版随本文提交的生产改动有两项：一是删除 `bridge.js` 中没有调用方的 `resultText()` 和 `appendMcpText()`，以及只被它们使用的 import，共 33 行；二是 §2 列出的依赖升级。该批全量验证结果见 §2。后续 issuer 修复见 §3.2，令牌空值兼容见 §3.3，元数据地址覆盖见 §3.4，增量授权见 §3.5，CLI/重试/扩展注册见 §4.1，其余候选尚未实施。
