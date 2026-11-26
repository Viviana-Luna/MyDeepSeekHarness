---
name: mydsh-plugin-development
description: 在 MyDSH 中创建或修改自定义 Agent 预设、开发原生插件，或将仅支持 DSH 的插件实际改写为 MyDSH 插件。
---

先用文件读取工具阅读同目录 `development.md`（若开发环境尚未构建离线包，直接阅读仓库 `docs/plugin-development.zh.md`），再检查用户指定的源码与 MyDSH SDK。不能把安装 DSH 插件当成直接导入；必须改写产品接口并验证实际运行效果。

MyDSH 插件自省与转换工具均通过受控命令行 `mydsh plugin` 在 Shell 中调用（先运行 `mydsh plugin --help` 或 `mydsh plugin <action> --help` 查看完整参数）：

1. 运行 `mydsh plugin inspect-list` 与 `mydsh plugin inspect-query` 读取真实宿主服务、事件与插槽协议。前端公开接口见运行核心 `node_modules/@mydsh/ui/README.md`；后台见 `node_modules/@mydsh/sdk/README.md`。
2. 适配已有插件运行 `mydsh plugin prepare`（支持 `--kind local|git|npm`），保留原来源，在返回的独立目录中用普通文件读写/编辑工具改写代码。全新插件先在工作目录创建源码和清单，再用 `local` 来源准备转换任务。
3. 使用宿主共享的 Cordis、React、`@mydsh/sdk` 和 `@mydsh/ui`，不能复制 DSH WebUI、使用其私有插槽或另开 HTTP/TCP 服务。资源必须跟随插件的 Cordis 生命周期释放。
4. 运行 `mydsh plugin validate --id <任务ID>`，修复所有类型检查和构建问题。安装前向用户说明实际完成的能力与已知限制，再运行 `mydsh plugin install --id <任务ID>`（会触发受信任代码安装审批，请留足命令等待时间）。
5. 创建自定义 Agent 预设时，从运行核心 `node_modules/@deepseek-ai/dsh-agent-presets/presets`（内置 `standard`、`minimal`、`gpt-coding` 三个预设）读取参照，写入 `${MYDSH_HOME}/data/.agent-presets/<id>/`，包含 `preset.yml`（中文名称与说明）和 `agent.cordis.yml`。不得修改内置预设或运行核心。
