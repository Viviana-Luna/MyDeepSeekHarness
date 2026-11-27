# MyDSH 发行说明

项目全名为 MyDeepSeekHarness，应用名为 MyDSH，Bundle ID 为 `io.github.viviana-luna.mydsh`。本项目提供 Apple Silicon macOS App / DMG 与 Windows 11 x64 应用目录 / 按用户安装的 EXE。Windows ARM64、Linux 发行及 Windows 10 支持承诺不属于首版范围。

## 用户更新

1. 在菜单中选择“MyDSH → 检查更新…”。
2. 有新版时，查看版本说明并点击“下载新版本”，系统浏览器下载当前平台及架构的安装包。
3. 下载完成后退出 MyDSH。macOS 打开 DMG，把 MyDSH 拖入 Applications 并确认替换；Windows 运行对应 EXE 完成覆盖安装，再启动应用。

应用只在用户点击时检查更新。检查期间菜单暂时禁用，请求超时或失败后可以重试；退出应用会取消未完成的检查。下载由浏览器管理，MyDSH 不自动退出或替换应用，也不运行安装助手。

版本信息来自固定仓库 `Viviana-Luna/MyDeepSeekHarness` 的 GitHub Releases，只使用该仓库对应版本下、匹配当前平台和架构的安装包地址；缺少对应安装包时不提示其他平台的版本。客户端按语义化版本比较最近 20 条公开 Release；预览版可以更新到较新的预览版或正式版，正式版只提示较新的正式版。

在正式发布公开 Release 与对应平台安装包前，菜单内的在线更新检查暂不会返回可下载版本；源码同步本身不包含安装包发布。

## macOS 构建与验收

```sh
pnpm install --frozen-lockfile
pnpm run check
pnpm run make:mac
pnpm run verify:package:made
pnpm run verify:package:runtime
```

`make:mac` 生成 App 和以下安装包：

```text
out/make/mydsh-macOS-arm64-<package.json version>.dmg
```

构建默认沿用 ad-hoc 签名，不需要开发者证书、更新私钥或额外的更新清单。它没有 Apple Developer ID 签名、公证或 stapling，因此首次安装时仍可能出现 macOS Gatekeeper 提示。安装包验收会检查应用身份、内容、代码签名结构，并只读挂载 DMG 检查内部应用。

`MYDSH_BUILD_VERSION` 可指定 App 的构建号；未指定时使用预览版本末尾的数字，正式版默认使用 1。更新判断使用 `package.json` 中的版本号，每次公开发布都应提高该版本号，仅增加构建号不会提示更新。

## GitHub Release

仓库内置 [.github/workflows/release.yml](../.github/workflows/release.yml) 双端自动发版工作流，默认生成 **Draft Release** 供维护者复核后手动发布：

1. 将 `package.json` 版本改为新的语义化版本（例如 `0.1.0-preview.6` 或 `0.1.0`），提交并推送到 `main`。
2. 推送与版本完全一致的标签（例如 `git tag v0.1.0-preview.6 && git push origin v0.1.0-preview.6`），或在 GitHub Actions 页面手动触发「发布安装包」工作流。
3. 工作流先校验标签与 `package.json` 版本一致，再并行在 `macos-14` 与 `windows-2025` 完成构建、全量检查、打包与安装包验收；双端全部通过后，汇总上传 `mydsh-macOS-arm64-<version>.dmg`、`mydsh-Windows-x64-<version>.exe` 与 `SHA256SUMS.txt`（公开仓库额外生成构建来源证明），并按版本号是否含预览后缀自动标记 Pre-release。
4. 在 GitHub Releases 页面核对草稿产物、校验和与版本说明，确认无误后点击发布。

如需本地手工发版，也可在对应平台自行运行 `make:mac` / `make:win` 及验收命令后，按上述精确文件名手动上传至对应标签的 Release（不生成或上传更新签名文件）。本地构建脚本本身不会创建仓库、推送 Git、上传产物或发布 Release，这些操作始终由维护者显式触发。

## 核心与用户扩展的交付

macOS App 与 Windows 应用目录均携带完整初始核心，不要求用户首次联网下载。构建时 `build:runtime` 按 `docs/upstream/dsh/manifest.json` 记录的 `packages/`、`vendor/` 模块及 `packages/runtime/roster.json` 的业务组合生成离线依赖闭包，包含 Cordis、内置业务插件、TypeScript、构建器和固定版本包管理器。

`lib/mydsh-runtime` 中的 `manifest.json` 记录平台、架构、应用版本、API 版本、数据格式版本及每个文件的大小、SHA-256 和执行权限；`payload` 是对应文件树。打包后这份初始核心位于 macOS 的 `MyDSH.app/Contents/Resources/mydsh-runtime` 或 Windows 的 `resources/mydsh-runtime`，原生库和工具链不放进 ASAR。制品不得依赖指向开发机 `node_modules` 的符号链接。ad-hoc 签名可能改写原生文件，打包脚本在签名后重新计算资源清单并封装应用签名，验收按最终文件校验摘要。

