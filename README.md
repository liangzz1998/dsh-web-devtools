# dsh-web-devtools

把网页 **F12 开发者工具**里的东西接给 DeepSeek Harness 的 agent，专门服务于两件事：

1. **看懂一个陌生网页**：它是干什么的、有什么内容和功能、DOM 长什么样
2. **给这个网页写自动化 / 爬虫脚本**：元素定位器、刚发生了什么、登录态在哪、文件怎么下载

两条读取通道：

| 通道 | 读谁的页面 | 要不要装东西 |
|---|---|---|
| **专用浏览器**（默认） | 插件自己拉起的 Edge/Chrome 实例，独立 profile | 不用，开箱即用 |
| **浏览器扩展**（`target="current"`） | **你当前正在浏览的标签页**（你自己日常的浏览器） | 装一次扩展（加载解压缩目录即可） |

两条通道底层都是 Chrome DevTools Protocol（CDP）——和 F12 面板用的是同一套协议，零第三方依赖。

```
用户：这个网站我要写个自动导出报表的脚本
agent → devtools_summary   ← 页面是干什么的、表单/按钮/表格
      → devtools_find      ← 「导出」按钮的唯一 CSS / XPath / role+name
      → devtools_storage   ← token 放在 localStorage 还是 cookie
      → devtools_activity  ← 先 start，用户点一遍「导出」，再 read 反推流程
      → devtools_download  ← 真的把文件下载下来（url 或点按钮）
```

---

## 工具（17 个）

### 看懂页面
| 工具 | 作用 |
|---|---|
| `devtools_summary` | **页面概览**：标题/描述/框架（React/Vue/Next…）、主要标题、表单+字段、按钮、链接、表格、图片、栏目结构、正文摘录、疑似登录态存储键 |
| `devtools_dom` | **DOM**：html / text / outline 结构树 / attrs 属性 / rect 位置尺寸 |
| `devtools_eval` | **页面内执行 JS**（支持 await）：查全局变量、点按钮、提取数据 |
| `devtools_screenshot` | 截图（视口/整页）到会话工作区 |
| `devtools_pages` / `devtools_open` / `devtools_launch` / `devtools_status` | 页面列表 / 打开 URL / 启动调试浏览器 / 状态自检 |

### 写自动化脚本
| 工具 | 作用 |
|---|---|
| `devtools_find` | **元素定位器**：按 CSS 或文本找元素，返回唯一 CSS、XPath、role/name、文本定位、属性、当前值、坐标、可见性 —— 不用再手动去 F12 复制元素 |
| `devtools_activity` | **「刚刚发生了什么」时间线**：点击、输入、提交、fetch/XHR 请求、DOM 变化、SPA 跳转、控制台日志，按时间合并；先 `action=start` 让用户操作一遍，再 `action=read` 反推流程 |
| `devtools_console` | **控制台**：log/info/warn/error、未捕获异常、浏览器级日志；attach 时会回放历史日志 |
| `devtools_network` | **网络**：history（加载至今资源计时）/ live（实时抓包，可 reload 后抓） |
| `devtools_storage` | **登录态**：localStorage / sessionStorage / cookie，标出疑似 token/JWT |
| `devtools_download` | **下载文件**：`url` 直接下载（自动带浏览器 cookie），或 `selector` 点页面上的下载/导出按钮 |

### 读你当前正在浏览的页面（扩展）
| 工具 | 作用 |
|---|---|
| `devtools_live_status` | 扩展桥状态：hub 是否在跑、扩展是否连上、已接入哪些标签页、浏览器里开了哪些标签 |
| `devtools_live_attach` | 把扩展接入一个标签页（不传 id = 当前活动标签页） |
| `devtools_live_detach` | 断开（页面顶部「正在调试」提示消失） |

接入之后，所有读取工具都能用 **`target="current"`** 读你当前浏览器里的那个页面：
`devtools_console` / `devtools_dom` / `devtools_eval` / `devtools_summary` / `devtools_find` / `devtools_activity` / `devtools_storage` / `devtools_screenshot`。

---

## 怎么读「我当前正在浏览的页面」

### 原理

浏览器扩展有 `chrome.debugger` API —— 它就是 F12 用的那套 CDP，可以 attach 到任意标签页。
所以链路是：

```
你的浏览器（你正在看的标签页）
   │  扩展：chrome.debugger.attach(tabId)  → 收/发 CDP
   │  WebSocket  ws://127.0.0.1:9335/ext
   ▼
hub（插件自带的小进程，tools/hub.mjs）
   │  把扩展的 CDP 会话代理成标准 CDP：ws://127.0.0.1:9335/cdp?tab=…
   ▼
DSH 插件（lib/cdp.mjs 原样复用）
```

