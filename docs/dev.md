# 运行时维护与故障排查

MyDSH 的后台由应用自带的 Cordis 核心和业务插件组成。Electron 主进程安装并监督一个 `utilityProcess`；后台拥有会话、项目、工具和插件业务状态，renderer 拥有草稿、编辑缓冲、阅读位置和浮岛布局。窗口、系统对话框、更新入口以及调用方校验属于桌面宿主。

## 源码目录地图

| 路径 | 维护职责 |
| --- | --- |
| `src/main/index.ts` | Electron 装配、窗口、单实例锁、退出协调和真实窗口验收入口 |
| `src/main/runtime/runtime-install.ts` | 核心清单校验、版本选择、暂存安装、安装中断恢复、旧版本清理及数据格式检查 |
| `src/main/runtime/runtime-supervisor.ts` | 后台启动、就绪、请求、流、取消、退出确认；凭据由后台文件服务持有 |
| `src/main/runtime/runtime-stream.ts` | 将运行进程消息适配到现有 Remote 流消费接口，消费完成后才确认消息 |
| `src/main/runtime/import-controller.ts` | 导入入口、并发互斥、运行任务及未保存文件保护、暂停和重启核心 |
| `src/main/runtime/plugin-controller.ts` | 受限插件管理与前端本地资源协议 |
| `src/main/runtime/remote-controller.ts` | 前端插件公开 Remote 方法和订阅的受限桥接 |
| `src/main/host` | 沿用的 Remote 参数校验、结果解析及 Session 投影；目录名不代表外部 Host 进程 |
| `src/main/settings`、`src/preload` | 桌面偏好持久化及 sandbox 页面可用的最小系统能力 |
| `packages/runtime/entry.mjs`、`roster.json` | 后台进程入口、Cordis 插件组合和运行时装配 |
| `packages/runtime/credentials.mjs` | 把模型凭据请求交给主进程，不把明文存入后台普通配置 |
| `packages/runtime/directory-picker.mjs`、`src/main/runtime/directory-picker.ts` | 注册后台目录选择服务，通过主进程打开和取消原生目录框 |
| `packages/runtime/plugin-resolution.mjs` | 用户扩展与宿主共享 Cordis 等运行依赖的解析 |
| `packages/runtime/plugin-tools.mjs`、`plugin-typert.mjs` | Agent 转换工具注册及转换产物的 Typert 元数据生成 |
| `src/runtime/plugins` | 扩展版本管理、依赖校验、启停、恢复和源码转换工作区 |
| `src/runtime/workspace`、`src/runtime/terminal` | 项目文件、Git、索引和终端业务；Electron 适配留在主进程 |
| `src/runtime/import/dsh-import.ts` | 来源只读预览、格式校验、幂等来源映射与 data/config 联合提交 |
| `src/shared` | 窗口两侧使用的契约、校验和会话投影 |
| `src/renderer/src/plugins` | 前端 Cordis、插槽、内置视图贡献、扩展加载和插件管理页面 |
| `packages/core`、`packages/session`、`packages/session-query` | Agent 循环、工具契约、会话日志、投影、持久化与查询 |
| `packages/llm`、`packages/context`、`packages/compaction` | 模型调用、上下文注入、Token 统计与压缩 |
| `packages/api`、`packages/typert`、`packages/client` | Remote 契约、参数校验、Gateway 与本地连接分发 |
| `packages/fs`、`packages/shell`、`packages/subprocess`、`packages/sandbox` | 文件与命令工具、子进程和执行边界 |
| `packages/interaction`、`packages/skill`、`packages/goal`、`packages/subagent` | 审批与提问、Skills、目标和子 Agent |
| `packages/settings`、`packages/credentials`、`packages/storage`、`packages/workspace` | 配置、凭据服务契约、存储与项目业务 |
| `packages/desktop-services`、`packages/plugin-sdk`、`packages/ui-sdk` | MyDSH 桌面业务的 Remote 服务、后台与前端插件接口 |
| `vendor/<依赖>` | Cordis、Loader、Include、Timer、Cosmokit 和 Schemastery 的固定源码 |
| `docs/upstream/dsh` | 原许可证、来源提交、模块原始路径和 MyDSH 修改记录；不存放运行源码 |
| `scripts/core` | 固定来源导入与离线核心依赖闭包构建 |

