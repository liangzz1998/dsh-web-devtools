# dsh-web-devtools

把网页 **F12 开发者工具**里的东西接给 DeepSeek Harness 的 agent，专门服务于两件事：

1. **看懂一个陌生网页**：它是干什么的、有什么内容和功能、DOM 长什么样
2. **给这个网页写自动化 / 爬虫脚本**：元素定位器、刚发生了什么、登录态在哪、文件怎么下载

基于 Chrome DevTools Protocol（CDP）——和 F12 面板用的是同一套协议，零第三方依赖。

```
用户：这个网站我要写个自动导出报表的脚本
agent → devtools_summary   ← 页面是干什么的、表单/按钮/表格
      → devtools_find      ← 「导出」按钮的唯一 CSS / XPath / role+name
      → devtools_storage   ← token 放在 localStorage 还是 cookie
      → devtools_activity  ← 先 start，用户点一遍「导出」，再 read 反推流程
      → devtools_download  ← 真的把文件下载下来（url 或点按钮）
```

---

## 工具（14 个）

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

## 下载是怎么做的

- `url` 模式：先取浏览器里对该域生效的 cookie，用 Node 直接请求并落盘（图片 / PDF / CSV / 接口 JSON 都行）；失败再退回浏览器下载通道。
- `selector` 模式：`Browser.setDownloadBehavior` 打开下载通道 → 真实点击页面元素 → 监听 `Browser.downloadWillBegin/downloadProgress` → 等文件落盘。
- 文件默认存到会话工作区的 `downloads/`，返回绝对路径；重名自动加 `(1)`。

---

## 为什么不是「浏览器扩展」

扩展要手动装、只能读自己页面、还要写消息中转。CDP 是浏览器自带的调试通道：
一个 `--remote-debugging-port` 就能拿到 F12 同款数据，并且能注入记录器、触发下载。

## 浏览器从哪来

插件会**自己拉起一个专用浏览器实例**（Edge 或 Chrome）：

- 独立 profile 目录：`%LOCALAPPDATA%\dsh-web-devtools\browser-profile`（登录态会保存）
- **不会影响你平时用的 Edge/Chrome**，也不要求你先关掉它
- 第一次调用任意工具时自动启动；之后一直复用
- 端口默认 `9333`；`cdpPort` 指向别的 Chromium 程序（比如豆包 9225）也能读

> Chrome/Edge 出于安全考虑不允许在「默认 profile」上开调试端口，所以用独立 profile。
> 需要某网站的登录态，在插件拉起的窗口里登录一次即可，下次还在。

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

```powershell
# 1. 链接进 desktop profile 的 node_modules
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-web-devtools" `
  -Target "D:\dsh-plugins\dsh-web-devtools"

# 2. 在 ~/.dsh/profiles/desktop/cordis.patch.yml 里挂载（见本仓库 cordis.patch.yml 的 insert 段）

# 3. 重启 DeepSeek Harness 生效（启用 HMR 的 profile 保存配置即热加载）
```

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 关掉 = 不注册任何工具 |
| `cdpPort` | `9333` | CDP 调试端口 |
| `browser` | `''` | 浏览器 exe，留空自动探测 Edge/Chrome |
| `userDataDir` | `''` | 浏览器 profile 目录，留空用 `%LOCALAPPDATA%\dsh-web-devtools\browser-profile` |
| `headless` | `false` | 是否无头运行（默认弹窗，方便看着 agent 操作） |
| `autoLaunch` | `true` | CDP 离线时读取类工具是否自动拉起浏览器 |
| `outSubdir` | `web-devtools` | 截图在会话工作区里的子目录 |
| `downloadSubdir` | `downloads` | 下载文件在会话工作区里的子目录 |
| `autoRecord` | `true` | 是否自动注入页面记录器 |
| `timeoutMs` | `60000` | 单次操作默认超时 |

---

## 工作原理 / 目录

```
lib/index.js        DSH 插件入口：注册 14 个工具，调用子进程
lib/cdp.mjs         CDP 传输层与全部底层能力（零依赖，Node 内置 fetch/WebSocket）
lib/page/*.js       页面侧脚本：recorder / summary / find / storage（由 CDP 注入执行）
lib/resolve-node.mjs 找到一个真 node（DSH 主进程是 Electron，不能直接跑脚本）
tools/devtools.mjs  子进程 CLI：stdin 收 JSON，stdout 回 JSON（带人话排版）
tests/e2e.mjs       端到端测试：真无头浏览器跑全部工具（52 项断言）
```

运行时调用链：

```
agent → devtools_find 工具
      → spawn node tools/devtools.mjs
      → 连 127.0.0.1:9333 的 CDP WebSocket
      → 注入 lib/page/find.js 并取回结构化结果
      → 文本结果回给 agent
```

## 测试

```powershell
cd D:\dsh-plugins\dsh-web-devtools
node tests/e2e.mjs
# 52/52 通过 → ALL PASS
```

## 已知边界

- 记录器只装在主页面：iframe / Shadow DOM 里的操作看不到（可用 `target` 换页，但跨 frame 需要单独处理）
- `network` 的 history 只有资源计时；live 有方法/状态/耗时/大小，但不含请求/响应体
- `storage` 读不到 HttpOnly cookie；纯内存 token（如某些 SPA 的闭包变量）也不在 storage 里
- 控制台回放的对象只展开第一层属性（最多 12 个）
- 浏览器进程重启前的日志读不到（日志存在页面进程里）
- `download` 的 `url` 模式依赖 cookie；需要特殊 header/签名的下载请用 `selector` 点页面按钮
- 无头模式可能被部分站点指纹检测拦，必要时 `headless: false`