### 一次性安装扩展（约 30 秒）

1. 打开浏览器扩展页：Edge 地址栏输入 `edge://extensions`（Chrome 是 `chrome://extensions`）
2. 打开右下角（或左侧）的 **开发者模式**
3. 点 **加载解压缩的扩展**，选择目录：

   ```
   D:\dsh-plugins\dsh-web-devtools\extension
   ```

4. 装好后可以把它固定到工具栏

> 这个扩展不会自动更新，以后插件升级时重新点一下「重新加载」即可。
> 扩展权限说明：`debugger`（读开发者工具）、`tabs`（知道当前标签页）、`storage`（记住 hub 端口）。

### 使用

1. 在 DSH 里说「读一下我当前这个页面」，agent 调 `devtools_live_status`（会自动拉起 hub）
2. 你点浏览器工具栏上的扩展图标 → **接入当前标签页**
3. 之后 agent 用 `target="current"` 读控制台 / DOM / 网络 / 元素定位器 / 截图
4. 读完后点扩展 popup 的「断开」，或让 agent 调 `devtools_live_detach`

也可以反过来：先让 agent 调 `devtools_live_attach`，它会自动接入你当前活动的标签页。

### 页面跳转/导航之后还能读吗

**同标签页内跳转不用断开重接**——`chrome.debugger` 附加的是「标签页」而不是某个页面文档：

| 场景 | 读取能力 |
|---|---|
| 点了链接/按钮，**同一个标签页**整页跳转到网站另一个页面 | ✅ 会话跟着标签页走，直接继续读；新页面的 console 会重新收集 |
| SPA 路由跳转（`pushState` / hash 变化） | ✅ 同一文档，完全不受影响 |
| 点入口**新开了标签页/新窗口** | ✅ 默认 `followActiveTab: true`：下一次读取自动切到当前活动标签，旧会话自动断开，不用手动操作 |
| 手动切到另一个标签页 | ✅ 同上，读取时自动跟过去 |
| 标签页被关闭 / 跳到 `chrome://` 等特权页 | ⚠️ 会话失效；下一次 `target="current"` 会自动重新接入当前活动标签 |
| 闲置超过 10 分钟 | ⚠️ hub 自动 detach（避免黄条一直挂着）；下次读取自动重新接入 |

实现上 hub 会缓存每个标签页最近的控制台事件（并在主框架导航时清空旧页面的历史），
所以「先报错、后读取」和「导航后立刻读新页面」都成立。

> 扩展代码更新后，需要到 `edge://extensions` 点一下该扩展的「重新加载」才会生效。

### 限制（重要）

- 接入时标签页顶部会出现 **「正在调试此标签页」** 黄条，这是 chrome.debugger 的正常提示；点黄条上的「取消」或 popup 里的「断开」即可结束
- **同一个标签页不能同时开 F12**：一个标签页同一时刻只能被一个调试器占用；如果报「无法附加调试器」，先关掉该页的 F12
- **不能下载文件**：chrome.debugger 只有标签页级会话，不能设置浏览器下载通道；要下载请用专用浏览器模式（`devtools_download` 不带 `target="current"`）
- 只能读「当前可见、已加载」的标签页；跨 iframe / Shadow DOM 的操作看不到
- 扩展后台（MV3 service worker）可能被浏览器回收，会自动重连；hub 每 20 秒心跳保活
- 截图依赖标签页可见；最小化/后台标签可能截到空白

---

## 专用浏览器（默认通道）

插件会自己拉起一个专用浏览器实例（Edge 或 Chrome）：

- 独立 profile 目录：`%LOCALAPPDATA%\dsh-web-devtools\browser-profile`（登录态会保存）
- **不会影响你平时用的 Edge/Chrome**，也不要求你先关掉它
- 第一次调用任意工具时自动启动；之后一直复用
- 端口默认 `9333`；`cdpPort` 指向别的 Chromium 程序（比如豆包 9225）也能读
- 下载文件走浏览器下载通道，完全可用

### 多标签页怎么选

- 显式传 `target`：页面序号 / target id / 标题或 URL 片段
- 不传：优先**上次操作过的页面**（记在 `~/.dsh/web-devtools/state.json`）→ 当前可见/聚焦的页面 → 最近打开的 http 页面

## 页面侧记录器

`devtools_activity` 依赖注入到页面里的记录器（`window.__dshRecorder`）：

