# T09：摘要认证来源与逻辑请求失效边界

状态：先行设计已落实，实施完成、验收中。T08 #190 最终 head 0c738b1b3a70513dfd2f571673c1901ea04a837d 经 Codex completed/no findings、六 CI success 后合并为 aa5485a42fcf3d1b0c0c82530e09b90e44a0bf0c，两端对应分支已删除、main 已同步。本项从该基线开启 codex/t09-summary-auth-boundary。只使用当前 Node v26.13.0。

## 源码事实

AgentSession 的 _getSummarizationRequestAuth 取得已解析的 model/baseUrl/apiKey/headers/env；普通 compaction 与 tree summary 都冻结该快照。SDK createSummarizationStream 将快照作为 ProviderRequestContext 传入 ModelRuntime.prepareRequest。prepareRequest 有快照时跳过 getAuth，直接将已解析认证交给已捕获 provider.streamSimple。因此不能仅因 options 带 apiKey 就判断发生 OAuth → API key 重分类，也不能为了模仿上游额外添加认证缓存或复制 auth 数据。

现有 openai-compaction-lifecycle 合约覆盖普通摘要只解析一次、跨 transient retry 复用同一快照、headers/env/baseUrl、header-only 认证、模型/会话/transport 代际失效，以及真实 Codex OAuth refresh。已有 oauth-refresh-transactions 测试覆盖 refresh 与 logout 的存储事务。本项要补缺失的来源对照与 branch 场景，不重写这些已成立的边界。

另一个待复现点：_createSummarizationGuard 捕获 runner/session/model/executionBoundary/Codex generation，但没有 credential mutation generation。ModelRuntime.logout/login/setRuntimeApiKey/removeRuntimeApiKey 在写入后刷新目录，不保证更换当前 model 或 Provider 对象；UI /logout 可以在异步摘要期间触发。尚不能宣称旧快照在登出后自动失效，先离线复现，再决定是否需要独立根因修复。

## 证据与实施顺序

1. 使用现有真实 SDK/provider 离线 fixture，存储伪造 OAuth 与显式 key 分别执行普通 prompt、普通 compaction、branch summary。计数 getAuth、OAuth toAuth/refresh、API key resolve、实际 transport 次数；比较一致的 baseUrl/headers/env，只记录计数而不把 token/header 值写入证据。
2. 对同时支持 OAuth/API key 的虚构 auth handler，API key resolver 遇到 OAuth 转换结果应立即报错，确保测试真的能检出重分类；普通摘要和 branch retry 均应只解析一次。关闭远程 compaction extension，避免把远程压缩与本地摘要混为一谈。现有真实 Codex refresh 测试继续保留。
3. 使用 deferred auth/header hook，在请求尚未发出时完成真实 runtime.logout，恢复 hook 后验证旧摘要不能发送或写入 checkpoint；再覆盖 retry 之间的注销、模型切换和取消。失败必须先定位持有旧快照的 owner。若成立，实施前在本文补充最小生命周期设计：复用现有 guard，不在 delta 检查、刷新或重新解析认证，不退回环境变量，不新增长期凭据缓存。
4. 来源语义若已等效，明确记录该部分无生产改动；仅对已复现的 owner 缺口修复。必要 revision 状态以 provider 身份为边界，仅由实际 credential mutation 更新，避免不同 provider 相互取消，也不能把普通 OAuth token rotation 当账户切换；明确 commit 与同步失败的顺序。
5. 定向 lifecycle/source/OAuth transaction 回归 → check/build:offline → Node26 全套。若只改低频 auth admission/credential mutation，不宣称改进 delta/terminal 热路径；仍审计其现有 release 边界，记录 lookup/refresh/request 和旧快照释放证据。独立 PR、主动 review、最终 head 六 CI 与审核通过后自动合并和精确清理，再进入 T10。

## 已复现根因与修复设计（先于生产修改）

