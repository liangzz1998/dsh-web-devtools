/**
 * dsh-web-devtools —— 把网页「F12 开发者工具」里的东西接给 DSH 的 agent。
 *
 * 能力：控制台（含历史回放）、DOM、页面内 JS 求值、网络请求、截图、页面列表/打开。
 * 原理：Chrome DevTools Protocol（CDP）—— 和 F12 面板用的是同一套协议。
 * 架构：插件只是薄壳，真正连 CDP 的是 tools/devtools.mjs 子进程（真 node，零依赖）。
 *
 * @module dsh-web-devtools
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { resolveRuntime } from './resolve-node.mjs'
import { ensureHub } from './live.mjs'

export const name = 'dsh-web-devtools'

/** 需要 DSH 的工具注册表与会话工作目录。 */
export const inject = ['tools', 'workingDirectory']

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(HERE, '..', 'tools', 'devtools.mjs')

const DEFAULTS = {
  enabled: true,
  /** CDP 调试端口：插件用它拉起/连接浏览器 */
  cdpPort: 9333,
  /** 浏览器 exe；留空 = 自动探测 Edge / Chrome */
  browser: '',
  /** 浏览器 profile 目录；留空 = %LOCALAPPDATA%\dsh-web-devtools\browser-profile */
  userDataDir: '',
  /** 默认是否无头（false = 弹出可见窗口，方便用户看着 agent 操作） */
  headless: false,
  /** CDP 不在线时是否自动拉起浏览器 */
  autoLaunch: true,
  /** 截图落在会话工作区的这个子目录 */
  outSubdir: 'web-devtools',
  /** 下载文件落在会话工作区的这个子目录 */
  downloadSubdir: 'downloads',
  /** 是否自动注入页面记录器（点击/输入/请求/DOM 变化） */
  autoRecord: true,
  /** 扩展桥 hub 端口（读取「你当前浏览的标签页」用） */
  hubPort: 9335,
  /** 需要扩展桥时是否自动拉起 hub 进程 */
  autoStartHub: true,
  /** 单次操作默认超时（毫秒） */
  timeoutMs: 60000,
}

/** 合并配置。 */
export function resolveConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const positiveNumber = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback)
  return {
    enabled: config.enabled === undefined ? DEFAULTS.enabled : Boolean(config.enabled),
    cdpPort: positiveNumber(config.cdpPort, DEFAULTS.cdpPort),
    browser: typeof config.browser === 'string' ? config.browser.trim() : DEFAULTS.browser,
    userDataDir: typeof config.userDataDir === 'string' ? config.userDataDir.trim() : DEFAULTS.userDataDir,
    headless: config.headless === undefined ? DEFAULTS.headless : Boolean(config.headless),
    autoLaunch: config.autoLaunch === undefined ? DEFAULTS.autoLaunch : Boolean(config.autoLaunch),
    outSubdir: typeof config.outSubdir === 'string' && config.outSubdir.trim() ? config.outSubdir.trim() : DEFAULTS.outSubdir,
    downloadSubdir: typeof config.downloadSubdir === 'string' && config.downloadSubdir.trim() ? config.downloadSubdir.trim() : DEFAULTS.downloadSubdir,
    autoRecord: config.autoRecord === undefined ? DEFAULTS.autoRecord : Boolean(config.autoRecord),
    hubPort: positiveNumber(config.hubPort, DEFAULTS.hubPort),
    autoStartHub: config.autoStartHub === undefined ? DEFAULTS.autoStartHub : Boolean(config.autoStartHub),
    timeoutMs: positiveNumber(config.timeoutMs, DEFAULTS.timeoutMs),
  }
}

/**
 * 跑一次 tools/devtools.mjs 子进程，返回它打印的 JSON。
 * @param {{file: string, env: object}} runtime
 * @param {object} payload
 * @param {{signal?: AbortSignal, timeoutMs: number}} options
 */
