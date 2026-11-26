import { FileWarning, Save, Trash2, X } from 'lucide-react'
import { useEffect, useRef, type MouseEvent } from 'react'
import { useProjectWorkspace } from '../project-workspace/ProjectWorkspaceProvider.tsx'

export function UnsavedChangesDialog() {
  const workspace = useProjectWorkspace()
  const dialogRef = useRef<HTMLDialogElement>(null)
  const reason = workspace.unsavedChangesReason

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return
    if (reason !== null && !dialog.open) {
      dialog.showModal()
      requestAnimationFrame(() => {
        dialog.querySelector<HTMLButtonElement>('.unsaved-dialog__save')?.focus()
      })
    } else if (reason === null && dialog.open) {
      dialog.close()
    }
  }, [reason])

  const cancel = () => {
    void workspace.resolveUnsavedChanges('cancel')
  }
  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (event.target !== event.currentTarget) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const outside =
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    if (outside) cancel()
  }

  return (
    <dialog
      ref={dialogRef}
      className="unsaved-dialog"
      aria-labelledby="unsaved-dialog-title"
      aria-describedby="unsaved-dialog-description"
      onCancel={event => {
        event.preventDefault()
        cancel()
      }}
      onClick={handleBackdropClick}
    >
      <div className="unsaved-dialog__frame">
        <header>
          <span className="unsaved-dialog__icon" aria-hidden="true">
            <FileWarning size={19} />
          </span>
          <div>
            <h2 id="unsaved-dialog-title">保存对文件的更改？</h2>
            <p id="unsaved-dialog-description">
              {workspace.unsavedChangesPaths?.length
                ? `${workspace.unsavedChangesPaths.slice(0, 3).join('、')}${workspace.unsavedChangesPaths.length > 3 ? ` 等 ${workspace.unsavedChangesPaths.length} 个文件` : ''}`
                : (workspace.selectedFile?.relativePath ?? '当前文件')}{' '}
              尚未保存。继续{reason ?? '当前操作'}前，请选择如何处理这些更改。
            </p>
          </div>
          <button
            type="button"
            aria-label="取消离开文件"
            disabled={workspace.fileSaving}
            onClick={cancel}
          >
            <X size={17} aria-hidden="true" />
          </button>
        </header>
        <footer>
          <button type="button" disabled={workspace.fileSaving} onClick={cancel}>
            取消
          </button>
          <button
            className="unsaved-dialog__discard"
            type="button"
            disabled={workspace.fileSaving}
            onClick={() => {
              void workspace.resolveUnsavedChanges('discard')
            }}
          >
            <Trash2 size={14} aria-hidden="true" />
            放弃更改
          </button>
          <button
            className="unsaved-dialog__save"
            type="button"
            disabled={workspace.fileSaving}
            onClick={() => {
              void workspace.resolveUnsavedChanges('save')
            }}
          >
            <Save size={14} aria-hidden="true" />
            {workspace.fileSaving ? '保存中…' : '保存并继续'}
          </button>
        </footer>
      </div>
    </dialog>
  )
}
