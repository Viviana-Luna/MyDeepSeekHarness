import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import type { DatabaseProfile } from '../../../packages/connections/database/types.d.ts'
import { clickTrustedElement, emulateVerificationMedia } from './desktop-verifier.ts'
import { verifyDatabaseHome } from './database-home-verifier.ts'
import { verifyDatabaseAccess } from './database-access-verifier.ts'

/** 同一真实工作区完成直连、结构、查询、取消及 SSH 通道，数据仅来自临时夹具。 */
export async function verifyDatabaseWorkspace(
  win: BrowserWindow,
  appearance: (scheme: 'light' | 'dark') => void,
  capture: (name: string) => Promise<string>,
): Promise<void> {
  const fixture = JSON.parse(readFileSync(process.env.MYDSH_DATABASE_FIXTURE!, 'utf8')) as {
    port: number
    password: string
    ca: string
    sshPort: number
    sshFingerprint: string
  }
  const images: string[] = []
  const js = (source: string) => win.webContents.executeJavaScript(source)
  const wait = async (expression: string, attempts = 220) => {
    if (
      !(await js(
        `(async()=>{for(let i=0;i<${attempts};i++){if(${expression})return true;await new Promise(r=>setTimeout(r,50))}return false})()`,
      ))
    ) {
      throw new Error(
        `数据库界面等待失败：${expression}；界面：${await js('document.body.innerText.slice(-1600)')}`,
      )
    }
  }
  const click = (selector: string) => clickTrustedElement(win, selector)
  const button = async (text: string) => {
    await wait(
      `[...document.querySelectorAll('button, [role="tab"], [role="menuitem"]')].some(node=>node.checkVisibility()&&!node.disabled&&node.textContent.replaceAll(' ','')===${JSON.stringify(text.replaceAll(' ', ''))})`,
    )
    await js(
      `(()=>{const button=[...document.querySelectorAll('button, [role="tab"], [role="menuitem"]')].find(node=>node.checkVisibility()&&!node.disabled&&node.textContent.replaceAll(' ','')===${JSON.stringify(text.replaceAll(' ', ''))});button.click()})()`,
    )
  }
  const connectionAction = async (text: string) => {
    await click('[aria-label="数据库连接操作"]')
    await button(text)
  }
  const fill = (selector: string, value: string) =>
    js(
      `(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}))})()`,
    )
  const selectTable = async (name: string) => {
    const selector = `[data-database-table=${JSON.stringify(name)}]`
    await wait(
      `document.querySelector(${JSON.stringify(selector)})?.checkVisibility()&&!document.querySelector('.database-operation')?.textContent.includes('正在')`,
    )
    await click(selector)
  }
  const runQuery = async (sql: string) => {
    await fill('[aria-label="SQL 查询内容"]', sql)
    await button('运行查询')
  }
  await emulateVerificationMedia(win)
  await wait(
    `document.querySelector('[data-view="database"]')&&document.querySelector('[data-view="connections"]')`,
  )
  await click('[data-view="database"]')
  if (await js(`!!document.querySelector('.connections-groups')`))
    throw new Error('数据库仍使用共用的二级分组入口')
  await wait(`document.querySelector('[aria-label="新增数据库连接"]:not([disabled])')`)
  await wait(`document.querySelector('[data-database-home] [aria-label="快速开始"]')`)
  if (await js(`!!document.querySelector('.database-heading')`))
    throw new Error('数据库启动时未停留在未选择连接的首页')
  await click('[aria-label="新增数据库连接"]')
  await wait(`document.getElementById('host')`)
  await fill('#name', '真实 MySQL 验收')
  await fill('#host', '127.0.0.1')
  await fill('#port', String(fixture.port))
  await fill('#username', 'mydsh_local')
  await fill('#password', fixture.password)
  await fill('#database', 'mydsh_probe')
  if (await js(`!!document.getElementById('tlsServerName')`))
    throw new Error('普通数据库连接仍要求填写 TLS 身份')
  await js('new Promise(resolve=>setTimeout(resolve,350))')
  images.push(await capture('verify-database-connection-form.png'))
  await button('TLS/SSL')
  await button('连接信息')
  if (
    !(await js(`document.getElementById('password').value===${JSON.stringify(fixture.password)}`))
  )
    throw new Error('切换连接设置标签丢失了密码')
  await button('保存连接')
  await wait(
    `!document.querySelector('.ant-modal-wrap')?.checkVisibility()&&document.querySelector('.connections-heading h2')?.textContent==='真实 MySQL 验收'`,
  )
  await click('[aria-label="返回数据库首页"]')
  await wait(`document.querySelector('[data-database-home]')?.checkVisibility()`)
  appearance('dark')
  await js('new Promise(resolve=>setTimeout(resolve,350))')
  images.push(await capture('verify-database-home-empty.png'))
  await click('[aria-label="打开连接 真实 MySQL 验收"]')
  await wait(`document.querySelector('.database-operation')?.hidden`)
  await connectionAction('测试连接')
  await wait(`document.querySelector('.app-alert--floating')?.textContent.includes('连接测试成功')`)
  if (
    !(await js(
      `(async()=> (await window.dshDesktop.remote.call('mydshDatabase/status',{})).connections[0].tlsEnabled===false)()`,
    ))
  )
    throw new Error('普通数据库连接未保存关闭 TLS 的选择')
  await connectionAction('编辑连接')
  await wait(`document.getElementById('host')?.checkVisibility()`)
  await button('TLS/SSL')
  await click('#tlsEnabled')
  await wait(`document.getElementById('tlsCa')?.checkVisibility()`)
  await fill('#tlsCa', fixture.ca)
  if (await js(`!!document.getElementById('tlsServerName').value`))
    throw new Error('TLS 身份未保持自动使用数据库地址')
  images.push(await capture('verify-database-tls-form.png'))
  await button('保存连接')
  await wait(`!document.querySelector('.ant-modal-wrap')?.checkVisibility()`)
  await connectionAction('测试连接')
  await wait(`document.querySelector('.app-alert--floating')?.textContent.includes('连接测试成功')`)
  await click('[data-database-connection]')
  await wait(
    `document.querySelector('[aria-label="数据库表列表"]')?.textContent.includes('samples')`,
  )
  await fill('[aria-label="搜索数据库对象"]', 'samples')
  await wait(
    `document.querySelector('[data-database-table="samples"]')&&!document.querySelector('[data-database-table="pages"]')`,
  )
  await fill('[aria-label="搜索数据库对象"]', '')
  await selectTable('samples')
  await wait(
    `document.querySelector('[aria-label="数据库查询结果"]')?.textContent.includes('18446744073709551615')`,
  )
  const exact = await js(
    `(()=>{const text=document.querySelector('[aria-label="数据库查询结果"]').textContent;return text.includes('12345678901234567890.1234567890')&&text.includes('0x00ff')})()`,
  )
  if (!exact) throw new Error('数据库大整数、Decimal 或二进制展示失真')
  await button('字段结构')
  await wait(`document.querySelector('[aria-label="字段结构表"]')?.textContent.includes('payload')`)
  await button('表数据')
  await selectTable('pages')
  await wait(`document.querySelectorAll('[aria-label="数据库查询结果"] tbody tr').length===100`)
  const firstPage = await js(
    `document.querySelector('[aria-label="数据库查询结果"] tbody')?.textContent`,
  )
  await click('[aria-label="下一页数据"]')
  await wait(`document.querySelector('.database-result-footer')?.textContent.includes('第 2 页')`)
  if (
    (await js(`document.querySelector('[aria-label="数据库查询结果"] tbody')?.textContent`)) ===
    firstPage
  )
    throw new Error('数据库下一页没有改变结果')
  await button('SQL 查询')
  await runQuery('SELECT id, amount, payload, NULL AS missing FROM samples')
  await wait(
    `document.querySelector('[aria-label="数据库查询结果"] .database-null')?.textContent==='NULL'`,
  )
  await runQuery('SELECT * FROM pages ORDER BY id')
  await wait(
    `document.querySelector('.database-result-footer')?.textContent.includes('500 行')&&document.querySelector('.database-result-footer')?.textContent.includes('结果上限')`,
  )
  await runQuery('DELETE FROM samples')
  await wait(`document.querySelector('.app-alert--floating.app-alert--error')`)
  await runQuery('SELECT * FROM slow_view')
  await wait(`document.querySelector('.database-operation')?.textContent.includes('正在执行')`)
  await button('取消')
  await wait(
    `document.querySelector('.app-alert--floating.app-alert--info')?.textContent.includes('操作已取消')`,
  )
  const timeoutStarted = Date.now()
  await runQuery('SELECT * FROM slow_view')
  await wait(`document.querySelector('.database-operation')?.textContent.includes('正在执行')`)
  await wait(
    `/20 秒|超时|execution time|interrupted/i.test(document.querySelector('.app-alert--floating.app-alert--error')?.textContent??'')`,
    650,
  )
  if (Date.now() - timeoutStarted < 15_000) throw new Error('慢查询没有实际进入服务端时限验证')
  await runQuery('SELECT id, amount, payload, NULL AS missing FROM samples')
  await wait(
    `document.querySelector('[aria-label="数据库查询结果"]')?.textContent.includes('18446744073709551615')`,
  )

  const profile = (await js(
    `(async()=>{const state=await window.dshDesktop.remote.call('mydshDatabase/status',{});return state.connections[0]})()`,
  )) as DatabaseProfile
  const tlsRejected = await js(`(async()=>{
    const {credentialConfigured,...request}=${JSON.stringify(profile)};
    const changed=await window.dshDesktop.remote.call('mydshDatabase/save',{request:{...request,tlsServerName:'127.0.0.2'}});
    let rejected=false;try{await window.dshDesktop.remote.call('mydshDatabase/test',{id:changed.id})}catch(error){rejected=/Hostname|certificate|证书|TLS/i.test(String(error))}
    await window.dshDesktop.remote.call('mydshDatabase/save',{request:{...request,revision:changed.revision}});
    return rejected
  })()`)
  if (!tlsRejected) throw new Error('错误数据库 TLS 身份未被拒绝')
  images.push(...(await verifyDatabaseAccess({ win, appearance, capture })))
  const tunnel = (await js(`(async()=>{
    const saved=await window.dshDesktop.remote.call('mydshSsh/save',{request:{id:null,revision:null,name:'数据库隔离通道',host:'127.0.0.1',port:${fixture.sshPort},username:'tester',auth:'password',environment:'验收',projectId:null,disabled:false,password:${JSON.stringify(fixture.password)}}});
    const challenge=await window.dshDesktop.remote.call('mydshSsh/connect',{id:saved.id,testOnly:true,columns:80,rows:24});
    if(challenge.kind!=='confirm-host'||challenge.fingerprint!==${JSON.stringify(fixture.sshFingerprint)})throw Error('隔离 SSH 身份不匹配');
    const trusted=await window.dshDesktop.remote.call('mydshSsh/trustHost',{id:saved.id,revision:challenge.revision,fingerprint:challenge.fingerprint});
    const state=await window.dshDesktop.remote.call('mydshDatabase/status',{}),{credentialConfigured,...request}=state.connections[0];
    await window.dshDesktop.remote.call('mydshDatabase/save',{request:{...request,sshConnectionId:saved.id}});
    return {id:saved.id,revision:trusted.revision}
  })()`)) as { id: string; revision: number }
  await click('[aria-label="刷新数据库连接"]')
  await wait(
    `document.querySelector('.database-connection-note')?.textContent.includes('SSH 通道')`,
  )
  await connectionAction('测试连接')
  await wait(
    `document.querySelector('.app-alert--floating.app-alert--success')?.textContent.includes('连接测试成功')`,
  )
  await runQuery('SELECT id, amount, payload, NULL AS missing FROM samples')
  await wait(
    `document.querySelector('[aria-label="数据库查询结果"]')?.textContent.includes('18446744073709551615')`,
  )
  await click('[data-view="connections"]')
  await click('[data-view="database"]')
  await wait(`document.querySelector('[aria-label="SQL 查询内容"]')?.value.includes('SELECT id')`)
  await selectTable('samples')
  await wait(
    `document.querySelector('[aria-label="数据库查询结果"]')?.textContent.includes('18446744073709551615')`,
  )

  images.push(...(await verifyDatabaseHome({ win, appearance, capture })))
  await button('表数据')
  /* oxlint-disable no-await-in-loop -- 同一窗口按顺序验收布局、主题与关闭。 */
  for (const [width, scheme] of [
    [1280, 'dark'],
    [1280, 'light'],
    [1800, 'dark'],
    [1800, 'light'],
  ] as const) {
    win.setSize(width, width === 1280 ? 800 : 1000)
    appearance(scheme)
    await js('new Promise(r=>setTimeout(r,400))')
    const layout = await js(
      `(()=>{const main=document.querySelector('[data-database-workspace]'),nav=document.querySelector('.navigation-island .connections-navigation'),a=main.getBoundingClientRect(),b=nav.getBoundingClientRect(),grid=main.querySelector('.database-results'),notice=main.querySelector('[aria-label="数据库只读说明"]');return nav.checkVisibility()&&b.right<a.left&&nav.querySelector('[data-database-table="samples"]')?.checkVisibility()&&!main.querySelector('.connections-list')&&!main.querySelector('.database-browse-controls')&&notice?.checkVisibility()&&notice.textContent.includes('单条 SELECT')&&grid.clientHeight>400&&a.width>600&&document.documentElement.scrollWidth===innerWidth})()`,
    )
    if (!layout) throw new Error('数据库导航没有位于左浮岛或主区发生溢出')
    images.push(await capture(`verify-database-${width}-${scheme}.png`))
  }
  await emulateVerificationMedia(win, [
    { name: 'forced-colors', value: 'active' },
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
  ])
  await capture('verify-database-accessible.png')
  await emulateVerificationMedia(win)
  console.log('MYDSH_DATABASE_VISUAL_READY ' + JSON.stringify(images))
  if (process.env.MYDSH_DATABASE_VISUAL_PAUSE === '1')
    await new Promise(resolve => setTimeout(resolve, 30_000))
  await connectionAction('删除连接')
  await wait(`document.querySelector('.ant-modal-confirm-btns')`)
  await click('.ant-modal-confirm-btns .ant-btn-primary')
  await wait(`!document.querySelector('[data-database-connection]')`)
  await js(`window.dshDesktop.remote.call('mydshSsh/remove',${JSON.stringify(tunnel)})`)
  const keyPath = join(app.getPath('userData'), 'connection-secrets', 'secret.key')
  const keyStat = lstatSync(keyPath)
  const keyText = readFileSync(keyPath, 'utf8').trim()
  if (
    keyStat.isSymbolicLink() ||
    !keyStat.isFile() ||
    (process.platform !== 'win32' && (keyStat.mode & 0o777) !== 0o600) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(keyText)
  ) {
    throw new Error('数据库本地主密钥文件缺失或权限无效')
  }
  console.log('mydsh-database-verify: complete', {
    independentNavigation: true,
    objectTree: true,
    tableList: true,
    search: true,
    leftIsland: true,
    optionalTls: true,
    tlsIpIdentity: true,
    tls: true,
    tlsRejected: true,
    structure: true,
    pagination: true,
    preciseTypes: true,
    readOnly: true,
    truncation: true,
    cancellation: true,
    timeout: true,
    sshTunnel: true,
    draftsPreserved: true,
    themes: true,
    deleted: true,
  })
  /* oxlint-enable no-await-in-loop */
}
