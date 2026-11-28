// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { ConfigProvider } from 'antd'
import { useState, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { HostStatus } from '../src/renderer/src/platform/contracts.ts'

const mocked = vi.hoisted(() => ({
  snapshot: {
    selectedSessionId: '会话-1' as string | null,
    activeView: 'conversation',
    newSessionProjectId: null as string | null,
    newSessionDraft: '',
    hostStatus: { kind: 'ready', ownership: 'external', identity: {} } as HostStatus,
    sessionPermission: null as {
      currentValue: string
      options: { value: string; name: string; selectable: boolean }[]
    } | null,
    permissionCatalogError: null as string | null,
    loadingPermissionCatalog: false,
    permissionSelection: {
      currentValue: 'workspace-write',
      options: [
        { value: 'workspace-write', name: 'workspace-write', selectable: true },
        { value: 'danger-full-access', name: 'danger-full-access', selectable: true },
        { value: 'read-only', name: 'read-only', selectable: true },
      ],
    },
    sessionModels: {
      current: { provider: '提供方', model: 'flash', reasoningEffort: 'high' },
      routable: true,
      groups: [
        {
          id: '提供方',
          name: '模型提供方',
          models: [
            {
              id: 'flash',
              name: 'Flash',
              reasoning: {
                efforts: [
                  { id: 'high', name: '高' },
                  { id: 'max', name: '最大' },
                ],
                defaultEffort: 'high',
              },
            },
            {
              id: 'pro',
              name: 'Pro',
              reasoning: {
                efforts: [
                  { id: 'low', name: '低' },
                  { id: 'max', name: '最大' },
                ],
                defaultEffort: 'low',
              },
            },
          ],
        },
      ],
      failures: [],
    },
    loadingSessionModels: false,
    selectingSessionModel: false,
    switchingPermissionPreset: false,
    sessionModelsError: null as string | null,
    awaitingResponseSessionIds: [] as string[],
    sessionQueue: { items: [], totalCount: 0, omittedCount: 0, truncated: false },
    creatingSession: false,
    sendingMessage: false,
    choosingAttachments: false,
    sessionDrafts: { '会话-1': '' } as Record<string, string>,
    sessionAttachments: {} as Record<string, readonly unknown[]>,
    busyEnter: 'queue' as const,
    error: null as string | null,
  },
  session: {
    sessionId: '会话-1',
    updatedAt: 1,
    running: false,
    blank: false,
    // 读数条只在会话已有投影时出现，布局用例按真实会话给一份读数。
    projections: {
      asOfSeq: 1,
      values: {
        tokenUsage: {
          uncachedInputTokens: 1_200,
          cacheReadTokens: 40_000,
          cacheWriteTokens: 0,
          outputTokens: 9_000,
        },
        contextPressure: { projectedTokens: 42_000, contextWindow: 128_000 },
        sessionStats: {
          turns: 1,
          steps: 2,
          llmMs: 900,
          toolMs: 0,
          ttftSteps: 1,
          ttftMs: 300,
          decodeMs: 600,
          decodeTokens: 9_000,
        },
      },
    },
  },
  store: {
    selectedSession: vi.fn(),
    getSnapshot: vi.fn(),
    loadSessionModels: vi.fn(async () => true),
    loadPermissionCatalog: vi.fn(async () => true),
    selectSessionModel: vi.fn(async () => true),
    selectPermissionPreset: vi.fn(async () => true),
    chooseSessionAttachments: vi.fn(async () => true),
    removeSessionAttachment: vi.fn(),
    clearSessionAttachments: vi.fn(),
    clearSessionDraft: vi.fn(),
    setSessionDraft: vi.fn(),
    setNewSessionDraft: vi.fn(),
    ensureComposerSession: vi.fn(async () => '新会话-1' as string | null),
    submitComposerInput: vi.fn(async () => true),
    sendMessage: vi.fn(async () => true),
    cancelSession: vi.fn(async () => undefined),
    respondPendingInteraction: vi.fn(async () => ({ accepted: true as const })),
    openPlanPreview: vi.fn(),
    closePlanPreview: vi.fn(),
  },
}))

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => ({
    ...mocked.snapshot,
    sessions: mocked.store.selectedSession() ? [mocked.store.selectedSession()] : [],
  }),
  useWorkspaceStore: () => mocked.store,
}))

