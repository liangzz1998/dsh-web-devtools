/**
 * dsh-web-devtools —— 读取网页「F12 开发者工具」里那些东西的底层实现。
 *
 * 走 Chrome DevTools Protocol（CDP），和 F12 面板用的是同一套协议：
 *   - 控制台（Console）：Runtime.consoleAPICalled / exceptionThrown / Log.entryAdded
 *   - DOM：Runtime.evaluate 拿 outerHTML / 文本 / 结构树 / 元素属性
 *   - 网络（Network）：PerformanceResourceTiming 历史 + Network 域实时抓包
 *   - 截图：Page.captureScreenshot
 *
 * 零依赖：只用 Node ≥ 22 内置的 fetch / WebSocket。
 * 浏览器由 launchBrowser() 以 --remote-debugging-port 拉起，用独立 profile
 * （不会碰用户自己的浏览器配置，也不要求先关掉用户正在用的 Edge）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_PORT = 9333

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PAGE_DIR = path.join(HERE, 'page')
const pageScriptCache = new Map()

/** 读取 lib/page/*.js（页面侧脚本，由 Runtime.evaluate 注入执行）。 */
function pageScript(name) {
  if (!pageScriptCache.has(name)) {
    pageScriptCache.set(name, fs.readFileSync(path.join(PAGE_DIR, name + '.js'), 'utf8'))
  }
  return pageScriptCache.get(name)
}

/**
 * 在页面里跑一段 lib/page 脚本：
 * 外层包成 (() => { const __args = {...}; ...script... })()，
 * 脚本里直接读 __args、用 return 返回结果。
 */
async function runPageScript(page, name, args = {}) {
  const source = `(() => {\nconst __args = ${JSON.stringify(args || {})};\n${pageScript(name)}\n})()`
  const result = await evaluateRaw(page, source, { awaitPromise: false, timeoutMs: 20000 })
  const value = resultValue(result)
  if (!value.ok) throw new Error(value.error)
  return value.value
}

/** 等待毫秒。 */
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 浏览器独立 profile 目录（持久化登录态）。 */
export function defaultUserDataDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'dsh-web-devtools', 'browser-profile')
}

