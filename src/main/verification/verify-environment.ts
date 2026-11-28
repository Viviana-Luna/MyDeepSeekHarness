/**
 * 主进程启动期环境变量、命令行验收标志与隔离数据目录装配。
 *
 * 在 `app.whenReady()` 之前完成沙盒开启、应用身份设置与隔离 `userData` / `sessionData`
 * 绑定，并提供验收背景夹具、初始工作区种子会话与诊断脱敏辅助函数。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path'
import { app, nativeImage } from 'electron'
import { PRODUCT_NAME, PRODUCT_USER_DATA_DIRECTORY } from '../../shared/product.ts'
import { parseDesktopWorkspaceCreateResult } from '../../shared/workspace-capabilities.ts'
import { callDshHost } from '../host/host-client.ts'
import type { DesktopSettingsStore } from '../settings/desktop-settings.ts'
import type { VerifyReport, VerifyStage } from './desktop-verifier.ts'

const VERIFY_FLAG = '--verify'

/**
 * 自动验收总超时（毫秒）。
 * 低于外部 `scripts/runtime-verification.mjs` 时限，确保超时前能输出结构化失败报告。
 */
export const VERIFY_TOTAL_TIMEOUT_MS = 480_000

/** 主进程启动解析出的运行模式与隔离目录配置。 */
export interface VerifyEnvironment {
  readonly isVerifyMode: boolean
  readonly isVerifySsh: boolean
  readonly isVerifyDatabase: boolean
  readonly isVerifyInteractive: boolean
  readonly isVerifyBackground: boolean
  readonly verifyDeadline: number | undefined
  readonly verifyHome: string | undefined
  readonly verifyProject: string | undefined
  readonly appDataPath: string
  artifactPath(fileName: string): string
}

function resolveVerifyHome(isVerifyMode: boolean, rawHome: string | undefined): string | undefined {
  if (!isVerifyMode) return undefined
  if (rawHome === undefined) return mkdtempSync(join(tmpdir(), 'mydsh-verify-'))
  if (!isAbsolute(rawHome)) throw new Error('MYDSH_VERIFY_HOME 必须是绝对路径')
  return rawHome
}

function resolveVerifyProject(
  isVerifyMode: boolean,
  verifyHome: string | undefined,
  rawProject: string | undefined,
): string | undefined {
  if (!isVerifyMode) return undefined
  if (verifyHome === undefined || rawProject === undefined || !isAbsolute(rawProject)) {
    throw new Error('MYDSH_VERIFY_PROJECT 必须由验收运行器提供绝对路径')
  }
  const project = resolvePath(rawProject)
  const fromHome = relative(verifyHome, project)
  if (
    fromHome === '' ||
    fromHome === '..' ||
    fromHome.startsWith(`..${sep}`) ||
    isAbsolute(fromHome)
  ) {
    throw new Error('MYDSH_VERIFY_PROJECT 必须位于隔离验收目录内')
  }
  return project
}

function configureIsolatedPaths(
  verifyHome: string | undefined,
  verifyArtifactDirectory: string | undefined,
  verifyHomeFromRunner: boolean,
  appDataPath: string,
): void {
  if (verifyHome === undefined) {
    app.setPath('userData', join(appDataPath, PRODUCT_USER_DATA_DIRECTORY))
    return
  }
  mkdirSync(verifyHome, { recursive: true, mode: 0o700 })
  if (verifyArtifactDirectory === undefined) throw new Error('无法初始化验收产物目录')
  mkdirSync(verifyArtifactDirectory, { recursive: true, mode: 0o700 })
  const electronUserData = join(verifyHome, 'electron-user-data')
  mkdirSync(electronUserData, { recursive: true, mode: 0o700 })
  app.setPath('userData', electronUserData)
  // Chromium 的存储目录可能已按系统已知目录初始化，不能只修改 userData。
  app.setPath('sessionData', electronUserData)
  if (!verifyHomeFromRunner) {
    process.once('exit', () => {
      rmSync(verifyHome, { recursive: true, force: true })
    })
  }
}

