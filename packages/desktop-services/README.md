# MyDSH 桌面业务服务

这个包将现有文件、Git、索引和 PTY 实现放在运行时。源码分别位于 `src/runtime/workspace` 与 `src/runtime/terminal`，此目录只维护 Cordis 生命周期和公开 Remote 包装；主进程负责发送方校验、原生对话框和 Finder 等系统操作。

`build.mjs` 复制必要后台源码到系统临时目录，先做独立 TypeScript 检查，再复用固定版本 Typert 分析器生成调用参数、结果和逻辑流契约。它不引用前端 tsconfig、不分析 renderer、不手写反射替代契约，临时目录总是在 finally 删除。

构建核心依赖之后调用 `buildDesktopServices(toolchainDirectory, destinationDirectory)`，或运行 `node packages/desktop-services/build.mjs`。宿主先注册产物 `@mydsh/desktop-services/typert` 的 `TYPERT`，再装配 `@mydsh/desktop-services`，传入随应用交付的 `ripgrepPath`。

- `mydshWorkspace.sync(sessions, roots)`：由可信主进程更新完整项目基线，返回规范的项目描述符；普通 renderer 不得调用。
- `mydshWorkspace.call(projectId, operation, payload)`：已登记项目范围内的文件、Git 和索引操作。原有路径、输入大小、文件 revision 与 Git 校验保持不变。
- `mydshWorkspace.resolveDroppedFiles(projectId, paths)`：校验显式项目文件引用，拒绝项目外路径、目录和符号链接。普通拖入附件使用核心 `fileUploads/upload`，不经过这个项目路径接口。
- `mydshWorkspace.clear()`：停止索引并撤销目录授权；只供管理流程使用。
- `mydshTerminal.create/ready/write/resize/close`：窗口编号由主进程提供，按拥有者控制 PTY。
- `mydshTerminal.events(signal)`：可取消的终端事件逻辑流。队列受事件数量和字符数上限约束，积压时报告错误。取消订阅不等于关闭终端；停止服务才释放全部 PTY。

上述方法使用同一 Gateway 传输。后台服务可通过 `ctx.mydshWorkspace.registry.resolveProjectDirectory(projectId)` 取得已授权的项目根，不建立主进程注册表副本。
