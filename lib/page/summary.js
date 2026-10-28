// 页面概览：这个网页是干什么的、有什么内容和功能。
// 由 CDP Runtime.evaluate 注入，外层包成 (() => { const __args = ...; ... })()
const text = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max)

const selectorOf = (el) => {
  if (window.__dshSelector) return window.__dshSelector(el)
  if (!el || el.nodeType !== 1) return ''
  if (el.id) return '#' + String(el.id)
  return el.tagName ? el.tagName.toLowerCase() : ''
}

const meta = (name) => {
  const byName = document.querySelector('meta[name="' + name + '"]')
  const byProperty = document.querySelector('meta[property="' + name + '"]')
  const node = byName || byProperty
  return node ? text(node.getAttribute('content') || '', 400) : ''
}

const headingList = Array.from(document.querySelectorAll('h1, h2, h3')).slice(0, 40).map((node) => ({
  tag: node.tagName.toLowerCase(),
  text: text(node.innerText, 120),
  selector: selectorOf(node),
}))

const formList = Array.from(document.querySelectorAll('form')).slice(0, 10).map((form) => ({
  action: form.getAttribute('action') || '',
  method: String(form.getAttribute('method') || 'get').toUpperCase(),
  selector: selectorOf(form),
  fields: Array.from(form.querySelectorAll('input, textarea, select, button')).slice(0, 40).map((field) => {
    let label = ''
    if (field.id) {
      const labelNode = document.querySelector('label[for="' + field.id + '"]')
      if (labelNode) label = text(labelNode.innerText, 60)
    }
    if (!label && field.closest) {
      const parentLabel = field.closest('label')
      if (parentLabel) label = text(parentLabel.innerText, 60)
    }
    if (!label) label = text(field.getAttribute('aria-label') || field.getAttribute('placeholder') || '', 60)
    return {
      tag: field.tagName.toLowerCase(),
      type: field.getAttribute('type') || '',
      name: field.getAttribute('name') || '',
      id: field.id || '',
      placeholder: field.getAttribute('placeholder') || '',
      label,
      required: field.required === true,
      selector: selectorOf(field),
    }
  }),
}))

const buttonList = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"], a.button')).slice(0, 40).map((node) => ({
  text: text(node.innerText || node.value || node.getAttribute('aria-label') || '', 80),
  selector: selectorOf(node),
  disabled: node.disabled === true,
}))

const linkList = Array.from(document.querySelectorAll('a[href]')).slice(0, 60).map((node) => ({
  text: text(node.innerText, 60),
  href: node.href || '',
}))

const tableList = Array.from(document.querySelectorAll('table')).slice(0, 10).map((table) => ({
  headers: Array.from(table.querySelectorAll('thead th, tr:first-child th')).slice(0, 30).map((th) => text(th.innerText, 40)),
  rows: table.querySelectorAll('tbody tr').length,
}))

const frameworks = []
try {
  if (window.React || document.querySelector('[data-reactroot], #__next, [data-reactid]')) frameworks.push('React')
  if (window.Vue || document.querySelector('[data-v-app]')) frameworks.push('Vue')
  if (window.__NEXT_DATA__) frameworks.push('Next.js')
  if (window.__NUXT__) frameworks.push('Nuxt')
  if (window.angular || document.querySelector('[ng-version]')) frameworks.push('Angular')
  if (window.jQuery) frameworks.push('jQuery')
  if (document.querySelector('meta[name="generator"]')) frameworks.push(text(meta('generator'), 80))
} catch (e) {}

const storageKeys = { local: [], session: [] }
try {
  for (let i = 0; i < localStorage.length; i += 1) storageKeys.local.push(localStorage.key(i))
} catch (e) {}
try {
  for (let i = 0; i < sessionStorage.length; i += 1) storageKeys.session.push(sessionStorage.key(i))
} catch (e) {}

const bodyText = text(document.body ? document.body.innerText : '', 3000)

return {
  url: location.href,
  title: document.title,
  lang: document.documentElement.lang || '',
  readyState: document.readyState,
  description: meta('description') || meta('og:description'),
  keywords: meta('keywords'),
  viewport: { width: innerWidth, height: innerHeight },
  document: {
    width: Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0),
    height: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0),
    elements: document.querySelectorAll('*').length,
  },
  frameworks,
  headings: headingList,
  forms: formList,
  buttons: buttonList,
  links: linkList,
  tables: tableList,
  landmarks: {
    header: document.querySelectorAll('header').length,
    nav: document.querySelectorAll('nav').length,
    main: document.querySelectorAll('main').length,
    aside: document.querySelectorAll('aside').length,
    footer: document.querySelectorAll('footer').length,
    iframes: document.querySelectorAll('iframe').length,
  },
  images: { count: document.images.length, missingAlt: Array.from(document.images).filter((img) => !img.alt).length },
  storageKeys,
  textExcerpt: bodyText,
}
