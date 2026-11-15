# LaTeX Preview — 开发文档

**文档定位**：本文档交付给一位独立开发者在 4–6 周内完成从脚手架到上架 DSH 插件商店的完整开发。技术栈围绕“DSH 原生插件 + 本地 Tectonic 编译引擎 + Web 端 PDF.js 渲染”展开。

**隐私边界声明**：编译、渲染、SyncTeX 跳转、diff 计算**全部在本机完成，稿件内容不出本机**。但“错误回传 Agent”“PDF 批注发 Agent”两项功能会将**错误上下文 / 批注锚点与用户指令**发送至 DSH Agent 服务。README 与插件首次启用时必须明确告知此边界，并提供“错误脱敏”开关（只发错误消息与行号，不发源码上下文）。

---

## 0. 依赖与平台

| 依赖 | 说明 |
|---|---|
| `@deepseek-ai/cordis` | DSH 插件框架，API 以官方文档为准；DSH developer preview 期间建议锁定精确版本（见坑 7） |
| `@deepseek-ai/dsh-llm` | `createUserMessage` 来源 |
| `pdfjs-dist` | 选择与当前 DSH Web UI 兼容的稳定版；DOM 适配层见 3.2 |
| `diff-match-patch` | 行级 diff 惯用法稳定 |
| `chokidar` | 使用 3.x 稳定线（v4 有 breaking change） |
| `tectonic` | 二进制由用户环境提供，插件启动时校验可用性 |
| `synctex` | 随 Tectonic 分发，启动时一并校验 |

**平台支持矩阵**：`win-x64` / `macos-universal` / `linux-x64` 官方二进制可用；`win-arm64` / `linux-arm64` 需用户 `cargo install tectonic`，README 如实标注。

---

## 1. 技术选型

| 层级 | 选型 | 备选方案 | 选择理由 |
|---|---|---|---|
| 宿主框架 | DSH 插件（Cordis 双半结构） | 独立 Electron / Web 应用 | 直接吃到 DSH 生态，AI 能力零成本复用 |
| 编译引擎 | **Tectonic**（单一二进制） | latexmk + TeX Live 全家桶 | 免配置、跨平台、自动按需下载依赖包 |
| 正反跳转 | **SyncTeX**（synctex CLI） | 手写行号映射 | 事实标准，`--synctex` 生成 `.synctex.gz` |
| PDF 渲染 | **PDF.js** | pdfium / native | Web 端唯一成熟方案 |
| Diff 引擎 | **diff-match-patch**（行级） | 自写 Myers diff | `diff_linesToChars_` 做行级 diff 稳定可靠 |
| 源码编辑器 | **CodeMirror 6** / Monaco（备选） | — | DSH 是 Web UI，CodeMirror 6 轻量、行号 API 与 SyncTeX 映射直接 |
| 语言 | TypeScript | Rust + WASM | 与 DSH 生态同栈 |

> **说明**：DSH 是独立 Web UI，不存在“VS Code 原生编辑器”可嵌入。主选 CodeMirror 6，备选 Monaco。

---

## 2. 架构总览

