# MyDSH 后台插件 SDK

此包由 MyDSH Runtime 提供唯一实例。插件引用 `@mydsh/sdk`，不自己安装或打包另一份 Cordis。

- `Context`、`Service`、`definePlugin`：沿用 Cordis 的服务注入与可撤销资源生命周期。
- `schema`：当前运行核心的 Schemastery 配置校验。
- `defineTool`、`validateArgs`：当前工具注册表的类型化定义与参数校验。使用 `ctx.tools.register()` 后经过现有 Agent 权限和审批流程。
- `Remote`、`RemoteScope`、`TypertRemoteService`、`bindTypertRemote`：复用当前 Typert 服务声明，不创建另一条 RPC 通道。

转换器检测后台的 `Remote` / `RemoteScope` 声明后，会使用随包 Typert 编译器生成 `./typert` 和 `./remote` 产物。清单缺少这些公开导出、方法缺少明确类型或引用私有边界类型时，构建失败；不回退为源码反射。插件管理器把生成契约和后台入口挂在同一个 Cordis 生命周期中，停用后同时释放。

公开 Remote 的代码使用 `src/` 布局，并在包清单中声明 `./typert` 指向 `lib/typert.host.{js,d.ts}`、`./remote` 指向 `lib/typert.remote-client.{js,d.ts}`，将四个文件列入 `files`。后台公开的自定义入参或结果类型必须从非根类型子路径导出。详细清单见插件开发指南。只调用已有公开服务的插件不需要声明自己的 Remote，也不需要这些生成产物。

后台插件接收 `MydshPluginConfig.home`，持久内容写到这个目录。通过 `ctx.effect()` 挂载定时器、流和外部连接，返回释放函数；释放必须等待资源退出。

前端扩展使用独立的 `@mydsh/ui`，通过浮岛插槽注册模式、动作和设置页。此后台 SDK 不提供 Electron 通用 IPC，也不暴露任意桌面系统操作。
