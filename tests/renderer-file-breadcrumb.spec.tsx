// @vitest-environment jsdom

/** 验证文件路径栏收起长目录时仍保留完整可访问路径。 */
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { FileBreadcrumb } from '../src/renderer/src/features/files/FileBreadcrumb.tsx'

afterEach(cleanup)

describe('文件路径栏', () => {
  it('长路径显示末尾三级，并提供完整路径', () => {
    const path = 'src/renderer/src/features/files/FileViewer.tsx'
    render(<FileBreadcrumb path={path} />)
    const breadcrumb = screen.getByRole('navigation', { name: `文件路径：${path}` })
    expect(breadcrumb.getAttribute('title')).toBe(path)
    expect(breadcrumb.textContent).toBe('…featuresfilesFileViewer.tsx')
    expect(within(breadcrumb).queryByText('renderer')).toBeNull()
  })
})
