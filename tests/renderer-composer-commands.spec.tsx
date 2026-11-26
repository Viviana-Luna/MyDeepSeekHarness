// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => {
  const session = {
    sessionId: '会话-1',
    updatedAt: 1,
    running: false,
    blank: false,
    projections: { values: { plan: { active: false, pending: false } } },
  }
  const snapshot = {
    selectedSessionId: '会话-1',
    activeView: 'conversation',
    sessions: [session],
    hostStatus: { kind: 'ready' as const, ownership: 'external' as const, identity: {} },
    error: null as string | null,
    sessionDrafts: {} as Record<string, string>,
    sessionCommandDirectory: {
      status: 'ready' as 'idle' | 'loading' | 'ready' | 'stale' | 'error',
      value: {
        commands: [
          { name: 'compact', description: '压缩当前上下文' },
          { name: 'review', description: '审阅当前工作区变更' },
          { name: 'inspect', description: '检查运行状态' },
          { name: 'trace', description: '打开轨迹视图' },
          { name: 'summarize', description: '总结当前会话' },
          { name: 'tests', description: '运行限定测试' },
          { name: 'lint', description: '运行限定 lint' },
        ],
        skills: [
          {
            name: 'plan-project-change',
            description: '整理项目变更计划',
            whenToUse: '规划实现前的边界、验收和停止条件',
            modelInvocable: true,
          },
          {
            name: 'skill-review',
            description: '审查 Skill 说明',
            whenToUse: 'review skill instruction',
            modelInvocable: true,
          },
        ],
      },
      error: null as string | null,
      commandError: null as string | null,
      skillError: null as string | null,
    },
    sessionCommandExecution: null as {
      phase: 'submitting' | 'running' | 'success' | 'error'
      name: string
      commandId?: string
      text?: string
    } | null,
    sessionModels: {
      current: { provider: '测试提供方', model: 'mock' },
      routable: true,
      groups: [
        {
          id: '测试提供方',
          name: '测试提供方',
          models: [{ id: 'mock', name: 'Mock' }],
        },
      ],
      failures: [],
    },
    sessionPermission: null,
    loadingSessionModels: false,
    selectingSessionModel: false,
    switchingPermissionPreset: false,
    sessionModelsError: null as string | null,
    awaitingResponseSessionIds: [] as string[],
    sessionQueue: { items: [], totalCount: 0, omittedCount: 0, truncated: false },
    sendingMessage: false,
    busyEnter: 'queue' as const,
  }
  const store = {
    getSnapshot: () => snapshot,
    clearError: vi.fn(),
    selectedSession: vi.fn(() => session),
    loadSessionModels: vi.fn(async () => true),
    loadPermissionCatalog: vi.fn(async () => true),
    loadSessionCommandDirectory: vi.fn(async () => true),
    submitComposerInput: vi.fn(async () => true),
    executeSessionCommand: vi.fn(async () => true),
    setSessionDraft: vi.fn((sessionId: string, text: string) => {
      snapshot.sessionDrafts =
        text === ''
          ? Object.fromEntries(
              Object.entries(snapshot.sessionDrafts).filter(([id]) => id !== sessionId),
            )
          : { ...snapshot.sessionDrafts, [sessionId]: text }
      snapshot.error = null
    }),
    clearSessionDraft: vi.fn((sessionId: string, submittedText?: string) => {
      const current = snapshot.sessionDrafts[sessionId]
      if (current === undefined || (submittedText !== undefined && current !== submittedText))
        return
      snapshot.sessionDrafts = Object.fromEntries(
        Object.entries(snapshot.sessionDrafts).filter(([id]) => id !== sessionId),
      )
    }),
    cancelSession: vi.fn(async () => undefined),
    selectSessionModel: vi.fn(async () => true),
    selectPermissionPreset: vi.fn(async () => true),
  }
  return { session, snapshot, store }
})

vi.mock('../src/renderer/src/hooks/useWorkspace.ts', () => ({
  useWorkspaceSnapshot: () => mocked.snapshot,
  useWorkspaceStore: () => mocked.store,
}))