/** 候选浏览器可执行文件，按优先级。 */
export function browserCandidates() {
  const out = []
  const add = (p) => { if (p && !out.includes(p)) out.push(p) }
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles || 'C:\\Program Files'
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    add(path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    add(path.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    add(path.join(local, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    add(path.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    add(path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    add(path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    add(path.join(pf, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'))
    add(path.join(local, 'Chromium', 'Application', 'chrome.exe'))
  } else if (process.platform === 'darwin') {
    add('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
    add('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else {
    add('/usr/bin/microsoft-edge')
    add('/usr/bin/google-chrome')
    add('/usr/bin/chromium')
  }
  return out
}

/** 找浏览器：显式配置 > 环境变量 > 默认安装路径。 */
export function findBrowser(preferred = '') {
  const explicit = String(preferred || process.env.DSH_WEB_DEVTOOLS_BROWSER || '').trim()
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit
    return explicit // 交给调用方报「配置的路径不存在」
  }
  for (const candidate of browserCandidates()) {
    try { if (fs.existsSync(candidate)) return candidate } catch { /* ignore */ }
  }
  return ''
}

async function httpJson(url, timeoutMs = 3000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`)
  return res.json()
}

/** CDP 端口是否活着。 */
export async function cdpVersion(port, timeoutMs = 1500) {
  try {
    const v = await httpJson(`http://127.0.0.1:${port}/json/version`, timeoutMs)
    return { alive: true, browser: v.Browser || '', protocol: v['Protocol-Version'] || '', wsUrl: v.webSocketDebuggerUrl || '' }
  } catch {
    return { alive: false, browser: '', protocol: '', wsUrl: '' }
  }
}

/** 列出所有可调试页面。 */
export async function listPages(port) {
  const list = await httpJson(`http://127.0.0.1:${port}/json/list`, 5000)
  const pages = Array.isArray(list) ? list : []
  return pages
    .filter((t) => t && t.type === 'page' && t.webSocketDebuggerUrl)
    .map((t) => ({ id: String(t.id || ''), title: String(t.title || ''), url: String(t.url || ''), ws: String(t.webSocketDebuggerUrl) }))
}

/**
 * 启动（或复用）带调试端口的浏览器。
 * @param {{cdpPort?:number, browser?:string, userDataDir?:string, headless?:boolean, url?:string, autoLaunch?:boolean}} cfg
 */
export async function launchBrowser(cfg = {}) {
  const port = clamp(cfg.cdpPort, 1, 65535, DEFAULT_PORT)
  const existing = await cdpVersion(port)
  if (existing.alive) {
    return { launched: false, port, ...existing, exe: findBrowser(cfg.browser), userDataDir: cfg.userDataDir ? path.resolve(cfg.userDataDir) : defaultUserDataDir() }
  }
  const exe = findBrowser(cfg.browser)
  if (!exe) throw new Error('没找到 Edge / Chrome。请在插件配置里设置 browser 为浏览器 exe 的绝对路径。')
  if (!fs.existsSync(exe)) throw new Error(`配置的浏览器路径不存在：${exe}`)
  const userDataDir = cfg.userDataDir ? path.resolve(cfg.userDataDir) : defaultUserDataDir()
  fs.mkdirSync(userDataDir, { recursive: true })

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-allow-origins=*',
    '--disable-features=msEdgeFirstRunExperience,Translate',
  ]
  if (cfg.headless) args.push('--headless=new', '--disable-gpu')
  args.push(String(cfg.url || 'about:blank'))

  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()

  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await sleep(250)
    const info = await cdpVersion(port)
    if (info.alive) {
      await sleep(500) // 等首个页面建好
      return { launched: true, port, exe, userDataDir, ...info }
    }
  }
  throw new Error(`已启动浏览器（${exe}），但 CDP 端口 ${port} 在 25 秒内没就绪。`
    + '可能是浏览器以普通模式先占用了同一个 user-data-dir；请完全退出我们拉起的浏览器后重试。')
}

/** 需要页面时确保浏览器在跑。 */
export async function ensureBrowser(cfg = {}) {
  const port = clamp(cfg.cdpPort, 1, 65535, DEFAULT_PORT)
  const info = await cdpVersion(port)
  if (info.alive) return { launched: false, port, ...info }
  if (cfg.autoLaunch === false) {
    throw new Error(`CDP 端口 ${port} 离线，且插件配置 autoLaunch=false。请先调用 devtools_launch。`)
  }
  return launchBrowser(cfg)
}

/**
 * 选页面：
 * - target 为空 → 最近的 http(s) 页面（没有就最后一页）
 * - 数字 → 列表序号
 * - target id / URL / 标题片段 → 匹配
 */
export function pickPage(pages, target = '') {
  if (!pages || !pages.length) {
    throw new Error('浏览器里没有可调试的页面，先用 devtools_open 打开一个 URL。')
  }
  const t = String(target || '').trim()
  if (!t) {
    const httpPages = pages.filter((p) => /^https?:/i.test(p.url))
    const pool = httpPages.length ? httpPages : pages
    return pool[pool.length - 1]
  }
  if (/^\d+$/.test(t)) {
    const index = Number(t)
    if (index >= 0 && index < pages.length) return pages[index]
    throw new Error(`页面序号 ${index} 超出范围（共 ${pages.length} 个页面）`)
  }
  const byId = pages.find((p) => p.id === t)
  if (byId) return byId
  const low = t.toLowerCase()
  const byUrl = pages.find((p) => p.url.toLowerCase().includes(low))
  if (byUrl) return byUrl
  const byTitle = pages.find((p) => p.title.toLowerCase().includes(low))
  if (byTitle) return byTitle
  throw new Error(`没找到匹配「${t}」的页面。先用 devtools_pages 看看有哪些页面。`)
}

/** 一个 CDP 会话（WebSocket 连接）。 */
export class CdpSession {
  constructor(wsUrl, { timeoutMs = 30000 } = {}) {
    this.wsUrl = wsUrl
    this.timeoutMs = timeoutMs
    this.nextId = 0
    this.pending = new Map()
    this.listeners = new Map()
    this.ws = null
    this.closed = false
  }

  async connect() {
    if (typeof WebSocket !== 'function') {
      throw new Error('当前 Node 运行时没有全局 WebSocket（需要 Node ≥ 22）。请把 DSH_NODE 指向较新的 node。')
    }
    const ws = new WebSocket(this.wsUrl)
    this.ws = ws
    ws.addEventListener('message', (event) => this._onMessage(event.data))
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('连接 CDP WebSocket 超时')), Math.min(this.timeoutMs, 8000))
      ws.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`连接 CDP WebSocket 失败：${this.wsUrl}`)) }, { once: true })
      ws.addEventListener('close', () => { clearTimeout(timer); reject(new Error('CDP WebSocket 在连接阶段就被关闭')) }, { once: true })
    })
  }

  _onMessage(raw) {
    let msg
    try {
      msg = typeof raw === 'string' ? JSON.parse(raw) : JSON.parse(Buffer.from(raw).toString('utf8'))
    } catch { return }
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id)
      if (!pending) return
      this.pending.delete(msg.id)
      clearTimeout(pending.timer)
      if (msg.error) pending.reject(new Error(`${pending.method}: ${msg.error.message || JSON.stringify(msg.error)}`))
      else pending.resolve(msg.result)
      return
    }
    const handlers = this.listeners.get(msg.method)
    if (handlers) {
      for (const handler of handlers) {
        try { handler(msg.params, msg) } catch { /* 监听器异常不影响主流程 */ }
      }
    }
  }

  send(method, params = {}, timeoutMs) {
    if (this.closed) return Promise.reject(new Error('CDP 会话已关闭'))
    const id = ++this.nextId
    const limit = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP 调用超时：${method}（>${Math.round(limit / 1000)}s）`))
      }, limit)
      this.pending.set(id, { method, resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(e)
      }
    })
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, [])
    this.listeners.get(method).push(handler)
    return () => {
      const list = this.listeners.get(method)
      if (!list) return
      const index = list.indexOf(handler)
      if (index >= 0) list.splice(index, 1)
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('CDP 会话已关闭'))
    }
    this.pending.clear()
    try { this.ws && this.ws.close() } catch { /* ignore */ }
  }
}

/** 在页面会话里跑一段逻辑。 */
export async function withPage(page, fn, timeoutMs = 30000) {
  const session = new CdpSession(page.ws, { timeoutMs })
  await session.connect()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

/* ------------------------------------------------------------------ *
 * 控制台
 * ------------------------------------------------------------------ */

const CONSOLE_LEVELS = { debug: 0, log: 1, info: 2, warn: 3, error: 4 }

function mapConsoleLevel(type) {
  switch (type) {
    case 'warning': return 'warn'
    case 'error': return 'error'
    case 'assert': return 'error'
    case 'debug': return 'debug'
    case 'trace': return 'debug'
    case 'info': return 'info'
    case 'dir':
    case 'dirxml':
    case 'table': return 'log'
    default: return 'log'
  }
}

function mapLogLevel(level) {
  switch (level) {
    case 'error': return 'error'
    case 'warning': return 'warn'
    case 'info': return 'info'
    default: return 'debug'
  }
}

function previewToText(preview) {
  if (!preview) return ''
  if (preview.subtype === 'null') return 'null'
  if (preview.subtype === 'array') {
    const props = (preview.properties || []).map((p) => p.name + ': ' + (p.value === undefined ? p.type : p.value))
    return `Array(${props.length})[${props.join(', ')}]`
  }
  if (preview.subtype === 'error') return preview.description || 'Error'
  const name = preview.description || 'Object'
  const props = (preview.properties || []).slice(0, 12).map((p) => {
    const v = p.value !== undefined ? p.value : (p.type === 'string' ? '""' : p.type)
    return `${p.name}: ${v}`
  })
  return `${name} {${props.join(', ')}}`
}

/** 把一个 console 参数（RemoteObject）转成可读文本。 */
export function remoteArgToText(arg) {
  if (!arg) return ''
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
    const v = arg.value
    if (typeof v === 'string') return v
    if (v === null) return 'null'
    if (v === undefined) return 'undefined'
    if (typeof v === 'object') {
      if (arg.subtype === 'null') return 'null'
      try { return JSON.stringify(v) } catch { return String(v) }
    }
    return String(v)
  }
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue)
  if (arg.type === 'undefined') return 'undefined'
  if (arg.type === 'function') return arg.description || '[function]'
  if (arg.preview) return previewToText(arg.preview)
  return arg.description || `[${arg.type || 'unknown'}]`
}

function stackFrame(stackTrace) {
  const frame = stackTrace && Array.isArray(stackTrace.callFrames) && stackTrace.callFrames[0]
  if (!frame) return { url: '', line: -1 }
  return { url: frame.url || '', line: Number(frame.lineNumber) >= 0 ? Number(frame.lineNumber) + 1 : -1 }
}

function exceptionText(details) {
  const d = details || {}
  const exception = d.exception || {}
  const base = exception.description || exception.value || d.text || '未捕获异常'
  return String(base)
}

/**
 * 回放的 console 对象只有 objectId：用 Runtime.getProperties 补一层浅属性，
 * 让「读取 F12 控制台」也能看到 { a: 1 } 这种内容，而不是光一个 "Object"。
 */
async function describeObject(session, objectId) {
  try {
    const result = await session.send('Runtime.getProperties', {
      objectId,
      ownProperties: true,
      generatePreview: false,
    }, 3000)
    const props = (result.result || [])
      .filter((prop) => prop && prop.enumerable !== false && prop.name !== '__proto__' && prop.name !== 'length')
      .slice(0, 12)
    if (!props.length) return ''
    const parts = props.map((prop) => {
      if (!prop.value) return `${prop.name}: (访问器)`
      const text = remoteArgToText(prop.value)
      return `${prop.name}: ${prop.value.type === 'string' ? JSON.stringify(text) : text}`
    })
    return ` {${parts.join(', ')}}`
  } catch {
    return ''
  }
}

/**
 * 读控制台。
 * attach 之后 Runtime.enable 会把**已经发生过的 console 消息回放**给新客户端
 *（Chrome 的 V8ConsoleMessageStorage 会重放），所以不需要常驻进程也能读历史。
 */
export async function readConsole(page, opts = {}) {
  const waitMs = clamp(opts.waitMs, 0, 30000, 600)
  const session = new CdpSession(page.ws, { timeoutMs: 30000 })
  await session.connect()
  const messages = []
  let enrichBudget = 40
  try {
    session.on('Runtime.consoleAPICalled', (params) => {
      const frame = stackFrame(params.stackTrace)
      messages.push({
        level: mapConsoleLevel(params.type),
        source: 'console',
        text: '',
        rawArgs: params.args || [],
        url: frame.url,
        line: frame.line,
        ts: Number(params.timestamp) || Date.now(),
      })
    })
    session.on('Runtime.exceptionThrown', (params) => {
      const d = params.exceptionDetails || {}
      const frame = stackFrame(d.stackTrace)
      messages.push({
        level: 'error',
        source: 'exception',
        text: exceptionText(d),
        url: d.url || frame.url,
        line: Number(d.lineNumber) >= 0 ? Number(d.lineNumber) + 1 : frame.line,
        ts: Number(params.timestamp) || Date.now(),
      })
    })
    session.on('Log.entryAdded', (params) => {
      const entry = params.entry || {}
      messages.push({
        level: mapLogLevel(entry.level),
        source: 'browser',
        text: String(entry.text || ''),
        url: entry.url || '',
        line: Number(entry.lineNumber) >= 0 ? Number(entry.lineNumber) + 1 : -1,
        ts: Number(entry.timestamp) || Date.now(),
      })
    })
    await session.send('Runtime.enable')
    await session.send('Log.enable')
    await sleep(waitMs)

    // 回放的 console 参数往往只有 objectId、没有 preview → 现场取一遍属性补全
    for (const message of messages) {
      if (!message.rawArgs) continue
      const parts = []
      for (const arg of message.rawArgs) {
        let text = remoteArgToText(arg)
        const needsDetail = arg && !arg.preview && arg.objectId && (arg.type === 'object' || arg.type === 'function')
        if (needsDetail && enrichBudget > 0) {
          enrichBudget -= 1
          const detail = await describeObject(session, arg.objectId)
          if (detail) text = (arg.description && arg.description !== 'Object' ? arg.description : (arg.className || 'Object')) + detail
        }
        parts.push(text)
      }
      message.text = parts.join(' ')
      delete message.rawArgs
    }
  } finally {
    await session.close()
  }

  // 同一个错误可能同时经 console + log 两条通道上报，去重
  const deduped = []
  for (const message of messages) {
    const duplicate = deduped.find((prev) => prev.text === message.text
      && Math.abs(prev.ts - message.ts) < 5000
      && prev.level === message.level)
    if (!duplicate) deduped.push(message)
  }

  const minimum = opts.level && opts.level !== 'all' && CONSOLE_LEVELS[opts.level] !== undefined
    ? CONSOLE_LEVELS[opts.level]
    : -1
  const keyword = String(opts.filter || '').trim().toLowerCase()
  const filtered = deduped.filter((message) => {
    if (minimum >= 0 && (CONSOLE_LEVELS[message.level] ?? 9) < minimum) return false
    if (keyword) {
      const haystack = `${message.text}\n${message.url}`.toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
  filtered.sort((a, b) => a.ts - b.ts)
  const total = filtered.length
  const limit = clamp(opts.limit, 1, 500, 100)
  const sliced = filtered.slice(-limit)
  return { page: { title: page.title, url: page.url }, messages: sliced, total, shown: sliced.length }
}

/* ------------------------------------------------------------------ *
 * eval / DOM
 * ------------------------------------------------------------------ */

function resultValue(result) {
  if (result && result.exceptionDetails) {
    const d = result.exceptionDetails || {}
    const description = (d.exception && (d.exception.description || d.exception.value)) || d.text || '执行出错'
    return { ok: false, error: String(description), line: d.lineNumber, column: d.columnNumber, url: d.url || '' }
  }
  const res = (result && result.result) || {}
  if (Object.prototype.hasOwnProperty.call(res, 'value')) return { ok: true, value: res.value, type: res.type || typeof res.value }
  if (res.unserializableValue !== undefined) return { ok: true, value: String(res.unserializableValue), type: res.type || 'number' }
  if (res.type === 'undefined') return { ok: true, value: undefined, type: 'undefined' }
  return { ok: true, value: res.description || `[${res.type || 'object'}]`, type: res.type || 'object', descriptionOnly: true }
}

/** 在页面里求值（原始 CDP 结果）。 */
export async function evaluateRaw(page, expression, opts = {}) {
  const timeoutMs = clamp(opts.timeoutMs, 1000, 120000, 15000)
  return withPage(page, (session) => session.send('Runtime.evaluate', {
    expression: String(expression),
    returnByValue: true,
    awaitPromise: opts.awaitPromise !== false,
    userGesture: true,
    includeCommandLineAPI: true,
    timeout: timeoutMs,
  }, timeoutMs + 5000), timeoutMs + 10000)
}

/** 在页面里执行 JS，返回结构化结果。语句/async 会自动兜底包裹。 */
export async function evaluate(page, expression, opts = {}) {
  const source = String(expression == null ? '' : expression)
  if (!source.trim()) throw new Error('expression 不能为空')
  let result = await evaluateRaw(page, source, opts)
  if (result.exceptionDetails && /SyntaxError/i.test(String(result.exceptionDetails.text || ''))) {
    // 用户写的是语句（如 const x = 1; return x）→ 包成 async IIFE 再试
    result = await evaluateRaw(page, `(async () => {\n${source}\n})()`, opts)
  }
  const value = resultValue(result)
  return { ...value, page: { title: page.title, url: page.url } }
}

function buildDomExpression(selector, mode, depth, maxChars) {
  const sel = JSON.stringify(String(selector || ''))
  const modeValue = JSON.stringify(String(mode || 'html'))
  const dep = clamp(depth, 1, 40, 4)
  const max = clamp(maxChars, 500, 500000, 20000)
  return `(() => {
  const sel = ${sel}, mode = ${modeValue};
  const meta = { url: location.href, title: document.title, readyState: document.readyState, viewport: { width: innerWidth, height: innerHeight }, scroll: { width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0), height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0) } };
  let el = null;
  if (sel) {
    try { el = document.querySelector(sel) } catch (e) { return { ...meta, found: false, error: '选择器不合法: ' + String(e && e.message || e) } }
  }
  if (sel && !el) return { ...meta, found: false, error: '找不到元素: ' + sel };
  if (mode === 'attrs') {
    const attrs = {};
    if (el) for (const attr of el.attributes) attrs[attr.name] = attr.value;
    return { ...meta, found: true, tag: el ? el.tagName.toLowerCase() : '', attrs };
  }
  if (mode === 'rect') {
    if (!el) return { ...meta, found: false, error: 'rect 模式需要 selector' };
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return { ...meta, found: true, rect: { x: Math.round(rect.x), y: Math.round(rect.y), top: Math.round(rect.top), left: Math.round(rect.left), width: Math.round(rect.width), height: Math.round(rect.height) }, display: style.display, visibility: style.visibility, opacity: style.opacity };
  }
  if (mode === 'text') {
    const node = el || document.body;
    const text = node ? (node.innerText || '') : '';
    return { ...meta, found: true, length: text.length, truncated: text.length > ${max}, text: text.slice(0, ${max}) };
  }
  if (mode === 'outline') {
    const lines = [];
    const walk = (node, level) => {
      if (!node || node.nodeType !== 1 || level > ${dep} || lines.length >= 500) return;
      const tag = node.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'template' || tag === 'svg' || tag === 'path') return;
      let line = '  '.repeat(level) + tag;
      if (node.id) line += '#' + node.id;
      if (node.classList && node.classList.length) line += '.' + Array.from(node.classList).slice(0, 3).join('.');
      if (node.children.length === 0) {
        const text = (node.innerText || '').replace(/\\s+/g, ' ').trim();
        if (text && text.length <= 60) line += ' "' + text + '"';
      }
      lines.push(line);
      for (const child of node.children) walk(child, level + 1);
    };
    walk(el || document.body, 0);
    return { ...meta, found: true, lines: lines.length, outline: lines.join('\\n') };
  }
  const node = el || document.documentElement;
  const html = node ? node.outerHTML : '';
  return { ...meta, found: true, length: html.length, truncated: html.length > ${max}, html: html.slice(0, ${max}) };
})()`
}

/** 读 DOM：html / text / outline / attrs / rect。 */
export async function readDom(page, opts = {}) {
  const expression = buildDomExpression(opts.selector || '', opts.mode || 'html', opts.depth, opts.maxChars)
  const result = await evaluateRaw(page, expression, { awaitPromise: false, timeoutMs: 20000 })
  const value = resultValue(result)
  if (!value.ok) throw new Error(value.error)
  return value.value
}

/* ------------------------------------------------------------------ *
 * 网络
 * ------------------------------------------------------------------ */

/** 历史请求：PerformanceResourceTiming（页面加载至今，无需实时抓包）。 */
export async function networkHistory(page, opts = {}) {
  const limit = clamp(opts.limit, 1, 1000, 100)
  const expression = `(() => {
  const entries = performance.getEntriesByType('resource').map((entry) => ({
    url: entry.name,
    type: entry.initiatorType || '',
    duration: Math.round(entry.duration),
    transferSize: entry.transferSize || 0,
    encodedBodySize: entry.encodedBodySize || 0,
    status: entry.responseStatus || 0,
    start: Math.round(entry.startTime),
  }));
  const nav = performance.getEntriesByType('navigation')[0];
  return {
    url: location.href,
    title: document.title,
    entries,
    navigation: nav ? { url: nav.name, duration: Math.round(nav.duration), domContentLoaded: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd) } : null,
  };
})()`
  const result = await evaluateRaw(page, expression, { awaitPromise: false })
  const value = resultValue(result)
  if (!value.ok) throw new Error(value.error)
  const data = value.value || {}
  const keyword = String(opts.filter || '').trim().toLowerCase()
  let entries = Array.isArray(data.entries) ? data.entries : []
  if (keyword) entries = entries.filter((entry) => String(entry.url).toLowerCase().includes(keyword))
  const total = entries.length
  entries = entries.slice(-limit)
  return { page: { title: page.title, url: page.url }, entries, total, shown: entries.length, navigation: data.navigation || null }
}

/** 实时抓包：Network 域，抓 waitMs 内的请求（可选先 reload）。 */
export async function captureNetwork(page, opts = {}) {
  const waitMs = clamp(opts.waitMs, 200, 60000, 2500)
  const limit = clamp(opts.limit, 1, 1000, 100)
  const session = new CdpSession(page.ws, { timeoutMs: waitMs + 30000 })
  await session.connect()
  const requests = new Map()
  try {
    session.on('Network.requestWillBeSent', (params) => {
      const request = params.request || {}
      // Network.timestamp 是单调时钟（秒），不是 epoch：时长必须用两个 timestamp 相减
      const startTs = Number(params.timestamp)
      requests.set(params.requestId, {
        id: params.requestId,
        url: String(request.url || ''),
        method: String(request.method || 'GET'),
        type: String(params.type || ''),
        startTs: Number.isFinite(startTs) ? startTs : Date.now() / 1000,
        duration: -1,
        status: 0,
        mimeType: '',
        encodedLength: 0,
        failed: '',
      })
    })
    session.on('Network.responseReceived', (params) => {
      const record = requests.get(params.requestId)
      if (!record) return
      const response = params.response || {}
      record.status = Number(response.status) || 0
      record.mimeType = String(response.mimeType || '')
      record.type = record.type || String(params.type || '')
    })
    session.on('Network.loadingFinished', (params) => {
      const record = requests.get(params.requestId)
      if (!record) return
      record.encodedLength = Number(params.encodedDataLength) || 0
      const endTs = Number(params.timestamp)
      record.duration = Number.isFinite(endTs)
        ? Math.max(0, Math.round((endTs - record.startTs) * 1000))
        : Math.round(Date.now() - record.startTs * 1000)
    })
    session.on('Network.loadingFailed', (params) => {
      const record = requests.get(params.requestId)
      if (!record) return
      record.failed = String(params.errorText || 'failed')
      const endTs = Number(params.timestamp)
      record.duration = Number.isFinite(endTs)
        ? Math.max(0, Math.round((endTs - record.startTs) * 1000))
        : Math.round(Date.now() - record.startTs * 1000)
    })
    await session.send('Network.enable', {
      maxTotalBufferSize: 50000000,
      maxResourceBufferSize: 10000000,
      maxPostDataSize: 5000000,
    })
    if (opts.reload) {
      const loaded = new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.min(waitMs, 20000))
        session.on('Page.loadEventFired', () => { clearTimeout(timer); resolve() })
      })
      await session.send('Page.enable').catch(() => {})
      await session.send('Page.reload', { ignoreCache: false })
      await loaded
      await sleep(500)
    } else {
      await sleep(waitMs)
    }
  } finally {
    await session.close()
  }
  const keyword = String(opts.filter || '').trim().toLowerCase()
  let list = Array.from(requests.values()).filter((record) => record.url && !record.url.startsWith('data:'))
  if (keyword) list = list.filter((record) => record.url.toLowerCase().includes(keyword))
  list.sort((a, b) => a.startTs - b.startTs)
  const total = list.length
  list = list.slice(-limit)
  return { page: { title: page.title, url: page.url }, requests: list, total, shown: list.length }
}

/* ------------------------------------------------------------------ *
 * 截图
 * ------------------------------------------------------------------ */

/** 截图，返回 PNG/JPEG Buffer。 */
export async function captureScreenshot(page, opts = {}) {
  const fullPage = Boolean(opts.fullPage)
  const format = opts.format === 'jpeg' ? 'jpeg' : 'png'
  return withPage(page, async (session) => {
    const params = { format }
    if (format === 'jpeg') params.quality = clamp(opts.quality, 1, 100, 80)
    if (fullPage) {
      const metrics = await session.send('Page.getLayoutMetrics')
      const size = metrics.cssContentSize || metrics.contentSize || { width: 1280, height: 800 }
      const width = Math.max(1, Math.min(4096, Math.ceil(size.width)))
      const height = Math.max(1, Math.min(12000, Math.ceil(size.height)))
      params.clip = { x: 0, y: 0, width, height, scale: 1 }
      params.captureBeyondViewport = true
    }
    if (opts.fromSurface !== undefined) params.fromSurface = Boolean(opts.fromSurface)
    const result = await session.send('Page.captureScreenshot', params, 60000)
    return { buffer: Buffer.from(result.data, 'base64'), format }
  })
}

/* ------------------------------------------------------------------ *
 * 页面打开 / 导航
 * ------------------------------------------------------------------ */

function waitForLoad(session, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { off(); resolve(false) }, timeoutMs)
    const off = session.on('Page.loadEventFired', () => { clearTimeout(timer); off(); resolve(true) })
  })
}

async function waitReady(session, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const result = await session.send('Runtime.evaluate', {
        expression: `({ url: location.href, title: document.title, readyState: document.readyState })`,
        returnByValue: true,
      }, 8000)
      const value = resultValue(result)
      if (value.ok && value.value && value.value.readyState === 'complete') return value.value
    } catch { /* 页面可能正在导航，重试 */ }
    await sleep(200)
  }
  return null
}

/** 新建标签页打开 URL，并等页面加载完成。 */
export async function openNewTab(port, url, timeoutMs = 30000) {
  const info = await cdpVersion(port)
  if (!info.alive) throw new Error(`CDP 端口 ${port} 离线`)
  const session = new CdpSession(info.wsUrl, { timeoutMs })
  await session.connect()
  let targetId = ''
  try {
    const created = await session.send('Target.createTarget', { url: String(url) })
    targetId = created.targetId
  } finally {
    await session.close()
  }
  const deadline = Date.now() + 20000
  let page = null
  while (Date.now() < deadline) {
    await sleep(200)
    const pages = await listPages(port)
    page = pages.find((candidate) => candidate.id === targetId)
    if (page) break
  }
  if (!page) throw new Error('新标签页没有出现在 CDP 页面列表里')
  try {
    await withPage(page, async (pageSession) => {
      await pageSession.send('Page.enable', {}, 5000)
      const loaded = waitForLoad(pageSession, timeoutMs)
      await waitReady(pageSession, timeoutMs)
      await loaded
    }, timeoutMs + 5000)
  } catch { /* 加载没等全也不影响读取 */ }
  const pages = await listPages(port)
  return pages.find((candidate) => candidate.id === targetId) || page
}

/** 让现有页面导航到 URL。 */
export async function navigatePage(port, page, url, timeoutMs = 30000) {
  await withPage(page, async (session) => {
    await session.send('Page.enable', {}, 5000)
    const loaded = waitForLoad(session, timeoutMs)
    await session.send('Page.navigate', { url: String(url) }, 10000)
    await loaded
    await waitReady(session, timeoutMs)
  }, timeoutMs + 5000)
  const pages = await listPages(port)
  return pages.find((candidate) => candidate.id === page.id) || page
}

/** 关闭带调试端口的浏览器（测试清理 / 用户想收掉 agent 开的窗口时用）。 */
export async function closeBrowser(port) {
  const info = await cdpVersion(port)
  if (!info.alive) return false
  const session = new CdpSession(info.wsUrl, { timeoutMs: 5000 })
  try {
    await session.connect()
    await session.send('Browser.close', {}, 5000)
    return true
  } catch {
    return false
  } finally {
    await session.close()
  }
}

/* ------------------------------------------------------------------ *
 * 页面理解（概览 / 元素定位 / 存储）
 * ------------------------------------------------------------------ */

/** 页面概览：用途、内容、功能、框架、表单、按钮、链接、表格、正文摘录。 */
export async function readSummary(page) {
  return runPageScript(page, 'summary')
}

/** 元素定位：按 selector / text / tag 找元素，返回可直接写进脚本的定位器。 */
export async function readFind(page, args = {}) {
  return runPageScript(page, 'find', args)
}

/** 本地存储 / Cookie。 */
export async function readStorage(page, args = {}) {
  return runPageScript(page, 'storage', args)
}

/* ------------------------------------------------------------------ *
 * 页面侧记录器：「刚刚又干了什么」
 * ------------------------------------------------------------------ */

/** 注入记录器（已存在则直接复用）。 */
export async function ensureRecorder(page) {
  try {
    const value = await runPageScript(page, 'recorder')
    return {
      ok: true,
      existed: Boolean(value && value.existed),
      startedAt: Number(value && value.startedAt) || 0,
    }
  } catch (error) {
    return { ok: false, existed: false, startedAt: 0, error: String(error?.message || error) }
  }
}

/** 读记录器当前缓冲的事件。 */
export async function readRecorder(page) {
  const result = await evaluateRaw(page, `(() => {
  const recorder = window.__dshRecorder;
  if (!recorder) return null;
  return { startedAt: recorder.startedAt, paused: !!recorder.paused, events: recorder.events.slice(-1500) };
})()`, { awaitPromise: false })
  const value = resultValue(result)
  if (!value.ok) throw new Error(value.error)
  return value.value
}

/** 暂停 / 清空记录器。 */
export async function controlRecorder(page, action) {
  const source = action === 'stop'
    ? `(() => {
  const recorder = window.__dshRecorder;
  if (!recorder) return { ok: false, error: '记录器还没启动' };
  recorder.paused = true;
  return { ok: true, paused: true };
})()`
    : `(() => {
  const recorder = window.__dshRecorder;
  if (!recorder) return { ok: false, error: '记录器还没启动' };
  recorder.events.length = 0;
  recorder.startedAt = Date.now();
  recorder.paused = false;
  return { ok: true, cleared: true };
})()`
  const result = await evaluateRaw(page, source, { awaitPromise: false })
  return resultValue(result)
}

/** 时间线：记录器事件（点击/输入/请求/DOM 变化/跳转）+ 控制台日志。 */
export async function readActivity(page, opts = {}) {
  const limit = clamp(opts.limit, 1, 500, 200)
  const sinceMs = clamp(opts.sinceMs, 0, 86400000, 300000)
  const cutoff = Date.now() - sinceMs
  const events = []

  let recorder = null
  try {
    recorder = await readRecorder(page)
  } catch { /* 页面可能正在跳转 */ }
  if (recorder && Array.isArray(recorder.events)) {
    for (const event of recorder.events) {
      if (Number(event.ts) >= cutoff) events.push({ ...event })
    }
  }

  if (opts.includeConsole !== false) {
    try {
      const consoleResult = await readConsole(page, { waitMs: 0, limit: 400 })
      for (const message of consoleResult.messages) {
        if (message.ts >= cutoff) {
          events.push({
            kind: 'console',
            level: message.level,
            text: message.text,
            url: message.url || '',
            line: message.line,
            ts: message.ts,
          })
        }
      }
    } catch { /* 控制台读失败不影响时间线 */ }
  }

  events.sort((a, b) => Number(a.ts) - Number(b.ts))
  const total = events.length
  const sliced = events.slice(-limit)
  return {
    page: { title: page.title, url: page.url },
    recorder: recorder
      ? { startedAt: Number(recorder.startedAt) || 0, paused: Boolean(recorder.paused), total: recorder.events.length }
      : null,
    events: sliced,
    total,
    shown: sliced.length,
  }
}

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */

const MIME_EXTENSIONS = {
  'text/csv': 'csv',
  'text/plain': 'txt',
  'text/html': 'html',
  'application/json': 'json',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/octet-stream': 'bin',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
}

function sanitizeFilename(name) {
  const cleaned = String(name || '');
  const base = cleaned.replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/^\.+/, '').trim()
  return base || 'download-' + Date.now()
}

function uniquePath(dir, filename) {
  const parsed = path.parse(filename)
  let candidate = path.join(dir, filename)
  let index = 1
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${parsed.name} (${index})${parsed.ext}`)
    index += 1
  }
  return candidate
}

