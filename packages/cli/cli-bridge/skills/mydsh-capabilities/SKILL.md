---
name: mydsh-capabilities
description: 调用 MyDSH 桌面工作台的受控二级能力（数据库连接查询/变更、SSH 远程操作、浏览器 CDP 操控、系统级桌面 Computer Use）。当任务涉及数据库、SSH 服务器、网页自动化或桌面窗口交互时加载本技能。
---

MyDSH 将数据库、SSH、浏览器自动化和系统桌面操控统一封装在受控命令行 `mydsh` 中（已自动注入当前会话 Shell 的 `PATH`，通过本地安全 IPC 回调后台服务，不暴露任何密码或密钥）。

## 快速发现（按需查询参数，不要盲猜字段名）

在 Shell 工具（`bash` / `powershell` / `exec_command`）中运行：

```sh
mydsh --help
mydsh <domain> --help
mydsh <domain> <action> --help
```

支持的四大业务领域：

- `mydsh db`：`list`（查看已开放连接）、`schema`（查看库表字段索引）、`query`（只读 SQL）、`mutate`（需审批的写入或 DDL）
- `mydsh ssh`：`list`（查看已开放主机）、`ls`、`read`、`write`（SFTP 读写）、`exec`（受控远程命令）
- `mydsh browser`：`status`、`tabs`、`navigate`、`snapshot`（提取 `@eN` 元素引用）、`click`、`type`、`press-key`、`select`、`scroll`、`wait`、`diagnostics`、`screenshot`
- `mydsh computer`：`status`、`screenshot`、`focus-window`、`click`、`drag`、`scroll`、`type`、`key`

## 参数传递与跨平台防转义规范

1. **简单标量参数**：直接使用 `--kebab-case` 标志（会自动映射到底层 `snake_case` 字段），例如：
   ```sh
   mydsh db list
   mydsh browser navigate --url https://example.com
   mydsh browser click --ref @e2 --snapshot-id snap_1
   ```
2. **多行 SQL、代码或含复杂引号的文本**：优先使用 `--<字段名>-stdin` 或 `--json-stdin` 通过标准输入传递，避免在 Bash 或 PowerShell 中手拼引号转义：
   - macOS / Bash：
     ```sh
     cat <<'SQL' | mydsh db query --connection-id prod --sql-stdin
     SELECT status, COUNT(*) AS total FROM orders WHERE created_at >= '2026-01-01' GROUP BY status;
     SQL
     ```
   - Windows / PowerShell（使用单引号 here-string，勿用 `cat <<'SQL'`）：
     ```powershell
     @'
     SELECT status, COUNT(*) AS total FROM orders WHERE created_at >= '2026-01-01' GROUP BY status;
     '@ | mydsh db query --connection-id prod --sql-stdin
     ```
3. **多模态截图查看**：`mydsh browser screenshot` 与 `mydsh computer screenshot` 会在返回 JSON 的 `image_path` 字段给出落盘图片路径，紧接着调用 `read`（标准模式）或 `view_image`（ChatGPT 模式）传入该路径即可查看画面。
4. **权限审批与超时**：写入数据库、SSH 写文件/执行非只读命令、首次访问域名或桌面键鼠操作会在界面弹出确认卡等待用户批准。调用这类命令时请将 Shell 超时设长（如 120～300 秒）或配合 `job_output` 等待结果，不要因等待审批重复发起同一写操作。
