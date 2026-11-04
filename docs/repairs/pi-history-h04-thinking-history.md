# H04 — 跨模型历史省略 thinking

状态：失败基线、最小修复、确定性计数、分配采样和生命周期验收已完成，等待独立 PR 审查/CI。分支 `codex/h04-thinking-history`。任务根 `D:\RMProjects\Pi\.task-tmp\h04-125da27381b4`；Node v26.13.0，runner 的 TMP/TEMP/TMPDIR 指向该根，进程/输出登记 resources.json。

## 调用链与范围

已完整阅读 hot-path allocation contract。入口包括 AgentSession 请求历史、摘要/SDK 直接请求及 provider 重放；公共转换实际被 Anthropic、Bedrock、Google shared、Mistral、OpenAI Chat 和 Responses shared 调用，后者也服务 Azure/Codex。`transformMessages → transformMessage → transformContentBlock → orphan tool-result repair → provider content conversion → SDK request serialization / fetch → terminal stream result / failure / abort` 为本项主链。原消息/用量由调用者持有，转换结果为请求生命周期所有，不重写 session history。

源码确认两条路径：公共 transformContentBlock 先处理签名/redacted，再把跨 provider/API/model 的非空 thinking 改为 text；另有 `contextForModelCapabilities` 在 toolCalling=false 时先把 thinking 改为 text，导致后续公共转换无法再识别。必须覆盖这个前置投影，而不是只修最后一层。capability projection 在 OpenAI 部分 stream 入口与 buildParams 各调用一次，既有重复遍历须计入完整请求基线。

在现有遍历中按 provider/API/model 三个身份省略跨模型 thinking；公共转换的同模型重放继续受 thoughtSignatureRoundTrip 和各 provider 原规则控制。toolCalling=false 的同模型纯文本投影保持现状，它与 estimate.ts 的历史用量估算配套；本项不扩展为原生 thinking 重放，也不修改预算策略。text、toolCall/toolResult 归一化与顺序、redacted/空块规则、用量及输入不可变性均为验收约束。无新自动重试、兜底、正则、闭包、全局缓存或第二遍新历史过滤。

## 性能基线和验收设计

公共转换既有成本包括 Map、Set、transformed/result/pendingToolCalls 数组、每个 assistant 的内容数组与消息拷贝，以及原有两遍消息遍历。非视觉图片投影、工具 ID 归一化、孤儿结果修复保持原规则。下游 provider 仍有请求级数组/对象、sanitize/序列化、SDK Promise/回调；Anthropic inline/deferred tool history 的额外扫描与快照只在相应配置下出现，不把这些既有成本写成零。

先冻结失败矩阵：同身份/不同 model/provider/API × 签名允许/禁止，内容包含 unsigned/signed/redacted/空 thinking、正常正文及工具调用；再通过真正 SDK fetch 边界捕获 Anthropic 出站 body，覆盖 toolCalling=true/false 和同/不同模型。网络边界只返回合成 SSE，不调用真实服务；输入深冻结并检查原内容/用量。

大历史基准使用固定规模和哈希：计数阶段观测实际生产遍历/块转换及结果容器，profile 阶段关闭计数 hook，用 HeapProfiler 采样；生命周期阶段保持输入历史、模型及消费后的 stream owner 存活，释放请求输出，受控 GC/WeakRef 检查正常、失败、取消后请求内容引用。基线/候选串行、同 Node/同 fixture，最终报告明确代表性 provider 和未覆盖配置，不将 timing 或单次 heap delta 替代分配/释放证据。AST/source invariants、相关 provider contracts、类型/构建与最终六分片 CI 为门禁。

## 固化基线与最小实施决定

基线为 H03 合并提交 `a7b239eb7e969cd3b7866b2e54df692f2c34cf02`。两个生产文件的 SHA-256 分别为 transform-messages `11f2c571e33d012518533ab02211a7e8baa51efc68cd9593b17aafb7344b4e7c`、model-capabilities `7c53660e03ee59cce0de9af59984dffabff52876acfc0cf8fb6456cc37d851d5`。最终 12 项 contract 在冻结基线上为 **4 通过、8 失败**：同模型公共签名及 SDK 两条投影对照通过，六个跨 model/provider/API 组合把 PRIVATE_UNSIGNED/PRIVATE_SIGNED 变为正文；两个跨模型出站 body 含合成 thinking。最终基线通过 module load hook 加载两个冻结源码文件，其他依赖及测试不变。初次断言的显式 undefined 字段差异不计为生产问题；预算链审计后，同模型 no-tools 断言按既有纯文本语义校正。

因此实施限制为两个现有遍历：公共 thinking 分支首先拒绝不同身份，再执行原同模型 redacted/signature/空块规则；能力投影只增加同一三字段身份条件，跨模型省略，同模型仍按既有规则投影为正文。工具协议投影、正文、用量、预算策略与输入所有权不变，无新 helper 或整历史遍历。

`scripts/bench/thinking-history.ts` 的冻结基准哈希 `28fc0bb9506c0a3ddc9c35199d03596777ed8c34c99b5435050fb017d26da150`，1,024 个 user/assistant 对、2,048 条消息、8,411,050 thinking code units。计数 run 仅给两个指定生产模块注入 AST 计数；profile/lifecycle run 加载原源码。公共转换基线一次调用，消息首/次遍各 2,048，内容转换/次遍块各 2,048，thinking trim 1,024；源码对象字面量创建 3,072、数组 1,027、Map/Set 各 1、inline closures 0。禁用工具路径另有 2,048 消息/2,048 块投影，两个指定层合计对象 6,145、数组 2,052。该计数不涵盖 SDK/V8 隐式分配。

