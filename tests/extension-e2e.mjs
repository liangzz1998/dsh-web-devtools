/**
 * 扩展桥端到端测试：真 Edge + --load-extension + hub + 插件 CLI。
 *
 * 验证目标：不另开专用浏览器，直接读取「用户当前正在浏览的标签页」。
 *
 * 跑法：node tests/extension-e2e.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const CLI = path.join(ROOT, 'tools', 'devtools.mjs')
const HUB = path.join(ROOT, 'tools', 'hub.mjs')
const EXTENSION = path.join(ROOT, 'extension')
const HUB_PORT = 9346
const EDGE_DEBUG_PORT = 9446

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function pageHtml(title, logText) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1 id="title">${title}</h1>
  <div id="app" data-testid="app-root">
    <ul class="list"><li class="item">甲</li><li class="item">乙</li></ul>
    <button id="btn">点我</button>
    <div id="out"></div>
  </div>
  <script>
    console.log('${logText}', { where: 'live' })
    console.warn('${title}警告')
    console.error('${title}错误')
    setTimeout(() => console.log('${title}延迟日志'), 400)
    window.__answer = 42
    document.getElementById('btn').addEventListener('click', () => {
      document.getElementById('out').textContent = '已点击'
      console.log('按钮被点了')
    })
  </script>
</body></html>`
}

const PAGE_HTML = pageHtml('当前页测试', '当前页加载：日志')

const checks = []
function check(name, ok, detail = '') {
  checks.push({ name, ok: Boolean(ok), detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${!ok && detail ? ' — ' + String(detail).slice(0, 700) : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function findBrowser() {
  for (const candidate of EDGE_CANDIDATES) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* ignore */ }
  }
  return ''
}

function runCli(payload, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI], {
      env: { ...process.env, ...(env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out = []
    const err = []
    child.stdout.on('data', (chunk) => out.push(chunk))
    child.stderr.on('data', (chunk) => err.push(chunk))
    child.on('close', () => {
      const text = Buffer.concat(out).toString('utf8').trim()
      const lines = text.split(/\r?\n/).filter(Boolean)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        try { resolve(JSON.parse(lines[index])); return } catch { /* 继续 */ }
      }
      resolve({ ok: false, error: Buffer.concat(err).toString('utf8') || text || 'no output' })
    })
    child.stdin.end(JSON.stringify(payload))
  })
}

async function hubStatus() {
  try {
    return await fetch(`http://127.0.0.1:${HUB_PORT}/status`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
  } catch {
    return null
  }
}

async function waitFor(predicate, timeoutMs, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await sleep(intervalMs)
  }
  return null
}

