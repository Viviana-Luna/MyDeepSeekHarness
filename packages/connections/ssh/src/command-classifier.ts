/**
 * SSH 命令静态词法分段与风险分级器：运行在后台 Runtime，负责只读白名单判定、高危标记与灾难命令硬拦截。
 * 采用保守的 POSIX Shell 解析；任何无法确认为纯只读的语法都会降级为需要确认的变更操作。
 */
import type { SshAgentAccessMode } from '../types.d.ts'

/** 静态分析后的 SSH 命令风险分类结果。 */
export interface ClassifiedSshCommand {
  readonly category: 'readonly' | 'mutation' | 'high-risk' | 'forbidden'
  readonly usesSudo: boolean
  readonly requiresPerCallApproval: boolean
  readonly requiredMode: SshAgentAccessMode
  readonly risks: readonly string[]
  readonly forbiddenReason?: string
}

interface ParsedCommand {
  readonly segments: readonly (readonly string[])[]
  readonly hasCommandSubstitution: boolean
  readonly hasProcessSubstitution: boolean
  readonly hasOutputRedirection: boolean
  readonly hasHereDoc: boolean
  readonly hasBackground: boolean
  readonly hasUnclosedQuote: boolean
}

const SIMPLE_READONLY_COMMANDS = new Set([
  'ls',
  'll',
  'dir',
  'pwd',
  'stat',
  'file',
  'wc',
  'du',
  'tree',
  'readlink',
  'realpath',
  'basename',
  'dirname',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'cksum',
  'cat',
  'tac',
  'nl',
  'head',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'cut',
  'uniq',
  'tr',
  'diff',
  'cmp',
  'comm',
  'column',
  'jq',
  'uname',
  'hostname',
  'uptime',
  'date',
  'whoami',
  'id',
  'groups',
  'w',
  'who',
  'last',
  'df',
  'free',
  'vmstat',
  'iostat',
  'mpstat',
  'lscpu',
  'lsblk',
  'lsmem',
  'lsusb',
  'lspci',
  'ps',
  'pgrep',
  'ss',
  'netstat',
  'dig',
  'nslookup',
  'host',
  'lsof',
  'dmesg',
  'which',
  'type',
  'printenv',
  'true',
  'false',
  'echo',
  'printf',
])

const VERSION_ONLY_COMMANDS = new Set([
  'node',
  'npm',
  'pnpm',
  'yarn',
  'python',
  'python3',
  'go',
  'rustc',
  'cargo',
  'java',
  'php',
  'ruby',
  'docker-compose',
])

const SUDO_COMMANDS = new Set(['sudo', 'doas', 'su', 'pkexec'])
const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'python',
  'python3',
  'perl',
  'ruby',
  'node',
])
const SYSTEM_ROOT_TARGETS = new Set([
  '/',
  '/*',
  '~',
  '~/*',
  '$HOME',
  '$HOME/*',
  '${HOME}',
  '${HOME}/*',
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/var',
  '/boot',
  '/sys',
  '/proc',
  '/dev',
  '/root',
])
const PROTECTED_SENSITIVE_FILES = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers']

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(token)
}

function stripLeadingEnv(tokens: readonly string[]): readonly string[] {
  let index = 0
  while (index < tokens.length && isEnvAssignment(tokens[index]!)) index++
  return tokens.slice(index)
}

function commandNameOf(token: string | undefined): string {
  if (!token) return ''
  const slash = token.lastIndexOf('/')
  return (slash >= 0 ? token.slice(slash + 1) : token).toLowerCase()
}

