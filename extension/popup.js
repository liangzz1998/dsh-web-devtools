/* DSH Web DevTools Bridge —— popup 逻辑：只跟本地 hub 的 HTTP 接口打交道 */

const DEFAULT_HUB_PORT = 9335

const $ = (id) => document.getElementById(id)

let hubPort = DEFAULT_HUB_PORT

async function loadPort() {
  const stored = await chrome.storage.local.get({ hubPort: DEFAULT_HUB_PORT })
  hubPort = Number(stored.hubPort) > 0 ? Number(stored.hubPort) : DEFAULT_HUB_PORT
  $('portInput').value = hubPort
}

async function getCurrentTab() {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tabs && tabs[0]
}

async function hubFetch(path, options) {
  const response = await fetch(`http://127.0.0.1:${hubPort}${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options && options.headers) },
    signal: AbortSignal.timeout(4000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`)
  return data
}

function renderStatus(status) {
  const hubDot = $('hubDot')
  const hubText = $('hubText')
  if (!status) {
    hubDot.className = 'dot bad'
    hubText.textContent = 'hub 未运行 —— 先在 DSH 里调用 devtools_live_status 启动'
    $('attachBtn').disabled = true
  } else if (!status.extensionConnected) {
    hubDot.className = 'dot ok'
    hubText.textContent = 'hub 在线，正在重连扩展…'
    $('attachBtn').disabled = false
  } else {
    hubDot.className = 'dot ok'
    hubText.textContent = `hub 在线 · 扩展已连接${status.version ? '（hub ' + status.version + '）' : ''}`
    $('attachBtn').disabled = false
  }

  const attached = (status && status.attached) || []
  $('attached').textContent = attached.length
    ? attached.map((item) => `#${item.tabId} ${item.title || item.url}`).join('\n')
    : '—'
  $('detachBtn').disabled = attached.length === 0
}

async function refresh() {
  const tab = await getCurrentTab()
  $('tabTitle').textContent = (tab && tab.title) || '—'
  $('tabUrl').textContent = (tab && tab.url) || ''
  try {
    const status = await hubFetch('/status')
    renderStatus(status)
  } catch {
    renderStatus(null)
  }
}

$('attachBtn').addEventListener('click', async () => {
  $('attachBtn').disabled = true
  try {
    const result = await hubFetch('/attach', { method: 'POST', body: '{}' })
    renderStatus(await hubFetch('/status'))
    $('hubText').textContent = `已接入：${result.title || result.url}（标签页 #${result.tabId}）`
  } catch (error) {
    $('hubText').textContent = '接入失败：' + (error.message || error)
    $('attachBtn').disabled = false
  }
})

$('detachBtn').addEventListener('click', async () => {
  try {
    await hubFetch('/detach', { method: 'POST', body: '{}' })
    await refresh()
  } catch (error) {
    $('hubText').textContent = '断开失败：' + (error.message || error)
  }
})

$('savePort').addEventListener('click', async () => {
  const value = Number($('portInput').value)
  if (!(value > 0 && value < 65536)) return
  hubPort = value
  await chrome.storage.local.set({ hubPort: value })
  chrome.runtime.sendMessage({ type: 'reconnect' }).catch(() => {})
  await refresh()
})

loadPort().then(refresh)
