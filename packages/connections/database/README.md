# MySQL 工作区与模型数据库工具

`mydshDatabase` 通过既有 Remote/Typert 提供连接配置、测试、结构、表预览和手动只读 `SELECT`。桌面方法仅允许当前 macOS 窗口调用。`@mydsh/database/tools` 是同包的模型工具入口，由 `@mydsh/cli-bridge` 在隔离作用域内装配并通过 `mydsh db` 二级命令行对外暴露，共用后台连接、队列与取消控制。

## 连接与安全模型

- **凭据与通道**：连接元信息与加密密码封装保存在所属 `CredentialProvider` 记录中，公开状态不返回密码或密文。支持严格 TLS（验证 CA 与 DNS/IP SAN）与引用已启用、已信任主机指纹的 SSH 隧道。
- **手动浏览（工作区）**：桌面点击运行保持单表只读 `SELECT`（最多 500 行 / 2 MiB、单值 256 KiB、20 秒时限），支持同账号控制连接 `KILL QUERY` 取消。
- **模型访问策略（「数据库」模式配置）**：每个连接默认关闭 `agentAccess`；开启后选择 `readonly`、`readwrite` 或 `full` 档位，再按需配置 `库名.表名`／`库名.*` 表级规则。表规则只能收窄档位，最终权限同时受 MySQL 账号限制。每次执行前重新校验连接版本和关联 SSH 指纹。

## 模型工具与授权流程

- `database_connections_list`：列出已启用、凭据完整且在「数据库」模式开放的模型连接（含直连与可信 SSH 隧道连接）及脱敏权限摘要，不弹窗。
- `database_schema`：按档位和表级规则返回库、表、字段与索引结构。结构读取被规则拒绝时会先请求本次或本会话提权；系统库始终不可通过该工具读取。
- `database_query`：`sql`、`queries` 和分号脚本最多包含 20 条同类业务表语句。没有表级规则时使用完整 SQL 路径，支持子查询、CTE、UNION、窗口函数和业务表 DML/DDL；有表级规则时解析目标库表。读取在只读事务中执行，写入和 DDL 进入授权流程。档位或表规则不足时先请求临时提权；系统库、`INTO OUTFILE`、`LOAD_FILE`、账号管理和服务器对象仍直接拒绝。
- `database_mutate`：批量执行 1 至 50 条业务表 `INSERT`、`UPDATE`、`DELETE` 及表/库/索引/视图 DDL（`CREATE`、`ALTER`、`DROP`、`TRUNCATE`、`RENAME`），保持传输层 `multipleStatements: false`。权限不足时先申请本次或本会话提权，再合并为用户授权；纯 DML 在单事务内原子执行并支持异常回滚，包含 DDL 时顺序执行并提示 MySQL 隐式提交特性。

会话提权只存在内存，绑定当前 Agent、连接版本和关联 SSH 配置；修改连接、表规则、SSH 指纹或重建会话后失效。MySQL 账号权限仍是最终上限。

## 逐次确认的破坏性变更

以下语句即使已获得本会话变更授权或本会话完整访问提权，也必须每次单独确认，确认卡不提供「本次会话允许」选项：

- `CREATE DATABASE`、`ALTER DATABASE`、`DROP DATABASE`（含 `SCHEMA` 写法）；
- `DROP TABLE`、`DROP VIEW`、`TRUNCATE`；
- 没有顶层 `WHERE` 的 `DELETE` 与 `UPDATE`（包括 `WITH ... UPDATE/DELETE`）。

变更结果的 `authorization` 字段说明本次放行来源：`approved-once`、`approved-session`、`elevated-once`、`elevated-session` 或 `session-reused`。`database_connections_list` 的 `session_elevation` 返回当前会话仍有效的临时提权；`agent_access` 只描述连接配置，不包含临时提权。模型只能看到工具结果，无法得知界面是否弹出确认卡，因此应以这两个字段判断授权来源。
