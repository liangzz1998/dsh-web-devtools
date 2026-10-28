// 按选择器 / 文本 / 标签找元素，返回可直接写进自动化脚本的定位器。
// 外层包成 (() => { const __args = ...; ... })()
const args = __args || {}
const selector = String(args.selector || '').trim()
const keyword = String(args.text || '').trim().toLowerCase()
const tagFilter = String(args.tag || '').trim().toLowerCase()
const includeHidden = args.includeHidden === true
const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))

const text = (value, max) => {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

const escapeCss = (value) => {
  const s = String(value)
  if (window.CSS && CSS.escape) return CSS.escape(s)
  return s.replace(/[^a-zA-Z0-9_-]/g, (ch) => '\\' + ch)
}

const localSelector = (el) => {
  if (!el || el.nodeType !== 1) return ''
  if (el.id) {
    const byId = '#' + escapeCss(el.id)
    try { if (document.querySelectorAll(byId).length === 1) return byId } catch (e) {}
  }
  const parts = []
  let node = el
  while (node && node.nodeType === 1 && parts.length < 6) {
    let part = node.tagName.toLowerCase()
    if (node.classList && node.classList.length) part += '.' + Array.from(node.classList).slice(0, 2).map(escapeCss).join('.')
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

const selectorOf = (el) => {
  if (window.__dshSelector) return window.__dshSelector(el)
  return localSelector(el)
}

const xpathOf = (el) => {
  if (!el || el.nodeType !== 1) return ''
  const parts = []
  let node = el
  while (node && node.nodeType === 1) {
    let index = 1
    let sibling = node.previousElementSibling
    while (sibling) {
      if (sibling.tagName === node.tagName) index += 1
      sibling = sibling.previousElementSibling
    }
    parts.unshift(node.tagName.toLowerCase() + '[' + index + ']')
    node = node.parentElement
  }
  return '/' + parts.join('/')
}

const roleOf = (el) => {
  const explicit = el.getAttribute && el.getAttribute('role')
  if (explicit) return explicit
  const tag = el.tagName.toLowerCase()
  if (tag === 'a' && el.getAttribute('href')) return 'link'
  if (tag === 'button') return 'button'
  if (tag === 'select') return 'combobox'
  if (tag === 'textarea') return 'textbox'
  if (tag === 'input') {
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    if (type === 'submit' || type === 'button' || type === 'reset') return 'button'
    if (type === 'checkbox') return 'checkbox'
    if (type === 'radio') return 'radio'
    if (type === 'file') return 'file'
    if (type === 'search') return 'searchbox'
    return 'textbox'
  }
  return ''
}

const nameOf = (el) => {
  const aria = el.getAttribute && el.getAttribute('aria-label')
  if (aria) return text(aria, 80)
  const tag = el.tagName.toLowerCase()
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const placeholder = el.getAttribute('placeholder')
    if (placeholder) return text(placeholder, 80)
    if (el.id) {
      const labelNode = document.querySelector('label[for="' + el.id + '"]')
      if (labelNode) return text(labelNode.innerText, 80)
    }
    return ''
  }
  return text(el.innerText || el.value || el.getAttribute('title') || '', 80)
}

const isVisible = (el) => {
  if (!el.getClientRects || el.getClientRects().length === 0) return false
  const style = getComputedStyle(el)
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
  return true
}

const describe = (el) => {
  const rect = el.getBoundingClientRect()
  const attrs = {}
  if (el.attributes) {
    for (const attribute of el.attributes) {
      if (Object.keys(attrs).length >= 16) break
      attrs[attribute.name] = attribute.value.length > 120 ? attribute.value.slice(0, 120) + '…' : attribute.value
    }
  }
  const css = selectorOf(el)
  let unique = false
  try { unique = document.querySelectorAll(css).length === 1 } catch (e) {}
  const tag = el.tagName.toLowerCase()
  const role = roleOf(el)
  const name = nameOf(el)
  return {
    tag,
    id: el.id || '',
    classes: el.classList ? Array.from(el.classList).slice(0, 8) : [],
    attrs,
    text: text(el.innerText || el.textContent || '', 160),
    value: el.value !== undefined && el.type !== 'password' ? text(el.value, 100) : '',
    href: tag === 'a' && el.href ? el.href : '',
    src: tag === 'img' || tag === 'script' || tag === 'iframe' ? (el.src || '') : '',
    role,
    name,
    disabled: el.disabled === true,
    visible: isVisible(el),
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      inViewport: rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth,
    },
    selector: css,
    selectorUnique: unique,
    xpath: xpathOf(el),
    // 写 Playwright/Puppeteer 时可直接照抄的提示
    locator: el.id ? '#' + escapeCss(el.id) : (el.getAttribute('name') ? tag + '[name="' + el.getAttribute('name') + '"]' : css),
    textLocator: name ? 'text=' + name : '',
  }
}

let candidates = []
let error = ''
if (selector) {
  try {
    candidates = Array.from(document.querySelectorAll(selector))
  } catch (e) {
    error = '选择器不合法：' + String(e && e.message || e)
  }
} else if (keyword) {
  const all = Array.from(document.querySelectorAll('body *'))
  candidates = all.filter((el) => {
    const ownText = Array.from(el.childNodes)
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent)
      .join(' ')
    const extra = [
      ownText,
      el.value || '',
      el.getAttribute('aria-label') || '',
      el.getAttribute('placeholder') || '',
      el.getAttribute('title') || '',
      el.tagName === 'INPUT' || el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'LABEL' ? (el.innerText || '') : '',
    ].join(' ')
    return extra.toLowerCase().indexOf(keyword) >= 0
  })
} else {
  error = 'selector 或 text 至少给一个'
}

if (error) return { error }
if (tagFilter) candidates = candidates.filter((el) => el.tagName.toLowerCase() === tagFilter)
if (!includeHidden) candidates = candidates.filter(isVisible)

const total = candidates.length
const results = candidates.slice(0, limit).map(describe)
return {
  page: { url: location.href, title: document.title },
  query: { selector: selector, text: keyword, tag: tagFilter, includeHidden: includeHidden },
  total: total,
  shown: results.length,
  results: results,
}