```
┌──────────────────────── DSH Web UI（浏览器）────────────────────────────┐
│  ┌─ 源码栏 ────────┐  ┌─ PDF 预览栏 ─────────┐  ┌─ Diff 面板 ────────────┐  │
│  │ CodeMirror 6    │  │ PDF.js iframe         │  │ diff-match-patch      │  │
│  │ 行号 + diff 标记 │  │ SyncTeX 高亮 overlay   │  │ 行级 diff 视图        │  │
│  └──────┬──────────┘  └─────────┬─────────────┘  └──────────┬────────────┘  │
│         │ 光标行变更 / 双击      │ 双击 / 圈选                │ 一键发给 Agent │
└─────────┼───────────────────────┼───────────────────────────┼───────────────┘
          │ ctx.inject / ctx.get    │ postMessage（iframe 内）    │ agent.steer()
┌─────────▼───────────────────────▼───────────────────────────▼───────────────┐
│                    Host 半（Node.js，Cordis 插件）                          │
│  ┌─ FileWatcher ──┐  ┌─ CompileService ───┐  ┌─ SyncTeXService ──────────┐ │
│  │ chokidar       │→ │ 防抖 + Tectonic     │→ │ synctex view/edit        │ │
│  │ .tex/.bib/.sty │  │ --synctex 增量编译  │  │ 子进程 + 产物管理         │ │
│  └────────────────┘  └─────────┬───────────┘  └──────────────────────────┘ │
│  ┌─ DiffService ───┐  ┌─ ErrorParser ──────┐  ┌─ AgentBridge ────────────┐ │
│  │ 行级 diff + 行号 │  │ .log 解析 error/   │  │ createUserMessage()     │ │
│  │ 旧版 vs 新版     │  │ warning 双级       │  │ + agent.steer() 提交    │ │
│  └─────────────────┘  └────────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Host ↔ Client 通信契约

Cordis 的核心约定：**所有服务、事件和生命周期 API 都通过 `ctx` 访问**；服务由插件通过 `Service` 基类注册，消费方通过 `inject` 声明依赖，或在 `apply` 时用 `ctx.inject(deps, cb)` 延迟获取。

**Host 半：用 `Service` 基类注册服务**。官方教程明确：`Service` 子类在构造函数中调用 `super(ctx, name)` 将自身注册为 `ctx.<name>`，注册随所属 fiber 自动移除。

```typescript
// src/services/latex-preview-service.ts
import { Service, type Context } from '@deepseek-ai/cordis'

export class LatexPreviewService extends Service {
  constructor(ctx: Context, private compile: CompileService, private synctex: SyncTeXService, private diff: DiffService, private bridge: AgentBridge) {
    super(ctx, 'latexPreview')
  }

  compileRoot(rootFile: string) { return this.compile.run(rootFile) }
  onCompiled(cb: (r: CompileResult) => void) { this.compile.on('compiled', cb) }
  synctexView(line: number) { return this.synctex.view(line) }
  synctexEdit(page: number, x: number, y: number) { return this.synctex.edit(page, x, y) }
  getDiff() { return this.diff.getLatest() }
  sendErrorToAgent(errorId: string) { return this.bridge.send(errorId) }
}

// src/index.ts
export function apply(ctx: Context, config: Config) {
  const compile = new CompileService(config)
  const synctex = new SyncTeXService()
  const diff = new DiffService()
  const bridge = new AgentBridge(config)
  ctx.plugin(LatexPreviewService, compile, synctex, diff, bridge)
}
```

**Host 半获取其他服务：`ctx.inject` 优先于 `ctx.get`**。官方双半指南明确指出：应在 `ctx.inject(deps, cb)` 中获取依赖，而非在 `apply` 时直接 `ctx.get()`，因为服务 fiber 在 apply 时可能尚不存在。例如，Host 半需要 `webServer` 来暴露 PDF 静态路由：

```typescript
ctx.inject(['webServer'], (wctx) => {
  const webServer = wctx.get('webServer')
  const dispose = webServer.register({ kind: 'exact', path: '/.latex-preview', handler: ... })
  wctx.effect(() => dispose, 'latex-preview: static route')
})
```

**Client 半：通过 `inject` 声明依赖，或用 `ctx.get` 可选获取**。官方文档说明：`inject` 用于硬性依赖，保证 `apply` 时服务已就绪；若功能缺失时插件仍可运行，则跳过 `inject` 并在使用处用 `ctx.get` 探测。

```typescript
// src/client/index.tsx
export const name = 'latex-preview-client'
export const inject = ['latexPreview']   // 硬性依赖：Host 半服务