function runDevtools(runtime, payload, options) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (!settled) {
        settled = true
        resolve(value)
      }
    }
    let child
    try {
      child = spawn(runtime.file, [CLI, '--stdin-json', '--json'], {
        env: runtime.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      finish({ ok: false, error: '启动 node 子进程失败：' + (error?.message || error) })
      return
    }

    const stdout = []
    const stderr = []
    child.stdout.on('data', (chunk) => stdout.push(chunk))
    child.stderr.on('data', (chunk) => stderr.push(chunk))

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: `devtools 操作超时（>${Math.round(options.timeoutMs / 1000)}s）` })
    }, options.timeoutMs + 30000)

    const onAbort = () => {
      try { child.kill() } catch { /* ignore */ }
      finish({ ok: false, error: '调用被取消' })
    }
    if (options.signal) {
      if (options.signal.aborted) onAbort()
      else options.signal.addEventListener('abort', onAbort, { once: true })
    }

    child.on('error', (error) => {
      clearTimeout(timer)
      finish({ ok: false, error: 'node 子进程错误：' + (error?.message || error) })
    })
    child.on('close', () => {
      clearTimeout(timer)
      const text = Buffer.concat(stdout).toString('utf8').trim()
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      // 约定：stdout 最后一行 JSON 就是结果
      const lines = text.split(/\r?\n/).filter(Boolean)
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index]
        if (!line.startsWith('{')) continue
        try {
          finish(JSON.parse(line))
          return
        } catch { /* 继续找 */ }
      }
      finish({ ok: false, error: (errorText || text || 'devtools 没有返回结果').slice(-2000) })
    })

    try {
      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    } catch (error) {
      clearTimeout(timer)
      finish({ ok: false, error: '写入子进程失败：' + (error?.message || error) })
    }
  })
}

/** 文本输出：工具结果就是人/agent 直接读的文字。 */
const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value ?? '') }],
}

const TARGET_DESCRIPTION = '目标页面：页面序号（devtools_pages 里的 [0]）、target id，或标题/URL 片段；'
  + '传 "current" = 你当前浏览器里接入的那个标签页（需要装一次扩展，见 devtools_live_status）；'
  + '省略 = 插件专用浏览器的最近页面。'

const COMMON_TARGET = {
  type: 'string',
  description: TARGET_DESCRIPTION,
}

