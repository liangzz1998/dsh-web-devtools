#!/usr/bin/env node
/**
 * dsh-web-devtools 的 CDP 执行端：独立 node 子进程，从 stdin 收 JSON，
 * 往 stdout 打一行 JSON（{ok, text} 或 {ok:false, error}）。
 *
 * 为什么用子进程：DSH 宿主是 Electron 主进程，插件只做薄壳；真正连 CDP 的
 * 逻辑放在真 node 里跑（Node ≥ 22 自带 WebSocket），不依赖宿主 Node 版本。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as cdp from '../lib/cdp.mjs'
import * as live from '../lib/live.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function clamp(value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

function safeStringify(value, indent = 2) {
  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (key, val) => {
      if (typeof val === 'bigint') return String(val)
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[循环引用]'
        seen.add(val)
      }
      if (typeof val === 'undefined') return '[undefined]'
      if (typeof val === 'function') return '[function]'
      return val
    }, indent)
  } catch (error) {
    return String(value)
  }
}

function clip(text, max = 20000) {
  const source = String(text == null ? '' : text)
  if (source.length <= max) return { text: source, truncated: false, length: source.length }
  return { text: source.slice(0, max), truncated: true, length: source.length }
}

function shortUrl(url, max = 120) {
  const source = String(url || '')
  if (!source) return ''
  try {
    const parsed = new URL(source)
    const pathname = parsed.pathname + parsed.search
    const short = parsed.host + (pathname === '/' ? '' : pathname)
    return short.length > max ? short.slice(0, max) + '…' : short
  } catch {
    return source.length > max ? source.slice(0, max) + '…' : source
  }
}

function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n <= 0) return '0B'
  if (n < 1024) return n + 'B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + 'KB'
  return (n / 1024 / 1024).toFixed(1) + 'MB'
}

function levelTag(level) {
  return `[${String(level || 'log').padEnd(7)}]`
}

/** 解析页面：需要页面时自动确保浏览器在跑。 */
const STATE_DIR = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'web-devtools')

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(STATE_DIR, 'state.json'), 'utf8')) || {} } catch { return {} }
}

function writeState(patch) {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    const state = { ...readState(), ...patch, updatedAt: new Date().toISOString() }
    fs.writeFileSync(path.join(STATE_DIR, 'state.json'), JSON.stringify(state, null, 2))
  } catch { /* 记不住不影响功能 */ }
}

async function resolvePage(cfg, target) {
  const hubPort = clamp(cfg.hubPort, 1, 65535, live.DEFAULT_HUB_PORT)
  if (String(target || '').trim() === 'current') {
    return resolveLivePage(cfg, hubPort)
  }
  const port = clamp(cfg.cdpPort, 1, 65535, cdp.DEFAULT_PORT)
  const info = await cdp.ensureBrowser({ ...cfg, cdpPort: port })
  const pages = await cdp.listPages(port)
  let page = null
  if (target) {
    page = cdp.pickPage(pages, target)
  } else {
    // 没指定页面：优先上次用的页面 → 当前可见/聚焦的页面 → 最近打开的 http 页面
    const state = readState()
    if (state.lastPageId) page = pages.find((candidate) => candidate.id === state.lastPageId) || null
    if (!page) {
      const httpPages = pages.filter((candidate) => /^https?:/i.test(candidate.url))
      for (const candidate of httpPages.slice(-6)) {
        try {
          const probe = await cdp.evaluate(candidate, `({ visible: document.visibilityState, focused: document.hasFocus() })`, { awaitPromise: false })
          if (probe.ok && probe.value && (probe.value.visible === 'visible' || probe.value.focused)) {
            page = candidate
            break
          }
        } catch { /* 下一个 */ }
      }
    }
    if (!page) page = cdp.pickPage(pages, '')
  }
  writeState({ lastPageId: page.id, lastUrl: page.url, lastTitle: page.title })
  return { port, page, info, pages }
}

/**
 * target="current"：走扩展桥读用户当前浏览的标签页。
 * hub 没起就拉起来；扩展没连就给出明确提示；还没 attach 就自动 attach 当前活动标签。
 */
async function resolveLivePage(cfg, hubPort) {
  const status = await live.ensureHub({ port: hubPort, autoStart: cfg.autoStartHub !== false })
  if (!status.online) {
    throw new Error('扩展桥 hub 没起来（' + (status.error || '未知错误') + '）。先调用 devtools_live_status 看看状态。')
  }
  if (!status.extensionConnected) {
    throw new Error('浏览器扩展还没连接：请在浏览器里点开「DSH Web DevTools Bridge」扩展图标 → 点「接入当前标签页」。'
      + '如果 hub 端口改过，在扩展 popup 里把端口改成 ' + hubPort + '。')
  }
  let attached = Array.isArray(status.attached) ? status.attached : []
  if (!attached.length) {
    const result = await live.attachLive(hubPort)
    attached = [{ tabId: result.tabId, title: result.title, url: result.url }]
  }
  const current = attached[0]
  return {
    live: true,
    port: hubPort,
    info: { alive: true, browser: (status.extension && status.extension.browser) || '' },
    page: {
      id: String(current.tabId),
      title: current.title || '',
      url: current.url || '',
      ws: `ws://127.0.0.1:${hubPort}/cdp?tab=${current.tabId}`,
    },
    pages: attached.map((item) => ({ id: String(item.tabId), title: item.title || '', url: item.url || '', ws: '' })),
  }
}

