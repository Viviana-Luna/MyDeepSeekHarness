export const DESKTOP_TERMINAL_CHANNELS = Object.freeze({
  create: 'dsh-desktop:terminal:create',
  ready: 'dsh-desktop:terminal:ready',
  write: 'dsh-desktop:terminal:write',
  resize: 'dsh-desktop:terminal:resize',
  close: 'dsh-desktop:terminal:close',
  clipboard: 'dsh-desktop:terminal:clipboard',
  event: 'dsh-desktop:terminal:event',
})

export const DESKTOP_TERMINAL_LIMITS = Object.freeze({
  maxTerminals: 12,
  maxInputBytes: 256 * 1024,
  maxPendingOutputCharacters: 1024 * 1024,
  minColumns: 2,
  maxColumns: 500,
  minRows: 1,
  maxRows: 200,
})

export interface DesktopTerminalCreateRequest {
  projectId: string
  taskId?: string
  columns: number
  rows: number
}

export type DesktopTerminalKind = 'shell' | 'task'

export interface DesktopTerminalDescriptor {
  id: string
  pid: number
  kind: DesktopTerminalKind
  title: string
  taskId?: string
}

export type DesktopTerminalEvent =
  | {
      type: 'data'
      terminalId: string
      data: string
    }
  | {
      type: 'exit'
      terminalId: string
      exitCode: number
      signal?: number
    }