import { AppAlert } from '../src/renderer/src/shared/ui/AppAlert.tsx'
import { Composer } from '../src/renderer/src/features/composer/Composer.tsx'
import { PendingInteractionPanel } from '../src/renderer/src/features/composer/PendingInteractionPanel.tsx'
import {
  ModelSelector,
  PermissionSelector,
} from '../src/renderer/src/features/composer/ComposerControls.tsx'
import { ChatComposer } from '../src/renderer/src/pages/workspace/components/mainpanel/chat-mainpanel/index.tsx'

afterEach(cleanup)

const render = (element: ReactElement) =>
  renderView(element, {
    wrapper: ({ children }) => (
      <ConfigProvider theme={{ token: { motion: false } }}>{children}</ConfigProvider>
    ),
  })

function ModelFocusControls() {
  return (
    <>
      <button type="button">其他操作</button>
      <ModelSelector />
    </>
  )
}

function TrajectoryComposerHarness({ collapsible }: { collapsible: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  return (
    <ChatComposer
      collapsible={collapsible}
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
    />
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocked.store.selectSessionModel.mockReset().mockResolvedValue(true)
  mocked.store.selectPermissionPreset.mockReset().mockResolvedValue(true)
  mocked.store.selectedSession.mockReturnValue(mocked.session)
  mocked.store.getSnapshot.mockImplementation(() => mocked.snapshot)
  mocked.snapshot.selectedSessionId = '会话-1'
  mocked.snapshot.newSessionProjectId = null
  mocked.snapshot.newSessionDraft = ''
  mocked.snapshot.hostStatus = { kind: 'ready', ownership: 'external', identity: {} }
  mocked.snapshot.awaitingResponseSessionIds = []
  mocked.snapshot.choosingAttachments = false
  mocked.snapshot.creatingSession = false
  mocked.snapshot.sessionDrafts = { '会话-1': '' }
  mocked.snapshot.sessionAttachments = {}
  mocked.session.running = false
  mocked.snapshot.sessionPermission = mocked.snapshot.permissionSelection
  mocked.snapshot.permissionCatalogError = null
  mocked.snapshot.loadingPermissionCatalog = false
  mocked.snapshot.sessionModels.current = {
    provider: '提供方',
    model: 'flash',
    reasoningEffort: 'high',
  }
  mocked.snapshot.sessionModelsError = null
})

describe('Composer 会话控制', () => {
  const planInteraction = {
    kind: 'question' as const,
    key: 'question:plan-1',
    questions: [
      {
        id: 'plan-review',
        question: '审阅计划',
        detail:
          '# 周末行程\n\n先确定交通，再安排游览。\n\n' +
          '| 时间 | 行程 |\n| --- | --- |\n| 早晨 | 出发 |\n'.repeat(100),
        options: [{ label: 'Approve' }, { label: 'Keep planning' }],
        intent: { kind: 'plan-review' as const, approve: 'Approve', callId: 'plan-call-1' },
      },
    ],
  }

  it('计划审阅只呈现摘要和独立操作，自动打开全文，批准使用核心选项原值', async () => {
    render(<PendingInteractionPanel interaction={planInteraction} />)
    expect(screen.getByRole('region', { name: '计划待审' })).toBeTruthy()
    expect(screen.queryByRole('radio')).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByText(planInteraction.questions[0]!.detail)).toBeNull()
    expect(mocked.store.openPlanPreview).toHaveBeenCalledWith(
      '会话-1',
      'plan-call-1',
      planInteraction.questions[0]!.detail,
      'question:plan-1',
    )
    fireEvent.click(screen.getByRole('button', { name: '查看全文' }))
    expect(mocked.store.respondPendingInteraction).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '同意执行' }))
    await waitFor(() =>
      expect(mocked.store.respondPendingInteraction).toHaveBeenCalledWith({
        kind: 'question',
        sessionId: '会话-1',
        key: 'question:plan-1',
        answers: [{ id: 'plan-review', selected: ['Approve'] }],
      }),
    )
  })

  it('要求修改取消审阅并返回输入，不提交批准或切换模式', async () => {
    render(<PendingInteractionPanel interaction={planInteraction} />)
    fireEvent.click(screen.getByRole('button', { name: '要求修改' }))
    await waitFor(() =>
      expect(mocked.store.respondPendingInteraction).toHaveBeenCalledWith({
        kind: 'question-cancel',
        sessionId: '会话-1',
        key: 'question:plan-1',
      }),
    )
    expect(mocked.store.closePlanPreview).toHaveBeenCalledOnce()
  })

  it('审阅提交失败后显示错误并恢复操作', async () => {
    mocked.store.respondPendingInteraction.mockRejectedValueOnce(new Error('连接暂时不可用'))
    render(<PendingInteractionPanel interaction={planInteraction} />)
    fireEvent.click(screen.getByRole('button', { name: '同意执行' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('连接暂时不可用'))
    expect(screen.getByRole('button', { name: '同意执行' })).toHaveProperty('disabled', false)
  })

  it('把 ask_user_question 的选项与自由输入合并成一批结构化回答', async () => {
    render(
      <PendingInteractionPanel
        interaction={{
          kind: 'question',
          key: 'question:rpc-1',
          questions: [
            {
              id: 'school',
              header: '学校归属',
              question: '请选择学校',
              options: [{ label: '红明小学 (Recommended)', description: '使用新学校代码' }],
            },
            { id: 'note', question: '还需要补充什么？' },
          ],
        }}
      />,
    )

    fireEvent.click(screen.getByRole('radio', { name: /红明小学/u }))
    fireEvent.change(screen.getByPlaceholderText('输入你的回答'), {
      target: { value: '保留老师账号清单' },
    })
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    await waitFor(() => {
      expect(mocked.store.respondPendingInteraction).toHaveBeenCalledWith({
        kind: 'question',
        sessionId: '会话-1',
        key: 'question:rpc-1',
        answers: [
          { id: 'school', selected: ['红明小学 (Recommended)'] },
          { id: 'note', selected: [], custom: '保留老师账号清单' },
        ],
      })
    })
  })

  it('把提权申请限制为拒绝或允许当前一次操作', async () => {
    render(
      <PendingInteractionPanel
        interaction={{
          kind: 'approval',
          key: 'approval:rpc-2',
          approvalId: '审批-2',
          toolName: 'Bash',
          reason: '把两个交付文件复制到 Downloads',
        }}
      />,
    )

    expect(screen.getByText('把两个交付文件复制到 Downloads')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /永久/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await waitFor(() => {
      expect(mocked.store.respondPendingInteraction).toHaveBeenCalledWith({
        kind: 'approval',
        sessionId: '会话-1',
        key: 'approval:rpc-2',
        outcome: 'allowed-once',
      })
    })
  })

  it('完全权限关闭菜单并在独立弹窗中确认，勾选前不能提交', async () => {
    const view = render(<PermissionSelector />)
    expect(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' }))
    const permissionMenu = screen.getByRole('menu', { name: '选择访问模式' })
    expect(within(permissionMenu).queryByText('访问模式')).toBeNull()
    expect(within(permissionMenu).queryByText('同时控制文件范围与审批策略')).toBeNull()
    expect(screen.getByRole('menuitemradio', { name: '仅可查看' })).toBeTruthy()
    expect(
      screen.getByRole('menuitemradio', { name: '工作区内修改' }).getAttribute('aria-checked'),
    ).toBe('true')

    fireEvent.click(screen.getByRole('menuitemradio', { name: '完全权限' }))
    const dialog = screen.getByRole('dialog', { name: '启用完全权限？' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(view.container.contains(dialog)).toBe(false)
    expect(dialog.getAttribute('aria-modal')).toBe('true')
    expect(within(dialog).getByText(/当前会话/u)).toBeTruthy()
    // 未勾选「我已了解风险」之前不能启用。
    expect(screen.getByRole('button', { name: '启用完全权限' })).toHaveProperty('disabled', true)
    expect(mocked.store.selectPermissionPreset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解风险/u }))
    fireEvent.click(screen.getByRole('button', { name: '启用完全权限' }))
    await waitFor(() => {
      expect(mocked.store.selectPermissionPreset).toHaveBeenCalledWith(
        'danger-full-access',
        '会话-1',
      )
    })
  })

  it('取消风险确认保持原权限，重新打开时清除上次勾选', async () => {
    render(<PermissionSelector />)
    const trigger = screen.getByRole('button', { name: '访问模式，当前：工作区内修改' })
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '完全权限' }))
    fireEvent.click(screen.getByRole('checkbox', { name: /我已了解风险/u }))
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(mocked.store.selectPermissionPreset).not.toHaveBeenCalled()
    expect(trigger.getAttribute('aria-label')).toBe('访问模式，当前：工作区内修改')
    fireEvent.click(trigger)
    fireEvent.click(screen.getByRole('menuitemradio', { name: '完全权限' }))
    expect(screen.getByRole('checkbox')).toHaveProperty('checked', false)
    expect(screen.getByRole('button', { name: '启用完全权限' })).toHaveProperty('disabled', true)
  })

  it.each(['切换会话', '撤销选项'] as const)(
    '%s 后取消已勾选的风险确认，不提交过期权限',
    async change => {
      const view = render(<PermissionSelector />)
      fireEvent.click(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' }))
      fireEvent.click(screen.getByRole('menuitemradio', { name: '完全权限' }))
      fireEvent.click(screen.getByRole('checkbox'))
      if (change === '切换会话') mocked.snapshot.selectedSessionId = '会话-2'
      else
        mocked.snapshot.sessionPermission = {
          ...mocked.snapshot.permissionSelection,
          options: mocked.snapshot.permissionSelection.options.filter(
            option => option.value !== 'danger-full-access',
          ),
        }
      view.rerender(<PermissionSelector />)
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(mocked.store.selectPermissionPreset).not.toHaveBeenCalled()
    },
  )

  it('Auto review 使用同一确认弹窗，提交失败后保留原权限', async () => {
    mocked.snapshot.sessionPermission = {
      ...mocked.snapshot.permissionSelection,
      options: [
        ...mocked.snapshot.permissionSelection.options,
        { value: 'auto', name: 'Auto review', selectable: true },
      ],
    }
    mocked.store.selectPermissionPreset.mockResolvedValue(false)
    render(<PermissionSelector />)
    fireEvent.click(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Auto review' }))
    expect(screen.getByRole('dialog', { name: '启用 Auto review？' })).toBeTruthy()
    expect(screen.getByText(/可能误放行或误拒绝/u)).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '启用 Auto review' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' })).toBeTruthy(),
    )
    expect(mocked.store.selectPermissionPreset).toHaveBeenCalledWith('auto', '会话-1')
  })

  it('自动审核提权明确保留沙箱，勾选风险后才提交独立预设', async () => {
    mocked.snapshot.sessionPermission = {
      ...mocked.snapshot.permissionSelection,
      options: [
        ...mocked.snapshot.permissionSelection.options,
        { value: 'auto-review', name: 'auto-review', selectable: true },
      ],
    }
    render(<PermissionSelector />)
    fireEvent.click(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '自动审核提权' }))
    expect(screen.getByRole('dialog', { name: '启用自动审核提权？' })).toBeTruthy()
    expect(screen.getByText(/保留工作区沙箱，使用当前会话模型/u)).toBeTruthy()
    expect(screen.getByRole('button', { name: '启用自动审核提权' })).toHaveProperty(
      'disabled',
      true,
    )
    fireEvent.click(screen.getByRole('checkbox'))
    fireEvent.click(screen.getByRole('button', { name: '启用自动审核提权' }))
    await waitFor(() =>
      expect(mocked.store.selectPermissionPreset).toHaveBeenCalledWith('auto-review', '会话-1'),
    )
  })

  it('会话读数条挂在输入卡片下方的同一 dock 内', () => {
    render(<Composer />)
    const card = document.querySelector('.composer-card')
    const footer = card?.querySelector('footer')
    expect(card).not.toBeNull()
    expect(footer).not.toBeNull()
    // 读数条不在工具行里，而是卡片之后的下一个兄弟节点（真实外壳里由 composer-dock 承载）。
    expect(footer?.querySelector('[data-composer-readings="true"]')).toBeNull()
    expect(
      document.querySelector('.composer-card + [data-composer-readings="true"]'),
    ).not.toBeNull()
    expect(document.querySelectorAll('.composer-card').length).toBe(1)
  })

  it('读数条仅在外层空间不足时隐藏，恢复空间后重新显示', () => {
    const view = render(<Composer showReadings={false} />)
    expect(document.querySelector('[data-composer-readings="true"]')).toBeNull()
    view.rerender(<Composer showReadings />)
    expect(document.querySelector('[data-composer-readings="true"]')).not.toBeNull()
  })

  it('权限目录或当前值未到达时不渲染，目录失败时在菜单里给出原因与重试', () => {
    mocked.snapshot.sessionPermission = null
    const view = render(<PermissionSelector />)
    expect(screen.queryByText('权限不可用')).toBeNull()
    view.unmount()

    mocked.snapshot.permissionCatalogError = '运行核心返回了无效的权限预设目录'
    render(<PermissionSelector />)
    const trigger = screen.getByRole('button', { name: /权限不可用/u })
    expect(trigger.getAttribute('title')).toBe('运行核心返回了无效的权限预设目录')
    fireEvent.click(trigger)
    const errorMenu = screen.getByRole('menu', { name: '选择访问模式' })
    expect(within(errorMenu).queryByText('访问模式')).toBeNull()
    expect(within(errorMenu).queryByText('同时控制文件范围与审批策略')).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('运行核心返回了无效的权限预设目录')
    fireEvent.click(screen.getByRole('menuitem', { name: /重试/u }))
    expect(mocked.store.loadPermissionCatalog).toHaveBeenCalledWith(true)
  })

  it('直接列出模型并从对应行一次提交模型和推理等级', async () => {
    const view = render(<ModelSelector />)
    const trigger = screen.getByRole('button', { name: /Flash · 高/u })
    fireEvent.click(trigger)
    const root = screen.getByRole('menu', { name: '选择模型' })
    expect(root.dataset.menuMorph).toBe('settled')
    expect(within(root).getByRole('group', { name: '模型提供方' })).toBeTruthy()
    const pro = within(root).getByRole('menuitemradio', { name: 'Pro' })
    expect(pro.textContent).toContain('低')

    fireEvent.mouseEnter(pro)
    const submenu = screen.getByRole('menu', { name: 'Pro 推理等级' })
    expect(
      within(submenu).getByRole('menuitemradio', { name: '低' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(mocked.store.selectSessionModel).not.toHaveBeenCalled()
    fireEvent.click(within(submenu).getByRole('menuitemradio', { name: '最大' }))
    await waitFor(() =>
      expect(mocked.store.selectSessionModel).toHaveBeenCalledWith(
        { provider: '提供方', model: 'pro', reasoningEffort: 'max' },
        '会话-1',
      ),
    )
    await waitFor(() => expect(screen.queryByRole('menu', { name: '选择模型' })).toBeNull())

    mocked.snapshot.sessionModels.current.reasoningEffort = 'max'
    view.rerender(<ModelSelector />)
    fireEvent.click(trigger)
    const flash = screen.getByRole('menuitemradio', { name: 'Flash' })
    fireEvent.keyDown(flash, { key: 'ArrowRight' })
    const max = screen.getByRole('menuitemradio', { name: '最大' })
    expect(max.getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(max, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: 'Flash 推理等级' })).toBeNull()
    expect(document.activeElement).toBe(flash)
    fireEvent.keyDown(flash, { key: 'Escape' })
    expect(screen.queryByRole('menu', { name: '选择模型' })).toBeNull()
    expect(document.activeElement).toBe(trigger)
  })

  it.each([
    { retry: false, moveOutside: false },
    { retry: true, moveOutside: false },
    { retry: false, moveOutside: true },
  ])(
    '模型目录异步到达时尊重当前焦点（重试 $retry，已移开 $moveOutside）',
    async ({ retry, moveOutside }) => {
      const snapshot: { sessionModels: typeof mocked.snapshot.sessionModels | null } =
        mocked.snapshot
      const directory = snapshot.sessionModels
      snapshot.sessionModels = null
      mocked.snapshot.loadingSessionModels = !retry
      mocked.snapshot.sessionModelsError = retry ? '读取模型失败' : null
      try {
        const view = render(<ModelFocusControls />)
        const trigger = screen.getByRole('button', { name: /^模型：/u })
        trigger.focus()
        fireEvent.click(trigger)
        const menu = screen.getByRole('menu', { name: '选择模型' })
        if (retry) {
          const retryButton = within(menu).getByRole('menuitem', { name: '重试' })
          await waitFor(() => expect(document.activeElement).toBe(retryButton))
          fireEvent.click(retryButton)
          expect(mocked.store.loadSessionModels).toHaveBeenCalledWith(true, '会话-1')
          mocked.snapshot.loadingSessionModels = true
          mocked.snapshot.sessionModelsError = null
          view.rerender(<ModelFocusControls />)
        }
        await waitFor(() => expect(document.activeElement).toBe(menu))
        const outside = screen.getByRole('button', { name: '其他操作' })
        if (moveOutside) outside.focus()
        snapshot.sessionModels = directory
        mocked.snapshot.loadingSessionModels = false
        view.rerender(<ModelFocusControls />)
        const flash = within(menu).getByRole('menuitemradio', { name: 'Flash' })
        expect(document.activeElement).toBe(moveOutside ? outside : flash)
        if (!moveOutside) {
          fireEvent.keyDown(flash, { key: 'ArrowDown' })
          expect(document.activeElement).toBe(
            within(menu).getByRole('menuitemradio', { name: 'Pro' }),
          )
        }
      } finally {
        snapshot.sessionModels = directory
        mocked.snapshot.loadingSessionModels = false
      }
    },
  )

  it('模型切换失败时保留列表、原选择和错误提示', async () => {
    mocked.store.selectSessionModel.mockResolvedValueOnce(false)
    const view = render(<ModelSelector />)
    fireEvent.click(screen.getByRole('button', { name: /Flash · 高/u }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pro' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '低' }))
    await waitFor(() => expect(mocked.store.selectSessionModel).toHaveBeenCalled())
    mocked.snapshot.sessionModelsError = '模型切换失败，请重试'
    view.rerender(<ModelSelector />)
    expect(screen.getByRole('alert').textContent).toBe('模型切换失败，请重试')
    expect(screen.getByRole('menuitemradio', { name: 'Flash' }).getAttribute('aria-checked')).toBe(
      'true',
    )
    expect(screen.getByRole('menuitemradio', { name: 'Pro' })).toHaveProperty('disabled', false)
  })

  it('权限菜单通过 Portal 贴合触发器，并在顶部空间不足时保持在视口内', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    render(<PermissionSelector />)
    const trigger = screen.getByRole<HTMLButtonElement>('button', {
      name: '访问模式，当前：工作区内修改',
    })
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 12,
      y: 10,
      width: 160,
      height: 32,
      top: 10,
      right: 172,
      bottom: 42,
      left: 12,
      toJSON: () => ({}),
    })

    fireEvent.click(trigger)

    const menu = await screen.findByRole('menu', { name: '选择访问模式' })
    expect(menu.parentElement).toBe(document.body)
    expect(menu.dataset.anchoredMenu).toBe('true')
    expect(menu.dataset.menuMorph).toBe('settled')
    expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8)
    expect(menu.style.visibility).toBe('visible')
  })

  it('等待与回复时只显示停止动作，空闲后恢复发送按钮', () => {
    mocked.snapshot.awaitingResponseSessionIds = ['会话-1']
    const view = render(<Composer />)
    expect(screen.queryByText('等待 DSH')).toBeNull()
    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy()
    expect(document.querySelector('.stop-button')).not.toBeNull()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
    expect(screen.getByRole('button', { name: /Flash · 高/u })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' })).toHaveProperty(
      'disabled',
      false,
    )

    mocked.snapshot.awaitingResponseSessionIds = []
    mocked.session.running = true
    view.rerender(<Composer />)
    expect(screen.queryByText('DSH 正在回复')).toBeNull()
    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '加入队列' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Flash · 高/u }))
    expect(screen.getByRole('menu', { name: '选择模型' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Pro' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: '低' }))
    expect(mocked.store.selectSessionModel).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '访问模式，当前：工作区内修改' }))
    expect(screen.getByRole('menu', { name: '选择访问模式' })).toBeTruthy()

    mocked.session.running = false
    view.rerender(<Composer />)
    expect(screen.queryByRole('button', { name: '停止运行' })).toBeNull()
    expect(screen.getByRole('button', { name: '发送' })).toBeTruthy()
    expect(document.querySelector('.stop-button')).toBeNull()
  })

  it('图片入口可用，并把当前会话交给原生图片选择器', () => {
    render(<Composer />)

    fireEvent.click(screen.getByRole('button', { name: '附加图片' }))

    expect(mocked.store.chooseSessionAttachments).toHaveBeenCalledWith('会话-1')
  })

  it('新增项目没有真实会话时允许输入第一条消息与选择模型，点击模型入口后实体化会话并加载列表', async () => {
    const previousModels = mocked.snapshot.sessionModels
    mocked.store.selectedSession.mockReturnValue(undefined)
    mocked.snapshot.selectedSessionId = null
    mocked.snapshot.newSessionProjectId = 'project:新项目'
    ;(mocked.snapshot as { sessionModels: typeof previousModels | null }).sessionModels = null
    try {
      const view = render(<Composer />)
      const input = screen.getByPlaceholderText<HTMLTextAreaElement>('输入第一条消息以创建会话…')
      expect(input).toHaveProperty('disabled', false)
      expect(screen.getByRole<HTMLButtonElement>('button', { name: '附加图片' })).toHaveProperty(
        'disabled',
        true,
      )
      const modelTrigger = screen.getByRole<HTMLButtonElement>('button', { name: '模型：选择模型' })
      expect(modelTrigger.disabled).toBe(false)

      mocked.store.ensureComposerSession.mockResolvedValueOnce(null)
      mocked.snapshot.error = '创建新会话失败'
      fireEvent.click(modelTrigger)
      expect(await screen.findByRole('alert')).toHaveProperty('textContent', '创建新会话失败重试')

      mocked.snapshot.error = null
      mocked.store.ensureComposerSession.mockResolvedValueOnce('新会话-1')
      fireEvent.click(screen.getByRole('menuitem', { name: '重试' }))
      await waitFor(() => {
        expect(mocked.store.ensureComposerSession).toHaveBeenCalledTimes(2)
        expect(mocked.store.loadSessionModels).toHaveBeenCalledWith(false, '新会话-1')
      })
      expect(screen.getByRole('menu', { name: '选择模型' })).toBeTruthy()

      fireEvent.change(input, { target: { value: '第一条消息' } })
      expect(mocked.store.setNewSessionDraft).toHaveBeenCalledWith('第一条消息')

      mocked.snapshot.newSessionDraft = '第一条消息'
      view.rerender(<Composer />)
      fireEvent.click(screen.getByRole('button', { name: '发送' }))

      await waitFor(() => {
        expect(mocked.store.submitComposerInput).toHaveBeenCalledWith(
          '第一条消息',
          'queue',
          undefined,
          undefined,
        )
      })
      expect(mocked.store.clearSessionDraft).not.toHaveBeenCalled()
    } finally {
      mocked.snapshot.sessionModels = previousModels
      mocked.snapshot.error = null
    }
  })

  it('Host 重连期间禁用输入与会话控件，连接恢复后重新启用', () => {
    mocked.snapshot.hostStatus = { kind: 'connecting', message: '正在重新连接' }
    const view = render(<Composer />)

    expect(screen.getByRole<HTMLTextAreaElement>('combobox')).toHaveProperty('disabled', true)
    expect(screen.getByPlaceholderText('正在恢复运行核心…')).toBeTruthy()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '附加图片' })).toHaveProperty(
      'disabled',
      true,
    )
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: '访问模式，当前：工作区内修改' }),
    ).toHaveProperty('disabled', true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: /Flash · 高/u })).toHaveProperty(
      'disabled',
      true,
    )

    mocked.snapshot.hostStatus = { kind: 'ready', ownership: 'external', identity: {} }
    view.rerender(<Composer />)

    expect(screen.getByRole<HTMLTextAreaElement>('combobox')).toHaveProperty('disabled', false)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '附加图片' })).toHaveProperty(
      'disabled',
      false,
    )
  })

  it('轨迹模式允许收起与展开输入区，待响应交互到达时保持可见', () => {
    Object.assign(mocked.snapshot, {
      pendingInteractions: [],
      composerHeight: 112,
      navigationWidth: 260,
      informationWidth: 260,
    })
    const view = render(<TrajectoryComposerHarness collapsible={false} />)
    expect(screen.queryByRole('button', { name: '收起输入框' })).toBeNull()

    view.rerender(<TrajectoryComposerHarness collapsible />)
    const collapseButton = screen.getByRole('button', { name: '收起输入框' })
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true')
    fireEvent.click(collapseButton)

    const expandButton = screen.getByRole('button', { name: '展开输入框' })
    expect(expandButton.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.composer-card')).toBeNull()
    expect(document.querySelector('.composer-dock')?.getAttribute('data-composer-collapsed')).toBe(
      'true',
    )

    Object.assign(mocked.snapshot, {
      pendingInteractions: [
        {
          kind: 'approval',
          key: 'approval:trace-1',
          approvalId: '审批-轨迹',
          toolName: 'Bash',
          reason: '需要确认命令',
        },
      ],
    })
    view.rerender(<TrajectoryComposerHarness collapsible />)
    expect(screen.getByText('需要确认命令')).toBeTruthy()

    Object.assign(mocked.snapshot, { pendingInteractions: [] })
    view.rerender(<TrajectoryComposerHarness collapsible />)
    fireEvent.click(screen.getByRole('button', { name: '展开输入框' }))
    expect(document.querySelector('.composer-card')).not.toBeNull()
    expect(screen.getByRole('button', { name: '收起输入框' })).toBeTruthy()
  })
})

it('错误提示自动消失，悬停与键盘聚焦期间暂停剩余计时', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const close = vi.fn()
    render(
      <AppAlert tone="error" title="操作未完成" floating dismissAfterMs={1000} onClose={close}>
        文件上传失败
      </AppAlert>,
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600)
    })
    fireEvent.mouseEnter(screen.getByRole('alert'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(close).not.toHaveBeenCalled()
    fireEvent.focus(screen.getByRole('button', { name: '关闭提示' }))
    fireEvent.mouseLeave(screen.getByRole('alert'))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(close).not.toHaveBeenCalled()
    fireEvent.blur(screen.getByRole('button', { name: '关闭提示' }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(close).toHaveBeenCalledOnce()
  } finally {
    vi.useRealTimers()
  }
})
