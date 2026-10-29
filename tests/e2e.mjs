/**
 * 端到端测试：用假 ctx 走一遍插件注册的全部工具，对真 Edge/Chrome（无头）跑。
 * 跑法：node tests/e2e.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { closeBrowser } from '../lib/cdp.mjs'

const CDP_PORT = 9341

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>F12 测试页</title></head>
<body>
  <header><nav>导航</nav></header>
  <h1 id="title">F12 测试页</h1>
  <div id="app" data-testid="app-root">
    <ul class="list">
      <li class="item" data-id="1">第一项</li>
      <li class="item" data-id="2">第二项</li>
      <li class="item" data-id="3">第三项</li>
    </ul>
    <button id="btn">点我</button>
    <a id="dl" href="/api/file" download="report.csv">下载报表</a>
    <div id="out"></div>
  </div>
  <form id="login-form" action="/api/login" method="post">
    <label for="user">用户名</label>
    <input id="user" name="username" placeholder="请输入用户名">
    <input type="password" name="password" placeholder="请输入密码">
    <button type="submit">登录</button>
  </form>
  <script>
    console.log('页面加载：普通日志', { page: 'f12-test', n: 1 })
    console.info('页面加载：info')
    console.warn('页面加载：警告')
    console.error('页面加载：错误', new Error('示例错误'))
    setTimeout(() => console.log('延迟 500ms 的日志'), 500)
    fetch('/api/demo?from=page').then(r => console.log('fetch 完成', r.status)).catch(e => console.error('fetch 失败', e))
    window.__testData = { hello: 'world', nums: [1, 2, 3] }
    window.__add = (a, b) => a + b
    try {
      localStorage.setItem('auth_token', 'eyJhbGciOiJIUzI1NiJ9.demo.signature')
      localStorage.setItem('userInfo', '{"name":"测试用户","id":42}')
      document.cookie = 'sessionid=demo-cookie-123; path=/'
    } catch (e) {}
    document.getElementById('btn').addEventListener('click', () => {
      console.log('按钮被点击')
      const li = document.createElement('li')
      li.className = 'item'
      li.textContent = '新增项'
      document.querySelector('.list').appendChild(li)
      document.getElementById('out').textContent = '已点击'
    })
  </script>
</body></html>`

const checks = []
function check(name, condition, detail = '') {
  checks.push({ name, ok: Boolean(condition), detail })
  if (condition) {
    console.log(`  ✅ ${name}`)
  } else {
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`)
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    const url = String(req.url || '')
    if (url.startsWith('/api/demo')) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    if (url.startsWith('/api/file')) {
      const body = 'name,value\nalpha,1\nbeta,2\n'
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="report.csv"',
      })
      res.end(body)
      return
    }
    if (url.startsWith('/api/login')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE_HTML)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const sitePort = server.address().port
  const pageUrl = `http://127.0.0.1:${sitePort}/`

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-devtools-test-'))
  const outDir = path.join(tempRoot, 'workspace')
  fs.mkdirSync(outDir, { recursive: true })

  const tools = new Map()
  const fakeCtx = {
    tools: { register: (definition) => tools.set(definition.name, definition) },
    workingDirectory: { ensure: async () => outDir },
  }

  let failed = false
  try {
    apply(fakeCtx, {
      cdpPort: CDP_PORT,
      headless: true,
      userDataDir: path.join(tempRoot, 'browser-profile'),
      outSubdir: 'shots',
      downloadSubdir: 'downloads',
      timeoutMs: 60000,
    })

    const exec = { agent: { id: 'e2e' }, signal: undefined }
    const run = async (toolName, args = {}) => {
      const definition = tools.get(toolName)
      if (!definition) throw new Error(`工具没注册：${toolName}`)
      return String(await definition.execute(args, exec))
    }

    console.log('\n[1] 工具注册')
    check(`注册了 17 个工具（实际 ${tools.size}）`, tools.size === 17)
    for (const name of ['devtools_status', 'devtools_launch', 'devtools_pages', 'devtools_open', 'devtools_console', 'devtools_dom', 'devtools_eval', 'devtools_network', 'devtools_screenshot', 'devtools_summary', 'devtools_find', 'devtools_activity', 'devtools_storage', 'devtools_download', 'devtools_live_status', 'devtools_live_attach', 'devtools_live_detach']) {
      check(`有 ${name}`, tools.has(name))
    }

    console.log('\n[2] 启动浏览器')
    const statusBefore = await run('devtools_status')
    check('status 在启动前报告离线', statusBefore.includes('离线'), statusBefore.split('\n')[0])
    const launchText = await run('devtools_launch', { headless: true })
    check('launch 成功', launchText.includes('浏览器已启动') || launchText.includes('复用'), launchText.split('\n')[0])

    console.log('\n[3] 打开页面')
    const openText = await run('devtools_open', { url: pageUrl })
    check('open 返回了目标 URL', openText.includes(pageUrl), openText)
    const pagesText = await run('devtools_pages')
    check('pages 列出了测试页', pagesText.includes('F12 测试页'), pagesText)

    console.log('\n[4] 控制台')
    const consoleText = await run('devtools_console', { level: 'all', wait_ms: 800 })
    check('回放到普通日志', consoleText.includes('页面加载：普通日志'), consoleText.slice(0, 400))
    check('回放到对象内容', consoleText.includes('f12-test'), consoleText.slice(0, 600))
    check('回放到 error 与堆栈', consoleText.includes('示例错误'))
    check('回放到延迟日志', consoleText.includes('延迟 500ms 的日志'))
    check('回放到浏览器级 404 日志', /404/.test(consoleText))
    const errorOnly = await run('devtools_console', { level: 'error' })
    check('level=error 过滤掉 info', !errorOnly.includes('页面加载：info') && errorOnly.includes('示例错误'))

    console.log('\n[5] DOM')
    const outline = await run('devtools_dom', { selector: '#app', mode: 'outline', depth: 3 })
    check('outline 有结构树', outline.includes('div#app') && outline.includes('li.item'), outline)
    const attrs = await run('devtools_dom', { selector: '#app', mode: 'attrs' })
    check('attrs 读到属性', attrs.includes('app-root'), attrs)
    const html = await run('devtools_dom', { mode: 'html', max_chars: 4000 })
    check('html 读到页面标记', html.includes('<title>F12 测试页</title>'), html.slice(0, 300))
    const text = await run('devtools_dom', { selector: '#app', mode: 'text' })
    check('text 读到文本', text.includes('第一项'), text)

    console.log('\n[6] 页面内 JS')
    const evalText = await run('devtools_eval', { expression: '({ sum: window.__add(2, 3), title: document.title })' })
    check('eval 返回结构化结果', evalText.includes('"sum": 5') && evalText.includes('F12 测试页'), evalText)
    const evalAsync = await run('devtools_eval', { expression: 'await new Promise(r => setTimeout(() => r(42), 100))' })
    check('eval 支持 await', evalAsync.includes('42'), evalAsync)

    console.log('\n[7] 页面概览')
    const summary = await run('devtools_summary')
    check('summary 有标题和正文', summary.includes('F12 测试页') && summary.includes('正文摘录'), summary.slice(0, 500))
    check('summary 有表单和字段', summary.includes('login-form') && summary.includes('name=username'), summary.slice(0, 1200))
    check('summary 有按钮和链接', summary.includes('点我') && summary.includes('下载报表'), summary.slice(0, 1500))
    check('summary 识别疑似登录态存储键', summary.includes('auth_token'), summary.slice(0, 1600))

    console.log('\n[8] 元素定位')
    const findById = await run('devtools_find', { selector: '#btn' })
    check('find 返回唯一 CSS 和 XPath', findById.includes('定位器：') && findById.includes('XPath') && findById.includes('#btn'), findById)
    const findByText = await run('devtools_find', { text: '下载报表' })
    check('find 按文本找到下载链接', findByText.includes('#dl') && findByText.includes('/api/file'), findByText)
    const findLi = await run('devtools_find', { text: '第一项', tag: 'li' })
    check('find 文本+标签命中 li', findLi.includes('li.item') && findLi.includes('第一项'), findLi)

    console.log('\n[9] 操作时间线')
    const startText = await run('devtools_activity', { action: 'start' })
    check('activity start 成功', startText.includes('记录器') && (startText.includes('已启动') || startText.includes('已经在运行')), startText)
    await run('devtools_eval', { expression: "document.getElementById('btn').click()" })
    await new Promise((resolve) => setTimeout(resolve, 600))
    const activity = await run('devtools_activity', { action: 'read', since_ms: 60000 })
    check('时间线记录到点击', activity.includes('[点击]'), activity)
    check('时间线记录到 DOM 变化', activity.includes('[DOM]'), activity)
    check('时间线合并控制台日志', activity.includes('按钮被点击'), activity)

    console.log('\n[10] 存储')
    const storage = await run('devtools_storage')
    check('storage 读到 localStorage token', storage.includes('auth_token') && storage.includes('eyJ'), storage)
    check('storage 读到 cookie', storage.includes('sessionid'), storage)
    check('storage 标记疑似登录态', storage.includes('疑似登录态'), storage)

    console.log('\n[11] 网络')
    const history = await run('devtools_network', { mode: 'history', filter: 'api/demo', limit: 20 })
    check('history 抓到 /api/demo 404', history.includes('404') && history.includes('/api/demo'), history)
    const live = await run('devtools_network', { mode: 'live', reload: true, wait_ms: 6000, limit: 20 })
    check('live 至少抓到页面文档', live.includes('GET') && live.includes('Document'), live)

    console.log('\n[12] 下载')
    const downloadUrlText = await run('devtools_download', { url: pageUrl + 'api/file' })
    const downloadMatch = downloadUrlText.match(/已下载：(.+)/)
    const downloadFile = downloadMatch ? downloadMatch[1].trim() : ''
    check('URL 下载保存成功', Boolean(downloadFile) && fs.existsSync(downloadFile), downloadUrlText)
    if (downloadFile && fs.existsSync(downloadFile)) {
      const content = fs.readFileSync(downloadFile, 'utf8')
      check('URL 下载内容正确', content.includes('alpha,1'), content)
    }
    const downloadClickText = await run('devtools_download', { selector: '#dl' })
    const clickMatch = downloadClickText.match(/已下载：(.+)/)
    const clickFile = clickMatch ? clickMatch[1].trim() : ''
    check('点击按钮触发下载', Boolean(clickFile) && fs.existsSync(clickFile), downloadClickText)

    console.log('\n[13] 截图')
    const shotText = await run('devtools_screenshot', { full_page: true })
    const match = shotText.match(/截图已保存：(.+)/)
    const file = match ? match[1].trim() : ''
    check('截图落盘', Boolean(file) && fs.existsSync(file) && fs.statSync(file).size > 1000, shotText)

    console.log('\n[14] 清理')
    const closed = await closeBrowser(CDP_PORT)
    check('浏览器已关闭', closed)
  } catch (error) {
    failed = true
    console.error('\n💥 异常：', error && error.stack ? error.stack : error)
  } finally {
    try { await closeBrowser(CDP_PORT) } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve))
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const failedChecks = checks.filter((item) => !item.ok)
  console.log(`\n结果：${checks.length - failedChecks.length}/${checks.length} 通过`)
  if (failedChecks.length || failed) {
    console.log('失败项：')
    for (const item of failedChecks) console.log(`  - ${item.name}${item.detail ? ' — ' + String(item.detail).slice(0, 1000) : ''}`)
    process.exitCode = 1
  } else {
    console.log('ALL PASS')
  }
}

main()
