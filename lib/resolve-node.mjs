/**
 * 找一个「真 node」来跑 CDP 子进程。
 *
 * DSH 桌面端的主进程是 Electron，process.execPath 指向 DeepSeek Harness.exe，
 * 不带 ELECTRON_RUN_AS_NODE 时跑不了脚本。CDP 客户端需要 Node ≥ 22（内置
 * WebSocket / fetch），所以按 DSH_NODE → DSH 自带运行时 → PATH → Program Files
 * 的顺序探一遍，并用「写文件证明」验证（Electron 进程退出码 0 不代表真跑了）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const cache = new Map()

/** 真跑一段 JS，确认这个可执行文件是 node。 */
export function probeRuntime(file, env) {
  let dir
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-devtools-node-'))
    const proof = path.join(dir, 'proof')
    const result = spawnSync(file, ['-e', 'require("fs").writeFileSync(process.argv[1],process.versions.node)', proof], {
      env,
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    })
    return !result.error && result.status === 0 && /^\d+\./.test(fs.readFileSync(proof, 'utf8'))
  } catch {
    return false
  } finally {
    if (dir) {
      try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

/** 解析 node 运行时；返回 { file, env }。 */
export function resolveRuntime(dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')) {
  if (cache.has(dshHome)) return cache.get(dshHome)
  const env = process.env
  const home = env.USERPROFILE || env.HOME || os.homedir()
  const platform = process.platform
  const current = process.execPath
  const electron = Boolean(process.versions.electron)
  const bin = platform === 'win32' ? 'node.exe' : 'node'

  const candidates = [env.DSH_NODE, env.DSH_DESKTOP_NODE_EXECUTABLE]
  for (const root of new Set([path.join(dshHome, 'dsh-runtimes'), path.join(home, '.dsh', 'dsh-runtimes')])) {
    try {
      for (const dir of fs.readdirSync(root)) candidates.push(path.join(root, dir, 'dependencies', 'node', 'bin', bin))
    } catch { /* 没有这个运行时目录就算了 */ }
  }
  const separator = platform === 'win32' ? ';' : ':'
  for (const dir of String(env.PATH ?? '').split(separator)) {
    if (dir) candidates.push(path.join(dir.replace(/^"|"$/g, ''), bin))
  }
  if (platform === 'win32' && env.ProgramFiles) candidates.push(path.join(env.ProgramFiles, 'nodejs', bin))
  if (platform === 'darwin') candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
  if (!electron) candidates.push(current)

  for (const file of new Set(candidates.filter(Boolean))) {
    try {
      if (fs.statSync(file).isFile() && probeRuntime(file, env)) {
        const found = { file, env: { ...env } }
        cache.set(dshHome, found)
        return found
      }
    } catch { /* 下一个候选 */ }
  }
  if (electron) {
    const nodeEnv = { ...env, ELECTRON_RUN_AS_NODE: '1' }
    if (probeRuntime(current, nodeEnv)) {
      const found = { file: current, env: nodeEnv }
      cache.set(dshHome, found)
      return found
    }
  }
  throw new Error('[dsh-web-devtools] 找不到可执行脚本的 node 运行时；请把环境变量 DSH_NODE 设成真实 node（≥22）的绝对路径')
}