function parseShellCommand(command: string): ParsedCommand {
  const segments: string[][] = []
  let current: string[] = []
  let token = ''
  let inSingle = false
  let inDouble = false
  let hasToken = false
  let hasCommandSubstitution = false
  let hasProcessSubstitution = false
  let hasOutputRedirection = false
  let hasHereDoc = false
  let hasBackground = false

  const pushToken = () => {
    if (!hasToken) return
    current.push(token)
    token = ''
    hasToken = false
  }
  const pushSegment = () => {
    pushToken()
    if (current.length > 0) {
      segments.push(current)
      current = []
    }
  }

  for (let index = 0; index < command.length; index++) {
    const ch = command[index]!
    const next = command[index + 1] ?? ''
    if (inSingle) {
      if (ch === "'") inSingle = false
      else token += ch
      continue
    }
    if (ch === '\\' && next) {
      token += next
      hasToken = true
      index++
      continue
    }
    if (inDouble) {
      if (ch === '"') {
        inDouble = false
        continue
      }
      if (ch === '`' || (ch === '$' && next === '(')) hasCommandSubstitution = true
      token += ch
      continue
    }
    if (ch === "'") {
      inSingle = true
      hasToken = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      hasToken = true
      continue
    }
    if (ch === '`') {
      hasCommandSubstitution = true
      token += ch
      hasToken = true
      continue
    }
    if (ch === '$' && next === '(') {
      hasCommandSubstitution = true
      token += '$('
      hasToken = true
      index++
      continue
    }
    if ((ch === '<' || ch === '>') && next === '(') {
      hasProcessSubstitution = true
      token += `${ch}(`
      hasToken = true
      index++
      continue
    }
    if (ch === '<' && next === '<') {
      hasHereDoc = true
      pushToken()
      index++
      if (command[index + 1] === '<') index++
      continue
    }
    if (ch === '>' || (ch === '&' && next === '>')) {
      const rest = command.slice(index)
      const isHarmlessFdMerge = /^>&[12](?:$|\s|[;|&])/u.test(rest)
      const isDevNullStderr =
        (token === '2' || token === '') && /^>\s*\/dev\/null(?:$|\s|[;|&])/u.test(rest)
      if (isHarmlessFdMerge) {
        if (token === '1' || token === '2') {
          token = ''
          hasToken = false
        }
        index += 2
        continue
      }
      if (isDevNullStderr && token === '2') {
        const match = rest.match(/^>\s*\/dev\/null/u)
        token = ''
        hasToken = false
        index += (match?.[0].length ?? 1) - 1
        continue
      }
      hasOutputRedirection = true
      pushToken()
      if (next === '>' || next === '|' || (ch === '&' && next === '>')) index++
      continue
    }
    if (ch === ';' || ch === '\n') {
      pushSegment()
      continue
    }
    if (ch === '|') {
      pushSegment()
      if (next === '|') index++
      continue
    }
    if (ch === '&') {
      if (next === '&') {
        pushSegment()
        index++
      } else {
        hasBackground = true
        pushSegment()
      }
      continue
    }
    if (/\s/u.test(ch)) {
      pushToken()
      continue
    }
    token += ch
    hasToken = true
  }
  pushSegment()
  return {
    segments,
    hasCommandSubstitution,
    hasProcessSubstitution,
    hasOutputRedirection,
    hasHereDoc,
    hasBackground,
    hasUnclosedQuote: inSingle || inDouble,
  }
}

function unwrapSudoSegment(tokens: readonly string[]): {
  usesSudo: boolean
  effective: readonly string[]
} {
  const clean = stripLeadingEnv(tokens)
  const first = commandNameOf(clean[0])
  if (!SUDO_COMMANDS.has(first)) return { usesSudo: false, effective: clean }
  // 跳过 sudo 常见短参数（例如 -u root、-n、-E）以识别背后实际执行的命令。
  let index = 1
  while (index < clean.length) {
    const arg = clean[index]!
    if (arg === '--') {
      index++
      break
    }
    if (!arg.startsWith('-')) break
    if (first === 'sudo' && ['-u', '-g', '-C', '-p', '-t', '-r', '-h'].includes(arg)) index += 2
    else index++
  }
  return { usesSudo: true, effective: stripLeadingEnv(clean.slice(index)) }
}

function hasRecursiveRmFlag(args: readonly string[]): boolean {
  return args.some(
    arg =>
      arg === '--recursive' ||
      arg === '--no-preserve-root' ||
      (/^-[A-Za-z]+$/u.test(arg) && (arg.includes('r') || arg.includes('R'))),
  )
}

function isCatastrophicRm(effective: readonly string[]): boolean {
  if (commandNameOf(effective[0]) !== 'rm') return false
  const args = effective.slice(1)
  if (args.includes('--no-preserve-root')) return true
  if (!hasRecursiveRmFlag(args)) return false
  const targets = args.filter(arg => !arg.startsWith('-'))
  return targets.some(target => {
    const trimmed = target.length > 1 && target.endsWith('/') ? target.slice(0, -1) : target
    return SYSTEM_ROOT_TARGETS.has(trimmed) || trimmed === '/*'
  })
}