领域目录沿用上游已存在的模块分组，每个实际模块有自己的 `package.json`。根工作区同时登记 `packages/*`、`packages/*/*` 和 `vendor/*`，由 pnpm 管理模块间依赖；构建脚本不额外向根 `node_modules` 填入整套隐式链接。`packages/runtime` 是产品装配目录，`roster.json` 决定本次启用的核心插件。

`tsconfig.json` 编译 Node/Electron 一侧；`tsconfig.renderer.json` 检查前端；后台业务包对 Cordis 的声明合并与前端界面声明使用各自编译边界。不要让 renderer 直接导入 `src/runtime`、Electron 或后台 Cordis 服务。目录迁移保持原来的静态检查范围：上游源码与声明快照不因移动位置而批量套用 MyDSH 的 Lint 规则；MyDSH 自有实现、包构建及集成验收继续执行现有检查。

## 安装目录与配置

开发构建生成 `lib/mydsh-runtime/manifest.json` 和 `lib/mydsh-runtime/payload/`。正式 App 将这份初始安装包放在 `MyDSH.app/Contents/Resources/mydsh-runtime/`，处于 ASAR 外；原生库和工具链必须可以作为普通文件执行。应用主进程与 renderer 位于 `app.asar`。

安装后的可写目录如下：

```text
~/.mydsh/
├── runtime/<版本>/       # entry.js、内置插件、node_modules、固定工具链和安装回执
├── plugins/             # 用户扩展及其已安装版本
├── config/
│   ├── settings.yaml    # 模型和业务插件设置的唯一活动文件
│   ├── plugins.json     # 用户插件启用状态与版本索引
│   └── credentials.yaml # DSH 本地凭据提供方，文件权限 0600
├── data/
│   ├── format.json      # 数据格式版本门禁
│   ├── sessions/        # Session 日志
│   ├── attachments/     # 附件内容
│   ├── storages/        # 项目及其他业务存储
│   ├── plugins/         # 用户扩展的数据
│   └── .mydsh-imports.json
├── conversions/         # 用户发起的转换源码、状态、报告及产物
└── cache/               # 可重建缓存
```

`DSH_HOME` 仅是移植代码在后台内部使用的目录参数，固定指向当前 `MYDSH_HOME/data`，不引用原 DSH 目录。设置插件显式使用 `MYDSH_HOME/config/settings.yaml`；它不会在 `data` 下维护另一份配置。现有桌面外观、文件导航和项目任务偏好继续保存在 Electron `userData` 中，以保留已有客户端偏好；它们不是后台模型配置。

`MYDSH_HOME` 可以指定绝对路径，供测试隔离使用。未指定时才使用 `~/.mydsh`；不能用相对目录切换用户数据。验收脚本自动建立隔离目录、受限 `PATH` 和 Electron 用户目录，并在退出时清理，开发验收不应指向个人数据。

## 启动、通信和退出

启动先取得应用单实例锁，再恢复中断的导入事务，然后校验和安装清单要求的核心版本。必须先恢复导入，后创建空 `data` 或 `config`，否则可能覆盖应恢复的旧目录。核心安装验证整个文件清单；同版本可复用，新版本不覆盖配置和会话。目录里存在更新的核心也不会改变应用选择。

主进程通过 Electron 消息启动后台，后台装配 `roster.json` 中的插件并检查必要服务后报告就绪。业务请求保留 Remote、Typert 与 Gateway 契约；实现中的 Fetch-shaped 请求对象只是分发适配，没有内部 HTTP 监听、Cookie 登录或端口接管。已有 `host.call` 名字属于界面动作契约，最终只调用应用自有核心。

项目目录选择沿用 `directoryPicker/pick`：后台注册 `DirectoryPicker` 服务，Electron 主进程持有当前窗口的原生目录框。用户取消返回 `null`；请求中断、后台退出或应用退出会关闭对应目录框，并丢弃迟到的选中结果。启动就绪检查包含 `directoryPickerController`，不能缺少服务仍进入工作台。

