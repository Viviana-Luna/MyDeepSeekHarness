# MyDSH 应用图标

MyDSH 使用蓝发鲸鱼娘与 TOKEN 小票想法气泡作为 Logo。角色保留提供素材中的表情、线条与服饰，浅蓝圆角底板外透明；气泡底部的小凸起与两颗圆点朝角色头部延伸。

`app-icon-source.png` 是确认版 Logo 的 1024×1024 PNG 源图，不由脚本重绘或覆盖。角色属于社区同人素材，相关权利归各自创作者；项目代码的 GPL-3.0-or-later 许可证不代表对原始角色素材的授权。

`app-icon.png` 是带 macOS 安全留白的主图，供 Dock 与窗口使用；`app-icon.icns` 用于 macOS 应用包，包含 16、32、64、128、256、512 与 1024 像素资源。两者由同一份源图生成：

```sh
pnpm run build:icon
pnpm run verify:assets
```

导出脚本只在 macOS 上运行，使用系统 `sips` 将源图缩放到 910×910，再居中补齐到 1024×1024。源图已有 48px 透明边距，最终可见图形约为 824px。各尺寸 PNG 按 ICNS 块结构封装；临时文件自动清理。普通构建消费已经跟踪的主图和 ICNS，不要求重新生成图标。

`startup-light-soft.png` 和 `startup-dark-soft.png` 是定稿的启动插画，构建时分别复制为 `lib/startup-light.png` 和 `lib/startup-dark.png`，随应用离线交付。启动页单独呈现阶段文字，并使用“设置 → 通用 → 外观配色”的浅色、深色或跟随系统选择。
