import type { DesktopBridge } from '../platform/contracts.ts'

const MINIMUM_DESKTOP_BRIDGE_VERSION = 11

export class DesktopBridgeUnavailableError extends Error {
  constructor() {
    super('桌面桥不可用，请从 MyDSH 启动此界面')
    this.name = 'DesktopBridgeUnavailableError'
  }
}

/** 校验 preload 桥的最低能力版本；普通浏览器中明确失败，避免悄悄改用网络旁路。 */
export function getDesktopBridge(): DesktopBridge {
  const bridge = window.dshDesktop
  if (bridge === undefined || bridge.version < MINIMUM_DESKTOP_BRIDGE_VERSION) {
    throw new DesktopBridgeUnavailableError()
  }
  return bridge
}
