# T12-C：本地package配置条目的实际路径匹配

状态：先行方案已落盘，开始独立复现。T12-B #195最终head 374d3eb2b50fcb2bd86263493660e255d00558f6获得completed/no findings和六CI通过，合并为0cc64d3be615386134c7be8fe3932aa1dba35a2f；两端任务分支已删除，main已同步。本批分支codex/t12c-local-package-identity，只使用Node26。

## 已定位边界

DefaultPackageManager.removeAndPersist先remove再removeSourceFromSettings。local remove只校验scope信任并发送已有progress，不删除本地package目录。当前removeSourceFromSettings.filter对每条配置重新解析同一input；packageSourcesMatch的左右key分别是settings相对scope base（user=agentDir，project=cwd/.sp）与input相对cwd的词法绝对路径。同一目录的Windows大小写和junction别名不能匹配。addSourceToSettings使用同一个匹配函数，必须保持两处一致，避免add新增重复项。

## 最小方案

仅把local匹配key中的已解析路径送入T12-A canonical helper；npm按name、git按host/path的现有键及版本/ref规则保持不变。每次add/remove先计算一次input match key，再由现有findIndex/filter计算各条settings key，去掉重复右侧解析，不增加全局索引、Map缓存、异常吞没或重试。持久化格式仍按原scope保存相对路径，显示路径不改写。已不存在路径保留明确词法相等，不大小写折叠或猜等价。

实际修改前先写失败回归：Windowscase、junction/symlink、不同相对基准、两scope、相似prefix不同目录、缺失路径及大小写敏感不同对象；add已有同身份条目保留已有filters和object字段；remove只删匹配配置、保留其它项目/用户条目和包内文件。拒绝信任的project remove必须在持久化前失败。npm/git匹配回归用removeSourceFromSettings验证，不联网/不执行卸载命令。

## 性能与生命周期

完整链为显式包管理命令→removeAndPersist/addSourceToSettings→scope设置读取→key比较→一次设置写入。不是frame/delta/进度回调路径。1/100/1000条记录的native调用最多N+1（每条existing一次、input一次）；记录input路径调用单独计数，避免因input也作为existing而误判。没有新保留容器，原filter返回数组由SettingsManager持有。已有getGlobal/ProjectSettings会structuredClone，save又持有snapshot直至writeQueue完成；不能漏算这些基线成本。生命周期测试观察SettingsManager实际旧packages数组/对象，在替换并await flush后，保留manager验证回收；不把getter克隆当作持久owner证据。低频findIndex/filter既有闭包不变成每frame工作；无池、不制造热路径承诺。

check/build:offline/Node26全套及相关路径/trust/package回归；独立PR，主动@codex review，发现问题修复推送后再请求审核。最终head审核完成且六CI通过才合并并按精确分支身份清理。

## 实施与已观察证据

初始14项回归10项失败、4项既有语义对照通过；新增add最大扫描计数后共17项本功能测试通过。最小生产变更仅两侧local key消费canonical helper、每条命令预先计算inputKey，并删除只包装左右比较的旧私有函数。没有额外缓存、重试或新异常处理。add保留原配置对象的autoload/资源filter字段，按原scope写相对路径；removeAndPersist只移除配置，包内文件仍存在。

每个user/project scope覆盖真实Windows大小写和junction；配置相对agentDir/cwd/.sp、输入相对cwd的不同基准未混用。相似prefix不同目录、已缺失路径词法相等、实际Windows大小写敏感不同对象、拒绝信任项目和npm版本/git ref原有匹配均通过。远程源匹配测试不联网，也未执行npm/git卸载。

1/100/1000条真实目录记录，add和remove分别验证input解析一次、总native API调用2/101/1001；匹配目标放在末尾，add也完整扫描候选。此处为API次数，不是OS syscall。3个实际旧owner对象（packages数组与两条对象记录）在配置替换并flush后全部回收，SettingsManager/PackageManager继续存活。原设置克隆、快照、writeQueue和filter返回数组仍是基线成本，未宣称零分配或整体提速。

56项路径/trust/package/选择器相关回归通过，check/build:offline通过。最终Node26全套415个执行单元成功，5548项测试：5450通过、98跳过、0失败/取消。最终PR审核CI待完成；结构化证据见`docs/evidence/pi-150-t12c-local-package-identity.json`，原始红绿与计数日志位于`.git/pi150-t12c`。