import { Composer } from '../src/renderer/src/features/composer/Composer.tsx'
import { COMMAND_PALETTE_LISTBOX_ID } from '../src/renderer/src/features/composer/CommandPalette.tsx'

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  mocked.session.sessionId = '会话-1'
  mocked.session.running = false
  mocked.session.projections.values.plan = { active: false, pending: false }
  mocked.snapshot.selectedSessionId = '会话-1'
  mocked.snapshot.error = null
  mocked.snapshot.sessionDrafts = {}
  mocked.snapshot.sessionCommandDirectory = {
    status: 'ready',
    value: {
      commands: [
        { name: 'compact', description: '压缩当前上下文' },
        { name: 'review', description: '审阅当前工作区变更' },
        { name: 'inspect', description: '检查运行状态' },
        { name: 'trace', description: '打开轨迹视图' },
        { name: 'summarize', description: '总结当前会话' },
        { name: 'tests', description: '运行限定测试' },
        { name: 'lint', description: '运行限定 lint' },
      ],
      skills: [
        {
          name: 'plan-project-change',
          description: '整理项目变更计划',
          whenToUse: '规划实现前的边界、验收和停止条件',
          modelInvocable: true,
        },
        {
          name: 'skill-review',
          description: '审查 Skill 说明',
          whenToUse: 'review skill instruction',
          modelInvocable: true,
        },
      ],
    },
    error: null,
    commandError: null,
    skillError: null,
  }
  mocked.snapshot.sessionCommandExecution = null
  mocked.snapshot.sessionModels = {
    current: { provider: '测试提供方', model: 'mock' },
    routable: true,
    groups: [
      {
        id: '测试提供方',
        name: '测试提供方',
        models: [{ id: 'mock', name: 'Mock' }],
      },
    ],
    failures: [],
  }
  mocked.snapshot.sessionPermission = null
  mocked.snapshot.loadingSessionModels = false
  mocked.snapshot.selectingSessionModel = false
  mocked.snapshot.switchingPermissionPreset = false
  mocked.snapshot.sessionModelsError = null
  mocked.snapshot.awaitingResponseSessionIds = []
  mocked.snapshot.sessionQueue = { items: [], totalCount: 0, omittedCount: 0, truncated: false }
  mocked.snapshot.sendingMessage = false
  mocked.snapshot.busyEnter = 'queue'
  mocked.store.selectedSession.mockReturnValue(mocked.session)
  mocked.store.submitComposerInput.mockResolvedValue(true)
  mocked.store.executeSessionCommand.mockResolvedValue(true)
})

function renderComposer() {
  return render(<Composer />)
}

function composerTextArea(): HTMLTextAreaElement {
  return document.querySelector('#composer') as HTMLTextAreaElement
}

function inputDraft(value: string, caret = value.length): void {
  const textarea = composerTextArea()
  textarea.focus()
  fireEvent.change(textarea, {
    target: {
      value,
      selectionStart: caret,
      selectionEnd: caret,
    },
  })
}

function optionId(kind: 'command' | 'skill' | 'category', name: string): string {
  return `命令候选-${kind}:${name}`
}

function pressComposingEnter(textarea: HTMLTextAreaElement): void {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, 'isComposing', { configurable: true, value: true })
  fireEvent(textarea, event)
}

