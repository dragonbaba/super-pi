# 压缩边界、保留尾部与请求预算

## 观察与复现

一次历史手动压缩记录的 `tokensBefore` 为 512568，本地物化后估计为
70807（500000 的 14.2%）。其中摘要约 643，旧失败 CodeMode 参数约
69768，其余尾部约 396。191310 字符的源码经 JSON 转义后占用更大；
`keepRecentTokens=20000` 的切点不能拆开原有完整工具交互，因而留下整个
失败调用。这解释了该本地估计的主要来源，不代表原生远端历史的真实 token 数。
原生替换历史与本地尾部不同，压缩操作本身的 usage 也不是下一轮输入用量。

历史首个越过默认 425000 阈值的成功响应直接达到 512307，发生在此前
用量代次和百分比修复交付之前。无法仅凭会话文件确认进程加载的具体源码版本。
本次另用开启工具结果预算的离线生产路径复现了三个独立问题：

1. 压缩保留的旧助手响应带有将来或相同时间戳，其旧 usage 被 AI 请求估算器
   误当作新代次用量；会话状态栏的代次修复没有覆盖这个下游估算器。
2. 自动压缩调用真实 `buildProviderRequestPayload` 时，预览误用普通下一轮
   工具结果的 context-headroom 检查，尚未调用原生压缩就失败。手动压缩前
   末尾如果已是错误响应，可能避开该分支，因此两者表现不同。
3. 自动压缩失败/取消后的布尔返回值无法区分“提交成功但无需续跑”和失败，
   下一轮继续准备普通请求，后续余量错误掩盖了压缩原因。

## 行为与所有权

- `failed-attempts.ts` 只在压缩准备/恢复边界处理已完成的单独失败交换。
  用已有保留额度和源码长度判断，不序列化完整源码作测量；原结果内容和
  details 保留引用。成功、pending、不同 call ID、混合工具批次保持完整。
  这不增加源码或命令拦截规则，不自动重放任何操作。
- `normalize-checkpoint.ts` 只处理终端压缩检查点；先持久化维护检查点再暴露
  精简视图。旧日志不改写，新条目不重复 usage/usageLedger 费用，原生
  replacement history 字节相同；有后续条目则不改变已建立的历史前缀。
- SessionManager 给旧助手用量建立仅限内存的历史标记。SDK 在扩展转换后
  只认可当前代次、当前 provider/model/API 的精确已提交对象；复制/外来历史
  使用物化估计。Symbol 元数据不进入 JSON，内容、reasoning/signature、
  费用和工具结果配对保持原值。
- 原生压缩预览保留配置的工具结果投影，但不预留普通下一轮回答的空间。
  普通预览、真实发送、原生压缩的认证/请求归属/承诺/传输检查不受豁免。
- 自动压缩返回明确的提交/续跑结果。失败保存有界错误并阻止当前运行续发，
  不自动付费重试；供应商原有重试策略不变。新提示、成功的手动/自动检查点
  和 disposal 清理失败状态。新输入和已完成副作用保留，post-save hook
  失败也不会隐式重放。原生策略只向模型返回安全阶段/错误分类，不带原始凭据。
- 防循环基线属于创建它的模型和阈值。显式变更后可尝试一次新策略，同策略
  的大检查点仍不造成立即循环。触发点仍是统一百分比的安全边界检查。

## 热路径审计与验证入口

调用链为 `SDK conversion → getRequestUsageEpoch → convertToLlmWithUsageEpoch
→ tool-result presentation → AI estimate → provider send`；另审计
`prepare-next-turn / assistant-end → auto compaction → canonical preview →
checkpoint → buildSessionContext` 和 restore/setup 的维护路径。

请求代次查找和 AI usage 索引不增加闭包、Promise、AbortController、临时
历史数组或逐项 wrapper。AI 估算改用原始索引，移除每个候选助手的临时
usage 对象。既有 converter 的 map/filter 输出数组不扩大；正常校准只在
每次请求创建一个共享原内容的元数据视图。无有效当前用量且收到外部复制
历史时，按请求建立历史标记视图；它不缓存调用者内容。旧基线回退不再复制
完整尾部数组。legacy 物化回退保留原有 token 估算，不宣称消除了所有历史
参数序列化。

`materializeCompactionMessages`、`condenseFailedCodemodeAttempts` 和
`normalizeUnconsumedCompaction` 是检查点/恢复 setup 分配边界；
`_blockUncommittedAutoCompaction` 是一次失败生命周期边界。它们不在逐 delta、
progress 或 frame 中执行。新增数组/视图随调用或检查点所有者释放；归档本身
有意保留原调用。无新全局可变缓存、队列、池或完整 payload 计量副本。

定向回归入口：

```text
node --experimental-strip-types --test --test-concurrency=1 tests/compaction-request-boundary.test.ts tests/compaction-request-epoch.test.ts tests/compaction-tail-policy.test.ts tests/compaction-policy-epoch.test.ts tests/pi087-length-recovery.test.ts
node --experimental-strip-types --test --test-concurrency=1 tests/compaction-usage-epoch-hot-paths.test.ts tests/auto-compaction-hot-paths.test.ts tests/codemode-budget-capability-source-invariants.test.ts tests/tool-prefix-providers.test.ts tests/bundled-extensions.test.ts
node --expose-gc --experimental-strip-types scripts/bench/compaction-request-epoch.ts --output <owned-file>
node --expose-gc --experimental-strip-types scripts/bench/compaction-usage-epoch.ts --output <owned-file>
```

跨供应商测试覆盖全部十类内置 API 和四种缓存/兼容变体，比较实际发送边界
序列化的工具/系统/缓存字段与完整历史。新增十四组元数据前后完全相同的
请求，并保留激活、重排、替换、MCP 刷新和压缩后规则恢复矩阵。离线前缀
相等不能推断线上缓存命中率；本次没有调用真实付费压缩，没有改写原用户
会话或运行其旧脚本。

## 同机分配与释放测量

Windows / Node 26.13.0，基线为 `872ea217949a701c263a24dc8fc2093946069fee`
的 converter/AI estimator，前后顺序运行同一脚本。每次处理 160 对相同的
4 KiB 调用参数/4 KiB 结果及同一个有效当前响应；两者均完整处理并返回
329509 tokens。以下为 2048 次请求准备的单次样本，不作为时间硬门槛：

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| HeapProfiler 采样字节 | 34213688 | 21610816 |
| 观测峰值 heapUsed | 79673128 | 68133944 |
| 释放并多轮 GC 后 heapUsed | 45703728 | 45774520 |
| CPU（微秒） | 62000 | 47000 |
| 完整历史参数额外 JSON 序列化 | 0 | 0 |
| 元数据视图 | 0 | 2048（每请求一个） |
| 保留 session/settings owner | 0 / 0 | 0 / 0 |

主要变化是旧 `getLastAssistantUsageInfo` 的逐候选临时对象不再存在
（基线采样 12426584 字节）；修改后主要仍是既有 map/filter 输出数组和
测量驱动。采样量降低约 36.8%，不是所有请求或机器的固定收益。
请求和当前响应覆盖相同，未用省略输出换取结果。额外查询/footer 测量
256 次：采样 1785104 字节、峰值 48766680、释放后 45650448，session、
settings、footer owner 均为零，无身份键重编码或历史体序列化；CPU 分辨率
得到零，不据此宣称速度提升。AST、精确视图/序列化计数和 controlled-GC
弱引用检查作为回归门槛，未使用对象池。

本地 `npm run check`、离线十二包构建及相关 98 项定向回归通过。最终整套
测试和最终 head 的 CI/review/合并状态以对应 PR 为准。
