// 读取页面的本地存储 / Cookie（自动化脚本里常用来取 token、登录态）。
// 外层包成 (() => { const __args = ...; ... })()
const args = __args || {}
const maxValue = Math.max(80, Math.min(4000, Number(args.maxValue) || 600))

const readAll = (storage) => {
  const items = []
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i)
      let value = ''
      try { value = storage.getItem(key) == null ? '' : String(storage.getItem(key)) } catch (e) {}
      items.push({
        key: key,
        value: value.length > maxValue ? value.slice(0, maxValue) + '…' : value,
        length: value.length,
        looksLikeJson: value.trim().startsWith('{') || value.trim().startsWith('['),
      })
    }
  } catch (e) {}
  return items
}

const parseCookies = () => {
  try {
    return String(document.cookie || '').split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
      const index = part.indexOf('=')
      return {
        name: index >= 0 ? part.slice(0, index) : part,
        value: index >= 0 ? part.slice(index + 1) : '',
      }
    })
  } catch (e) {
    return []
  }
}

const localStorageItems = readAll(localStorage)
const sessionStorageItems = readAll(sessionStorage)
const cookies = parseCookies()

const tokenPattern = /token|auth|jwt|session|ticket|user|uid|login|csrf|xsrf/i
const tokenishKeys = []
for (const item of localStorageItems.concat(sessionStorageItems)) {
  if (tokenPattern.test(item.key)) tokenishKeys.push(item.key)
}
for (const cookie of cookies) {
  if (tokenPattern.test(cookie.name)) tokenishKeys.push('cookie:' + cookie.name)
}

return {
  url: location.href,
  localStorage: localStorageItems,
  sessionStorage: sessionStorageItems,
  cookies: cookies,
  tokenishKeys: tokenishKeys,
  counts: {
    local: localStorageItems.length,
    session: sessionStorageItems.length,
    cookies: cookies.length,
  },
}