describe('Composer 斜杠命令面板集成', () => {
  it('写到一半可从命令入口选择 Skill 和切换模式，搜索与分类不改草稿', async () => {
    mocked.snapshot.sessionCommandDirectory.value.commands.push({
      name: 'plan',
      description: '切换规划模式',
    })
    const view = renderComposer()
    const draft = '先检查输入框，再修复窗口布局'
    inputDraft(draft, 6)
    fireEvent.click(screen.getByRole('button', { name: '打开命令与 Skill' }))
    fireEvent.click(screen.getByRole('option', { name: /^Skill/u }))
    const search = screen.getByRole('combobox', { name: '搜索命令与 Skill' })
    expect(document.activeElement).toBe(search)
    fireEvent.change(search, { target: { value: '规划' } })
    expect(composerTextArea().value).toBe(draft)
    fireEvent.keyDown(search, { key: 'Enter' })
    const next = `/plan-project-change ${draft}`
    await waitFor(() => {
      expect(composerTextArea().value).toBe(next)
    })
    expect(composerTextArea().selectionStart).toBe('/plan-project-change '.length + 6)
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '打开命令与 Skill' }))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.click(screen.getByRole('option', { name: /^命令/u }))
    expect(screen.queryByRole('option', { name: /\/plan-project-change/u })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '返回分类' }))
    expect(screen.getAllByRole('option')).toHaveLength(2)
    fireEvent.click(screen.getByRole('button', { name: '关闭候选面板' }))
    expect(screen.queryByRole('dialog', { name: '命令与 Skill' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '打开命令与 Skill' }))
    expect(screen.getByRole('dialog', { name: '命令与 Skill' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '打开命令与 Skill' }))
    expect(screen.queryByRole('dialog', { name: '命令与 Skill' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '切换工作模式' }))
    expect(screen.getByRole('menu', { name: '工作模式' }).dataset.menuMorph).toBe('settled')
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Plan 模式' }))
    await waitFor(() => {
      expect(mocked.store.executeSessionCommand).toHaveBeenCalledWith('/plan', '会话-1')
    })
    mocked.session.projections.values.plan.active = true
    view.rerender(<Composer />)
    expect(
      screen.getByRole('button', { name: '退出 Plan 模式' }).getAttribute('data-plan-active'),
    ).toBe('true')
    expect(composerTextArea().placeholder).toBe('描述你的任务以生成计划…')
    fireEvent.click(screen.getByRole('button', { name: '退出 Plan 模式' }))
    await waitFor(() => {
      expect(mocked.store.executeSessionCommand).toHaveBeenLastCalledWith('/plan off', '会话-1')
    })
    expect(composerTextArea().value).toBe(next)
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()
  })

  it('模式切换失败时保留原模式、草稿与可重试菜单', async () => {
    mocked.snapshot.sessionCommandDirectory.value.commands.push({
      name: 'plan',
      description: '切换规划模式',
    })
    mocked.store.executeSessionCommand.mockResolvedValue(false)
    renderComposer()
    inputDraft('不要丢失这段内容')
    fireEvent.click(screen.getByRole('button', { name: '切换工作模式' }))
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Plan 模式' }))
    await waitFor(() => {
      expect(mocked.store.executeSessionCommand).toHaveBeenCalledWith('/plan', '会话-1')
    })
    expect(
      screen.getByRole('menuitemradio', { name: '普通模式' }).getAttribute('aria-checked'),
    ).toBe('true')
    expect(composerTextArea().value).toBe('不要丢失这段内容')
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()
  })

  it('附件入口使用回形针，命令入口使用命令提示符图标', () => {
    renderComposer()

    const attachButton = screen.getByRole('button', { name: '附加图片' })
    expect(attachButton.hasAttribute('disabled')).toBe(false)
    expect(attachButton.getAttribute('title')).toContain('PNG')
    expect(attachButton.querySelector('.lucide-paperclip')).not.toBeNull()
    expect(
      screen.getByRole('button', { name: '打开命令与 Skill' }).querySelector('.lucide-terminal'),
    ).not.toBeNull()
    expect(screen.queryByRole('button', { name: '选择 Skill' })).toBeNull()
    expect(attachButton.textContent).toBe('')
  })

  it('输入 / 打开 Portal listbox，并在 textarea 上维护 ARIA 关系', async () => {
    renderComposer()

    inputDraft('/')

    const textarea = composerTextArea()
    const listbox = await screen.findByRole('listbox', { name: '命令候选' })
    const palette = screen.getByRole('dialog', { name: '命令与 Skill' })
    expect(palette.parentElement).toBe(document.body)
    expect(listbox.id).toBe(COMMAND_PALETTE_LISTBOX_ID)
    expect(textarea.getAttribute('aria-controls')).toBe(COMMAND_PALETTE_LISTBOX_ID)
    expect(textarea.getAttribute('aria-expanded')).toBe('true')
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('category', 'skill'))
    expect(listbox.getAttribute('aria-activedescendant')).toBe(optionId('category', 'skill'))
    expect(within(listbox).getAllByRole('option')).toHaveLength(2)
    expect(within(listbox).getByRole('option', { name: /Skill/u })).toBeTruthy()
    expect(within(listbox).getByRole('option', { name: /^命令/u })).toBeTruthy()

    inputDraft('/review')

    const filtered = screen.getByRole('listbox', { name: '命令候选' })
    expect(within(filtered).getByRole('option', { name: /^review/u })).toBeTruthy()
    expect(within(filtered).getByRole('option', { name: /\/skill-review/u })).toBeTruthy()
    expect(within(filtered).queryByRole('option', { name: /^compact/u })).toBeNull()
    expect(composerTextArea().getAttribute('aria-activedescendant')).toBe(
      optionId('command', 'review'),
    )
  })

  it('支持 Arrow、Home、End、PageUp、PageDown、Tab、Enter 和 Escape 键盘行为', async () => {
    renderComposer()
    inputDraft('/')
    await screen.findByRole('listbox', { name: '命令候选' })
    fireEvent.click(screen.getByRole('option', { name: /^命令/u }))
    const textarea = screen.getByRole('listbox', { name: '命令候选' })

    fireEvent.keyDown(textarea, { key: 'ArrowDown' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('command', 'review'))
    fireEvent.keyDown(textarea, { key: 'ArrowUp' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('command', 'compact'))
    fireEvent.keyDown(textarea, { key: 'End' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('command', 'lint'))
    fireEvent.keyDown(textarea, { key: 'Home' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('command', 'compact'))
    fireEvent.keyDown(textarea, { key: 'PageDown' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('command', 'tests'))
    fireEvent.keyDown(textarea, { key: 'PageUp' })
    expect(textarea.getAttribute('aria-activedescendant')).toBe(optionId('command', 'compact'))

    fireEvent.keyDown(textarea, { key: 'Tab' })
    expect(mocked.store.setSessionDraft).toHaveBeenLastCalledWith('会话-1', '/compact ')
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()

    cleanup()
    mocked.snapshot.sessionDrafts = {}
    vi.clearAllMocks()
    renderComposer()
    inputDraft('/')
    await screen.findByRole('listbox', { name: '命令候选' })
    fireEvent.click(screen.getByRole('option', { name: /^命令/u }))
    const commands = screen.getByRole('listbox', { name: '命令候选' })
    fireEvent.keyDown(commands, { key: 'ArrowDown' })
    fireEvent.keyDown(commands, { key: 'Enter' })
    expect(mocked.store.setSessionDraft).toHaveBeenLastCalledWith('会话-1', '/review ')
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()

    cleanup()
    mocked.snapshot.sessionDrafts = {}
    vi.clearAllMocks()
    renderComposer()
    inputDraft('/')
    await screen.findByRole('listbox', { name: '命令候选' })
    fireEvent.keyDown(composerTextArea(), { key: 'Escape' })
    expect(screen.queryByRole('listbox', { name: '命令候选' })).toBeNull()
    expect(composerTextArea().getAttribute('aria-expanded')).toBe('false')
  })

  it('IME 组合输入期间 Enter 不选择命令，也不提交消息', async () => {
    renderComposer()
    inputDraft('/')
    await screen.findByRole('listbox', { name: '命令候选' })
    vi.clearAllMocks()

    pressComposingEnter(composerTextArea())

    expect(mocked.store.setSessionDraft).not.toHaveBeenCalled()
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()
    expect(screen.getByRole('listbox', { name: '命令候选' })).toBeTruthy()
  })

  it('Host Command 与 Skill 同名时禁用两条候选并说明当前不可执行', async () => {
    mocked.snapshot.sessionCommandDirectory.value = {
      commands: [{ name: 'review-code', description: 'Host 审查命令' }],
      skills: [
        {
          name: 'review-code',
          description: '代码审查 Skill',
          whenToUse: '需要审查代码时使用',
          modelInvocable: true,
        },
      ],
    }
    renderComposer()
    inputDraft('/review-code')

    const options = await screen.findAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options.every(option => option.getAttribute('aria-disabled') === 'true')).toBe(true)
    expect(options[0]?.textContent).toContain('暂不能从面板执行')
    expect(options[1]?.textContent).toContain('暂不能从面板执行')
  })

  it('目录重新加载并保留旧候选时，不引用尚未渲染的 listbox 或 option', async () => {
    const view = renderComposer()
    inputDraft('/compact')
    await screen.findByRole('listbox', { name: '命令候选' })
    expect(composerTextArea().getAttribute('aria-controls')).toBe(COMMAND_PALETTE_LISTBOX_ID)
    expect(composerTextArea().getAttribute('aria-activedescendant')).toBe(
      optionId('command', 'compact'),
    )

    mocked.snapshot.sessionCommandDirectory = {
      status: 'loading',
      value: {
        commands: [{ name: 'compact', description: '压缩当前上下文' }],
        skills: [],
      },
      error: null,
      commandError: null,
      skillError: null,
    }
    view.rerender(<Composer />)

    expect(screen.queryByRole('listbox', { name: '命令候选' })).toBeNull()
    expect(screen.getByRole('status').textContent).toContain('正在加载命令')
    expect(composerTextArea().getAttribute('aria-controls')).toBeNull()
    expect(composerTextArea().getAttribute('aria-activedescendant')).toBeNull()
  })

  it('选择候选只插入规范 /name 前缀和空格，不直接执行命令', async () => {
    renderComposer()
    inputDraft('/compact')
    await screen.findByRole('listbox', { name: '命令候选' })
    vi.clearAllMocks()

    fireEvent.click(screen.getByRole('option', { name: /^compact/u }))

    expect(mocked.store.setSessionDraft).toHaveBeenCalledWith('会话-1', '/compact ')
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()
  })

  it('未知斜杠输入按提交路径交给 store，提交失败时不清草稿', async () => {
    renderComposer()
    inputDraft('/unknown')
    vi.clearAllMocks()
    mocked.store.submitComposerInput.mockReset()
    mocked.store.submitComposerInput.mockResolvedValueOnce(false)

    fireEvent.keyDown(composerTextArea(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocked.store.submitComposerInput).toHaveBeenCalledWith(
        '/unknown',
        'queue',
        undefined,
        '会话-1',
      )
    })
    expect(mocked.store.clearSessionDraft).not.toHaveBeenCalled()
    expect(mocked.snapshot.sessionDrafts['会话-1']).toBe('/unknown')
  })
})

describe('Composer 普通消息提交和运行状态', () => {
  it('普通消息 Enter 正常提交，成功后只清理对应 Session 的匹配草稿', async () => {
    renderComposer()
    inputDraft('你好，DSH')
    vi.clearAllMocks()
    mocked.store.submitComposerInput.mockReset()
    mocked.store.submitComposerInput.mockResolvedValueOnce(true)

    fireEvent.keyDown(composerTextArea(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocked.store.clearSessionDraft).toHaveBeenCalledWith('会话-1', '你好，DSH')
    })
    expect(mocked.store.submitComposerInput).toHaveBeenCalledWith(
      '你好，DSH',
      'queue',
      undefined,
      '会话-1',
    )
    expect(mocked.snapshot.sessionDrafts['会话-1']).toBeUndefined()
  })

  it('普通消息提交失败时保留草稿，等待用户继续编辑或重试', async () => {
    const view = renderComposer()
    inputDraft('网络失败时不要丢')
    vi.clearAllMocks()
    mocked.store.submitComposerInput.mockReset()
    mocked.store.submitComposerInput.mockResolvedValueOnce(false)

    fireEvent.keyDown(composerTextArea(), { key: 'Enter' })

    await waitFor(() => {
      expect(mocked.store.submitComposerInput).toHaveBeenCalledWith(
        '网络失败时不要丢',
        'queue',
        undefined,
        '会话-1',
      )
    })
    expect(mocked.store.clearSessionDraft).not.toHaveBeenCalled()
    expect(mocked.snapshot.sessionDrafts['会话-1']).toBe('网络失败时不要丢')
    mocked.snapshot.error = '连接失败，请重试'
    view.rerender(<Composer />)
    const alert = screen.getByRole('alert')
    expect(alert.parentElement).toBe(document.body)
    expect(alert.className).toContain('app-alert--error')
    fireEvent.click(screen.getByRole('button', { name: '关闭提示' }))
    expect(mocked.store.clearError).toHaveBeenCalledWith('连接失败，请重试')
    expect(composerTextArea().value).toBe('网络失败时不要丢')
  })

  it('命令运行状态和 DSH 回复状态应独立呈现', () => {
    mocked.snapshot.sessionCommandExecution = {
      phase: 'running',
      name: 'compact',
      commandId: '命令-1',
    }
    mocked.snapshot.awaitingResponseSessionIds = ['会话-1']

    renderComposer()

    expect(screen.queryByText('等待 DSH')).toBeNull()
    expect(screen.getByRole('status', { name: '正在执行 /compact' }).textContent).toBe('')
    inputDraft('压缩期间继续编辑')
    fireEvent.keyDown(composerTextArea(), { key: 'Enter' })
    expect(mocked.store.submitComposerInput).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: '停止运行' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '发送' })).toBeNull()
  })
})
