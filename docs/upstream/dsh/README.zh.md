# MyDSH 移植源码的来源与修改记录

本目录只保存 DeepSeek Harness 移植来源、原始许可证和修改记录。MyDSH 维护的核心与业务源码直接放在仓库根目录 `packages/<领域>/<模块>`，第三方框架直接放在 `vendor/<依赖>`；不在这里保存或嵌套另一份工程。应用不依赖用户另外安装 DSH。

## 来源与范围

上游仓库为 `https://github.com/deepseek-ai/deepseek-harness`，当前固定基线为 `ddefc45fbc7f8e46dd73185e68295696d1297887`。机器可读的模块名称、版本和原始路径以同目录 `manifest.json` 为准；修改基线时必须同时更新此记录。

- 仓库根目录 `packages/` 保留 Agent、模型、会话、工具、权限、项目、设置、Remote/Typert 等选定业务包，以及它们的依赖；与 MyDSH 自有模块一起纳入 pnpm 工作区。
- 仓库根目录 `vendor/` 保留 DSH 所用的 Cordis、Loader、Include、Timer、Cosmokit 和 Schemastery。保留该基线已经包含的 Cordis 父子所有权、可等待清理和异步 effect 生命周期修复，不能仅按 npm 同名包版本替换。
- 各包的 `src/` 是维护源码；`upstream-package.json` 保留原包元信息；`types/` 和 `contracts/` 保存固定基线所需的声明及 Typert 生成协议。
- `lib/` 由 MyDSH 的构建脚本重新编译。它不作为单独的手工维护来源。

源码包在仓库中存在不等于运行时自动启用。实际插件组合由仓库根目录的 `packages/runtime/roster.json` 明确选择。依赖闭包可能包含未启用的辅助包；应用不读取用户原 DSH profile，也不会自动加载原插件目录。

## MyDSH 适配记录

移植保持模块边界与原始协议，当前产品差异主要放在 MyDSH 自有包中：

| 位置 | 调整 |
| --- | --- |
| `packages/`、`vendor/` 中各移植包的 `package.json` | 标记为私有工作区包，移除上游发布与开发脚本，调整源码逐文件编译对应的导出和声明路径；原元信息保留在 `upstream-package.json`。保留原包标识，避免目录归位时同时改变 Cordis 声明合并和 Remote 契约。 |
| `packages/core/system-prompt/src/index.ts` | 固定身份开场白使用 MyDSH，保留上游提示词分层顺序与配置字段。 |
| 原生依赖声明 | 固定 `@deepseek-ai/node-addon-system` 发布版本，使应用构建可以携带已有原生模块，而不要求用户编译上游原生仓库。 |
| `packages/client/connection/src/` 及对应 `types/` | 只装配共享 RPC/Fetch 注册与分发，不创建浏览器 Cookie 密钥、不依赖凭据或 WebServer。旧浏览器授权及独立 HTTP 通道接口明确拒绝；本地 IPC 身份与参数校验由 Electron 主进程和受限 preload 承担。修改由 `scripts/core/patches/connection-ipc.patch` 在重新导入时重放。 |
| `packages/subprocess/subprocess-local/src/runner-launch.ts` | 在 Electron UtilityProcess 内，通过 `MYDSH_NODE_EXECUTABLE` 使用应用主程序的 Node 模式启动私有 runner，并设置 `ELECTRON_RUN_AS_NODE=1`。不依赖全局 Node。 |
| `packages/llm/llm-pi-ai/` | 将 `@earendil-works/pi-ai` 升级至 `1.6.0` 并同步 `compat` 门禁与 `ToolCall` 参数类型，纳入 Gemini 4 系列模型目录；在 `provider.ts` 中开放 `google-generative-ai` 自定义协议并为 Gemini 4 `xhigh` 思考等级补充 `onPayload` 透传；在 `discovery.ts` 中接入 Google 原生 `/v1beta/models` 在线发现。 |
| 仓库根目录 `scripts/core/build-runtime.mjs` | 编译选定源码，补齐 subprocess runner 和 Session worker 的入口文件，解析实际依赖闭包并复制为无符号链接的离线安装包。 |
| 仓库根目录 `packages/runtime/` | 装配后台 Cordis，通过 Electron 消息承载 Remote；采用 DSH 本地凭据提供方，将 MyDSH 插件转换与自省工具经 `@mydsh/cli-bridge` 隔离挂载并通过 `mydsh plugin` 二级 CLI 暴露，选择 MyDSH 自己的数据与配置目录。 |
| 仓库根目录 `packages/plugin-sdk`、`packages/ui-sdk`、`packages/desktop-services` | MyDSH 插件公共接口、前端共享接口及桌面业务服务；不把这些产品接口反向伪装为官方 DSH 接口。 |
| 仓库根目录 `src/renderer/src/plugins/` | 前端 Cordis 与插槽装配，界面实现由 MyDSH 自己维护。 |