首次启动取得单实例锁后，将核心安装到 `~/.mydsh/runtime/<应用版本>`。安装器先在暂存目录复制并校验，再原子切换；取消、中断和失败保留既有核心与用户数据。下次启动只加载应用清单指定的版本。数据格式不兼容时拒绝启动，不能用旧核心猜测读取新数据。

安装或复用成功后，安装器清理其他版本的核心目录，避免升级残留累积磁盘占用：只删除带安装回执的目录，用户手工放入的陌生内容保留；旧目录先原子改名为 `.trash-` 待删标记再递归删除，清理中途退出留下的残留下次启动按前缀收走。清理失败只记录告警，不阻断本次启动。

对照 DSH 的 Cordis 启动路径，MyDSH 继续等待业务服务就绪后才进入工作台，后台失败与退出仍有界释放本应用资源。Windows 的主要额外耗时来自约两万个核心文件的完整性检查与复制：改为最多 16 项并发，小文件直接读取摘要，进度最多每 100ms 通知一次；首次安装仍检查源与目标，后续启动仍逐文件校验 SHA-256。取消或失败先等待所有并发操作结束，再回滚和清理。

同一核心包的本机隔离基准中，核心首次安装由 47.8 秒降到 11.6 秒，复用已有核心的检查由 13.2 秒降到 3.4 秒。这是核心安装阶段的测量，不包含 Electron、插件和工作台加载，也不保证每次启动耗时相同。真实运行日志分别记录 `coreInstall`、`coreLoad` 和 `total` 毫秒数。

核心文件每次启动仍核对全部 SHA-256。校验和安装最多同时处理 16 个文件，小文件直接读取，父目录创建共享进行中的操作；进度通知最多每 100ms 更新一次，阶段开始和完成必定发送。发生失败或取消后，等待全部在途工作结束再回滚和删除暂存目录，不能有后台复制继续写入已清理的路径。主进程输出核心检查／安装、后台加载与总启动耗时，便于区分首次安装与后续启动；加载继续采用固定 DSH 的 Cordis 装配、就绪后通知与有界退出机制，不加载 DSH CLI 或外部 profile。

新版应用提供相应核心版本，不单独查询核心在线更新。用户扩展位于 `~/.mydsh/plugins`，可独立安装、升级或停用；变更占用运行任务或未保存内容时延迟处理。应用更新不得覆盖 `data`、`config` 和用户转换工作区。

业务设置统一保存在 `~/.mydsh/config/settings.yaml`，凭据由 DSH 本地文件提供方保存在同目录的 `credentials.yaml`（macOS 使用 0600，Windows 使用仅当前用户与 SYSTEM 可访问的受保护 DACL），不访问系统钥匙串。DSH 数据导入暂停运行核心后联合提交 `data` 与 `config`；恢复必须发生在安装器创建空目录之前。维护路径与故障处理见[运行时维护与故障排查](dev.md)。

发行验收必须区分源码检查、核心制品检查和真实应用运行：

- `verify:standalone` 检查固定源码、无外部 DSH 启动路径、无官方 WebUI，以及已构建核心的逐文件完整性。首次构建前没有制品时，它明确报告只完成源码检查。
- 安装包必须包括核心清单、完整依赖闭包、原生库、插件工具链和许可证，并从包内资源完成首次安装。
- 真实应用验收使用隔离 `MYDSH_HOME`、Electron 用户目录及受限的工具搜索路径，证明不需要用户全局 DSH、Node 或 pnpm；不能用开发环境的依赖存在替代这个结果。
- 验证首次安装、重复启动、安装失败恢复、会话持久化、插件启停、转换产物和退出清理。模型与 AI 转换的真实链路需要有效配置，缺少配置时明确标记未完成。
- 临时截图、日志、导入夹具和安装环境位于系统临时目录，并在成功或失败的退出路径中清理。

## Windows 构建与验收

Windows 四边与四个可见圆弧必须显示对应的系统缩放光标，并能真实拖动缩放。直边命中宽度为 8 DIP，四角按到圆弧的距离命中；同步处理 Chromium 内容子窗口的原生命中和悬停，避免只有父 HWND 的测试通过。100% 与 150% 均须完成实际鼠标验收；启动小窗、最大化及全屏不保留缩放区，实色与高对比度仍能正常缩放。背景视觉、父窗口回调与内容子窗口回调分别按窗口生命周期清理。

