# 参与贡献 MyDSH

感谢你对 MyDSH 的关注。无论是反馈问题、完善文档还是提交代码改进，都非常欢迎。

## 反馈问题与提出建议

- 提交前请先在 [GitHub Issues](https://github.com/Viviana-Luna/MyDeepSeekHarness/issues) 中搜索是否已有类似记录。
- 反馈缺陷时，请尽量附上操作系统与架构、复现步骤、实际现象与脱敏后的诊断信息（切勿粘贴 API Key、凭据文件或隐私日志）。
- 涉及安全漏洞或权限绕过的问题，请勿在公开 Issue 中披露，参阅 [SECURITY.md](SECURITY.md)。

## 本地开发准备

### 环境要求

- Node.js 22.19+ 或 24+
- pnpm 11
- macOS（Apple Silicon）或 Windows 11（x64，另需 Visual Studio C++ Build Tools 与 Windows SDK）

### 拉取并运行

```sh
git clone https://github.com/Viviana-Luna/MyDeepSeekHarness.git
cd MyDeepSeekHarness
pnpm install
pnpm run dev
```

动手修改代码前，建议先阅读以下文档了解项目边界与约束：

- [代码规范](docs/code-style.md)
- [运行时维护与故障排查](docs/dev.md)
- [前端维护指南](docs/renderer.md)

## 编码与提交规范

- **语言约定**：MyDSH 自有文档、代码注释、测试描述、错误信息与 Git 提交信息统一使用简体中文；代码标识符、协议字段与第三方专名保持原有写法。固定上游源码不批量翻译或改写。
- **格式与规模门禁**：提交前运行 `pnpm run format`，并保持函数与文件不超过 [代码规范](docs/code-style.md) 中的上限。`.oxlintrc.json` 与 `scripts/comment-debt.json` 中的豁免清单只减不增。
- **测试与验收**：
  - 常规改动必须通过 `pnpm run check`（包含类型检查、格式校验、Lint、注释校验、单元测试与架构/独立性门禁）。
  - 涉及生命周期、子进程、导航、IPC、权限、本地文件或 UI 布局的改动，必须补充失败与清理路径覆盖，并运行真实 Electron 隔离验收 `pnpm run verify`。
  - UI 改动需同时核对 1280×800 默认窗口、放大窗口、明暗主题、透明合成与无障碍降级。
- **敏感与临时文件**：禁止提交 `.env`、证书私钥、用户设置、会话数据、构建输出或临时截图缓存。

## Pull Request 清单

1. 从主分支切出语义清晰的特性或修复分支，保持单个 PR 聚焦单一主题；重构与行为改动尽量分提交记录。
2. 本地执行 `pnpm run format`、`pnpm run check` 与 `git diff --cached --check`，确认全部通过。
3. 涉及桌面交互、权限或界面调整时，执行 `pnpm run verify` 并在 PR 描述中附上验证结果与明暗主题截图。
4. 确保所有新文件末尾保留单个换行符，不包含未归属的临时待办标记。
