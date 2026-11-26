import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('electron', () => ({ dialog: { showOpenDialog: mocks.open }, ipcMain: {}, protocol: {} }))
import {
  choosePluginDirectory,
  pluginOperationPayload,
} from '../src/main/runtime/plugin-controller.ts'

describe('插件文件夹选择', () => {
  it('主进程拒绝越界字段、相对路径和核心标识', () => {
    expect(pluginOperationPayload('mydshPlugins.list', {})).toEqual({})
    expect(pluginOperationPayload('mydshPlugins.enable', { id: 'sample' })).toEqual({
      id: 'sample',
    })
    expect(() => pluginOperationPayload('mydshPlugins.install', { path: '../outside' })).toThrow(
      '完整路径',
    )
    expect(() => pluginOperationPayload('mydshPlugins.enable', { id: 'mydsh.core' })).toThrow(
      '保留标识',
    )
    expect(() =>
      pluginOperationPayload('mydshPlugins.uninstall', { id: 'sample', force: true }),
    ).toThrow('不支持的字段')
    expect(() => pluginOperationPayload('mydshPlugins.install', null)).toThrow('参数无效')
  })
  it('取消不安装，窗口销毁后丢弃迟到的路径', async () => {
    let destroyed = false
    const win = { isDestroyed: () => destroyed } as BrowserWindow
    mocks.open.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await choosePluginDirectory(win)).toBeNull()
    mocks.open.mockImplementationOnce(async () => {
      destroyed = true
      return { canceled: false, filePaths: ['C:/fixture'] }
    })
    expect(await choosePluginDirectory(win)).toBeNull()
    await expect(choosePluginDirectory(win)).rejects.toThrow('窗口已经关闭')
  })
  it('只选择目录并传回路径，系统对话框错误不吞掉', async () => {
    const win = { isDestroyed: () => false } as BrowserWindow
    mocks.open.mockResolvedValueOnce({ canceled: false, filePaths: ['C:/fixture'] })
    expect(await choosePluginDirectory(win)).toBe('C:/fixture')
    expect(mocks.open).toHaveBeenLastCalledWith(
      win,
      expect.objectContaining({ properties: ['openDirectory', 'dontAddToRecent'] }),
    )
    mocks.open.mockRejectedValueOnce(new Error('无法打开系统对话框'))
    await expect(choosePluginDirectory(win)).rejects.toThrow('无法打开系统对话框')
  })
})
