/** 对话折叠摘要的逐字显现；内容和辅助技术读取始终使用原始摘要。 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import styles from './AnimatedSummary.module.css'

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const ANIMATED_LIMIT = 120

function charactersAtStart(text: string): { characters: string[]; remainder: string } {
  const characters: string[] = []
  let end = 0
  for (const item of segmenter.segment(text)) {
    if (characters.length === ANIMATED_LIMIT) break
    characters.push(item.segment)
    end = item.index + item.segment.length
  }
  return { characters, remainder: text.slice(end) }
}

function Glyph({ text, animate, delay }: { text: string; animate: boolean; delay: number }) {
  const [enter] = useState(animate)
  const [initialDelay] = useState(delay)
  return (
    <span
      className={enter ? styles.glyph : undefined}
      style={{ '--glyph-delay': `${String(initialDelay)}ms` } as CSSProperties}
    >
      {text}
    </span>
  )
}

/** 只为实时新增或改变的字符播放动效，历史摘要直接显示。 */
export function AnimatedSummary({ text, active }: { text: string; active: boolean }) {
  const previous = useRef<string | null>(null)
  const animate = previous.current === null ? active : previous.current !== text
  const previousText = previous.current
  useEffect(() => {
    previous.current = text
  }, [text])
  if (previousText === null && !active) return <>{text}</>
  const { characters, remainder } = charactersAtStart(text)
  const old = charactersAtStart(previousText ?? '').characters
  let prefix = 0
  while (prefix < old.length && prefix < characters.length && old[prefix] === characters[prefix])
    prefix += 1
  return (
    <>
      <span className="visually-hidden">{text}</span>
      <span aria-hidden="true" data-animated-summary="true">
        {characters.map((character, index) => (
          <Glyph
            key={`${String(index)}:${character}`}
            text={character}
            animate={animate && index >= prefix}
            delay={Math.min(Math.max(0, index - prefix) * 14, 420)}
          />
        ))}
        {remainder}
      </span>
    </>
  )
}