六个 OAuth/显式 key × prompt/compact/branch 对照均通过，lookup=1、对应 resolver=1、错误 resolver=0、request=1、refresh=0；该来源语义不改。两个真实 SDK 红灯确认 compact/branch 在 before_provider_headers 等待时完成 runtime.logout 后，旧快照仍能继续请求且没有拒绝。现有 guard 不观察 credential mutation，provider/model identity 也不足以代表账号变化。

最小修复：ModelRuntime 按 providerId 保留纯数字 credential generation，并提供读取方法。四个已存在的 credential mutation（login/logout/setRuntimeApiKey/removeRuntimeApiKey）都在成功写入后调用 synchronizeCredentialState；因此只在该共同入口、任何同步 await/取消检查之前递增一次。写入失败不递增；写入已提交但模型同步失败或随后取消仍递增。OAuth refresh 不走这个入口，维持同账户 token rotation 与摘要 retry 快照语义。状态由 runtime 拥有，大小为本 runtime 发生显式凭据变更的 provider 身份数量，不存 token/header、请求或 callback，不加淘汰/兜底缓存。

_createSummarizationGuard 在解析认证前捕获该 provider 的 generation，在既有 guard 调用点比较。覆盖认证等待、header 等待和下一次 summary retry 的发起边界，错误明确为凭据已改变；不重新解析、不追加请求、不关闭推理、不对每个 delta 检查。不增加全局注销监听器、取消队列或对象池。已发出的 transport 仍按原有生命周期完成，本项不把本地 credential 删除伪装成远端 token 撤销。

新增必要回归：同 provider 的 logout/替换 key 阻止尚未发送或待 retry 的摘要；其他 provider 变更不相互取消；失败写入保持旧 generation，成功提交但同步失败仍使旧 owner 失效；正常 OAuth refresh 不产生显式 credential generation。测试 fake runtime 按实际所需接口补齐方法，生产不为陈旧 fixture 增加可选调用/降级。只在低频请求 admission/凭据变更边界加入整数读写，现有大历史/流式/终端生产代码不改。

## 实施与验证记录

生产仅增加 runtime 的数字代际表/读取方法、已提交 mutation 共同入口的一次递增，以及已有摘要 guard 的捕获/比较。API key 与 OAuth 解析、SDK auth snapshot、provider dispatch 和 refresh 事务不改。完整审计链为请求 guard → auth 解析 → frozen snapshot → SDK request context → prepareRequest → provider → 既有 finally cleanup；这是低频配置/请求边界，新增每 delta/frame 的 closure/Promise/controller/wrapper/array 均为 0，不声称给未修改热路径做了新的 profile。

14 项 T09 回归证明六种来源场景各 lookup/resolver/request=1，错误 resolver=0；四个 compact/branch × auth/header 等待注销场景实际发送=0、checkpoint=0；替换 key 后的 outer retry 没有再解析 auth 或发送第二次请求。无关 provider 变更仍可正常完成。同账户真实 Codex OAuth 刷新不改变显式 credential generation。写入失败不递增；写入提交后同步失败或同步阶段取消仍递增，旧 owner 不能恢复。

定向合计 **195/195** 通过，check/build:offline 通过。前两次全套分别暴露图片和 Evidence Ledger 共用 fake runtime 缺少新增读取方法；图片回归 **52/52** 通过，Ledger 定向两项失败已消失（该次未加 --expose-gc，16 pass / 17 skip；正式全套由已有 runner 启用 GC）。随后按明确目标列表一次补齐其余手写 runtime 夹具的静态 generation=0，保持完整接口，check 再次通过；没有生产可选调用或降级。最终 Node v26.13.0 全套 --keep-going **406/406 执行单元成功，5473 tests / 5375 pass / 98 skip / 0 fail / 0 cancelled**。最终 PR reviewer/CI 尚待验收。原始日志在 .git/pi150-t09，[结构化证据](../evidence/pi-150-t09-summary-auth-boundary.json)只记录计数、源码 hash 和生命周期边界，不记录认证数据。
