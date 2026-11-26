# MyDSH 文档中心

本目录收录 MyDSH 的架构说明、功能设计、开发规范与发行流程，供开发者与维护者查阅。

## 架构与核心维护

| 文档 | 内容摘要 |
| --- | --- |
| [运行时维护与故障排查](dev.md) | 源码目录地图、`~/.mydsh` 数据与配置布局、启动退出流程与常见故障排查 |
| [前端维护指南](renderer.md) | 浮岛外壳、工作标签材质、对话排版、输入区控件、状态同步与前端工程基线 |
| [代码规范](code-style.md) | 格式、函数与文件规模上限、命名、中文注释规范与自动门禁 |

## 功能与运行机制

| 文档 | 内容摘要 |
| --- | --- |
| [编码与调度模式](agent-modes.md) | `standard` / `minimal` / `gpt-coding` 三套预设、二级 `mydsh` CLI 与 Harness 评测 |
| [Git AI 提交](git-ai-commit.md) | AI 差异分组、审阅确认、锁保护与后台安全边界 |
| [自动审核提权](../packages/interaction/auto-review/README.md) | `auto-review` 预设的单次提权审核边界、取证限制与审计记录 |
| [输入区读数可见性说明](composer-readings-visibility.zh.md) | 会话读数、上下文占用与多宽度自适应降级策略 |

## 插件、导入与上游来源

| 文档 | 内容摘要 |
| --- | --- |
| [插件与 AI 转换开发指南](plugin-development.zh.md) | 后台 Cordis 插件生命周期、信任模型、资源释放与转换工作区 |
| [前端界面插件指南](../src/renderer/src/plugins/README.md) | 前端 Cordis 上下文、`MydshSlots` 插槽装配与本地协议加载 |
| [从 DSH 导入数据](data-import.zh.md) | 历史 DSH 会话、项目、设置与凭据的只读预览与事务式导入 |
| [上游来源与适配记录](upstream/dsh/README.zh.md) | DeepSeek Harness 固定基线提交、许可证留存与 MyDSH 修改清单 |
| [宿主与插件能力差异记录](host-plugin-gaps.md) | 宿主演进过程中的已知插件边界与差异记录 |

## 构建与发行

| 文档 | 内容摘要 |
| --- | --- |
| [发行说明](release.md) | macOS / Windows 打包验收、离线核心交付、签名说明与 GitHub Release 流程 |
| [应用图标与启动插画说明](../assets/README.md) | 图标源图、ICNS 导出校验与启动页明暗插画素材说明 |
