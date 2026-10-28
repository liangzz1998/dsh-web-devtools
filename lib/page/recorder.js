// 页面侧记录器：把「刚刚发生了什么」记到 window.__dshRecorder。
// 只在页面里运行（由 CDP Runtime.evaluate 注入），不是 Node 模块。
const existing = window.__dshRecorder
if (existing) return { ok: true, existed: true, startedAt: existing.startedAt }

const REC = { startedAt: Date.now(), events: [], paused: false, max: 1200 }
const MAX = REC.max

const push = (event) => {
  if (REC.paused) return
  event.ts = Date.now()
  REC.events.push(event)
  if (REC.events.length > MAX) REC.events.splice(0, REC.events.length - MAX)
}

const text = (value, max) => {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

const escapeCss = (value) => {
  const s = String(value)
  if (window.CSS && CSS.escape) return CSS.escape(s)
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch)
}

// 生成尽量短、尽量唯一的 CSS 选择器
const selectorOf = (el) => {
  if (!el || el.nodeType !== 1) return ''
  if (el.id) {
    const byId = '#' + escapeCss(el.id)
    try { if (document.querySelectorAll(byId).length === 1) return byId } catch (e) {}
  }
  const parts = []
  let node = el
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase()
    if (node.classList && node.classList.length) {
      part += '.' + Array.from(node.classList).slice(0, 2).map(escapeCss).join('.')
    }
    const parent = node.parentElement
    if (parent) {
      const sameTag = Array.from(parent.children).filter((child) => child.tagName === node.tagName)
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')'
    }
    parts.unshift(part)
    const candidate = parts.join(' > ')
    try { if (document.querySelectorAll(candidate).length === 1) return candidate } catch (e) {}
    node = parent
  }
  return parts.join(' > ')
}

const labelOf = (el) => {
  if (!el) return ''
  const aria = el.getAttribute ? (el.getAttribute('aria-label') || '') : ''
  if (aria) return text(aria, 80)
  const placeholder = el.getAttribute ? (el.getAttribute('placeholder') || '') : ''
  if (placeholder) return text(placeholder, 80)
  return text(el.innerText || el.value || '', 80)
}

const add = (kind, el, extra) => {
  push(Object.assign({
    kind,
    selector: selectorOf(el),
    tag: el && el.tagName ? el.tagName.toLowerCase() : '',
    label: labelOf(el),
  }, extra || {}))
}

// 点击
document.addEventListener('click', (event) => {
  const el = event.target && event.target.nodeType === 1 ? event.target : null
  if (!el) return
  add('click', el, { text: text(el.innerText || el.value || '', 100) })
}, true)

// 输入
document.addEventListener('input', (event) => {
  const el = event.target
  if (!el || !el.tagName) return
  const isPassword = el.type === 'password'
  add('input', el, { value: isPassword ? '***' : text(el.value, 120), inputType: el.type || '' })
}, true)

document.addEventListener('change', (event) => {
  const el = event.target
  if (!el || !el.tagName) return
  if (el.tagName === 'INPUT') return
  add('change', el, { value: text(el.value || '', 120) })
}, true)

document.addEventListener('submit', (event) => {
  const form = event.target
  if (!form) return
  add('submit', form, { action: form.action || '', method: String(form.method || 'get').toUpperCase() })
}, true)

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return
  const el = event.target
  if (!el || !el.tagName) return
  add('key', el, { key: 'Enter' })
}, true)

// fetch
const wrapFetch = () => {
  const original = window.fetch
  if (!original || original.__dshWrapped) return
  const wrapped = function () {
    const args = Array.prototype.slice.call(arguments)
    const input = args[0]
    const init = args[1] || {}
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    const method = String(init.method || (input && input.method) || 'GET').toUpperCase()
    const startedAt = Date.now()
    return original.apply(this, args).then((response) => {
      push({ kind: 'request', url: String(url), method, status: response.status, ms: Date.now() - startedAt, failed: false })
      return response
    }).catch((error) => {
      push({ kind: 'request', url: String(url), method, status: 0, ms: Date.now() - startedAt, failed: true, error: text(error && error.message || error, 120) })
      throw error
    })
  }
  wrapped.__dshWrapped = true
  window.fetch = wrapped
}
wrapFetch()

// XMLHttpRequest
const wrapXhr = () => {
  if (!window.XMLHttpRequest || XMLHttpRequest.prototype.__dshWrapped) return
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dsh = { method: String(method || 'GET').toUpperCase(), url: String(url || '') }
    return originalOpen.apply(this, arguments)
  }
  XMLHttpRequest.prototype.send = function () {
    const info = this.__dsh || { method: 'GET', url: '' }
    const startedAt = Date.now()
    this.addEventListener('loadend', () => {
      push({ kind: 'request', url: info.url, method: info.method, status: this.status || 0, ms: Date.now() - startedAt, failed: this.status === 0 })
    })
    return originalSend.apply(this, arguments)
  }
  XMLHttpRequest.prototype.__dshWrapped = true
}
wrapXhr()

// 路由变化（SPA）
const wrapHistory = (name) => {
  const original = history[name]
  if (!original || original.__dshWrapped) return
  const wrapped = function () {
    const result = original.apply(this, arguments)
    push({ kind: 'navigate', url: location.href })
    return result
  }
  wrapped.__dshWrapped = true
  history[name] = wrapped
}
wrapHistory('pushState')
wrapHistory('replaceState')
window.addEventListener('popstate', () => push({ kind: 'navigate', url: location.href }))
window.addEventListener('hashchange', () => push({ kind: 'navigate', url: location.href }))

// DOM 结构变化（120ms 聚合，避免刷屏；只看 childList）
let pending = null
const flush = () => {
  if (!pending) return
  const batch = pending
  pending = null
  push({ kind: 'dom', selector: batch.selector, added: batch.added, removed: batch.removed, summary: batch.summary })
}
const observer = new MutationObserver((mutations) => {
  if (REC.paused) return
  for (const mutation of mutations) {
    const added = mutation.addedNodes ? mutation.addedNodes.length : 0
    const removed = mutation.removedNodes ? mutation.removedNodes.length : 0
    if (!added && !removed) continue
    const target = mutation.target && mutation.target.nodeType === 1
      ? mutation.target
      : (mutation.target && mutation.target.parentElement) || null
    if (!pending) pending = { selector: target ? selectorOf(target) : '', added: 0, removed: 0, summary: '' }
    pending.added += added
    pending.removed += removed
    if (!pending.summary && mutation.addedNodes && mutation.addedNodes.length) {
      const first = mutation.addedNodes[0]
      if (first && first.nodeType === 1) {
        const content = text(first.innerText || first.textContent || '', 60)
        if (content) pending.summary = '<' + first.tagName.toLowerCase() + '> ' + content
      }
    }
  }
  if (!pending) return
  clearTimeout(REC.mutationTimer)
  REC.mutationTimer = setTimeout(flush, 120)
})
try {
  observer.observe(document.documentElement || document, { childList: true, subtree: true })
} catch (e) {}

REC.observer = observer
window.__dshRecorder = REC
window.__dshSelector = selectorOf
return { ok: true, existed: false, startedAt: REC.startedAt }
