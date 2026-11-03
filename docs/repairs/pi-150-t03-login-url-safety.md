# T03 — 登录 URL 与终端控制字符

日期：2026-11-03。状态：**先写入本方案，再增加失败用例并实施；本地验收通过，待远端验收与合并**。基线为 #178 合并后的 `57e623a2840a1709d0aad92fdd380f5cf78e7367`；分支 `codex/t03-login-url-safety`。本项遵循[总方案](../upstream-pi-1.5.0-implementation-plan.md)和[性能契约](../performance/hot-path-allocation-contract.md)，只用当前 Node 26.13.0 验收。

## 1. 问题、范围与复现计划

`LoginDialogComponent.showAuth()`、`showDeviceCode()`、`showInfo()` 将外部 URL 直接写入 OSC 8；`showAuth()` 还直接交给平台 launcher。文案、设备码和标签也直接进入允许 ANSI 的 Text。无 shell 的 launcher 不能替代协议/终端边界校验。

在现有 `tests/login-url-copy.test.ts` 中先增加失败用例：拦截 `child_process.spawn`，验证本地文件、自定义协议、相对地址、畸形 URL 和原始 C0/DEL/C1 被拒绝，未启动 launcher、未设置复制目标；验证原始控制串不能进入渲染。只用 `.invalid`/loopback 夹具，不打开真实浏览器，不使用真实认证。

范围限定在登录对话的 URL 和文本接收入口；不调整 provider 协议、MCP secureUrl/issuer 校验、通用扩展 selector、通用 Text/Markdown 或 SDK 宿主自定义 UI。`showDetails()` 的唯一生产调用者传入应用自己加色的 AWS 说明，保留其受信任的预格式化语义。

## 2. 完整调用链与最小设计

1. `/login` → `InteractiveMode.showLoginDialog/showApiKeyLoginDialog` → `loginProvider` → `ModelRuntime.login` 的已有凭据串行队列 → `Models.login` → provider `AuthInteraction.notify/prompt`。
2. `notifyAuthDialog` 先检查 active dialog 身份，再进入 `showAuth/showDeviceCode/showInfo/showProgress`；文本/手工 prompt 进入 `showPrompt/showManualInput`。只在这些低频登录事件入口处理外部数据。
3. 同文件局部 URL helper 先拒绝原始 C0/DEL/C1，再用 `URL.parse()` 解析一次，只允许绝对 `http:`/`https:`。返回序列化的 `href`，同一值进入可见 URL、OSC 8、复制目标和 launcher。不解码 `%xx`，不加域名白名单，不限制 HTTP 为 loopback，不更改通用打开文件能力。
4. 非法输入抛出固定错误文案，不把原始 URL 拼进错误，不改为主页或另一个 launcher。现有 login catch 显示失败，finally 清理复制目标；provider 的 notify 异常沿原 Promise 传播，失败不能落成登录成功或保存凭据。
5. 同文件局部文本 helper 使用 Node `stripVTControlCharacters` 移除完整终端序列，再规范化 CRLF/CR 为 LF，移除剩余 C0/DEL/C1（保留 LF 和 TAB，TAB 由现有 Text 处理）。在加 theme 色之前调用，覆盖标题、instructions、device userCode、info message/label、manual/prompt/placeholder、waiting/progress。不清理应用生成的 OSC 8/颜色串，不进入 `render()`。
6. auth/device 在修改显示/复制状态前完成解析；info 在添加对应链接前逐个解析，错误由现有登录 owner 关闭对话，不为多链接列表增加事务副本。链接信息不自动启动浏览器；设备码链接保持原来的手动打开语义；已有复制失败提示、单次在途复制和取消语义不变。

