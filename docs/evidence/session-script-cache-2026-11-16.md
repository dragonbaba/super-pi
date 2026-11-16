# 脚本输出、工具发现与缓存提示

历史验证：本记录中的本地内联声明及激活后前缀变化，已由[固定工具入口与按需契约](tool-prefix-guidance-2026-11-16.md)替代。输出恢复和响应绑定诊断仍有效。

## 问题与复现

成功的 shell 命令返回了约 137 KB 的合法 JSON，脚本却对工具的 `content[0].text` 调用 `JSON.parse` 后报 `unexpected data at the end`。完整输出文件可正常解析；返回文本已经是截断尾部，并含有显示说明。进程输出排空与脚本收到完整文档是不同的事实，脚本后处理失败不应被理解为命令失败或重新执行命令的理由。

另一个复现中，`tool_search("memory")` 激活记忆工具后，`memory action add replace remove` 因通用描述词分数而激活浏览器。生产 SDK 装配证明，激活本地工具会改变 CodeMode 的内联工具声明，即实际 provider 请求前缀；无关激活会产生可避免的额外变化。该前缀变化是客户端已观察事实，并不等于取得服务端的缓存未命中诊断。

旧缓存提示只给出长度上限并称原因未知。一个归一化用量夹具的前轮 prompt 为 250,639 token（其中 cache-read 249,472），后轮记录 input 251,063、cache-read 0，长度上限为 `min(250639, 251063) = 250639`，显示为 251k。这个算式不能证明重复内容、缓存过期、账号切换或重复计费。

## 修改

- shell 完成事实继续保留；CodeMode 单独标记 `outputTruncated`，摘要和脚本异常补充截断上下文及已有输出恢复指引。实际脚本错误仍然失败，本次 store 写入仍回滚，成功工具及副作用不重放。Bash/PowerShell 与 CodeMode 说明明确要求解析前检查截断/日志封顶状态。
- 前置类别别名加空白或冒号将查询限定在该类别；已全部激活时返回空结果，不因通用动词转去其他类别。浏览器调试意图只在无类别或 browser 类别内优先，不覆盖 memory、delegation、skills、MCP、navigation；这些类别也不借用浏览器的批准等待状态。原权限边界保持原语义。
- 可选缓存提示显示记录的 prompt/cache-read 数量、比例及长度上限。当前响应身份对应的前缀观测可显示客户端变化枚举，明确区分服务端诊断；复制、历史恢复或观测缺失时不借用最新请求的变化。估计、用量和费用计算没有修改。

[OpenAI 缓存诊断文档](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics) 定义了基准响应、`comparison_response_id` 和服务端诊断结果；它是请求比较，不会恢复历史或保证命中。核对 Codex 提交 `75fc67e8f4284a669eebd90ab6bc9ef7697e876e` 的 [client 请求构建](https://github.com/openai/codex/blob/75fc67e8f4284a669eebd90ab6bc9ef7697e876e/codex-rs/core/src/client.rs)，该处缓存 options 只构造 ttl。未证实 Codex OAuth 专用端点兼容新的诊断选项，因此本次不自动发送。已有会话缺少响应绑定的有效派发记录和服务端诊断，无法追溯其确切服务端原因。

## 验证与性能边界

离线回归使用原生 Bash 捕获和真实 CodeMode worker：截断解析失败时子命令仍为成功，完整文件可解析；下一脚本只读取已有文件恢复 4000 项数据，生产命令只调用一次。小型完整 JSON 正常，普通无效 JSON 不附错误的截断说明。类别误激活先复现，再通过真实 SDK 验证不发生第二次声明变化。缓存回归覆盖实际数量、响应身份、重建、禁用与原估计边界。

`npm run check`、`npm run build:offline`（12/12 包）通过；最终 10 个相关测试文件共 391 成功、1 环境跳过、0 失败或取消。最终提交的完整回归与跨平台 CI 结果记录在 PR 验证说明。

源码不变量确认提示格式化只有原来的 Spacer/Text 两个展示 owner，没有新回调、Promise、controller、历史扫描或持有观测对象。CodeMode 基准执行 418 次子调用、progress 0，11 个 worker 全部停止，55 个弱引用 GC 后均释放，待处理 evidence 为 0；host 采样分配 37,532,504 bytes，这是一次候选生命周期样本，不是性能改善结论。

工具发现同机交替三对进程，每种场景 4096 次计时、32 次采样、1024-byte sampling interval。比较相同的正确查询/输出；CPU 与采样值为三个进程的中位数。没有 catalog 缓存；每次搜索读取一次 catalog。两侧各六种释放场景的旧 catalog 引用均为 0。

| catalog / 查询 | CPU μs：基线 → 候选 | sampled bytes/search：基线 → 候选 |
| --- | --- | --- |
| 100 / English | 49.56 → 53.47 | 38170 → 38336.75 |
| 100 / CJK | 41.99 → 42.24 | 29305.25 → 28576 |
| 1000 / English | 381.59 → 366.21 | 350751 → 352153 |
| 1000 / CJK | 343.26 → 343.02 | 266189.25 → 264766.5 |

进程峰值 RSS 中位数为基线 89,396 KiB、候选 88,640 KiB。小 catalog 的 English CPU 增加约 3.91 μs，采样仍有波动；本次交付类别正确性，不宣称吞吐或内存改善。普通 delta/progress/frame 处理未改变。

复跑入口：`npm run check`、`npm run build:offline`、`node --expose-gc --experimental-strip-types --test tests/codemode-shell-json.test.ts tests/cache-overlap.test.ts tests/tool-search-category.test.ts tests/tool-search-hot-paths.test.ts`、`node --expose-gc --experimental-strip-types scripts/bench/tool-search-ranking.ts`、`node --expose-gc --experimental-strip-types scripts/bench/codemode-session.ts --handled-failures`，以及 `npm test -- --keep-going`。真实 Unity/远端 provider 未重新调用，原始会话只读。
