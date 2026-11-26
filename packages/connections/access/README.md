# 会话连接变更授权与并发协调

`@mydsh/connection-access` 在 MyDSH 后台持有本代 Runtime 内各会话对数据库变更与 DDL 操作的临时同意状态（内存态，不落盘，不从历史日志恢复），不保存连接配置、密码或查询结果。

- **会话级同意（`grantSessionConsent` / `hasSessionConsent`）**：绑定会话、当前 Agent 根实例、数据库连接版本以及依赖的 SSH 配置/主机指纹。会话结束、归档、Agent 重建、连接或 SSH 修改/删除、Runtime 退出时自动失效。
- **单次租约与会话租约（`acquireLease` / `releaseLease`）**：支持用户选择的「允许本次（全部 N 条）」一次性租约与会话级持续同意；历史参数或伪造标识不能绕过校验。
- **连接串行协调（`serializeForConnection`）**：确保同一会话同一轮并发发起的多次变更调用排队申请授权，用户同意会话放行后后续操作无需重复弹窗。

公开工具与表级策略规则见 [数据库插件说明](../database/README.md)。
