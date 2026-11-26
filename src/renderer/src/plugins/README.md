# MyDSH 界面插件

前端使用一份 Cordis 上下文和一份 React 实例。内置会话、文件、Git、终端和设置分别作为独立 Cordis 插件通过 `MydshSlots` 注册；对话与轨迹因共享同一份 Session 日志归属会话插件。浮岛外壳只消费贡献，不导入具体业务组件。后台拥有项目和会话事实；前端 Provider 保存视图投影和编辑缓冲，插件复用这些状态。

## 上游来源

`slot-core.ts` 的普通插槽算法移植自 DeepSeek Harness 提交 `ddefc45fbc7f8e46dd73185e68295696d1297887` 的 `packages/client/ui-slots/src/index.ts`，使用 MIT 许可证，完整文本位于仓库 `docs/upstream/dsh/LICENSE`。本地版本保留 `single`、`list`、`keyed`、声明代次、级联释放、过期检查及微任务批量通知，未移植没有消费者的组件工厂、链路匹配和 Store 轴。`registry.ts` 的 Service 调用者绑定方式遵循上游 `ui-renderer` 的生命周期设计。

## 插件入口

源码导出标准 Cordis `apply(ctx)`；构建时将 React、React DOM、Cordis 和 `@mydsh/ui` 外置。发布的单入口脚本采用下列注册形式，由转换工具链生成，不要手写 `eval` 或远程脚本加载：

```js
globalThis.__MYDSH_PLUGINS__.define('example.notes', (require, module, exports) => {
  // 构建器写入的 CommonJS 产物。
})
```

主进程按安装清单生成 `mydsh-plugin://插件标识/版本/入口`。加载器只接受这类地址并核对标识和版本。共享依赖由宿主传给模块工厂，其余依赖必须打入插件产物。

```tsx
import type { Context } from '@deepseek-ai/cordis'
import { useWorkspaceSnapshot } from '@mydsh/ui'

function Notes({ placement }: { placement: 'main' | 'right' }) {
  const { selectedSessionId } = useWorkspaceSnapshot()
  return <section data-placement={placement}>当前会话：{selectedSessionId ?? '未选择'}</section>
}
function Icon() { return <span aria-hidden="true">记</span> }

export const inject = ['mydshSlots']
export function apply(ctx: Context) {
  ctx.mydshSlots.registerIsland({
    id: 'example.notes', label: '笔记', icon: Icon, component: Notes,
    placements: ['main', 'right'], scope: 'session',
  })
  ctx.mydshSlots.registerMode({
    id: 'example.notes', label: '笔记', icon: Icon,
    mainIslandId: 'example.notes', defaultRightIslandId: 'session-info',
  })
  ctx.mydshSlots.addStyle('.example-notes { padding: 16px; }')
}
```

`registerIsland` 声明可展示能力、允许位置和 `session`、`project` 或 `window` 作用域；组件从 `placement` 与 `visibility` 得知当前呈现状态。`registerMode` 声明模式入口、中央浮岛、左侧导航和首次右侧建议，还可声明 `tooltip` 组件、`sessionHome`（切换会话时进入）、`collapsePanelsOnEnter`（暂存并收起两侧）和 `showComposer`（呈现输入区）。多个模式声明 `sessionHome` 时取贡献顺序中的第一个；没有声明时取第一个可用模式。右侧建议只用于尚未建立现场的会话，不能在模式切换时覆盖用户选择。`registerSettings` 添加设置分类；`registerAction` 可向 `composer.actions`、`composer.readings`、`workspace.toolbar`、`workspace.alerts`、`session.info`、`shell.notifications` 注册组件，其中 `workspace.alerts` 和 `session.info` 按项目重建。`registerToolResult(toolName, component)` 按工具名称选择输出视图，未匹配或渲染失败时保留原文本。`registerOverlay({ id, label, component })` 提供浮层内容，外壳负责焦点限制、Escape 和关闭后恢复焦点。注册操作和 `addStyle` 都通过调用插件的 `ctx.effect` 回收。异步任务、事件监听和其他外部资源同样必须由插件登记释放。

