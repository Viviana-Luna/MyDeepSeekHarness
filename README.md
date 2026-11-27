<div align="center">
  <img src="assets/app-icon.png" width="104" height="104" alt="MyDSH 应用图标" />
  <h1>MyDSH</h1>
  <p><strong>MyDeepSeekHarness · 面向本地工程与多工具协同的独立插件化 Agent 桌面工作台</strong></p>

  <p>
    <img src="https://img.shields.io/badge/Stage-Technical%20Preview-4d6bfe?style=flat-square" alt="技术预览阶段" />
    <img src="https://img.shields.io/badge/Platform-macOS%20arm64%20%7C%20Windows%2011%20x64-1f2937?style=flat-square" alt="支持平台" />
    <img src="https://img.shields.io/badge/Stack-Electron%20%C2%B7%20Cordis%20%C2%B7%20React-2563eb?style=flat-square" alt="技术栈" />
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3%2B-2f9d77?style=flat-square" alt="GPL-3.0-or-later 许可证" /></a>
  </p>

  <p>
    <a href="#核心特性">核心特性</a> ·
    <a href="#快速开始">快速开始</a> ·
    <a href="#架构一览">架构一览</a> ·
    <a href="#文档导航">文档导航</a> ·
    <a href="#参与贡献">参与贡献</a> ·
    <a href="SECURITY.md">安全政策</a>
  </p>
</div>

---

