/** 供 SSH Agent 集成测试使用的本地 POSIX 映射 SFTP 子系统桩。 */
import {
  closeSync,
  fstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join, posix, relative, sep } from 'node:path'

function statsToAttrs(st) {
  return {
    mode: st.mode,
    uid: st.uid ?? 0,
    gid: st.gid ?? 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  }
}

function resolveOpenMode(flags, openMode) {
  const isWrite = (flags & openMode.WRITE) !== 0
  const isCreat = (flags & openMode.CREAT) !== 0
  const isTrunc = (flags & openMode.TRUNC) !== 0
  if (isWrite && isCreat && isTrunc) return 'w'
  if (isWrite && isCreat) return 'w+'
  return isWrite ? 'r+' : 'r'
}

function attachDirectoryHandlers(sftp, state) {
  const { handles, allocHandle, toLocal, toRemote, STATUS_CODE } = state
  sftp.on('REALPATH', (reqid, reqPath) => {
    try {
      const resolved = realpathSync(toLocal(reqPath))
      const remote = toRemote(resolved)
      sftp.name(reqid, [
        { filename: remote, longname: remote, attrs: statsToAttrs(statSync(resolved)) },
      ])
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })
  const onStat = (reqid, reqPath) => {
    try {
      sftp.attrs(reqid, statsToAttrs(statSync(toLocal(reqPath))))
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  }
  sftp.on('STAT', onStat)
  sftp.on('LSTAT', onStat)
  sftp.on('OPENDIR', (reqid, reqPath) => {
    try {
      const dir = toLocal(reqPath)
      sftp.handle(reqid, allocHandle({ kind: 'dir', dir, names: readdirSync(dir), done: false }))
    } catch {
      sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
    }
  })
  sftp.on('READDIR', (reqid, handleBuf) => {
    const entry = handles.get(handleBuf.toString('hex'))
    if (!entry || entry.kind !== 'dir' || entry.done) {
      sftp.status(reqid, STATUS_CODE.EOF)
      return
    }
    entry.done = true
    sftp.name(
      reqid,
      entry.names.map(filename => ({
        filename,
        longname: filename,
        attrs: statsToAttrs(statSync(join(entry.dir, filename))),
      })),
    )
  })
}

function attachFileHandlers(sftp, state) {
  const { handles, allocHandle, toLocal, STATUS_CODE, OPEN_MODE } = state
  sftp.on('OPEN', (reqid, filename, flags) => {
    try {
      const fd = openSync(toLocal(filename), resolveOpenMode(flags, OPEN_MODE))
      sftp.handle(reqid, allocHandle({ kind: 'file', fd }))
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })
  sftp.on('FSTAT', (reqid, handleBuf) => {
    const entry = handles.get(handleBuf.toString('hex'))
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    sftp.attrs(reqid, statsToAttrs(fstatSync(entry.fd)))
  })
  sftp.on('READ', (reqid, handleBuf, offset, length) => {
    const entry = handles.get(handleBuf.toString('hex'))
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    const buffer = Buffer.alloc(length)
    const bytesRead = readSync(entry.fd, buffer, 0, length, offset)
    if (bytesRead === 0) sftp.status(reqid, STATUS_CODE.EOF)
    else sftp.data(reqid, buffer.subarray(0, bytesRead))
  })
  sftp.on('WRITE', (reqid, handleBuf, offset, data) => {
    const entry = handles.get(handleBuf.toString('hex'))
    if (!entry || entry.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE)
    writeSync(entry.fd, data, 0, data.length, offset)
    sftp.status(reqid, STATUS_CODE.OK)
  })
  sftp.on('SETSTAT', (reqid, _path, _attrs) => sftp.status(reqid, STATUS_CODE.OK))
  sftp.on('RENAME', (reqid, oldPath, newPath) => {
    try {
      renameSync(toLocal(oldPath), toLocal(newPath))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })
  sftp.on('REMOVE', (reqid, reqPath) => {
    try {
      unlinkSync(toLocal(reqPath))
      sftp.status(reqid, STATUS_CODE.OK)
    } catch {
      sftp.status(reqid, STATUS_CODE.FAILURE)
    }
  })
  sftp.on('CLOSE', (reqid, handleBuf) => {
    const key = handleBuf.toString('hex')
    const entry = handles.get(key)
    if (entry?.kind === 'file') closeSync(entry.fd)
    handles.delete(key)
    sftp.status(reqid, STATUS_CODE.OK)
  })
}

/**
 * 将 ssh2 会话上的 SFTP 子系统绑定到本地临时根目录，并把远端 POSIX 绝对路径（如 /app）映射到底层文件系统。
 * @param {object} session ssh2 会话实例
 * @param {string} rootDir SFTP 默认工作目录对应的本地路径
 * @param {string} remoteRoot 远端 `/` 对应的本地根目录
 * @param {{ STATUS_CODE: Record<string, number>, OPEN_MODE: Record<string, number> }} sftpConstants ssh2 SFTP 常量表
 */
export function attachSftpSubsystem(session, rootDir, remoteRoot, sftpConstants) {
  session.on('sftp', accept => {
    const sftp = accept()
    const handles = new Map()
    let nextHandle = 1
    const state = {
      ...sftpConstants,
      handles,
      allocHandle: value => {
        const buf = Buffer.alloc(4)
        buf.writeUInt32BE(nextHandle++, 0)
        handles.set(buf.toString('hex'), value)
        return buf
      },
      toLocal: reqPath =>
        reqPath === '.'
          ? rootDir
          : join(
              remoteRoot,
              ...posix.normalize(reqPath).replace(/^\/+/u, '').split('/').filter(Boolean),
            ),
      toRemote: localPath => {
        const rel = relative(remoteRoot, localPath)
        return rel === '' ? '/' : `/${rel.split(sep).join('/')}`
      },
    }
    attachDirectoryHandlers(sftp, state)
    attachFileHandlers(sftp, state)
  })
}