function detectForbiddenReason(command: string, parsed: ParsedCommand): string | undefined {
  if (/:\s*\(\s*\)\s*\{[\s\S]*:\s*\|[\s\S]*:\s*&[\s\S]*\}\s*;?\s*:/u.test(command))
    return '检测到 Fork 炸弹模式，已硬拦截'
  if (
    /\/dev\/(?:tcp|udp)\//u.test(command) ||
    /\b(?:nc|ncat|netcat)\b[^\n;|&]*(?:\s-e\b|\s-c\b|\s--sh-exec\b)/u.test(command) ||
    /\bbash\s+-i\s+>&/u.test(command) ||
    /\bsocat\b[^\n;|&]*\bexec:/iu.test(command)
  )
    return '检测到反弹 Shell 模式，已硬拦截'
  for (const segment of parsed.segments) {
    const { effective } = unwrapSudoSegment(segment)
    const cmd = commandNameOf(effective[0])
    if (isCatastrophicRm(effective)) return '禁止对根目录、系统目录或家目录执行递归删除'
    if (
      cmd === 'mkfs' ||
      cmd.startsWith('mkfs.') ||
      ['wipefs', 'fdisk', 'parted', 'sfdisk', 'gdisk'].includes(cmd)
    )
      return `禁止执行磁盘分区或格式化命令（${cmd}）`
    if (
      cmd === 'dd' &&
      effective.slice(1).some(arg => /^of=\/dev\/(?!null$|zero$|stdout$|stderr$)/u.test(arg))
    )
      return '禁止使用 dd 直接覆写块设备'
  }
  const touchesSensitive = PROTECTED_SENSITIVE_FILES.some(file => command.includes(file))
  if (touchesSensitive) return '禁止通过 SSH 工具直接访问或修改系统凭据敏感文件（shadow / sudoers）'
  return undefined
}

function isReadonlyGit(args: readonly string[]): boolean {
  let index = 0
  while (index < args.length) {
    const arg = args[index]!
    if (arg === '-C' || arg === '--git-dir' || arg === '--work-tree') {
      index += 2
      continue
    }
    if (arg === '--no-pager' || arg === '-P') {
      index++
      continue
    }
    break
  }
  const sub = args[index]
  const rest = args.slice(index + 1)
  if (!sub) return false
  if (
    [
      'status',
      'log',
      'diff',
      'show',
      'rev-parse',
      'describe',
      'ls-files',
      'ls-tree',
      'blame',
      'shortlog',
    ].includes(sub)
  )
    return true
  if (sub === 'branch') {
    const dangerous = new Set(['-d', '-D', '-m', '-M', '-c', '-C', '--delete', '--move', '--copy'])
    return !rest.some(arg => dangerous.has(arg) || !arg.startsWith('-'))
  }
  if (sub === 'tag') return rest.length === 0 || rest.every(arg => arg === '-l' || arg === '--list')
  if (sub === 'remote') return rest.length === 0 || rest[0] === '-v' || rest[0] === 'show'
  if (sub === 'stash') return rest[0] === 'list'
  if (sub === 'config') return rest.some(arg => arg === '--get' || arg === '--list' || arg === '-l')
  return false
}

function isReadonlyContainer(args: readonly string[]): boolean {
  const sub = args[0]
  if (!sub) return false
  if (['ps', 'images', 'inspect', 'top', 'port', 'version', 'info'].includes(sub)) return true
  if (sub === 'logs') return !args.includes('-f') && !args.includes('--follow')
  if (sub === 'stats') return args.includes('--no-stream')
  if (sub === 'network' || sub === 'volume')
    return ['ls', 'list', 'inspect'].includes(args[1] ?? '')
  if (sub === 'compose') {
    const composeSub = args[1]
    if (composeSub === 'ps' || composeSub === 'config') return true
    if (composeSub === 'logs') return !args.includes('-f') && !args.includes('--follow')
  }
  return false
}