async function opStatus(cfg) {
  const port = clamp(cfg.cdpPort, 1, 65535, cdp.DEFAULT_PORT)
  const info = await cdp.cdpVersion(port)
  const exe = cdp.findBrowser(cfg.browser)
  const userDataDir = cfg.userDataDir ? path.resolve(cfg.userDataDir) : cdp.defaultUserDataDir()
  let pages = []
  if (info.alive) {
    try { pages = await cdp.listPages(port) } catch { pages = [] }
  }
  const lines = [
    `CDP：${info.alive ? '在线 ✅' : '离线 ❌'}  · 端口 ${port}`,
    `浏览器：${info.browser || '（未知）'}`,
    `可执行文件：${exe || '（没找到 Edge/Chrome，请在插件配置里设置 browser）'}`,
    `用户数据目录：${userDataDir}`,
    `页面数：${pages.length}`,
  ]
  pages.forEach((page, index) => {
    lines.push(`  [${index}] ${page.title || '(无标题)'} — ${page.url}`)
  })

  // 扩展桥状态：读「用户当前浏览的标签页」那条路
  const hubPort = clamp(cfg.hubPort, 1, 65535, live.DEFAULT_HUB_PORT)
  const hub = await live.hubStatus(hubPort, 1500).catch(() => ({ online: false }))
  lines.push('')
  lines.push('扩展桥（读取你当前浏览的页面）：')
  if (!hub.online) {
    lines.push('  hub：离线（调用 devtools_live_status 会启动它）')
  } else {
    lines.push(`  hub：在线 v${hub.version || '?'}  ·  端口 ${hubPort}`)
    lines.push(`  扩展：${hub.extensionConnected ? '已连接 ✅' : '未连接（去浏览器点开「DSH Web DevTools Bridge」扩展图标）'}`)
    const attached = hub.attached || []
    lines.push(`  已接入：${attached.length ? attached.map((item) => '#' + item.tabId + ' ' + (item.title || item.url)).join('；') : '无'}`)
  }

  if (!info.alive) {
    lines.push('')
    lines.push(exe ? '提示：调用 devtools_launch 启动浏览器；读控制台/DOM 的工具也会自动拉起它。' : '提示：先安装 Edge 或 Chrome，或在插件配置里把 browser 指到浏览器 exe。')
  } else if (!pages.length) {
    lines.push('')
    lines.push('提示：还没有页面，调用 devtools_open 打开一个 URL。')
  }
  return lines.join('\n')
}

async function opLiveStatus(cfg) {
  const hubPort = clamp(cfg.hubPort, 1, 65535, live.DEFAULT_HUB_PORT)
  const status = await live.ensureHub({ port: hubPort, autoStart: cfg.autoStartHub !== false })
  const lines = ['扩展桥 · 读取你当前浏览器里正在看的页面']
  if (!status.online) {
    lines.push('hub：离线 ❌' + (status.error ? '（' + status.error + '）' : ''))
    lines.push('提示：检查端口 ' + hubPort + ' 是否被占用；日志在 ' + path.join(live.stateDir(), 'hub.log'))
    return lines.join('\n')
  }
  lines.push(`hub：在线 ✅  端口 ${hubPort}  v${status.version || '?'}`)
  lines.push(`扩展：${status.extensionConnected ? '已连接 ✅' : '未连接 ❌（在浏览器里点开「DSH Web DevTools Bridge」扩展图标 → 点「接入当前标签页」）'}`)
  if (status.extension && status.extension.browser) lines.push('浏览器：' + String(status.extension.browser).slice(0, 160))
  const attached = status.attached || []
  lines.push('已接入：' + (attached.length
    ? attached.map((item) => `#${item.tabId} ${item.title || item.url}${item.idleMs ? '（空闲 ' + Math.round(item.idleMs / 1000) + 's）' : ''}`).join('；')
    : '无'))
  const tabs = (status.extension && status.extension.tabs) || status.tabs || []
  if (tabs.length) {
    lines.push('')
    lines.push(`浏览器标签页（${tabs.length}）：`)
    for (const tab of tabs.slice(0, 20)) {
      lines.push(`  ${tab.active ? '▶' : ' '} #${tab.id} ${tab.title || '(无标题)'} — ${tab.url || ''}`)
    }
  }
  lines.push('')
  lines.push('下一步：devtools_live_attach 接入当前页（或指定 tab_id），然后用 devtools_console / devtools_dom / devtools_find 等，target 传 "current"。')
  return lines.join('\n')
}

