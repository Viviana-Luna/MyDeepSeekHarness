import { PRODUCT_UPDATE_REPOSITORY } from '../../shared/product.ts'
import { isRecord } from '../../shared/validation.ts'

const MAX_RELEASE_RESPONSE_BYTES = 1024 * 1024

interface Version {
  numbers: number[]
  prerelease: string[]
}

export interface AvailableProjectUpdate {
  version: string
  releaseNotes: string
  downloadUrl: string
}

interface ProjectUpdateCheckOptions {
  currentVersion: string
  platform?: NodeJS.Platform
  arch?: string
  fetchImpl?: typeof fetch
  signal?: AbortSignal
}

function parseVersion(input: string): Version | undefined {
  if (input.length > 100) return undefined
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-z-]+(?:\.[\da-z-]+)*))?$/iu.exec(input)
  if (match === null) return undefined
  const numbers = [Number(match[1]), Number(match[2]), Number(match[3])]
  const prerelease = match[4]?.split('.') ?? []
  if (
    !numbers.every(Number.isSafeInteger) ||
    prerelease.some(
      part =>
        /^\d+$/u.test(part) &&
        (!Number.isSafeInteger(Number(part)) || (part.length > 1 && part.startsWith('0'))),
    )
  ) {
    return undefined
  }
  return { numbers, prerelease }
}

function compareVersions(left: Version, right: Version): number {
  for (const [index, value] of left.numbers.entries()) {
    const difference = value - (right.numbers[index] ?? 0)
    if (difference !== 0) return difference
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1
  if (right.prerelease.length === 0) return -1
  for (const [index, value] of left.prerelease.entries()) {
    const other = right.prerelease[index]
    if (other === undefined) return 1
    if (value === other) continue
    const numeric = /^\d+$/u.test(value)
    const otherNumeric = /^\d+$/u.test(other)
    if (numeric && otherNumeric) return Number(value) - Number(other)
    if (numeric !== otherNumeric) return numeric ? -1 : 1
    return value < other ? -1 : 1
  }
  return left.prerelease.length - right.prerelease.length
}

async function readReleaseList(response: Response): Promise<unknown[]> {
  const contentLength = response.headers.get('content-length')
  if (
    contentLength !== null &&
    (!Number.isSafeInteger(Number(contentLength)) ||
      Number(contentLength) < 0 ||
      Number(contentLength) > MAX_RELEASE_RESPONSE_BYTES)
  ) {
    await response.body?.cancel()
    throw new Error('更新服务返回了超出限制的内容。')
  }
  if (response.body === null) throw new Error('更新服务返回了空内容。')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    /* oxlint-disable no-await-in-loop -- 分块读取并及时取消超出大小限制的响应。 */
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > MAX_RELEASE_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('更新服务返回了超出限制的内容。')
      }
      chunks.push(result.value)
    }
    /* oxlint-enable no-await-in-loop */
  } finally {
    reader.releaseLock()
  }
  let input: unknown
  try {
    input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('更新服务返回了无效 JSON。')
  }
  if (!Array.isArray(input) || input.length > 20) {
    throw new Error('更新服务返回了无效的 Release 列表。')
  }
  return input as unknown[]
}

export async function checkForProjectUpdate(
  options: ProjectUpdateCheckOptions,
): Promise<AvailableProjectUpdate | undefined> {
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  if (!(
    (platform === 'win32' && arch === 'x64') ||
    (platform === 'darwin' && ['arm64', 'x64'].includes(arch))
  ))
    return undefined
  const current = parseVersion(options.currentVersion)
  if (current === undefined) throw new Error('当前应用版本无效。')
  const timeout = AbortSignal.timeout(30_000)
  const response = await (options.fetchImpl ?? fetch)(
    `https://api.github.com/repos/${PRODUCT_UPDATE_REPOSITORY}/releases?per_page=20`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'MyDSH',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      redirect: 'error',
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    },
  )
  if (response.status === 404) throw new Error('更新仓库尚未公开，暂时无法检查新版本。')
  if (!response.ok) throw new Error(`更新检查失败（HTTP ${String(response.status)}），请稍后重试。`)
  const releases = await readReleaseList(response)
  let latestVersion = current
  let update: AvailableProjectUpdate | undefined
  for (const release of releases) {
    if (
      !isRecord(release) ||
      typeof release.tag_name !== 'string' ||
      typeof release.draft !== 'boolean' ||
      typeof release.prerelease !== 'boolean' ||
      !Array.isArray(release.assets) ||
      release.assets.length > 30
    ) {
      throw new Error('更新服务返回了结构异常的 Release。')
    }
    if (release.draft || !release.tag_name.startsWith('v')) continue
    const versionText = release.tag_name.slice(1)
    const version = parseVersion(versionText)
    if (version === undefined) continue
    if (current.prerelease.length === 0 && (release.prerelease || version.prerelease.length > 0))
      continue
    if (compareVersions(version, latestVersion) <= 0) continue
    const assetName =
      platform === 'win32'
        ? `mydsh-Windows-x64-${versionText}.exe`
        : `mydsh-macOS-${arch}-${versionText}.dmg`
    const assets: unknown[] = release.assets
    const asset = assets.find(item => isRecord(item) && item.name === assetName)
    if (!isRecord(asset)) continue
    const downloadUrl = `https://github.com/${PRODUCT_UPDATE_REPOSITORY}/releases/download/${release.tag_name}/${assetName}`
    if (
      asset.browser_download_url !== downloadUrl ||
      !Number.isSafeInteger(asset.size) ||
      Number(asset.size) <= 0
    ) {
      throw new Error(`版本 ${versionText} 的安装包信息无效。`)
    }
    latestVersion = version
    update = {
      version: versionText,
      releaseNotes:
        typeof release.body === 'string'
          ? release.body
              // oxlint-disable-next-line no-control-regex -- Release 文本去除控制字符，保留换行与制表符。
              .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '')
              .slice(0, 4000)
              .trim()
          : '',
      downloadUrl,
    }
  }
  return update
}