事件流由后台逐条发送，主进程完成异步投影后才确认；取消释放请求和订阅。进程异常后清理飞行中的请求，重连重新取得状态基线，不重放写操作。队列、请求和消息大小均有上限，超过时返回中文错误。

退出先调用 `shutdownImportController`，取消并等待正在进行的导入，再调用运行监督器的 `shutdown`。普通 `stop` 用于导入时暂停，允许之后重启；`shutdown` 禁止异步 `finally` 再启动核心。监督器先请求后台清理，超时后只终止本应用持有的子进程，并等待退出确认。凭据提供方随后台 Cordis 退出时等待已接受的原子写入完成。

## 常见故障

| 现象 | 应检查与处理 |
| --- | --- |
| 首次安装失败或反复停留在完整性校验 | 从启动页复制诊断，检查应用附带的 `Resources/mydsh-runtime` 是否完整以及目录是否可写。点击重试会重新验证并修复核心；应用资源本身损坏时重新安装 App，不删除会话或配置。 |
| 提示数据格式不兼容 | 使用支持该格式的应用版本。不要手动改 `data/format.json` 绕过门禁，也不要把其他核心目录改名冒充当前版本。 |
| 提示导入恢复记录无效或旧副本无法恢复 | 保留 `~/.mydsh/.import-*`，其内容可能是尚未恢复的唯一旧数据。处理权限、空间或损坏记录后重试恢复；不能把这些目录当缓存清理。详见[数据导入说明](data-import.zh.md)。 |
| 核心已安装，但启动超时或插件加载失败 | 查看启动诊断中的失败插件与后台错误，核对随包原生库和依赖。普通用户扩展不能卸载基础服务；不要通过安装全局 DSH 修补应用包。 |
| 模型列表可见，但调用缺少凭据 | 在模型设置中填写 API 密钥，保存到私有 credentials.yaml；普通设置只保存引用。启动环境提供的凭据只读并优先，文件写入失败时保留表单供重试。 |
| 用户插件启用或升级失败 | 在插件管理页查看错误与依赖，必要时恢复上一可用版本。正在运行任务或有未保存内容时先完成相关操作，再执行待处理切换。 |
| 转换未完成或构建失败 | 查看 `conversions/<任务>/` 中的状态与报告，从保留的源码继续；失败产物不会替换正在运行的插件。来源下载需要相应网络，初始核心安装无需网络。 |
| 对话中断后重新连接 | 先确认运行核心已经就绪，等待新基线；核对操作结果后再决定是否重试写入，不能假定取消已撤销外部工具副作用。 |

## 验收入口

类型、现有测试和静态规则使用 `pnpm run check`。`pnpm run verify` 完整构建后运行真实 Electron；`pnpm run verify:package:runtime` 从打包 App 在隔离目录首次安装核心并执行工具链检查。截图、日志与夹具均写到系统临时目录并自动清理。

原生目录框交互使用 `node scripts/verify-source-runtime.mjs --directory-picker`：第一次点击取消，第二次选择日志给出的临时项目目录；脚本验证项目创建后，自动检查请求取消和常规界面。此入口需要操作员或系统 UI 自动化，不能用预设路径调用代替原生选择验收。

需要手动操作完整工作台时，可在隔离验收环境中为应用同时传入 `--verify --verify-interactive`。此模式沿用 `MYDSH_VERIFY_HOME` 的用户目录隔离，跳过自动点击、会话夹具和自动退出；控制台输出 `desktop-shell-interactive-ready` 后即可操作。启动它的脚本负责设置临时 `MYDSH_HOME`、限定运行时长，并在退出时清理测试数据与子进程。

真实模型调用与 Agent 源码转换需要有效模型配置；确定性夹具通过不能替代这部分验收。发行步骤、ASAR 资源约束和 DMG 检查见[发行说明](release.md)，界面插槽见[前端维护指南](renderer.md)与[插件开发指南](plugin-development.zh.md)。
