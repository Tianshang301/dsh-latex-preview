/**
 * Same-origin PDF.js viewer for the LaTeX Preview panel.
 *
 * pdfjs-dist does not ship a viewer application (only the `web/pdf_viewer.mjs`
 * components), so this page assembles the minimal one: container + event bus +
 * link service + PDFViewer. It deliberately mirrors the names the generic
 * viewer exposes (`#viewerContainer`, `.page`, `window.PDFViewerApplication`)
 * because `client/pdf-viewer.ts` is written against exactly those.
 *
 * It also owns the "point at the PDF, edit the source" gesture: a text selection
 * or a rubber-band region becomes a PDF-space rectangle, and the bar that follows
 * sends `{ page, x, y, x2, y2, instruction }` to the panel. Nothing is extracted
 * from the PDF as content — formulas and ligatures extract badly — the rectangle
 * is only ever used to ask SyncTeX which source lines it covers.
 *
 * Contract with the host panel (`client/panel.tsx`):
 *   parent ← { source: 'latex-preview-viewer', type: 'ready' | 'page' | 'sync-reverse' | 'edit-request' | 'error' }
 *
 * @module dsh-latex-preview/viewer
 */

import * as pdfjs from '../pdfjs/pdf.mjs'

/** `pdf_viewer.mjs` reads this global at module-evaluation time. */
globalThis.pdfjsLib = pdfjs

const { PDFViewer, PDFLinkService, EventBus } = await import('../pdfjs/pdf_viewer.mjs')

/** Messages are tagged so unrelated `postMessage` traffic is ignored. */
const SOURCE = 'latex-preview-viewer'

/** A click shorter than this, in CSS px, is a click and not a region drag. */
const MIN_REGION = 12

const statusEl = document.getElementById('status')

/**
 * Show a fatal message in place of the document.
 * @param message - text for the user.
 */
function fail(message) {
  statusEl.hidden = false
  statusEl.textContent = message
  window.parent?.postMessage({ source: SOURCE, type: 'error', message }, '*')
}

/** Post a payload to the panel. */
function tell(type, detail) {
  window.parent?.postMessage({ source: SOURCE, type, ...detail }, '*')
}

const params = new URLSearchParams(window.location.search)
const rawFile = params.get('file')
if (!rawFile) fail('缺少 file 参数：查看器需要 PDF 地址')
// Resolve against the origin: the panel passes a root-relative route, and a
// relative one would otherwise be joined to this page's directory.
const file = rawFile ? new URL(rawFile, window.location.origin).href : ''

const assetBase = new URL('../pdfjs/', import.meta.url)
pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.mjs', assetBase).href

/** Minimal `l10n` stub: `PDFViewer` only calls translate/pause/resume. */
const l10n = {
  get: async (key) => key,
  translate: () => undefined,
  pause: async () => undefined,
  resume: async () => undefined,
}

const eventBus = new EventBus()
const linkService = new PDFLinkService({ eventBus })
const container = document.getElementById('viewerContainer')
const viewerEl = document.getElementById('viewer')

const pdfViewer = new PDFViewer({
  container,
  viewer: viewerEl,
  eventBus,
  linkService,
  l10n,
  // Annotations stay off: a read-only preview never edits them. The text layer is
  // ON because selection is how the user points at a place to change.
  annotationMode: 0,
  textLayerMode: 1,
  enableHWA: false,
})
linkService.setViewer(pdfViewer)

/** Loaded document, or null until `getDocument` resolves. */
let pdfDocument = null

try {
  pdfDocument = await pdfjs.getDocument({
    url: file,
    cMapUrl: new URL('cmaps/', assetBase).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('standard_fonts/', assetBase).href,
  }).promise

  pdfViewer.setDocument(pdfDocument)
  linkService.setDocument(pdfDocument, null)
  pdfViewer.currentScaleValue = 'page-width'

  // The generic viewer's global is what `client/pdf-viewer.ts` reads.
  window.PDFViewerApplication = { pdfViewer, pdfDocument, eventBus, linkService }

  eventBus.on('pagechanging', (event) => tell('page', { page: event.pageNumber }))
  tell('ready', { pages: pdfDocument.numPages })
} catch (error) {
  fail(`PDF 打开失败：${error?.message ?? error}`)
}

// ── PDF point conversion ────────────────────────────────────────────────────

/**
 * Convert a client-space rect inside one page element to PDF user space.
 * @param {HTMLElement} pageEl - the `.page` element.
 * @param {{left:number,top:number,right:number,bottom:number}} rect - client rect.
 * @returns {Promise<{page:number,x:number,y:number,x2:number,y2:number}|null>}
 *   the rectangle in points, or null when the page cannot be measured.
 */
async function toPdfRect(pageEl, rect) {
  const pageNumber = Number(pageEl?.dataset?.pageNumber)
  if (!pdfDocument || !Number.isFinite(pageNumber) || pageNumber < 1) return null
  const box = pageEl.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null

  const page = await pdfDocument.getPage(pageNumber)
  // `getViewport({scale:1})` is already in PDF points (Letter → 612×792), not in
  // CSS pixels: measuring against the 816×1056 element and scaling by 96/72 is
  // what SyncTeX does not expect. Verified against a live `synctex edit` sweep —
  // dividing by the element box and multiplying by the viewport is all that is
  // needed (docs/spikes.md §B15).
  const viewport = page.getViewport({ scale: 1 })
  const x = ((rect.left - box.left) / box.width) * viewport.width
  const x2 = ((rect.right - box.left) / box.width) * viewport.width
  const y = ((rect.top - box.top) / box.height) * viewport.height
  const y2 = ((rect.bottom - box.top) / box.height) * viewport.height

  return {
    page: pageNumber,
    x: Math.max(0, Math.min(x, x2)),
    x2: Math.min(viewport.width, Math.max(x, x2)),
    y: Math.max(0, Math.min(y, y2)),
    y2: Math.min(viewport.height, Math.max(y, y2)),
  }
}