Windows 原生背景构建需要 Visual Studio C++ Build Tools 与包含 C++/WinRT 的 Windows SDK；稳定 Node-API 头文件是开发依赖，模块使用静态 CRT，不要求用户安装编译器或 Node。安装包验收需要开发机安装完整 7-Zip（`7z.exe`，Windows CI 镜像已提供），应用自身不依赖它。

Windows 首版固定 x64，沿用 Electron 主进程、utilityProcess、Remote/Typert/Gateway 与独立用户目录。窗口使用右侧三个自定义按钮；Windows 11 22H2 起使用与 18px 外缘共用几何裁剪的原生 HostBackdrop 模糊背景，系统减少透明、高对比度或合成不可用时释放原生视觉并使用实色。整窗 Acrylic 不受 `SetWindowRgn` 的可见裁剪约束，不能继续将其与自定义圆角叠加使用。命中区域不能截断圆弧的抗锯齿覆盖；前景按原生像素尺寸裁剪，消除分数缩放时的视口取整误差。macOS 继续使用原生按钮与透明窗口。后台验收检查画布 alpha、明暗主题、布局、裁剪投影、降级与自定义关闭保护；Windows 离屏页可能仍按 1 倍绘制，不能替代实际分数缩放验收。前台 `--foreground` 验收严格核对前景与原生窗口像素对齐，并触发真实最小化、最大化与还原；`verify:window` 额外检查实际桌面四段完整圆弧、单像素覆盖、圆弧外颜色泄漏与背景释放。

```sh
pnpm install --frozen-lockfile
pnpm run build
pnpm run check
pnpm run verify:core
pnpm run verify
pnpm run make:win
pnpm run verify:package:win -- --made
pnpm run verify:package:win -- --made --foreground
```

应用目录为 `out/MyDSH-win32-x64/`，安装包为 `out/mydsh-Windows-x64-<版本>.exe`。NSIS 安装器使用当前用户权限，不提升权限、不修改系统 PATH，卸载保留 `~/.mydsh` 与用户数据。默认不签名、不发布；公开发行前仍需在独立 Windows 11 测试账户中验收安装、覆盖升级和卸载。

`packages/runtime/windows-tools.json` 固定官方 PowerShell ZIP 与标准 MinGit 的版本、下载地址、SHA-256 和许可证。只在构建阶段下载并校验，运行时不联网安装；所有解压文件、许可和工具清单一起进入核心摘要。第三方 npm 包保留必要的 `src`（例如 koffi 的实际入口），不做全局源码目录裁剪。Agent Shell、持久 Shell 和默认用户终端使用同一个随包 PowerShell；应用 Git 调用使用随包绝对路径。用户配置的项目任务仍由自己的可执行文件与环境决定。

内部 ordinary runner、Windows ACL runner、PTC 和转换器使用应用可执行文件的 Node 模式，utilityProcess 本身不启用该模式。普通命令归属 Windows Job，终端使用 DSH 的 ConPTY 进程身份追踪；终端分配等待 PID 就绪，关闭等待整个可观察进程树清理。ConPTY 无法保证清理主动脱离可观察父子树的进程，这一限制不以 Job 的保证来表述。

Windows ACL 采用固定上游 Low integrity 与父目录删除权限修复组合，仍如实报告 `partial`：限制写入、删除和移动，不承诺读取或网络隔离；沙箱不可用时拒绝受限执行。工作区授权按上游机制常驻，会话临时目录授权随生命周期撤销。凭据保留原文件提供方，配置目录的受保护 DACL 只允许当前用户与 SYSTEM，临时文件和原子替换后的文件继承同一边界。

核心安装拒绝平台或架构不匹配；旧安装收据缺少新字段时可恢复并重新安装，不覆盖用户数据。Windows 原子替换遇到短暂 EACCES、EBUSY 或 EPERM 时有界重试，仍失败则保留原目标并报告错误。源码和打包验收均清空开发工具 PATH，使用临时用户目录并在退出后清理；Windows 制品验收设置 150% 缩放，最终几何验收须同时使用 `--foreground`。`--made` 从实际 EXE 中取出应用归档及 Nsis7z 插件，在临时目录编译只负责解包的 NSIS 程序，用制品自己的插件解码，逐文件核对摘要后运行解出的应用；不写安装注册表或快捷方式。不能用现代 7-Zip 直接解开应用归档来替代安装器解码验收。

Windows 安装包固定使用 BCJ 压缩过滤器。electron-builder 26.15.3 使用的新 7-Zip 会为二进制自动选择 ARM64 / BCJ2，而安装时的 Nsis7z 无法完整解码，可能返回成功但漏文件；详见[上游问题记录](https://github.com/electron-userland/electron-builder/issues/9983)。构建脚本强制使用兼容过滤器，仍保留完整性校验，解压退出码不能单独作为验收依据。
