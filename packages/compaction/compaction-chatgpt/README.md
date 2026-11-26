# ChatGPT 原生上下文压缩

`@mydsh/compaction-chatgpt` 是 ChatGPT 与标准模式等带自动压缩预设共用的 Cordis 插件。
在普通 Responses 请求中设置 `context_management`，默认阈值为模型上下文窗口的 80%。
它不依赖 pi-ai、外部 Codex 或其他客户端凭据。

## 行为

- ChatGPT 路由使用服务端原生压缩，不再抢先执行通用自动摘要。
- 其他提供方沿用既有压缩策略。
- 提供商只在完整响应成功后保存原生压缩条目及其在输出中的位置。
- 加密内容进入 Session 的私有回放状态，不进入可见消息、桌面历史或实时事件。
- 后续同账号、同模型请求从最新压缩条目继续；原始会话日志保留，切换目标不重放旧密文。
- 插件卸载释放当前会话的自动压缩策略；已经持久化的压缩状态仍可恢复。
- 压缩策略跟随本步选择的提供方，不切换用户的预设、模型或账号；其他提供方保留原摘要参数和手动压缩行为。
- 原生压缩后的请求占用等待后续成功请求重新报告，本地历史估算另行展示，不用创建检查点时的输入用量充当压缩后读数。
- 若服务端在压缩前拒绝超长输入，本轮停止，重新打开同一会话也不重复发送已被拒绝的历史。原始日志和工具结果保留；用户需新建会话并明确携带必要上下文，不静默截断。

原生自动压缩与独立的 `POST /v1/responses/compact` 是两种调用方式。
2026-10-20 使用 MyDSH 自身 SIWC 授权验证时，独立端点返回 HTTP 401、
`hardened_oauth_rule_missing`。正常 Responses 请求的自动原生压缩及后续回放均成功。
所以当前 ChatGPT 路由的 `/compact` 明确提示不支持手动压缩；不切换私有端点，
不把普通文本摘要伪装成原生结果。

## 验收边界

真实接口已用合成历史触发原生压缩，并在后续请求保留测试标识及待办。
这证明当前账号和模型上的调用与回放能力，不代表全部账号、模型或长任务质量均已验收。
订阅剩余额度是另一项接口能力；Responses 的 token 用量不能换算成剩余额度。
隔离测试覆盖约 395K 输入的检查点回放与服务端拒绝路径，但不能证明任意已经超窗的旧会话都可被真实服务端救回。

## 与 Codex 的差异

2026-10-21 对照 Codex 修订 `ab6095dde0040bb8cdf8592acb89c344e5f27a56` 的
Responses Compaction V2 路径。Codex 还存在受功能开关控制的其他路径，
下表不代表所有版本或配置。

| 项目 | MyDSH 当前实现 | Codex 对照实现 |
| --- | --- | --- |
| 压缩状态 | OpenAI 返回的加密 `compaction` 条目 | 同样消费加密 `compaction` 条目 |
| 触发 | 正常 Responses 请求设置 `context_management`，阈值为模型窗口 80% | 客户端根据模型与配置判断时机，显式发送 `compaction_trigger` |
| 原文保留 | 请求从最新压缩条目继续；完整原文仅留在本地日志 | 筛选用户消息等原文，在 64,000 token 预算内优先保留较新的内容，再加入压缩条目；部分保留行为受功能开关控制 |
| 压缩后上下文 | 保持当前系统指令，回放压缩条目及之后的输出、新消息 | 另有初始上下文与环境状态的重建、合并及安装流程 |
| 超窗和调度 | 未实现 Codex 的专用超窗预处理或后台候选压缩 | 压缩请求前可裁剪工具历史；支持受功能开关控制的后台压缩与候选安装 |
| 手动压缩 | 当前明确提示不支持 | 支持 `/compact` |

两者使用同类原生状态格式，但客户端策略不同。公开资料不能证明服务端的内部压缩模型、
提示词或算法完全相同，也不能据此推断 MyDSH 的长任务质量等同 Codex。
Codex 保留近期原文，意味着部分精确约束在压缩后仍直接可读；MyDSH 对压缩前信息的继续使用
主要依赖加密条目。这是需要长任务验证的实际差异，不应把本地保留完整日志等同于模型仍能读取原文。

源码依据：
[触发请求](https://github.com/openai/codex/blob/ab6095dde0040bb8cdf8592acb89c344e5f27a56/codex-rs/core/src/compact_remote_v2_attempt.rs#L167)、
[原文保留](https://github.com/openai/codex/blob/ab6095dde0040bb8cdf8592acb89c344e5f27a56/codex-rs/core/src/compact_remote_v2.rs#L480)、
[上下文安装](https://github.com/openai/codex/blob/ab6095dde0040bb8cdf8592acb89c344e5f27a56/codex-rs/core/src/compact_remote_v2_installation.rs#L192)、
[触发条件](https://github.com/openai/codex/blob/ab6095dde0040bb8cdf8592acb89c344e5f27a56/codex-rs/core/src/session/context_window.rs#L58)。

### 合成信息保留对照

2026-10-21，使用 MyDSH 自身 SIWC 授权、`gpt-6-astra`，按 MyDSH 相同的
`context_management` 与最新压缩条目回放规则，比较完整历史与原生压缩后的回答。
测试降低触发阈值至 1,024 tokens，生产预设的 80% 阈值未改动。
样例包含合成诊断日志、工具调用及返回、初始约束和后续修正，没有发送用户项目内容。

| 检查 | 完整历史 | 原生压缩后 |
| --- | --- | --- |
| 项目标识、文件路径、区域、修正后的端口、只读权限、表名、行数、版本、待办、禁止事项 | 10/10 正确 | 10/10 正确 |
| 回答同一核对问题的输入 tokens | 7,809 | 419 |

压缩请求本身另外消耗 7,937 输入 tokens、184 输出 tokens。后续输入减少约 94.6%，
不是整体费用降低 94.6%，也不是稳定的平均压缩率。
这是一项单场景信息保留测试；尚未进行 Codex 与 MyDSH 的同任务长程对照，
不能代替跨多次压缩、图片、复杂代码修改或长期工具执行的效果验收。

依据：[官方 Compaction 指南](https://developers.openai.com/api/docs/guides/compaction)、
[SIWC 接口限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。
