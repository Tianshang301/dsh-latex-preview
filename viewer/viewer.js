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
 * It also draws the diff overlay: the panel sends the rectangles of the lines
 * changed since the previous compile, and this page paints them over the pages.
 * The overlay is `pointer-events: none` so it never steals a selection from the
 * text layer — hover/click are resolved by hit-testing instead.
 *
 * Contract with the host panel (`client/panel.tsx`):
 *   parent ← { source: 'latex-preview-viewer', type: 'ready' | 'page' | 'sync-reverse' | 'edit-request' | 'diff-click' | 'error' }
 *   viewer ← { source: 'latex-preview-panel', type: 'diff', regions, visible }
 *   viewer ← { source: 'latex-preview-panel', type: 'mode', readOnly }
 *
 * `readOnly` is set while the previous revision is on screen: its page maps to the
 * *old* source, so a selection there would hand the Host old line numbers, and a
 * reverse jump would report a line that no longer holds that text. The overlay
 * still works — that is the whole reason to look at that document.
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

// ── Diff overlay ────────────────────────────────────────────────────────────

/** Message source the host panel uses when talking to the viewer. */
const PANEL_SOURCE = 'latex-preview-panel'

/** Rectangles for the loaded PDF, in points; empty hides the overlay. */
let diffRegions = []
let diffVisible = true

/**
 * True while the previous revision is the document on screen.
 *
 * Every gesture on that page would resolve against the old source, so they are
 * suppressed rather than mis-answered: no edit bar, no reverse jump, no line jump.
 */
let readOnly = false

/**
 * Bumped on every incoming `diff` message. A paint started under an older
 * generation must not commit: it was computed from regions that no longer apply.
 */
let diffGeneration = 0

/**
 * Per-page paint ticket, so two paints of the same page cannot interleave.
 *
 * `paintDiffPage` awaits `getPage()`, and `pagerendered` fires again during zoom
 * or scroll; without a ticket, an older await can resume *after* a newer one and
 * append a stale layer (or a second `.diffLayer` to the same page).
 */
const pagePaintTokens = new WeakMap()

/** Painted rectangles, kept for hit-testing (the layer itself ignores the mouse). */
let painted = []

/** Floating label that explains the region under the cursor. */
let diffTip = null

/** Set when a rubber-band ended, so the trailing click is not read as a jump. */
let suppressClickUntil = 0

/** Thinnest hoverable band, in CSS px; a drawn seam can be thinner than this. */
const HIT_MIN = 8

/** Seam thickness, in CSS px: proportional to the line, clamped to stay visible. */
const SEAM_MIN = 2
const SEAM_MAX = 8

/**
 * A region as percentages of its page.
 *
 * One conversion for both painting and hit-testing: they used to compute the same
 * ratios separately, so a change to one silently desynced the other from the
 * pixels on screen.
 * @param {{x:number,y:number,width:number,height:number}} region - in PDF points.
 * @param {{width:number,height:number}} viewport - the page viewport at scale 1.
 * @returns {{left:number,top:number,width:number,height:number}} percentages.
 */
function regionPercent(region, viewport) {
  return {
    left: (region.x / viewport.width) * 100,
    top: (region.y / viewport.height) * 100,
    width: (region.width / viewport.width) * 100,
    height: (region.height / viewport.height) * 100,
  }
}

/**
 * Remove every overlay layer from one page and forget its hit-test entries.
 * @param {HTMLElement} pageEl - the `.page` element.
 */
function clearPageDiff(pageEl) {
  for (const layer of pageEl.querySelectorAll(':scope > .diffLayer')) layer.remove()
  painted = painted.filter((entry) => entry.pageEl !== pageEl)
}

/**
 * Paint (or clear) the overlay for one page.
 *
 * Commits atomically: the new layer is appended before the old one is dropped, so
 * a page is never left without its marks mid-repaint. Anything that finishes out
 * of order is discarded rather than drawn — see {@link pagePaintTokens}.
 * @param {HTMLElement} pageEl - the `.page` element.
 */
