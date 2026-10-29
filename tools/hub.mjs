#!/usr/bin/env node
/**
 * dsh-web-devtools 的「扩展桥」hub。
 *
 * 它解决的是插件原本做不到的事：读取用户**当前正在浏览**的标签页（而不是插件
 * 自己拉起的专用浏览器实例）。做法：
 *
 *   浏览器扩展（chrome.debugger = F12 同款 CDP）
 *        │  WebSocket  ws://127.0.0.1:9335/ext
 *        ▼
 *      hub（本文件）—— 把扩展的 CDP 会话代理成标准 CDP WebSocket
 *        │  WebSocket  ws://127.0.0.1:9335/cdp?tab=<tabId>
 *        ▼
 *   DSH 插件（lib/cdp.mjs 原样复用：Runtime/Page/DOM/Network 全部可用）
 *
 * 另外提供 HTTP 管理接口：GET /status、POST /attach、POST /detach。
 * 状态会写到 ~/.dsh/web-devtools/live.json，供插件工具读取。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWsServer } from './ws.mjs'

const HUB_VERSION = '0.3.0'
const DEFAULT_PORT = 9335
const DEFAULT_AUTO_DETACH_MS = 10 * 60 * 1000

const argv = parseArgs(process.argv.slice(2))
const PORT = toInt(argv.port, toInt(process.env.DSH_WEB_DEVTOOLS_HUB_PORT, DEFAULT_PORT))
const AUTO_DETACH_MS = toInt(argv['auto-detach-ms'], DEFAULT_AUTO_DETACH_MS)
const STATE_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'web-devtools')
const STATE_FILE = path.join(STATE_DIR, 'live.json')

const state = {
  port: PORT,
  startedAt: Date.now(),
  extension: null,
  attached: new Map(),
  tabConnections: new Map(),
}

const pending = new Map()
let callSeq = 0

class HubError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function toInt(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function parseArgs(list) {
  const out = {}
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]
    if (!item.startsWith('--')) continue
    const body = item.slice(2)
    const eq = body.indexOf('=')
    if (eq >= 0) out[body.slice(0, eq)] = body.slice(eq + 1)
    else if (index + 1 < list.length && !list[index + 1].startsWith('--')) out[body] = list[++index]
    else out[body] = true
  }
  return out
}

function log(message) {
  console.log(`[hub ${new Date().toISOString()}] ${message}`)
}

function writeState() {
  const data = {
    service: 'dsh-web-devtools-hub',
    hubPort: PORT,
    hubVersion: HUB_VERSION,
    extensionConnected: Boolean(state.extension),
    extension: state.extension
      ? { version: state.extension.version, browser: state.extension.browser, connectedAt: state.extension.connectedAt, tabs: state.extension.tabs }
      : null,
    tabs: state.extension ? state.extension.tabs : [],
    attached: [...state.attached.entries()].map(([tabId, item]) => ({
      tabId: Number(tabId),
      title: item.title,
      url: item.url,
      attachedAt: item.attachedAt,
      idleMs: Date.now() - item.lastActivity,
    })),
    updatedAt: new Date().toISOString(),
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2))
  } catch { /* 状态写不了不影响服务 */ }
}

function statusPayload() {
  return {
    service: 'dsh-web-devtools-hub',
    version: HUB_VERSION,
    hubPort: PORT,
    extensionConnected: Boolean(state.extension),
    extension: state.extension
      ? {
        version: state.extension.version,
        browser: state.extension.browser,
        connectedAt: state.extension.connectedAt,
        tabs: state.extension.tabs,
      }
      : null,
    attached: [...state.attached.entries()].map(([tabId, item]) => ({
      tabId: Number(tabId),
      title: item.title,
      url: item.url,
      attachedAt: item.attachedAt,
      idleMs: Date.now() - item.lastActivity,
    })),
    startedAt: state.startedAt,
  }
}

