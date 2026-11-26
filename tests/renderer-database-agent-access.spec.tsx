// @vitest-environment jsdom
/** 验证数据库 Agent 权限先开启连接再选择档位，并允许表规则进一步收窄。 */
import { ConfigProvider } from 'antd'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, expect, it } from 'vitest'
import {
  createDefaultAgentAccess,
  DatabaseAgentAccessTab,
  validateAgentAccessDraft,
} from '../src/renderer/src/features/connections/DatabaseAgentAccessTab.tsx'

afterEach(cleanup)

function AccessHarness() {
  const [value, setValue] = useState(createDefaultAgentAccess)
  return (
    <ConfigProvider>
      <DatabaseAgentAccessTab value={value} onChange={setValue} />
    </ConfigProvider>
  )
}

it('连接默认关闭，开启后先使用只读档位，再允许切换到数据读写或完整访问', () => {
  render(<AccessHarness />)
  const enabled = screen.getByRole('switch', { name: '向模型开放此连接' })
  expect(enabled.getAttribute('aria-checked')).toBe('false')
  expect(screen.queryByRole('button', { name: /只读/ })).toBeNull()

  fireEvent.click(enabled)
  const readonly = screen.getByRole('button', { name: /只读/ })
  expect(readonly.getAttribute('aria-pressed')).toBe('true')

  fireEvent.click(screen.getByRole('button', { name: /数据读写/ }))
  expect(screen.getByRole('button', { name: /数据读写/ }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByRole('button', { name: /完整访问/ }).getAttribute('aria-pressed')).toBe(
    'false',
  )

  fireEvent.click(screen.getByRole('button', { name: '添加表规则' }))
  expect((screen.getByRole('checkbox', { name: '新增' }) as HTMLInputElement).checked).toBe(true)
  expect((screen.getByRole('checkbox', { name: 'DDL' }) as HTMLInputElement).disabled).toBe(true)
})

it('Agent 权限草稿校验对 SQLite 前置拦截 sqlite_* 系统保留表', () => {
  const error = validateAgentAccessDraft(
    {
      enabled: true,
      mode: 'readonly',
      tableRules: [
        {
          schema: 'main',
          table: 'sqlite_master',
          select: true,
          insert: false,
          update: false,
          delete: false,
          ddl: false,
        },
      ],
    },
    'sqlite',
  )
  expect(error).toContain('系统保留表 sqlite_master')
})