归档管理参考 DSH 社区归档插件的“恢复 / 确认后永久删除”交互，由 MyDSH 自有设置插件和 Desktop Remote 实现。`session-controller` 保留自己创建的 Agent 释放句柄；`session-persistence-jsonl`、`workspace`、`session-projection-cache` 和 `session-query` 增加各自拥有的删除清理入口及声明。MyDSH 归档先停止任务并释放会话；删除只允许已归档会话，先等待遗留任务停止和写入完成，不复制社区插件对内部对象的访问，也不装配其 WebUI 或 HTTP 通道。

重新导入上游时，先审查原来的 MyDSH 修改与生命周期修复，再合并新版源码。`scripts/core/import-dsh.mjs <明确的源码目录>` 是维护命令，会写入根目录 `packages/`、`vendor/`、来源清单和核心组合；普通构建只使用已固定的仓库内容。Remote 声明变化时必须同步生成 Typert 协议并验证前后台调用，不能只调整类型文件掩盖运行协议差异。

新增或由 MyDSH 继续维护的注释使用简体中文，说明接口、错误、取消、持久化与资源释放约束；第三方原始版权和来源说明保留，不批量翻译上游源码来制造无关差异。

## 许可证与随包材料

DeepSeek Harness 原始 MIT 许可证位于同目录 `LICENSE`，其中的版权与许可条款保持原文。根目录 `vendor/` 中各组件自带的许可证同样保留。其他 npm 依赖按自身元信息和许可证随依赖目录交付，不能因为它们属于间接依赖而删除许可材料。

核心构建把本文件、`LICENSE` 和 `manifest.json` 复制到离线核心 `licenses/deepseek-harness/`，并一起纳入安装清单的 SHA-256 校验。这样随 App 提供的初始包和安装到 `~/.mydsh/runtime/<版本>` 的核心都包含来源、修改说明及原许可。

MyDSH 是独立应用，保留来源和许可证不代表 DeepSeek 对此应用、转换结果或用户插件作出支持或背书。

## 模型与预设对齐

同一固定基线补齐 persona、持久终端、PTC Node 运行时、工作流、网页检索、用户问答、文件交付和 Cordis 运行时检查模块。内置预设收敛为 `standard`（标准模式）、`minimal`（极简模式）和 `gpt-coding`（ChatGPT）三套独立组合，按运行平台选择 bash 或 pwsh，Windows 下补充原生 `glob` / `grep`；共享注册表和持久化继续由宿主持有。`packages/preset/agent-presets/src/index.ts` 为已下线预设 ID 维护平滑回退映射（`efficiency` → `minimal`，`wish`、`mydsh`、`ptc`、`cordis`、`coding-focused` → `standard`），历史会话恢复与旧默认配置继续可用。

原创造模式的插件开发 Skill 与转换工具已收拢至 `@mydsh/cli-bridge` 的内置 `bundledSkillDir` 与 `mydsh plugin` 二级受控命令行，不加载 DSH profile 插件管理器或官方 WebUI。`ptc-runtime` 与 `cordis:mydsh-plugin-tools` 仅面向用户自定义或历史复制预设保留兼容。

三套内置预设的接口、二级 CLI 与设计来源见 [编码与调度模式说明](../../agent-modes.md)。`tool-fs` 提供不注册工具的定义工厂，Shell 和待办插件接受可选注册回调，使 MyDSH 可以调整模型参数而继续复用原执行函数、权限和文件观察策略；原有调用方式与其他预设不变。新增的工具装配与补丁格式为 MyDSH 的独立实现。

`file-reference-local` 与 `tool-subagent` 的 Agent 释放监听接受 Cordis Fiber 重复释放时的同步空返回，避免预设作用域已释放后再次调用 `.catch` 抛错；清理仍跟随既有 Agent 生命周期。

## Windows 适配记录

