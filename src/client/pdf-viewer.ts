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

import type { DiffRegion } from '../types.ts'

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

  /**
   * Deliver a message to the viewer.
   *
   * Same-origin only, which is also why the viewer can be scripted at all; a
   * cross-origin mount would have to switch this to a real channel.
   * @param message - payload to post.
   */
  post(message: unknown): void {
    this.iframe.contentWindow?.postMessage(message, '*')
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
    // `scrollPageIntoView` only logs a warning for a bad page number (observed:
    // `scrollPageIntoView: "1" is not a valid pageNumber parameter.`), so a value
    // that arrived as a string would silently do nothing. Normalise here.
    const pageNumber = Math.trunc(Number(page))
    if (!Number.isFinite(pageNumber) || pageNumber < 1) return
    const app = this.app
    if (app?.pdfViewer) {
      app.pdfViewer.scrollPageIntoView({ pageNumber })
      return
    }
    // Fallback for viewers without the application object exposed.
    const container = this.container
    const target = this.pages[pageNumber - 1]
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

  /**
   * Show or clear the diff overlay.
   * @param regions - rectangles in PDF points, already resolved by the Host.
   * @param visible - false hides them without forgetting them.
   */
  showDiff(regions: readonly DiffRegion[], visible: boolean): void {
    this.adapter.post({ source: 'latex-preview-panel', type: 'diff', regions, visible })
  }

  /**
   * Turn the viewer's gestures off (or back on).
   *
   * Set while the previous revision is on screen: its pages map to the *old*
   * source, so pointing at a line there would edit or report the wrong one. The
   * overlay stays live, which is the only thing that view is for.
   * @param readOnly - true to suppress selection, double-click and band jumps.
   */
  setReadOnly(readOnly: boolean): void {
    this.adapter.post({ source: 'latex-preview-panel', type: 'mode', readOnly })
  }

  /** Drop any captured state (called when the user opens a different file). */
  reset(): void {
    this.state = null
  }

  /**
   * Scroll to a page without disturbing the remembered position.
   * Used by diagnostic clicks, where the target comes from SyncTeX rather than
   * from where the user was.
   * @param page - 1-based page number.
   */
  jumpToPage(page: number): void {
    this.adapter.scrollToPage(page)
  }
}

/**
 * Convert a click in the page element to PDF user-space coordinates.
 *
 * PDF.js reports the page viewport in PDF points at `scale: 1` (a Letter page is
 * 612×792), so a click only needs to be expressed as a fraction of the rendered
 * element — no dpi conversion (docs/spikes.md §B15). The origin is top-left, which
 * the same sweep confirmed; `flipY` stays explicit for other renderers.
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
  // `rect` is the rendered page (viewport × scale) in CSS px; dividing by the
  // scale lands in PDF points directly.
  const pdfX = cssX / scale
  const pdfY = options.flipY ? (rect.height - cssY) / scale - paddingTop : cssY / scale - paddingTop
  return { x: pdfX, y: pdfY }
}