- 记录 click / input / change / submit / Enter、fetch 与 XHR、pushState/popstate/hashchange、DOM childList 变化（120ms 聚合）
- 单页最多 1200 条，值里的密码会打成 `***`
- `autoRecord: true` 时，`summary` / `find` / `dom` / `eval` 调用会顺手注入，之后的操作都会被记下

## 控制台为什么能读到「之前」的日志

CDP 的 `Runtime.enable` 会把页面**已经打过的 console 消息回放**给新客户端（Chrome 的
V8ConsoleMessageStorage 会重放，含对象内容），所以不需要常驻进程：先让页面报错，
再 `devtools_console`，照样看得到。`wait_ms` 还会抓 attach 之后新产生的日志。

---

## 安装

前提：Node ≥ 22（插件跑子进程用；DSH 自带运行时满足）、本机有 Edge 或 Chrome。

### 方式一：从 GitHub 安装（推荐）

```powershell
dsh plugin --profile desktop add "github:liangzz1998/dsh-web-devtools"
# 重启 DeepSeek Harness 生效（启用 HMR 的 profile 保存配置即热加载）
```

### 方式二：本地源码 link（开发用）

```powershell
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-web-devtools" `
  -Target "D:\dsh-plugins\dsh-web-devtools"

# 再在 ~/.dsh/profiles/desktop/cordis.patch.yml 里挂载（见本仓库 cordis.patch.yml 的 insert 段）
# 重启 DeepSeek Harness 生效
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉 = 不注册任何工具 |
| `cdpPort` | `9333` | 专用浏览器的 CDP 调试端口 |
| `browser` | `''` | 浏览器 exe，留空自动探测 Edge/Chrome |
| `userDataDir` | `''` | 专用浏览器 profile 目录 |
| `headless` | `false` | 专用浏览器是否无头 |
| `autoLaunch` | `true` | CDP 离线时是否自动拉起专用浏览器 |
| `outSubdir` | `web-devtools` | 截图在会话工作区里的子目录 |
| `downloadSubdir` | `downloads` | 下载文件在会话工作区里的子目录 |
| `autoRecord` | `true` | 是否自动注入页面记录器 |
| `hubPort` | `9335` | 扩展桥 hub 端口（扩展 popup 里可改） |
| `autoStartHub` | `true` | 插件加载时是否自动拉起 hub |
| `followActiveTab` | `true` | `target="current"` 时跟随当前活动标签页（换标签/新开页后自动切过去） |
| `timeoutMs` | `60000` | 单次操作默认超时 |

---

## 工作原理 / 目录

```
lib/index.js        DSH 插件入口：注册 17 个工具，调用子进程
lib/cdp.mjs         CDP 传输层与全部底层能力（零依赖，Node 内置 fetch/WebSocket）
lib/live.mjs        扩展桥封装：hub 状态 / 拉起 hub / attach·detach
lib/page/*.js       页面侧脚本：recorder / summary / find / storage（由 CDP 注入执行）
lib/resolve-node.mjs 找到一个真 node（DSH 主进程是 Electron，不能直接跑脚本）
tools/devtools.mjs  子进程 CLI：stdin 收 JSON，stdout 回 JSON（带人话排版）
tools/hub.mjs       扩展桥 hub：接扩展 WebSocket、代理成标准 CDP、HTTP 管理接口
tools/ws.mjs        零依赖 WebSocket 服务端实现（RFC 6455 子集）
extension/          浏览器扩展（MV3）：chrome.debugger → hub
tests/e2e.mjs       专用浏览器端到端测试（55 项断言）
tests/extension-e2e.mjs 扩展桥端到端测试：真 Edge + --load-extension 读「当前页」（17 项断言）
```

## 测试

```powershell
cd D:\dsh-plugins\dsh-web-devtools
node tests/e2e.mjs           # 专用浏览器：55/55
node tests/extension-e2e.mjs # 扩展桥读当前页：17/17（会自动起一个临时 Edge，不动你日常浏览器）
```

## 已知边界

- 扩展模式读不到 iframe / Shadow DOM 里的内容；只有标签页级会话
- 记录器只装在主页面；`network` 不含请求/响应体
- `storage` 读不到 HttpOnly cookie；纯内存 token 也不在 storage 里
- 控制台回放的对象只展开第一层属性（最多 12 个）
- 浏览器进程重启前的日志读不到（日志存在页面进程里）
- 无头模式可能被部分站点指纹检测拦，必要时 `headless: false`
- 关闭扩展或浏览器后，`target="current"` 会报「扩展未连接」，重新点扩展图标接入即可
