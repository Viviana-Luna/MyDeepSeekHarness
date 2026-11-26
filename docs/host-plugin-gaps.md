# 历史记录：外部 Host 客户端阶段的插件能力

本文记录 MyDSH 连接外部 DSH 时的调查基线、接口计数和当时的验收方式。下文的外部 Host、端口、Cookie、禁止随包核心等限制已经由独立运行时方案替换，不是当前开发规则，也不表示当前应用仍采用这些路径。文中记录的“插件状态与操作”通用面板已移除。保留本记录用于说明 Session 投影、事件与操作白名单的来源；当前进程和目录边界见[运行时维护与故障排查](dev.md)，扩展开发见[插件开发指南](plugin-development.zh.md)。

桌面端支持 DSH 插件通过公开协议提供的非 UI 能力，使用自己的 renderer 展示状态和执行已适配的操作，不加载插件自带的 WebUI。本次接通了会话投影、现有 Host 事件和目标／子智能体 RPC；任意插件事件与任意插件动作仍需要上游提供公开、受授权的契约。

## 三个问题的结论

| 问题 | 根因 | 当前实现 | 仍需上游提供 |
| --- | --- | --- | --- |
| 一：会话投影被丢弃 | 解析层只保留 `title`、`modelSelection`、`permissions`，其他实时状态丢失 | 按会话保存有界 JSON 投影，接收基线与增量，提供折叠查看入口 | 无；插件需要按公开 Session projection 协议提供状态 |
| 二：Cordis 事件消费不完整 | Host 转发范围固定，桌面也漏消费了对现有功能有用的事件 | 设置、模型适配器、凭据引用和目标激活状态变化驱动刷新 | 插件自定义事件的注册、授权与订阅机制 |
| 三：插件 RPC 不可达 | 桌面固定操作映射没有覆盖插件自己的接口 | 适配目标 7 项、子智能体 3 项公开操作，并提供桌面操作面板 | 可发现、带参数和结果描述、经过授权的插件动作清单 |

以上数量按 DSH `0.1.5-rc.2` 的公开 Remote 声明核对：15 个包声明 84 个方法；这是包内静态声明，不代表某个 profile 实际加载的接口数量。桌面本次增加 10 项操作，白名单从 45 项变为 55 项。历史交接中的 105 个 Host 接口、43 个桌面操作不适用于这份基线。

## 一：接收并展示未知会话投影

### 原因与实现

Host 已经通过 `session/control` 基线及增量、`session/follow` 快照提供投影。原来的解析分支只接受三个专用键，因此初始列表可能有值，实时变化却进不了 renderer。插件可以继续注册新投影，逐个补键名无法解决根因。

[共享投影契约](../src/shared/plugin-projections.ts) 的 `parsePluginProjectionChange` 和 `PluginProjectionCache` 提供通用通道；[Session 解析](../src/shared/session-live.ts) 保留专用键的严格校验；[实时流](../src/main/host/session-stream.ts) 的 `emitProjectionBaseline` 区分完整快照与增量。[工作台 Store](../src/renderer/src/models/workspace/store.ts) 合并列表、页面和流中的投影；[Host RPC 适配器](../src/main/host/host-client.ts) 对一次性读取应用相同预算，防止列表绕过流的限制。

规则如下：

- 单值最多 128 KiB；单会话最多 128 个未知键、1 MiB；一个缓存最多 256 个会话、8 MiB。值只允许有限深度的 JSON，不接受循环引用、非有限数字或特殊对象。
- 基线维护 `asOfSeq`，每个键另外维护自己的水位。同一序号的不同键可以同时接收，旧增量不能覆盖新值；迟到基线保留比它更新的键，并删除基线已经不再包含的旧键。
- 空会话快照允许 `asOfSeq = -1`，增量必须是非负安全整数。超大值、非法值和超出容量的条目被省略；有可用会话快照时，界面显示省略数量，不输出值内容到诊断日志。
- 流重置和 Host 恢复清理缓存，会话移除清理对应状态。切换会话仍复用物理连接，选中会话的旧 follow 回调不能污染新会话。
- `title`、`modelSelection`、`permissions` 继续使用原有专用通道；无效的已知投影不会退回通用通道。

