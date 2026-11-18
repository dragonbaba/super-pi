# DeepSeek 思考模式的历史回传

DeepSeek 要求在思考模式的请求携带工具时回传各历史轮次的 `reasoning_content`。公共转换会移除不可复用的签名。Chat 适配器原先依赖签名确定回传字段，还会跳过未调用工具的助手消息，导致普通历史轮丢失推理文本、工具调用轮只剩空字段。[DeepSeek 协议](https://api-docs.deepseek.com/guides/thinking_mode/)

修复在 DeepSeek 兼容格式发送工具、开启思考且路由要求回传时，将同模型的明文思考内容写入协议字段。离线回归用 V4 Flash 和 V4 Pro 的真实 provider 和流解码器构造后续请求，核对普通回复、工具调用、工具结果、跨模型历史与无工具请求。签名及标记为不可见的内容不进入这个字段。

运行 `node --import tsx --test tests/deepseek-thinking-history.test.ts tests/azure-foundry.test.ts`。测试覆盖协议正确性，未测 DeepSeek 在线计费。
