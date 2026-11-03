# T08：显式分支摘要输出上限与空结果处理

状态：先行设计已落实，实施完成、验收中。T07 #189 最终 head 1b2452c034fb89ddf8bc6f31035ff9a9f3b2f921 经 Codex completed/no findings、六 CI success 后合并为 4e004f4af1b10f91e9137632608b9421c32ed728；对应两端分支已删除、main 已同步。本项从该基线开启 codex/t08-branch-summary-output。仅当前 Node v26.13.0。

## 已核对事实与默认成本决定

BranchSummarySettings 只有 reserveTokens/skipPrompt；reserveTokens 默认 16384，控制历史输入预算中的预留空间，并不是输出上限。generateBranchSummary 固定 maxTokens=2048。当前配置没有可复用的独立输出字段，所以新增可选 branchSummary.maxTokens，与 SDK GenerateBranchSummaryOptions.maxTokens 对应；缺省继续 2048，绝不默认取模型上限。

用户显式设置后才增加摘要 maxTokens 配置值，不能承诺等量可见文字。保持现有 SimpleStreamOptions 语义：Google/Vertex 将 thinking 计入共享额度；非 adaptive Anthropic/Claude Bedrock 会在基础回答额度上增加 thinking，再受模型/上下文限制。本字段不是跨 provider 的统一总账单硬限制。既有 provider 上下文预算还可能降低实际值；reserveTokens 保持原有输入选择含义，文档明确较大的输出设置应配置足够预留。不擅自改变历史截取、默认费用或自动再请求。

另一个相关真实缺口：contentText 为空时先拼接 BRANCH_SUMMARY_PREAMBLE，导致后面的空值兜底永远不会触发，并可能保存没有实质内容的 checkpoint。T08 先用空/仅 thinking 终态复现，再在加前缀前返回明确 error；不能拿固定前缀伪装成功。

## 最小实现

1. settings-manager 的 BranchSummarySettings 增加 maxTokens?: number；getBranchSummarySettings 原样返回可选值，不在 getter 层再做一套校验/默认值。navigateTree 将值传给摘要 options。
2. GenerateBranchSummaryOptions 增加 maxTokens。生成入口在准备大历史前确定请求值：仅 undefined 使用 2048；显式值必须为正 safe integer，否则抛明确参数错误，禁止字符串转换、null 默认化、四舍五入或静默兜底。此处同时覆盖 settings JSON 与直接 SDK 调用，只验证一次。
3. model.maxTokens 为正时取 min(requested, model.maxTokens)；未知/缺失上限仍保留显式值或 2048，而不是 Infinity。不重复读取模型目录或手写 provider 规则，既有 transport/context 限制继续由既有 owner 处理。
4. requestOptions 使用选定上限，T07 Google 预算调整使用同一个选定值计算可用 thinking，保留 reasoning 和现有 auth/retry owner。length 返回原有 incomplete 错误；空/空白/仅 reasoning 的可见文本在 preamble 之前返回 error，不存分支摘要，不触发额外付费请求。合法内容和 file tracking/preamble 顺序不变。
5. 同步 settings.schema.json 的 integer/minimum=1/maximum=MAX_SAFE_INTEGER/default=2048 及中文/英文说明；project schema 复用全局定义，不复制第二份字段表。补充面向用户的摘要配置文档，区分 maxTokens、reserveTokens、推理占用和成本。

## 性能契约与调用链

已读 hot-path allocation contract。完整链为 trusted settings / SDK options → navigateTree auth/model/session generation guard → prepareBranchEntries → convertToLlm → serializeConversation → completeSummarization → provider stream → result failure/text → branchWithSummary → finally 释放。

只在一次摘要入口增加标量校验/取最小值，不新增每 message/delta 的配置/回调/Promise，不为每个输出档位重新序列化 conversation。空结果检查只在终态进行一次。保留现有 prepare/serialize 数据所有权，不顺带重构历史遍历和 provider delta。

