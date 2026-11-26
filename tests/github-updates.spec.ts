import { describe, expect, it, vi } from 'vitest'
import { checkForProjectUpdate } from '../src/main/updates/github-updates.ts'
import { PRODUCT_UPDATE_REPOSITORY } from '../src/shared/product.ts'

function release(version: string) {
  const name = `mydsh-macOS-arm64-${version}.dmg`
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: version.includes('-'),
    body: '改善桌面体验。',
    assets: [
      {
        name,
        size: 123456,
        browser_download_url: `https://github.com/${PRODUCT_UPDATE_REPOSITORY}/releases/download/v${version}/${name}`,
      },
    ],
  }
}

describe('GitHub 安装包更新检查', () => {
  it('按版本顺序找到新版 DMG，安装到该版本后不再提示更新', async () => {
    const latest = release('0.1.0-preview.10')
    const releases = [
      release('0.1.0-preview.9'),
      { ...release('0.2.0'), draft: true },
      latest,
      release('0.1.0-preview.2'),
    ]
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(releases)))
    expect(
      await checkForProjectUpdate({
        platform: 'darwin',
        arch: 'arm64',
        currentVersion: '0.1.0-preview.9',
        fetchImpl,
      }),
    ).toEqual({
      version: '0.1.0-preview.10',
      releaseNotes: '改善桌面体验。',
      downloadUrl: latest.assets[0]?.browser_download_url,
    })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      `https://api.github.com/repos/${PRODUCT_UPDATE_REPOSITORY}/releases?per_page=20`,
    )
    expect(fetchImpl.mock.calls[0]?.[1]?.redirect).toBe('error')
    expect(
      await checkForProjectUpdate({
        platform: 'darwin',
        arch: 'arm64',
        currentVersion: '0.1.0-preview.10',
        fetchImpl,
      }),
    ).toBeUndefined()
  })

  it('拒绝把下载交给其他仓库或站点', async () => {
    const untrusted = release('0.1.0-preview.6')
    untrusted.assets[0]!.browser_download_url =
      'https://github.com/other/repository/releases/download/v1/MyDSH.dmg'
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([untrusted])))
    await expect(
      checkForProjectUpdate({
        platform: 'darwin',
        arch: 'arm64',
        currentVersion: '0.1.0-preview.5',
        fetchImpl,
      }),
    ).rejects.toThrow('安装包信息无效')
    expect(fetchImpl).toHaveBeenCalledOnce()
  })
})

it('Windows 只选本平台 x64 安装包，缺失时不退回 DMG', async () => {
  const mac = release('0.2.0')
  const asset = {
    ...mac.assets[0]!,
    name: 'mydsh-Windows-x64-0.2.0.exe',
    browser_download_url:
      'https://github.com/' +
      PRODUCT_UPDATE_REPOSITORY +
      '/releases/download/v0.2.0/mydsh-Windows-x64-0.2.0.exe',
  }
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify([mac])))
  const options = { currentVersion: '0.1.0', platform: 'win32' as const, arch: 'x64', fetchImpl }
  expect(await checkForProjectUpdate(options)).toBeUndefined()
  fetchImpl.mockImplementation(
    async () => new Response(JSON.stringify([{ ...mac, assets: [...mac.assets, asset] }])),
  )
  expect((await checkForProjectUpdate(options))?.downloadUrl).toBe(asset.browser_download_url)
  expect(await checkForProjectUpdate({ ...options, arch: 'arm64' })).toBeUndefined()
})
