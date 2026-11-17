/**
 * A diff must partition the source, not sample it.
 *
 * Every consumer of the diff — the bands, the seam anchors, the removed-text row —
 * assumes line numbers are contiguous and that nothing is counted twice or dropped.
 * These tests pin that by rebuilding both revisions out of the blocks: whatever the
 * diff says happened, applying it has to reproduce exactly the documents it was
 * given (docs/spikes.md §B21, §B23).
 *
 * @module dsh-latex-preview/test/unit/diff-partition
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { lineDiff, normalizeLatex } from '../../src/services/diff.ts'
import { diffHunks, insertionAnchor } from '../../src/services/diff-regions.ts'
import type { DiffBlock } from '../../src/types.ts'

/**
 * Rebuild both revisions from the blocks, the way a patch would.
 * @param blocks - diff blocks in document order.
 * @returns the old and new documents the blocks describe.
 */
function rebuild(blocks: readonly DiffBlock[]): { oldText: string; newText: string } {
  let oldText = ''
  let newText = ''
  for (const block of blocks) {
    if (block.type !== 'insert') oldText += block.text
    if (block.type !== 'delete') newText += block.text
  }
  return { oldText, newText }
}

/**
 * Assert a diff loses nothing and duplicates nothing.
 * @param oldText - previous revision.
 * @param newText - current revision.
 */
function assertPartitions(oldText: string, newText: string): void {
  const blocks = lineDiff(oldText, newText)
  const rebuilt = rebuild(blocks)
  assert.equal(rebuilt.oldText, normalizeLatex(oldText), 'the old side must be reconstructed exactly')
  assert.equal(rebuilt.newText, normalizeLatex(newText), 'the new side must be reconstructed exactly')

  // Line ranges must tile the new document in order with no gaps and no overlap,
  // because every band is placed from these numbers.
  let nextLine = 1
  for (const block of blocks) {
    if (block.type === 'insert') {
      assert.equal(block.oldLines, 0, 'an insertion consumes no old lines')
    }
    if (block.type === 'delete') continue
    assert.equal(block.startLine, nextLine, `block starts at ${block.startLine}, expected ${nextLine}`)
    nextLine = block.endLine + 1
  }
}

test('an insertion above the first line partitions both revisions', () => {
  assertPartitions('A\nB\n', 'X\nA\nB\n')
})

test('an insertion between lines partitions both revisions', () => {
  assertPartitions('A\nB\nC\n', 'A\nX\nB\nC\n')
})

test('an insertion at the end partitions both revisions', () => {
  assertPartitions('A\nB\n', 'A\nB\nX\n')
})

test('a deletion partitions both revisions', () => {
  assertPartitions('A\nB\nC\nD\n', 'A\nD\n')
})

test('a replacement partitions both revisions', () => {
  assertPartitions('A\nB\nC\n', 'A\nB2\nC\n')
})

test('mixed edits at both ends and in the middle partition both revisions', () => {
  assertPartitions('head\nA\nB\nC\ntail\n', 'new head\nA\nB2\ntail\nplus one more\n')
})

test('an empty revision and a filled one still partition', () => {
  assertPartitions('', 'A\n')
  assertPartitions('A\n', '')
})

test('successive insertions keep their anchors in document order', () => {
  // Long enough equal runs that `cleanupSemantic` keeps three separate hunks —
  // with one-line paragraphs it merges them into a single `modify`, which is its
  // documented behaviour (small equal runs are absorbed).
  const oldText = 'A\nA2\nA3\nB\nB2\nB3\nC\nC2\nC3\n'
  const newText = 'A\nA2\nA3\nX\nB\nB2\nB3\nY\nC\nC2\nC3\nZ\n'
  const hunks = diffHunks(lineDiff(oldText, newText))
  assert.deepEqual(
    hunks.map((hunk) => hunk.kind),
    ['insert', 'insert', 'insert'],
  )
  assert.deepEqual(
    hunks.map((hunk) => insertionAnchor(hunk.oldStart, 9)),
    [
      { line: 3, edge: 'bottom' },
      { line: 6, edge: 'bottom' },
      { line: 9, edge: 'bottom' },
    ],
  )
})