/**
 * 解析命令行验收标志并初始化 Electron 进程级沙盒、应用名称与隔离用户目录。
 * 必须在模块顶层（请求单实例锁之前）调用一次。
 */
export function initializeProcessEnvironment(): VerifyEnvironment {
  const isVerifyMode = process.argv.includes(VERIFY_FLAG)
  const isVerifySsh = isVerifyMode && process.argv.includes('--verify-ssh')
  const isVerifyDatabase = isVerifyMode && process.argv.includes('--verify-database')
  // 交互验收保留数据隔离，由操作员检查真实界面，不注入自动验收会话或接管页面。
  const isVerifyInteractive = isVerifyMode && process.argv.includes('--verify-interactive')
  const isVerifyBackground =
    isVerifyMode &&
    !isVerifyInteractive &&
    !process.argv.includes('--verify-foreground') &&
    !process.argv.includes('--verify-directory-picker')

  if (isVerifyBackground && process.platform === 'darwin') {
    app.setActivationPolicy('prohibited')
  }
  // Windows 后台离屏验收在无独立 GPU 的虚拟桌面上按 Electron 离屏要求关闭硬件加速。
  if (isVerifyBackground && process.platform === 'win32') {
    app.disableHardwareAcceleration()
  }

  const verifyDeadline =
    isVerifyMode && !isVerifyInteractive ? Date.now() + VERIFY_TOTAL_TIMEOUT_MS : undefined
  const rawVerifyHome = process.env.MYDSH_VERIFY_HOME
  const verifyHomeFromRunner = isVerifyMode && rawVerifyHome !== undefined
  const verifyHome = resolveVerifyHome(isVerifyMode, rawVerifyHome)
  const verifyProject = resolveVerifyProject(
    isVerifyMode,
    verifyHome,
    process.env.MYDSH_VERIFY_PROJECT,
  )
  const verifyArtifactDirectory =
    verifyHome === undefined ? undefined : join(verifyHome, 'artifacts')

  const sshVerificationAppName =
    isVerifySsh || isVerifyDatabase ? process.env.MYDSH_SSH_VERIFY_APP_NAME : undefined
  if (
    (isVerifySsh || isVerifyDatabase) &&
    (!verifyHomeFromRunner ||
      !/^mydsh-credentials-verify-[0-9a-f]{32}$/u.test(sshVerificationAppName ?? ''))
  ) {
    throw new Error('SSH 凭据验收缺少隔离目录或独立测试应用身份')
  }
  app.setName(sshVerificationAppName ?? PRODUCT_NAME)
  app.enableSandbox()

  const appDataPath = app.getPath('appData')
  configureIsolatedPaths(verifyHome, verifyArtifactDirectory, verifyHomeFromRunner, appDataPath)

  return {
    isVerifyMode,
    isVerifySsh,
    isVerifyDatabase,
    isVerifyInteractive,
    isVerifyBackground,
    verifyDeadline,
    verifyHome,
    verifyProject,
    appDataPath,
    artifactPath(fileName: string): string {
      if (
        verifyArtifactDirectory === undefined ||
        !/^verify(?:-[a-z0-9]+)*\.png$/u.test(fileName)
      ) {
        throw new Error('验收截图必须写入隔离产物目录')
      }
      return join(verifyArtifactDirectory, fileName)
    },
  }
}

/** 为自动验收准备隔离的透明画布背景与棋盘格裁剪源图。 */
export function prepareVerifyBackgroundFixtures(
  verifyEnv: VerifyEnvironment,
  settingsStore: DesktopSettingsStore,
): string | undefined {
  if (verifyEnv.verifyHome === undefined || verifyEnv.isVerifyInteractive) return undefined
  const transparentBitmap = Buffer.alloc(2 * 2 * 4)
  const transparentPng = nativeImage
    .createFromBitmap(transparentBitmap, { width: 2, height: 2, scaleFactor: 1 })
    .toPNG()
  settingsStore.setBackground('canvas', transparentPng)

  const sourceWidth = 320
  const sourceHeight = 240
  const sidebarBitmap = Buffer.alloc(sourceWidth * sourceHeight * 4)
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      const offset = (y * sourceWidth + x) * 4
      const alternate = x < sourceWidth / 2 !== y < sourceHeight / 2
      sidebarBitmap[offset] = alternate ? 238 : 24
      sidebarBitmap[offset + 1] = alternate ? 72 : 212
      sidebarBitmap[offset + 2] = alternate ? 42 : 238
      sidebarBitmap[offset + 3] = 255
    }
  }
  const verifyBackgroundSource = join(verifyEnv.verifyHome, 'background-selection.png')
  writeFileSync(
    verifyBackgroundSource,
    nativeImage
      .createFromBitmap(sidebarBitmap, {
        width: sourceWidth,
        height: sourceHeight,
        scaleFactor: 1,
      })
      .toPNG(),
    { mode: 0o600 },
  )
  return verifyBackgroundSource
}

