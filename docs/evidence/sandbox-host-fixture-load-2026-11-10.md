# 沙箱输入宿主夹具加载失败（2026-11-10）

## 问题

`scripts/acceptance/windows-sandbox-input-host-fixture.mjs` 在模块加载阶段断言失败，依赖它的三个验收脚本（`windows-sandbox-input-execution-acceptance`、`windows-sandbox-input-writeback-acceptance`、`windows-sandbox-task-acceptance`）因此在动态 import 处中止。

## 复现

用 `node --expose-gc --experimental-strip-types` 直接 import 该文件。先后有两处断言失败：

1. `browserRuntimeResolutions` 期望 1、实际 0：`resource-lifecycle-guard` 自 #274 起不再引入 `chrome-devtools`。
2. `contract.mutationRequestHash` 与源码中的函数不是同一引用：`permission-contract.ts` 经 `@super-pi/coding-agent/internal/files/extension-permissions` 转出，而夹具的源码别名表里没有这一项，解析到了 `dist`。

## 修复

不涉及热路径。

- 解析次数的期望值改为 0（钩子保留，守卫重新引入浏览器管理器时仍会被发现）。
- 别名表补上 `extension-permissions`。

## 验证

修复后模块加载成功并导出 `runInputHostFixture`。夹具主体需要由验收脚本在 Windows Sandbox 会话中驱动，本次没有运行，主体是否还有其他过期点未验证。

## 重跑

```powershell
node --expose-gc --experimental-strip-types -e "import('./scripts/acceptance/windows-sandbox-input-host-fixture.mjs').then(m => console.log(Object.keys(m)))"
```
