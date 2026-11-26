import { File, FileCode2, FileImage, FileText, Globe2, type LucideIcon } from 'lucide-react'
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MessageCodeBlock } from './MessageCodeBlock.tsx'
import { AnchoredMenu } from '../../shared/ui/AnchoredMenu.tsx'
import { parseFileLink, projectRelativeFilePath, resolveFileMention } from './file-links.ts'
import styles from './ConversationView.module.css'
import { useStreamingReveal } from './useStreamingReveal.ts'

export interface MessageMarkdownProps {
  text: string
  projectCwd?: string | undefined
  files?: readonly string[] | undefined
  streaming?: boolean | undefined
  showCursor?: boolean | undefined
  onOpenFile?: ((relativePath: string, line?: number) => void | Promise<void>) | undefined
  onOpenFileInMain?: ((relativePath: string, line?: number) => void | Promise<void>) | undefined
}

const FileMentionScope = createContext(true)
const EMPTY_FILES: readonly string[] = []

const CODE_FILE =
  /\.(?:c|cc|cpp|cs|css|go|h|hpp|htm|html|java|js|jsx|json|jsonc|kt|kts|less|mjs|mts|php|py|rb|rs|sass|scss|sh|sql|swift|toml|ts|tsx|vue|xml|ya?ml|zsh)$/iu
const DOCUMENT_FILE = /\.(?:docx?|mdx?|pdf|pptx?|rtf|txt|xlsx?)$/iu
const IMAGE_FILE = /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)$/iu

function FileLinkIcon({ path }: { path: string }) {
  let Icon: LucideIcon = File
  if (CODE_FILE.test(path)) Icon = FileCode2
  else if (DOCUMENT_FILE.test(path)) Icon = FileText
  else if (IMAGE_FILE.test(path)) Icon = FileImage
  return <Icon className={styles.linkIcon} size={14} strokeWidth={1.8} aria-hidden="true" />
}

function FileReference({
  path,
  line,
  children,
  onOpenFile,
  onOpenFileInMain,
}: {
  path: string
  line?: number | undefined
  children: ReactNode
} & Pick<MessageMarkdownProps, 'onOpenFile' | 'onOpenFileInMain'>) {
  const [menuOpen, setMenuOpen] = useState(false)
  const anchorRef = useRef<HTMLButtonElement>(null)
  const dismissMenu = useCallback(() => {
    setMenuOpen(false)
  }, [])
  const openMenu = () => {
    if (onOpenFileInMain !== undefined) setMenuOpen(true)
  }
  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={styles.fileReference}
        title={path}
        aria-haspopup={onOpenFileInMain === undefined ? undefined : 'menu'}
        aria-expanded={menuOpen || undefined}
        onClick={() => {
          void (line === undefined ? onOpenFile?.(path) : onOpenFile?.(path, line))
        }}
        onContextMenu={event => {
          event.preventDefault()
          openMenu()
        }}
        onKeyDown={event => {
          if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
          event.preventDefault()
          openMenu()
        }}
      >
        <FileLinkIcon path={path} />
        {children}
      </button>
      <AnchoredMenu
        open={menuOpen}
        anchorRef={anchorRef}
        side="bottom"
        align="start"
        className="file-reference-menu"
        label={`${path} 的打开方式`}
        onDismiss={dismissMenu}
      >
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            setMenuOpen(false)
            void (line === undefined ? onOpenFileInMain?.(path) : onOpenFileInMain?.(path, line))
          }}
        >
          在文件模式中打开
        </button>
      </AnchoredMenu>
    </>
  )
}

function MessageCode({
  children,
  className,
  files,
  projectCwd,
  onOpenFile,
  onOpenFileInMain,
}: {
  children?: ReactNode
  className?: string | undefined
} & Pick<MessageMarkdownProps, 'files' | 'projectCwd' | 'onOpenFile' | 'onOpenFileInMain'>) {
  const enabled = useContext(FileMentionScope)
  const path =
    !enabled || onOpenFile === undefined
      ? undefined
      : resolveFileMention(String(children), files ?? [], projectCwd)
  return (
    <code className={className}>
      {path === undefined ? (
        children
      ) : (
        <FileReference path={path} onOpenFile={onOpenFile} onOpenFileInMain={onOpenFileInMain}>
          {children}
        </FileReference>
      )}
    </code>
  )
}