async function paintDiffPage(pageEl) {
  const token = (pagePaintTokens.get(pageEl) ?? 0) + 1
  pagePaintTokens.set(pageEl, token)

  const generation = diffGeneration
  const documentAtStart = pdfDocument
  const pageNumber = Number(pageEl.dataset.pageNumber)
  const list = diffVisible ? diffRegions.filter((region) => region.page === pageNumber) : []

  if (!documentAtStart || !Number.isFinite(pageNumber) || list.length === 0) {
    clearPageDiff(pageEl)
    return
  }

  const page = await documentAtStart.getPage(pageNumber)

  // Anything that changed while awaiting means this result is already stale:
  // newer regions, a newer paint of this page, a different document, or a page
  // that PDF.js has since torn down.
  if (
    generation !== diffGeneration ||
    pagePaintTokens.get(pageEl) !== token ||
    documentAtStart !== pdfDocument ||
    !pageEl.isConnected
  ) {
    return
  }

  // `getViewport({scale:1})` is in PDF points (§B15). Positioning in percent keeps
  // the bands glued to the text through zoom and re-layout, with no resize hook.
  const viewport = page.getViewport({ scale: 1 })
  const pageHeightPx = pageEl.clientHeight
  const layer = document.createElement('div')
  layer.className = 'diffLayer'
  const nextPainted = []

  for (const region of list) {
    const pct = regionPercent(region, viewport)
    const box = document.createElement('div')
    box.className = `diffRegion diff-${region.kind}`
    box.style.left = `${pct.left}%`
    box.style.top = `${pct.top}%`
    box.style.width = `${pct.width}%`
    // A seam marks a change whose line is not on *this* page: a deletion on the
    // live PDF, an insertion on the previous one. It gets a short hatched band
    // instead of a solid one, so it reads as "something happened here" and not as
    // "this line changed". Its thickness follows the line so it scales with zoom
    // instead of staying 7 screen pixels at every magnification.
    const seam = region.seam === true
    const linePx = pageHeightPx > 0 ? (region.height / viewport.height) * pageHeightPx : 0
    const seamPx = Math.min(SEAM_MAX, Math.max(SEAM_MIN, linePx * 0.55))
    box.style.height = seam ? `${seamPx}px` : `${pct.height}%`
    layer.append(box)

    if (region.kind === 'delete') {
      const chip = document.createElement('div')
      chip.className = 'diffDelChip'
      chip.textContent = region.removed ? `− ${region.removed} 行` : '−'
      // At the right end of the text column, straddling the seam: the page's
      // right margin is the one place a marker covers no text.
      chip.style.left = `${((region.x + region.width) / viewport.width) * 100}%`
      chip.style.top = `${pct.top}%`
      layer.append(chip)
    }
    nextPainted.push({ pageEl, region, width: viewport.width, height: viewport.height, seamPx, seam })
  }

  // Swap in one step: the old layer stays until the new one is in the DOM.
  const previous = pageEl.querySelectorAll(':scope > .diffLayer')
  pageEl.append(layer)
  for (const old of previous) old.remove()
  painted = [...painted.filter((entry) => entry.pageEl !== pageEl), ...nextPainted]
}

/** Repaint every page that exists right now. */
async function paintDiff() {
  const pages = [...viewerEl.querySelectorAll('.page')]
  for (const pageEl of pages) await paintDiffPage(pageEl)
}

/**
 * Client-space rectangle of one painted region.
 *
 * Uses the same ratios as the paint, and widens a thin seam to {@link HIT_MIN} so
 * a 2 px line is still hoverable — otherwise the deletion row would be
 * unreachable at low zoom.
 * @param {{pageEl:HTMLElement,region:object,width:number,height:number,seamPx:number}} entry - painted entry.
 * @returns {{left:number,right:number,top:number,bottom:number}|null} client rect.
 */
function regionClientRect(entry) {
  if (!entry.pageEl.isConnected) return null
  const box = entry.pageEl.getBoundingClientRect()
  if (box.width <= 0 || box.height <= 0) return null
  const left = box.left + (entry.region.x / entry.width) * box.width
  const right = left + (entry.region.width / entry.width) * box.width
  const top = box.top + (entry.region.y / entry.height) * box.height
  // Match what is actually drawn: a seam has its own thickness, a band has the
  // line height. Both fall back to HIT_MIN so a hairline is still reachable.
  const drawn = entry.seam ? entry.seamPx : (entry.region.height / entry.height) * box.height
  return { left, right, top, bottom: top + Math.max(drawn || 0, HIT_MIN) }
}

/** Region under a viewport point, or null. */
function diffRegionAt(clientX, clientY) {
  for (const entry of painted) {
    const rect = regionClientRect(entry)
    if (!rect) continue
    if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
      return entry.region
    }
  }
  return null
}

