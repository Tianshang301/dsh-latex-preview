/**
 * Service-level tests for artefact provenance.
 *
 * Everything here drives a real `LatexPreviewService` inside a real Cordis context
 * and lets a real `CompileService` do the copying, hashing and rolling back. Only
 * the *process* is replaced (via `CompileOptions.run`), which is the one thing a
 * test must control: what a compile produces, and what the source looks like when
 * it starts and finishes.
 *
 * The module-level tests in `artifacts.test.ts` prove the manifest is internally
 * consistent; these prove the service never *hands* it something it cannot vouch
 * for. The distinction matters — a perfectly valid manifest over the wrong bytes is
 * the failure this whole design exists to prevent.
 *
 * @module dsh-latex-preview/test/unit/service-provenance
 */

import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { CompileService, compilePaths, type CompileOptions, type CompileRun } from '../../src/services/compile.ts'
import { LatexPreviewService } from '../../src/services/latex-preview-service.ts'
import type { PreviewState } from '../../src/types.ts'

const DOC = (body: string): string =>
  ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}', ''].join('\n')
const A = DOC('第一版。')
const B = DOC('第二版。')
const C = DOC('第三版。')

/** Same digest the service uses to name a revision. */
const digestOf = (source: string): string => createHash('sha1').update(source).digest('hex').slice(0, 12)

/** What the fake compiler should do on its next run. */
interface Behaviour {
  /** Reads the file mid-compile and rewrites it, simulating an edit that races. */
  mutate?: (content: string) => string
  /** Blocks the next run, so a test can inspect the state between two runs. */
  gateFromRun?: number
  gate?: () => Promise<void>
  /** Exit non-zero instead of producing a PDF. */
  fail?: boolean
  runs: number
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const signal = (): AbortSignal => new AbortController().signal

/** Write a fake but self-describing pair, so assertions can name the bytes. */
function writeOutputs(outDir: string, rootFile: string, content: string): void {
  const stem = basename(rootFile, '.tex')
  writeFileSync(join(outDir, `${stem}.pdf`), `PDF:${digestOf(content)}`)
  writeFileSync(join(outDir, `${stem}.synctex.gz`), `SYNC:${digestOf(content)}`)
}

/** A compile factory whose process reads the file, optionally mutates it, then writes. */
function factory(behaviour: Behaviour): (options: CompileOptions) => CompileService {
  return (options) =>
    new CompileService({
      ...options,
      run: async (): Promise<CompileRun> => {
        behaviour.runs += 1
        if (behaviour.gate && behaviour.gateFromRun !== undefined && behaviour.runs >= behaviour.gateFromRun) {
          await behaviour.gate()
        }
        const content = readFileSync(options.rootFile, 'utf8')
        if (behaviour.mutate) {
          // One-shot: the repair run that follows must see a stable file.
          const next = behaviour.mutate(content)
          behaviour.mutate = undefined
          writeFileSync(options.rootFile, next)
        }
        if (behaviour.fail) return { code: 1, stdout: '', stderr: 'fake failure', timedOut: false }
        writeOutputs(options.outDir, options.rootFile, content)
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      },
    })
}

/** A configured service whose watcher is off, so compiles happen only when asked. */
async function boot(
  workDir: string,
  review: 'manual' | 'auto' = 'manual',
): Promise<{ service: LatexPreviewService; behaviour: Behaviour; stop: () => Promise<void> }> {
  const behaviour: Behaviour = { runs: 0 }
  const service = new LatexPreviewService(new Context(), { compileFactory: factory(behaviour) })
  // The binary probe is not what these tests are about, and a missing `tectonic`
  // would veto every compile before the fake process ever ran.
  await delay(0)
  ;(service as unknown as { patch(next: Partial<PreviewState>): void }).patch({
    binaries: { tectonic: true, synctex: true },
  })
  await service.configure({ rootFile: join(workDir, 'main.tex'), review }, signal())
  await (service as unknown as { watcher: { stop(): Promise<void> } }).watcher.stop()
  const stop = async (): Promise<void> => {
    await (service as unknown as { watcher: { stop(): Promise<void> } }).watcher.stop()
  }
  return { service, behaviour, stop }
}

/**
 * Wait for the compile `configure` kicks off.
 *
 * Watching `status` alone races: the fake process can finish before the first poll,
 * so "compiling" may never be observed. What cannot be missed is the effect — a run
 * happened (`runs` moved) and the state carries its duration.
 */
async function settled(
  service: LatexPreviewService,
  behaviour: Behaviour,
  timeoutMs = 20_000,
): Promise<PreviewState> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await service.getState(signal())
    const done = behaviour.runs > 0 && state.durationMs !== null && (state.status === 'ok' || state.status === 'failed')
    if (done) return state
    await delay(20)
  }
  throw new Error('compile never settled')
}