export function apply(ctx: ClientContext) {
  const api = ctx.latexPreview             // inject 保证已就绪
  api.onCompiled((result) => { ... })
  ctx.slots.inject('editor.panel.item', () =>
    ctx.slots.register({ name: 'latex-preview', id: 'latex-preview' }, () => <LatexPreviewPanel api={api} />)
  )
}
```

**槽位注册模式**。官方 UI 与槽位文档给出的注册点是：

```typescript
ctx.slots.inject(key, () => ctx.slots.register(opts, Component))
```

并且**不要将其包裹在 `ctx.effect` 中**——`ctx.effect` 只接受“函数 / null / undefined”作为返回值，包错一层会导致激活阶段抛 `Invalid effect`，表现为“插件装上了但面板不出现”。

**副作用清理**：所有路由、定时器、监听器必须注册 disposer，使用 `ctx.effect(() => dispose, label)`，否则热重载时会留下重复。

**端到端时序（文件变更 → PDF 刷新）**：

```
用户保存 .tex
   │
   ▼
[Host] chokidar 触发 → CompileService.onFileChange()
   │  防抖
   ▼
[Host] 编译前：备份 outDir/xxx.pdf → xxx.pdf.prev
   │  spawn tectonic -X compile ...
   ▼
[Host] 成功？──否──→ 回滚 .prev → .pdf，产 errors，emit 'compiled'
   │ 是
   ▼
[Host] 生成 diff，emit 'compiled' { pdfPath, diff, errors: [] }
   │
   ▼
[Client] api.onCompiled 回调
   │  pdfViewer.captureScrollState()   ← 新 PDF 加载前
   ▼
[Client] iframe.postMessage({ type: 'load', url: pdfPath })
   │  PDF.js 'documentloaded'
   ▼
[Client] pdfViewer.restoreScrollState()   ← 页数越界时钳制
   ▼
完成
```

**PDF 传输约定**：通过 Host 半的 `webServer` 注册静态路由，Client 半用同源 URL 加载 PDF；大文件不走 postMessage 传二进制。若 iframe 跨域，`PDFViewerApplication` 不可直接访问，滚动恢复需全部改走 postMessage。

---

## 3. 核心模块设计

### 3.1 文件监听与增量编译

**为什么不用 `tectonic -X watch`**：官方 issue 记录 watch 与 compile 组合存在已知缺陷。Host 半用 chokidar 自行监听 + 防抖。

**编译产物策略**：不依赖 Tectonic 的容错参数，在 CompileService 内显式备份/回滚，保证“编译失败时 PDF 不清空”。

```typescript
// src/services/compile.ts
export class CompileService {
  private timer: NodeJS.Timeout | null = null
  private listeners: Array<(r: CompileResult) => void> = []

