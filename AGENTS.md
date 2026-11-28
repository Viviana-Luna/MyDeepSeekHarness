# 桌面项目协作规则

本仓库名为 MyDeepSeekHarness，软件名称为 MyDSH，是基于 Cordis 的独立 macOS / Windows Agent 桌面产品，发布 Apple Silicon `.app` / DMG 与 Windows 11 x64 应用目录 / 按用户安装的 EXE。核心运行时以 `runtime.asar`（配合解包原生模块与固定工具链）随应用离线交付，启动时从应用资源目录就地加载，并在升级后自动清理历史遗留的 `~/.mydsh/runtime/<旧版本>` 副本。应用不依赖用户安装 DSH、Node 或包管理器，不加载、嵌入或复制 DSH WebUI。
## 架构边界

- Electron 主进程拥有窗口、系统权限、核心准备和进程监督；后台 Cordis 与业务插件运行在应用自有的 `utilityProcess` 中。桌面内部只使用 IPC，不监听 HTTP 端口，也不发现、启动或停止外部 DSH。
- 核心与业务模块直接位于 `packages/<领域>/<模块>`；Cordis 等第三方框架仅保留一层 `vendor/<依赖>`。来源提交、许可证和修改记录位于 `docs/upstream/dsh`，不得再嵌套一份 DSH 工程。允许必要的内部工作区依赖；禁止复制 DSH CLI、profile 产品装配或官方 WebUI。核心版本组合由 MyDSH 的装配清单决定。
- 核心准备先取得应用单实例锁，核对清单平台架构、核心归档及数据格式门禁后从应用资源目录就地启动；仅加载应用清单指定的版本，不兼容或校验失败时保留已有用户数据。退出时释放本应用拥有的 Runtime、工具进程、终端和订阅。
- 应用资源目录 `mydsh-runtime` 存放只读核心归档 `runtime.asar`、解包原生模块与随包工具链；`~/.mydsh` 下的 `plugins` 存放用户扩展，`data`、`config`、`conversions`、`cache` 分别存放用户数据、配置、转换工作区和缓存。不得与 DSH 共用可写日志。
- renderer 必须开启 Chromium sandbox、context isolation，关闭 Node integration。受限 preload 只向受信任的本地 renderer 暴露版本化方法；主进程复核发送方、frame、方法白名单、字段和值。插件资源只能通过核对安装目录的本地协议加载。
- 移植 DSH Remote、Typert 校验及 Gateway 分发机制，使用 Electron 通信载体。保留的主进程动作适配器只转换现有界面动作与公开契约，不访问外部 Host；不能增加第二套业务协议或任意 IPC。
- 前端 Cordis、React 和 MyDSH SDK 由宿主提供共享实例。浮岛外壳拥有布局、焦点和视觉，业务插件通过插槽贡献内容。插件资源随所属生命周期释放；终端显隐与销毁分开。
- 用户扩展是明确受信任的原生代码；Cordis 及 React 错误边界不提供安全沙箱。官方插件转换器由 AI 修改源码形成 MyDSH 插件，不是通用兼容层，也不能自行修改 MyDSH 核心。
- 对话与轨迹从同一份 Session 日志投影。导入先预览并校验来源摘要，保留原数据，导入任务保持停止。凭据使用 DSH 的本地文件提供方，存于 MyDSH 私有目录的 credentials.yaml（macOS 使用 0600，Windows 使用仅当前用户与 SYSTEM 可访问的受保护 DACL）；设置只保存引用，不将密钥交给 renderer、Agent 或普通日志。

## 项目结构

```text
src/                 Electron 主进程、后台业务、preload、自有 renderer 和共享契约
packages/           按领域分组的核心与业务模块、MyDSH SDK 和运行时装配
vendor/             Cordis、Loader 等第三方框架依赖
docs/upstream/dsh/   固定来源清单、原许可证与修改记录
native/              macOS 窗口按钮与 Windows 背景裁剪、缩放模块
tests/               核心安装、生命周期、插件、导入、设置安全与 Session 投影测试
scripts/             构建、发行、安装包验收和独立性门禁
docs/                架构与各平台发行说明
.github/workflows/   最小持续集成
```

## 开发命令

```sh
pnpm install
pnpm run build
pnpm run test
pnpm run typecheck
pnpm run lint
pnpm run verify:standalone
pnpm run verify
```

`pnpm run verify` 使用系统临时目录中的隔离 MyDSH 数据与 Electron `userData` 启动真实应用，检查离线核心安装、自有 renderer、浮岛、项目、输入区、模式切换、设置 IPC、明暗主题、多尺寸布局、持久化及退出清理。截图、录屏和诊断日志不得落入仓库，退出时自动清理。静态检查不能代替真实 Electron 或安装包验收。

## 变更规则

- 所有自有对话、文档、代码注释、测试描述、错误信息和 Git 提交信息使用简体中文；标识符、协议字段和第三方专名保持既有写法。固定上游源码保留版权与来源，维护的移植层提供中文机制说明。
- 先读取 `README.md`、`docs/renderer.md`、`docs/code-style.md` 和本次涉及的实际代码，再修改。My Workflow 关闭时，不自动读取或维护外部 Markdown 工作区。
- MyDSH 自有代码遵守 `docs/code-style.md`：提交前运行 `pnpm run format`；单个函数和文件不超过规范上限；每个文件写明职责，每个导出声明写中文 JSDoc，行内注释说明原因而不是复述代码。`.oxlintrc.json` 与 `scripts/comment-debt.json` 中的豁免清单只减不增。
- 生命周期、子进程、导航、IPC、权限或本地文件变更必须覆盖失败路径和清理路径，并运行真实 Electron 验收。
- UI 改动必须同时检查 1280×800 默认窗口、放大窗口、明暗主题、透明合成、描边连续性和无障碍降级。
- 不提交 `.env`、证书、签名私钥、公证凭据、用户设置、会话数据、截图缓存或构建输出。
- 未经用户明确授权，不 push、不创建 Release、不签名、不公证、不发布安装包。
- 文件以一个换行结尾；提交前运行 `git diff --cached --check`。
