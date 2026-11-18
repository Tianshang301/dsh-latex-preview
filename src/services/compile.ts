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
 * 3. **Rollback** — the PDF *and its `.synctex.gz`* are copied aside before
 *    compiling. On failure both are restored, so a broken edit neither blanks
 *    the preview nor leaves a new sync map pointing at an old PDF; when only one
 *    half can be restored the result says so (`rollbackIncomplete`) instead of
 *    reporting a clean rollback. A first compile that fails has nothing to
 *    restore to, so its partial output is removed rather than shown.
 *
 * The pre-compile copies are left in place on success: publishing them as a
 * revision is the service's call, because only it knows which revision they
 * describe and may therefore commit a manifest (see `artifacts.ts`).
 *
 * @module dsh-latex-preview/services/compile
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { BackupResult, CompileResult, LatexDiagnostic } from '../types.ts'
import { parseLatexLog } from '../utils/log-parser.ts'
import { artifactPaths } from './artifacts.ts'

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
  /**
   * Replacement for the real process, used by the rollback tests.
   *
   * Injecting the *outcome* (instead of a fake binary) is what lets a test reproduce
   * a compile that exits non-zero while leaving a partial PDF behind, or one that
   * deletes its own backup — neither of which a real Tectonic run will do on cue.
   */
  readonly run?: (timeoutMs: number) => Promise<CompileRun>
}

/** What one process run reports back, regardless of who produced it. */
export interface CompileRun {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly timedOut: boolean
}

/** Where a compile's output lives, derived from options. */
export interface CompilePaths {
  readonly pdf: string
  readonly prev: string
  readonly log: string
  readonly synctex: string
  /** Transient copy of `synctex`, restored with `prev` on failure. */
  readonly prevSynctex: string
  /** Manifest that commits {@link basePdf} + {@link baseSynctex} as one pair. */
  readonly baseManifest: string
  /** Persisted PDF of the **previous compile** (every successful run moves it). */
  readonly recentPdf: string
  /** Sync map for {@link recentPdf}; same basename pairing rule as the base pair. */
  readonly recentSynctex: string
  /** Manifest that commits {@link recentPdf} + {@link recentSynctex}. */
  readonly recentManifest: string
  /** Persisted PDF of the revision that preceded the current one. */
  readonly basePdf: string
  /**
   * Persisted sync map for {@link basePdf}.
   *
   * The basename must pair with `basePdf`: `synctex view -o main.prev.pdf` looks
   * for `main.prev.synctex.gz` and would silently find `main.synctex.gz`
   * otherwise, mapping old lines onto the new document.
   */
  readonly baseSynctex: string
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
  const accepted = artifactPaths(outDir, stem, 'prev')
  const recent = artifactPaths(outDir, stem, 'recent')
  return {
    pdf: join(outDir, `${stem}.pdf`),
    prev: join(outDir, `${stem}.pdf.prev`),
    log: join(outDir, `${stem}.log`),
    synctex: join(outDir, `${stem}.synctex.gz`),
    prevSynctex: join(outDir, `${stem}.synctex.gz.prev`),
    basePdf: accepted.pdf,
    baseSynctex: accepted.synctex,
    baseManifest: accepted.manifest,
    recentPdf: recent.pdf,
    recentSynctex: recent.synctex,
    recentManifest: recent.manifest,
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

/** sha256 of a file, for the backup record the service verifies against. */
async function sha256(path: string): Promise<string> {
  const bytes = await readFile(path)
  return createHash('sha256').update(bytes).digest('hex')
}

/** One-line reason from an unknown thrown value. */
function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
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

    const backup = await this.backupPair(paths)
    // A stale log would otherwise be parsed as if it belonged to this run.
    await removeQuietly(paths.log)

    const timeout = this.firstRunDone ? this.opts.timeoutMs : this.opts.firstRunTimeoutMs
    const runner = this.opts.run
    const { code, stdout, stderr, timedOut } = await (runner ? runner(timeout) : this.spawnTectonic(timeout))
    this.firstRunDone = true

    let diagnostics: LatexDiagnostic[] = []
    if (await exists(paths.log)) {
      const logText = await readFile(paths.log, 'utf8').catch(() => '')
      if (logText) diagnostics = parseLatexLog(logText, this.opts.rootFile, this.opts.outDir)
    }

    const ok = code === 0 && !timedOut && (await exists(paths.pdf))
    let rolledBack = false
    let rollbackIncomplete = false

    if (ok) {
      // The pre-compile copies stay where they are: publishing them as a revision
      // is the service's decision, because only it knows which revision they
      // describe and whether the manifest may claim them (artifacts.ts).
    } else if (backup.status === 'complete') {
      // Both halves or neither. A restored PDF next to an unrestored (new) sync map
      // is the exact failure the pair exists to prevent, so a half-done rollback is
      // reported instead of being rounded up to "rolled back".
      const pdfRestored = await this.restore(paths.prev, paths.pdf)
      const syncRestored = await this.restore(paths.prevSynctex, paths.synctex)
      rolledBack = pdfRestored && syncRestored
      rollbackIncomplete = !rolledBack
    } else if (backup.status === 'pdf-only') {
      // A PDF without a sync map can still be put back — it is what the user was
      // looking at — but no map may survive to describe it.
      const pdfRestored = await this.restore(paths.prev, paths.pdf)
      await removeQuietly(paths.synctex)
      rolledBack = pdfRestored
      rollbackIncomplete = !pdfRestored
    } else if (backup.status === 'failed') {
      // The old bytes are gone or unreachable, so the file on disk is now whatever
      // the failed run left. Nothing here can be called a rollback.
      rollbackIncomplete = true
    } else {
      // Nothing to restore to. Whatever the failed run left behind describes a
      // document that never compiled, so it must not become "the PDF on screen".
      await removeQuietly(paths.pdf)
      await removeQuietly(paths.synctex)
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
      rollbackIncomplete,
      backup,
    }
  }

