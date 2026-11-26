/**
 * 对话等待回复时的加载小笑话模块：提供 38 条精炼中文加载文案、无撞车洗牌顺序
 * 以及感知页面可见性与「减少动态」偏好的平滑轮换 Hook。运行在 renderer。
 */
import { useEffect, useState } from 'react'

/** 等待回复时相邻两条加载小笑话之间的默认切换间隔（毫秒）。 */
export const LOADING_QUIP_INTERVAL_MS = 3_400

/** 等待模型回复时轮换展示的趣味中文加载小笑话清单。 */
export const LOADING_QUIPS: readonly string[] = [
  '蓝色大肥鱼正在点数手里的 Token 票…',
  '给蓝色大肥鱼投喂了一把上下文…',
  '正在把 Token 票一张张压平放进槽里…',
  '大肥鱼偷偷擦亮了今天的代码滤镜…',
  '蓝色大肥鱼 DeepSeek 正在深海打捞最靠谱的代码…',
  '正在向大肥鱼申请一张加急推理券…',
  '蓝色大肥鱼正在埋头狂炫大白饭…',
  '大肥鱼吃饱大白饭就来给你写代码…',
  '正在用 Token 票给大肥鱼换一碗大白饭…',
  '大肥鱼扒拉了两口大白饭，思路突然通了…',
  '正在确认大肥鱼碗里的大白饭够不够跑完这轮…',
  '燃咖啡机，启动！',
  '正在说服编译器这绝对不是 Bug，是特性…',
  '正在向小黄鸭严肃复盘你的需求…',
  '正在给缓存擦拭不存在的灰尘…',
  '正在把“在我机器上能跑”翻译成真正能跑…',
  '正在假装自己读完了三百页文档…',
  '正在试图用 O(1) 的心态解决 O(n²) 的难题…',
  '正在祈祷这次不用再清一次 node_modules…',
  '正在把咖啡因悄悄转换成 TypeScript 类型…',
  '正在递归地确认自己没有陷入死循环…',
  '正在和括号配对达成友好和解…',
  '正在从祖传代码里小心翼翼拆一颗定时炸弹…',
  '正在把临时方案包装得像架构设计…',
  '正在给异步回调发一张排队叫号单…',
  '正在检查有没有少写一个该死的分号…',
  '正在认真分辨这是需求变更还是灵光一闪…',
  '正在用量子力学解释为什么刚才还报错…',
  '正在给线程们分座位，防止它们抢资源打架…',
  '正在把一整团面条代码梳成顺滑的直发…',
  '正在悄悄把 TODO 变成已经 DONE…',
  '正在把灵感压缩到刚好塞进上下文窗口…',
  '正在给正则引擎递一杯降压茶…',
  '正在和 Git 合并冲突展开和平谈判…',
  '正在把零散的字节拼成你想要的样子…',
  '正在替你把坑先踩一遍，确认安全再上…',
  '正在给主进程和渲染进程传小纸条…',
  '正在给变量起一个比 temp2 更有尊严的名字…',
]

interface QuipDeckState {
  readonly order: readonly number[]
  readonly cursor: number
}

function clampRandomIndex(value: number, upperInclusive: number): number {
  const index = Math.floor(value * (upperInclusive + 1))
  return Math.max(0, Math.min(upperInclusive, index))
}

/**
 * 使用 Fisher-Yates 算法生成 `0..length-1` 的随机遍历顺序；
 * 当传入 `avoidFirst` 且 `length > 1` 时，确保首项不与上一轮末项重复。
 */
export function createQuipOrder(
  length: number,
  avoidFirst?: number,
  random: () => number = Math.random,
): readonly number[] {
  if (length <= 0) return []
  const order = Array.from({ length }, (_, index) => index)
  for (let index = length - 1; index > 0; index -= 1) {
    const swapIndex = clampRandomIndex(random(), index)
    const current = order[index]!
    order[index] = order[swapIndex]!
    order[swapIndex] = current
  }
  if (avoidFirst !== undefined && length > 1 && order[0] === avoidFirst) {
    const swapIndex = 1 + clampRandomIndex(random(), length - 2)
    const first = order[0]!
    order[0] = order[swapIndex]!
    order[swapIndex] = first
  }
  return order
}

function createInitialDeck(): QuipDeckState {
  return { order: createQuipOrder(LOADING_QUIPS.length), cursor: 0 }
}

function advanceQuipDeck(current: QuipDeckState): QuipDeckState {
  const nextCursor = current.cursor + 1
  if (nextCursor < current.order.length) {
    return { order: current.order, cursor: nextCursor }
  }
  const lastIndex = current.order[current.cursor]
  return {
    order: createQuipOrder(LOADING_QUIPS.length, lastIndex),
    cursor: 0,
  }
}

function getReducedMotionQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null
  return window.matchMedia('(prefers-reduced-motion: reduce)')
}

/**
 * 按固定间隔平滑轮换加载小笑话；页面隐藏或系统开启「减少动态」时自动暂停，
 * 卸载时彻底释放定时器与事件监听。
 */
export function useRotatingLoadingQuip(active: boolean): string {
  const [deck, setDeck] = useState<QuipDeckState>(createInitialDeck)

  useEffect(() => {
    if (!active) return
    const reducedQuery = getReducedMotionQuery()
    let timerId: ReturnType<typeof setInterval> | null = null

    const stopTimer = () => {
      if (timerId === null) return
      clearInterval(timerId)
      timerId = null
    }

    const syncTimer = () => {
      const hidden = typeof document !== 'undefined' && document.hidden
      if (hidden || reducedQuery?.matches === true) {
        stopTimer()
        return
      }
      if (timerId !== null) return
      timerId = setInterval(() => {
        setDeck(advanceQuipDeck)
      }, LOADING_QUIP_INTERVAL_MS)
    }

    syncTimer()
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', syncTimer)
    }
    reducedQuery?.addEventListener?.('change', syncTimer)

    return () => {
      stopTimer()
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', syncTimer)
      }
      reducedQuery?.removeEventListener?.('change', syncTimer)
    }
  }, [active])

  const index = deck.order[deck.cursor] ?? 0
  return LOADING_QUIPS[index] ?? LOADING_QUIPS[0]!
}