  onFileChange(_path: string): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.run(), this.opts.debounceMs)
  }

  private async run(): Promise<CompileResult> {
    const pdf = join(this.opts.outDir, basename(this.opts.rootFile, '.tex') + '.pdf')
    const prev = pdf + '.prev'
    try { await copyFile(pdf, prev) } catch { /* 首次编译无 prev */ }

    const args = [
      '-X', 'compile', this.opts.rootFile,
      '--synctex', '--keep-logs', '--keep-intermediates',
      '--outdir', this.opts.outDir,
    ]
    const result = await spawnTectonic(args, this.opts.draftMode)

    if (result.exitCode !== 0) {
      try { await rename(prev, pdf) } catch { /* 首次编译失败无 prev */ }
    } else {
      try { await unlink(prev) } catch { /* 无 prev */ }
    }
    const payload = { ...result, pdfPath: pdf }
    this.listeners.forEach((cb) => cb(payload))
    return payload
  }
}
```

**draftMode 的正确实现**：编译前源码预处理，向 `\documentclass` 后注入 draft 选项，而非使用无关的 Tectonic 参数。

```typescript
export function applyDraftMode(tex: string): string {
  return tex.replace(
    /(\\documentclass(?:\[[^\]]*\])?\{[^}]+\})/,
    '$1\n\\PassOptionsToPackage{draft}{graphicx}\n\\PassOptionsToPackage{draft}{tikz}',
  )
}
```

**多根文件工作区**：扫描 `% !TEX root` 指令与 `\documentclass` 文件，在配置面板让用户选择主根文件；未配置时拒绝自动编译。

**`.latex-preview/` 清理**：保留最近 3 次成功编译的中间文件，`.prev` 在成功编译后立即删除；插件卸载时提供“清理缓存”按钮。

### 3.2 PDF 渲染与滚动位置保持

**核心问题**：朴素刷新会让 AI 改第 50 页后 PDF 跳回第 1 页，用户直接卸载。

**PDF.js 加载方式**：加载 PDF.js 的 `viewer.html`，通过 postMessage 通信。**DOM 选择器与 `PDFViewerApplication` 访问收敛到适配层**：

```typescript
// src/client/pdf-viewer.ts
class PDFViewerAdapter {
  private get container(): HTMLElement | null {
    return this.iframe.contentDocument?.querySelector('#viewerContainer') ?? null
  }
  getVisiblePage(): number | null {
    const pages = this.container?.querySelectorAll('.page') ?? []
    let best: Element | null = null, bestTop = Infinity
    const cTop = this.container?.getBoundingClientRect().top ?? 0
    pages.forEach((p) => {
      const top = Math.abs(p.getBoundingClientRect().top - cTop)
      if (top < bestTop) { bestTop = top; best = p }
    })
    const n = best?.getAttribute('data-page-number')
    return n ? parseInt(n, 10) : null
  }
  getScrollRatio(): number {
    const c = this.container
    return c ? c.scrollTop / Math.max(1, c.scrollHeight) : 0
  }
  scrollToPage(page: number): void {
    const app = (this.iframe.contentWindow as any)?.PDFViewerApplication
    app?.pdfViewer?.scrollPageIntoView({ pageNumber: page })
  }
  totalPages(): number {
    const app = (this.iframe.contentWindow as any)?.PDFViewerApplication
    return app?.pdfDocument?.numPages ?? 0
  }
}

export class PDFViewer {
  private adapter = new PDFViewerAdapter()
  private scrollState: { page: number; scrollRatio: number } | null = null

  captureScrollState(): void {
    const page = this.adapter.getVisiblePage()
    if (page == null) return
    this.scrollState = { page, scrollRatio: this.adapter.getScrollRatio() }
  }

  restoreScrollState(): void {
    if (!this.scrollState) return
    const total = this.adapter.totalPages()
    const target = Math.min(this.scrollState.page, Math.max(1, total))
    this.adapter.scrollToPage(target)
    requestAnimationFrame(() => {
      const c = (this.adapter as any).container as HTMLElement | null
      if (c) c.scrollTop = this.scrollState!.scrollRatio * c.scrollHeight
    })
  }
}
```

**注意**：`captureScrollState()` 必须在新 PDF 加载前调用；页数减少时 `scrollPageIntoView` 对越界页码静默忽略，必须做 `Math.min` 钳制。增量渲染是 P2 优化，MVP 不做。

### 3.3 Diff 高亮

**统一为行级 diff 并补齐行号**——行号是 SyncTeX 跳转所需的锚点：

```typescript
export interface DiffBlock {
  type: 'insert' | 'delete' | 'equal'
  text: string
  startLine: number
  endLine: number
}