async function main() {
  const browser = findBrowser()
  if (!browser) {
    console.log('SKIP: 没找到 Edge/Chrome')
    process.exit(0)
  }

  const server = http.createServer((request, response) => {
    const pathname = String(request.url || '/').split('?')[0]
    const html = pathname.startsWith('/next')
      ? pageHtml('第二页', '第二页加载')
      : PAGE_HTML
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(html)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const sitePort = server.address().port
  const pageUrl = `http://127.0.0.1:${sitePort}/`

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-live-e2e-'))
  const profileDir = path.join(tempRoot, 'edge-profile')
  const stateHome = path.join(tempRoot, 'dsh-home')
  // 复制一份扩展并把默认 hub 端口改成测试端口，避免干扰用户日常正在用的扩展/hub
  const extensionCopy = path.join(tempRoot, 'extension')
  fs.cpSync(EXTENSION, extensionCopy, { recursive: true })
  const backgroundPath = path.join(extensionCopy, 'background.js')
  fs.writeFileSync(
    backgroundPath,
    fs.readFileSync(backgroundPath, 'utf8').replace('const DEFAULT_HUB_PORT = 9335', `const DEFAULT_HUB_PORT = ${HUB_PORT}`),
  )
  fs.mkdirSync(profileDir, { recursive: true })
  fs.mkdirSync(stateHome, { recursive: true })
  const env = { DSH_HOME: stateHome }
  const outDir = path.join(tempRoot, 'shots')
  fs.mkdirSync(outDir, { recursive: true })

  let hub = null
  let edge = null
  let failed = false

  try {
    // 1. 起 hub
    hub = spawn(process.execPath, [HUB, `--port=${HUB_PORT}`], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    hub.stdout.on('data', (chunk) => process.stdout.write('[hub] ' + chunk))
    hub.stderr.on('data', (chunk) => process.stderr.write('[hub:err] ' + chunk))
    const up = await waitFor(async () => (await hubStatus())?.service === 'dsh-web-devtools-hub', 10000)
    check('hub 启动', Boolean(up))
    if (!up) throw new Error('hub 启动失败')

    // 2. 启动 Edge（加载扩展、打开测试页）
    const edgeArgs = [
      `--user-data-dir=${profileDir}`,
      `--load-extension=${extensionCopy}`,
      `--disable-extensions-except=${extensionCopy}`,
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--remote-debugging-port=${EDGE_DEBUG_PORT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--headless=new',
      '--disable-gpu',
      pageUrl,
    ]
    edge = spawn(browser, edgeArgs, { stdio: 'ignore', windowsHide: true })
    console.log('  …等待扩展连接 hub（最多 25s）')
    const connected = await waitFor(async () => {
      const status = await hubStatus()
      return status && status.extensionConnected ? status : null
    }, 25000)
    check('扩展自动连接 hub', Boolean(connected), connected ? '' : '扩展没有连上（headless 下扩展可能被禁用）')
    if (!connected) throw new Error('扩展未连接：' + JSON.stringify(await hubStatus()))
    const tabs = (connected.extension && connected.extension.tabs) || connected.tabs || []
    check('扩展上报了标签页', tabs.length > 0, JSON.stringify(tabs).slice(0, 400))

    // 3. 接入当前标签页
    const attach = await runCli({ op: 'live-attach', config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('live-attach 成功', attach.ok === true && String(attach.text || '').includes('已接入'), attach.text || attach.error)

    // 4. 用 target="current" 读当前页
    const consoleResult = await runCli({ op: 'console', target: 'current', level: 'all', wait_ms: 900, config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    const consoleText = String(consoleResult.text || '')
    check('console 回放到日志', consoleText.includes('当前页加载：日志'), consoleText)
    check('console 回放到 error', consoleText.includes('当前页测试错误'), consoleText)
    check('console 回放到延迟日志', consoleText.includes('延迟日志'), consoleText)

    const dom = await runCli({ op: 'dom', target: 'current', selector: '#app', mode: 'outline', depth: 3, config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('dom 读到结构树', String(dom.text || '').includes('div#app'), dom.text || dom.error)

    const evalResult = await runCli({ op: 'eval', target: 'current', expression: 'window.__answer + 1', config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('eval 读到全局变量', String(evalResult.text || '').includes('43'), evalResult.text || evalResult.error)

    const summary = await runCli({ op: 'summary', target: 'current', config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('summary 读到页面概览', String(summary.text || '').includes('当前页测试'), summary.text || summary.error)

    const find = await runCli({ op: 'find', target: 'current', selector: '#btn', config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('find 返回定位器', String(find.text || '').includes('定位器：'), find.text || find.error)

    const shot = await runCli({ op: 'screenshot', target: 'current', outDir, config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    const shotPath = (String(shot.text || '').match(/截图已保存：(.+)/) || [])[1]
    check('screenshot 落盘', Boolean(shotPath) && fs.existsSync(shotPath.trim()) && fs.statSync(shotPath.trim()).size > 500, shot.text || shot.error)

    // 5. 同标签页跳转：整页导航后应继续有效，不需要断开重接
    const beforeNav = await hubStatus()
    const attachedTabId = beforeNav && beforeNav.attached && beforeNav.attached[0] ? beforeNav.attached[0].tabId : null
    check('接入的是测试页（不是用户浏览器）', Boolean(beforeNav && beforeNav.attached && beforeNav.attached[0] && String(beforeNav.attached[0].title).includes('当前页测试')), JSON.stringify(beforeNav && beforeNav.attached))
    const navEval = await runCli({ op: 'eval', target: 'current', expression: "location.href = '/next'", config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    await sleep(2500)
    const afterNavTitle = await runCli({ op: 'eval', target: 'current', expression: 'document.title', config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    const afterNav = await runCli({ op: 'console', target: 'current', level: 'all', wait_ms: 800, config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('整页导航后无需重接即可读', String(afterNav.text || '').includes('第二页加载'), afterNav.text || afterNav.error)
    const statusAfterNav = await hubStatus()
    check('attached 仍是同一个 tab', Boolean(attachedTabId) && statusAfterNav && statusAfterNav.attached && statusAfterNav.attached[0] && Number(statusAfterNav.attached[0].tabId) === Number(attachedTabId), JSON.stringify(statusAfterNav && statusAfterNav.attached))

    // 6. SPA 路由跳转后也应继续有效
    const spaEval = await runCli({ op: 'eval', target: 'current', expression: "history.pushState({}, '', '/spa'); console.log('SPA 后的日志')", config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    await sleep(500)
    const afterSpa = await runCli({ op: 'console', target: 'current', level: 'all', wait_ms: 600, config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('SPA 路由后无需重接即可读', String(afterSpa.text || '').includes('SPA 后的日志'), afterSpa.text || afterSpa.error)

    // 7. 断开
    const detach = await runCli({ op: 'live-detach', config: { hubPort: HUB_PORT, autoStartHub: false } }, env)
    check('live-detach 成功', String(detach.text || '').includes('已断开'), detach.text || detach.error)
  } catch (error) {
    failed = true
    console.error('\n异常：', error && error.stack ? error.stack : error)
  } finally {
    try { if (edge && edge.pid) spawn('taskkill', ['/F', '/T', '/PID', String(edge.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
    try { if (hub && hub.pid) spawn('taskkill', ['/F', '/T', '/PID', String(hub.pid)], { stdio: 'ignore', windowsHide: true }) } catch { /* ignore */ }
    await sleep(800)
    try { server.close() } catch { /* ignore */ }
    try { fs.rmSync(tempRoot, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  const failedChecks = checks.filter((item) => !item.ok)
  console.log(`\n结果：${checks.length - failedChecks.length}/${checks.length} 通过`)
  if (failedChecks.length || failed) {
    for (const item of failedChecks) console.log(`  - ${item.name}`)
    process.exitCode = 1
  } else {
    console.log('ALL PASS')
  }
}

main()
