/**
 * Tectonic runner: single-flight, timeout, and PDF rollback.
 *
 * Three invariants, each fixing a specific way the naive version loses data:
 * 1. **Single-flight** — concurrent saves must not stack processes over one
 *    `outDir`. A call while running joins the in-flight promise and sets a
 *    pending flag; the finished run starts one more, so writes are never lost
 *    but processes never overlap.
 * 2. **Timeout** — the first compile downloads the bundle and can take minutes,
 *    so first-run and steady-state budgets differ. A killed process counts as
 *    failure and triggers rollback.
 * 3. **Rollback** — the PDF is copied to `.pdf.prev` before compiling. On
 *    failure that copy is restored, so a broken edit never blanks the preview.
 *    On success the `.prev` is removed.
 *
 * @module dsh-latex-preview/services/compile
 */

import { spawn } from 'node:child_process'
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { CompileResult, LatexDiagnostic } from '../types.ts'
import { parseLatexLog } from '../utils/log-parser.ts'

/** Everything a run needs; the service owns the mutable copy. */
export interface CompileOptions {
  /** Absolute path of the root `.tex`. */
  readonly rootFile: string
  /** Directory receiving pdf/log/synctex. Created when missing. */
  readonly outDir: string
  /** Steady-state budget. */
  readonly timeoutMs: number
  /** Budget for the first run, which may download packages. */
  readonly firstRunTimeoutMs: number
  /** Executable name or absolute path. */
  readonly tectonic?: string
}

/** Where a compile's output lives, derived from options. */
export interface CompilePaths {
  readonly pdf: string
  readonly prev: string
  readonly log: string
  readonly synctex: string
}

/** Number of stdout/stderr lines kept for the UI. */
const TAIL_LINES = 20

/**
 * Derive output paths from a root file and output directory.
 * @param rootFile - absolute root `.tex`.
 * @param outDir - output directory.
 * @returns absolute paths of pdf / prev / log / synctex.
 */
export function compilePaths(rootFile: string, outDir: string): CompilePaths {
  const stem = basename(rootFile, '.tex')
  return {
    pdf: join(outDir, `${stem}.pdf`),
    prev: join(outDir, `${stem}.pdf.prev`),
    log: join(outDir, `${stem}.log`),
    synctex: join(outDir, `${stem}.synctex.gz`),
  }
}

/** Keep the last N non-empty lines of a stream. */
function tail(text: string, lines = TAIL_LINES): string {
  return text
    .split(/\r?\n/)
    .filter((l) => l.trim() !== '')
    .slice(-lines)
    .join('\n')
}

/** Whether a path exists (any type). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Quietly remove a file. */
async function removeQuietly(path: string): Promise<void> {
  try {
    await unlink(path)
  } catch {
    /* already gone */
  }
}

export class CompileService {
  private running: Promise<CompileResult> | null = null
  private pending = false
  private firstRunDone = false
  private inflightCount = 0

  constructor(private opts: CompileOptions) {}

  /** Replace options (e.g. the user picked another root file or outDir). */
  configure(opts: CompileOptions): void {
    this.opts = opts
  }

  /** Output paths for the current options. */
  paths(): CompilePaths {
    return compilePaths(this.opts.rootFile, this.opts.outDir)
  }

  /** Whether a compile is in progress right now. */
  get busy(): boolean {
    return this.running !== null
  }

  /**
   * Compile the root file.
   *
   * Joins an in-flight run instead of starting a second process, and schedules
   * exactly one follow-up run when a request arrived mid-flight.
   * @returns the result of the run this caller observes.
   */
  async run(): Promise<CompileResult> {
    if (this.running) {
      this.pending = true
      return this.running
    }
    this.inflightCount += 1
    this.running = this.execute()
    try {
      return await this.running
    } finally {
      this.running = null
      if (this.pending) {
        this.pending = false
        // Deliberately not awaited: the caller already has a result to render.
        void this.run().catch(() => undefined)
      }
    }
  }

  /** One actual process run, including backup and rollback. */
  private async execute(): Promise<CompileResult> {
    const started = Date.now()
    const paths = this.paths()
    await mkdir(this.opts.outDir, { recursive: true })
    await mkdir(dirname(this.opts.rootFile), { recursive: true }).catch(() => undefined)

    const hadPdf = await exists(paths.pdf)
    if (hadPdf) await copyFile(paths.pdf, paths.prev).catch(() => undefined)
    // A stale log would otherwise be parsed as if it belonged to this run.
    await removeQuietly(paths.log)

    const timeout = this.firstRunDone ? this.opts.timeoutMs : this.opts.firstRunTimeoutMs
    const { code, stdout, stderr, timedOut } = await this.spawnTectonic(timeout)
    this.firstRunDone = true

    let diagnostics: LatexDiagnostic[] = []
    if (await exists(paths.log)) {
      const logText = await readFile(paths.log, 'utf8').catch(() => '')
      if (logText) diagnostics = parseLatexLog(logText, this.opts.rootFile, this.opts.outDir)
    }

    const ok = code === 0 && !timedOut && (await exists(paths.pdf))
    let rolledBack = false

    if (ok) {
      await removeQuietly(paths.prev)
    } else if (hadPdf) {
      rolledBack = await this.restore(paths.prev, paths.pdf)
    }

    if (!ok && diagnostics.length === 0) {
      diagnostics = [
        {
          file: this.opts.rootFile,
          line: 0,
          message: timedOut ? `编译超时（${Math.round(timeout / 1000)}s）已终止` : `tectonic 退出码 ${String(code)}，日志无错误记录`,
          context: tail(`${stdout}\n${stderr}`),
          severity: 'error',
        },
      ]
    }

    return {
      ok,
      exitCode: code,
      timedOut,
      durationMs: Date.now() - started,
      pdfPath: (await exists(paths.pdf)) ? paths.pdf : null,
      pdfUrl: null,
      logPath: (await exists(paths.log)) ? paths.log : null,
      diagnostics,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr),
      rolledBack,
    }
  }

  /** Restore `.pdf.prev` over the PDF, preferring an atomic rename. */
  private async restore(prev: string, pdf: string): Promise<boolean> {
    try {
      await rename(prev, pdf)
      return true
    } catch {
      // Windows refuses rename-over-existing in some states; fall back to copy.
      try {
        await copyFile(prev, pdf)
        await removeQuietly(prev)
        return true
      } catch {
        return false
      }
    }
  }

  /** Spawn Tectonic once and enforce the budget. */
  private spawnTectonic(timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
    const args = [
      '-X',
      'compile',
      this.opts.rootFile,
      '--synctex',
      '--keep-logs',
      '--outdir',
      this.opts.outDir,
    ]
    return new Promise((resolveRun) => {
      const child = spawn(this.opts.tectonic ?? 'tectonic', args, { cwd: this.opts.outDir, windowsHide: true })
      let stdout = ''
      let stderr = ''
      let timedOut = false

      const timer = setTimeout(() => {
        timedOut = true
        // SIGKILL: Tectonic prints its own SIGTERM handling on some platforms and
        // would otherwise linger while holding the output directory.
        child.kill('SIGKILL')
      }, timeoutMs)

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolveRun({ code: null, stdout, stderr: `${stderr}\n${error.message}`, timedOut })
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        resolveRun({ code, stdout, stderr, timedOut })
      })
    })
  }
}
