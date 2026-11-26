# MyDSH 的编码与调度模式

MyDSH 按模型后训练先验划分三个相互独立的内置预设，并通过 `@mydsh/cli-bridge` 将低频重型的自研外围能力（数据库、SSH、浏览器 CDP、系统级 Computer Use 与插件转换器）从一级工具 Schema 下沉为受控二级命令行 `mydsh` + 按需 Skills。

## 三套内置预设

- **标准模式（`standard`）**：面向通用编码模型，一级提供 `read`、`edit`、`write`、支持后台作业的 `bash` / `powershell`（Windows 额外提供原生 `glob` / `grep` 以规避命令行转义），并保留 `update_plan`、`job_output` / `job_kill`、`web_search` / `web_fetch`、`ask_user_question`、`exit_plan_mode`、`skill`、`subagent`、`goal` 与 `present`。不暴露 `apply_patch` 与外围业务 Schema。
- **极简模式（`minimal`）**：聚焦纯代码读改，POSIX 下严格仅保留 `read`、`edit`、`write`、`bash` 四工具，Windows 下为 `read`、`edit`、`write`、`powershell`、`glob`、`grep`。项目与用户 Skills 按需通过 `read` 加载。
- **ChatGPT（`gpt-coding`）**：对齐 Codex 后训练原语，一级提供 `read`、`view_image`、`exec_command`、`apply_patch`、`update_plan`、`job_output` / `job_kill`（Windows 补充 `glob` / `grep`），**不暴露 `write` 与 `edit`**；搭配 `@mydsh/compaction-chatgpt` 在窗口 80% 处启用 Responses 原生压缩。

历史会话或旧配置中曾使用的 `efficiency` 自动映射至 `minimal`，`ptc`、`cordis`、`coding-focused` 自动映射至 `standard`。用户复制到个人目录的预设引用随包模块，不依赖内置预设相对路径。

## 二级受控命令行与评测框架

`mydsh` 仅在受管 Shell 会话内通过 `ctx.shellEnv` 注入的一次性内存租约工作，经本地 Unix Domain Socket 或带 Low-Integrity 标签与当前用户 DACL 的 Windows Named Pipe 回调后台服务，不监听任何 HTTP/TCP 端口，也不向子进程环境泄露凭据。支持 `--help` 逐级参数发现与 `--<字段名>-stdin` 流式输入；截图工具自动落盘到运行期私有目录并返回 `image_path` 供 `read` / `view_image` 读取。

运行 `pnpm run eval:harness` 可执行离线 Schema 预算降幅与沙箱二级 CLI 安全闭环评测；附加 `-- --live --provider <id> --model <id>` 可在隔离临时目录运行真实大模型端到端基准任务对比。

设计参考来源：

- [Codex 的官方系统提示词](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/core/gpt-5.2-codex_prompt.md)与[命令执行实现](https://github.com/openai/codex/blob/c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs)，来源修订 `c2f7fe89d87ce853900d0b5cb1f5dc4863e44d73`。
- [OpenAI 的公开补丁工具说明](https://developers.openai.com/api/docs/guides/tools-apply-patch)。
- [pi 的系统提示词](https://github.com/badlogic/pi-mono/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/core/system-prompt.ts)、[读取工具](https://github.com/badlogic/pi-mono/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/core/tools/read.ts)与[编辑工具](https://github.com/badlogic/pi-mono/blob/200387122ca450d6387f033949423114a270b96c/packages/coding-agent/src/core/tools/edit.ts)，来源修订 `200387122ca450d6387f033949423114a270b96c`。
