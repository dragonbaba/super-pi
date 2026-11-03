# Windows Sandbox 任务专属固定 VHD 实现方案

**当前状态（2026-11-03）：本轮 Windows/Node 整合交付范围已完成。四项剩余任务、P0 真实桌面回放及性能检查均已闭合；结果、支持范围与兼容条件见本文件末尾 §70。以下旧状态均为历史记录。**

历史日期：2026-11-02。当时状态：**记录替换故障已修正；原生单盘生命周期与第21节唯一GUID共享/32B正常收尾限定通过。第27节唯一现场取得114MiB后原始112及宿主核对的限定容量证据；最终记录检查故障已最小修正并离线验证，第28节外部收尾完成、无残留，原现场失败保持。异常失效与真实工程适配仍待验收，生产接入/默认切换关闭。**

本项承接用户批准的 [当前首版契约第 0 节](Windows%20Sandbox%20存储与执行契约预审.md)。平台全部存储硬上限、可信来宾监督者及 HMAC 不再是首版前置，不重新选择后端。任务是“专属固定 VHD：创建、身份绑定、共享准入与释放生命周期”；已有剪贴板、禁网、文件、取消及三进程树结论保留，不重复旧矩阵。生产工作区、默认切换及权限退役关闭，P0 桌面回放待办。

## 1. 本项最小实现及审核决定

范围审查 turn `01a19610-cd28-78f2-925b-f92281773ca1` 允许先实现生命周期/身份和替身检查；路径方案复核 revision 183 / turn `01a19615-0d0a-7a42-b82e-42c4537d3efb` 同意唯一采用 **`\\?\Volume{GUID}\exchange`**。不建立宿主普通目录挂载点、盘符、底层挂载目录 ACL 或 DOS 路径备选。原生卷 GUID 命名有官方依据，不能据此推断固定 WSB 客户端接受或保持该路径语义。[卷命名规则](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-volume)

| 实现 | 责任 | 本轮不承担的结论 |
| - | - | - |
| [volume.mjs](../scripts/acceptance/windows-sandbox-volume.mjs) | 宿主控制状态、持续助手进程/有界协议、释放与读取门槛、真实撤销回调 | 不启动 WSB，不生成映射，不解除真实共享准入 |
| [volume-helper.ps1](../scripts/acceptance/windows-sandbox-volume-helper.ps1) | 单一管理进程，从创建到确认解除附加持续持有同一 VHD 管理对象；执行固定 Storage 对象链 | 不提供任意命令、任意盘号或路径入口；不在超时/控制丢失时自动退出 |
| [volume-native.cs](../scripts/acceptance/windows-sandbox-volume-native.cs) | Win32 VHD API、文件身份、固定类型/尺寸/分配、卷物理区间及目录身份校验 | API 声明和编译不是本机存储准入/实测证据 |
| [定向检查](../tests/windows-sandbox-volume.test.mjs) 与 [PowerShell 替身](../tests/fixtures/windows-sandbox-volume-helper-check.ps1) | 控制状态与实际 helper 函数的非存储替身，C# 编译和 x64 ABI/PS 解析 | 不运行 VHD API、Storage provider 或实际管理助手入口 |

唯一管理助手由宿主以隐藏窗口、无 shell 拼接、固定脚本与参数启动。已编译程序集必须在宿主私有任务根内、普通单链接文件、长度不超过 128 KiB，且匹配宿主提供的 SHA-256；助手再次核对后加载。不在助手启动时安装组件或临时编译。现有任务 owner 将来仍负责任务、VM、CLI、取消和独占准入；必须在原私有 owner 根内安排此资源，并在 VM 与卷两类责任都收口后才能释放原 owner。当前没有接入生产或已有运行入口，不能把本类自身视为已实现全局任务准入锁。

## 2. 固定容量与宿主预算

| 对象 | 固定值 / 核对方式 |
| - | - |
| 虚拟磁盘 | VHD 格式，128 MiB；创建版本 1，`FULL_PHYSICAL_ALLOCATION`，512 字节扇区，无 parent/source |
| 镜像文件 | 逻辑长度与实际分配分别检查在 128–129 MiB 内；禁止压缩、EFS、稀疏和多硬链接；1 MiB 是本实现允许的格式/分配余量，不声称实际开销恰为 1 MiB |
| 分区 | MBR，唯一分区，偏移 1 MiB、长度 126 MiB、IFS 类型；前后各留 1 MiB，不分配盘符 |
| 文件系统 | NTFS、4 KiB 分配单元；文件系统元数据占用包含在分区中，用户可用空间不等于 126/128 MiB |
| 宿主准备条件 | 镜像路径为未重解析、未压缩/EFS 的本地 NTFS 私有根；创建前可用空间至少 129 MiB＋32 MiB 余量，失败关闭；该预检不宣称平台硬上限 |
| 程序/记录 | 原生 DLL ≤128 KiB；helper journal/next 各 ≤8 KiB；宿主 owner journal 单条 ≤8 KiB，沿用有界替换写入，不追加无界历史 |
| 协议 | 单请求 ≤512 字符，单响应含换行 ≤8 KiB，最多16命令/32响应，最多1个待定调用，宿主一份8 KiB行缓冲 |
| 期限 | 管理请求最多120秒逻辑期限；正常exit后物理close等待最多5秒；期限失败保留助手/归属，不杀进程使卷提前消失 |
| 候选数据 | 既有16项、4 KiB单文件、16 KiB合计、4 KiB清单不变；本项不扩大候选上限 |

固定预分配标志是该 VHD 的机制依据；还核对 provider subtype 为 fixed、请求的磁盘 GUID 和虚拟尺寸。该保证只涉及这块磁盘，不扩展到 WSB 系统盘或平台开销。[创建标志](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ne-virtdisk-create_virtual_disk_flag)、[创建参数](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-create_virtual_disk_parameters)、[磁盘信息](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-get_virtual_disk_info)

## 3. 身份链与破坏性操作准入

1. 只对新路径 `task.vhd` 调用 CreateVirtualDisk；已有对象即拒绝。创建失败时返回句柄未定义，不能关闭或使用该值。成功后先登记已创建状态，再保存镜像文件身份和请求 GUID；身份未能建立的部分创建保留，不按猜测删除。[CreateVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-createvirtualdisk)
2. 助手只在自身已有令牌上启用 `SeManageVolumePrivilege`；缺失则失败，不发起 UAC、不提权其他任务或启用系统功能。附加使用 RW/GET_INFO/DETACH 权限，设置 NO_DRIVE_LETTER，不设置 PERMANENT_LIFETIME。宿主卷及 provider 条件须实际操作前满足，本轮没有查询或更改。[AttachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-attachvirtualdisk)、[附加标志](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ne-virtdisk-attach_virtual_disk_flag)
3. 从当前持有句柄调用 GetVirtualDiskPhysicalPath，限定为 `\\.\PhysicalDriveN`；N 是本次定位结果，不是长期归属标识。指定镜像的 Get-DiskImage 必须唯一、Attached=true、ImagePath匹配、DevicePath与该结果一致，其关联 Get-Disk 必须唯一、尺寸匹配、非boot/system且满足可写/在线准入。缺失/多值/查询错误不补猜盘号，不选择“新盘”“最后一盘”或“唯一RAW盘”。[设备路径](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-getvirtualdiskphysicalpath)、[镜像关联链](https://learn.microsoft.com/en-us/powershell/module/storage/get-diskimage?view=windowsserver2025-ps)
4. 初始化前要求 RAW、0分区；仅对上一步实际对象调用 Initialize-Disk。完成后重新取得所属对象，要求 MBR、0分区，再固定设备Path、UniqueId及MBR Signature。分区创建前重新核对；只对该对象创建固定偏移/尺寸分区，不用通配命令。[Initialize-Disk](https://learn.microsoft.com/en-us/powershell/module/storage/initialize-disk?view=windowsserver2025-ps)、[New-Partition](https://learn.microsoft.com/en-us/powershell/module/storage/new-partition?view=windowsserver2025-ps)
5. 格式化前重新派生唯一分区，核对它的反向磁盘关联、编号、偏移、尺寸和无盘符；只向 Format-Volume 的 Partition 参数传该对象。卷GUID必须从该分区 Get-Volume 得到，不全局取第一个卷、不按卷标定位。[Format-Volume](https://learn.microsoft.com/en-us/powershell/module/storage/format-volume?view=windowsserver2025-ps)
6. 原生 IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS 要求唯一 extent，其磁盘编号、偏移和长度与上述当前物理设备/分区匹配。之后才在该GUID卷下新建固定exchange目录；记录目录文件身份，核对最终GUID路径没有跳转。再次验证不自动重建丢失目录，不解除重解析对象拒绝规则。[卷物理区间](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-ioctl_volume_get_volume_disk_extents)、[布局定义](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ns-winioctl-volume_disk_extents)

现实现假设宿主控制代码及私有根不被另一个有权宿主进程恶意并发替换；每次关键操作仍做身份复核。不能把这种控制流程检查说成对恶意管理员或内核的原子隔离。实际 provider 的对象属性、分区布局和延迟行为仍待验证；不通过时保留责任，不隐式扩大超时或重试初始化/格式化。

## 4. 唯一共享路径及尚未开放的准入

HostFolder候选始终是完整的 `\\?\Volume{GUID}\exchange`。不删除 `\\?\` 前缀、不转盘符、不建宿主目录别名；卷消失不会把该名称变成本实现创建的普通宿主目录。GUID字符串本身不是归属证明，始终结合第3节对象链。Windows允许同一卷有多个GUID名称，所以只比较记录的关系，不声称字符串是所有环境下唯一表示。

WSB官方只明确 HostFolder必须预先存在，否则启动失败；自动创建的是来宾SandboxFolder。这不证明固定客户端支持卷GUID路径，也不证明共享重连/缓存句柄在失效时的行为。[WSB配置](https://learn.microsoft.com/en-us/windows/security/application-security/application-isolation/windows-sandbox/windows-sandbox-configure-using-wsb-file)

因此，helper响应和 `TaskVolumeOwner.shareAdmission` **始终为false**，prepared只表示存储准备回执，替身也不能开启共享。未来如果固定客户端拒绝GUID路径，本路线准入失败，不增添普通目录回退。原生GUID访问、WSB接受、失效后的行为及实际容量拒绝是不同验证结论，不能互相代替。

当前 `OfflineCandidateOwner` 仍要求盘符形式合成根。本项没有修改它的根路径正则，也没有将其冒充真实GUID目录读取器。后续须单独审查携卷身份、重解析点和实际打开/关闭约束的读取适配。本次只新增一个3字节合成候选的接线检查，用于证明正常释放盘不会撤销已检查字节，真正revoke仍传递。

## 5. 生命周期与失败责任

```mermaid
flowchart LR
  A[宿主独占任务owner] --> B[单管理助手创建并持有VHD句柄]
  B --> C[镜像/设备/分区/卷/exchange身份核对]
  C --> D[prepared 真实共享准入仍关闭]
  D --> E[宿主确认VM及所有调用已退出]
  E --> F[候选读取租用与句柄关闭]
  F --> G[解除附加并核对 -> 关闭管理句柄 -> 删除自有镜像]
  G --> H[助手物理close后盘责任收口]
  F --> I[独立持有已检查字节]
  I --> J[将来按授权/版本提交或释放]
  B -. 异常退出或控制失联 .-> K[阻止准入/读取 传递撤销与取消 保留owner]
```

宿主读取门槛使用实时宿主回调，不复制冻结的旧生命周期值。只有已确认closed且instanceAbsent，或者确未发出过运行调用的not-started状态，同时callsClosed=true，才可开始读取或正常释放。正在读取时必须显式归还读取责任；activeHandles非0或uncertainHandles非空会锁住资源收尾、撤销候选并请求取消实际执行。取消回调和候选revoke是宿主接口，不来自来宾JSON。

正常释放盘不调用候选dispose/revoke：已检查私有字节可以在卷拆除后继续持有，临近提交仍需核对授权和来源版本。真实任务撤销则调用TaskVolumeOwner.revoke并传递候选revoke；宿主必须把实际撤销接到该方法，不通过修改旧输入对象实现。

| 情形 | 必须保留/执行的责任 |
| - | - |
| 创建前失败 | 没有已创建盘时不执行盘清理；发现未登记的部分镜像则阻断，不猜身份 |
| 已创建、附加或初始化阶段失败 | 只允许对记录的本任务镜像核对/解除附加/关闭/删除；不初始化或格式化其他对象；无法确认身份则保留 |
| VM/调用仍活动或业务读取中 | 禁止发送release，不因超时先杀管理助手 |
| close-unknown | 拒绝正常解除附加/删除，保留不确定句柄责任；清空Buffer不等于关闭句柄 |
| 助手异常close、通信中断、格式/身份变化 | 禁止后续共享/读取/接纳，传递候选撤销及执行取消，保留最小归属；不自动重启助手或抢占旧owner |
| 请求逻辑超时 | 保留最多一个待定操作与物理子进程；不kill；直到物理收尾或另行审查恢复，不能放行下一任务 |
| 控制EOF/协议或journal失败 | 助手保留句柄进入阻断等待，不主动exit引发隐式脱卷；异常OS终止仍会关闭句柄，宿主必须按unsafe处理 |
| 解除附加 | 先确认业务读取结束，核对本任务镜像；必要时DetachVirtualDisk，然后指定镜像Attached=false、持有句柄IsLoaded=false、记录的卷GUID无法打开且属于明确的不存在/断开错误；权限/查询错误不冒充消失 |
| 清理完成 | 关闭管理句柄后按根/镜像身份删除镜像；重复release不重复清理已收口资源。助手exit回执与物理close都确认后才记盘released |

非永久附加会在最后管理句柄关闭时自动解除；显式Detach也有其他句柄约束。不能把助手退出、单次API成功或清空内存当作解除附加证据。查询旧PhysicalDrive编号时不能清理后来复用该编号的其他设备；历史mount manager GUID缓存不删除，也不单独当作活动卷。[DetachVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-detachvirtualdisk)、[IsLoaded](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-get_virtual_disk_info)

## 6. 本轮检查与后续实测条件

本轮只在代码复审放行后运行新test文件的8组检查：宿主替身覆盖使用中/未知关闭/异常助手/身份变化/超时/协议预算及幂等释放；PowerShell替身通过AST只装载8个实际helper函数，所有Storage调用为显式mock，关闭模块自动加载并确认Storage模块未载入。20项替身/合成目录分支包含实际Write-State的null序列化及journal写入，生成回执交实际JS协议解析；只编译native DLL并读取类型布局，不构造NativeDisk或调用原生存储API。编译/候选临时根均提前登记身份清理，结束断言不存在。执行过程及两次故障修正见第7节，不把最终通过改写为首次全部通过。

首轮代码审查 revision190 / turn `01a19624-a674-7de3-9ad7-bcdd82627c54` 要求修正宿主journal失败后仍可继续的状态，以及File.Exists不能证明部分创建镜像不存在。现已改为关键保存失败统一阻断、撤销及取消各一次；未创建状态只接受父根身份核对后的明确叶文件不存在异常，其余查询错误或对象存在均保留责任。助手自身journal/输出失败也为不可恢复控制失败，禁止继续命令。成功回执保留JSON null，管道替身不重声明公共参数，未记录卷路径用显式布尔值跨PowerShell/C#传递。修正与新增覆盖经revision194复审后执行，原生ABI偏移无剩余审查发现。

本链没有生产调用者。控制协议最多16个生命周期命令，不是持续工具输出或进度流；固定8 KiB缓冲、单待定调用，物理close释放缓冲/监听器/等待引用，逻辑超时保留必要责任。没有对象池。已重读 [热路径分配契约](performance/hot-path-allocation-contract.md)；未来接入生产结果/进度链时重审完整调用链，当前不扩跑无关生产基准。

后续现场验证需先审查具体入口及权限/组件/空间条件，不能直接运行本helper作为已授权实测：

1. 仅本任务128 MiB盘；核对实际VHD、分区/卷/GUID/exchange身份、无盘符/普通目录映射；原生GUID访问正常对照。
2. 固定WSB客户端接受唯一GUID路径的正例；拒绝时阻断，不改目录别名。网络/剪贴板等配置不变。
3. 直接写入而非输出包装器：预定1 MiB块、最多144 MiB、最多30秒，必须观察实际存储不足错误。路径/权限/超时或达到写入上限均不能冒充硬容量通过；不向宿主普通卷灌满探索。
4. 核对卷外保护哨兵、实际容量及失败来源，再在VM/调用退出后读取候选；确认业务句柄关闭，解除附加/助手退出及自有镜像清理。
5. GUID失效/助手异常路径先审最小反例，再决定是否需要单独一次实验；正常释放不能自动证明WSB缓存/重连行为。真实候选读取适配和工程提交继续独立待办。

当前没有执行以上现场步骤。本轮不提交、不推送，原九份删除和patch保留。

## 7. 实际检查、清理与复核记录

代码复审 revision194 / turn `01a1962c-a6bb-7ee3-99fe-e317915352ac` 放行当前8组，不包含实际管理助手、存储操作或实例。全文件命令仅运行一次：`node --test --test-reporter=tap --test-concurrency=1 tests/windows-sandbox-volume.test.mjs`。第1–7组通过，第8组C#编译/ABI通过后在PowerShell解析阶段失败；进程退出1、报告772.5634ms。三处行首-or不兼容Windows PowerShell 5，移到前一行末，条件语义不变；解析错误输出改为ASCII ErrorId/行列。

语法修正经revision196 / turn `01a1962e-953f-7902-87a3-c4d3262503de` 复审，仅运行第8组：`node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern="^native helper compiles" tests/windows-sandbox-volume.test.mjs`。本次解析通过，但释放故障替身没有观察到拒绝；退出1、报告845.6775ms。静态定位发现循环变量failure与script:failure同名，Reset-Case清空了待注入故障。改为独立releaseFault，并保留精确分支诊断；没有另跑纯定位实验。

该替身修正经revision199 / turn `01a1962f-d7de-7870-b937-26c41a28acfa` 复审，使用同一第8组过滤命令进行最终验证：1组通过、0失败/取消/跳过，进程退出0，报告872.181ms（子项811.1075ms）。PowerShell回执为helperParsed=true、realStorageOperations=0、cases=20、abiSize=56，真实回执通过VolumeProtocol解析。前7组未重复运行；合计8组各自取得通过结果，不宣称整份文件在一次运行中全通过，也不将耗时当作性能优化证据。

| 责任 / 资源 | 本轮观察 |
| - | - |
| 管理准入 | shareAdmission始终false；实时VM/调用状态不允许时不发release；读取中、close-unknown、助手异常及身份变化阻断 |
| 协议生命周期 | 最多1个待定请求、固定8KiB行缓冲；超时保留物理归属，close清理pending及监听器；无自动kill |
| 日志失败 | 归还读取责任时失败持续阻断；恢复journal回调也不解除，撤销/取消各一次；助手next写入冲突使控制不可恢复 |
| 候选字节 | 3字节实际离线候选在模拟盘释放后仍可读取，真实revoke传递后不可消费、模块内部保留归零；不代表GUID读取适配完成 |
| 原生/Storage | C#三次仅编译；三次PowerShell检查进程实际结束，最终20项分支通过。未构造NativeDisk、未装载Storage provider、未运行实际helper入口 |
| 临时资源 | 首轮2个、两次过滤运行各1个，共4个专属根；after按记录身份及解析父路径核对后删除，并断言不存在。编译DLL、journal/next和3字节候选随根移除，无本项运行遗留 |

最终实现/检查SHA-256如下；源码读取和散列不构成真实存储验证：

| 文件 | SHA-256 |
| - | - |
| windows-sandbox-volume.mjs | `7F55957F9199B6FBC75747B426C7735F1A6DDAC71DC8E97AE2693BC3CEB3A202` |
| windows-sandbox-volume-helper.ps1 | `CCD4C65B31F00450A00525C54ED49B0271E41439F5DE182D6E2C138C0EA49FD2` |
| windows-sandbox-volume-native.cs | `F9FA114279FB8B121C5660A7CAE8190388FC52F2A881668BBF4D6BD892A504F5` |
| windows-sandbox-volume.test.mjs | `09903B1EA521F7A5C881BD32D29213DCEA3E8B92128E993134DCEB5B603A6A47` |
| windows-sandbox-volume-helper-check.ps1 | `E0E48BEE6BD8D7D1439DADED30AABE66A6880D4AC7FA9B66EEB84EC3EB4C647E` |

最终结果/记录复核 revision201 / turn `01a19634-18a1-7ca0-b0ec-8e9a901003c8` 通过，无剩余代码/记录阻断，无需追加检查。本项8文件已精确暂存，index由1910增至1916条；工作副本与index的Git差异为空，两份独立文档18个本地链接检查通过。范围外1908条完整stage摘要保持 `0172CE3FDD77B10EF3152676B09649CBF3860C9A687F5084B8F5C428BA26D702`；不得改变范围外条目或原九份删除/patch。本项只完成生命周期代码与替身，不将真实硬容量、固定客户端GUID兼容/失效语义、本机权限及provider条件或真实候选接线记作通过。

## 8. 当前阶段：原生单盘入口与正常生命周期

用户继续下一阶段。范围复核revision205 / turn `01a1968e-71a6-76d3-a001-55c07789e9bd` 将第一项现场门槛限定为一次单块128MiB盘、原生GUID小文件正例及正常释放；WSB兼容、硬容量和异常失效仍是后续独立项。revision206确认可继续实现入口，实际磁盘仍须代码先审。三项产品决定不重开。

只读前置观测于2026-11-01T10:03:30Z：当前管理员令牌true，SeManageVolumePrivilege存在、Disabled，未调整权限。D为Fixed/NTFS，可用88,204,181,504字节，高于168,820,736字节门槛；D:\、RMProjects、Pi、.artifacts均为目录，重解析/压缩/EFS掩码为0，Node realpath一致、无符号链接，dev均3938676073，ino依次1407374883553285、281474976746555、844424931353657、2533274791626374；固定owner根不存在。这些不是执行时保证，入口再次检查元数据，实际NativeDisk仍检查父链/根及空闲空间。

首条exec指定shell后实际回执仍为PowerShell7.6.9，不能当固定助手环境证据；随后明确调用固定exe，仅补运行时和命令元数据，确认Windows PowerShell5.1.26100.9711/x64。Storage2.0.0.0，实际使用Get-DiskImage、Get-Disk、Initialize-Disk、New-Partition、Get-Partition、Format-Volume、Get-Volume共七个命令（范围讨论“六个”已纠正），所需参数存在。固定powershell.exe SHA-256为`60C9B29843624DD8AF6B6A7B26147753BE6AEEF65098B9A503CC50850AFE410F`；csc保持`ECA02E6B15CDE93009A59A3D129D5A77FB5008F2E1CF62CF573B6737C747ECC3`。没有执行Storage数据查询或变更；Get-DiskImage到Get-Disk管道沿用[官方例4](https://learn.microsoft.com/en-us/powershell/module/storage/get-diskimage?view=windowsserver2025-ps)，无需因缺少同名参数而改猜盘号。

新增手动入口 [native-acceptance.mjs](../scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs) 必须显式提供`--run-native-volume-once`。它持有现有固定独占owner根，不抢占已有根；先运行固定工具只读前置及编译，再以单一管理助手执行prepare→verify→probe→release→exit。没有WSB调用、共享配置或生产调用者。编译/前置各最多15秒，仅这些非存储助手可按原OwnedHelperRunner在取消/超时后结束并确认close；管理助手沿用逻辑超时保留，不kill，存储责任未知时保留外层owner及进程。

probe由宿主owner与助手分别限制一次，调用前检查实际未启动VM且调用已结束、卷/exchange身份；原生方法在I/O前登记已尝试。固定叶名native-control.bin仅CREATE_NEW，内容为宿主task GUID的32字节ASCII。单个写句柄写入/Flush/核对长度和身份后关闭，再从同一GUID路径打开读句柄，比较32字节、长度及身份，关闭后再核对exchange。固定32字节缓冲，无循环灌写；原生探针opened/closed计数分别记录，关闭未知禁止正常释放。探针文件随自有镜像删除，不把普通目录当备用目标。

宿主私有volume-probe.json最多4KiB；正常数据必须匹配task/volume/exchange及文件身份、matched=true、opened=closed=2、closeUnknown=false。固定五种操作的首次错误各最多4KiB，含阶段、异常类型、HRESULT/原生错误码及最多512字符原因；查询、日志或关闭失败不能冒充成功。既有helper journal/next各8KiB，外层owner journal/next各8KiB，DLL128KiB上限保持；整体记录超过8KiB会阻断，不追加无界历史。

正常释放仍由原有检查链证明指定镜像未附加、持有句柄IsLoaded=false、记录GUID明确不可用、管理句柄关闭及镜像删除；Node再确认helper物理close且pending为空。仅当上述责任结束、编译/只读助手无active、宿主读取回执没有未知关闭时才按已记录身份删除外层owner。不会以助手退出单独证明解除附加，也不会把普通写入失败自动升级为关闭未知；关闭已知时仍尝试一次正常释放。

新增 [五组定向检查](../tests/windows-sandbox-volume-native-acceptance.test.mjs) 与 [probe替身](../tests/fixtures/windows-sandbox-volume-probe-check.ps1) 经代码复审后执行：正常实际TaskVolumeOwner顺序与关联；活跃/重试/身份及关闭未知拒绝、可释放的写失败；准备后取消；外层日志失败及报告预算；编译与真实PS函数的七项替身、真实回执解析。替身关闭模块自动加载，不构造NativeDisk、不执行前置代码（仅解析）或存储API；只创建一个按身份清理的临时根。既有8组/20项及旧隔离矩阵不重复运行。新增检查的实际结果在下文记录；当前尚未执行实际管理助手或存储操作。

代码先审revision210 / turn `01a1969a-3f51-7163-b224-27c805b3268b` 提出三项P2。修正为：原生类型/文件身份/关联/内容不符及身份查询异常使用StorageIdentityException，助手沿异常链识别并传storage-identity-failed，宿主进入unsafe保留；普通I/O失败仍以已知句柄状态和释放门槛判断，不能混为同一类。新替身调用实际编译类型的纯身份断言（不调用Win32），验证异常经PS包装后仍能分类，避免仅伪造返回ID。外层journal有独立持续失败位，首次或助手启动后写入失败均禁止后续启动/根删除；保留路径不让再次记录异常逸出。助手输出仅保留每流256字符预览、原观测字节数和截断标志，操作错误最多五条、消息预览256字符；完整报告在删根前和stdout均验证含换行不超过8KiB。超限保留owner并输出明确不完整的小型诊断，不声称未持久化的细节已经保存。取消回调、回执读取/关联失败和未知关闭均有持续阻断路径。

revision214 / turn `01a196a4-a691-7d21-8a54-22f5e65b4541` 复审通过后，唯一一次执行`node --test --test-reporter=tap --test-concurrency=1 tests/windows-sandbox-volume-native-acceptance.test.mjs`：5组通过，0失败/取消/跳过，退出0，报告894.0717ms。PS回执cases=7、realStorageOperations=0；编译/替身两个子进程结束，一个临时根按身份和父路径核对删除并断言不存在。没有重跑既有8组/20项或旧隔离矩阵，没有实际存储/VM调用。该时间只作检查事实，不作性能优化结论。

本阶段源码/检查摘要如下；第7节摘要继续属于上一阶段，不能回填为本版本：

| 文件 | SHA-256 |
| - | - |
| windows-sandbox-volume.mjs | `65DB77C1792FA96F0E2D0B001D36DBE6BD5264397F27082A9DB74D71FC799553` |
| windows-sandbox-volume-helper.ps1 | `BCBF7EEEB1D1A73BB77CB6F563E519997F354BE3C66FAFAABC3364190E287B7C` |
| windows-sandbox-volume-native.cs | `A01944E8E62F5F34BBBFC685158FBF0D70F40260B81A1B8DAE362D9E977949CC` |
| windows-sandbox-volume-native-acceptance.mjs | `9E0C49B64488693B8CDFAD93E9A424B599C86DA2582760C60E776DBE6919B7F9` |
| windows-sandbox-volume-native-acceptance.test.mjs | `B153AC31E4BD1EDD928663BEDB8F5E5ABA27EE288AAB7FED10DDDDDC2C8CDA2D` |
| windows-sandbox-volume-probe-check.ps1 | `36099F59DEBFA5C41D687936D08ECA6C37ADFD08C1E4C41B8168EF9E610E88B4` |

现场条件经revision218 / turn `01a196a9-e61d-7942-9c96-7d8188098954` 复核通过：九文件精确暂存并确认六份源码与获审摘要一致后，仅调用`node scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs --run-native-volume-once`一次；执行前确认上述源码未变及固定owner可独占，入口重新查询元数据并核对工具摘要，失败即停止，不自动调整权限分配、安装/启用功能、改变路径或重试。管理助手只启用自身令牌上已存在的SeManageVolumePrivilege；其余系统作用限于本任务新建的固定盘附加、初始化、格式化和正常解除附加。发生未知状态时由固定root、助手PID、镜像与回执保留责任，不用kill或手动删根绕过。若实际调用失败，即使正常清理完成，也先记录并交审核，不在同一流程再次创建盘。源码及定向检查结果复核后仅暂存本阶段九文件，现场结果另记；生产、WSB共享准入及P0边界保持。

### 8.1 唯一现场调用：创建前失败，未通过

九文件精确暂存后index为1919条，范围外1910条完整stage摘要保持`136339B1DE1F33B5A7B8936BAB10BA5F1AFF8F25814D8A6441115A9AF429DC64`；六份源码与上表相同。确认固定owner根不存在后仅调用入口一次。task=`72ec5342-2730-4160-8055-74d45a43416f`，startedUtc=`2026-11-01T10:33:40.833Z`，原stdout的finishedUtc=`2026-11-01T10:33:42.252Z`；后者只是该失败报告生成时刻，不是全部物理资源已退出证明。命令最终自然退出1，没有外层强杀或重试。

| 原始回执中的事实 | 值 |
| - | - |
| 实际前置 | PowerShell5.1.26100.9711/x64，Storage2.0.0.0，commands=7，管理员令牌true，SeManageVolumePrivilege存在/Disabled，NTFS可用88,200,200,192字节，门槛168,820,736 |
| 前置 / 编译 | PID29800 / PID13016，均settled、退出0、signal=null、killRequested=false、无stderr；前置stdoutSeen=289，预览被截断不代表原流truncated（该值false） |
| 编译程序集 | 16896字节；SHA-256 `89D8232273B795CC8580593A7E69AB483C5E479BE6070EE8CFC6363D6B3F4D97` |
| 管理助手与阶段 | PID23336，state=blocked，facts/prepared/probe=null，probeAttempted=false，closeUnknown=false |
| 初始报告时刻 | helperClosed=false、pending=true；error=`Unexpected helper stderr`，cleanupError=`Volume still in use or cleanup unknown`；released=false、artifactsRemoved=false |
| 分类标志 | cancelled=true、revoked=true来自unsafe后的内部取消，不是用户主动取消或超时；journalFailed=false、outputBoundFailed=false、sequencePassed=false、passed=false |
| 外部范围 | vmCalls=0、shareAdmission=false、operationErrors=[]、receiptUnknownHandles=[]；没有再次调用入口 |

后续仅只读核对固定root：只有lifecycle.json（3047字节）和volume-native.dll，没有task.vhd、volume-helper.json/next、probe或operation-error文件。日志task ID相符，helperClosed已为true、pending仍为true；精确PID23336查询不存在，主Node也已自然退出。原onClose先保存unsafe快照、再清pending/监听器，导致最终journal保留滞后pending；不能据此声称物理助手仍活动。stderr正文当时未保存，不得猜为构造函数、权限或某个API失败。

revision221 / turn `01a196ad-6f25-7503-b3e1-932be04d6463` 复核确认：唯一Create调用前必须成功持久化creating，当前无该日志且未发生外根递归清理，结合已审构造函数只读，可将阶段判为**助手在VHD创建前失败，未进入创建调用**；不能将本次实测记为通过。允许单独核对任务ID、文件集合、普通文件身份/摘要后，仅删除两个已知产物和空根，任何变化停止，不调用VHD API。清理前lifecycle SHA-256为`9102DE71B9FE83DED60F5BC4886ECD7D1F11857E97957DF5B639E6D080FC5574`，程序集摘要如上；这次单独收尾不能回写成入口正常release成功。下一最小项只补有界stderr证据、真实退出码/信号及清除pending/监听器后的最终快照，先审后做替身，不再运行现场入口。

清理回执：首次清理调用没有报错或输出，但后续只读核对两个文件仍在，不能记为删除成功。随后按精确身份、文件集合和摘要守卫的两文件及空根删除请求被自动审批以`blocked by policy`拒绝，未给出更细原因；没有换工具绕过。用户回复“已删除”后，只读核实固定owner根不存在，记录为**用户手动清理已核实**。revision222 / turn `01a196b6-4f28-78e0-b84d-6c684e21020f` 确认无需再请用户操作；原入口released=false、passed=false和启动根因未知保持，不因此恢复实测。

### 8.2 创建前失败的有界诊断修正

仅修改管理协议、现场报告时间字段及同文件中的两组纯内存检查。每个VolumeProtocol持有1024字节stderr缓冲，保留原始字节的base64、encoding=uninterpreted、观测/捕获字节数和截断标志；计数在Number.MAX_SAFE_INTEGER饱和，不能将截断内容当完整错误。新增缓冲不提高既有8192字节journal/stdout上限。stderr分块回调只拷贝剩余预算和更新标量，首个错误触发阻断；后续块不逐块生成日志、字符串、闭包或Promise。最终close一次转换最多1368字符base64，随后释放原始缓冲。

close记录真实exitCode/signal，先拒绝并清空pending、取消计时、释放行和stderr缓冲、移除六个监听器，再发布宿主unsafe最终快照并完成close等待；不把物理退出等同磁盘释放。TaskVolumeOwner只增加transport观察字段，仍不允许未知责任的release。外层时间字段改为reportedUtc，明确报告可能早于物理close，迟到的最终状态由journal承载。该修正不能追溯恢复第8.1节已丢失的stderr。

两组新增检查以`volume diagnostics`开头，只使用EventEmitter和内存对象：保留非UTF8原始字节、分块合并、退出码23、null退出码/SIGTERM；2065字节输入只捕获1024字节、1368字符base64；最终pending为空、六监听清零、两缓冲释放、撤销/取消各一次、拒绝释放与kill、报告时间字段和8KiB预算。代码先审后仅过滤执行这两组；不重跑原5组、旧8组/20项、剪贴板或其他矩阵，不编译、调用真实助手/磁盘/实例或创建临时目录。当前仍无生产调用链变化，沿用已审热路径契约；本项只记录上述确定性计数及引用释放，不扩跑生产分配基准或据耗时宣称优化。

代码先审revision226 / turn `01a196b9-cf3f-7a62-a4b1-3908acdd635a` 发现两项P2，在任何新检查执行前修正：stderr后的stdout end、stdin/child error也经同一首次失败守卫，不重复发布或反复拒绝；最终close通知保持独立。检查的journal回调只记录快照及发布时监听数量，断言移至回调外，防止被onUnsafe的异常保护吞掉；新增实际stderr→end→两种error事件序列，断言close前一次发布、close后两次，发布时监听数依次6和0。

诊断版本三文件SHA-256（不同于第8.1节唯一现场调用版本，不回填其历史摘要）：

| 文件 | SHA-256 |
| - | - |
| windows-sandbox-volume.mjs | `6E2387386607A0D33ECCD522BCF3F96C4CCD732D30E8A3B95671E2ADE38647BC` |
| windows-sandbox-volume-native-acceptance.mjs | `B107E275AA9BCAF8ED7C7F043C75B469A923FA69D313A5317B82C88578564F2F` |
| windows-sandbox-volume-native-acceptance.test.mjs | `F11B1BCBA0385D2DCBAD30D915C342E16B5C6837C2D6BBA1201694FCCA20CECD` |

revision228 / turn `01a196bc-5032-76f0-891f-7af46a6fefda` 代码复审通过后，仅一次执行`node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern='^volume diagnostics' tests/windows-sandbox-volume-native-acceptance.test.mjs`。实际2组通过，0失败/取消/跳过，进程退出0，报告53.2702ms；该时间不是性能改进证据。原五组和编译/PS替身未执行，没有管理助手、存储API、VHD或VM调用，没有本项临时根或文件产物。两组均核实发布时六监听从6到0、pending清空、缓冲引用释放、撤销/取消各1；stderr超限只保存1024字节及截断标志，没有提高journal或stdout上限。新增诊断检查完成，不改变第8.1节真实失败判定。

当前停止条件：原始stderr正文不可追溯，实际启动失败的具体原因仍未知；有界诊断已准备，但本轮现场授权已使用且明确禁止重跑。下一次具体诊断/恢复范围仍须先交审核，不能直接重启完整入口、改权限、重建盘或重跑旧矩阵。原生GUID及正常释放、固定客户端映射兼容、硬容量拒绝、异常失效与真实候选接线均未证明；生产真实工程、默认切换和权限退役继续关闭，P0桌面回放待办。

最终结果/记录复核revision232 / turn `01a196bf-12db-7703-a7ca-513891936be2` 通过，无需补改或追加测试。三份源码摘要与revision228及上表一致，六文件差异格式无错误，两份独立文档22个本地链接目标存在。本轮六文件已精确暂存：协议、现场入口、定向检查及三份方案/契约/交接文档。暂存前后index均1919条，原九文件范围外1910条完整stage摘要保持`136339B1DE1F33B5A7B8936BAB10BA5F1AFF8F25814D8A6441115A9AF429DC64`；阶段九文件工作副本与index的Git差异为空、暂存空白检查通过。原九份未暂存删除及未跟踪patch保留，不提交、不推送；用户手动清理已核实，后续纯内存项无新增临时产物。

## 9. 管理助手启动失败的单次诊断

用户新授权只获取启动失败证据，不直接重跑完整存储入口或旧矩阵。范围复核revision236 / turn `01a196e4-ec49-7ee1-8f04-1ce169c66fbd` 同意先代码预审，再新增边界检查和一次startup-only。三项产品决定、生产关闭和P0待办保持。

| 证据账本 | 已知事实与本项区分 |
| - | - |
| 已通过的对照 | 原固定PS5前置与C#编译成功、替身检查通过；它们没有执行实际NativeDisk构造，不能当启动正例 |
| 失败 | 第8.1节真实助手在VHD创建前产生stderr，原正文未保存，具体原因未知；不假定权限、构造或加载问题 |
| 已准备的证据能力 | 第8.2节原始stderr有界保留及最终close快照已通过两组纯内存检查，没有恢复旧错误 |
| 本项问题 | 同一助手原参数/程序集/编码/只读构造链究竟在哪一步失败，异常类型、HRESULT及可用原生错误码是什么 |
| 固定边界 | 原C#源码不改；不调用prepare、Storage、权限调整、VHD/WSB，不发送stdin；不扩大目录或提高已有预算 |

实际helper只增加显式StartupDiagnostic分支与诊断回执：依序保留参数校验、程序集校验、Assembly.LoadFile、OutputEncoding及原New-Object NativeDisk调用形式。阶段为arguments、assembly-check、assembly-load、output-encoding、native-constructor、complete，completed单独表示前一步完成。成功在命令循环前exit0；异常在专用catch给出有界回执并保留PowerShell错误记录到stderr后exit1，普通模式仍重新抛出原异常。解析/参数绑定早于正文的失败允许没有回执、阶段未知，不猜成构造失败。

“只读”包括原构造链的父目录属性、宿主卷NTFS/空间及目录身份打开/查询/关闭；不是零文件系统元数据查询。专用入口 [startup.mjs](../scripts/acceptance/windows-sandbox-volume-startup.mjs) 要求`--diagnose-startup-once`，复用固定独占owner根，不抢占已有根。允许固定摘要csc一次编译未变C#，生成DLL不超过128KiB并登记身份/摘要；然后最多一次固定PS5助手，不运行完整PREFLIGHT。编译失败即停止。实际操作前再次核对获审源码/工具及根的归属。

独立传输只分配2048字节stdout和1024字节stderr，稳定分块回调只复制剩余额度和更新标量，物理close时才转换base64、记录退出码/信号/时间并释放缓冲、四监听和child引用。启动回执严格独立schema，失败消息最多256字符，不放宽卷协议。stderr保留原始字节、观测/捕获量和截断；专用回执最多2KiB，整个journal最多8KiB；stdout证据行最多7680字节，加最多512字节清理尾行，总计不超过8KiB。阶段错误与最终物理退出明确区分。

助手只有15秒逻辑等待；超时、取消或journal失败永久保留owner，不kill、自动重试或在迟到close后自行清理。迟到close只更新证据；编译器仍用已有仅针对编译进程的超时/取消收尾。证据须先写有界journal并成功交付stdout，才允许清理；清理按根dev/ino/realpath、精确文件集合、每文件dev/ino/长度/摘要核对，只unlink已登记叶子再rmdir空根，不递归删除。额外文件、重解析、身份变化、未知关闭或证据写入失败均保留责任；启动成功与清理成功分别报告。

新增 [定向检查](../tests/windows-sandbox-volume-startup.test.mjs) 限定四组内存检查及一组 [PS5 parse-only AST](../tests/fixtures/windows-sandbox-volume-startup-parse.ps1)：schema/阶段关联及整体预算、原始字节截断/close释放、超时/取消/日志失败和迟到close、精确清理门槛；AST只解析实际helper，检查成功/失败诊断出口早于命令循环和存储调用。解析子进程独立记录，不称为纯内存检查；无编译/构造/Storage/VHD。代码先审再运行，原检查不重复。新增传输不进入生产输出/进度链，复用既有低频wait，不引入对象池或逐块Promise/字符串；确定性容量、监听/缓冲释放作为本项性能证据。

如果startup-only成功，只能记录“本次启动阶段未复现”，不能恢复旧stderr、宣称旧根因已明或自动继续prepare；如失败，先按具体阶段/异常复核，一次诊断后均停止重试，后续修复或更深阶段另审。

代码预审revision239 / turn `01a196ec-fc59-7022-89ff-81493d2e016b` 提出两项P2，在执行任何新增检查前修正：专用StartupOutput以稳定error监听统一处理写回调/流error，首个失败锁定并阻断清理；清理尾行失败保留已发生的artifactsRemoved事实，不重建已删除journal或假称目录仍在。StartupLifetime用持续on监听幂等取消，最多跟踪编译器及启动助手两个调用；逻辑超时/日志失败后，直到两个调用都物理关闭、输出无pending，才在下一次事件循环移除信号和输出error观察器并清空调用引用。迟到close先记录再释放观察责任。五组检查数量不变，补入回调错误、流error、尾行失败，以及超时后重复取消、两个迟到close和最终监听释放断言。

复审revision242 / turn `01a196f1-80d7-7121-9132-3de3c6e430cd` 再指出两个细节，仍在任何检查前修正：流error只逻辑拒绝，不清写入pending，直到实际write回调返回才通知lifetime释放；同步write抛出由无提交分支清理。产物已清理后的取消忽略，不再abort或保存到已删除根，也不改变已结束任务的cancelled/retained。补入error先到、write回调迟到，以及清理完成但尾行仍pending时重复取消的内存断言，保持五组范围。

### 9.1 代码复审与唯一新增检查

最终代码与断言复核revision246 / turn `01a196f4-6c49-7883-9393-521eb249c87c` 通过，只放行一次新增文件。核对检查摘要后执行`node --test --test-reporter=tap --test-concurrency=1 tests/windows-sandbox-volume-startup.test.mjs`：5组通过，0失败/取消/跳过，进程退出0，报告358.1055ms。其中PS5 parse-only为PID31976、退出0、signal=null、helperExecuted=false、storageCalls=0；解析两条诊断退出路径，不执行helper正文或原生构造。其余四组纯内存；没有编译、真实诊断、临时目录/文件或旧矩阵重跑。时长不作优化证据。

实际断言覆盖原始stderr1502字节只保留1024字节/1368字符base64，stdout2050只保留2048且标截断；close后四监听、两个缓冲及child引用清空。超时及journal失败后迟到关闭不会释放保留的owner；重复取消只处理一次，编译/助手全部关闭且实际输出回调完成后，两个信号监听及输出error监听归零、calls引用归零。输出回调错误/流error/清理尾行失败和精确文件集合/身份拒绝均取得证据。

| 本次获审文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-helper.ps1 | `66BEC514B077499A20AC699B8B0EF67A4FBBA65DCA3FE0592E2E7045B2452CAC` |
| windows-sandbox-volume-startup.mjs | `8F01774689F9BB3339A9838298B87C4EEBEF8D70291167F1974F5BA454F88883` |
| windows-sandbox-volume-startup.test.mjs | `58616D89FF7A22641D63189EB18518DE3C06814BB1CEBD5E25AA789928A9F18C` |
| windows-sandbox-volume-startup-parse.ps1 | `24722F1956920CAE2176F4C5B26887A5CAE8AEF194A32D9AEBF015DB7DB19AB2` |

未改的NativeDisk源码仍为`A01944E8E62F5F34BBBFC685158FBF0D70F40260B81A1B8DAE362D9E977949CC`，入口硬编码核对该摘要；固定PS5/csc摘要沿用第8节，不增加环境查询。此时仅新增检查完成，实际一次编译及startup-only须结果/执行条件复核，未知或失败不得续跑完整入口。

结果/执行条件复核revision248 / turn `01a196f6-5c8b-7c71-8f73-a7e16a207153` 通过。精确暂存本项七文件并紧邻核对四份获审源码、未变C#及固定owner根不存在后，允许唯一一次`node scripts/acceptance/windows-sandbox-volume-startup.mjs --diagnose-startup-once`，最多一次编译和一次PS5启动；无论成功失败都停止后续调用、记录交复核。本项暂存前index1919条，排除七文件后范围外1915条完整stage摘要为`B1759DF7EC47D7F4A4752223EC4B8BB686F8FFDC2D9552E25F3144DDED836B37`；加入三个新文件后预期1922条，范围外必须保持一致。不追加环境枚举、权限调整、完整存储入口、修复或第二次诊断。

### 9.2 唯一实际诊断：程序集校验时命令不可用

七文件精确暂存后index1922条，范围外1915条摘要与第9.1节相同，工作副本与index一致。紧邻执行核对四源码及未变C#摘要、固定owner根不存在后，仅调用诊断入口一次。task=`7b03cdef-4aa7-4429-88da-d2e08ee2bc19`，startedUtc=`2026-11-01T11:56:34.051Z`，助手closedUtc=`2026-11-01T11:56:34.702Z`，reportedUtc=`2026-11-01T11:56:34.713Z`。主入口自然退出1，工具wall=0.8754314秒；无外层强杀或重试，耗时不作性能优化证据。

| 实际观察 | 结果 |
| - | - |
| 编译准备 | PID30056，settled、退出0、signal=null、killRequested=false；stdout/stderr均0，无截断 |
| 本次DLL | 16896字节，SHA-256 `B01C8B0BD05C619D1FD191C648FE798B9312CE29CE11E5111BB5DC558E12B08B`；这是本次编译产物，不要求与上次DLL二进制摘要相同 |
| 启动助手 | PID33408，settled、退出1、signal=null、launchError=null，物理close已观察，buffersReleased=true |
| 回执阶段 | ok=false，step=assembly-check，completed=arguments；尚未到Assembly.LoadFile、OutputEncoding、NativeDisk构造或命令循环 |
| 直接失败 | System.Management.Automation.CommandNotFoundException，HRESULT=-2146233087，nativeCode=null；本次PS5进程无法识别Get-FileHash命令 |
| 流证据 | stdoutSeen=stdoutCaptured=498，stderrSeen=stderrCaptured=413；两流均未截断，receiptError=null；stderr仍按uninterpreted原始字节保留 |
| 外层与边界 | cancelled=false、journalFailed=false、outputFailed=false；storageCommandsSent=0、vmCalls=0、shareAdmission=false；没有权限调整、Storage或VHD调用 |
| 清理结果 | 成功交付证据行后，尾行artifactsRemoved=true、retained=false、startupSucceeded=false、cleanupError=null；随后只读确认固定owner根不存在 |

结构化错误消息原文：`无法将“Get-FileHash”项识别为 cmdlet、函数、脚本文件或可运行程序的名称。请检查名称的拼写，如果包括路径，请确保路径正确，然后再试一次。` messageTruncated=false。该消息来自明确UTF-8启动回执，不通过猜测stderr编码获取。

完整498字节stdout的base64如下（回执按代码明确使用UTF-8写出，包含末尾换行）：

```text
eyJwcm90b2NvbCI6InN1cGVyLXBpLXZvbHVtZS1zdGFydHVwLXYxIiwidGFza0lkIjoiN2IwM2NkZWYtNGFhNy00NDI5LTg4ZGEtZDJlMDhlZTJiYzE5Iiwib2siOmZhbHNlLCJzdGVwIjoiYXNzZW1ibHktY2hlY2siLCJjb21wbGV0ZWQiOiJhcmd1bWVudHMiLCJlcnJvciI6eyJleGNlcHRpb24iOiJTeXN0ZW0uTWFuYWdlbWVudC5BdXRvbWF0aW9uLkNvbW1hbmROb3RGb3VuZEV4Y2VwdGlvbiIsImhyZXN1bHQiOi0yMTQ2MjMzMDg3LCJuYXRpdmVDb2RlIjpudWxsLCJtZXNzYWdlIjoi5peg5rOV5bCG4oCcR2V0LUZpbGVIYXNo4oCd6aG56K+G5Yir5Li6IGNtZGxldOOAgeWHveaVsOOAgeiEmuacrOaWh+S7tuaIluWPr+i/kOihjOeoi+W6j+eahOWQjeensOOAguivt+ajgOafpeWQjeensOeahOaLvOWGme+8jOWmguaenOWMheaLrOi3r+W+hO+8jOivt+ehruS/nei3r+W+hOato+ehru+8jOeEtuWQjuWGjeivleS4gOasoeOAgiIsIm1lc3NhZ2VUcnVuY2F0ZWQiOmZhbHNlfX0K
```

完整413字节stderr的base64如下（没有推定其文本编码）：

```text
RDpcUk1Qcm9qZWN0c1xQaVxzY3JpcHRzXGFjY2VwdGFuY2Vcd2luZG93cy1zYW5kYm94LXZvbHVtZS1oZWxwZXIucHMxIDogzt63qL2robBHZXQtRmlsZUhhc2ihsc/uyrax8M6qIGNtZGxldKGiuq/K/aGivcWxvs7EDQq8/rvyv8nUy9DQs8zQ8rXEw/uzxqGjx+u87LLpw/uzxrXExrTQtKOsyOe5+7D8wKjCt762o6zH68i3saPCt7621f3It6OsyLu689TZytTSu7TOoaMNCiAgICArIENhdGVnb3J5SW5mbyAgICAgICAgICA6IE9iamVjdE5vdEZvdW5kOiAoR2V0LUZpbGVIYXNoOlN0cmluZykgW1dyaXRlLUVycm9yXSwgQ29tbWFuZE5vdEZvdW5kRXhjZXB0aW9uDQogICAgKyBGdWxseVF1YWxpZmllZEVycm9ySWQgOiBDb21tYW5kTm90Rm91bmRFeGNlcHRpb24sd2luZG93cy1zYW5kYm94LXZvbHVtZS1oZWxwZXIucHMxDQogDQo=
```

证据行记录的精确归属：root dev=`3938676073`、ino=`2533274791599825`；lifecycle.json ino=`3096224745021194`、3688字节、SHA-256 `82B29ADE7F3AC20279968F93C160B756584033F669C28E8F77364A2C397EB424`；DLL ino=`2251799814889227`、同一dev、长度与摘要见上表。只有这两个登记文件，按身份逐文件删除后rmdir空根，没有递归或另行手动清理。证据行是在交付和清理前序列化，因此其中evidenceEmitted=false/artifactsRemoved=false是当时快照，最终清理以随后startup-cleanup尾行及根不存在核对为准。外层error=null仅表示采集链未抛错，不覆盖助手退出1和startupSucceeded=false。

本次已定位的直接原因仅为**该固定PS5启动上下文中的Get-FileHash命令不可用**；模块搜索路径、自动加载或其他环境机制尚未核查，不能编造解释，也不能回填第8.1节已丢失的旧stderr。接下来可先静态预审消除该隐式cmdlet依赖的最小摘要校验方案，保持DLL大小/身份、完整SHA-256、流关闭及失败拒绝判据；本轮没有实施修复或再执行诊断。该诊断仍为显式手动门控，不接生产。原生GUID/正常释放、共享硬容量与真实工程适配未通过；生产默认/接入和权限退役关闭，P0桌面回放待办。

最终记录复核revision252 / turn `01a196fa-7c80-7062-b396-dc7f87d51da8` 通过，无遗漏，无需追加诊断或测试。独立核对两段原始base64的498/413字节、严格UTF-8回执关联及阶段/异常/消息，四源码摘要保持获审版本；本项两独立文档26个本地链接及差异格式检查通过。代码/检查及首次记录先前已按七文件精确暂存，最终仅补暂存三文档记录；index1922条，七文件范围外1915条完整stage摘要保持`B1759DF7EC47D7F4A4752223EC4B8BB686F8FFDC2D9552E25F3144DDED836B37`。保留原九份未暂存删除和未跟踪patch，不提交、不推送。本项编译、诊断及自有文件已收尾，无新增遗留；下一项只先静态审查最小摘要校验替换，不自动执行。

## 10. 用户指定宿主仅使用 PowerShell 7

用户明确指令：“马上立刻改回pw 7，本机只用pw 7，且路径明确，不需要回退 5”。此前固定PS5是主任务自行选择，用户未要求；现撤回沿PS5替换Get-FileHash算法的推进建议，也不把本机PS7视为异常环境。第8–9节原始观测保留为PS5历史证据，不能作为PS7验收结论。当前宿主唯一路径为`D:\PowerShell\7\pwsh.exe`，只读解析版本7.6.9，SHA-256为`2A6769A3330DC1084D0154BFDE7D164AB750CA7F700F313F9D417C1BE78B2233`；不搜索候选路径或回退5。

范围复核revision254 / turn `01a19702-a9f6-7ef0-bcde-f690dec2c702` 确认：三宿主入口（管理助手启动、原生前置、startup诊断）及三个原检查启动点统一使用volume.mjs导出的固定路径和共用参数；helper、preflight和三个PS夹具明确要求major7/Core/x64。旧来宾固定任务的C盘PowerShell路径是来宾环境，不替换成宿主D盘路径。Get-FileHash校验算法、原生C#、取消/所有权/容量预算均不改。

新仓库配置 [powershell7.config.json](../scripts/acceptance/windows-sandbox-powershell7.config.json) 完整保留本机基线中的`Microsoft.PowerShell:ExecutionPolicy=RemoteSigned`及`WindowsPowerShellCompatibilityModuleDenyList=[PSScheduledJob,BestPractices,UpdateServices]`，仅增加`DisableImplicitWinCompat=true`；当前187字节，上限256字节，固定摘要`7AD7607ADF83F5DF57F786D85911FACEF02103F42D3F6B5E1EE1FDE2B8778E51`。共用校验同时固定原`D:\PowerShell\7\powershell.config.json`摘要`98C0E5B6EE17EB8B8F4E4940C2B2528689CEC8470DB4BDE427AD16D90D6A52D4`，基线读取上限4096字节；变化即停止，不自动接受新基线。宿主启动路径核对exe和两份配置，再在-File/-EncodedCommand之前显式传入-SettingsFile；不改机器或用户的全局配置、不增加执行策略命令行参数。微软明确说明隐式模块导入可能创建后台PS5，且支持专用SettingsFile禁止该行为；配置加源码中排除显式UseWindowsPowerShell共同落实无回退。[微软兼容模式文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_windows_powershell_compatibility?view=powershell-7.6)

正常助手（startup-only出口之后）及原生前置显式`Import-Module Storage -SkipEditionCheck -ErrorAction Stop`，导入失败直接停止；该参数只允许在当前Core进程尝试加载，不证明模块调用兼容，更不批准PS5兼容代理。[微软Import-Module文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/import-module?view=powershell-7.6#-skipeditioncheck)

新增 [两组最小检查](../tests/windows-sandbox-powershell7.test.mjs) 为一组纯源码边界和一组“编译一次未变C#＋单个固定PS7兼容进程”。[兼容夹具](../tests/fixtures/windows-sandbox-powershell7-check.ps1) 验证实际运行时/路径、Get-FileHash对已知DLL的完整摘要、程序集加载/类型/ABI（56字节及8/24偏移）、helper/preflight解析、Storage原生导入实际路径/版本和七项命令参数、会话/兼容代理均为零；不构造NativeDisk或调用磁盘查询/修改命令。只有一个任务临时根，两个文件按根和文件身份/摘要逐叶删除再移除空根。旧矩阵、管理助手startup与完整存储入口均不运行。

性能范围只增加低频启动路径的固定exe/小型配置校验及一次启动参数组合；数据分块、进度、生产调用链没有修改，不引入对象池。此项兼容检查只用于确认选定PS7的必要能力，不能替代原生盘、硬容量或真实工程验收；生产接入、默认切换及权限退役关闭，P0桌面回放继续待办。

### 10.1 首次兼容检查失败及配置保留修正

代码复审revision256 / turn `01a19705-8b32-7573-8523-9bf020f65a07` 通过后，首次仅运行新增两组检查：源码边界通过，兼容组在PS7夹具正文运行前因SecurityError/脚本执行策略拒绝而失败，1通过、1失败、0取消/跳过、入口退出1，报告529.7691ms。C#编译退出0；PS7子进程退出1，首次诊断位于断言之后，没有保留两个PID。stderr当时按UTF-8解码出现乱码，原始字节未保留，不重新编码冒充原始证据。清理回执temporaryRootRemoved=true、ownedFiles=2；未运行夹具正文、Storage导入、实际助手或原生构造。该失败保留，不以修正后的结果回填首次通过。

首次专用配置仅含DisableImplicitWinCompat（33字节，SHA-256 `02A0C0160B9192CAC54FE11E61EDE47EC0E70127ED85A4693FCDE48A28BCF788`），错误地未保留基线原值。revision259/260 / turn `01a19709-13e0-7751-841d-94808b5a2c81` 同意两次只读内联核对，未执行ps1、编译或Storage。默认固定PS7的PID28940退出0，版本7.6.9，有效策略及LocalMachine为RemoteSigned，其余四scope均Undefined；基线恰含上文两键。携带旧专用配置的查询退出1，加载Microsoft.PowerShell.Security的Security.types.ps1xml时AuthorizationManager检查失败，没有取得有效策略值，不能写成实测Restricted。SettingsFile替代全局配置导致遗漏原策略的修正依据与微软配置说明一致；不通过Bypass、Unrestricted、Set-ExecutionPolicy或Unblock-File消除错误。[微软配置文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_config?view=powershell-7.6)

修正仅完整保留基线两键、增加禁止兼容项，并固定两配置摘要。新检查核对精确三键，夹具实际断言有效RemoteSigned；子进程在断言前记录PID、退出码、信号、启动错误和字节数量，stderr从Buffer保留前1024原始字节、最多1368字符base64，标记截断。每次调用maxBuffer仍8192，源码/配置检查及兼容组之外不扩测；宿主journal、流预算和生产热路径均未改变。具体修正先交代码复审，之后才恢复新增两组各一次（原DLL已清理，需一次新编译和一个固定PS7进程），不得恢复实际助手或完整存储入口；执行结果见10.2–10.3。

### 10.2 配置修正后一次检查：夹具类型重载失败

revision262 / turn `01a1970e-2c71-7e81-a781-63973c75d20d` 代码复审通过，紧邻执行核对四份获审源码摘要后，新增两组各执行一次。源码组通过，兼容组在夹具第11行`Marshal.SizeOf($type)`失败；1通过/1失败/0取消/跳过，入口退出1，总696.2182ms。编译PID31500退出0，signal/error均null，两流0字节；PS7 PID30320退出1，signal/error均null，stdout0、stderr428字节，完整保留、未截断。temporaryRootRemoved=true、ownedFiles=2，编译及检查子进程均已返回，未留本项产物。

根据夹具顺序，PS7固定路径/版本守卫、实际RemoteSigned断言、Get-FileHash匹配及Assembly.LoadFile已完成；随后SizeOf错误指明`System.RuntimeType`不能作为非托管结构封送。尚未取得ABI/OffsetOf、AST或Storage导入结果，不将此解释成原生磁盘或Storage不兼容。该失败是在PS7中调用重载方法的检查代码问题；最小修正仅用`GetMethod('SizeOf',[type[]]@([type]))`选中SizeOf(Type)，再Invoke同一类型对象，保持56字节及8/24偏移判据。修正先复审，只允许对原失败兼容组一次恢复，不重跑已通过源码组、实际助手或旧矩阵。

本次完整stderr原始base64（不推定文本编码）：

```text
UGFyZW50Q29udGFpbnNFcnJvclJlY29yZEV4Y2VwdGlvbjogRDpcUk1Qcm9qZWN0c1xQaVx0ZXN0c1xmaXh0dXJlc1x3aW5kb3dzLXNhbmRib3gtcG93ZXJzaGVsbDctY2hlY2sucHMxOjExDQpMaW5lIHwNCiAgMTEgfCAgJHNpemU9W1J1bnRpbWUuSW50ZXJvcFNlcnZpY2VzLk1hcnNoYWxdOjpTaXplT2YoJHR5cGUpDQogICAgIHwgIH5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fg0KICAgICB8ILX308OhsFNpemVPZqGxsqK0q8jrobAxobG49rLOyv3KsbeiyfrS7LOjo7qhsFR5cGUgJ1N5c3RlbS5SdW50aW1lVHlwZScgY2Fubm90IGJlIG1hcnNoYWxlZCBhcyBhbiB1bm1hbmFnZWQgc3RydWN0dXJlOyBubyBtZWFuaW5nZnVsDQogICAgIHwgc2l6ZSBvciBvZmZzZXQgY2FuIGJlIGNvbXB1dGVkLqGxDQo=
```

### 10.3 失败兼容组的最小恢复通过

revision263 / turn `01a19710-62f9-7041-91d3-ab5c05f3401c` 两行修正复审通过，紧邻核对夹具SHA-256 `C7D3418C322090681C393EF682264B5770419A239F9DE6F3687D2AC12D570EA3` 后，仅一次执行`node --test --test-reporter=tap --test-concurrency=1 --test-name-pattern="^PowerShell 7 loads the unchanged native type," tests/windows-sandbox-powershell7.test.mjs`。实际1组通过，0失败/取消/跳过，入口退出0，报告2006.8012ms。已通过源码组被名称过滤、未执行，旧矩阵和实际助手未运行；前两次失败继续保留，时长不作性能优化证据。

| 本次观察 | 结果 |
| - | - |
| 编译 | 固定csc，PID31992、退出0、signal/error均null；stdout/stderr均0 |
| 固定PS7 | PID20540、退出0、signal/error均null；stdout462、stderr0、无截断 |
| 运行时和策略 | `D:\PowerShell\7\pwsh.exe`、7.6.9/Core/x64；有效RemoteSigned，与宿主基线一致 |
| 原生程序集 | Get-FileHash完整匹配、加载成功；CreateParameters大小56，UniqueId偏移8、MaximumSize偏移24；没有构造NativeDisk |
| 实际脚本 | helper及preflight两份AST解析/守卫检查完成，不执行其正文 |
| Storage | 当前PS7进程实际导入2.0.0.0，实际路径`C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules\Storage\Storage.psd1`；七命令及所需参数元数据确认 |
| 无回退 | 兼容会话0、代理模块0；固定配置禁止隐式兼容，源码没有显式PS5入口 |
| 操作边界 | storageCalls=0、nativeConstructed=false；没有磁盘命令、管理助手、VHD或VM |
| 清理 | 两个已登记文件及临时根按身份/摘要核对后删除，temporaryRootRemoved=true、ownedFiles=2 |

至此两个新增检查各自取得通过；本项累计三个兼容尝试、三次编译，每次两个文件和独占临时根均清理。两次只读策略查询另行记录于10.1，没有旧矩阵或存储恢复。原PS5根因不再驱动当前实现，Get-FileHash和原生C#不替换；下一项只可先审固定PS7的实际startup-only条件，本次不因兼容通过自动启动助手或完整存储。

| 本轮最终源码 | SHA-256 |
| - | - |
| `scripts/acceptance/windows-sandbox-volume.mjs` | `7988A536C16FC4701B354D0AC050707615383B3DF141AB49B930FB20753EA501` |
| `scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs` | `903015AE79186DF18E2083A1BF06C3D8798AB9342042240125A1676383ACAFFD` |
| `scripts/acceptance/windows-sandbox-volume-startup.mjs` | `05CBCE5B47BFC688C4CC0AE768FEBBAA36334099D67078E9DFAB3D2EC74FC2AD` |
| `scripts/acceptance/windows-sandbox-volume-helper.ps1` | `D9643A897113AFF1F38898312B0DB69AD46E95F854C4128EBA739411EDBC461B` |
| `scripts/acceptance/windows-sandbox-powershell7.config.json` | `7AD7607ADF83F5DF57F786D85911FACEF02103F42D3F6B5E1EE1FDE2B8778E51` |
| `tests/windows-sandbox-volume.test.mjs` | `A80A11561469537B932C1D1F587510E0AC78A2DA891CE7EA6FBC115C64B6ABF9` |
| `tests/windows-sandbox-volume-native-acceptance.test.mjs` | `8469CC5817CFB77155A743EF18AF9D7F0D5699B5A2AC19CAE756A83034B11361` |
| `tests/windows-sandbox-volume-startup.test.mjs` | `BA30E199043146EFA3D5F3716B434BED9DE8C189A801E472C1649FBBDC982246` |
| `tests/fixtures/windows-sandbox-volume-helper-check.ps1` | `ECF3E94CDEC4491F4A29A95BCFECA6ED0B69BE985AEA4916CB23CBE2C84126FD` |
| `tests/fixtures/windows-sandbox-volume-probe-check.ps1` | `F02068CF3E972E475AD51C26550B193087038C0E0A038DB79CA1B4E5BCE121AF` |
| `tests/fixtures/windows-sandbox-volume-startup-parse.ps1` | `A52D9F4C5D1414805DD24CE9579D7FEAECCCAB248A45F510D4F6DB64F6141B95` |
| `tests/windows-sandbox-powershell7.test.mjs` | `CE1779EF869F8CD1CB0AFCAF57B80EB71E017C06624FD109CC3B38D9B7748635` |
| `tests/fixtures/windows-sandbox-powershell7-check.ps1` | `C7D3418C322090681C393EF682264B5770419A239F9DE6F3687D2AC12D570EA3` |

最终代码/结果/记录只读复核revision268 / turn `01a19712-c565-76d2-9669-76940993c061` 通过，无需补改或追加执行。十三份源码摘要与上表一致，两独立文档30个本地链接目标存在，差异格式检查通过。本项精确暂存上述十三源码/配置/检查及三份方案，共16文件；index从1922增至1925条，范围外1909条stage记录的JSON数组UTF-8 SHA-256保持`E399071F02C52F88EBEF182C77F040FAC641984BDFEC12A03DA11E48B2243F53`，本项工作副本与index的Git差异为空。原九份未暂存删除和未跟踪patch保留，不提交、不推送；本项进程与产物清理已确认，不再补跑。后续startup或完整存储没有因本次兼容通过而放行；生产接入、默认切换及权限退役关闭，P0桌面回放继续待办。


## 11. 固定PS7实际助手启动通过

用户新授权“按照顺序依次执行，审查，核对”。沿用第10节已获审代码，不改源码或重复测试；范围/代码复核revision271 / turn `01a19723-15e3-7813-bbdd-5aab2d4cdef7` 允许一次同一startup-only。执行前核对13份获审源码、未变C#、固定PS7/csc及基线/专用配置摘要，确认固定owner根不存在。新一项开始index1925条，原九份删除及未跟踪patch保留；三文档以外1922条stage记录JSON数组UTF-8 SHA-256为`1AD3ABD599F1C9A6B47E67138D33160433EC823ED1930290991A1696A3B77CFB`。

唯一调用`node scripts/acceptance/windows-sandbox-volume-startup.mjs --diagnose-startup-once`正常退出0，工具wall=0.7848314秒，不作为优化结论。task=`8de4ea6a-4a57-43f5-8f8d-9bdf9ae7d25c`，startedUtc=`2026-11-01T12:45:15.865Z`，助手closedUtc=`2026-11-01T12:45:16.391Z`，reportedUtc=`2026-11-01T12:45:16.400Z`。

| 观察 | 本次结果 |
| - | - |
| 编译 | PID26152，settled、退出0、signal/launchError=null、killRequested=false，两流0 |
| 实际助手 | PID30492，settled、退出0、signal/launchError=null；固定PS7路径与配置 |
| 回执 | ok=true、step=complete、completed=native-constructor、error=null；实际经过原New-Object构造、父目录/NTFS/空间/目录身份只读链 |
| 流与释放 | stdout164字节全部捕获，stderr0，无截断；buffersReleased=true、receiptError=null |
| 宿主状态 | startupSucceeded=true；cancelled/journalFailed/outputFailed均false，error/cleanupError=null |
| 执行范围 | storageCommandsSent=0、vmCalls=0、shareAdmission=false；不发送stdin、不导入Storage、不调整权限、不创建VHD |
| 清理尾行 | artifactsRemoved=true、retained=false、startupSucceeded=true；随后只读核对固定根不存在 |

完整164字节UTF-8回执原始base64：

```text
eyJwcm90b2NvbCI6InN1cGVyLXBpLXZvbHVtZS1zdGFydHVwLXYxIiwidGFza0lkIjoiOGRlNGVhNmEtNGE1Ny00M2Y1LThmOGQtOWJkZjlhZTdkMjVjIiwib2siOnRydWUsInN0ZXAiOiJjb21wbGV0ZSIsImNvbXBsZXRlZCI6Im5hdGl2ZS1jb25zdHJ1Y3RvciIsImVycm9yIjpudWxsfQo=
```

清理前归属快照：根dev=`3938676073`、ino=`2251799814889310`；lifecycle.json ino=`2814749768310624`、2308字节、SHA-256 `2D33DE884481EFB29895AFFA5A26B5AE34C562A8DF5C0DAD22F344BAB58594C6`；DLL ino=`2251799814889324`、16896字节、SHA-256 `B30101EB27ED17C07AD2206120072C97585B0824E74418F8EB44E11E5F261FE9`，两文件同根dev。证据行的evidenceEmitted/artifactsRemoved=false是交付/清理前序列化值，最终以随后cleanup尾行及根不存在为准。仅按两叶登记身份删除再rmdir空根，没有递归、强杀或遗留。

结论限定于本次PS7实际启动和只读构造链通过，不回填历史PS5失败，也不代表真实VHD生命周期、WSB路径/硬容量或工程接入通过。下一项为已实现的原生单盘prepare→verify→32字节probe→release→exit，须先审核具体PS7前置/归属/清理条件；当前不执行该项或旧矩阵。生产、默认切换和权限退役保持门槛，P0桌面回放待办。

结果/文档最终复核revision276 / turn `01a19725-7d2b-7c01-a1fe-1f425117b732` 通过；本项仅三文档精确暂存，index1925条，范围外1922条stage JSON数组UTF-8摘要保持`1AD3ABD599F1C9A6B47E67138D33160433EC823ED1930290991A1696A3B77CFB`，工作副本与index一致，31个本地链接及差异格式核对通过。原九份删除和patch保留，不提交推送。下一原生单盘入口暂不执行：先修复证据输出确认前删根、以及一次性/过早移除取消监听这两项P2，完成最小代码/替身审查后再复核实际条件。已通过startup不重跑，生产与P0边界保持。


## 12. 原生单盘入口的输出交付与取消寿命修正

第11节实际启动完成后，revision276只读审查发现两个P2，真实单盘尚未执行：原finishNativeAcceptance先删归属根再无回调写stdout，输出失败会丢失记录；入口使用once信号监听并在物理助手可能仍活动时移除，重复取消会失去归属保护。问题有明确代码依据，不通过重跑磁盘流程取证。

本项只调整宿主手动验收入口：有界主证据先交付并确认write回调，再按原已验证归属清理，最后输出清理尾行；主证据含换行最多7680字节，尾行最多512字节，总8KiB不变。首行passed=false、artifactsRemoved=false是清理前事实，最终passed以尾行和返回记录为准。输出错误首次锁定、保留责任；流error不冒充实际写回调完成；清理完成后的尾行错误保留artifactsRemoved事实，不重建已删journal。

NativeLifetime最多跟踪前置、编译、管理助手三个实际调用；信号使用稳定on监听，取消幂等。所有物理调用关闭且写回调完成后才在下一事件循环释放信号/输出错误观察及调用引用；迟到close只补physicalCalls及归属记录，不重新释放盘、清根或恢复下一任务。VolumeProtocol新增一次settled通知，顺序在原pending、六个子进程监听、字节缓冲和unsafe回执处理之后，并释放child引用、单独保留pid；没有新增轮询或终止管理助手。

已重读热路径分配契约，完整检查手动入口→CapturedProcess/OwnedHelperRunner、VolumeProtocol→TaskVolumeOwner→完成输出/资源释放链。该链仍无生产调用者，仅固定生命周期操作；新增回调均为实例稳定字段，输出最多两次、pending最多1、calls最多3；没有逐字节/分块/生产进度分配变化，无对象池。此项不修改C#、PowerShell存储脚本、磁盘容量、共享准入或真实工程。

新增[完成收尾检查](../tests/windows-sandbox-volume-completion.test.mjs)计划只运行四组纯内存：证据/清理/尾行先后；回调错误、流error迟到回调、同步throw、尾行失败四分支；三个调用迟到关闭、重复取消、无重清理和缓冲/引用/监听释放。原native检查只适配并运行一个受影响的outer journal failure用例，验证证据阶段不删根/不宣告passed及原有journal/预算拒绝。先代码复审后执行，不运行编译、PowerShell、真实助手或旧矩阵。完成后再审核原生单盘实际条件。

代码复审期间revision278指出：物理close若发生在证据或尾行写回调仍pending、但收尾函数尚未返回时，旧finished判据遗漏持久化。已在执行任何新检查前改为beginCompletion开始即观察；迟到close在completing期间保存有界physicalCalls，只在artifactsRemoved=false时写记录。第四组纯内存分别覆盖首证据/尾行pending窗口，直接核对持久化关闭状态，仍不恢复操作或清理。


### 12.1 定向检查通过

最终代码复审revision280 / turn `01a19731-9894-7750-9d43-d957247dbebe` 通过后，仅一次运行新四组与原受影响一组的名称过滤命令。实际5组通过，0失败/取消/跳过，入口退出0，总106.6841ms；耗时不作优化证据。原其他用例、编译、PS验证助手及存储/VM未执行，无新增磁盘文件/临时根或本项待退出助手。

实际计数：最多2次输出、1个pending写入；四种输出故障均无重试，清理完成后保存次数0；3个已启动调用、取消回调1次、迟到清理0次；证据/尾行pending两个时点都保存了实际关闭；最终子进程六监听、信号/error观察、calls引用、输出pending及持有stream/report引用均释放。原journal失败、报告预算、未关闭助手及未知读取句柄门槛仍拒绝清理。测试仅用替身调用移除钩子，没有真实磁盘/文件系统操作。

| 本项获审源码/检查 | SHA-256 |
| - | - |
| `scripts/acceptance/windows-sandbox-volume.mjs` | `50BEF18A1AF35B4803B91B672985B056F16C680644F8FE8FE54F76CD2F0826D6` |
| `scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs` | `E4A269C0D347A9E7CF3A6C5B10C61F938862CEE96939EEFBD789914E10E758B3` |
| `tests/windows-sandbox-volume-native-acceptance.test.mjs` | `950BA9195552142EDB4F2A7217A727EC0DC29D3E11B6465F15F5BA7450E7C1EA` |
| `tests/windows-sandbox-volume-completion.test.mjs` | `35C0B5D444D356D0A82E17666F7A5B875133542D61DD1FD1E5B50A55E47723AF` |

本项范围为上述4文件加3文档，共7文件；暂存前index1925条，排除本项后1919条stage JSON数组UTF-8 SHA-256为`C67D0D511BA560F4F065AFE65A60A38047DF72030660C50BAB111214EF8FE99F`。新增检查文件后预期index1926，范围外摘要不得变化。结果复核/记录/精确暂存完成后，另按具体条件审原生单盘一次调用，不因纯内存通过直接执行。

最终结果/记录复核revision282 / turn `01a19733-ec5c-7bf1-8203-a167f41d329d` 通过，本项7文件精确暂存，index1926条，范围外1919条stage JSON数组UTF-8摘要保持`C67D0D511BA560F4F065AFE65A60A38047DF72030660C50BAB111214EF8FE99F`；工作副本与index一致，33个本地链接及差异格式核对通过，原九份删除/patch保留。审核确认紧邻核对源码、工具/两配置和独占根不存在后，可以唯一一次运行固定PS7原生单盘入口；范围只含既有只读前置、一次编译/单助手、128MiB本任务盘及prepare→verify→32字节probe→release→exit。未知或失败保留责任，不自动重试/kill，不WSB、共享、灌写或真实工程。该放行不是现场通过证据，实际结果另记。


## 13. 一次原生单盘：创建后记录未推进，保留责任

revision282允许本次调用后，7文件精确暂存并核对index1926/范围外1919摘要。紧邻执行再次核对获审源码、未变C#、固定PS7/csc与两份配置、工作副本与index一致以及独占根不存在，仅一次运行`node scripts/acceptance/windows-sandbox-volume-native-acceptance.mjs --run-native-volume-once`。没有第二次创建、旧矩阵或WSB调用。

task=`eb60c4fd-8ebc-4b10-bd74-93e061f58641`，startedUtc=`2026-11-01T13:04:40.471Z`，reportedUtc=`2026-11-01T13:06:41.612Z`。管理请求达到既定120秒逻辑期限，主证据及native-cleanup尾行已交付；外层执行会话38438仍未报告结束，不把逻辑结束当作物理退出。

| 已取得证据 | 实际值与限制 |
| - | - |
| 前置 | 固定PS7 7.6.9/x64，管理员令牌true，SeManageVolumePrivilege存在/Disabled，Storage2.0.0.0/7命令；NTFS可用88176832512字节，门槛168820736 |
| 前置/编译 | PID33352/PID21544，均settled、退出0、signal/launchError=null、killRequested=false；前置stdout280/stderr0，无流截断（256字符预览截断）；编译两流0 |
| 原生DLL | 16896字节，SHA-256 `827C9245917B31297931A02EB9ABB3E1F79A61FAE9062DC2A2193D1FE58C7524` |
| 管理助手 | PID15524；helperClosed=false、pending=true、exitCode/signal=null、buffersReleased=false；没有stderr |
| 最后已发布进度 | sequence1、phase=creating、imageCreated=false、imageId/physicalPath/volumePath/exchangeId=null；这是旧回执，不能代表超时后的实际磁盘状态 |
| 逻辑结果 | error=`Volume operation deadline; owner retained`；cleanupError=`Volume still in use or cleanup unknown`；prepared/probe=null、released=false、passed=false |
| 取消来源 | cancelled/revoked=true来自deadline→unsafe的内部取消，不是用户主动取消 |
| 交付与保留 | 尾行artifactsRemoved=false、retained=true、passed=false、outputFailed=false；journalFailed/outputBoundFailed=false；后来归属记录evidenceEmitted=true |
| 外层范围 | vmCalls=0、shareAdmission=false、operationErrors=[]、receiptUnknownHandles=[]；没有32字节probe通过、附加/解除附加或正常释放确认 |

超时后只读核对本任务根和已存在记录，未查询全局磁盘、运行存储命令或清理。观察时间`2026-11-01T13:09:04.787Z`，根为`D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner`，dev=`3938676073`、ino=`1688849861468031`；实际5个普通单链接叶子，同dev：

| 自有叶子 | 文件身份ino | 逻辑字节数 |
| - | - | -: |
| `lifecycle.json` | `1970324838178713` | 4271 |
| `task.vhd` | `3659174698442646` | 134218240 |
| `volume-helper.json` | `2533274791600023` | 415 |
| `volume-helper.next.json` | `1407374884757402` | 436 |
| `volume-native.dll` | `1407374884757400` | 16896 |

task.vhd逻辑长度为128MiB＋512字节，文件身份格式化后为`EAC36D69:000D000000125F96`。已发布volume-helper.json仍为creating，但同任务/sequence1的volume-helper.next.json已完整写下：

```json
{"protocol":"super-pi-volume-v1","taskId":"eb60c4fd-8ebc-4b10-bd74-93e061f58641","sequence":1,"kind":"progress","phase":"created","error":null,"imageCreated":true,"imageId":"EAC36D69:000D000000125F96","diskId":"eb60c4fd-8ebc-4b10-bd74-93e061f58641","physicalPath":null,"volumePath":null,"exchangeId":null,"capacity":134217728,"imageBudget":135266304,"shareAdmission":false,"detached":false,"managementClosed":false,"closeUnknown":false}
```

该.next中的imageId与实际task.vhd身份一致。结合已审代码先Create()/内部校验返回、再phase=created并Write-State的顺序，证据支持截至后续只读观察时创建后进度已写入.next，**尚未完成记录提交/对宿主交付**；不能继续写成“VHD未创建”或“CreateVirtualDisk本身不返回”。逻辑超时报于13:06:41.612Z，随后才观察到created记录，未取得该记录实际生成时刻，不能确定Create()在超时前还是超时后返回。.next不替代正式协议回执，不能据此断言当前没有附加、管理句柄已关闭，或可以安全删除。File.Replace等具体失败原因尚未取得异常证据，不猜成权限、磁盘或PS7模块故障。

当前明确阻断：准备流程未完成，管理助手及物理操作责任未收口，旧归属必须保留。没有调用release重试、强杀、删除盘/根、扩大时限或重跑；信号/error与晚到close观察继续由本次外层owner持有。上述5文件不是可随意清理的普通临时产物，后续只能先审本任务记录提交/交付与实际句柄/附加状态的最小只读诊断，获得明确依据后再确定恢复或释放方式。共享、工程候选接线、生产默认/权限退役和P0均未进入。

本次只补三文档结果；暂存前index1926条，范围外1923条stage JSON数组UTF-8 SHA-256为`1564EB8818F7CE0C08A865186D3C23B3D755A71764B9540757C5F40D64F74386`。最终复核后精确暂存，不触及原九份删除及patch、不提交推送。

最终记录复核revision285 / turn `01a1973d-a590-73a3-b3a4-fc3bf6ecb6a7` 通过，按其一项时序意见明确区分120秒逻辑截止和随后created观察，未推定创建发生在截止前。本次仅三文档精确暂存，index1926条，范围外1923条stage JSON数组UTF-8摘要保持`1564EB8818F7CE0C08A865186D3C23B3D755A71764B9540757C5F40D64F74386`，工作副本与index一致，33个本地链接及差异格式核对通过。代码/检查保持已审已测版本，原九份删除及patch保留，不提交推送。本轮停止后续诊断/磁盘查询/重试/清理，助手、会话和5个归属文件保持未决，不能宣称本项产物清理完成；下一项不得越过该owner，生产/P0边界保持。

## 14. 记录替换故障：单变量复现与最小修正

用户继续授权“查明原因，继续”后，revision286先审最小诊断范围，revision290审定合成代码。旧任务仅只读核对：2026-11-01T13:25:49.776Z，第13节根及五叶身份/长度不变，两份记录仍分别creating/created；PID15524为固定PS7，创建时间13:04:41.585335Z，完整参数匹配task/root/DLL摘要；父PID24964为本次node原生入口，创建时间13:04:40.434519Z。未把源文件修正视为旧进程函数热更新。

[File.Replace官方说明](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace?view=net-10.0)允许第三参数为真正null以省略备份；[PowerShell NullString官方说明](https://learn.microsoft.com/en-us/dotnet/api/system.management.automation.language.nullstring?view=powershellsdk-7.4.0)给出向.NET字符串参数传入真正null的专用值。由此选择单变量对照，不增时限或更换执行环境。

[新单组检查](../tests/windows-sandbox-volume-journal.test.mjs)仅从[PowerShell夹具](../tests/fixtures/windows-sandbox-volume-journal-check.ps1)中AST提取实际助手唯一Write-State；不执行助手顶层、加载C#、导入Storage、调用VHD或VM。假native仅提供固定属性及无存储Fingerprint。每次先Move，再第二次Replace；独立两叶保持相同初始/目标字节、同卷和同三字符串重载，仅改第三参数为NullString.Value。

| 证据 | 修正前一次 | 修正后一次 |
| - | - | - |
| UTC/PID | 13:31:25.656Z / 31480 | 13:33:30.307Z / 3688 |
| 子进程 | status=0，signal=null，stderr=0 | status=0，signal=null，stderr=0 |
| 原始stdout | 2374字节完整保留 | 2654字节完整保留 |
| 首次Move | 成功 | 成功 |
| 第二次实际Write-State | MethodInvocationException，根ArgumentException | 无异常 |
| 根异常 | HRESULT=-2147024809；parameter=path；The path is empty. (Parameter 'path') | null |
| 控制/发布 | controlFailed=true；stdout1；正式creating；next=created | controlFailed=false；stdout2；正式created；next不存在 |
| 独立真正null对照 | 目标字节匹配、源消失 | 目标字节匹配、源消失 |
| 最终正常行为断言 | 1 fail（修正前机制证据，保留） | 1 pass / 0 fail，438.9258ms |
| 自有产物 | 3叶1287字节及独占根已按身份清除 | 2叶872字节及独占根已按身份清除 |

修正前外层异常HRESULT=-2146233087，根消息无截断。源码仅将Write-State的File.Replace第三参数由$null改为[System.Management.Automation.Language.NullString]::Value并加解释；记录提交顺序、错误保留、存储/共享门槛及超时未变。revision293先审此最小修正后才运行新代码单组；没有第三次诊断、完整入口或旧矩阵。

此证据确认固定PS7/该源码中的故障机制。结合源码：Replace异常使controlFailed=true，外层再次以CreateNew写已有.next会失败并进入保留循环，能够解释现场正式记录未推进、无stderr和最终deadline；**旧助手的原始异常未直接捕获，创建相对原deadline的实际时刻仍未知**，不把合成证据改写成旧进程异常回执。

诊断检查先保存有界原始Buffer及base64、长度/截断标记，再严格解析；≤16KiB证据同步完整交付后才按登记身份逐叶删除/空根rmdir。子进程15秒、输出16KiB；四个允许叶子每个≤8KiB；采集stdout≤8KiB/stderr≤1KiB。失败输出仍保留；无输出确认不清理。检查进程均退出；旧owner根/盘/助手未触动。此为冷路径验收函数，不改生产热链、逐块分配或对象池；两次各两次状态写入、一次独立对照，不扩大生产性能测试。

| 最终文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-helper.ps1 | 4C833B7056DC0D1B4B6C54B2C0991DD06CE89AD40C22D13E5DC13EF3A02193B5 |
| windows-sandbox-volume-journal.test.mjs | BEB0104D5269805525F4FD9DABD1B798A5967E7C720FBB8800032852A2628124 |
| windows-sandbox-volume-journal-check.ps1 | 58C118747180717368AA3ECC5C9559D3CBB353A047F90A9D7CDBBD6595E73E2D |

本项范围为上述三文件加三方案文档，共六文件；暂存前index1926，范围外1922条stage JSON数组UTF-8 SHA-256为B3EC8D257C0D4EEAD622A8C65C1EA5D7D24ACBE40D701466EFCB93B298FE18B8。两新检查文件加入后预期index1928，范围外摘要不变。结果/文档复核后精确暂存，原九份删除和patch保留，不提交推送。

下一步已由revision293限定只读恢复前置：指定task.vhd仅一次Get-DiskImage、恰一对象与ImagePath相符，并前后核对根/镜像/两journal及准确进程归属。Attached=false只表示观察时点未附加，不证明管理句柄已闭或可终止/删除；释放仍须独立方案审查。旧责任未收口前不恢复原生单盘，不WSB共享、生产接入/默认/权限退役；P0继续待办。


本项最终结果/记录复核revision295 / turn `01a19752-36ae-7122-bcec-8dcaa5acce38` 通过；已按意见移除新增EOF空行。六文件已精确暂存，核对index1928条、范围外1922条摘要保持B3EC8D257C0D4EEAD622A8C65C1EA5D7D24ACBE40D701466EFCB93B298FE18B8；工作副本与index一致、36本地链接及差异格式通过，原九删除/patch保留。不重跑已通过检查，随后只执行已审的指定镜像只读前置。

## 15. 保留镜像的只读状态与恢复边界

revision293/295审定后，仅一次指定路径Get-DiskImage，不串联Get-Disk/分区/卷命令、不使用作业或远程会话。固定PS7及两配置校验通过；查询进程PID6328实际退出0、signal=null、stdout1996字节完整原始base64已交付、stderr0，严格UTF8/JSON解析成功，没有新磁盘产物或存储变更。

观察时间2026-11-01T13:37:03.1891594Z，恰好一个对象：ImagePath=`D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner\task.vhd`，Attached=false，DevicePath=null，Size=134217728，StorageType=2。前后13:37:01.562Z/13:37:03.460Z的根、镜像dev/ino及逻辑长度均与第13节一致；三份记录身份、长度和SHA-256未变化：正式415B/AB4D8870B1A01A8B31F5488F6AB217FBD74B8FD830A37A2C2FB9D9A3E0CFF07D；next436B/219DCB397A7EE3371DFEC618C92235F751894CA8474E2AC04A8B3CFE2B31BB32；lifecycle4271B/37A01C4E08DDD961A1418A4E31B5BA99CB0AE578659BD425F91D8CE87FEC798F。两次精确进程查询均确认helper15524、parent24964的创建时间、可执行路径、父子关系和完整命令与第14节一致。

这只证明观察时点未附加，不证明VHD管理句柄关闭，也不授予删除许可。已加载的旧函数在control失败后没有协作退出通道，不能把修改脚本当作已恢复。下一阶段先审一次性外部恢复方案及具体代码：仅绑定本任务的准确助手句柄，核对任务、文件和未附加状态后方可考虑一次终止；必须等待真实退出及原父进程自然收尾，禁止终止父进程/进程树、重复终止、自动重跑或因超时直接清盘。最终句柄、附加和身份确认之后另审清理；当前此动作尚未实施，第13节历史验收保持失败。

### 15.1 一次性外部恢复完成，原验收仍失败

恢复范围由revision298确认，具体一次性脚本由revision302 / turn `01a1975b-2806-7ff2-ab38-a5bc9fc3af9e` 复审。临时源`.artifacts/volume-recovery-eb60c4fd.ps1`：dev3938676073、ino2251799814889421、14574字节、SHA-256 D5B9DA6DB021EE321C16BD63ECD59FEDF810DDFBFD20C2C8722F2E5F2EE526F2。仅内存Add-Type，helper句柄含查询/等待/终止权限，parent仅查询/等待；全过程使用已绑定句柄，没有按PID重新选择目标或终止进程树。

紧邻执行核对固定PS7/两配置/临时源摘要；一次恢复器PID13460，实际exit0、signal=null，stdout1583字节完整原始base64交付、stderr0、四份回执解析成功。旧四份源码/DLL摘要、五叶身份/摘要、两journal、never-shared事实及父子参数均通过脚本门槛。原生句柄创建时间精度：helper=13:04:41.5853350Z，parent=13:04:40.4345192Z；与先前WMI微秒精度记录一致。

| 恢复观察 | 实际结果 |
| - | - |
| 紧邻未附加 | 13:51:33.1853343Z，Attached=false、DevicePath=null、Size134217728 |
| 终止尝试/接受 | 各true，仅一次对helper15524调用TerminateProcess(125) |
| helper实际退出 | 同一绑定句柄等待确认，exit125 |
| 原parent实际退出 | 只等待自然结束，exit1 |
| 后置未附加 | 13:51:33.2313402Z，Attached=false、DevicePath=null、Size134217728 |
| 最终owner | helperClosed=true、pending=false、buffersReleased=true；33352/21544/15524均closed，exit0/0/125 |
| 恢复器收尾 | helperHandleClosed/parentHandleClosed=true，error=null，step=complete |
| 原会话38438 | 后续工具返回实际exit_code=1、0新输出，不再活动 |
| 历史结论 | passed=false、released=false、retained=true、artifactsRemoved=false、normalReleaseSucceeded=false |

最终lifecycle由原owner晚到close更新，**身份已更换**：13:52:01.415Z登记dev3938676073、ino2251799814889369、4267字节，SHA-256 0311EA3AB018979096890AE78AD0AA66B9F4DCFCBBA71DF3424B11FB9A288B2C；其余四叶及根身份/长度/小文件摘要与第13/15节一致。

[微软终止进程语义](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-terminateprocess)要求将异步终止请求与实际退出分开；[进程资源回收说明](https://learn.microsoft.com/en-us/windows/win32/procthread/terminating-a-process)说明进程自有句柄被系统关闭，其他进程的句柄仍可能存在。本次结论限于两个绑定进程实际退出及恢复器自有句柄关闭，不宣称全机没有相关句柄，也不是原生release成功。

revision304确认可以准备逐路径清理，但删除前必须另完成同镜像一次独占只读打开、句柄身份/长度核对及关闭确认，先交付最终证据，再先镜像/最后归属记录删除；不得递归、重试、重建已删记录或启动新任务。清理代码及结果另记，当前此节尚不宣告文件已删除。

### 15.2 独占检查与精确清理完成

revision308 / turn `01a19766-3bc3-76b0-ae58-38bb07cbfb5a`先审一次性清理源码（9051B，dev3938676073/ino4785074604999173，SHA-256 1C95A6A1673FA87BCB0E04F9A98DB8E84590109919DBB36CFD971B2D40CC34CC），紧邻执行再次核对同摘要/身份，仅一次调用。

2026-11-01T14:01:29.970Z交付删除前有界证据：完整最终lifecycle、原会话exit1/恢复结果、五叶与两临时源身份/摘要、独占打开回执。固定PS7独占检查PID31596，实际exit0、signal=null，stdout206字节完整原始base64交付、stderr0；FileMode.Open/FileAccess.Read/FileShare.None成功，从该句柄核对image ID=3938676073:3659174698442646及长度134218240、普通单链接文件，bytesRead=0，Dispose后closed=true，error=null。它证明检查时无冲突共享占用，不外推永久没有其他句柄。

证据同步完整交付、再次验证全部目标后，逐项重新核对身份并按顺序删除：task.vhd、DLL、next、正式journal、最终lifecycle，随后仅rmdir空根，再删除已登记的恢复/清理两份临时源。尾行cleanup-complete：removed共7叶、rootRemoved=true、artifactsRemoved=true；入口退出0，三个已知路径（owner根/两个源）均不存在。没有递归/通配、额外磁盘查询、全镜像读取/摘要、重杀或重试，也未复跑旧矩阵。

旧task的进程与文件责任已收口，**历史passed=false、released=false、normalReleaseSucceeded=false不改写**。本项只更新三方案文档；暂存前index1928，排除三文档后1925条stage JSON数组UTF-8 SHA-256为1A4EB370DF3809268B7751BF51971C2B2B4BB4E0D779195590FB179435B8670A。先复核结果/记录再精确暂存，保留原九份删除/patch，不提交推送。

下一项拟恢复修正后的唯一一次原生单盘验证：仍固定PS7/csc及既有128MiB/预算/时限，仅前置→编译→prepare→verify→32B probe→release→exit；紧邻核对工具、源码、配置及独占根不存在。必须由新运行的具体回执证明准备与正常释放，不能用本节外部恢复代替；不WSB共享/灌写/真实工程，失败保留、不自动重试。此处为待复核条件，尚未运行。

结果/记录最终复核revision310 / turn `01a1976b-a3d9-7221-91c2-61756f7b16ac` 通过，三文档精确暂存核对目标index1928/范围外1925摘要1A4EB370DF3809268B7751BF51971C2B2B4BB4E0D779195590FB179435B8670A；原九删除/patch保留，不提交推送。审核允许紧邻核对固定工具/两配置/源码及独占根不存在后，执行修正后的唯一原生单盘入口；不重跑已通过检查。此放行不是生命周期已通过证据，实际结果另记。

## 16. 修正后原生单盘正常生命周期通过

revision310审定条件、三文档精确暂存并核对范围外摘要后，紧邻核对固定PS7/csc、基础与专用配置、四份源码摘要及独占根不存在，仅一次运行既有原生入口。task=`8da73fd7-3423-4079-9dde-98b02481e7a5`，startedUtc=`2026-11-01T14:04:53.055Z`、reportedUtc=`2026-11-01T14:05:08.154Z`，会话40114实际exit0。未复跑startup、剪贴板、禁网、文件边界或进程树旧矩阵。

| 本次实际证据 | 值 |
| - | - |
| 前置 | PS7.6.9/x64、管理员令牌true、SeManageVolumePrivilege存在/Disabled、Storage2.0.0.0/7命令；NTFS可用88155152384B，门槛168820736B |
| 调用退出 | 前置PID32772、csc33512、manager30160全部closed/exit0/signal=null，stderr均0；前置stdout280，编译两流0 |
| 新编译DLL | SHA-256 0123BFFB07499AD26D409ABBB834261E7CC035A16BA074EDC2620566FDC4D002；本次产物摘要单独记录，不用旧DLL摘要替代 |
| 准备 | sequence1、prepared-not-share-admitted；capacity134217728、imageBudget135266304 |
| 镜像/盘 | imageId=EAC36D69:0011000000125FD9；diskId为本task；持有句柄推导设备PhysicalDrive1（仅历史事实，不能据盘号重新定位） |
| 卷/目录 | volumePath=\\\\?\\Volume{d0fcf3be-0000-0000-0000-100000000000}\\；exchangeId=D6FB42C4:0001000000000024 |
| probe | bytes32、matched=true、opened2/closed2、closeUnknown=false；fileId=D6FB42C4:0001000000000025 |
| 正常收尾 | sequence5/released、detached=true、managementClosed=true、closeUnknown=false；helperClosed=true、pending=false、reading=false、buffersReleased=true |
| 任务结果 | sequencePassed=true、released=true；error/cleanupError=null，operationErrors/receiptUnknownHandles=[]，cancelled/revoked=false |
| 清理尾行 | native-cleanup：passed=true、artifactsRemoved=true、retained=false、outputFailed=false、cleanupError=null |
| 范围 | vmCalls=0、shareAdmission=false；不WSB共享、不容量灌写、不真实工程 |

主证据首行passed=false/artifactsRemoved=false/evidenceEmitted=false是既有“先交付证据、后清理”的前置时点，不与最终尾行混淆。最终尾行及实际exit0证明本次正常收尾；随后一次只读确认独占根不存在。没有未决helper/业务句柄或本项临时产物。已正常释放的卷GUID和PhysicalDrive1只作为历史记录，后续任务不得复用。

源码仍为：C# A01944E8E62F5F34BBBFC685158FBF0D70F40260B81A1B8DAE362D9E977949CC，helper 4C833B7056DC0D1B4B6C54B2C0991DD06CE89AD40C22D13E5DC13EF3A02193B5，volume.mjs 50BEF18A1AF35B4803B91B672985B056F16C680644F8FE8FE54F76CD2F0826D6，native入口 E4A269C0D347A9E7CF3A6C5B10C61F938862CEE96939EEFBD789914E10E758B3。没有为本次运行再改代码、提高时限/容量或绕过状态门槛。

此项证明固定环境下**原生专属卷正常生命周期**；不证明固定WSB客户端接受卷GUID目录映射、不证明共享准入/来宾写入/直接硬容量拒绝，也不覆盖异常脱卷回落、Windows候选读取或真实工程接纳。下一项先审最小共享接线：明确宿主共享准入、实时VM与CLI收尾事实，以及来宾可写GUID目录的有界安全读取；先代码和必要新定向检查，再决定单实例小文件共享，硬容量灌写另项。

本次仅三文档记录，精确暂存前index1928/范围外1925摘要保持1A4EB370DF3809268B7751BF51971C2B2B4BB4E0D779195590FB179435B8670A。先复核记录再精确暂存，原九删除/patch保留，不提交推送。生产接入/默认/权限退役关闭，P0桌面回放待办。

结果/记录复核revision313 / turn `01a19772-127a-7cc0-810e-d212a9b892a5` 通过，按意见将主方案时间改为startedUtc/reportedUtc，并将随后清理/实际exit0单独表述，不赋予未观察的最终完成时间。三文件精确暂存核对index1928/范围外1925摘要1A4EB370DF3809268B7751BF51971C2B2B4BB4E0D779195590FB179435B8670A，原九删除/patch保留。后续仅进入第16节所列共享适配的方案与代码；尚未放行WSB实测。

## 17. 实验共享准入与实时收尾绑定：离线检查通过

revision315确认最小离线范围；revision317/321及后续复审指出异步检查完成到实际派发间的撤销/释放、VM清理缓存及runtime销毁窗口，全部在首次运行前修正。revision329 / turn `01a19794-1886-78f0-96eb-cd89f07cabdf`代码复审通过，紧邻核对六份获审摘要后执行限定检查。

[配置](../scripts/acceptance/windows-sandbox-volume-config.mjs)只生成恰好一个所属卷GUID的exchange到C:\\SuperPiVolume的RW映射；要求规范49字符GUID路径，无盘符、普通目录、UNC或尾换行回退。网络、剪贴板、音视频、打印与vGPU关闭，内存2048MiB。[卷owner](../scripts/acceptance/windows-sandbox-volume.mjs)原shareAdmission仍固定false；独立experimentalShareAdmission只服务离线已审接线，不表示WSB兼容性通过。私有一次性ticket绑定同一卷基线、task、实际VM对象、instanceId和完整配置摘要；真实ticket开始使用即消费，不能通过恢复旧配置重用。

[生命周期](../scripts/acceptance/windows-sandbox-lifecycle.mjs)在preflight list之后再次验证卷，最终在启动记录写入之后、cli.launch之前同步检查私有许可、健康状态、VM清理/调用状态和runtime实时绑定，中间没有await或宿主回调。守卫拒绝时只撤回未实际派发的entry，不伪造退出；已完成或阻断的清理状态保留。[runtime适配](../scripts/acceptance/windows-sandbox-volume-sharing.mjs)必须绑定实际VM；只有从未派发且所有调用关闭，或最后严格成功且未截断的list证明所属实例消失、全部exec/connect/control实际关闭时，才允许读取或盘释放。实例消失但exec未结束、启动未知、list失败/坏schema/截断、关闭未知均保留责任。

2026-11-01T14:50:59.732Z核对摘要后，新[检查文件](../tests/windows-sandbox-volume-sharing.test.mjs)仅运行一次：11通过、0失败/取消/跳过，59.5048ms。指定旧用例的首次筛选名称误写为someone's而漏掉else，输出1..0，没有实际选中用例，不能计为验证通过；核对源码名称后仅执行正确精确名称`pre-existing instances and pre-start cancellation never start or stop someone else's instance`一次，1通过、0失败/取消/跳过，63.7166ms。两次实际检查进程退出0；未重跑新11组或旧矩阵。这些时长是检查报告事实，不作为性能收益证据。

| 定向证据 | 观察/断言 |
| - | - |
| 正常许可 | 假CLI仅1次start；卷命令prepare→verify→verify→release→exit；真实ticket不可复用 |
| 异步撤销/已接受释放 | 在dispatch-checked journal排入微任务；两支start均0，释放与启动不能同时成立 |
| 清理先行 | 微任务cleanup保持closed-before-start；同步启动journal内cleanup保持blocked-cleanup/缓存false，start均0 |
| runtime提前dispose | start0，ticket撤销；runtime永久unknown，卷release拒绝；没有将清除引用当作资源已释放 |
| 未决与未知 | exec未物理关闭、最后list未证明缺席、启动未知或文件close-unknown均阻止盘释放 |
| 引用 | 映射终态清除ticket/VM/config引用；正常runtime.dispose清除内部VM/四视图引用；未决分支有意保留责任，不外推外部持有的快照 |
| 资源 | 所有存储/CLI均为纯内存替身，实际WSB/助手/编译/Storage/VHD调用0；无本项临时文件或系统资源 |

完整冷控制链已核对：TaskVolumeOwner→SandboxLifecycle.start/invoke/cleanup→CapturedProcess，以及VolumeProtocol→owner与实时runtime；新增导入仅在手动验收和检查中，packages无生产调用。未改stdout/stderr逐块回调、Provider/进度/渲染/大结果链，无池。每次runtime绑定一次创建4个固定视图，read本身不按调用创建闭包/数组；最终list解析复用既有有界parseRunning，限冷收尾。既有96调用、128列表项、16KiB/流及卷8KiB记录预算保持；尚未实现真实组合入口，不宣称两个原入口的记录预算可以直接相加，也未运行无关生产分配基准。

| 本次获审文件 | SHA-256 |
| - | - |
| windows-sandbox-lifecycle.mjs | D9D962A4652356A50ACFF310DDF1128C07EC5F77963D0EE1B467CFB8813DF2A1 |
| windows-sandbox-volume.mjs | E0EE1BFD5F86EA07914E7813C3A12DC3B8BCE7E38DB68A058DDCF8FEE4DC6B7D |
| windows-sandbox-volume-config.mjs | 77F1A2532B185492E657A177445DBF15087CB2F7BE46A17AECA8ED6F12B72CA6 |
| windows-sandbox-volume-sharing.mjs | D070C6CDF0EB167E1B7FB277E4A26D5582AC1D51708BE5FDD46F95032D201BBA |
| windows-sandbox-volume-sharing.test.mjs | C0C2AC97FBED4379D940F7DB100A2E41D88EF1E85EF4C1137C2046649CBFF16F |
| 既有windows-sandbox-lifecycle.test.mjs（未修改） | 9A7A8F1F859DDE25E7EA4359BC1C0B70027A67F4594F1EC622C1E13F80DFF832 |

本项精确范围为5代码/检查文件加3方案文档，合计8文件。暂存前index1928条，范围外1923条stage JSON数组UTF-8 SHA-256为1485674C50DC043526EFDE807355F983D981CBF8BE21926E07659AA8AACF32D6；新增三文件后预期index1931，范围外保持不变。先复核结果和记录再精确暂存，保留原九份删除及用户patch，不提交推送。

下一独立小项是宿主读取固定32B来宾叶子的安全适配，随后才是一个统一owner的GUID小文件共享入口及现场条件；本节不授予真实共享验证通过。直接容量拒绝、异常失效、真实候选/工程接纳尚未完成。生产真实工作区/默认切换/权限退役保持关闭，P0桌面回放待办。

结果与记录复核revision331 / turn `01a19799-65ee-7980-a2f4-17ddbd0457d7`通过，50个本地链接核对通过；按获审范围精确暂存八文件，目标index1931/范围外1923摘要1485674C50DC043526EFDE807355F983D981CBF8BE21926E07659AA8AACF32D6，原九删除/patch保留，不提交推送。下一固定32B读取范围已获审，具体代码另审后才做新定向检查；不重跑已通过项。

## 18. 固定32B来宾文件读取：代码与离线检查通过

revision331先确认独立最小范围。源码预审发现原操作异常会被finally中的关闭异常覆盖，运行前已修正为分别捕获主操作、文件关闭、目录关闭异常，始终尝试两个关闭并清空缓冲，再按主操作→文件关闭→目录关闭优先级用ExceptionDispatchInfo重抛原异常；两个关闭错误码及对应未知句柄继续独立保存。revision335 / turn `01a197a5-4be9-7951-afbb-35460468c5c9`复审通过后才执行新检查，没有先跑再补审。

[原生读取器](../scripts/acceptance/windows-sandbox-volume-native.cs)只接受所属规范GUID exchange下固定guest-control.bin，不接受来宾路径或payload。目录GENERIC_READ、OPEN_EXISTING、BACKUP_SEMANTICS|OPEN_REPARSE_POINT、FILE_SHARE_READ；叶GENERIC_READ、OPEN_EXISTING、OPEN_REPARSE_POINT、share0。目录不使用仅属性访问来宣称排斥共享；访问/共享规则依据[CreateFileW官方说明](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)。从持有句柄取得规范GUID最终路径，具体标志和长度/错误判据依据[GetFinalPathNameByHandleW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)；卷serial及file index用于身份比较，依据[GetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfileinformationbyhandle)。这些API依据不代替本机真实调用验证。

正文前核对目录身份、叶类型/非重解析/单链接/32B长度、卷关系、精确路径和DeletePending；只调用一次32B ReadFile，比较本task去横线前30ASCII十六进制字符加CRLF，并做后置身份核对。两个业务句柄独立计数、峰值最多2，未知关闭不清空对应IntPtr、不重试；两个32B数组在finally清空。本计数不包含已有VerifyImage/VerifyExchange等元数据查询内部句柄。标记只用于本次固定文件往返，不能认证来宾具体进程或宣告任务成功。

[助手](../scripts/acceptance/windows-sandbox-volume-helper.ps1)新增固定read-guest命令、一次性状态和宿主私有volume-guest-read.json，现有无payload请求schema、16命令/32消息及预算保持。[私有回执检查](../scripts/acceptance/windows-sandbox-volume-guest-read.mjs)绑定task/volume/exchange，严格字段、实际读取/打开/关闭/峰值、两个close错误和未知句柄标志；伪造关联、越界或不可能的计数拒绝。owner只允许本次已派发VM真实收尾、全部CLI关闭后读取；读取期间占用阻止release，前后绑定不稳定、身份/回执/关闭未知进入unsafe。普通marker不符且所有句柄明确关闭，可继续正常释放磁盘；候选接纳/工程提交没有接入，OfflineCandidateOwner未扩展。

2026-11-01T15:07:48.038Z（本地2026-11-02）紧邻核对六份获审摘要后，新[五组检查](../tests/windows-sandbox-volume-guest-read.test.mjs)仅运行一次：5通过、0失败/取消/跳过，792.466ms，入口exit0。前四组纯内存；第五组一次编译和一次[PS7 AST夹具](../tests/fixtures/windows-sandbox-volume-guest-read-check.ps1)，24分支通过。夹具只载入DLL/提取三实际函数、运行假native和三个纯静态验证方法；nativeConstructors=0、realStorageOperations=0、businessHandles=0，未加载Storage或运行真实业务读取、VHD、WSB。报告时长不是性能优化证据。

| 实际检查/资源证据 | 结果 |
| - | - |
| 编译 | 固定csc PID26092，status0/signal=null/error=null，stdout0/stderr0 |
| PS7夹具 | 固定PS7 PID32124，status0/signal=null/error=null，stdout547字节完整base64交付、stderr0，无截断 |
| 正常替身 | 单次read-guest；匹配/32B/两开两关/峰值2回执及冻结副本；正常release/exit和runtime引用释放 |
| 拒绝/未决 | 未结束VM或exec、重复读取、读取中release、撤销、runtime失联均拒绝；缺失回执、身份或close未知保留责任；普通marker失败与未知关闭分开 |
| 异常优先级 | 原identity+双close、双close、仅dirclose、全无错四个纯静态分支，前三以ReferenceEquals确认重抛原异常对象；两个close码穿过helper回执保留 |
| 本项根 | .artifacts/volume-guest-read-check-e20ecb66-1e36-49f5-ae48-8622ea52856e，dev3938676073/ino3096224745021467 |
| 唯一产物 | volume-native.dll，dev3938676073/ino1970324838178878，22016B；未构造NativeDisk |
| 清理 | 有界完整证据同步交付后，逐叶身份核对删除DLL、空根rmdir；rootRemoved=true/filesRemoved=1；随后根及原acceptance-owner根均不存在 |

全部新路径为冷验收读取/控制点；沿helper→VolumeProtocol→TaskVolumeOwner→LiveSandboxRuntime→SandboxLifecycle检查收尾链，未修改既有逐块输出回调、生产Provider/进度/渲染或大结果处理。原生设计固定64B正文缓冲和两个业务句柄；当前仅证明源码边界与离线反例，不伪称实际Win32读取计数。检查最多两个15秒进程、一个≤128KiB DLL、≤12KiB证据、stdout2KiB/stderr1KiB前缀；完整长度/截断/退出事实保留。没有对象池、无关分配基准或旧矩阵重跑。

| 获审文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-native.cs | F7FB571F4D13135AEEDF34F6ECB705A54FBDACFCC5F2B256BE3DC36C10DE75C3 |
| windows-sandbox-volume-helper.ps1 | 3DFA12B3BB209E2FD1E5977E9F5D27FC699EB979DA3DF93C56D6229BBBD92B6E |
| windows-sandbox-volume.mjs | 1C12ED9C053221E5A8A07E0E9DBCD47358F833881CB2843ADB878D0663297835 |
| windows-sandbox-volume-guest-read.mjs | B6FD0175BDF76657CFC4D366B1234FC9014261870B9AE645578240CD6812BF22 |
| windows-sandbox-volume-guest-read.test.mjs | DF0B4046D78025073F18138494FB0C06461469CDB83DC417D0431D53C7A8C122 |
| windows-sandbox-volume-guest-read-check.ps1 | 1C15D2DEC371E7B10E5E2E6DFEF6CD4914CB0CA9ADF6D2AE7DAAFFA1768C9240 |

本项6代码/检查文件加3文档，共9文件；暂存前index1931/范围外1925条stage JSON数组UTF-8摘要41160DDB86B83ABF8F05B98A878C73DE7B5473696A75BB5EFB8489170AEE57D9，加入三个新文件后预期index1934、范围外保持不变。先复核结果/记录，再精确暂存，原九删除及用户patch保留，不提交推送。

下一项必须单独审统一外层owner、合并记录/输出预算、取消及迟到收尾、固定来宾写入和真实GUID小文件往返入口。本节不证明固定WSB客户端接受卷GUID映射、真实读取API调用、共享硬容量或异常失效。生产真实工程/默认切换/权限退役保持关闭，P0桌面回放继续待办。

结果/记录复核revision336 / turn `01a197a9-1453-7870-bf9c-ce2596534743`通过，56个本地链接和临时根不存在核对通过；本项九文件精确暂存目标index1934/范围外1925摘要41160DDB86B83ABF8F05B98A878C73DE7B5473696A75BB5EFB8489170AEE57D9，原九删除/patch保留，不提交推送。下一项先审统一owner及实际GUID入口方案，不重复本项或旧矩阵。

## 19. 共享会话组合核心：离线检查与收尾责任

revision341确认只实现组合控制与纯内存检查，不启动真实适配器。新增[会话生命周期](../scripts/acceptance/windows-sandbox-volume-session.mjs)、[固定32B写入编排](../scripts/acceptance/windows-sandbox-volume-share.mjs)和[八组组合检查](../tests/windows-sandbox-volume-session.test.mjs)，复用实际TaskVolumeOwner、LiveSandboxRuntime与SandboxLifecycle，存储/CLI/文件系统/输出/保留定时器均为替身。没有实际共享入口或生产导入。

预审revision343指出预留持久化重新引入启动回调窗口、输出error但写回调未结束时责任保留缺失、部分删除计数丢失三项P2，均先修正再测。组合adapter先检查/登记名额并保存，随后紧邻factory重新验证私有许可；明确未派发才回撤合成entry，真实factory抛错保持launch-unknown。固定exec另外绑定实际task/VM/volume/driver/runtime及未撤销映射状态，单独volume.revoke不abort也拒绝派发。所有物理调用关闭仍不等于真实VM、盘或任务责任完成；未知分支保留实际owner和60秒无操作保留定时器，不轮询、重试或自动恢复。

正常编排为prepare→绑定唯一GUID配置和实际VM→两次verify/一次start→固定System命令→真实VM/所有CLI收尾→单次固定32B安全读取→release/exit→有界证据交付→精确私有叶清理→runtime/task解除绑定→尾行回调完成后释放剩余引用。来宾命令固定绝对cmd.exe、/d /c、重定向在前、30位task派生ASCII十六进制及CRLF，无尾随空格；平台回执解析与实际读取匹配分别记录，不认证来宾具体进程。

| 预算与责任 | 固定限制 |
| - | - |
| 创建前名额 | 至多99条预留：2个预检/编译、1个manager、96条CLI；最多4个未决，超过在factory之前拒绝 |
| 调用证据 | 记录数、实际观察启动数、已关闭数、结果字符数、最多4项精确未决归属与末次CLI摘要；不展开全部历史、不截断第五个未决 |
| 记录/输出 | 实际JSON两空格缩进UTF-8 journal≤8192B，主证据≤7680B，footer≤512B；错误文本按JSON编码字节限长 |
| 超限 | 拒写超限journal，主证据明确complete:false，保留owner/根；不提高上限或宣称全部完整报告都能容纳 |
| 精确清理 | 只允许9个固定私有叶及大小/身份，lifecycle最后；native先负责删除image，残留task.vhd/额外文件/身份变化拒绝清理 |
| 部分失败 | 每次unlink立即计数；后续unlink/rmdir失败尾行如实交付已删数量，不重建journal或重复清理 |
| 迟到事件 | 只更新事实；输出callback未完成继续保留，不能因stream error已拒绝Promise就假定callback结束 |
| 缓冲口径 | 98个CapturedProcess双流固定捕获累计容量加manager 9KiB约3.1MiB，是源码容量上限，不是同时存活、总堆或实测配额 |

revision347完成四份代码预审后，2026-11-01T16:04:39.792Z（本地11月2日）一次运行新八组：7通过/1失败、135.459ms，检查PID14468/status1/signal=null/stderr0。失败组为预留journal重入：runtime.dispose因未决start拒绝，粘性journal失败后私有record已标not-started但内存摘要未更新；factory未调用、startAttempted已回撤，不能把失败写成实际启动越界。修正仅在该catch中同步刷新摘要、不再写journal，保留原错误；复审后只恢复该失败组，七个已通过组不重跑。首次失败后的exec撤销子分支当时未执行，不算通过。

已通过的正常替身证据：7个CLI、6次manager命令、8个物理对象、2次输出；四私有叶删除、native另删镜像、最后未决0、runtime与task及调用引用释放。全99名额/4未决在factory之前约束，错误/未知有意保留责任。编码压力样本使用实际摘要函数，但人工填充字段不称为严格可达生产状态：成功样本开始6258B、结束6654B；保留失败7637B、结束7680B；最大实际journal7681B，主证据5311/6479B、footer172/265B。保守schema组合10389B触发明确不完整输出和保留。不能由这些样本外推所有完整报告必定小于8192B。

本次仅手动验收冷控制链；完整检查owner/CLI/manager、journal和输出回调、精确清理/迟到关闭引用责任，没有改逐块捕获回调或生产Provider、进度、渲染、大结果路径，无对象池或无关基准。所有新组合检查均纯内存，真实编译/helper/Storage/VHD/WSB/文件系统操作0，无本项临时产物。

本项固定4代码/检查加3文档，共7文件。暂存前index1934、范围外1930条stage JSON数组UTF-8 SHA-256为3D554CF259D950DD6BE4272052A8CC467C99150D2242EB9AB4BAD0CDD1B2CA33；加入3文件后预期index1937，其余不变。完成复核再精确暂存，保留九删除及用户patch，不提交推送。

revision348/349复审上述catch后，2026-11-01T16:06:46.615Z仅按精确名称恢复原第3组一次：实际选中1组、1通过/0失败取消跳过，61.0137ms，PID32284/status0/signal=null/stderr0。三种start重入和exec单独撤销均通过；新八组分别取得通过，首次7pass/1fail保留，不写成首次全通过。没有重跑其余七组、旧矩阵或实际资源。

| 最终获审代码/检查 | SHA-256 |
| - | - |
| windows-sandbox-lifecycle.mjs | 590CB363408A8A3830082E0F8CC2B1526003A484023D51EC68E93FB15212777C |
| windows-sandbox-volume-session.mjs | C48BD93E9D512AAB7723DD3C21A5F74D264A51FE44F57BA2758347F647AA991B |
| windows-sandbox-volume-share.mjs | 5A547BBA876EF174B65057F23CC3BE339A4CA13F1600FC5E225BEB12C8DE3686 |
| windows-sandbox-volume-session.test.mjs | 5BD5A1C83A3C009F1FCB73BE56FA6D126E782155C4B022CBB33EDBD738A4D4C8 |

后续仍需具体真实adapter、固定工具/源码/独占根条件预审，才能单次实际验证GUID小文件往返；当前不证明GUID路径被固定客户端接受、共享硬容量或异常失效。生产真实工作区/默认切换/权限退役继续关闭，P0桌面回放待办。

结果/记录复核revision352 / turn `01a197dd-de54-71a3-9a27-3e8dd0f4daa5`通过，专项54本地链接及主方案6个目标存在（未验章节锚点），差异格式与独占根不存在核对通过。按上述7文件精确暂存目标index1937/范围外1930摘要3D554CF259D950DD6BE4272052A8CC467C99150D2242EB9AB4BAD0CDD1B2CA33，保留原九删除/patch；下一项真实adapter实现范围已审，具体代码和现场条件仍另审。

## 20. 单GUID共享真实适配入口：代码与离线检查完成

revision352先审具体实现范围。[手动适配入口](../scripts/acceptance/windows-sandbox-volume-share-acceptance.mjs)仅接受显式一次运行参数及获审源码集合摘要，固定PS7预检、一次编译、单manager、单卷/实例和32B标记，不提供任意任务、工作区、容量灌写或回退目录。实际关闭门槛接入helper.active、LiveSandboxRuntime、volume released、manager实际关闭/pending以及私有收据未知句柄；尚未创建的资源保持未创建事实，未知创建保留精确预留责任，不借用合成VM关闭状态。

预审修正源码校验过早和可选收据错误归类两项P2：三个宿主创建均经SharingLifetime先预留/持久化，最终hostLaunchGuard再核对task、取消、完整集合及对应PS7/csc摘要，紧邻factory；start/exec仍使用原私有卷/VM许可。可选错误收据只把第一次固定叶lstat的ENOENT且再次根核对通过视为缺失，返回JSON不可能产生的undefined；现存JSON null必须结构校验失败。根/open/后置复核期间消失不忽略。

私有读取器只允许guest-read及prepare/verify/read-guest/release/exit五错误叶，各最多一次、每次≤4096B、单链接/非链接及根身份、打开后与读后句柄/叶身份和长度/时间核对、严格UTF-8。具体guest/error回执消费者继续严格字段及关联校验。读取/关闭同时失败保留原读取异常，关闭错误另记fd/name/code/message；未知关闭立即拒绝后续读取和清理，不重试数字fd。缓冲finally清零，单次峰值4096B、最多6次累计24576B；计数不包含元数据查询内部句柄。

revision359/362完成最终代码及测试夹具复审后，2026-11-01T16:22:59.929Z（本地11月2日）紧邻核对两摘要，只运行新[四组检查](../tests/windows-sandbox-volume-share-acceptance.test.mjs)一次：4pass、0fail/cancel/skip，63.9713ms，PID21208/status0/signal=null/stderr0。收据均内存替身，真实文件访问仅固定源码只读，实际子进程/helper/编译/存储/WSB/文件写及临时产物0；旧矩阵未跑。

| 本次证据 | 结果及限制 |
| - | - |
| 正常读取替身 | opened1/closed1/active0/peak1，11B读取/分配，保留的测试Buffer全部清零 |
| 拒绝/关闭未知 | 非固定叶、超限、根/句柄/叶变化、短读/非法UTF-8、初始缺失与中途消失、JSON null分别验证；未知close保留fd17，原读取异常对象保持 |
| 末次创建守卫 | 预留回调改变bundle、取消、工具失配均manager factory0/notStarted1；正常对照factory1，各纯内存绑定/引用释放 |
| 集合 | 16文件、导入闭包只读核对；逐文件字节限131072B，合计≤1048576B，当前189005B |
| 适配报告编码压力 | journal样本6201B、主证据4828B、错误组合6792B；是有限压力样本，不宣称全可达状态上界；原8KiB/7680B/512B门槛及超限保留保持 |

入口SHA-256为71EB25E07C47F4CA0005D7AEBDC8C72B815141165179EB721BCA7404EAA26D81，检查为B114BA5B6F2EE8EB0B89BB3A1D360F5259E0B57FDCB2E8B270DE3EBE0A043F8D。新增仅冷手动控制/有界私有读取，没有生产导入或逐块回调变化，不跑无关分配基准；固定捕获/调用上限及完整链引用责任沿第19节。

集合算法固定为下表顺序的[相对路径,小写SHA-256]二元数组，路径统一加scripts/acceptance/；构造键顺序protocol、files的对象，protocol=super-pi-sharing-sources-v1，JSON.stringify无缩进/无结尾换行后按UTF-8计算SHA-256。当前集合为c8b77da13b6b8f3771a63d3e42fb8bc789e4286870d369681c9a2b1a5ac4a228。表中覆盖实际加载的模块、helper/C#及专用PS配置；PS基础配置、工具二进制和生成DLL分别由既有固定守卫/运行记录核对，不混入源文件清单。宿主Node为D:\Nodes\26.13.0\node.exe（v26.13.0），宿主PowerShell只用D:\PowerShell\7\pwsh.exe，不回退。

| 顺序／文件（scripts/acceptance/） | SHA-256 |
| - | - |
| 1. windows-sandbox-clipboard.mjs | bc96e0fa0266b74fea450e64926218cafc120ba919a55d992d2ee73b8954896f |
| 2. windows-sandbox-fixed-acceptance.mjs | b7551b3c41db0e9b029dd11413875f68f1a81a67b8e8c543c215a290e2dfc599 |
| 3. windows-sandbox-guest.mjs | 622f25061b4076a6c7fdb673e9faee8adff4479fd4bf359a39affb2795bbf5dc |
| 4. windows-sandbox-lifecycle.mjs | 590cb363408a8a3830082e0f8cc2b1526003a484023d51ec68e93fb15212777c |
| 5. windows-sandbox-package.mjs | 9c727a392e2f25a3785002342f36fbf5dc479c9cdcd164ed79c1535aa3059ad7 |
| 6. windows-sandbox-powershell7.config.json | 7ad7607adf83f5df57f786d85911facef02103f42d3f6b5e1ee1fde2b8778e51 |
| 7. windows-sandbox-volume-config.mjs | 77f1a2532b185492e657a177445dbf15087cb2f7be46a17aeca8ed6f12b72ca6 |
| 8. windows-sandbox-volume-guest-read.mjs | b6fd0175bdf76657cfc4d366b1234fc9014261870b9ae645578240cd6812bf22 |
| 9. windows-sandbox-volume-helper.ps1 | 3dfa12b3bb209e2fd1e5977e9f5d27fc699eb979da3df93c56d6229bbbd92b6e |
| 10. windows-sandbox-volume-native-acceptance.mjs | e4a269c0d347a9e7cf3a6c5b10c61f938862cee96939eefbd789914e10e758b3 |
| 11. windows-sandbox-volume-native.cs | f7fb571f4d13135aeedf34f6ecb705a54fbdacfcc5f2b256be3dc36c10de75c3 |
| 12. windows-sandbox-volume-session.mjs | c48bd93e9d512aab7723dd3c21a5f74d264a51fe44f57ba2758347f647aa991b |
| 13. windows-sandbox-volume-share-acceptance.mjs | 71eb25e07c47f4ca0005d7aebdc8c72b815141165179eb721bca7404eaa26d81 |
| 14. windows-sandbox-volume-share.mjs | 5a547bba876ef174b65057f23cc3be339a4ca13f1600fc5e225beb12c8de3686 |
| 15. windows-sandbox-volume-sharing.mjs | d070c6cdf0eb167e1b7fb277e4a26d5582ac1d51708be5fdd46f95032d201bba |
| 16. windows-sandbox-volume.mjs | 1c12ed9c053221e5a8a07e0e9dbcd47358f833881cb2843adb878d0663297835 |

本项2代码/检查加3文档，共5文件。暂存前index1937/范围外1934条stage JSON数组UTF-8摘要21283F73F4DC18C287D09577157E81545BE06644151789F09D7618824824A03F；加入两文件后预期index1939，其余不变。结果/记录复核后精确暂存，不提交推送，九删除及用户patch保留。

下一独立现场条件只允许一次相同源码集合、固定工具及无旧owner前置下的128MiB卷/单GUID实例/固定32B往返，必须实际list确认所属实例消失、全部CLI关闭，再安全读入并正常释放镜像；任何未知保留责任、不自动重试或终止管理助手。没有由本节推定客户端接受GUID或共享硬容量通过；容量填充/异常失效另审，生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

结束请求按角色区分：既有OwnedHelperRunner仅对本任务持有的只读预检或编译子进程，在15秒逻辑超时/取消时请求结束一次并再等3秒，记录killRequested；未确认物理关闭仍保留责任，不当作已退出。卷manager和WSB CLI不因此终止，不按猜测PID或进程名扫描/清理；不重跑整个入口。

结果/记录复核turn `01a197ed-ccfd-7a81-9333-a308b193faac`通过，57专项加6主方案本地链接目标存在；独立重算集合及范围外索引摘要一致。角色边界补充后，revision368 / turn `01a197f0-d465-7eb3-b7c0-4f770d9f08da`确认可在五文件精确暂存后执行唯一一次实际GUID/32B验收，结果必须分开主证据、清理尾行及最终进程关闭事实。指定Node二进制SHA-256为14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5。暂存目标index1939/范围外1934摘要21283F73F4DC18C287D09577157E81545BE06644151789F09D7618824824A03F；该放行不是现场通过，既有边界保持。

## 21. 单GUID共享与32B往返实际限定通过

revision368现场条件确认及五文件精确暂存后，紧邻固定Node摘要核对，只执行一次第20节集合入口；入口再次核对集合、PS7/配置/csc/CLI、独占根及前置。task=84afcab6-d9e4-4012-ae7d-ea93c40aaebc，hostPID13376；startedUtc=2026-11-01T16:29:32.766Z，reportedUtc=16:29:48.354Z（本地11月2日）。后者是主证据生成时间，不是清理或最终进程退出时间。唯一会话87555随后实际exit0。

| 实际证据 | 观察结果 |
| - | - |
| 前置/编译/manager | 固定PS7 7.6.9、Storage2.0.0.0原生前置通过；PID24072/2752/32264均exit0，signal=null、stderr0，两个helper killRequested=false |
| 空间 | NTFS可用88150302720B，要求168820736B；这是时点预检，不是平台写入硬上限 |
| 实例 | f4a1a1f0-92c8-4e07-880b-170f8f131457，实际startSettled/registered/stopAttempted=true、state=closed；control/execution/connection pending均false |
| 调用 | 10预留/10附着/10观察到启动/10物理关闭，launchUnknown0、pending空；7CLI，结果字符665；最后list PID28808 exit0、42B、未截断，WindowsSandboxEnvironments为空 |
| 卷/路径 | imageId EAC36D69:00100000001260AE，PhysicalDrive1，GUID Volume{1235f230-0000-0000-0000-100000000000}；仅其exchange映射至C:\SuperPiVolume，无普通RW目录回退 |
| 固定容量 | capacity134217728B/imageBudget135266304B；本次只写32B，没有填满，不能记成硬容量拒绝通过 |
| 标记 | 平台接口所载来宾入口exitCode0；宿主实际读32B/matched=true，exchangeId4A307C55:0001000000000024、fileId4A307C55:0001000000000025 |
| 业务读取句柄 | opened2/closed2/peak2，文件和目录均未保留，两个closeError=null、closeUnknown=false；不包含内部元数据句柄 |
| 私有回执 | 433B，opened1/closed1/active0/peak1，读/分配各433B；无未知fd或操作错误 |
| 原生释放 | volume.state/mapping=released，detached/managementClosed/helperClosed/buffersReleased=true、pending=false，manager stderr0 |
| 主证据/尾行 | 主证据sequencePassed=true、passed=false为交付前状态；后续尾行passed/artifactsRemoved=true、removedFiles4、retained=false、cleanupError=null |
| 最终 | 会话exit0后独立只读确认owner根不存在；正常native已删除镜像，四私有叶和空根已清理，无本项遗留 |

源码集合保持c8b77da13b6b8f3771a63d3e42fb8bc789e4286870d369681c9a2b1a5ac4a228；本次生成DLL SHA-256为7be82d4adef3e2507c9e79b5bbe8f2428a18da4074be6443945f2a4f42ec73f4，22016B。运行生成的配置摘要c27fdcbdda4e2bbb565a3054798ed1e79d3214e444b91c4d79600a574eef84a3，只含所属GUID的exchange；网络/剪贴板/音视频/打印/vGPU禁用，内存2048MiB，不重复此前网络或剪贴板矩阵。

| 删除前精确身份 | 记录 |
| - | - |
| 根 | D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner；3938676073:3096224745021562 |
| volume-native.dll | 3938676073:2251799814889647，22016B |
| volume-guest-read.json | 3938676073:10696049116209329，433B |
| volume-helper.json | 3938676073:13510798883315881，525B |
| lifecycle.json | 3938676073:5629499535417520，5711B |

本结论证明固定客户端0.8.107.0在本机接受这一任务专属GUID目录，并完成一次32B往返、安全读取及正常全链收尾；不推广到共享容量满、恶意文件树、异常脱卷或真实工程。未新增代码/测试或重跑已通过项，本次只记录三文档；index1939/范围外1936条stage JSON数组UTF-8摘要E3ED2419CB1B681CD8DFF14310A9CFD7FEA096ED2AFEA1B1FFE6814D413AB3E6，复核后精确暂存，原九删除/patch保留，不提交推送。

下一独立项先审绕过输出包装器的有界直接写入容量探针，固定总写入量/块大小/期限、实际存储不足归因、卷外哨兵和完整收尾；不得把本次正常共享当作容量或异常路径通过。生产真实工作区/默认切换/权限退役继续关闭，P0桌面回放待办。

现场结果/三文档记录复核revision372 / turn `01a197f4-7571-7343-92cc-2bd688e14129`通过，当前状态/进度行已同步；按上述三文档精确暂存，index1939/范围外1936摘要E3ED2419CB1B681CD8DFF14310A9CFD7FEA096ED2AFEA1B1FFE6814D413AB3E6，原九删除/patch保留。下一容量探针范围已审定，须具体代码及定向结果复核后再审一次实际条件，不立即实测。

## 22. 容量直接写入算法：独立离线检查通过

revision372确认下一范围：固定guest C#，一个1MiB非零复用块，最多144次/144MiB请求，20秒循环逻辑期限，原exec保持30秒；首次失败/短写停止，不补写重试。普通文件同步WriteFile、写穿透，不稀疏/压缩/预扩展或跳跃偏移，不做裸盘、异常脱卷或平台总存储。WriteFile返回、刷新和关闭必须分别记录；同步操作可能阻塞，逻辑截止不能证明已结束。[WriteFile官方语义](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-writefile)、[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)、[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)

先交付独立[容量算法](../scripts/acceptance/windows-sandbox-volume-capacity-core.cs)与[纯C#替身](../tests/fixtures/windows-sandbox-volume-capacity-core-check.cs)。它没有PInvoke、文件/进程入口、结果槽或生产调用者。核心保持一个1MiB块，IoResult值类型保留LastWrite原始返回值/错误码/请求和返回字节，成功字节仅计完整成功块，失败的部分返回字节独立保留。首次112/39、其他失败、短写、144次、20秒或无效观测均停止；操作、Flush、Close的原始结果及异常引用分别保存，finally各尝试一次flush/close并清零缓冲。候选检查还要求此前有成功完整块、刷新和关闭成功，不把首写就满或后续错误记为通过。[112/39定义](https://learn.microsoft.com/en-us/windows/win32/debug/system-error-codes--0-499-)

LastLoopCheckMilliseconds只表示最后循环前采样；不称操作完成或整体耗时。1个payload缓冲、1048576B是显式算法分配计数，IoResult按值返回，循环不新建数组/闭包；不是GC/总堆实测，无对象池。结果对象不持有payload数组；测试保留的参数引用也已清零，不宣称擦除所有外部复制。

代码预审发现[检查入口](../tests/windows-sandbox-volume-capacity-core.test.mjs)在进程状态未知或元数据检查失败时先抛错、后交付证据，以及spawnSync自身抛错前未登记调用两处同一P2路径。运行前已改为每次调用前登记固定role/时间/未知PID和退出状态，catch保留有界异常；清理前先交付根身份、已有调用及未知/检查失败状态，再决定是否删除。仅已关闭且身份已确认才逐叶删除；删除数即时更新，rmdir失败另交付保留证据。15秒spawnSync超时是结束请求和等待语义，不是物理完成硬期限；40秒测试期限同样不能终止阻塞的同步等待。[Node官方说明](https://nodejs.org/api/child_process.html#child_processspawnsynccommand-args-options)

revision377 / turn `01a19807-4816-7293-bea9-b3029c0b5b43`复审后，2026-11-01T16:53:43.874Z（本地11月2日）核对三个获审源码、固定Node/PS7/配置/csc，仅运行新单组一次：1pass、0fail/cancel/skip，435.2256ms，外层检查PID8288/status0/signal=null/stderr0。一轮编译两份C#、一个固定PS7加载DLL并调用纯CapacityCoreChecks.Run；没有Storage/Win32业务调用、卷、WSB、程序安装或实际数据写入。

| 定向证据 | 结果 |
| - | - |
| 编译 | PID21468/status0/signal=null/error=null，stdout0/stderr0 |
| 纯检查 | PID21500/status0/signal=null/error=null，stdout172B完整base64交付、stderr0，无截断；16分支通过 |
| 分支 | 112/39；2/3/5/1816/0；首写失败；失败部分返回；短写；144次上限；20秒/负时钟；无效观测；双原始错误；三异常对象分别保留 |
| 分配/调用 | 每轮1个1048576B复用块，最大144次/150994944B请求，全部观测Buffer清零；realStorageOperations=0 |
| 专属根 | .artifacts/volume-capacity-core-check-0f1601d4-7dd4-44aa-9cc3-412a91552d67，dev3938676073/ino2533274791600325 |
| 唯一产物 | capacity-core-check.dll，dev3938676073/ino2251799814889671，9728B，仅纯检查程序集，无实际入口 |
| 清理 | 两进程关闭/身份确认且有界完整证据先交付后，逐叶删除DLL及空根，rootRemoved=true/filesRemoved1，入口exit0，无本项遗留 |

| 获审文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-capacity-core.cs | 8E6E43E3444A41A1E531F650EDBD0DB49B326B96342EA2E6BE478162ABBEC762 |
| windows-sandbox-volume-capacity-core-check.cs | A6339462E5C704EE3AEB2CDCDE310ABB4C21BE1C0F93A3CB02B212FB076BF413 |
| windows-sandbox-volume-capacity-core.test.mjs | 395479DA1FE8376FEDD2A13ADD688D1F149899C83A22665AA4DB67A87F04939E |

本项3代码/检查加3文档，共6文件；暂存前index1939/范围外1936摘要E3ED2419CB1B681CD8DFF14310A9CFD7FEA096ED2AFEA1B1FFE6814D413AB3E6，新增三文件后预期index1942，其余不变。代码先审、单组一次、结果记录复核再精确暂存；不重跑旧矩阵，九删除/patch保留，不提交推送。

后续结果交付契约已另经审核turn `01a197ff-6124-7343-8190-971f51ba2da2`确认：结果槽自身最后写/刷新/关闭不能由同一槽自证；槽内不能预填未来成功。固定平台所载guest退出码0只作为三步交付成功的必要条件，不是容量通过；有限非零状态集合区分交付故障，任意未知/崩溃码不能当状态位，未交付原始错误保持null/unknown。不得重开/补写/重试关闭追求自证，不额外增加结果文件。具体协议、真实Win32适配、卷内安装/预填槽、宿主同卷身份/长度/分配核对及私有哨兵、容量专用3helper+1manager+95CLI预算接线均尚未实现；旧共享入口保持2+1+96及原记录/输出上限。真实硬容量/异常失效/工程接纳仍待后续，生产和默认关闭，P0待办。

结果/记录复核revision378 / turn `01a19809-7a45-7bc3-aad7-8976de2006d2`通过，源码摘要、两根不存在、差异格式及范围外索引摘要独立核对一致；本项六文件精确暂存目标index1942/范围外1936摘要E3ED2419CB1B681CD8DFF14310A9CFD7FEA096ED2AFEA1B1FFE6814D413AB3E6。下一步按已审契约实现固定槽协议与guest Win32包装，具体代码另审后再做定向验证，仍不直接填盘。

## 23. 固定容量结果槽与来宾封装：离线定向完成

按第22节已审交付契约，实现固定512B初始/最终槽、guest Win32封装和宿主严格解码。本项先审后测，尚未运行有效来宾入口、卷内安装、WSB或容量填充。文件分别为[协议C#](../scripts/acceptance/windows-sandbox-volume-capacity-protocol.cs)、[guest](../scripts/acceptance/windows-sandbox-volume-capacity-guest.cs)、[宿主解码](../scripts/acceptance/windows-sandbox-volume-capacity-protocol.mjs)与[C#纯夹具](../tests/fixtures/windows-sandbox-volume-capacity-guest-check.cs)、[两组检查](../tests/windows-sandbox-volume-capacity-guest.test.mjs)。

槽以固定magic、32字节任务标识绑定，数据区域含阶段、停止原因、请求/成功计数、最后循环前时间、最后返回的Write及Flush/Close结果与异常。200..511为零保留区；初始槽与最终槽不可混用。guest只使用两个固定普通文件，CREATE_NEW数据文件、OPEN_EXISTING结果槽、独占共享、同步写穿透及重解析/类型检查；先校验全部初始512B再回卷首。其Win32结构/打开标记只完成静态核对，尚未证明固定WSB共享层实际支持。[文件信息结构](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)、[CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)

数据和槽各自Write/Flush/Close及异常分别保留，所有关闭最多尝试一次；交出关闭责任前先设标记，防止关闭回调在自身标记前抛错时重试。槽不预填自身未来成功；0仅是交付完成的必要条件，有限非零集合65/66/68/69/70/72/73/74/76/77/78区分故障，96..99为未交付，其他值unknown。未传送的槽原始错误始终null；已成功的数据操作也不冒充观察到GetLastError=0。最后返回的Write在后续调用抛异常时可能属于此前调用，不能当作最后一次请求的返回。宿主解码分别提供diskFullWrite、dataFinalized和qualifiedWriteCandidate，没有host acceptance。

revision381发现P2：从退出码推导的三个状态误标platform-interface。运行前已改为source=guest-report、interfaceSource=platform-interface，与既有来源契约一致；revision383确认最终源码。平台承载退出码，不独立证明来宾所报操作，也不认证具体进程来源。

| 定向阶段 | 实际证据 |
| - | - |
| 首次两组 | 2026-11-01T17:16:24.946Z，outerPID30868/status1，总150.1696ms；1pass/1fail。第一组止于夹具CS0136：外层输出变量result与foreach局部同名；25分支/跨语言检查当时未运行 |
| 首次编译/清理 | PID32948/status1，stdout221B完整原始base64、stderr0；无DLL、未启动纯检查PS7。根volume-capacity-guest-check-4681961c-b200-4aea-a28d-ffe0ac8eac7a，dev3938676073/ino2814749768310855，files[]，rootRemoved=true/filesRemoved0 |
| 已通过第二组 | 有限退出状态、未知/崩溃码及来源标签断言一次通过，0.391ms；后续不重跑 |
| 最小修复/复审 | 仅夹具末尾result改名outputJson；revision385 / turn 01a1981d-3aa9-7d43-9d0d-966eb7b9c579确认精确过滤第一组恢复一次 |
| 恢复第一组 | 17:19:24.144Z，outerPID9012/status0，1pass/0fail，总470.2165ms、单组408.4529ms；没有第二组或旧核心重跑 |
| 恢复子进程 | 编译PID6772/status0/stdout0/stderr0；固定PS7纯检查PID30152/status0/stdout1463B完整base64/stderr0，均signal=null/error=null |
| 纯证据 | 25分支，Native.Calls=0；两种跨语言512B样本分别为容量候选与无写入deadline，二者均可交付0但候选不同；布局/畸形字段/任务/长度/保留字节拒绝、双数据错误及关闭不重试检查通过 |
| 分配/释放 | 核心仍1MiB复用块，本夹具完整guest运行最多2次Fake写；数据块及GuestRunner持有的交付payload清零，解码结果只持值、不保留输入Buffer。不是总堆/GC测量，无池、无生产/捕获热链变更 |
| 恢复清理 | 根volume-capacity-guest-check-6bac2617-7d74-405f-8269-f569fada8888，dev3938676073/ino1970324838179040；唯一capacity-guest-check.dll，ino1970324838179053，19456B。证据先交付、子进程关闭/身份确认后删DLL和空根，rootRemoved=true/filesRemoved1 |

| 最终文件 | SHA-256 |
| - | - |
| capacity-protocol.cs | 33BCB53B827114DA8B78832DC81FC81A755DB2E46CF286BD28437AF895484432 |
| capacity-guest.cs | C007C74FF93240C2C508E3B0CCB54753F9BB3457B9FEF322CE939C3A20AF1F90 |
| capacity-protocol.mjs | 9FD2E4466B4570083AEDC6197F92B6B9F795E5D76975271FD125444C46E9E74C |
| capacity-guest-check.cs | 5B2F0E3C61F62B3C2FDD8E4FCC9E5AB41FEB5F9C0B743C02153CA67B1D5CCDB4 |
| capacity-guest.test.mjs | 3E52BFB01ED6DE94DC08999BCD6755AF728905949FAF41E36C99F5CC72CAB9E0 |

本项5新增源码/检查加3文档，共8文件。暂存前index1942/范围外1939条stage数组摘要A91D5F167EEA3FCE81F7D6EF59EDD8A453784CD1CA8F39160A751DF787134A5B；新增5文件后预期index1947，范围外索引不变，九删除/patch保留。下一宿主安装/读回代码另项进行，不能混入本项暂存；结果和记录复核后精确暂存，不提交推送。

下一项为宿主在所属卷安装固定probe、真实预写并刷新槽、登记私有哨兵，以及VM/CLI实际关闭后的同卷身份、EOF和Allocation核对。小槽预写不担保满卷时必然交付；真实填充文件的分配量证据独立检查，不把MFT小文件逻辑长度当外部分配证明。[微软MFT说明](https://learn.microsoft.com/en-us/windows/win32/fileio/master-file-table) 容量专用3helper+1manager+95CLI接线、完整具体代码/检查及新源码集合复核后，才讨论一次现场条件；当前共享硬容量、异常失效和工程接纳仍未通过，生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

结果/记录复核revision387 / turn 01a19821-0925-7832-80a1-ff9f2b507c14通过；仅修文件末尾多余空白并保留正常换行，不重跑测试。按本项八文件精确暂存，目标index1947/范围外1939摘要A91D5F167EEA3FCE81F7D6EF59EDD8A453784CD1CA8F39160A751DF787134A5B；下一宿主草稿留在工作树范围外。

## 24. 宿主容量安装与读回组件：离线预审和定向检查通过

实现可选[NativeDisk partial](../scripts/acceptance/windows-sandbox-volume-capacity-host.cs)，既有native.cs只增加partial声明；旧共享入口不编入此组件。尚无helper控制命令、owner调用或实际入口接线。本项没有安装探针、挂载、有效guest入口、WSB或填盘。

InstallCapacity从已持有的VHD/卷及exchange身份出发，打开宿主私有固定capacity-probe.exe，限制65536B，按持有句柄核对普通属性、单链接、同卷身份、最终路径、长度前后及固定SHA。仅CREATE_NEW写所属exchange内exe、实际预写512B初始结果槽并刷新，再写32B私有哨兵；镜像、源exe、管理入口和哨兵均不共享。读取/写入是固定次数及大小，没有文件树遍历、稀疏/压缩/预扩展，也不以小槽的逻辑长度证明其外部分配量。

ReadCapacity保留同一slotId的512B诊断Base64，后续失败不清除已读诊断；然后核对普通单链接填充文件的最终GUID路径和所属卷，要求EOF至少1MiB、Allocation至少EOF且均不超过128MiB，最后核对私有哨兵原身份/32B内容并重新验证VHD/exchange。这只证明指定哨兵，不能扩张为任意卷外路径安全；该层没有guest报告通过决策。VM/CLI实际收尾的准入由后续真实owner接线承担，不能因存在此方法就提前调用。

业务句柄采用9个固定唯一槽，安装5个、读回4个，实际代码最大同时3个；这不含既有元数据验证链临时句柄。账本先标记已尝试再关闭，false返回保留原始码和精确句柄，桥接抛错保留句柄/unknown且原始码null，其他槽仍尝试关闭，重复清理不重试。NativeDisk.CloseUnknown在finally传播到既有解除/关闭/删镜像门槛；原操作异常优先于关闭异常，九项错误另行保留。正常释放槽引用置零，诊断快照返回副本。固定小缓冲在finally清零，无对象池或生产/输出热路径改动。

预审发现跨文件P2：宿主小文件可接受非负Allocation，但此前guest Shape仍要求Allocation>=EOF。这里是确定判据不一致，不推定本机或共享层一定返回0。最小修正抽出guest纯CheckShape，仅接受长度0或512，保持EOF、单链接、普通属性、非删除和全部初值内容检查，允许Allocation非负；真实填充文件的严格分配判据保持独立。[微软FILE_STANDARD_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)、[MFT说明](https://learn.microsoft.com/en-us/windows/win32/fileio/master-file-table)

revision390 / turn 01a19827-aaab-77f2-a7ad-104ca5de06e1复核最终集合后，2026-11-01T17:29:28.942Z仅运行新的[host单组](../tests/windows-sandbox-volume-capacity-host.test.mjs)一次：1pass/0fail，单组492.1715ms、总540.3568ms，outerPID33644/status0/signal=null/stderr0。

| 证据 | 结果 |
| - | - |
| 编译 | PID13400/status0/stdout0/stderr0；native/host/core/protocol/guest/纯夹具编为library |
| 纯检查 | 固定PS7 PID29660/status0/stdout153B完整base64/stderr0，无截断 |
| 分支 | 30：元数据普通/驻留小文件/目录、属性/链接/路径/卷/长度/分配拒绝；正常/重复关闭、混合原始失败与抛错、精确未知句柄、错误快照副本、原异常优先、ABI；六个guest小槽/空文件规则 |
| 原生边界 | 不构造NativeDisk、不调用其任何I/O方法；夹具固定报告nativeDiskInstances=0/win32EntriesInvoked=0，额外断言guest.Native.Calls=0；这些是本纯夹具调用范围，不是进程级原生调用遥测 |
| 替身责任 | 固定9槽、峰值3、两未知句柄保留，失败关闭重试0；正常槽全部清零 |
| 专属根 | .artifacts/volume-capacity-host-check-93d540b8-3d21-4dff-b266-23d2d2b476d7，dev3938676073/ino1970324838179076 |
| 唯一产物 | capacity-host-check.dll，ino2251799814889734，50176B，两个子进程关闭后按身份删除 |
| 清理 | 有界完整证据先交付；rootRemoved=true/filesRemoved1，单组exit0；未产生VHD或实例 |

| 最终文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-native.cs | BBB77200DAFF31E15B3424EE099A69C2EE67C63DB720B598D9DF61D832A5E678 |
| windows-sandbox-volume-capacity-host.cs | 750F9BFBC92AC3D6DC18391419A65EEB39B26FB7C452A995F48E189A0AA8BE07 |
| windows-sandbox-volume-capacity-guest.cs | E1C139FE57D70F269EF3D61569469A63D63B62F37091B937725896918BA27B5F |
| windows-sandbox-volume-capacity-host-check.cs | 175377286557956FA72FF6347D045FB3C6D0645D027C8DFCFC8CEBE8409F8156 |
| windows-sandbox-volume-capacity-host.test.mjs | CF47B5DB8B42B2AF12A2C1B5EBA125DF582668EE29B51E75C546F96AAF0AAC35 |

本项5源码/检查与3文档，共8文件；index1947/范围外1942摘要47372AE65AFA9B5B47B5ABDA314AC3194708CA3E92A5D554580E890C2F9B6C21，新增3文件后预计index1950，范围外不变。旧guest两组、容量核心和所有旧矩阵不重跑；九删除/patch保留，下一回执/接线草稿不混入本项暂存，复核后精确暂存，不提交推送。

旧GUID实际证据仍对应其历史c8b77…集合；native.cs新增partial已改变当前源码集合，旧摘要不能用于恢复任何入口。下一项审固定回执及helper/owner容量命令、3helper+1manager+95CLI/99总调用、完整收尾和新源码集合。共享硬容量尚无实际证明，异常失效和工程接纳未完成；生产真实工作区/默认切换/权限退役继续关闭，P0桌面回放待办。

结果/记录复核revision391 / turn 01a19829-f030-7c43-88fb-f8a8a2745bb4通过；按本项八文件精确暂存，目标index1950/范围外1942摘要47372AE65AFA9B5B47B5ABDA314AC3194708CA3E92A5D554580E890C2F9B6C21。下一回执/helper/owner草稿留在本项索引范围外。

## 25. 容量固定回执与helper/owner准入：七组定向通过

新增[容量回执](../scripts/acceptance/windows-sandbox-volume-capacity-receipt.mjs)，并在现有固定PS7 helper、TaskVolumeOwner和LiveSandboxRuntime接线；没有实际容量执行入口。helper只新增install-capacity/read-capacity两种不接受路径的控制请求，容量模式须传固定probe摘要，启动前重新检查宿主probe普通单链接/65536B上限/摘要；旧模式没有该参数就拒绝容量操作，无PS5回退。

安装仅准入同任务未绑定/未派发VM，读回仅准入所属实际VM已关闭、实例不存在及全部CLI关闭；一次性标记先记，读租约阻止提前释放，save后复核撤销和同一runtime，reply后复核卷/安装身份及回执。未知关闭、身份或协议失配触发unsafe并保留责任；普通已明确关闭的操作失败可在静止条件下释放。未绑定runtime只在构造时建立一个带taskId的固定视图，read不按进度新建对象，dispose清除此视图；既有分块捕获回调未改、packages无生产调用者，不引入池或无关基准。

回执精确限定字段、task/volume/exchange/probe摘要、原probe/slot/私有哨兵身份、九槽错误/未知句柄、计数及512B canonical Base64；错误码缺失保持null，桥接异常可保留句柄而没有原始码。宿主元数据与guest payload分别解析，capacityEvidence只形成必要候选条件，仍依赖外层所有收尾和清理。helper在finally保存固定<=4096B容量回执，普通/身份失败另有固定错误叶；journal失败终止控制，不据此释放。

revision394 / turn 01a1982e-d8ef-7073-9412-174f9a8867c4先审后，2026-11-01T17:41:12.274Z仅执行新[owner六组](../tests/windows-sandbox-volume-capacity-owner.test.mjs)与[helper单组](../tests/windows-sandbox-volume-capacity-helper.test.mjs)一次，串行并发1：7pass/0fail，总986.1368ms，outerPID24948/status0/signal=null/error=null/stderr0。旧guest/核心/GUID/旧矩阵未重跑。

| 新定向范围 | 结果 |
| - | - |
| owner六组 | 安装前/真实关闭后一次性；已绑定VM与journal撤销拒绝；pending安装阻止释放/runtime变化保留；关闭未知/身份/结构失配阻断；普通失败保留诊断并正常释放；来源/元数据/交付分开 |
| helper单组 | 880.6586ms；一次native base library编译，一次固定PS7只AST选择五个定义，替换native/VerifyReady/WriteEvidence/Release；真实helper顶层不执行 |
| 编译子进程 | PID32632/status0，stdout0/stderr0 |
| PS7纯检查 | PID27428/status0，stdout113B完整base64/stderr0，无截断；14分支、nativeConstructors0、realStorageOperations0、helperParsed=true |
| helper分支 | 安装/读取各一次，九null槽JSON往返；重复拒绝；普通失败/关闭未知/身份失败；后续失败仍保留已读结果；journal失败阻止释放；未安装/无摘要拒绝；两个命令及额外path字段拒绝 |
| 责任与性能 | 未决业务租约阻止释放；正常替身manager关闭/runtime解绑；一个未绑定视图及固定九槽快照，不引入生产进度分配；不是进程级内存或Win32遥测 |
| 专属根 | .artifacts/volume-capacity-helper-check-c2716f2c-ca27-4fee-a30f-d459749623d4，dev3938676073/ino1970324838179084 |
| 唯一产物/清理 | capacity-helper-check.dll，ino2251799814889742，22016B；子进程实际关闭、证据先交付后按身份删DLL与空根，rootRemoved=true/filesRemoved1 |

| 最终文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-capacity-receipt.mjs | 76883027571BD6DF10331E23F9A146DD8A661AD1F23E85349B305162482525AA |
| windows-sandbox-volume-helper.ps1 | E949552DA42D7F3440C687498E30C6208255A1D829E79A5414D13F272D2578F8 |
| windows-sandbox-volume.mjs | 73697282AE70AEFE3EB7CFA20EFD4E4F32F48D476658DD48313B9B9407CF54EC |
| windows-sandbox-volume-sharing.mjs | CDA28AB24C3FF300421FFE563571574EE8D53A91B49D671E143076396B92D30B |
| windows-sandbox-volume-capacity-owner.test.mjs | 95E241A61405E55CF6DDAED0095D1DD254443DC60E38DA10A3984FDD6F37E238 |
| windows-sandbox-volume-capacity-helper.test.mjs | A7D1D6837382305E89AE33369F3C6E8DA9AD44F27617AE716AE20B90179171AB |
| windows-sandbox-volume-capacity-helper-check.ps1 | 38CB043F544911354F5EF76B5FBE6CD57FE8913CD4EF3CBDDE2A1FE7DFB1ECE3 |

本项7源码/检查加3文档，共10文件；index1950/范围外1944条摘要A7630584C185FD1B5CE44AD5E57DDAF06FCCCF68166EBDE5795689E7A3E6FA75，新增4文件后预计index1954，范围外索引不变。下一容量外层预算/固定编排/真实adapter及共享源码清单草稿另项审查和暂存，不能混入本项。九删除/patch保留，复核后精确暂存，不提交推送。

当前有界回执和owner准入完成离线检查，仍未实际安装、读取或容量实验。下一项须固定3helper+1manager+95CLI/99总预留，容量清理叶清单、源码闭包、完整输出预算及最终物理派发校验；审具体代码和新定向结果后再讨论一次现场条件。共享硬容量、异常失效和工程接纳尚未完成，生产真实工作区/默认/权限退役关闭，P0桌面回放待办。

结果/记录复核revision395 / turn 01a19834-89e8-7480-a44a-2caf3e2a338e通过；本项十文件精确暂存目标index1954/范围外1944摘要A7630584C185FD1B5CE44AD5E57DDAF06FCCCF68166EBDE5795689E7A3E6FA75。下一容量外层及源码闭包草稿保持范围外，不重跑检查。

## 26. 容量外层、真实入口与源码闭包离线完成

容量入口采用独立3helper+1manager+95CLI、总99物理预留/4未决预算，旧共享仍为2+1+96；8192B journal、7680B主证据、512B尾行不变。新增固定容量编排与真实adapter：prepare→安装→单VM/单exec→确认VM及所有CLI关闭→一次诊断读回→release/exit；guest交付失败仍可保留原始512B诊断，不能变成通过，关闭未知保留责任。最终exec同时复核原安装对象、卷/VM/运行时许可，CLI源码及工具复核在物理预留之后。

容量清理profile仅允许13个固定宿主私有叶（含6个操作错误叶），按登记身份逐叶处理，拒绝额外镜像或身份变化；正常样本实际7叶。安装/读回的宿主元数据与guest-report分开，容量候选仅是必要条件，最后仍需实际收尾与证据交付。共享旧manifest补齐protocol/receipt两个静态依赖至18文件；容量闭包24文件。无生产调用者、未改变既有分块捕获热路径、不引入池，固定计数/复用缓冲及终态引用释放保持。

revision398发现95CLI专用预算拒绝时，VM预留的第96记录未被撤回，可能妨碍最终95条快照与责任记录。所有factory前准入/预算拒绝改为既有UndispatchedError，使真实SandboxLifecycle撤回临时记录；factory已调用后的异常仍按未知派发保留。没有提高上限或吞掉错误。

revision400 / turn 01a1983a-7a2c-7061-a491-dd8a8ed277e9代码复审后，2026-11-01T17:57:33.740Z只运行新增六组和精确受影响旧manifest一组一次，串行并发1：7pass/0fail，总137.4233ms，outerNodePID1836/status0/signal=null/error=null/stderr0。未运行其他旧组，未产生helper、编译、存储、WSB或文件写入/临时产物。

| 定向证据 | 实际结果 |
| - | - |
| 完整容量替身组合 | 单次exec、原始512B保存、7CLI/7manager命令/11物理替身，7精确叶清理，2输出回调 |
| 最终派发守卫 | 安装对象替换、卷独立撤销、预留后源码/工具/许可改变均阻止factory |
| 失败责任 | 非零交付仍保留诊断且最终false；关闭未知/未决exec保留owner与文件 |
| 预算组合 | 真实Lifecycle组合95个假调用后，第96请求拒绝；factory/记录/快照均95，可完成报告及引用释放 |
| 清理与源码 | profile拒绝额外镜像和身份变化；24文件闭包；旧manifest受影响组18文件 |
| 容量编码样本 | journal峰值7490B、主证据6223B、尾行175B，低于既有上限；不声称覆盖全部可达状态 |
| 旧manifest编码样本 | pretty6201B/main4828B/failure6792B；realProcesses/realReceiptHandles/filesystemWrites均0 |

本项6源码/检查与3文档，共9文件；index1954/范围外1948摘要703F25A79EC798535AB4A846BEBC691EA5DC154C26DCF8219F8D31AB6AD66987，新增3文件后预计index1957，范围外不变；九删除/patch保留，复核后精确暂存，不提交推送。

### 26.1 固定容量源码集合与一次现场条件

当前集合协议super-pi-capacity-sources-v1，按下表顺序将相对路径和小写SHA-256组成files二维数组，与protocol一起JSON.stringify为UTF-8无换行；总源码260788B，24文件，集合SHA-256为bd2b96fd01acdff28c73cea9d9c4ec5e741dc4701e49dea99f0c591599be7866。单源码131072B、总1048576B上限保持。历史GUID集合仅对应历史实测，不能代替本集合。

| 文件（scripts/acceptance/） | SHA-256 |
| - | - |
| windows-sandbox-clipboard.mjs | bc96e0fa0266b74fea450e64926218cafc120ba919a55d992d2ee73b8954896f |
| windows-sandbox-fixed-acceptance.mjs | b7551b3c41db0e9b029dd11413875f68f1a81a67b8e8c543c215a290e2dfc599 |
| windows-sandbox-guest.mjs | 622f25061b4076a6c7fdb673e9faee8adff4479fd4bf359a39affb2795bbf5dc |
| windows-sandbox-lifecycle.mjs | 590cb363408a8a3830082e0f8cc2b1526003a484023d51ec68e93fb15212777c |
| windows-sandbox-package.mjs | 9c727a392e2f25a3785002342f36fbf5dc479c9cdcd164ed79c1535aa3059ad7 |
| windows-sandbox-powershell7.config.json | 7ad7607adf83f5df57f786d85911facef02103f42d3f6b5e1ee1fde2b8778e51 |
| windows-sandbox-volume-capacity-protocol.mjs | 9fd2e4466b4570083aedc6197f92b6b9f795e5d76975271fd125444c46e9e74c |
| windows-sandbox-volume-capacity-receipt.mjs | 76883027571bd6df10331e23f9a146dd8a661ad1f23e85349b305162482525aa |
| windows-sandbox-volume-config.mjs | 77f1a2532b185492e657a177445dbf15087cb2f7be46a17aeca8ed6f12b72ca6 |
| windows-sandbox-volume-guest-read.mjs | b6fd0175bdf76657cfc4d366b1234fc9014261870b9ae645578240cd6812bf22 |
| windows-sandbox-volume-helper.ps1 | e949552da42d7f3440c687498e30c6208255a1d829e79a5414d13f272d2578f8 |
| windows-sandbox-volume-native-acceptance.mjs | e4a269c0d347a9e7cf3a6c5b10c61f938862cee96939eefbd789914e10e758b3 |
| windows-sandbox-volume-native.cs | bbb77200daff31e15b3424ee099a69c2ee67c63db720b598d9df61d832a5e678 |
| windows-sandbox-volume-session.mjs | cfd2e117623c10d7c32de9ff4039e20fa469f0b5ac3982b9e2ffa7604dd7adcd |
| windows-sandbox-volume-share-acceptance.mjs | 104dfd075c5fc357f86917e1a48e8cbcc39e3cc0aab4aa80df35c6bd365d8732 |
| windows-sandbox-volume-share.mjs | 5a547bba876ef174b65057f23cc3be339a4ca13f1600fc5e225beb12c8de3686 |
| windows-sandbox-volume-sharing.mjs | cda28ab24c3ff300421ffe563571574ee8d53a91b49d671e143076396b92d30b |
| windows-sandbox-volume.mjs | 73697282ae70aefe3eb7cfa20efd4e4f32f48d476658dd48313b9b9407cf54ec |
| windows-sandbox-volume-capacity-core.cs | 8e6e43e3444a41a1e531f650edbd0db49b326b96342ea2e6be478162abbec762 |
| windows-sandbox-volume-capacity-protocol.cs | 33bcb53b827114da8b78832dc81fc81a755db2e46cf286bd28437af895484432 |
| windows-sandbox-volume-capacity-guest.cs | e1c139fe57d70f269ef3d61569469a63d63b62f37091b937725896918ba27b5f |
| windows-sandbox-volume-capacity-host.cs | 750f9bfbc92ac3d6dc18391419a65eeb39b26fb7c452a995f48e189a0aa8be07 |
| windows-sandbox-volume-capacity.mjs | 550d54aa4771119e0035c24a0e3d79e6c30277b41ecd494f87f3d9993712ea11 |
| windows-sandbox-volume-capacity-acceptance.mjs | 1102b34bbbb11a99ccb95ad5a37e1e900c6f420bfbf8e950567af615697afcf0 |

拟恢复条件：结果/记录及具体现场范围复核通过并精确暂存，紧邻启动核对固定根不存在及源码/工具身份；使用唯一新128MiB固定VHD、唯一所属GUID exchange、一个禁网/禁剪贴板共享VM、一次固定guest程序。一个复用1MiB非零块，最多144次/144MiB请求，20秒仅逻辑循环期限、外层exec30秒，首个失败/短写即停，不自动重试。仅实际存储不足112/39且先有完整写成功可形成容量候选，路径/权限/超时/上限不算容量证明；Write/Flush/Close及交付状态分别保留。

VM及CLI实际关闭后，保持卷附加读取原slot、同卷普通单链接fill的EOF/Allocation、私有32B哨兵与卷身份/容量；随后关业务句柄、解除附加、manager实际退出，输出后按固定身份清理自有产物。未知关闭或身份变化保留owner并阻止下一任务，不以清理内存代替释放。只检验专属共享区硬容量，整体WSB平台写入风险沿用已接受契约；不认证guest进程来源，不把guest退出0当容量成功。现场尚未执行，共享硬容量、异常失效与工程接纳尚未完成；生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

revision405 / turn 01a19847-5cd3-7593-87f6-0ee61863f6b8结果/记录/九文件范围及本固定集合一次现场条件复核通过；精确暂存目标index1957/范围外1948摘要703F25A79EC798535AB4A846BEBC691EA5DC154C26DCF8219F8D31AB6AD66987。暂存后紧邻启动复核，通过后只运行本节固定入口一次；现场结论另行复核，不自动重试。

## 27. 唯一容量现场取得存储不足事实，最终记录检查失败保留

revision405条件通过，九文件精确暂存后index1957/范围外1948摘要不变；2026-11-01T18:04:57.344Z紧邻重核根不存在、固定Node/PS7/csc/WSB与24源码集合均匹配。仅执行§26集合bd2b96fd01acdff28c73cea9d9c4ec5e741dc4701e49dea99f0c591599be7866的一次入口；没有重跑旧矩阵。

| 实际任务/归属 | 证据 |
| - | - |
| task / 原会话 / host | 15f06cbc-9d54-4186-b556-1021d963a382 / 20189 / PID30244 |
| 时间 | startedUtc=2026-11-01T18:05:02.417Z；reportedUtc=2026-11-01T18:05:19.567Z，后者不是进程最终退出时间 |
| 专属根 | D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner；rootId=3938676073:2533274791600426 |
| 三helper | preflight24616、compile-native30716、compile-guest31880，均exit0/closed；仅固定PS7 |
| 固定二进制 | native38912B，SHA 0aef619b4b514b24ded65b8324e241eb82a6a56fed7dcdff134b25c846f85153；guest13824B，SHA 68be63d7fe384b9af3a115317b41e9cdb007a7f7084fedcc6e9df128f39bf08d，宿主未执行guest程序 |
| VM | 17e9d317-230f-41af-a9f8-b7440801849f，closed；7CLI全部关闭，最终list PID32480/exit0且WindowsSandboxEnvironments为空 |
| 物理对象 | 11reserved/attached/started/closed，launchUnknown0，pending[]；manager27920实际exit0/buffersReleased=true |
| 镜像/磁盘 | imageId=EAC36D69:0015000000126151；diskId=task；\\.\PhysicalDrive1；capacity134217728/imageBudget135266304 |
| 卷/目录 | \\?\Volume{d74950f0-0000-0000-0000-100000000000}\；exchangeId=E8874742:0001000000000024 |
| 安装身份 | probe=E8874742:0001000000000025；slot=E8874742:0001000000000026；私有sentinel=EAC36D69:001A000000126142 |
| 宿主读回 | fill=E8874742:0001000000000027；EOF=Allocation=119537664（114MiB）；原slot身份匹配、私有哨兵匹配；九业务句柄九开九关/峰值3/unknown=false |
| 卷正常释放 | state=released、mapping=released、detached/managementClosed/helperClosed=true、pending/reading/closeUnknown=false |
| 原最终输出 | complete=false/reason=journal-or-report-bound；尾行passed=false/artifactsRemoved=false/retained=true/removedFiles0/cleanupError=Combined final record bound |

原现场没有全链通过：在补入七叶清理清单后，最终格式化JSON检查失败，证据退化输出并保留原Node owner及七个宿主小文件，未自动删除或重跑。实例、卷、manager实际收尾与owner/文件残留是不同事实；不能把前者改写成整个入口成功。

### 27.1 一次只读诊断与明确根因

revision407确认内容范围，409/411指出错误回执command关联、关闭未知保留、输出降级与换行预算问题；修正内联只读脚本后revision413 / turn 01a1984f-49d2-75a0-9f5c-2057a1420a8a复审通过。2026-11-01T18:11:55.071Z仅查询本固定根七叶元数据，并各一次读取lifecycle及两份容量JSON；无错误叶、未读取DLL/EXE/哨兵、未重新访问卷、未查询实例或进程。诊断PID31208实际exit0，3开3关/unknown[]，complete=true；原会话继续保留。无临时文件。

每次按固定根/叶身份、大小、同句柄前后mtime/ctime核对，最后metadata清单一致；正文缓冲清零。原始已落盘对象与内存补manifest的诊断对象严格区分：

| 内容 | 实际字节/摘要 |
| - | - |
| 原lifecycle | 7730B，SHA 9ad3d09f3d8e291c910c58ee714a2b32cbb587248e1c62b505a6310e7cdb6c9b；原files=[]，compact6114B（不含换行） |
| 原install回执 | 724B，SHA fe70e8eaedd5604ad2acfb45129c1cde6087d5a66698ca148545e30b3718b88c |
| 原read回执 | 1440B，SHA 16256b2a61744dc723356f58ca0ca9c3d3087be97e1fb935dd83ed80e1c75c61 |
| 仅内存补当前manifest | pretty8536B；compact含换行6680B；不是原始完整输出 |
| 具体失败 | completeSharingSession在save后添加files，再对未写入journal的最终对象执行pretty<=8192检查；8536>8192，后续compact<=7680检查尚未执行 |
| 样本遗漏 | 先前短合成root/身份/transport的离线编码样本未覆盖实际长度，7490B样本不能作为全部状态上界 |

原guest-report严格解码：phase3/stop1，attempts115/successfulCalls114，requestedBytes120586240/successfulBytes119537664；最后返回的WriteFile=false、原始error112、request1048576/transferred0，lastLoopCheck104ms。数据Flush/Close均返回成功，原始错误码null，无operation/flush/close异常；diskFullWrite/dataFinalized/qualifiedWriteCandidate均true。经platform-interface承载的guest退出0仅作槽交付必要条件，仍标guest-report，不认证具体进程来源。宿主EOF/Allocation、卷容量与哨兵核对及实例实际关闭提供独立宿主事实。

同一已读内存槽严格解码一次，没有再次读取文件或运行guest。完整512B原始槽（base64）保留如下：

```text
U1BDRjAwMDExNWYwNmNiYzlkNTQ0MTg2YjU1NjEwMjFkOTYzYTM4MgMAAAABAAAAcwAAAHIAAAAAADAHAAAgB2gAAAAAAAAAAQAAAAAAAABwAAAAAAAQAAAAAAABAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAJAAAAAgTgAAAQAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
```

| 保留叶 | 文件身份 | 字节 |
| - | - | - |
| volume-native.dll | 3938676073:2251799814889810 | 38912 |
| capacity-probe.exe | 3938676073:1688849861468499 | 13824 |
| capacity-host-sentinel.bin | 3938676073:7318349395681602 | 32 |
| volume-capacity-install.json | 3938676073:2814749768311126 | 724 |
| volume-capacity-read.json | 3938676073:10977524092920148 | 1440 |
| volume-helper.json | 3938676073:10414574139498837 | 525 |
| lifecycle.json | 3938676073:4503599628575063 | 7730 |

七叶合计63187B，无VHD；原owner的空定时器只持有责任，不轮询/重试VM或存储。下一步仅审纠正最终检查对象的最小代码与真实长度形态离线回归，以及原owner身份绑定后的外部退出/精确清理；不提高8192B日志或7680B输出上限，不为此重复写满容量。当前原入口仍失败，限定容量事实与收尾恢复结论须另行复核。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision415 / turn 01a19850-2206-7973-97b6-bbded86c8655复核：上述事实采纳为本次固定配置/负载下的限定容量证据；原入口失败与自动收尾未现场通过保持。诊断已捕获输出实际12185B（含换行），不需重读。104ms只是最后一次循环期限检查值，不是实验总耗时。最小检查对象修正与外部恢复范围通过，具体代码仍须先审。

## 28. 最终记录检查修正与原任务外部收尾完成

revision415确认本次错误是检查对象混用，不是预算不足。[会话实现](../scripts/acceptance/windows-sandbox-volume-session.mjs)仅删除最终未持久化对象的pretty8192检查；sessionJournal仍对每次实际日志严格限8192B，最终实际紧凑输出仍限7680B（含换行），尾行512B。失败路径若尝试保存附带清单的对象仍受journal约束，未放宽任何真实写入或输出限额。

新增[现场形态fixture](../tests/fixtures/windows-sandbox-volume-capacity-record.json)只保存已读取的原始日志对象及七叶manifest，明确属于旧任务清理前时点；新增[单组回归](../tests/windows-sandbox-volume-capacity-record.test.mjs)精确复现7730/8536/6680B，使用真实SharingLifetime与纯内存文件/进程/输出替身验证清理和引用责任。fixture不含二进制或宿主剪贴板内容。

revision421 / turn 01a19854-8099-7ce2-aae8-74ec8eceda56代码复审后，2026-11-01T18:20:39.926Z仅运行该新组一次：1pass/0fail，组4.2182ms、总62.2563ms，testPID31104/status0/signal=null/error=null/stderr0；realOperations=0，journalPeak7917B/main6680B/footer175B，11物理替身、7精确叶、2输出callback、任务引用及监听全部释放。无临时产物，不重复其他新旧检查，不重跑容量现场。

| 本项文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-session.mjs | D9B098F737C63A005DA75CAF3B256C2C9C0972F287AAF4DA4A92F0FFB10B1608 |
| windows-sandbox-volume-capacity-record.test.mjs | 74582CEBFDB4A50FBD163F7CA6D36C0DA16790B1E88CFE4B15948C51CDDC4943 |
| windows-sandbox-volume-capacity-record.json | 35AD34F8DC6BF96F3452BD7B0B24664ADCBB33F637027BF60618E82814F7E047 |

### 28.1 外部退出确认与七叶精确清理

恢复脚本仅内联执行、不落临时文件。revision421先指出未匹配命令输出与有界失败记录问题；修正后turn 01a19858-4677-77f0-9504-1d804faee08a复审通过，才以固定PS7/项目配置执行唯一一次。先持有目标Process.Handle，再核对同一对象的创建时间/固定路径，以及同一PID的CIM路径/完整命令；未匹配内容只登记长度/摘要/匹配结果，身份确认后才输出已知命令。两种创建时间按CIM六位小数精度严格比较，并保留原始值及启动区间，不用PID猜测其他进程。

| 退出证据 | 实际结果 |
| - | - |
| 唯一目标 | host PID30244；进程创建2026-11-01T18:05:02.3057791Z，CIM时间18:05:02.3057790Z；六位小数一致且落在18:04:57.344Z至18:05:02.417Z原启动区间 |
| 身份 | imageMatches/cimImageMatches/commandMatches/identityVerified=true；完整命令211字符，SHA 5FC705BB9868A524BB8EEEF81C6303FEE7132EAEBF66C426DE0086969A3DB127，原bd2b96…集合 |
| 操作 | 同一已持有进程对象Kill(false)一次，非进程树；heldHandle2092，exited=true/exitCode=-1/handleClosed=true，operationError/closeError=null，outputComplete=true |
| 外层确认 | 恢复工具实际exit0；原会话20189实际exit1，没有新增输出，不重写旧failed结论；不操作helper/VM |

revision425 / turn 01a19859-6fb3-7891-b28d-9d7240ddfb61条件性审查通过，且上述退出条件全部成立后，执行唯一一次外部清理：只用登记rootId及§27七叶manifest；整体及每叶身份/大小/单链接/规范路径重核，准入清单输出callback完成后逐项删除，lifecycle最后，最后删除空根。无递归、重试、卷/镜像/其他进程操作。最终独立回执artifactsRemoved=true/retained=false/removedFiles7/error=null，工具实际exit0；2026-11-01T18:24:41.723Z独立lstat得到ENOENT，根不存在。内联诊断/恢复/清理均无临时源文件。

该外部清理完成本次残留责任，不将原入口passed=false/artifactsRemoved=false改为正常通过；仅本次固定配置/负载的容量事实已获认可，修正后的自动收尾只有新单组离线证据，没有第二次现场实测。当前源码session变化后，bd2b96…只对应历史现场，任何未来入口均须重新固定集合并审条件。

本项3代码/fixture/检查与3文档共6文件：index1957/范围外1953摘要ACE9D318540C66FDFAB22AC90AB8A4C450CBFFE0A58120A1C016F4B5C50C3846；新增2文件后预计index1959，范围外不变。九删除/patch保留，复核后精确暂存，不提交推送。冷手动验收链，无生产导入、分块捕获/渲染/进度热路径未改，无对象池或无关基准。

下一项先核对异常脱卷时GUID路径不回落普通宿主目录的机制、owner失效与下一任务阻断，再决定唯一必要的反例或最小接线；真实候选owner与工程接纳仍未完成。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

revision432 / turn 01a1985d-2307-7b51-aa89-430839a0f5af结果/记录/六文件暂存范围复核通过，目标index1959/范围外1953摘要ACE9D318540C66FDFAB22AC90AB8A4C450CBFFE0A58120A1C016F4B5C50C3846。下一最小项确定为真实卷owner—GUID候选读取租约的只读适配设计；不新增重复manager异常替身、不启动异常现场实验。代码无普通宿主目录回退，平台真实失效行为仍未验证。

## 29. 真实卷候选读取适配契约与纯数据核心离线通过

revision432确定下一实际缺口为真实卷owner—GUID候选读取租约，revision435 / turn 01a19869-0498-78b1-b38a-748c12e19661只读方向复核通过。继续使用同一NativeDisk管理助手，不增加reader进程，不放宽旧OfflineCandidateOwner盘符根正则，不重复manager异常替身或容量/旧矩阵。代码层无普通宿主目录回退；真实WSB卷失效后的缓存/已开句柄/重连行为仍未验证，不能由本适配设计推定通过。

### 29.1 两阶段、固定私有载体与预算

未来固定read-candidate-manifest/read-candidate-batch各一条控制命令；逐文件操作只在同一助手的batch内部串行进行。拟正常流程prepare、两次verify、manifest、batch、release、exit共7条命令，prepare五条progress加各reply共12消息；不发逐文件控制请求，保持16命令/32消息/8192B协议行。实际接线仍须逐调用核对，不将此设计计数记作现场数据。

| 固定宿主私有叶 | 内容 | 上限 |
| - | - | - |
| candidate-manifest.bin | 原始manifest字节 | 4096B |
| candidate-request.json | 宿主批准请求 | 4096B |
| candidate-payload.bin | 按请求顺序串接的原始payload，无头部 | 16384B |
| candidate-manifest-receipt.json | 绑定、源/载体身份、长度、摘要、关闭结果 | 4096B |
| candidate-batch-receipt.json | 请求摘要、载体身份/长度/摘要、有序分项表、关闭结果 | 4096B |

五叶合计32768B；未来两条新命令的固定错误回执各4096B，另列8192B。新增叶只由宿主代码确定，进入新精确清理profile；来宾只见卷内exchange，不能见镜像、owner、journal或上述私有叶。原日志8192B/主输出7680B/尾行512B不变，日志不重复载荷或整张分项表。全部payload保持16项、单项4096B、总16384B，manifest4096B；不能通过载体头部暗增payload预算。

批准请求只含protocol/taskId/manifestSha256/有序paths，不复制snapshotId、宿主revision、完整allowlist或报告。snapshotId已由宿主对原manifest核验；操作授权、来源版本和目标基线始终保存在宿主私有记录。batch回执的每项采用[sourceId,length,sha256]，省去重复路径；偏移由严格有序长度前缀和得出。项数、单项/累计长度、总和等于实际载体长度、整体及逐项摘要全部核对；零长度文件占一个条目且摘要为零字节SHA-256，空batch为零项/零长度/同一空摘要，不发布部分成功。

### 29.2 真实读取租约及句柄责任（尚未接线）

私有租约须绑定同一实际VM owner、task/instance、卷身份和本次读取；只在所属VM已关闭、最终list证明实例不存在、全部CLI实际关闭、manager/卷仍健康时授予。租约覆盖manifest读取→宿主校验→请求发布→batch读取→JS读取载体并确认关闭→候选发布，中间不清除读取占用位。save回调重入之后、每次命令实际派发之前及最终候选发布之前再次核对同一租约/运行时/卷；禁止仅信任构造时冻结的生命周期声明。真实入口的revokeCandidates须连接候选owner.revoke，而非只更新报告标记。

宿主观察到失效后立即撤销准入和消费资格，不声称同步Win32 I/O已被中断或句柄已关闭；未决操作继续登记，迟到字节拒绝发布并清零内部缓冲。manager失效/身份变化/关闭未知保留owner并阻止盘释放和下一任务。正常detach只释放盘，不调用候选dispose；已检查字节由独立候选租约持有，最终消费/拒绝/撤销后再释放。内部Buffer也不是语言层不可变对象，采用私有存储与复制接口；不能声称擦除调用方此前取得的副本。

native须逐组件OPEN_REPARSE_POINT，父目录以仅READ共享打开，不开放不需要的WRITE/DELETE共享，并保持到叶读取后；同句柄核对文件/卷身份、普通类型/单链接/EOF前后及最终GUID路径，继续拒绝重解析对象和路径别名。字符串GUID不能替代实际设备/卷/目录归属链；原生小固定叶代码只能提供实现参照，不能冒充通用候选读取器。读取前后保留原始操作和关闭错误，关闭仅一次、未知句柄精确保留。

拟业务句柄模型：manifest串行捕获为exchange+源文件，再私有载体，共3次打开、峰值2；batch先读取私有请求并关闭，再持有载体writer，每项打开exchange/payload/最多3级父目录/叶，共2+sum(path段数+2)次，16项四段路径上界98，峰值7。原生元数据检查、PowerShell回执写入及JS载体读取的句柄另计并各自确认关闭；这些是待实现的业务上界，不能写成全部Win32遥测或沿用容量九槽计数。实际原生实现若改变打开方式，须先审模型，不能静默增加限额。

### 29.3 首个独立核心：只验证已捕获数据

新增[纯数据契约](../scripts/acceptance/windows-sandbox-volume-candidate-contract.mjs)及[新定向检查](../tests/windows-sandbox-volume-candidate-contract.test.mjs)，旧候选模块只导出原candidatePath/manifest两个纯函数别名；其文件根、读取和生命周期逻辑不变。调用链仅为复制宿主权限/绑定→原有manifest规则→生成批准请求→验证有界成功回执与捕获字节→私有数据保存，尚无NativeDisk、文件访问、VM、CLI、提交或运行时授权。模块导入旧文件不调用其I/O函数。

纯核心以candidate-data-checked/contractOnly=true明确区分数据满足契约与真实owner准入；guest exit23不影响候选数据检查，也不宣告任务成功。宿主基线复制固定，收到的Buffer先复制后验证，内部payload至多一份16384B、批准请求至多4096B；manifest及回执解析暂存另计并在使用后清零，调用方输入和复制接口的输出由调用方负责。失败/撤销清除内部请求/payload及宿主上下文，禁止再次尝试或继续消费。

成功回执使用super-pi-candidate-capture-v1、manifest/batch固定stage，绑定task/volume/exchange及宿主实际观察的carrierId。原始JSON要求严格字段与规范编码，未知字段/重复键/非UTF8拒绝；关闭结果要求opened=closed、峰值/总数处于本节业务上界、closeUnknown=false且retained为空。失败或未知关闭仍是未来真实owner的责任，纯数据类没有能力证明进程来源或释放任何系统资源。request使用super-pi-candidate-read-request-v1，SHA-256绑定原manifest与批准路径序列；分项身份须同卷、互异且不与exchange或manifest身份混淆。

代码预审turn 01a1987a-e3f9-79c0-81c9-f994bb9b632a指出一项P2：小型Buffer.from可能与调用方共享池的底层ArrayBuffer，复制可见范围不足以证明私有字节隔离。现内部输入/请求及所有返回副本均改用独立非池化Buffer.alloc；没有新增对象池。检查改为限定在测试自有backing内扩大视图写入，并核对两个输出副本及内部存储彼此独立、backing大小等于可见字节数。另修正UTF-8 BOM被TextDecoder默认剥除的问题：新receipt保留BOM让JSON拒绝，manifest显式拒绝BOM，旧parser不改。

revision440 / turn 01a19881-910a-7bd1-97e3-7c50391d29f4复审通过后，2026-11-01T19:07:54.482Z仅原九组一次9pass/0fail，总58.8226ms，testPID30140/status0/signal=null/error=null/stderr0。覆盖权限复制/原始字节与副本、空批次与空文件、最长路径/版本/16KiB边界、禁止路径与目标冲突、manifest关联、捕获身份和关闭、batch顺序/摘要/长度、编码/BOM限额、单次状态与撤销。未运行旧组、编译或原生/Storage/WSB；无临时产物。

最长正常样例含16条120字符路径、每项128字符宿主revision：request2159B、manifest receipt467B、batch receipt2153B、manifest2633B、payload16384B，均保持原限额；nativeOperations0，98/7只是拟定业务句柄模型，不是实际打开遥测。输入offset view和完整输出backing被修改后私有数据仍保持；失败/撤销后内部请求/payload/backing字节计数为0、上下文释放，调用方既有副本仍可持有。这些计数只描述本模块明确保有缓冲，不声称包括JSON字符串、调用方副本或进程总内存。实际原生错误回执及完整组合报告的编码上界仍需随对应实现验证。

| 最终文件 | SHA-256 |
| - | - |
| windows-sandbox-candidates.mjs | 7025A6B392C34549910B4BB15D2026A11DB02D9FF025DE0DB97B739327AB57CE |
| windows-sandbox-volume-candidate-contract.mjs | 0DE4F691B5CE40D8438C33AC1D11785BFB7B1B1CFBD81156DFCCDDA484FE4915 |
| windows-sandbox-volume-candidate-contract.test.mjs | 241C1BD3399B174FD95FEE31ECD1F26579286421DAE94396768A1899F241088C |

本项3源码/检查加3文档共6文件：index1959/范围外1955摘要2485EC559C7A4D7A2A90A7AF951788E4B8C3F892F2DF6AB9EBB3E957B886F24A，新增2文件后预计index1961，复核后精确暂存。无临时产物，既有九删除/patch保留。native捕获和真实owner租约尚未实现，继续逐项先审；生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

revision441 / turn 01a19884-26ac-7170-8269-fd91172516fd结果/记录/六文件范围复核通过，精确暂存目标index1961/范围外1955摘要2485EC559C7A4D7A2A90A7AF951788E4B8C3F892F2DF6AB9EBB3E957B886F24A。下一组件仅同一NativeDisk固定manifest捕获，含三个业务句柄槽及纯元数据校验；先审代码，再仅编译/纯替身，不构造NativeDisk、不调用Win32/Storage，不接helper/入口/真实租约。

## 30. 固定manifest原生捕获组件离线通过

revision441确认最小项仅同一NativeDisk的可选partial，固定读取已绑定GUID卷exchange/candidates.json并串行写到宿主私有candidate-manifest.bin；未接helper命令、执行入口或真实owner读取租约。实际VM/CLI关闭准入及回执发布须在后续接线，不能仅调用本方法就声称满足运行时接纳。

新增[固定捕获组件](../scripts/acceptance/windows-sandbox-volume-candidate-manifest.cs)、[纯替身夹具](../tests/fixtures/windows-sandbox-volume-candidate-manifest-check.cs)及[一次编译检查入口](../tests/windows-sandbox-volume-candidate-manifest.test.mjs)。NativeDisk原文件不修改；纯状态机与实际API适配同文件，纯检查只构造前者，通过注入操作核对顺序和失败分支，从不构造NativeDisk。宿主只用固定PS7及已核实csc，不启用功能、创建/挂载卷或启动实例。

### 30.1 固定操作、身份和释放

三个业务句柄槽固定为exchange目录、清单源文件、私有载体。目录只允许READ共享并以OPEN_REPARSE_POINT打开；源文件独占读取，载体独占CREATE_NEW并写穿。目录/源文件在同句柄上检查GUID最终路径、文件与卷身份、普通类型、单链接及前后长度/创建时间/写入时间；重解析、稀疏、压缩、加密和删除中对象拒绝。载体检查宿主DOS最终路径、同宿主根卷和独立身份、初始零长度、写后精确长度与原身份。小文件AllocationSize可为0，逻辑4096B预算不冒充文件系统实际分配硬限。

源长度1..4096B，只分配一个等长scratch，最多一次ReadFile；短读/返回失败拒绝。源两个句柄均关闭成功后才再次核对绑定并创建载体，最多一次WriteFile及一次FlushFileBuffers；短写/失败不发布。载体业务句柄关闭后再次核对绑定，方可标记captured。read/write/flush原始success/count/nullable error分别保留；桥接异常不伪造为系统错误，操作异常与关闭异常分开。

成功业务打开/关闭3/3、峰值2；每个槽最多一次关闭，先关闭后重新读取元数据不复用旧句柄。原始关闭错误0亦按失败保留；抛异常则error=null而责任未知。关闭失败保留确切槽/句柄及回调、阻止创建后续载体或宣布完成；原生owner CloseUnknown同步置位。任何结束路径清零scratch，业务句柄均已知关闭时释放操作/close回调；失败不自动删除已创建载体，后续owner按固定清单负责。现有ProbeVolumeIdentity/Fingerprint的临时元数据句柄属于既有owner责任，另计，不冒充三个业务句柄覆盖所有系统句柄。未知临时关闭阻止最终完成；其精确记录能力在真实接线前仍须核对。

### 30.2 待审的唯一离线验证

夹具拟50项：1/32/4096B正常及空/超限、普通类型/链接/卷/最终路径、源前后身份/写时变化、载体初始/最终身份长度、短读/短写/原始失败、绑定各阶段失效、打开失败、两个关闭同时未知、关闭错误0与抛异常、禁止重试、缓冲清零与回调释放。原生适配调用计数须为0；这不表示csc或PS7自身没有系统调用。

只编译基础NativeDisk+新增组件+纯夹具一次为x64 DLL，然后固定PS7加载并调用纯检查一次。每个子进程15秒/8192B捕获，stdout2048B/stderr1024B原始证据及退出状态保留，检查总40秒；输出证据至多12288B。唯一临时根为.artifacts/volume-candidate-manifest-check-UUID，只容纳candidate-manifest-check.dll最多65536B；进程实际退出后先交付根/叶身份和进程证据，再核对同一身份删除该叶与空根。未知退出或身份则保留，不递归、不扫描/猜测终止其他进程。

本项是冷路径手动验收，无packages生产导入、渲染/进度/大结果链改动或对象池，不扩跑旧检查/分配基准。六文件暂存边界：起始index1961，范围外1958摘要D38C9438BB155E864EC8E6C06723402509D786B294FB46A15EF9B1F225346BDA；三新增文件后预计1964。以上为运行前预审范围；实际执行结果见30.3。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 30.3 预审后唯一离线检查通过

revision445 / turn 01a19892-c268-7662-bfc1-b33d440c238e代码预审通过，紧邻执行核对三源码与Node摘要一致。2026-11-01T19:27:53.6804295Z仅该新文件一次1pass/0fail（内部50项），组613.1825ms、总675.4656ms、入口exit0。编译PID30868、纯夹具固定PS7 PID30660均实际exit0/signal=null/error=null、stderr0；PS7原始stdout182B，未截断。没有构造NativeDisk或调用组件原生适配、Storage、WSB，旧矩阵未跑。

确定计数：固定业务槽3、fake peak2、scratch最大4096B；50项均核对显式scratch清零与已知关闭后的回调释放。双关闭注入最多2个未知fake句柄被精确保留，失败close重试0；副本不能更改内部记录。正常1/32/4096B均3开3关，短读/短写、元数据变化、绑定失效及关闭失败均未发布。此为纯注入流程/元数据证据，不是实际GUID文件读取、实际VM收尾或全部系统句柄遥测。

唯一临时根volume-candidate-manifest-check-d725c663-371b-469f-b1ad-d8e226e08a37，身份3938676073:1970324838179191；唯一DLL49664B，身份3938676073:2251799814889849。两个进程退出后，先输出登记证据，再按同一身份删除DLL和空根；回执rootRemoved=true/filesRemoved=1，检查断言根不存在。无本项遗留，没有提高64KiB产物/输出或源清单预算。

| 文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-candidate-manifest.cs | 89C1075415E12061DE0D6CFF09DD087039C73D956F47B9A8A1367EFA2145A5C6 |
| windows-sandbox-volume-candidate-manifest-check.cs | 0E229DE2E9E58354D1EDC95132A47B7214CE602123A8B1EED10799CF42E1B522 |
| windows-sandbox-volume-candidate-manifest.test.mjs | 50B4A9EF6A10C7520A4D08334EB4C22B4A08FF5141F403BC7E065B73AD060D79 |

待结果/记录复核后精确暂存本项六文件。真实接线前先补齐既有临时元数据句柄未知关闭的精确责任，再推进batch捕获和真实owner租约；本组件仍无helper或生产消费者。原容量入口失败及其外部恢复记录保持；生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision448 / turn 01a19896-0724-70a1-84ef-e8552de2250f结果/文档/六文件范围复核通过，独立确认登记根不存在，批准精确暂存至index1964（范围外1958摘要不变）。下一最小项先于batch：调用方在NativeDisk构造前持有有界临时句柄责任，覆盖全部八个CloseTransient点及启动/错误报告路径；操作与关闭异常分离，未知后不得新获取。先审补丁与纯替身，不实际存储。

## 31. 临时句柄责任与未知关闭报告路径离线通过

revision448要求先于batch/真实租约补齐八处临时句柄责任。原CloseTransient仅置CloseUnknown，finally抛出的关闭异常还会覆盖原操作异常；构造器Fingerprint失败使NativeDisk赋值未完成，后续Write-State/Write-Evidence又会调用Fingerprint。现草稿由helper在构造前创建并持有纯TransientOwner，传入NativeDisk；不使用静态集合、终结器或GC作为收尾。构造失败也保留同一个调用方责任对象。

### 31.1 固定范围和失败语义

责任对象固定一个串行槽，已获取立即登记角色/句柄，成功关闭后清空槽及异常引用；不保留操作委托、不引入池。八个角色为Fingerprint、Privilege token、ImageInfo、VolumeExtents、ExchangePath、ProbeWrite、ProbeRead和DetachPresence。原业务容量九槽及manifest三槽不合并、不改变其责任；本次新增停止门只针对TransientOwner未知状态，不借此重写全部业务失败回执。

任一临时关闭返回错误（包括0）或抛异常都保留精确句柄、角色、操作异常、关闭异常及nullable原始close错误，关闭只尝试一次。再次进入、再次获取、再次绑定均在factory前拒绝，原记录不被覆盖；先抛原操作异常，关闭事实留在调用方owner。原操作失败但关闭成功仍准确增加关闭计数并释放内部引用。ProbeOpened/Closed继续反映真实打开/关闭而非整个操作是否成功；32B探针内部缓冲在结束时清零。DetachPresence只有实际打开失败的既有2/3/55/1167允许认定缺席；可打开对象或未知关闭不能冒充缺席，其他查询原始错误作为inner保留。

启动及常规命令的未知临时关闭路径都不再尝试写文件来报告自身状态。固定super-pi-volume-transient-v1诊断只从调用方对象生成，走既有stderr通道，最多1024B含换行；仅一次，失败不回退文件。携带task/phase、role/handle、开关计数、独立操作/关闭类型与HResult、操作原始nativeCode及nullablecloseError，不含任意异常正文或路径。既有接收端将stderr判为失败并保留有界原始字节，不能把诊断当正常成功回执。构造未返回或诊断输出失败时继续持有helper责任，等待显式恢复；不自动退出、杀进程或重启。startup普通已知失败原逻辑及正常回执schema不变。

### 31.2 仅离线定向检查草稿

新增纯C#检查24项：八角色串行释放、失败获取无无效关闭、无效句柄/角色/委托、构造赋值前外部owner保留、操作及关闭双失败/原始0、抛异常无伪造错误、重入/未知后factory不执行、一次关闭、无委托/数组保留。它只模拟构造赋值前的失败，不构造真实NativeDisk或声称实际constructor已运行。

新入口只编译一次基础NativeDisk、现有容量core/protocol/host、manifest partial及新纯fixture，以检查同一类型编译兼容；固定PS7只调用纯fixture与已审函数摘取。包括受影响startup解析夹具一次、未知状态下Write-State/Write-Evidence/Invoke-VolumeCommand共9个准入拒绝、三种原始诊断与禁止重复输出。五个旧PS替身仅机械补齐新纯函数依赖及null owner；新入口只解析其语法和依赖，不执行旧矩阵或旧存储写入。

两个子进程各15秒/捕获8192B、stdout2048B/stderr1024B；整体40秒、交付证据12288B。唯一.artifacts/volume-transient-check-UUID内仅transient-check.dll，采用既有原生程序集131072B上限（本次同时编译已有partial），不提高实际VOLUME_LIMITS；退出已知后先交付精确身份再删单叶/空根，未决则保留。无Storage/WSB/实际NativeDisk、安装、挂载或系统改动。

完整范围13文件：native/helper、新C#fixture/Node入口、startup解析夹具、五个旧PS夹具的依赖适配、三文档。起始index1964/范围外1953摘要64428E479A958EACB87278832525607F51A6B55272CDF108DE2B86055E86C36B，两个新增文件后预计1966。以上为运行前预审状态，当时尚未编译/运行；实际结果见31.3。不使用历史bundle摘要授权新源码现场。调用链仍是冷路径手动验收，无生产进度/渲染/大结果链变化，不扩跑分配基准。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

revision452预审指出两项P2，均在任何执行前修正：错误收尾的文件报告自身可能产生新unknown，原分支未复查；原9个准入检查把任意异常算通过，可能被null对象/已有controlFailed掩盖。现抽出实际Write-TerminalFailure，最多尝试一次普通报告后再次检查owner，新的unknown走一次stderr诊断，输出失败仍不重发或回退文件。检查每次独立重置controlFailed/phase，断言精确未知拒绝原因，并以会计数且先抛错的无I/O native/dispatch替身保证后续操作未触达；另外实际摘取有限收尾函数，覆盖已有unknown、报告中变unknown、诊断写入失败、普通报告失败及成功五种情况。C#核心仍24项，增加9个强准入判据及5个收尾反例；不执行真实保留循环或构造器。

### 31.3 复审后唯一离线检查通过

revision454 / turn 01a198a6-67ca-76b1-8212-6dba7c41d107确认两项P2已修正并放行唯一新检查。2026-11-01T19:48:23.2281956Z紧邻执行核对10源码/夹具与Node摘要一致，仅新入口一次1pass/0fail，组901.7355ms、总958.7304ms、入口exit0。编译PID33084、固定PS7 PID12856均实际exit0/signal=null/error=null、stderr0；纯调用stdout356B、未截断。

C#24项全部通过，八角色串行8开8关/单责任槽；unknown只有一次关闭尝试、后续获取0、无委托保留，已知关闭释放句柄及异常引用。受影响startup parse-only一次、9个精确准入拒绝（native/dispatch canary均0）、3种诊断、5种实际收尾函数模式、5旧夹具依赖parse均通过；诊断最大422B，注入writer失败只有1次尝试，未知责任保持。真实helper主体/无限保留循环/NativeDisk/Storage/WSB未执行，未重复旧矩阵。构造失败覆盖是纯责任转移加实际PS顺序/分支解析，不冒充真实构造故障现场。

唯一临时根volume-transient-check-851579f3-fe4c-479c-a9d6-d2b570e3493c，身份3938676073:1407374884757951；唯一DLL70656B，身份3938676073:1407374884757953。两个进程关闭后先输出身份/原始stdout/退出证据，按登记身份删除DLL和空根；rootRemoved=true/filesRemoved=1、断言根不存在，无本项遗留。沿用15秒/8192捕获、原生128KiB及1KiB诊断预算，无生产热路径改动或对象池。

| 文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-native.cs | 51E05A70958BB117B73AF048B24ABDE53D729060B020AA20406F57F7577068A8 |
| windows-sandbox-volume-helper.ps1 | D65242AC0C4BC752097C9F4E9656F063E4CA1BB55DF3ADFA8328EA1C1AA324EB |
| windows-sandbox-volume-transient-check.cs | D25250E03B41E41F7678424E347D5F18149C42935E458B6290ACD07729F7051B |
| windows-sandbox-volume-transient.test.mjs | 01DF1C43D4FADA80A40DD53B4F34428F9D7B739B4BAE952350DC943FF3647B28 |
| windows-sandbox-volume-startup-parse.ps1 | 4910009C7EE657F5B66ED353DB10DAF6BED7EC2666D5AE9177A222EC31374BBD |
| windows-sandbox-volume-guest-read-check.ps1 | 50AFB560E847A06EB15E277512F7CC4DC0BDA48D61EB6ABD88A6D8359C7536D0 |
| windows-sandbox-volume-capacity-helper-check.ps1 | 0B8D8B9124AA3ED4B96CAA64CDDFCC79498B756EF2381E71E71298A4A6103D65 |
| windows-sandbox-volume-helper-check.ps1 | 12178D137849E1623742A7B849AB8586DC8DA41EE64B450BAE04FB372108355E |
| windows-sandbox-volume-journal-check.ps1 | 10C615ACA989E1E2028CE5C95C5F77B6BD02A296F75E417E24BBB0C23FFCC148 |
| windows-sandbox-volume-probe-check.ps1 | F1CEFD799CE784E341867F433DD0ED409A978DEDF666DE8641EB5E3372FAFAED |

待结果/记录与13文件复核后精确暂存至index1966（范围外1953摘要不变），不提交推送。此前唯一容量现场/入口失败及外部恢复历史不改写；本项责任修正通过后可进入批量捕获与真实owner租约的独立预审，仍未具备真实候选接线验收。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision456 / turn 01a198a8-a401-7a60-b2d0-6908c87b40e9结果/记录/13文件范围复核通过，独立确认登记根不存在，批准精确暂存至index1966（范围外1953摘要不变）。下一允许同一NativeDisk批量组件含固定请求解析/路径校验、绑定已完成manifest、顺序载荷/零数据/原始错误与有界句柄；先审代码后仅编译/纯替身，无新增先决现场实验。helper命令/错误编码/真实owner租约和实际存储继续后续独立接线。

## 32. 同一管理助手的批量候选捕获离线通过

revision456确认下一最小项包括批准请求解析及批量捕获，不另开通用JSON框架或重复现场。新增[批量组件](../scripts/acceptance/windows-sandbox-volume-candidate-batch.cs)、[纯替身夹具](../tests/fixtures/windows-sandbox-volume-candidate-batch-check.cs)、[唯一检查入口](../tests/windows-sandbox-volume-candidate-batch.test.mjs)；manifest partial只增加内部只读绑定访问，并提取原同句柄元数据读取供两组件共用。GUID/DOS标志、类型一致性和原始Win32读取定义不变，两个适配器分别计数。

### 32.1 批准请求与已有捕获绑定

仅同一NativeDisk的只读task Id及其私有已成功ManifestCapture可创建批量绑定；核对Root/RootId/volume/exchange完全一致，保留原manifest源身份、载体身份及SHA。调用参数不能声明manifest已成功，也不能替换本机task。当前仍没有真实VM收尾/owner lease准入，方法未接helper命令；这一内部绑定不冒充运行时授权。

先独占读取固定私有candidate-request.json，检查同句柄宿主卷/最终DOS路径/普通单链接/前后身份长度，最多4096B；源关闭确认后才CREATE_NEW candidate-payload.bin。请求不得与原manifest载体身份相同，新的payload载体不得复用request或manifest载体身份。

请求采用当前JS生产者的精确紧凑编码：protocol、taskId、manifestSha256、paths四字段依次出现。有界扫描器严格UTF-8、固定前后缀和最多16个引号路径，拒绝BOM、转义写法、重复/额外/重排字段、非规范空白及尾随数据；不引入在PS7下不可用的Framework JSON依赖。路径与既有宿主规则一致：ASCII、1..120字符、最多4段/每段64字符、首字符字母数字，拒绝尾点、设备名、绝对/ADS/反斜杠/点段/非ASCII/短名等；大小写重复和祖先冲突双向拒绝。宿主revision、操作授权和目标版本继续不传入来宾或此请求。一个新兼容样例从实际CapturedCandidateOwner.copyRequestBytes生成请求并交C#解析，避免仅用重复的字面量生产者证明兼容。

### 32.2 有界读取、数据和失败责任

请求句柄关闭后复用槽0持有宿主payload writer；每个候选按exchange/payload/相对路径逐组件打开，持有父目录READ共享及OPEN_REPARSE_POINT，叶独占读取。同句柄检查最终GUID路径、普通类型、单链接、源/卷身份及长度，读后再次检查叶与所有父目录。来源身份不能等于manifest源、路径中其他组件或先前候选；不扩大为来宾进程来源认证。

每项最多4096B，总和最多16384B，核对长度与剩余额度后才分配。请求缓冲先清零，再逐项分配等长缓冲、最多一次读取和一次写入，结束清零；总显式字节分配最多20480B、同时保有输入缓冲最多4096B，不保留载荷Buffer。原始payload无头部，按请求顺序串接；记录有序sourceId/length/SHA，整体增量SHA和总长度。零长度文件不虚构ReadFile/WriteFile调用，仍核对身份及空摘要；空批次仍创建/flush/关闭零字节载体。

业务槽固定7个，已知关闭后才串行复用；每次打开有新实际句柄登记，关闭只尝试一次。模型为请求1+载体1+各路径(k+2)，最多98开/峰值7；空批次2开/峰值1。此为单次捕获资源记录，不是对象池。元数据核对沿用先前TransientOwner责任，另计，不把98当全部Win32操作。VerifyBinding正常最多候选数+3次；真实元数据打开计数仍待接回执。

请求read、每项read/write与flush的原始success/count/nullable错误有界保留，操作异常和关闭异常分开。未知关闭后停止新获取/发布，保留确切七槽及关闭错误，尝试关闭其他已知自有句柄而不重试未知句柄。任何失败都不提供Items成功快照，已创建私有载体由后续固定清理清单负责；不以中途已写字节当候选接纳。结束后清零所有显式输入缓冲；业务句柄全已知关闭时释放操作/close回调，元数据未知仍由外部owner独立保留。

### 32.3 待审唯一离线检查

拟74纯项覆盖：既有manifest绑定、请求编码/字段/路径/重复/祖先/17项拒绝、最长16条120字符路径、空文件/空批次、16KiB正常边界及超限、载体/源身份与元数据变化、短读写/原始失败、各绑定阶段/打开失败、多个关闭未知、一次性状态、独立快照及缓冲/回调释放；另一个当前JS生产者到C#解析器的线协议样例。最大正常业务模型98/7、request2159B、总输入分配18543B为拟定检查值，尚未实测确认。纯manifest依赖只捕获不透明固定字节，不声称已验证宿主授权或来宾命令来源。

仅编译基础NativeDisk+manifest+batch+纯fixture一次，固定PS7调用纯检查一次；不构造NativeDisk、执行helper正文/Storage/WSB或重跑旧矩阵。每子进程15秒/捕获8192B、stdout2048B/stderr1024B、总40秒；唯一.artifacts/volume-candidate-batch-check-UUID内仅candidate-batch-check.dll最多131072B。进程已知关闭后先交付身份/退出/原始输出证据，再按登记身份删除该叶和空根；未知状态保留。

七文件范围：一个已跟踪manifest partial、三新增源码/检查和三文档；起始index1966/范围外1962摘要CAAA3E4B28FE03862D799982971299BE2F93C3EFA4B7232D00954B9CDE8B9172，预计index1969。以上为运行前预审状态，当时尚未编译或运行；实际结果见32.4。冷路径手动验收，生产进度/渲染/大结果链不变，无对象池，不扩跑分配基准；helper命令、错误回执、真实owner租约及实际候选读取后续独立接线。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 32.4 预审后唯一离线检查通过

revision460 / turn 01a198bb-be10-7530-8839-3184d83c34ff代码预审通过。2026-11-01T20:17:32.6669232Z紧邻执行核对四候选文件、base native、JS contract、旧candidates及Node摘要一致，仅新入口一次1pass/0fail，组642.8827ms、总695.8956ms、入口exit0。编译PID3896、固定PS7 PID20116均实际exit0/signal=null/error=null、stderr0；纯stdout294B，未截断。

74项纯检查通过；最大实际fake业务opened98/peak7、累计显式缓冲分配18543B，全部清零且RetainedBufferBytes0，最大接纳request2159B。双关闭注入最多保留2个精确fake句柄，重复Run及重复清理不再调用I/O；已知关闭后回调释放。空批次/空文件、整批16KiB、逐项有序长度及摘要、原始短读写、关联/路径/身份失败和无部分成功均通过。JS实际生产的两项请求被C#原生请求解析器接受，双方SHA-256均为7cb4c1339dfa55c7ca9f341d4147af6014a720072a49e0dcb80ce51e6dfd1c71。NativeDisk实例0、两个捕获原生适配器调用0，不是实际GUID读取或真实租约通过。

唯一临时根volume-candidate-batch-check-94e9f212-b350-4573-b033-74c220491f4b，身份3938676073:4222124651864406；唯一DLL82944B，身份3938676073:1407374884757980。两个进程退出后先输出精确身份/原始输出/退出证据，再删除该DLL和空根；rootRemoved=true/filesRemoved=1并断言根不存在。无本项遗留，未重跑旧矩阵，无helper主体/Storage/WSB或系统改动。

| 文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-candidate-manifest.cs | 939CB56EC7D3BF705222D839FECE2BACFE8EB6C7B46B137D524C96130904912A |
| windows-sandbox-volume-candidate-batch.cs | 7196AE427A2820D6692A99E0F396BFF81498C776855B4709D3A86505F361C604 |
| windows-sandbox-volume-candidate-batch-check.cs | D053F000930CE2738566934A41A3B954457D4A591EEB8F6A7064820E574016D9 |
| windows-sandbox-volume-candidate-batch.test.mjs | 1B514662CB0A7A66989ADB93E9A0C6C52B01A44508072BDC23FD0FB5BA5DF702 |

待结果/记录/七文件范围复核后精确暂存至index1969，范围外1962摘要保持CAAA3E4B28FE03862D799982971299BE2F93C3EFA4B7232D00954B9CDE8B9172。下一独立缺口是固定helper命令与成功/失败回执编码、真实owner读取租约及宿主私有载体接纳；继续先审，不以本次离线通过授权生产或历史bundle现场。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision461 / turn 01a198c4-3504-7ad2-8541-adff39dc2769结果/记录/七文件范围复核通过，独立确认登记根不存在，允许精确暂存至index1969（范围外1962摘要不变）。下一两固定helper命令与有界回执可独立适配：prepared/ready/控制与关闭健康、一次性尝试、batch依赖同native manifest成功；成功编码匹配实际JS（retained空数组、items保持二维），原始失败/报告失败分别保留，最坏16项事实与未知关闭编码须实际测长。仍守16命令/32消息/8192行/4096回执，分别计业务、临时元数据和回执句柄；只先审源码及纯检查，无现场前置实验、无自动宿主派发或真实lease准入。

## 33. 候选读取固定命令及回执适配（离线通过；真实租约未接入）

### 33.1 本项边界与入口

revision462 / turn 01a198cf-e56d-7663-8b07-4ea976cc5a06确认本项必要范围：两个固定读取命令、成功/失败回执、独立回执流责任及共享单次终止诊断；当时运行许可待源码预审，后续通过与唯一执行见33.4。helper新增显式CandidateCapture开关，默认关闭，与capacity profile互斥，加载程序集后核对两个捕获方法存在；现有宿主没有自动派发新命令。prepared不等于VM已退出或真实读取租约成立。

read-candidate-manifest / read-candidate-batch只在prepared、ready、控制与临时句柄健康、native无关闭未知时准入；batch还要求同native的manifest捕获成功。每阶段在Verify-Ready或任何捕获/报告I/O前登记一次性尝试，失败不重试。既有16命令、32消息、8192行预算不变。

### 33.2 回执、失败与责任

成功回执严格匹配super-pi-candidate-capture-v1；原生三个/七个全null槽显式编码retained=[]，items为0/1/16行二维[sourceId,bytes,sha256]。只有捕获成功、业务句柄已知全关，且回执Write/Flush/Dispose全部完成，才允许普通成功reply。manifest/batch各一个固定success或error叶，每叶4096B：candidate-manifest-receipt.json、candidate-batch-receipt.json、candidate-manifest-error.json、candidate-batch-error.json。正常两个成功叶8KiB，额外错误叶预算8KiB；历史manifest/request/payload预算保持。

失败回执不读取抛错的Items，只保留可用事实前缀；原始IO以[success,nullableError,count]编码，每项[index,requestedBytes,read,write]最多16行，不把事实数当失败文件索引。native operation、native close、捕获包装异常、后续报告异常分别保留；不将报告失败覆盖原捕获事实。错误回执不具备候选接纳效力。

回执流为独立责任：创建后立即登记对象，再记录借用的SafeFileHandle数值身份，不另行原始关闭；Write/Flush状态与操作异常分别记录，Dispose只尝试一次。Dispose抛错只表述关闭未知，保留流引用及此前取得的句柄身份，不推断仍打开；已知关闭释放流/句柄引用。编码缓冲finally清零并计数。两个阶段最多各一个回执流，业务98/7不含临时元数据或这两个流；本项没有把98宣称为总打开数。

临时元数据未知、回执关闭未知和报告失败共用transientReported这一写前置位的一次性stderr标记；同时发生时合并为super-pi-candidate-report-failure-v1，ASCII异常类型前缀64字符及原始hresult/native code、精确已知句柄、独立异常，含换行<=1024B。既有启动阶段transient协议保留，不改宿主stderr处理/流热路径。诊断写出失败不重试、不切换另一出口、不回退文件。回执未知阻止后续文件入口、命令及成功发布；终止分支跳过Write-State，helper保持责任。

### 33.3 历史预审检查与资源范围（实际结果见33.4）

只编译base native+manifest+batch+计数替身一次、固定PS7提取helper函数一次，不执行helper正文、NativeDisk构造、Storage、WSB或真实载体读取。拟29组覆盖0/1/16双成功回执实际交给JS CapturedCandidateOwner、9类准入拒绝、捕获/身份失败、16项最坏IO/7槽关闭未知、报告Open/Write/Flush/Dispose/metadata失败及叠加、原捕获与报告失败分离、双责任诊断、writer失败后重入零打开/零重复关闭、旧启动诊断兼容。旧五PS替身仅补一个脚本状态初始化并解析，旧矩阵不重跑；旧transient检查同样仅补初始化。

每子进程15秒、总40秒、捕获8192B、测试stdout8192B/stderr1024B、原始证据包16384B；这些是测试输出预算，产品预算未变。仅.artifacts/volume-candidate-helper-check-UUID内一个candidate-helper-check.dll<=131072B，按创建根和叶的文件身份登记；进程实际关闭后先输出完整原始结果/退出与身份，再删除确切DLL和空根；未知状态保留。

13文件范围：helper、三新检查、六旧提取检查的初始化及三文档。起始index1969/范围外1959摘要3927BFEF2097E336C5A0EDA22F6472AE74D780A75BABB0E335C80500F73C9A21，预计index1972；其余既有工作不改。冷路径手动验收，生产进度/渲染/大结果链未改、无对象池，不扩跑性能/分配矩阵。本段为编译/运行前的预审历史，实际通过结果见33.4。真实owner租约/载体读取、实际共享卷候选及异常脱卷仍后续；生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

### 33.4 预审后唯一离线检查通过

revision467 / turn 01a198d6-d85d-7ce1-b954-8e3b6a2e2ead代码预审通过。2026-11-01T20:43:33.5400632Z紧邻执行核对helper、三新检查、base native、manifest/batch、JS contract/candidates及固定Node摘要一致，仅新入口一次1pass/0fail，组1194.3533ms、总1249.2426ms、入口exit0。编译PID33108、固定PS7 PID23608均实际exit0/signal=null/error=null，stderr0；原始PS stdout5308B，完整保留且未截断。

实际29组、16次未知责任入口guard通过；0/1/16成功回执全部由现有CapturedCandidateOwner消费，得到candidate-data-checked，逐项私有字节匹配，guest report exit23未被宣称任务成功。成功最大2102B，16项原始IO+7槽未知关闭错误回执2281B，双责任终止诊断最大478B（含实际换行），均低于4096/1024B原预算。以上是本次实际构造值，不把静态保守展开808B/2413B冒充实测上界。每次回执关闭只尝试一次、缓冲全部清零，已知关闭释放流/句柄引用，未知保留确切fake对象与数值；原捕获和报告失败叠加、Write/Flush和Dispose叠加、诊断writer失败后重入均未新增打开/重复关闭。原生适配调用0，helper正文未执行，没有NativeDisk构造、真实GUID载体读取或VM租约证明。

唯一临时根volume-candidate-helper-check-a4cbef5b-e8cc-42ae-9296-8e8585ded0b1，身份3938676073:3096224745021922；唯一DLL65536B，身份3938676073:2251799814889956。两个进程关闭后先输出完整原始结果/退出与资源身份，再删除确切DLL和空根；rootRemoved=true/filesRemoved=1并断言根不存在。无本项遗留，无旧矩阵、helper正文/Storage/WSB或系统改动。

| 本项主要文件 | SHA-256 |
| - | - |
| windows-sandbox-volume-helper.ps1 | 55262FC32D85855E892317A371FA848224EBFC8F526CF74BD108C4BD60C71841 |
| windows-sandbox-volume-candidate-helper-check.cs | 681328719AD1454F1C33AC14AE191CB5C97A76209154FC5D536AD992AA7887BC |
| windows-sandbox-volume-candidate-helper-check.ps1 | 88E1EF951E4ED7C7F10351FDC36462A0AD2F65375CBD8A0DAEF7B6CB49C05363 |
| windows-sandbox-volume-candidate-helper.test.mjs | C629266AA31A2274EDF6AAAEB0EFA0DC6563C2E332DF9EAE6E1D3909D8CB2A47 |

静态自查已在首跑前修正纯检查scenario与script:mode同名导致的场景覆盖问题；没有失败运行或重跑。六旧检查仅初始化candidateReceiptUnknown=false；五PS旧夹具只解析，不重放其矩阵。13文件结果/记录复核待通过后精确暂存至index1972，范围外1959摘要须保持3927BFEF2097E336C5A0EDA22F6472AE74D780A75BABB0E335C80500F73C9A21。下一缺口为真实owner读取租约及宿主私有载体读取/请求写入接纳，继续先审范围与源码，不以本次纯检查授权实际VM执行。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision472 / turn 01a198db-1945-7b80-93be-43d2504d90b3结果、记录及13文件范围复核通过，独立确认登记根不存在，文档时态已收口；允许精确暂存index1972，范围外1959摘要保持3927BFEF2097E336C5A0EDA22F6472AE74D780A75BABB0E335C80500F73C9A21。下一独立项先接真实owner读取租约和固定接口计数替身，再独立适配实际私有载体I/O；不重跑本轮检查。

## 34. 实际任务owner的候选读取租约（离线通过；真实载体I/O未接入）

### 34.1 已确认范围

revision472确认先补真实TaskVolumeOwner租约，再独立接实际私有载体I/O；revision474/475明确阶段准入、重复有效性检查和双Promise缓冲期限。本项只修改既有owner及driver两个固定命令白名单，新增一个纯Node检查和三文档。没有helper启动profile、真实文件适配器、实际VM、生产入口或默认切换。

readCandidatesOnce(authority,channel)由实际TaskVolumeOwner持有私有lease，绑定已派发并完成的原SandboxLifecycle对象、task/instance、LiveSandboxRuntime当前完成视图及卷基线；从未派发、活动/未知调用、跨owner/VM/context拒绝。authority经实际CapturedCandidateOwner复制；宿主绑定字段由owner确定，不能由来宾清单替换。一个lease覆盖manifest命令→私有清单/回执→宿主校验→固定request写入→batch命令→私有payload/回执→接纳→最终发布。旧begin/end不能替代或结束新lease。

### 34.2 固定接口与物理结算

channel是宿主专有接口，固定owner、vm、readManifest、writeRequest、readBatch、snapshot；本轮全部计数替身。每阶段登记责任后提供冻结ticket：固定阶段、task/instance、卷/共享身份和4096/16384数据、4096回执预算。admit(ticket)一次消费；validate(ticket)在同一活动阶段可反复调用，适配器须在每个新的物理操作前以及等待/重入后调用；过期、复制、跨owner和撤销票据拒绝。每次异步返回、journal/snapshot回调后、helper同步派发前、发布前复核真实租约。现有driver写pipe前没有等待或journal回调，仅扩两命令白名单，不扩preDispatch接口或流路径。

三个接口同步返回固定operation {outcome:Promise,settled:Promise}。取得后立即对两者安装处理，不产生未处理拒绝；outcome可逻辑失败，settled只有物理操作结束且不再使用借用/返回缓冲时才resolve。两者都结算前保持operation/channel/VM/request责任，不加自动清理超时。settled pending则方法保持pending；settled拒绝、同步抛错/非法operation、关闭未知或非法快照保留责任、阻止release。正常outcome失败但settled成功且快照全部已知关闭时，安全清零并释放I/O关联，再返回原失败。

snapshot仅观察不关闭、不重试、不做I/O。接口准入预算为显式宿主私有句柄累计16、峰值/未决4、固定阶段3；不是实测打开上界，也不是全部Win32内部元数据调用计数。计数校验整数/范围、opened-closed=active、peak、单调性，未决槽0..3及最多16十六进制字符身份唯一；实际适配器随后需证明满足本接口预算。逻辑阶段数与文件打开数分别记录。

撤销立即作用于实际候选core，其内部缓冲独立于IO借用副本。尚未派发副本可清零；已借出request在settled成功前保持原字节，不能因逻辑拒绝清零。晚到数据拒绝接纳，仅在已证实不再使用后清零。全部已知收尾才释放channel/VM/ticket/operation关联；正常卷release继续保留已检查候选，disposeCandidates只处置候选，不能解除未决IO责任。

### 34.3 历史预审检查及性能边界（实际结果见34.4）

拟只运行新candidate-owner Node入口一次，11组覆盖：真实owner+实际LiveSandboxRuntime/SandboxLifecycle的纯替身链、独立字节与正常盘释放、7类准入拒绝、8个journal重入点、读/写待完成时撤销及缓冲期限、旧begin/end、重复validate和跨owner票据、10类未知/非法责任、4种falsy拒绝值各有/无最终journal失败共8个反例、已关闭的来宾数据拒绝、journal异常/发布前dispose，以及实际VolumeProtocol的两命令白名单与释放。非法operation携带的两个已拒绝Promise也先安装处理，再拒绝schema；调用adapter前的journal拒绝不误标物理未知。所有CLI/文件操作为计数替身，无测试主动启动的helper/CLI/编译进程或新文件/临时产物；固定Node运行器及其测试隔离进程由有界调用等待退出，入口总时限40秒。已有PS、剪贴板、禁网、容量、取消矩阵不重跑。

已复核performance contract及完整实验调用链：新增只在显式候选捕获生命周期运行，最多两次helper命令、三阶段operation/票据、每阶段两Promise结算；不进入provider delta、tool progress、渲染、帧、Evidence Ledger或大结果路径，不改onData/onStderr/进程输出buffer链。无对象池；句柄及Buffer/候选/VM引用释放由新定向检查提供确定性证据，不扩跑生产性能矩阵。旧现场report.volume由volumeSnapshot收窄，新owner诊断字段未自动扩大旧聚合报告；将来新真实入口的总记录预算单独核对。

五文件范围起始index1972/范围外1968摘要7304D3274F5D77601C74D240242231C801A8F53C428270FAA19733DFDCA6BE68，预计index1973。本段为运行前历史设计，实际唯一检查结果见34.4。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

revision481静态预审提出三P2，首跑前已修复：仅真正Promise进入观察集合以免非法thenable被执行；独立failed/snapshotFailureSet保留undefined/null/0/false原始拒绝及journal聚合；opened>0要求peak>=1。另补异常分支一次当前快照观察和snapshotStage/current/failed标记，快照不替代physicalSettled。revision483 / turn 01a198ee-e6f0-7230-902d-eb6df84e5673复核通过，允许当前两源码摘要不变时仅新11组入口一次。获审源码BEA784506449FCF18E2FCFBB2AC11D4297399563BA9F2570FE80C0CF6A4FE1B7、检查50972F48D20A75D428DB1D0C597FB9142AFB290FD00F53A86192691F394DB237；尚未运行，结果另记。

### 34.4 预审后唯一11组检查通过

revision483代码复核后，2026-11-01T21:07:57.919Z紧邻核对两获审源码、实际候选contract及固定Node摘要一致，仅新candidate-owner入口一次，11pass/0fail/0cancelled/0skipped，总69.5718ms。固定Node观察进程PID4932实际exit0；测试运行器PID30116实际status0/signal=null/error=null，stderr0，完整stdout1279B，无截断。40秒有界调用未触及截止时间。没有编译器、helper、WSB或真实文件适配器，未生成本项文件/目录产物；Node运行及测试隔离已结束，无本项存储/实例资源需要清理。

实际正常链为两固定捕获命令+三I/O阶段，计数替身私有文件opened5/closed5/peak2；7类前置拒绝均未派发I/O。8个journal重入点、重复/跨owner票据、旧begin/end、待完成read/write期间撤销通过。借出request在physical settled前摘要与原字节保持，候选core内部请求已经撤销清零；settled后副本及原始返回缓冲清零，晚到数据不接纳。正常I/O结束后lease/channel/VM/ticket/operation引用释放；正常volume release保留候选字节，后续revoke/dispose清空候选并释放其引用。

10类未知/非法责任注入保留lease并拒绝release；当前快照与上一阶段快照明确区分。两个非法thenable的getter/then实际调用均0，非法operation的两个立即拒绝Promise被观察，无unhandled rejection。4种falsy拒绝值各有/无最终journal失败的8个反例，分别精确保留原拒绝值或AggregateError.errors；snapshot throw undefined被明确标记失败。非法peak0停止于首读，未知物理结算仍保留借出缓冲；disposeCandidates没有解除I/O责任。实际VolumeProtocol新白名单通过原流处理，正常结束清除输出缓冲、子进程引用及监听器。

| 本项源码 | SHA-256 |
| - | - |
| windows-sandbox-volume.mjs | BEA784506449FCF18E2FCFBB2AC11D4297399563BA9F2570FE80C0CF6A4FE1B7 |
| windows-sandbox-volume-candidate-owner.test.mjs | 50972F48D20A75D428DB1D0C597FB9142AFB290FD00F53A86192691F394DB237 |

这证明实际owner代码链在纯替身下的租约与生命周期，不是实际私有载体I/O或真实候选VM验收。接口16/4仍是约束，5/2是本次正常替身计数，不能写成Win32实际上界。未改生产热路径，无对象池、无旧矩阵重跑或本轮失败测试。待结果/记录复核后精确暂存五文件至index1973，范围外1968摘要保持7304D3274F5D77601C74D240242231C801A8F53C428270FAA19733DFDCA6BE68。下一最小缺口为固定私有载体reader/writer及其身份/预算/关闭结算契约，继续先审，不启动实际VM。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision485 / turn 01a198f1-b6f5-7063-8f97-54948b1f3082结果/记录/五文件范围复核通过，允许精确暂存index1973、范围外1968摘要保持7304D3274F5D77601C74D240242231C801A8F53C428270FAA19733DFDCA6BE68。下一项固定私有载体reader/writer先实现及计数替身预审：原始回执字节、同句柄身份/预算、CREATE_NEW写入和独立write/flush/close事实、正确settled期限，完整打开链须满足16/4；不先接helper profile或启动VM。

## 35. 宿主私有候选载体I/O（离线通过；实际文件兼容未验证）

### 35.1 对象边界与官方依据

revision488 / turn 01a198f3-d6f9-7d63-9674-930c777dfc2d确认：固定在未向来宾共享的宿主私有根内，允许Node fs适配，不要求额外原生reader桥。根/父路径继续依赖先前原生构造阶段的属性检查与登记身份；不承诺持续持有原生根句柄，不覆盖恶意同权限宿主进程并发替换。来宾共享树仍由原生capture逐组件持句柄检查，不能套用此私有路径例外。

Node BigInt Stats提供dev/ino等身份信息；固定Node v26.13.0的Windows libuv实现与官方Stats语义是本项依据（审核已核对，不重复搜索）：[固定版本fs实现](https://raw.githubusercontent.com/nodejs/node/v26.13.0/deps/uv/src/win/fs.c)、[Node Stats文档](https://nodejs.org/api/fs.html#class-fsstats)。dev必须是0..FFFFFFFF的BigInt，ino是1..FFFFFFFFFFFFFFFF的BigInt，直接转大写8:16十六进制；拒绝Number、越界和截断。历史3938676073→EAC36D69只是单一样例；真实接线前仍需单一登记文件的Node/native身份兼容检查，不能以纯转换替代。

| 对象 | 本项及既有证据 | 未证明内容 |
| - | - | - |
| 私有根/父路径 | 先前原生构造属性检查；本项lstat/realpath重验根ID与路径 | 持续原生根锁、并发恶意宿主防护 |
| manifest/payload | 原生capture同句柄属性/ID/长度；Node同fd前后再验 | Node独立证明全部Windows属性 |
| request | Node CREATE_NEW、写/刷新/关闭；后续native batch完整检查 | wx不是Win32拒绝共享锁 |
| PS回执 | 私有根、PS CreateNew/写/关闭；Node同fd身份/长度/链接数 | 原生叶完整属性检查 |

Node Stats不等同稀疏、压缩、加密及全部特殊重解析属性证明。原始回执直接作为Buffer交给既有core，不先解析/再编码，避免丢失重复键、BOM及编码证据。

### 35.2 固定资源、结算及失败责任

PrivateCandidateChannel只持宿主owner/VM/task/instance/volume/exchange及私有root/rootId快照；固定readManifest→writeRequest→readBatch，票据每阶段一次admit，每个新公开fs操作及最终交付前validate。五固定叶为manifest回执、manifest.bin、request.json、batch回执和payload.bin；前三个及batch回执各1..4096B，payload0..16384B。不接任意路径，未创建目录/删除叶；根仅规范Windows ASCII路径，拒绝UNC、ADS、保留名、尾点与归一化变化。

根lstat/realpath检查后，读叶lstat/realpath、open、同fd fstat前后、再次根/叶检查；同一身份、长度、mtimeNs/ctimeNs保持，文件regular/nlink1、与根同宿主卷且不同ID，五叶身份互异。分配前已核长度；非空单次read，短读拒绝不补读，空payload不调用read。request使用wx新建，立即登记fd，核对空文件后单次write/fsync，复验ID/长度/路径，最后一次close；写/刷新/关闭各自事实保留。失败创建的叶留在精确清理账，不在异常中删除。

所有本项文件操作同步；operation.outcome与settled仍遵循实际owner接口。settled resolve仅说明已不再使用借入/返回缓冲，不能替代关闭证据。未知close保留精确fd/slot及原始异常，阻止下一阶段、dispose和卷release；close只尝试一次，撤销后的本属清理允许，不再开新文件。操作/关闭分别记录failed标志，undefined/null/0/false不被吞掉。无有效fd的异常返回标记unresolved，禁止猜测关闭。成功原始缓冲转交owner；失败缓冲清零；request是借用，不由适配器改写。正常dispose释放context、fs方法、记录及身份集合，外部interface不再持owner/VM。

### 35.3 历史预审检查与预算（实际结果见35.4）

仅新增一个纯Node入口13组：精确BigInt宽度、实际core链、空payload、原始重复键、10类身份/路径变化、长度先验/短读、五叶精确上限与batch/request越界、8类创建/写/刷/关错误、原始falsy关闭、7个撤销点、重入/非法票据、根快照、实际TaskVolumeOwner正常及未知责任。全为内存fs/CLI替身，不运行helper/编译/Storage/VM，不创建文件产物；不导入旧测试入口或重复旧矩阵。

预期非空完整链显式fd 5开5关/峰值1；公开fs调用64，其中read4/write1/fsync1/open5/close5/fstat10、root lstat10/realpath10、leaf lstat9/realpath9；validate62。空payload少一次read。此为公开API及显式fd计数，不是libuv内部Win32元数据句柄数。原owner接口16/4预算保持；适配器累计原始分配最大28672B、最多4次Buffer.alloc，request借用最多4096B，阶段成功转交后不保留Buffer。记录固定最多5个。失败时释放/未知保留由定向计数核对。

本项仍为显式冷生命周期，无生产热链变更、无对象池；只使用固定Node v26.13.0运行有界40秒的新入口，先源码审查后一次执行。真实适配尚未接入helper profile、源码闭包或运行入口；未宣称实际同文件兼容或真实候选通过。五文件起始index1973，范围外1970摘要88FE119875AD08DA02FE79B29F53EE1CEB41B308DC6A2804EDB4449A5016F5C4，预计index1975。生产真实工作区/默认切换/权限退役关闭，P0桌面回放待办。

### 35.4 预审后唯一13组检查通过

revision496 / turn 01a19908-0c02-7b33-bf52-21b652b04581源码及五文件范围预审通过。首次执行前的摘要守卫停止于依赖contract：临时命令误抄摘要漏写B1，Node未启动；核对实际文件无未暂存差异、原revision483获审摘要0DE4F691B5CE40D8438C33AC1D11785BFB7B1B1CFBD81156DFCCDDA484FE4915后，仅修正运行命令的抄录，不修改依赖或降低校验。

2026-11-01T21:35:37.643Z两新增源码、owner、contract/candidates及固定Node紧邻摘要匹配，唯一新入口13pass/0fail/0cancelled/0skipped，总69.5676ms；观察进程30600实际exit0，运行器5704 status0/signal=null/error=null，stderr0，完整输出已保留。无编译/helper/Storage/WSB或本项文件/目录产物；没有旧矩阵或已通过检查重跑。

实际非空正常链5开5关/峰值1、64次公开API/62validate，空payload63API/3read。纯原始上限样例分配28672B，五叶上限均接纳，超限在目标数据读取/分配前拒绝；这些任意原始边界样例未冒充core协议接纳。实际core正常链与实际owner链的结果字节匹配，guest exit23仍为来宾声明；原始重复JSON键由core拒绝。10类路径/身份变化、8类request错误、7撤销点、短读/短写、原始falsy与重入/票据失败均通过。未知close保留确切fd和责任且只尝试一次，禁止下一阶段及释放；正常dispose释放owner/VM/fs引用，正常卷release后候选字节仍可用，后续候选dispose独立清零。

| 本项源码 | SHA-256 |
| - | - |
| windows-sandbox-volume-candidate-private.mjs | 7B35EE3257CFD4645DF367E25D51379A08B8CFE93539FDBD8F828ECC4DC16656 |
| windows-sandbox-volume-candidate-private.test.mjs | A9D9A0A4C0EFC398CB4E18F981F1B0AB60D3CE02C012594B6A38A9D65F12564B |

本轮仅证明当前适配代码在计数fs/CLI替身中的合同，未证明实际Windows同文件身份兼容或真实私有I/O链。结果/记录复核后精确暂存五文件至index1975，外1970摘要保持88FE119875AD08DA02FE79B29F53EE1CEB41B308DC6A2804EDB4449A5016F5C4。下一项先审单一新登记文件Node/native身份兼容检查，不先启用helper profile或VM。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision498 / turn 01a1990a-c6f0-7c43-9fe8-ac282c7108e6结果、记录及五文件范围复核通过，允许精确暂存index1975，范围外1970摘要保持88FE119875AD08DA02FE79B29F53EE1CEB41B308DC6A2804EDB4449A5016F5C4。下一项单登记32B文件Node/native身份兼容获准先实现，须源码预审后执行；不将本项离线结果扩大为真实I/O/VM验收。

## 36. 单一登记文件Node/native身份兼容（限定本机检查通过）

revision498批准下一独立最小项：仅在新独占宿主私有根创建一个固定32B identity.bin，使用固定Node v26.13.0保持原fd，Windows原生只打开同一路径的属性句柄，比较同一对象的精确身份。无NativeDisk构造、Storage命令、VHD附加、WSB、helper profile或真实工程；不重复§35或旧矩阵，也不把此项单文件兼容等同完整私有I/O链。

检查准备为三新源码：单Node test、C#元数据夹具、固定PS7加载入口。随机新根位于既有.artifacts；只有identity.bin（32B）和identity-check.dll（上限16384B）两叶。Node wx新建即登记fd/文件身份，单次32B写与fsync后记录同fd BigInt dev/ino/size/nlink/mtimeNs/ctimeNs，保持fd并调用一次PS7。原生使用FILE_READ_ATTRIBUTES、OPEN_EXISTING、OPEN_REPARSE_POINT及READ|WRITE|DELETE共享，兼容仍打开的Node写fd；取得GetFileInformationByHandle serial/index/size/links/attrs和GetFinalPathNameByHandle。原生无正文读取，拒绝目录、重解析、稀疏、压缩、加密、多链接或长度非32；最终路径须等于登记路径。

原生句柄成功返回后立即由静态槽持有，原操作与一次CloseHandle分别记录failed/原始Win32码；未知保留确切句柄hex及PS PID，不重复关闭。PS只输出一次<=2048B JSON并按失败状态退出；Node核对回执PID与spawn所属PID，原生identity必须严格等于实际nativePrivateIdentity(Node-before)，Node同fd after全部列明元数据严格相等；来源路径及根再验。原生关闭、Node关闭及所属进程退出独立判定，不用进程exit推定原生CloseHandle成功。Node关闭独立保留原始异常，合并失败保留两事实；32B Buffer finally清零。

单次编译与单次固定PS7各15秒/4096B捕获上限，stderr完整证明要求<=1024B；整个入口40秒。固定编译器/PS7及其配置按既有工具摘要校验；获审三源码及Node摘要紧邻运行再次核对。全证据<=12288B，包含原始输出、PID/退出/错误、根和两叶ID、fd/关闭、前后与原生元数据，先交付再清理。清理仅两个登记叶，逐叶核对根/ID/路径/类型/链接/最终长度，删除后移除空根；不递归、不扫进程。未知身份、关闭或进程退出保留根/记录，禁止重试与猜测终止。

本项显式冷检查，无生产热路径或对象池。六文件起始index1975，外1972摘要094B136EB63B661FC8894592484B68C706A84A6F01D82BAC4708CC74C0BBEA53，预计index1978。当前仅准备代码与记录，先独立预审再执行一次。生产真实工程接入/默认切换/权限退役关闭，P0桌面回放待办。

### 36.1 预审后唯一单文件兼容检查通过

revision504 / turn 01a1990e-2f00-7861-a365-bee9fd3272b3确认源码预审通过。2026-11-01T21:43:15.794Z获审三源码、私有适配器、owner及固定Node摘要紧邻匹配后，唯一新入口1pass/0fail/0cancelled/0skipped；组459.6875ms、总510.7936ms，观察进程612实际exit0，运行器12596 status0/signal=null/error=null，测试隔离进程29548正常结束。完整stdout3068B/stderr0；无输出截断。编译8588和固定PS7原生元数据33192各一次，均实际status0/signal=null/error=null/stderr0；编译stdout0，PS stdout408B。

唯一根candidate-identity-a429da46-6821-4643-941b-6b86bef46498，ID EAC36D69:0008000000126228。Node fd3以wx创建32B identity.bin，身份EAC36D69:0008000000126229（dev3938676073、ino2251799814890025），单写32/fsync完成；保持原fd时原生PS进程33192打开句柄61C，返回完全相同身份、32B、Links1、Attributes32及准确最终路径。Node前后size/links/dev/ino/mtimeNs/ctimeNs严格相等；原生无正文读取。原生与Node各一次关闭，opened/closed=true，operationFailed/closeFailed=false，原生关闭码null。没有用进程退出替代句柄关闭证据。

本项DLL实际5632B，身份EAC36D69:000800000012622A；另一叶32B。先交付完整退出/身份/关闭记录后逐一核对并删除两叶和空根，rootRemoved=true/filesRemoved=2，额外只读Test-Path确认根不存在。无本项遗留，不重跑§35/旧矩阵，无NativeDisk、VHD、Storage或WSB操作。

| 获审源码 | SHA-256 |
| - | - |
| windows-sandbox-volume-candidate-identity.test.mjs | BE98F48C38FBE263D783F86D210983A527AD07CD5C4101DBFEB93FAD2779A2CE |
| windows-sandbox-volume-candidate-identity-check.cs | 105AC9493A3557479B86B4ADD7CDFBD2A9B074639AD0C193E1D35752EB88D1C5 |
| windows-sandbox-volume-candidate-identity-check.ps1 | 0CB06D039634C14A1BDA2E0D2803007444D9E88D056DF9E1EA0FC39B890699D3 |

该结果解除固定本机环境中同一登记文件跨接口身份表示的前置疑问；不等同所有文件系统/文件属性、完整私有I/O链或候选VM验收。结果复核后精确暂存六文件至index1978，外1972摘要保持094B136EB63B661FC8894592484B68C706A84A6F01D82BAC4708CC74C0BBEA53。下一最小项仍先与独立审核确认，生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

revision509 / turn 01a19912-080f-70d3-998a-568f7ca94859结果、记录及六文件范围复核通过，并独立确认确切登记根不存在；允许精确暂存index1978，外1972摘要保持094B136EB63B661FC8894592484B68C706A84A6F01D82BAC4708CC74C0BBEA53。无需独立重做真实五叶I/O，可将证据合并到随后唯一候选现场；下一组合profile/源码闭包/外层责任与清理预算先代码及纯检查预审，再审单卷单VM条件。

## 37. 候选链组合适配（七组纯检查通过；未进行候选现场）

### 37.1 已确认最小范围

revision509允许将实际五叶I/O合并到随后唯一候选现场，不增加单独I/O实测；revision511确认固定cmd合成任务；revision512确认失败原始事实保留策略。本项新增candidate-session、candidate-acceptance及七组纯组合检查，既有volume仅接显式互斥CandidateCapture参数，session仅接candidate固定文件/尾行配置；原PS7脚本和原生capture算法不改。所有宿主PowerShell继续固定D:\PowerShell\7\pwsh.exe；不安装来宾PowerShell或Node，本步只验证候选捕获集成，不能声称项目命令后端完成。

固定来宾一次cmd.exe exec：mkdir C:\SuperPiVolume\payload成功后才写payload\a.txt，成功后最后写candidates.json；仅插入严格小写UUID task/snapshot，其余正文/文件名为字面量。正文为super-pi-candidate-v1加CRLF，无&&前尾空格。清单只允许a.txt/add、guest report exit23；CLI进程退出、平台承载的来宾cmd退出与清单exit23分开记录。宿主固定预算16项/单4KiB/总16KiB不变；本次只一个合成目标，不开放真实工程或来源版本提交。

### 37.2 同一外层责任与失败保留

candidateTask持续持有实际LiveSandboxRuntime、TaskVolumeOwner、原VM、driver和PrivateCandidateChannel；外层quiescent直接核对真实owner lease、channel pending/active/uncertain、VM/全部CLI与manager已退出，不能只看volume.state。撤销接到真实volume.revoke，候选core立即撤销；正常读取租约仍跨manifest→request→batch且只在VM/CLI关闭后准入。

正常链核对候选path/bytes后，先由实际owner释放卷并确认manager退出，再从已检查私有字节核对固定UTF-8内容/独立预期SHA及guest claim23；随后独立disposeCandidates并核对Buffer/context释放。channel处置前由外层记录固定行的已观察叶名、ID/fd、创建及独立操作/close事实，原始payload不入报告；最终输出已交付、八个精确文件和根清理后，才dispose channel/runtime/所有任务引用。不会用磁盘release隐式撤销此前候选。

普通失败且卷/管理状态健康、无IO pending或未知时，仍由原release判据决定盘能否释放；失败始终retained，保留所有本次固定产物及外层owner。候选错误叶可能缺失或部分写入，不能假定完整；完整原始IO/close事实不复制进小报告、不丢弃或假装已清理，后续唯一诊断读取后另审精确清理。关闭未知、身份或控制不可信时不发disk release，保留channel/manager/卷责任。volume released不能解除retained或准入下一任务；固定owner根仍占用。

### 37.3 固定源码、资源与报告预算

显式入口参数为--run-candidate-once --source-bundle；默认生产入口未改变。完整25源码集合为既有18 sharing依赖加candidates、candidate-contract/private、manifest/batch partial、candidate-session/acceptance；每次物理派发前重验完整集合及对应工具摘要，最后宿主许可在预留持久化后复核。native仅编译base+manifest+batch至同一DLL，上限128KiB；无额外guest exe、Node复制或runtime安装。

2 helper（preflight、compile）+1 manager+96CLI=99，未决最多4；命令16/消息32不变。正常组合预期7CLI、7manager命令（prepare/verify/verify/manifest/batch/release/exit）、10实际进程对象；manifest及batch原生业务预算与私有五fd/峰1/64公开API分别记录，元数据内部句柄不混算。

candidate清理配置仅native DLL、五正常叶（总32KiB）、两错误叶（另8KiB）、prepare/verify/release/exit四固定错误叶、helper及lifecycle两日志。正常成功还要求八个正常叶准确齐全，额外错误叶或缺失均拒绝；部分失败仍保留本根，不递归清除。完整报告保持8192B journal、7680B主输出、512B尾行；报告仅候选摘要/独立来源、私有计数及固定最多5行、失败阶段/保留原因，不重复原生错误完整表或载荷。

### 37.4 待源码审查的七组定向检查

只准备新增candidate-session入口一次，40秒有界：实际owner/runtime/VM/core/PrivateChannel与内存fs/CLI/driver组合，正常7CLI/7命令及卷释放后字节、八文件精确清理、缓冲/引用/监听释放；五类已关闭失败保留根（包括后补canonical尾换行拒绝）；私有/原生unknown、pending exec和错误回执缺失/部分写入阻断；显式profile互斥/固定命令/末次权限；候选清理白名单；25文件依赖闭合/派发后源码守卫；正常与保留失败完整报告压力样例。替身不导入旧测试入口，没有实际进程构造、文件写、编译、VHD或WSB。字符串/源文件只读核对不替代实际guest命令证明。

性能审查覆盖显式候选外层到既有SharingLifetime/NativeOutput完整链：新增在prepare/read/release及一次最终记录边界，复用既有输出与释放，不改onData/onStderr、每chunk/event帧路径；固定最多5行/3阶段，不引入对象池。只核对新增确定性计数与引用生命周期，不重跑生产热路径或旧矩阵。

原送审八文件起始index1978，外1973摘要F6FBD9128D7B952C75DF43C2B7D8AB772A09FB49D76C5859FA9D656CA566B835。revision519预审后追加已验证原生计数摘要到candidate-contract，当前九文件范围外1972摘要482229BA048E8E713EE9D62130BB3A920875C8F7425261A3370E59202A95EA3B，仍预计index1981。当前尚未执行新检查或编译；先源码预审，再唯一纯组合检查、结果复核/暂存，随后独立审单卷单VM实际条件。生产真实工程接入/默认切换/权限退役关闭，异常GUID失效尚未验收，P0桌面回放待办。

revision519 / turn 01a1991c-a36e-7d83-b7a9-f8fd82cd1e84首次代码预审暂不批准执行。首跑前修正三点：固定内容验证失败时由finally独立dispose已取得候选，补high-bit拒绝后的payload/request/context/task.checked释放断言；core只在完整回执验证后保存冻结manifest/batch实际opened/closed/peak/closeUnknown摘要，正常主证据交付这些实际值，core撤销/处置清除自身引用；纯夹具补实际transport形态、1024B stderr Base64、真实私有根/长ID/最大合法PID与fd、固定工具全路径及预检输出前缀，并新增batch成功回执部分写入terminal（已有三私有记录）和五种完整报告压力形态。理论上界不替代原生实测计数，旧core/私有I/O矩阵不重跑。尚未运行新检查，须最终九文件源码复审。

### 37.5 canonical写入前置与限定CMD检查（待源码预审）

revision522确认原echo manifest与现有canonical判据冲突：manifest必须满足JSON.stringify(value)===text，末尾CRLF也应拒绝。此前首次运行准入已撤回，组合七组与现场均未执行；不trim、不忽略换行、不放宽解析。revision524批准先准备同一固定相对body的宿主CMD兼容前置。

candidateCommandBody只接受两严格UUID，不接路径参数；路径固定为payload\a.txt和candidates.json。生产exec工作目录仍硬编码C:\SuperPiVolume；固定CMD前缀/d /a /e:on /v:off /c。最后一步从已成功写入的非空payload重定向stdin，以set /p SP_FIXED_CANDIDATE=canonicalJSON输出提示文本到manifest，省去管道和无条件成功尾命令。官方SET/CMD资料不足以证明提示文本写失败的完整退出语义，所以此处仍为待验证写法，不能凭语法或windowsVerbatimArguments宣称正确。

新增candidate-cmd检查使用相同prefix/body，宿主cwd是本项新登记case目录，windowsVerbatimArguments=true避免Node额外变换固定参数；宿主常规工具仍使用固定PS7，无PS5、安装、编译或VM。固定C:\Windows\System32\cmd.exe，版本10.0.26100.9949，SHA-256 15CD209C995B7D3009C91CA40892D5B8F1FB162F3E5F10716642EA278E8E0D7B；每次实际派发前复验摘要及cwd身份。

一个新入口只准备三场景各一次：正常精确payload ASCII+CRLF和无BOM/尾换行的完整manifest字节，交既有canonical parser；payload预置为1B登记文件令mkdir失败，最终必须非零且manifest不出现；manifest预置同名登记目录令重定向失败，最终必须非零、payload正确且碰撞目录ID不变。不得用无条件exit0掩盖失败。组合夹具的无换行正常字节和明确CRLF拒绝样例待此前置通过后再同步，并重新送组合源码最终预审。

资源固定为一个根、三个case目录、两个CMD创建的payload目录及一个预置碰撞目录，共7目录；四小文件（manifest读取上限4096B，其余各64B）。Node显式文件句柄为1次预置写和4次读取、最多同时1个；每次关闭只尝试一次，读缓冲和expected/sentinel finally清零。未知ID/关闭/进程或未完整取得的字节证据均保留根，不补跑场景。先登记清理回调再创建根，并立即交付root/ID/PID开始记录。

三CMD各10秒；比原议4KiB更窄，spawn捕获maxBuffer=1024，记录额外强制stdout+stderr合计<=1024B才视为完整，原始Base64按总1024B预算保存，超过则truncated=true并保留。文件原始证据每叶保存最多512B，正常manifest固定小于512B；超出时标记不完整并保留原文件，不冒充完整证明。输出协议总<=16384B（start512、完整事实15360、cleanup512），Base64与转义计入；Node测试运行器外围捕获另32KiB上限。按准确路径和登记ID逐叶删除四文件，再依固定顺序删除7个空目录，不递归、不扫进程；正常/失败原始退出、目录和文件ID、字节/hash/关闭事实先交付。

当前组合项范围增至十文件，外1972摘要仍482229BA048E8E713EE9D62130BB3A920875C8F7425261A3370E59202A95EA3B，预计index1982。先只审并执行这一兼容前置；组合七组、候选现场、真实工程/默认/权限退役均未开放，P0待办。

### 37.6 唯一CMD兼容前置通过，待恢复组合源码复审

revision526 / turn 01a19930-2e23-78c2-a980-c9955c9cadc3仅批准兼容入口一次。2026-11-01T22:19:28.970Z获审body、检查、相关依赖/Node和CMD摘要紧邻匹配后，唯一新入口1pass/0fail/0cancelled/0skipped；组84.4113ms、总137.0017ms。观察进程32464实际exit0、运行器7372 status0/signal=null/error=null，测试隔离Node23988正常结束；完整stdout4023B/stderr0。诊断start172B、完整事实3541B、cleanup92B，合计3805B，均含实际换行/JSON/Base64开销，无截断。

三个CMD场景各一次：normal PID20632 exit0/stdout0/stderr0；prior-failure PID14468 exit1/stdout0/stderr33B（原始Base64 19PEv8K8u/LOxLz+IHBheWxvYWQg0tG+rbTm1Nqhow0K）；redirect-failure PID21472 exit1/stdout0/stderr12B（原始Base64 vty++LfDzsqhow0K）。均signal=null/error=null；每次捕获合计低于1024B。normal payload精确23B、SHA73b7c1798737359d6a0b7a5071509c77d6a64372190145e20df26ef0d5f44c81（固定ASCII及CRLF）；manifest精确220B、SHA1d21ef266a87d6ee3e21d08d9b23af70510cd060c1f47ae6f0870c291139141a，字节完全等于预期JSON.stringify且现有canonical parser接纳，无BOM/尾换行或额外空格。前步失败未创建manifest，1B预置文件保持；最后重定向失败时payload匹配、碰撞目录身份保持。

唯一根candidate-cmd-fa8198d8-6335-4d14-8f29-f5449cdebab8，ID EAC36D69:000B000000126259。七目录和四文件均登记实际ID，五次显式Node文件打开串行，fd数值复用3但每次各有独立记录/一次已知关闭、无操作或close错误。先交付完整事实后删除四文件及七空目录，rootRemoved=true/removedFiles4/removedDirectories7；额外Test-Path确认确切根不存在。无本项遗留；无编译/PS5/VHD/WSB或旧矩阵执行。

获审body/session SHA49F87F55707F6DA0DA4FB59CEF030137AC7A8F15A46B83E9B2F6A38E15DEDF18，CMD检查SHA9AE3C1B4A0B99B1BD59208681123A6B59BCACFC67576178247AE9F760770B064。该前置仅证明本机指定CMD/cwd下的字节和两个确定失败控制，不证明WSB工作目录兑现或完整候选链。依据本次事实，纯组合fixture正常manifest已改无换行，额外manifest-crlf反例要求仍被既有parser拒绝且候选上下文/字节清除；生产-d固定值也加入断言。

十文件整体尚未暂存：CMD前置结果与更新后的组合源码需复核，随后只执行新七组一次，不重跑本项三场景或旧矩阵；组合实际报告预算尚未验证。预计index1982，外1972摘要仍482229BA048E8E713EE9D62130BB3A920875C8F7425261A3370E59202A95EA3B。生产真实工程/默认切换/权限退役关闭，异常GUID及P0桌面回放待办。

### 37.7 最终预审后唯一七组纯组合检查通过

revision531 / turn 01a19937-2751-7702-b0e3-5ca584dffb4c复核CMD结果、根不存在及组合最终源码，通过唯一七组40秒/并发1准入。2026-11-01T22:28:56.990Z获审源码/依赖/Node摘要紧邻一致后，首次运行7pass/0fail/0cancelled/0skipped，总112.7481ms；观察进程9516实际exit0，运行器32456 status0/signal=null/error=null，stderr0。没有重跑CMD、私有I/O、identity或旧矩阵；无实际业务进程构造、文件写、编译、VHD或WSB，无本项临时产物。

正常组合实际替身计数为7CLI、7manager命令、10进程对象、8叶删除；5私有fd打开/关闭、峰1、64公开API，实际原生回执计数从验证后manifest(3/3/2)、batch(5/5/4)冻结摘要交付。这些是替身组合事实，不标为真实原生现场计数。共享盘释放后固定字节/独立摘要匹配、guest claim23与平台cmd0区分、core Buffer/context清除及channel/runtime/task/监听引用释放均通过。known-closed、未知关闭、pending、缺失/部分错误或成功回执按固定策略保留；尾CRLF被原parser拒绝，未降低完整性判据。

| 完整报告样例 | 最大持久化journal字节 | 实际主输出字节 | 尾行字节 |
| - | -: | -: | -: |
| normal（最大host PID） | 7544 | 6126 | 176 |
| private-unknown | 6564 | 5076 | 239 |
| native-failure | 5966 | 4738 | 239 |
| error-receipt-missing | 7516 | 6229 | 239 |
| batch-receipt-partial（1024B原始stderr Base64及三私有记录） | 8144 | 6540 | 239 |

上表均采用完整来源、工具路径、长ID及实际报告字段；末项journal距8192上限仅48B，不能外推为任意错误文本均可容纳。现有journal/主输出/尾行8192/7680/512硬限制保持，超限仍保留责任与证据，不准入清理。正常第一组另为journal7544/main6120/footer176。最终测试SHA EED54D844C03FA32F327FC945FEACF90F5F21D452CF6B541FD3756D0A8FDAB64；候选25源码只读集合347513B，bundle 27ca2f5d62d4151159def9e0e9cb2906ff997b81a948e53f477256272776d2d2。

本项十文件结果与记录待独立复核后精确暂存，目标index1982、外1972摘要482229BA048E8E713EE9D62130BB3A920875C8F7425261A3370E59202A95EA3B；既有九项删除与未跟踪补丁不动。下一项仅审一个128MiB固定卷、一个VM、一次合成候选写入和完整自动收尾的现场条件，尚未启动；不重做容量/剪贴板/禁网矩阵。生产真实工程/默认切换/权限退役关闭，异常GUID及P0桌面回放待办。

revision535 / turn 01a1993b-a724-7860-80a8-2ce7f7c4242e完成结果、三份记录、七代码摘要、源码集合及任务外范围复核，准予上述十文件精确暂存至index1982。现场条件已列明，仍须暂存复核及具体观察方式临行确认；不能将本项纯检查或暂存准入当作现场执行/通过结论。

## 38. 唯一候选现场通过：实际捕获、卷释放后消费与自动清理

revision537 / turn 01a1993e-502c-72e3-9244-42b04ccaf776完成index1982/十文件/固定根空闲/直接观察wrapper复审，批准一个128MiB固定卷、一个VM、一次固定候选exec。紧邻核对固定Node及根不存在，入口和每次物理派发继续校验获审25源bundle 27ca2f5d62d4151159def9e0e9cb2906ff997b81a948e53f477256272776d2d2、固定PS7及配置/CSC/CLI。唯一入口开始于2026-11-01T22:33:49.839Z，宿主owner PID25916，工具session23835；主记录22:34:05.679Z，最后工具实际exit0。完整开始行174B、主记录6021B、清理尾行176B，合计6371B，无截断或异常摘要。

实际task=eeda94ae-3214-4f70-b380-0fdd7b053281，snapshot=4bc57752-bbc5-4a5d-885a-d9b5ddcd8f90，VM=43ee8768-0398-4d89-9d15-23ffd0e1a9bb，宿主根ID=3938676073:2251799814890099。preflight PID23124与compile PID32952各实际exit0/signal=null/launchError=null/stderr0；固定PS7版本7.6.9，NTFS可用87990267904B/门槛168820736B。SeManageVolumePrivilege存在、预检为Disabled，后续本次实际原生管理成功，未把预检状态写成Enabled。仅编译base+manifest+batch，DLL61952B，SHA b265c5521e0f91821e63b0893953ddbc50c04432e59971fead408d588799b68b。

实际镜像身份EAC36D69:00100000001262A5、diskId等于task；从本次VHD句柄取得设备PhysicalDrive1，绑定卷970e0835-0000-0000-0000-100000000000与exchange身份3213FBD8:0001000000000024，容量134217728B。VM实际registered/startSettled/stopAttempted且最终closed，7CLI全部结算；总10实际进程对象observedStarted=physicallyClosed=10、pending空、launchUnknown0，最后list PID27608退出0且平台列表为空。manager PID24716实际exit0，state/released、detached/managementClosed=true，buffersReleased=true，stderr0，无pending/reading/closeUnknown。

### 38.1 实际候选与关闭计数

实际来宾工作目录及固定命令兑现：manifest220B通过原canonical判据，payload23B，候选path=a.txt/add、sourceId3213FBD8:0001000000000026，SHA 73b7c1798737359d6a0b7a5071509c77d6a64372190145e20df26ef0d5f44c81。CLI承载的来宾命令exit0与不可信清单guest-report exit23分别记录；status=candidate-data-checked不宣称任务成功。卷已释放且manager已退出后，独立候选字节仍与固定正文和独立预期SHA一致，matchedAfterRelease=true，随后buffersReleased=true。

native已验证实际回执为manifest opened3/closed3/peak2，batch opened5/closed5/peak4，两者closeUnknown=false；不是理论上界或替身计数。私有适配器实际opened5/closed5/peak1、64公开API、pending=false/uncertain空，各显式fd仅一次关闭。适配器分配1325B并全部转交真实TaskVolumeOwner；adapter cleared0表示已转交，不是其自身清零。按已审代码，TaskVolumeOwner在physicalSettled后清零原始manifest220B/receipt466B/batch receipt616B/payload23B，另独立清零借给writer的199B request副本；core对自身复制的清单、回执、请求和payload分别承担清零责任。现场core最终retainedPayload/request=0及retainedContext=false判据通过，不把transfer计为适配器清零，也不将字段摘要声称为1325B原缓冲逐字节遥测。

| 私有叶 | 实际原生表示ID | fd | 关闭尝试 |
| - | - | -: | -: |
| candidate-manifest-receipt.json | EAC36D69:00050000001262AA | 3 | 1 |
| candidate-manifest.bin | EAC36D69:002F0000001262A4 | 3 | 1 |
| candidate-request.json | EAC36D69:00220000001262A9 | 3 | 1 |
| candidate-batch-receipt.json | EAC36D69:00050000001262AD | 3 | 1 |
| candidate-payload.bin | EAC36D69:00110000001262A7 | 3 | 1 |

五记录均opened/closed=true，无operation或close错误；request由wx创建，其他四叶只读。原生业务计数与私有fd计数独立，不混入Win32内部瞬时元数据句柄。最终候选stage=published、leaseHeld=false、physicalSettled=true，无保留原因。

### 38.2 证据交付、八叶清理及范围结论

主报告在清理前生成，因此当时passed/artifactsRemoved/taskReferencesReleased=false是预期阶段值，sequencePassed=true且无error/cleanupError/cancel/revoke/journal/output失败。后续完整尾行为passed=true、artifactsRemoved=true、retained=false、removedFiles8、cleanupError=null；结合入口通过判据和实际exit0，确认清理及任务引用释放。没有只用清理前主报告判断最终成功。

| 精确删除叶 | 已登记Node身份 | 字节 |
| - | - | -: |
| volume-native.dll | 3938676073:1688849861468838 | 61952 |
| candidate-manifest.bin | 3938676073:13229323906605732 | 220 |
| candidate-manifest-receipt.json | 3938676073:1407374884758186 | 466 |
| candidate-request.json | 3938676073:9570149209367209 | 199 |
| candidate-payload.bin | 3938676073:4785074605286055 | 23 |
| candidate-batch-receipt.json | 3938676073:1407374884758189 | 616 |
| volume-helper.json | 3938676073:2533274791600812 | 525 |
| lifecycle.json | 3938676073:3096224745022123 | 7326 |

八叶合计71327B，最后lifecycle7326B低于8192上限；在主证据交付后按身份逐叶清理，最后删除空根。工具结束后额外只读Test-Path确认D:\RMProjects\Pi\.artifacts\windows-sandbox-acceptance-owner不存在。本项无残留镜像、编译文件、私有载荷或任务根；正常序列自行收尾，无强退、猜测终止或恢复删除。没有重跑CMD、旧容量/剪贴板/禁网/取消矩阵，也没有真实工程写入。

结论仅为本机固定版本下这一个合成候选的正常端到端链路与正常自动清理通过；异常GUID脱卷/缓存/重连旁路、任意项目PowerShell/Node运行环境、真实工程保护/变更回接、生产默认与旧权限退役均未由本项证明。结果先独立复核，再仅三记录精确暂存；之后与审核确认下一最小工作。P0桌面回放仍待办。

revision542 / turn 01a19940-0a45-7c03-82cf-d19853c54df8复核现场限定结论及三份记录，独立确认根不存在、五叶身份对应和两组字节合计，批准同步契约页首状态后精确暂存三记录。index保持1982，外1979摘要88BD0E7DA9032F5A55744C20D8360AB8ED0335571E27E35D973E88A7F8AA0160。下一先推进异常GUID/脱卷检测点、撤销和责任保留的方案与代码项；当前没有主动脱卷、终止manager或新VM执行准入。

## 39. 登记后、exec前再验卷身份（新增阶段检查，待代码预审）

revision544 / turn 01a19943-8232-7c23-9386-fe1ffef12695确认下一最小项。此前issue/start前verify及native捕获阶段核对已有卷；VolumeProtocol控制丢失/异常关闭/错误/超时通知owner.onUnsafe，owner撤销真实core及mapping、取消执行，unsafe禁止release，外层保留根和责任。它们不是持续卷监测。配置仅规范GUID+exchange，无普通宿主RW目录回退；异常平台缓存/重连/脱卷行为仍未验收。

新增仅candidate-session的executeCandidateFixture：VM已登记后、进入executing状态前await既有volume.verify一次。现有helper Verify-Ready只核对镜像/设备/分区/卷/exchange，不初始化或格式化；源码允许已启动VM，但实际兼容尚待新版本现场。await前保存原task/instance ID及对象引用，返回后核对同一task字段、VM/volume/driver/runtime、ID、登记状态、未清理/无未决调用、未取消、原runtime绑定及卷/driver健康，随后才修改VM状态。原预留持久化后的末次派发守卫保留。失败沿既有onUnsafe/取消/VM收尾/保留链，不增加轮询、恢复、重试、kill或路径回退。

新版本正常manager命令由7增至8，仍16命令/32消息上限；7CLI/10进程对象、报告字段及8192/7680/512上限不变。§38原bundle及7命令实测为历史事实，不能改写为本版本已通过。当前25源348391B，bundle f0d0519040f1127dc1470ddd2a23c7c4488ff2ea39beffcff3cfcb56f6c9ecae；仅源码只读摘要，未运行现场。

拟仅按名称筛选四组、40秒/并发1：受影响正常顺序（登记后恰一次verify、8命令后完整清理）；新增绑定变化/verify失败/待定失效后迟到成功（0exec、撤销取消、禁止release、准确保留及三新失败报告预算）；新增await期间九种对象/ID/取消/清理/登记变化（禁止exec/capture）；复用现有profile和末次派发替换/撤销组。其他旧组与全部旧矩阵不跑；纯内存fs/CLI/manager，无实际VM/编译/磁盘或产物。

性能范围仍为显式冷入口，新增一次阶段调用和一次runtime视图读取，沿用既有manager/输出处理；不改onData/onStderr或生产进度/渲染热路径，不引入对象池。新五文件（session/test及三记录）起始index1982，外1977摘要F13B4259E69A2434834D02F2232CBB180F10E38D0DC27C7EB708611BD7798BEE；先代码复审再唯一四组，尚未执行。生产真实工程/默认/权限退役关闭，P0待办。

### 39.1 唯一四组定向检查通过

revision548 / turn 01a19947-5150-7813-9231-155b7333d430源码预审通过。2026-11-01T22:44:39.301Z紧邻核对获审源码/依赖/Node摘要后，按获审名称筛选仅四组首次运行，4pass/0fail/0cancelled，88.3673ms；观察PID18224实际exit0，runner20644 status0/signal=null/error=null，stderr0。其余五组没有执行，输出skipped0是Node筛选未登记那些组，不表示运行了全部九组。无业务进程/文件写/编译/VM/磁盘产物。

正常替身实际为7CLI/8manager命令/10进程对象，登记后verify恰一次，随后exec恰一次，8叶清理/5私有fd峰1/64API及缓冲/引用释放通过；journal7545/main6121/footer176B。三新增失败预算如下：

| 替身失败点 | 登记后verify次数 | exec实际工厂调用 | 最大journal | 主输出 | 尾行 |
| - | -: | -: | -: | -: | -: |
| verify-identity | 1 | 0 | 5775 | 4471 | 213 |
| verify-failure | 1 | 0 | 5800 | 4496 | 213 |
| verify-pending，unsafe后迟到成功 | 1 | 0 | 5778 | 4474 | 213 |

三个失败均撤销/取消、无capture/release，原manager/volume及外层owner保持，文件删除0；pending例是unsafe通知和迟到回复注入，明确driver仍未物理关闭，不冒充真实manager退出或脱卷。跨await九种变更和原末次守卫替换/撤销均拒绝exec。所有报告仍在既定硬上限内，未跑旧五种压力矩阵。

获审session SHA D48F2E7AE4A4EA627F3205F9595CCE8E4D963139616D71B8087EDB3290529155、检查SHA801FF544EFC8E9529E64326EECEA2CBD99758BE3D84BB09DA4A924A45BC4F9D3不变；结果待复核后五文件精确暂存，index1982/外1977摘要F13B4259E69A2434834D02F2232CBB180F10E38D0DC27C7EB708611BD7798BEE。新版本在VM已登记时的verify现场兼容、实际控制失效和平台脱卷/缓存路径仍分别未证明，下一必要现场触发点与精确收尾须另审。生产真实工程/默认/退役关闭，P0待办。

revision550 / turn 01a1994a-63b4-79c3-9a00-5233ce915e9f复核通过，准予上述五文件精确暂存。下一只读方案固定为“已登记VM真实verify成功后，原manager异常退出”，先落实原创建对象绑定的一次性触发能力与故障后精确收尾证据链；当前不执行kill/detach/新VM，也不将控制退出推定为卷已分离或旧GUID打不开。

## 40. 管理进程失效的专用收尾契约与纯计划（待源码预审）

revision550选择单一后续故障目标：同一VM登记并完成一次真实verify后，原manager异常退出。revision553/555确认先补专用收尾契约和纯核心，再接默认关闭的终止能力、原生诊断与删除执行器。当前故障现场被收尾证据链未接通所阻断；不表示平台机制不可行，也不授权kill/detach/新VM。§39定向结果已按revision550精确暂存。

### 40.1 已核对的机制依据与不同事实

固定Node v26.13.0的[ChildProcess实现](https://raw.githubusercontent.com/nodejs/node/v26.13.0/lib/internal/child_process.js)将kill交给原_handle；[ProcessWrap](https://raw.githubusercontent.com/nodejs/node/v26.13.0/src/process_wrap.cc)传递原uv_process_t；[Windows libuv](https://raw.githubusercontent.com/nodejs/node/v26.13.0/deps/uv/src/win/process.c)保存创建所得进程句柄并用于终止。该链支持绑定原ChildProcess的一次性能力，不能换成按PID重新查找。SIGTERM在此Windows实现使用TerminateProcess；请求返回、Node error/异常与实际close分别记录，Node映射错误不标成原始Win32错误。

只读诊断拟使用OpenVirtualDisk的GET_INFO权限；[GetVirtualDiskInformation](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-getvirtualdiskinformation)不要求镜像已附加，[IsLoaded定义](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-get_virtual_disk_info)提供当前挂载使用状态，并同句柄核对disk ID、容量及fixed subtype。[OpenVirtualDisk](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-openvirtualdisk)失败时输出句柄未定义，成功句柄才登记并关闭一次。以上是官方接口/固定源码依据，不是本机API布局、原始错误码或故障行为的实测。

后续预期顺序为登记→真实verify结算→持久登记一次故障尝试→最终宿主绑定核对→原child单次终止请求→实际close→unsafe/取消→所属VM及CLI收尾。此触发点没有候选，不能宣称实测了既有候选Buffer撤销。manager关闭、镜像未附加、旧GUID打不开、共享缓存行为是不同事实；不得绕过失效守卫追加guest exec。诊断不主动attach/detach，额外共享缓存探针另审。

### 40.2 仅生成纯计划，不授予物理删除权限

新增[纯收尾契约](../scripts/acceptance/windows-sandbox-volume-fault-cleanup.mjs)无fs、spawn、CLI或生命周期释放入口。构造时固定task/instance、根/镜像原生表示ID、镜像长度、GUID、manager PID，以及owner/VM/driver/runtime/诊断/输出六个不同原对象引用。固定宿主观察器是信任边界，只能由随后专用host adapter提供，不能由CLI、来宾或任意外部回调注入；对象身份本身不证明观察事实真实，实际接线必须读原对象状态。当前替身只证明契约判定，不能产生物理关闭或删除授权。

观察器按严格数据结构交付原故障、全部物理状态、原诊断调用及原始回执、输出交付状态、根及固定文件清单。模型要求一次已接受故障请求、实际异常结果、unsafe/取消/任务拒绝，且exec/capture为0；VM及6..95CLI全部关闭，总进程=CLI+4且<=99，manager和诊断关闭、pending/unknown/candidateBytes为0。诊断进程PID须对应宿主记录，exit0/无signal/launchError/截断/stderr，实际stdout字节与原回执一致。全部均为待真实适配器证明的来源要求，不能以调用方几个true替代。

仅接纳严格有界规范诊断成功回执：绑定task/instance/root/image/disk/GUID/镜像长度，128MiB/fixed、IsLoaded=false；旧GUID打开失败只暂接受明确not-found码2/3，权限拒绝或其他错误均未知，原生项还须核对实际API/错误语义。成功回执列root/image/vhd-info三个确切句柄，一次关闭、无操作/关闭错误；意外成功GUID句柄或未知状态不发资格，原始失败保留给后续诊断。文件里的诊断字节摘要还须与原调用输出一致。

资格使用对象身份token，JSON往返、拷贝或跨任务对象不能恢复能力；一次消费绑定完整证据版本、全部原对象及准确五叶。观察器回调前先预留阶段，回调重入或撤销不能使资格复活。每叶模拟前复核当前证据及剩余清单；模拟完成后核对目标已不存在，再推进唯一顺序。证据版本、身份或长度变化、未知、重放、输出未交付和部分失败都永久阻断旧资格并保留上下文。末尾仅在模拟五叶及根均清除后释放本模型引用，原owner retained、volume状态及保留计时器均不改动。原故障事实始终保留，不变成正常任务成功，不恢复派发或volume.release。

### 40.3 固定预算及完整证据交付

| 拟议故障资源 | 上限/责任 |
| - | - |
| 进程与调用 | 3 helper（预检/编译/诊断）+1 manager+95CLI=99，未决<=4；无exec正常预期6CLI/总10对象 |
| 原生诊断显式槽 | root/image元数据、VHD GET_INFO、意外成功旧GUID，共4槽/峰<=4；打开成功即登记，每次关闭最多一次 |
| 原生诊断过程 | 一个额外固定PS7调用，15秒；stdout/回执<=4096B、stderr<=1024B，JSON及实际换行算入 |
| 完整诊断原文出口 | 独立raw envelope含task/原SHA/Base64及换行，<=6144B，必须完整交付确认；摘要/hash不能替代原文 |
| 普通记录 | journal<=8192B、主报告<=7680B、尾行<=512B保持；交付完整raw和主报告后冻结相关日志 |
| 纯核心缓冲 | 每次校验最多一个4096B显式副本，finally清零并计allocated/cleared/active/peak；借入原回执不改动，无对象池 |

成功计划必须准确齐全且唯一的五叶，依次task.vhd<=135266304B、volume-native.dll<=131072B、volume-helper.json<=8192B、fault-diagnostic.json<=4096B、lifecycle.json<=8192B。根私有，镜像精确身份和长度固定；缺失、额外叶、链接/重解析或属性判定留给真实文件适配器先证明，纯核心不冒充已经检查磁盘对象。最终清单后logFrozen要求成立，日志再变必须废弃旧资格重新审定，不能沿用旧身份/长度。原文和主报告须先完整交付；真实执行器随后只能逐叶按身份删除并删除空根，不递归、不重试。

### 40.4 本项定向源码与执行边界

新增十组纯检查，拟唯一40秒/并发1入口：固定五叶模拟及仅自身引用释放；六原对象/身份；诊断关联/附加/GUID错误/关闭未知；诊断进程/完整原字节；各物理未决及原故障；原文交付/冻结；精确清单和证据变化；token序列化/跨任务/重放；部分失败及falsy原因；观察器重入/数据getter拒绝。无真正诊断、文件、进程或删除，不重跑既有矩阵。当前还未执行。

本项五文件为新core/test及三记录，起始index1982/外1979摘要87B163CBBA37CB4CD86CCCEFDF05E1583B22E49C01EC2F502D06B102758AAC57，目标index1984。显式冷的契约边界，生产热路径未改。先源码预审、仅十组一次、结果复核及精确暂存；之后才接真实诊断/终止cap/专用收尾。生产真实工程/默认切换/权限退役关闭，P0桌面回放待办。

### 40.5 唯一十组纯检查通过

revision557 / turn 01a1995e-8612-7fe1-be0d-cd95411a1aca源码预审后，2026-11-01T23:12:04.027Z紧邻核对两获审源码与固定Node，仅新入口十组首次运行：10pass/0fail/0cancelled/0skipped，63.9071ms；观察PID8872实际exit0，runner20840 status0/signal=null/error=null，stderr0。没有旧矩阵、真实诊断、文件/进程业务操作、删除或终止，也无本项临时产物。

正常模型实际14次观察、模拟五叶；该样例原回执603B，显式副本累计allocated=cleared=8442B、峰603B、active归零；只释放本模型context/observer，原宿主对象retained及原故障事实保持。各拒绝分支校验借入原文不变、已分配副本清零；身份/未决/原文交付/证据变化/token重放/部分失败/falsy及重入反例通过。以上是纯契约观察/缓冲计数，不是Windows进程、原生句柄或真实文件清理事实。

独立原文封装边界实际4096B输入生成5639B完整Base64 JSON行（含换行），低于6144；4097B拒绝，解码逐字节匹配且测试副本清零。这个4096B样例验证封装预算，不把任意4096B字节声称为诊断成功回执。主/尾及journal上限未改变。

两源码SHA仍735D15F4AACF8F0A72ED392675AF6D7D759A39D548DE44231DB6D6F462354D29 / FC7EEDEB80032A108C9EDB8B49CB12AC4FE38F8AD1A139ED6FBA66754FF8E0C7。五文件结果待复核后精确暂存index1984，外1979摘要87B163CBBA37CB4CD86CCCEFDF05E1583B22E49C01EC2F502D06B102758AAC57保持。下一先审只读原生诊断的固定调用/结构/关闭证据实现，不重复三条终止链检索或旧矩阵；真实诊断、终止cap和专用删除/外层释放仍未接通，故障现场继续不准入。生产真实工程/默认/退役关闭，P0待办。

revision558 / turn 01a19964-7559-7af0-a7a5-df712232c599已复核本项结果、摘要和范围，批准五文件精确暂存；十组运行数字来源为实施记录，审核独立核对源码与文档。下一仅独立原生只读诊断源码、一次编译及纯替身，真实适配器调用必须为0。


## 41. 原生故障只读诊断独立实现与纯检查预审

revision558批准§40五文件精确暂存，已完成index1982→1984，任务外1979摘要87B163CBBA37CB4CD86CCCEFDF05E1583B22E49C01EC2F502D06B102758AAC57不变。后续按同次审核范围，仅新增独立FaultDiagnosticOwner及只读适配器，不构造NativeDisk，不更改原管理器、owner、正常失败保留或生产热路径。真实诊断调用、终止cap、删除及故障现场尚未准入。

### 41.1 接口与固定布局

[微软打开参数说明](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-open_virtual_disk_parameters)明确RWDepth=0适用于只读；实现固定Version1、RWDepth0、GET_INFO=0x00080000、flags0，无权限重试。访问枚举页面本轮不可读取，改核对[微软SDK头文件](https://raw.githubusercontent.com/microsoft/win32metadata/main/generation/WinSDK/RecompiledIdlHeaders/um/virtdisk.h)中的权限、结构和版本，不重复检索。该头文件完整Open union含Version3，存储44B、Version偏移0/RWDepth偏移4；只使用Version1前缀，其余零初始化，不能复制CreateParameters的8字节union偏移。

[GET_INFO结构](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/ns-virtdisk-get_virtual_disk_info)的union按64位成员对齐至8；固定布局32B，Size全部字段读到32、Identifier读到24、Subtype/Win32 BOOL读到12。运行入口先以纯托管Marshal断言x64/little-endian及Open44、StorageType20、Info32、FileInfo52、StandardInfo24和关键偏移；后者两个BOOLEAN为1B，IsLoaded为4B。每次查询复用同一64B数组，清零后写版本；[接口文档](https://learn.microsoft.com/en-us/windows/win32/api/virtdisk/nf-virtdisk-getvirtualdiskinformation)成功才定义输出，因此DWORD失败/size或used不足、超64、版本变化均拒绝且不解析，不扩容或重试。

### 41.2 四槽与身份责任

调用方必须先持有FaultDiagnosticOwner再调用Run，异常后继续保留原owner；四槽分别为root、image、VHD-info、意外打开成功的旧GUID。根/镜像以READ_ATTRIBUTES、OPEN_EXISTING、OPEN_REPARSE_POINT打开，仅共享读写、不共享删除；根另BACKUP_SEMANTICS。两元数据句柄和GET_INFO句柄持续持有至最终核对，成功句柄立即登记，失败OpenVirtualDisk输出未定义，绝不登记或关闭其垃圾值。旧GUID去掉末尾斜杠、access0/share7/OPEN_EXISTING，只接受打开失败码2/3；其他原始错误保留，成功则登记第四柄后拒绝成功回执。

根/镜像同句柄检查原ID、最终路径、普通类型/属性、单链接/未删除；镜像精确EOF及128..129MiB Allocation。GET_INFO同柄核对task disk ID、128MiB、fixed subtype2、IsLoaded四字节值0，最后复核两元数据的ID/路径/长度/Allocation/属性/链接/创建及修改时间。GetFinalPathName固定512字符，短失败或超界停止；没有路径重开、创建、attach/detach、格式化或权限调整。

finally逆序关闭每个成功登记槽最多一次，操作异常与关闭异常独立记录；关闭失败保留精确句柄、原adapter及责任对象，禁止再次Run/新获取。其余可关闭槽仍各尝试一次。64B显式查询缓冲finally清零，计allocated/cleared。仅全部操作及三柄关闭成功、旧GUID明确不存在时生成规范JSON加LF，<=4096B，与§40已审成功schema相同；失败没有SuccessReceipt，不冒充未附加证明。这里尚不写诊断文件或输出原文，交付/真实清理接线后续另审。

### 41.3 待审最小检查及产物

新增三源码为diagnostic.cs、fixture check.cs及Node单入口，连同三记录共六文件。拟一轮编译独立DLL（<=64KiB）、一次固定PS7加载，执行111个内存替身分支；真实适配器计数必须0。覆盖2/3正常、四槽失败及未定义输出、GET_INFO各版本错误/长度/值、BOOL高字节、元数据前后变化、意外GUID打开、原操作/关闭异常、四槽未知、一次关闭及重入拒绝。最大四假句柄、64B缓冲；计数和成功原文由PS7输出后交Node核对，不以替身称现场成功。

仅检查编译器与PS7两个子进程，每个15秒/stdout<=2048B、stderr<=1024B；整体40秒、并发1。临时根为.artifacts/volume-fault-diagnostic-check-UUID，唯一fault-diagnostic-check.dll；先记录目录/文件ID及调用原始输出、实际关闭，再按精确身份删除DLL和空根，不递归、不按名字搜索或清理别项。未知进程/文件状态保留责任。本项不产生VHD/WSB，不重复任何已过矩阵。

六文件起始index1984/外1981摘要1989B242AF4A583BF1C3B4711DCA5B6A970F6768D968050EF829AB45AAD3BD88，目标index1987。当前仅源码，检查未运行，先送审核。生产真实工程/默认切换/旧权限退役关闭，P0桌面回放待办。


### 41.4 唯一编译与111分支通过，产物已清理

预审先指出runner创建先于清理登记、截断证据仍可删除、删除前根检查过早的问题；均在任何运行前修正。最终入口先登记creationAttempted/rootCreated/identity，未确认身份或进程/输出完整性则保留；完整证据交付后每次unlink/rmdir前调用ownedRoot重新核对原dev/ino/目录/非链接/realpath/固定parent。revision565 / turn 01a19971-e53e-74e3-a6de-a2fe57e224d6对最终版本批准一次编译+纯替身。

2026-11-01T23:29:37.798Z紧邻确认三个获审源码与固定Node后首次且唯一执行：observer23288实际exit0、runner32284 status0/signal=null/error=null；Node入口1pass/0fail/0cancelled/0skipped，总522.4682ms（该项460.7764ms）。两个子调用均实际closed/exit0/signal=null/error=null/exception=null/无截断：compiler28844 stdout0/stderr0，固定PS7 8992 stdout835B/stderr0。原始两调用输出已先完整交付；整体runner stdout2407B/stderr0。

夹具返回111场景、真实nativeAdapterCalls=0、四固定槽/假句柄峰4/最大保留假句柄4、64B显式scratch、失败关闭重试0；每例验证allocated=cleared及实际数组全零、重复Run无新操作，已知关闭释放adapter、未知保留原责任。正常三柄各关闭一次、成功回执600B含LF，Node逐字段及规范JSON核对通过。以上是布局与纯算法证据，没有实际OpenVirtualDisk/GetInfo/CreateFile查询，也不证明本机原卷已经失效。

唯一根.artifacts/volume-fault-diagnostic-check-7bfdfb06-0bb1-4a8f-8ae2-02cf9dcd8957，原身份3938676073:5348024558707048；唯一fault-diagnostic-check.dll为28672B，身份3938676073:1970324838179596。完整身份/证据输出后精确删除1文件及空根，footer rootRemoved=true/filesRemoved=1，独立只读核对该准确路径不存在。无VHD/VM/其他产物，不重跑已过矩阵。

获审/运行源码SHA：diagnostic.cs 6A12D48FA209E8482F1906B3C4B4E16EC317380C2600017F5E494A8429A0FC4B；fixture 7D9C22CC6E44FA9F12ACBFA605B3B53BEB887ABF7928147D66B8D4632C64E747；runner 96BC45FC39FCB958290C522A57903F3A41AA7DC3E9D758D75320A6571C8F71CF。六文件结果待复核后精确暂存index1987，外1981摘要1989B242AF4A583BF1C3B4711DCA5B6A970F6768D968050EF829AB45AAD3BD88须保持。下一最小故障触发能力/独立宿主观察与诊断包装仍需审定，不能直接恢复完整故障现场。生产真实工程/默认/权限退役关闭，P0待办。

revision570 / turn 01a19973-7efd-7012-97f1-60c91faea6a9已复核六文件结果、原源码摘要和准确根不存在，批准精确暂存；下一按单次原child故障能力→PS7诊断/原文与真实观察→五叶清理/外层释放→现场准入的依赖顺序推进。


## 42. 单次原管理进程故障能力与纯组合预审

revision570已复核§41六文件并精确暂存index1987/外1981摘要1989B242AF4A583BF1C3B4711DCA5B6A970F6768D968050EF829AB45AAD3BD88。本项按该次确定顺序先固定触发与实际close的关系，仍无实际kill/新VM；诊断包装及真实观察、五叶清理/外层释放随后接线。

### 42.1 专用工厂，普通路径不提供能力

在原windows-sandbox-volume.mjs中增加ManagerLossFactory及createManagerLossFactory。固定启动验证/参数抽为私有spawnVolumeHelper；普通launchVolumeHelper仍只构造同一个VolumeProtocol，不创建故障工厂或额外监听器。专用工厂只接受root/taskId/nativeSha256三个字段，复制后固定；不允许candidate/capacity或任意命令开关。工厂构造无I/O，调用方先持有工厂再显式launch，在child创建点立即持有原对象并在原协议监听前登记专用error/close观察，随后构造同一个VolumeProtocol。无公开child、PID重查/kill、通用杀进程入口或正常deadline终止。

新类与工厂放在同一获摘要文件，没有新增普通入口的传递依赖，既有源清单文件数不变；历史源码bundle仍只描述当时现场，不沿用为本轮运行许可。初始编写的新独立模块已合入此文件，按本项新文件原身份3938676073:2533274791600832清除，不触碰用户文件。

### 42.2 一次资格、实际verify及末次守卫

verifyAndArm只允许一次，固定原task/driver/volume/VM/runtime/signal和instanceId，入口核对后实际调用volume.verify，await结算后再次核对同一组对象及登记/任务ID/VM ID/无活动调用/无清理/未撤销、prepared卷/dispatched映射、driver无pending/未关闭/未blocked及原child PID/exit/signal/killed状态。只有这个verify完成才能设verified，不能由调用方true替代；该纯项里的卷/VM/runtime状态仍是替身，后续真实宿主接线不能据此省略实际owner来源。

request先在内存消耗attempt=1，再同步调用固定宿主journal；抛出（含undefined）或非同步返回均永久阻断本资格。持久回调后再检查原绑定与许可，之后不插入await或日志回调，直接调用原child一次SIGTERM。请求返回true/false、抛出原值、Node映射error及独立close分别记录；返回不等于物理关闭，不将Node错误写成原始Win32错误。撤销、重入、身份变化和日志失败均不触发或重试。

专用观察的记录失败被捕获，不得阻断原VolumeProtocol处理关闭和unsafe；error只保留首个原错误及有界元数据，最多四次持久观察，计数5明确为>=5且truncated=true。close单次观察、移除本项监听并清除child引用；原driver仍独立负责协议缓存/未决/监听及unsafe。dispose不发终止；未使用能力可释放自身引用，已消耗attempt且尚无实际close则保持责任，未包成driver的child也不能提前丢弃。启动尚未返回时的回调dispose被拒绝；close回调内dispose和verify跨await dispose不会恢复能力。已清理后只保留有界标量事实，不解除外层owner责任或清除原故障。

### 42.3 待审检查与性能边界

新增唯一Node纯入口十二组：默认关闭/普通协议；正常单请求与close分离；false/异常/falsy/error事件；持久回调后的十种变更；verify跨await八种变化与失败；日志失败和异步返回；观察记录失败不阻断原协议；撤销/未用dispose；attempt回调重入；close/await中dispose；启动包装失败保留；错误记录上限。组合实际VolumeProtocol与新工厂，进程/卷/VM/runtime为内存替身，原Protocol命令/缓冲/关闭处理真实运行；不冒充完整真实owner或WSB集成。

仅一个40秒/并发1 Node入口，不编译、不生成磁盘文件、不启进程业务/VM，不重复111/10/4及旧矩阵。断言每个原协议在收尾后无本项监听、缓冲释放；原错误引用及工厂child/driver/binding/callback在dispose后清除。正常生产热链和onData/onStderr/onClose原处理未改，无轮询/对象池/额外正常启动观察；新增工作只在显式验收工厂及有界故障事件发生，故不扩跑生产性能矩阵。

五文件为既有volume.mjs、新manager-loss.test.mjs及三记录；起始index1987/外1983摘要97516CDDC2F98D0C945CD3638A210C6C7C4E7AC1BB7CDE273B12FE343A311EEA，目标1988。当前仅源码尚未运行，先预审。生产真实工程/默认/权限退役关闭，P0待办。

§42预审补正（尚未运行）：启动前revoked/recordFailed直接拒绝，launch回调不执行。误返原生Promise的journal也永久失败，同时最多持有1个原Promise及观察链，接住异步拒绝原值（含undefined）；settle只更新失败事实并释放该引用，不恢复资格。记录仍未决或观察安装未知时，即使child已close也拒绝dispose。十二组内补Promise.resolve/reject/挂起与child-close回调异步拒绝，仍不扩旧矩阵。每个fixture核对最多8个持久观察（含launch/kill的全部事件<=10）、原协议缓存/监听和工厂引用释放。生产packages对该模块/工厂无引用，正常启动提取不增加故障监听或改变原协议热处理。

§42最终在途修正（仍未运行）：persist调用前先登记recordInFlight，回调尚未返回时dispose拒绝，重入日志观察不再调用persist并永久拒绝资格。同步在途与唯一异步Promise责任分别结算；原协议close照常继续，待同步记录返回、误返Promise结算和请求进程关闭后，外层才能dispose。第10组补“close回调dispose被拒后返回拒绝Promise”及“回调重入child-error而返回挂起Promise”，并断言第二日志回调/第二Promise从未产生；async函数抛错和创建前撤销三回调全0亦已补齐。


### 42.4 首次十二组11通过/1失败，定向预期修正待审

revision579 / turn 01a19983-db7d-73e2-8640-baacd5d0fb61最终源码预审后，2026-11-01T23:49:29.166Z紧邻核对两源码和固定Node，首次十二组11pass/1fail，总61.4045ms；observer31100实际exit1、runner23044 status1/signal=null/error=null、stderr0。原获审volume SHA7C047EE4DEFCD4B96C33F1C9337D7E080F05D9E792D69A98F9DF153325DDF5FD，检查入口当时3D42EF7CB8B421D97A1C35EC003668446E8EFEC8D39667ABCC7B76354AC44B57。无文件、原生、真实业务进程或VM产物。

唯一失败在第7组child-error场景：原Protocol.onError经#fail通知unsafe一次；随后原onClose在实际清除pending/缓冲/监听后独立通知unsafe。因此实际2、预期1，错误属于新检查对旧语义的计数假设。该例在失败断言前已验证driver.physicallyClosed=true、childReleased=true；因断言中止，该例末尾工厂dispose与本组后续async-close分支未执行，不能宣称该组引用释放已通过。其余11组通过，不再重跑。失败记录保留，不修改原协议语义。

仅修正本组预期为child-error分支2、child-close分支1，并保留实际settled=1、缓存/监听及工厂引用释放判据。下一拟先复核这处变更，然后按完整名称只运行这一组；当前尚未补跑，无新增现场准入。


### 42.5 仅失败一组补跑通过，十二组证据补齐

revision581 / turn 01a19985-44d1-7312-b21d-d2466c7b2372核对最小计数修正后，2026-11-01T23:51:06.895Z紧邻核对volume/test/固定Node，按完整名称^fault observation journal failure cannot block original protocol close handling$只运行第7组：1pass/0fail，总51.4699ms（本组2.5351ms）；observer11208实际exit0，runner27768 status0/signal=null/error=null，stderr0。其余十一组未执行，Node名称筛选未注册其余组，因此显示skipped0，不把它解释为跑过所有组。

该组完整覆盖close日志同步失败、error日志失败后独立close通知，以及close日志返回拒绝Promise；原driver实际关闭/child引用和协议缓冲/监听释放、工厂等待记录结算后释放、原错误引用清除全部通过。本项合并证据为首跑十一组通过＋只修正失败组后该组通过，保留§42.4首败，不写成十二组首轮全绿。

正常模型确定性计数为launch1/wrap1/persist4、verify1/原假child请求1、unsafe1/settled1；error→close路径按原协议unsafe2而settled1。创建前撤销三回调0，全部fixture事件<=10（最多8持久观察），error记录上限4/计数5表示>=5、Promise最多1未决，未决或同步在途时禁止释放，结算无恢复。以上是纯组合计数，未实例化真实TaskVolumeOwner/VM、未终止业务进程；原Protocol固定缓存释放及本项对象/错误/Promise引用清除由定向断言验证，无产物需要清理。

最终volume SHA7C047EE4DEFCD4B96C33F1C9337D7E080F05D9E792D69A98F9DF153325DDF5FD、test SHAEE0A10E14B70AC048367E5A97C2D657B0098F46AD4D048321D802AF5B72DA146。五文件结果待复核后精确暂存index1988，外1983摘要97516CDDC2F98D0C945CD3638A210C6C7C4E7AC1BB7CDE273B12FE343A311EEA保持；下一先审PS7只读诊断包装、原文交付与真实宿主观察的最小接线，仍不准入真实故障。生产真实工程/默认/退役关闭，P0待办。

revision590 / turn 01a19986-f9a3-7be1-86a1-2949631b0708已复核五文件结果、摘要和范围，批准精确暂存index1988；下一先准备PS7诊断及独立宿主责任。其后同轮审核准许在严格ASCII/完整字节计数/原schema门槛下复用CapturedProcess重建成功原文，共享输出回调保持不变；超时不终止、未知保留、落盘句柄单列及三helper/99预算不变，实际诊断未准入。


## 43. 成功诊断原文准入链预审（尚未启动诊断）

revision590复核§42五文件并已精确暂存index1988/外1983摘要97516CDDC2F98D0C945CD3638A210C6C7C4E7AC1BB7CDE273B12FE343A311EEA。后续同轮审核先收窄到成功回执与逻辑等待的准入链；本项只实现这条无启动/落盘/删除权限的宿主组件，PS7包装、实际host observer/角色、文件owner仍按后续依赖接线，不将它称为完整诊断入口。

### 43.1 固定解码来源与精确回转依据

既有CapturedProcess在实际close时将固定stdout/stderr缓冲以UTF-8解码并释放原buffer。[固定Node v26.13.0 Buffer文档](https://raw.githubusercontent.com/nodejs/node/v26.13.0/doc/api/buffer.md)规定无效UTF-8以U+FFFD表示；有效非ASCII字符也不会解码为ASCII。因此，只有原CapturedProcess结果完整、未经变换、所有字符均ASCII，且stdoutSeen=string.length=UTF8 byteLength时，才可精确重建成功原文。固定版本网站页面本次不可读取，核对了相同固定tag原文；不重复搜索或扩大版本范围。禁止使用ascii解码（会移去高位）、trim、去BOM、换行规范化或重新序列化。

新增DiagnosticResultChannel绑定原调用对象、原wait方法、PID及六字段宿主上下文快照，仅一次调用原wait(15000,signal)。准入还要求原call.result存在且child/out/err已释放，返回settled、未取消、原PID对应、实际exit0/signal=null/launchError=null、stderrSeen0/空stderr、无截断、closedUtc规范；stdoutSeen为1..4096。随后验证原始LF、共享严格成功schema、身份/128MiB/fixed/未附加、旧GUID2/3及三柄各关闭一次。失败保留该调用对象和错误；超时/取消后原进程仍未关闭时禁止dispose，迟到close只允许释放本组件，不恢复等待/成功准入。

本组件不创建进程，原调用对象必须由后续故障lifetime先登记/持有，可信固定入口提供真正CapturedProcess；当前注入对象只能证明准入判定，不能把调用方几个字段当成真实host owner/VM收尾证明。它没有kill、重启、挂载、文件或清理入口。普通OwnedHelperRunner超时会kill，明确不用于这条诊断链。

### 43.2 单一校验与字节所有权

从已审fault-cleanup核心仅抽出原文本/schema判定为validateFaultDiagnosticText共享函数；旧核心仍先拷贝有界原Buffer，UTF-8严格解码、同一判定及finally清零。原核心的LF/CRLF兼容保持；新C#成功通道固定只接受原LF。新通道先完成ASCII/schema检查再分配唯一独立Buffer，UTF-8原样写入并记录SHA/实际字节及不可变过程事实。此校验函数只判断数据，不授予进程、文件或删除权限。

预算明确分开：既有CapturedProcess两块16KiB、合计32KiB捕获缓冲；新成功重建Buffer<=4096B。takeSuccess仅一次转移同一Buffer及冻结proof，不再复制；接收的宿主文件owner随后必须持有并最终清零。未转移时dispose清零本组件字节；转移后本组件计transferred，不能谎称自己清除了接收方内容。allocated=cleared+transferred+retained，dispose清除原call/wait/context/proof/error引用；外层任务及调用对象责任不随之释放。完整封装继续<=6144B。非ASCII/非法编码/不完整输出仅称解码后的诊断信息，不能称完整原文或授予清理资格。

### 43.3 新七组检查待预审

新七组仅Node内存替身，拟单40秒/并发1：精确ASCII/封装回转与一次所有权转移/本地清零；非法UTF-8、非ASCII、BOM、CRLF/trim与高位置换拒绝；计数/上限/stderr/退出/截断；共享原schema/旧CRLF兼容；超时/取消/迟到close无重试；等待未决/falsy失败/原wait绑定；getter数据拒绝和partial-close保留。测试用原始合成Buffer经Node实际UTF-8解码提供边界输入，不构造或运行真正CapturedProcess，不启动PS7/原生/VM，旧111/12/10/4矩阵不重跑。

六文件为fault-cleanup.mjs共享判定提取、新diagnostic-channel.mjs及test、三记录；起始index1988/外1984摘要4C08DB7E43569BC5DAE4BB537C2AF47C75D5446DC9E73205498FFB1CDFFBBC56，目标1990。无生产热路径、共享onOut/onErr改动或对象池；本项只有冷的成功判定与最多4096B明确所有权，不扩大性能矩阵。当前源码尚未运行，先预审。生产真实工程/默认/权限退役关闭，P0待办。


### 43.4 唯一七组准入检查通过

revision594 / turn 01a19995-3517-7971-84a5-74c5b7c3a6ba源码预审后，2026-11-02T00:09:53.841Z紧邻核对三获审源码和固定Node，仅新入口首次七组7pass/0fail/0cancelled/0skipped，总55.5847ms。observer22736实际exit0，runner28512 status0/signal=null/error=null、stderr0。无真实诊断/PS7/VM/文件产物，不重复111/12/10/4。

严格成功样例的原文/摘要及完整Base64封装逐字节回转通过，原合成输入随后修改不会改变独立缓冲；一次take转移且本组件不谎称cleared，由接收替身最后清零；未转移分支本组件清零。每次dispose验证allocated=cleared+transferred、retained0及call/context/wait/error引用解除。正常原wait调用1、kill0；超时/取消同样wait1/kill0，原进程未关闭时保留，迟到close后仍不能再wait或take，只能释放本组件。pending等待、falsy错误与原wait方法绑定通过。

非法UTF-8/非ASCII/BOM/CRLF/去换行/前缀空白/高位、字节计数和退出/截断/stderr、身份/附加/关闭未知、getter与partial-close均拒绝；拒绝分支在重建前停止，allocated0。共享判定旧CRLF兼容定向检查通过；未重跑原十组。4096/4097样例仅为无效文本边界，未把空白输入说成有效成功回执。全部结论是合成数据与注入call判定，不替代真实CapturedProcess来源或宿主状态观察。

三源码SHA保持：channel 0E311442CC98E2BAF6452861C1C4690198844837BB5C2515E2B2C210C26F789A；共享core D500D479F1538B29D574A5AD6C77D310E52E1AFF5597B4332E97A8CBC0789FAB；test DDA62CE33792968D9CA5E8910C7223632881F926406EF0C70D8DB186DDAAA193。六文件结果待复核精确暂存index1990/外1984摘要4C08DB7E43569BC5DAE4BB537C2AF47C75D5446DC9E73205498FFB1CDFFBBC56保持。下一继续PS7固定包装及原生Unknown保留，再接实际host observer/diagnostic角色与单叶I/O责任；真实诊断/故障现场尚未准入。生产真实工程/默认/退役关闭，P0待办。

revision595 / turn 01a19998-1b45-72a1-a733-af63aa6a8583已复核七组结果、三源码摘要及六文件范围，批准精确暂存index1990。下一PS7包装可使用整文件仅ParseFile、固定唯一顶层原函数AST提取、fake owner/emit/不返回hold哨兵及同编码函数MemoryStream方式先审后验；不得加载入口/DLL或调用原生，原操作/关闭/包装输出异常分别保留。

## 44. 固定 PS7 诊断包装与未知责任保留（待源码预审）

revision595复核上一成功通道项后六文件精确暂存index1990。本项按同轮限定新增固定PS7包装、AST夹具和唯一Node检查入口；不编译/加载DLL，不执行真实入口，不调用原生或创建文件/VM。主机仍只使用D:\PowerShell\7\pwsh.exe，固定配置/摘要由既有verifyPowerShell7核对，无PS5回退。

### 44.1 原对象、失败与退出的边界

真实入口先核对显式开关、PS7 Core x64、固定宿主身份/路径/容量/原生DLL摘要与128KiB预算，再LoadFile；将原FaultDiagnosticOwner保存为强引用后，调用唯一Run。两个独立原函数供实际入口和夹具共用。包装分别保存原生OperationException、CloseException、PowerShell调用异常、包装异常和输出异常，原事实不被外层调用包装替换。

全部关闭的成功原文保持原LF、不重序列化，输出一次；已知关闭失败无成功回执并返回1。Unknown即使报告构造/输出失败，也在finally把同一原owner交给不返回hold；生产hold只等待，外层catch再次保护Unknown，不自动退出、清引用、重试关闭或终止进程。失败行最多4096B，含原四槽/关闭尝试/原操作及关闭错误码；入口前置失败stderr仅一次最多1024B的阶段/类型，不输出异常消息或路径。逻辑超时及原进程责任仍待宿主接线，不能借此宣称现场收尾已完成。

### 44.2 编码所有权与检查界限

唯一编码函数使用严格UTF-8无BOM，把<=4096B且带LF的文本编码一次；借用给write/flush后finally逐字节清零，allocated/cleared分别计数。stdout流由真实进程持有，本函数不接管关闭。写入或flush失败均不重试；原诊断所有权不依赖交付成功。

夹具仅Parser.ParseFile解析整文件，要求零解析错误和固定唯一两个顶层函数，再加载其原Extent.Text；绝不dot-source整个入口。七种流程组合加一次重放拒绝覆盖成功、已知失败、输出失败、Unknown、Unknown+输出失败、Unknown+报告构造失败及hold意外返回。fake hold记录同一owner/状态并抛专用哨兵，由最外层夹具识别，模拟不返回；仅意外返回专例用于检查拒绝。原操作/关闭和调用异常各自保留，四槽原假句柄/adapter不丢失。

另四种编码组合通过同一个原函数与MemoryStream验证原字节、无BOM/额外换行、write/flush异常finally清零和4097B在分配前拒绝。正常合成文本仅用于包装流转，不冒充真实诊断schema；schema由上项七组覆盖不重跑。预期流程Run7/emit6/hold4/replay拒绝1，编码write3/flush2/allocated=cleared105B，共12场景。MemoryStream字节证明不等于生产stdout或真实native兼容证明。

单Node40秒/并发1，仅一次固定PS7调用15秒/捕获8192B，stdout<=2048/stderr<=1024完整证据；超时或失败停止、不重试。此处可使用spawnSync检查超时，因为只执行可终止的纯替身，绝不用于真实Unknown诊断。无本项磁盘产物，旧111/12/10/7矩阵均不重跑。没有生产事件/输出热回调改动或池化。

六文件起始index1990/范围外1987摘要A6F85C9571C45A820F044D585EE69CDAF1D44D9A43C0D54662543EB75B3AE937；目标index1993。源码未运行，待独立预审。后续真实host observer/diagnostic角色与回执文件责任、五叶清理和外层释放仍须接线/审查；真实故障现场不因本项通过获得准入。生产真实工程/默认/退役关闭，P0待办。

### 44.3 唯一固定PS7十二场景通过

revision597预审在运行前发现检查预期的静态计数错误：合成文本含LF为35B，三次编码应105B，原deepEqual写102。只修改固定预期及§44说明，保留动态字节数和全部清零判据；没有失败试跑。revision598 / turn 01a199a6-dd4a-7620-a766-d89e192ca7e3复核最小修正与三摘要后，2026-11-02T00:27:40.263Z紧邻核对获审源码和固定Node，只运行一次新入口。

observer29544实际exit0，runner29564 status0/signal=null/error=null，1pass/0fail，总565.2195ms（组512.4447ms）。唯一PS7进程29196实际status0/signal=null/error=null，stdout270B完整Base64交付，stderr0/无截断。夹具12场景通过：Run7/emit6/hold4/replay拒绝1；encoding writes3/flushes2/allocated=cleared105B，并实际检查编码借用数组全零及MemoryStream逐字节。正常、失败和Unknown组合保持原owner/adapter/槽位，原异常分类未混同，Unknown不返回退出结果。

nativeCalls0/entryExecutions0/diskArtifacts0；无编译/加载DLL、WSB/VHD或磁盘产物，无需清理，无旧矩阵重跑。PS7夹具自身270B结果以Console.WriteLine产生CRLF，它只是检查报告；生产成功诊断原文的LF/无BOM/无额外换行结论来自原编码函数MemoryStream对比，不能拿夹具stdout代替真实诊断stdout证据。

最终SHA：包装D9BDA1E548FD74BE27264C7AE75F4F114CD620E898AF8A1A36766320C314BC7E；夹具E3410821EC2879F147F9A2F67ECDD794611B02FC0D7F83AF3F9A804B1521392B；检查入口CB50DB9020CC318EAC0C262ECD5D0CDAA253013C038FC28F278EA7F4A2A38993。六文件待结果复核后精确暂存index1993，外1987摘要A6F85C9571C45A820F044D585EE69CDAF1D44D9A43C0D54662543EB75B3AE937保持。下一接宿主原始观察/故障专用角色和回执文件责任；真正诊断及故障现场尚未准入，生产真实工程/默认/退役关闭，P0待办。

revision600 / turn 01a199a8-1aef-7af0-b937-d9fec6a0d973复核§44结果及六文件后，已精确暂存index1993；范围外1987摘要保持。下面先完成回执文件owner内部依赖，再接真实诊断角色与观察。

## 45. 宿主诊断回执文件责任（待源码预审）

按revision600范围新增DiagnosticReceiptFile及六组纯检查。仅接管上项原DiagnosticResultChannel成功Buffer并为固定宿主私有叶fault-diagnostic.json负责；不启动进程、执行卷操作、删除文件或授予外层释放权限。真实文件I/O存在于适配器但本项检查全部注入内存替身，不调用实际文件系统。

### 45.1 同一上下文与独立责任

构造固定root/rootId/taskId/instanceId/imageId/imageBytes/volumePath、原I/O接收者及七个原方法和宿主同步guard。adopt先占用阶段，再通过原类takeSuccess取得原Buffer并立即登记所有权，之后以共享schema逐项复核跨任务/实例/根/镜像/容量/卷上下文。发生不匹配仍由本owner保存并在明确放弃/失败释放时清零，不能先抛出而丢失已转入缓冲。接管字节计received，不冒充本owner新分配。

固定叶以wx/0600排他创建；根身份/规范路径先核对，取得fd立即登记（包括0），然后同fd核对普通文件/单链接/零长度和身份。短写只允许最多4次正向进展，每次返回必须为1..remaining整数；0/负数/越界/非整数或耗尽上限立即失败，绝不重试抛错的调用。完整写入后fsync、同fd最终身份/长度和根及路径再核对，原Buffer摘要保持。

成功fd只close一次，关闭不受随后撤销阻挡；操作与关闭各有failed布尔及原错误，包含undefined/0。close失败或无效fd返回均保留精确返回、原IO、上下文、原Buffer和未知责任，禁止再次关闭或dispose，不删除失败现场。四原生诊断槽与这里单文件fd分开计数，不能用native全关闭替代此fd关闭。

### 45.2 不暴露通用字节借用

按审核建议，本项只提供固定同步evidence操作，返回原过程proof、文件身份/摘要和完整Base64封装，不返回原Buffer、通用回调或异步借用接口。调用guard/I/O前running已置位，重入write/adopt/evidence/abandon/dispose均拒绝。固定evidence再次核对权限和原Buffer摘要，变更后永久阻断；以后真实原文交付与纯清理核心的接线须继续保持字节责任，不凭这个文件对象授予清理资格。

fd已关闭也不立即清空成功字节。written/ready阶段dispose拒绝；显式abandon不可逆放弃成功用途后，或已知关闭的blocked失败，才可dispose清零并解除原IO/guard/channel/proof/context/error引用。Unknown即使abandon也不能dispose。这里的abandon只针对成功字节用途，不清除任务故障、不删文件、不解除外层责任。

### 45.3 有界计数与定向检查

每owner最多1fd、原成功字节<=4096B、新分配Buffer0；全部fs调用<=16，写调用<=4，正常open1/write1/fsync1/close1、共12次fs、峰值fd1。三段短写预期14次fs。证据封装沿用<=6144B，原捕获32KiB与原生64B/four slots仍由各自组件负责；输出字符串是一次冷的固定证据构造，无生产热回调改动/池化。

六组仅Node内存替身，拟单40秒/并发1，源码先审未运行：正常原方法/上下文快照、同Buffer写入及完整封装；操作/close独立falsy与组合错误；短写进展/无进展/超界/上限/fd0及fd0关闭未知；根/叶/链接/长度/路径/内容改变；撤销/guard和I/O重入/无效fd；跨六上下文错配转入后清零及拒绝伪通道。未知分支检查故意保留owner责任；夹具只清自身假内存，不能写成实现已关闭未知fd。正常和已知失败分支验证received=cleared、引用解除、原借给write的数组实际全零。

五文件基线index1993/外1990摘要FAB349388D96D2E0F889994CBECDBE6D11A7CD839AF4A1247BD704D3FFD55957，目标index1995。无真实文件/PS7/VM或产物，旧矩阵不重跑。后续fault专用3helpers/95CLI/99记录、实际CapturedProcess来源/原owner-VM-manager最终守卫、五叶清理/外层释放仍按顺序接线。生产真实工程/默认/退役关闭，P0待办。

### 45.4 唯一六组纯检查通过

revision602 / turn 01a199ae-1a4d-77f2-b722-1b22c6f2f1d8预审后，2026-11-02T00:38:22.888Z紧邻核对两获审源码和固定Node，仅新入口唯一六组6pass/0fail/0cancelled/0skipped，总57.1184ms。observer29748实际exit0，runner2464 status0/signal=null/error=null、stderr0。无PS7/native/文件/VM或产物，旧矩阵未运行。

正常12次fs/open1/write1/fsync1/close1/峰值fd1/活动fd0，三段短写14次/写3及fd0一次关闭通过。所有错误返回/超界/零进展和4次耗尽停止；原操作和关闭的undefined/0/Error及双重错误分别保存；close未知保持原fd/IO/Buffer，abandon仍拒绝dispose且关闭仅1次。根/叶/链接/长度/路径/原字节变化拒绝，方法替换不改变构造时绑定；guard/I/O/evidence重入拒绝，六字段跨上下文不匹配在接管后失败并负责清零。正常及已知失败received=cleared、新分配Buffer0、原write借用数组实际全零和原IO/context/guard/channel/error引用解除通过。Unknown分支只验证保留，没有宣称未知fd已释放；它们只有假内存。

最终SHA与获审一致：owner D639B669B626731810B11A1243B4AD61D4238149A2C3524576BF0534A2CA5816；test CD41B157925F368126E764B4E64BD003B8C5E5ADCB105AAB99DC652F0226FE05。五文件结果待复核精确暂存index1995，外1990摘要FAB349388D96D2E0F889994CBECDBE6D11A7CD839AF4A1247BD704D3FFD55957保持。文件适配器本身尚未实际写入；下一继续真实故障角色/原宿主观察，再接完整证据与五叶释放。生产真实工程/默认/退役关闭，P0待办。

## 46. 管理进程故障收尾组合接线（源码待预审，未运行）

新工作01a199c4-175b-7183-bc62-7a42cc53e149已接管，新审核01a199c3-cc92-7dc2-bf58-edf0e0250b43复核。交接已精确暂存index1996；八文件为session、diagnostic-file、fault-session、fault-acceptance、fault-session.test及固定方案/契约/主方案三记录。范围外1991项SHA25698BDBFA6544053AC34EE9917549D9A6ACE049404AA30857075255A299C2C5A4C（git -c core.quotepath=false ls-files --stage，排除上述八路径，LF及末尾LF）。九原有删除和补丁保留，本项未暂存。

### 46.1 原对象与停止边界

SharingLifetime新增fault专用3helper/95CLI/99记录/未决4；preflight、compile、diagnostic各一次，guest exec拒绝，普通profileFiles不增加fault。原私有records逐项核对同一个manager、CapturedProcess、VM调用/result引用及实际child/out/err释放；诊断启动时仅容许当前一条reserved。预留/持久化后核对source bundle、PS7配置和原DLL身份摘要，随后原task/volume/driver/VM/runtime/factory末次守卫，再紧接CapturedProcess构造。

FaultSession在任何启动前创建并由lifetime持有。六字段native上下文绑定原根/镜像身份和实际EOF，虚拟容量128MiB、物理长度<=129MiB。一次原manager SIGTERM后，waitClosed异常返回false不等同未关闭；独立核对实际close/child/buffer/pending，再确认VMcleanup/absent和全部旧CLI/helper关闭。实际调用一次beginCandidateRead观察拒绝，exec/capture0由原对象/记录核对，报告布尔不提供授权。用户停止使用独立AbortController，内部故障取消不遮蔽后来的停止；停止禁止新launch、在途诊断逻辑取消不kill、迟到close不恢复。

### 46.2 字节、文件与释放

原call成功→DiagnosticResultChannel→DiagnosticReceiptFile原Buffer一次转入→wx/同fd/有界write/fsync/一次close→FaultArtifacts独立有界读回。读回完整fingerprint（ID/长度/mtime/ctime）保存于owner并与冻结清单严格比较，修复交接披露的同ID变化缺口。read<=4、scratch<=4096、独立fd<=1；Unknown保留原fd/IO/scratch，禁止重试close或dispose。

最后journal后冻结五叶；完整原文Base64封装<=6144B及主报告<=7680B均实际输出结算后，已创建外层立即接住原Buffer。纯contract观察来自原对象/私有records/读回SHA/固定输出结算；五叶按task.vhd/nativeDLL/helperJSON/diagnosticJSON/lifecycleJSON顺序，前后同证据版本，最后仅rmdir原空根。清理失败保留剩余责任，不重试或自动恢复。

contract model-complete、原根消失、IO及footer输出结算后才释放外层。unsafe/cancelled/taskRejected及taskPassed=false保留，faultAcceptancePassed单列；普通TaskVolumeOwner.release不变。原Buffer最终清零，factory/runtime/channel/file/artifact IO、lifetime监听/记录与task graph分别解除。失败由lifetime强引用保留。

### 46.3 八组组合替身计划

拟唯一Node入口、并发1/40秒：完整owner/协议/VM/contract链；readback后同ID长度/mtime/ctime变化；独立停止/迟到close；末次guard的source/停止/原result替换；写/读fd关闭Unknown；两段输出及footer失败；五叶逐位置失败不重试；角色/源清单/显式入口和普通cleanup隔离。CapturedProcess只用prototype-only传输替身，不声称执行其构造器/生产回调。无实际文件/PS7/native/VM/产物，不重跑旧矩阵。

预期正常helper2+diagnostic1/manager1/CLI6=10记录，manager请求1、prepare/verify共4，capture替身9；write12fs，独立artifact读回/冻结/前后核对142fs、峰值写fd1/读fd1。contract临时副本14次，每次<=4096且finally清零；channel重建/转移、文件接收/转移、外层接收/清零分列。原生4槽/64B及捕获32KiB沿用组件预算，不冒充本模型实际native证据。journal8192/main7680/raw4096/envelope6144/footer512由模型实际形状验证并输出计数。

仅冷显式验收变化，生产onData/onStderr/onClose/onOut/onErr及其热调用链未改，无池化。源码待预审，未运行/暂存，真实现场尚未准入；源码通过后最小定向验证，再复核/记录/精确暂存，随后另核单次现场。生产真实工程/default/旧权限退役关闭，P0待办；一次额度重置已消耗，不再自行重置。

### 46.4 唯一八组组合检查通过（待结果复核/精确暂存）

新审核revision20 / turn01a199cf-6d9e-7910-b408-b9be8c8f0886源码放行后，2026-11-02T01:15:55.675Z紧邻核对五个获审源码及固定Node摘要，仅新入口八组、并发1/40秒边界唯一运行，8pass/0fail/0cancelled/0skipped，118.9506ms。observer33216实际exit0，runner31124 status0/signal=null/error=null，stdout1139B完整、stderr0；未运行真实验收入口/编译/PS7诊断/VM，也未重跑旧矩阵，无本项文件产物。

正常完整模型实测：一次原假child请求、4个prepare/verify协议命令、6CLI/9capture替身/10记录；artifact142fs，原文600B，原Buffer外层接收600B并清零600B，contract14次副本共8400B分配=清零，独立读回scratch600B分配=清零。写fd0/读fd1各关闭一次；正常五叶精确顺序及原空根删除通过。日志峰值6153B<=8192；原文封装975B<=6144，主报告4925B<=7680，footer196B<=512。实际TaskVolumeOwner/VolumeProtocol/Factory/VM/runtime/lifetime/contract组合，加内存文件/传输替身；这些不是实际native/VM/磁盘证据。

同ID读回后长度/mtime/ctime变化均在输出/转移/删除前拒绝；用户停止在内部cancelled之后仍独立生效，禁止新诊断、在途逻辑取消且迟到close不恢复；最终guard的source/停止/原VM result替换拒绝；写/读close抛0均保留准确fd/IO/Buffer，禁止dispose和删除。两段输出失败或停止均无转移/删除；footer失败虽已删除五叶仍保留外层原字节责任。逐叶五处失败保留剩余根/字节，二次complete拒绝且无额外IO。成功后原write/read借用Buffer全零，factory回调/runtime owner、channel/file/artifact引用、lifetime信号/输出/settled监听和进程记录、task graph释放断言通过；原volume仍blocked，普通release仍拒绝。Unknown分支仅清夹具假内存，不声称未知真实fd已释放。

最终五源码SHA与revision20一致：session A7DD8A47D013D793D3AEC1B867C31A428C02F826B51D007C0B8508E2330AAA60；diagnostic-file F035430CCD6ABB7BAB8D6448EEC9A53A9C1CD106A9E5FBB7B8E42B83A9655863；fault-session B051E2840372447A401490C52FB27CC087CFC50AB7F0661B99EE54E764D32E74；fault-acceptance 9F7D25F96A3C39DBBF76139BC49C67BAF25AF12F3FBF137B38FE1EB5251F87E0；test BFF5938BFB991AB61CB6A8057058924266A0A2A78054B1E0C470D621DF769592。八文件待结果复核后精确暂存，预计index1999，范围外1991摘要保持。之后另核单次真实故障现场，当前不准入；生产真实工程/默认/退役关闭、P0待办，额度重置不得再次自行使用。

## 47. 单次真实管理进程故障现场（预审方案，尚未运行）

§46已完成revision20源码预审、唯一八组8pass/0fail、revision22结果复核、revision24暂存后复核；最新交接单文件也已获审并精确暂存。新工作（四）独占编辑，新审核（四）只读复核。本项先核定现场，不重做§40–46模型或剪贴板/禁网/旧矩阵。

### 47.1 本轮范围与来源

本轮仅追加固定方案、契约预审、主方案三记录。基线index1999，外1996 SHA256 ACBDC546048FDC05A0BC64FF0E8C0EC86C091F2EB6D68DB12861B21B43AD6F62；算法沿用精确路径排除、stage行LF连接及末尾LF。三原blob依次为8dca41a2ab6fa70d16cf9b35fc4eb3d972a103e7、6642428330293c0c3fda13b2f6ad84436a5f4999、53e95594fbe028ac01dd002a3057e5da276d3334。九原docs删除/未跟踪补丁和全部既有暂存保留，历史17处EOF不处理。

只读导入faultSourceManifest并核对固定工具：FAULT_SOURCES完整28文件402086B，规范清单bundle SHA256 6453593629b4524ed47a65a488dd854ce5ecd26584dad981e0f6e7de9ed4a97c。清单精确顺序和每文件摘要由现有faultSourceManifest产生，源码未改；Node14319838…E0E6D5、PS7 2A6769A3…B2233、csc ECA02E6B…ECC3、CLI247e092b…9c441均与固定入口匹配，verifyPowerShell7同时核对两配置。启动前再核对bundle、四工具、配置、原owner根不存在和scope摘要；前置失败不调用入口。

### 47.2 唯一现场及原对象观察

固定cwd D:\RMProjects\Pi；仅D:\Nodes\26.13.0\node.exe运行scripts/acceptance/windows-sandbox-volume-fault-acceptance.mjs --run-fault-once --source-bundle 6453593629b4524ed47a65a488dd854ce5ecd26584dad981e0f6e7de9ed4a97c。只允许一次入口；单128MiB任务盘（实际EOF<=129MiB）、单VM、native.cs与fault-diagnostic.cs唯一合编一次volume-native.dll<=128KiB，guest exec/candidate capture为0。

原调用链为runFaultAcceptance→SharingLifetime预留持久化/末次来源guard→CapturedProcess preflight/compile→原ManagerLossFactory/VolumeProtocol/TaskVolumeOwner prepare及GUID映射→原SandboxLifecycle list/start/list→原factory.verifyAndArm→原child一次SIGTERM→独立close/child/buffer/pending核对→原VM cleanup/list-stop-list确认absent→原候选准入实际拒绝→原diagnosticAuthorization与同一lifetime diagnostic CapturedProcess→原channel/file/artifact/contract→五叶精确清理和空根→footer结算及task dispose/lifetime release。

父子关系由唯一observer原spawn返回的ChildProcess确认owner PID、原close与输出；owner内manager/diagnostic同样由原构造对象和私有record核对PID、实际close、result引用、child/out/err释放，不以另一个同PID进程或序列化成功标志授权。preflight另执行固定whoami只读权限查询；不新增观察用CLI、原生诊断或存储操作。成功footer加owner实际exit0与独立根不存在才记为该故障验收通过，taskPassed仍false，unsafe/cancelled/taskRejected仍true。模型计数不冒充实际观测。

### 47.3 外层启动、等待及失败保留

主机使用指定PS7/login=false，将下述观察器放入单引号here-string变量faultObserverSource，然后将该变量管道传给固定Node的--input-type=module；不创建额外脚本/日志文件。观察器唯一spawn上述显式入口，保留原child及stdout/stderr各16KiB（总32KiB）；seen与captured分列，继续消费全部超额字节并增量SHA256，不拼接扩容、不关流、不因上限kill。Base64仅固定前缀，摘要对应全流；overflow/truncated为true或计数溢出都不能声称完整证据。业务stdout受6144+7680+512=14336B边界；观察器最终单行<=65536B，启动/状态单行<=4096B，累计<=163840B，超额即标记观察失败并保持进程。

启动后立即输出原observer/owner PID、UTC、bundle和确切参数；原child spawn/error/exit/close及两个管道error/end/close分列。每30秒最多20次有界状态回执公开seen/captured/overflow和事件事实，之后静默持有不终止。未close时不输出原始捕获字节，无法从这些回执恢复完整诊断原文；这是明确观察限制，不能以journal消失/未变化推断物理结算。观察器stdout错误、收到信号或回调异常保留首个错误及原引用，ref interval保持；输出callback结算且原child/两管道close后才清零两Buffer、解除观察引用/监听并自然退出。无论owner退出码多少，原始封装先交付再由工作窗口解析；解析失败保留工具中的原始证据，不触发恢复。工具会话丢失时不重启现场，仅据已打印PID及现存journal观察；不声称能防止工具宿主/系统本身强制终止。

观察器不设全局timeout、不传递终止信号、不forced exit、不retry/recovery。exec等待10秒返回会话，后续空输入轮询最多30秒；这些只观察原会话，不向进程发输入或停止。产品helper/diagnostic各15秒、volume command至多120秒、原manager close5秒、VM start/settle120秒、exit观察30秒均为已有逻辑边界；任何未结算或Unknown仍由原lifetime与诊断PS强引用保留。迟到close不恢复资格。

若无close且journal记录retained/error/journalFailed/未决，或超过已有逻辑边界，则仅按启动打印的原owner PID及存在时根lifecycle.json登记的task/VM/manager/diagnostic身份只读取证；不广泛扫进程、不kill原owner/诊断、不拆卷、不删文件、不重跑。失败后原owner可能按设计长期保持，这就是保留责任；需要另审外部恢复，不能将外层等待结束写成物理释放。本轮不会自行进入恢复。观察器收到停止信号仅记录/保留，不向Windows child转发终止请求，也不冒称已调用内部用户取消；此现场不含停止实验，已有内部独立停止模型不重跑。

获审后将逐字运行此观察器（现在只是方案）：

```javascript
import {spawn} from "node:child_process";
import {createHash} from "node:crypto";
const node="D:\\Nodes\\26.13.0\\node.exe",bundle="6453593629b4524ed47a65a488dd854ce5ecd26584dad981e0f6e7de9ed4a97c";
const args=["scripts/acceptance/windows-sandbox-volume-fault-acceptance.mjs","--run-fault-once","--source-bundle",bundle];
let child,out=Buffer.alloc(16384),err=Buffer.alloc(16384),outHash=createHash("sha256"),errHash=createHash("sha256");
let finalPending=false,finalSent=false,outputPending=false,outputBytes=0,pulses=0,completed=false;
const s={observerPid:process.pid,ownerPid:null,startedUtc:new Date().toISOString(),bundle,
 spawn:false,exit:false,close:false,exitCode:null,exitSignal:null,closeCode:null,closeSignal:null,
 outEnd:false,outClose:false,errEnd:false,errClose:false,outSeen:0,errSeen:0,outLength:0,errLength:0,
 outOverflow:false,errOverflow:false,counterOverflow:false,spawnError:null,outError:null,errError:null,
 observerError:null,outputError:null,signal:null};
function fact(e){try{return String(e?.code??e?.message??e).slice(0,128);}catch{return "unreadable-error";}}
function blocked(){return !!(s.observerError||s.outputError||s.signal);}
function observeError(e){s.observerError??=fact(e);}
function outputError(e){s.outputError??=fact(e);}
function interruption(signal){s.signal??=signal;} // Never forward a Windows termination request.
function snapshot(kind){return {kind,...s,outputPending,outputBytes,pulses,finalSent};}
function writeRecord(record,isFinal=false){
 if(outputPending||s.outputError)return false;
 try{
  const line=JSON.stringify(record)+"\n",bytes=Buffer.byteLength(line);
  if(bytes>(isFinal?65536:4096)||outputBytes+bytes>163840){observeError("Observer output budget");return false;}
  outputBytes+=bytes;outputPending=true;
  process.stdout.write(line,e=>{
   outputPending=false;
   if(e)outputError(e);
   if(isFinal){finalSent=!e&&!s.outputError;if(finalSent)release();}
   else if(finalPending)finish();
  });
  return true;
 }catch(e){outputPending=false;outputError(e);return false;}
}
function release(){
 if(completed||blocked()||!s.close||!s.outClose||!s.errClose||!finalSent||outputPending)return;
 completed=true;clearInterval(hold);
 out.fill(0);err.fill(0);out=undefined;err=undefined;outHash=undefined;errHash=undefined;
 child.stdout.off("data",onOut);child.stderr.off("data",onErr);
 child.stdout.off("error",onOutError);child.stderr.off("error",onErrError);
 child=undefined;
 process.off("SIGINT",onInt);process.off("SIGTERM",onTerm);process.off("uncaughtException",observeError);
 process.stdout.off("error",outputError);
 process.exitCode=s.closeCode===0&&s.closeSignal===null&&!s.spawnError&&!s.outError&&!s.errError&&!s.outOverflow&&!s.errOverflow&&!s.counterOverflow?0:1;
}
function finish(){
 if(!s.close||!s.outClose||!s.errClose||finalSent)return;
 finalPending=true;if(outputPending||s.outputError)return;
 try{
  const record=snapshot("fault-observer-close");
  record.closedUtc=new Date().toISOString();
  record.stdoutSha256=outHash.copy().digest("hex");record.stderrSha256=errHash.copy().digest("hex");
  record.stdoutBase64=out.toString("base64",0,s.outLength);record.stderrBase64=err.toString("base64",0,s.errLength);
  record.truncated=s.outOverflow||s.errOverflow||s.counterOverflow;
  writeRecord(record,true);
 }catch(e){observeError(e);}
}
function onOut(b){try{outHash.update(b);s.outSeen+=b.length;if(!Number.isSafeInteger(s.outSeen)){s.counterOverflow=true;s.outSeen=Number.MAX_SAFE_INTEGER;}
 s.outLength+=b.copy(out,s.outLength,0,Math.min(b.length,out.length-s.outLength));s.outOverflow=s.outSeen>out.length;}catch(e){observeError(e);}}
function onErr(b){try{errHash.update(b);s.errSeen+=b.length;if(!Number.isSafeInteger(s.errSeen)){s.counterOverflow=true;s.errSeen=Number.MAX_SAFE_INTEGER;}
 s.errLength+=b.copy(err,s.errLength,0,Math.min(b.length,err.length-s.errLength));s.errOverflow=s.errSeen>err.length;}catch(e){observeError(e);}}
function onOutError(e){s.outError??=fact(e);}
function onErrError(e){s.errError??=fact(e);}
function onInt(){interruption("SIGINT");}
function onTerm(){interruption("SIGTERM");}
process.stdout.on("error",outputError);process.on("uncaughtException",observeError);process.on("SIGINT",onInt);process.on("SIGTERM",onTerm);
const hold=setInterval(()=>{try{if(pulses<20&&!outputPending&&!s.outputError&&!finalSent){pulses++;writeRecord(snapshot("fault-observer-held"));}}catch(e){observeError(e);}},30000);
try{
 child=spawn(node,args,{cwd:"D:\\RMProjects\\Pi",windowsHide:true,shell:false,stdio:["ignore","pipe","pipe"]});
 s.ownerPid=child.pid??null;
 child.stdout.on("data",onOut);child.stderr.on("data",onErr);
 child.stdout.on("error",onOutError);child.stderr.on("error",onErrError);
 child.stdout.once("end",()=>{s.outEnd=true;});child.stderr.once("end",()=>{s.errEnd=true;});
 child.stdout.once("close",()=>{s.outClose=true;finish();});child.stderr.once("close",()=>{s.errClose=true;finish();});
 child.on("error",e=>{s.spawnError??=fact(e);});
 child.once("spawn",()=>{s.spawn=true;writeRecord({...snapshot("fault-observer-start"),node,args});});
 child.once("exit",(code,signal)=>{s.exit=true;s.exitCode=code;s.exitSignal=signal;});
 child.once("close",(code,signal)=>{s.close=true;s.closeCode=code;s.closeSignal=signal;finish();});
}catch(e){s.spawnError??=fact(e);writeRecord(snapshot("fault-observer-launch-error"));}
// The interval retains this observer on any unresolved/output/signal failure, without recovery.
```

### 47.4 资源与接受判据

预期正常prepare/verify共4命令、manager请求1、preflight/compile/diagnostic各1、CLI至少6（有界95）、总记录<=99/未决<=4。原生诊断4槽/64B、捕获每call32KiB、原文/文件<=4096B、写fd<=1、独立读回fd<=1/scratch<=4096B、read<=4、artifact<=256fs。journal<=8192B；原文封装<=6144B、主报告<=7680B、footer<=512B。五叶按task.vhd、volume-native.dll、volume-helper.json、fault-diagnostic.json、lifecycle.json处理，分别<=129MiB/128KiB/8192/4096/8192B。临时lifecycle.next.json或helper临时记录异常仍保留，不能把未完成五叶清单强行补齐。

真实输出先保留原始观察封装，再核对Base64回转/seen长度/全流SHA256，以及严格三段LF JSON：manager-loss-diagnostic-raw封装、super-pi-manager-loss-acceptance-v1主报告、fault-cleanup footer。三者taskId必须一致；原诊断ASCII/LF字节<=4096B，原文SHA与封装、主报告diagnostic/file三者相同，原六字段binding和成功schema由现有validateFaultDiagnosticText核对。主报告输出在cleanup前，faultAcceptancePassed仍false不是失败结论；footer必须faultAcceptancePassed=true、taskPassed=false、unsafe/cancelled/taskRejected/artifactsRemoved=true。仅在原child actual closeCode0/closeSignal=null、原spawn观察成功、两管道完整end/close、无任何进程/流/observer错误、stderr0/无截断、三段全部有效及独立原根不存在时放行现场结果。成功footer先于closeTaskBinding，因此必须再有正常原close；单独exit0/报告布尔不够。

实际原manager退出、VM absent和CLI/进程结算、回执文件身份/读回、正常五叶及根清除按真实报告分别记录。外层release和清零能从本次成功控制流得到的结论与已有模型断言分别记录；不声称额外GC/分配剖析。无生产热路径修改或池化。本轮未现场运行、未暂存；待新审核明确放行后只执行一次，结果复核/精确暂存再交接。生产真实工程/默认/旧权限退役关闭、P0待办；额度一次授权已耗尽。

### 47.5 唯一真实故障现场通过（待结果复核/精确暂存）

新审核（四）revision7 / turn01a199df-5714-7543-9c49-d6dc767056ce预审明确只放行一次后，紧邻核对三记录、外scope、28来源bundle、四固定工具/PS7配置、原根ENOENT及观察器5457B/SHA F030CC2610C0457B9F8A5661E6F720B691F5C7E62DDCEB905BDE7AB11BE8F248，才启动唯一现场。初次外层functions指令构造因JS/PS反引号冲突在工具解析层被拒，未运行shell/Node/现场；改用明确字符及正则表达式后唯一实际spawn，不是现场首败或重跑。

2026-11-02T01:31:44.234Z observer33476生成原owner30852；01:31:58.930Z原close，约14.696秒（仅观测，不作优化证据）。owner spawn/exit/close以及stdout/stderr的end/close均实际观察，exit/close code0、signal=null，所有spawn/stream/observer/output错误null，未截断。原exec session48881随后返回exit_code0，外层已完成最终输出callback、Buffer清零/release并自然退出；不是仅看到owner-close即宣称observer结算。启动回执862B/最终封装9059B，无30秒状态回执，外层合计9921B（另前置检查172B）。无额外临时文件/脚本。

实际task06aded65-0d2f-4f4f-bb11-58da4c0bff15，VM702f06dc-8750-4bd2-a4ed-bb47011010ab。preflight28832和compile29656均exit0/stderr0；原manager4316一次SIGTERM请求返回true，实际close signal=SIGTERM/exitCode=null、childHeld=false、协议buffersReleased=true、pending=false；随后原VM closed，6CLI/10条原物理记录全部关闭，最后list11964报告空集合。guest exec/candidate capture未派发。原volume仍blocked/revoked，unsafe/cancelled/taskRejected=true、userCancelled=false、taskPassed=false；专用故障验收成功不改变普通release失败语义。

诊断11048于01:31:58.901Z实际exit0/signal=null/stderr0，完整原文603B，SHA256 f3381d7903e0201685a75735f41c007b46ff8e1ca2552a471692eb0fb118c5ee；回执文件EAC36D69:002B0000001263F8同长度/摘要，独立读回13次I/O、scratch分配603B=清零603B。原根EAC36D69:000C000000126323，镜像EAC36D69:00120000001263F7/实际EOF134218240B；nativeDLL身份EAC36D69:00050000001263F9、SHA6eb9a6dfdb5d47594d0d09a728e943e84df1a066e6051719019ce08a07ee6a6b。原生实际确认virtualBytes134217728/subtype2/isLoaded=false、旧GUID打开失败Win32 2，三个成功句柄各一次关闭，无操作或close错误。完整原文（以下行加LF即603B）：

```json
{"protocol":"super-pi-manager-loss-diagnostic-v1","taskId":"06aded65-0d2f-4f4f-bb11-58da4c0bff15","instanceId":"702f06dc-8750-4bd2-a4ed-bb47011010ab","rootId":"EAC36D69:000C000000126323","imageId":"EAC36D69:00120000001263F7","diskId":"06aded65-0d2f-4f4f-bb11-58da4c0bff15","imageBytes":134218240,"volumePath":"\\\\?\\Volume{ec27ad0d-0000-0000-0000-100000000000}\\","virtualBytes":134217728,"subtype":2,"isLoaded":false,"guid":{"opened":false,"error":2},"handles":[["root","884",1,true,false,null,false,null],["image","88C",1,true,false,null,false,null],["vhd-info","8A0",1,true,false,null,false,null]]}
```

实际owner stdout6120B/stderr0；完整三行979/4945/196B，分别SHA256 8c6291c6b7b04016f85ea4c85a80ddb8f5b125f79fba07c7b6bd9d0b2cbd7072、3262d10e5a692256231daebf6c0da3a455156461b55e9f5991664029e04d9cc5、dc37698c3d15b9d7d4b7bf55538507bd5ecf07ea5b6217b00bc8e42042d22086；整体SHA256 0386cbbd7b2c292931a0e78e9b53b87ad0f17657ef69e4dcb634a1452c23cc4e。外层完整Base64保留在原工具证据并已交独立审核；只读解析核对Base64精确回转、长度/全流与各段摘要、三taskId/hostPID、六字段binding、原文成功schema、主报告物理记录及全部错误/截断标记，exit0。主报告在清理前，artifactsRemoved/taskReferencesReleased/faultAcceptancePassed=false属于时间点事实；最后footer明确faultAcceptancePassed=true、artifactsRemoved=true且原任务拒绝标记保持，再加原owner/observer正常退出。

五个固定叶与原空根由本次获审contract路径完成精确清除；后续独立fs.lstatSync原根实际ENOENT。没有外部删除/kill/恢复或新增CLI/诊断，无本项VM/VHD/原生进程/临时产物遗留。成功控制流必经task.dispose/lifetime.release及原Buffer清零；本次未另行输出这些最终内部计数，也未记录实际journal峰值、DLL字节或五叶逐项字节总和，因此不把§46的142fs/8400B/6153B等模型数字转写为实测，不声称GC/分配剖析。journal及DLL沿源码守卫边界成立。仅此固定本机、单盘单VM管理进程故障场景得到实际证据；不扩展到所有异常/并发或生产工程。三记录待独立结果复核后精确暂存，生产真实工程/默认/旧权限退役关闭，P0待办，额度一次授权已耗尽。

## 48. 宿主选择性输入契约与纯内存读取适配（源码待审）

审核（五）revision7 / turn01a199ed-d936-7340-8476-927fcf6e1252核定本项五文件/八组范围。仅新建`windows-sandbox-input-snapshot.mjs`与同名测试并追加三记录；不改生产FileService，不接实际fs/VM/快照发布/命令执行/工程提交。初始index1999，范围外1996行SHA256 `1B10F81C01587DD9E6AF1EB45EBC5DEDFCA2BEB666F5F9C872AD3725ED20E997`。三原blob依次为固定方案96b0fb005879b457bc9d8c8bb33ce38a8bc86f1d、契约da1090b5d213e31c0092b50ee868dea7b5e75350、主方案d50d15b449575087fc10674bb02ddd2c6b92aa55；旧九删除/唯一patch保持。

### 48.1 宿主授权与基线

`OfflineInputSnapshotOwner(context, reader)`只接受宿主已明确授权的联合路径集合。每项`expose`与`operation=null/add/modify`独立：null只读必须expose=true；modify可以不暴露；add必须expose=false且revision/identity/hash为null、源目标观察为不存在。`classification=ordinary`及常见凭据名称拒绝是附加限制，不会自动授权任何文件，也不声称从名称穷尽识别凭据。`.gitignore`和protected-path-policy不提供读取授权；不遍历工程、不跟随/展开链接、不生成硬链接。

context精确字段为taskId/epoch/snapshotId/sessionId/sourceRoot/budget/entries；epoch就是原FileRevisions.generation，不能用独立任务代数替代。每个已有源固定原生`snap_`22字符revision、dev/ino/size/mtimeNs/ctimeNs及SHA256，根和每级父目录固定身份/实际路径；格式不证明revision真实。注入reader的current/revision须由宿主原owner确认关联、generation和原receipt对象仍存活且字段未变，不重新read/latest/remember来刷新。模块不另持有原native receipt及其可能很大的bytes；本项模型由原适配器持有小型receipt替身，未来真实桥接另审。

路径沿用保守ASCII、120字符、4层/段64上限；拒绝点起始段（包括嵌套.git/.sp）、设备/ADS/反斜线/短名/尾点空格/大小写重复及前缀冲突。目录别名、不同路径同对象、未知reparse、非普通文件/非单链接及canonical不符拒绝。此处只审判断逻辑，不能作为真实Windows逐组件安全打开证据。

### 48.2 有界读取、释放与Unknown

所有已有源（包括expose=false）合计<=16KiB/单项<=4KiB，联合路径<=16；根+父目录最多49，单项至多3父目录。元数据以保守计费上界1024基础、每项512+2×path长度、每父项128+2×path长度计入32KiB，逐记录保留前守卫；不先序列化任意对象，也不将计费数声称为V8实际堆字节。宿主可下调所有预算。

reader仅同步current/revision/directory/file/open/read/stat/close；方法和原接收对象固定。全项预检在首个open/Buffer前。仅expose=true调用open/read，逐项检查root/parents/file/原revision、同token stat、受剩余额度约束的Buffer、短读进度及hash、读后检查；末次整批复核与hash失败时所有已捕获Buffer清零且无可消费结果。不声称跨文件原子快照；expose=false仅保留原receipt和对象观察，不声称重新计算其当前内容hash。

最多1个同时显式token、最多16次open/close，私有读取Buffer合计<=16KiB；最终hash直接消费已有Buffer，不另复制整份数据。成功仅`input-captured`，固定宿主记录/绑定和私有字节；正常结束解除原reader/context引用。copyFile(index)每个暴露文件至多1次，独立Buffer.alloc backing，全部调用方副本最多16KiB；调用方独自负责清零其副本，owner释放不宣称外部副本已擦除。内部Buffer在revoke/dispose或失败时清零/解除引用；无对象池、不入生产热路径，不扩跑生产分配基准。

open须返回有效token或在未获得资源前抛出；部分open责任是未来真实adapter必须提供的边界，本模型不持有实际OS fd。每个已返回token只尝试close一次，非true/抛错均Unknown；保留原token、reader、固定context及原操作/关闭异常（包括falsy抛值），revoke/dispose不重试、不抹除责任。同步回调重入capture拒绝；回调中撤销不会提前丢弃尚待关闭token。Reader借用输出Buffer只在同步read调用内，不得保留；模型夹具保留引用仅作清零检查和违规写入反例。

### 48.3 FileService接点核对与待解决限制

已读FileService.prepare/withPreparedItems/revalidate/release、FileBatch及revision-mutations/snapshot-line-edit/file-commit。现有write参数`WriteParameters`是additionalProperties:false且没有snapshot；FileService.prepare未收到snapshot就选revisions.latest(target)。因此当前write接口不是绑定任务原revision的回接接口；后续需先解决显式原revision入口，不能刷新读取、选latest或伪造receipt来跨过缺口。本项不改它，也不调用真实prepare/revalidate/execute。

后续适配应在宿主当前授权与写回路径保护下绑定原source-root/task/epoch/snapshot/来源revision、已检查候选清单与私有字节。准备全部add(create)/modify(overwrite)后，沿withPreparedItems锁作用域先全项revalidate，再逐项batch临近检查并如实保存结果，finally释放未消费/已消费plan。FileBatch已有这一顺序，但尚不是Sandbox桥接。任意候选字节不能直接转换为content即声称无损：实际字符串写入口必须严格UTF-8解码并逐字节往返验证，二进制/不支持编码拒绝，另审BOM/空内容/无变化等语义。首次写前拒绝整批；开始后冲突/取消停止后续，保留committed/not_committed/unknown和partial真实事实，不自动回滚或覆盖用户新改动；delete/move始终拒绝。

独立cwd/隔离副本、固定工具摘要及离线依赖清单仍是未来执行前置。本阶段不发布文件快照，不真实工程执行/提交；生产接入/default/旧权限退役关闭，P0待办。

### 48.4 待源码审核的唯一最小验证

固定命令：`D:/Nodes/26.13.0/node.exe --test --test-concurrency=1 tests/windows-sandbox-input-snapshot.test.mjs`，仅指定PS7/login=false包装，紧邻核对固定Node SHA14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5、五文件获审摘要及范围外基线。八组覆盖：独立暴露/私有副本；schema/路径/凭据；关联与原revision变化；对象/读后/末次变化；预算精确边界；短读/异常/falsy；撤销重入；Unknown保留。输出正常/最大/Unknown结构计数及释放差值；实际fs/OS fd/PS7子业务/VM/VHD/临时文件为0。只运行这一个新文件，当前尚未测试或暂存；不得扩到旧矩阵或将模型计数写成原生实测。

### 48.5 唯一八组纯内存检查通过，待结果复核/精确暂存

审核（五）revision11 / turn01a199f3-5dd6-7032-bf91-1d32dae2db6f完成五文件完整源码预审、独立范围外核对并放行唯一一次指定命令。执行紧邻重新核对五获审SHA、固定Node及index1999/外1996 SHA1B10F81C01587DD9E6AF1EB45EBC5DEDFCA2BEB666F5F9C872AD3725ED20E997后，首次且唯一八组全部通过：tests8/pass8/fail0/cancelled0/skipped0/todo0，测试报告85.6532ms；指定PS7执行工具实际completed/exit_code0、wall0.3753891秒，无仍运行工具会话。时间只是本轮观察，不作性能优化证据；执行工具返回完整合并输出，没有另行声称独立stderr字节计量。

正常模型：原源16B（含不暴露7B），仅两暴露文件共9B；ioCalls69/open2/closeAttempts2/closed2/峰值token1/readCalls5/readBytes9，private allocated9/exported9。dispose后cleared9、retainedBytes/buffers/records均0、activeHandles0、reader/context引用false；调用方两副本独立并由夹具清零，owner不声称替调用方擦除。元数据计费3284B、目录2。

上限模型：16个1024B源，总16384B；ioCalls8531/open16/close16/峰值token1，夹具故意2B短读故readCalls8192/readBytes16384；private allocated16384/exported16384，dispose后cleared16384且所有私有字节/Buffer/记录/reader/context引用归零。源与元数据预算按包含不暴露源的口径守卫；另在同组覆盖4096B单项、49目录、元数据恰好计费/减1拒绝、零字节及空集合。

Unknown模型：ioCalls34/open1/closeAttempt1/closed0/activeToken1、3次短读5B、allocated5=cleared5；retainedBytes/buffers/records=0，但原reader/context/token及关闭失败保留，dispose/revoke不重试。操作异常的undefined/null/0原值保存均有定向断言；组合失败断言原操作异常与关闭错误对象同时保留。关闭路径另覆盖false/undefined/Promise返回及null抛值进入Unknown，不声称关闭抛出undefined/0已逐项验证。此处token只是内存对象，actualOSHandles0；模型未知责任不能外推为实际OS句柄已关闭，也无真实待恢复资源。

全部八组还覆盖独立read/write许可、未授权/嵌套元数据/凭据与路径/对象别名、原receipt替换/失活和关联变化、读前后/末次修改整批拒绝、无暴露项无open/read、短读/异常、打开后撤销及重入。实际业务文件I/O/VM/VHD/原生接口/快照发布/工程提交为0，无临时产物；没有重复旧矩阵。模块/测试仍为获审SHA EECF79D67C45B5F5352B1CEF989F203D34AEB22F3FA04104488302077802DE16 / 70D762527CC0B867E26FDD4A8D7D68032FBC1BDC2FF7DE53E4EAC7317CD08F82，完整原测试输出交独立审核。本项只得到离线契约/替身证据，非真实来源reader或native revision桥接、无GC或实际分配剖析结论；三记录追加此结果后五文件待结果复核及精确stage，生产/default/旧权限退役关闭，P0待办。

## 49. 原FileRevisions成员租约桥接（源码待审）

§48随后已复核并精确暂存，旧审核revision23确认闭合；审核（六）核定本项六文件及八组范围。旧输入模块只将authority改名导出createInputAuthority并更新构造调用，原校验判断逐字保持；新增input-revision-lease模块和测试，追加三记录。index2001，范围外1997行SHA256 `1DA378D366E6BAF4BEB9A47AE2AFDABD83A6060220BE4A477EB045A16F88A789`；原输入/固定方案/契约/主方案blob分别43e66647a19a17c343ef952b6b2628fee81834d6、56439fd41bc88e2a14cb81f6917fd9a2765e361b、e2323269a14f7902672a177cc9fdcacf7aa4ed60、0698dc3390606239c20cebfea983d85abf34d1c4。旧9删除/patch保留。

### 49.1 实际接口与所有权

`OriginalInputRevisionLease(input, originalOwner, assertHostCurrent)`导入真实FileRevisions并复用§48预算/授权/路径校验，固定task/snapshot/session/root与epoch=原generation。至少一项必须有原有full receipt，以assertCurrent证明原owner未dispose；空集合/纯add明确拒绝，未来须补上层关闭态接点。混合add的不存在观察仍由输入reader负责。只接受已有小型full receipt；mode、residentBytes、原Buffer对象及长度受约束，compact不接纳。固定原型get/assertCurrent/generation及原owner接收对象，以WeakRef保存owner/原receipt/原Buffer；复制小型冻结metadata，不复制或读取receipt.bytes内容，不阻止owner的forget/淘汰。每次current在固定同步宿主回调前后核对全部原对象、身份五项/hash及归属；revision另核原entry许可/parents/字段。发现失效、非true、重入或撤销不可恢复，抛错原值向调用方传递；终止清metadata/weakRefs/guard。宿主回调若闭包捕获owner/receipt仍可能持有大字节，调用方须避免，本模块在终止解除该回调。

FileRevisions的forget/invalidatePath/同ID替换/128条或8MiB淘汰不推进epoch，故必须原对象成员检查，不能只看generation。get/remember公开，成员存活并非签发认证；租约不能区分宿主手工remember与签发函数，不对恶意同进程宿主提供隔离。租约不refresh/read/latest/remember，不修改生产FileRevisions；不验收receipt字节内容，实际输入owner仍须从源读取并计算hash。

SessionFiles.assertCurrent另核runtime/executionBoundary/accepting/当前service/ctx.cwd/session；本项固定宿主回调只是后续接点，测试回调不是该生产链已接通的证据。源reader仍为同步内存替身，租约不持有reader/token，不接close；租约释放不会解除输入owner的Unknown关闭责任。源根/逐父目录的Windows安全打开、真实来源reader及FileService显式原snapshot写入缺口继续待办。成功输入捕获之后未来发布/提交仍须重新使用存活租约和授权守卫，不能把已捕获状态当永久授权。

### 49.2 唯一最小验证与资源边界

待源码审后唯一命令：`D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-input-revision-lease.test.mjs`，指定PS7/login=false，紧邻核对固定Node SHA14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5、六获审文件摘要和上述范围外基线；不另跑导入冒烟、§48或旧矩阵。

只建一个专属sp-input-lease随机临时根及source.txt五字节叶。排他创建/记录根叶dev+ino，每次兼容签发沿用该固定叶，最多64次/320逻辑回执字节；不把调用数或逻辑字节当内部OS读取次数/分配计量。正例都调用现有issueSnapshotForRead实际capture；无MUTATION_READ_SOURCE的宿主已知同文result会走兼容路径，不证明完整原生read工具或SessionFiles执行链。remember合成对象只用于替换/淘汰负例。租约零文件I/O及零字节复制是源码事实，未用固定0常量冒充系统调用测量；nativeFileDiagnostics只读差值核对未启动worker。

八组固定为原owner/原方法；同epoch失效与淘汰；clear/dispose；原字段及关联变化；host非true/原抛值/重入/撤销；输入组合与读中失效清零；Unknown责任独立；四轮受控GC及引用释放。仅低频acceptance模块，无生产热路径改动、对象池或分配优化结论。GC仅报告本夹具实际观察，不外推为任意生命周期回收。

清理逐项紧邻核根/叶身份与实际路径，unlink精确叶后rmdir原根，独立ENOENT；不递归扫描/删除。创建helper分别保存operationFailed/operationError及closeFailed/closeError；双失败用AggregateError保留两原值，关闭只尝试一次，未确认则保留原FileHandle和根叶、不unlink/rmdir，正常关闭清句柄引用。八组内纯替身验证操作undefined/null/0与关闭错误双保留，无额外真实I/O。签发未完整确认会停止后续签发并保留根叶。任何创建、签发、close或身份检查失败保留实际错误与已知路径，不重跑/扩大清理；已记录根在创建后立即输出，缺少身份则不猜删。夹具输入token全是内存对象，Unknown不代表实际待关闭OS句柄。本项不启动VM/VHD/原生业务、不读取真实工程、不prepare/执行/提交/自动回滚。独立cwd/固定工具/离线依赖仍未来执行前置，生产/default/旧权限退役关闭、P0待办。

### 49.3 唯一八组通过，待结果复核与精确暂存

审核（六）完整源码预审修正了空/纯add没有原receipt可证明owner存活、创建操作与close双错保存两处边界，并加入guard后传入binding复核。定稿放行后紧邻核六获审SHA、固定Node和index2001/外1997 SHA1DA378D366E6BAF4BEB9A47AE2AFDABD83A6060220BE4A477EB045A16F88A789，首次且唯一既定命令8pass/0fail、cancelled/skipped/todo0，报告1350.9141ms；工具实际completed/exit_code0、wall1.6772725秒，无session_id或仍运行会话。完整合并原输出未截断并交审核；不声称独立stderr计量，时间非优化结论。

一个真实合成根`C:\Users\Administrator\AppData\Local\Temp\sp-input-lease-C6utBA`及唯一`source.txt`五字节叶，41次兼容issueSnapshotForRead成功、205逻辑回执字节，未达64/320上限。创建句柄closeAttempted/closeConfirmed均true、handleRetained=false、operationFailed/closeFailed=false；按原身份精确unlink/rmdir，releasedLeaves=1/releasedRoots=1，两个路径独立ENOENT断言通过。nativeFileDiagnostics的workerStarts及calls差值均0、pending0。签发内部OS I/O/原生句柄数未计量；成功兼容签发不能外推为完整原生read或SessionFiles执行链验收。

正常租约样例checks4/receiptChecks8/guardCalls4、metadataCharge1556/entries1/weakRefs3；dispose后metadata/entries/weakRefs=0、retainedGuard=false。正常输入组合是内存source reader：io27/open1/read3/5B/close1/峰token1，private allocated5/exported5，dispose后cleared5及buffer/bytes/records/context/io归零。读中原receipt失活样例io19，同为三次短读5B、open/close各1，捕获最终拒绝、exported0、allocated5=cleared5；不称每次短读前都检查租约或即时取消。

Unknown内存样例io22/open1/read3/5B/closeAttempt1/closed0/activeToken1，allocated5=cleared5，私有buffer/bytes/records0；输入owner继续保留原io/context/token，revoke/dispose没有第二次close。lease独立终止，metadata/weakRefs/guard均释放；actualOsHandles0仅指该内存reader，不涵盖签发源。原owner强引用退出并clear后，仍持活lease的四轮tick+GC中，原owner/原receipt/原Buffer三个WeakRef目标均不再存活；随后lease失效并释放全部metadata/guard。这是该夹具受控GC观察，不是全生产分配或任意宿主回调无捕获的证明。

八组还定向验证同session不同owner、固定原方法、forget/invalidatePath/同ID替换/128条容量淘汰的epoch不变拒绝、clear/dispose、原字段和关联变化、空/纯add对live/disposed拒绝、宿主非true/原falsy抛值/重入/撤销/同步改binding，以及创建双错纯替身对操作Error/undefined/null/0与关闭错误对象的保留。源码/测试未变：lease08CEE17AA1B6D1AAC5DB65C7C2AA48E0C938CC72BAF7284D26DF5ED52B11AB50、test210BFFAAD80E4BCC3A5C16288A3AF950D324D7BA780D2921517BB2D148516E98。没有真实工程/VM/VHD/native业务/发布/提交，无本项临时产物、实际Unknown资源或会话遗留；没有重跑§48或旧矩阵。三记录仅追加结果，六文件待复核精确stage，Windows来源安全读取/上层执行守卫/显式原revision写回仍待实现，生产/default/旧权限退役关闭、P0待办。

## 50. 现有SessionFiles原回执来源守卫（源码待审）

§49及最终交接已复核精确暂存。审核（七）核定先闭合SessionFiles原service/revisions生命周期接点，Windows source-root安全打开没有必须更早执行的依赖，独立留待下一项。本轮六文件：session-files.ts仅新增低频pin入口及其状态槽/私有校验，新增session-file-revision-source.ts、windows-sandbox-input-session-source.test.mjs，以及固定方案/契约/主方案三记录。生产既有getService/assertCurrent/install/read/进度路径逐字保持，无高频调用接入、对象池或分配优化结论。

初始index2003/范围外1999行SHA256 `863E71B9008B26AF02438C3A55B20120CC03E956834CA2B804C77C4223E787BA`。旧session-files/fixed/contract/main blob依次f2b77280af9681c6f635c6e02dd0afc570718957、e5a80078b40a66a3c9a922a459da69ca0bc4abe3、5b9db2a32b5a5cf29e42a85e015c2b565081fcbf、18f4af5c862eeb902a231a85891ae5fe2d160563；两新路径原不存在。原九docs未暂存删除及唯一patch保留，仅检查本项增量。

### 50.1 实际接口与限定

SessionFiles.pinReadRevisions(ctx)只接现存service，不调用getService、不创建/替换服务、不读文件、不签发/refresh/latest/remember。pin入口自身拒绝重入，内部重入即使被getter吞掉也使外层pin失败，finally清状态。SessionFileRevisionSource弱持原SessionFiles、FileService、FileRevisions、ctx、runtime、executionBoundary六对象；原signal存在则第七WeakRef，原undefined也固定，替换/移除/新增均拒绝。原revisions与boundary generation、cwd/session固定；原prototype assertCurrent、generation getter及boundary方法固定。current是稳定实例回调，原signal中止和宿主生命周期检查前后复核；ctx getter调用后再次核私有closed/accepting/原service/runtime/boundary等状态。异常含falsy原值保留，重入/撤销/失效单调终止，初始化失败同样清所有弱引用/校验器/字符串元数据。

revisions getter只有current通过才临时借出原owner，调用方可传入§49 OriginalInputRevisionLease，借出的强引用由调用方负责；source自身不持receipt或字节。该接口只证明生命周期，不证明当前用户已授权读取、task/root/path归属或回执签发认证；宿主仍须独立提供当前读取许可和§48显式集合/绑定，生产不导入acceptance模块。同进程恶意代码/任意副作用宿主回调不在隔离承诺内。完整runtime、原生read工具及Windows逐组件安全打开均不由本项兼容夹具证明。

### 50.2 唯一八组、资源预算与待审命令

待完整源码预审后唯一命令：`D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-input-session-source.test.mjs`。仅固定PS7/login=false；紧邻核固定Node SHA14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5、六获审文件摘要及上述外scope基线。不另跑导入冒烟、§47/48/49或旧矩阵。

八组依次为无service拒绝/正常原owner与固定方法；runtime Error/undefined/null/0抛值；boundary过渡恢复和对象替换；cwd/session及公开read替换原service；clear/reset/dispose及signal原身份/abort；pin/current重入、getter撤销/关闭/失活及初始化失败；真实source+原lease+内存input正常/读中失效组合；四轮受控GC引用释放。生产SessionFiles及SessionExecutionBoundary实际调用，runtime和基础read是受控最小替身；经公开install/read路径实际兼容issueSnapshotForRead，测试不改TS private字段。

只创建一个登记dev/ino的sp-input-session随机临时根及source.txt五字节叶；排他创建、最多32次已安装read调用/160逻辑回执字节（非内部OS I/O计量）。创建操作/close双失败分别保留原值，close一次，未确认保留原句柄/路径且不重试。签发未完整确认不继续签发/删除。清理紧邻核实际路径及原根叶身份，精确unlink叶/rmdir根、分别ENOENT，不递归删。nativeFileDiagnostics仅核worker启动/调用差值及pending，无native业务。读中失活组合source reader仍纯内存，5B私有字节/借用buffer须全清；不把租约释放当Unknown资源恢复。保留source存活做四轮tick/GC，观察owner/runtime/boundary/ctx/revisions/receipt/Buffer七原目标，不能外推到任意宿主回调或全生产分配。

本项尚未运行/暂存，无本项真实资源已创建。Windows源根/逐级目录安全打开、真正来源reader、显式原snapshot写回、发布/独立cwd/固定工具/离线依赖及执行/提交仍后续门槛；不读取真实工程、不prepare/执行/提交/自动回滚，不恢复契约§0已取消承诺。生产/default/旧权限退役关闭、P0待办，一次额度授权耗尽。

### 50.3 唯一八组通过，待记录复核与精确暂存

审核（七）完整源码预审发现末次runtime回调可能更换signal而最后仍比较旧采样值，已修为原assertCurrent、末次runtime.assertActive、再取ctx cwd/session/signal及私有状态后置检查；移除动态signal方法调用，固定原AbortSignal原型检查在helper前后进行。第六组复用原fixture覆盖第二次runtime回调更换signal，不增加读取。有限采样仍不声称任意恶意宿主访问器的原子一致，实际trusted ctx/runtime前提保持。

定稿预审后紧邻核六获审SHA、固定Node及index2003/外1999基线，首次且唯一既定命令8pass/0fail、cancelled/skipped/todo0、4550.8736ms。执行工具actual completed/exit_code0、wall4.8673677秒，无session_id或仍运行会话。完整合并输出未截断，审核直接read_thread原执行记录确认output.truncated=false；没有独立stderr计量，时间非优化证据。三个源码/测试未改：session-files20D86DE03C930666489D609B75F42543AE91B0C3E842C00653E9EA6343D498AC、sourceBA7854679EF2A3D6C07753D4E342DD5261395F767343A307D8C274E51CB13E3A、testA33097217FFBB7EBD8EE18DE69E49AA48A0186E3975C8C644D5B8FDACF47D3F2。

唯一实际合成根`C:\Users\Administrator\AppData\Local\Temp\sp-input-session-fsVe78`及source.txt五字节叶，26次公开installed read兼容签发/130逻辑回执字节，未达32/160预算。创建closeAttempted/closeConfirmed=true、handleRetained=false、operationFailed/closeFailed=false；按原根叶身份精确unlink/rmdir，releasedRoots=1/releasedLeaves=1及各自lstat ENOENT断言通过。审核另对两个精确路径Get-Item得到PathNotFound，不记成新的Node ENOENT。native workerStarts/calls差值0、pending0；签发内部OS I/O/隐含句柄未计量，未启动原生业务/VM/VHD或读取真实工程。

正常source样例checks5/weakReferences6/retainedVerifier=true，retainedMetadata79是cwd+session字符串长度，不是分配字节；终止后weakReferences0/verifierfalse/metadata0。正常组合source checks15/refs6，input io27/open1/read3/5B/close1、allocated5=cleared5/exported5；失活组合source checks11/refs0，input io19/open1/read3/5B/close1、allocated5=cleared5/exported0，三短读后最终拒绝，非逐短读即时取消。两组私有buffer/bytes/records/context/io均清除，正常外部5B副本也由夹具清零；实际reader OS句柄0仅指该内存模型。Unknown本轮未真实注入或恢复，不改变原input owner保留未知close责任的契约。

四轮tick+GC中保持source存活，原SessionFiles/runtime/boundary/ctx/FileRevisions/receipt/Buffer七目标均live0；随后source失效及dispose全部弱引用/校验器/metadata归零。各fixture通过公开owner/boundary关闭，pending/inFlight/revisions0、closed=true，boundary participant0/deadlinefalse。此为受控夹具引用释放，非全生产分配基准或任意回调生命周期证明。

八组还通过无service拒绝且未创建、原owner和固定方法、runtime Error/undefined/null/0保留、boundary切换恢复/对象替换不复活、cwd/session/公开read更换service、clear/reset/dispose、原signal替换/移除/新增/abort、pin/current重入与getter同步撤销/关闭/失活/初始化失败。审核已独立复核运行和清理；三记录仅追加本结果，六文件待记录复核精确stage。没有重跑旧矩阵，无本项实际临时资源、工具会话或恢复责任遗留；Windows source-root逐组件安全打开/真实reader、显式原snapshot写回及发布/执行/提交仍待接通，生产/default/旧权限退役关闭、P0待办。

## 51. Windows来源逐组件打开与同步reader基础（BASE-1，源码待审）

§50及最终交接已完成独立复核/精确暂存。工作（八）与审核（八）冻结本轮为BASE-1：新增scripts/acceptance/windows-sandbox-source-native.mjs、windows-sandbox-source-reader.mjs、tests/windows-sandbox-source-reader.test.mjs，另追加固定方案/契约/主方案三记录，共六文件。不修改旧§48–50组件、生产或热路径，不调用OfflineInputSnapshotOwner.capture、SessionFiles或原receipt lease；真实签发0。先取得来源安全打开基础的限定证据，后续外层capture关闭责任及原会话/当前读取授权组合单独接线。

初始index2005，范围外2002行SHA256 `EC04455F23AE28D1E4DC16DC888B20FF9914A3C9E8784AADA217690D40E7C70D`；算法沿用LF拼接补末尾LF/UTF8。旧主/固定/契约blob分别a5d2c39d72a6b1c5eaabbf6a4d6fa4aba2982509、b3f8a530cf788bd6301bef32051e8c5537aff47f、22d7b0d70784f63f4e98bcddb320b1a6c9be7ecb，三新增路径原不存在。保留原九删除和唯一patch，不检查或清理历史cached EOF提示。

### 51.1 API、锚点和原始基线

仅支持Windows x64、本地NTFS。复用已安装Koffi3.3.1，固定kernel32/ntdll符号，同线程同步调用；无helper/worker/编译/安装。Koffi原生模块node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node的SHA256为`072EFA48190587A6181BE48F99F28D52DB106C4D2137FE237DE0D49B892A00F6`，首次执行前再次核对。UNICODE_STRING/OBJECT_ATTRIBUTES分别16/48B及指针偏移在加载时断言，IO_STATUS_BLOCK使用16B缓冲区，NTSTATUS按有符号32位解析；仅status0、IOSB status0、FILE_OPENED1及有效handle成功。非成功但有handle保持未知且不盲关，pending不认作成功。

宿主明确提供drive、固定volume GUID和原卷根dev/ino。harness在唯一命令内一次GetVolumeNameForVolumeMountPointW查询及原卷根Node stats建立此合成场景锚点；这不是读取授权或祖先安全证明。reader再次核DOS关联后，以固定GUID卷根的Nt路径打开；先查真实句柄的NTFS、普通磁盘类型、tag、身份和GUID/DOS两种最终路径，再使用该父句柄及单一basename逐组件到sourceRoot及允许的父/叶。ObjectAttributes.Attributes=0；FILE_OPEN、SYNCHRONOUS_IO_NONALERT、OPEN_REPARSE_POINT，不设DIRECTORY/NON_DIRECTORY，不依赖OBJ_DONT_REPARSE。每级打开后拒绝任意reparse、未知/非普通属性、非预定类型、别名或不精确匹配的大小写/canonical；保留全部祖先句柄，SHARE_READ仅限数据/删除分享，不宣称锁住attribute/EA修改。依据：[NtCreateFile](https://learn.microsoft.com/en-us/windows/win32/api/winternl/nf-winternl-ntcreatefile)、[卷GUID查询](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumenameforvolumemountpointw)、[最终句柄路径](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)。

BY_HANDLE信息与FileBasic/Standard/AttributeTag交叉核验，普通文件nlink必须1，拒绝pending delete。原dev32位serial/ino64位index、size、mtimeNs/ctimeNs必须逐项相等。LastWriteTime/ChangeTime减116444736000000000后乘100转换到Unix纳秒；创建时间不冒充ctime。读前后、目录及结算前重复真实inspect，按原SHA256增量核字节，不refresh/latest或修改authority。兼容性须由本次同一合成文件的实际Node stats与native字段验证，不沿用§36。依据：[FileBasicInfo](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_basic_info)、[FileStandardInfo](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info)。

createInputAuthority仅承载显式宿主集合及预算，不认证批准/签发来源。metadata查询限已列根/父/叶；内容open/read仅expose=true原有项，未批准路径在native调用前拒绝。add只有已验证父句柄下最终basename的STATUS_OBJECT_NAME_NOT_FOUND可表示不存在；祖先不存在、access denied、tag错误不能降格为null。guard只为同步宿主存活检查，公共业务前后复核，false/异常/重入后单调失效，保留undefined/null/0原异常；不称当前读取授权、SessionFiles生命周期或原receipt认证。

### 51.2 所有权、预算与交付限制

构造在native首调用前拒绝根路径超过32分量或总目录预算超限。卷锚1+至sourceRoot最多32目录+root内额外48=81目录，加单叶峰82个本reader实际句柄；不是进程总句柄峰。每reader打开尝试≤256（成功另计）、ReadFile≤4096、累计实际读取≤16KiB/单文件≤4KiB、业务原生调用≤8192（失败取错留一调用余量），cleanup及取关闭错误不受业务预算/guard阻止。原authority元数据计费≤32KiB，额外树/槽路径保守计费≤64KiB；原生owner固定自有scratch2264B，逐调用清零，dispose清零并释放。该计数不覆盖Koffi封送/系统内部复制或V8总分配，不是性能优化结论。

每个open前先登记责任槽；原生返回handle先写槽再校验，部分打开失败仍可找到原责任。逆序每handle最多一次CloseHandle，attempt在调用前置位。关闭未知保留原handle/token/path/status/ops/context、原operation值及各close错误，不重试数字句柄；正常/已确认失败释放显式槽、ops、guard、context和内容状态表。保留的原operationError本身可能携带外部引用，dispose不抹掉这项证据；本轮不声称释放任意异常对象内部引用。成功settle要求每个expose原有项恰好一次完整原hash核验，再核全部原metadata和当前guard，最后确认所有关闭；未read或仅metadata的暴露项拒绝，重复content-open在native前拒绝。non-expose仅核metadata，空/纯add的基础结算不等于原lease准入。closeAll仅代表资源关闭，不是授权或快照成功。

read借用调用方Buffer仅至同步返回，使用handle自己的文件位置，offset仅为目标buffer位置；每次长度受原size/累计预算约束。后置hash/metadata/guard失败清零本次整个请求区，拒绝交付；此前已经返回的其他块和全部外部副本仍归调用方清理，reader不保留这些Buffer引用。后续capture外层必须阻止部分字节发布并在任一失败全清私有输入；旧input自身只跟踪叶token，尚不能覆盖本reader祖先/部分打开Unknown。本阶段不把基础接口直接安装到input，也不产生input-captured。

### 51.3 唯一八组及现场资源预算（尚未运行）

源码预审后唯一命令拟为`D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-source-reader.test.mjs`。仅固定PS7/login=false，紧邻核固定Node SHA14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5、Koffi模块/六文件摘要和外scope。不得先导入冒烟、bootstrap探针或重跑§47–50/旧矩阵。

八组固定为：①真实GUID至嵌套5B叶，Node/native全部metadata兼容、2/2/1目标区分段及原hash；②错误锚/root/ctime、大小写别名拒绝；③同一真实junction分别位于sourceRoot严格上方祖先与root内部父；④真实leaf symlink拒绝（无权限直接失败，不skip）；⑤真实hardlink nlink拒绝；⑥原有writer共享冲突与真实读取后guard失活/请求区清零；⑦纯ops未read/仅metadata结算及重复content-open拒绝、超深/未批准/不暴露/超长读取、inspect前部分open与open自身写slot后抛错、falsy/重入、add缺失限定及错误hash；⑧纯ops close Unknown及非success/pending有handle但不可关闭的原责任不重试，保持已关闭reader存活做四轮tick/GC，正常模型原input/ops/guard三目标释放。GC不涵盖保存的任意异常对象。模型句柄不等于真实HANDLE，Unknown只模型注入，不伪报实CloseHandle失败或恢复。

唯一mkdtemp登记根下inner和inner/outside两目录、inner/source.txt五字节叶，以及各一个junction/leaf-symlink/hardlink顺序创建并精确移除，最多7个唯一命名节点及7次创建登记（不重建link，hardlink不另有内容），没有递归删除。junction指inner；祖先场景sourceRoot为junction/outside、原identity为实际inner/outside且entries为空，只检验真实根链；另一场景仍检验root内部junction/source.txt。每个新场景独立采集原baseline，建/删link后引起的metadata变化不由reader刷新。最多16真实reader（当前源码11）、native内容总≤128B（正常预期10B），真实签发0；fixture显式Node文件打开≤3、同时≤1，关闭各一次；bootstrap仅1次GUID查询/0handle。Node测试runner自身进程与框架I/O不计业务worker/child0，nativeFileDiagnostics核原worker启动/调用差值和pending；不声称覆盖隐含Node OS I/O。自有JSON输出≤24KiB，另有测试框架输出；实际新代码无业务child启动路径。真实调用方5B/9B缓冲区清零单列计量，native scratch计量独立。

真实关闭未确认即保留reader对象和全部精确路径，禁止后续acquire/清理；成功则紧邻核原祖先链/节点dev/ino、绝对根内路径及预定类型，逐叶unlink、逐目录rmdir，每路径独立ENOENT。mkdir/叶/链接创建记录区分已创建并获id、已创建未获id、失败后确认不存在；创建或身份阶段失败停止进一步acquire并输出精确路径/阶段，未获id不删，已登记安全节点仍逐一尝试精确清理。原创建/操作/关闭异常与独立清理异常分别保留，不重试已尝试的删除，不把非空父目录删除失败伪记成清理成功。关闭取错调用单列closeErrorCalls，不混入8192业务calls。不存在真实工程内容读取、VM/VHD、执行/提交或自动回滚。原会话/原lease及当前读取授权组合、input外层关闭、显式原snapshot写回、快照发布/独立cwd/固定工具/离线依赖均仍后续。生产/default/旧权限退役关闭，P0待办，额度一次授权耗尽。

### 51.4 唯一八组通过，结果已独立复核，待记录复核与精确暂存

审核（八）完整初审收口A–E：settle逐expose完整原hash及content单次；junction严格祖先场景；关闭取错独立计数、普通属性白名单、创建/身份失败分态；open写slot后抛原值与pending不可关闭责任；GC/保存异常引用限定。修订复审后，在同次命令紧邻核六SHA、固定Node/Koffi及index2005/外2002基线，首次且唯一既定命令8pass/0fail、cancelled/skipped/todo0、224.3505ms。执行工具actual completed/exit_code0、wall0.5411446秒，无session_id；审核直接read_thread核原commandExecution `exec-58b46d3b-671b-442c-8c21-8d77c70c3a25`及output.truncated=false，其毫秒摘要541ms。完整合并原输出未截断；没有独立stderr计量，时间不作为优化证据。

三源码/测试执行后未改、未重跑：native SHA332772C2F8539EF99980FCD4A2D8A5D54E4747283287D278EF7632095200D21F；reader SHAFF3DD799B26CFCDE7BE1A61FCBD7BA5DAB4A531E8357CC78BD417F0B576ECDB2；test SHA6E1A994911CF8513D33B528D5C3E8356FD44C6084039E078CF7E5633CDA4F15C。未运行旧§47–50/矩阵、导入探针或额外现场。

唯一根`C:\Users\Administrator\AppData\Local\Temp\sp-source-QrGdsI`，七登记节点为根、inner、inner/outside、inner/source.txt、junction、leaf-link.txt、hard.txt。所有created/identified/removed/released/cleanupAttempted均true，creation/cleanup/fixture failures0、unresolvedReaderCount0、resourcesSafe=true；按原身份逐节点删除及各自Node ENOENT断言通过。审核另用固定PS7对七精确路径Get-Item均PathNotFound/ObjectNotFound，不记成新的Node ENOENT。fixture显式Node open/close2/2、active0/峰1；无本项真实资源、工具会话或实际关闭恢复责任遗留。

11真实reader逐行原JSON经独立解析汇总：打开尝试88、opened=closed=closeAttempts87，reader峰值9（不是进程总句柄峰）；业务native calls3293另bootstrap1，ReadFile共4次/10B、closeErrorCalls0。正常项三段2/2/1共5B，真实Node/native dev/ino/size/mtimeNs/ctimeNs及原hash一致；失活项一次5B，hash计数verifiedContents1后仍由后置guard拒绝，清本次请求区5B，不能将其closed/hash计数记为成功交付。真实调用方allocated14=cleared14，此计数与clearedBorrowedBytes5重叠，不能相加当唯一内容字节。11reader自有scratch allocated=released24904B，bootstrap另2264B，所有retainedScratch/Bindings归零；各reader active/slots/context/ops/guard/contentStates/borrowedBuffer字段归零。计量不覆盖Koffi/系统内部复制、隐含Node I/O或全部进程分配。

真实严格祖先及内部junction、leaf symlink、hardlink nlink、原有writer共享冲突、错误锚/root/ctime/大小写别名均拒绝。第7/8组模型通过未read/仅metadata结算、重复content-open、预算/未批准路径/非expose/原hash、限定add缺失、falsy/重入及部分open原责任。模型Unknown1+pending1，已知实际Unknown0；原close-attempt无重试，非closeable pending未误关。四轮tick/GC保持已关闭reader存活，正常模型原input/ops/guard三目标live0；不外推保存的原异常对象或真实故障恢复。原native worker启动/调用差值0、pending0；业务child无调用源码，但没有OS进程总量计量，Node runner自身不算业务child。

结果独立复核后仅追加三记录，六文件待记录复核及精确stage。BASE-1只验证本机Windows x64/NTFS来源安全打开和同步reader基础，不接input.capture/SessionFiles/lease，签发0，不认证当前读取许可、不发布输入快照，不称完整生产集成。后续须由外层统一祖先及部分打开Unknown、失败私有字节全清和最终关闭，再接原source/lease/当前授权；显式原snapshot写回、发布/独立cwd/固定工具/离线依赖及真实执行提交仍待接通。生产/default/旧权限退役关闭，P0待办，§0取消承诺不恢复，额度一次授权耗尽。

## 52. 原会话租约与Windows输入捕获组合（源码待审，尚未运行）

§51及最终交接已独立复核、精确暂存并完成暂存后确认。工作/审核（九）冻结五文件：新增scripts/acceptance/windows-sandbox-input-capture.mjs、tests/windows-sandbox-input-capture.test.mjs，追加固定方案/契约/主方案三记录；旧§48–51组件和生产热方法逐字不改。初始index2008，五文件范围外2005行SHA256 `7B37826DBC8CF37C34A05EA144F5AB6A9A92D19A891403B535AEA141E9F62B88`（精确排除scope、LF连接补末LF、UTF8）；固定/契约/主方案旧blob分别290870380657bc0aa334d5e22ee0f3d1497e75e4、eeef1669653a2be8161201677df4a2791d243413、5c89666e48b7c9ff2de7043fdfb42b8ec9bc1264。原九删除/唯一patch保持，不清历史cached EOF提示。

### 52.1 同一输入、原来源和独立读取许可

WindowsInputCapture仅接受专门移交的真实SessionFileRevisionSource实例。品牌检查后、schema检查前接收该source所有权；构造拒绝释放它，正常/失败只释放自己的source、lease、input和reader，不dispose外部SessionFiles。固定原source.current、原型revisions getter/dispose；借出的原FileRevisions强引用只用于同步构造OriginalInputRevisionLease，不存入wrapper。先调用createInputAuthority将调用方输入转为固化数据，再补回classification=ordinary并全冻结；lease/input/reader均消费这一份canonical input，不从外部可变输入重复采样namespace。

原source/lease验证生命周期与原receipt成员，不能授予读取许可。另要求同步可信宿主authorize(binding, entries)对固定task/snapshot/session/epoch/root及整批expose/operation集合返回严格true；false、Promise、其他非true或原异常均拒绝。本轮该回调是受控合成许可接缝，不接生产权限UI或把写回保护推成读取许可。没有调用现有authorizeFileObservation：其异步入口可走getService，且无compatibility boundary的分支只核生命周期。原空/纯add/full-only门槛保留，不refresh/latest/remember或伪造receipt补基线；第2组不重做旧compact矩阵。

组合guard先核原lease（内部guard仅核source），调用独立authorize，再核原lease/source及wrapper单调状态，避免递归。该guard安装至WindowsSourceReader每个公开业务操作前后，包括每次短read；input本身的current/revision检查继续保留。原throw undefined/null/0单独记录，重入或忙时revoke/dispose只失活，等同步栈展开再释放；回调吞掉重入异常仍不能恢复。宿主回调是可信同步边界，不宣称任意恶意同进程回调的原子性或receipt签发认证。

### 52.2 全链时序、字节和Unknown

私有时序为canonical input→原source/lease/authorize→reader.initialize→input.capture→reader.settle（末次真实metadata/hash/guard及全closeAll）→关闭之后再核原source/lease/authorize→外层captured。外层不返回内部input/reader/adapter。input.#read末次#check在叶token仍打开时调用io.file；私有adapter只对活动原token和精确同path调用reader.stat(token)重新真实查询，不缓存、不重开，不重新签发。活动叶期间其他path直接拒绝；close在finally清adapter token，原native槽始终仍由reader负责。

任何拒绝先保存input原failure及外层原异常，再revoke清全部私有字节，随后处理剩余native祖先/部分打开句柄。input已经执行的叶finally关闭不等于整条链关闭；input cleanup=complete不能覆盖native pending/unknown。initialize/预检file/open抛前取得的槽、叶close、settle及native dispose均归外层。关闭错误与原操作值分别保存；settle内activeHandles=0而cleanup仍pending的释放异常，另记cleanupFailed/原cleanupError并保持操作异常，不重试dispose。若settle前置复查失败且仍持句柄，则全清私有bytes后关闭剩余祖先。Unknown保留原reader/input/ops/槽和attempt，不重试数字HANDLE，不因dispose消除责任；无活句柄的ops释放Unknown与HANDLE Unknown分列。所有已知native资源关闭后再发生授权失败仍是拒绝。正常清自有引用；保留原错误本身可能外持引用，宿主authorize自行捕获的对象也不是桥能提前释放的内容。

成功后copyFile仍在前后检查同一source/lease/授权；后置失败将新副本及全部私有输入清零，不返回。一次复制限制沿用input，返回成功副本归调用方清理。原source byte、私有输入byte、成功外部副本、失败副本与native请求区分开计数；失败请求区与私有buffer可能重叠，不能相加为唯一字节。除既有单4KiB/合计16KiB和native82句柄/8192业务calls/256open等上限，本轮不提高预算。低频acceptance组合不进入生产热链；不引入对象池，不把计数或时间外推为全生产分配结论。

### 52.3 八组与唯一执行/资源预算（待完整源码复审）

固定八顶层test：①真实SessionFiles/boundary、受控runtime/basic installed read签发原回执、原lease和native捕获5B，原token stat及成功一次copy，断言许可接缝完整冻结关联与operation；②初始许可false/Promise、source/epoch/empty/pureadd/schema/形似source及forget原回执均在native前拒绝；③真实read之后许可失活、全私有5B清零；④真实所有close后末次许可拒绝；⑤真实copy之后许可拒绝且观测实际新副本清零（串行测试临时包裹原copyFile，finally恢复，原复制逻辑不替换）；⑥纯ops partial-open/preflight祖先/leaf close/pending四个HANDLE模型Unknown，另有全handle关闭后的dispose原null错误/Unknown、settle前置复查原0错误后正常关闭，分别验证不重复close/dispose及清零先于剩余关闭；⑦纯ops 2/2/1短读/同token stat、错误canonical namespace、falsy和吞重入/revoke/dispose，以及第一个2B短读后许可拒绝/持资源吞重入或revoke、authorize返回true前forget原receipt后的post-lease拒绝，均不做第二次read/不补新基线；⑧保持captured wrapper存活，退役原会话后四轮tick/GC核7原对象加调用方input共8目标，随后stale copy拒绝清私有5B和授权引用。compact gate仅沿用旧源码限定，不伪造compact receipt。

唯一拟命令：`D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-input-capture.test.mjs`。只能完整源码预审/修订复审后首次运行；紧邻核五文件SHA、固定Node SHA14319838B3F355E0398C13569A90270BCE4FC68F25189F58C59B03DADAE0E6D5、Koffi SHA072EFA48190587A6181BE48F99F28D52DB106C4D2137FE237DE0D49B892A00F6和上述外scope，固定PS7/login=false。无先行导入探针/冒烟、不重跑§47–51或旧链接/容量矩阵。

唯一mkdtemp根和source.txt两节点、5B内容，不创建链接；fixture显式open/close各1，同时1，原身份精确unlink/rmdir且每节点独立ENOENT。所有真实capture在首次调用前登记，finally/afterEach及最终after只按登记对象收尾统计；即使预期断言失败，Unknown仍置safe/acquire=false并保留原对象，不能继续获取或删路径。会话/boundary也在签发前登记，setup/GC退休失败分别尝试已知owner与boundary收尾，首个异常不跳过其他责任，失败不重试原操作。创建未得id或真实关闭不明保留精确路径及责任，不广泛清理/重试。最多8真实reader/40B native内容，最多10次public installed兼容签发/50逻辑B（当前源码预期8次签发、5reader/25B），wrapper签发0；bootstrap1次GUID查询/0handle，scratch沿用2264B。模型Unknown不是实际HANDLE故障，真实不明即停止acquire/清理；自有JSON≤24KiB、另有测试框架输出。native worker启动/调用差值与pending另核，业务child源码无启动，不声称OS进程总量或隐含Node I/O全计量。没有VM/VHD/真实工程读取执行提交或自动回滚。

本小项只补来源基础与输入owner的组合及显式宿主许可接缝，不发布输入快照，不称完整runtime/native installed read或生产权限适配。原snapshot写回（FileService write无显式snapshot且会选latest）、发布/独立cwd/固定工具/离线依赖及真实执行提交仍后续。生产/default/旧权限退役关闭，P0待办；§0取消承诺不恢复，额度一次授权耗尽。

### 52.4 首次唯一八组通过，原结果已复核，待记录复核及精确暂存

审核（九）完整预审收口A–C后修订复审通过：所有真实capture/session事前登记、断言/setup/退休失败不漏原责任；settle释放原错独立保存并验证不重试；持资源短读后授权/吞重入/revoke及回调forget后的post-lease反例。紧邻核五获审SHA、固定Node/PS7/Koffi三摘要及index2008/外2005基线/三旧blob后，首次且唯一既定命令8pass/0fail、cancelled/skipped/todo0、406.5233ms。原commandExecution exec-92d79377-7beb-4df7-8b01-56b20e9d89b8（chunk8e1b35）actual completed/exit_code0、wall0.7638956s、无session_id；审核直接read_thread核原输出truncated=false，工具摘要763ms。完整合并原输出7692UTF8B，其中测试自有JSON6620B；无独立stderr计量，时间不作优化证据。

两源码/测试运行后未改：wrapper SHA BE017E91D6C0DE1F0D6C4781D4D121C47971856ACD49AE7AC8CA510EC5C9AB81，test SHA 4D88C5FD13ADF11A83A74B1835A0FF338ED2B2EEC3BD3830BC0EDD081DE4DC08。没有导入探针、第二次运行或重跑§47–51/旧矩阵；compact full-only门槛仅沿用原源码，不称本次重新验证。

唯一根C:\Users\Administrator\AppData\Local\Temp\sp-input-capture-JZpuoL及其source.txt两节点created/identified/removeAttempted/removed均true，safe=true/errors为空。原身份精确unlink/rmdir及各自Node ENOENT断言通过；审核另以固定PS7对两精确路径Get-Item均PathNotFound/ObjectNotFound，不记成新的Node ENOENT。fixture显式open/closeAttempt/closed各1，无保留handle。12真实capture owner登记全部已收尾，unattempted0、unresolvedSession0、actualUnknown0；无本项实际资源、工具会话或真实恢复责任遗留。

五原reader JSON独立汇总：attempts=opened=closed=closeAttempts58，reader峰8（不是进程总句柄峰）；ReadFile5次/25B，业务native总9081+bootstrap1，单reader最高1989<8192，closeErrorCalls0。四reader各12打开/关闭及1989业务calls，真实read后失活项10及1125。五reader自有scratch allocated=released11320B，bootstrap另2264B；全部retainedScratch/Bindings及reader active/slots/context/operations/guard/contentStates/borrowedBuffers归零。原native worker启动/调用差值0、pending0；无业务child源码调用，不外推OS进程总量、Koffi/系统内部复制、隐含Node I/O或全部V8分配。

harness八次public installed兼容签发/40逻辑回执B，wrapper签发0；来源为真实SessionFiles/boundary及受控runtime/basic read，捕获内容则使用真实Windows native reader。正常原token stat及冻结task/snapshot/session/epoch/root/expose/operation、单次成功copy5B全清通过。真实read后许可失活时，native已读5B且verifiedContents1，input.readBytes仍0并拒绝；本次请求区5B与input私有5B清零重叠，不相加或记为成功交付。全close后末次许可拒绝仍清私有5B；post-copy实际新副本5B观察全0且不返回，私有5B另清。各real input释放断言确认retainedBytes0，不把关闭/hash或内部input-captured冒充外层交付。

模型partial/preflight/leaf/pending四项各保留一个原HANDLE责任槽，其中pending不可close；原异常/slot/ops/attempt保留，CloseHandle模型无重试。另一个dispose模型active/unresolved handle0但保留7个已关闭目录槽和ops，原null同时保留operationError/cleanupError，disposeCalls仅1；五个模型Unknown owner不是实际HANDLE失败或恢复。settle第4次metadata open前置复查throw0后，先清私有5B再关剩余句柄、正常dispose一次。三种在途拒绝各在首个2B短读后停止（read1），私有5B全清且callback内不提前close；authorize内forget原receipt仍返回true时由post-lease拒绝，不补remember/latest基线。其余初始九拒绝、wrong canonical、falsy/吞重入等组内断言通过。

保持captured wrapper存活，退役原会话后四轮tick/GC，原owner/runtime/boundary/ctx/revisions/receipt/receipt.bytes及调用方input八指定目标live0。随后stale copy确实拒绝、私有5B归零及authorize结构引用释放；未对authorize做GC证明，不外推原异常对象内部引用或宿主回调自行捕获对象。

原结果/两路径复核后仅追加三结果记录，五文件待记录复核及精确stage。§52已验证低频输入捕获组合及受控宿主许可接缝，未发布快照，未接生产当前权限适配/完整runtime或native installed read。原snapshot写回、发布/独立cwd/固定工具/离线依赖与真实工程执行提交仍后续；生产/default/旧权限退役关闭、P0待办，§0取消承诺不恢复，额度一次授权耗尽。

## 53. 固定输入的真实读取许可准备（源码待审，尚未运行）

§52与最终交接已完整闭合。本项先补真实权限准备，不依赖显式原snapshot写回；不接capture/copy/发布。工作/审核（十）冻结八文件：新core session-input-read-permission.ts、新acceptance windows-sandbox-input-read-preparation.mjs及新八组测试；SessionFiles和SessionPermissionController仅增加低频入口/import/固定校验；固定方案/契约/主方案追加记录。初始index2010，八scope外2005行SHA256 `36EA5D920BD70F779C04F12DB52457C7A5500C3A17B44DDA23FA4F24C171E85E`（精确排除scope、LF连接补末LF、UTF8）；旧五blob为session-files 6ba86fc1fbed418658d1219100415a7cb9de69c3、controller 3006fbe1a6ddaba4e24d32977d16290c52010b78、固定7ae65575dd13c98039a55c04ef395435ccdb99a5、契约cd49b169040d608583ba0c265886e5cf78bd6e56、主ee3302c74363c654df570fe86a616cbfc59100e6。原九删除/唯一patch保持，旧§47–52不重跑。

### 53.1 真正权限、原会话和绑定

实际路径许可来自SessionFiles的compatibility boundary（SessionPermissionController），与source固定的runtime.executionBoundary不同。新pinInputReadPermission只用已存在service和支持prepareInputRead的原boundary；缺失即拒绝，不getService。借用source必须属于原service.revisions，整个生命周期弱借原source/owner/ctx/permission boundary，固定prepare方法；不接管source或dispose外部SessionFiles。原owner/service/ctx及两个boundary失效前后均拒绝。

Controller新prepareInputRead在await前创建InputReadPolicyLease：固定generation/sequence的原弱issuer回调、弱ctx/signal（包括undefined）、原cwd/session及冻结paths。借固定原prototype authorizeFileObservation完成真实async目标canonical、当前scope和工作区身份检查；跨await再核原lease后返回。旧/changes观察接口逐字保留，返回的强assertAllowed闭包不长期保存。同步assertCurrent只核原policy/ctx/signal有效性，不重复文件系统检查，不代表当前路径或关闭后copy已续验。

acceptance preparation owner在首次await前createInputAuthority固化task/snapshot/session/epoch/sourceRoot及全部entries/expose/operation/identity/hash/原revision；独占自己的专用source及OriginalInputRevisionLease，原receipt在等待前固定、等待后复核。SessionInputReadPermission只弱借source。路径表涵盖sourceRoot、去重parents和所有entry（含non-expose/add的元数据观察）；不把写回许可、source.current、对象freeze或receipt成员当读取签发认证。prepare单次；checkPrepared只比较完整固定binding/entries并以前后原lease围住permission检查，不公开capture授权回调。没有latest/refresh/read/新receipt补旧基线。

### 53.2 失效、等待和预算

任一撤销、检查失败、ctx/signal或boundary更换、吞掉重入后均单调失活；恢复原sequence/上下文也不复活。原throw undefined/null/0单独failed字段保存。prepare等待中revoke/dispose清逻辑引用；仍等待原异步调用结算，不能称取消OS观察。迟到真实policy由原owner释放一次后拒绝发布；正常/失败释放原policy、source与revision lease，不触外部SessionFiles。policy/source释放是固定类的字段清理，不做OS close或异步恢复；外部原Error若自带引用不能外推为全释放。

路径限1–34、每项4096字符、全部8192字符，重复/非绝对/含NUL拒绝；authority原16项/单4KiB/源总16KiB/49目录/32KiB metadata不提高。超过34观察路径直接拒绝，不拆批扩大。保留两份authority结构（preparation及原revision lease，各按原32KiB保守记账，不等于V8 heap）；Session permission与policy各一份冻结path表，各最多8192个UTF16字符；preparation组装path表只同步暂存，异步调用期间旧观察函数另有一份targets副本。policy另保留cwd≤4096及session≤64字符；原source另按既有字段保留原namespace。无源Buffer复制、native reader或内容捕获。上述是各层结构上限，不声称所有V8/Node内部字符串或数组分配精确字节。

低频调用链为preparation构造→pinReadRevisions/原lease→pinInputReadPermission→prepare→Controller.prepareInputRead→旧authorizeFileObservation→state.assessTarget/工作区lstat-realpath→跨await原source/lease/policy复核→prepared；checkPrepared→原lease→permission/checkSource/policy→原lease；dispose/失败清自有引用。现有getService/install/read/authorizeFileObservation、observer/progress/render/terminal/Evidence热方法逐字不改，无对象池，不扩跑生产性能基准。

### 53.3 唯一八组与执行前提（未运行）

①实际Controller/SessionFiles准备、冻结调用方输入及新类同源；②无service/boundary/新增能力拒绝且不创建service、真实outside范围拒绝；③异步等待后policy/source/原receipt失活；④prepared后sequence/signal/session/原permission boundary失活，恢复数值仍拒绝，原abort0；⑤完整关联和entry字段拒绝，non-expose/add paths观察；⑥等待中revoke/dispose迟到policy清一次、falsy原错、吞重入及回调forget；⑦34项/8192字符/重复等预算、原空纯add门槛与弱借source不误dispose；⑧保持prepared wrapper活，退役session后四轮tick/GC核owner/runtime/execution boundary/ctx/revisions/receipt/bytes/controller/原input共九目标，再check拒绝并释放。compact只沿用旧full-only门槛，不重跑旧矩阵。

唯一拟命令 `D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-input-read-preparation.test.mjs`。固定PS7/login=false，完整源码预审/修订复审后首次执行，紧邻八获审SHA/固定Node与PS7摘要/index外scope。无提前导入/编译/探针/冒烟。测试静态加载当前SessionFiles/core，动态加载当前controller源码；仅用临时registerHooks把新增internal export映射到完全相同core源URL，finally立即deregister，验证真实返回policy instanceof同一类。其他既有package导出沿用当前环境，不宣称全工程dist重建。

单登记mkdtemp根/source.txt两节点5B，不建链接；fixture显式open/close各1、同时1。最多12次public installed兼容签发/60逻辑回执B（受控runtime/basic read），preparation签发0；Controller真实prepare调用≤96、实际assessTarget≤256，先检查再增计数；隐式Node元数据I/O另不全计量。native reader/captured bytes/业务child为0，自有JSON≤16KiB、框架输出另计。所有preparation/session在使用前登记，已开始异步等待收尾后才清路径；root/leaf原身份精确unlink/rmdir并各自ENOENT。实际fixture close/身份不明停acquire保留原路径；不广泛删除/kill或重试原操作。没有VM/VHD、真实工程读取/执行/提交或自动回滚。

本项仅“固定输入的真实许可准备及同步失效检查”。workspace grant原身份与native链绑定、全close后消费续验、§52整合、显式原snapshot写回、发布/独立cwd/固定工具/离线依赖仍后续；FileService write无snapshot/latest缺口未改。生产/default/旧权限退役关闭、P0待办；§0取消承诺不恢复、额度授权耗尽。

53源码预审A–C修订（仍未运行）：A在SessionInputReadPermission pin时独立固定传入ctx的原cwd/session/signal（含undefined），弱持原service/signal，不能借source的不同ctx接纳后来的signal；前后采样ctx之后，以原service/boundary/source state纯字段核验收口。Session permission另有cwd≤4096/session≤64的结构字符串计账，正常/失败清零。B保留检查完成后的迟到policy gate，新增真实authorizeFileObservation内原assessTarget结果await处的gate，分别改变policy/signal/原receipt，完整结算；直接policy检查失败后恢复checkpoint仍拒绝。C把检查分为可触发ctx/runtime回调的复核与最后纯issuer/owner身份阶段；core与外层最终原receipt回调之后，追加固定原controller generation/sequence的纯检查，不再调用ctx/runtime。原receipt成员后置复核不被移走，不以交换顺序留下另一侧缺口。组4精确第7次末次callback换boundary，以及core第14/外层第36次末次runtime callback撤销policy，要求当次拒绝且恢复仍失活；组7两个ctx同service但pin后signal改变在真实prepare前拒绝。固定pure检查不做FS续验，公开方法不提供capture许可，业务热方法仍未改。

### 53.4 首次唯一八组通过，原结果与路径已独立复核（待记录复核/精确暂存）

审核（十）A–C修订同版完整复审通过后，紧邻重核八获审SHA、五旧index blob、index2010/外2005摘要及固定Node/PS7，首次且唯一执行既定命令。8pass/0fail、cancelled/skipped/todo0、10800.4821ms；原commandExecution `exec-371182c3-1db4-490e-9ddd-9d29d3ae0cee`实际completed/exit0、工具记录11174ms、output.truncated=false。首次工具chunk533dfa于10.0182082s返回session72457/空输出；唯一轮询chunk822224实际exit0并交付全部输出，无活工具会话。完整原输出3314UTF8B，四条自有JSON2330B；审核直接read_thread独立计算一致。无独立stderr计量，时间含启动且不作性能改善结论。

执行后五源码/测试保持获审SHA：core 2A2F0B69DAA128AE48063891AB371B2ED935D14F29809119F58FE1B4B044180E；session-files 85239690FA2FB9833279B4E537696EE1C1C15F673AF852B8E4737C61298A8DB1；controller 4191685AD44F1814534C003FFF8B066037698B6A746ED6EE8AE5439A21C00781；acceptance FE08D8570423513CB5FF6D8BAA581736814199FB647F7FA3E4A26A5C87FB8569；test AC81C76B5A8E069A953F9987B5CB563D3E0409EAEBCE3E9F437FDFDEA3DACF39。没有提前导入/编译/探针/冒烟、第二次运行或旧矩阵重跑；旧生产方法及source未改。

唯一根C:\Users\Administrator\AppData\Local\Temp\sp-input-permission-r2wbc3及其source.txt两节点created/identified/removeAttempted/removed全部true，safe=true/errors=[]。按原身份unlink/rmdir及各自Node ENOENT断言通过；审核分别用固定PS7得到PathNotFound/ObjectNotFound，不混记为另一次Node检查。fixture open/closeAttempt/closed各1、无保留handle；无本项实际文件、工具会话或恢复责任遗留。

九次public installed兼容签发/45逻辑回执B，preparation签发0；真实Controller prepare36次、assessTarget83次，在≤96/≤256内。33个acceptance preparation登记，最终live0/pending0/unresolvedHost0；源与permission直接借用用例在各finally释放。native source reader0、捕获内容0、native worker启动/调用差值0、pending0。兼容签发仍是真实SessionFiles/受控runtime及basic read，不称完整native installed read；新准备无内容复制，不外推OS进程/句柄总量或隐式Node元数据I/O。

正常准备回执明确filesystemRenewed=false；同源policy instanceof、完整canonical/原baseline绑定、non-expose/add路径观察通过。A两个ctx同service但pin后signal替换在真实prepare前拒绝，恢复不复活；B真实assessTarget await内的policy/signal/forget三支与完成后迟到policy三支分别通过，等待中revoke/dispose各清迟到policy一次且pending结算；直接policy失败后恢复checkpoint仍拒绝。C末次runtime第7次换permission boundary、第14次core及第36次外层末次回调改policy，均当次拒绝并不可恢复；原receipt后置成员核保留。原abort0与throw undefined/null/0、吞重入、回调forget、34路径/8192字符预算及空/纯add原lease拒绝等组内断言通过；compact门槛沿用旧源码，不记作重跑。

保持prepared wrapper存活，原owner/runtime/execution boundary/ctx/revisions/receipt/receipt.bytes/controller及调用方input共九指定目标在四轮tick/GC后live0。随后stale check拒绝，authority/source/lease/permission引用全清，permission弱refs0/paths0/metadataChars0/policyDisposals1，source弱refs0/retainedMetadata0，lease引用与metadata0。不是任意外持Error或宿主回调引用、所有V8分配的释放证明。

原结果/两路径已复核后，仅追加三结果记录；八文件待记录复核及精确stage。本项只验证固定输入的真实许可准备和同步失效检查。workspace grant与原native身份绑定、FS续验/关闭后copy、§52整合、显式原snapshot写回、发布/独立cwd/固定工具/离线依赖及真实执行提交仍未来。生产/default/旧权限退役关闭，P0待办；§0取消承诺不恢复、额度授权耗尽。

## 54. 原workspace grant固定及真实异步续验（源码待审，尚未运行）

§53及最终单文件交接已完整闭合。工作/审核（十一）最终冻结六scope：新增packages/coding-agent/src/core/files/input-workspace-grant-lease.ts；packages/extensions/resource-lifecycle-guard/permission-controller.ts仅新增import/低频prepareInputWorkspaceRead和固定static/helper；新增tests/windows-sandbox-input-workspace-grant.test.mjs；本固定方案、契约预审和主方案三记录追加。先前讨论的八scope/native/source组合没有实施。本阶段不改SessionFiles、§48–53/source/preparation/reader/capture；不接原receipt、原native或内容消费。完整成果限“原grant固定、失效和真实FS续验”，不是读取/copy授权。

初始index2013、六scope外2009行SHA256 `4B3D2A1B9F9AA73927C4CB51D5EBD87641508888EE37F3F6635E1A80D41C0B90`；算法为git -c core.quotepath=false ls-files --stage、精确排除scope、LF连接补末LF、UTF8。旧四blob：controller761b8daa398ae09773248e34eeb5c43e05d281b7、固定7796293f4c294ba998efff0889a848d06739cfd7、契约d8e9a9df997a426273882a9bc48be3d1916dd68d、主aa8a61f6512a3f689570ecd20502d3443421774c。三记录原前缀401215/110301/649096B保持；原九删除/唯一patch不动。仅固定PS7/login=false，不commit/push/reset/clean/广泛stage，不重跑§47–53或旧矩阵。

### 54.1 原对象、精度、映射与时序

Controller新prepareInputWorkspaceRead(ctx,paths)在首次await前固定全部目标、按原primary优先及additional顺序选出的同一个原grant对象和原槽位；跨grant拒绝。InputWorkspaceGrantLease只弱持原issuer/ctx/grant，另用§53原InputReadPolicyLease固定ctx/signal含undefined、cwd/session与generation/sequence。原requestedPath/canonicalPath/device/inode是独立冻结数据，requested必须等于canonical；首版不接alias、盘根、full-access无grant或不同grant的目标。原device须safe integer且0..uint32，inode须safe positive integer，之后才转bigint；不能用Number(nativeIno)舍入比较，也不能以新stat补旧grant。真实夹具若原inode不精确，保留实际拒绝，不换目录重试找safe值。

每次检查先执行有ctx回调的原policy检查，再无ctx/runtime回调地核原policy身份、原grant对象仍属原槽、四原字段及每条path映射。读取grant字段和additional槽只接受own data property，不执行getter充当纯检查。原字段修改、同sequence对象替换或restoreCheckpoint重新建additional对象，都当次拒绝且恢复不复活；没有公开替换真实private primary对象的接口，primary验证覆盖原字段改变，additional覆盖真实对象替换。

observe用固定static方法，不闭包持controller/state。每条path真实await state.assessTarget后检查原lease，要求canonicalTarget完全一致且assessment.workspace就是原grant；再真实bigint lstat核directory/非symbolic/dev/ino；再realpath(original requested)核原canonical，每个await返回后均检查，结束再检查。源内容、receipt和native HANDLE均未接。同步assertCurrent只核身份；prepare一次，renew每次重做原paths/原grant的FS观察，绝不换baseline。真实观察之间仍可能发生文件系统变化，这不是锁或后续消费许可。

### 54.2 所有权、预算和失败

状态new→observing→ready；任一检查失败、重入、撤销或dispose后均单调失活，重复prepare/并发renew拒绝。原throw undefined/null/0用独立failed标志保存。pending撤销只清逻辑引用，原static observe及run临时强借issuer/ctx/grant/binding/path表直到确切I/O结算，迟到结果不发布；不能把pending中的diagnostics清零说成所有在途临时引用已释放。正常释放固定原policy一次，清自有弱refs/函数/binding/path引用。外部原Error或调用方保留输出不在全释放结论中。

路径限1–34、每项4096字符、合计8192字符；重复/相对/NUL拒绝。本阶段只1个原grant，requested/canonical各≤4096字符，共≤8192字符，保存两number与两bigint；policy另记cwd≤4096/session≤64字符。Controller预先冻结targets一份，初次异步期间保留；policy冻结路径表一份，lease仅借同一表，无第三保留副本。renew借原表不重建grant；同步选路短暂记录及Node内部观察分配不冒充零分配。binding getter只返回已冻结primitive数据，外持此对象的寿命归caller，不构成独立授权。以上为结构上限，不是V8精确字节或全部Node元数据I/O计量。

链路为Controller低频新增入口→原路径表/选路→新lease+原policy→固定static observe→state.assessTarget/lstat(bigint)/realpath→每await后原policy/对象/映射核验→ready；renew重复原观察；失败/释放清字段。旧authorizeFileObservation、prepareInputRead、state方法及生产observer/progress/render/terminal/Evidence热方法未改，无对象池，不扩跑生产热路径基准。

### 54.3 唯一八组与资源门槛（未运行）

①实际Controller+同源新类，caller paths改动不变原表，正常prepare与renew；②unsafe整数、alias、无grant/full-access、路径/字符预算前置拒绝，原safe但错误inode由真实bigint lstat拒绝，data accessor拒绝不调用；③原四字段/真实additional restoreCheckpoint同sequence对象替换/槽映射/跨grant拒绝；④真实assessTarget结果已完成但await未交付时，初次grant/policy/signal与renew的cwd/session/requested变化；⑤pending revoke/dispose结算、原falsy异常；⑥末次ctx回调改变grant、吞重入和issuer失活当次拒绝且恢复不复活；⑦保持ready lease存活，四轮tick/GC核原controller/state/ctx/grant/inputPaths五目标，随后stale拒绝释放；⑧无pending时按原id精确清空work目录，原lease再renew由真实lstat ENOENT拒绝，不重建或刷新grant。全组源码须独立预审/修订复审后才首次运行。

唯一拟命令 `D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-input-workspace-grant.test.mjs`。紧邻核六获审SHA/固定Node与PS7摘要/四旧blob及index外scope。registerHooks仅映射新core和其既有policy internal export到相同源码URL，动态import当前Controller后finally即deregister；既有package其余导出沿用当前环境，不声称全dist重建。无提前导入/编译/探针/冒烟或第二次运行。

单登记mkdtemp根及其work空目录两节点/两路径，无内容叶、rename、链接或恢复重建；真实内容read/receipt/native reader/capture均0，显式fixture open/close0，Node目录元数据I/O不全计量。≤64次prepare+renew请求、≤256次实际assessTarget，在调用前检查再计数；自有JSON≤16KiB，框架输出另计。新lease在构造后、初始async观察开始前登记；Controller在restore前登记，所有pending的受控gate在finally释放，原调用结算后再清理。正常清理work和root分别核原id/类型/真实路径及父关系，用rmdir且各自ENOENT；任何身份/清理未知保留原节点不重试猜路径。最后组删除work是既定清理，不是工程回滚。worker启动/调用差值和pending须0，无VM/VHD/工程访问或执行。

下一阶段先把此固定grant与原source/receipt、原native锚点及授权祖先真实HANDLE绑定，明确所有权和末次纯owner/grant收口，再处理全close后的异步capture/copy消费。§53 prepared及本lease.assertCurrent/冻结binding都不能直接作§52 authorize。显式原snapshot写回/latest缺口、发布/独立cwd/固定工具/离线依赖及真实工程执行提交仍未来；生产/default/旧权限退役关闭，P0待办，§0取消承诺不恢复，额度授权耗尽。

54源码预审A–B修订（仍未运行）：A Controller自己的await lease.prepare返回后，再调用await前固定的原lease.assertCurrent实例函数才发布，失败以固定原dispose清理；core prepare/renew直接返回原run Promise，不增加async转交层。组4保留真实assessment内部六支等待，另加真实prepare已完成/lease.pending=false但Controller仍等交付的grant改变与revoke两支，要求Controller当次reject、policy只释放1次、全部pending结算，不能混作同一等待证据。B根/work每节点创建和原dev/ino识别后立即登记输出，末报告再留原身份字符串或未识别null；错误仅通过native Error own data descriptor提取有界name64/code128/message640，falsy分别记录，不调用getter/stack/任意toString，非native对象只记类型。清理失败保留原Error作最终失败原因，多错AggregateError保留各原对象；输出仍16KiB，不重试或猜测路径。新增日志getter反例仍在原八组，资源和计数上限不变。

### 54.4 首次唯一八组通过，原输出及两路径独立复核（待记录复核/精确暂存）

审核（十一）A–B同版完整复审后，紧邻核六获审SHA、四旧index blob、index2013/六外2009摘要及固定Node/PS7摘要，首次且唯一执行既定新测试。8pass/0fail、cancelled/skipped/todo0、678.9659ms；原commandExecution `exec-4b16f0cf-9441-4bf5-9504-5847e7600ebc`（工作turn `01a19a9a-f357-7d22-8221-4e9624fe14d0`）实际completed/exit0、工具1055ms、output.truncated=false；chunkefb9ae/wall1.0554931s直接退出，无工具session。原完整输出3637UTF8B，11条自有JSON含各LF共2588B，审核直接read_thread独立计算一致。无独立stderr计量，时间含启动，不是性能改善证据。

执行后三源码/测试保持获审SHA：core0CDD8818402A02D995C197BAEDC8A29D8243005C0EA33FC88297E34BBD64BD28；controller3B77A490FBC5F552848F662A09142218F6DDF29162CFD6847E99D709B788321F；test6912352D3955DD2FCA4551EA183319E008A771E470DF2CBB741FB7EF6D430DEA。没有提前导入/编译/探针/冒烟、第二次运行或旧矩阵重跑，旧生产方法未改。

唯一root `C:/Users/Administrator/AppData/Local/Temp/sp-workspace-grant-I720KY` 原dev3637606815/ino3659174697854282，其work子目录原dev3637606815/ino2251799814301003。两节点创建/识别即输出原路径及身份，最终created/identified/removeAttempted/removed全部true，safe=true/errors=[]。work按原id完成既定rmdir后，尚持原lease的renew因真实lstat ENOENT拒绝；未重建目录或grant。root随后按原id清理，原测试两路径各自Node ENOENT；审核另以固定PS7各得PathNotFound/ObjectNotFound（chunk788723），不混记为第二次Node运行。无本项实际目录、工具会话或恢复责任遗留。

42次prepare+renew请求（含前置拒绝）/33次真实assessTarget；26个构造成功且在初始async观察前登记的lease最终live0/pending0/hosts0，不能把请求数当实际FS观察次数。内容文件/内容bytes/receipt签发/native reader/capture/显式fixture open-close均0；worker启动/调用差值及pending0。Node隐式元数据I/O、全进程句柄数和全部V8分配未全计量，未扩推这些零值。

同源新class、caller paths改动不影响原表、正常renew仍原binding通过。七次prepare前置拒绝的实际assessment增量0；原safe但错误inode由真实bigint lstat拒绝一次；grant和Error.message的accessor均未调用。真实additional restoreCheckpoint同sequence对象替换、原四字段与路径映射改变，及恢复后的持续拒绝通过。内部assessment-await六支与真实prepare完成后Controller await尚未交付的迟到grant/revoke两支分别通过；后两原policy只释放1次、pending结算0。pending revoke/dispose、原throw undefined/null/0保留、末次ctx callback1改grant及吞重入均当次拒绝，恢复不复活。

保持ready lease wrapper存活，四轮tick/GC后原controller/state/ctx/grant/inputPaths五指定目标live0；随后stale检查拒绝，弱refs/path/grant/metadata全0、observer/verifier清除、policyDisposals1。该结论不外推任意外持原Error或binding副本、所有内部分配。输出数据从来不是独立授权，后续必须由实际原owner约束其来源和寿命。

原结果/两路径获审后，仅在410130/112384/650486B获审前缀之后追加三结果记录；六文件待记录复核与精确stage。当前只完成原grant固定与真实FS观察基础，未接source/receipt/native祖先HANDLE、capture/copy或原snapshot写回。下一阶段先原grant→source/receipt→真实native祖先绑定，再关闭后异步消费；生产/default/旧权限退役关闭，P0待办，发布/独立cwd/固定工具/离线依赖/真实执行提交及§0/额度边界保持。

## 55. 原SessionFiles授权来源与原生授权祖先绑定（源码待审，尚未运行）

§54及最终交接完整闭合后，工作/审核（十二）冻结八scope：input-workspace-grant-lease.ts仅新增低频纯assertGrantIdentity；SessionFiles仅import及pinInputWorkspacePermission；新增core/files/session-input-workspace-permission.ts、acceptance/windows-sandbox-workspace-source-reader.mjs及tests/windows-sandbox-workspace-source-reader.test.mjs；本方案、契约与主方案三记录追加。Controller、旧§53/source/preparation、原reader/native与§52capture均不改。当前不是全close后capture/copy或发布接线。

初始index2015/八scope外2010行SHA256 27B8645EE0D70CEDE6C910A20D9BE385D52821D3BDBEE3D56C13C8AE3FC97DF7；算法同§54。旧五blob：grant7d58eeb235c9f2c159fafcbbc6e90c2dce59515e、SessionFiles02f86d0bad94afea2fc8da3b816239f43b93a0ae、固定a65493b54eb282f79fc363cf760572c42f2eb856、契约32f5d08c7ab6b995ea0689f340e6450c325792f3、主28646a8a3ae6934c958bb6bba7ee32cff21b2cba。三记录原前缀413949/113472/651343B保持；原九删除/唯一patch不动。不commit/push/reset/clean/广泛stage或重跑§47–54/旧矩阵。

### 55.1 来源、时序和读权限边界

WindowsWorkspaceSourceReader只收input/anchor/原SessionFiles/ctx（可选ops明确只作模型），不收caller grant/binding/lease/source。固定SessionFiles原prototype方法取得专用source及新permission，必须原service与明确支持prepareInputWorkspaceRead的原compatibility boundary；不getService、不补receipt。新bridge弱借owner/service/ctx/source/boundary与可选signal，另pin原cwd/session/signal含undefined；捕获安装边界的原方法，直接调用真实Controller既有prepareInputWorkspaceRead获得grant。constructor/instanceof只是防类型误用，不是签发认证；可信宿主安装边界不是恶意同进程隔离。

canonical input首次await前一次固定，OriginalInputRevisionLease绑定原receipt及其Buffer成员，专用source由新wrapper独占，permission仅弱借。bridge.prepare(checkOriginal)的固定同步callback只在本次pending局部借用，await前及返回后立即检查原receipt/source，随后ctx/grant检查；末次checkOriginal之后pure owner+grant收口才return。外wrapper自己的await返回也先原receipt/source检查，最后同一纯收口；不以外层检查冒充桥内检查。pending revoke/dispose不取消原I/O，迟到grant固定dispose一次，原falsy错误保留。prepare结果仅表示准备，不是独立内容或未来copy权限。

同步guard为原lease→permission(原source/ctx/grant)→原lease→pure owner+grant，纯尾部之后不再调用ctx/runtime/receipt。新assertGrantIdentity只复用原grant/policy身份与路径映射，绝非FS续验。真实内容依赖下一段的实际HANDLE链绑定。ready以后原source/receipt/grant变动当次拒绝、恢复不复活；不latest/refresh/新receipt补原基线。

### 55.2 原生接点、请求切片与Unknown

native延后到initialize创建。constructor仅以inert ops校验原reader schema/预算，无native绑定或HANDLE。原grant的safe uint32 device/safe positive inode由§54精确转bigint；requested===canonical，sourceRoot必须等于grant或是其完整组件后代，同drive/dev，单grant覆盖所有固定paths。不能startswith混淆work/workspace，不能alias/跨drive/dev。

私有GrantOperations只借原reader已登记slot，在其dosPath精确命中授权目录时核已有expected（如有）必须同原dev/ino，再放原精确identity；恰一次命中方可leaf open/read。原reader随后inspect真实目录HANDLE；失败不下降内容，不由新stat补旧grant。adapter无slot/HANDLE/token/buffer保留，不新建close责任。真实ops固定WindowsSourceNative原prototype；模型另列。业务volume/open/inspect/read前后同guard，close/dispose不受失效业务guard阻断；原reader仍独占slot、close attempt、unknown责任。

外read在底层成功返回后再guard，若后置失败必须先清本次实际借用请求区再cleanup；旧reader.catch无法清已成功返回的数据。底层也失败时两层可能重叠清零，分别计数，不虚增独立擦除字节；历史成功交付caller的bytes归caller，不声称撤回。无私有capture/copy或发布接口。busy/pending/guard回调内revoke/reentry只失活，由展开调用收尾，不能回调内抢先close。

settle末次原reader验证并全close后仍guard，成功释放source/lease/permission/canonical/reader/ops。最后guard失败保留原错并释放已明确关闭资源。关闭未知或activeHandles0但ops.dispose抛均保留原reader/operations/slots/attempt/errors/canonical，不重复原close/dispose；普通GC结论不外推Unknown。新wrapper只清自己资源，不释放外SessionFiles，也不共享§53私有source给§52。

### 55.3 唯一八组、预算及执行门槛（未运行）

1. 两个真实reader：sourceRoot=work；真实restore(work)同级grant与restore(root)祖先grant分别读取5B，后者installed read相对work/source.txt。caller input改变不能换固定canonical，两次串行全关。
2. 缺service/boundary/明确能力、错误原receipt/namespace及caller自造descriptor前置拒绝，不native。
3. 真实prepare完成后未交付与真实assessment内部gate；原ctx/owner改变、原receipt forget、pending revoke/dispose均拒绝，桥与外层原await分别复查，不重签。
4. 显式模型grant HANDLE inode/sourceRoot身份错、旧expected冲突、drive/dev/组件关联前置拒绝，拒绝前无内容read。
5. 第三个真实reader底层成功5B后外层失效；模型owner/grant失效、sentinel切片及历史成功caller bytes责任，临时原reader.read观察包装保留原实现且finally恢复。
6. 模型busy吞reentry/revoke及undefined/null/0，清请求区后一次展开收尾；另原receipt末次第四次sha256观察改变owner/grant，纯尾核当次拒绝，恢复不复活，无native。
7. 模型partial/pending/close/active0 dispose Unknown；保留原slot/error/ops，重复dispose不增加调用，不当实际HANDLE失败。
8. 保持prepare-ready wrapper活，四轮tick/GC核owner/runtime/executionBoundary/ctx/revisions/receipt/bytes/controller/state/grant/input十一目标，stale拒绝后自有引用释放；按原身份清理全部实际节点。

唯一拟命令 D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-workspace-source-reader.test.mjs。完整源码/同版修订复审后才首次运行，紧邻核八SHA、五旧blob、index外scope、固定PS7/Node/Koffi摘要。只映射grant与旧policy两个internal到相同源码URL，Controller动态import后finally deregister；不声称全dist重建。无提前导入/编译/探针/冒烟或第二轮。

单mkdtemp root/work/source.txt三节点、5B，创建即记录路径、识别即记录dev/ino；fixture显式1open/1close attempt/1close，1bootstrap volume查询无HANDLE。真实reader恰3、内容总≤15B；单reader同时82HANDLE/256open尝试/8192业务native/4096readCalls，串行同时峰≤82，三reader累计尝试及成功获取≤768、业务≤24576+bootstrap1、readCalls≤12288。每slot close最多一次，实际获取/关闭/峰值分列，不把82当累计open。scratch每reader2264B，三reader+bootstrap累计9056B、串行峰2264B。原authority每副本32KiB、reader tree64KiB、单源4KiB/总16KiB保持；wrapper/core另保留原canonical与有界paths，metadata及Node隐式I/O不冒充V8精确分配/全OS句柄计量。adapter无大scratch或池。

≤12兼容签发/60逻辑B、wrapper0签发；≤64真实prepare请求/256assessment；≤24模型reader（无OS HANDLE），自有JSON24KiB、框架另计。grant真实数值若不精确保留拒绝，不换目录重试。所有wrapper/host在操作前登记，gate各finally释放，pending原调用结算后才按每节点原id/类型/canonical/父关系精确unlink/rmdir并各ENOENT。未知立即禁止后续实际获取，保留原责任不猜关/重建；错误日志只own data有界name64/code128/message640，不getter/stack/任意toString，失败仍交原Error/falsy。worker启动/调用差值和pending要求0，无VM/VHD/工程执行。

### 55.4 性能及后续边界

审计链为固定SessionFiles pin→新weak桥→原Controller grant准备→原receipt/source及pure尾核→新grant-aware ops→原reader/native逐组件/open/inspect/read→outer slice cleanup或settle全close→释放。仅低频acceptance新方法，旧热方法逐字未改；新增callback每owner固定，sync native业务guard会有有界校验临时对象/路径选路、旧source diagnostics分配，不能宣称零分配/提速，无对象池、不扩跑生产热路径基准。结构计数和四轮指定目标GC只支持本边界。

本项不接§52 authorize/capture/copy；全close后async消费、一次source转移和安全固定元数据发布另审。显式原snapshot写回/latest缺口、发布/隔离cwd/固定工具/离线依赖/真实工程执行提交仍未来；生产/default/旧权限退役关闭，P0待办，§0取消承诺不恢复，额度授权耗尽。

2026-11-02用户纠正换窗约定：用户没有要求每阶段完成就新建/归档工作与审核窗口；原意仅为上下文已经很大，例如连续几十轮输入后，才考虑换窗。此前逐阶段换窗的交接说法为助手误传，立即废止。当前工作/审核（十二）继续使用，阶段完成不触发新建/归档。仅纠正当前交接和此项记录，不改变既有验证事实；本次文档更正把当前交接文件作为第九个精确scope，源码/测试不变，仍待同版预审后运行。

55源码预审A–C修订（尚未运行）：A实际reader在initialize前以ownerId登记，末报告逐owner保留partial/Unknown的缺失诊断项、状态、原slot HANDLE/status/information/path/attempt/closeable/error，以及原operation/cleanup错误；缺失计数显式列出，不先解引用缺失reader或执行成功断言。先完整输出资源责任和有界own-data错误，再抛原清理错误/做成功断言，不以active0掩盖dispose未知。B第3组保留原Controller/assessment七支，另单独gate真实SessionInputWorkspacePermission.prepare已ready/pending=false、wrapper await尚未交付的grant/owner/receipt三支；迟到拒绝，grantDisposals及其policyDisposals各1，pending结算。C第7组新增两个模型：ops.dispose成功时改变owner/grant，所有close/dispose成功后最后guard拒绝，cleanup complete、原错误保留、自有资源释放、重复dispose不增加调用，与四个Unknown分开。仍原八组/三真实reader/≤24模型/12签发等预算，不重跑既有组。源码实现四文件SHA保持首审值；仅test及三记录修订，交接仅用户换窗纠正。当前精确scope为原八文件加交接文档共九文件，不因阶段完成新建或归档。

### 55.5 首次唯一运行在原grant精度门槛拒绝（未验收；不重跑）

A–C同版源码复审通过后，紧邻核九SHA、六旧blob、index2015/九外2009 SHA58B5B23D38A50FAA7AFF8F0A06BE8E385BCC87056ABFB85770034378E0B1ACC5及固定PS7/Node/Koffi摘要（chunk7ab438）均通过。首次唯一命令原commandExecution exec-b43637ed-6a74-4cdb-9762-07701f72263d，chunk96b828，实际exit1/工具788ms（wall0.7880327s），无工具session。完整原输出15667UTF8B、7条JSON含各LF共2314B，审核直接读取原工具输出独立计算一致且确认未截断；没有独立stderr字节计量。

八个业务组中仅第2组前置拒绝通过，其余七组失败；第3组在gate之前因原grant拒绝结束。after在完整资源报告之后因realReaders实际0、预期3而新增一项失败，框架tests9/pass1/fail8、cancelled/skipped/todo0、696.4559ms。不是8组通过，不把安全拒绝等同于绑定功能验收。不得据此次结果声称真实授权目录HANDLE绑定、外层迟到失效、post-read清零、Unknown模型或GC目标通过，以上目标均未进入。

根C:/Users/Administrator/AppData/Local/Temp/sp-workspace-source-38nJlw原dev3637606815/ino10977524092331301，work子目录同dev/ino11821949022463271；两inode均大于Number.MAX_SAFE_INTEGER=9007199254740991。source.txt同dev/ino5348024558118191。原permission-state.workspaceGrant在签发时使用number版lstat，原grant未保留精确bigint；实际调用栈在freezeInputWorkspaceBinding的safe integer门槛拒绝，真实assessment前就停止。此为已冻结拒绝条件的实际触发，不能用后续stat补原基线、舍入比较、换目录重试或重跑§55。

三节点创建/识别/删除尝试/删除完成均记录true，safe=true/errors=[]；测试逐节点按原id、类型、canonical及父关系精确unlink/rmdir后各Node ENOENT，审核固定PS7独立三路径均PathNotFound/ObjectNotFound（命令exit0）。无本项实际资源遗留、实际Unknown或恢复责任。

7prepare请求/0assessment、8登记wrapper最终live0/pending0/hosts0；这些为登记表和在途计数，不是本次未执行的GC结论。真实reader0/模型reader0/原生内容0，fixture1open/1close attempt/1close，兼容签发8次40逻辑B、wrapper签发0；bootstrap卷查询1次、累计scratch分配2264B，源码finally调用dispose，但原输出未单列bootstrap释放计数，不能记作已测释放2264B。worker启动/调用差值及pending0；Node隐式I/O与全部OS句柄/V8分配未全计量。

执行后四实现与test均保持获审SHA，未修改/重跑或启动第二现场。当前§55源码已审但验证失败，结果及记录待复核，生产/默认/权限退役继续关闭。后续独立依赖可研究在全新原grant签发的同一次观察中保留精确身份，并绑定原对象及兼容/恢复语义；不能修复本次已失败的原unsafe grant，也不能把后续新证据改写为§55本次通过。工作/审核（十二）继续使用。

## 56. 全新原workspace grant签发时的精确身份来源（源码待审，尚未运行）

§55首次唯一失败事实及三路径清理已独立复核，九文件全部保持未暂存，失败不改写为通过。本项补其独立前提，不重跑§55/§47–54矩阵，不换目录找safe inode、不以新stat修复已签发的unsafe原grant。工作/审核（十二）继续使用。

本项八scope：permission-state.ts、permission-controller.ts、input-workspace-grant-lease.ts、新tests/windows-sandbox-workspace-grant-identity.test.mjs、四记录。与§55现存未暂存改动并集十二scope；index2015/十二外2007 SHA256 5245C596421A292DA8F12B603673C88FB719F9885CB4E55AC6BF7B2E25336D3D。新纳入旧blob state7839a422772279c8aab5bf9a7c9b9597124d10c3、controller e8b230d5cbed4326058647264cd26d0cc0892cfa；其余沿§55原索引。四记录原前缀428049/117247/653736/22596B保持，仅追加。本项不改§55bridge/SessionFiles/native wrapper/test，旧grantIdentityIsCurrent逐字保持number路径，不顺带改变全部旧授权观察的承诺。

### 56.1 观察、签发、恢复与固定来源

原workspaceGrant拆为observeWorkspace和issueWorkspace。一次原观察仍realpath→lstat，但后者使用bigint；冻结原requested/canonical、legacy Number(dev/ino)及原精确bigint dev/ino。Number转换只维持现有字段/JSON表示，绝不是原生身份的安全比较。首次primary和通过既有重复/容量拒绝检查的新add才issue：创建原四字段grant，并在模块私有WeakMap<原grant,原冻结sidecar>登记此次观察。sidecar不持grant/state，只primitive与冻结identity；对外grant不新增BigInt字段，serialized/parsePersisted/checkpoint/restoreCheckpoint仍只复制原四字段。

已有primary.restore只做比较观察，不签发临时grant、不给旧对象补登记、不替换原grant/sidecar。有原sidecar时既核原四字段未动，也以原精确dev/ino比较本次观察，不能只比较碰撞的number；无sidecar保留原有语义，不升级。checkpoint实际只复制additional，primary原对象保留。持久化恢复和additional克隆无sidecar；进入input精确链时，safe原number可按旧规则，unsafe无原来源继续拒绝。重复add的后续观察也不能给已存在的克隆补发。

state.getIssuedWorkspaceIdentity仅在grant仍为原primary/additional成员时查询原WeakMap；additional有界且own data descriptor查成员，不执行getter。Controller固定原state prototype方法，在首次await前取得原sidecar或undefined，传给lease；每次pure检查要求仍取回同一对象（包含undefined），原grant四字段、原槽、路径映射同时保留原检查，不能途中换来源。

lease以WeakRef(sidecar)+hadIssuance固定来源；binding只复制primitive，不暴露sidecar令牌或强持原sidecar。hadIssuance而原对象不见即单调失效，绝不回退safe-number分支。精确分支核sidecar原四字段一致、own data fields、dev uint32及ino positive uint64；无sidecar分支保持原safe整数门槛。真实来源由state签发/成员查询/Controller路径保证，公开constructor或纯数据sidecar仍不是授权证明。新input链继续在assessment后以原精确bigint做lstat及realpath续验，每await后原检查；不接source/receipt/HANDLE/capture。

### 56.2 分项预算、生命周期与唯一六组

新grant签发请求≤16（首次restore/add，失败也算请求），成功实际签发≤16另计；已有primary.restore比较请求≤8，与签发严格分列；prepare请求≤24、renew请求≤8（合计≤32），真实assessment≤128。门槛均在对应调用前检查并计数。Node内部realpath/lstat总I/O不全计量，不能把请求数称为真实签发数或全部元数据I/O。

sidecar只由WeakMap弱键保留：原grant活时value活，grant退役后ready lease弱pin不延长sidecar寿命；原pending中的强借issuer/grant及其WeakMap值须等确切调用结算。正常release清sidecar WeakRef/had标志、binding/paths及原policy一次。外持sidecar或binding寿命归caller，普通GC不涵盖pending或任意外持对象。

1. 真实Controller restore(work) primary与正常add(root) additional，原精确identity分别匹配两目录；对work实际命中primary、对root实际命中additional，serialized仍number且无identity键，clone查询无来源。
2. 纯边界数据：safe旧路径、unsafe无来源拒绝；同number而不同bigint保持不同；uint32/uint64及字段/accessor拒绝。该组明确仅数据规则，不冒充真实签发。
3. 原additional租约经checkpoint克隆后持续失活，primary原对象不变；duplicate add不能补克隆来源；serialized通过正常新state.restore形成额外primary新签发与无来源additional，unsafe拒绝，实际safe则只旧规则，不假称clone获精确身份。
4. 已有primary三次restore比较保留原grant/sidecar，原字段被检查发现改变后原lease不能恢复；同精确原binding续验不换值。实际FS并未制造两个碰撞inode；同number不同bigint边界在第2组为纯数据证据。
5. Controller固定prototype查询不受实例方法替换影响；原精确prepare/renew、最后ctx回调改grant纯尾核当次拒绝，冻结sidecar不可改；一个真实assessment-await中的revoke结算不迟到发布。
6. 保持ready lease活，四轮tick/GC核controller/state/ctx/grant/sidecar/callerPaths六目标，随后stale拒绝清自有引用。

唯一拟命令D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-workspace-grant-identity.test.mjs。单mkdtemp root及work两空目录，无leaf、rename、link或重建，0内容/receipt/native reader/capture/显式fixture open-close。创建即记录原路径、识别即记录dev/ino；最终在所有pending结算后逐节点核原id/类型/canonical/父关系rmdir并各ENOENT，未知保留责任不重试猜路径。自有JSON16KiB、框架输出另计，有界Error own data日志，保留原Error/falsy；worker启动/调用差值及pending0。真实inode无论safe或unsafe均使用同次原签发精确值，不选择性换目录。

### 56.3 完整链与当前边界

审计低频原授权签发/恢复→原same-observation sidecar→当前state成员查询→Controller首次固定→lease弱来源/原policy纯核→真实assessment与bigint lstat/realpath→结算/清引用；已有grantIdentityIsCurrent数值路径、serialized/parse/checkpoint旧JSON/schema及生产流式hot方法不改。每次新观察增加两个有界冻结数据对象；每成功新签发一个WeakMap项，当前state通常primary1+additional≤16，外部保留旧grant寿命另属caller，不称全局固定条目数。lease每原来源多一个WeakRef与flag，binding复制两个bigint值；无池，不称零分配/提速，不扩跑热基准。

完整源码及修订复审前不导入/编译/探针/测试，不暂存。§56即使限定通过也不能填补§55未取得的native绑定、迟到外层、post-read、Unknown/GC组合证据，后续整合验证须另冻结。生产/default/权限退役关闭，P0待办；全close后async capture/copy、显式原snapshot写回、发布/隔离cwd/固定工具/离线依赖及真实工程执行提交仍未来，§0取消承诺及额度边界不变。

### 56.4 首次唯一六组通过及独立原输出复核（限定前提证据）

源码预审仅要求修正第4/5组反例：不能假定inode+1024必然改变legacy number，改为inode===1?2:1并在检查前assert.notEqual，finally恢复原值；其余源码/测试范围及预算不变。同版复审后获准首次唯一运行，紧邻十二SHA、八旧blob、index2015/外2007及固定PS7/Node摘要预检均通过（chunk9827d5，原commandExecution exec-f1a9b5af-64ac-4ab4-b2d7-60e6077ebe02）。预检OriginalBlobs输出为八个1的属性枚举，实际foreach逐项核完八旧blob，不是只核一项。

唯一原命令exec-15b3df0a-9641-4fba-b270-c4db4d1f9826/chunk4a2361实际completed/exit0，工具767ms（wall0.7671365s），未生成session；框架tests6/pass6/fail0、cancelled/skipped/todo0、duration677.9207ms。完整原输出3400 UTF8B，11条JSON含各LF共2648B，未截断；独立审核直接读取原工具输出重新计算一致，无独立stderr字节计量。未重跑、提前探针或改变获审代码求通过。获审测试20142B/SHA256 AA7B6AA18F14A70F72BAF62E8606A598DFC29A287B60F3092831283D5CB981DD；执行后八个源码/测试文件均仍为同版获审摘要。

单root C:/Users/Administrator/AppData/Local/Temp/sp-grant-identity-29sE33原dev3637606815/ino45317471250693804，work同dev/ino10133099162199356；两者legacySafe=false。真实primary(work)/additional(root)首次签发保留精确bigint并命中对应原目录；无换目录寻找safe值。serialized仍旧数字字段、无identity；克隆/持久化additional无来源，实际unsafe分支拒绝，重复add未升级。existing-primary三次比较保留原grant/sidecar，检测失效后不复活；固定prototype查询、最后context回调变更拒绝及pending撤销结算通过。同number不同bigint及uint64边界只是第2组纯数据证据，本次未制造真实文件系统inode碰撞，不以此冒充原生HANDLE验证。

分项实测：签发请求9/成功签发8（含一次重复add拒绝），已有primary比较3，prepare9/renew2，assessment9；登记lease7（两次unsafe clone在prepare登记前拒绝），末live/pending/hosts0。第6组ready lease保持活，四轮tick/GC后controller/state/ctx/grant/sidecar/callerPaths六目标live0；其后stale拒绝，weakReferences/grants/paths/grantChars/pathChars归0、observer/verifier清除、originalIssuance=false、policyDisposals1。此为该ready lease生命周期证据，不泛化为全部pending/外持对象GC。

0内容文件/内容B、0receipt/native reader/capture、0显式fixture open/close，worker启动/调用差值及pending0；Node隐式metadata I/O与全部OS句柄/V8分配并未全计量。最终safe=true/errors=[]。两节点created/removeAttempted/removed均true，原调用结算后按原id/类型/canonical/父关系精确rmdir并逐路径Node ENOENT；审核固定PS7独立两路径均PathNotFound/ObjectNotFound。无本项实际资源遗留、实际Unknown或恢复责任。

2026-11-02独立审核已确认原运行、完整输出/字节、分项计数、八源码/test同版及两路径清理。§56只取得精确签发独立前提的限定证据；§55首次失败仍为失败，native绑定、外层迟到、post-read清零、Unknown及组合GC仍未取得整合通过证据，后续须另冻结，不能回填或重跑旧矩阵。

### 56.5 本轮记录与精确暂存边界

四记录仅在获审§56源码稿之后追加本次真实结果，原§55失败和已有文档前缀保持。本轮统一范围仍为十二路径：§55的grant lease、session-input-workspace-permission、SessionFiles、workspace-source-reader实现/test及四文档，再加§56的permission-state、permission-controller、新workspace-grant-identity test。记录与此范围复核通过后，才由工作窗口对这十二路径一次精确git add；不使用全量暂存。预计index2015→2019，范围外仍2007条/原SHA5245C596421A292DA8F12B603673C88FB719F9885CB4E55AC6BF7B2E25336D3D。实际闭环以独立暂存后同版复核为准，不在本段预称已暂存。

原九项文档删除和super-pi-clipboard-fix.patch继续原状，不提交/推送/PR。当前工作与审核（十二）继续使用，不因阶段结束新建/归档；生产/default/权限退役、§0/P0及额度边界保持关闭或待办。

## 57. 原精确签发下此前未到达的读取组合（源码待审，未运行）

用户明确要求继续完成剩余任务。§56已完成唯一6/0、结果/记录及十二路径精确暂存后独立复核（审核chunk edd753/exit0）；index2019，§56十二外2007摘要保持。当前依赖为新精确签发下的读取组合；保留§55首次失败及原测试文件，不重新运行旧矩阵，不将后续证据回填为旧运行成功。工作/审核（十二）继续，不因阶段结束换窗。

本项五路径：新增tests/windows-sandbox-issued-workspace-source.test.mjs，追加本固定方案/契约/主方案/交接四记录。既有八个源码与测试保持§56获审已暂存版本，不改变production/native实现。五范围外2015条stage SHA256 EDBBCCDFAA9881549691A3A8B6480BC94D5BE9FF814F37700206B76C12C58F25，四文档原blob分别1b1b1cbf9636ade3d82cc4555873464980512963、bd552372d83f0d853ef20fb0e746785aa801e124、3325974c20c26ed7f969b1e3aec64ce002de8e5d、fe5a7e6ab0ee812b4742584f4b90b48dcd80ab55。原九删除及patch保持。

### 57.1 新路径与五组范围

真实Controller.restore产生原grant，固定SessionPermissionState.prototype.getIssuedWorkspaceIdentity核原sidecar冻结且精确身份等于本次登记root或work，不接受caller descriptor代替来源。经过既有SessionFiles原boundary/source/receipt→weak permission→Controller→grant-aware adapter→原native reader，全grant目录命中恰一次才读取。inode实际safe/unsafe均接纳同次精确来源，不强求unsafe或换目录。所有legacy number变更用original===1?2:1并先assert.notEqual、finally恢复，避免unsafe number加1无变化。

| 新组 | 正常完成时host/原grant/receipt各自次数 | prepare / assessment预期 | 真实reader / 模型reader | 真实内容B / 模型内容B |
| - | - | - | - | - |
| 1 原sourceRoot及ancestor实际绑定 | 各2 | 2 / 4 | 2 / 0 | 10 / 0 |
| 2 async与末次receipt回调 | 各2 | 7 / 13 | 0 / 0 | 0 / 0 |
| 3 底层read已成功而外层拒绝 | 各1 | 2 / 4 | 1 / 1 | 5 / 4 |
| 4 identity/busy/Unknown/全关后拒绝 | 各1 | 10 / 20 | 0 / 10 | 0 / 24 |
| 5 prepared组合GC | 各1 | 1 / 2 | 0 / 0 | 0 / 0 |
| 合计（预期，非实测） | 各7，receipt逻辑35B | 22 / 43 | 3 / 11 | 15 / 28 |

第2组保留真实assessment原调用await和Controller返回原grant后两关，另三个bridge已ready/pending=false而wrapper pending=true的owner/grant/receipt关，gate用实际到达信号，finally释放。两个末次receipt getter在第4次访问改变owner/grant，验证同次拒绝、无reader/ops分配、恢复后仍拒绝；不把更早失败当成达到注入点。第3组保留底层成功返回的count及固定5B内容观测，外层拒绝后本次切片清零、外哨兵不变、底层清零计数0；模型另核历史已成功交付的2B不被撤回。read循环要求正整数进展且不越剩余长度，失败清测试借用buffer。

第4组两个identity模型均在内容前拒绝；两个busy重入/撤销模型在原栈展开前closeCalls0。四Unknown分别为partial初始化、pending slot、close失败、active0但dispose失败，保留原token/handle/status/information/path/尝试及falsy错误；重复dispose不重试。全close/dispose成功后owner/grant最后guard拒绝的两个分支为rejected+cleanup complete，另核，不混为Unknown。模型没有OS HANDLE/scratch。第5组保持prepared wrapper活，先退出强持原对象作用域，四轮tick/GC核owner/runtime/boundary/ctx/revisions/receipt/receipt.bytes/controller/state/grant/sidecar/caller input十二目标，随后stale拒绝且native未初始化。只覆盖该prepared状态，不外推Unknown/pending或外持对象。

### 57.2 硬预算、责任及唯一执行约束

一个mkdtemp root/work/source.txt三节点、固定5B，不遍历工程、不换目录找数值。host请求≤12、成功原grant签发≤12、receipt签发≤12（≤60逻辑B）分别计数且获取前设限；prepare≤40、assessment≤128。真实reader恰3，各只读同一个5B叶：底层合计15B，外层成功交付10B、第三次外层拒绝并清5B；模型≤12、全部模型read≤64B且每次写借用buffer前检查，预期28B另列。真实reader在initialize前登记owner，发生实际Unknown立即停止后续获取，保留原reader/ops/slot/error，不重试关闭，不因局部计数0声明释放。

单真实reader原上限峰82 HANDLE/256open尝试/8192业务native/4096readCalls，三reader串行，累计尝试≤768、业务≤24576另bootstrap1；最终按owner分别报opened/closeAttempts/closed/peak与未决slot。bootstrap及每reader各scratch2264B、累计9056B，allocated/released/retained均从各自实际diagnostics分列；bootstrap dispose失败保留原对象及原错误、不重试。测试显式fixture1open/1close attempt/1close单列。Node隐式metadata I/O/全部OS句柄/V8分配未全计量。

JSON24KiB，框架另计；有界Error own-data日志不调用任意getter/stack/toString，falsy原错误保留。最终先输出全部实际owner、缺失诊断、计数、bootstrap责任及错误，再做成功断言；模型Unknown与实际未知分列。所有pending原调用结算后，以逐节点创建时登记的dev/ino、类型、canonical和父关系精确unlink/rmdir，各Node ENOENT；失败不猜路径/重复删除。worker启动/调用差值及pending预期0，无VM/VHD或真实工程执行。

唯一拟命令D:/Nodes/26.13.0/node.exe --expose-gc --test --test-concurrency=1 tests/windows-sandbox-issued-workspace-source.test.mjs。完整源码预审通过后，紧邻核五SHA、四旧blob、八既有源码/test及固定PS7/Node/Koffi摘要、范围外index才运行一次；此前不导入/编译/探针。当前尚未运行/暂存。只增加低频有界验收，无生产hot变更/池，不扩跑分配基准。

后续仍继续：原native绑定后接全close的async capture/copy与安全元数据发布；原snapshot显式写回；真实隔离执行/候选消费/宿主应用变更；P0与默认/退役最终验收。完成§57不等于完成用户剩余任务，生产/default/旧权限退役不因本项自行放行，§0已取消承诺与既有额度边界保留。

### 57.3 首次唯一五组通过，原输出与清理独立复核完成

完整源码预审通过后，紧邻预检chunk8c8b87核五文件SHA/四旧blob、八冻结源码test、PS7/Node/Koffi摘要、index2019/外2015全部一致。原唯一commandExecution exec-af01e0d9-521d-43d1-bd4a-6feed5e827e9，chunk21ae52，actual completed/exit0，无session；框架5pass/0fail，cancelled/skipped/todo0，868.9968ms，工具wall0.9970489s。完整原输出14227UTF8B、20JSON含各LF13552B，审核直接读取原输出独立计算一致、确认未截断；无独立stderr计量，不把时间作为优化证据。测试保持获审38669B/SHA C98F678BD88C9C3D04EACCC5FF5B4E7FE5384677C900E2DA723250F3B2A47F06，未重跑。

真实root C:/Users/Administrator/AppData/Local/Temp/sp-issued-workspace-WoVcPT dev3637606815/ino26740122787512947，work同dev/ino3096224744434386，work/source.txt同dev/ino1407374884170451。sourceRoot grant legacySafe=true、ancestor=false，均由原Controller首次签发精确sidecar匹配本次登记目录，真实grant目录各命中1，不挑数值。三节点created/removeAttempted/removed均true，原id/type/canonical/父关系核对后各Node ENOENT；审核PS7独立三路径均PathNotFound/ObjectNotFound（chunk5830e9/exit0）。safe=true/errors=[]，无本项实际遗留或恢复责任。

实测host请求/原grant签发/receipt签发各7，receipt逻辑35B、wrapper签发0；prepare22/assessment43，登记wrapper22，末live/pending/hosts0。三真实reader底层15B（各5），外层成功交付10B、第三次成功底层返回alpha/5后外层原grant拒绝并清本次5B，切片外哨兵保留，原reader清零计数0。模型历史成功2B未被后续拒绝撤回。实际opened/closeAttempts/closed均29（10+10+9），串行峰9，active0/unresolved[]；业务native701+701+424=1826另bootstrap1，真实readCalls3。各reader及bootstrap scratch allocated/released均2264B、retained0，总9056/9056，bootstrapRetained=false。所有missing诊断和missingCounters均空。

模型11/read28B；两个identity内容前拒绝、两个busy栈内未close、partial/pending/close/dispose四Unknown保留原责任且重复dispose不重试；这些不是实际OS遗留。两个全关成功后的owner/grant变更为普通rejected+cleanup complete。四轮GC十二目标（含原sidecar）live0，prepared wrapper仍活，随后stale拒绝且无native初始化，引用释放；不外推至Unknown/pending或任意外持对象。worker启动/调用差值和pending0，fixture1open/1close attempt/1close，无VM/VHD/工程执行；Node隐式I/O、所有OS句柄/V8分配未全计量。

独立审核确认原输出、分项计数、三路径清理、五获审文件/八冻结源码test及十二旧stage对象未变。记录为§57新组合通过，§55首次失败保持原事实。四结果记录追加后只对本项新test+四文档五路径复核并一次精确暂存，预计index2019→2020、五范围外2015/原摘要不变；是否闭环以独立暂存后复核为准，此处不预称已暂存。原九删除/patch保持，不commit/push/PR。

### 57.4 后续执行顺序继续

读取组合取得限定证据后，继续同一个原source/receipt/grant的全close后async续验、私有捕获/一次复制及固定元数据发布；继而补显式原snapshot写回、真实隔离执行/候选消费/宿主应用变更、P0与最终切换验收。本轮五组并未实现这些后续能力。工作/审核（十二）继续，不按阶段换窗；生产/default/旧权限退役不自动放行，§0取消承诺与已有额度边界保持。

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
