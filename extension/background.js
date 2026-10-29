/**
 * DSH Web DevTools Bridge —— 扩展后台。
 *
 * 做的事很简单：连上本地 hub（ws://127.0.0.1:9335/ext），把 hub 发来的
 * CDP 命令交给 chrome.debugger 执行（chrome.debugger 就是 F12 用的那套
 * DevTools 协议），再把页面侧事件原样回传。
 *
 * 注意：
 * - 一个标签页同一时刻只能被一个调试器占用：该标签开着 F12 时 attach 会失败。
 * - attach 期间标签页顶部会出现「正在调试此标签页」黄条，可在扩展 popup 里断开。
 * - MV3 service worker 会被浏览器回收；WebSocket 消息会续命，另加 alarm 兜底重连。
 */

const DEFAULT_HUB_PORT = 9335
const RECONNECT_DELAY_MS = 2500

let socket = null
let connecting = false
let reconnectTimer = null

async function getHubPort() {
  try {
    const { hubPort } = await chrome.storage.local.get({ hubPort: DEFAULT_HUB_PORT })
    return Number(hubPort) > 0 ? Number(hubPort) : DEFAULT_HUB_PORT
  } catch {
    return DEFAULT_HUB_PORT
  }
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(message))
    return true
  } catch {
    return false
  }
}

async function listTabs() {
  try {
    const tabs = await chrome.tabs.query({})
    return tabs.map((tab) => ({
      id: tab.id,
      title: tab.title || '',
      url: tab.url || '',
      active: Boolean(tab.active),
      windowId: tab.windowId,
    }))
  } catch {
    return []
  }
}

async function pushTabs() {
  send({ type: 'tabs', tabs: await listTabs() })
}

async function attachTarget(tabId) {
  let tab
  if (tabId) {
    tab = await chrome.tabs.get(Number(tabId))
  } else {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
    tab = tabs && tabs[0]
  }
  if (!tab || typeof tab.id !== 'number') {
    throw new Error('找不到活动标签页：请先切到要读取的网页，再点扩展图标')
  }
  try {
    await chrome.debugger.attach({ tabId: tab.id }, '1.3')
  } catch (error) {
    const message = String((error && error.message) || error)
    throw new Error('无法附加调试器：' + message + '（如果这个标签页开着 F12，请先关掉它，或换一个标签页）')
  }
  try { await chrome.storage.local.set({ lastTabId: tab.id }) } catch { /* ignore */ }
  await pushTabs()
  return { tabId: tab.id, title: tab.title || '', url: tab.url || '' }
}

async function detachTarget(tabId) {
  const id = Number(tabId) || (await chrome.storage.local.get({ lastTabId: null })).lastTabId
  if (!id) return { detached: false }
  try {
    await chrome.debugger.detach({ tabId: id })
    return { detached: true, tabId: id }
  } catch (error) {
    // 已经断了也当成功
    return { detached: false, tabId: id, error: String((error && error.message) || error) }
  }
}

async function handleCall(message) {
  const { id, method, tabId, params } = message
  try {
    let result
    if (method === 'DSH.attach') result = await attachTarget(params && params.tabId)
    else if (method === 'DSH.detach') result = await detachTarget(tabId || (params && params.tabId))
    else if (method === 'DSH.tabs') result = await listTabs()
    else if (method === 'DSH.ping') result = { ok: true }
    else {
      if (!tabId) throw new Error('没有指定 tabId：请先调用 devtools_live_attach')
      result = await chrome.debugger.sendCommand({ tabId: Number(tabId) }, method, params || {})
    }
    send({ type: 'response', id, result: result === undefined || result === null ? {} : result })
  } catch (error) {
    send({ type: 'response', id, error: String((error && error.message) || error) })
  }
}

async function connect() {
  if (connecting) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  connecting = true
  const port = await getHubPort()
  let ws
  try {
    ws = new WebSocket(`ws://127.0.0.1:${port}/ext`)
  } catch {
    connecting = false
    scheduleReconnect()
    return
  }
  socket = ws
  ws.addEventListener('open', async () => {
    connecting = false
    send({
      type: 'hello',
      version: chrome.runtime.getManifest().version,
      browser: navigator.userAgent,
      tabs: await listTabs(),
    })
    console.log('[dsh-bridge] 已连接 hub，端口', port)
  })
  ws.addEventListener('message', (event) => {
    let message
    try { message = JSON.parse(event.data) } catch { return }
    if (message.type === 'call') void handleCall(message)
    else if (message.type === 'ping') send({ type: 'pong' })
    else if (message.type === 'hub-hello') send({ type: 'hello', version: chrome.runtime.getManifest().version, browser: navigator.userAgent, tabs: [] })
  })
  ws.addEventListener('close', () => {
    connecting = false
    if (socket === ws) socket = null
    scheduleReconnect()
  })
  ws.addEventListener('error', () => {
    try { ws.close() } catch { /* ignore */ }
  })
}

function scheduleReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void connect()
  }, RECONNECT_DELAY_MS)
}

// 页面侧事件（console/network/DOM/Page 等）原样回传
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!source || typeof source.tabId !== 'number') return
  send({ type: 'event', tabId: source.tabId, method, params })
})

chrome.debugger.onDetach.addListener((source, reason) => {
  if (!source || typeof source.tabId !== 'number') return
  send({ type: 'detached', tabId: source.tabId, reason: String(reason || '') })
  void pushTabs()
})

chrome.runtime.onInstalled.addListener(() => {
  void connect()
  chrome.alarms.create('dsh-bridge-keepalive', { periodInMinutes: 1 })
})

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'dsh-bridge-keepalive') return
  if (!socket || socket.readyState !== WebSocket.OPEN) void connect()
})

// 手机/浏览器唤醒、popup 打开时都尝试连一下
chrome.runtime.onStartup.addListener(() => { void connect() })

// popup 改端口后要求重连
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'reconnect') return
  try { if (socket) socket.close() } catch { /* ignore */ }
  socket = null
  connecting = false
  setTimeout(() => { void connect() }, 100)
})

connect()