async function opLiveAttach(cfg, payload) {
  const hubPort = clamp(cfg.hubPort, 1, 65535, live.DEFAULT_HUB_PORT)
  const status = await live.ensureHub({ port: hubPort, autoStart: cfg.autoStartHub !== false })
  if (!status.online) throw new Error('hub 没起来：' + (status.error || '未知错误'))
  if (!status.extensionConnected) {
    throw new Error('扩展未连接：请在浏览器里点开「DSH Web DevTools Bridge」扩展图标 → 点「接入当前标签页」。'
      + '如果 hub 端口不是 ' + hubPort + '，在扩展 popup 里改端口。')
  }
  const result = await live.attachLive(hubPort, payload.tab_id)
  return [
    `已接入标签页 #${result.tabId}：${result.title || '(无标题)'}`,
    `URL：${result.url || ''}`,
    '现在可以用 target="current" 读它：devtools_console / devtools_dom / devtools_find / devtools_activity / devtools_storage / devtools_screenshot 都支持。',
    '注意：接入期间标签页顶部会有「正在调试此标签页」提示，且不能同时开 F12；读完可调 devtools_live_detach 断开。',
  ].join('\n')
}

async function opLiveDetach(cfg, payload) {
  const hubPort = clamp(cfg.hubPort, 1, 65535, live.DEFAULT_HUB_PORT)
  const status = await live.hubStatus(hubPort)
  if (!status.online) return 'hub 没在运行，没有需要断开的标签页。'
  const result = await live.detachLive(hubPort, payload.tab_id)
  const list = Array.isArray(result.detached) ? result.detached : []
  return list.length ? `已断开 ${list.length} 个标签页：${list.map((id) => '#' + id).join(', ')}` : '没有已接入的标签页。'
}

async function opLaunch(cfg, payload) {
  const port = clamp(cfg.cdpPort, 1, 65535, cdp.DEFAULT_PORT)
  const result = await cdp.launchBrowser({
    ...cfg,
    cdpPort: port,
    url: payload.url,
    headless: payload.headless === undefined ? cfg.headless : Boolean(payload.headless),
  })
  let pages = []
  try { pages = await cdp.listPages(port) } catch { pages = [] }
  const lines = [
    result.launched ? '浏览器已启动（带 CDP 调试端口）。' : '浏览器已经在调试端口上运行，直接复用。',
    `端口：${port}  · 浏览器：${result.browser || '未知'}`,
    `可执行文件：${result.exe || '（配置路径）'}`,
    `用户数据目录：${result.userDataDir || ''}`,
    `页面数：${pages.length}`,
  ]
  pages.forEach((page, index) => lines.push(`  [${index}] ${page.title || '(无标题)'} — ${page.url}`))
  if (!pages.length) lines.push('提示：用 devtools_open 打开一个 URL。')
  lines.push('（这个浏览器是插件专用实例：有自己的 profile，登录态会保存；不会动你平时用的 Edge/Chrome。）')
  return lines.join('\n')
}

async function opPages(cfg) {
  const port = clamp(cfg.cdpPort, 1, 65535, cdp.DEFAULT_PORT)
  const info = await cdp.cdpVersion(port)
  if (!info.alive) {
    return `CDP 端口 ${port} 离线。先调用 devtools_launch（或任意读取工具会自动拉起浏览器）。`
  }
  const pages = await cdp.listPages(port)
  if (!pages.length) return '浏览器在线，但没有页面。用 devtools_open 打开一个 URL。'
  const lines = [`页面列表（${pages.length} 个，端口 ${port}）：`]
  pages.forEach((page, index) => {
    lines.push(`  [${index}] ${page.title || '(无标题)'}`)
    lines.push(`       ${page.url}`)
    lines.push(`       id=${page.id}`)
  })
  return lines.join('\n')
}

async function opOpen(cfg, payload) {
  const port = clamp(cfg.cdpPort, 1, 65535, cdp.DEFAULT_PORT)
  const url = String(payload.url || '').trim()
  if (!url) throw new Error('url 不能为空')
  await cdp.ensureBrowser({ ...cfg, cdpPort: port })
  let page
  if (payload.new_tab === false) {
    const pages = await cdp.listPages(port)
    const current = cdp.pickPage(pages, payload.target)
    page = await cdp.navigatePage(port, current, url)
  } else {
    page = await cdp.openNewTab(port, url)
  }
  writeState({ lastPageId: page.id, lastUrl: page.url, lastTitle: page.title })
  return [
    `已打开：${page.title || '(无标题)'}`,
    `URL：${page.url}`,
    `id：${page.id}`,
    '接着可以用 devtools_console / devtools_dom / devtools_eval / devtools_network 读它。',
  ].join('\n')
}

