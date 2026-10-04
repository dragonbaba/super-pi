# TUI ANSI 边界与前导空白补全复核

候选基于 `1bfe11abb`（PR #63 合并后的 main），分支
`codex/tui-ansi-slash-correctness`。本报告对应上游差异计划的第 5 批。
生产范围仅为 `utils.ts` 和 `autocomplete.ts`；不涉及 MCP 启动或 OAuth。

## 正确性与上游依据

- 官方 v1.0.0 的 `17f3dccbe` 修复列切片边界的 ANSI 顺序。Super Pi
  保留 ASCII 快路、共享字素分段器以及 `sliceWithWidthInto` 的调用方工作对象，
  在追加边界控制序列之前先写入先前积累的序列。颜色复位、组合样式和 OSC 8
  超链接关闭都按原文顺序输出，宽字符和 strict 边界规则不变。
- 完整调用链审计发现，Super Pi 的 `highlightTerminalColumns` 单次扫描实现
  也有同源问题。选区起点和选区之后的起点分别修复，不退回三次切片。
  新测试既检查明确的预期字节，也通过真实 `TuiAltScreen.renderNow`、帧队列和
  测试终端检查最终输出。既有全列边界等价测试继续运行。
- 官方 v1.0.0 的 `65117e31f` 修复前导空白斜杠补全。命令判断、名称匹配、
  返回前缀及参数偏移统一使用 `trimStart()` 后的文本。`applyCompletion` 原有
  前缀定位因此保留输入空白和光标后缀。测试覆盖空格、Tab、Unicode 空白、
  多行输入、参数前缀和真实 Editor 输入/Tab 接受；强制文件补全保持原分支。

最终新增用例对原始生产代码的复验：17 项中 15 项失败、2 项通过；
修复后 17 项全部通过。基线通过本地模块重定向加载 `1bfe11abb` 的两个生产文件，
只调整依赖路径，不改生产工作区。原始基线和重定向后的最终用例日志均保留。

## 调用链与分配审计

审计依据：[热路径分配契约](hot-path-allocation-contract.md)。

1. 会话更新经 `InteractiveMode.handleSessionEvent → handleEvent →`
   消息组件更新/版本推进 `→ TuiBase.requestRender → scheduleRender → performRender`。
   键盘输入经 `TuiBase.handleInput → Editor.handleInput`，补全完成后也进入同一渲染调度。
2. 主屏 `doRender/renderVisibleDocument` 和全屏 `doRender → renderLayoutFrame`
   生成可见行。覆盖层走 `compositeOverlays → compositeLineAt → sliceWithWidthInto`；
   滚动条走 `styleScrollbarCell → sliceByColumn`；Input 横向滚动、Editor 历史
   指示器、选区复制及最终越宽裁剪也是切片调用方。
3. 三个切片入口汇入 `sliceColumns → findTerminalSequenceEnd / isSimpleTerminalAsciiRun`；
   非 ASCII 分支使用模块级 `Intl.Segmenter → graphemeWidth → eastAsianWidth`。
   正则来自模块常量；字素宽度计算不把切片文本写入共享宽度缓存。
   全屏选区走 `applySelection → highlightTerminalColumns`，复用同一组基础函数。
4. 合成行经行复位/宽度检查、差异帧拼接，交给
   `TerminalFrameQueue.submit → start → ProcessTerminal.writeFrame/startFrameWrite`。
   稳定的写完成/drain 回调经 `completeFrameWrite → queue.finish` 释放拥有权。
   `performRender` 的 finally 清空临时帧引用；队列完成、失败及 abort 释放待写引用。
   逻辑取消仍保留 OS 写入的物理代次直至其回调结束。
5. 补全路径为 `requestAutocomplete → startAutocompleteRequest → runAutocompleteRequest →`
   `CombinedAutocompleteProvider.getSuggestions → fuzzyFilter/参数提供者`，然后
   `applyAutocompleteSuggestions/SelectList → applyCompletion → requestRender`。
   过期快照/取消检查不变，取消清空 UI；最终组件释放重置请求 Promise、计时器和缓存。

新增分配及已有成本分开记录：

| 路径 | 已有成本 | 本次变化 |
| --- | --- | --- |
| 切片/选区叶子 | 输出字符串拼接；Unicode 分段器的迭代记录及子串；`sliceWithWidth` 外部返回对象 | 只移动待写控制序列的输出时机；闭包、Promise、控制器、对象/数组字面量、动态正则、`String()` 均未新增 |
| 覆盖层 | 每实例工作对象和可复用数组；输出行字符串 | 继续调用 `sliceWithWidthInto`，不创建包装对象；finally 清空行和切片字符串引用 |
| 全屏布局 | 既有视口数组、布局 box/rect/clip、字符串输出与缓存 | 不改变布局分配策略；实测每帧 box/rect/clip 为 10/21/10，视口行数组 1，并非整个 TUI 零分配 |
| 帧提交/写入 | 每实例稳定回调；显式 flush 可建立共享等待 Promise | 正常每帧 Promise/AbortController/包装对象/整帧复制均为 0，帧字符串生成 1 次 |
| 命令补全 | 原有 async 请求链和取消控制器、每请求的命令条目与模糊匹配数组、外部结果对象 | 多一个局部字符串引用及 trimStart 调用；无新增闭包、对象或正则；只在输入请求时运行 |

