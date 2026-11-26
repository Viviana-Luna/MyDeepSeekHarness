# MyDSH 插件与 AI 转换开发指南

MyDSH 将核心插件安装到 `~/.mydsh/runtime/<核心版本>`，用户扩展安装到 `~/.mydsh/plugins/<插件标识>/<版本>`。核心由应用整体更新；扩展可以独立安装、启停和恢复上一版本。

## 信任与生命周期

用户扩展属于受信任代码。后台入口运行在 MyDSH Runtime，前端入口接入同一组件树。Cordis 管理依赖和资源归属，但不隔离恶意代码。安装意味着允许该扩展在其运行进程中执行原生能力；`capabilities` 是供用户理解的声明，不是操作系统沙箱。

后台入口导出 Cordis `apply(ctx, config)`。使用 `ctx.effect()`、`ctx.on()`、`ctx.plugin()` 注册资源，卸载时必须等待异步释放。`config.home` 是该插件的数据目录；不要将数据写进插件代码目录。

```ts
export function apply(ctx, config) {
  // 资源跟随当前插件释放，停用后不遗留后台定时器。
  ctx.effect(() => {
    const timer = setInterval(() => { /* 在这里执行插件工作。 */ }, 1000)
    return () => clearInterval(timer)
  })
}
```

## 清单与入口

每个产物根目录必须包含 `mydsh.plugin.json`：

```json
{
  "id": "example-file-view",
  "name": "文件侧栏",
  "version": "1.0.0",
  "apiVersion": 1,
  "backend": "dist/backend.js",
  "frontend": "dist/frontend.js",
  "styles": ["dist/frontend.css"],
  "dependencies": {},
  "capabilities": ["workspace.read"]
}
```

后台和前端入口至少提供一个。`styles` 可选，列出前端随插件加载并在卸载时移除的 CSS；没有样式文件时省略。标识只能含小写字母、数字、点、下划线和连字符，`mydsh.*` 留给核心插件，用户扩展不能使用；版本使用三段明确版本号，可带预发布后缀。`dependencies` 描述其他 MyDSH 插件，允许引用核心标识，值为精确版本或 `*`；npm 编译依赖仍放在 `package.json`。

`apiVersion: 1` 声明兼容 MyDSH API 的第 1 个主版本，当前运行核心只接受这一范围。可选 `config` 是不超过 64 KiB 的 JSON 对象，作为后台 `apply(ctx, config)` 的初始配置；`home` 始终由宿主确定。需要用户长期修改的设置，应注册到 `ctx.settings`，使用既有设置页与持久化服务，不把用户配置写回插件代码。

入口必须留在包内；安装产物不接受符号链接或特殊文件。后台使用 ESM。前端脚本通过 `globalThis.__MYDSH_PLUGINS__.define(id, factory)` 登记 CommonJS 工厂，工厂导出 Cordis 插件。转换构建会生成该包装。

React、React DOM、Cordis、`@mydsh/ui` 和 `@mydsh/sdk` 使用宿主共享实例。不要将这些模块再次打进前端包，不要直接调用 Electron 或导入其他插件的私有文件。界面扩展通过 MyDSH UI SDK 的工作模式和插槽接口注册。

## 安装与恢复

`mydshPlugins.list()` 返回内置与用户插件的名称、来源、版本、启用状态和错误。`install(directory)` 与 `update(directory)` 接收已经构建的插件目录，先复制候选版本、校验清单和依赖，再切换装配与持久索引。新版本启动失败时恢复原版本；同版本修改必须提升版本号，避免 Node 模块缓存混用。

`enable(id)`、`disable(id)`、`uninstall(id)` 和 `rollback(id)` 管理用户扩展。依赖仍启用时先停用依赖方。任务或编辑状态占用时，停用、升级和卸载登记为待重启操作。核心插件不允许通过这些方法修改。恢复插件版本不会撤销插件已经产生的文件写入或网络请求。

## Agent 转换工作流

转换器提供准备、验证和安装能力，不会把未改写的官方插件伪装成兼容产物：

1. `mydshConverter.prepare(source)` 接收本地目录、HTTPS Git 地址与 ref，或 npm 包名与精确版本。返回任务标识、固定来源版本和独立源码目录。
2. Agent 用普通文件工具阅读与修改返回的源码。删除官方产品私有依赖，改成 MyDSH 公开服务和浮岛插槽，补充中文注释。原始来源保持不变。
3. 在 `package.json` 中声明 `mydshBuild`，提供 `mydsh.plugin.json` 和可执行类型检查的 `tsconfig.json`。
4. `mydshConverter.validate(id)` 安装编译依赖，执行 TypeScript 检查、esbuild 构建和 Node 语法检查；后台声明 `Remote` 时还执行严格 Typert 生成。依赖安装禁用包脚本，转换器不会执行原插件的任意构建脚本。
5. 对照用户需求完成实际功能检查。静态验证不证明插件业务正确，不证明模型重写已经完成。
6. `mydshConverter.install(id)` 核验源码及产物摘要未变化，再交由插件管理器安装。

```json
{
  "type": "module",
  "mydshBuild": {
    "backend": "src/index.ts",
    "frontend": "src/client.ts",
    "tsconfig": "tsconfig.json"
  }
}
```

