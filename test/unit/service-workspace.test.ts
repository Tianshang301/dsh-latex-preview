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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { ArtifactStore } from '../../src/services/artifacts.ts'
import { CompileService, compilePaths, type CompileOptions, type CompileRun } from '../../src/services/compile.ts'
import { DiffDocService } from '../../src/services/diffdoc.ts'
import { LatexPreviewService } from '../../src/services/latex-preview-service.ts'
import type { PreviewState } from '../../src/types.ts'
import { fakeBinaries } from './support.ts'

const DOC = (body: string): string =>
  ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}', ''].join('\n')
const A1 = DOC('甲一。')
const A2 = DOC('甲二。')
const A3 = DOC('甲三。')
const B1 = DOC('乙一。')
const C1 = DOC('丙一。')

const digestOf = (source: string): string => createHash('sha1').update(source).digest('hex').slice(0, 12)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const signal = (): AbortSignal => new AbortController().signal

/** What the fake compiler should do. */
interface Behaviour {
  runs: number
  /** From this run number on, exit non-zero without writing anything. */
  failFromRun?: number
  /** On exactly this run number, throw instead of returning a result. */
  throwOnRun?: number
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
  /** Set once the fake diff build has started (and parked, if armed). */
  diffStarted: { started: boolean }
}

/** How a test wants the service booted. */
interface BootOptions {
  /** Pause between the compiler returning and publishing. */
  onRunReturned?: (workspace: { id: string; generation: number }) => Promise<void>
  /** Pause inside the compiler, *before* it writes any bytes. */
  beforeWrite?: () => Promise<void>
  /** Pause inside the diff build, before it writes the diff PDF. */
  beforeDiffWrite?: () => Promise<void>
  /** Output directory for the first workspace; omitted means the default one. */
  outDir?: string
}

/**
 * Boot a service on one workspace, configured and with the watcher stopped so
 * compiles happen only when a test asks for one.
 * @param workDir - directory holding `main.tex`.
 * @param options - see {@link BootOptions}.
 * @returns the harness.
 */
