/**
 * The latexdiff 对比视图: a *third document* that renders both revisions at once.
 *
 * Why a third document, and not more overlay bands: a deletion has no pixels in
 * the new PDF — the typesetter already closed the hole — so no overlay on that
 * PDF can ever show the removed words. `latexdiff` solves it the only faithful
 * way: it merges the old and new source into one markup document where removed
 * text is wrapped in `\DIFdel` (red, struck through) and added text in
 * `\DIFadd` (blue, wavy), and *that* document is compiled, so the removed text
 * is typeset — struck out — exactly where it used to stand. This is the
 * PDF-world equivalent of a git diff: additions and deletions both visible.
 *
 * Pipeline per build: write both snapshots to `outDir`, run `latexdiff old new`
 * → `<stem>.diff.tex`, hand that to `CompileService` (single-flight, timeout,
 * rollback — a failed diff build keeps the previous diff PDF, same philosophy
 * as the main compile), then remove the two snapshot files. The diff source
 * itself is kept next to the PDF for inspection.
 *
 * Known limits, by design: `latexdiff` without `--flatten` diffs the root file
 * only, so changes inside `\input` files appear only through their effect on
 * the root (the band overlay has the same root-line granularity); and exotic
 * documents can produce markup that does not compile — that surfaces as a
 * readable failure and the last good diff PDF stays.
 *
 * @module dsh-latex-preview/services/diffdoc
 */

import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { CompileService } from './compile.ts'

/** Options for one diff-document builder. */
export interface DiffDocOptions {
  /** Absolute path of the root `.tex` (stem names the artifacts). */
  readonly rootFile: string
  /** Output directory receiving every artifact. */
  readonly outDir: string
  /** Steady-state compile budget for the diff document. */
  readonly timeoutMs: number
  /** First-run budget; the diff preamble may pull extra packages. */
  readonly firstRunTimeoutMs: number
}

/** Result of one build attempt. */
export interface DiffDocBuild {
  /** Whether a diff PDF exists after the attempt (built now or kept from before). */
  readonly ok: boolean
  /** Absolute path of the diff PDF, or null when none exists. */
  readonly pdfPath: string | null
  /** One-line outcome for the status bar. */
  readonly message: string
  /** First error line when the build failed. */
  readonly detail?: string
}

/** `latexdiff --version` budget; the probe must not hang the panel. */
const PROBE_TIMEOUT_MS = 15_000

/** One `latexdiff` run: output text, or why there is none. */
interface LatexdiffRun {
  readonly ok: boolean
  readonly stdout: string
  readonly stderr: string
  readonly failure?: string
}

/**
 * Run `latexdiff old new` and capture its stdout (the marked-up document).
 *
 * `--encoding=UTF-8` keeps non-ASCII sources intact through the Perl-side
 * round trip (this plugin's demo document is Chinese with `ctex`, and the
 * first real test was exactly that).
 */
function runLatexdiff(oldFile: string, newFile: string, timeoutMs: number): Promise<LatexdiffRun> {
  return new Promise((resolve) => {
    execFile(
      'latexdiff',
      ['--encoding=UTF-8', oldFile, newFile],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
          if (code === -1) return resolve({ ok: false, stdout: '', stderr: '', failure: error.message })
          return resolve({ ok: false, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), failure: `exit ${code}` })
        }
        resolve({ ok: true, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') })
      },
    )
  })
}

/** Whether `latexdiff` runs at all; probed once per process, cached. */
let latexdiffAvailable: boolean | undefined

/**
 * Probe `latexdiff --version` once.
 *
 * MiKTeX ships it (`miktex packages install latexdiff`), TeX Live via
 * `tlmgr install latexdiff`; the probe result names the fallback in its
 * caller's message, so the user gets an actionable hint, not a silent button.
 * @returns whether the command exists and runs.
 */