用户从会话信息中的“插件状态与操作”打开面板。未知键默认折叠，展开后以纯文本 JSON 显示，不执行 HTML，也不把投影内容解释为动作。

### 验收边界

现有 Session 流夹具覆盖 control 基线与 follow 快照的通用投影；解析与 Store 验证覆盖同序号多键、乱序、空基线、重连清理、超大值、超多键和非法 JSON。真实 Electron 验收读取本机隔离 Host 的投影，确认面板可见。

`projectSessionCost` 目前仍没有生产调用点。接收到 Token 数量不能推导出费用；本机公开投影不提供可据此展示的带单位金额，因此这次不增加费用卡片，原始计量投影可以在通用面板查看。

## 二：消费 Host 已经提供的变化事件

### 原因与实现

Host 的 `$events` 用 `{ args: {} }` 打开，本版本没有订阅参数。`API_REMOTE_FORWARDED_EVENTS` 固定转发 19 条事件，其中 17 条为 `emit`，审批和提问两条为 `waterfall`。客户端无法要求 Host 转发名单外的事件。

本次在[Host 事件契约](../src/shared/host-live.ts) 中增加以下严格解析，并由 Store 和[设置中心](../src/renderer/src/features/settings/useSettingsCenter.ts) 消费：

| Host 事件 | 界面行为 |
| --- | --- |
| `settings/document-updated` | 设置中心打开时重新读取公开设置，刷新当前会话模型目录 |
| `llm/adapters-updated` | 刷新模型提供方、设置中心和当前会话模型目录 |
| `credentials/reference-updated` | 重新读取凭据是否配置的状态及模型目录，不通过事件传输密钥值 |
| `goal/activation-changed` | 当前会话的目标面板重新读取运行时激活状态 |

因此，这份固定转发名单中桌面已消费 12 条。其余 7 条是 `api-session/activity` 和 6 条 `cordis/*` 事件；当前桌面没有依赖这些事件的操作。审批与提问的处理保留原样。未知事件和非法结构继续忽略。

刷新由事件触发，不使用轮询。旧读取不能覆盖更新的读取；设置保存期间延后重读；插件设置和模型配置中已经修改、尚未保存的文本保留。目标面板同时监听目标投影变化，子智能体面板复用会话增删和运行状态事件，并提供手动刷新。

### 验收边界

现有 Store 测试覆盖三类事件的原始 payload 解析、模型目录刷新和非法事件忽略；设置界面测试覆盖刷新后保留未保存输入。真实 Electron 验收在隔离 Host 修改并恢复 `shell.timeoutMs`，检查打开的设置页无需手动刷新即可显示新值。模型适配器和凭据事件通过协议与状态测试验证，不在用户实际配置上制造变化。

### 上游事件接口需求

Host 需要提供插件可注册的公开事件描述，以及受授权的订阅或 profile 转发声明，至少包含：

1. 稳定事件名、插件归属、payload schema 和版本。
2. 客户端可见范围，以及不允许对 renderer 暴露的字段。
3. 订阅失败、插件卸载、断线重连和恢复基线的语义。
4. payload 大小和事件速率边界。

在契约具备之前，不用客户端轮询模拟广播，也不放宽客户端事件校验。

## 三：按固定产品动作调用插件 RPC

### 原因与实现

`DSH_HOST_OPERATIONS`、`OPERATION_CANDIDATES` 和 `parseOperation` 共同限制 renderer 能调用什么。问题在于缺少产品动作的适配，白名单本身仍是必要的安全边界。增加映射时也必须落实字段校验、返回值解析、错误提示和真正的界面消费者。