function isReadonlySegment(tokens: readonly string[]): boolean {
  const clean = stripLeadingEnv(tokens)
  if (clean.length === 0) return false
  const cmd = commandNameOf(clean[0])
  const args = clean.slice(1)
  if (SIMPLE_READONLY_COMMANDS.has(cmd)) return true
  if (cmd === 'env') return args.length === 0
  if (cmd === 'tail') return !args.some(arg => arg === '-f' || arg === '-F' || arg === '--follow')
  if (cmd === 'sort') return !args.some(arg => arg === '-o' || arg.startsWith('--output'))
  if (cmd === 'find') {
    const unsafe = new Set([
      '-exec',
      '-execdir',
      '-ok',
      '-okdir',
      '-delete',
      '-fprint',
      '-fprintf',
      '-fls',
    ])
    return !args.some(arg => unsafe.has(arg))
  }
  if (cmd === 'journalctl')
    return !args.some(
      arg =>
        arg === '-f' ||
        arg === '--follow' ||
        arg.startsWith('--vacuum') ||
        arg === '--rotate' ||
        arg === '--flush',
    )
  if (cmd === 'sysctl')
    return !args.some(arg => arg === '-w' || arg === '--write' || arg === '-p' || arg.includes('='))
  if (cmd === 'crontab') return args.length === 1 && args[0] === '-l'
  if (cmd === 'ip') {
    const obj = args[0] ?? ''
    const mutating = new Set(['add', 'del', 'delete', 'set', 'replace', 'change', 'flush'])
    return (
      ['addr', 'a', 'address', 'route', 'r', 'link', 'l', 'neigh', 'n'].includes(obj) &&
      !args.some(arg => mutating.has(arg))
    )
  }
  if (cmd === 'ping') return args.includes('-c')
  if (cmd === 'nginx') return args.length === 1 && ['-v', '-V', '-t', '-T'].includes(args[0]!)
  if (VERSION_ONLY_COMMANDS.has(cmd))
    return args.length === 1 && ['-v', '-V', '--version', 'version'].includes(args[0]!)
  if (cmd === 'git') return isReadonlyGit(args)
  if (cmd === 'systemctl')
    return [
      'status',
      'is-active',
      'is-enabled',
      'is-failed',
      'list-units',
      'list-unit-files',
      'list-timers',
      'cat',
      'show',
    ].includes(args[0] ?? '')
  if (cmd === 'service') return args[0] === '--status-all' || args[1] === 'status'
  if (cmd === 'docker' || cmd === 'podman') return isReadonlyContainer(args)
  if (cmd === 'kubectl') {
    const sub = args[0] ?? ''
    if (['get', 'describe', 'top', 'version', 'cluster-info'].includes(sub)) return true
    if (sub === 'logs') return !args.includes('-f') && !args.includes('--follow')
    return false
  }
  if (cmd === 'pm2') {
    const sub = args[0] ?? ''
    if (['list', 'ls', 'status', 'jlist', 'info', 'show', 'describe'].includes(sub)) return true
    return sub === 'logs' && args.includes('--nostream')
  }
  if (cmd === 'supervisorctl') return args[0] === 'status'
  return false
}

function collectSegmentRisks(
  effective: readonly string[],
  risks: Set<string>,
): { requiresFull: boolean } {
  const cmd = commandNameOf(effective[0])
  const args = effective.slice(1)
  let requiresFull = false
  if (
    ['rm', 'rmdir', 'unlink', 'shred'].includes(cmd) ||
    (cmd === 'find' && args.includes('-delete'))
  )
    risks.add('包含文件或目录删除操作')
  if (['reboot', 'shutdown', 'poweroff', 'halt', 'init'].includes(cmd)) {
    risks.add('会重启或关闭远端主机')
    requiresFull = true
  }
  if (
    (cmd === 'systemctl' &&
      ['stop', 'restart', 'reload', 'disable', 'mask', 'daemon-reload'].includes(args[0] ?? '')) ||
    (cmd === 'service' && ['stop', 'restart', 'reload'].includes(args[1] ?? '')) ||
    (cmd === 'pm2' && ['stop', 'restart', 'delete', 'kill'].includes(args[0] ?? '')) ||
    ['kill', 'killall', 'pkill'].includes(cmd)
  )
    risks.add('影响运行中的服务或进程')
  if (['chmod', 'chown', 'chgrp'].includes(cmd)) risks.add('修改文件或目录权限/归属')
  if (['useradd', 'userdel', 'usermod', 'groupdel', 'passwd'].includes(cmd)) {
    risks.add('修改系统账号或密码配置')
    requiresFull = true
  }
  if (['iptables', 'ip6tables', 'nft', 'ufw', 'firewall-cmd'].includes(cmd)) {
    risks.add('修改主机防火墙或网络策略')
    requiresFull = true
  }
  if (
    cmd === 'git' &&
    ((args[0] === 'reset' && args.includes('--hard')) ||
      args[0] === 'clean' ||
      (args[0] === 'push' &&
        args.some(arg => arg === '-f' || arg === '--force' || arg === '--force-with-lease')))
  )
    risks.add('包含不可逆的 Git 历史或工作区变更')
  if (
    (cmd === 'docker' || cmd === 'podman') &&
    (['rm', 'rmi'].includes(args[0] ?? '') ||
      (args[0] === 'system' && args[1] === 'prune') ||
      (args[0] === 'volume' && args[1] === 'rm') ||
      (args[0] === 'compose' && args[1] === 'down'))
  )
    risks.add('删除容器、镜像或数据卷')
  if (cmd === 'kubectl' && ['delete', 'apply', 'patch', 'replace'].includes(args[0] ?? ''))
    risks.add('变更 Kubernetes 集群资源')
  return { requiresFull }
}

