/**
 * Turn a source diff into highlightable PDF rectangles.
 *
 * Two jobs, both pure so they can be reasoned about without a compiler:
 * 1. fold `insert` / `delete` blocks into hunks (`modify` = a delete immediately
 *    followed by an insert on the spot);
 * 2. merge the many boxes `synctex view` returns for one line into one band.
 *
 * The second is what stops the overlay from looking like confetti: SyncTeX emits
 * one box per horizontal box on a line, so a paragraph yields several boxes whose
 * y ranges coincide. Merging them per line gives the highlighter band a reader
 * expects (docs/spikes.md §B17).
 *
 * @module dsh-latex-preview/services/diff-regions
 */

import type { DiffBlock, DiffRegionKind, SyncViewHit } from '../types.ts'

/** One contiguous change, in terms of the new revision's line numbers. */
export interface DiffHunk {
  readonly kind: DiffRegionKind
  /** First source line in the new revision (for a deletion: where it was). */
  readonly lineStart: number
  /** Last source line in the new revision; equals `lineStart` for a deletion. */
  readonly lineEnd: number
  /** How many lines the deletion removed, 0 otherwise. */
  readonly removed: number
  /** First few characters of the changed text, for the hover title. */
  readonly preview: string
}

/**
 * Fold diff blocks into hunks.
 *
 * `lineDiff` reports a replaced paragraph as `delete` then `insert`; treating
 * them as two marks would paint the same spot twice in two colours, so an
 * adjacent pair becomes one `modify` anchored at the *new* lines.
 * @param blocks - blocks in document order, as `lineDiff` returns them.
 * @returns hunks in document order; `equal` blocks only separate them.
 */
export function diffHunks(blocks: readonly DiffBlock[]): DiffHunk[] {
  const hunks: DiffHunk[] = []
  let inserts: DiffBlock[] = []
  let deletes: DiffBlock[] = []

  const flush = (): void => {
    if (inserts.length === 0 && deletes.length === 0) return
    if (inserts.length > 0) {
      const lineStart = inserts[0]!.startLine
      const lineEnd = inserts[inserts.length - 1]!.endLine
      hunks.push({
        kind: deletes.length > 0 ? 'modify' : 'insert',
        lineStart,
        lineEnd: Math.max(lineStart, lineEnd),
        removed: deletedLineCount(deletes),
        preview: previewOf(inserts),
      })
    } else {
      const lineStart = deletes[0]!.startLine
      hunks.push({
        kind: 'delete',
        lineStart,
        lineEnd: lineStart,
        removed: deletedLineCount(deletes),
        preview: previewOf(deletes),
      })
    }
    inserts = []
    deletes = []
  }

  for (const block of blocks) {
    if (block.type === 'equal') {
      flush()
      continue
    }
    if (block.type === 'insert') inserts.push(block)
    else deletes.push(block)
  }
  flush()
  return hunks
}

/**
 * One rectangle per text line, built from the boxes SyncTeX reported.
 *
 * Merge rule: boxes on the same page whose vertical ranges overlap by at least
 * half of the shorter one belong to the same rendered line; their union in x is
 * the band. Anything less overlapping is a separate line (or a superscript).
 * @param hits - every `synctex view` result for one hunk.
 * @returns bands in reading order, per page.
 */
export function bandsFromHits(hits: readonly SyncViewHit[]): Array<{ page: number; x: number; y: number; width: number; height: number }> {
  const byPage = new Map<number, SyncViewHit[]>()
  for (const hit of hits) {
    if (hit.page < 1 || hit.width <= 0 || hit.height <= 0) continue
    const list = byPage.get(hit.page)
    if (list) list.push(hit)
    else byPage.set(hit.page, [hit])
  }

  const bands: Array<{ page: number; x: number; y: number; width: number; height: number }> = []
  for (const [page, list] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...list].sort((a, b) => topOf(a) - topOf(b) || a.x - b.x)
    let current: { x: number; y: number; right: number; bottom: number } | null = null
    const push = (): void => {
      if (!current) return
      bands.push({ page, x: current.x, y: current.y, width: current.right - current.x, height: current.bottom - current.y })
      current = null
    }
    for (const hit of sorted) {
      const top = topOf(hit)
      const bottom = top + hit.height
      if (!current) {
        current = { x: hit.x, y: top, right: hit.x + hit.width, bottom }
        continue
      }
      const overlap = Math.min(current.bottom, bottom) - Math.max(current.y, top)
      const shorter = Math.min(current.bottom - current.y, hit.height)
      if (overlap >= shorter * 0.5) {
        current.x = Math.min(current.x, hit.x)
        current.right = Math.max(current.right, hit.x + hit.width)
        current.y = Math.min(current.y, top)
        current.bottom = Math.max(current.bottom, bottom)
      } else {
        push()
        current = { x: hit.x, y: top, right: hit.x + hit.width, bottom }
      }
    }
    push()
  }
  return bands
}

/**
 * Top edge of a SyncTeX box, in PDF points.
 *
 * `synctex view` reports `y` as the box's reference line, not its top edge: on a
 * real page `y + H` lands below the text while `v - H` coincides with the text
 * layer's span (measured full overlap, ≤2 px error on two consecutive lines).
 * `v` is therefore the bottom edge, `H` the line height (docs/spikes.md §B17).
 * @param hit - one `synctex view` result.
 * @returns the top edge, falling back to `y - height` when `v` is absent.
 */
function topOf(hit: SyncViewHit): number {
  return hit.v > 0 ? hit.v - hit.height : hit.y - hit.height
}

/** Lines in a diff fragment, matching `lineDiff`'s own counting. */
function countLines(text: string): number {
  if (text === '') return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}

/** Total lines removed by a set of delete blocks. */
function deletedLineCount(blocks: readonly DiffBlock[]): number {
  return blocks.reduce((sum, block) => sum + countLines(block.text), 0)
}

/** First meaningful characters of the changed text, for a tooltip. */
function previewOf(blocks: readonly DiffBlock[]): string {
  for (const block of blocks) {
    for (const line of block.text.split('\n')) {
      const trimmed = line.trim()
      if (trimmed !== '') return trimmed.length > 60 ? `${trimmed.slice(0, 60)}…` : trimmed
    }
  }
  return ''
}