/** A fresh workspace with `main.tex` holding `source`. */
function workspace(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-latex-prov-'))
  writeFileSync(join(dir, 'main.tex'), source)
  return dir
}

test('a PDF left over from an earlier session is never published as a revision', async () => {
  const dir = workspace(A)
  const outDir = join(dir, '.latex-preview')
  mkdirSync(outDir, { recursive: true })
  // Someone else compiled this, from a source nobody can name any more.
  writeFileSync(join(outDir, 'main.pdf'), `PDF:${digestOf('an older document')}`)
  writeFileSync(join(outDir, 'main.synctex.gz'), `SYNC:${digestOf('an older document')}`)

  try {
    const { service, behaviour, stop } = await boot(dir)
    const state = await settled(service, behaviour)
    await stop()

    assert.equal(state.status, 'ok', 'the compile itself succeeded')
    assert.equal(state.recentRevisionId, null, 'the leftover PDF is not "the previous compile"')
    assert.equal(state.baseRevisionId, null, 'and it is certainly not the accepted revision')
    const paths = compilePaths(join(dir, 'main.tex'), outDir)
    assert.equal(existsSync(paths.recentManifest), false, 'no manifest was written for it')
    assert.equal(existsSync(paths.baseManifest), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a pair becomes publishable once this process has compiled the bytes it names', async () => {
  const dir = workspace(A)
  try {
    const { service, behaviour, stop } = await boot(dir)
    await settled(service, behaviour)

    // Second compile: the pre-compile copies are now bytes this process produced.
    writeFileSync(join(dir, 'main.tex'), B)
    await service.compileNow(signal())
    const state = await service.getState(signal())
    await stop()

    const paths = compilePaths(join(dir, 'main.tex'), join(dir, '.latex-preview'))
    assert.equal(state.baseRevisionId, digestOf(A), 'the accepted revision is the first compile')
    assert.equal(state.recentRevisionId, digestOf(A), 'and it is also what this save replaced')
    assert.equal(existsSync(paths.baseManifest), true)
    assert.equal(readFileSync(paths.recentPdf, 'utf8'), `PDF:${digestOf(A)}`, 'the published bytes are the ones named')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a restart restores the accepted pair its manifest still describes', async () => {
  const dir = workspace(A)
  try {
    const first = await boot(dir)
    await settled(first.service, first.behaviour)
    writeFileSync(join(dir, 'main.tex'), B)
    await first.service.compileNow(signal())
    await first.service.acceptChanges(signal())
    const accepted = await first.service.getState(signal())
    await first.stop()
    assert.equal(accepted.baseRevisionId, digestOf(B))

    // A new process, same workspace: the manifest is the only thing that survived.
    const second = await boot(dir)
    const state = await settled(second.service, second.behaviour)
    await second.stop()

    assert.equal(state.baseRevisionId, digestOf(B), 'restored from the manifest, not recomputed')
    assert.equal(state.baseViewerUrl !== null || state.basePdfUrl !== null, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a backup that cannot be made publishes nothing and leaves no stale copy', async () => {
  const dir = workspace(A)
  const outDir = join(dir, '.latex-preview')
  try {
    const { service, behaviour, stop } = await boot(dir)
    await settled(service, behaviour)

    // A directory where the backup's temporary file must go: the copy fails, and
    // nothing may be left behind that a later publish could pick up.
    const paths = compilePaths(join(dir, 'main.tex'), outDir)
    mkdirSync(`${paths.prev}.tmp`)

    writeFileSync(join(dir, 'main.tex'), B)
    const result = await service.compileNow(signal())
    const state = await service.getState(signal())
    await stop()

    assert.equal(result.ok, true, 'the new PDF did compile')
    assert.equal(result.backup.status, 'failed')
    assert.equal(state.recentRevisionId, null, 'the previous compile stays unknown')
    assert.equal(existsSync(paths.prev), false, 'no half-copied backup is left in place')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('undo puts the discarded revision in the previous-compile slot', async () => {
  const dir = workspace(A)
  const outDir = join(dir, '.latex-preview')
  try {
    const { service, behaviour, stop } = await boot(dir)
    await settled(service, behaviour)
    writeFileSync(join(dir, 'main.tex'), B)
    await service.compileNow(signal())
    writeFileSync(join(dir, 'main.tex'), C)
    await service.compileNow(signal())

    const before = await service.getState(signal())
    assert.equal(before.recentRevisionId, digestOf(B), 'before the revert, the revision before C is B')

    const state = await service.revertChanges(signal())
    await stop()

    assert.equal(readFileSync(join(dir, 'main.tex'), 'utf8'), A, 'the source is back to the baseline')
    assert.equal(state.recentRevisionId, digestOf(C), 'what was on screen is the previous compile now')
    assert.equal(state.baseRevisionId, digestOf(A), 'the accepted pair is unchanged')
    const paths = compilePaths(join(dir, 'main.tex'), outDir)
    assert.equal(readFileSync(paths.recentPdf, 'utf8'), `PDF:${digestOf(C)}`, 'and the bytes match the revision it names')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the diff regions name the side they were computed for', async () => {
  const dir = workspace(A)
  try {
    const { service, behaviour, stop } = await boot(dir)
    await settled(service, behaviour)
    writeFileSync(join(dir, 'main.tex'), B)
    await service.compileNow(signal())

    const regions = await service.getDiffRegions({ side: 'compile' }, signal())
    const base = await service.getDiffRegions({ side: 'base' }, signal())
    await stop()

    assert.equal(regions.side, 'compile')
    assert.equal(base.side, 'base')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an edit that lands mid-compile withholds the credential for the result', async () => {
  const dir = workspace(A)
  try {
    const { service, behaviour, stop } = await boot(dir)
    await settled(service, behaviour)

    // The second run mutates the file as it compiles; the repair run it triggers is
    // held at a gate, so the state can be inspected before convergence hides it.
    const gateRef: { release?: () => void } = {}
    const gate = new Promise<void>((resolve) => {
      gateRef.release = resolve
    })
    behaviour.mutate = (content) => `${content}\n% 编译期间改的\n`
    behaviour.gateFromRun = 3
    behaviour.gate = () => gate

    writeFileSync(join(dir, 'main.tex'), B)
    await service.compileNow(signal())
    await delay(150)

    const inFlight = service as unknown as { trusted: unknown; currentSource: string }
    // The PDF on screen was compiled from a file that changed underneath it, so no
    // credential may name it. Everything downstream (publishing a revision, promoting
    // a baseline) keys off this being null; `drops` above assert the consequence.
    assert.equal(inFlight.trusted, null, 'no credential for bytes nobody can name')

    gateRef.release?.()
    await delay(300)
    await stop()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two compiles fired for one save cannot erase each other', async () => {
  const dir = workspace(A)
  const outDir = join(dir, '.latex-preview')
  try {
    const { service, behaviour, stop } = await boot(dir)
    await settled(service, behaviour)

    // A watcher that reports the same save twice is ordinary; two bookkeepings
    // racing are not. Without serialisation the second run copies the PDF the first
    // just wrote, names it with the older revision, and the first run's publish is
    // then dropped — leaving both revision views empty.
    writeFileSync(join(dir, 'main.tex'), B)
    await Promise.all([service.compileNow(signal()), service.compileNow(signal())])
    const state = await service.getState(signal())
    await stop()

    assert.equal(state.baseRevisionId, digestOf(A), 'the accepted revision survived both runs')
    // The second run changed nothing, so the revision before B is still A — and it
    // must still be published, not dropped by the run that had nothing to say.
    assert.equal(state.recentRevisionId, digestOf(A), 'the previous compile survived the redundant run')
    const paths = compilePaths(join(dir, 'main.tex'), outDir)
    assert.equal(readFileSync(paths.recentPdf, 'utf8'), `PDF:${digestOf(A)}`)
    assert.equal(readFileSync(paths.basePdf, 'utf8'), `PDF:${digestOf(A)}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a failed compile that restored the pair keeps showing it', async () => {
  const dir = workspace(A)
  try {
    const { service, behaviour, stop } = await boot(dir)
    const first = await settled(service, behaviour)
    assert.notEqual(first.pdfUrl, null)

    behaviour.fail = true
    writeFileSync(join(dir, 'main.tex'), B)
    const result = await service.compileNow(signal())
    const state = await service.getState(signal())
    await stop()

    assert.equal(result.artifactState, 'restored', 'the previous revision came back intact')
    assert.notEqual(state.pdfUrl, null, 'so the panel keeps showing a PDF')
    assert.ok(state.pdfUrl?.includes('/pdf/main.pdf'), state.pdfUrl ?? '')
    assert.equal(state.status, 'failed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unprovable artefact is withdrawn instead of left on screen', async () => {
  const dir = workspace(A)
  const outDir = join(dir, '.latex-preview')
  try {
    const { service, behaviour, stop } = await boot(dir)
    const first = await settled(service, behaviour)
    assert.notEqual(first.pdfUrl, null)

    // Backup impossible *and* the compile fails: nothing can be said about the file
    // that is left, so it must not stay on screen behind a valid-looking URL.
    const paths = compilePaths(join(dir, 'main.tex'), outDir)
    mkdirSync(`${paths.prev}.tmp`)
    behaviour.fail = true
    writeFileSync(join(dir, 'main.tex'), B)
    const result = await service.compileNow(signal())
    const state = await service.getState(signal())
    await stop()

    assert.equal(result.artifactState, 'unavailable')
    assert.equal(result.pdfPath, null)
    assert.equal(state.pdfUrl, null, 'no URL for an artefact nobody can vouch for')
    assert.equal(state.viewerUrl, null)
    assert.equal(state.baseRevisionId, null)
    assert.equal(state.recentRevisionId, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a reviewer that accepts immediately still gets a credential to publish with', async () => {
  const dir = workspace(A)
  try {
    // `auto` mode with the model replaced by a reviewer that answers at once — the
    // worst case for ordering, because approving promotes the current PDF to the
    // baseline immediately.
    const { service, behaviour, stop } = await boot(dir, 'auto')
    ;(service as unknown as { runReview: unknown }).runReview = async () => ({ verdict: 'accept', reason: 'ok' })
    await settled(service, behaviour)

    writeFileSync(join(dir, 'main.tex'), B)
    await service.compileNow(signal())
    // The verdict is applied on a detached promise; wait for it to settle.
    for (let i = 0; i < 100 && (service as unknown as { reviewing: boolean }).reviewing; i += 1) await delay(20)
    await delay(120)
    const state = await service.getState(signal())
    await stop()

    assert.equal(state.baseRevisionId, digestOf(B), 'the approved revision became the baseline')
    assert.equal(state.recentRevisionId, digestOf(A), 'and its predecessor is still the previous compile')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a rejecting reviewer rolls back without asking for a second review', async () => {
  const dir = workspace(A)
  try {
    const { service, behaviour, stop } = await boot(dir, 'auto')
    let reviews = 0
    ;(service as unknown as { runReview: unknown }).runReview = async () => {
      reviews += 1
      return { verdict: 'reject', reason: 'not wanted' }
    }
    await settled(service, behaviour)

    writeFileSync(join(dir, 'main.tex'), B)
    await service.compileNow(signal())
    for (let i = 0; i < 100 && (service as unknown as { reviewing: boolean }).reviewing; i += 1) await delay(20)
    await delay(200)
    const state = await service.getState(signal())
    await stop()

    assert.equal(reviews, 1, 'the revert it causes must not trigger another review')
    assert.equal(readFileSync(join(dir, 'main.tex'), 'utf8'), A, 'the source went back')
    assert.equal(state.baseRevisionId, digestOf(A))
    assert.equal(state.recentRevisionId, digestOf(B), 'what was rejected is now the previous compile')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
