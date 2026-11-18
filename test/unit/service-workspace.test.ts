/**
 * What a compile may touch when the workspace changes underneath it.
 *
 * The previous round guarded the workspace *around* `compiler.run()` — "did a switch
 * happen while we were inside the compiler". This file tests the window after it:
 * the run has returned, the check has passed, and a `configure` lands while the run
 * is still reading the source, hashing the pair, publishing, or holding a credential.
 * Every one of those steps used to resolve its paths and identity from `this`, so a
 * stale run could publish into the new workspace's directory, drop the pair it had
 * just published, or write its own revision into the new workspace's three-version
 * state.
 *
 * The seam is `ServiceOptions.onRunReturned`: a position in time, not a mock.
 * `CompileService.run` returning is exactly where the old check sat, so pausing
 * there is the only way to hold a run in the window with its work still ahead of it.
 *
 * @module dsh-latex-preview/test/unit/service-workspace
 */

import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { CompileService, compilePaths, type CompileOptions, type CompileRun } from '../../src/services/compile.ts'
import { LatexPreviewService } from '../../src/services/latex-preview-service.ts'
import type { PreviewState } from '../../src/types.ts'
import { fakeBinaries } from './support.ts'

const DOC = (body: string): string =>
  ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}', ''].join('\n')
const A1 = DOC('甲一。')
const A2 = DOC('甲二。')
const A3 = DOC('甲三。')
const B1 = DOC('乙一。')

const digestOf = (source: string): string => createHash('sha1').update(source).digest('hex').slice(0, 12)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const signal = (): AbortSignal => new AbortController().signal

/** What the fake compiler should do. */
interface Behaviour {
  runs: number
  /** From this run number on, exit non-zero without writing anything. */
  failFromRun?: number
}

function writeOutputs(outDir: string, rootFile: string, content: string): void {
  const stem = basename(rootFile, '.tex')
  writeFileSync(join(outDir, `${stem}.pdf`), `PDF:${digestOf(content)}`)
  writeFileSync(join(outDir, `${stem}.synctex.gz`), `SYNC:${digestOf(content)}`)
}

interface Harness {
  readonly service: LatexPreviewService
  readonly behaviour: Behaviour
  stop(): Promise<void>
}

/**
 * Boot a service on one workspace, configured and with the watcher stopped so
 * compiles happen only when a test asks for one.
 * @param workDir - directory holding `main.tex`.
 * @param onRunReturned - optional pause between the compiler returning and publishing.
 * @returns the harness.
 */
