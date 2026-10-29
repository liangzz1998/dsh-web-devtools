/**
 * 「扩展桥」的插件侧封装。
 *
 * hub 是个独立进程（tools/hub.mjs），负责：
 *   - 接浏览器扩展的 WebSocket（chrome.debugger 的 CDP 会话）
 *   - 把会话代理成标准 CDP WebSocket（ws://127.0.0.1:9335/cdp?tab=…）
 *   - 提供 HTTP 管理接口 /status /attach /detach
 *
 * 这里只做：读状态、必要时拉起 hub、调 attach/detach。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_HUB_PORT = 9335
export const HUB_VERSION = '0.3.0'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HUB_SCRIPT = path.join(HERE, '..', 'tools', 'hub.mjs')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function stateDir() {
  return path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'web-devtools')
}

export function liveFile() {
  return path.join(stateDir(), 'live.json')
}

/** hub 写下的最近状态（可能过期，调用前最好再查一次 /status）。 */
export function readLiveState() {
  try { return JSON.parse(fs.readFileSync(liveFile(), 'utf8')) } catch { return null }
}

/** 查 hub 是否在线 + 扩展状态。 */
export async function hubStatus(port = DEFAULT_HUB_PORT, timeoutMs = 2500) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/status`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return { online: false }
    const data = await response.json()
    if (!data || data.service !== 'dsh-web-devtools-hub') return { online: false }
    return { online: true, ...data }
  } catch {
    return { online: false }
  }
}

/**
 * 确保 hub 在跑（没有就 detached 拉起来）。
 * @param {{port?: number, autoStart?: boolean, nodeFile?: string, env?: object, logFile?: string}} options
 */
export async function ensureHub(options = {}) {
  const port = Number(options.port) > 0 ? Number(options.port) : DEFAULT_HUB_PORT
  const status = await hubStatus(port)
  if (status.online) return status
  if (options.autoStart === false) return { online: false }
  const nodeFile = options.nodeFile || process.execPath
  const logFile = options.logFile || path.join(stateDir(), 'hub.log')
  try { fs.mkdirSync(path.dirname(logFile), { recursive: true }) } catch { /* ignore */ }
  let out = 'ignore'
  try { out = fs.openSync(logFile, 'a') } catch { /* ignore */ }
  try {
    const child = spawn(nodeFile, [HUB_SCRIPT, `--port=${port}`], {
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
      env: options.env || process.env,
    })
    child.unref()
  } catch (error) {
    return { online: false, error: '启动 hub 失败：' + String((error && error.message) || error) }
  }
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    await sleep(200)
    const next = await hubStatus(port)
    if (next.online) return next
  }
  return { online: false, error: 'hub 启动超时（8s）' }
}

async function hubPost(port, pathname, body) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(25000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.message || data.error || `HTTP ${response.status}`)
  return data
}

/** 让扩展 attach 一个标签页（不传 tabId = 当前活动标签页）。 */
export async function attachLive(port, tabId) {
  return hubPost(port, '/attach', tabId ? { tabId: Number(tabId) } : {})
}

/** 断开（不传 tabId = 全部断开）。 */
export async function detachLive(port, tabId) {
  return hubPost(port, '/detach', tabId ? { tabId: Number(tabId) } : {})
}