/** 消息只消费明确目标和事件投影的文件集合；打开动作仍由项目工作台拥有。 */
export const MessageMarkdown = memo(
  function MessageMarkdown({
    text,
    projectCwd,
    files = EMPTY_FILES,
    streaming = false,
    showCursor = false,
    onOpenFile,
    onOpenFileInMain,
  }: MessageMarkdownProps) {
    const canOpen = !streaming && onOpenFile !== undefined
    const visibleText = useStreamingReveal(text, streaming)
    return (
      <div className={styles.messageText} data-streaming-cursor={showCursor || undefined}>
        <Markdown
          remarkPlugins={[remarkGfm]}
          skipHtml
          components={{
            a: ({ href, children }) => {
              const label = (
                <FileMentionScope.Provider value={false}>{children}</FileMentionScope.Provider>
              )
              if (href !== undefined && /^(https?:|mailto:)/iu.test(href)) {
                const external = /^https?:/iu.test(href)
                return (
                  <a
                    className={styles.messageLink}
                    href={href}
                    target={external ? '_blank' : undefined}
                    rel={external ? 'noopener noreferrer' : undefined}
                  >
                    <Globe2
                      className={styles.linkIcon}
                      size={14}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                    {label}
                  </a>
                )
              }
              const target = href === undefined ? undefined : parseFileLink(href)
              const path =
                target === undefined ? undefined : projectRelativeFilePath(target.path, projectCwd)
              if (!canOpen || path === undefined) return <span>{label}</span>
              return (
                <FileReference
                  path={path}
                  line={target?.line}
                  onOpenFile={onOpenFile}
                  onOpenFileInMain={onOpenFileInMain}
                >
                  {label}
                </FileReference>
              )
            },
            pre: ({ children, node }) => {
              const code = node?.children.find(
                child => child.type === 'element' && child.tagName === 'code',
              )
              const className = code?.type === 'element' ? code.properties.className : undefined
              const names = Array.isArray(className) ? className.join(' ') : String(className ?? '')
              const language = /(?:^|\s)language-([^\s]+)/u.exec(names)?.[1]
              return (
                <FileMentionScope.Provider value={false}>
                  <MessageCodeBlock language={language}>{children}</MessageCodeBlock>
                </FileMentionScope.Provider>
              )
            },
            code: ({ children, className }) => (
              <MessageCode
                className={className}
                files={files}
                projectCwd={projectCwd}
                onOpenFile={canOpen ? onOpenFile : undefined}
                onOpenFileInMain={canOpen ? onOpenFileInMain : undefined}
              >
                {children}
              </MessageCode>
            ),
            table: ({ children }) => (
              <div className={styles.tableScroll}>
                <table>{children}</table>
              </div>
            ),
            img: ({ alt }) => <span>{alt ?? '图片'}</span>,
          }}
        >
          {visibleText}
        </Markdown>
      </div>
    )
  },
  (previous, next) => {
    // 会话投影会重建文件数组；文件集合未变时，历史 Markdown 无需重新解析。
    const previousFiles = previous.files ?? EMPTY_FILES
    const nextFiles = next.files ?? EMPTY_FILES
    return (
      previous.text === next.text &&
      previous.projectCwd === next.projectCwd &&
      previous.streaming === next.streaming &&
      previous.showCursor === next.showCursor &&
      previous.onOpenFile === next.onOpenFile &&
      previous.onOpenFileInMain === next.onOpenFileInMain &&
      (previousFiles === nextFiles ||
        (previousFiles.length === nextFiles.length &&
          previousFiles.every((file, index) => file === nextFiles[index])))
    )
  },
)