async function boot(workDir: string, options: BootOptions = {}): Promise<Harness> {
  const behaviour: Behaviour = { runs: 0 }
  const diffStartedRef: { current: { started: boolean } } = { current: { started: false } }
  const service = new LatexPreviewService(new Context(), {
    binaryProbe: async () => fakeBinaries(),
    onRunReturned: options.onRunReturned,
    diffDocFactory: (diffOptions) => {
      void diffOptions
      return {
        build: async (base: string, head: string): Promise<unknown> => {
          diffStartedRef.current.started = true
          void base
          void head
          await options.beforeDiffWrite?.()
          return { ok: true, pdfPath: join(diffOptions.outDir, `${basename(diffOptions.rootFile, '.tex')}.diff.pdf`), message: 'fake diff' }
        },
      } as unknown as DiffDocService
    },
    compileFactory: (compileOptions: CompileOptions) =>
      new CompileService({
        ...compileOptions,
        run: async (): Promise<CompileRun> => {
          behaviour.runs += 1
          if (behaviour.throwOnRun === behaviour.runs) {
            throw new Error('fake compiler crash')
          }
          // The seam that matters for path leases: the task owns the directory and has
          // not written anything yet. `onRunReturned` is too late — the bytes are
          // already there by then.
          await options.beforeWrite?.()
          const content = readFileSync(compileOptions.rootFile, 'utf8')
          if (behaviour.failFromRun !== undefined && behaviour.runs >= behaviour.failFromRun) {
            return { code: 1, stdout: '', stderr: 'fake failure', timedOut: false }
          }
          writeOutputs(compileOptions.outDir, compileOptions.rootFile, content)
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      }),
  })
  const stop = async (): Promise<void> => {
    await (service as unknown as { watcher: { stop(): Promise<void> } | null }).watcher?.stop()
  }
  const diffStarted = { started: false }
  diffStartedRef.current = diffStarted
  const request = { rootFile: join(workDir, 'main.tex'), review: 'manual' as const }
  await service.configure(options.outDir ? { ...request, outDir: options.outDir } : request, signal())
  await stop()
  return { service, behaviour, stop, diffStarted: diffStartedRef.current }
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
  const h = await boot(a, {
    onRunReturned: async () => {
      if (!gate) return
      const held = gate
      gate = null
      await held
    },
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

test('a stale compile cannot take the new workspace’s published pair with it', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  // Two gates: the run that will go stale, and the new workspace's own compile. The
  // second one has to be held as well, because a compile of B that ran to completion
  // would legitimately republish the very pair this test is asking about.
  const releases: Array<() => void> = []
  let holdNext = 0
  const h = await boot(a, {
    onRunReturned: () =>
      new Promise<void>((resolve) => {
        if (holdNext <= 0) {
          resolve()
          return
        }
        holdNext -= 1
        releases.push(resolve)
      }),
  })
  try {
    await until(() => h.behaviour.runs >= 1, 'A’s first compile')
    await delay(150)
    writeFileSync(join(a, 'main.tex'), A2)
    await h.service.compileNow(signal())
    assert.equal((await h.service.getState(signal())).baseRevisionId, digestOf(A1))

    holdNext = 2
    writeFileSync(join(a, 'main.tex'), A3)
    const running = h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= 3, 'the run that will go stale')

    await h.service.configure({ rootFile: join(b, 'main.tex'), review: 'manual' }, signal())

    // Give B a previous-compile pair that is real in every sense: published through the
    // same store the service uses, so its manifest verifies and its hashes are true.
    // Writing a lone JSON by hand would test nothing.
    const bPaths = compilePaths(join(b, 'main.tex'), join(b, '.latex-preview'))
    mkdirSync(join(b, '.latex-preview'), { recursive: true })
    writeFileSync(bPaths.recentPdf, 'PDF:B-PREVIOUS')
    writeFileSync(bPaths.recentSynctex, 'SYNC:B-PREVIOUS')
    const store = new ArtifactStore({
      pdf: bPaths.recentPdf,
      synctex: bPaths.recentSynctex,
      manifest: bPaths.recentManifest,
    })
    assert.equal(
      await store.publish({ revisionId: digestOf(B1), pdf: bPaths.recentPdf, synctex: bPaths.recentSynctex }),
      true,
    )
    const recentUrl = '/.latex-preview/pdf/main.recent.pdf?v=1'
    ;(h.service as unknown as { patch(next: Partial<PreviewState>): void }).patch({
      recentRevisionId: digestOf(B1),
      recentPdfUrl: recentUrl,
      recentViewerUrl: null,
    })
    const before = {
      manifest: readFileSync(bPaths.recentManifest, 'utf8'),
      pdf: readFileSync(bPaths.recentPdf, 'utf8'),
      synctex: readFileSync(bPaths.recentSynctex, 'utf8'),
    }

    // Release the stale run only. Everything it does from here happens after the
    // switch, which is the whole point of the test. B's own compile is queued behind
    // it and parks at the same seam, so nothing else can move while we look.
    releases.shift()?.()
    const result = await running
    await until(() => h.behaviour.runs >= 4, 'B’s own compile to start')
    await delay(200)
    const after = await h.service.getState(signal())

    assert.equal(result.pdfUrl, null)
    // The bug this replaces was silent: A's publish hashed B's (absent) `.prev` pair
    // against its own backup hashes, never matched, and withdrew B's pair as a result.
    assert.equal(readFileSync(bPaths.recentManifest, 'utf8'), before.manifest, 'the manifest is untouched')
    assert.equal(readFileSync(bPaths.recentPdf, 'utf8'), before.pdf, 'the PDF is untouched')
    assert.equal(readFileSync(bPaths.recentSynctex, 'utf8'), before.synctex, 'the sync map is untouched')
    assert.equal(after.recentRevisionId, digestOf(B1), 'and the panel still offers it')
    assert.equal(after.recentPdfUrl, recentUrl)
    assert.notEqual(await store.verify(), null, 'the pair still verifies')
    // The three versions and the credential belong to B, not to the run that ended.
    assert.equal(internals(h.service).currentSource, B1)
    assert.equal(internals(h.service).acceptedSource, B1)
    assert.equal(internals(h.service).trusted, null)
  } finally {
    // Let anything still parked finish, so no promise is left dangling.
    while (releases.length > 0) releases.shift()?.()
    await delay(100)
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

test('a configure that would overwrite a running compile’s output waits for it', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  // One output directory, two projects, the same file name: every artefact name in it
  // is shared, and `restoreArtifacts` deletes both pairs by name.
  const shared = mkdtempSync(join(tmpdir(), 'dsh-latex-shared-'))
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const h = await boot(a, {
    outDir: shared,
    onRunReturned: async () => {
      if (!gate) return
      const held = gate
      gate = null
      await held
    },
  })
  try {
    await until(() => h.behaviour.runs >= 1, 'A’s first compile')
    await delay(150)
    // A second compile, so a previous-compile pair exists in the shared directory —
    // that pair is what a concurrent restore would delete.
    writeFileSync(join(a, 'main.tex'), A2)
    await h.service.compileNow(signal())
    const paths = compilePaths(join(a, 'main.tex'), shared)
    assert.equal(existsSync(paths.recentPdf), true, 'A published a pair into the shared directory')

    // Park a compile after its compiler returned: `main.pdf` holds the new bytes and
    // the pair above still describes the revision before it.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    writeFileSync(join(a, 'main.tex'), A3)
    const running = h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= 3, 'the held run to reach the compiler')

    // B writes `main.pdf` too. Its restore must not run now: it would delete the two
    // pairs of a compile that is about to publish into the same names.
    const configured = h.service.configure({ rootFile: join(b, 'main.tex'), outDir: shared, review: 'manual' }, signal())
    const early = await Promise.race([
      configured.then(() => 'done' as const),
      delay(200).then(() => 'pending' as const),
    ])
    assert.equal(early, 'pending', 'a colliding configure must wait for the compile')
    assert.equal(existsSync(paths.recentPdf), true, 'and must not have deleted the pair while waiting')

    hold.release?.()
    await running
    const state = await configured
    await until(() => h.behaviour.runs >= 4, 'B’s own compile to start')
    await delay(200)

    assert.equal(state.rootFile, join(b, 'main.tex'))
    assert.equal(internals(h.service).currentSource, B1)
    // The shared directory now holds B's document and only B's: A's run was released
    // before the switch, so it published its own revision into A's own names first.
    assert.equal(readFileSync(join(shared, 'main.pdf'), 'utf8'), `PDF:${digestOf(B1)}`)
  } finally {
    hold.release?.()
    await delay(100)
    await h.stop()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  }
})

test('a configure into another output directory does not wait for a running compile', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const h = await boot(a, {
    onRunReturned: async () => {
      if (!gate) return
      const held = gate
      gate = null
      await held
    },
  })
  try {
    await until(() => h.behaviour.runs >= 1, 'A’s first compile')
    await delay(150)

    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    writeFileSync(join(a, 'main.tex'), A2)
    const running = h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= 2, 'the held run to reach the compiler')

    // Nothing in B's directory belongs to A's compile, so there is nothing to order:
    // the switch stays immediate instead of inheriting the compile's duration. This is
    // the other half of the rule — if this waits too, `configure` has silently become
    // a queued operation and every project switch pays for a first compile.
    const configured = h.service.configure({ rootFile: join(b, 'main.tex'), review: 'manual' }, signal())
    const early = await Promise.race([
      configured.then(() => 'done' as const),
      delay(2000).then(() => 'pending' as const),
    ])
    assert.equal(early, 'done', 'a configure with its own output directory is not serialised')
    assert.equal((await configured).rootFile, join(b, 'main.tex'))

    hold.release?.()
    const result = await running
    assert.equal(result.pdfUrl, null, 'and the released run still knows it lost its workspace')
  } finally {
    hold.release?.()
    await delay(100)
    await h.stop()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('a stale writer cannot change paths a later workspace has taken over', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  const c = workspaceSource(C1)
  // A and C write the same file names into the same directory; B does not.
  const shared = mkdtempSync(join(tmpdir(), 'dsh-latex-lease-'))
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const h = await boot(a, {
    outDir: shared,
    beforeWrite: async () => {
      if (!gate) return
      const held = gate
      gate = null
      await held
    },
  })
  const pathsA = compilePaths(join(a, 'main.tex'), shared)
  try {
    await until(() => h.behaviour.runs >= 1, 'A’s first compile')
    await delay(150)
    // A second compile, so the shared directory holds a published pair the restore
    // would delete.
    writeFileSync(join(a, 'main.tex'), A2)
    await h.service.compileNow(signal())
    assert.equal(existsSync(pathsA.recentPdf), true, 'A published a pair into the shared directory')

    // A's third run owns the directory but has written nothing yet: the compiler is
    // holding the gate. This is the window `onRunReturned` cannot produce.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    writeFileSync(join(a, 'main.tex'), A3)
    const running = h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= 3, 'A’s held run to reach the compiler')

    // B has its own directory: nothing to order against, so the switch is immediate.
    const started = Date.now()
    const configuredB = await h.service.configure(
      { rootFile: join(b, 'main.tex'), outDir: join(b, '.latex-preview'), review: 'manual' },
      signal(),
    )
    assert.equal(configuredB.rootFile, join(b, 'main.tex'))
    assert.ok(Date.now() - started < 5000, 'a non-colliding switch still does not wait')

    // C claims A's directory. A is stale already — its result will be discarded — but it
    // is still writing, so the paths are not C's to restore yet.
    const configuredC = h.service.configure({ rootFile: join(c, 'main.tex'), outDir: shared, review: 'manual' }, signal())
    const early = await Promise.race([
      configuredC.then(() => 'done' as const),
      delay(300).then(() => 'pending' as const),
    ])
    assert.equal(early, 'pending', 'C must wait for the writer that still owns the paths')
    // The promise being pending is not the point: the *restore* must not have run, so
    // the pair A published is still on disk and A's bytes are still the last written.
    assert.equal(existsSync(pathsA.recentPdf), true, 'no restore ran under the running writer')
    assert.equal(readFileSync(join(shared, 'main.pdf'), 'utf8'), `PDF:${digestOf(A2)}`, 'and nothing wrote over it')

    // Release the writer. Only after its underlying I/O finishes does the lease go, and
    // only then does C's activation run.
    hold.release?.()
    const result = await running
    const state = await configuredC
    await until(() => h.behaviour.runs >= 5, 'C’s own compile to start')
    await delay(200)

    assert.equal(result.pdfUrl, null, 'the stale run published nothing')
    assert.equal(state.rootFile, join(c, 'main.tex'))
    // The stricter criterion: the stale writer must not determine the final bytes.
    const final = readFileSync(join(shared, 'main.pdf'), 'utf8')
    assert.equal(final, `PDF:${digestOf(C1)}`, 'the final document is C’s')
    assert.ok(!final.includes(digestOf(A3)), 'and A’s late bytes are nowhere in it')
    assert.equal(internals(h.service).currentSource, C1)
    assert.equal(internals(h.service).acceptedSource, C1)
    assert.equal(h.behaviour.runs >= 5, true)
  } finally {
    hold.release?.()
    await delay(100)
    await h.stop()
    for (const dir of [a, b, c, shared]) rmSync(dir, { recursive: true, force: true })
  }
})

test('a lease is released by a crash and never conflicts with a queued peer', async () => {
  const a = workspaceSource(A1)
  const b = workspaceSource(B1)
  const shared = mkdtempSync(join(tmpdir(), 'dsh-latex-lease-miss-'))
  const h = await boot(a, { outDir: shared })
  try {
    await until(() => h.behaviour.runs >= 1, 'A’s first compile')
    await delay(150)

    // A compiler that throws rejects the queued task; the lease lives in a `finally`,
    // so it must be gone before the next operation looks at these paths. If it leaked,
    // the configure below would be refused as `artifact-busy`.
    h.behaviour.throwOnRun = 2
    await assert.rejects(h.service.compileNow(signal()), /fake compiler crash/)

    // Two compiles queued at once on one path set: each holds its own reservation, and
    // neither may read the other's as a conflict.
    const both = await Promise.all([h.service.compileNow(signal()), h.service.compileNow(signal())])
    assert.equal(both.length, 2)
    assert.equal(both[0]?.ok, true)
    assert.equal(both[1]?.ok, true)

    const state = await h.service.configure({ rootFile: join(b, 'main.tex'), outDir: shared, review: 'manual' }, signal())
    assert.equal(state.rootFile, join(b, 'main.tex'), 'a leaked lease would have refused this restore')
  } finally {
    await h.stop()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  }
})

test('a configure colliding with a diff build waits for the reader instead of refusing', async () => {
  const a = workspaceSource(A1)
  const c = workspaceSource(C1)
  const shared = mkdtempSync(join(tmpdir(), 'dsh-latex-lease-read-'))
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const h = await boot(a, {
    outDir: shared,
    beforeDiffWrite: async () => {
      if (!gate) return
      const held = gate
      gate = null
      await held
    },
  })
  const pathsA = compilePaths(join(a, 'main.tex'), shared)
  try {
    await until(() => h.behaviour.runs >= 1, 'A’s first compile')
    await delay(150)
    // A pending change, so a diff build has something to build.
    writeFileSync(join(a, 'main.tex'), A2)
    await h.service.compileNow(signal())

    // The reader takes the paths and parks inside its build — outside the lifecycle
    // queue, which is exactly why the queue alone could never order this.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    const building = h.service.buildDiffDoc(signal())
    await until(() => h.diffStarted.started, 'the diff build to park inside its read lease')

    // C claims the paths the reader holds. The old behaviour refused the restore with
    // `artifact-busy` (a reader is "running"); the lock makes the writer wait instead.
    const configured = h.service.configure({ rootFile: join(c, 'main.tex'), outDir: shared, review: 'manual' }, signal())
    const early = await Promise.race([
      configured.then(() => 'done' as const),
      delay(300).then(() => 'pending' as const),
    ])
    assert.equal(early, 'pending', 'C waits for the reader — it does not refuse, and does not restore')
    assert.equal(existsSync(pathsA.recentPdf), true, 'and nothing was deleted under the reader')

    hold.release?.()
    const build = await building
    assert.equal(build.ok, true)
    const state = await configured
    assert.equal(state.rootFile, join(c, 'main.tex'), 'the restore then runs, on paths nobody is reading')
    await until(() => h.behaviour.runs >= 3, 'C’s own compile to start')
  } finally {
    hold.release?.()
    await delay(100)
    await h.stop()
    rmSync(a, { recursive: true, force: true })
    rmSync(c, { recursive: true, force: true })
    rmSync(shared, { recursive: true, force: true })
  }
})