- `manifest.json` 的 `backports` 固定 Windows ACL 修复提交，`scripts/core/patches/windows-acl-delete.patch` 保留相对原基线的完整补丁，覆盖 Low integrity、工作区/临时目录 Low 标签及父目录 FILE_DELETE_CHILD 防护，不能拆开移植。
- `packages/runtime/subprocess.mjs` 经 Cordis 内置项替换子进程提供方，只为固定 ACL runner 注入应用 Node 模式。原 ordinary runner 与 PTC 继续使用既有 MyDSH 启动适配。ACL runner 进入 PTY 时由随包 PowerShell 承载控制台，解决 Electron GUI 可执行文件尚未接入时 ConPTY 已退出的问题；全部参数逐个转义，监督和清理仍归 DSH 子进程服务。
- `subprocess-local` 等待异步 ConPTY 分配 PID 后再捕获进程身份；输出订阅早于等待，取消和失败沿用统一释放路径。桌面终端和插件转换命令复用该服务。Windows 选用 node-pty 随包 ConPTY DLL，进程树清理后释放原生句柄；`scripts/core/patch-node-pty.mjs` 对固定 npm 版本 `1.2.0-beta.15` 的 `lib/windowsPtyAgent.js` 加入输出线程的兜底释放，避免没有尾部输出时泄漏。补丁在构建时严格匹配版本及原文，原许可证保留，修改后文件进入核心摘要。
- `pwsh-local/resolve.ts` 优先读取 MyDSH 固定的 PowerShell 路径，persistent terminal 与 Agent executor 共用解析逻辑。随包工具来源与许可证另见 `packages/runtime/windows-tools.json`。
- Session 永久删除保留写锁与代际清理，目录 `fsync` 仅在 POSIX 执行，避免 Windows 在文件已删除后误报失败。
- Windows 配置私有 ACL 与文件占用重试由 MyDSH 维护，未改造 DSH 的凭据公开契约；macOS 的文件权限语义保留。

## 会话停止与队列接续

`agent` 的 `CancelOptions` 增加仅在保留队列时生效的 `resumeInbox`，由普通 `session-controller` 的取消请求启用。`agent-loop` 等旧活动完成清理后再唤醒新驱动，使用新的取消信号按顺序处理排队消息；队列已清空时不唤醒。生命周期释放撤销接续并拒绝迟到唤醒，目标暂停和其他只保留队列的调用不自动接续。由真实 Agent 驱动测试及隔离 Electron 核心验收覆盖取消、重复停止、清空队列和退出路径。

## 轨迹、右栏与轮次文件审阅

参照官方 `ui-trajectory` 的紧凑表格、时间轴、局部检查器与 `ui-sidebar-browser` 的导航交互，在 MyDSH 自有 renderer 实现，没有复制或嵌入官方 WebUI。原始参数、嵌套工具与失败模型尝试直接消费已有 Session 事件。`agent-loop` 新增 `agent/turn-settled` 串行通知：所有退出路径在工具收束后、下一轮前完成；MyDSH Desktop Services 用它完成私有文件快照，快照失败不覆盖原始轮次结果。公开类型声明同步维护。


## GPT 编码预设与摘要参数

MyDSH 新增 `gpt-coding` 预设，复用现有工具执行、权限和 Session 生命周期。
GPT 首包曾临时关闭图片工具；图片请求链路接入后恢复既有 `view_image` 注册与能力门禁，并移除临时开关。
`compaction-basic` 的 `maxTokens` 支持显式 `null`，配置校验、精确模型覆盖和摘要调用同步处理，公开类型快照一并更新。
不配置该字段仍为 8192；只有显式关闭时省略请求与摘要调用记录中的硬上限，其他提供商默认行为不变。
该修改使不接受输出上限参数的 SIWC 订阅接口可以复用同一摘要后端，没有引入第二套压缩实现。

## 保留沙箱的自动审核提权

`packages/interaction/auto-review` 是 MyDSH 自有审批答复器，使用原 `tools/execute` 与 `approval/request` 扩展点；不启用上游关闭沙箱的 `auto` 集成。新预设 `auto-review` 固定为 `workspace-write + ask`。`llm` 和 DeepSeek 请求扩展类型增加辅助用途 `approval-review`，对应类型快照同步维护；Session 已知事件目录登记 `approval/reviewed`，支持审计持久化。没有修改原审批结果、Remote 方法或单次提权执行契约。具体范围和降级规则见 [自动审核说明](../../../packages/interaction/auto-review/README.md)。

## 模型错误诊断

模型错误出口保留提供商正文、HTTP 状态、请求 ID 和底层异常链；普通提供商的流内错误使用同一转换路径。认证字段在进入会话日志前脱敏，错误码和重试策略保持原语义。

## MyDSH 私有配置与派生进程

MyDSH 在装配时为既有文件后端增加私有配置路径检查，为自有 subprocess 适配器增加 macOS Seatbelt 读取保护。
`subprocess-local` 增加一个启动前处理点；PTY 在准备原 Shell 的状态集成后才应用宿主限制，
并使用处理后的可执行文件，避免包装命令造成状态跟踪丢失。默认后端原样返回启动参数。
公开类型快照同步维护；其他平台不据此宣称具有同等的读取隔离。