function hasRemoteScriptPipe(segments: readonly (readonly string[])[]): boolean {
  for (let index = 0; index + 1 < segments.length; index++) {
    const left = commandNameOf(unwrapSudoSegment(segments[index]!).effective[0])
    const right = commandNameOf(unwrapSudoSegment(segments[index + 1]!).effective[0])
    if ((left === 'curl' || left === 'wget') && SHELL_INTERPRETERS.has(right)) return true
  }
  return false
}

/**
 * 静态分析待执行 SSH 命令的类别、所需权限档位、sudo 依赖与高危提示。
 * @throws 命令为空或超过 16 KiB 时抛出。
 */
export function classifySshCommand(rawCommand: string): ClassifiedSshCommand {
  const command = rawCommand.trim()
  if (!command) throw new Error('command 参数不能为空')
  if (Buffer.byteLength(command, 'utf8') > 16 * 1024)
    throw new Error('command 超过 16 KiB 长度上限')
  const parsed = parseShellCommand(command)
  if (parsed.hasUnclosedQuote) throw new Error('command 包含未闭合的引号，请检查 Shell 语法后重试')
  const forbiddenReason = detectForbiddenReason(command, parsed)
  if (forbiddenReason) {
    return {
      category: 'forbidden',
      usesSudo: false,
      requiresPerCallApproval: true,
      requiredMode: 'full',
      risks: [forbiddenReason],
      forbiddenReason,
    }
  }
  let usesSudo = false
  let requiresFull = false
  const risks = new Set<string>()
  for (const segment of parsed.segments) {
    const unwrapped = unwrapSudoSegment(segment)
    if (unwrapped.usesSudo) usesSudo = true
    const result = collectSegmentRisks(unwrapped.effective, risks)
    if (result.requiresFull) requiresFull = true
  }
  if (usesSudo) risks.add('包含 sudo / 提权执行，将强制单次确认')
  if (hasRemoteScriptPipe(parsed.segments)) {
    risks.add('从网络下载脚本并直接通过解释器执行')
    requiresFull = true
  }
  const hasShellHazard =
    parsed.hasCommandSubstitution ||
    parsed.hasProcessSubstitution ||
    parsed.hasOutputRedirection ||
    parsed.hasHereDoc ||
    parsed.hasBackground
  const isReadonly =
    !usesSudo &&
    !hasShellHazard &&
    risks.size === 0 &&
    parsed.segments.length > 0 &&
    parsed.segments.every(segment => isReadonlySegment(segment))
  if (isReadonly) {
    return {
      category: 'readonly',
      usesSudo: false,
      requiresPerCallApproval: false,
      requiredMode: 'readonly',
      risks: [],
    }
  }
  if (command.includes('authorized_keys')) risks.add('涉及 SSH 信任密钥配置')
  if (parsed.hasCommandSubstitution || parsed.hasProcessSubstitution)
    risks.add('包含命令或进程替换语法，请核对展开内容')
  if (parsed.hasBackground) risks.add('包含后台运行操作符 (&)')
  const isHighRisk = usesSudo || requiresFull || risks.size > 0
  return {
    category: isHighRisk ? 'high-risk' : 'mutation',
    usesSudo,
    requiresPerCallApproval: isHighRisk,
    requiredMode: requiresFull ? 'full' : 'standard',
    risks: [...risks],
  }
}
