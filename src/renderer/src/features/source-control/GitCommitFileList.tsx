import { File } from 'lucide-react'
import type { GitCommitDetail } from './source-control-types.ts'

type CommitFile = GitCommitDetail['files'][number]

export function GitCommitFileList({
  files,
  selectedPath,
  disabled,
  onOpenFile,
}: {
  files: readonly CommitFile[]
  selectedPath: string | null
  disabled: boolean
  onOpenFile(file: CommitFile): void
}) {
  if (files.length === 0) return <p className="git-commit-files-empty">这个提交没有变更文件。</p>
  return (
    <ul aria-label="提交文件" className="git-commit-file-list">
      {files.map(file => {
        const separator = file.relativePath.lastIndexOf('/')
        const name = file.relativePath.slice(separator + 1)
        const directory = separator === -1 ? '' : file.relativePath.slice(0, separator)
        const description =
          file.originalPath === undefined
            ? file.relativePath
            : `${file.originalPath} → ${file.relativePath}`
        return (
          <li key={file.relativePath}>
            <button
              aria-current={selectedPath === file.relativePath ? 'true' : undefined}
              aria-label={`查看提交中的 ${description}`}
              className={`git-commit-file-row${selectedPath === file.relativePath ? ' is-selected' : ''}`}
              disabled={disabled}
              title={description}
              type="button"
              onClick={() => {
                onOpenFile(file)
              }}
            >
              <File aria-hidden="true" size={14} />
              <span className="git-commit-file-copy">
                <span className="git-commit-file-name">{name}</span>
                {directory !== '' && <span className="git-commit-file-directory">{directory}</span>}
              </span>
              <small
                className={`git-file-status git-file-status--${file.status.toLowerCase()}`}
                title={
                  file.binary
                    ? '二进制文件'
                    : `新增 ${String(file.additions)} 行，删除 ${String(file.deletions)} 行`
                }
              >
                {file.status}
              </small>
            </button>
          </li>
        )
      })}
    </ul>
  )
}