function parseContentDisposition(header) {
  const value = String(header || '')
  if (!value) return ''
  const utf8 = value.match(/filename\*=UTF-8''([^;]+)/i)
  if (utf8) {
    try { return decodeURIComponent(utf8[1].trim()) } catch { /* ignore */ }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)
  if (plain) return plain[1].trim()
  return ''
}

function guessFilename(url, contentType) {
  try {
    const parsed = new URL(url)
    const last = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '')
    if (last) return last
  } catch { /* ignore */ }
  const extension = MIME_EXTENSIONS[String(contentType || '').split(';')[0].trim()] || 'bin'
  return 'download-' + Date.now() + '.' + extension
}

async function withBrowserSession(port, fn, timeoutMs = 180000) {
  const info = await cdpVersion(port)
  if (!info.alive) throw new Error(`CDP 端口 ${port} 离线`)
  const session = new CdpSession(info.wsUrl, { timeoutMs })
  await session.connect()
  try {
    return await fn(session)
  } finally {
    await session.close()
  }
}

function snapshotDir(dir) {
  const snapshot = new Map()
  try {
    for (const name of fs.readdirSync(dir)) {
      try {
        const stat = fs.statSync(path.join(dir, name))
        snapshot.set(name, { size: stat.size, mtimeMs: stat.mtimeMs })
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
  return snapshot
}

/** 等目录里出现一个「新的（或刚被重写的）、非 .crdownload、大小稳定」的文件。 */
async function waitNewFile(dir, before, startedAt, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastCandidate = ''
  let stableCount = 0
  while (Date.now() < deadline) {
    let names = []
    try { names = fs.readdirSync(dir) } catch { names = [] }
    const candidates = []
    for (const name of names) {
      if (name.endsWith('.crdownload') || name.endsWith('.tmp')) continue
      const previous = before.get(name)
      const file = path.join(dir, name)
      try {
        const stat = fs.statSync(file)
        if (!previous || stat.mtimeMs >= startedAt - 1000 || stat.size !== previous.size) candidates.push({ name, mtimeMs: stat.mtimeMs })
      } catch { /* ignore */ }
    }
    candidates.sort((a, b) => a.mtimeMs - b.mtimeMs)
    const candidate = candidates.length ? candidates[candidates.length - 1].name : ''
    if (candidate && candidate === lastCandidate) {
      stableCount += 1
      if (stableCount >= 2) {
        const file = path.join(dir, candidate)
        try {
          if (fs.statSync(file).size > 0) return file
        } catch { /* ignore */ }
      }
    } else {
      lastCandidate = candidate
      stableCount = 0
    }
    await sleep(200)
  }
  return ''
}

/** 打开浏览器下载通道，执行 trigger，等下载完成。返回 {file, filename, bytes} 或 null。 */
async function runBrowserDownload(port, dir, trigger, timeoutMs) {
  fs.mkdirSync(dir, { recursive: true })
  const before = snapshotDir(dir)
  const startedAt = Date.now()
  return withBrowserSession(port, async (session) => {
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: dir,
      eventsEnabled: true,
    }, 10000)
    const downloads = []
    session.on('Browser.downloadWillBegin', (params) => {
      downloads.push({ guid: params.guid, filename: params.suggestedFilename || '', url: params.url || '', state: 'inProgress', bytes: 0 })
    })
    session.on('Browser.downloadProgress', (params) => {
      const record = downloads.find((item) => item.guid === params.guid)
      if (record) {
        record.state = params.state
        record.bytes = Number(params.receivedBytes) || record.bytes
      } else {
        downloads.push({ guid: params.guid, filename: '', state: params.state, bytes: Number(params.receivedBytes) || 0 })
      }
    })
    await trigger(session)
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const completed = downloads.find((item) => item.state === 'completed')
      if (completed) {
        const file = await waitNewFile(dir, before, startedAt, 8000)
        if (!file) {
          let listing = ''
          try { listing = fs.readdirSync(dir).join(', ') } catch { listing = '(目录读不了)' }
          throw new Error('下载完成但没在目标目录找到文件；目录内容：' + (listing || '(空)'))
        }
        return { file, filename: path.basename(file), bytes: completed.bytes || 0, mode: 'browser' }
      }
      const canceled = downloads.find((item) => item.state === 'canceled')
      if (canceled) throw new Error('浏览器取消了下载（可能被安全策略拦截）')
      await sleep(150)
    }
    const file = await waitNewFile(dir, before, startedAt, 1500)
    return file ? { file, filename: path.basename(file), bytes: 0, mode: 'browser' } : null
  }, timeoutMs + 30000)
}