/** The page element containing a node, if any. */
function pageOf(node) {
  const el = node instanceof Element ? node : node?.parentElement
  return el?.closest?.('.page') ?? null
}

// ── Floating "change this" bar ──────────────────────────────────────────────

let bar = null

/** Remove the bar and any pending anchor. */
function closeBar() {
  bar?.remove()
  bar = null
  window.getSelection()?.removeAllRanges()
}

/**
 * Show the instruction bar under a selection.
 * @param {{page:number,x:number,y:number,x2:number,y2:number}} region - PDF rect.
 * @param {string} quoted - selected text, shown as context only.
 * @param {{left:number,top:number,right:number,bottom:number}} anchor - client rect.
 */
function showBar(region, quoted, anchor) {
  closeBar()
  const el = document.createElement('form')
  el.id = 'editBar'
  el.innerHTML = `
    <div class="editBarQuote"></div>
    <input class="editBarInput" type="text" placeholder="想让 AI 怎么改这里？" />
    <div class="editBarRow">
      <button type="submit" class="editBarSend">发送给 AI</button>
      <button type="button" class="editBarCancel">取消</button>
    </div>`
  el.querySelector('.editBarQuote').textContent = quoted ? `「${quoted}」` : `第 ${region.page} 页选区`

  const top = Math.min(anchor.bottom + 8, window.innerHeight - 96)
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - 300))
  el.style.top = `${Math.max(8, top)}px`
  el.style.left = `${left}px`

  el.querySelector('.editBarCancel').addEventListener('click', closeBar)
  el.addEventListener('submit', (event) => {
    event.preventDefault()
    const input = el.querySelector('.editBarInput')
    const instruction = input.value.trim()
    if (instruction === '') {
      input.focus()
      return
    }
    tell('edit-request', { ...region, text: quoted, instruction })
    closeBar()
  })

  document.body.append(el)
  bar = el
  el.querySelector('.editBarInput').focus()
}

// ── Gestures ────────────────────────────────────────────────────────────────

/**
 * Reverse SyncTeX on a plain double-click: report the point, no instruction.
 * Two frames of the same gesture are not needed — the panel only reads the line.
 */
viewerEl.addEventListener('dblclick', async (event) => {
  const pageEl = pageOf(event.target)
  if (!pageEl) return
  const point = await toPdfRect(pageEl, {
    left: event.clientX,
    top: event.clientY,
    right: event.clientX,
    bottom: event.clientY,
  })
  if (!point) return
  tell('sync-reverse', { page: point.page, x: point.x, y: point.y })
})

/** Selection → bar, on mouse release inside the document. */
container.addEventListener('mouseup', async () => {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed) return
  const text = selection.toString().trim()
  if (text === '') return
  const pageEl = pageOf(selection.anchorNode)
  if (!pageEl) return
  const range = selection.getRangeAt(0)
  const rect = range.getBoundingClientRect()
  const region = await toPdfRect(pageEl, rect)
  if (!region) return
  showBar(region, text.length > 60 ? `${text.slice(0, 60)}…` : text, rect)
})

/**
 * Rubber-band region select, for parts with no text layer: formulas rendered as
 * images, figures, tables. Starts only when the press misses the text layer, so
 * ordinary text selection keeps working.
 */
let drag = null
container.addEventListener('mousedown', (event) => {
  if (event.button !== 0) return
  const target = event.target instanceof Element ? event.target : null
  if (target?.closest('.textLayer')) return
  const pageEl = target?.closest('.page')
  if (!pageEl) return
  event.preventDefault()
  closeBar()
  drag = { pageEl, startX: event.clientX, startY: event.clientY, box: null }
})

container.addEventListener('mousemove', (event) => {
  if (!drag) return
  const left = Math.min(drag.startX, event.clientX)
  const top = Math.min(drag.startY, event.clientY)
  const width = Math.abs(event.clientX - drag.startX)
  const height = Math.abs(event.clientY - drag.startY)
  if (!drag.box) {
    drag.box = document.createElement('div')
    drag.box.id = 'regionBox'
    document.body.append(drag.box)
  }
  Object.assign(drag.box.style, {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  })
})

container.addEventListener('mouseup', async (event) => {
  if (!drag) return
  const { pageEl, startX, startY, box } = drag
  drag = null
  box?.remove()
  if (Math.abs(event.clientX - startX) < MIN_REGION || Math.abs(event.clientY - startY) < MIN_REGION) return
  const rect = {
    left: Math.min(startX, event.clientX),
    top: Math.min(startY, event.clientY),
    right: Math.max(startX, event.clientX),
    bottom: Math.max(startY, event.clientY),
  }
  const region = await toPdfRect(pageEl, rect)
  if (region) showBar(region, '', rect)
})

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeBar()
})

// A scroll moves the anchor away from the bar; hiding is better than a stray bar.
container.addEventListener('scroll', () => closeBar(), { passive: true })
