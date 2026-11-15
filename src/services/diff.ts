/**
 * Line-level diff with LaTeX-aware normalisation.
 *
 * Normalisation exists so a reformat (comment added, spaces rewritten) does not
 * drown a real content change — but it must not change line *counts*, because
 * `startLine` / `endLine` are the anchors SyncTeX jumps use. So normalisation is
 * strictly per-line: no merging, no removal of lines.
 *
 * @module dsh-latex-preview/services/diff
 */

import DiffMatchPatch from 'diff-match-patch'
import type { DiffBlock } from '../types.ts'

/**
 * Normalise one LaTeX line for comparison only (never for display).
 *
 * - strips a trailing `%` comment (an escaped `\%` is kept)
 * - collapses runs of whitespace
 * - trims
 * @param line - one source line, without its newline.
 * @returns the comparable form.
 */
export function normalizeLatexLine(line: string): string {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '\\') {
      // Keep the escape and the escaped character verbatim (\% is not a comment).
      out += ch + (line[i + 1] ?? '')
      i += 1
      continue
    }
    if (ch === '%') break
    out += ch
  }
  return out.replace(/[ \t]+/g, ' ').trim()
}

/**
 * Normalise a whole document, line-count preserved.
 * @param source - full file text.
 * @returns the comparable text with the same number of lines.
 */
export function normalizeLatex(source: string): string {
  return source.split(/\r?\n/).map(normalizeLatexLine).join('\n')
}

/**
 * Line-level diff between two revisions.
 * @param oldText - previous source.
 * @param newText - current source.
 * @param options.normalize - compare normalised lines (default true).
 * @returns blocks in document order; line numbers are 1-based and refer to `newText`,
 *   except for `delete` blocks which point at the position they were removed from.
 */
export function lineDiff(oldText: string, newText: string, options: { normalize?: boolean } = {}): DiffBlock[] {
  const normalize = options.normalize ?? true
  const left = normalize ? normalizeLatex(oldText) : oldText
  const right = normalize ? normalizeLatex(newText) : newText

  // diff_linesToChars_ maps every distinct line to one character, which is the
  // only line-accurate mode diff-match-patch offers.
  const mapper = new DiffMatchPatch()
  const mapped = mapper.diff_linesToChars_(left, right)
  const diffs = mapper.diff_main(mapped.chars1, mapped.chars2, false)
  mapper.diff_charsToLines_(diffs, mapped.lineArray)
  mapper.diff_cleanupSemantic(diffs)

  const blocks: DiffBlock[] = []
  let newLine = 1
  for (const [op, text] of diffs) {
    if (text === '') continue
    const lineCount = countLines(text)
    const startLine = newLine
    if (op !== -1) newLine += lineCount
    blocks.push({
      type: op === 1 ? 'insert' : op === -1 ? 'delete' : 'equal',
      text,
      startLine,
      endLine: op === -1 ? startLine : startLine + Math.max(0, lineCount - 1),
    })
  }
  return blocks
}

/**
 * Count lines in a diff fragment.
 *
 * `diff_linesToChars_` keeps the trailing newline of every line except the last
 * fragment, so `"a\nb\n"` is two lines, not three.
 * @param text - fragment.
 * @returns number of source lines the fragment covers.
 */
function countLines(text: string): number {
  if (text === '') return 0
  const parts = text.split('\n')
  return text.endsWith('\n') ? parts.length - 1 : parts.length
}