async function opConsole(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  const result = await cdp.readConsole(page, {
    level: payload.level,
    filter: payload.filter,
    limit: payload.limit,
    waitMs: payload.wait_ms,
  })
  const lines = [
    `F12 控制台 · 显示 ${result.shown}/${result.total} 条`,
    `页面：${page.title || '(无标题)'} — ${page.url}`,
  ]
  if (!result.messages.length) {
    lines.push('')
    lines.push('没有捕获到控制台消息。')
    lines.push('可能原因：页面没有日志；或日志在更早的进程里（浏览器重启过）；或需要更长的 wait_ms 才能等到新日志。')
  } else {
    lines.push('')
    for (const message of result.messages) {
      const location = message.url
        ? `  (${shortUrl(message.url, 100)}${message.line > 0 ? ':' + message.line : ''})`
        : ''
      const body = clip(message.text, 4000).text
      lines.push(`${levelTag(message.level)} ${body}${location}`)
    }
    if (result.total > result.shown) lines.push(`…（只显示最后 ${result.shown} 条，共 ${result.total} 条；用 limit 调整）`)
  }
  return lines.join('\n')
}

async function opDom(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  const mode = String(payload.mode || 'html')
  const data = await cdp.readDom(page, {
    selector: payload.selector,
    mode,
    depth: payload.depth,
    maxChars: payload.max_chars,
  })
  const head = [
    `DOM · 模式 ${mode}${payload.selector ? ` · 选择器 ${payload.selector}` : ''}`,
    `页面：${data.title || page.title || ''} — ${data.url || page.url}`,
    `readyState=${data.readyState || '?'}  视口=${data.viewport ? data.viewport.width + '×' + data.viewport.height : '?'}  文档=${data.scroll ? data.scroll.width + '×' + data.scroll.height : '?'}`,
  ]
  if (data.found === false) {
    return head.concat(['', `❌ ${data.error || '没找到'}`, '提示：选择器用 CSS 语法，例如 #app .list li 或 [data-testid="submit"]。']).join('\n')
  }
  head.push('')
  if (mode === 'attrs') {
    head.push(`<${data.tag || '元素'} 的属性>`)
    head.push(safeStringify(data.attrs || {}))
  } else if (mode === 'rect') {
    const r = data.rect || {}
    head.push(`位置：x=${r.x} y=${r.y} 宽=${r.width} 高=${r.height}`)
    head.push(`样式：display=${data.display} visibility=${data.visibility} opacity=${data.opacity}`)
  } else if (mode === 'text') {
    head.push(safeText(data.text))
    if (data.truncated) head.push(`\n…（已截断：原文 ${data.length} 字符，用 max_chars 调整）`)
  } else if (mode === 'outline') {
    head.push(data.outline || '(空)')
    if (data.lines >= 500) head.push('\n…（结构树超过 500 行已截断，用 depth 控制深度）')
  } else {
    head.push(data.html || '(空)')
    if (data.truncated) head.push(`\n…（已截断：原文 ${data.length} 字符，用 max_chars 调整或加 selector 缩小范围）`)
  }
  return head.join('\n')
}

function safeText(text) {
  return String(text == null ? '' : text)
}

async function opEval(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  const result = await cdp.evaluate(page, payload.expression, {
    awaitPromise: payload.await_promise,
    timeoutMs: payload.timeout_ms,
  })
  const lines = [`在页面执行 JS（${payload.expression.length > 120 ? payload.expression.slice(0, 120) + '…' : payload.expression}）`]
  lines.push(`页面：${page.title || '(无标题)'} — ${page.url}`)
  lines.push('')
  if (!result.ok) {
    lines.push('❌ 执行出错：')
    lines.push(result.error)
    if (result.line !== undefined && result.line >= 0) lines.push(`位置：第 ${result.line + 1} 行${result.column !== undefined ? ' 第 ' + (result.column + 1) + ' 列' : ''}`)
    return lines.join('\n')
  }
  if (result.value === undefined) {
    lines.push('返回值：undefined')
  } else {
    const text = typeof result.value === 'string' ? result.value : safeStringify(result.value)
    const clipped = clip(text, 20000)
    lines.push(clipped.text)
    if (clipped.truncated) lines.push(`\n…（已截断：原文 ${clipped.length} 字符）`)
  }
  return lines.join('\n')
}

async function opNetwork(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  const mode = String(payload.mode || 'history')
  const lines = []
  if (mode === 'live') {
    const result = await cdp.captureNetwork(page, {
      waitMs: payload.wait_ms,
      filter: payload.filter,
      limit: payload.limit,
      reload: payload.reload,
    })
    lines.push(`网络 · 实时抓包 · ${result.shown}/${result.total} 条`)
    lines.push(`页面：${page.title || '(无标题)'} — ${page.url}`)
    lines.push('')
    if (!result.requests.length) {
      lines.push('这段时间没有抓到请求。可以加 wait_ms（例如 8000），或 reload=true 后立刻抓页面加载请求。')
    }
    for (const request of result.requests) {
      const status = request.failed ? 'ERR ' + request.failed.slice(0, 40) : String(request.status || '—')
      lines.push(`[${status}] ${request.method} ${request.type || ''} ${request.duration >= 0 ? request.duration + 'ms' : ''} ${formatBytes(request.encodedLength)}`)
      lines.push(`      ${shortUrl(request.url, 180)}`)
    }
  } else {
    const result = await cdp.networkHistory(page, { filter: payload.filter, limit: payload.limit })
    lines.push(`网络 · 历史资源（PerformanceResourceTiming）· ${result.shown}/${result.total} 条`)
    lines.push(`页面：${page.title || '(无标题)'} — ${page.url}`)
    if (result.navigation) {
      lines.push(`文档：load ${result.navigation.load}ms · DOMContentLoaded ${result.navigation.domContentLoaded}ms`)
    }
    lines.push('')
    if (!result.entries.length) {
      lines.push('没有资源记录。可改用 mode="live" 实时抓包。')
    }
    for (const entry of result.entries) {
      const status = entry.status ? `[${entry.status}]` : '[—]'
      lines.push(`${status} ${String(entry.type || 'other').padEnd(10)} ${String(entry.duration + 'ms').padEnd(8)} ${formatBytes(entry.transferSize)}`)
      lines.push(`      ${shortUrl(entry.url, 180)}`)
    }
    lines.push('')
    lines.push('提示：历史模式只有资源计时，没有请求/响应头和请求体；要抓实时请求用 mode="live"。')
  }
  return lines.join('\n')
}