/** 向扩展发一条命令并等响应。 */
function callExtension(method, params = {}, tabId, timeoutMs = 60000) {
  if (!state.extension) {
    return Promise.reject(new HubError(409, 'extension-offline', '扩展未连接：请在浏览器里点开「DSH Web DevTools Bridge」扩展并点「连接 DSH」'))
  }
  const id = 'c' + (++callSeq)
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new HubError(504, 'extension-timeout', `等待扩展响应超时（${method}）`))
    }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
    state.extension.conn.send({
      type: 'call',
      id,
      method,
      tabId: tabId === undefined || tabId === null || tabId === '' ? undefined : Number(tabId),
      params,
    })
  })
}

function broadcastEvent(tabId, method, params) {
  const key = String(tabId)
  const connections = state.tabConnections.get(key)
  if (connections) {
    for (const conn of connections) conn.send({ method, params })
  }
  const record = state.attached.get(key)
  if (record) record.lastActivity = Date.now()
}

async function attachTab(tabId) {
  if (!state.extension) {
    throw new HubError(409, 'extension-offline', '扩展未连接：请在浏览器里点开「DSH Web DevTools Bridge」扩展并点「连接 DSH」')
  }
  const result = await callExtension('DSH.attach', tabId ? { tabId: Number(tabId) } : {}, tabId, 20000)
  const key = String(result.tabId)
  state.attached.set(key, {
    title: result.title || '',
    url: result.url || '',
    attachedAt: Date.now(),
    lastActivity: Date.now(),
  })
  writeState()
  log(`attached tab ${key} (${result.title || result.url})`)
  return {
    ok: true,
    tabId: Number(result.tabId),
    title: result.title || '',
    url: result.url || '',
    cdpUrl: `ws://127.0.0.1:${PORT}/cdp?tab=${encodeURIComponent(key)}`,
  }
}

async function detachTab(tabId) {
  const ids = tabId ? [String(tabId)] : [...state.attached.keys()]
  const detached = []
  for (const id of ids) {
    try {
      await callExtension('DSH.detach', { tabId: Number(id) }, Number(id), 10000)
    } catch { /* 扩展可能已经断开 */ }
    state.attached.delete(id)
    detached.push(Number(id))
  }
  writeState()
  return { ok: true, detached }
}

/** 扩展连接：接收事件、响应、hello/tabs。 */
function handleExtension(conn) {
  if (state.extension) {
    try { state.extension.conn.close() } catch { /* ignore */ }
  }
  const record = { conn, connectedAt: Date.now(), version: '', browser: '', tabs: [] }
  state.extension = record
  log('extension connected')

  conn.onMessage((raw) => {
    let message
    try { message = JSON.parse(raw) } catch { return }
    switch (message.type) {
      case 'hello':
        record.version = String(message.version || '')
        record.browser = String(message.browser || '')
        record.tabs = Array.isArray(message.tabs) ? message.tabs : []
        writeState()
        break
      case 'tabs':
        record.tabs = Array.isArray(message.tabs) ? message.tabs : []
        writeState()
        break
      case 'response': {
        const waiter = pending.get(message.id)
        if (!waiter) break
        clearTimeout(waiter.timer)
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(String(message.error)))
        else waiter.resolve(message.result)
        break
      }
      case 'event':
        broadcastEvent(message.tabId, message.method, message.params)
        break
      case 'detached':
        state.attached.delete(String(message.tabId))
        writeState()
        log(`extension detached tab ${message.tabId} (${message.reason || ''})`)
        break
      case 'pong':
        break
      default:
        break
    }
  })

  conn.onClose(() => {
    if (!state.extension || state.extension.conn !== conn) return
    log('extension disconnected')
    state.extension = null
    for (const connections of state.tabConnections.values()) {
      for (const cdpConn of connections) {
        cdpConn.send({ method: 'DSH.detached', params: { reason: 'extension-disconnected' } })
      }
    }
    state.tabConnections.clear()
    state.attached.clear()
    writeState()
  })

  conn.send({ type: 'hub-hello', version: HUB_VERSION, port: PORT })
  const heartbeat = setInterval(() => {
    if (conn.closed) { clearInterval(heartbeat); return }
    conn.send({ type: 'ping' })
  }, 20000)
  heartbeat.unref?.()
  writeState()
}