export function lineDiff(oldText: string, newText: string): DiffBlock[] {
  const dmp = new diff_match_patch()
  const a = dmp.diff_linesToChars_(oldText, newText)
  const diffs = dmp.diff_main(a.chars1, a.chars2, false)
  dmp.diff_charsToLines_(diffs, a.lineArray)
  dmp.diff_cleanupSemantic(diffs)

  const blocks: DiffBlock[] = []
  let newLine = 1
  for (const [op, text] of diffs) {
    const lineCount = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    const startLine = newLine
    if (op !== -1) newLine += lineCount
    blocks.push({
      type: op === 1 ? 'insert' : op === -1 ? 'delete' : 'equal',
      text, startLine,
      endLine: op === -1 ? startLine : startLine + Math.max(0, lineCount - 1),
    })
  }
  return blocks
}
```

**LaTeX 特殊处理**：diff 前做规范化——去注释行、合并连续空格、规范化 `\%` 等转义——避免格式微调淹没真实内容变更。

**降级**：若 diff 块落在导言区或宏定义内部无法经 SyncTeX 定位，点击时仅高亮源码，状态栏提示“该位置无 PDF 映射”。

### 3.4 SyncTeX 双向跳转

**正向（源码→PDF）与反向（PDF→源码）**均通过 `synctex` CLI 子进程调用，官方 manpage 明确禁止手写 `.synctex` 解析器。

```typescript
export function synctexView(input: string, line: number, outputPdf: string): Promise<ViewResult> {
  return new Promise((resolve, reject) => {
    execFile('synctex', ['view', '-i', `${line}:0:${input}`, '-o', outputPdf],
      { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err)
        resolve(parseView(stdout))
      })
  })
}

function parseView(out: string): ViewResult {
  const body = out.split('SyncTeX result begin')[1]?.split('SyncTeX result end')[0] ?? ''
  const get = (k: string) => parseFloat((body.match(new RegExp(`^${k}:([\\d.]+)`, 'm')) ?? [])[1] ?? 'NaN')
  const page = parseInt((body.match(/^Page:(\d+)/m) ?? [])[1] ?? '0', 10)
  if (!page) throw new Error('synctex view: no Page in output')
  return { page, x: get('x'), y: get('y'), h: get('h'), v: get('v') }
}

export function synctexEdit(page: number, x: number, y: number, outputPdf: string): Promise<EditResult> {
  return new Promise((resolve, reject) => {
    execFile('synctex', ['edit', '-o', `${page}:${x}:${y}:${outputPdf}`],
      { maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
        if (err) return reject(err)
        resolve(parseEdit(stdout))
      })
  })
}
```

**浏览器半坐标换算**：PDF.js 用 CSS 坐标（左上原点，y 向下），synctex 用 PDF 坐标（左下原点，y 向上）。换算需考虑页面缩放、滚动容器偏移与 DPI：

```typescript
function pdfPointFromClick(e: MouseEvent, pageEl: HTMLElement, pageScale: number, pagePaddingTop: number) {
  const rect = pageEl.getBoundingClientRect()
  const cssX = e.clientX - rect.left
  const cssY = e.clientY - rect.top
  return {
    x: (cssX / pageScale) * (72 / 96),
    y: ((rect.height - cssY) / pageScale) * (72 / 96) - pagePaddingTop,
  }
}
```

> `pageScale` 与 `pagePaddingTop` 的获取方式需在 PDF.js 实机上验证；若 iframe 跨域，必须改由 iframe 内脚本 postMessage 回传坐标。这是 P1 阶段必须实机验证的点。

**Tectonic 的 SyncTeX 限制**：复杂宏展开、深 `\input` 链下可能定位偏差，README 如实告知。

### 3.5 编译错误回传 Agent（核心差异化功能之一）

**定位**：与实时预览并列的核心功能。P0 第 2 周打通“编译失败→一键发 Agent”的最小链路，完整错误面板（warning 级、脱敏开关）留在 P0+。

**官方 API**：`createUserMessage({ content, source })` 是构建 user 消息的规范入口，`agent.steer()` 是将消息投递到当前会话的官方 API。

```typescript
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export function buildErrorPrompt(e: LatexError, includeContext: boolean): string {
  const head = `LaTeX 编译失败，请修复以下错误后重新编译：\n文件：${e.file}\n行号：${e.line}\n错误：${e.message}`
  return includeContext
    ? `${head}\n上下文：\n\`\`\`latex\n${e.context}\n\`\`\`\n请直接修改源文件修复此错误。`
    : `${head}\n（已开启脱敏模式，不发送源码上下文；请基于错误信息与行号推断修复。）`
}

