/** 真实 Electron 内置 + 外置 CDP 浏览器自动化验收入口：启动本地测试页并在退出后彻底清理临时目录。 */
import electron from 'electron'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const onlyEmbedded = args.includes('--embedded') && !args.includes('--external')
const onlyExternal = args.includes('--external') && !args.includes('--embedded')

const TEST_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>MyDSH 浏览器自动化验收页</title>
</head>
<body>
  <h1>MyDSH 自动化测试表单</h1>
  <label for="name-input">姓名</label>
  <input id="name-input" type="text" placeholder="请输入中文姓名" />
  <label for="lang-select">语言</label>
  <select id="lang-select">
    <option value="en">English</option>
    <option value="zh">简体中文</option>
  </select>
  <button id="submit-btn" type="button">提交测试</button>
  <p id="result-box">尚未提交</p>
  <script>
    console.log('MYDSH_TEST_PAGE_READY');
    document.getElementById('submit-btn').addEventListener('click', async () => {
      const name = document.getElementById('name-input').value;
      const lang = document.getElementById('lang-select').value;
      console.warn('MYDSH_SUBMIT_TRIGGERED', name, lang);
      const res = await fetch('/api/echo?token=secret123&name=' + encodeURIComponent(name));
      const data = await res.json();
      document.getElementById('result-box').textContent = '已提交:' + data.name + ':' + lang;
    });
  </script>
</body>
</html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/api/echo') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, name: url.searchParams.get('name') ?? '' }))
    return
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(TEST_HTML)
})

const home = await realpath(await mkdtemp(join(tmpdir(), 'mydsh-browser-verify-')))
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const testUrl = `http://127.0.0.1:${port}/`

  let verifyMode = 'all'
  if (onlyEmbedded) verifyMode = 'embedded'
  else if (onlyExternal) verifyMode = 'external'

  const env = {
    ...process.env,
    MYDSH_VERIFY_BROWSER_HOME: home,
    MYDSH_VERIFY_BROWSER_URL: testUrl,
    MYDSH_VERIFY_BROWSER_MODE: verifyMode,
  }
  delete env.ELECTRON_RUN_AS_NODE

  const child = spawn(electron, ['scripts/verify-browser-automation-electron.mjs'], {
    cwd: root,
    env,
    stdio: 'inherit',
  })
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        /* 忽略进程已退出。 */
      }
      reject(new Error('浏览器自动化真实 Electron 验收超时（45s）'))
    }, 45_000)
    child.once('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolveExit()
      else reject(new Error(`浏览器自动化真实 Electron 验收失败：退出码 ${code}`))
    })
  })
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(home, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
