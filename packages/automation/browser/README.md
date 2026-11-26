# @mydsh/browser-automation

MyDSH 后台 `utilityProcess` 浏览器自动化工具包，向主会话 Agent 暴露 12 个统一 CDP 浏览器操控工具（同时支持内置隔离 `WebContentsView` 与外置本机 Chrome/Edge）。所有实际浏览器驱动和权限护栏均由 Electron 主进程持有并通过 `mydshAutomationSystem` 受控通道调用。
