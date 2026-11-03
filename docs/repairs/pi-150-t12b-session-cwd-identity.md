# T12-B：自定义session目录中的cwd等价匹配

状态：先行方案已落盘，开始独立复现。T12-A #194最终head 421cecb10270528a04537f45740a3e4edede70eb经修复后复审completed/no findings，六CI通过，合并为adcd1a6ec866fad3d02c836529a8873a1f38ecd3；两端任务分支已删除，main已同步。本批分支codex/t12b-session-cwd-identity，只使用Node26。

## 根因与范围

session-manager.sessionCwdMatches仅resolvePath(header.cwd)===resolvedCwd；SessionManager.list和continueRecent对显式非默认sessionDir启用这个过滤。实际同一Windows目录的大小写/短路径/namespace别名或junction因此可能查不到历史。findMostRecentSession通过同一判断决定候选。默认session目录依cwd文本编码成历史bucket，不能未经迁移设计改名/移动/覆盖旧session；本批保留bucket规则，修正现有比较入口。

显式sessionDir与默认dir的比较也只有字符串不等：若只是既有目录别名，不能错误改变是否按header.cwd过滤。usesDefaultSessionDir也使用同一比较，它在显式打开/切换会话选择器时决定all scope是否跨默认bucket，并在退出时决定恢复命令是否携带session-dir；不属于render/delta路径。三处共享一个实际目录比较helper，保留字符串相等零I/O入口。先用真实文件及header创建红灯，覆盖list、continueRecent、findMostRecentSession、usesDefaultSessionDir和显式默认dir别名，确认所有入口原本语义。

## 最小设计

引入扫描拥有的cwd matcher（函数/小型私有对象择最清楚者），查询目录canonical身份一次，缓存该次扫描中每个不同header.cwd字符串的匹配boolean。先做既有词法exact比较；只在实际需要时调用T12-A canonical helper。相同header.cwd出现N次不能N次realpath；Map容量≤该次扫描不同cwd数，扫描结束或异常后自然释放，不跨列表/不全局缓存。缺失/空/非字符串header不扩大匹配；解析失败仍按现有helper的明确词法值比较，不把失败当任意项目。

list和findMostRecent各创建一个owner；continueRecent复用后者，不再建立第二套匹配。显式sessionDir与usesDefaultSessionDir用同一个实际目录helper，默认bucket的创建和名称保持原样。header matcher先检查非空字符串，词法相等不解析文件系统；需要比较别名时才求query canonical，之后该扫描共享。native查找只在显式扫描/入口，不进入session append、provider delta、frame或每次进度回调。保持mtime排序、有效header过滤、旧格式读取、stat races处理和未匹配时创建新会话的原有语义；不新增fallback、重试或对象池。

## 验收

真实临时JSONL夹具：目标目录的不同拼写/junction能list/resume，其他项目即使mtime更新也被排除；同名prefix不同目录不能混淆；missing cwd只匹配明确词法相同；Windows大小写敏感不同对象仍隔离；显式默认目录别名保持原本无额外header过滤规则；无参数默认bucket仍能读取既有会话。最近会话用明确不同mtime避免测试时钟竞争。

固定100/1000个header候选，重复相同cwd和少量不同cwd，记录native调用次数只随不同身份字符串增长、query身份一次、无按每entry调用；控制GC证明保留返回SessionInfo/SessionManager时matcher/Map已释放。读取是显式低频边界，报告已有文件读取/stat开销，不把新状态放进高频lookup。若测试暴露实际热路径，则先更新方案并补source/AST及allocation profile；不偷偷引入持久索引。

先相关session/paths测试，check/build:offline/Node26全套；独立PR和主动Codex review。有问题修复推送并额外@codex review，等最终head审核完成与六CI全过，再merge/精确删两端分支/同步main，进入T12-C。

## 实施与已观察证据

最初9项测试中6项失败：Windows拼写、junction双向、默认bucket别名及其扫描/释放断言；3项既有missing/大小写敏感/词法fast path对照通过。最小实现为一个`isDefaultSessionDirectory`共享比较入口与一个scan-owned matcher。默认bucket名称函数未改；in-memory session的空目录sentinel仍不分类为默认bucket。查询canonical延迟到首次词法不等时，重复header.cwd仅做Map读取；精确原始cwd命中为0次native调用。

100/1000真实JSONL文件，90%同一junction cwd、10%另一项目，recent均3次native调用，list/continue均5次（另2次为共享目录与默认目录比较）；查询cwd、alias、另一项目各一次。相似prefix仍隔离，missing仅词法相等，empty/非字符串/损坏header排除。Windows实际启用大小写敏感目录后两个case对象inode不同且只匹配各自会话。默认bucket中旧header无cwd仍可通过默认路径及其别名读取，保持原语义。

每次需要cwd过滤的显式扫描新增一个Map及一个matcher闭包，容量≤不同的非exact header.cwd数，正常/error返回后释放；3个正常Map和1个目录不存在退出Map经受控GC全部回收，返回sessions和manager仍存活。已有扫描文件数组、header包装、stream/Promise、filter/sort闭包未隐藏或改写；这些是显式session discovery开销，不进入append、delta、progress callback或render。本批无对象池、全局cache、新兜底链，不宣称整次文件扫描零分配或全面提速。

53项session/path/append/选择器及相关source invariants通过，check/build:offline通过。最终Node26全套414个执行单元成功，5531项测试：5433通过、98跳过、0失败/取消。最终PR审核CI待完成；结构化记录见`docs/evidence/pi-150-t12b-session-cwd-identity.json`，原始红绿与计数日志位于`.git/pi150-t12b`。
