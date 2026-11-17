# 压缩后恢复会话的历史显示

## 问题与核实

用户在更新后打开同一 session，发现旧对话不可见。只读检查原 JSONL：约
175 MB、1178 条消息、2452 条记录，全部可解析，无重复 ID 或缺失父节点，
当前分支链完整；原有两个压缩检查点，没有新增本地维护检查点。归档较
之前增大，未发现消息被删除。未改写原日志、调用真实供应商或重放旧工具。

界面恢复和设置重建使用 `buildContextEntries()`，其职责是选出模型的
压缩后上下文，因此省略了已总结的旧记录。界面的 `renderSessionEntries()`
又跳过整个 compaction 条目：它自身的摘要及显式 retainedTail 也不能显示。
打开压缩后的终端会话可能只剩状态通知。该显示路径原已存在，本次在旧会话
恢复场景复现；不能据此归因为本地维护删除了数据。

## 修正边界

- `renderInitialMessages` / `rebuildChatFromMessages` 读取当前选中分支的完整
  归档，而非模型上下文。切换分支仍排除兄弟分支，编辑历史恢复原用户输入。
- 每个实际压缩条目只生成一个摘要卡片。原调用和结果已在归档中，不重复
  展开 retainedTail。失败源码精简、长度恢复完成时的本地结算都使用显式维护
  标识，不重复显示或计作新压缩。不根据相同摘要或缺少 usage 猜测历史条目
  的性质；缺少显式标识的旧条目保留显示，避免误隐藏实际压缩。
- SessionManager 的上下文构造、供应商发送、工具定义和缓存策略不变。
  显示旧历史不把它加入模型；界面初始恢复和再次重建后，模型消息、请求
  转换 JSON 以及归档均保持相同。

## 回归与性能范围

三个写盘后重新打开相同 ID 的离线场景先在修复前失败，再在修复后通过：
legacy 切点、显式 retainedTail、SDK 终端维护检查点。另验证真实长度恢复
结算方法追加检查点后，写盘重开保留维护身份、只显示/计数一次摘要。覆盖两次压缩、旧用户/
助手消息、尾部仅一次、兄弟分支排除、原生摘要可见、维护不重复计数，以及
重建后的下一次请求转换不变。使用合成日志，不依赖用户真实会话内容。

调用链审计为 restore/显式重建 → 当前分支归档 → renderSessionEntries →
renderSessionItems → 原有 retained components / viewport index。修改仅在恢复
和显式重建生命周期中执行；维护元数据仅在本地检查点结算时浅拷贝一次，
原生历史继续共享引用。未修改逐 delta、progress、布局/帧或写队列热
路径，不运行额外分配基准。没有新增缓存、池、逐帧闭包或历史 payload 复制；
既有 branch/items 数组由一次重建拥有，组件由 transcript clear/disposal 释放。
显示更多正确历史有相应的一次初始化成本，不以原先遗漏内容的较少工作量
声称性能提升。

定向 92 项通过，包括长度恢复及后续请求/重载、5000 个历史工具 retained sidecar、50000 条混合历史的
有界发现扫描、分组 read、选择区跨重建/异常/GC 释放。类型检查通过。
验证入口：

```text
node --expose-gc --experimental-strip-types --test --test-concurrency=1 tests/tui-resume-compaction-history.test.ts tests/tui-transcript-selection-reset.test.ts tests/tui-retained-session-rebuild.test.ts tests/compaction-tail-policy.test.ts
node --experimental-strip-types --test tests/pi087-length-recovery.test.ts
node --experimental-strip-types --test tests/tui-retained-source-invariants.test.ts tests/tui-retained-transcript.test.ts tests/tool-prefix-providers.test.ts
```

完整离线构建、套件及最终 head 的 CI/review/合并结果见对应 PR。