/** DSH 侧 CDP 连接：{id, method, params} → 扩展 → {id, result|error}。 */
function handleCdpConnection(conn, tabId) {
  const key = String(tabId || '')
  if (key) {
    if (!state.tabConnections.has(key)) state.tabConnections.set(key, new Set())
    state.tabConnections.get(key).add(conn)
  }
  conn.onClose(() => {
    if (!key) return
    const connections = state.tabConnections.get(key)
    if (!connections) return
    connections.delete(conn)
    if (!connections.size) state.tabConnections.delete(key)
  })

  conn.onMessage(async (raw) => {
    let message
    try { message = JSON.parse(raw) } catch { return }
    if (message.id === undefined) return
    const id = message.id
    const method = String(message.method || '')
    const params = message.params && typeof message.params === 'object' ? message.params : {}
    const targetTab = String(params.tabId || key || '')
    if (method === 'DSH.ping') {
      conn.send({ id, result: { ok: true } })
      return
    }
    try {
      if (!targetTab) throw new HubError(400, 'no-tab', '没有指定 tab：请先调用 devtools_live_attach')
      const result = await callExtension(method, params, targetTab, method === 'Page.captureScreenshot' ? 90000 : 60000)
      const record = state.attached.get(targetTab)
      if (record) record.lastActivity = Date.now()
      conn.send({ id, result: result === undefined || result === null ? {} : result })
    } catch (error) {
      conn.send({
        id,
        error: { code: -32000, message: String((error && error.message) || error) },
      })
    }
  })
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); request.destroy(); return }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (!chunks.length) return resolve({})
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve({}) }
    })
    request.on('error', reject)
  })
}

function route(request, response) {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`)
  const send = (status, data) => {
    const body = JSON.stringify(data)
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    })
    response.end(body)
  }
  ;(async () => {
    try {
      if (request.method === 'GET' && url.pathname === '/status') return send(200, statusPayload())
      if (request.method === 'GET' && url.pathname === '/health') return send(200, { ok: true, service: 'dsh-web-devtools-hub' })
      if (request.method === 'POST' && url.pathname === '/attach') {
        const body = await readJsonBody(request)
        return send(200, await attachTab(body.tabId))
      }
      if (request.method === 'POST' && url.pathname === '/detach') {
        const body = await readJsonBody(request)
        return send(200, await detachTab(body.tabId))
      }
      send(404, { error: 'not-found', path: url.pathname })
    } catch (error) {
      send(error instanceof HubError ? error.status : 500, {
        error: (error && error.code) || 'internal',
        message: String((error && error.message) || error),
      })
    }
  })()
}

// 端口已被自己占用时直接退出（供插件「确保 hub 在跑」复用）
async function alreadyRunning() {
  try {
    const data = await fetch(`http://127.0.0.1:${PORT}/status`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json())
    return data && data.service === 'dsh-web-devtools-hub'
  } catch {
    return false
  }
}

if (await alreadyRunning()) {
  log(`hub 已在 127.0.0.1:${PORT} 运行，本次启动退出`)
  process.exit(0)
}

const server = createWsServer((conn, request) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname === '/ext') {
    handleExtension(conn)
    return
  }
  if (url.pathname === '/cdp') {
    const tabId = url.searchParams.get('tab') || ''
    handleCdpConnection(conn, tabId)
    return
  }
  conn.close()
})
server.on('request', route)

// 空闲自动断开：用户忘了点取消调试黄条时，10 分钟后自动 detach
const autoDetachTimer = setInterval(() => {
  const now = Date.now()
  for (const [tabId, record] of state.attached) {
    if (now - record.lastActivity > AUTO_DETACH_MS) {
      log(`tab ${tabId} 空闲超过 ${Math.round(AUTO_DETACH_MS / 60000)} 分钟，自动 detach`)
      void detachTab(tabId)
    }
  }
}, 60000)
autoDetachTimer.unref?.()

server.listen(PORT, '127.0.0.1', () => {
  log(`listening ws://127.0.0.1:${PORT}（扩展连 /ext，DSH 连 /cdp?tab=…）`)
  writeState()
})

process.on('SIGINT', () => { writeState(); process.exit(0) })
process.on('SIGTERM', () => { writeState(); process.exit(0) })
