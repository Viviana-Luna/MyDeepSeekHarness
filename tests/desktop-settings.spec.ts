/**
 * Electron 自有桌面外观设置持久化与版本兼容测试：验证默认值、IPC 校验、v1-v7 迁移和损坏回退。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DesktopSettingsStore,
  DesktopSettingsValidationError,
  migrateLegacyDesktopSettings,
  parseDesktopBackgroundApplyRequest,
  parseDesktopBackgroundChooseRequest,
  parseDesktopBackgroundLayer,
  parseDesktopSettingsPatch,
} from '../src/main/settings/desktop-settings.ts'

const temporaryDirectories: string[] = []

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'dsh-desktop-settings-test-'))
  temporaryDirectories.push(path)
  return path
}

afterEach(() => {
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
})

describe('Electron 自有桌面设置', () => {
  it('正式产品首次启动只迁移旧桌面外观文件且不覆盖目标设置', () => {
    const legacyRoot = temporaryDirectory()
    const targetRoot = temporaryDirectory()
    const legacyStore = new DesktopSettingsStore(legacyRoot)
    legacyStore.update({ accentColor: '#c45a84', canvasTransparency: 0.36 })
    legacyStore.setBackground('sidebar', Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    expect(migrateLegacyDesktopSettings(targetRoot, [legacyRoot])).toBe(legacyRoot)
    expect(new DesktopSettingsStore(targetRoot).read()).toMatchObject({
      accentColor: '#c45a84',
      backgrounds: { sidebar: expect.stringMatching(/^data:image\/png;base64,/u) },
    })
    expect(new DesktopSettingsStore(legacyRoot).read().accentColor).toBe('#c45a84')

    const targetStore = new DesktopSettingsStore(targetRoot)
    targetStore.update({ accentColor: '#112233' })
    expect(migrateLegacyDesktopSettings(targetRoot, [legacyRoot])).toBeUndefined()
    expect(new DesktopSettingsStore(targetRoot).read().accentColor).toBe('#112233')
  })

  it('首次读取返回默认值且不创建持久化文件', () => {
    const root = temporaryDirectory()
    const store = new DesktopSettingsStore(root)
    expect(store.read()).toEqual({
      version: 7,
      revision: 0,
      colorScheme: 'system',
      canvasColorScheme: 'follow-interface',
      fontFamily: 'system',
      fontSize: 12,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 8,
      accentColor: '#4d6bfe',
      canvasTransparency: 0.32,
      contentScrimOpacity: 0.82,
      backgrounds: { canvas: null, sidebar: null, content: null },
    })
    expect(() => readFileSync(join(root, 'desktop-settings.json'))).toThrow()
  })

  it('只在内容变化时递增 revision，并能从磁盘恢复标量设置', () => {
    const root = temporaryDirectory()
    const store = new DesktopSettingsStore(root)
    expect(
      store.update({
        colorScheme: 'dark',
        canvasColorScheme: 'light',
        fontFamily: 'humanist',
        fontSize: 15,
        editorFontSize: 17,
        editorLineHeight: 'relaxed',
        editorLigatures: true,
        islandGap: 14,
        accentColor: '#C45A84',
        canvasTransparency: 0.42,
        contentScrimOpacity: 0.74,
      }),
    ).toMatchObject({
      revision: 1,
      colorScheme: 'dark',
      canvasColorScheme: 'light',
      fontFamily: 'humanist',
      fontSize: 15,
      editorFontSize: 17,
      editorLineHeight: 'relaxed',
      editorLigatures: true,
      islandGap: 14,
      accentColor: '#c45a84',
      canvasTransparency: 0.42,
      contentScrimOpacity: 0.74,
    })
    expect(JSON.parse(readFileSync(join(root, 'desktop-settings.json'), 'utf8'))).toMatchObject({
      version: 7,
      colorScheme: 'dark',
      canvasColorScheme: 'light',
      fontFamily: 'humanist',
      fontSize: 15,
      editorFontSize: 17,
      editorLineHeight: 'relaxed',
      editorLigatures: true,
      islandGap: 14,
    })
    expect(store.update({ accentColor: '#c45a84' }).revision).toBe(1)
    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      revision: 0,
      colorScheme: 'dark',
      canvasColorScheme: 'light',
      fontFamily: 'humanist',
      fontSize: 15,
      editorFontSize: 17,
      editorLineHeight: 'relaxed',
      editorLigatures: true,
      islandGap: 14,
      accentColor: '#c45a84',
      canvasTransparency: 0.42,
      contentScrimOpacity: 0.74,
    })
  })

  it('拒绝 IPC 中的未知字段、无效颜色、越界透明度和未知背景层', () => {
    expect(parseDesktopSettingsPatch({ fontFamily: 'monospace', fontSize: 11 })).toEqual({
      fontFamily: 'monospace',
      fontSize: 11,
    })
    expect(parseDesktopSettingsPatch({ fontSize: 18 })).toEqual({ fontSize: 18 })
    expect(
      parseDesktopSettingsPatch({
        editorFontSize: 18,
        editorLineHeight: 'compact',
        editorLigatures: true,
      }),
    ).toEqual({ editorFontSize: 18, editorLineHeight: 'compact', editorLigatures: true })
    expect(parseDesktopSettingsPatch({ islandGap: 5 })).toEqual({ islandGap: 5 })
    expect(parseDesktopSettingsPatch({ islandGap: 20 })).toEqual({ islandGap: 20 })
    expect(() => parseDesktopSettingsPatch({ shellCommand: 'open .' })).toThrow('不支持字段')
    expect(() => parseDesktopSettingsPatch({ accentColor: 'red' })).toThrow('#RRGGBB')
    expect(() => parseDesktopSettingsPatch({ themeMode: 'glass' })).toThrow('不支持字段')
    expect(parseDesktopSettingsPatch({ colorScheme: 'light' })).toEqual({ colorScheme: 'light' })
    expect(parseDesktopSettingsPatch({ canvasColorScheme: 'dark' })).toEqual({
      canvasColorScheme: 'dark',
    })
    expect(() => parseDesktopSettingsPatch({ canvasColorScheme: 'sepia' })).toThrow(
      'follow-interface、light 或 dark',
    )
    expect(() => parseDesktopSettingsPatch({ colorScheme: 'sepia' })).toThrow(
      'system、light 或 dark',
    )
    expect(() => parseDesktopSettingsPatch({ fontFamily: 'serif' })).toThrow(
      DesktopSettingsValidationError,
    )
    expect(() => parseDesktopSettingsPatch({ fontFamily: 'serif' })).toThrow(
      'system、humanist 或 monospace',
    )
    for (const fontSize of [10, 19, 13.5, Number.NaN, '13']) {
      expect(() => parseDesktopSettingsPatch({ fontSize })).toThrow(DesktopSettingsValidationError)
      expect(() => parseDesktopSettingsPatch({ fontSize })).toThrow('11 到 18 之间的整数')
    }
    for (const islandGap of [4, 21, 10.5, Number.NaN, '10']) {
      expect(() => parseDesktopSettingsPatch({ islandGap })).toThrow(DesktopSettingsValidationError)
      expect(() => parseDesktopSettingsPatch({ islandGap })).toThrow('5 到 20 之间的整数')
    }
    for (const editorFontSize of [10, 19, 13.5, Number.NaN, '13']) {
      expect(() => parseDesktopSettingsPatch({ editorFontSize })).toThrow('11 到 18 之间的整数')
    }
    expect(() => parseDesktopSettingsPatch({ editorLineHeight: 'wide' })).toThrow(
      'compact、standard 或 relaxed',
    )
    expect(() => parseDesktopSettingsPatch({ editorLigatures: 'yes' })).toThrow('布尔值')
    expect(() => parseDesktopSettingsPatch({ canvasTransparency: 1.01 })).toThrow('0 到 1')
    expect(() => parseDesktopSettingsPatch({ islandChromeTransparency: 0.5 })).toThrow('不支持字段')
    expect(() => parseDesktopSettingsPatch({ islandContentTransparency: 0.5 })).toThrow(
      '不支持字段',
    )
    expect(() => parseDesktopSettingsPatch({ contentScrimOpacity: 1.01 })).toThrow('0 到 1')
    expect(() => parseDesktopBackgroundLayer('../secrets')).toThrow('背景目标')
  })

  it('读取版本 1 设置时保留原透明体验为 glass 且不覆盖原文件', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 1,
      accentColor: '#c45a84',
      canvasTransparency: 0.42,
      backgroundLayers: ['canvas'],
    })
    writeFileSync(path, document, { mode: 0o600 })
    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'system',
      fontFamily: 'system',
      fontSize: 12,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 8,
      accentColor: '#c45a84',
      canvasTransparency: 0.42,
      contentScrimOpacity: 0.82,
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('读取版本 2 设置时保留三档透明度并迁移为 glass', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 2,
      accentColor: '#112233',
      canvasTransparency: 0.58,
      islandChromeTransparency: 0.27,
      islandContentTransparency: 0.44,
      backgroundLayers: ['content'],
    })
    writeFileSync(path, document, { mode: 0o600 })

    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'system',
      fontFamily: 'system',
      fontSize: 12,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 8,
      accentColor: '#112233',
      canvasTransparency: 0.58,
      contentScrimOpacity: 0.82,
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('读取版本 3 设置时保留主题与透明度并补齐字体默认值', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 3,
      themeMode: 'classic',
      accentColor: '#345678',
      canvasTransparency: 0.41,
      islandChromeTransparency: 0.22,
      islandContentTransparency: 0.14,
      contentScrimOpacity: 0.76,
      backgroundLayers: [],
    })
    writeFileSync(path, document, { mode: 0o600 })

    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'system',
      fontFamily: 'system',
      fontSize: 12,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 8,
      accentColor: '#345678',
      canvasTransparency: 0.41,
      contentScrimOpacity: 0.76,
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('读取版本 4 设置时保留字体与主题并补齐浮岛间隙默认值', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 4,
      themeMode: 'glass',
      fontFamily: 'humanist',
      fontSize: 15,
      accentColor: '#345678',
      canvasTransparency: 0.41,
      islandChromeTransparency: 0.22,
      islandContentTransparency: 0.14,
      contentScrimOpacity: 0.76,
      backgroundLayers: [],
    })
    writeFileSync(path, document, { mode: 0o600 })

    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'system',
      fontFamily: 'humanist',
      fontSize: 15,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 8,
      accentColor: '#345678',
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('读取版本 5 设置时保留全部外观参数并补齐跟随系统配色', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 5,
      themeMode: 'glass',
      fontFamily: 'monospace',
      fontSize: 14,
      islandGap: 8,
      accentColor: '#8069d4',
      canvasTransparency: 0.36,
      islandChromeTransparency: 0.24,
      islandContentTransparency: 0.18,
      contentScrimOpacity: 0.78,
      backgroundLayers: ['canvas', 'content'],
    })
    writeFileSync(path, document, { mode: 0o600 })

    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'system',
      fontFamily: 'monospace',
      fontSize: 14,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 8,
      accentColor: '#8069d4',
      canvasTransparency: 0.36,
      contentScrimOpacity: 0.78,
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('严格校验裁剪目标、比例、一次性标识与归一化区域', () => {
    expect(
      parseDesktopBackgroundChooseRequest({
        layer: 'sidebar',
        targetAspectRatio: 0.523_456,
      }),
    ).toEqual({ layer: 'sidebar', targetAspectRatio: 0.5235 })
    expect(() =>
      parseDesktopBackgroundChooseRequest({
        layer: 'canvas',
        targetAspectRatio: 0,
      }),
    ).toThrow('裁剪比例')
    expect(
      parseDesktopBackgroundApplyRequest({
        selectionId: '3d594650-c880-4b32-965c-6cadbc49d6d1',
        crop: { x: 0.125, y: 0, width: 0.75, height: 1 },
      }),
    ).toMatchObject({
      crop: { x: 0.125, y: 0, width: 0.75, height: 1 },
    })
    expect(() =>
      parseDesktopBackgroundApplyRequest({
        selectionId: 'not-a-selection',
        crop: { x: 0, y: 0, width: 1, height: 1 },
      }),
    ).toThrow('选择标识')
    expect(() =>
      parseDesktopBackgroundApplyRequest({
        selectionId: '3d594650-c880-4b32-965c-6cadbc49d6d1',
        crop: { x: 0.8, y: 0, width: 0.4, height: 1 },
      }),
    ).toThrow('源图范围')
  })

  it('损坏的设置文件不会阻止启动，也不会在读取时覆盖原文件', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    writeFileSync(path, '{broken', { mode: 0o600 })
    const store = new DesktopSettingsStore(root)
    expect(store.read()).toMatchObject({
      accentColor: '#4d6bfe',
      warning: expect.stringContaining('原文件没有被覆盖'),
    })
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  })

  it('持久化文件出现未知字段时按损坏设置处理', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 1,
      accentColor: '#4d6bfe',
      canvasTransparency: 0.85,
      backgroundLayers: [],
      shellCommand: 'open .',
    })
    writeFileSync(path, document, { mode: 0o600 })
    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      accentColor: '#4d6bfe',
      warning: expect.stringContaining('默认值'),
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('版本 5 持久化字体、字号或浮岛间隙非法时安全回退且不覆盖原文件', () => {
    for (const invalidFont of [
      { fontFamily: 'serif', fontSize: 13, islandGap: 10 },
      { fontFamily: 'system', fontSize: 13.5, islandGap: 10 },
      { fontFamily: 'system', fontSize: 13, islandGap: 22 },
    ]) {
      const root = temporaryDirectory()
      const path = join(root, 'desktop-settings.json')
      const document = JSON.stringify({
        version: 5,
        themeMode: 'glass',
        ...invalidFont,
        accentColor: '#c45a84',
        canvasTransparency: 0.42,
        islandChromeTransparency: 0.28,
        islandContentTransparency: 0.36,
        contentScrimOpacity: 0.74,
        backgroundLayers: [],
      })
      writeFileSync(path, document, { mode: 0o600 })

      expect(new DesktopSettingsStore(root).read()).toMatchObject({
        version: 7,
        colorScheme: 'system',
        fontFamily: 'system',
        fontSize: 12,
        editorFontSize: 13,
        editorLineHeight: 'standard',
        editorLigatures: false,
        islandGap: 8,
        warning: expect.stringContaining('默认值'),
      })
      expect(readFileSync(path, 'utf8')).toBe(document)
    }
  })

  it('读取版本 6 设置时保留界面外观并补齐代码编辑器默认值', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 6,
      themeMode: 'glass',
      colorScheme: 'dark',
      fontFamily: 'humanist',
      fontSize: 15,
      islandGap: 12,
      accentColor: '#c45a84',
      canvasTransparency: 0.42,
      islandChromeTransparency: 0.28,
      islandContentTransparency: 0.36,
      contentScrimOpacity: 0.74,
      backgroundLayers: [],
    })
    writeFileSync(path, document, { mode: 0o600 })

    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'dark',
      fontFamily: 'humanist',
      fontSize: 15,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 12,
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('版本 7 配色非法时安全回退且不覆盖原文件', () => {
    const root = temporaryDirectory()
    const path = join(root, 'desktop-settings.json')
    const document = JSON.stringify({
      version: 7,
      themeMode: 'glass',
      colorScheme: 'sepia',
      fontFamily: 'system',
      fontSize: 14,
      editorFontSize: 13,
      editorLineHeight: 'standard',
      editorLigatures: false,
      islandGap: 5,
      accentColor: '#c45a84',
      canvasTransparency: 0.42,
      islandChromeTransparency: 0.28,
      islandContentTransparency: 0.36,
      contentScrimOpacity: 0.74,
      backgroundLayers: [],
    })
    writeFileSync(path, document, { mode: 0o600 })

    expect(new DesktopSettingsStore(root).read()).toMatchObject({
      version: 7,
      colorScheme: 'system',
      warning: expect.stringContaining('默认值'),
    })
    expect(readFileSync(path, 'utf8')).toBe(document)
  })

  it('背景图使用固定层文件并只向 renderer 返回 data URL', () => {
    const root = temporaryDirectory()
    const store = new DesktopSettingsStore(root)
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const saved = store.setBackground('sidebar', png)
    expect(saved.revision).toBe(1)
    expect(saved.backgrounds.sidebar).toBe(`data:image/png;base64,${png.toString('base64')}`)
    expect(JSON.stringify(saved)).not.toContain(root)
    expect(store.setBackground('sidebar', png).revision).toBe(1)
    expect(store.clearBackground('sidebar')).toMatchObject({
      revision: 2,
      backgrounds: { sidebar: null },
    })
    expect(store.clearBackground('sidebar').revision).toBe(2)
  })

  it('同内容孤立背景文件仍会重新登记到设置中', () => {
    const root = temporaryDirectory()
    const directory = join(root, 'backgrounds')
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'canvas.png'), png)
    const store = new DesktopSettingsStore(root)
    expect(store.setBackground('canvas', png)).toMatchObject({
      revision: 1,
      backgrounds: { canvas: expect.stringMatching(/^data:image\/png;base64,/u) },
    })
  })
})