外壳只创建当前主区、当前右侧或声明了 `preserveWhenHidden` 的浮岛。右侧选择不会形成前后层；离开主区和右侧且没有保留声明时立即卸载。`preserveWhenHidden` 只用于已经证明需要连续现场的能力，插件停用时仍照常卸载。内置终端是窗口级单实例，直到用户实际打开或运行任务才创建；内部按项目保留终端组，切换项目只改变可见分组，用户关闭标签或退出 MyDSH 才结束对应 PTY。

需要把同一浮岛在主区和右侧之间换位时，先从 `WorkspaceStore.captureIslandCollaborationIntent()` 取得会话与右侧选择代次；异步读取应在发起前捕获，成功后再调用 `presentIslandCollaboration(intent, modeId, 'main' | 'right')`，同步按钮可连续调用两步。插件只提供自己的模式 ID 和目标位置，工作台从模式贡献取得中央浮岛，检查位置与代次后换位；无效或过期请求返回 `false` 且不改布局。主区换位时暂用会话入口的浮岛作为右侧伴随视图，返回会话入口后恢复之前的右侧选择。

浮岛、导航、设置页和插件图标的组件错误由区域错误边界呈现，不阻止其他浮岛工作。注册入口会先拒绝空标识、未知位置或作用域、重复位置和不可渲染组件；模式引用的中央或右侧贡献尚未加载、已经卸载或不支持目标位置时，外壳显示可用回退，不复制实例。这只是故障隔离；原生插件是受信任代码，Cordis、元数据校验和错误边界都不是安全沙箱。

## 公开业务调用与类型检查

前端通过 `callRemote(endpoint, args, signal?)` 调用插件公开的后台方法，通过 `followRemote(endpoint, args, onItem, onError)` 订阅逻辑流；参数沿用 Typert 生成的命名参数对象。生命周期内注册订阅时使用 `ctx.effect(() => followRemote(...))`，组件内则通过 `useEffect` 的返回值取消。插件停用后不要保留后台订阅。运行时恢复后，通信层重新打开逻辑流并接收新的状态基线；单次调用不会自动重放。可取消的单次调用传入 `AbortSignal`，在插件释放时调用对应 `AbortController.abort()`；Signal 留在前端，由请求编号关联后台取消。

随包 `@mydsh/ui` 从实际宿主源码生成接口声明，前端单独继承 `@mydsh/ui/tsconfig`。前后台 `mydshBuild.tsconfigFrontend`、`mydshBuild.tsconfigBackend` 分别检查，配置示例见 [前端 SDK](../../../../packages/ui-sdk/README.md)。

## 作用域与占用

输入动作以当前会话（或新会话草稿所属项目）为 key，工具栏以当前项目为 key；切换会重建贡献组件并执行它们的 React effect 清理。工具结果以会话和调用标识隔离，通知与浮层属于应用作用域。右侧外壳按会话记住一个当前选择，业务数据仍归贡献声明的真实作用域所有；切换会话统一回到中央对话，再恢复目标会话的右侧选择。组件内的订阅应由 `useEffect` 返回取消函数；插件级订阅仍由 `ctx.effect` 回收。

扩展持有未保存缓冲或尚未结束的专属资源时，调用 `ctx.mydshSlots.blockSwitch('笔记尚未保存')`；返回的函数解除占用，插件卸载也会自动清理。React 组件可用 `useEffect(() => dirty ? ctx.mydshSlots.blockSwitch('笔记尚未保存') : undefined, [dirty])`。外壳聚合原因交给主进程，插件管理和 AI 转换安装使用同一份占用判断。

升级候选的前端入口失败时，加载器仅在存在 `previousVersion` 的更新中请求插件管理器恢复上一版。恢复后明确显示失败原因；首次安装失败不会请求不存在的历史版本。同一个失败入口不会因清单广播反复尝试，停用再启用或重启后可以重新加载。
