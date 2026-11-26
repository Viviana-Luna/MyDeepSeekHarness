import { DirectoryPicker } from '@deepseek-ai/dsh-host-directory-picker'

/**
 * 提供 DSH 原有的目录选择服务，使 Workspace Controller 保持同一份公开契约。
 * 原生对话框属于 Electron 主进程；后台只转交请求，取消和退出随请求生命周期清理。
 */
export function installDirectoryPicker(ctx, exchange) {
  class DesktopDirectoryPicker extends DirectoryPicker {
    // 能力对象在服务生命期内保持稳定，控制器可以安全地持有它。
    nativeCapability = { kind: 'native', pick: signal => exchange('directory.pick', {}, signal) }

    capability() {
      return this.nativeCapability
    }
  }

  return ctx.plugin(DesktopDirectoryPicker)
}