/** 取浏览器里对目标 URL 生效的 cookie（节点侧 fetch 用）。 */
async function cookiesForUrl(port, url) {
  try {
    const parsed = new URL(url)
    const host = parsed.hostname
    return await withBrowserSession(port, async (session) => {
      const result = await session.send('Storage.getCookies', {}, 8000)
      return (result.cookies || []).filter((cookie) => {
        const domain = String(cookie.domain || '').replace(/^\./, '')
        return domain && (host === domain || host.endsWith('.' + domain))
      })
    }, 15000)
  } catch {
    return []
  }
}

/** 直接下载一个 URL：先用浏览器 cookie 走 Node fetch；不行再退回浏览器下载事件。 */
export async function downloadUrl(port, page, url, dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const timeoutMs = clamp(opts.timeoutMs, 5000, 600000, 120000)
  const target = String(url || '').trim()
  if (!target) throw new Error('url 不能为空')
  const fallback = async (reason) => {
    const result = await runBrowserDownload(port, dir, (session) => session.send('Target.createTarget', { url: target }), Math.min(timeoutMs, 45000))
    if (result) return result
    throw new Error(reason || '没有触发下载：这个 URL 可能直接在页面里打开了（用 devtools_screenshot 看，或改用 selector 点页面上的下载按钮）')
  }

  const cookies = await cookiesForUrl(port, target)
  const headers = {}
  if (cookies.length) headers.cookie = cookies.map((cookie) => cookie.name + '=' + cookie.value).join('; ')
  if (opts.userAgent) headers['user-agent'] = opts.userAgent
  if (opts.referer) headers.referer = opts.referer
  let response = null
  try {
    response = await fetch(target, { headers, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    response = null
  }
  if (response && response.ok) {
    const buffer = Buffer.from(await response.arrayBuffer())
    const contentType = response.headers.get('content-type') || ''
    const disposition = response.headers.get('content-disposition') || ''
    const filename = sanitizeFilename(parseContentDisposition(disposition) || guessFilename(target, contentType))
    const file = uniquePath(dir, filename)
    fs.writeFileSync(file, buffer)
    return { file, filename: path.basename(file), bytes: buffer.length, contentType, mode: 'fetch' }
  }
  return fallback(response ? `HTTP ${response.status}，且浏览器没有触发下载` : '节点侧请求失败，且浏览器没有触发下载')
}

/** 点击页面上某个元素触发的下载（导出按钮 / a[download] / blob 下载）。 */
export async function downloadByClick(port, page, selector, dir, opts = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const timeoutMs = clamp(opts.timeoutMs, 5000, 600000, 120000)
  const sel = String(selector || '').trim()
  if (!sel) throw new Error('selector 不能为空')
  const result = await runBrowserDownload(port, dir, async () => {
    const click = await evaluate(page, `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { ok: false, error: '找不到元素：' + ${JSON.stringify(sel)} };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.click();
  return { ok: true, tag: el.tagName.toLowerCase(), text: (el.innerText || el.value || '').slice(0, 80) };
})()`, { awaitPromise: false })
    if (!click.ok) throw new Error(click.error || '点击失败')
    return click
  }, timeoutMs)
  if (!result) {
    throw new Error('点击后没有触发下载（可能是页面跳转/弹窗，或下载需要用户手势）。可以先用 devtools_activity 看看点了之后发生了什么。')
  }
  return result
}