大历史验证以离线真实 generateBranchSummary 为边界：固定 N/2N/4N 消息，旧基线与候选串行同机，统计真实请求次数/最终 prompt 尺寸，AST 确认每次非空摘要仅一处 serializeConversation 调用、无新增完整历史副本路径；记录 allocation profile、p95/CPU/peak/GC heap。WeakRef 保持 caller entries/result 活着，确认 request context/options 在完成/取消后可释放，区分 caller 拥有的输入与 request scratch。测量不并发构建/测试，不宣称本项改进整个 provider 热路径。

## 验证门禁

1. 在现有 branch-summary-options contract 先加入红灯：配置/SDK显式值原先无法生效，空/仅推理结果原先被前缀掩盖。
2. 覆盖缺省2048、显式合法值、已知模型更低上限、未知模型上限、非法值（0/负值/小数/非有限/超safe/null/字符串）在请求和序列化前失败；模型/配置事实不在每层重复验证。
3. settings schema 接受/拒绝边界和项目覆盖合并，真实 tree navigation 证明显式值到达请求、失败不写摘要；T07 thinking 继承不回退。length/empty/reasoning-only/abort 各验证无额外请求，合法摘要仍记录 usage/file details。
4. 大历史计数/串行采样/受控 GC 后删除精确记录的 baseline；check/build:offline、相关 schema/compaction 合约、当前 Node26 全套。全部离线、虚构认证，不执行可能访问 provider 的 compaction-summary --run。
5. 写方案和证据、独立 PR/主动 Codex review；最终 head completed 且无问题、六 CI success 后自动合并并精确清理两端分支，进入 T09 认证来源核对。发现问题则修复推送并额外独立请求复审。

## 实施与实测

配置 getter 原样传递可选 maxTokens，摘要入口在访问历史前一次校验并按已知模型上限取最小值，默认仍 2048。T07 的 Google thinking 调整直接消费选定额度；没有另建 provider 规则或改全局预算函数。空/空白/仅 thinking 结果在加前缀前报错，真实 tree fixture 验证原 leaf 和摘要记录数保持不变。length 终态不自动补发。全局/项目 schema 与配置优先级、SDK 入口和用户文档同步更新。

红灯证明原来的 3072 设置仍发送 2048，空内容却得到带固定前缀的 summary。修复后定向 **121/121** 通过，包含 schema、真实 tree、Google/Vertex payload、既有 compaction 生命周期和新 AST/GC 门禁；check 与 build:offline 通过。Node v26.13.0 全套 **406/406 执行单元成功，5459 tests / 5361 pass / 98 skip / 0 fail / 0 cancelled**。最终 PR reviewer 和 CI 尚待验收。

完整调用链与已有分配已核对：prepareBranchEntries 的两次历史扫描、所选 messages、convertToLlm 返回数组、serializeConversation 的 parts 和最终 join 都保留原样；新增校验不遍历历史。已有 request context/options/retry closure/controller 仍按一次摘要拥有，没有新增每消息/delta/frame 的 closure/Promise/controller/wrapper/array，也不触及终端 frame 材料化。没有对象池。

离线真实 generateBranchSummary 在 256/512/1024 条历史上，分别序列化 265872/531856/1063848 code units，均为 **1 次序列化、1 次请求**；最大 prompt 的 UTF-16 逻辑大小上界为 2129140 bytes（不是 V8 实际存储字节断言）。正常/abort/error 三种终态保留 caller entries 和返回 result，受控 GC 后 request context/options 均为 0 个存活引用，request-owned prompt 无 owner 保留。

三轮同机串行基线/候选采样见[完整 JSON](../evidence/pi-150-t08-branch-summary-output.json)。1024 条历史的采样分配中位数为约 1.315 MB → 1.310 MB/摘要，p95 中位数为 0.6453 → 0.6601 ms；GC 后 heap 约 20.4 MB，差异很小。CPU 中位数为 275.4 → 304.7 μs/摘要，受 Windows 计时粒度、调度和 GC 影响而波动，不宣称性能提升。首次仅 12 次测量导致 CPU=0，已改为 512 次，最终证据只使用足够长的测量窗口。profile 最大分配仍来自原有历史串行化路径；临时 baseline 按精确绝对路径删除，未保留生产副本。