**MyDSH**（MyDeepSeekHarness）是一款基于 [Cordis](https://cordis.js.org/) 二次开发的独立桌面 Agent 工作台。它选择性移植了 DeepSeek Harness 的 Agent 循环、会话投影、模型与工具能力，并从零重构了桌面浮岛交互、多工具工作区与安全运行边界。

与依赖外部 CLI 或套壳网页不同，MyDSH 随应用离线交付完整的后台核心与工具链，不要求用户预先安装 DSH、Node.js 或包管理器，应用内部仅通过受控 IPC 通信，不监听本地 HTTP 端口。

> [!NOTE]
> MyDSH 当前处于 **Technical Preview（首个公开技术预览）** 阶段，功能与界面仍在持续迭代中。欢迎通过 [GitHub Issues](https://github.com/Viviana-Luna/MyDeepSeekHarness/issues) 反馈问题或交流想法。

## 核心特性

### 光学浮岛工作台
- **原生质感与双主题**：macOS 原生窗口合成与 Windows 11 原生背景裁剪，内置完整的深浅主题切换、多尺寸响应式排版与无障碍降级（高对比度、强制色彩、减少动态与减少透明）。
- **工作标签与双栏分屏**：聊天、代码文件、Git 差异、本地终端、SSH 与内置浏览器统一纳入顶部工作标签，支持自由排序、拖拽分屏、单标签自动沉浸收起与平铺总览。
- **同源对话与轨迹**：对话流与结构化执行轨迹实时投影自同一份 Session 日志，并配备轮次刻度导航、多维度用量与上下文压力读数。

### 面向模型的 Harness 预设与二级 `mydsh` CLI
- **三套独立内置预设**：
  - **标准模式（`standard`）**：面向主流通用模型，提供文件读改、后台 Shell、规划、网页检索、提问、子代理与 Skills 等核心原语。
  - **极简模式（`minimal`）**：纯粹编码预设，仅暴露最精简的读写与 Shell 工具，零外围干扰。
  - **ChatGPT（`gpt-coding`）**：面向 GPT / Codex 后训练体系，对齐 `exec_command`、`apply_patch`、`update_plan`、`view_image` 与原生上下文压缩。
- **受控二级命令行 `mydsh`**：将数据库、SSH、浏览器操控、系统桌面操控与插件工具从一级工具 Schema 下沉至按需 Skills + 受控二级 CLI（经本地 Socket / Named Pipe 回调宿主），显著降低上下文噪音。

### 一站式本地工程工具区
- **代码与 Git 工作区**：内置 CodeMirror 编辑器、未保存离开保护、并排 / 行内 Diff 查看器、分支提交图以及可审阅分批提交的 Git AI 提交助手。
- **多项目终端与 SSH**：按项目分组管理持久化本地 PTY 终端，同时提供独立的 SSH 服务器管理与远程终端工作区。
- **多数据库工作区**：支持 MySQL、MariaDB、PostgreSQL 与 SQLite，提供表结构浏览、分页查看与单表查询，并支持按连接与表级粒度为 Agent 授权（只读 / 读写 / 完整访问）。
- **浏览器与桌面自动化**：内置基于 CDP 的浏览器操控与系统级 Computer Use 能力，支持受控授权与站点来源约束。

### 隐私与分层安全边界
- **零端口桌面架构**：Renderer 开启 Chromium Sandbox 与 Context Isolation，经受限版本化 Preload 与主进程通信，不暴露本地 HTTP 服务。
- **本地凭据隔离**：模型与连接凭据保存在 MyDSH 私有目录的 `credentials.yaml`（macOS `0600` 权限，Windows 受保护用户 DACL），普通配置文件仅存引用，不向前端或普通日志泄露密钥。
- **分级权限与审批**：提供只读、工作区内修改、完全权限与实验性的「自动审核提权」；高危数据库 DDL / 无条件删改与提权操作均有独立确认与审计留痕。

### 原生插件与数据导入
- **前后端 Cordis 扩展**：用户插件可独立安装、启停与回退版本，并内置面向官方插件的 AI 源码转换工作区。
- **无损 DSH 数据导入**：支持从历史 DSH 数据目录只读预览、摘要校验并导入会话、项目与受支持设置，保留原始目录不被改写。

## 支持平台

| 平台 | 架构 | 支持状态 | 交付形态 |
| --- | --- | --- | --- |
| macOS | Apple Silicon (`arm64`) | 技术预览支持 | `.app` / `.dmg` |
| Windows 11 | `x64` | 技术预览支持 | 应用目录 / 按用户安装 `.exe` |
| Windows ARM64 / Windows 10 / Linux | — | 暂不在首版范围 | — |

> 当前预览构建默认采用 ad-hoc 签名，暂未接入正式商业代码签名或 Apple 公证，首次安装运行可能触发系统安全提示。

## 快速开始

### 环境要求

- **Node.js**：22.19+ 或 24+
- **包管理器**：pnpm 11（推荐使用 Corepack：`corepack enable`）
- **Windows 额外要求**：构建原生背景模块需要 Visual Studio C++ Build Tools 与包含 C++/WinRT 的 Windows SDK

### 从源码运行

```sh
git clone https://github.com/Viviana-Luna/MyDeepSeekHarness.git
cd MyDeepSeekHarness
pnpm install
pnpm run dev
```

### 常用开发命令

| 命令 | 说明 |
| --- | --- |
| `pnpm run dev` | 增量构建并启动 Electron 桌面端 |
| `pnpm run build` | 按输入摘要增量构建离线核心运行时、主进程与前端资源（全量冷重编可用 `pnpm run build:clean`） |
| `pnpm run check` | 运行并行增量类型检查、格式校验、Lint、注释检查、单元测试与独立性门禁 |
| `pnpm run test:unit` | 仅运行纯内存与前端组件快速单元测试（跳过重型子进程集成测试） |
| `pnpm run verify:smoke` | 快速启动真实 Electron 验收核心安装、启动页、窗口与基础浮岛（也可通过 `node scripts/verify-source-runtime.mjs --suite=<套件>` 定向验收） |
| `pnpm run verify` | 在隔离临时目录中运行全量真实 Electron 窗口验收 |
| `pnpm run eval:harness` | 运行 Harness Schema 预算与二级 CLI 闭环评测 |
| `pnpm run make:mac` | 构建并打包 macOS Apple Silicon `.app` 与 `.dmg` |
| `pnpm run make:win` | 构建并打包 Windows 11 x64 应用目录与安装程序 |

## 架构一览

```text
┌──────────────────────────────────────────────────────────────────────┐
│  Renderer（Chromium Sandbox + Context Isolation）                     │
│  React + Ant Design + 前端 Cordis 插槽（浮岛外壳 / 工作标签 / 业务视图）  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ 受限版本化 Preload IPC（零 HTTP 端口）
┌──────────────────────────────────▼───────────────────────────────────┐
│  Electron 主进程（宿主）                                               │
│  窗口合成 · 原生权限与目录框 · 单实例锁 · 离线核心校验安装 · 进程监督    │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ Electron MessagePort / Remote + Typert
┌──────────────────────────────────▼───────────────────────────────────┐
│  内置后台 Runtime（Electron utilityProcess + Cordis）                  │
│  Agent 循环 · 模型路由 · Session 持久化 · 工作区 / 终端 / SSH / DB     │
│  受控二级 CLI 桥接（mydsh ⇄ Unix Socket / Named Pipe）                │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                    ~/.mydsh/{runtime,plugins,config,data,conversions,cache}
```

### 目录结构

```text
.
├── src/                # Electron 主进程、后台管理、Preload、自有 Renderer 与共享契约
├── packages/           # 按领域分组的核心与业务模块、SDK 及运行时装配清单
├── vendor/             # Cordis、Loader 等第三方框架固定依赖
├── native/             # macOS 窗口按钮与 Windows 原生背景裁剪/缩放模块
├── assets/             # 应用图标源图、ICNS 与明暗启动插画
├── scripts/            # 构建、打包、独立性检查与真实窗口验收脚本
├── tests/              # 核心、生命周期、插件、安全与前端交互自动化测试
└── docs/               # 架构维护、编码模式、插件开发与发行文档
```

## 文档导航

完整文档目录请查看 [docs/README.md](docs/README.md)，常用入口如下：

- **理解能力与架构**：[编码与调度模式](docs/agent-modes.md) · [运行时维护与故障排查](docs/dev.md) · [前端维护指南](docs/renderer.md)
- **扩展与迁移**：[插件与 AI 转换开发指南](docs/plugin-development.zh.md) · [前端界面插件指南](src/renderer/src/plugins/README.md) · [从 DSH 导入数据](docs/data-import.zh.md)
- **特性与安全细节**：[Git AI 提交](docs/git-ai-commit.md) · [自动审核提权边界](packages/interaction/auto-review/README.md) · [安全政策](SECURITY.md)
- **开发与发布**：[贡献指南](CONTRIBUTING.md) · [代码规范](docs/code-style.md) · [发行说明](docs/release.md)

## 参与贡献

欢迎提交 Bug 报告、功能建议或 Pull Request！提交前请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [代码规范](docs/code-style.md)，并确保本地改动通过 `pnpm run check`。

如果你发现了安全漏洞或权限绕过问题，请不要直接在公开 Issue 中披露细节，请参阅 [SECURITY.md](SECURITY.md) 了解私密反馈方式。

## 致谢与声明

- MyDSH 的核心运行时框架与部分基础能力移植自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 与 [Cordis](https://cordis.js.org/)，固定来源提交、原始 MIT 许可证与完整修改记录均保留在 [docs/upstream/dsh/](docs/upstream/dsh/README.zh.md)。
- MyDSH 是独立维护的社区桌面应用，保留上游来源与许可证不代表 DeepSeek 官方对本项目的背书或支持。
- 应用图标素材说明与权利归属见 [assets/README.md](assets/README.md)。

## 许可证

本项目整体及 MyDSH 自有代码采用 [GNU General Public License v3.0 or later（GPL-3.0-or-later）](LICENSE) 开源（强传染性 Copyleft 协议）：任何基于本项目的再分发或衍生作品均须在相同许可证下公开完整对应源代码。

从上游移植并保留的 DeepSeek Harness 与 Cordis 源码模块维持其原始 MIT 版权与许可声明，详见 [docs/upstream/dsh/LICENSE](docs/upstream/dsh/LICENSE) 与 `vendor/` 目录（与 GPL-3.0 兼容）。
