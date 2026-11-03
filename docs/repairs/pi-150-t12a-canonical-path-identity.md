# T12-A：真实路径名称、旧信任记录与同文件去重

状态：已按先行方案实施并完成性能回退修正，正在验收。基线6b0f8a10459709aaad9e0e8818771e8abd6e109e，Node26.13.0。总顺序见[T12方案](pi-150-t12-path-equivalence-plan.md)。本批为共同canonical helper、trust兼容及必要的选择器身份读取边界；session cwd匹配、local package remove和自定义目录来源的独立根因留给后续批次。

## 根因、兼容边界与最小候选

Windows上的fs.realpathSync会保留目录输入大小写，而native版本返回实际大小写。同一目录不同拼写的dev/ino相同；现有canonicalizePath输出却不同，trust键和Skills去重因而失配。先用真实临时目录测试跨大小写、drive拼写、namespace路径、junction、缺失路径、不同对象及同名Skills冲突；不使用真实用户配置。

canonicalizePath只把已有realpath调用替换为native，保留既有失败原样返回，不再加另一套fallback。native按实际filesystem名称区分大小写敏感目录，不把路径统一toLowerCase。所有20处消费者逐项审计：trust/bootstrap、Skills、package资源去重、resource-loader合并/提示模板/worktree context、ConfigSelector继承开关和SessionSelector树/当前会话标记。各调用原有路径展示和缺失行为保留，必要compat问题先用测试证明。

旧trust.json仍读原始key，不在get时重写。一次getEntry中为已保存的绝对路径生成请求拥有的canonical决定映射，null忽略；同身份boolean冲突标为冲突，只有匹配到当前目录或其最近ancestor时明确报错，不能让无关冲突阻止其它目录。相对/无效legacy键不新解释为cwd授权。祖先遍历只读该映射，不反复I/O；键数量N时最多N次legacy重定向检查、N次native解析加一次cwd解析。无长期缓存。

setMany表示显式用户选择。每批读取旧key并解析一次，针对每个被更新实际目录清理其旧拼写，再按当前canonical key保存决定；clear(null)清掉该目录所有已确认alias。其它key和决定保持原样，显式更新可解决该目录旧true/false冲突。不能因同字符串prefix删掉另一个目录，不能对解析失败的路径猜测等价。写文件仍使用已有lock/serialization边界，不新增格式版本、后台迁移或重试。

## 热路径、状态与验收

共同helper目前已在SessionList.render的每可见行和ConfigSelector继承开关render查询调用。此批不凭空增加渲染缓存或改变删除前真实身份校验；必须跑实际两种选择器的渲染基线/候选profile，记录canonical/native调用次数、每render分配/CPU/p95、受控GC后frame数组和dispose后的component释放。完整链为选择器输入/列表装载 → requestRender → TUI布局/组件render → helper → frame queue/physical writer；新增每frame closure/Promise/controller/wrapper/array为0，已有路径字符串和布局数组属于基线，不能隐去。没有对象池或新retained路径表在render生命周期外。

基线在改生产前运行3次，候选在改后同机串行3次，明确记录顺序及源码hash。初始列表/资源装载和warmup不计入渲染计时；fixtures为真实存在的小文件/目录，避免把缺失路径catch成本当通常路径。信任读取/写入记录native调用数，并验证读失败/冲突不写文件、显式更新只影响对应身份。缺失路径和namespace/junction的实际可用范围要标明，远程UNC不可用则不声称已实测。

先路径/trust/Skills红绿测试、选择器回归与source invariants、生产allocation profile和frame queue计数，再check/build:offline/Node26全套；独立PR并主动review。最终head审核完成且六CI通过再合并、删除两端对应分支并同步main，进入T12-B。

## profile后、UI修改前的方案修订

第一候选只换native并修复trust，27项相关测试通过。真实选择器3轮profile发现每帧API调用次数仍为10/28，采样分配下降但p95/CPU约增加30%：session p95约0.598→0.775ms，config约1.497→1.953ms。不能把这种高频代价转嫁给每帧。下一步先按下面的owner方案修改UI，再重测；第一候选原始结果保留，不改写为最终成绩。

SessionList在constructor/setSessions入口根据已得到的currentSessionCanonicalPath建立“当前文件的列表路径”Set，只保存本次列表里匹配的path字符串，最大长度不超过列表数；setSessions清空后重建，dispose清空。render只查Set；原isCurrentSessionPath保留真实native解析，删除确认继续调用它，以免junction在显示后变化导致错误删除。列表快照显示与操作前核对明确分开，不做全局路径cache；现有buildSessionTree的装载/过滤解析单独记入setup，不挪到frame。

ConfigSelector既有ResourceItem包装在buildGroups入口多一个identityKey字符串，生命周期随当前资源列表；render继承标记查这个字段，不再拼字符串/调用filesystem。toggleResource入口先重新计算该item的identityKey，再执行既有override判断/写入，保持操作时路径核对。无新增Map/缓存框架；旧全局继承索引原有刷新语义不变。组件释放后这些item/key随owner释放，更新字段丢弃旧key引用。

