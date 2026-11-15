/**
 * Same-origin PDF.js viewer for the LaTeX Preview panel.
 *
 * pdfjs-dist does not ship a viewer application (only the `web/pdf_viewer.mjs`
 * components), so this page assembles the minimal one: container + event bus +
 * link service + PDFViewer. It deliberately mirrors the names the generic
 * viewer exposes (`#viewerContainer`, `.page`, `window.PDFViewerApplication`)
 * because `client/pdf-viewer.ts` is written against exactly those.
 *
 * Contract with the host panel (`client/panel.tsx`):
 *   parent ← { source: 'latex-preview-viewer', type: 'ready' | 'page' | 'sync-reverse' | 'error' }
 *
 * @module dsh-latex-preview/viewer
 */

import * as pdfjs from '../pdfjs/pdf.mjs'

/** `pdf_viewer.mjs` reads this global at module-evaluation time. */
globalThis.pdfjsLib = pdfjs

const { PDFViewer, PDFLinkService, EventBus } = await import('../pdfjs/pdf_viewer.mjs')

/** Messages are tagged so unrelated `postMessage` traffic is ignored. */
const SOURCE = 'latex-preview-viewer'

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
  // Annotations and the text layer add two script loads and DOM passes that a
  // read-only preview never uses; both are off on purpose.
  annotationMode: 0,
  textLayerMode: 0,
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

/**
 * Reverse SyncTeX: double-click a page and report the point in PDF user space.
 *
 * SyncTeX reports points at 72 dpi; DOM rects are CSS pixels (96 dpi), hence the
 * 0.75 factor. Origin is top-left per docs/spikes.md §B9 (`y ≈ v`), so no flip.
 */
viewerEl.addEventListener('dblclick', async (event) => {
  const pageEl = event.target instanceof Element ? event.target.closest('.page') : null
  if (!pageEl) return
  const pageNumber = Number(pageEl.dataset.pageNumber)
  if (!Number.isFinite(pageNumber) || pageNumber < 1) return

  try {
    if (!pdfDocument) return
    const page = await pdfDocument.getPage(pageNumber)
    const viewport = page.getViewport({ scale: 1 })
    const rect = pageEl.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    const x = ((event.clientX - rect.left) / rect.width) * viewport.width * 0.75
    const y = ((event.clientY - rect.top) / rect.height) * viewport.height * 0.75
    tell('sync-reverse', { page: pageNumber, x, y })
  } catch {
    // A page that failed to render simply has no reverse mapping.
  }
})