不需要的入口可以省略。构建产物放在转换任务的 `artifact` 中，来源记录保存在 `mydsh.provenance.json`。失败保留源码供继续修复；取消会终止工具子进程组。修改源码或产物后必须重新验证。

前后台同时存在时，建议分别提供 `mydshBuild.tsconfigBackend` 与 `mydshBuild.tsconfigFrontend`。未指定时才使用上例的 `tsconfig`。前端配置只包含前端源码并使用 `@mydsh/ui`，后台配置只包含后台源码并使用 `@mydsh/sdk`，避免两种 Cordis Context 的服务声明互相合并。Typert 只分析后台配置。

## 公开自有 Remote 方法

只使用现有服务的插件无需生成自有 RPC。需要公开后台方法时，通过 `@mydsh/sdk` 的 `Remote` 和 `TypertRemoteService` 声明，并在 `package.json` 增加明确导出：

```json
{
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./dist/backend.js" },
    "./typert": { "types": "./lib/typert.host.d.ts", "default": "./lib/typert.host.js" },
    "./remote": { "types": "./lib/typert.remote-client.d.ts", "default": "./lib/typert.remote-client.js" }
  },
  "files": [
    "lib/typert.host.js", "lib/typert.host.d.ts",
    "lib/typert.remote-client.js", "lib/typert.remote-client.d.ts"
  ]
}
```

这类插件的后台源码放在 `src/` 下，所有公开参数、返回值和服务成员写出明确类型。自定义边界类型放在公开的非根子路径，例如 `./types`，并同时提供对应生成文件的导出。导出不能指向产物中不存在的源码、通配路径或私有文件。

转换器仅为当前插件创建临时分析工作区，使用固定协议和 SDK 的声明快照识别符号，不再次编译所有核心插件。生成的参数和返回值 codec 都使用 `strict` 模式；任何生成错误都会阻止安装。插件管理器加载标准 `./typert` 产物，通过 `ctx.typert.register()` 登记；更新失败、停用和卸载时与插件一起释放。此机制沿用同一 Gateway，不建立第二套 RPC。

工具链随运行核心的 `node_modules` 目录安装，包含 TypeScript、esbuild 和 npm，使用应用的 Node 执行能力。无需全局 Node、pnpm 或 DSH；下载外部依赖需要网络。Git 来源使用 macOS 的 Git，缺少 Git 时应改用 npm 或本地源码。需要安装脚本的原生依赖不能绕过限制，应移植到现有宿主服务，或明确列为未支持能力。

转换器的模型工具只接受本应用内部 Agent 的调用，不提供外部 MCP 接口。插件无法通过转换器改写运行核心；缺少公共能力时应报告缺口。

模型可调用的工具名是 `converter_prepare`、`converter_validate`、`converter_install` 和 `converter_list`。它们通过现有 `ctx.tools` 注册，继续经过 Agent 预设、权限门禁、取消和调用日志。安装使用现有审批服务确认受信任代码执行；没有审批服务时拒绝安装，不另建绕过通道。

插件后台代码引用 `@mydsh/sdk`。它导出当前核心的 Cordis、配置 schema、工具定义和 Remote 声明；详情见 `packages/plugin-sdk/README.md`。扩展内对 Cordis 和 SDK 的导入由当前 Runtime 的局部解析钩子定位到核心唯一实例，其他依赖保持 Node 原有解析规则。

## 隔离转换验收

完成应用构建后，可先运行 `electron scripts/verify-plugin-conversion.mjs --check-setup`。这一步不读取用户模型配置或凭据，不访问网络，检查真实核心装配、Agent 工具范围、共享 SDK 构建及带会话的文件 Remote。随后用明确的本地夹具检查同一套 React 模式挂载和卸载流程；夹具通过不代表官方插件已由 AI 转换。

`--use-dsh-model` 会读取现有 DSH 默认模型配置，且要求 `baseURL` 精确等于 `https://api.commandcode.ai/provider/v1`；不匹配时在读取凭据前停止。对应凭据只在父进程与隔离 Runtime 的内存之间传递，供模型适配器发起请求，不写入普通配置、日志或 Agent 上下文。运行前应确认这个模型服务、发送的源码和调用预算；脚本限制为一个会话、六次请求、六分钟转换时限，每次最多六千输出 token。四万 token 是基于发送前估算与已返回供应商用量的预算门槛，不能保证供应商最终计费绝不超过四万。可通过 `--source=/绝对路径` 指定官方文件侧栏源码目录。

该脚本复制运行核心到临时目录，不安装到真实 `~/.mydsh/plugins`，不回写原 DSH 配置或凭据。模型只能读写转换源码副本，不能调用 shell 或读取私人配置；安装继续走正常审批记录。随后在真实 Renderer 中加载转换产物，使用共享 React、SDK 和真实会话挂载模式组件，等待文件 Remote 返回的文件名出现在 DOM；卸载插件后检查组件、会话订阅、插槽贡献和调用记录全部释放。此项检查不代替完整窗口的视觉验收。失败、取消和正常退出均清理本次临时核心、会话、产物和日志，原始源码通过摘要对照确认未变。