/** 自动验收首次就绪时在隔离项目目录下创建初始 Workspace 与会话。 */
export async function seedVerifySession(options: {
  readonly verifyProject: string | undefined
  readonly targetUrl: URL
  readonly fetchImpl: typeof fetch
  readonly sessionCookie: string | undefined
}): Promise<void> {
  const { verifyProject, targetUrl, fetchImpl, sessionCookie } = options
  const projectPath = verifyProject ?? process.cwd()
  try {
    const created = parseDesktopWorkspaceCreateResult(
      await callDshHost(
        targetUrl,
        'createWorkspace',
        { path: projectPath },
        fetchImpl,
        sessionCookie,
      ),
    )
    await callDshHost(
      targetUrl,
      'createSessionForWorkspace',
      { workspaceId: created.workspace.workspaceId },
      fetchImpl,
      sessionCookie,
    )
  } catch (error) {
    // 首选装配失败不能静默：退回普通会话会让项目相关阶段失去工作区，必须留下原因。
    console.warn('桌面验收创建隔离工作区失败，改用普通会话：', error)
    await callDshHost(targetUrl, 'createSession', { cwd: projectPath }, fetchImpl, sessionCookie)
  }
}

/** 构造启动期或超时期的失败验收报告，避免非验收启动静态加载完整验收器。 */
export function createStartupFailedVerifyReport(
  verificationStage: VerifyStage,
  error: unknown,
  hostReady: boolean,
): VerifyReport {
  return {
    verificationStage,
    hostReady,
    startupScreen: false,
    startupCapture: '',
    startupDarkCapture: '',
    appMounted: false,
    uiActive: false,
    frame: false,
    islandCount: 0,
    canvasCount: 0,
    pageScrollable: false,
    transparentRoots: false,
    settingsDialog: false,
    settingsFocusInside: false,
    settingsLayerCount: 0,
    settingsAccent: '',
    settingsCanvasOpacity: '',
    settingsCanvasAlpha: 0,
    settingsCanvasImageApplied: false,
    settingsPanelFits: false,
    frameOpacity: '',
    islandsOpaque: false,
    nativeSettingsTrigger: false,
    nativeSettingsDialog: false,
    nativeSettingsSidebarRaised: false,
    nativeSettingsTopmost: false,
    nativeAppearanceEntry: false,
    nativeAppearanceEntryPlaced: false,
    appearanceMenu: false,
    appearanceAccelerator: '',
    capture: '',
    darkCapture: '',
    darkSettingsReadable: false,
    largeCapture: '',
    largeLayoutStable: false,
    mediumToolbarStable: false,
    narrowCapture: '',
    narrowSettingsFits: false,
    nativeCapture: '',
    clearCapture: '',
    blank: true,
    error: error instanceof Error ? error.message : String(error),
  }
}

/** 隐去运行核心诊断文本中可能出现的凭据前缀或头部字段值。 */
export function redactHostDiagnostic(message: string): string {
  return message
    .replace(/\b(?:sk|key)-[0-9A-Za-z_-]{12,}\b/gu, '[凭据已隐藏]')
    .replace(
      /\b(authorization|api[_-]?key|token|password)(\s*[:=]\s*)([^\s,;]+)/giu,
      '$1$2[已隐藏]',
    )
    .slice(0, 500)
}
