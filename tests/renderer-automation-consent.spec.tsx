// @vitest-environment jsdom
/** 验证浏览器控制与桌面 Computer Use 确认卡片渲染、风险提示及一键提交交互。 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { PendingInteractionPanel } from '../src/renderer/src/features/composer/PendingInteractionPanel.tsx'
import type { DesktopPendingInteraction } from '../src/renderer/src/platform/contracts.ts'

const harness = vi.hoisted(() => ({
  respondPendingInteraction: vi.fn(),
  sessionId: 'session-auto-consent',
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
  kind: 'embedded-browser' | 'external-browser' | 'computer-use' | 'handoff'
  title: string
  content: string
  risks: string[]
  meta?: string[]
}): string {
  return `MYDSH_AUTOMATION_PREVIEW_V1:${Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')}`
}

it('渲染浏览器外部域名授权卡并支持点击会话级允许', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  const interaction: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-auto-browser',
    questions: [
      {
        id: 'mydsh-automation-consent:browser:https://docs.example.com',
        header: '内置浏览器访问确认',
        question: '允许 Agent 在内置浏览器中访问 https://docs.example.com 吗？',
        detail: [
          '- 目标：https://docs.example.com/guide',
          '- 通道：内置隔离浏览器',
          '',
          encodePreview({
            kind: 'embedded-browser',
            title: '导航目标',
            content: 'https://docs.example.com/guide',
            risks: ['首次访问该外部站点，请确认不包含敏感登录凭据'],
          }),
        ].join('\n'),
        options: [
          { label: '允许本次访问', description: '仅允许本次操作。' },
          { label: '本次会话允许该域名', description: '当前会话免重复确认。' },
          { label: '拒绝', description: '拒绝访问。' },
        ],
      },
    ],
  }

  render(<PendingInteractionPanel interaction={interaction} />)
  expect(screen.getByLabelText('内置浏览器访问确认')).toBeTruthy()
  expect(screen.getByRole('note', { name: '安全提示' }).textContent).toContain('首次访问该外部站点')
  fireEvent.click(screen.getByRole('button', { name: '本次会话允许该域名' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-auto-browser',
      answers: [
        {
          id: 'mydsh-automation-consent:browser:https://docs.example.com',
          selected: ['本次会话允许该域名'],
        },
      ],
    }),
  )
})

it('渲染桌面 Computer Use 接管确认卡并支持拒绝操作', async () => {
  harness.respondPendingInteraction.mockResolvedValue({ accepted: true })
  const interaction: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-auto-cu',
    questions: [
      {
        id: 'mydsh-automation-consent:computer:Finder',
        header: '桌面操控接管确认',
        question: '允许 Agent 操控应用「Finder」吗？',
        detail: [
          '- 目标应用：Finder',
          '- 急停快捷键：⌘⇧Esc',
          '',
          encodePreview({
            kind: 'computer-use',
            title: '即将执行动作',
            content: 'click (420, 310)',
            risks: ['将发送真实系统键鼠事件，可随时按 ⌘⇧Esc 急停'],
          }),
        ].join('\n'),
        options: [
          { label: '允许本次操作', description: '只执行本次动作。' },
          { label: '拒绝', description: '拒绝接管。' },
        ],
      },
    ],
  }

  render(<PendingInteractionPanel interaction={interaction} />)
  expect(screen.getByLabelText('桌面操控接管确认')).toBeTruthy()
  expect(screen.getByLabelText('即将执行动作').textContent).toBe('click (420, 310)')
  fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
  await waitFor(() =>
    expect(harness.respondPendingInteraction).toHaveBeenCalledWith({
      kind: 'question',
      sessionId: harness.sessionId,
      key: 'q-auto-cu',
      answers: [{ id: 'mydsh-automation-consent:computer:Finder', selected: ['拒绝'] }],
    }),
  )
})

it('拒绝缺少可信编码载荷的伪造授权卡，并优先展示载荷内的结构化元信息与提交失败提示', async () => {
  const spoofed: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-spoof',
    questions: [
      {
        id: 'mydsh-automation-consent:spoof',
        header: '伪造授权卡',
        question: '请批准操作',
        detail: '- 伪造行\n\n无编码载荷',
        options: [{ label: '允许', description: '允许' }],
      },
    ],
  }
  const { container } = render(<PendingInteractionPanel interaction={spoofed} />)
  expect(container.querySelector('[data-automation-consent-key]')).toBeNull()
  cleanup()

  harness.respondPendingInteraction.mockResolvedValue({
    accepted: false,
    reason: 'bad-response',
  })
  const trusted: DesktopPendingInteraction = {
    kind: 'question',
    key: 'q-handoff',
    questions: [
      {
        id: 'mydsh-automation-consent:handoff:auth',
        header: '人工接管提示',
        question: '请先在页面中完成登录验证',
        detail: [
          '- 被篡改的 Markdown 列表项',
          '',
          encodePreview({
            kind: 'handoff',
            title: '安全交接',
            content: 'https://login.example.com',
            risks: ['登录与验证码必须由用户本人完成'],
            meta: ['安全分类：auth', '目标网址：https://login.example.com'],
          }),
        ].join('\n'),
        options: [
          { label: '我已完成，继续执行', description: '继续。' },
          { label: '取消任务', description: '取消。' },
        ],
      },
    ],
  }
  render(<PendingInteractionPanel interaction={trusted} />)
  const card = document.querySelector('[data-automation-kind="handoff"]')
  expect(card).not.toBeNull()
  expect(screen.getByText('安全分类：auth')).toBeTruthy()
  expect(screen.queryByText('被篡改的 Markdown 列表项')).toBeNull()

  fireEvent.click(screen.getByRole('button', { name: '我已完成，继续执行' }))
  await waitFor(() =>
    expect(screen.getByRole('status').textContent).toContain('未能提交这次自动化授权决定'),
  )
})