export async function probeLatexdiff(): Promise<boolean> {
  if (latexdiffAvailable !== undefined) return latexdiffAvailable
  return new Promise<boolean>((resolve) => {
    execFile('latexdiff', ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
      latexdiffAvailable = !error && /latexdiff/i.test(String(stdout ?? ''))
      resolve(latexdiffAvailable)
    })
  })
}

export class DiffDocService {
  private readonly opts: DiffDocOptions
  /** Single-flight: a second request joins the running build. */
  private running: Promise<DiffDocBuild> | null = null

  constructor(opts: DiffDocOptions) {
    this.opts = opts
  }

  /** Paths of the artifacts this builder owns. */
  paths(): { diffTex: string; diffPdf: string } {
    const stem = basename(this.opts.rootFile, '.tex')
    return {
      diffTex: join(this.opts.outDir, `${stem}.diff.tex`),
      diffPdf: join(this.opts.outDir, `${stem}.diff.pdf`),
    }
  }

  /**
   * Build the diff document between two revisions.
   *
   * Concurrent callers join the in-flight build (they all want the same
   * document); the snapshots are written per call so a build can never mix
   * revisions.
   * @param base - last accepted source.
   * @param head - source of the PDF currently on screen.
   * @returns the build outcome.
   */
  async build(base: string, head: string): Promise<DiffDocBuild> {
    if (this.running) return this.running
    this.running = this.execute(base, head).finally(() => {
      this.running = null
    })
    return this.running
  }

  /** One build: snapshots → latexdiff → tectonic → cleanup. */
  private async execute(base: string, head: string): Promise<DiffDocBuild> {
    if (base === head) {
      return { ok: false, pdfPath: null, message: '两版内容一致，没有可对比的改动' }
    }
    if (!(await probeLatexdiff())) {
      return {
        ok: false,
        pdfPath: null,
        message: '未找到 latexdiff（对比视图需要它；MiKTeX: miktex packages install latexdiff，TeX Live: tlmgr install latexdiff）',
      }
    }

    const { diffTex, diffPdf } = this.paths()
    const stem = basename(this.opts.rootFile, '.tex')
    const oldFile = join(this.opts.outDir, `${stem}.diff.base.tex`)
    const newFile = join(this.opts.outDir, `${stem}.diff.head.tex`)
    await writeFile(oldFile, base, 'utf8')
    await writeFile(newFile, head, 'utf8')

    try {
      const run = await runLatexdiff(oldFile, newFile, this.opts.timeoutMs)
      if (!run.ok || run.stdout.trim() === '' || !run.stdout.includes('\\documentclass')) {
        const why = run.failure ? `latexdiff ${run.failure}` : (run.stderr.trim().split(/\r?\n/).find(Boolean) ?? 'no output')
        return { ok: false, pdfPath: null, message: 'latexdiff 生成对比源码失败', detail: why }
      }
      await writeFile(diffTex, run.stdout, 'utf8')

      // The diff document is compiled through the same runner as the main
      // one, so it inherits timeout and rollback: a failed diff build keeps
      // the previous diff PDF rather than blanking the view.
      const compiler = new CompileService({
        rootFile: diffTex,
        outDir: this.opts.outDir,
        timeoutMs: this.opts.timeoutMs,
        firstRunTimeoutMs: this.opts.firstRunTimeoutMs,
      })
      const result = await compiler.run()
      if (!result.ok || !result.pdfPath) {
        return {
          ok: false,
          pdfPath: null,
          message: '对比文档编译失败',
          detail: result.diagnostics[0]?.message ?? result.stderrTail.split(/\r?\n/).find(Boolean) ?? 'unknown',
        }
      }
      return { ok: true, pdfPath: result.pdfPath, message: `对比视图已生成（${(result.durationMs / 1000).toFixed(1)}s）` }
    } finally {
      // Snapshots are inputs of one build; the merged source and the PDF
      // stay for inspection, the two full copies do not.
      await rm(oldFile, { force: true }).catch(() => undefined)
      await rm(newFile, { force: true }).catch(() => undefined)
    }
  }
}

export default DiffDocService