[WHATWG URL 标准](https://url.spec.whatwg.org/#concept-basic-url-parser)允许一些原始控制字符在解析时被忽略，因此不能只验证解析后的字符串；这也是前置控制字符检查与解析各自负责的边界。

## 3. 所有权、性能与不过度防御

- 登录事件不是 assistant/tool progress。精确低频范围为 constructor、上述 show* 方法和显式 copy 命令；不按整个类豁免普通 `handleInput()`。
- 已审计后续链：入口创建 Text/Spacer → `Container` 持有组件 → `requestRender` 的既有合并请求 → `scheduleRender/performRender` → Text 的现有缓存与 wrap → `TerminalFrameQueue.submit` → 终端写入。下游方法不修改，不按帧重跑解析或文本清理。
- 每个接收的 URL 原始控制检查一次、解析至多一次；多个 OSC 展示、重复 render、普通按键、复制均复用结果。有效事件新增一个临时 URL 对象和必要的规范化字符串；无新增 Promise、AbortController、timer、wrapper、cache、pool 或在途操作。
- 对话保留已有 `authUrl`/`authUrlHint` 两个槽位。替换后旧 Text 由 Container.clear 释放；完成/错误沿 `clearAuthUrl` 释放复制引用，取消沿 `cancel`，迟到复制凭现有 hint 身份和 signal 判定。URL 对象不跨入口保存。
- 必要校验只在拥有 UI/launcher 的登录入口做一次；类型由现有 AuthEvent/AuthPrompt 提供，不再加 schema/typeof 链。无新 catch、重试或静默降级；保留既有 clipboard 失败提示和 launcher best-effort 语义。
- 用 `URL.parse` 调用计数和 AST/source 不变量证明 render/handleInput/copy 没有重复解析；用现有复制替换、完成、取消、迟到结果测试和实际 login owner 失败测试证明释放。未修改生产热路径，因此不制造无关 allocation 基准；如实现需要下沉到 render/输入热路径，先停止并补充性能设计和 profile。

## 4. 有序实施与验收

1. 先运行新增行为用例，记录未修复的红灯；launcher 测试替身必须在退出时恢复 builtin ESM 导出。
2. 仅在 `login-dialog.ts` 实现局部 URL/text helper 和入口使用；不编辑 `open-browser.ts` 或 shared render。
3. 验证 HTTPS、HTTP（包括 loopback）、规范化后展示/复制/打开一致、编码 query 不改写；三个 URL 入口对不合法协议与控制字符采用同一规则。
4. 验证普通多行文字保留，注入的 OSC 52、CSI、BEL/ESC/C0/C1 不穿透；可信 showDetails 的应用样式保持。
5. 验证原有 copy failure/coalescing/replacement/cancel/completion，以及实际 `showLoginDialog` 在非法 URL 时报告失败、恢复 editor、释放 URL 且不完成认证。通用 launcher 仍能接受正常文件路径。
6. 先跑 `node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/login-url-copy.test.ts tests/tui-async-owner-closeout.test.ts`，再 `npm.cmd run check`、`npm.cmd run build:offline`、`npm.cmd test -- --keep-going`。最终提交保留现有 Node 26 Linux 2 / Windows 4 CI 分片。
7. 补写源文件哈希、确定性计数、红/绿与生命周期证据；检查 diff 不包含用户原有 patch 删除；独立提交、推送并创建 T03 PR。合并授权只适用于刚完成的 #178，不自动合并新 PR。

## 5. 当前验证

初始红灯：78 项中 70 pass / 8 fail，观察到非 Web URL 被接受、原始终端控制串进入输出、非法 info 链接后 provider 仍正常返回。初版 prompt 夹具在断言提前失败后取消未观察的 Promise，另有一条测试清理的 unhandledRejection；已在最终夹具立即观察该 Promise，并在输出断言中识别原有 Input 光标标记，不把这些夹具问题当作产品缺陷。

候选定向验收：**78 pass / 0 fail / 0 skip**，包含既有 async owner closeout；类型检查和离线构建通过。有效链接在 auth/device/info 各解析一次；每个入口的 22 个拒绝输入中，14 个控制字符输入解析次数为 0，其余 8 个协议/格式错误各解析一次。重复 render、普通输入和复制新增解析为 0。原有复制失败、替换、取消与迟到结果回归通过；实际 login owner 错误路径恢复 editor、释放 `authUrl`/`authUrlHint`，完成认证次数为 0。

全量 Node 26 测试：**389/389 执行单元成功，5,113 pass / 96 原有 skip / 0 fail / 0 cancelled**。没有增加跳过项、放宽断言或修改超时。最终提交的远端 CI 以独立 PR 检查列表为准；不把候选当作已合并交付。

[JSON 证据](../evidence/pi-150-t03-login-url-safety.json)记录源文件 LF-normalized SHA-256、确定性解析计数、owner 释放与覆盖限制；原始日志保留在 `.git/pi150-t03`。最终代码只修改一个生产文件；新增三项模块级正则和两个局部 helper，没有新全局状态机、缓存、重试或对象池。
