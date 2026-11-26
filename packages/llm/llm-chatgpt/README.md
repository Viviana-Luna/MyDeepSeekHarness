# ChatGPT 订阅提供商

MyDSH 自有的 Cordis 模型插件，包名 `@mydsh/llm-chatgpt`，路由为 `chatgpt-subscription`。
使用官方 Sign in with ChatGPT（SIWC）授权与公开 Responses 接口，独立于 pi-ai 和外部 CLI。

## 连接

打开“设置 → ChatGPT 订阅 → 继续使用 ChatGPT”，再打开系统浏览器中的授权页面。
首次注册使用 MyDSH 名称；后续重用签发的客户端 ID 和稳定主机 ID。
回调签发的客户端 ID 会先保存为待完成注册，令牌交换失败后继续复用；身份校验完成前不能调用模型。
授权采用 PKCE，并用 `jose` 校验 ID Token 签名、签发方、客户端、有效期和 nonce。
只有获得订阅用量 scope 才会调用模型；身份登录成功但没有订阅授权时，界面会提示继续授权。

浏览器回调仅在授权期间监听 `127.0.0.1` 的临时端口，路径固定为 `/auth/callback`。
完成、失败、取消、关闭连接页、超时和插件退出都会关闭监听。
桌面内部业务继续走现有 IPC／Typert。

凭据存入 MyDSH 私有文件中的 `llm-chatgpt/account`；主机 ID 存在 `llm-chatgpt/host`。
令牌不传给 renderer，不读取其他客户端凭据，不保留旧 Codex 设备码流程或 backend-api 回退。
断开会尝试撤销远端会话并清除本机令牌，保留注册以便再次登录。
远端撤销未确认时会明确提示；移除本机注册不会删除 ChatGPT 中的应用注册。
首版维护一个账号注册。更换账号时先断开，再移除本机注册并重新连接。

## 模型调用

- 从 `https://api.openai.com/v1/models` 读取当前账号的目录。
- 订阅 OAuth 令牌用于 `https://api.openai.com/v1/responses`，不是 API Key 计费。
- 请求固定为无状态 HTTP/SSE：`store:false`、`stream:true`。
- 请求 JSON 在原始大小校验后以 zstd 压缩传输；压缩不改变模型输入、附件内容或历史，取消后不继续发送。
- 原生推理等级来自目录；默认省略 effort，显式选择不能静默降档。
- 函数工具在 `mydsh` 命名空间内传输和回放，未知命名空间拒绝执行。
- 支持文本和工具往返；目录明确包含 `image` 时开放图片输入。用户附图与工具图片保持顺序和调用归属。
- 图片由现有附件服务核对摘要、类型和尺寸，发送归一化后的真实字节与尺寸说明，不把本地路径当成图片 URL。单次完整请求仍限制为 32 MiB，图片展开前也检查累计 Base64 大小。
- 不接受订阅接口不支持的温度及输出上限等参数。
- 只有完成事件到达才算成功；额度、权限及不支持能力的服务端错误码保留，敏感错误正文不透传。
- 使用自有 ReplayEnvelope 保留加密推理、原生压缩、条目标识与消息阶段；切换账号或模型不重放旧密文。
- 公开 Session 历史与实时帧过滤私有回放，后台日志保留原始记录。
- 凭据刷新串行化，401 最多恢复一次；永久失效清除令牌，网络失败保留原记录。
- 额度、资格、权限、证书和无明确原因的 429 不自动重试；明确的临时传输失败、提前断流、超时及临时服务错误最多重试五次，复用 Agent 的可取消退避，并保留服务端 `Retry-After`。重试当前模型步骤，不重新执行已完成的工具。
- 发送或等待响应、接收响应阶段的错误保留底层原因；未知异常不会一律归入网络重试。对话在恢复期间显示次数、计划时间及上次原因，收到新输出或停止后移除。
- 订阅额度与应用限额在 ChatGPT 设置 → 用量中查看，不推测余额和重置时间。

GPT 编码预设装配独立的 [`@mydsh/compaction-chatgpt`](../../compaction/compaction-chatgpt/README.md)。
提供商支持 `context_management` 的原生压缩条目，下一次请求从最新压缩条目继续；
策略归独立插件管理，原始日志保留，只有同账号同模型会使用对应的私有状态。

首次启用订阅后显示一次用量说明，确认结果随账号注册保存，刷新与重新登录不重复弹出。
尚未取得可验证的剩余额度数据，对话输入区及仪表行不显示额度入口或占位。
设置页保留 `https://chatgpt.com/settings/usage` 用量管理入口。
连接前说明本地身份／令牌存储及发送给 OpenAI 的任务上下文。

## 本机凭据边界

MyDSH 的文件后端拒绝模型文件工具访问私有配置目录，包括解析到该目录的符号链接。
macOS 派生进程额外使用 Seatbelt 拒绝该目录的读写与 Apple Events 转交执行；
原有写入沙箱与 Shell 状态集成保留，完全访问模式也不解除这一保护。
凭据仍由原本的本地文件提供方管理，设置通过受限接口读写。

这不是同一系统用户下所有代码的通用安全沙箱：受信任原生扩展、外部进程、
用户主动放到其他位置的凭据副本以及恶意并发路径替换不属于本包的隔离保证。
Windows 尚未实现同等的子进程读取隔离，不能按 macOS 验收结果宣称通过。

## 验收状态

协议和授权使用合成账号及事件流验证，不装配 pi-ai 也能运行。
单元测试复用现有主路径与关键失败路径；真实 Electron 探针在临时隔离目录验收后自动清理。
用户图片、工具图片、自动压力压缩与完整退出重启已通过合成响应验收；重启后从持久附件恢复图片，未重复已完成的写入。
视觉 Token 未套用未知模型的计费公式，发送前压力读数使用现有估算；服务端 usage 是已完成请求的实际用量依据。
真实订阅账号已完成 `gpt-6-astra`／`xhigh` 的工具往返，终结状态为 `stop`。
真实图片理解、长任务效果、预设对照和 Windows 结果仍需分别确认，不能由协议连通性推断。
上述边界改善凭据安全，不构成 OpenAI 对应用的审核批准或账号不会被停用的保证。

```sh
npm run test -- tests/chatgpt-provider.spec.mjs tests/chatgpt-images.spec.mjs tests/gpt-coding-preset.spec.mjs tests/session-live.spec.ts tests/host-client.spec.ts
npm run typecheck
npm run build
npm run verify:standalone
```

## 协议来源

2026-10-20 核对的官方文档：
[注册与登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、
[账号与会话](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)、
[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、
[接口限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)、
[错误恢复](https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery)。

Responses 基础流解析曾参考 Codex 固定修订 `014489466a1739c2c563cdfe57880c2c7c8680e3`；
当前授权与服务端点以 SIWC 文档为准，开源源码不能替代服务授权。

2026-10-20 真实响应省略了 `Content-Type`，且终结事件的 `output` 为空数组。
缺少类型头时仍按 SSE 解析；正文由完整的 `response.output_item.done` 提交，收到有效 `response.completed` 后才完成。
终结事件提供非空输出时继续核对一致性；缺少完成事件、条目未完成或流中报错仍拒绝成功。
