// @vitest-environment jsdom
/** 验证 SSH 命令与远程文件修改确认卡片交互：命令/Diff 预览、风险告警、单次与会话授权及与普通问答路由隔离。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PendingInteractionPanel } from '../src/renderer/src/features/composer/PendingInteractionPanel.tsx'
import type { DesktopPendingInteraction } from '../src/renderer/src/platform/contracts.ts'

const harness = vi.hoisted(() => ({
  respondPendingInteraction: vi.fn(),
  sessionId: 'session-ssh-consent',
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => ({
    selectedSessionId: harness.sessionId,
    sessions: [{ sessionId: harness.sessionId }],
  }),
  useWorkspaceStore: () => ({
    respondPendingInteraction: harness.respondPendingInteraction,
  }),
}))

afterEach(() => {
  cleanup()
  harness.respondPendingInteraction.mockReset()
})

function encodePreview(payload: {
  kind: 'command' | 'diff'
  title: string
  content: string
  risks: string[]
}): string {
  return `MYDSH_SSH_PREVIEW_V1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

it('渲染 SSH 命令执行确认卡与高危提示，并支持一次点击批准', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  const command = 'sudo systemctl restart nginx'
  const interaction: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-ssh-exec',
    questions: [
      {
        id: 'mydsh-ssh-consent:host-1',
        header: 'SSH 权限提权',
        question: '允许在服务器「线上网关」执行以下 SSH 命令吗？',
        detail: [
          '- 服务器：线上网关 (ops@10.0.0.8:22)',
          '- 工作目录：/srv/gateway',
          '- 权限提升：临时允许本次 sudo',
          '',
          encodePreview({
            kind: 'command',
            title: '待执行 SSH 命令',
            content: command,
            risks: ['影响运行中的服务或进程', '包含 sudo / 提权执行，将强制单次确认'],
          }),
        ].join('\n'),
        options: [
          { label: '提权并允许本次操作', description: '仅授权本次执行一次。' },
          { label: '拒绝', description: '拒绝本次请求。' },
        ],
      },
    ],
  }

  render(<PendingInteractionPanel interaction={interaction} />)
  expect(screen.getByLabelText('SSH 权限提权')).toBeTruthy()
  expect(screen.getByLabelText('待执行 SSH 命令').textContent).toBe(command)
  expect(screen.getByRole('note', { name: '风险提示' }).textContent).toContain('sudo')
  expect(screen.queryByRole('button', { name: /本次会话/u })).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '提权并允许本次操作' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-ssh-exec',
      answers: [{ id: 'mydsh-ssh-consent:host-1', selected: ['提权并允许本次操作'] }],
    }),
  )
})

it('渲染 SFTP 远程文件修改确认卡并展示 Unified Diff 与会话放行按钮', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  const diff = [
    '--- a/srv/app/.env',
    '+++ b/srv/app/.env',
    '@@ -1,2 +1,2 @@',
    '-PORT=3000',
    '+PORT=8080',
    ' NODE_ENV=production',
  ].join('\n')
  const interaction: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-ssh-write',
    questions: [
      {
        id: 'mydsh-ssh-consent:host-1',
        header: 'SSH 远程文件修改确认',
        question: '允许在服务器「测试主机」局部修改文件 /srv/app/.env 吗？',
        detail: [
          '- 服务器：测试主机 (ops@10.0.0.9:22)',
          '- 目标文件：/srv/app/.env',
          '- 变更统计：+1 / -1 行',
          '',
          encodePreview({
            kind: 'diff',
            title: '远程文件变更预览：/srv/app/.env',
            content: diff,
            risks: [],
          }),
        ].join('\n'),
        options: [
          { label: '允许本次写入', description: '仅授权本次写入一次。' },
          { label: '本次会话允许该主机常规操作', description: '当前会话内免重复确认。' },
          { label: '拒绝', description: '拒绝本次请求。' },
        ],
      },
    ],
  }

  render(<PendingInteractionPanel interaction={interaction} />)
  expect(screen.getByLabelText('SSH 远程文件修改确认')).toBeTruthy()
  const preview = screen.getByLabelText('远程文件变更预览：/srv/app/.env')
  expect(preview.textContent).toContain('+PORT=8080')
  expect(preview.textContent).toContain('-PORT=3000')

  fireEvent.click(screen.getByRole('button', { name: '本次会话允许该主机常规操作' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-ssh-write',
      answers: [{ id: 'mydsh-ssh-consent:host-1', selected: ['本次会话允许该主机常规操作'] }],
    }),
  )
})
