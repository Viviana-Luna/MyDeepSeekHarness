# `@mydsh/cli-bridge`

MyDSH 二级受控 CLI 桥插件。

## 职责与边界

- 在后台 Runtime 内创建与 Agent 预设完全隔离的 Cordis 作用域，挂载数据库、SSH、浏览器自动化、系统级桌面操控、Cordis 运行时检查与插件转换工具，不把这 30 余个外围 Schema 注入模型的一级工具列表。
- 通过 `ctx.shellEnv` 为每次 Shell 工具调用生成绑定当前会话 `Agent` 与 `AbortSignal` 的一次性内存租约，不在环境变量中暴露任何业务凭据。
- 仅使用本地操作系统 IPC（POSIX `0700` 目录下的 Unix Domain Socket，Windows 带当前用户 DACL 与 Low-Integrity 标签的 Named Pipe），不监听任何 HTTP 或 TCP 端口。
- 所有二级命令执行复用原有的主会话校验、表级与域名守卫、交互审批弹窗、取消传播与会话级生命周期清理；返回图片附件时自动落盘到当前运行期私有截图目录并返回可读路径。
