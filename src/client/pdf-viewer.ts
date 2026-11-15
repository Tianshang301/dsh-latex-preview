/**
 * PDF.js adapter — every DOM selector and `PDFViewerApplication` access lives here.
 *
 * The viewer runs in a same-origin iframe, so `contentDocument` is reachable.
 * If that ever stops being true (cross-origin mount), this is the only file that
 * has to change: the rest of the client talks to {@link PDFViewer} only.
 *
 * Two behaviours decide whether users keep the plugin:
 * - `captureScrollState()` must run **before** the new PDF is loaded.
 * - `restoreScrollState()` clamps the page with `Math.min`: `scrollPageIntoView`
 *   silently ignores out-of-range pages, which looks exactly like "jumped to
 *   page 1" and is indistinguishable from the bug we are avoiding.
 *
 * @module dsh-latex-preview/client/pdf-viewer
 */

/** A captured viewport position, expressed so it survives a page-count change. */
export interface ScrollState {
  /** 1-based page that occupied the viewport top. */
  readonly page: number
  /** Scroll offset within the document, 0…1. */
  readonly ratio: number
}

/** Point in PDF user space (72 dpi, origin per docs/spikes.md §B9). */
export interface PdfPoint {
  readonly x: number
  readonly y: number
}

export class PDFViewerAdapter {
  constructor(private readonly iframe: HTMLIFrameElement) {}

  /** Scroll container inside the viewer, or null before the document loads. */
  get container(): HTMLElement | null {
    return this.iframe.contentDocument?.querySelector<HTMLElement>('#viewerContainer') ?? null
  }

  /** All rendered page elements, in document order. */
  private get pages(): HTMLElement[] {
    const doc = this.iframe.contentDocument
    if (!doc) return []
    return Array.from(doc.querySelectorAll<HTMLElement>('.page'))
  }

  /** `PDFViewerApplication` when the viewer script is on the same origin. */
  private get app(): { pdfViewer?: { scrollPageIntoView(o: { pageNumber: number }): void }; pdfDocument?: { numPages: number } } | null {
    const win = this.iframe.contentWindow as unknown as
      | { PDFViewerApplication?: { pdfViewer?: { scrollPageIntoView(o: { pageNumber: number }): void }; pdfDocument?: { numPages: number } } }
      | null
    return win?.PDFViewerApplication ?? null
  }

  /** 1-based number of the page whose top is closest to the container top. */
  getVisiblePage(): number | null {
    const container = this.container
    if (!container) return null
    const containerTop = container.getBoundingClientRect().top
    let best: HTMLElement | null = null
    let bestDistance = Number.POSITIVE_INFINITY
    for (const page of this.pages) {
      const distance = Math.abs(page.getBoundingClientRect().top - containerTop)
      if (distance < bestDistance) {
        bestDistance = distance
        best = page
      }
    }
    const raw = best?.dataset['pageNumber']
    return raw ? Number.parseInt(raw, 10) : null
  }

  /** Scroll offset as a 0…1 fraction of the scrollable height. */
  getScrollRatio(): number {
    const container = this.container
    if (!container) return 0
    const scrollable = Math.max(1, container.scrollHeight - container.clientHeight)
    return container.scrollTop / scrollable
  }

  /** Total pages, or 0 before the document is ready. */
  totalPages(): number {
    return this.app?.pdfDocument?.numPages ?? this.pages.length
  }

  /** Scroll so the page is at the top of the viewport. */
  scrollToPage(page: number): void {
    const app = this.app
    if (app?.pdfViewer) {
      app.pdfViewer.scrollPageIntoView({ pageNumber: page })
      return
    }
    // Fallback for viewers without the application object exposed.
    const container = this.container
    const target = this.pages[page - 1]
    if (container && target) container.scrollTop = target.offsetTop
  }

  /** Apply a ratio of the scrollable height. */
  scrollToRatio(ratio: number): void {
    const container = this.container
    if (!container) return
    const scrollable = Math.max(1, container.scrollHeight - container.clientHeight)
    container.scrollTop = Math.max(0, Math.min(1, ratio)) * scrollable
  }
}

export class PDFViewer {
  private state: ScrollState | null = null

  constructor(private readonly adapter: PDFViewerAdapter) {}

  /**
   * Remember where the user is. Must run before the new PDF is loaded.
   * @returns the captured state, or null when nothing is rendered yet.
   */
  captureScrollState(): ScrollState | null {
    const page = this.adapter.getVisiblePage()
    if (page == null) return null
    this.state = { page, ratio: this.adapter.getScrollRatio() }
    return this.state
  }

  /**
   * Restore the remembered position, clamped to the new page count.
   * @returns true when a restore was attempted.
   */
  restoreScrollState(): boolean {
    const state = this.state
    if (!state) return false
    const total = this.adapter.totalPages()
    const target = Math.min(state.page, Math.max(1, total))
    this.adapter.scrollToPage(target)
    // Page scroll lands first; the ratio then refines within the page. Two frames
    // because the viewer re-lays out asynchronously after a document swap.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => this.adapter.scrollToRatio(state.ratio))
    })
    return true
  }

  /** Drop any captured state (called when the user opens a different file). */
  reset(): void {
    this.state = null
  }
}

/**
 * Convert a click in the page element to PDF user-space coordinates.
 *
 * PDF.js lays pages out in CSS pixels (96 dpi, top-left origin); SyncTeX reports
 * PDF points (72 dpi). Whether the PDF origin is bottom-left or top-left is still
 * being verified (docs/spikes.md §B9 records `y ≈ v`, which suggests top-left),
 * so `flipY` is explicit rather than baked in: calibrate once on a real machine
 * and pass the answer here.
 * @param event - the click/double-click event.
 * @param pageElement - the `.page` element that was hit.
 * @param options.scale - the viewer's current page scale.
 * @param options.flipY - subtract from page height (bottom-left origin) when true.
 * @param options.paddingTop - page padding above the rendered content, in CSS px.
 * @returns the point in PDF user space.
 */
export function pdfPointFromClick(
  event: MouseEvent,
  pageElement: HTMLElement,
  options: { scale: number; flipY: boolean; paddingTop?: number },
): PdfPoint {
  const rect = pageElement.getBoundingClientRect()
  const scale = options.scale > 0 ? options.scale : 1
  const paddingTop = options.paddingTop ?? 0
  const cssX = event.clientX - rect.left
  const cssY = event.clientY - rect.top
  const pdfX = (cssX / scale) * (72 / 96)
  const pdfY = options.flipY ? ((rect.height - cssY) / scale) * (72 / 96) - paddingTop : (cssY / scale) * (72 / 96) - paddingTop
  return { x: pdfX, y: pdfY }
}
