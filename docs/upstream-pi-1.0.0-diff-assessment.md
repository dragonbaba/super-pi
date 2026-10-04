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
- 本批只处理 issuer 安全边界；可选字段空值另见 §3.3，元数据覆盖另见 §3.4，增量授权仍待后续批次。

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

### 3.5 剩余 OAuth 能力（单独立项）

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
| 2（已合并 #59） | OAuth issuer 校验（实现见 §3.2） | 发现、缓存与回调绑定同一 issuer；错误或必需 `iss` 缺失在令牌交换前拒绝；保留 `state` 和 PKCE |
| 3a（已合并 #60） | OAuth 令牌空值兼容（§3.3） | 可选字段缺省、刷新令牌保留、原校验边界与缓存重开 |
| 3b（本地实现） | OAuth 元数据地址覆盖（§3.4） | 配置入口、发现来源和 issuer 绑定，各有针对性回归 |
| 3c | OAuth 增量授权 | 挑战处理、scope 合并、完整重新授权流程 |
| 4 | CLI、重试、扩展注册 | 三项小修复，各带针对性回归 |
| 5 | TUI 正确性 | ANSI 顺序、前导空格补全，附热路径检查 |
| 6 | MCP 启动与激活恢复 | 后台连接、按需等待、reload 和 resume 恢复，覆盖取消和代次边界 |

每项修复都要有一个修复前失败、修复后通过的最小回归，按现有执行日志的格式记录。

## 10. 本轮验证与边界

- 审查阶段（基于 `7434ba7ab`）：13 个 MCP 测试文件共 153 项通过，Codemode 描述稳定性测试通过，`npm run check` 和 `git diff --check` 通过。这个阶段没有运行全量测试和性能基准，临时夹具已清理。
- 初版随本文提交的生产改动有两项：一是删除 `bridge.js` 中没有调用方的 `resultText()` 和 `appendMcpText()`，以及只被它们使用的 import，共 33 行；二是 §2 列出的依赖升级。该批全量验证结果见 §2。后续 issuer 修复见 §3.2，令牌空值兼容见 §3.3，元数据地址覆盖见 §3.4，其余候选尚未实施。
