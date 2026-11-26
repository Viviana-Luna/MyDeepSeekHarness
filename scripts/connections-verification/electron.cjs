const { app, utilityProcess } = require('electron')
const { join } = require('node:path')
const { rmSync, writeFileSync } = require('node:fs')

const home = process.env.MYDSH_VERIFY_HOME
if (!home) throw new Error('缺少隔离验收目录，请使用 verify-connections.mjs 入口。')
app.setPath('userData', join(home, 'electron'))
app.setPath('sessionData', join(home, 'electron-session'))
app.setPath('logs', join(home, 'logs'))

app
  .whenReady()
  .then(() => {
    console.log(`真实 Electron ${process.versions.electron}，启动独立 utilityProcess。`)
    const child = utilityProcess.fork(join(__dirname, 'worker.mjs'), [], {
      cwd: __dirname,
      env: { ...process.env },
      stdio: 'pipe',
      serviceName: 'MyDSH 连接驱动验收',
    })
    let result
    const stop = () => {
      child.kill()
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    child.once('spawn', () => {
      if (child.pid) writeFileSync(join(home, 'runtime.pid'), String(child.pid), { mode: 0o600 })
    })
    child.stdout.on('data', data => process.stdout.write(data))
    child.stderr.on('data', data => process.stderr.write(data))
    child.on('message', message => {
      if (message?.type === 'connections-result') result = message.result
    })
    child.once('exit', code => {
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
      rmSync(join(home, 'runtime.pid'), { force: true })
      if (code === 0 && result?.success === true && result.runtime === 'utilityProcess') {
        console.log(
          'MYDSH_CONNECTIONS_RESULT ' +
            JSON.stringify({ ...result, electron: process.versions.electron }),
        )
        app.exit(0)
      } else {
        console.error(`后台驱动验收未完成，退出码 ${code}。`)
        app.exit(1)
      }
    })
  })
  .catch(error => {
    console.error('Electron 验收启动失败：' + error.message)
    app.exit(1)
  })