/**
 * 插件入口。
 * @param {object} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  if (!config.enabled) return

  let runtime
  try {
    runtime = resolveRuntime(process.env.DSH_HOME)
  } catch (error) {
    console.error('[dsh-web-devtools] ' + (error?.message || error))
    return
  }

  // 加载标记：出问题时能判断插件到底有没有被宿主加载
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
    const markerDir = path.join(home, 'web-devtools')
    fs.mkdirSync(markerDir, { recursive: true })
    fs.writeFileSync(path.join(markerDir, 'plugin-loaded.json'), JSON.stringify({
      loadedAt: new Date().toISOString(),
      port: config.cdpPort,
      tools: ['devtools_status', 'devtools_launch', 'devtools_pages', 'devtools_open', 'devtools_console', 'devtools_dom', 'devtools_eval', 'devtools_network', 'devtools_screenshot', 'devtools_summary', 'devtools_find', 'devtools_activity', 'devtools_storage', 'devtools_download', 'devtools_live_status', 'devtools_live_attach', 'devtools_live_detach'],
    }, null, 2))
  } catch { /* 标记写不了不影响功能 */ }

  // 后台把扩展桥 hub 拉起来：这样浏览器扩展一启动就能连上，用户不用先手动触发
  if (config.autoStartHub) {
    void ensureHub({
      port: config.hubPort,
      autoStart: true,
      nodeFile: runtime.file,
      env: runtime.env,
    }).catch(() => { /* hub 起不来不影响专用浏览器模式 */ })
  }

  const call = async (payload, exec, timeoutMs) => {
    const result = await runDevtools(runtime, { ...payload, config }, {
      signal: exec?.signal,
      timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : config.timeoutMs,
    })
    if (!result || result.ok !== true) throw new Error(result?.error || 'devtools 调用失败（无返回）')
    return String(result.text ?? '')
  }

  ctx.tools.register({
    name: 'devtools_status',
    description: [
      '检查网页调试桥（CDP）状态：浏览器是否在线、端口、可执行文件、用户数据目录、已打开的页面列表。',
      '读控制台/DOM 之前不确定环境时先用它；它不会启动浏览器。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      return call({ op: 'status' }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_launch',
    description: [
      '启动（或复用）一个带 CDP 调试端口的 Edge/Chrome，用来给 agent 读取 F12 信息。',
      '用的是插件专用 profile（登录态会保存），不会影响用户平时用的浏览器；不需要先关掉用户的浏览器。',
      '已有实例在跑时直接复用，不会重复启动。可选 url 直接打开一个页面。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '启动后要打开的 URL（可选，默认 about:blank）' },
        headless: { type: 'boolean', description: '是否无头运行（默认跟随插件配置，通常是有界面窗口）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({ op: 'launch', url: args.url, headless: args.headless }, exec, Math.max(config.timeoutMs, 60000))
    },
  })

  ctx.tools.register({
    name: 'devtools_pages',
    description: '列出浏览器里所有可调试的页面（序号、标题、URL、target id）。多标签页时用来挑目标。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      return call({ op: 'pages' }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_open',
    description: [
      '在调试浏览器里打开一个 URL（默认新标签页；new_tab=false 时让当前页面导航过去），并等页面加载完成。',
      '返回页面标题/URL/id，之后可以用 devtools_console / devtools_dom 等读取它。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的 URL（http/https/file 等）' },
        new_tab: { type: 'boolean', description: '是否新开标签页（默认 true）' },
        target: { ...COMMON_TARGET, description: 'new_tab=false 时导航哪个页面，见目标页面说明' },
      },
      required: ['url'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({ op: 'open', url: args.url, new_tab: args.new_tab, target: args.target }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_console',
    description: [
      '读取网页 F12 控制台（Console）：console.log/info/warn/error、未捕获异常、浏览器级日志。',
      '基于 CDP 的 Runtime 域，attach 时会把页面已经打过的日志回放出来，所以「先有日志、后读」也能看到；',
      'wait_ms 内新产生的日志也会一并抓到。可按级别和关键字过滤。',
      '用户说「网页报错了 / 看看控制台 / 有没有 JS 错误」时用它。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        level: {
          type: 'string',
          enum: ['all', 'error', 'warn', 'info', 'log', 'debug'],
          description: '最低级别：error 只看错误；warn 看警告+错误；all 全看（默认 all）',
        },
        filter: { type: 'string', description: '只保留文本或 URL 里包含该关键字的消息' },
        limit: { type: 'number', description: '最多返回最后多少条（默认 100，上限 500）' },
        wait_ms: { type: 'number', description: 'attach 后继续监听多少毫秒以捕获新日志（默认 600）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'console',
        target: args.target,
        level: args.level,
        filter: args.filter,
        limit: args.limit,
        wait_ms: args.wait_ms,
      }, exec, Math.max(config.timeoutMs, (Number(args.wait_ms) || 600) + 30000))
    },
  })

  ctx.tools.register({
    name: 'devtools_dom',
    description: [
      '读取网页 DOM（F12 的 Elements 面板）：',
      '- mode=html（默认）：整页或指定元素的 outerHTML',
      '- mode=text：innerText 纯文本',
      '- mode=outline：带缩进的结构树（标签、id、class、短文本），最适合快速看页面结构',
      '- mode=attrs：某元素的全部属性；mode=rect：位置尺寸与显示状态',
      'selector 用 CSS 语法（#app .list li、[data-testid="submit"]）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        selector: { type: 'string', description: 'CSS 选择器（可选；不填 = 整页文档）' },
        mode: { type: 'string', enum: ['html', 'text', 'outline', 'attrs', 'rect'], description: '读取模式（默认 html）' },
        depth: { type: 'number', description: 'outline 模式的结构树深度（默认 4，上限 40）' },
        max_chars: { type: 'number', description: 'html/text 返回的最大字符数（默认 20000）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'dom',
        target: args.target,
        selector: args.selector,
        mode: args.mode,
        depth: args.depth,
        max_chars: args.max_chars,
      }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_eval',
    description: [
      '在网页里执行 JS 并返回结果（相当于 F12 的 Console 里敲代码），支持 await。',
      'expression 可以是表达式（document.title、[...document.querySelectorAll("a")].map(a=>a.href)）',
      '也可以是语句（先赋值/点按钮，再 return 结果；插件会自动包成 async 函数兜底）。',
      '读取页面全局变量、调用页面函数、点击元素、提取数据都可以用它。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        expression: { type: 'string', description: '要执行的 JS 源码' },
        await_promise: { type: 'boolean', description: '是否等待 Promise 结果（默认 true）' },
        timeout_ms: { type: 'number', description: '页面内执行超时（毫秒，默认 15000）' },
      },
      required: ['expression'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'eval',
        target: args.target,
        expression: args.expression,
        await_promise: args.await_promise,
        timeout_ms: args.timeout_ms,
      }, exec, Math.max(config.timeoutMs, (Number(args.timeout_ms) || 15000) + 30000))
    },
  })

  ctx.tools.register({
    name: 'devtools_network',
    description: [
      '读取网页网络请求（F12 的 Network 面板）：',
      '- mode=history（默认）：页面加载至今的资源计时（名称、类型、状态码、耗时、大小），无需实时抓包',
      '- mode=live：实时抓 wait_ms 内的请求（方法、状态码、类型、耗时、大小）；reload=true 会先刷新页面再抓',
      '用户说「看看请求 / 接口有没有 404 / 抓一下网络」时用它。实时模式抓不到请求体/响应头。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        mode: { type: 'string', enum: ['history', 'live'], description: 'history=历史资源计时；live=实时抓包（默认 history）' },
        filter: { type: 'string', description: '只保留 URL 里包含该关键字的请求' },
        limit: { type: 'number', description: '最多返回多少条（默认 100，上限 1000）' },
        wait_ms: { type: 'number', description: 'live 模式的抓取窗口（毫秒，默认 2500，最大 60000）' },
        reload: { type: 'boolean', description: 'live 模式：是否先刷新页面再抓（默认 false）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'network',
        target: args.target,
        mode: args.mode,
        filter: args.filter,
        limit: args.limit,
        wait_ms: args.wait_ms,
        reload: args.reload,
      }, exec, Math.max(config.timeoutMs, (Number(args.wait_ms) || 2500) + 45000))
    },
  })

  ctx.tools.register({
    name: 'devtools_screenshot',
    description: [
      '给网页截图并保存到会话工作区，返回图片绝对路径（可用 read_image 打开查看）。',
      'full_page=true 截整页（自动按文档高度），否则只截当前视口。用来确认页面长什么样、元素有没有渲染出来。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        full_page: { type: 'boolean', description: '是否整页截图（默认 false）' },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式（默认 png）' },
        quality: { type: 'number', description: 'jpeg 质量 1-100（默认 80）' },
        filename: { type: 'string', description: '文件名（可选，不带扩展名也行）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const outDir = path.join(cwd, config.outSubdir)
      return call({
        op: 'screenshot',
        target: args.target,
        full_page: args.full_page,
        format: args.format,
        quality: args.quality,
        filename: args.filename,
        outDir,
      }, exec, Math.max(config.timeoutMs, 120000))
    },
  })

  ctx.tools.register({
    name: 'devtools_summary',
    description: [
      '一次性了解这个网页是干什么用的、有什么内容和功能（相当于把 F12 里 Elements + 页面信息扫一遍）：',
      '标题/描述/语言/框架（React/Vue/Next…）、主要标题、表单和字段、按钮、链接、表格、图片、',
      '栏目结构、正文摘录、登录态存储键。',
      '接到一个陌生网页、或要给某个网站写自动化脚本之前，先跑它建立整体认识。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { target: COMMON_TARGET },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({ op: 'summary', target: args.target }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_find',
    description: [
      '按 CSS 选择器或文本找元素，返回**可以直接写进自动化脚本的定位器**：',
      '唯一 CSS 选择器、XPath、role/name、文本定位、属性、当前值、坐标与可见性。',
      '用它代替「手动去 F12 复制元素再发给 agent」。',
      'selector 和 text 至少给一个：selector 用 CSS（#app .item）；text 按元素自身文本匹配（如「提交」「下载」）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        selector: { type: 'string', description: 'CSS 选择器（如 #submit、.list .item、[data-testid="btn"]）' },
        text: { type: 'string', description: '按元素文本搜索（如「提交」「导出」「下一页」）' },
        tag: { type: 'string', description: '只保留某个标签（如 button、a、input）' },
        limit: { type: 'number', description: '最多返回多少个（默认 20，上限 100）' },
        include_hidden: { type: 'boolean', description: '是否包含隐藏元素（默认 false）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'find',
        target: args.target,
        selector: args.selector,
        text: args.text,
        tag: args.tag,
        limit: args.limit,
        include_hidden: args.include_hidden,
      }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_activity',
    description: [
      '看页面「刚刚发生了什么」：点击、输入、提交、网络请求（fetch/XHR）、DOM 变化、SPA 跳转、',
      '控制台日志，按时间线合并显示。写自动化脚本时用来反推操作流程。',
      '推荐用法：先 action=start 开记录 → 用户手动操作页面 → action=read 看时间线。',
      '不先 start 也能读：读取时会自动注入记录器，但只能看到注入之后的事件（控制台历史日志仍会回放）。',
      'action=stop 暂停记录，action=clear 清空重来。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        action: { type: 'string', enum: ['read', 'start', 'stop', 'clear'], description: '默认 read' },
        since_ms: { type: 'number', description: '只看最近多少毫秒内的事件（默认 300000 = 5 分钟）' },
        limit: { type: 'number', description: '最多返回多少条（默认 200）' },
        include_console: { type: 'boolean', description: '是否合并控制台日志（默认 true）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'activity',
        target: args.target,
        action: args.action,
        since_ms: args.since_ms,
        limit: args.limit,
        include_console: args.include_console,
      }, exec, Math.max(config.timeoutMs, 90000))
    },
  })

  ctx.tools.register({
    name: 'devtools_storage',
    description: [
      '读取页面的 localStorage / sessionStorage / cookie（含疑似 token、JWT、登录态），',
      '写需要登录态的自动化脚本时用来确认鉴权信息放在哪。',
      '注意：HttpOnly cookie 在页面里读不到（这里只列 document.cookie 可见的部分）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        show_values: { type: 'boolean', description: '是否显示值（默认 true；false 只显示键和长度）' },
        max_value: { type: 'number', description: '每个值最多显示多少字符（默认 600）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({
        op: 'storage',
        target: args.target,
        show_values: args.show_values,
        max_value: args.max_value,
      }, exec)
    },
  })

  ctx.tools.register({
    name: 'devtools_download',
    description: [
      '从网页下载文件（自动化里的「导出 / 下载」环节）：',
      '- url：直接下载一个 URL（自动带上浏览器里的 cookie，适合图片、PDF、CSV、接口返回的文件）',
      '- selector：点页面上的下载/导出按钮触发下载（适合 JS 生成的 blob、需要点按钮的导出）',
      '文件保存到会话工作区的默认下载目录，返回本地绝对路径。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        target: COMMON_TARGET,
        url: { type: 'string', description: '要下载的 URL（和 selector 二选一）' },
        selector: { type: 'string', description: '触发下载的元素选择器（和 url 二选一）' },
        timeout_ms: { type: 'number', description: '等待下载完成的超时（默认 120000）' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
      const dir = path.join(cwd, config.downloadSubdir)
      return call({
        op: 'download',
        target: args.target,
        url: args.url,
        selector: args.selector,
        timeout_ms: args.timeout_ms,
        dir,
      }, exec, Math.max(config.timeoutMs, (Number(args.timeout_ms) || 120000) + 30000))
    },
  })

  ctx.tools.register({
    name: 'devtools_live_status',
    description: [
      '查看「读取你当前浏览器正在浏览的页面」这条通道的状态：本地 hub 是否在跑、浏览器扩展是否已连接、已接入哪些标签页、以及浏览器里打开了哪些标签。',
      '第一次调用会自动启动 hub；之后需要你在浏览器里点开「DSH Web DevTools Bridge」扩展图标 → 点「接入当前标签页」。',
      '扩展只需安装一次（扩展目录在插件的 extension/ 下，浏览器「扩展 → 开发者模式 → 加载解压缩的扩展」）。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      return call({ op: 'live-status' }, exec, 30000)
    },
  })

  ctx.tools.register({
    name: 'devtools_live_attach',
    description: [
      '把浏览器扩展接入一个标签页（不传 tab_id = 当前活动标签页），之后所有读取工具都能用 target="current" 直接读你正在看的页面。',
      '注意：接入期间标签页顶部会有「正在调试此标签页」提示，且该标签页不能同时开 F12；读完可调 devtools_live_detach 断开。',
      '首次使用需要先在浏览器扩展里安装并连接（见 devtools_live_status）。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: '要接入的标签页 id（devtools_live_status 里能看到），省略 = 当前活动标签页' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({ op: 'live-attach', tab_id: args.tab_id }, exec, 40000)
    },
  })

  ctx.tools.register({
    name: 'devtools_live_detach',
    description: '断开扩展桥接入的标签页（不传 tab_id = 全部断开），页面顶部的「正在调试」提示会消失。',
    parameters: {
      type: 'object',
      properties: {
        tab_id: { type: 'number', description: '要断开的标签页 id，省略 = 全部断开' },
      },
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return call({ op: 'live-detach', tab_id: args.tab_id }, exec, 30000)
    },
  })
}

export default { name, inject, apply }