export function sendErrorToAgent(agent: Agent, e: LatexError, includeContext: boolean): void {
  agent.steer(createUserMessage({ content: buildErrorPrompt(e, includeContext), source: 'latex-preview' }))
}
```

**合规要求**：首次启用及每次发送时 UI 明确提示内容将离开本机；脱敏开关默认关闭但必须可开启。

**错误解析**：同时覆盖 error（`!` 开头 + `l.N`）与 warning（`LaTeX Warning` / `Package ... Warning` / `Overfull`）。

```typescript
export interface LatexError {
  file: string
  line: number
  message: string
  context: string
  severity: 'error' | 'warning'
}

export function parseLatexLog(log: string, rootFile: string): LatexError[] {
  const lines = log.split('\n')
  const errors: LatexError[] = []

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('!')) {
      const msg = l.slice(1).trim()
      let lineNo = 0
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const m = lines[j].match(/^l\.(\d+)/)
        if (m) { lineNo = parseInt(m[1], 10); break }
      }
      errors.push({
        file: rootFile, line: lineNo, message: msg,
        context: lines.slice(Math.max(0, i - 2), i + 3).join('\n'),
        severity: 'error',
      })
    }
    const wm = l.match(/^(LaTeX|Package \S+) Warning: (.+)$/) ?? l.match(/^(Overfull \\[hv]box .+)$/)
    if (wm) {
      errors.push({
        file: rootFile, line: 0,
        message: wm[2] ?? wm[1],
        context: lines.slice(Math.max(0, i - 2), i + 3).join('\n'),
        severity: 'warning',
      })
    }
  }
  return errors
}
```

### 3.6 PDF 批注 → Agent 指令（P2）

PDF.js text layer 取选中文本与位置 → `synctexEdit` 反查源码行 → 结构化 prompt。批注内容同样受隐私边界约束。

---

## 4. 双半结构骨架

**package.json**：

```json
{
  "name": "dsh-latex-preview",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".": { "default": "./lib/index.js" },
    "./client": "./lib/client.js",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["slots"] }
  }
}
```

> **Client 打包注意**：官方双半指南指出 `lib/client.js` **不是 ES module**，顶层唯一语句必须是模块加载器调用，所有副作用放在工厂内部。构建配置需按此产出懒加载 CJS 包。

**cordis.patch.yml**：

```yaml
- insert:
    - id: latex-preview
      name: dsh-latex-preview