[Host RPC 适配器](../src/main/host/host-client.ts) 现在提供以下固定映射；[共享插件契约](../src/shared/plugin-capabilities.ts) 校验结果；当时的会话插件面板提供操作入口。

| 桌面操作 | 固定 Host endpoint |
| --- | --- |
| `getSessionGoal` | `goals/get` |
| `createSessionGoal` | `goals/create` |
| `editSessionGoal` | `goals/edit` |
| `pauseSessionGoal` | `goals/pause` |
| `resumeSessionGoal` | `goals/resume` |
| `completeSessionGoal` | `goals/complete` |
| `clearSessionGoal` | `goals/clear` |
| `listSessionSubagents` | `subagents/list` |
| `promptSessionSubagent` | `subagents/prompt` |
| `interruptSessionSubagent` | `subagents/interruptByParent` |

目标请求将 `sessionId` 映射为协议要求的 `args.agentId`。编辑和状态变更携带目标 `id` 与 `revision`，冲突时提示刷新，不自动覆盖。目标的 `activation` 由 RPC 返回，不能只凭持久投影推断自动继续的权限。创建和继续按钮附近提示 Host 可能自动继续执行。

子智能体操作固定为 `continuable` 模式，由 Host 校验父子归属。一次性子智能体只展示状态；父会话不可用时禁止发送和中断。发送只支持文本，失败重试保留同一请求标识；用户修改内容后使用新标识。

所有新增动作都限制字段、字符串长度、标识符和枚举；结果只留下桌面需要的已校验字段。401、403、404、目标版本冲突及其他业务失败有中文提示。RPC 继承超时，并随 Host 连接生命周期、renderer 导航或窗口退出取消；组件卸载后的迟到结果不会更新新面板。取消请求不代表 Host 已回滚，写操作遇到超时应先刷新状态。

计划和日程等插件继续使用已有命令、工具及通用投影；本版本没有它们各自的公开 Remote 方法，不虚构接口。插件清单页明确说明 WebUI 不会显示。

### 验收边界

现有 Host 客户端测试验证十项固定映射，覆盖 endpoint 字段注入、无效版本、非法结果、401／403／404 和业务冲突；设置界面的插件面板测试验证目标创建与原始投影显示。真实 Electron 验收实际调用 `goals/get`、`subagents/list`，并检查目标编辑入口在默认／放大窗口、明暗配色及无障碍降级下可用。目标写操作及子智能体消息发送使用协议夹具验证，不在验收中启动真实模型任务。

### 上游动作接口需求

支持任意第三方插件不能只增加一份 endpoint 名称清单。Host 至少需要提供：

1. 稳定动作标识、插件归属、版本、参数和结果 schema，以及可供桌面展示的名称。
2. 操作范围与授权声明：会话／项目归属、读取或写入、副作用、可调用条件。
3. Host 生成并验证的能力授权，或经过主进程审核的固定动作注册；renderer 只能提交动作标识与参数。
4. 超时、取消、幂等、版本冲突、插件卸载及能力失效的语义。

接口发现本身不等于授权。得到清单之后，桌面仍需要明确接受哪些动作，并由主进程执行结构与权限校验。

## 必须保留的边界

- 不靠不断增加 projection 键白名单支持插件状态。
- 不轮询模拟 Host 未提供的事件，不放宽未知事件校验。
- 不增加“转发任意 endpoint”的通用操作，不把 URL、channel 或 endpoint 交给 renderer 控制，也不使用前缀匹配绕过固定操作白名单。
- 不因为插件接口可发现，就把凭据写入、工作区删除、设置修改等全部 Host 能力暴露给 renderer。
- 不修改用户安装的 DSH，不导入 Host 私有模块，不把 DSH 或插件 WebUI 打包进桌面应用。

运行 `pnpm run check` 检查类型、规则、现有测试和独立性；运行 `pnpm run verify` 使用临时端口、隔离 DSH_HOME 和隔离 Electron userData 完成真实窗口验收。截图和运行数据随验收退出自动清理。
