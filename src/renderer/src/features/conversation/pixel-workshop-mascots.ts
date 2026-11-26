/**
 * 空会话像素工坊的品牌吉祥物多色图元模块：手工绘制 MyDSH Logo 招牌元素「蓝色大肥鱼」与「Token 票」
 * 的多帧像素画与深浅主题色表。保持纯数据与纯函数实现，避免撑大主网格模块。
 */

/** 品牌吉祥物像素图元标识。 */
export type MascotSpriteId = 'feiyu' | 'token-ticket'

/** 多色像素图元在深色与浅色主题下各自的字符色表映射。 */
export interface PixelSpriteColorMap {
  readonly dark: Readonly<Record<string, string>>
  readonly light: Readonly<Record<string, string>>
}

/** 多色像素图元悬停时的明暗柔光色值。 */
export interface PixelSpriteHoverGlow {
  readonly dark: string
  readonly light: string
}

/** 品牌多色像素图元的完整结构定义。 */
export interface MascotSpriteDefinition {
  readonly id: MascotSpriteId
  readonly width: number
  readonly height: number
  readonly frames: readonly (readonly string[])[]
  readonly colorMap: PixelSpriteColorMap
  readonly hoverGlow: PixelSpriteHoverGlow
  readonly showcaseOnly: boolean
}

const FEIYU_COLOR_MAP: PixelSpriteColorMap = {
  dark: {
    h: '#5d82d6',
    b: '#9ec0ff',
    s: '#3e589e',
    w: '#f7fbff',
    r: '#cbdcf5',
    c: '#67c9e8',
    f: '#ffe8dc',
    p: '#f59ab0',
    e: '#1d2b52',
    i: '#4d71c7',
    d: '#34477a',
    g: '#57cff7',
    k: '#d6f7ff',
  },
  light: {
    h: '#4c6ec2',
    b: '#7da4f0',
    s: '#334b8c',
    w: '#ffffff',
    r: '#8ea8cc',
    c: '#3e9ec2',
    f: '#fce0d2',
    p: '#e67c96',
    e: '#1c284a',
    i: '#3b5db0',
    d: '#273866',
    g: '#2ba8d9',
    k: '#9be8ff',
  },
}

const TOKEN_TICKET_COLOR_MAP: PixelSpriteColorMap = {
  dark: {
    o: '#2d6c96',
    t: '#7ce2ff',
    s: '#bff4ff',
    w: '#f4fdff',
    n: '#183559',
    p: '#337ca3',
    k: '#8be8ff',
  },
  light: {
    o: '#1b3d63',
    t: '#8be6ff',
    s: '#ccf6ff',
    w: '#ffffff',
    n: '#162d52',
    p: '#3984ab',
    k: '#32a2d6',
  },
}

function buildFeiyuFrame(options: {
  readonly ahogeRight: boolean
  readonly eyeMode: 'open' | 'shimmer' | 'blink'
  readonly gemSparkle: boolean
}): readonly string[] {
  const row0 = options.ahogeRight ? '......hhh.......' : '.....hhh........'
  let eyeRows: readonly [string, string, string] = [
    'sshheeeffeeehhss',
    'rwhfewiffiwefhwr',
    '.shfibiffibifhs.',
  ]
  if (options.eyeMode === 'shimmer') {
    eyeRows = ['sshheeeffeeehhss', 'rwhfiwiffiwifhwr', '.shfibiffibifhs.']
  } else if (options.eyeMode === 'blink') {
    eyeRows = ['sshhffffffffhhss', 'rwhfeeeffeeefhwr', '.shffffffffffhs.']
  }
  const bowRows: readonly [string, string] = options.gemSparkle
    ? ['.shrwddkgddwrhs.', '.shrwwdgkdwwrhs.']
    : ['.shrwddggddwrhs.', '.shrwwdggdwwrhs.']

  return [
    row0,
    '....rrrhrrrr....',
    '...rwwhhhhwwr...',
    '..rwhhbbhhhhwr..',
    '..cwhhhbhhbhwc..',
    '.shhffhhhhffhhs.',
    eyeRows[0],
    eyeRows[1],
    eyeRows[2],
    '.shfpffffffpfhs.',
    '.shhffffffffhhs.',
    '.shhrwwwwwwrhhs.',
    bowRows[0],
    bowRows[1],
    '.sh.rwdwwdwr.hs.',
    '..h..rwwwwr..h..',
  ]
}

const TOKEN_TICKET_BODY: readonly string[] = [
  '.ooooooooooooo.',
  'ottttttttttptto',
  'ootnnntntntttoo',
  '.ottnttnnttpto.',
  'oottnttntntttoo',
  'ottttttttttptto',
  '.ooooooooooooo.',
]

const EMPTY_TICKET_ROW = '...............'

function applyTicketSheen(sweepPos: number): readonly string[] {
  return TOKEN_TICKET_BODY.map((line, localRow) => {
    let result = ''
    for (let col = 0; col < line.length; col += 1) {
      const ch = line[col]!
      if (ch !== 't') {
        result += ch
        continue
      }
      const diag = col + localRow
      if (diag === sweepPos) result += 'w'
      else if (Math.abs(diag - sweepPos) === 1) result += 's'
      else result += ch
    }
    return result
  })
}

function buildTokenTicketFrame(options: {
  readonly sweepPos: number
  readonly topRows: readonly string[]
  readonly bottomRows: readonly string[]
}): readonly string[] {
  return [...options.topRows, ...applyTicketSheen(options.sweepPos), ...options.bottomRows]
}

/** MyDSH 品牌吉祥物多色像素图元列表（大肥鱼仅用于 2×2 大格展示，Token 票兼用于大小格）。 */
export const PIXEL_WORKSHOP_MASCOTS: readonly MascotSpriteDefinition[] = [
  {
    id: 'feiyu',
    width: 16,
    height: 16,
    frames: [
      buildFeiyuFrame({ ahogeRight: false, eyeMode: 'open', gemSparkle: false }),
      buildFeiyuFrame({ ahogeRight: true, eyeMode: 'shimmer', gemSparkle: true }),
      buildFeiyuFrame({ ahogeRight: true, eyeMode: 'blink', gemSparkle: false }),
      buildFeiyuFrame({ ahogeRight: false, eyeMode: 'open', gemSparkle: true }),
    ],
    colorMap: FEIYU_COLOR_MAP,
    hoverGlow: { dark: '#72a4ff', light: '#4d77db' },
    showcaseOnly: true,
  },
  {
    id: 'token-ticket',
    width: 15,
    height: 11,
    frames: [
      buildTokenTicketFrame({
        sweepPos: 4,
        topRows: ['.............k.', '............kwk', '.............k.'],
        bottomRows: [EMPTY_TICKET_ROW],
      }),
      buildTokenTicketFrame({
        sweepPos: 8,
        topRows: ['..............k', EMPTY_TICKET_ROW],
        bottomRows: [EMPTY_TICKET_ROW, EMPTY_TICKET_ROW],
      }),
      buildTokenTicketFrame({
        sweepPos: 12,
        topRows: ['............kwk', '.............k.'],
        bottomRows: [EMPTY_TICKET_ROW, EMPTY_TICKET_ROW],
      }),
      buildTokenTicketFrame({
        sweepPos: 16,
        topRows: [EMPTY_TICKET_ROW, '.............k.', EMPTY_TICKET_ROW],
        bottomRows: [EMPTY_TICKET_ROW],
      }),
    ],
    colorMap: TOKEN_TICKET_COLOR_MAP,
    hoverGlow: { dark: '#6ce2ff', light: '#2ca6db' },
    showcaseOnly: false,
  },
]
