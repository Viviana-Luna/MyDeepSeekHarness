# 安全政策

MyDSH 是一款具备本地 Shell、文件读写、Git、SSH、数据库访问及浏览器/桌面自动化能力的桌面 Agent 应用，我们非常重视运行边界与用户数据安全。

## 安全模型与已知边界

在报告或评估安全问题时，请了解 MyDSH 当前的设计边界：

- **本地零端口架构**：应用内部仅通过 Electron 受限 IPC、MessagePort 以及本地受保护的 Unix Domain Socket / Windows Named Pipe（受控二级 CLI `mydsh`）通信，不监听本地 HTTP 端口。
- **Renderer 隔离**：前端渲染进程启用 Chromium Sandbox 与 Context Isolation，关闭 Node Integration，仅通过受限 Preload 暴露版本化方法，主进程复核调用方、frame 与参数契约。
- **凭据存储**：API Key 与连接凭据存储于 `~/.mydsh/config/credentials.yaml`（macOS `0600`，Windows 仅当前用户与 SYSTEM 可访问的 DACL），不会直接暴露给渲染进程、Agent 普通上下文或常规日志。
- **权限预设与审批**：高危数据库写操作、DDL、系统越界访问及权限提升默认需用户确认。实验性「自动审核提权（`auto-review`）」由模型辅助判断，存在误判可能，不构成绝对安全隔离，详见 [自动审核提权边界](packages/interaction/auto-review/README.md)。
- **用户插件信任模型**：用户主动安装的扩展属于受信任原生代码，Cordis 与 React 错误边界仅提供容错与资源回收，不提供恶意代码安全沙箱，请只安装来自可信来源的插件。

## 报告安全漏洞

如果你发现潜在的安全漏洞（例如 IPC 越权、路径穿越、凭据泄露、沙箱逃逸或恶意输入导致的未授权执行），请**不要**直接在公开 Issue 或 Pull Request 中披露复现细节。

请通过以下私密渠道向维护者报告：

1. 前往仓库的 [GitHub Security Advisories](https://github.com/Viviana-Luna/MyDeepSeekHarness/security/advisories/new) 提交私密漏洞报告（推荐）。
2. 报告中请尽量提供：
   - 受影响的操作系统、架构及提交哈希 / 版本信息
   - 漏洞影响范围与前置条件
   - 最小化复现步骤或概念验证说明
   - 可选的修复思路或缓解建议

我们会在收到报告后尽快核实影响范围、评估修复方案，并在修复发布后再协调公开说明。
