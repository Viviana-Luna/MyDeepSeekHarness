import { useEffect, useState } from 'react'
import { getDesktopBridge } from '../../services/desktop.ts'

export function SessionImage({
  sessionId,
  attachmentId,
  name,
}: {
  sessionId: string
  attachmentId: string
  name: string
}) {
  const [source, setSource] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let active = true
    setSource(null)
    setError(false)
    void getDesktopBridge()
      .host.call('getSessionAttachment', { sessionId, attachmentId })
      .then(
        value => {
          if (!active) return
          if (
            typeof value !== 'string' ||
            !/^data:image\/(png|jpeg|webp|gif);base64,/u.test(value)
          ) {
            setError(true)
            return
          }
          setSource(value)
        },
        () => {
          if (active) setError(true)
        },
      )
    return () => {
      active = false
    }
  }, [sessionId, attachmentId, revision])
  if (error)
    return (
      <button type="button" onClick={() => setRevision(value => value + 1)}>
        图片加载失败，点击重试
      </button>
    )
  if (source === null) return <span role="status">正在读取图片…</span>
  return (
    <img
      src={source}
      alt={name}
      onError={() => setError(true)}
      style={{
        display: 'block',
        maxWidth: '100%',
        maxHeight: 420,
        objectFit: 'contain',
        borderRadius: 8,
      }}
    />
  )
}