```

**Host 半**：`ctx.plugin(LatexPreviewService, ...)` 注册服务；需要 `webServer` 时用 `ctx.inject(['webServer'], cb)` 延迟获取；所有副作用用 `ctx.effect(() => dispose, label)` 管理。

**Client 半**：`export const inject = ['latexPreview']` 声明硬性依赖；槽位用 `ctx.slots.inject(key, () => ctx.slots.register(opts, Component))` 注册，**不包 `ctx.effect`**。

---

## 5. 里程碑

| 阶段 | 周次 | 交付内容 | 验收标准 |
|---|---|---|---|
| **P0 双核最小闭环** | 1–2 | 脚手架 + FileWatcher + Tectonic + PDF.js 静态渲染 + 编译失败最小回传链路 | 改 .tex → PDF 刷新；AI 写错 → 点修复 → Agent 收到并回写 → PDF 刷新 |
| **P0+ 体验补完** | 3 | 滚动保持（越界钳制）+ 完整错误面板（warning/脱敏）+ 产物回滚 | 删 5 页 → PDF 不跳首页；编译失败旧 PDF 保留；脱敏开 prompt 不含源码 |
| **P1 双向跳转** | 4 | SyncTeX 正反跳转 + 行级 diff 高亮（含 startLine） | 源码点击跳 PDF；PDF 双击跳源码；滚动 3 屏后坐标不漂移 |
| **P2 批注闭环** | 5 | PDF 圈选批注 → 结构化 prompt → Agent | 圈选“改简洁” → AI 改写 → diff 高亮 |
| **P3 打磨上架** | 6 | README、动图、npm 发布、DSH Workshop 索引、i18n | 一条命令可用；中英文可切换 |

**砍功能优先级**：P2 批注 > P1 diff 点击跳转 > P0+ warning 级。**滚动位置保持与产物回滚是底线，任何情况下不砍。**

---

## 6. 常见坑点

1. **`tectonic -X watch` 不可用**：issue 已记录。→ chokidar 自行监听。
2. **Tectonic 是 XeTeX 管线**：pdfLaTeX 专属宏包可能不兼容。→ README 写明，提供 latexmk 降级链。
3. **Tectonic 不识别 `Tectonic.toml`（对 `-X compile`）**：→ `% !TEX root` 定位根文件；多根工作区让用户选择。
4. **PDF.js 刷新滚动丢失**：→ capture/restore，capture 必须在新 PDF 加载前。
5. **PDF.js 与 synctex 坐标系不一致**：→ y 翻转 + DPI 换算 + 滚动偏移修正。
6. **手写 `.synctex` 解析器是禁忌**：官方 manpage 警告。→ 一律走 `synctex` CLI。
7. **DSH developer preview API 破坏性变更**：→ 精确版本锁定 + `pnpm verify` 契约测试；关注官方 CHANGELOG。
8. **`dsh plugin add` 终端沙箱 EPERM**：→ 普通 Terminal 运行，或 `HOME=$PWD/.fake-home dsh plugin add ...`。
9. **Tectonic 官方二进制不支持 arm64**：→ README 平台矩阵，arm64 引导 `cargo install`。
10. **首次 bundle 下载慢**：→ 启动时后台预下载 + 进度条，支持离线缓存模式。
11. **`synctex` 不在 PATH**：→ 启动时校验 `tectonic --version` 与 `synctex --version` 双可用。
12. **iframe 跨域导致滚动恢复失效**：→ 插件静态路由与 Web UI 同域；跨域时全部走 postMessage。
13. **`ctx.get` 在 `apply` 时拿到 `undefined`**：官方双半指南明确，服务 fiber 在 apply 时可能尚未存在。→ Host 半一律用 `ctx.inject(deps, cb)` 而非直接 `ctx.get`；Client 半硬性依赖用 `inject` 声明，可选依赖才用 `ctx.get` 并在使用处探测。
14. **槽位注册包了 `ctx.effect` 导致面板不出现**：`ctx.effect` 只接受函数/null/undefined 返回值，包错一层会在激活阶段抛 `Invalid effect`。→ `ctx.slots.inject(key, () => ctx.slots.register(...))` 直接调用，不包 `effect`。

---

## 7. 仓库目录结构

```
dsh-latex-preview/
├── package.json                  # dsh.bundle.patch + dsh.client 声明
├── cordis.patch.yml
├── tsconfig.json
├── src/                          # Host 半（Node.js）
│   ├── index.ts                  # apply()：ctx.plugin(LatexPreviewService)
│   ├── services/
│   │   ├── latex-preview-service.ts   # Service 基类，super(ctx, 'latexPreview')
│   │   ├── compile.ts            # 防抖 + 产物备份回滚
│   │   ├── draft.ts              # draftMode 源码预处理
│   │   ├── watcher.ts
│   │   ├── synctex.ts            # parseView / parseEdit
│   │   ├── diff.ts               # 行级 diff + startLine
│   │   ├── error-parser.ts       # error + warning 双级
│   │   └── agent-bridge.ts       # 含脱敏 prompt
│   └── utils/
├── src/client/                   # 浏览器半（懒加载 CJS bundle）
│   ├── index.tsx                 # inject: ['latexPreview'] + slots.inject
│   ├── pdf-viewer.ts             # PDFViewerAdapter 版本隔离
│   ├── diff-panel.tsx
│   ├── annotation.ts
│   └── synctex-bridge.ts
├── assets/pdfjs/
├── i18n/
├── test/
├── docs/demo.gif
└── README.md                     # 隐私边界 + 平台矩阵 + 已知限制
```

---

## 8. 发布前自查清单

- [ ] `tectonic --version` 与 `synctex --version` 双检测 + 安装引导
- [ ] 首次编译 bundle 下载进度提示
- [ ] 编译失败时 PDF 经产物回滚保证不清空
- [ ] 滚动恢复在页数减少时钳制，不跳末页
- [ ] 错误面板点击跳源码；warning 级可折叠
- [ ] “发送给 Agent”按钮旁常驻隐私提示；脱敏开关生效
- [ ] Agent prompt 经 ≥10 个真实错误样本回归（样本存 `test/fixtures/errors/`）
- [ ] README 含 30 秒动图 + 隐私边界声明 + 平台矩阵 + 已知限制
- [ ] `pnpm build` 产物提交，Client 半产出懒加载 CJS bundle
- [ ] `pnpm verify` 契约测试通过（`ctx.plugin(Service)`、`ctx.inject`、`ctx.slots.inject`、`createUserMessage`、`agent.steer` 冒烟）
- [ ] i18n 中英文案完整，无硬编码中文
- [ ] 提交 DSH Workshop 索引
- [ ] LICENSE 选 MIT

---

## 9. 测试策略

| 层 | 测试对象 | 方式 | 目标 |
|---|---|---|---|
| 单元 | `parseLatexLog` | fixture `.log` 样本（error / warning / Overfull / 嵌套） | ≥15 样本，行号与消息准确率 100% |
| 单元 | `parseView` / `parseEdit` | 固定字符串输出 | 字段解析 100% |
| 单元 | `lineDiff` | 构造新旧源码对 | `startLine/endLine` 与人工核对一致 |
| 单元 | `pdfPointFromClick` | 给定 rect/scale/click | 与手工计算一致 |
| 集成 | `CompileService` | mock `spawn`，模拟成功/失败/超时 | 失败回滚 `.prev`；成功删除 `.prev` |
| 契约 | DSH API 调用 | `pnpm verify` 冒烟：`ctx.plugin(Service)`、`ctx.inject`、`ctx.slots.inject/register`、`createUserMessage`、`agent.steer` | DSH 升级后一键回归 |
| 端到端 | 完整闭环 | Playwright（P3 可选） | 改 tex → PDF 刷新 → 错误 → 发 Agent |

**性能目标（MVP）**：增量编译 P50 < 2s / P95 < 5s（≤50 页）；防抖合并率可观测；PDF 加载到可交互 < 800ms；滚动恢复页码一致，ratio 误差 < 5%。若 P95 编译 > 5s，才启动 P2 增量渲染。

---

## 10. 交付判断

本文档已完成 DSH 官方文档的 API 契约核验：**服务注册使用 `Service` 基类**，**Host 半服务获取优先 `ctx.inject`**（避免 apply 时拿到 undefined），**槽位注册使用 `ctx.slots.inject` + `ctx.slots.register` 且不包 `ctx.effect`**。除需要在实机上验证的 PDF.js DOM 选择器与跨域坐标回传外，文档已具备支撑独立开发的条件。最容易踩坑的仍是“PDF 刷新体验”与“SyncTeX 坐标换算”——第 1 周先跑通最小闭环，第 2 周专门打磨滚动保持与错误回滚，宁可砍 P2 批注也不要在体验上妥协。