async function boot(
  workDir: string,
  onRunReturned?: (workspace: { id: string; generation: number }) => Promise<void>,
): Promise<Harness> {
  const behaviour: Behaviour = { runs: 0 }
  const service = new LatexPreviewService(new Context(), {
    binaryProbe: async () => fakeBinaries(),
    onRunReturned,
    compileFactory: (options: CompileOptions) =>
      new CompileService({
        ...options,
        run: async (): Promise<CompileRun> => {
          behaviour.runs += 1
          const content = readFileSync(options.rootFile, 'utf8')
          if (behaviour.failFromRun !== undefined && behaviour.runs >= behaviour.failFromRun) {
            return { code: 1, stdout: '', stderr: 'fake failure', timedOut: false }
          }
          writeOutputs(options.outDir, options.rootFile, content)
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      }),
  })
  const stop = async (): Promise<void> => {
    await (service as unknown as { watcher: { stop(): Promise<void> } | null }).watcher?.stop()
  }
  await service.configure({ rootFile: join(workDir, 'main.tex'), review: 'manual' }, signal())
  await stop()
  return { service, behaviour, stop }
}

/** A fresh workspace with `main.tex` holding `source`. */
function workspaceSource(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-latex-workspace-'))
  writeFileSync(join(dir, 'main.tex'), source)
  return dir
}

/** Wait until `predicate` holds, or fail loudly. */
async function until(predicate: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The internal fields these tests need to inspect; not part of the wire surface. */
interface Internals {
  workspace: { id: string; rootFile: string; outDir: string; generation: number } | null
  trusted: unknown
  currentSource: string | null
  acceptedSource: string | null
}

const internals = (service: LatexPreviewService): Internals => service as unknown as Internals

test('a switch inside the publish window leaves the new workspace untouched', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  // Only the run the test arms is held; every other run (including B's first) flows.
  const h = await boot(a, async () => {
    if (!gate) return
    const held = gate
    gate = null
    await held
  })
  try {
    /** configure() kicks a compile; wait for it to be rendered. */
    const settleFirstCompile = async (): Promise<void> => {
      await until(() => h.behaviour.runs >= 1, 'a compile to start')
      await delay(150)
    }

    await settleFirstCompile()
    // A second compile of A, so A holds a published pair this run could take away.
    writeFileSync(join(a, 'main.tex'), A2)
    await h.service.compileNow(signal())
    const accepted = await h.service.getState(signal())
    assert.equal(accepted.baseRevisionId, digestOf(A1), 'A has a baseline to lose')

    // The run that will be held: its compiler returns, then nothing is published yet.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    writeFileSync(join(a, 'main.tex'), A3)
    const running = h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= 3, 'the held run to reach the compiler')

    // Switch while the run sits between the compiler and the publish. Its own
    // compile is queued behind the held one and will fail, so the three-version
    // state stays exactly as `configure` left it — anything else is contamination.
    h.behaviour.failFromRun = 4
    const configured = await h.service.configure({ rootFile: join(b, 'main.tex'), review: 'manual' }, signal())
    assert.equal(configured.rootFile, join(b, 'main.tex'))
    const versionBefore = configured.version

    hold.release?.()
    const result = await running
    await until(() => h.behaviour.runs >= 4, 'the new workspace’s compile to run')
    await delay(150)
    const after = await h.service.getState(signal())
    await h.stop()

    // The run itself: it compiled, and it says nothing is publishable.
    assert.equal(result.ok, true)
    assert.equal(result.pdfUrl, null, 'a stale run hands back no URL')
    assert.equal(readFileSync(join(a, '.latex-preview', 'main.pdf'), 'utf8'), `PDF:${digestOf(A3)}`, "A's own output")

    // Nothing of A may be visible in B.
    assert.equal(after.rootFile, join(b, 'main.tex'))
    assert.notEqual(after.version, versionBefore, 'B’s own failed compile patched the state')
    assert.equal(internals(h.service).currentSource, B1, 'the current revision is still B’s document')
    assert.equal(internals(h.service).acceptedSource, B1, 'and so is the accepted one')
    assert.equal(after.baseRevisionId, null, 'no baseline from A’s bytes')
    assert.equal(after.recentRevisionId, null)
    assert.equal(internals(h.service).trusted, null, 'no credential naming A’s bytes as B’s')
    // Nothing A published may land in B's directory.
    const bPaths = compilePaths(join(b, 'main.tex'), join(b, '.latex-preview'))
    for (const path of [bPaths.baseManifest, bPaths.recentManifest, bPaths.recentPdf, bPaths.basePdf]) {
      assert.equal(existsSync(path), false, path)
    }
  } finally {
    await h.stop()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('two configures in flight leave one workspace described in both places', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  const h = await boot(a)
  try {
    await until(() => h.behaviour.runs >= 1, 'the first compile to start')
    await delay(150)

    // The body awaits root resolution, a source read and an artefact restore, and
    // assigns `this.workspace` in the middle of that; overlapping calls used to
    // leave the state describing one project and the workspace another.
    await Promise.all([
      h.service.configure({ rootFile: join(b, 'main.tex'), review: 'manual' }, signal()),
      h.service.configure({ rootFile: join(a, 'main.tex'), review: 'manual' }, signal()),
    ])
    await delay(200)
    const state = await h.service.getState(signal())
    await h.stop()

    const workspace = internals(h.service).workspace
    assert.ok(workspace)
    assert.equal(state.rootFile, workspace.rootFile, 'state and workspace describe the same project')
    // Serialised, so the second call is the winner.
    assert.equal(state.rootFile, join(a, 'main.tex'))
    assert.equal(workspace.outDir, join(a, '.latex-preview'))
    if (state.pdfUrl !== null) {
      assert.equal(state.pdfUrl.includes('/.latex-preview/pdf/'), true, state.pdfUrl)
    }
  } finally {
    await h.stop()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})
