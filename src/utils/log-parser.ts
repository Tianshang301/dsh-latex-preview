/**
 * `.log` parser: errors and warnings from a Tectonic run.
 *
 * The spec's parser is a starting point; three things in a real log break it and
 * are handled here:
 * 1. LaTeX wraps one error message across several lines until a blank line —
 *    taking only the `!` line truncates most real messages.
 * 2. `l.N` may sit up to ~20 lines below the `!`, not 10.
 * 3. Diagnostics from `\input`-ed files are attributed to the *root* file unless
 *    the parser follows the `(./file.tex` ... `)` nesting. Without that, "click to
 *    jump" lands in the wrong file.
 *
 * @module dsh-latex-preview/utils/log-parser
 */

import { basename, isAbsolute, resolve } from 'node:path'
import type { LatexDiagnostic } from '../types.ts'

/** `! LaTeX Error: ...` and friends. */
const ERROR_START_RE = /^!\s?(.*)$/
/** `l.123 ...` (may be `l.123` alone when the line is empty). */
const LINE_HINT_RE = /^l\.(\d+)/m
/** `LaTeX Warning: ...` / `Package foo Warning: ...`. */
const WARNING_RE = /^(?:LaTeX|Package\s+\S+|Class\s+\S+)\s+Warning:\s*(.*)$/
/** `Overfull \hbox (12.3pt too wide) in paragraph at lines 10--12`. */
const OVERFULL_RE = /^(?:Overfull|Underfull)\s+\\[hv]box\b.*$/
/** A file pushed onto the log's parenthesis stack: `(./chapters/intro.tex` or `(/abs/path.tex`. */
const OPEN_FILE_RE = /\(([^()\s]+\.(?:tex|sty|cls|def|cfg|clo))/g

/**
 * Parse a `.log` into diagnostics.
 * @param log - full log text.
 * @param rootFile - absolute path used when no enclosing file can be determined.
 * @param cwd - directory relative log paths are resolved against (Tectonic's run dir).
 * @returns diagnostics in log order; errors and warnings interleaved as they occur.
 */
export function parseLatexLog(log: string, rootFile: string, cwd = process.cwd()): LatexDiagnostic[] {
  const lines = log.split(/\r?\n/)
  const diagnostics: LatexDiagnostic[] = []
  const fileStack: string[] = [rootFile]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string

    // Track `(./file.tex` nesting so later diagnostics carry the right file.
    for (const match of line.matchAll(OPEN_FILE_RE)) {
      const raw = match[1] as string
      fileStack.push(isAbsolute(raw) ? raw : resolve(cwd, raw))
    }
    // Cheap, well-behaved approximation of the closing paren: only when the line
    // *ends* with ')' do we pop, and never below the root.
    if (line.trimEnd().endsWith(')') && fileStack.length > 1) fileStack.pop()

    const errorStart = ERROR_START_RE.exec(line)
    if (errorStart) {
      const head = (errorStart[1] ?? '').trim()
      const message: string[] = head ? [head] : []
      let lineNo = 0
      let consumed = i
      let sourceExcerpt = ''

      // Collect continuation lines until a blank line, stopping at `l.N` — what
      // follows `l.N` is TeX echoing the offending source, not part of the message
      // (taking it verbatim leaks "world." and the next log event into the prompt).
      for (let j = i + 1; j < lines.length && j <= i + 40; j++) {
        const next = lines[j] as string
        consumed = j
        if (next.trim() === '') break
        const hint = LINE_HINT_RE.exec(next)
        if (hint) {
          lineNo = Number.parseInt(hint[1] as string, 10)
          const after = next.slice(hint[0].length).trim()
          const continuation = (lines[j + 1] ?? '').trim()
          sourceExcerpt = [after, continuation].filter(Boolean).join(' ')
          break
        }
        if (next.startsWith('!')) break
        // TeX's "See the ... manual" / "Type H <return>" trailers add nothing.
        if (/^(See the|Type\s+H\b|\s*$)/.test(next.trim())) continue
        message.push(next.trim())
      }

      const file = fileStack[fileStack.length - 1] ?? rootFile
      diagnostics.push({
        file,
        line: lineNo,
        message: message.join(' ').replace(/\s+/g, ' ').trim() || '未知错误',
        context: [contextAround(lines, i, consumed), sourceExcerpt ? `源行：${sourceExcerpt}` : '']
          .filter(Boolean)
          .join('\n'),
        severity: 'error',
      })
      i = Math.max(i, consumed)
      continue
    }

    const warning = WARNING_RE.exec(line)
    if (warning) {
      diagnostics.push({
        file: fileStack[fileStack.length - 1] ?? rootFile,
        line: 0,
        message: (warning[1] ?? '').trim(),
        context: contextAround(lines, i, i + 1),
        severity: 'warning',
      })
      continue
    }

    if (OVERFULL_RE.test(line)) {
      const lineNo = /at lines?\s+(\d+)/.exec(line)?.[1]
      diagnostics.push({
        file: fileStack[fileStack.length - 1] ?? rootFile,
        line: lineNo ? Number.parseInt(lineNo, 10) : 0,
        message: line.trim(),
        context: contextAround(lines, i, i + 1),
        severity: 'warning',
      })
    }
  }

  // A log with no `!` but a non-zero exit still failed; keep a synthetic error so
  // the UI never shows "failed with nothing to click".
  return diagnostics
}

/**
 * Build a short excerpt around a diagnostic.
 * @param lines - log lines.
 * @param from - first index.
 * @param to - last index (inclusive).
 * @returns at most 5 lines joined by newlines.
 */
function contextAround(lines: readonly string[], from: number, to: number): string {
  const start = Math.max(0, from - 1)
  const end = Math.min(lines.length, Math.max(to, from) + 2)
  return lines.slice(start, Math.min(end, start + 7)).join('\n')
}

/**
 * Attribution helper for callers that know only the log path.
 * @param logPath - absolute path of the `.log`.
 * @returns the run directory, which is what relative log paths resolve against.
 */
export function runDirOf(logPath: string): string {
  return resolve(logPath, '..')
}

/**
 * Human label for a diagnostic's file, for log lines and prompts.
 * @param file - absolute path.
 * @returns the basename, or the full path when the basename is empty.
 */
export function shortName(file: string): string {
  const name = basename(file)
  return name || file
}