验收增加：正常render路径解析0次；列表替换及dispose清空匹配Set；保留selector时旧列表对象释放；junction在列表展示后换目标，删除仍依据操作前解析拒绝当前文件；配置toggle前身份更新有实际探针。再次运行相同baseline/最终候选profile，区分一次性装载I/O和每帧I/O，保留CPU/分配/生命周期证据。

## 信任旧键重定向：实施前补充方案

自查发现直接native解析所有旧键会把“原受信任目录后来被junction替换”的旧授权转移到新目标。旧版本保存的是legacy realpath输出，因此旧键兼容必须先确认legacy realpath仍返回原key；只有未重定向的key才转换为native拼写。已重定向或无法解析的旧键保持原字符串，查询及显式选择仍解析当前实际目标。读取不写文件，更新新目标不删除原目录历史记录，不增加版本迁移、文件句柄或全局缓存。

先增加实际目录被替换为junction/symlink的失败回归，再加入仅用于已保存key的转换helper；Windows大小写别名冲突继续覆盖，POSIX的GC测试不把人为写入symlink别名当作合法历史canonical键。I/O证据分别记录legacy/native：9个普通旧键的get为9/10次，2项更新为9/11次，无祖先或每项更新重复解析。本批保持既有路径身份模型，不宣称inode绑定授权或并发文件系统替换的原子保证。

## 最终实现与已观察证据

canonicalizePath换native后，Windows大小写、盘符、8.3短路径、namespace路径得到一致实际名称；缺失路径仍原样。真实Windows大小写敏感目录成功启用，两种case对象inode不同且trust决定不混淆；junction在Windows、symlink在POSIX用同一语义测试。远程UNC服务未实测，不据此宣布网络盘覆盖。Skills同文件别名只保留一次，不同文件同名仍报告collision。

trust读取构建一次操作拥有的Map，以null作为已检测boolean冲突的内部标记；原文件null不参与决定，普通读取不写文件。只在最近命中的实际目录冲突时报错，无关目录仍能读取。保存key先核对legacy realpath仍返回自身，才统一native拼写；后来被junction替换的目录不会把历史授权转给新目标。setMany只更新已确认同身份的旧alias键，新目标的更新保留已重定向旧目录的历史决定；9条记录的get为9次legacy/10次native API调用，2项显式update为9/11次，不按祖先层数/更新数量重做每个key的I/O。正常、更新、clear及Windows冲突共5个操作Map在受控GC后全部释放。相对legacy键不变成当前目录授权；其它记录及写锁边界保留。

SessionList的Set随列表替换整组丢弃重建，销毁时clear，不保留旧大背板；只含该列表中匹配当前文件的path字符串，最大条目数受列表数约束。删除入口继续调用真实路径检查。ResourceItem在构建时保存一个identityKey，toggle先更新再走现有配置逻辑；没有额外索引或缓存框架。配置组件及其items随owner回收，列表替换的旧Set也已用WeakRef验证回收。新增每frame closure/Promise/controller/wrapper/array均为0；原有layout/override helper的数组、Set及格式化字符串仍计入完整frame profile，不能把整个选择器宣称为零分配。

原基线、native-only中间态、最终候选分别串行3轮；warmup20、timing1024、profile64、采样间隔1024。30项列表的最终装载native API计数session91/config60，显示帧从10/28降为0/0；删除和toggle的显式操作仍解析。最终中位数：session **208126→176433 bytes/frame，p95 0.5982→0.2925ms，CPU 565.4→274.4μs/frame**；config **634777→540743 bytes/frame，p95 1.4975→0.5378ms，CPU 1282.2→503.9μs/frame**。GC后heap约25MB，最终比基线增加约0.3%/0.2%，不是零驻留成本。旧frame数组在组件存活时回收，旧身份Set在替换后回收，组件dispose/release后回收。

58项路径/trust/Skills/选择器及TUI source invariants通过，check/build:offline通过。最终Node26全套412个执行单元成功，5512项测试：5414通过、98跳过、0失败/取消。frame queue生产计数100000请求→2次render/写入，active write≤1，完整帧复制0，frame Promise/controller/wrapper0，flush后active/pending bytes及write归零。新增删除测试曾缺少全局键绑定，已按真实启动契约补齐；Map探针修正泛型构造签名，生产未加任何兜底。测试清理器也换native身份比较，修复临时目录短路径与长路径误判；每个新fixture记录精确root并由既有owner清理。

最终PR reviewer/CI待验收。原始记录 `.git/pi150-t12a` 保留native-only回退证据及最终profile；结构化证据见 `docs/evidence/pi-150-t12a-canonical-path-identity.json`。旧键重定向回归先红后绿；最后修复未触及选择器，原最终选择器源码hash及profile仍适用。