两种实际 SDK 出站 body 均为 8,557,373 code units，并检测到合成 thinking。HeapProfiler 4,096-byte sampling、收集 minor/major GC 已回收对象、计数 hook 关闭；同机基线每请求采样字节：纯转换 **536,940.5**（64 次），Anthropic tools **9,831,623**、no-tools **10,892,037**（各 8 次）。主要分配为 SDK FallbackEncoder 请求序列化、provider convertMessages、公共转换；no-tools 还包括能力投影。包含 fixture Response、SDK 和 profiler 的固定噪声，不将其当精确堆大小或 CPU 提升结论。

生命周期诊断记录在本项 lifecycle-ledger.json。同步在 SDK fetch 回调内用默认 abort reason 取消时，仅 cancel 的两个 payload.messages WeakRef 存活；success/failure 和其他引用释放、abort listener=0。将 reason 换成 primitive 的控制为 0 存活；恢复默认 reason、在独立受控 microtask 触发取消也为 0 存活，支持“默认异常保留同步 SDK 调用栈”的解释，未修改生产清理。最终基准采用真实外部取消边界，临时 primitive 控制已移除：输入 2,048 消息、六个已消费 stream 和六个 AbortSignal 保持存活时，21 个请求/转换 WeakRef 全部释放，abort listener=0，取消 resolver 清空。不能把原同步诊断失败隐去或宣称生产已修复该失败。

## 候选验收与分配对照

候选 SHA-256：transform-messages `46648c06f6bc4c21818cef7011a6222a1132777b78ce30146c93d7d5f9259037`，model-capabilities `b22901994b844dc98831bda50cc93f2f4c33cd9e64d6ad0eee00ce02e0b85906`。两文件全部 AST：arrow/function expression **0→0 / 5→5**、function declarations **5→5 / 31→31**、regex/new Promise/async 均 **0→0**，strings **33→32 / 274→274**。能力投影的既有工具结果 map 回调未增加；大历史代表场景 inline closure 仍为 0。没有新增校验、状态、fallback 或对象池。

| 指标（每请求） | 基线 | 候选 |
| --- | ---: | ---: |
| 公共转换首/次遍消息数 | 2,048 / 2,048 | 2,048 / 2,048 |
| 公共转换内容调用 / 次遍块访问 | 2,048 / 2,048 | 2,048 / 1,024 |
| 跨模型 thinking trim | 1,024 | 0 |
| 公共转换对象字面量 / 数组 / Map / Set | 3,072 / 1,027 / 1 / 1 | 2,048 / 1,027 / 1 / 1 |
| no-tools 两指定层对象 / 数组 | 6,145 / 2,052 | 4,097 / 2,052 |
| 两条 SDK 路径出站 code units | 8,557,373 | 119,699 |
| 出站包含合成 thinking 的请求数 | 1 | 0 |
| 纯转换采样 bytes/request | 536,940.5 | 492,266 |
| Anthropic tools 采样 bytes/request | 9,831,623 | 1,283,859 |
| Anthropic no-tools 采样 bytes/request | 10,892,037 | 2,256,025 |

计数不新增全历史 pass，数组数不变，省略块使下游块访问减少；no-tools 投影仍访问原始 2,048 块，公共转换只再访问其保留的 1,024 块。采样的主要减少来自不再序列化无关 thinking；候选主要剩余栈为公共/provider 转换和必要请求编码。完整数据、命令、源码/基准哈希、主要栈及边界见 [正式证据](../evidence/pi-history-h04-thinking-allocation.json)。基线与候选 counts/profile 使用相同冻结基准；baseline lifecycle 在仅增加 benchmarkHash 输出元数据前运行，取消与测量逻辑相同。

候选正常/错误/取消六条请求链继续保持六个 stream、六个 AbortSignal、原始大历史存活：21 个 WeakRef 全部释放，abort listeners=0、取消 resolver=undefined。GC 后堆分别约 24.37M/24.44M bytes，作为释放背景记录，不将该小差值当内存回归或提升结论。基准没有 real network；SDK fetch 仅由离线 fixture 返回合成 SSE。

`node --experimental-strip-types --test tests/provider-contract/thinking-history.contract.test.ts tests/provider-contract/model-capability-authority.contract.test.ts tests/source-invariants.test.ts tests/stream-hot-paths.test.ts` **37 通过**；指定 allocation source gate **2 通过**；新增 `tests/thinking-history-allocation.test.ts` **1 通过**，把实际生产遍历/对象/数组/闭包与请求尺寸计数纳入 CI。计数子进程使用仓库内独立 task fixture，启动前校验三个临时变量和 os.tmpdir，结束后登记 PID/退出结果并验证清理。类型检查与离线构建通过。

普通 provider delta/event、SDK 错误和取消传播、工具 ID 配对、同模型合法签名/redacted replay 以及原始输入/用量均保留。性能实测覆盖该固定 Anthropic 场景和公共转换；其他 provider 配置为调用链源码审计及既有 contract 覆盖，未声称全部配置有同样降幅。最终 head reviewer 与六分片 CI 尚待完成。