/** Floating deletion row: the removed lines, struck through. */
let diffRows = null

/** Remove every floating annotation (tooltip and deletion row). */
function hideDiffFlyout() {
  diffTip?.remove()
  diffTip = null
  diffRows?.remove()
  diffRows = null
}

/**
 * Show the deletion row: the removed source lines, struck through, git-diff style.
 *
 * The removed words exist nowhere in the loaded PDF — the typesetter closed the
 * hole — so this popup (fed from the diff, not from the PDF) is the only place
 * they can be shown. Falls back to nothing when the region carries no text
 * (the plain tooltip still explains the region then).
 * @param {object} region - the deletion region under the cursor.
 * @param {number} x - viewport x.
 * @param {number} y - viewport y.
 */
function showDiffRows(region, x, y) {
  hideDiffFlyout()
  const lines = String(region.text ?? '').split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) return
  diffRows = document.createElement('div')
  diffRows.id = 'diffRows'
  const head = document.createElement('div')
  head.className = 'head'
  head.textContent = region.title ?? ''
  diffRows.append(head)
  for (const line of lines) {
    const row = document.createElement('div')
    row.className = 'row'
    row.textContent = line
    diffRows.append(row)
  }
  document.body.append(diffRows)
  const box = diffRows.getBoundingClientRect()
  diffRows.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - box.width - 8))}px`
  diffRows.style.top = `${Math.max(8, Math.min(y - box.height - 12, window.innerHeight - box.height - 8))}px`
}

/**
 * Show or move the tooltip.
 * @param {string} text - label, empty hides it.
 * @param {number} x - viewport x.
 * @param {number} y - viewport y.
 */
function showDiffTip(text, x, y) {
  hideDiffFlyout()
  if (text === '') return
  diffTip = document.createElement('div')
  diffTip.id = 'diffTip'
  document.body.append(diffTip)
  diffTip.textContent = text
  const width = diffTip.offsetWidth
  diffTip.style.left = `${Math.max(8, Math.min(x + 12, window.innerWidth - width - 8))}px`
  diffTip.style.top = `${Math.max(8, y - 28)}px`
}

// Pages render on demand (the viewer only keeps a window of them), so a repaint
// triggered by a message would miss pages that mount later.
eventBus.on('pagerendered', (event) => {
  // `event.source.div` is the element that just rendered; re-querying by page
  // number can hit a different instance if the page was rebuilt.
  const pageEl =
    event.source?.div ?? viewerEl.querySelector(`.page[data-page-number="${event.pageNumber}"]`)
  if (pageEl) void paintDiffPage(pageEl)
})

window.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.source !== PANEL_SOURCE) return
  if (data.type === 'mode') {
    readOnly = data.readOnly === true
    if (readOnly) {
      closeBar()
      drag = null
    }
    return
  }
  if (data.type !== 'diff') return
  // Any paint already in flight is now working from regions that no longer apply.
  diffGeneration += 1
  diffRegions = Array.isArray(data.regions) ? data.regions : []
  diffVisible = data.visible !== false
  void paintDiff()
})

container.addEventListener('mousemove', (event) => {
  if (drag) {
    hideDiffFlyout()
    return
  }
  const region = diffRegionAt(event.clientX, event.clientY)
  // A band with removed lines pops them up (struck through); everything else
  // explains itself through the one-line tooltip.
  if (region?.text) {
    showDiffRows(region, event.clientX, event.clientY)
    return
  }
  showDiffTip(region?.title ?? '', event.clientX, event.clientY)
})

container.addEventListener('mouseleave', hideDiffFlyout)

// A click on a band jumps to the source line that produced it. Hit-tested rather
// than bound to the element, because the layer must stay transparent to the mouse.
container.addEventListener('click', (event) => {
  if (readOnly) return
  if (Date.now() < suppressClickUntil) return
  if (!window.getSelection()?.isCollapsed) return
  const region = diffRegionAt(event.clientX, event.clientY)
  if (region) tell('diff-click', { line: region.lineStart })
})

// ── Gestures ────────────────────────────────────────────────────────────────

/**
 * Reverse SyncTeX on a plain double-click: report the point, no instruction.
 * Two frames of the same gesture are not needed — the panel only reads the line.
 */
viewerEl.addEventListener('dblclick', async (event) => {
  if (readOnly) return
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
  if (readOnly) return
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
  if (readOnly) return
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
  suppressClickUntil = Date.now() + 300
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
