# T11：多语言工具检索与多词排序

状态：先行设计已落盘，开始实施。T10 #192 最终提交 fb0762bf8c28a8e9c6fe015bd1e81e64e29c10c9 获 reviewer completed/no findings 和六CI通过，合并为336ea2bfb124bf1b26a92c69fb659f99fd894246；两端任务分支已删除，本项从同步main创建 codex/t11-tool-search-ranking。只使用 Node26。

## 已审计边界与复现目标

显式 tool_search.execute → readToolCatalog → available/active/policy-owned/category/browser 路由过滤 → query/name/description 匹配 → 排序/limit → setActiveTools → getActiveTools 验证实际 added/rejected。BrowserRoutingGuard 的事件回调是高频边界，保持现状；不能把新分词或规范化移入事件、每帧或常规模型请求。既有真实 SDK/Codemode 测试覆盖权限过滤、精确工具名及浏览器 approval pause。

当前 normalizedTerms 只有 lowercase/split，未做 NFC；中文/日文连续字符串不能按词查找；名称和描述混在同一个完整 haystack，每词一分，缺少同覆盖度时的名称权重，重复查询词可能重复加分。先用组合字符、中文/日文无空格、英文多词与重复词用例红灯，避免仅按上游改动推断需求。

## 最小设计与排序规则

1. 查询在显式入口 trim/lowercase/NFC 一次，category/debug routing/exact-name/terms 共用。工具名与描述每个合格 catalog 项各规范化一次；不把组合字符拆成不等价词。保留 Unicode marks。
2. 复用 Node26 Intl.Segmenter 的 word 粒度拆解含汉字/假名的查询片段；其他语言维持字母/数字/mark 分隔，工具名下划线仍可分词。查询词去重，原始完整查询仍用于精确工具名匹配。无词查询仍返回无匹配，不发明模糊/拼音/翻译服务。先在实际 Node26 核对分词输出，再确定夹具，不为每个词造白名单。
3. 去掉每个工具的 name+description 全量拼接 haystack，分开检查已规范化名称、描述和固定 category aliases。比较顺序：精确完整名称最高；保留原有类别/本地调试优先；之后先比较覆盖词数，再比较名称覆盖数，最后按原始工具名确定性排序。若继续公开 score，采用随去重词数 n 推导的权重：coverage*(n+1)+nameMatches，范围小于 (n+1)^2，类别优先为一倍该界，精确名为两倍该界，避免魔法常数被多词突破。category 本身已过滤，不改变可激活工具集合。
4. 只有显式搜索产生短生命分词结果/候选数组。固定 Segmenter 可模块拥有且无 catalog/query 引用；不建永久索引、generation cache、词对象池或新增依赖。保留已有 activation 后验证，不能把相关性当授权。

## 验证与性能门禁

聚合 tests/tool-search-ranking.test.ts 使用真实 extension.execute，覆盖 NFC/NFD 双向、无空格中文与日文、名称vs描述、完整覆盖优于部分名称、重复词、精确名、稳定tie、unavailable/active/policy-owned过滤、browser_debug/普通browser隔离、activation拒绝及catalog变化。既有 SDK/Codemode 权限/approval regressions 和 codemode-hot-paths source invariants 必须通过。

生产 benchmark 100/1000 catalog，显式单查询最大200字符。统计查询词数、规范化次数、includes比较数和sort比较数；没有 per-term 再次规范化或全文haystack副本。串行基线/候选分配、CPU/p95、受控GC；查询/catalog caller释放后，保留extension和结果时不得保留旧catalog/tool对象。分词对象生命周期局限一次查询；返回name/score属于caller。若语义增强增加合理成本应如实报告，不能把时间噪声当优化；无profile证据不引入缓存。

先相关测试和benchmark，再check/build:offline/Node26全套。PR只包含本功能及交付记录。主动review；有建议修复推送并独立@codex review；等最终head reviewer完成、六CI全过，再按exact branch/head清理并进入T12。

## 实施与验证记录

7项先红灯再绿灯：NFC/NFD双向、中文、日文、名称权重、重复词和无预组合形式的mark。最终只改 classification 的查询边界和得分；不增加永久索引或新的activation入口。每次查询NFC一次，每个合格工具的name/description各一次。固定Intl.Segmenter不保存查询/catalog；原始返回名称不改写，因此规范化不会改变传给setActiveTools的标识符。中文“搜索数据库”在当前Node26 ICU拆成“搜索/数据/库”，日文“検索ファイル”为“検索/ファイル”；不声称跨语言翻译或词干归一化。

完整调用链及边界：extension初始化注册一次tool_search/BrowserRoutingGuard → 既有SDK tool catalog授权/可见性 → 显式execute → category/active/available/policy/browser过滤 → query词循环 → sort/limit → 既有setActiveTools及实际added/rejected确认 → Codemode observation/provider下一轮工具视图。BrowserRoutingGuard事件回调及render/provider delta链未改。真实SDK/Codemode/MCP/policy回归 **175/175**，定向排名/source/GC与既有codemode-hot-paths合计 **23/23**，check/build:offline通过。

生命周期与分配：新query Set、split结果、Array.from和ICU分词记录仅一次显式搜索拥有，最多受原始200字符query schema约束；没有catalog级缓存。候选数组延续既有设计，最多合格catalog项数，sort后截为limit≤12；现有requested/map/filter/spread/activeSet、async execute Promise和result包装均是此显式命令的已有边界，不移入事件回调。词循环无closure/Promise/controller/object/array、无再次normalize/全文拼接。每事件/frame新增这些对象均为0，无池化。execute在匹配/activation前没有await，不新增异步取消owner。

100/1000目录结构计数：英文3词，normalize=201/2001，substring comparisons=400/4000，sort comparisons=99/999；日文2词，normalize相同，substring comparisons=600/6000。每次catalogReads=1，不匹配时activation=0。正常激活、拒绝激活和activation抛错后，替换catalog、保留extension及返回details，旧catalog数组/100或1000工具对象在受控GC后全部释放。source invariants和既有browser routing零分配约束通过。

三组串行baseline/candidate，预热10、计时4096、profile32、HeapProfiler间隔1024。初始256次pilot出现WindowsCPU计时分辨率下的零值，已排除并增加样本。1000工具英文采样分配中位数 **787408→350918 bytes/search**，p95 **0.4093→0.4390ms**，CPU **343.3→377.7μs/search**；日文 **703887→268154 bytes/search**，p95 **0.3278→0.4172ms**，CPU **274.7→343.3μs/search**。新NFC/分词/名称排序语义有CPU代价，不能声称时间全面优化；绝对开销仍在该机每次显式搜索亚毫秒范围，分配减少约55%/62%，GC后heap没有上升。未为回避成本添加ASCII猜测、缓存或多套fallback。语义改善与资源成本分开记录；旧实现无法召回无空格多词查询，不是同质量检索基线。

临时baseline文件按记录的完整路径删除。Node26全量 **410/410执行单元，5495 tests / 5397 pass / 98 skip / 0 fail / 0 cancelled**。最终PR review/CI待验收；原始记录在 `.git/pi150-t11`，结构化数据见 [T11证据](../evidence/pi-150-t11-tool-search-ranking.json)。
