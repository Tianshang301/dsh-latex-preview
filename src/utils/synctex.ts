/**
 * SyncTeX bridge — always the CLI, never a hand-written `.synctex` parser.
 *
 * Format notes are measured, not assumed (see docs/spikes.md §B9):
 * - `view` needs the source path as an **absolute path with forward slashes**.
 *   Both a relative path and a backslash Windows path return `No tag`.
 * - Box dimensions come back as **uppercase** `W:` / `H:`.
 * - `edit` returns `Input:` (absolute, backslashed), `Line:`, `Column:` which can
 *   be `-1`, `Offset:`, and a free-form `Context:` block.
 *
 * @module dsh-latex-preview/utils/synctex
 */

import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import type { SyncEditHit, SyncViewHit } from '../types.ts'

const MAX_BUFFER = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Normalise a path the way `synctex view -i` expects it.
 * @param file - path, absolute or relative to `cwd`.
 * @param cwd - base for relative input.
 * @returns absolute path with `/` separators.
 */
export function toSynctexPath(file: string, cwd = process.cwd()): string {
  return resolve(cwd, file).replace(/\\/g, '/')
}

/** Numeric field reader that tolerates negative values (`Column:-1`). */
function num(body: string, key: string): number {
  const match = new RegExp(`^${key}:(-?[\\d.]+)`, 'm').exec(body)
  return match ? Number.parseFloat(match[1] as string) : 0
}

/** Pull every `SyncTeX result begin … end` block out of stdout. */
function blocks(stdout: string): string[] {
  const out: string[] = []
  const parts = stdout.split('SyncTeX result begin')
  for (const part of parts.slice(1)) {
    const body = part.split('SyncTeX result end')[0]
    if (body) out.push(body)
  }
  return out
}

/** String field reader for non-numeric keys. */
function text(body: string, key: string): string {
  const match = new RegExp(`^${key}:(.*)$`, 'm').exec(body)
  return match ? (match[1] as string).trim() : ''
}

/**
 * Parse `synctex view` output.
 * @param stdout - raw stdout.
 * @returns one hit per result block; empty when SyncTeX had no tag for the file.
 */
export function parseView(stdout: string): SyncViewHit[] {
  const hits: SyncViewHit[] = []
  for (const body of blocks(stdout)) {
    const page = num(body, 'Page')
    if (!page) continue
    hits.push({
      page,
      x: num(body, 'x'),
      y: num(body, 'y'),
      h: num(body, 'h'),
      v: num(body, 'v'),
      width: num(body, 'W'),
      height: num(body, 'H'),
    })
  }
  return hits
}

/**
 * Parse `synctex edit` output.
 * @param stdout - raw stdout.
 * @returns one hit per result block; `line` is 0 when the tool reported none.
 */
export function parseEdit(stdout: string): SyncEditHit[] {
  const hits: SyncEditHit[] = []
  for (const body of blocks(stdout)) {
    const line = num(body, 'Line')
    const file = text(body, 'Input') || text(body, 'Output')
    if (!file) continue
    hits.push({ file, line, column: num(body, 'Column') })
  }
  return hits
}

/** Reject with the tool's own stderr, which is the only useful diagnostic it gives. */
function fail(command: string, stderr: string, code: number | null): Error {
  const detail = stderr.trim() || `exit ${String(code)}`
  return new Error(`synctex ${command} failed: ${detail}`)
}

/** Run one `synctex` subcommand and hand back stdout. */
function runSynctex(args: readonly string[], timeoutMs: number): Promise<string> {
  return new Promise((resolveRun, rejectRun) => {
    execFile(
      'synctex',
      [...args],
      { maxBuffer: MAX_BUFFER, timeout: timeoutMs, windowsHide: true },
      (error, stdout, stderr) => {
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 0
        if (error && !/No tag/i.test(String(stderr))) {
          // `No tag` exits 0 with a warning on stdout in some builds; everything
          // else is a genuine failure.
          if (code !== 0) return rejectRun(fail(args[0] ?? 'synctex', String(stderr), code))
        }
        resolveRun(String(stdout))
      },
    )
  })
}

/**
 * Forward jump: source line → PDF position.
 * @param input - source file (absolute or relative to `cwd`).
 * @param line - 1-based line number.
 * @param pdf - PDF produced together with the `.synctex.gz`.
 * @param options - timeout and resolution base.
 * @returns every hit SyncTeX reports, in tool order.
 */
export async function synctexView(
  input: string,
  line: number,
  pdf: string,
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<SyncViewHit[]> {
  const cwd = options.cwd ?? process.cwd()
  const out = await runSynctex(
    ['view', '-i', `${line}:0:${toSynctexPath(input, cwd)}`, '-o', resolve(cwd, pdf)],
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  return parseView(out)
}

/**
 * Reverse jump: PDF point → source location.
 * @param page - 1-based page number.
 * @param x - horizontal coordinate in PDF points.
 * @param y - vertical coordinate in PDF points (see docs/spikes.md §B9 on origin).
 * @param pdf - PDF next to the `.synctex.gz`.
 * @param options - timeout and resolution base.
 * @returns every hit SyncTeX reports, in tool order.
 */
export async function synctexEdit(
  page: number,
  x: number,
  y: number,
  pdf: string,
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<SyncEditHit[]> {
  const cwd = options.cwd ?? process.cwd()
  const out = await runSynctex(
    ['edit', '-o', `${page}:${x}:${y}:${resolve(cwd, pdf)}`],
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  return parseEdit(out)
}
