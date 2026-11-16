# 跨 provider 工具前缀矩阵

## 问题与修复

PR #318 固定了 CodeMode 定义，但仅检查 Codex SSE。新增发送矩阵发现两个共享问题：同一活动集重排会重排顶层工具和系统提示；普通工具激活会改变通用 shell/read 指引、工具规则和 Skills 展示条件。最初本地替换夹具还受到 SDK 自定义工具同名覆盖，不能证明新定义真的生效。本次从扩展注册并替换目标工具，同时断言最终注册表中的说明及 required 参数已更新。

会话现在按准确注册名排序活动定义，提示简述和规则使用一致顺序，不改变工具执行顺序。CodeMode 启用时，普通工具的能力指引、Skills 条件和按工具限定的操作规则使用允许的注册目录，不依赖活动子集；嵌套规则同样按名字排序。没有 CodeMode、模型不支持工具和空工具集保持原有边界。工具目录、规则或发现结果不能授予权限，Plan/Goal、活动集、当前 Schema 和执行授权仍在执行前检查。

真实规则内容更新仍然到达模型，顶层控制集合或其契约改变仍如实发送；不冻结旧定义或隐藏真实规则来制造缓存命中。模型/账号/配置/压缩/分支及外部 payload hook 的语义变化也不能被等同于纯工具目录操作。

## 实际发送矩阵

| API | 离线真实 SDK/适配器边界 |
| --- | --- |
| openai-codex-responses | Codex SSE，实际 zstd HTTP body 解压后核对 |
| openai-responses | OpenAI Responses HTTP body |
| azure-openai-responses | Azure SDK HTTP body |
| openai-completions | OpenAI SDK；另含 OpenRouter Claude 缓存标记、DeepSeek、Kimi |
| anthropic-messages | Anthropic SDK SSE；另含 Opus 5 原生 inline-tools/持久 checkpoint |
| bedrock-converse-stream | Smithy HTTP handler 接到已序列化请求；返回编码 AWS eventstream，由真实 SDK 解码 |
| google-generative-ai | Google SDK 实际 HTTP body |
| google-vertex | Vertex API-key 路径的 Google SDK 实际 HTTP body |
| mistral-conversations | Mistral 适配器实际 HTTP body |
| pi-messages | pi-messages 实际 HTTP body |

静态 `Record<KnownApi, Model>` 使新增内置 API 必须补矩阵。14 组配置各发送 10 次请求：前 9 次覆盖基线、普通激活/重排、真实本地说明和 Schema 替换、MCP 激活/刷新/停用、bash/read 激活以及包含顶层控制和 gateway 的同集合重排；固定字段和缓存设置相同。每次成功完成且只发送一次，不重试、不执行目标工具。最后一次更新真实工具规则，核对新规则到达模型（原生 Claude 可进入后部历史），旧规则没有被固化成当前规则。

每轮检查所有非历史的实际字段、前置系统指令、完整工具定义、缓存键/保留设置和固定缓存标记；单独比较先前对话内容，保留 provider 原有工具配对及 checkpoint。历史末尾缓存断点正常前移，因此仅从历史内容比较中排除 `cache_control` 和独立 Bedrock `cachePoint`，固定工具/系统缓存标记仍逐字段比较。不能把正常增长的历史或移动断点误算为前缀失效。原生 Claude 的后部系统更新不能误归类为前置 system 字段。

全部 140 次请求使用合成凭据并替换网络 admission，没有真实服务端、ADC 凭据、缓存命中率或计费验证；不能据此承诺 99% 命中或追溯历史零缓存原因。该矩阵验证现有十类 API 及列出的兼容分支，不声称穷举每个模型 ID、第三方 hook、WS、网关改写或服务端实现。

## 写法、性能与生命周期

生产链为 `setActiveToolsByName → CodeMode/Agent 模型工具投影 → 系统提示组成 → 各 API 真实序列化发送`。排序只发生于工具选择，使用模块级比较函数及已有数组；提示重建使用直接循环，移除了原 `filter` 闭包。两个方法和比较函数的 AST 回归禁止回调/正则工厂及新增 Promise/AbortController。固定夹具环境和 SSE 头为模块常量。没有新增全局可变缓存、对象池、每 delta/progress/render 分配或工具重放。本次不修改这些热路径，跳过无关帧基准。

现有 catalog/registration 生命周期探针：8/512 项目录激活 Schema 读取均为 0，Worker 启动/关闭各 1，关闭后名称映射与文档快照均为 0，24 个跟踪引用全部释放。32 次真实注册维持 Plan 选择，mode 读取 32、提示重建 64、Schema 读取及新增 Worker 均为 0，活会话释放 64 组退休引用，最终 70 个引用全部释放。采样宿主分配约 23.1 MB / 4.7 MB；主分配仍为目录/标识符处理和工具包装。没有同负载 CPU/峰值内存对比，不据此声称吞吐或内存改善。

类型检查、12/12 包离线构建及 233 项相关回归通过。完整套件和最终 head 的审查/CI 见关联 PR，不预写未观察结果。复跑：

```powershell
npm.cmd run check
npm.cmd run build:offline
node --experimental-strip-types --test tests/tool-prefix-providers.test.ts tests/tool-prefix-stability.test.ts tests/codemode-hot-paths.test.ts tests/prompt-composition.test.ts
node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts --catalog
node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts --registration-plan
```
