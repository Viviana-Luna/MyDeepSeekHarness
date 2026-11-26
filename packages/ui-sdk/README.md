# MyDSH 前端 SDK

`@mydsh/ui` 描述宿主实际导出的界面 API。运行时由插件加载器提供同一份 React、Cordis 和 SDK 实例；这个包只携带类型，不另建可执行实现。构建前运行 `node packages/ui-sdk/build.mjs`，脚本从 `src/renderer/src/plugins/sdk.ts` 生成公开接口可达的声明闭包，`lib/exports.json` 记录同批构建的运行导出。

公开接口包括 `MydshSlots`、`useUiRuntime`、`useModes`、`useIslands`、`PluginActions`、`PluginBoundary`、`useWorkspaceSnapshot`、`useWorkspaceStore`、`useProjectWorkspace` 、`getDesktopBridge` 、`callRemote` 和 `followRemote`。插槽注册方式见 [界面插件说明](../../src/renderer/src/plugins/README.md)。返回值和方法类型来自真实源码，不能依靠声明调用宿主没有实现的功能。

## 前后台分别检查

前端配置继承 `@mydsh/ui/tsconfig`，`include` 只列前端入口及其模块：

```json
{
  "extends": "@mydsh/ui/tsconfig",
  "include": ["src/client.tsx", "src/client/**/*.ts", "src/client/**/*.tsx"]
}
```

这份配置使用浏览器标准库和 `types: []`，不自动引入 Node 全局或后台 SDK 的 Cordis 声明。前端源码从 `@mydsh/ui` 和 `@deepseek-ai/cordis` 导入所需接口；不要导入 `@mydsh/sdk`、后台入口或后台声明文件。后端另建 `tsconfig.backend.json`，按需从 `@mydsh/sdk` 引用后台服务。

转换器通过插件的 `package.json` 指定两个边界，类型检查通过后才构建入口：

```json
{
  "mydshBuild": {
    "backend": "src/index.ts",
    "frontend": "src/client.tsx",
    "tsconfigBackend": "tsconfig.backend.json",
    "tsconfigFrontend": "tsconfig.frontend.json"
  }
}
```

只有一个入口的插件只填写对应字段。原有 `tsconfig` 字段仅作为未提供专用配置时的回退；包含前后台入口的插件应显式分开配置，防止 Cordis 的后端服务声明进入浏览器检查。

构建时将 `react`、`react-dom`、`react/jsx-runtime`、`react/jsx-dev-runtime`、`@deepseek-ai/cordis`、`@mydsh/ui` 保持外部引用，其余浏览器依赖打进插件产物。宿主的 `mydsh-plugin:` 协议负责读取已启用的已安装版本，扩展无需访问源码目录。

业务调用使用 `callRemote(endpoint, args, signal?)`；逻辑流使用 `followRemote(endpoint, args, onItem, onError)`。方法必须已由运行时公开并通过 Typert 校验，系统与管理接口不能通过它调用。订阅返回取消函数：在 `apply` 中用 `ctx.effect(() => followRemote(...))` 登记，在 React 组件中用 `useEffect` 返回它。停止订阅只释放本次流；运行时恢复后由通信层重新打开流并取得基线，单次请求不会重放。单次调用可传入 `AbortSignal`，取消后立即以 `AbortError` 拒绝，并通过请求编号向后台传播取消请求；Signal 不跨越 Electron 桥。插件应在生命周期清理时 abort 仍在执行的调用。

`MydshSlots` 提供按工具名称选择的 `registerToolResult`、由外壳管理焦点的 `registerOverlay`，以及生命周期绑定的 `blockSwitch(reason)`。通知通过 `registerAction('shell.notifications', id, component, order)` 贡献，在外壳的有序 `aria-live` 区域展示。具体作用域与占用用法见界面插件说明。