  /**
   * Copy the artefacts on screen aside, as one pair.
   *
   * Three things this must not do, each a way the earlier version could hand a
   * stale or half-written file to the publisher:
   * - leave a copy from an earlier run in place (a failed copy then looks like a
   *   successful one) — hence the removal before copying;
   * - install either file before both are known good — hence the `.tmp` names and
   *   the rename at the end;
   * - report success without saying *which* bytes were copied — hence the hashes,
   *   which the service checks against the revision it is about to claim.
   * @param paths - this run's output paths.
   * @returns what was copied, and whether it forms a complete pair.
   */
  private async backupPair(paths: CompilePaths): Promise<BackupResult> {
    const tmpPdf = `${paths.prev}.tmp`
    const tmpSynctex = `${paths.prevSynctex}.tmp`
    await removeQuietly(paths.prev)
    await removeQuietly(paths.prevSynctex)
    await removeQuietly(tmpPdf)
    await removeQuietly(tmpSynctex)

    if (!(await exists(paths.pdf))) return { status: 'unavailable' }
    try {
      await copyFile(paths.pdf, tmpPdf)
    } catch (error) {
      await removeQuietly(tmpPdf)
      return { status: 'failed', reason: `PDF 备份失败：${messageOf(error)}` }
    }
    const pdfSha256 = await sha256(tmpPdf)
    try {
      await rename(tmpPdf, paths.prev)
    } catch (error) {
      await removeQuietly(tmpPdf)
      return { status: 'failed', reason: `PDF 备份无法就地安装：${messageOf(error)}` }
    }

    if (!(await exists(paths.synctex))) return { status: 'pdf-only', pdfSha256 }
    try {
      await copyFile(paths.synctex, tmpSynctex)
    } catch (error) {
      // Half a pair is not a pair: drop the PDF copy too, so nothing downstream can
      // mistake it for one.
      await removeQuietly(tmpSynctex)
      await removeQuietly(paths.prev)
      return { status: 'failed', reason: `SyncTeX 备份失败：${messageOf(error)}` }
    }
    const synctexSha256 = await sha256(tmpSynctex)
    try {
      await rename(tmpSynctex, paths.prevSynctex)
    } catch (error) {
      await removeQuietly(tmpSynctex)
      await removeQuietly(paths.prev)
      return { status: 'failed', reason: `SyncTeX 备份无法就地安装：${messageOf(error)}` }
    }
    return { status: 'complete', pdfSha256, synctexSha256 }
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
