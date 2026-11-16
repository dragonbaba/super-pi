# 缓存、传输生命周期和渲染审计

基线为 `184b1a5e39c7190fef7a18854ae1497e98c7374d`。对 1,048 个 TS/JS 文件、15,434 个函数体进行静态候选扫描，再沿确认候选的生产调用链核实。范围包含 provider 请求与历史、工具/MCP 目录、压缩、事件交付、交互组件、布局及终端帧队列。这不是对每个文件逐行人工证明，也不表示不存在其他问题。

## 确认的问题与结果

1. **压缩后的规则恢复。** 动态规则已从 system 移入自定义历史消息，但旧恢复逻辑仍读取物理树中已被摘要替代的哈希，导致下一轮遗漏规则。现在按可见上下文恢复，支持 `retainedTail`、保留起点、分支、旧 host 回退及空状态；验证起点确实位于当前祖先链。已保留的消息不重复插入，已摘要的规则恰好补回一次。当前 host 使用索引向父项遍历，消除每轮完整分支副本。旧 host 下 CodeMode 内嵌 `read` 也正确迁移 Skills，避免规则更新改写 system。
2. **流结束的等待者。** 终止事件只唤醒一个迭代器时，其他等待者可能永久悬挂。现在成功和错误终止都会释放全部等待者，终止事件只交付一次，保留晚消费和提前退出后的 FIFO 语义。共享不可变完成值；公共 API 未增加实例字段。
3. **WebSocket 混合帧顺序。** 较晚的文本或 Blob 转换可越过较早的 Blob，甚至在完成/close 时丢失其增量。现在按接收顺序消费，借入的可变二进制视图在入口立即解码；每个请求复用一个惰性 decoder。保留已有 128 个活动转换的边界，立即接管拒绝结果，取消/结束仍加入所有已启动转换。空闲等待及 Blob 转换期间均覆盖超时，移除监听器、计时器、原始帧引用并释放队列后才结束所有权。已开始的请求失败不会重放；下一请求保留现有回退策略。
4. **长 Markdown 崩溃及尾行分配。** 约 60 万字符、150,000 项列表可在 `push(...lines)` 处报 `Maximum call stack size exceeded`。列表、嵌套列表、表格、引用及换行结果现在用直接循环追加。部分代码围栏检查使用 `lastIndexOf` 和短尾逐字符比较，避免将整个代码块切成数组。没有裁剪输出或改动终端提交协议。

固定规则、正则继续复用模块常量。FIFO 复用现有双数组实现，增加所有者 `clear()` 以释放两个 backing store；没有对象池或全局可变 scratch。入口回调、decoder 辅助函数、空闲计时器回调均属于单请求；正常帧不创建回调工厂。Blob 本身的转换 Promise、已存在的 async generator 交付和空闲交接属于各自已有生命周期成本，不计为零分配。

## 缓存验证

`tool-prefix-providers.test.ts` 保留十类 API、十四种发送配置的 140 次工具激活、重排、本地替换、MCP 刷新请求验证；另增加十四组真实 `AgentSession.compact()` 之后的发送，共 42 次普通请求。压缩摘要由离线扩展 fixture 提供，普通请求经过真实 provider SDK、序列化和发送边界。验证规则在压缩后恢复、下一轮不重复、固定 wire prefix 不变。覆盖 Codex、OpenAI/Azure、Anthropic 普通/原生 inline、Bedrock、Google/Vertex、Mistral、Pi、OpenRouter cache markers、DeepSeek、Kimi。

这证明指定转换不再无故改写客户端固定前缀；实际规则或权限变化仍须传给模型。压缩必然改变可见历史，不能据此承诺服务端缓存命中率，也不能将此前服务端零缓存的原因直接归到这四个问题。

## 同机性能和释放证据

Windows x64、Node v26.13.0、i7-14700KF；每组前后顺序执行，完整验证同一输出。分配为 inspector 4 KiB 间隔采样总字节，峰值为采样点观察值，不是精确瞬时最大值。耗时仅限该 fixture。