async function opScreenshot(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  const format = payload.format === 'jpeg' ? 'jpeg' : 'png'
  const result = await cdp.captureScreenshot(page, {
    fullPage: Boolean(payload.full_page),
    format,
    quality: payload.quality,
  })
  const outDir = payload.outDir ? path.resolve(String(payload.outDir)) : path.join(process.cwd(), 'web-devtools')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const base = String(payload.filename || `page-${stamp}`).replace(/[\\/:*?"<>|]/g, '_')
  const file = path.join(outDir, base.endsWith('.' + format) ? base : `${base}.${format}`)
  fs.writeFileSync(file, result.buffer)
  return [
    `截图已保存：${file}`,
    `页面：${page.title || '(无标题)'} — ${page.url}`,
    `格式：${format}${payload.full_page ? '（整页）' : '（视口）'}  ·  大小：${formatBytes(result.buffer.length)}`,
    '可以用 read_image 工具打开这个文件查看。',
  ].join('\n')
}

/* ------------------------------------------------------------------ *
 * 页面理解：概览 / 元素定位 / 时间线 / 存储
 * ------------------------------------------------------------------ */

function pad2(value) {
  return String(value).padStart(2, '0')
}

function clockOf(ts) {
  const date = new Date(Number(ts) || Date.now())
  return pad2(date.getHours()) + ':' + pad2(date.getMinutes()) + ':' + pad2(date.getSeconds()) + '.' + String(date.getMilliseconds()).padStart(3, '0')
}

/** 自动给页面注入记录器（除非配置关掉）。 */
async function ensureRecord(cfg, page) {
  if (cfg.autoRecord === false) return null
  try { return await cdp.ensureRecorder(page) } catch { return null }
}

async function opSummary(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  await ensureRecord(cfg, page)
  const data = await cdp.readSummary(page)
  const lines = []
  lines.push('页面概览')
  lines.push(`URL：${data.url || page.url}`)
  lines.push(`标题：${data.title || '(无标题)'}`)
  if (data.description) lines.push(`描述：${data.description}`)
  const metaBits = []
  if (data.lang) metaBits.push('语言 ' + data.lang)
  if (data.frameworks && data.frameworks.length) metaBits.push('框架 ' + data.frameworks.join(' / '))
  metaBits.push('状态 ' + (data.readyState || '?'))
  lines.push(metaBits.join('  ·  '))
  const doc = data.document || {}
  lines.push(`规模：${doc.elements || 0} 个元素  ·  文档 ${doc.width || 0}×${doc.height || 0}  ·  视口 ${data.viewport ? data.viewport.width + '×' + data.viewport.height : '?'}`)
  const landmarks = data.landmarks || {}
  lines.push(`结构：header ${landmarks.header || 0} · nav ${landmarks.nav || 0} · main ${landmarks.main || 0} · aside ${landmarks.aside || 0} · footer ${landmarks.footer || 0} · iframe ${landmarks.iframes || 0}`)

  if (data.headings && data.headings.length) {
    lines.push('')
    lines.push(`主要标题（${data.headings.length}）：`)
    for (const heading of data.headings.slice(0, 15)) {
      lines.push(`  [${heading.tag}] ${heading.text || '(空)'}`)
    }
  }

  if (data.forms && data.forms.length) {
    lines.push('')
    lines.push(`表单（${data.forms.length} 个）：`)
    data.forms.forEach((form, index) => {
      lines.push(`  ${index + 1}. ${form.method} ${form.action || '(当前页)'}   ${form.selector ? '定位 ' + form.selector : ''}`)
      for (const field of form.fields.slice(0, 12)) {
        const bits = [field.tag + (field.type ? '[type=' + field.type + ']' : '')]
        if (field.name) bits.push('name=' + field.name)
        if (field.label) bits.push('label=' + field.label)
        else if (field.placeholder) bits.push('placeholder=' + field.placeholder)
        if (field.required) bits.push('必填')
        bits.push('定位 ' + field.selector)
        lines.push('     - ' + bits.join('  '))
      }
    })
  }

  if (data.buttons && data.buttons.length) {
    lines.push('')
    lines.push(`按钮（${data.buttons.length}）：`)
    for (const button of data.buttons.slice(0, 15)) {
      lines.push(`  "${button.text || '(无文字)'}"  定位 ${button.selector}${button.disabled ? '  [禁用]' : ''}`)
    }
  }

  if (data.links && data.links.length) {
    lines.push('')
    lines.push(`链接（${data.links.length}）：`)
    for (const link of data.links.slice(0, 12)) {
      lines.push(`  "${link.text || '(无文字)'}" → ${shortUrl(link.href, 100)}`)
    }
    if (data.links.length > 12) lines.push(`  …还有 ${data.links.length - 12} 条`)
  }

  if (data.tables && data.tables.length) {
    lines.push('')
    lines.push(`表格（${data.tables.length}）：`)
    data.tables.forEach((table, index) => {
      lines.push(`  ${index + 1}. ${table.headers.length} 列 / ${table.rows} 行${table.headers.length ? '  列：' + table.headers.join(' | ') : ''}`)
    })
  }

  const images = data.images || {}
  lines.push('')
  lines.push(`媒体：图片 ${images.count || 0} 张${images.missingAlt ? `（${images.missingAlt} 张缺 alt）` : ''}`)

  const storageKeys = data.storageKeys || {}
  const tokenPattern = /token|auth|jwt|session|ticket|user|uid|login/i
  const localKeys = storageKeys.local || []
  const sessionKeys = storageKeys.session || []
  if (localKeys.length || sessionKeys.length) {
    const tokenKeys = localKeys.concat(sessionKeys).filter((key) => tokenPattern.test(key))
    lines.push(`存储键：local[${localKeys.slice(0, 12).join(', ')}${localKeys.length > 12 ? '…' : ''}]  session[${sessionKeys.slice(0, 12).join(', ')}${sessionKeys.length > 12 ? '…' : ''}]${tokenKeys.length ? '  → 疑似登录态：' + tokenKeys.join(', ') : ''}`)
  }

  if (data.textExcerpt) {
    lines.push('')
    lines.push('正文摘录：')
    lines.push(data.textExcerpt)
  }

  lines.push('')
  lines.push('下一步：用 devtools_find 找具体元素定位器；用 devtools_activity 看刚才发生了什么；用 devtools_dom 看结构。')
  return lines.join('\n')
}

function formatFindItem(item, index) {
  const rect = item.rect || {}
  const visibleText = item.visible ? '可见' : '不可见'
  const size = `${rect.width || 0}×${rect.height || 0}`
  const position = `@ ${rect.x || 0},${rect.y || 0}`
  const lines = []
  const title = [item.tag, item.id ? '#' + item.id : '', item.classes && item.classes.length ? '.' + item.classes.join('.') : ''].join('')
  lines.push(`[${index + 1}] ${title}  "${item.name || item.text || ''}"  (${visibleText}, ${size} ${position})`)
  lines.push(`    定位器：${item.locator || item.selector}${item.selectorUnique ? '（唯一）' : '（不唯一，建议用 XPath）'}`)
  if (item.selector && item.selector !== item.locator) lines.push(`    CSS：${item.selector}`)
  lines.push(`    XPath：${item.xpath}`)
  if (item.role) lines.push(`    role：${item.role}${item.name ? '  name："' + item.name + '"' : ''}`)
  if (item.textLocator && item.name) lines.push(`    文本定位：${item.textLocator}`)
  const attrBits = Object.entries(item.attrs || {}).filter(([key]) => !['style'].includes(key)).slice(0, 8).map(([key, value]) => `${key}=${String(value).slice(0, 60)}`)
  if (attrBits.length) lines.push(`    属性：${attrBits.join('  ')}`)
  if (item.value) lines.push(`    当前值：${item.value}`)
  if (item.href) lines.push(`    href：${shortUrl(item.href, 100)}`)
  return lines.join('\n')
}

async function opFind(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  await ensureRecord(cfg, page)
  const data = await cdp.readFind(page, {
    selector: payload.selector,
    text: payload.text,
    tag: payload.tag,
    limit: payload.limit,
    includeHidden: payload.include_hidden === true,
  })
  if (data.error) throw new Error(data.error)
  const lines = [
    `元素定位 · ${payload.selector ? '选择器 ' + payload.selector : '文本 "' + (payload.text || '') + '"'} · 命中 ${data.total} 个，显示 ${data.shown}`,
    `页面：${page.title || ''} — ${page.url}`,
  ]
  if (!data.results || !data.results.length) {
    lines.push('')
    lines.push('没有匹配到元素。')
    lines.push('提示：文本搜索只匹配元素自身的直接文本；页面如果用了 iframe/Shadow DOM 需要另外处理；隐藏元素默认跳过（include_hidden=true 可包含）。')
    return lines.join('\n')
  }
  lines.push('')
  data.results.forEach((item, index) => lines.push(formatFindItem(item, index)))
  lines.push('')
  lines.push('把「定位器 / CSS / XPath」直接写进脚本即可；文本定位可以直接用 page.getByText 之类的写法。')
  return lines.join('\n')
}

function formatTimelineEvent(event) {
  const time = clockOf(event.ts)
  switch (event.kind) {
    case 'click':
      return `${time}  [点击]    ${event.tag || ''} ${event.selector || ''}  "${event.text || event.label || ''}"`
    case 'input':
      return `${time}  [输入]    ${event.selector || ''} = ${event.value || ''}`
    case 'change':
      return `${time}  [变更]    ${event.selector || ''} = ${event.value || ''}`
    case 'submit':
      return `${time}  [提交]    ${event.selector || ''}  ${event.method || ''} ${shortUrl(event.action || '', 100)}`
    case 'key':
      return `${time}  [按键]    ${event.selector || ''}  ${event.key || ''}`
    case 'navigate':
      return `${time}  [跳转]    ${shortUrl(event.url || '', 140)}`
    case 'request':
      return `${time}  [网络]    ${event.method || 'GET'} ${shortUrl(event.url || '', 100)} → ${event.failed ? '失败' : (event.status || '?')}${event.ms >= 0 ? ' (' + event.ms + 'ms)' : ''}`
    case 'dom':
      return `${time}  [DOM]     ${event.selector || ''} +${event.added || 0} -${event.removed || 0}${event.summary ? '  ' + event.summary : ''}`
    case 'console':
      return `${time}  [控制台] [${event.level}] ${clip(event.text, 800).text}`
    default:
      return `${time}  [${event.kind}] ${JSON.stringify(event).slice(0, 300)}`
  }
}

async function opActivity(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  const action = String(payload.action || 'read')
  if (action === 'start') {
    const result = await cdp.ensureRecorder(page)
    if (!result.ok) throw new Error(result.error || '记录器启动失败')
    return [
      result.existed ? '记录器已经在运行，会继续记录。' : '记录器已启动：从现在开始记录点击、输入、提交、请求、DOM 变化和跳转。',
      `页面：${page.title || ''} — ${page.url}`,
      '现在去页面上操作，然后调用 devtools_activity（action=read）即可看到时间线。',
    ].join('\n')
  }
  if (action === 'stop') {
    const result = await cdp.controlRecorder(page, 'stop')
    if (!result.ok) throw new Error(result.error || '暂停失败')
    return '记录器已暂停（已记录的事件仍可读取；action=start 恢复记录）。'
  }
  if (action === 'clear') {
    const result = await cdp.controlRecorder(page, 'clear')
    if (!result.ok) throw new Error(result.error || '清空失败')
    return '记录器已清空，重新开始记录。'
  }

  // read
  let recorder = null
  try { recorder = await cdp.readRecorder(page) } catch { recorder = null }
  if (!recorder && cfg.autoRecord !== false) {
    await cdp.ensureRecorder(page).catch(() => {})
  }
  const sinceMs = clamp(payload.since_ms, 1000, 86400000, 300000)
  const result = await cdp.readActivity(page, {
    sinceMs,
    limit: payload.limit,
    includeConsole: payload.include_console !== false,
  })
  const lines = []
  lines.push(`操作时间线 · 最近 ${Math.round(sinceMs / 1000)} 秒 · ${result.shown}/${result.total} 条`)
  lines.push(`页面：${page.title || ''} — ${page.url}`)
  if (result.recorder) {
    lines.push(`记录器：已启动 ${clockOf(result.recorder.startedAt)}  ·  共记录 ${result.recorder.total} 条${result.recorder.paused ? '  ·  已暂停' : ''}`)
  } else {
    lines.push('记录器：未启动 —— 只能看到控制台日志。想在操作前开始追踪，先调用 devtools_activity（action=start）。')
  }
  lines.push('')
  if (!result.events.length) {
    lines.push('这段时间没有记录到事件。')
    lines.push('可能原因：记录器是刚注入的（之前发生的事件看不到）、页面没有交互，或正在 iframe 里操作（记录器只装在主页面）。')
  } else {
    for (const event of result.events) lines.push(formatTimelineEvent(event))
  }
  return lines.join('\n')
}

async function opStorage(cfg, payload) {
  const { page } = await resolvePage(cfg, payload.target)
  await ensureRecord(cfg, page)
  const data = await cdp.readStorage(page, { maxValue: payload.max_value })
  const lines = [`存储 · localStorage ${data.counts.local} / sessionStorage ${data.counts.session} / cookie ${data.counts.cookies}`, `页面：${page.title || ''} — ${page.url}`]
  const renderItem = (item) => {
    let value = item.value || ''
    if (payload.show_values !== false) {
      if (/jwt|token|auth|session/i.test(item.key) && value.length > 40) value = value.slice(0, 30) + '…（已截断，共 ' + item.length + ' 字符）'
      else if (value.length > 300) value = value.slice(0, 300) + '…'
    } else {
      value = '（长度 ' + item.length + '）'
    }
    const flags = []
    if (item.looksLikeJson) flags.push('JSON')
    if (value.slice(0, 3) === 'eyJ') flags.push('疑似 JWT')
    return `  ${item.key} = ${value}${flags.length ? '  [' + flags.join(', ') + ']' : ''}`
  }
  if (data.localStorage.length) {
    lines.push('')
    lines.push(`localStorage（${data.localStorage.length}）：`)
    for (const item of data.localStorage.slice(0, 60)) lines.push(renderItem(item))
  }
  if (data.sessionStorage.length) {
    lines.push('')
    lines.push(`sessionStorage（${data.sessionStorage.length}）：`)
    for (const item of data.sessionStorage.slice(0, 60)) lines.push(renderItem(item))
  }
  if (data.cookies.length) {
    lines.push('')
    lines.push(`cookie（${data.cookies.length}，仅 document.cookie 可见，HttpOnly 读不到）：`)
    for (const cookie of data.cookies.slice(0, 60)) {
      const value = cookie.value.length > 120 ? cookie.value.slice(0, 120) + '…' : cookie.value
      lines.push(`  ${cookie.name} = ${value}`)
    }
  }
  if (data.tokenishKeys && data.tokenishKeys.length) {
    lines.push('')
    lines.push('疑似登录态 / 可鉴权的键：' + data.tokenishKeys.join(', '))
  }
  if (!data.localStorage.length && !data.sessionStorage.length && !data.cookies.length) {
    lines.push('')
    lines.push('页面没有可读取的 localStorage / sessionStorage / cookie。')
  }
  return lines.join('\n')
}

async function opDownload(cfg, payload) {
  if (String(payload.target || '').trim() === 'current') {
    throw new Error('扩展模式（target="current"）不支持下载：chrome.debugger 只有标签页级会话，不能设置浏览器下载通道。'
      + '要下载文件请用专用浏览器模式（不传 target="current"）调用 devtools_download。')
  }
  const port = clamp(cfg.cdpPort, 1, 65535, cdp.DEFAULT_PORT)
  const outDir = payload.dir ? path.resolve(String(payload.dir)) : path.join(process.cwd(), cfg.downloadSubdir || 'downloads')
  const { page } = await resolvePage(cfg, payload.target)
  const timeoutMs = payload.timeout_ms
  let result
  if (payload.selector) {
    result = await cdp.downloadByClick(port, page, payload.selector, outDir, { timeoutMs })
  } else if (payload.url) {
    let userAgent = ''
    try {
      const ua = await cdp.evaluate(page, 'navigator.userAgent')
      if (ua.ok) userAgent = String(ua.value || '')
    } catch { /* ignore */ }
    result = await cdp.downloadUrl(port, page, payload.url, outDir, { timeoutMs, userAgent, referer: page.url })
  } else {
    throw new Error('url 和 selector 至少给一个：url 直接下载文件；selector 点页面上的下载/导出按钮')
  }
  const lines = [
    `已下载：${result.file}`,
    `来源：${result.mode === 'browser' ? '浏览器下载事件（页面内触发）' : 'URL 直接下载（带浏览器 cookie）'}`,
    `大小：${formatBytes(result.bytes)}${result.contentType ? '  ·  类型：' + result.contentType : ''}`,
    `页面：${page.title || ''} — ${page.url}`,
  ]
  if (/\.(png|jpg|jpeg|gif|webp|svg)$/i.test(result.file)) lines.push('这是图片，可用 read_image 工具查看。')
  return lines.join('\n')
}

async function dispatch(payload) {
  const cfg = payload.config && typeof payload.config === 'object' ? payload.config : {}
  switch (payload.op) {
    case 'status': return opStatus(cfg)
    case 'launch': return opLaunch(cfg, payload)
    case 'pages': return opPages(cfg)
    case 'open': return opOpen(cfg, payload)
    case 'console': return opConsole(cfg, payload)
    case 'dom': return opDom(cfg, payload)
    case 'eval': return opEval(cfg, payload)
    case 'network': return opNetwork(cfg, payload)
    case 'screenshot': return opScreenshot(cfg, payload)
    case 'summary': return opSummary(cfg, payload)
    case 'find': return opFind(cfg, payload)
    case 'activity': return opActivity(cfg, payload)
    case 'storage': return opStorage(cfg, payload)
    case 'download': return opDownload(cfg, payload)
    case 'live-status': return opLiveStatus(cfg)
    case 'live-attach': return opLiveAttach(cfg, payload)
    case 'live-detach': return opLiveDetach(cfg, payload)
    default: throw new Error(`未知操作：${payload.op}`)
  }
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

async function main() {
  let payload = {}
  try {
    const raw = await readStdin()
    payload = raw.trim() ? JSON.parse(raw) : {}
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: '参数不是合法 JSON：' + (error && error.message) }) + '\n')
    return
  }
  try {
    const text = await dispatch(payload)
    process.stdout.write(JSON.stringify({ ok: true, text: String(text) }) + '\n')
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: String((error && error.message) || error) }) + '\n')
  }
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ ok: false, error: String((error && error.message) || error) }) + '\n')
  process.exitCode = 1
})
