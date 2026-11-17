/**
 * Where a pure insertion is marked on the previous revision.
 *
 * The inserted lines have no pixels in the old PDF, so the only thing that can be
 * drawn there is a seam — and the seam has to sit where the new text went in, not
 * at the anchor SyncTeX happens to answer for (a closing tag answers with the page
 * number, docs/spikes.md §B17/§B22).
 *
 * @module dsh-latex-preview/test/unit/diff-insertion
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { lineDiff } from '../../src/services/diff.ts'
import { diffHunks, insertionAnchor, type DiffHunk } from '../../src/services/diff-regions.ts'

/**
 * Diff two revisions and return the single hunk they must produce.
 * @param oldText - previous revision; end it with a newline like a real file.
 * @param newText - current revision.
 * @returns the hunk.
 */
function onlyHunk(oldText: string, newText: string): DiffHunk {
  const hunks = diffHunks(lineDiff(oldText, newText))
  assert.equal(hunks.length, 1, `expected exactly one hunk, got ${JSON.stringify(hunks)}`)
  return hunks[0]!
}

test('insertion above the first line anchors on line 1 top edge', () => {
  const hunk = onlyHunk('A\nB\n', 'X\nA\nB\n')
  assert.equal(hunk.kind, 'insert')
  assert.equal(hunk.oldLines, 0)
  assert.equal(hunk.oldStart, 1)
  assert.deepEqual(insertionAnchor(hunk.oldStart, 2), { line: 1, edge: 'top' })
})

test('insertion between two lines anchors on the preceding line bottom edge', () => {
  const hunk = onlyHunk('A\nB\n', 'A\nX\nB\n')
  assert.equal(hunk.kind, 'insert')
  assert.equal(hunk.oldLines, 0)
  assert.equal(hunk.oldStart, 2)
  assert.deepEqual(insertionAnchor(hunk.oldStart, 2), { line: 1, edge: 'bottom' })
})

test('insertion after the last line anchors on that line bottom edge', () => {
  const hunk = onlyHunk('A\nB\n', 'A\nB\nX\n')
  assert.equal(hunk.kind, 'insert')
  assert.equal(hunk.oldLines, 0)
  assert.equal(hunk.oldStart, 3)
  assert.deepEqual(insertionAnchor(hunk.oldStart, 2), { line: 2, edge: 'bottom' })
})

test('insertion before a closing tag never anchors on the tag itself', () => {
  // The case that motivated the fix: `\end{document}` answers `synctex view` with
  // the page-number box, so anchoring on it put the seam in the page footer.
  const oldText = '\\begin{document}\nBody.\n\\end{document}\n'
  const newText = '\\begin{document}\nBody.\nAdded paragraph.\n\\end{document}\n'
  const hunk = onlyHunk(oldText, newText)
  assert.equal(hunk.oldStart, 3)
  assert.deepEqual(insertionAnchor(hunk.oldStart, 3), { line: 2, edge: 'bottom' })
})

test('a one-line document still anchors inside the document', () => {
  assert.deepEqual(insertionAnchor(1, 1), { line: 1, edge: 'top' })
  assert.deepEqual(insertionAnchor(2, 1), { line: 1, edge: 'bottom' })
})

test('an anchor past the end is clamped to the last line', () => {
  assert.deepEqual(insertionAnchor(9, 4), { line: 4, edge: 'bottom' })
})

test('a document with no lines at all stays at line 1', () => {
  assert.deepEqual(insertionAnchor(5, 0), { line: 1, edge: 'bottom' })
})
