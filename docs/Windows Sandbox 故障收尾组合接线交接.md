> **已退役的 Windows Sandbox VM 资料。** 当前运行与验收入口见[执行环境](execution-environments.md)和[测试](testing.md)。历史脚本可从[退役记录](documentation-status.md#windows-sandbox-vm-retirement)定位。

# Windows Sandbox 原workspace grant续验后续交接（2026-11-02，§54完整闭合）

**当前状态（2026-11-03）：本轮 Windows/Node 整合交付范围已完成。四项剩余任务、P0 真实桌面回放及性能检查均已闭合；结果、支持范围与兼容条件见本文件末尾 §70。以下旧状态均为历史记录。**

用户于2026-11-02明确纠正：从未要求每阶段完成就新建工作/审核窗口；其原意是在上下文已经很大，例如连续几十轮输入后，才考虑换窗口。此前“每阶段完整后新建并归档”的交接表述是助手误传，立即废止，不能作为后续授权。当前继续使用工作/审核（十二），阶段完成不触发新建或归档。持续依序实现、源码预审、唯一最小验证、原结果/清理/记录复核、精确暂存及暂存后独立确认的工程流程另行保持。本文件替代§53后的交接。§47–54均已完整闭合；历史章节“待审/待暂存”不构成重做依据。

## 工作权及固定执行边界

- 旧工作（十一）：01a19a96-2c47-76c2-a60c-19ec72c4e843，host local。
- 旧审核（十一）：01a19a95-ff3f-7ab2-9a03-78282bed9d44，host local。
- 新工作（十二）：01a19ab4-4f53-7910-a03b-978d6a278390，host local。
- 新审核（十二）：01a19ab4-3b39-74b3-a434-b699c4ee9f19，host local。

用户持续授权双方沟通及工程审核流程。工作/审核（十二）已完成指定只读核对，§54最终交接已完成预审、精确stage及独立确认，旧工作已发“正式继续”并停止编辑；工作（十二）独占继续。此前逐阶段新建/归档依据已被用户纠正，后续不得重复。若将来上下文确实积累很大，再按实际需要考虑交接，不以阶段边界替代该条件。

共享工作区D:/RMProjects/Pi；宿主命令仅D:/PowerShell/7/pwsh.exe、login=false，无PS5。生产热路径改动须审完整调用链并给结构/分配/引用生命周期证据；本项只追加低频权限观察入口，旧hot方法逐字未改，无对象池，不扩跑热路径基准。按需读§48–53和相关源码，不翻全历史聊天。

不commit/push/reset/clean、广泛stage，不重跑§47–54/旧链接/容量/共享矩阵；一次额度重置授权已耗尽，不重置/购买/充值。原九docs未暂存删除保留：interactive-control-image-input.md、native-batch-cwd-integration.md、native-files-next-phase.md、next-phase-n1-evidence.md、next-phase-n2-evidence.md、next-phase-n3-evidence.md、next-phase-n4-evidence.md、next-phase-usability-reliability-efficiency.md、upstream-pi-0.99.1-diff-assessment.md。唯一未跟踪super-pi-clipboard-fix.patch保持；不清历史全cached对HEAD的EOF提示，只查本阶段旧blob→新blob增量。

当前契约§0有效：全来宾不可信、宿主独占输入/授权/版本/真实提交与收尾。用户已取消可信来宾监督、Task SID/HMAC、平台系统可写层及全部开销的任务级硬上限承诺，不恢复；平台层耗尽宿主磁盘风险已接受，专属共享卷硬容量要求仍保留。生产真实工程接入/default/旧权限退役关闭，P0桌面回放独立待办。发布、隔离cwd/副本、固定工具摘要、离线依赖仍执行前置，不整体RW共享工程，不自动安装依赖、执行工程、提交或回滚。

## §54完整闭合及原结果

源码A–B同版完整复审→首次唯一八组→完整原输出及两路径独立复核→三结果记录复核→六精确文件stage→审核（十一）暂存后独立确认，全部完成。无本项实际目录、native资源、工具会话或恢复责任遗留。

最终六scope：新增packages/coding-agent/src/core/files/input-workspace-grant-lease.ts、新增tests/windows-sandbox-input-workspace-grant.test.mjs；packages/extensions/resource-lifecycle-guard/permission-controller.ts仅新增低频方法/import/helpers；固定方案/契约/主方案三记录追加。SessionFiles、§48–53/source/preparation/reader/capture均未改。本阶段只有原grant固定与真实异步FS观察；讨论过的native/source组合没有实施，不能据早期草案当已接通。

紧邻核六获审SHA、四旧index blob、index2013/六外2009摘要和固定Node/PS7后，唯一命令：
D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-input-workspace-grant.test.mjs

原commandExecution exec-4b16f0cf-9441-4bf5-9504-5847e7600ebc，所在工作turn01a19a9a-f357-7d22-8221-4e9624fe14d0；实际completed/exit0/duration1055ms，output.truncated=false。chunkefb9ae/wall1.0554931s直接结束，无工具session。8pass/0fail、cancelled/skipped/todo0、678.9659ms。原完整输出3637UTF8B，11JSON含各LF2588B，审核直接read_thread独立计算一致。无独立stderr测量，时间含启动且不是优化结论。无提前导入/编译/探针/冒烟、第二次运行或旧矩阵重跑。

- 唯一root C:/Users/Administrator/AppData/Local/Temp/sp-workspace-grant-I720KY，原dev3637606815/ino3659174697854282；work子目录原dev3637606815/ino2251799814301003。两节点创建/识别即记录路径及原id，最终created/identified/removeAttempted/removed全部true，safe=true/errors=[]。
- work在末组作为既定清理按原id精确rmdir，旧lease的renew随后因真实lstat ENOENT拒绝，未重建目录或新grant。root随后原id清理；原测试两路径分别Node ENOENT，审核另以固定PS7分别PathNotFound/ObjectNotFound（chunk788723），不是第二次Node检查。
- 42次prepare+renew请求含前置拒绝，33次真实assessment，26个构造成功后/初始async观察前登记的lease最终live0/pending0/hosts0。不能把42当实际FS观察数。内容文件/bytes/receipt签发/native reader/capture/显式fixture open-close0；worker启动/调用差值及pending0。Node隐式元数据I/O、全进程句柄/V8分配未全计量。
- 同源新class、caller paths改动不影响原表、正常renew仍原binding通过。七次prepare前置拒绝的assessment增量0；safe但错误原inode由真实bigint lstat拒绝1次。grant accessor及Error.message getter均未调用。
- 原grant四字段、真实additional restoreCheckpoint同sequence对象替换、槽/路径映射改变和恢复后持续拒绝通过。primary没有公开替换其private对象的入口，覆盖其原四字段；additional覆盖实际对象替换，不捏造primary对象替换证据。
- A：真实assessment已完成但await未交付的内部六支，和真实lease.prepare已完成ready/pending=false但Controller还等待交付的迟到grant/revoke两支分列。后两policyDisposals1、全部pending0；Controller末次await返回后调用提前固定原assertCurrent才发布，catch固定原dispose。core prepare/renew直接返原run Promise。
- B：两原目录身份随日志可接管；错误记录只取native Error own data descriptor，有界name64/code128/message640，不取stack/getter/任意toString，非native对象只记类型，falsy区分；失败仍抛原Error或AggregateError保留各原错。此次无清理错误。
- pending revoke/dispose、throw undefined/null/0、末次ctx callback1改变grant、吞重入均拒绝且恢复不复活。保持ready lease wrapper存活，四轮tick/GC后controller/state/ctx/grant/inputPaths五指定目标live0；stale检查后refs/paths/grants/metadata0、observer/verifier清、policyDisposals1。任意外持原Error/binding副本不在该GC结论内。
- registerHooks仅把新core与其原policy两个internal导出映射到同一源码URL，动态加载当前Controller后finally即deregister；其余既有包导出沿当前环境，不声称全dist重建。

三结果记录追加前410130/112384/650486B获审前缀逐字保持。六文件实际stage后审核（十一）独立命令chunkf30931/exit0确认index2015/六外2009 SHA256 4B3D2A1B9F9AA73927C4CB51D5EBD87641508888EE37F3F6635E1A80D41C0B90、六worktree=index、四old→new增量check及两新cachedcheck全0，九删除/patch保持。§54无剩余审核阻断。

| 文件 | 当前SHA256 | index blob |
| - | - | - |
| input-workspace-grant-lease.ts | 0CDD8818402A02D995C197BAEDC8A29D8243005C0EA33FC88297E34BBD64BD28 | 7d58eeb235c9f2c159fafcbbc6e90c2dce59515e |
| permission-controller.ts | 3B77A490FBC5F552848F662A09142218F6DDF29162CFD6847E99D709B788321F | e8b230d5cbed4326058647264cd26d0cc0892cfa |
| input-workspace-grant.test.mjs | 6912352D3955DD2FCA4551EA183319E008A771E470DF2CBB741FB7EF6D430DEA | 923be21a453d09f82df2a14de4b776fc6908663d |
| 固定方案 | D5C7CAA4A0B853EBAE31278AFA6EB4DAACED78FD5DFE45B97C331FE8AB5EE45F | a65493b54eb282f79fc363cf760572c42f2eb856 |
| 契约预审 | 35E114973813CF60F2504C53E2DF2EA593E5E24EBA584F5E7380734B95EAD5F0 | 32f5d08c7ab6b995ea0689f340e6450c325792f3 |
| 主方案 | 31F2E8ADAB49CE4D704EA1F9A6607854F4C514E85CA33CC7E5E765871AD6AF33 | 28646a8a3ae6934c958bb6bba7ee32cff21b2cba |

本交接更新前index2015/交接外2014 SHA FBB6D1EAA5D29E049E632E504F9EA19955B191A2A70E3A8667821BE6A08BD415；旧交接blob068063cd444202203fa40f272b4e90e53b2639a5、SHA3DED9D1601BC3E1F16F9BFCCB31F266693DF7F521C055F7DEAEA32529860FF9D。摘要算法为git -c core.quotepath=false ls-files --stage精确排除scope，LF连接补末LF，UTF8 SHA256。本交接stage会改变六scope外摘要；下一小项按自身scope建新基线。

## §54接口的准确语义及限制

Controller.prepareInputWorkspaceRead(ctx,paths)先冻结paths并按原primary优先/additional顺序选原grant，首次相关await前固定原grant对象WeakRef、原槽及requested/canonical/device/inode；所有path必须仍映射同一原对象和槽。对象freeze只是数据保护，不是OS隔离或恶意同进程认证；公开constructor/binding也不能用作来源认证，未来必须从实际SessionFiles的原Controller边界取得并绑定来源。

原number只有safe uint32 device及safe positive inode才转bigint，真实lstat(bigint)严比原dev/ino；不准Number(nativeIno)舍入比较，不准新stat重新签原grant。requested===canonical、绝对规范非盘根；alias、full-access无grant、跨grant拒绝。真实fixture若不精确要保留实际拒绝，不能换目录寻找可用identity。纯阶段用own data descriptor取grant字段与additional槽，拒绝accessor，不执行其getter。

InputWorkspaceGrantLease复用§53 InputReadPolicyLease固定原ctx/signal含undefined、cwd/session和原generation/sequence守卫。每次assertCurrent先允许ctx回调的policy检查，再纯policy+原grant对象/fields/所属槽/全部path映射检查；后面不触ctx/runtime。observe固定static，无strong controller/state闭包；每条path真实assessTarget返回必须canonicalTarget全等且workspace是原对象，再lstat(bigint)普通目录/非symbolic/dev/ino与realpath(original requested)全等，每个await后以及结尾check。prepare单次，renew对原paths/grant重做FS观察，失败/重入/撤销后单调。改变再恢复若已被检查发现不能复活；不声称捕获所有未观察的并发变化或实现FS锁。

new→observing→ready。原falsy异常独立failed保存。revoke/dispose清逻辑refs，pending中的static observer与run临时强借issuer/ctx/grant/binding/paths直到原操作结算；不能把此时diagnostics归零说成在途临时引用都释放。同步assertCurrent只核身份；binding getter是冻结primitive数据，不是独立授权、fresh FS证明或可直接给§52 authorize的callback。外持该数据寿命归caller。

1–34 paths、单path4096/全部8192字符；原单grant requested/canonical各4096共8192，原policy另cwd4096/session64。Controller初次async期间有targets冻结副本，policy拥有一份冻结表，lease借同表；renew不重建。新lease自有weak issuer/ctx/grant3个，policy另weakctx/可选signal及原weakissuer守卫。结构预算不是全heap计量。当前没有receipt/source绑定、没有native content read、没有发布字段接口。

## §48–53基础及不可丢失的所有权边界

§48输入固定task/snapshot/session/epoch/sourceRoot和expose/operation/原revision/identity/hash，16项/单4KiB/源总16KiB含non-expose/49目录/32KiB metadata。不遍历真实工程，不由.gitignore/protected path/写回许可推出read授权。§49 OriginalInputRevisionLease只核原FileRevisions/原receipt与Buffer成员，WeakRef不延长退役寿命；至少一原full receipt，空/纯add/compact拒绝，不latest/refresh/remember补原baseline。公开remember/get不是恶意同进程签发认证。

§50 SessionFileRevisionSource仅从既有service取得，pin不getService/补建。弱持owner/service/revisions/ctx/runtime/execution boundary/signal，固定双generation/cwd/session/signal含undefined。source.current只是生命周期/来源，不授路径权；专用source不能多个外owner共享。兼容read证据不是完整native installed read。§53/54均未改该source。

§53 InputReadPolicyLease只有原policy/ctx弱身份和冻结paths；Controller.prepareInputRead复用旧authorizeFileObservation真实async scope/workspace检查，但不保留强闭包，纯assertPolicyIdentity不触ctx/runtime也不做FS。SessionFiles.pinInputReadPermission必须既有service及原compatibility boundary明确支持新能力，与source的runtime.executionBoundary不同，缺失拒绝、不getService。SessionInputReadPermission弱借source/owner/service/ctx/boundary并独立pinctx/signal，source.revisions必须原service.revisions；它不释放source或外SessionFiles。

§53 checkSource在ctx/source校验后末尾以固定assertInputReadOwner(finalOnly=true)核owner.closed/accepting/service/boundary与source state，无ctx/runtime回调。permission current最后source回调后再pure policy；外preparation最后原receipt后再pure owner/policy，不能交换先后把另一侧检查移没。prepared/checkPrepared/pure检查不是FS续验。WindowsInputReadPreparation首次await前固化canonical/原receipt，独占自己的source和OriginalLease，permission只弱借；不公开capture许可或source转移接口。§54没有接它；不能把该私有source同时交§52。

§53首次唯一8/0/10800.4821ms、actual0，exec-371182c3-1db4-490e-9ddd-9d29d3ae0cee工具11174ms，原输出3314B/4JSON2330B；曾session72457已唯一poll退出。9兼容签发45B、prepare36/assess83、33登记live/pending/host0，native/capture/worker差值0；sp-input-permission-r2wbc3/source.txt两节点按原id已清、各Node ENOENT+审核PS7 PathNotFound。A独立pinctx/signal、B真实观察await内/完成后迟到分别拒绝、C末次callback7/14/36当次拒绝和GC9目标live0已通过，不重做。

§51 Windows x64本地NTFS原native reader：固定drive/GUID/卷根dev-ino，Nt卷根后RootDirectory+单basename逐组件开。OPEN_REPARSE_POINT后tag/type/白名单0x20b7/nlink/DeletePending、双GUID-DOS canonical/dev32/ino64/LastWriteTime/ChangeTime/hash核对；ObjectAttributes.Attributes=0、只有SHARE_READ，不依赖OBJ_DONT_REPARSE，不声称锁住attribute/EA；不Node open降级。当前initialize只卷根及sourceRoot有预固定expected，中间祖先原identity在打开时采样，尚无原workspace grant约束。

单reader81目录+1叶峰82、256 open尝试、8192业务native calls、ReadFile4096、单4KiB/总16KiB、tree metadata64KiB另authority32KiB、scratch2264B不自动扩大。原slot先登记后native，每slot最多close一次；非success/pending带handle不可盲关，Unknown保留原slot/ops/attempt/error。ops.dispose失败即使activeHandles0仍未知，不能假称全关后成功或重试原dispose。

§52 WindowsInputCapture品牌后schema前接管专用source，构造失败也释放，不能与preparation共享。canonical一次固定给原lease/input/native，source.revisions只同步借。guard是原lease→独立同步authorize(binding,entries)严格true→原lease/source/单调状态，覆盖native各业务前后/短read；当前authorize是受控可信接缝，不是真实grant/FS续验。活动leaf期间CaptureIO.file只同path stat原token，不缓存/重开/签发。

input成功仍私有；reader.settle末次metadata/hash、全叶与祖先关闭后，还要末次source/lease/authorize才外captured。失败先存原错并清全部私有bytes，再native cleanup。Unknown保留原reader/input/ops/slots/attempt/operationError/cleanupError，不重试；input cleanup complete不能盖native未知。copy前后同guard，后置失败清实际新copy和全部私有输入，不返回；成功外部copy归caller。wrapper内部固定binding/entries尚无发布接口，不可回读路径或用可变caller input拼快照。

§52原exec-92d79377-7beb-4df7-8b01-56b20e9d89b8首次8/0/406.5233ms/actual0；五reader25B、58句柄全关/峰8、业务native9081+bootstrap1且单reader最高1989、scratch11320+2264释放。8兼容签发40B/wrapper0，12capture登记均收尾；sp-input-capture-JZpuoL/source.txt已原id清理并独立确认。模型四HANDLE责任与一个active0的ops释放Unknown不是实际失败；GC8目标live0，authorize仅结构释放。不重跑旧§49–52/compact或旧已清路径。

## 下一阶段的最小依赖次序（尚未实现）

1. 新工作/审核先核真实Controller grant经原SessionFiles compatibility boundary到source/receipt的来源与namespace绑定，冻结接口/精确scope/状态/资源和唯一合成预算，再实现/先审后验。不能仅凭InputWorkspaceGrantLease instanceof或caller自造冻结descriptor授读取权；需固定原controller/boundary、实际原grant、原ctx/会话及原receipt。不得latest/refresh/新receipt补原基线。
2. 可考虑独立grant-aware operations适配，不改旧reader：在原reader.open之前仅借已登记slot，命中原grant canonical目录时先核旧expected如有必须同原dev/ino，再设置原grant精确bigint identity；旧reader原inspect即核验，失败不能下降/内容read。构造先证grant是drive→sourceRoot完整组件祖先且同drive/dev、requested===canonical、单grant覆盖全部paths；目标必须命中恰1次才read。同级sourceRoot和上级祖先分别验证，不能只字符串startswith，也不能没匹配到仍成功。适配不持slot/HANDLE、不新建close责任，真实WindowsSourceNative固定原prototype方法，模型另列。
3. 新外owner可独占一个专用source及OriginalLease，permission弱借；或明确一次转移到§52。不能重复拿§53私有source给两个owner。每await前后核同原source/receipt/ctx；末次receipt/ctx callback之后必须pure owner+grant身份收口，二者后不能再有外callback。可由SessionFiles把原private static assertInputReadOwner(finalOnly=true)传新桥，桥weak持owner/service/ctx/source/boundary，不必改旧§53core。旧checkSource先核owner、之后再receipt、最后只grant的时序仍会漏末次owner变更。
4. 若新wrapper把原reader.read成功结果再做外层postcheck，失败时旧reader.catch无法清该已返回buffer；wrapper须先清本次实际借用请求切片，再剩余cleanup。分别计重叠清零，不声称撤回历史成功交付caller的bytes。吞重入/revoke在busy栈只失活，由展开owner收尾，不能native回调中提前close。Unknown保留原责任，正常GC不外推到Unknown。
5. 原native grant绑定完成后再审全close后的async capture/copy生命周期。§54 renew只是某次原paths/grant的FS观察，不锁路径、不授权未来copy。新消费续验期间私有bytes不能发布；之后同原source/receipt/完整canonical/policy校验，失败清私有或实际新副本，Unknown不覆盖。固化元数据安全发布另审，不能回读源路径或接可变input。
6. 显式原snapshot写回仍独立缺口：WriteParameters additionalProperties:false且无snapshot，FileService.prepare未收snapshot会选latest。后续需严格UTF8/字节往返、add=create/modify=overwrite、完整prepare、锁内全项预检及逐项临近复核/finally释放，保留conflict/partial/committed/not_committed/unknown，停后续不自动回滚，delete/move拒绝。
7. 发布、隔离cwd/副本、固定工具/离线依赖、真实执行/候选消费/宿主提交尚未接，生产/default/权限退役/P0不自动通过。旧固定VHD生命周期、GUID共享32B、114MiB后Win32 112、§38合成候选与§47唯一manager-loss现场保持原限定；旧失败不重写、不重复现场。阶段完成后在现有工作/审核窗口继续，不自动新建或归档；仅在上下文已经很大时考虑换窗，不把等待当阻断。

## 固定工具

Node D:/Nodes/26.13.0/node.exe SHA14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5；PS7 D:/PowerShell/7/pwsh.exe 7.6.9 SHA2A6769A3330DC1084D0154BFDE7D164AB750CA7F700F313F9D417C1BE78B2233。§54首次命令紧邻核两摘要。

未来实际native若用Koffi3.3.1，其node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node旧SHA072EFA48190587A6181BE48F99F28D52DB106C4D2137FE237DE0D49B892A00F6，届时紧邻核；本轮没有native reader，旧摘要不是本次I/O证据。旧WSB0.8.107.0/csc沿旧记录，未来使用再紧邻核，不提前探针或重跑现场。

## 当前进展补充：§55首次唯一验证失败，尚未验收

工作/审核（十二）按上文最小依赖实施§55，源码A–C复审通过，但首次唯一运行原exec-b43637ed-6a74-4cdb-9762-07701f72263d actual exit1/788ms。八业务组1pass7fail，after成功条件另fail，框架tests9/pass1/fail8/696.4559ms；完整输出15667B/7JSON含LF2314B和三路径清理已独立复核。固定方案55.5及契约0.53保留详细事实，不重跑§55或改写成通过。

本次root/work原inode10977524092331301/11821949022463271超过MAX_SAFE_INTEGER，permission-state原grant签发采用number lstat，freezeInputWorkspaceBinding按既定精度门槛在assessment前拒绝。7prepare/0assessment、8登记wrapper最终live/pending/hosts0；真实/模型reader与内容0，8兼容签发40B、fixture1open/close、bootstrap1call/2264B分配（原输出未单列释放计数）。目标native绑定/迟到失效/Unknown模型/GC均未取得证据。

唯一C:/Users/Administrator/AppData/Local/Temp/sp-workspace-source-38nJlw及work/source.txt三节点均按原id清理，各Node ENOENT与独立PS7 PathNotFound/ObjectNotFound，无实际资源/Unknown遗留。源码/测试保持获审SHA，记录待复核。下一独立依赖先审全新原grant签发时保留exact身份、原对象关联及兼容/恢复语义；不得续验补发原unsafe grant、换目录碰运气或把新证据回填成旧运行成功。继续现有工作/审核（十二），不按阶段换窗。

## 当前§56精确签发前提（源码待审）

§55失败记录已独立复核，九文件均保持未暂存，原索引基线未动。§56新增原签发same-observation精确sidecar：首次primary/成功add才登记、已有primary.restore只比较不补来源，clone/持久化不继承。Controller固定原state prototype查询、lease弱pin sidecar含undefined与纯尾核，旧数值观察/JSON保持。八scope与现有并集十二scope，index2015/外2007 SHA5245C596421A292DA8F12B603673C88FB719F9885CB4E55AC6BF7B2E25336D3D。新六组两空目录的源码尚未运行/暂存，完整方案和预算见固定§56/契约0.54。

不重跑§55或用新stat修补其原unsafe grant，不把新前提结果当作旧native组合验证通过。实际后续整合仍须独立冻结范围/源码预审/唯一验证；留在现有工作/审核（十二），不按阶段创建/归档窗口。

## 当前§56限定验证已通过，进入记录与暂存复核

首次唯一六组6pass/0fail、actual exit0，原commandExecution exec-15b3df0a-9641-4fba-b270-c4db4d1f9826/chunk4a2361，完整3400UTF8B/11JSON含LF2648B及两路径清理已独立复核。实际root/work均unsafe legacy inode；精确原签发、克隆不升级、既存primary比较不补发、pending撤销及ready lease四轮GC六原目标live0均为本次限定证据。两目录按原身份清理，独立PS7确认不存在；live/pending/hosts0，0内容/receipt/native/capture，无本项资源遗留。详细计数/界限见固定56.4。

原§55整合失败保持；不能将本次前提通过写成原生HANDLE绑定、外层迟到、post-read、Unknown或组合GC通过，也不重跑旧矩阵。四记录结果与精确十二路径方案复核后一次暂存，预计index2019/外2007及原外SHA不变，实际闭环以独立暂存后同版核验为准。原九文档删除及super-pi-clipboard-fix.patch保持，不commit/push/PR。继续当前工作/审核（十二），阶段结束不触发换窗；生产/default/旧权限退役、§0/P0/额度边界保持。

## 当前§57：补原精确签发下的读取组合证据

§56唯一6/0及十二文件暂存后独立复核完成，实际index2019，旧§56范围外2007摘要保持。用户已明确“请继续完成剩余任务”，不能以完成一个小项代替全部剩余任务。沿依赖先做§57新五组整合：真实sourceRoot/ancestor、原await与bridge迟到、真实post-read清零、模型identity/busy/四Unknown/全关后拒绝、prepared含原sidecar十二目标GC。仅新增tests/windows-sandbox-issued-workspace-source.test.mjs及四记录；旧八源码/test不改，§55首次失败仍保留，不重跑旧文件/矩阵。

当前仅源码草稿，未运行/暂存。一个root/work/source.txt固定5B；真实reader3/15B，成功交付10B/外层拒绝清5B；模型≤12/≤64B、host/grant/receipt各≤12、prepare≤40/assessment≤128，bootstrap和三个reader的scratch分配/释放分别计量，完整预算、预期计数与清理见固定§57/契约0.55。五scope外2015 SHA EDBBCCDFAA9881549691A3A8B6480BC94D5BE9FF814F37700206B76C12C58F25。完整源码复审后才唯一运行。

之后还须完成capture/copy与安全发布、原snapshot写回、真实隔离执行/候选消费/宿主应用变更以及P0和最终切换验收。既有§0取消承诺/额度边界、原九删除/patch、不commit/push约定保持；继续当前工作/审核（十二），不按阶段建窗或归档。

## §57新读取组合已通过，继续capture/copy接线

首次唯一5/0、actual exit0，exec-af01e0d9-521d-43d1-bd4a-6feed5e827e9/chunk21ae52，14227UTF8B/20JSON13552B及三路径清理已独立复核。真实sourceRoot safe/ancestor unsafe均绑定原精确身份；15B底层读取/10B交付/5B外层拒绝清零，29实际句柄全关，scratch9056分配=释放，模型11/28B及十二目标GC通过，各证据仅限自身范围。没有实际Unknown/临时路径遗留，旧§55失败不改写。

新test及四结果记录五scope待记录与精确暂存复核，预计index2020/外2015及§57原外摘要不变，最终以独立暂存后核验为准。下一项继续同原source/receipt/grant在全close后的异步续验、私有捕获/复制和固定元数据发布，后续原snapshot写回及真实执行/P0/最终切换仍须完成。原八实现/test及原删除/patch保持，当前对话继续，不按阶段建窗/归档。

§57暂存格式修正记录：首次精确git add五路径已执行，但后续cached差异检查发现新test第496行EOF多余空行，原命令chunk533254实际exit1，不记成暂存复核通过、不reset/unstage。仅删除测试末尾一个LF（0x0A），从38669B变38668B，当前SHA256 6547A7E94069F93DECF9143589C745E74D93C0887785EC286E0670A1543A10E4；在内存回拼该LF后严格恢复已运行原SHA C98F678BD88C9C3D04EACCC5FF5B4E7FE5384677C900E2DA723250F3B2A47F06（chunk18a035）。执行内容未改，不重跑；§57原运行5/0及原字节输出证据保持。四记录只追加此事实，修订摘要复核后精确更新本五路径暂存，再做完整同版/范围外/余留原改动检查；当前不预称该修正已完成暂存复核。

## §58 同原授权的输入捕获、复制和元数据发布（源码预审，尚未执行）

§57五路径格式修正已完成最终独立暂存核验（工作chunk99568a、审核chunkd14f4b均exit0），index2020，范围外2015摘要保持。继续当前工作/审核（十二），不按阶段创建或归档窗口；全部剩余任务仍包括原snapshot写回、真实隔离执行/候选消费/宿主应用、P0实机与最终切换验收。

本项仅八路径：session-input-workspace-permission.ts、windows-sandbox-workspace-source-reader.mjs、新windows-sandbox-workspace-input-capture.mjs、新windows-sandbox-workspace-input-capture.test.mjs和本四记录。基线index2020，本范围外2014条目SHA256 5375FEF0BCA9D80DCAB12A6406F2D4AFE15466DAE71C84EA9F70629D34D60FDE。不更改原九删除或super-pi-clipboard-fix.patch，不commit/push/PR；旧§55失败不回填，不重跑§55–57或旧容量场景。

桥接层新增同一个InputWorkspaceGrantLease固定prototype renew；没有重新prepare、重签grant或receipt。每层await回来重新验证原source/receipt/binding，最后为无回调owner+grant纯核验。reader的seal只在全部原生资源已关闭后保留原guard，禁止再次read/initialize；原settle仍释放guard。seal/cleanup complete本身不等于capture成功。

新owner独占reader和OfflineInputSnapshotOwner：new→preparing→capturing（同步借用）→renewing→captured；capture只在全关和原授权续验后返回。copyFile每个暴露条目最多一次，先同原续验，再分配copy，返回前做完整source/receipt/binding及最终纯核验；拒绝时清新copy和私有原buffer，已成功交给调用方的历史副本由调用方负责。publishMetadata最多一次，同样续验和最终核验，返回构造时冻结的原canonical数据；元数据不是授权。最多16条/每文件4KiB/总16KiB/metadata32KiB，故成功阶段最多初次1+copy16+metadata1次续验。grant续验重观察原授权目录与当前许可范围，不宣称捕获后所有文件仍未变化；宿主写回须另核原snapshot磁盘基线。

撤销在异步等待中立即清理未被借用的私有buffer，并使原reader失效；同步读取/回调仍持有buffer时只标记、由原栈返回后清理。pending直到原调用落定才归零。任何Unknown保留原reader/operations/slot/error/attempt责任，不因active=0推定complete，不重试dispose/close。CaptureIO的活跃同路径检查使用原token stat；底层失败先全关时，仅在固定原reader诊断明确complete、native complete/active0/unresolved空且原token精确匹配时确认该token已关闭，不再native close，不掩盖最初错误（含undefined/null/0）。

唯一拟运行新test六组，完整源码独立预审后才运行固定Node26.13.0 --expose-gc --test --test-concurrency=1该文件。一个sp-workspace-capture-* root/work/source.txt三节点固定5B，记录原身份逐节点清理；真实reader恰3，真实读取总15B：exact/ancestor两次正常capture与真实post-read撤销一次；业务每reader open≤256/peak≤82/native calls≤8192/read calls≤4096，合计open≤768/calls≤24576；bootstrap仅volume一次。scratch为bootstrap+3reader各2264B，预计9056分配=释放；私有capture每次5B，两个成功调用方副本各5B，第三次实际读取外层拒绝清5B并确认已关token一次。

模型reader≤20（源码18）、模型读取≤128B（分支固定请求、每read最多2B）。六异步gate：capture/assessment撤销、copy/assessment撤销、metadata/assessment重入、capture/bridge完成后owner变更、copy/source完成后原grant变更、metadata/bridge完成后原receipt失效；每例新model capture最多5B。三同步分支为read撤销、read抛undefined、leaf close后撤销；三Unknown为pending open、leaf close抛0、所有句柄关闭但dispose抛0，保留原责任不重试。两post-copy原receipt回调改变owner/grant，实际新copy各5B清零；一次成功copy后重复copy拒绝且历史副本保持；两个模型验证seal与原settle释放语义；captured wrapper仍存活时四轮GC检查十二原目标含签发sidecar，随后消费拒绝并清私有buffer。

host/grant原签发/receipt各≤12、prepare≤40、assessment≤256，JSON报告≤48KiB，逻辑receipt每次5B；test没有worker、外部进程、VHD、WSB或生产切换。报告先记真实分支部分结果/缺计数/原始错误和责任，再做成功断言；Node隐式metadata I/O、全部OS句柄和V8分配不声称完整计量。属于低频验收/授权生命周期扩展，未改provider/render/event等热路径、不引入pool、不作零分配或热路径性能提升声明。当前仅源码静态检查，尚未import/编译/测试/暂存，最终证据以首次唯一实际执行及独立原输出/资源核验为准。

§58源码预审修订（未运行）：审核cursor77指出两处测试前置错误，现已修正。第六组两个standalone reader各通过原token分段读取完整5B、核对alpha并close，再验证seal/settle；两个测试buffer共10B在finally清零。第四组close失败只注入openKind=read，明确记录且断言读取5B、原read close恰一次、原handle和Offline owner保留token同槽、重复dispose不再调用close。分项模型读取：六await gate30B，三个同步分支2+2+5=9B，三个Unknown0+5+5=10B，post-copy三例15B，standalone两例10B，GC捕获5B，总79B/18模型；保持≤128B/≤20上限。真实3reader/15B、9056scratch和其余预算不变。实现三文件未改，仅新test及四记录追加；仍未import/编译/执行/暂存，修订摘要复核后再唯一运行。

### §58首次唯一验证结果（独立原输出与资源复核通过）

获审test SHA60FD22AAA972DD5105632C20DE73157E922A7132E483A687D2B557DB40C95490，三实现摘要未变。紧邻preflight chunk6e27e3/exec-52ec91cf-076f-41c6-b948-4ffa759e21a4通过后，首次唯一执行固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-workspace-input-capture.test.mjs。原commandExecution exec-e65969b5-a80f-4236-a4a9-1b97a33f5e45/chunkec6f15，actual exit0/completed/1074ms、工具wall1.0747453s、框架981.7238ms，6pass/0fail，无cancel/skip/todo/工具session。原输出42204UTF8B，22JSON含LF41430B（≤48KiB），stderr无独立字节计量；时间不作优化证据。

审核cursor89已从原始执行记录独立确认命令事件与原工具输出逐字一致；现场检查chunk1320fc实际exit0，以下三登记路径均PathNotFound/ObjectNotFound，原身份清理证据一致，无本项实际资源遗留。八获审文件/七冻结依赖/六旧暂存对象均未变，原九删除/patch保持。

唯一root C:/Users/Administrator/AppData/Local/Temp/sp-workspace-capture-Elcpz7及work/source.txt，dev均3637606815，原ino依次3659174697855695、4503599627988166、3659174697856242；三节点逐原id/类型/父链/canonical校验清理，各Node ENOENT。fixture显式open/closeAttempt/closed各1，记录节点3，无保留fixture handle。host/原grant/receipt签发各8、逻辑receipt40B、wrapper重签0；prepare21/assessment88、登记21，最终live/pending/hosts0。

真实reader3：底层15B/3次read，source成功交付10B，真实read先返回5B再外层拒绝清5B；实际open/closeAttempt/closed均37（13+13+11），peak9、active0、unresolved[]。业务nativecalls5762（2246+2246+1270）加bootstrap1；bootstrap和三reader各scratch2264B分配=释放，总9056/9056、retained0。真实capture私有分配15B清15B，两个成功副本各5B，两个metadata与copy均在native全关后续验同原grant，各3renew/原grant observations4，无重开原生reader。真实post-read拒绝确认原已关token恰1，无duplicate close；其原错误workspace source inactive由外层保留。actualUnknown0，worker启动/调用差值和pending均0，missingCounters/errors均空。

模型18、实际读取79B（30+9+10+15+10+5）。六原await/完成后gate及重入均拒绝并归零pending；同步借用在原栈返回后清理；三Unknown分别pending未决slot、原read close抛0、全部handles0但dispose抛0，保留原slot/token/error/attempt责任，重复dispose不加close。两个post-copy回调真实分配新copy各5B后拒绝并清零；历史成功caller副本不被后续拒绝清掉。standalone两个原token读完后验证seal保留guard和旧settle释放guard，独立测试buffer10B分配清10B。所有capture私有分配90B清90B；copy分配25B=交付15B+拒绝清10B，成功15B由测试finally清零；这些层次可能清理同一底层借用，不把重叠清理相加成独立实际内存。captured wrapper保持存活，四轮GC十二原目标（含sidecar）live0，之后消费拒绝并释放私有bytes。

证据仅覆盖本项capture/copy/metadata和模型生命周期。模型Unknown不是实际OS遗留；Node隐式metadata I/O、全部OS句柄、V8分配不声称完整计量；immutable元数据不是授权；授权目录续验不承诺捕获后所有文件仍未变。§55旧失败/§56–57原结果不改写。后续原snapshot宿主写回、真实隔离执行/候选消费/应用变更、P0实机及最终切换仍未完成；生产/default/旧权限退役保持关闭，不恢复§0取消承诺或旧额度场景。

本次八路径待精确暂存及暂存后独立复核；预计index2022，本范围外2014条目及原SHA5375FEF0BCA9D80DCAB12A6406F2D4AFE15466DAE71C84EA9F70629D34D60FDE保持。原九删除/patch不改，不commit/push/PR，不按阶段新建或归档窗口。

## §59 原生写入显式原snapshot与兼容隔离（源码预审，尚未运行）

§58已最终闭合：工作精确八路径暂存exec-21493b7c-23aa-4d4f-9175-0203e8379134/chunk6f47f4 exit0；审核cursor97/独立chunk4306e0 exit0，八工作SHA/blob/六旧→新/两新cached检查一致，index2022/外2014原摘要保持，仅余原九D+patch。六组唯一6/0及§55旧失败均保持，不重跑。

采用审核cursor95/97同意的native-only 11scope：core/files/file-parameters.ts、file-batch-protocol.ts、file-service.ts、file-invocation.ts、file-batch.ts、session-files.ts，新tests/windows-sandbox-explicit-write-snapshot.test.mjs及本四记录。基线index2022，本范围外2012条目SHA256 71F52AA79FB24708AF3E51614E0CA3DDEB2C93E24D68675C8DEAB6162375ADE2。旧extension两入口不改，§58其他源/test不改，不commit/push/PR，不按阶段新建/归档对话。

WriteParameters原样保留，另加NativeWriteParameters，由原schema属性派生并增加符合SNAPSHOT_ID_PATTERN的optional snapshot，仅FileService验证与SessionFiles.install(write)选用。copyBatchInput默认不接纳write snapshot（包括原先拒绝的own snapshot:undefined字段）；仅core FileBatch固定传内部true启用，不把该开关放入用户input。显式snapshot只允许overwrite，create拒绝。FileService mode=create+snapshot在路径观察前拒绝，缺失目标的显式snapshot在creation判定后拒绝，绝不把修改退成新建；现有input.snapshot ?? latest选择保持，显式原版本不重新取latest。缺省snapshot原行为保持。

单write请求摘要在原content字段后，仅当snapshot !== undefined时追加固定snapshot;标签及结构化长度+值；批量通过已有递归绑定同字段。缺省snapshot的旧摘要保持，例如write/source.txt/next无purpose的旧SHA256 80b5943cd8c85e39d1f9476c908dcdcb09e7a5a814c8cc41401d7ae760392df7。这样prepare/permission/consume同原输入校验能够发现快照替换或移除；不能把摘要当作独立授权。

调用链已只读审查：原生SessionFiles prepareInvocation→FileBatch/FileService prepare→mutationRequestHash，Controller原path approval→consumePermissionPathApproval→同invocation consume；旧extension reexport WriteParameters及默认copyBatchInput仍拒绝新字段，旧write body不会静默忽略已公开的新字段。另核对hash在完成/意图记录和/changes有界恢复中的使用，缺省旧hash保持。改动限schema初始化、有限调用的准备/授权消费、每次请求的摘要；不改provider/message_update、progress delta分发、render/layout、terminal或Evidence Ledger lookup，不引入pool，不作热路径优化/零分配声明。实际installed permission消费、host writeback及Sandbox执行仍是后续整合，不能由本项preflight证据替代。

唯一拟运行新test一个有界组合：纯旧/native schema对比，五种非法snapshot及extra field/create拒绝；旧默认batch拒绝显式与own undefined，原生batch保留冻结原snapshot；single/batch hash更换snapshot不同、single移除不同、旧缺省hash不变。实际一个sp-explicit-snapshot-* root/source.txt共两节点，exclusive初写alpha5B，然后同原file identity的r+改写beta4B，仅fixture初始化/外部变化模拟共9B；两次真实issueSnapshotForRead签发原receipt合计9B。显式old在newest仍live时拒绝且不调用latest；原old失效后再次拒绝；显式newest准备成功、legacy缺省调用latest恰1；缺失目标snapshot/create+snapshot拒绝、缺省create只准备不执行。最后batch先准备missing.txt create，再因old snapshot拒绝，已有item全release且items0；检查source仍beta和missing仍ENOENT。

预算：一次Node26.13.0 --test --test-concurrency=1该新文件，direct prepare恰7/上限12，FileBatch.prepare一次含另2次service prepare，whole-batch执行入口0、宿主应用请求0；fixture显式open/closeAttempt/close预期各2、write9B，final读4B并finally清零；receipt签发2（守卫上限3），成功direct plan3分别release，service.dispose后revisions0。只登记两节点，创建成功即先登记路径再取得原id，按原身份/类型/父链/canonical逐节点清理；任何close未知不重试，不猜测清理路径。不启动worker/WSB/VHD/helper或做容量/旧矩阵验证；native worker启动/调用差值与pending预期0。报告先列实际部分结果/原责任和错误，再作最终断言；Node内部stat/read/文件提交预检的临时buffer不声称完整OS句柄或分配计量，也不外推实际写入完成。

当前仅11scope源码/记录草稿和静态差异检查，尚未import/编译/运行/暂存。完整源码、冻结摘要及本预算独立复审后才唯一验证。之后继续候选bytes严格UTF8往返、原snapshot+原会话的安装后权限/全批预检/逐项提交回执、真实隔离输入/工具清单/执行/P0及最终切换；全部剩余任务仍未完。

### §59 首次源码复审纠正：有界历史恢复（未运行）

审核cursor101发现changes.ts旧恢复字段白名单拒绝新write snapshot，使合法新请求的/changes回执无法关联。按同次明确范围调整，将core/files/changes.ts加入原11scope成为12scope；其原65807B/SHA256 61D05CD2BC8EEEF13DBE6176B2CFCAD4F1BAC5FFA90DE555E4BC48E56263D2B5/blob299cd9ad4eba14458549ea6e975caa4d7e68184b。紧邻扩围基线chunk25d0fb exit0：index2022，范围外2011条目SHA256 BF5638A36FE505671A76F724FC5AF4496B41FD5511222FB36C9BC163F2F98BF4；changes.ts改前工作区等于原index。其余原基线保持，原11scope说明保留为首次提案记录。

修正仅允许单项/批量write恢复字段snapshot；有值时按现有字符串预算消费至多27UTF8B并检验原SNAPSHOT_ID_REGEX，批量仅overwrite，create+snapshot拒绝。沿用原总4MiB恢复预算、每次mutation1MiB预算、有限512条分支、原requestHash/顺序/target/terminal检查，未调用observe/verify或扩大可重放权限。完整调用链复查：唯一生产collectChanges调用位于显式/changes命令，入口要求idle UI→recentMutationEntries→有界恢复→collectStructuredMutationReceipts/uniqueBatchPreparation/boundBatchIntents→现有hash关联→记录→用户另选View/Verify/Draft；它不在provider进度、渲染或Evidence Ledger lookup循环中。新字段常量仅模块初始化，校验沿用已有局部预算，无新增per-entry数组/closure/pool，不作性能改进声明。

原新test中增加11次纯内存恢复模型，每次4条历史（总44），每分支JSON最多4096UTF8B/总45056B；单项及batch各验证：合法同snapshot关联、改snapshot拒绝、移除拒绝、旧缺省仍关联、非法latest即使hash一致也拒绝；另一次batch create+snapshot即使hash一致仍拒绝。预期4次关联/7次拒绝，关联核对requestEntryId、原input同一对象、postimage，无关联时三者均undefined且明确unavailable。模型只传入虚构历史，不签发真实变更回执/授权、不触发磁盘观察或应用。原两节点/9B fixture、prepare/receipt/worker预算均不变；仍只首次唯一执行这个新test文件，不重跑任何旧矩阵。

当前12scope尚未import/编译/运行/暂存；需修正源码及冻结摘要复审后才运行。此修正不改写§58或§55失败事实，也不代表宿主实际写回已完成。

### §59 首次唯一验证结果（预检及恢复，不是宿主应用）

源码获审cursor106/独立chunk1a7b8e exit0后，紧邻preflight chunk68a620 exit0核对冻结12scope、10既有依赖、固定Node/PS7/Koffi三二进制及原index2022/outside2011。唯一执行Node26.13.0 --test --test-concurrency=1 tests/windows-sandbox-explicit-write-snapshot.test.mjs，原commandExecution exec-dec89e11-b2e8-4e0b-943e-eafa64b141f5/chunk1c5381：actualexit0/completed379ms、工具wall0.3798943s、框架308.7745ms；1pass/0fail，无cancel/skip/todo/工具session。test冻结SHA A98372F9004603176FD77548B2EB002E33E555EF59762172DAFD3827BEC952D0/blobbf7e306e3b5a2cfe56d50639bbd5855d040e90c1保持。原完整输出1588UTF8B，4JSON含LF1381B；stderr无独立字节计量，时间不作性能证据。

纯内存历史恢复实际11调用44条/15619B，4绑定7拒绝，filesystemOperations0；这不是11次实际宿主写入。真实fixture唯一root C:/Users/Administrator/AppData/Local/Temp/sp-explicit-snapshot-BJ7B8Q及其source.txt，dev均3637606815、原ino分别5348024558118302和1688849860880060；显式open/closeAttempt/closed各2，fixture初写/外部变化模拟总9B；两节点按原身份/类型/父链/canonical逐个清理后Node ENOENT，retainedFixtureHandle false，safe/succeededtrue，errors[]。两份原read receipt合计9B、direct prepare实测7，batch内部另2次prepare由冻结源码调用链确认（非额外实测计数）、latest恰1、成功direct plan3均释放、service.dispose后revisions0。原source最终beta、missing.txt未创建；批量准备中后项旧snapshot拒绝并释放前项，executionMethodsRequested0、finalTargetsVerifiedtrue。worker启动/调用差值及pending均0。

证据覆盖新旧schema隔离、原snapshot绑定及缺省兼容、create/缺失目标拒绝、单项/批量历史恢复和未执行预检释放；不替代installed permission消费、真实write commit、新增文件或Sandbox运行。模型回执不当作真实变更事实；未计量Node隐式OS I/O/临时buffer全量，也不声称全局V8零残留。不重跑、不改写§55或§56–58旧结果。

审核cursor112独立复核原日志/原工具输出一致，并以chunk4f1ff5 exit0确认两登记路径均PS7 PathNotFound/ObjectNotFound、12冻结文件/11原index不变；chunk6a7619确认10既有依赖/3二进制摘要保持。无本项实际遗留，原九删除/patch保持。

本项12scope待精确stage及暂存后独立复核，预计index2023、范围外2011及SHA256 BF5638A36FE505671A76F724FC5AF4496B41FD5511222FB36C9BC163F2F98BF4保持。仅新test增加一索引条目，原九删除/patch不动；不commit/push/PR，不按阶段开新对话。后续继续严格UTF8候选请求、同原会话/权限实际写回、真实隔离输入与工具执行、P0和最终切换，生产/default/旧权限退役仍不宣称完成。

## §60 候选字节到原生写入请求（源码预审，尚未运行）

§59已完成首次唯一1/0及独立复核：精确12scope stage exec-0b46cfa2-9870-45d0-a9b2-6701c136361a/chunk229ad1 exit0；审核cursor116/独立chunk8970d8 exit0核对12SHA/blob、11旧→新、新test cached及工作/index一致。index2023/outside2011原摘要保持，原9D+patch不动，无重跑/commit/push/PR/新窗口。

按cursor114/116认可的6scope：新scripts/acceptance/windows-sandbox-candidate-write-batch.mjs、新tests/windows-sandbox-candidate-write-batch.test.mjs及本四记录。落盘前chunk9b671c exit0确认两新路径不存在，四doc仍为§59最终index；index2023、本scope外2019条目SHA256 9AA37CD1FCD7136714CD677D295D639A9A8E5886C360D14BE31ACDBD888CC1A2。依赖原CapturedCandidateOwner SHA7DF38019A8E4885264EB27FAFBBD18D468C8D6F691993393A9FBFADEE488CCA4、candidates.mjs SHA7025A6B392C34549910B4BB15D2026A11DB02D9FF025DE0DB97B739327AB57CE、regex.ts SHA709E48987D8CA1B7E5F5846B6EAAC8BDCB21240DE4E513AFF9C7B63B4206B722，不修改§59及更早源码/test。

CapturedWriteBatch.prepare只接受固定CapturedCandidateOwner原型getter/copyBytes可以访问私有brand的实例；这只是数据来源类型及存活校验，不是授权或真实guest来源证明。模块WeakSet记录每个原owner一次转换attempt，不强保留key；同转换器一次prepare。先检查全部记录与预算：1–16项、每项≤4096B、总≤16384B，add原revision须null，modify须精确27字符且原SNAPSHOT_ID_REGEX通过。之后逐项恰一次原copyBytes，核对长度与SHA；fatal UTF8/ignoreBOM true解码并用独立Buffer精确往返比较，保留BOM/CRLF/NUL/Unicode。任何失败拒绝整批、释放已转换字符串引用；每项copy/roundtrip自有buffer在finally清零，计数区分两种分配。

生成operation=write，add为mode=create且不含snapshot，modify为mode=overwrite且保留原snapshot。operations和每item冻结；顶层operations公开字段不可写/不可配置，顶层对象仍可扩展以附加PREPARATION/权限符号，也可能附加其他属性（不声称只允许某个符号）。take前用固定原getter再验原owner存活，take成功或失败均释放转换器保留的owner/binding/input等；dispose同样释放。成功移交的数据由调用方持有，之后原owner撤销不偷偷擦除已交付字符串。字符串无法原地清零，仅释放本层引用。空候选不给出可执行空batch。无磁盘I/O、权限授予、native invocation、WSB/VM或提交入口。

完整调用链只读检查：原捕获owner acceptManifest/acceptBatch有限校验→固定getter/once copy→本同步转换器UTF8/hash/once take→未来宿主私有组合继续原SessionFiles prepareInvocation→实际installed Controller.authorizeToolCall→原invocation.consume→原installed file_batch.execute。当前未接入后四段，不以模型回执冒充实际写回；原CapturedCandidateOwner仍只负责捕获数据契约。新增代码限显式一次候选消费，未接入provider/message_update、工具进度、事件分发、render/layout、terminal或Evidence Ledger lookup；无pool/性能优化声明。

拟唯一新test六组：精确保留空文本/BOM/中文/CRLF/NUL/emoji和modify原snapshot，冻结公开字段/允许运行时symbol；四种非法UTF8（非法首字节、截断、多余编码、代理项）置第二项，验证首项已转但整批不可取并清理；两种非法原snapshot及空候选在复制前拒绝；伪实例/原型伪造/Proxy拒绝，替换公开getter/copy不劫持原方法；prepare前/后撤销均拒绝take并释放；保持转换器活着，对原capture做四轮GC确认WeakSet不强保留。合法及失败原owner都拒绝再次转换。

预算一次固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-candidate-write-batch.test.mjs。纯模型owner12（守卫≤16）、converter20（≤24）、prepare尝试25（≤32）、candidate payload合计75B（≤512）；模型fixture自有buffer总分配守卫65536B、全部finally清零，最多一个fixture存活。预期converter原copy14次/66B、roundtrip58B、合计清124B/retainedBytes0；20个终态diagnostics均无candidate/input/binding引用。四轮GC一个原capture目标，converter仍存活，预期live0。原capture内部manifest/request/payload有各自清理，不将其与本层重叠计数混作全局内存；全部V8字符串/OS句柄不声称完整计量。报告只计数和状态，预期≤8KiB，不输出候选正文。无filesystem/guest/nativeFile execution、无实际临时文件或进程，无旧额度/故障矩阵重跑。

当前仅6scope源码/test/文档草稿，尚未import/编译/运行/暂存；完整源码与冻结摘要独立审核后才唯一验证。随后继续实际同会话宿主写回、隔离输入/cwd/工具与guest执行、P0实机和最终切换；本转换数据不替代原授权/原snapshot/全批预检/逐项commit事实，生产/default/旧权限退役仍未完成。

### §60 首次唯一模型验证结果

源码获审cursor119/独立chunk9acb5d exit0后，紧邻preflight chunk68245d exit0核对6冻结scope、21既有依赖（含本项3个直接依赖）、固定Node/PS7/Koffi三二进制及index2023/outside2019原摘要。唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-candidate-write-batch.test.mjs，原commandExecution exec-94f654a7-3c25-4edf-a631-fa7a9cc13a5d/chunk1805d3：actualexit0/completed189ms、工具wall0.1900271s、框架97.1786ms；6pass/0fail，无cancel/skip/todo/工具session。原输出1032UTF8B、两JSON含LF367B，stderr无独立字节计量；耗时不作性能结论。源码SHA2F419AC72E38D5F55833871687261508C8ADBEAF99775A53C2D8FD0E7FEFE421、test SHA CD6670F3B5F127C1362AAA6B4AF83D19D1F4CEC945832714077E3A2425619D47保持，不重跑。

实际owner12/converter20/prepare尝试25、payload75B；converter复制14次/66B，roundtrip58B，清零合计124B且retainedBytes0。fixture自有buffer分配19004B/清零19004B、activeFixtures0；20终态diagnostics的candidate/input/binding引用释放断言通过。converter保持存活，四轮GC/一个原capture目标liveTargets0。无filesystem/guest/nativeFile执行；没有实际临时文件/VM/helper需要查删。不同层计数不合并成全局内存，字符串仅释放本层引用，不声称其已清零或全部V8内存归零。

审核cursor122独立确认原command记录与原工具输出完全一致、字节计数一致；chunk6ecde3 exit0核对6冻结文件/4原index、两新文件未暂存，index2023/outside2019原SHA保持；chunk561778确认21依赖/3binary未变，原9D+patch保持。该证据仅模型数据转换/生命周期，不证明真实guest来源、宿主权限消费或实际write提交；§55及后续旧结果不改写。

本6scope待精确暂存及暂存后独立复核；预期index2025（仅两新文件新增）、范围外2019及SHA256 9AA37CD1FCD7136714CD677D295D639A9A8E5886C360D14BE31ACDBD888CC1A2不变。四旧→新blob和两新完整cached差异均需检查，原9D/patch不动，不commit/push/PR/新建窗口。下一步实际写回需记录原创建/提交对象身份，以便按原身份收尾；拟优先复用现有NestedToolDispatch到原installed file_batch的真实权限/调用链，不为新功能旁路授权。完整隔离输入/guest运行/P0/最终切换仍继续，生产/default/旧权限退役不提前宣称完成。

## §61 原回执身份事实与真实宿主写回接线（源码预审，尚未运行）

§60已最终闭合：精确6scope stage exec-2441f8cc-17b9-4f55-ba66-7dd912de8d2d/chunk432cae exit0，审核cursor126/独立chunk45ea66 exit0核对6SHA/blob、四旧→新/两新cached及工作/index一致。index2025/outside2019原§60摘要保持，仅原9D+patch；6/0旧结果不重跑，不commit/push/PR/新开窗口。

按cursor126认可的8scope草稿范围：core/files/file-commit.ts、file-creation.ts；新scripts/acceptance/windows-sandbox-apply-captured-writes.mjs、新tests/windows-sandbox-captured-host-write.test.mjs及本四记录。落盘前chunkdc5ed7 exit0确认六现有路径等于index、两新路径不存在。index2025、本scope外2019条目SHA256 2EC41744482EB1633E70156201A3D612FA7D16F028BEF37EA0370405EC61F18F。commit旧16800B/SHA C43D4FEF4E38D92DC8A166A9AE5762F169B8B1B7A47D7010872143CBEFDD60C1/blob39908176f82c0d703765fa9b938914adbf5af9be；creation旧8398B/SHA261F87262C6C1F4AA0399AB880F5C685B83463C29A7755607A0E163C5B3D9E94/blobae39da57cf313e51999576ee438635fa0620ff81。四doc以§60最终index为基线，§59–60等其他源/test不改。

两个生产模块各加一个私有WeakMap和只读查询，无外部setter、无新序列化回执字段。commit的值仅从原temporary/publishedObject生成冻结{最终target path,device,inode}，记录点在原cleanup之后、原return/原FileCommitError之前；仅publishedObject已由原流程确认时关联。staged_replace身份来自原创建handle，protected_in_place来自原已固定target。已确认committed但postcheck/close失败的原FileCommitError.receipt可保留该历史关联；unknown/not_committed不凭后看路径生成已发布证明。该事实不保证当前路径仍相同，也不是权限或清理许可。

creation只在原exclusive open的handle.stat取得device/inode，成功完成原close后与原CreationResult关联；不以之后的lstat补成创建归属。原失败仍序列化Error.message再由FileService解析，没有原CreationResult，因此本稿不声称失败创建身份可以经旁表到达最终结果。实际验证若发生该失败，必须保留计划路径/原错误/未证明身份和收尾责任，不能猜删或靠新stat填补。旁表值没有handle/owner/授权对象引用；copy/JSON导入/原型派生/Proxy不是原key，不能取得关联。

完整结果链已读：原commit/creation→FileService.receipt保留commit或creation对象→BatchExecution.items.receipt→formatBatchResult.details.items→Agent createToolResultMessage.details原引用。新增身份关联仅在有限文件提交完成边界；未改progress/event delivery、provider delta、render/layout、terminal、large output、Evidence Ledger lookup或Agent热路径，不引入pool或性能改善声明。新增桥接只做一次§60转换、核对host给出的五个task binding字段、一次原executionContext.callTool(file_batch)，无直接文件I/O/自动retry/fallback。executionContext由可信宿主提供，桥接自身不证明调用方权限；不接受伪造callback回执作为真实链证据。失败原child仍标记parent失败，未用allowFailure压掉失败。

拟新test一个真实宿主集成：真实Agent生成两个独立接受性parent invocation，每个调用read及file_batch，共4个nested call。仅该新fixture parent声明orchestration，既有powershell/工具标记和Agent代码保持。真实createExtensionRuntime/SessionFiles先建立，再加载原resource-lifecycle-guard，其原getSessionFiles发现owner并安装实际SessionPermissionController；使用SessionManager.inMemory，原read definition、SessionFiles.install、原wrapToolDefinition、原ExtensionRunner.emitToolCall及finalAuthorization消费。before hook核对被选wrapper与原definition，观察原审批对象/hash和原pending invocation；after hook仅读取实际返回原receipt，不伪造审批或提交。

源码别名明确映射file-invocation/file-host/file-batch-protocol/file-commit/file-creation/input-workspace-grant-lease/session-input-read-permission到相同原src URL，并断言permission-contract.mutationRequestHash及两个旁表查询函数与直接source import为同一函数。原permission扩展index含TS参数属性；固定Node --help只读检查chunk845a2a exit0未列transform-types选项，未因此试跑目标。新test注册load hook仅对该唯一原index URL用既有TypeScript5.9.3转ES2022/ESNext，保留URL和模块实例；source≤128KiB、输出≤256KiB、恰1次，hook在import后解除，无编译落盘。其他目标模块普通导入，没有Jiti另起模块缓存。该编译只在获审唯一test启动时执行。

真实fixture一个sp-captured-host-* root、source.txt及计划new.txt三最终路径。先原exclusive handle写alpha5B，第一parent真实read得到原snapshot后用同原identity的r+写beta4B（fixture共9B/2open/2closeAttempt/2close）；第一份纯模型capture含add new.txt和modify oldsnapshot，经真实调用链整批准备拒绝，parent isError、没有实际receipt/审批、new仍ENOENT/source仍beta。第二parent是独立新请求，真实重新read取得新snapshot、另一个模型capture和新task/snapshot ID，再通过真实原权限和文件工具完成add new.txt=5B、modify source.txt=6B。只在此新请求使用新snapshot，不替换第一请求原基线或自动重放。

两份capture各11B候选，模型wrapper buffer累计守卫16384B、finally清零并释放capture；它们不是guest来源证据。预期2原生成功receipt/1原审批、六条原file-mutation-progress-v2均绑定成功batch hash，pending/inFlight/revisions归零。实际commit可能按原能力选择staged_replace或protected_in_place，测试不强迫策略；替换会产生原core负责的私有临时对象及发布身份，三最终路径数不冒充全部OS创建对象数。通过原返回对象旁表保存两个最终对象的原身份，与initial source身份分别记录；复制/JSON/派生/Proxy查询均应undefined。外层四轮GC检查两个原receipt key释放，旁表metadata可继续作为普通历史数据而不保留key。

原native worker本项最多启动1次，calls≤128、publicationAttempts≤1；记录原stats activeHandles/activeDescriptors和pending，必须为0才按原Worker owner释放。正常stats只一次；若在此前失败，仅在尚未尝试stats、pending0且worker未failed时允许一次诊断stats，不重试已失败stats或写入。stats未知/句柄未闭/pending不为0时保留worker责任，不通过terminate掩盖unknown。runtime依次等待Agent idle、原session_shutdown、原boundary/provider owners释放，再invalidate并释放内存session/Agent引用；未使用Chrome或截图，其原cleanup集合为空，不广扫/猜杀资源。

只有所有实际操作和关闭证据完整时才按登记root/最终原对象identity、父路径/canonical/type逆序unlink两file和非递归rmdir root，各自确认ENOENT。任何意外错误/partial/unknown/关闭未决均safe=false，先报告原错误、计划/已发身份及资源状态，不执行猜测清理。fixture统计不包含Node隐式全部OS I/O；native stats也不等于全部Node句柄/分配，字符串与V8堆不声称全量清零。

拟唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-host-write.test.mjs；预期一个组合测试，无live provider、guest/WSB/VHD/helper、额度/旧矩阵重跑，输出上限16KiB。当前8scope仅草稿，尚未import/编译/运行/暂存；完整源码/预算独立审核后才允许首次真实写入。后续仍继续真实隔离输入/cwd/工具执行与实际candidate来源、P0实机及最终切换，本项不提前宣称整体验收或默认启用完成。

§61首次运行前审核修正：cursor130确认仅有两项证据阻断，未发现其他阻断项，尚未运行。新test在原before hook捕获file_batch原prepare异常，复制有限值后原样throw；第一parent结束后断言恰一个异常、parentToolCallId=captured-stale、target=source.txt、snapshot等于该parent刚取得的原read snapshot，并精确核对原子调用ID:1及[SNAPSHOT_EDIT_STALE] Source changed or is unavailable. No change.与Preflight failed; no batch item executed.，排除任意schema/导入/权限错误冒充旧快照拒绝。第二parent另获不同snapshot且不增加该准备异常。原after hook在任何session清理前独立JSON复制每item的reason/stateChanged/requiresVerification，以及receipt.status/category/cause/stateChanged/requiresVerification/fileCreated/retryable/createdDirectories/creation/commit全部原历史字段（含retainedTemporary、cleanupReason），没有receipt也保存item事实。该有限值记录累计UTF8≤8192B，不保留原receipt key、authority、handle或callback；未知/失败仍禁止清理，原两个成功key的4轮GC要求不变。8scope与一次真实运行预算不扩展，需修正后源码/预算重新审核。

§61首次唯一运行结果：失败，尚未取得真实宿主写回通过证据。修正源码获cursor136首次单次放行后，紧邻预检chunkb4008a exit0核对8scope、25依赖、Node/PS7/Koffi三个二进制、6原index blob及index2025/outside2019 SHA256 2EC41744482EB1633E70156201A3D612FA7D16F028BEF37EA0370405EC61F18F。实际仅执行固定Node --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-host-write.test.mjs一次，未重跑。

原commandExecution exec-d75a6be1-17df-483c-8ee9-9504b77ca839（工作turn01a19b54-2ed5-7c11-af84-8d6790dfac01）/chunkb90adb，status=failed、exit1、命令duration1238ms、工具wall1.2391611s；审核原执行记录1.2389681s与工具舍入层次分列。0pass/1fail，cancelled/skipped/todo均0，framework1158.5334ms。原完整输出1490UTF8B，无JSON计数回执。原ERR_MODULE_NOT_FOUND指出packages/chrome-devtools/src/browser-manager.ts导入不存在的runtime.js。

原resource-lifecycle-guard/index.ts导入@super-pi/chrome-devtools/browser-manager；其package exports直接指向src/browser-manager.ts，该源第18行写./runtime.js，实际源为runtime.ts，当前精确alias hook未覆盖此依赖。已进入顶层动态模块加载，并允许过唯一index转译hook；不得记为未import/编译。失败早于test注册及exercise()，因此按源可达性，本测试未创建fixture root/source/new、Agent/SessionFiles/capture，未启动native worker/VM/helper；没有本测试登记资源需清理。写回、stats、清理和GC均未执行，这些不是运行计数为0或清理通过回执。

审核cursor142独立确认原命令与工具输出一致：chunk75641a exit0核对固定目标只执行1次，chunk1e3ad7 exit0核对8scope和索引边界，chunkf7a688 exit0核对8+25+3冻结哈希，原9D与patch保持；chunkf783c9 exit0确认新增加载依赖三hash。browser-manager.ts SHA42F97138AD9F5ED92F98FFD812CCDB53B850BFA0FAA75EA26CCE3094B48686BE；runtime.ts SHA939218E9728550659529B572A6275ED3BB1E3B4B5284023A7B34D65202D56038；其package.json SHA561A3851FE08329EC35D6E90BD1C5882B1B6BA756A7D52F81961E8BE950A6881。

本项保留生产源码/桥接/原test冻结值，仅四doc追加失败事实；精确暂存仍须记录复核，保存本项变更与失败证据不将失败改为通过。下一范围获准草稿为独立新test加四doc，限定原browser-manager parentURL与./runtime.js映射到原runtime.ts URL，核原state/解析次数，提交完整导入关系、三新增依赖和新唯一预算后再审；当前不放行新运行。真实隔离输入与执行、候选实际来源/写回、P0桌面及最终切换继续待完成。

## §62 原源码依赖精确解析后的真实宿主写回验证（草稿，尚未运行）

§61按原失败保存：唯一exec-d75a6be1-17df-483c-8ee9-9504b77ca839/chunkb90adb exit1，0pass/1fail，1490UTF8B；原test与生产/桥接源码不改、不重跑、不回填通过。8scope精确stage exec-5c1116cd-37cb-4e0d-8edb-e3af30f4bf80/chunk1236b4 exit0，index2027/outside2019仍§61原摘要；cursor147/独立chunkdffc79 exit0确认8SHA/blob/worktree=index、6旧→新增量/两新cached checks与原9D+patch保持。加载失败发生在动态模块图，测试主体未注册；无业务写回/资源清理/GC计数，不说加载未发生。

本项仅新增tests/windows-sandbox-captured-host-source-resolution.test.mjs及四doc追加。落盘前chunk931468 exit0：四旧doc与index一致、新目标不存在，index2027/本scope外2023 SHA256 0501219B1AB5110D6C7905022D5753396DBCA010FA0B3B275837D2DA49F7C844。新test保留§61同一有限业务用例与全部清理/失败记录/GC断言，独立文件入口仅增加已确诊依赖解析与无Chrome启动断言，不改生产路径、不新增行为替代实现。

实际加载关系：测试静态导入原src Agent、SessionFiles、SessionManager、EventBus、ExtensionRuntime/loader、ExtensionRunner、wrapToolDefinition、read definition、file-invocation、file-commit、file-creation、native-file-client及原候选转换/桥接；注册同一精确hook后动态导入原resource-lifecycle-guard/index.ts。该原index加载原Controller、core/shell分析、powershell生命周期、changes、background-shell及包出口browser-manager。Controller的原权限/状态、mutation兼容模块依赖保持原路径；file-invocation/file-host/file-batch-protocol/file-commit/file-creation/input-workspace-grant-lease/session-input-read-permission七个internal导出仍指向与静态import相同src URL，原hash与两个旁表函数同一对象断言不变。其他既有包出口沿当前环境，包括coding-agent公开shell接口和background tasks的dist，不声称全部dist重建或全源码加载。

确诊缺口只在browser-manager原URL的./runtime.js：新resolve分支必须同时匹配context.parentURL与specifier，返回原runtime.ts URL，并断言命中恰1次。原runtime仅有builtin ChildProcess type import，运行时为常量/env派生/AbortController，无导入时文件/进程I/O；原browser-manager其余运行时依赖均builtin。原browser-manager普通constructor可直接去TS类型；原index的TS参数属性仍唯一经既有TypeScript转ES2022/ESNext，同原URL、最多1次/128KiB源/256KiB输出、无编译落盘，hook finally解除。不广泛猜测.js→.ts、不模拟shutdown、不改包出口或Chrome状态。原runtime.state在加载后及业务结束都断言managedBrowser与launchPromise为undefined。

新增冻结依赖：browser-manager.ts SHA42F97138AD9F5ED92F98FFD812CCDB53B850BFA0FAA75EA26CCE3094B48686BE；runtime.ts SHA939218E9728550659529B572A6275ED3BB1E3B4B5284023A7B34D65202D56038；chrome-devtools/package.json SHA561A3851FE08329EC35D6E90BD1C5882B1B6BA756A7D52F81961E8BE950A6881。原§61四代码/test及25依赖保持；Node/PS7/Koffi仍固定。未修改生产热路径，无pool或性能改善声明。

拟唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-host-source-resolution.test.mjs，仅1组合。业务仍2独立parent/4nested/2模型capture各11B；原read snapshot→同identity fixture修改→精确旧snapshot整批准备拒绝，再独立新read/新snapshot经真实权限完成2项。fixture最多3最终路径、2open/2close、9B初始/外部修改；模型buffers≤16384B且finally清零；独立历史事实JSON累计≤8192B，原commit/creation两个WeakRef四GC应释放。原worker最多1启动、≤128calls、≤1stats、≤1publicationAttempt，只有确认原句柄/descriptor/pending归零才释放worker；未知仍保留责任，所有文件只按原创建/发布identity与父路径确认后精确逆序清理。完整输出≤16KiB，无guest/VM/VHD/helper/live provider、旧矩阵、依赖安装或工程执行。首次运行须完整源码/预算独立放行，当前仅草稿。

§62首次唯一结果仍为失败。cursor152放行后，紧邻预检chunk6e66dd exit0核对5scope、32依赖、3固定二进制、4旧index及index2027/outside2023 SHA256 0501219B1AB5110D6C7905022D5753396DBCA010FA0B3B275837D2DA49F7C844。唯一exec-20a778f0-9efc-49a8-82bd-71f8db161a2a/chunk49de74 statusfailed/exit1、duration1026ms、工具wall1.0269577s、审核原记录1.0265788s，framework929.4988ms；0pass/1fail，cancelled/skipped/todo0。完整原输出4088UTF8B，两JSON含LF2580B。原test不编辑、不重跑。

本次原模块精确解析1次、index转译1次，源14948B/输出16137B，七源码alias实际被使用；Chrome原state无managedBrowser/launchPromise。实际创建root C:/Users/Administrator/AppData/Local/Temp/sp-captured-host-EDhfNe（dev3637606815/ino20829148277204705）及source.txt（同dev/ino7036874418382861），独占fixture handle打开/关闭尝试/关闭成功各1，写alpha5B，无保留handle。new.txt仅计划路径、无已发identity。parentCalls1、nested before-hook计数0、batch/approval/receipt/capture/readSnapshots均0，模型分配/清零0。原owner/boundary/provider owners报告已关闭；worker启动/调用差值0、loadedfalse/pending0，stats未尝试、无worker保留。原测试safe=false/succeeded=false、两实际对象未清，失败断言为准备异常条数0!==1；没有执行外层GC。

nested before-hook为0不等于callTool未被调用。原child/parent错误正文没有保存，不能将其回填为已观测的“read not found”。只读源码机制：runHostToolDispatch在agent-loop.ts构造selectedContext时将tools缩为唯一parent；createNestedToolDispatch沿用该turn表，原read查找因此在before hook前拒绝。这解释当前计数，是源码推断而非遗失的原错误文本。采用complex-debugging-protocol建立两次失败/正负对照：§61加载缺口已由本次计数证实修正；§62入口选择假设被原host-only边界推翻。生产单次host隔离语义不应为测试扩大，后续改用原agent.prompt与固定无网络FixtureStream保留正常工具表，并先保存child/parent有界原始结果。

审核cursor156确认唯一原命令/输出一致及字节计数；chunk6979e2 exit0核5+32+3冻结值/index，原9D+patch保持。其后单独放行原登记对象精确清理脚本，不是测试重跑。固定Node哈希预核后，清理exec-23308225-9537-4779-9bc5-add989f4f7c5/chunkc2552c exit0，工具wall0.2553412s、审核原执行0.2552991s，原输出821UTF8B。逐一核原root/source bigint identity、普通类型/规范父路径/source单链接与5B大小，计划new为ENOENT；用1个原身份read handle验证精确alpha5B，1open/1closeAttempt/1close成功，5B buffer清零。重新核原identity后仅unlink source和非递归rmdir root，各自ENOENT；errors=[]/retainedReadHandle=false。该清理的1读/5B与原测试1创建写/5B分列，不改写原测试未清理事实。

审核cursor159确认清理原命令及输出、821B和原脚本一致；独立chunk828abf exit0分别检查原root/source/new三个登记路径得到PathNotFound/ItemNotFoundException，当前均不存在。本项登记fixture收尾已完成，但原业务验证依旧0/1。只有四doc追加本结果，原test、生产/桥接和§61失败保持；5scope暂存仍待记录复核。最终还需精确处理手动验收入口被scripts/test.mjs普通*.test.mjs递归发现的问题，保留源码hash与失败历史，不隐藏回归或重跑旧矩阵；本范围不改测试发现规则。真实宿主写回、隔离输入/执行/候选、P0与最终切换仍未通过。

## §63 使用原Agent正常编排入口验证真实宿主写回（草稿，尚未运行）

§62原唯一0pass/1fail不改写，原test不改不重跑；登记root/source已通过独立单次身份清理及cursor159三路径不存在复核。本阶段不再检查旧已清路径。§62精确5scope stage exec-fde24e8e-1004-4cad-bbea-1d25da1afb5c/chunkb0db31 exit0，index2028/outside2023保持原0501219B1AB5110D6C7905022D5753396DBCA010FA0B3B275837D2DA49F7C844；cursor163/独立chunk4912f0 exit0确认五工作SHA/blob及index一致、4旧→新/1新cached空白、原9D+patch保持。

本范围仅新增tests/windows-sandbox-captured-agent-orchestration.test.mjs及四doc。落盘前chunk662a17 exit0确认四doc等于index、新目标不存在；index2028/本scope外2024 SHA256 F5327BA7D149830DADAC0ADC5ADCE5BAD3CD602DB406D7EA9413951215B3FD69。§61–62原code/test和全部生产文件保持；普通suite发现手动验收的路由问题继续单独待处理，不通过本项省略它。

根因对照来自原tests/nested-tool-dispatch.test.ts和tests/operation-host-dispatch.test.ts的静态源码，不执行这些旧测试。前者使用agent.prompt+FixtureStream进入完整正常Agent编排，后者验证单次host dispatch隔离。新test据此只替换接受性入口：保留原Agent、SessionFiles、原安装read/mutation定义、wrapper、Runner、原权限扩展与最终authorization；由固定本地FixtureStream提供一次parent toolUse和一次stop，每个phase调用一次agent.prompt，总2prompt/4响应。fixture model/provider为明确本地测试标识，streamFn不调用任何网络/provider API、认证回调、额度/重置；这只是模型意图的确定性输入，不是假原生权限/文件回执。原生产host-only集合不扩大，原正常编排热路径不改。

完整调用关系为原Agent.prompt→runPromptMessages/createContextSnapshot→runAgentLoop→streamAssistantResponse（固定fixture stream）→executeToolCalls/prepareToolCall/原before hook→原parent execute→原createNestedToolDispatch使用完整turn tools→read/file_batch实时查找、schema验证、原Runner准备/权限及最终消费→原installed execute与真实FileService。保留§62原精确Chrome源解析和唯一index转译，同一hash/旁表函数身份检查不变；其余既有包出口保持原环境，未全dist重建。

每个child的callTool返回后先保存有界toolCallId/toolName/isError/executionStatus/content/observationFailure独立值，再断言或继续，包含read及file_batch各两次。每个prompt完成后，从Agent原history选择该唯一parent toolResult，连同phase、实际stream响应数和errorMessage先保存独立值再断言结果数1及响应数2；没有parent也先记录空结果和原errorMessage。原准备异常与item/commit/creation历史事实保存不变，整个valueCopy计费累计仍≤8192UTF8B，parent嵌套复制也计费，不声称全堆精确分配。这样失败不会再仅留下外层0!==1而丢掉已返回的原拒绝正文；异常尚未产生结果时保留外层原Error。

其他业务/资源预算沿用有限组合：2独立parent/4nested、两次真实read、第一原snapshot随同identity外部修改后明确旧快照整批准备拒绝，第二原read/new snapshot经实际权限提交2项；两份纯模型capture各11B，不当guest来源。3最终fixture路径，初始/外部修改9B，2open/2close；模型buffers≤16384B清零；native worker最多1启动/≤128calls/≤1stats/≤1publicationAttempt，未知不terminate掩盖。原successful creation/commit key两个WeakRef四轮GC，原owner/runtime收尾、原身份逆序清理与failure retention保持。输出≤16KiB，四个child与两个parent的原结果摘要也在此预算内，无VM/VHD/helper/guest、旧矩阵或真实工程执行。

依赖冻结补入原Agent/agent-loop/nested-tool-dispatch、tool-definition-wrapper、ExtensionRunner、read及两个只读控制测试，共8路径；加原§62test及32依赖共41，Node/PS7/Koffi仍固定。拟唯一固定Node26.13.0 --expose-gc --test --test-concurrency=1 tests/windows-sandbox-captured-agent-orchestration.test.mjs，1组合。当前仅草稿，完整源码/依赖/预算独立放行后才首次运行；不提前宣称真实写回通过、默认切换或权限退役完成。

§63首次唯一运行及资源收尾通过，1pass/0fail。cursor168放行后，紧邻预检chunk79bef4 exit0核5scope、41依赖、3固定二进制、4旧index，index2028/outside2024 SHA256 F5327BA7D149830DADAC0ADC5ADCE5BAD3CD602DB406D7EA9413951215B3FD69保持。唯一exec-74f37f88-491b-4dc4-be41-a7519e9aacce/chunke06ad0 completed/exit0、duration1053ms、工具wall1.0537343s、审核原记录1.0536155s；组合123.6662ms、framework975.3174ms。cancelled/skipped/todo0，完整原输出7293UTF8B、三JSON含LF7047B，独立值事实计费4021B，均在预算内。未重跑§61/62或旧矩阵。

实际2prompt/4本地固定响应、2parent/4nested、2批准备、1实际原批准和2实际原receipt。第一原read取得snap_Ia8IOkpwMxGMwwr1FEc5Jg后，同identity fixture从alpha5B改beta4B；原captured-stale:nested:2第二项精确[SNAPSHOT_EDIT_STALE]拒绝整批，child executionStatus=not_executed，parent失败，无该批实际receipt，目标new仍ENOENT。第二独立原read为snap_zlTd43PxwP-sV6SuRfjEoA，新请求成功新增new.txt=5B与修改source.txt=6B，最终精确内容及原六条file-mutation-progress-v2关联断言通过。实际原权限对象/hash、原pending及最终native消费经过原链；不是模拟回执或放宽host-only入口。

实际root C:/Users/Administrator/AppData/Local/Temp/sp-captured-host-A5DlSt，dev3637606815、inode14636698789571532；source初末inode13229323906018267、新建new原inode3096224744434693。修改实际选择protected_in_place，原兼容原因是unprotected Windows DACL下替换可能改变继承语义；原source identity保持、commit=committed/fileSynced=true/directorySynced=false，publicationAttempts0。本次不覆盖staged_replace或目录持久性，不为新建receipt添加不存在的sync承诺。原sidecar从两个实际原receipt取冻结身份，copy/JSON/派生/Proxy无关联；两个原key四轮GC后liveTargets0。

fixture打开/closeAttempt/关闭各2，初始与外部修改写入共9B，无保留fixture handle。两份候选各11B仍是纯模型CapturedCandidateOwner，不是guest输出；模型承载buffer累计3360B分配=清零、capturesLive0。原native worker启动1次、调用7次；唯一stats给activeHandles0/activeDescriptors0/publicationAttempts0/fileBytesRead4/metadataBytesRead0/hashBytes744/hashUpdates36，平台win32/x64。该计数不包含Node隐式全部OS I/O或全堆分配。原owner释放后workerLoadedfalse/pending0/workerRetainedfalse，native owner/boundary/provider owners均关闭。Chrome精确解析1、转译1（源14948B/输出16137B），无managedBrowser/launchPromise。

三登记节点按各原创建/发布identity、规范父路径/type复核后逆序精确清理，各Node ENOENT，safe=true/succeeded=true/errors=[]。审核cursor172确认原命令与工具输出一致、仅1运行、7293B/7047B/4021B独立重算一致；chunk39726c exit0对原root/source/new逐一获得PathNotFound/ItemNotFoundException，当前不存在。chunk331f21 exit0核5+41+3冻结、原index/outside摘要及9D+patch不变。没有本项资源或恢复责任遗留。

结论仅为正常Agent编排下的真实宿主原权限/文件写回与本次兼容原地策略，以及两原receipt key释放。guestExecutions0、input/candidate尚非实际隔离任务来源；真实输入发布、固定工具/离线依赖、隔离cwd/执行/候选→此宿主链接线、P0桌面、最终切换/权限退役和手动验收路由仍待办。§61/62原失败与独立清理事实保持，不回填。本次仅四doc追加结果；五scope精确暂存须记录复核后执行。

## §64 手动验收与普通测试路由隔离（源码预审，尚未运行）

§63 暂存已独立闭合：原 exec-4065d168-10cd-4dba-9c87-3a21c8b42fa7/fe6330 exit0；cursor175、独立 b35ffd exit0 确认5scope工作区=index、索引2029项、范围外2024项及原F5327BA7D149830DADAC0ADC5ADCE5BAD3CD602DB406D7EA9413951215B3FD69摘要不变。原9D与补丁保持，未新增聊天。

本项仅 scripts/test.mjs、新 tests/windows-sandbox-manual-routing.test.mjs 与四doc，共6scope。修改前8bae49/78cb0d确认5既有文件等于index、新目标不存在；index2029、scope外2024 SHA256 0B0D7DB3A810AD684038ECC1FC15176EF0C6D66C350A0AADC923697BC7D83DCB。原16个单次验收文件全部保持原路径、原内容与失败历史。路由精确列举这16个相对路径为manual；discover仍返回全部，普通all/unit/hot/contract均不执行manual，且不新增批量manual执行开关。未知新Windows Sandbox文件及嵌套同basename不会被宽泛排除。普通候选write-batch离线模型继续自动回归，新增其--expose-gc启动参数；原5个GC入口不变。仅提取原argv构建为testFileArguments，执行/并发/日志/清理链不改。这是测试基础设施冷路径，无生产热路径或对象池改动。

拟唯一验证为固定PS7 -NoProfile环境下固定 D:/Nodes/26.13.0/node.exe --test tests/windows-sandbox-manual-routing.test.mjs，30s界限。新验证只import runner、读取16既有文件各≤65536B累计≤1MiB核原SHA、获取all/unit/hot/contract和直接manual共5份list:true清单、比较全量保留与三常规分类分区、核6个GC argv。无旧test import/执行、无子进程/VM/worker/原生I/O绑定/fixture创建/清理；测试框架自身与目录/文件只读不冒称零OS I/O。输出≤16KiB，JSON摘要≤1024B。不跑原矩阵、旧失败或全npm test。16路径精确集合见runner源码；尚待独立分类/源码/预算复核，不把源码预审写成结果。

真实输入发布/固定离线工具/隔离执行与真实候选接宿主写回、P0桌面及最终生产切换仍需继续完成。

### §64 唯一只读验证结果

分类/源码/预算经cursor182独立放行，独立124b66 exit0确认16个手动入口、原45个普通回归与六文件冻结；16文件合计406700B。执行前317688 exit0核6scope+16保留文件+固定Node/PS7两binary、5旧index blob及范围外摘要。随后唯一原命令 exec-15bbabee-1306-4fbf-b43f-d23a79ec8c4a/chunk6d65b7 完成exit0、duration129ms、工具wall0.1294362s；1pass/0fail，cancelled/skipped/todo0，test13.5319ms、框架58.6498ms，完整输出347UTF8B。

实际只读原文件406700B，5次list:true；发现395个文件，16手动入口内容SHA不变，普通清单379项，其中Sandbox46项（原45加新路由测试），manualSelected0；6个GC argv符合预期。数字379/46是清单数量，不是这些项目已运行或通过。本次只执行新路由测试；没有import或执行旧验收、旧失败或容量/链接矩阵。新测试体没有spawn、fixture创建、VM、受测native worker或清理操作；Node测试框架自身进程、目录扫描和文件读取不纳入“没有业务子进程/原生读取”的陈述，也没有宣称零OS I/O或零分配。保留失败历史并隔离自动重放，同时维持普通回归发现。

审核cursor185确认唯一原命令与完整347B输出一致，独立重算JSON135B/含LF136B；07f222 exit0核运行后六文件冻结、原16文件SHA、index2029/outside2024及0B0D7DB3A810AD684038ECC1FC15176EF0C6D66C350A0AADC923697BC7D83DCB摘要不变，四doc原前缀保持、增量空白通过，原9D与补丁保持。审核确认本项无测试自建资源遗留，允许四doc追加该结果。仅此结果现已追加；源码两文件保持运行冻结版本。下一步按6scope精确暂存复核，随后继续真实输入/固定工具/隔离执行接线。

## §65 原输入 → 固定离线工具 → 实际隔离执行 → 原宿主写回（源码预审，尚未运行）

§64精确暂存已闭合：原exec-01d93681-f9f2-4e33-b957-ff567c669e21/24f8fc exit0，cursor188独立592b1c确认6scope工作区=index，索引2030、范围外2024及0B0D7DB3A810AD684038ECC1FC15176EF0C6D66C350A0AADC923697BC7D83DCB摘要不变。继续在原工作/审核聊天推进，不按阶段新建聊天；此前P0桌面回放仍属用户明确延期事项。

本项14scope：既有windows-sandbox-workspace-input-capture.mjs、windows-sandbox-volume.mjs、windows-sandbox-volume-helper.ps1、windows-sandbox-volume-session.mjs；新增windows-sandbox-input-install.cs、windows-sandbox-offline-worker.cs、windows-sandbox-input-publication.mjs、windows-sandbox-input-execution-session.mjs、windows-sandbox-input-host-fixture.mjs、windows-sandbox-input-execution-acceptance.mjs（均在scripts/acceptance），加本四doc。修改前0ccffb确认8既有文件等于index、6新路径不存在；index2030，scope外2022 SHA256 1DEDB7B070E866051B4E7115578FC3D17D641A0A3C4DFB4A8AC32FD03482D3FD。原9D与super-pi-clipboard-fix.patch保持。旧§55/61/62失败、§56–64入口/结果不改不重放。

唯一新场景由正常Agent的1prompt/2固定本地响应，经原wrapper/ExtensionRunner/resource-lifecycle-guard与SessionFiles：原nested read获得source.txt=alpha的原snapshot；原WindowsWorkspaceInputCapture读取5B并关闭原生句柄，单次发布元数据/复制后保留原授权。CapturedInputPublication在安装、实际映射派发、实际exec三个边界依次续期同一原授权（总renew6），每次实际派发同步复核原对象绑定。元数据/安装receipt只是数据；不接受JSON/布尔替代原权限，不重开源文件刷新baseline。

输入安装走原TaskVolumeOwner/VolumeProtocol/PS7管理器，不旁路原VHD/VM责任。新增NativeDisk partial一次读取宿主私有input-source.bin≤4096B和固定offline-worker.exe≤65536B，核原carrier身份、摘要、原卷/exchange，独占创建workspace/tools与两文件。七原生槽接管valid HANDLE早于inspect，正常opened=closed=7/peak4；close一次、失败单独留原异常/句柄，不重试。两内容buffer分配=清零；托管receipt writer独立责任不混入七原生槽。JS publication自己的carrier写/receipt读共2fd，每次关闭恰一次，复制与receipt缓冲清零。关闭状态不明保留原负责人，阻止后续派发和卷释放。

固定工具只使用系统.NET离线框架，不安装/下载依赖；唯一guest cwd C:/SuperPiVolume/workspace，exe固定tools/offline-worker.exe及两个UUID参数。只读本次alpha输入，产出修改source.txt=alpha-guest CRLF（13B）、新增new.txt=derived:alpha CRLF（15B）和两项guest manifest。原VM先停止并确认CLI/实例消失，再经原candidate owner/channel获取实际候选；guest报告不授权宿主写入。原卷确认释放、source/publication释放后，原applyCapturedWrites将这两个实际候选转换为一次nested file_batch，沿原权限批准/原执行边界写回fixture source/new。原commit/creation receipt sidecar确认目标身份；fixture三登记节点仅按原身份与规范父路径逆序清理，不递归扫描。宿主frame在任何fixture/native创建前由task保留，证据序列化/输出失败仍有原负责人。

预算：固定Node26.13.0/PS7/CSC/WSB CLI/Koffi/TypeScript摘要；源码manifest75项、当前只读计量1285967B、最大83610B，运行每文件≤262144B/累计≤2097152B并在物理派发前核同bundle。一个固定128MiB VHD，一个VM，一次guest exec；3 helper（只读preflight、native DLL编译、离线exe编译），1manager；原lifecycle CLI≤95/全部进程记录≤99/未决≤4，manager协议命令≤16。helper各15s，原VM普通call15s/start120s/exec30s/settle120s/exit30s；未决责任保留，不因外部超时杀猜测进程。native DLL≤131072B；输入5B、实际候选28B，candidate原协议/载体预算沿用。正常私有产物精确11项，journal≤16384B、最终证据≤15360B/footer≤512B、宿主详细证据≤12288B；源码哈希/固定binary哈希属于只读验证I/O，不称零OS I/O。宿主native worker启动1次/调用≤128，唯一stats须activeHandles0/activeDescriptors0，原owner/boundary/provider关闭；源capture/publication/candidate及两原receipt key共5目标，4轮受控GC须live0。

唯一拟执行命令：固定PS7 -NoProfile下 D:/Nodes/26.13.0/node.exe --expose-gc scripts/acceptance/windows-sandbox-input-execution-acceptance.mjs --run-input-once --source-bundle <独立复核后的75项bundle SHA256>。只在独立源码/预算放行后执行一次；失败保留原入口/输出/资源责任，不改后重跑。此入口不在普通tests发现中，不重跑旧矩阵、容量/链接场景或全npm test。本项是显式冷验收，生产Agent事件/渲染/终端/结果热链未改，不引入对象池。即使通过，也仅覆盖上述5B fixture及固定.NET工具；不代表通用离线工具集、正式默认切换或旧权限退役已经完成。

### §65 执行前失败路径修正（仍未运行）

独立预审cursor195指出两项阻断，工作端同时确认capture原错误丢失：CloseInput现将原生close返回false和直接抛异常都永久标记CloseUnknown，保留原异常/原槽且不重试；宿主fixture有任何登记节点尚未确认删除时，保留含原节点/身份及资源的同一responsibility，不能只因进程/句柄已关闭而丢失责任；capture拒绝时重新抛出原错误，释放已知关闭的owner前记录operation/cleanup及下层input/reader独立错误事实（包括undefined/null/0），publication自身operation/close事实分开。正常通过条件另明确原source native scratch分配=释放、retainedScratch0及bindings释放。没有新增失败实测或旧矩阵重跑。

三源码修正后，静态只读c1f8d3确认75项累计1288165B、最大83610B，bundle为40cffb14ac9e5b25f0ba9da773a659e6cb50d3a942518e8ad9aa1bd80ef5a682；其余运行/资源/输出预算不变。原14文件af11be冻结已撤回执行准入，以此次重冻/独立差异复审为准。尚无编译、fixture、VM或原生安装执行，也未暂存。

### §65 唯一实际运行失败及精确恢复

修正后的14scope及75源码bundle 40cffb14ac9e5b25f0ba9da773a659e6cb50d3a942518e8ad9aa1bd80ef5a682经cursor200、独立67bc4e exit0复审放行；执行前4b2707 exit0核101个去重SHA（含16旧入口/6固定程序）、原8个index blob及范围外摘要。原命令exec-6e0d8555-5b60-455f-a91f-1741c205a333（工作turn01a19c65-3da4-7011-8c05-a2d3e9c50e53）只执行一次，入口及全部运行冻结源码保持；没有改后重跑。task e1a79451-4744-4ff9-a47a-1130e7e4efb2，snapshot fcee9c88-efd3-4940-a0ad-f7e17ffd624d，VM 55159622-033f-4d00-be7e-0a7e68241293，host Node6000。原输出完整11345UTF8B、truncated=false，四JSON含LF分别414/2541/8182/208B，与原分段tool输出逐字一致。

实际完成原read snapshot=snap_wMaptUpQwFfMRPxX72TjwQ、原source capture5B（source native12开12关/closeAttempts12、active0，1content open/1read/5B，scratch2264B释放）；原capture总renew6/publicationRenew3，元数据发布及副本各1，原5B和复制5B均清理。安装原native7开7关/peak4、5+6144=6149B分配=清零；原carrier及卷内workspace/tools/source/tool身份回执齐全。JS publication2fd/2closeAttempts/2closed、883B分配=清零，disposed=true/retainedCapture=false/retainedFd=false。preflight和两次编译均exit0；原DLL69120B SHA5c7438d963138266baf815d1610eeb4af95dbf12db9b7526c15a8e57ddd5b65b，离线exe6144B SHAb6a3b7f3e78c570c0f5c75f566c6eea53fee5e07e8b68e97b66c9b18c94501d6。

一次真实guest exec返回平台接口ExitCode0；264B规范清单和28B payload经原候选链捕获：new.txt add15B SHA81a8095dfa53d1399e09bbe4c2969fa88282d495ccabd410fa5769027a8a61da，source.txt modify13B SHA1ac211b6d92be3d8a939ede7e10fd75ffd56cd740ce5ca7757fd21899152efc7。native manifest3开3关/peak2、batch8开8关/peak4；私有通道5开5关/peak1、64API、1474B转移（本地cleared0，不混作本地清零）；候选最终payload/request/context释放断言通过。原7CLI与3helper+1manager共11子进程对象均物理关闭、pending[]；VMclosed、最后原list为空，manager15456exit0/transport buffer释放，原卷released/detached/managementClosed、closeUnknown=false。此为实际输入/安装/guest/候选和业务资源关闭的限定观察，不认证guest来源或授权报告。

失败发生在host apply前的新增验收断言“Original source/permission settlement”。静态核查455bf1/18f0d4确认：reader.permission实际为SessionInputWorkspacePermission.diagnostics，内部计数位于permission.grant.grants；本项误写permission.grants===0，读到undefined必然失败，publicationSummary也因此省略该字段。工作端和独立源码预审均漏检了此层级，不能将其改写为权限泄漏或平台失败。宿主仅1prompt/2本地固定响应、1parent/1nested read，file_batch尝试/批准/原receipt/native worker启动及调用均0；没有宿主写回。fixture打开/closeAttempt/关闭各1、写入5B；owner/boundary/provider已关闭，无managedBrowser/launchPromise。恢复前五目标GC没有执行，外层task及fixture责任对象仍被保留，不能称所有引用清空。

恢复前失败状态保持passed=false、sequencePassed=false、retained=true。原私有root D:/RMProjects/Pi/.artifacts/windows-sandbox-acceptance-owner（dev3938676073/ino1970324838180597）保留11叶89772B；host root C:/Users/Administrator/AppData/Local/Temp/sp-input-execution-qP9GEP（dev3637606815/ino22517998137468260）保留source.txt5B（ino20829148277204325、原alpha摘要），new.txt明确未创建。只读4de996核全体原身份/大小/SHA/普通单链接/规范路径，无VHD或额外叶；持有外层timer的原Node6000未自然退出。

恢复按cursor204独立审准的A→B→C各一次执行。A原exec-6a7cb2cd-63c1-4b65-abd5-46b7600e48b0/b52a5f exit0，持有同一Process句柄，核Node6000程序/完整cmd/parent16776/UTC创建2026-11-02T13:43:08.2370682Z、无直接子进程，并重新核两root/12叶及原业务关闭报告后，仅Kill(false)原Node；确认其实际ExitCode=-1。B原tool session62179/a7bc2e结束，工具退出码1、无新增输出；原exec最终failed/exit1/duration841477ms包含等待独立恢复时间，不是执行性能或自然退出。C原exec-a0b3728c-c124-4aaa-8dd9-eb878f9cdc94/51e3bf exit0，逐叶重核原身份/SHA/规范父路径后unlink，两个原根确认空且原身份匹配才非递归rmdir，14目标逐一ENOENT，passed=true/error=null；没有杀父PS/manager/VM、递归清理或新WSB/磁盘试验。A内容读取101189B、C190966B，合计292155B（不含元数据查询）。

恢复成功与原验收失败分开记录；本次实际入口仍失败，宿主写回和五目标GC没有通过结论。原源码冻结继续保留；后续修正诊断层级须独立新入口、源码/预算预审及新验证，不重复原§65入口、旧容量/链接/故障矩阵。P0桌面仍按用户延期，生产真实工程/默认切换/旧权限退役未完成。

独立恢复复核cursor207闭合：8e1bb3 exit0对两个原根均确认PathNotFound/ItemNotFoundException；446031 exit0核101个SHA、14文件冻结/八原index blob、index2030/outside2022及1DEDB7B070E866051B4E7115578FC3D17D641A0A3C4DFB4A8AC32FD03482D3FD摘要不变，原9D和patch保持。原调用时间确认A→B→C，没有提前删除。两处资源现已无本项遗留；这是外部精确恢复闭合，不把原自动收尾或GC改记通过。四doc现仅追加记录，14scope待精确暂存复核。


## §66 原权限诊断分层纠错与实际写回接线（源码预审，尚未运行）

§65的14项精确暂存已闭合：原exec-92f6305e-734f-4fd5-a1da-c85b036df671/e564b3 exit0，cursor210独立b40b1d exit0确认14项工作区=index、101哈希与增量空白检查、index2036/outside2022及1DEDB7B070E866051B4E7115578FC3D17D641A0A3C4DFB4A8AC32FD03482D3FD不变。§65仍为原验收失败、定向恢复闭合；不将宿主写回或GC追记通过。继续使用原工作/审核聊天。

本项仅新增scripts/acceptance/windows-sandbox-input-writeback-session.mjs、windows-sandbox-input-writeback-acceptance.mjs与四doc，共6scope。修改前2a2463 exit0核新2路径不存在、原14项冻结及index；index2036，范围外2032项，SHA256 9CA15475BE0501561BFD38E35C88ED4C986C3D4895BD86371D872835F38B9E70。原§65十份源码及75文件bundle 40cffb14ac9e5b25f0ba9da773a659e6cb50d3a942518e8ad9aa1bd80ef5a682保持，原9D及补丁不动。旧入口不重跑。

纠错依据是实际类的getter与release链：SessionInputWorkspacePermission保留grant诊断，grants属于内部InputWorkspaceGrantLease，不能读取外层permission.grants。新session在原publication.prepare后、attachManager前，检查两层实际诊断的整数/布尔/状态字段及原授权就绪状态，并记录preparedPermission；诊断不授权任何操作，物理安装/派发/exec仍由原对象续期与同步identity检查决定。提前保存使用入口已创建的原journal回调，不调用尚未attach的task.save。最终source reader、外层会话权限、内层grant和原生scratch分开断言：外层disposed/renewals6/grantDisposals1、弱引用与metadata/path计数0及prepare/verifier/grant/binding引用消失；内层disposed/grants0、路径与字符串/弱引用0、observer/verifier/issuance释放、policyDisposals1且policy不再持有。摘要明确嵌套grant，各缺字段显式null，结构检查拒绝缺失字段。

新session复用§65原task/helper/guest执行/candidate释放函数；原错误producer与错误诊断函数保持但新链不调用。新entry复用旧源码清单常量，旧entry主调用有自身import.meta.url路径保护，导入不会重放旧验收。77文件源束为原75加新2，协议super-pi-input-writeback-sources-v1，静态累计1316307B、最大83610B；SHA256 4c40dee19cbdcd262fe561bf20fe9192b4962a58f05cbadb8f4038455e0331af。每源≤262144B/累计≤2097152B，真实派发前继续复核同束和固定binary。

唯一拟运行固定Node26.13.0 --expose-gc scripts/acceptance/windows-sandbox-input-writeback-acceptance.mjs --run-input-writeback-once --source-bundle 4c40dee19cbdcd262fe561bf20fe9192b4962a58f05cbadb8f4038455e0331af，仅独立源码/预算放行后执行一次。正常Agent原read/权限/source capture5B→原卷一次安装固定.NET离线exe→一个VM一次guest exec→原候选28B→原host file_batch一次实际2写→原receipt身份清理。仍为3 helper（只读preflight与两编译）/1manager/1个128MiB VHD/1VM/CLI≤95/总记录≤99/未决≤4/manager命令≤16，原时间界限不变；不下载或安装依赖。预期native输入7开7关、publication2开2关；宿主native worker1启动/调用≤128，stats无活动handle/descriptor。正常private11文件、host3登记节点按原identity非递归清理，5个原对象目标4轮GC须live0；所有保留责任/关闭未知路径沿原实现保留，不把外部恢复冒充自动成功。

journal≤16384B、最终证据≤15360B/footer≤512B、host明细≤12288B、组合stdout≤32768B；新增诊断摘要约1.5KiB，最终实际字节数需原输出复核，不以估算替代证据。此为显式冷验收，无生产热路径改动，无旧测试/容量/链接矩阵重放，无额外失败模型或普通npm test。源码检查及哈希读取不声称零I/O。即使通过也仅覆盖本次固定5B输入与.NET工具链，通用工程输入/正式执行入口/默认切换/旧权限退役仍待办；P0桌面仍按用户明确延期。


### §66 唯一实际写回验证结果

源码/预算经cursor222独立放行，4ae9b5与9e9f67 exit0核六文件冻结、103去重哈希、四doc各4029B追加及旧75源束不变；日志预算估算不是实测。执行前1d71a2 exit0再次核103哈希、四旧doc blob、index2036/outside2032及9CA15475BE0501561BFD38E35C88ED4C986C3D4895BD86371D872835F38B9E70摘要。原exec-9432ce96-bc8c-4e16-9a57-b44c2466c087仅运行一次冻结新入口，固定PS7 -NoProfile/Node26.13.0，源束4c40dee19cbdcd262fe561bf20fe9192b4962a58f05cbadb8f4038455e0331af；自然完成exit0/duration19323ms。此为本次耗时，不作优化证明。原chunk2c4002与2f847e完整串接15478UTF8B，5JSON含LF为414/4915/9883/173/93B，均在预算内。

task fc253a45-a95d-416b-9e36-3230dff3ceeb，snapshot faa47e5a-8842-4d01-8b14-8ae9ee051988，VM 8d7d06cc-102e-40ba-a8f9-7568032efe4a，host Node17184。原nested read snapshot=snap_Mfd5HeFQmXFxDLuzQmcsrQ；原source5B、native12开12关/closeAttempts12/active0、一次content open/read5B、scratch2264B释放。capture renew6/pubRenew3，原5B与复制5B释放。准备时外层ready/renewals3/weak6/path2，内层ready/observations4/grants1/weak4；最终外层disposed/renewals6/grantDisposals1/weak与metadata/path0、retained标志全false；内层disposed/observations7/grants及path/pathChars/grantChars/weak0、originalIssuance/observer/verifierfalse、policyDisposals1。分层诊断和原生scratch断言均通过。

输入安装native7开7关/peak4、6149B分配=清零、无保留handle/错误；publication2开2关/closeAttempts2、883B分配=清零。本次DLL69120B SHA8d7681b8902f26a244830815d3358b14fb61853939608ccf45412532abc6decb，离线exe6144B SHAf16e1c102ce9eabef80a4e6280d1b8b357e14597b989751e1e198f0de59bb49d，编译均exit0。一个guest exec返回平台接口ExitCode0；264B清单/28B真实候选：新增new.txt15B SHA81a8095dfa53d1399e09bbe4c2969fa88282d495ccabd410fa5769027a8a61da，修改source.txt13B SHA1ac211b6d92be3d8a939ede7e10fd75ffd56cd740ce5ca7757fd21899152efc7。native manifest3开3关/peak2、batch8开8关/peak4；私有通道5开5关/peak1、64API、1474B转移（本地cleared0），原candidate最终payload/request/context释放。

原VM确认关闭后捕获候选，卷释放/source授权释放后才原host apply。正常Agent1prompt/2本地固定响应/1parent/2nested，file_batch1次、approval1次、原receipt2份，2succeeded/0failed/0notStarted。new.txt实际创建15B；source.txt采用protected_in_place，保留原identity、outcome committed/fileSyncedtrue，directorySyncedfalse，目录持久化未确认。原宿主native worker启动1次、调用7次，唯一stats activeHandles0/activeDescriptors0、fileBytesRead5/hashBytes745/hashUpdates36；这不是全部隐式OS I/O/全堆分配计数。owner/boundary/provider均关闭、workerLoadedfalse/pending0，无browser实例/launchPromise。

host fixture root C:/Users/Administrator/AppData/Local/Temp/sp-input-execution-nvKv4d（dev3637606815/ino18295873486808856），原source inode21110623253915418、新file inode2251799814303001；三登记节点各按原identity/规范父路径清理并ENOENT，safe/succeededtrue/errors[]。fixture原开/closeAttempt/关各1、初始化写5B。宿主明细4915B，原receipt事实2557B，原bootstrap scratch2264B释放。

7CLI+3helper+1manager共11物理子进程关闭、pending[]；VMclosed/最后list空，manager26208exit0/transport buffersReleasedtrue。卷released/detached/managementClosed、closeUnknownfalse；不对历史PhysicalDrive编号另作操作。固定private root dev3938676073/ino2814749768312506，11文件精确清理；清理前清单中lifecycle.json观察值12817B，并非所有journal写入峰值。主报告9883B是清理前证据，仍含passedfalse/removedFiles0等当时字段；随后独立cleanup footer passedtrue/artifactsRemovedtrue/removedFiles11/retainedfalse，最后4轮GC targets5/live0/passedtrue，原执行自然退出0。清理和引用释放各有后续事实，不能仅凭主报告sequencePassedtrue推断。

e77a5c exit0复算上述UTF8长度，并对两个原根确认ItemNotFound；868536 exit0核运行后103哈希、四旧blob及index/outside均未变。read_thread大turn查询上限导致高输出请求被拒、低额度查询截断，不是本次实际stdout截断；原工具两chunk完整输出和原exec元数据分别保留。独立复核cursor225确认原exec完整输出与两段工具输出逐字一致，按原写入格式重建journal12817B匹配。独立953ea9/a8ed79/7c1ccf均exit0核103哈希、六文件冻结/四旧doc blob、index2036/outside2032及原摘要不变；两登记根均PathNotFound/ItemNotFoundException，原9D及patch保持。本项自动清理及五目标GC限定通过，允许四doc补本结果；源码不改。

结论限定为固定5B原输入/固定.NET工具/一个实际WSB任务的真实候选，经原正常Agent授权/版本/文件链完成两处宿主写回并自动清理与GC通过。没有推广为通用工程/任意命令、正式默认profile或旧权限退役完成。§65原失败和外部恢复保持，旧入口未重放。P0桌面继续按用户延期；生产入口接线与剩余权限迁移继续推进。


## §67 有界任务意图与原父调用绑定（源码预审，2026-11-03，尚未运行）

§66六项精确暂存已独立闭合：原exec-85bc816e-82e3-4a4b-a75f-b7a5955f4437/3ae596 exit0，49c0a1增量空白通过；cursor233、独立cee730 exit0核六项工作区/index、103哈希、四旧→新及两新增空白、index2038/outside2032与9CA15475BE0501561BFD38E35C88ED4C986C3D4895BD86371D872835F38B9E70摘要。§66仅固定真实两写/自动清理/五目标GC通过；§65原失败不改写。不按阶段新建聊天。

本项7scope：新增packages/coding-agent/src/core/sandbox/task-request.ts、task-binding.ts，tests/windows-sandbox-task-binding.test.mjs，加四doc。修改前575d2a exit0核三新路径不存在、§66六项冻结与index；index2038、范围外2034项，SHA256 21B015040260BD606CA3D05CD6F64D84A652DB419EA5B483A591AF0DB951C36F。§65/66原75/77源束与源码、16旧单次入口及原9D/patch保持；不修改旧entry/volume/helper/worker，不执行或重放它们。

本项解决生产接线的前置语义，不开放生产执行。普通BashOperations.exec缺少选择性输入/输出声明和原父调度上下文；自定义后端的显式cwd仍被原shell包装层拒绝。现有shell不能仅替换operations后直接nested file_batch，PowerShell也不改成嵌套orchestration。入口方向选现有CodeMode原父调用中的宿主协调器：在其原ToolDefinition.execute第六参数存活期间借用原execution，以同一父调度器先后走真正的命令子调用与file_batch兄弟调用。此协调器和工具参数传输仍须后续实际接线/审核；本项未注册新工具、未改变CodeMode API或Agent调度，不能声称生产入口已覆盖。原输入permission、实际命令授权、候选捕获、文件授权/版本检查和VM责任各沿原owner，不另建permission表或任务表。

request只复制并校验意图：固定version1/windows-powershell-foreground-v1、原文command、相对cwd、timeoutMs、inputs(path/snapshot)和writes(path/add|modify/snapshot)。拒绝未知host授权字段/访问器/稀疏或额外属性数组、非法编码/路径及冲突；修改项必须精确引用已选择输入的原snapshot，新增项snapshot=null且不与输入冲突。联合路径≤16、单源/候选≤4096B、源/候选总计各≤16384B、路径ASCII/120字符/4层等沿现有首版限制。命令UTF8≤8192B、元数据≤32768B、执行≤30000ms；stdout/stderr各32768B为后续执行profile预算，本项没有输出读取或进度链。冻结副本和WeakSet品牌只表示验证过的意图，不授予权限；序列化后须重新校验，不能携带原上下文。

明确的首版guest命令环境为C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe，命令传输UTF16LE→Base64，cwd映射C:/SuperPiVolume/workspace下的相对目录；只固定SystemRoot/WINDIR=C:/Windows与TEMP/TMP=C:/SuperPiVolume/temp，不转发宿主环境变量。本项只是声明，后续安装器须建立这些目录并以固定argv/无shell拼接执行，再取得新卷内实际证据。宿主仍只用固定PS7；宿主程序哈希、旧probe成功不能替代新环境验证。暂不开放Node、PowerShell7整套guest工具链、后台任务、任意依赖、删除/移动或超预算工程。

binding必须由可信宿主调用点传入原SessionFiles/ctx/父execution/execute signal及原parentToolCallId；构造函数、ID和callback形状都不证明来源。普通嵌套shell没有这样的父dispatcher，仍不支持。通过SessionFiles原prototype pinReadRevisions取得专属原source，核原receipt对象、精确canonicalPath和大小预算，不制造/刷新read证据；原source的current是实例arrow，捕获该原函数，不能误取prototype.current。弱借用当前powershell/file_batch工具及execute、父callTool/findTool、ctx/owner/signal和≤16receipt key，检查原会话/边界/信号与当前工具替换。可序列化请求不包含这些对象。

单次run同步接管借用再await可信协调器，禁止重入/重用。assertInputsCurrent在输入捕获/派发前检查原receipt身份；assertSessionCurrent负责会话/父调用状态，成功写回可消费旧revision，完成时不错误地再次要求原receipt仍在表内。权限和安全打开仍由原capture负责，真正nested调度仍是最终授权与父关闭拒绝点；本类不认证任意宿主回调、不对恶意同进程代码隔离、不把工具表检查当OS准入。dispose在pending时立即使检查失效但保留该借用/source责任直到原work settled；不冒充已停止VM或任意回调活动。完成/失败后source disposal恰一次，强request/原source/实例check闭包、receipt/tool弱表、其余弱引用及cwd/parent元数据释放；外部自行保留的借用副本仍由调用方负责。

新增测试仅针对本次契约：12个请求拒绝形状，原parent不匹配/意图JSON冒用/未知snapshot拒绝，9个绑定生命周期场景（正常、原falsy异常、方法/工具替换、父关闭、会话改变、pending取消/释放、模拟receipt消费与陈旧拒绝）；这些不是旧VM/容量/链接矩阵。使用真实SessionFiles/SessionFileRevisionSource/SessionExecutionBoundary/NestedToolDispatch类，但runtime/registry/read实现受控，child调用始终0；不宣称原permission-controller、真实宿主写回或guest执行已验证。一个身份登记Temp根与notes.txt10B，fixture1fd一次关闭、一次安装read、无native worker启动/请求、无业务子进程；原issuer内部OS I/O未全计数。两个节点按原identity/规范路径非递归清理，未知关闭/身份保留原fixture责任；原业务错误和清理错误分开保留。四轮GC检查request/binding/owner/ctx/dispatcher五目标live0。测试在普通无--expose-gc运行下明确gc=null，只断言确定性释放；本次唯一获审运行必须带--expose-gc，结果须确认五目标回收，不以gc=null记GC通过。

静态58b3d2核80项（原77加新3）累计1349664B/最大83610B、证据源束0e39b7fb287764986b002ef6d87f5dfb0160580b22dde23af1457564775ae888，作为外部冻结清单，不冒充测试内或VM派发前自动核束。拟唯一命令固定PS7 -NoProfile下D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-task-binding.test.mjs。执行前复核7scope+80源+16旧入口+6固定程序共106去重SHA及四旧blob/index；仅独立源码/预算批准后运行一次。30s预期上界，stdout≤16384B、JSON摘要≤2048B；无构建、下载、VM、编译器或旧tests重放。失败保留原入口与证据，不改后重跑。

已复读完整热路径合同。新增模块只处于调用准备/借用生命周期冷路径，尚无生产消费者；未改输出、进度、事件、渲染、终端或Ledger链，没有对象池，不扩跑既有分配基准。后续实际shell/CodeMode接入必须重新审完整生产调用链并补对应热路径检查。当前先送源码/预算预审，尚无测试通过、资源创建或暂存结论。P0桌面继续延期，通用工程/生产后端/默认切换/旧权限退役仍未完成。


### §67 执行前更正：零输入与测试收尾（2026-11-03，仍未执行）

初稿fe79d2与源束0e39b7fb287764986b002ef6d87f5dfb0160580b22dde23af1457564775ae888已在任何测试前主动撤回执行冻结。自查发现inputs=[]仍pinReadRevisions会依赖既有FileService，可能给首次无输入命令带回“先read”门槛；独立cursor234另指出pending断言失败可跳过gate结算、runCases串行finally可跳过后续清理并覆盖原错误。本段更正上文相应语义与数字，原预审历史保留，不是失败入口重跑。

binding新增第七参数为可信调用点的原ExtensionRuntime，弱借原runtime/assertActive/executionBoundary及独立ctx.signal，记录原generation与session ID；核runtime.nativeFiles同一原owner、owner未closed、原runtime有效、boundary当前、ctx/cwd/session与原execute/ctx双信号。仅非空输入pin原专属source/原receipt；零输入不pin、不创建FileService、不制造revision。run借用原runtime供后续协调器使用。完成后新增弱引用及session/generation元数据同时清除；非空sourceDisposals=1、零输入=0。无host回调来源认证或新授权能力，最终nested工具授权与父关闭拒绝仍在原dispatcher。源码当前无生产消费者。

测试在第一次read前验证零输入成功且owner计数保持pending/inFlight/revisions=0，结束前再验证原boundary转换使零输入旧binding失效。生命周期9→11，成功构造11、实际work回调5、拒绝24、请求形状拒绝12；原一次10B安装read、fixture1fd、两个节点清理与5目标GC不变。pending结果在断言前立即挂原promise观察者，独立finally一定释放该gate并等待同一结果，分别保留断言与结算错误；不重新发起工作。runCases保存原失败标志和值，清理每个已登记对象分别收集错误，继续其余收尾后聚合；原throw0/undefined不会被真值判断丢掉。外层原fixture身份检查与未知责任保留规则不变；没有重试未知关闭。检查仍只代表受控契约，不证明真实权限或guest执行。

修订静态4f8f32核原77源不变；80项累计1355795B、最大83610B，修订源束1cde2aea2e9ad843e52d0c33563778e0fcd9bd8b8bbacc678b1c5b0dd45d0c04。request7867B、binding14507B、test17114B。7scope、index2038/outside2034与21B015040260BD606CA3D05CD6F64D84A652DB419EA5B483A591AF0DB951C36F预算不变；仍只拟同一新增测试一次，固定Node带--expose-gc、30s预期、总输出≤16384B/JSON≤2048B，无编译器/VM/业务子进程或旧矩阵。本轮无测试、资源创建、构建或暂存；重新冻结送独立源码/预算预审。


### §67 唯一验证结果（2026-11-03）

修订ff7381通过独立cursor244源码/预算预审后，仅运行新增tests/windows-sandbox-task-binding.test.mjs一次。冻结入口、原77源和16旧入口未改后重跑。执行前5c869a exit0核106去重SHA、四旧docblob、index2038/outside2034及原摘要；外部源束为1cde2aea2e9ad843e52d0c33563778e0fcd9bd8b8bbacc678b1c5b0dd45d0c04。

原执行exec-3509de84-1300-4022-96b1-17724d097b85（工作turn01a19cd2-1606-7e80-b07a-d354b048e236）actual completed/exit0/app duration13024ms（独立原记录13024.214ms）；固定D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-task-binding.test.mjs，固定PS7 -NoProfile，cwd D:/RMProjects/Pi。初始8ea87a无输出/session12098，最终原2e3bee exit0。完整输出1127UTF8B，三JSON含LF为89/260/596B，摘要595B不含LF；测试1pass/0fail/0cancelled/0skipped，case26.0407ms、整体12958.5196ms。满足30s预期/16KiB输出/2KiB摘要预算；30s不是硬超时，时间不是优化证据，stderr未另行独立计量。

实际11个成功构造binding/11生命周期场景、5次work回调、24次预期拒绝（其中12个请求形状）；首次read前零输入成功且owner无revision，边界转换后零输入原binding拒绝。一次安装read10B，真实SessionFiles/source/boundary/dispatcher类但runtime/工具/read实现受控；childInvocations0，native workerStarts/calls差值0且pending0。原输入source释放state disposed/checks21/weakReferences0/retainedVerifier false/retainedMetadata0；各binding强request/source/check、receipt/tool/owner/runtime/boundary/context/signal弱引用和元数据按断言清零。pending场景原gate与promise已结算；原throw0保留，模拟forget只消费receipt，不是宿主文件写回。

原fixture根C:/Users/Administrator/AppData/Local/Temp/sp-task-binding-ju3CaZ，dev3637606815/ino4785074604152907；notes.txt dev3637606815/ino18014398509554156。fixture显式open/close1/1，两个节点按原身份/规范路径非递归清理后ENOENT；外部b15016 exit0两者PathNotFound。GC4轮、request/binding/owner/ctx/dispatcher5目标live0；不外推外部保留副本或全部OS隐式I/O。没有VM、业务子进程、编译、真实权限决策或guest执行；permissionOrGuestExecutionVerified/implicitOsIoInstrumented均false。后查027b4f exit0，106哈希/四旧docblob/index/outside不变。

外部输出字节统计曾因functions isolate无TextEncoder而报ReferenceError，仅该统计步骤失败；改用Unicode码点UTF8计数，未改变或重放目标。独立cursor247已对原exec与原poll逐字复算通过；5ae6c5只读确认两节点PathNotFound，5f46f9/f7190c核七文件、106SHA、四旧前缀、80源束及index/outside。原前后检查中的bundle字段是固定文本，源束复算结论来自独立核验，不冒充脚本内自动复算。该统计步骤错误不属于目标失败或重跑。

§67只闭合有界意图/原会话绑定，不宣称通用安装、命令执行或生产入口已接通。下一项按cursor244范围建立新有界任务publication/安装协议：有输入借原capture，零输入不造read；共享owner/helper/runtime可正式泛化，形成新源束并保存旧到新关系及§65历史内容/失败证据；新runner仅首版guest Windows PowerShell，独立核命令/cwd/环境/输出/超时及进程树结算。不能把任意包冒充原CapturedInputPublication，也不把旧offline-worker的65536B当新程序的已批准预算。该链验收后再接CodeMode原父协调器；默认切换、旧权限退役、通用工具链和P0桌面仍未完成/延期。此处尚未暂存。

### §68 通用任务执行链：源码与单次验收预算（2026-11-03，尚未执行）

§67已由独立cursor253完成暂存核验，7scope/index2041/outside2034保持其历史结论。本项不再按阶段创建或归档聊天；P0桌面继续延期。当前生产后端仍未接入，以下实现与验收不能冒充日常CodeMode、默认切换或旧权限退役已完成。

本项18scope：新增task-package.ts及task-publication/install/worker/result/session/acceptance六脚本，改原volume/helper/session/candidate-manifest与input-host-fixture五共享文件，新增历史ZIP/JSON两项，追加本四记录。基线2bc7fb为index2041/outside18scope2032、摘要5CA76AF8046A6B76E6AC725D9DD10C8070D2B9301CD324D6A0C534CCB5551D84。原9删除及untracked patch不动，无commit/push/PR或旧入口重跑。

先于共享源码变更，5debbd建立docs/evidence/windows-sandbox-through-67.sources.zip：1063118B/SHA d581769d1780d68e6e81c7bf3dc04d197566f2c4605441e15d0e1a368761c13c；配套JSON57855B/SHA4198f22376033da80b72c5e393ec7e5f8a9a1b30f1faaaefed098ebef4aec693。91 ZIP项中90原始项逐字复核：80原源码、4旧记录、§65/66/67各stdout与原exec元数据六项；内部清单另占一项，保留75/77/80历史源束。独立cursor256核档案及§66/67原stdout；它不是完整运行依赖镜像，也不宣称包含全部旧手动测试。最初过长shell命令在OS206创建进程前失败、没有写入；改为结构化文件后短命令成功，不是目标重跑。0e9cea核原五共享SHA与档案后才开始修改共享文件。

任务包只承载意图与原capture交付内容：SPTASK01、16B头、元数据≤32768B、输入总≤16384B，包≤49168B。原命令UTF16LE→Base64，任务/快照UUID、相对cwd、≤30000ms、≤16联合路径、逐输入长度与SHA、显式add/modify；不传宿主路径、原revision标识或授权对象。TaskPackageBuilder一次精确Buffer及一次命令scratch，按序复制原capture返回副本后立即清除；一次finish转移，放弃/失败清除。非空借原capture，零输入publication禁止制造capture，均须原SandboxTaskBorrow存活。原capture三次renew保持install/dispatch/execute检查。

原七native input槽各仅一次，两个载体只安装到tools/task-package.bin和tools/task-runner.exe，workspace保持输入命名空间；新旧Install入口共享同一attempt latch。安装receipt核两原载体身份/digest、五目标身份、7opened/7closed/peak4、无unknown和包/runner缓冲清零。原input-install.cs保存未改；本项新增partial不复用关闭后的slot。

新guest runner严格读完所有包字节，核路径、ASCII、Base64/UTF16、长度/溢出、输入hash、联合路径/修改关联；建立所选workspace输入、cwd与temp。原命令写tools/task-command.bin，argv只含固定小bootstrap；固定Windows PowerShell、固定四环境项，无宿主环境复制。bootstrap先等stdin固定gate，原Process加入不继承的KILL_ON_JOB_CLOSE Job后才放行。正常root退出也TerminateJobObject并核ActiveProcesses=0；超时同样结算root/两pump，unknown/未结算不能发布成功wrapper。request10s，结算截止request+8s，结果上限request+10s；宿主WSB exec预算20s。宿主取消拒绝结果/写回，实际VM关闭另行确认，不把VM关闭补写成guest进程树证据。

stdout/stderr各32KiB prefix及4KiB scratch独立pump，满后继续读取计数，无逐块字符串、对象、闭包、promise或对象池；两流原字节写SPRES001固定128B头+payload，总≤65664B。严格flags、reserved0、UUID、total/seen/retained/truncation/elapsed；结果本身是guest claim。新结果捕获复用原ManifestCapture算法但独立三slot/attempt/计数，固定两种内部profile，旧manifest仍4096B；结果18顶层native operations、3open/3close/peak2、独立buffer清零，unknown传播原NativeDisk。宿主确认原VM实际closed/absent/callsClosed后才读receipt及carrier两个独立fd，核原身份与SHA、再次核原borrow，并在解码后清除carrier/借用视图。UTF8替换解码明确允许截断末尾不完整字符，不宣称原bytes必为有效UTF8。

完整审计链为guest两BaseStream.Read→固定pump prefix→一次结果组装/文件发布→原native manifest读取/host私有载体→TaskResultReader两文件同步读取→一次settled UTF8解码→旧候选capture→原Agent/file_batch。既有WSB/manager逐chunk回调未改。本项尚无生产消费者；热路径验收用新增入口内source invariants和同一编译runner --contract-check：131073B内存流、34 reads、保留32768B、明确分配/清除36864B、两个buffer经独立NoInlining调用边界后GC live0，nativeCalls0；另零输入包及9 malformed package拒绝。JS新契约测包转移/放弃清除、零输入以及15拒绝（含一次重用拒绝），不跑旧VM/容量/链接/故障矩阵。仅源码约束不外推CLR全部隐式分配。

新链借原父execute上下文/SessionFiles/runtime，用§67 binding包住原capture到VM/结果/候选释放前的协调。原fixture增加实际powershell工具定义用于当前工具身份核验，没有调用它，不能声称真实生产命令授权。真正read与file_batch仍走原Agent/permission-controller，两次真实写回、原revision消费；生产CodeMode兄弟命令调用/最终授权需后续另接。成功预期stdout为stdout:alpha 中文+CRLF、stderr为stderr:fixture+CRLF，source修改alpha-guest+CRLF、new新增derived:alpha+CRLF；fixture5B源、2真实receipt、1native worker与5B一次capture沿旧有界断言。

静态524fb5按实际新入口清单顺序核88文件、1492798B、最大83610B，新源束585971bb2f168f325022e72a604d975fafa6322807e5d6be64507bdbd0d4144b。88=旧80+新7代码+原powershell.ts；不是完整transitive依赖镜像。先前9880da只是外部清单排序草稿，排序与入口不同，在任何运行前修正，不作为执行冻结。新入口每次physical dispatch复核自身88源束及对应固定程序；runner合同执行前核原编译产物。6固定程序、16旧手动测试保持原SHA。

拟唯一命令：固定PS7 -NoProfile、cwd D:/RMProjects/Pi，D:/Nodes/26.13.0/node.exe --expose-gc scripts/acceptance/windows-sandbox-task-acceptance.mjs --run-generic-task-once --source-bundle 585971bb2f168f325022e72a604d975fafa6322807e5d6be64507bdbd0d4144b。源码/预算独立批准且执行前116去重SHA/9旧indexblob/index/outside复核才运行一次；没有先行target import/compile/parse/test/VM。失败保持原入口与原始证据，不改后重跑。

预算：一个固定private root、一个按原identity管理的固定128MiB VHD/单VM、一个Temp host fixture根与两文件。4 helper（preflight、两csc编译、一次runner纯合同）各15s；DLL≤131072B、runner≤65536B是新拟上限，尚非实测大小。host物理记录≤99=helper4+manager1+CLI94，pending≤4；CLI按旧call/start/settle/exit15/120/120/30s边界，exec本次20s；manager commands≤16/messages≤32。新journal24576B、合并evidence23040B、footer512B、fixture原evidence12288B、总stdout≤40960B；普通私有文件13项，明确task profile固定白名单按原identity非递归清理；失败保留原owner及精确身份。成功预期capture/binding/publication/resultReader/checked及2原receipt共7弱目标、四轮GC live0。上述均为待验证预算，不是已观察结果。

执行批准尚未取得，新增入口保持未运行。

### §68 执行前修正：有界预览与新文件空白检查（尚未执行）

独立cursor268完成整链审阅；原073518与585971bb2f168f325022e72a604d975fafa6322807e5d6be64507bdbd0d4144b未获执行批准，现于任何目标运行前撤回。其余包/安装/Job/结果/原VM关闭/写回责任链未发现新增阻断；d41e5a/c8148c已独立核18scope、116去重哈希、88源及7552B四记录原前缀。两处集中修正如下，不属于失败入口重跑。

原task-session对完整32KiB输出转字符串再交boundedText，确实违反大结果处理的整链分配约束。现新增taskOutputPreview：只解码min(raw.length,64)字节，再把这份小文本交既有boundedText，JSON预览≤192B；两流各报告decoded/omitted字节和固定上限。原始字节数、seen/truncation及SHA仍直接从原buffer/view取值；前缀截断UTF8采用明确替换解码。helper内部完整JSON序列化的输入现在至多64个解码字符、控制字符最坏386B，而不是完整32KiB正文；没有完整输出字符串副本。

同一新增入口纯契约补三份满额32768B情形，复用一个32768B buffer：ASCII、全控制字符JSON展开、UTF8字符横跨第64字节；预期总source98304B、实际decode192B、每份omitted32704B、预览JSON≤192B，finally清除该buffer。源码不变量明确检查带0/end参数的限量解码、64/192常量及生产调用处无完整stdout/stderr.toString。C#原pump合同、VM数、helper数及七弱目标预算不变。原15拒绝字段改名refusals，避免误把一次包重用拒绝全计为result拒绝。

新task-acceptance末尾多余空行已移除。此前普通git diff --check不覆盖untracked新文件，不能声称已检查全部新源码；4a77ad现在逐个对七新源码运行git diff --no-index --check，以退出码及无诊断双重确认通过。此为静态空白检查，无目标导入/编译/执行。

修订88源仍最大83610B，累计1495795B，源束15cbd72dacc313125f96c9443108b3a0641fa04beaf8bdece17390820a5c1a3e。唯一拟命令的--source-bundle同步替换为该值；源码其他86项、历史ZIP/JSON、9旧indexblob和原范围外索引保持不变。尚未运行、未暂存，下一步仅复核这两文件/相关契约及新束增量，不重新审已完成整链，不扩大旧矩阵。

### §68 唯一实跑失败、原始证据与定向恢复

独立cursor273完成修订增量复核并批准唯一实跑；e709d8预核116哈希/九原index blob/index2041/outside2032通过。原执行exec-da163c9a-d25b-4f43-8831-877b1ce1d7cd（initial9a8adb、session68005）使用冻结88源束15cbd72dacc313125f96c9443108b3a0641fa04beaf8bdece17390820a5c1a3e。原stdout来自8e5773与2a6815，14379UTF8B、四行正文411/2529/11233/202B加四LF，SHA cda809c2c8ada0566d64eb7de539953f334a1de25763250fd4df55589ed1a68b。原任务a2a90255-985c-4e8a-9796-c2b83c594b5f、snapshot649bb91e-5b6a-41f3-a696-90f7756dc64e。report起止2026-11-02T18:03:53.386Z至18:04:38.710Z，45.324s到失败报告；原执行最终failed/exit1/duration891726ms包含失败保留与审核恢复等待，不能当作命令耗时。

实测preflight、两次编译与纯合同helper各exit0；DLL73728B/runner23040B。零输入/包转移/弃用清零及15拒绝断言通过；三预览情形source98304B、decode192B、最大JSON191B、fullOutputStrings0。生产pump纯内存合同读取131073B/34次，保留32768B，分配与清零各36864B、liveBuffers0/nativeCalls0，包拒绝9。上述是实际有限合同结果，未外推为全局内存计量或七目标GC通过。

实际5B输入捕获与安装成功：source12开12关、1次read/5B、scratch2264B释放；capture renew6/publication renew3，原5B与副本5B清理。publication2开2关、2202B分配清理相等；native install7开7关/peak4，24302B分配清理相等。guest wrapper0，但内部命令结果exit125、timedOutfalse、elapsed1503ms、flags995、stdout/stderr均0B。宿主收到严格校验的128B结果；native result3开3关/peak2/18operations/128B清理，JS reader2开2关/908B全部清理。宿主报Actual command result differs并拒绝候选写回：batchAttempts0、realReceipts0，仅原nested read成功。原fixture source仍为alpha5B，new.txt未创建。binding/source/publication/resultReader终态均释放已登记引用；七弱目标四轮GC分支未到达。源码支持优先调查bootstrap启动握手拒绝；编码或读取原因尚未实证，不记为已修复。

原VM97e91120-e670-4c49-b206-49cf0b535e98已closed，最后平台list为空；7CLI+4helper+1manager共12记录物理子进程均closed，pending[]；volume released/detached/managementClosed，closeUnknownfalse。失败策略保留外层Node33248及现场，不是自动收尾成功。私有root dev3938676073/ino9570149209367107有8叶115976B；fixture根dev3637606815/ino3096224743863722，source ino1407374883599787为5B。9fa125只读9开9关、115981B，核原身份/规范路径/普通单链接/大小/SHA和new.txt ENOENT。

失败证据保存为.artifacts/windows-sandbox-task-68-failure-a2a90255.json，4424950B、identity3938676073:1407374884759492、SHA f0041826cfe766cdaaa360a253aa9d33a950f0ff130808c93c26481abccf73d8。包含9现场叶、88冻结源码、四份追加前记录共101个原始字节条目及原stdout/身份清单。cd18cf逐条回读核验，101开101关、源内容读取3283087B；独立cursor277/fa7870再次确认档案及原输出一致、0cac5d核116冻结值。该档案独立保留，不在清理集合，不是新的可运行入口或完整依赖镜像。

恢复按cursor277批准的A→B→C执行。首次A/4d89ae在第一StartTime守卫停止，无kill/资源检查/删除；65d02c确认Process时间2026-11-02T18:03:52.8678132Z与CIM微秒时间18:03:52.8678130Z差2ticks。cursor278批准分别精确比较两值，不使用容差。A/f7b450 exit0持有同一原Process句柄，核原Node路径/完整命令/parent23584/创建时间/无直接子进程和档案/两根九叶/原关闭报告，读取115981B，仅Kill(false)原Node，实际ExitCode=-1，删文件0。B/9faf8d取得原session68005最终exit1，无新增输出。C/f6287c exit0先重核全部九叶，再逐叶重核原身份/SHA/规范父路径/单链接后unlink，两个原根核身份且空后非递归rmdir，11节点逐一ENOENT。C两次内容核验合计231962B，档案保持。未杀父PowerShell、未操作旧磁盘编号、未重复VM/目标入口。370d58核原116SHA、九旧indexblob及index2041/outside2032/SHA5CA76AF8046A6B76E6AC725D9DD10C8070D2B9301CD324D6A0C534CCB5551D84不变。

本项结论为原验收失败、定向恢复完成；未取得通用命令成功/两项宿主写回/七目标GC的通过结论。§68冻结源码与失败入口不修改、不重跑；原9D与补丁保持，无commit/push。后续首先以最小独立诊断确认启动握手机制，再处理新的修正验证；其后仍有生产CodeMode/session原授权接线、执行profile/配置迁移及旧权限退役、真实工程整体验收。P0桌面图片回放继续按用户延期，继续原工作/审核聊天。

### 用户要求停止：进度汇总（2026-11-03 03:25 JST）

用户最新明确指令：“立即记录进度并汇总，停止剩余任务”。本记录取代前文所有自动继续指示。剩余实现、诊断、测试、验收和后续审查均停止；仅完成此次进度记录。没有新建聊天。审核聊天已于cursor283完成既有暂存确认并处于idle，没有待运行验收。

已完成范围：P1原生装配/任务生命周期、P2原生文件正确性与会话装配、P5工具目录/提示词组合、P6约定的Provider/压缩契约已有实现和限定审查验证；P4.1/P4.2提前处理项及P7.1–P7.7各自范围已有完成记录。P7整体未完成。此前§66固定任务的输入捕获→沙盒执行→两项真实宿主文件写回链路已通过；§67请求/调用绑定的限定验证已通过，不能等同于通用生产命令接入。

本轮实际新增工作：实现通用任务包、来宾PowerShell runner、结果传输与有界输出预览；完成纯合同检查与一次真实沙盒验收。实机验收失败：子命令exit125、stdout/stderr为空，宿主正确拒绝写回；启动握手具体根因未验证、未修复。随后完成原失败证据保全、原Node精确终止、九临时文件/两个原目录清理和独立恢复核对。没有完成后续四块中的任何一块。45.324s到失败报告；原执行891.726s含人工恢复等待，不能把用户等待时间说成测试一直在执行。重复的实现/修正/复核和过细拆分消耗了时间，不能以局部检查通过替代交付进度。

停止时尚未完成：
1. 通用PowerShell任务启动握手问题修复，以及命令输出、两项写回和引用释放的成功实测。
2. 生产CodeMode、正常会话及原工具授权链的接入。
3. 执行profile/配置迁移、默认切换及依赖新边界的旧权限入口退役。
4. 代表性真实工程的整体验收与最终交付。
P0真实Windows桌面图片回放仍按用户之前要求延期，未恢复执行。

保存状态：§68冻结18文件已由442b2a一次精确暂存，cursor283独立确认，index2050/outside2032及原摘要不变；验收仍记失败。此前原九项未暂存删除与super-pi-clipboard-fix.patch保持。此次停止记录仅追加到四份现有文档，未再暂存、未commit/push，也不触发新的审查循环。完整失败档案保留在D:/RMProjects/Pi/.artifacts/windows-sandbox-task-68-failure-a2a90255.json；原沙盒、卷、记录辅助进程和专用临时目录均已收尾。后续仅在用户明确恢复后继续，不自动重跑§68或其他旧验收入口。

## §69 恢复实施：通用握手修复与生产接线（2026-11-03，进行中）

用户已明确恢复执行，并补充要求完成剩余全部任务、按性能文档检查全部代码。此前停止指示不再有效；历史失败结论和原始证据继续保留，不将旧失败回填为成功。此前延期的 P0 桌面回放纳入最终收尾。

握手机制已实证：Framework Process 的 StandardInput 在创建时使用 Console.InputEncoding；带 BOM 的 UTF-8 在 SUPERPI_GO 前插入前导字节。原 Console.In 的代码页解码使精确匹配失败并 exit125。第一次尝试固定 Console.InputEncoding 仅在有控制台本地成功，真实 System 来宾 wrapper125，已保留新失败档案 .artifacts/windows-sandbox-task-recovery-failure-86a46e00.json；其12个辅助进程/VM/VHD已关闭，精确终止本次保留 Node3372，按原身份清理7叶与2根。最终修复由子进程使用显式 UTF-8/BOM 检测 StreamReader 读取 stdin，不修改控制台编码；Job 分配先于握手放行，精确字符串校验保持。新增回归覆盖 UTF-8 有/无 BOM、936 代码页、无控制台，4场景通过。

新入口 windows-sandbox-task-recovery-acceptance.mjs 的修复源束 0e175d82314c5f9b134ce8e1f10dfe6c77edc425b9535ceee228fd5cf22d27b7 实机通过。task433edc0d-1128-4e89-8a03-774a114e87a6，命令exit0，stdout21B（含中文）、stderr16B；原授权下真实写回2项、1批/1次批准；12个物理进程全部closed，13文件自动清理，7弱目标/4轮GC/live0。证据为 .artifacts/windows-sandbox-task-recovery-bom-20261103.stdout.jsonl。原§68档案SHA256仍为f0041826cfe766cdaaa360a253aa9d33a950f0ff130808c93c26481abccf73d8。

生产接线已开始：共享任务链从固定夹具中提取，新增会话SessionSandbox、CodeMode兄弟powershell/file_batch协调及打包运行时。三组定向检查通过：命令拒绝不启动、写回拒绝不提交、正常兄弟调用和释放。首次正式构建后的AgentSession→CodeMode→实际WSB零输入命令通过，中文输出匹配，task目录无遗留；记录 .artifacts/windows-sandbox-session-20261103.stdout.jsonl，验收工程根 .artifacts/sandbox-session-uTmNbv 暂留作为现场证据。类型检查与离线构建通过。

当前仍未完成：生产输入/候选写回与失败/取消实测、执行配置迁移和默认切换、旧权限退役、代表性工程/P0桌面验收、完整性能检查。默认行为尚未切换；不能交付为全部完成。既有源码不变量首次检查发现6处此前已有property delete；CodeMode回归初跑与构建并发导致8个dist依赖缺失，不计为有效回归，构建后重跑正在进行。后续记录真实修复和结果，不以局部通过代替整体交付。未暂存本轮改动，未commit/push，原九删除与补丁保持。


## 70. 最终完成记录（2026-11-03）

**本轮 Windows/Node 交付范围完成，原四项剩余工作及恢复后的 P0 桌面回放均已闭合。** 当前状态以本节为准；早期“未完成/停止/待验收”保留为当时事实，不能覆盖本次证据，也不能将历史失败回填为通过。未运行 Linux/NVX/Bun 或任意第三方组合，不扩大既定平台范围。

| 原剩余任务 | 最终结果与证据 |
| --- | --- |
| 通用命令执行 | GateBootstrap 在 headless/System 来宾读取 BOM stdin 的根因已修复；显式 UTF-8 StreamReader，Job-before-gate 与精确握手仍保留。四项 gate 回归通过。通用任务支持真实 PowerShell、snapshot 输入、stdout/stderr、显式输出与取消/超时；失败不会发布候选。 |
| 正常产品流程接入 | AgentSession → CodeMode → 原 powershell 授权 → 实际 WSB → 原 file_batch 已贯通。最终工程脚本读取 JSON、计算 42、输出中文并写回两项，全部成功；10 个物理进程 closed，pending=0、task root removed，候选和结果字节释放。 |
| 配置与旧权限迁移 | 全局 executionEnvironment / executionPermissions、CLI 会话覆盖、JSON schema、Windows 新配置默认 sandbox 已完成；现有配置不猜测扩大权限。新 profile 仅安装原生权限 owner，旧 guard 不再重复注册；未适配 sandbox 的宿主入口明确禁用。旧会话权限不导入新 profile，仍有消费者的兼容路径按明确条件保留，见配置文档。 |
| 最终整体验收 | 离线构建、类型、源码门禁、全量回归及 20 个性能基准完成。实际工程成功、命令 exit23、超时与取消均有真实 WSB 证据；失败三类不写回宿主。 |
| P0 桌面图片 | 终端重启后工具恢复；真实 Alt+V/Ctrl+V、系统截图、Aseprite 图片复制、Explorer 中文文件名图片及普通 '-' 文本回放通过。辅助视觉 2 次：vision 每次 1 图、文字主模型每次 0 图；损坏图片保留失败原因，Enter 阻止发送，删除失败附件后可退出。 |

最终代表工程：`.artifacts/windows-sandbox-project-final-20261103.jsonl`，任务 `cc7540a2-e5d0-4287-a1d8-161ae12f8454`，根 `.artifacts/sandbox-session-eOxRnU` 作为可检查的工程证据保留。成功/失败/超时/取消原记录分别见 project-final、windows-sandbox-failure-20261103、windows-sandbox-timeout-session-20261103、windows-sandbox-cancel-session-20261103 的日志。没有重新运行冻结的历史失败入口。

回归：完整 suite 385 个单元 / 5165 项；初次最终运行有 3 个失败，分别是实际打包 peer 夹具缺失、源清单重复项、LSP Windows URI 夹具异常分配，均已诊断修正；随后对应 34 项全部通过。合并最终结果 5069 通过、96 个明确平台/可选场景跳过、0 未解决失败。`npm run check`、`npm run build:offline`、最终 `test:hot` 14 文件 / 81 项、diff whitespace 检查通过。保留失败和修复后日志，不将结果描述为一次全绿运行。

性能按完整生产调用链审查；20 场景最终全部通过。17 MiB 输出 / 272 chunks 仅固定保留 32768 B；200000 工作区 + 200000 普通 epoch 检查；热路径 Promise/controller=0，9 WeakRefs / 4 GC / live=0。Main/Alt 各 20000 帧，完整帧复制=0、最终字符串=1/帧、队列高水位=1、释放后引用=0。原生文件、任务、Provider/压缩、CodeMode、MCP、Evidence Ledger 与大结果各有独立数据；详见 [性能完成检查](performance/native-sandbox-closeout-2026-11-03.md)。

桌面证据：`.artifacts/windows-image-desktop-acceptance.json` 与 `windows-image-desktop-evidence.zip`。离线 fixture 使用真实 UI/剪贴板及生产序列化，网络禁止，未声称真实模型识图。经典 conhost 滚动区会保留部分中间状态行，当前附件状态和最终 wire 均核实；此展示限制不隐藏。两个验收终端、图片预览、专用 Explorer 与本次 Notepad 标签已关闭；用户其他 Notepad 标签保留。三个专用临时根按记录的路径、inode、内容 hash 归档后逐叶清理。

[执行环境与配置说明](execution-environments.md)明确支持范围：Windows、单会话串行、命令最多 30 秒、单文件 4096 B / 总 16384 B / 16 路径、有界离线任务。固定工具链缺失时拒绝运行，无宿主降级；不把本次小工程验收泛化为大型联网构建。兼容保留用于旧配置/历史数据/旧宿主，删除条件是完成显式迁移并退出相关支持范围；不会通过删除用户历史满足“退役”字样。

本轮没有 commit、push、PR 或再次暂存；已有暂存内容、9 份用户文档删除与 `super-pi-clipboard-fix.patch` 保留。运行时任务资源已收尾，`.artifacts` 下仅保留有意保存的验证记录与工程证据。统一源码/档案指纹见 `.artifacts/native-sandbox-closeout-manifest.json`。

## 三档权限接线追加交接（2026-11-03，已完成）

以[总进度 §71](Super%20Pi%20权限简化与原生能力整合方案.md#71-三档会话权限完成记录2026-11-03)和[会话权限与沙箱](execution-environments.md)为当前交互入口：直接 `superpi`，通过 `/permissions` 或 `/permission` 选只读沙箱、沙箱读写（默认）、宿主全部读写。前两档都在真实 VM；切换保留当前对话，第三档需明确确认且不会被新会话继承。

旧文中的命令行环境切换、30 秒/4 KiB 小任务上限属于旧非交互/SDK 兼容协议；新交互工作区为 256 MiB 快照、120 秒命令、2 MiB/文件与 16 MiB/32 文件写回。失败、超时、取消、迟到结果不写回；快照冲突会拒绝，重新选模式或 reload 刷新。没有宿主自动降级。

真实成功/拒写/失败/超时/切换、VM 后 reload、宿主工作区外写入及 Pi 仓库读取/Node 都已验证。定向回归首次 4 个旧宿主工具夹具失败，改经实际菜单选择宿主后通过；覆盖并集 99 通过、4 平台跳过。按性能合同完成新增链路采样、结构计数与资源释放，见性能文档追加节和 `.artifacts/permission-modes-closeout.json`。本轮验收资源已关闭，无等待任务；版本 1.0.0 构建已供本地 `superpi` 使用，没有提交或推送。