补全不是零分配路径：既有 Editor 请求含一个 async IIFE，调用自身、IIFE、
`runAutocompleteRequest` 和 provider 的 async 函数会产生 Promise；每次实际请求
有一个 AbortController。非空名称查询的 provider/fuzzy 层已有五个数组，
N 个命令条目、M 个匹配分数对象和一个结果对象，规模由命令集合/命中数决定。
附件防抖另有原有计时器闭包。这些既有成本没有移入逐帧绘制，也没有在本批改写；
不把“本次未新增”写成整条输入链符合零分配标准。

不引入对象池。采样主要成本是输出字符串、字素迭代和已有查询/布局记录，
没有满足新增池的收益与所有权证明条件。

## 性能采样与释放证据

同机 Windows、Node 26.4.0、`--expose-gc`，基线生产 HEAD 为 `1bfe11abb`。
先采基线，再修改生产代码；采样时未并行构建或运行全量测试。
Inspector 采样间隔 1024 字节，计入回收对象。表中总量包含基准夹具开销；
原始 JSON 保留主要分配站点，不能把总量全部归因于被测生产函数。

| 场景 | 基线分配 | 候选分配 | 基线 p95 | 候选 p95 |
| --- | ---: | ---: | ---: | ---: |
| 切片 + 单次扫描选区，每轮各调用一次 | 924.45 B/轮 | 943.24 B/轮 | 5.183 ms/千轮 | 5.351 ms/千轮 |
| 已有 `/he` 命令补全 | 1861.33 B/次 | 1860.96 B/次 | 2.550 ms/千次 | 2.495 ms/千次 |
| 完整全屏渲染，混合覆盖层/选区 | 69819.64 B/帧 | 69480.76 B/帧 | 0.1855 ms | 0.1730 ms |
| 仅队列，预建 64 KiB 帧 | 104.82 B/帧 | 109.43 B/帧 | 0.0956 ms | 0.0956 ms |

叶子各 100 批 × 1000 次、预热 20 批；全屏 500 历史项、120×40 视口、预热
300 帧、测量 1000 帧；队列预热 1000 帧、测量 20000 帧。这是一次前后配对的
采样数据，不是精确分配总量或统计性能提升证明；切片样本增加约 2%，没有为了
降低数字隐藏字符串或 Unicode 成本。队列代码未变，其采样波动也说明不能只凭
单个小幅差值认定回归。补全使用修复前同样成功的 `/he` 比较，避免拿旧版返回
null 的缩进查询作不公平基线。

- 两版完整渲染的确定性计数相同：每帧选区处理 11 行、覆盖层合成 2 行，
  完成的历史条目重绘 0、全历史回退 0；全视口数组复制 0；每帧字符串生成 1。
  即时写入设备夹具的活动/待写高水位为 1/0；慢写、替换、失败与取消边界由现有
  `tui-frame-queue`、`tui-terminal-state`、`tui-async-owner-closeout` 回归覆盖。
- 正常 flush 后活动和待写字节均为 0。覆盖层和选区临时引用数在帧后与停止后
  都为 0。五轮重新创建/停止全屏实例后，组件、源字符串、缓存行与屏幕引用均为 0。
  控制 GC 的末次堆占用基线 16,175,152 B、候选 16,137,768 B；这是进程整体堆，
  包含 profiler/运行时数据，不等同于 TUI 持有大小，也不据此宣称长期内存无泄漏。
- 新叶子基准每轮采样结束在 finally 清空 caller-owned scratch，检查空字符串和
  width=0，保留五次控制 GC 记录；新 Editor 回归通过最终 dispose 检查取消控制器、
  下拉列表和计时器清空。既有测试补足覆盖层 render 抛错、请求中止和挂载替换。
- AST 门禁扩大到 `sliceColumns`、`sliceByColumn`、`sliceWithWidthInto` 和两个扫描
  helper；禁止新增内联函数、对象/数组字面量、展开、动态正则和 `String()`。
  Unicode 迭代的运行时分配仍由采样体现，不把 AST 检查当成零堆分配证明。

采样脚本：

```text
node --expose-gc --experimental-strip-types scripts/bench/tui-ansi-slicing.ts
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-allocations.ts --fixture production-alt --alt-control mixed --items 500 --frames 1000 --warmup 300 --lifecycle-cycles 5
node --expose-gc --experimental-strip-types scripts/bench/tui-frame-queue-allocations.ts --frames 20000 --warmup 1000
```

## 最终候选验证

- 类型检查、离线构建、两个生产文件/两个测试文件/新基准脚本的语法检查及
  `git diff --check` 均通过。
- 13 个相关测试文件 309 项全部通过，包含渲染源码门禁、队列及终端生命周期、
  覆盖层/选区、Editor 释放和本批回归。
- 同一生产候选完整运行 223 个唯一执行单元，与 runner 清单逐项核对一致。
  按每个执行单元最后的汇总计数，避免重复计算嵌套测试输出：
  **3,467 项，3,377 通过、90 按条件跳过、0 失败或取消**。
- 按本次完整测试日志中的身份检查，runner 临时根目录已删除。
  新回归不创建共享临时文件、不启动外部进程。没有清理其他会话文件或日志。

本地证据位于 `.git/tui-correctness-20261004/`，包括采样原始 JSON（分配站点、
源文件哈希、GC 与引用计数）、修复前后回归、构建、类型检查、完整测试与汇总。
本地测试使用设备边界替身，不能代替真实终端目视验收。GitHub CI、Linux / Node
22.19 和用户实际终端交互尚未验证。以上为提交前的本地候选验证。