| 工作负载 | 基线 p50 / p95 ms | 修改后 p50 / p95 ms | 采样分配 bytes，前 → 后 |
| --- | ---: | ---: | ---: |
| 动态规则：10,000 条历史、100 次不变轮次，哈希靠近末尾 | 0.2336 / 0.3331 | 0.0121 / 0.0242 | 35,073,056 → 1,395,512 |
| 同上，哈希位于历史开头 | 0.2676 / 0.4781 | 0.1695 / 0.2760 | 35,021,048 → 1,445,752 |
| WS ArrayBuffer：每请求 2,000 增量，20 次测量 | 6.1246 / 6.7715 | 3.3634 / 4.1245 | 132,772,936 → 119,929,416 |
| 同上，文本帧 | 5.3342 / 6.2141 | 3.1525 / 3.8188 | 113,020,008 → 113,514,912 |
| Markdown：10,000 行代码、80 次围栏变化 | 5.4304 / 10.2514 | 6.2224 / 9.2248 | 828,961,760 → 808,147,144 |
| 完整 alt 渲染与队列：5,000 项、2,000 帧 | 0.0323 / 0.0488 | 0.0316 / 0.0489 | 22,741,952 → 22,379,856 |

动态规则的分支副本由 100 份、1,005,150 项变为零；近端哈希索引读取 5,050 次，远端 1,005,050 次，最坏扫描仍线性。近端观察堆峰值 42,011,848 → 26,581,920 bytes，受控 GC 后 25,298,504 → 25,240,384 bytes；两组各 3 个投影引用均释放，Runner 保持存活。

WS 每组完整交付 23 次请求、46,000 个增量（含 3 次预热），最终正文一致、连接建立/关闭各一次，46 个流/结果引用全部释放。二进制观察峰值 21,830,528 → 22,221,088 bytes，受控 GC 后 16,059,792 → 15,846,144 bytes；文本峰值 21,474,904 → 18,366,800 bytes，受控 GC 后 15,724,736 → 15,694,272 bytes。二进制峰值略升、文本分配基本持平，不宣称全项下降。延迟 Blob、拒绝、取消、超时、close、下一请求和借入缓冲复用由回归单独覆盖。

Markdown 每轮完整 10,002 行，前后最终输出 SHA-256 均为 `98b3f7c080a4215cad925e3f6ab574f10f3012af25026baa33473c5258520a1a`，81 个组件/结果数组引用释放。观察峰值 289,960,360 → 320,143,256 bytes，受控 GC 后 21,134,496 → 20,950,464 bytes；整体中位数与峰值未改善，其余 lex/wrap/repeat 工作仍占大头。150,000 项列表及 150,000 字符窄段落只作为完整输出的正确性回归，不拿崩溃基线比较速度。

源码调用链已核对 AssistantMessage → Markdown → 容器/视口布局 → TuiAltScreen → TerminalFrameQueue → sink；完整 alt fixture 的释放后组件、行、source、cachedRows 和屏幕行计数均为零。独立队列控制完整写入 2,000 帧、每帧 64 KiB，flush 后 active/pending 及其字节计数为零；每帧回调/Promise/AbortController/wrapper/完整帧副本计数均为零。这是控制验证，未更改队列本身。

EventStream 的 10,000 增量合并控制保持一次交付、一次快照、最大 pending 1；p50 2.2403 → 2.3929 ms，观察峰值 33,625,544 → 33,993,584 bytes，未声称性能提升。等待者修复的验收依据是完成行为、FIFO 和引用所有权。

## 复跑入口与边界

```sh
npm run check
npm run build:offline
npm test -- --keep-going
node --expose-gc --experimental-strip-types scripts/bench/dynamic-instructions-history.ts
node --expose-gc --experimental-strip-types scripts/bench/dynamic-instructions-history.ts --early-marker
node --expose-gc --experimental-strip-types scripts/bench/codex-websocket-decode.ts
node --expose-gc --experimental-strip-types scripts/bench/codex-websocket-decode.ts --text
node --expose-gc --experimental-strip-types scripts/bench/markdown-code-tail.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --frames 2000 --warmup 100
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 2000 --warmup 100
```

分配 AST 门禁随实现更新，继续限制每帧/增量的回调和 Promise 工厂，并检查 FIFO、规则索引遍历及 Markdown 尾行检查。当前保留单份 projection 的生命周期限制未变：正常 shutdown 后全部释放；仅同步使 API 失效但未发 shutdown 的旧 host，在 Runner 存活期间保留一个 projection，Runner 释放后归零。

所有性能/provider 发送均为离线 fixture；没有新增真实服务端缓存率、真实远端压缩或桌面 computer use 验收。退出清理、批量文件部分成功、搜索探测及子代理期限使用此前已交付回归继续验证。
