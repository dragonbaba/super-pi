# 恢复会话时的模型与本机搜索

第一条对话消息前选择模型和推理级别，再从已有会话记录恢复。原逻辑只看消息数量，按新会话的默认模型启动，并把默认选择追加到记录中。用离线 RPC 夹具复现后，启动 `--session` 和进程内 `switch_session` 都改为恢复已保存的模型和推理级别。夹具验证恢复前后日志字节一致。仅打开和关闭全新会话时仍沿用延迟写盘规则。

显式传入 `--model` 和 `--thinking` 时，会话会记录新选择。夹具在发送首条消息前重新启动，验证两项选择都能恢复。

Windows 已安装的 SearXNG 在启动进程缺少 `SP_SEARXNG_URL` 时无法被发现。扩展现在用安装标记识别本机实例，显式地址优先。安装缺失的夹具保持按需配置。实际 Codemode 调用从未设置地址的进程发现了 `web_search`，启动本机服务，返回 Unreal Fest 的目标资料，并在退出后按会话租约释放服务。

两处变更都发生在会话创建或扩展注册阶段。类型检查、12 包离线构建和 176 项相关测试通过，包含实际 Windows 进程的退出回归。

```text
npm run check
npm run build:offline
node --experimental-strip-types --test tests/session-first-user-persistence.test.ts tests/alpha-session-replacement.test.ts tests/model-resolution-compat.test.ts tests/searxng-web-search.test.ts tests/tool-search-category.test.ts tests/bundled-extensions.test.ts tests/codemode-default-config.test.ts tests/codemode-session.test.ts
```

Windows 进程回归设定 `SP_TEST_WINDOWS_PYTHON` 后运行 `node --experimental-strip-types --test tests/searxng-managed-lifetime.test.mjs`。
