/**
 * What "the compile is stable" has to mean for a multi-file document.
 *
 * `stable` decides three things at once: whether the three revisions advance, whether
 * a credential is issued, and whether a convergence compile is scheduled. It used to
 * compare the root `.tex` with itself, which is blind to `\input` chapters, so a
 * chapter rewritten while TeX was reading it produced a PDF that describes neither
 * version — and a credential saying it describes both.
 *
 * The seam is `ServiceOptions.onRunReturned`: the compiler has returned, its own
 * bytes are on disk, and the post-compile scan has not happened yet. Writing a
 * chapter there reproduces the real race (an editor, a formatter, a sync tool saving
 * mid-run) without a timer.
 *
 * @module dsh-latex-preview/test/unit/service-inputs
 */

import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import test from 'node:test'

import { CompileService, type CompileOptions, type CompileRun } from '../../src/services/compile.ts'
import type { BuildInputManifest } from '../../src/services/build-input.ts'
import { LatexPreviewService } from '../../src/services/latex-preview-service.ts'
import type { PreviewState } from '../../src/types.ts'
import { fakeBinaries } from './support.ts'

const DOC = (body: string): string =>
  ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}', ''].join('\n')

const digestOf = (source: string): string => createHash('sha1').update(source).digest('hex').slice(0, 12)
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const signal = (): AbortSignal => new AbortController().signal

/** What the fake compiler should do. */
interface Behaviour {
  /** How many times `CompileService.run` has been entered. */
  runs: number
  /** From this run number on, exit non-zero without writing anything. */
  failFromRun?: number
}

/** Write the pair a successful compile leaves behind. */
function writeOutputs(outDir: string, rootFile: string, content: string): void {
  const stem = basename(rootFile, '.tex')
  writeFileSync(join(outDir, `${stem}.pdf`), `PDF:${digestOf(content)}`)
  writeFileSync(join(outDir, `${stem}.synctex.gz`), `SYNC:${digestOf(content)}`)
}

/** A project directory from a `relative path → contents` map. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-latex-inputs-'))
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(dir, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents)
  }
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

/** The fields these tests inspect; none of them crosses the wire. */
interface Internals {
  trusted: unknown
  currentSource: string | null
  acceptedSource: string | null
}

const internals = (service: LatexPreviewService): Internals => service as unknown as Internals

/** How a test wants the service booted. */
interface BootOptions {
  /** Runs between the compiler returning and the post-compile scan. */
  onRunReturned?: (run: number) => Promise<void> | void
  /** Replaces the real scan, so failure and slowness are expressible. */
  scanner?: (rootFile: string, outDir: string) => Promise<BuildInputManifest>
}

/** Boot a service on `dir/main.tex`, its first compile finished and the watcher off. */
async function boot(
  dir: string,
  options: BootOptions = {},
): Promise<{ service: LatexPreviewService; behaviour: Behaviour }> {
  const behaviour: Behaviour = { runs: 0 }
  const service = new LatexPreviewService(new Context(), {
    binaryProbe: async () => fakeBinaries(),
    buildInputScanner: options.scanner,
    onRunReturned: async () => {
      await options.onRunReturned?.(behaviour.runs)
    },
    compileFactory: (compileOptions: CompileOptions) =>
      new CompileService({
        ...compileOptions,
        run: async (): Promise<CompileRun> => {
          behaviour.runs += 1
          const content = readFileSync(compileOptions.rootFile, 'utf8')
          if (behaviour.failFromRun !== undefined && behaviour.runs >= behaviour.failFromRun) {
            return { code: 1, stdout: '', stderr: 'fake failure', timedOut: false }
          }
          writeOutputs(compileOptions.outDir, compileOptions.rootFile, content)
          return { code: 0, stdout: '', stderr: '', timedOut: false }
        },
      }),
  })
  await service.configure({ rootFile: join(dir, 'main.tex'), review: 'manual' }, signal())
  await (service as unknown as { watcher: { stop(): Promise<void> } | null }).watcher?.stop()
  // `configure` starts the first compile without awaiting it; every test below needs
  // a settled starting point, or the run numbers it reasons about mean nothing.
  await until(() => behaviour.runs >= 1, 'the first compile')
  await delay(200)
  return { service, behaviour }
}

test('a chapter edited while the compiler was reading is not a revision', async () => {
  const root = DOC('\\input{chapters/ch1}')
  const dir = project({ 'main.tex': root, 'chapters/ch1.tex': 'first' })
  const armed = { flag: false }
  const h = await boot(dir, {
    onRunReturned: async () => {
      if (!armed.flag) return
      armed.flag = false
      writeFileSync(join(dir, 'chapters/ch1.tex'), 'second')
    },
  })
  try {
    const settled: PreviewState = await h.service.getState(signal())
    const settledSource = internals(h.service).acceptedSource
    assert.notEqual(internals(h.service).trusted, null, 'the first compile earned a credential')

    // The convergence run is made to fail, so the state inspected afterwards is the
    // unstable run's own commit rather than whatever the retry left behind.
    const failing = h.behaviour.runs + 2
    h.behaviour.failFromRun = failing
    armed.flag = true
    const result = await h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= failing, 'the convergence attempt')
    await delay(100)
    const after = await h.service.getState(signal())

    assert.equal(result.ok, true, 'the compile itself succeeded')
    assert.equal(internals(h.service).trusted, null, 'no credential for bytes that describe two versions')
    assert.equal(internals(h.service).acceptedSource, settledSource)
    assert.equal(internals(h.service).currentSource, root)
    // `baseRevisionId` is not asserted: the accepted pair is republished from the
    // *previous* bytes on any compile, and those bytes are the same revision here. What
    // must not move is the previous-compile pair, which only a stable run publishes.
    assert.equal(after.recentRevisionId, settled.recentRevisionId, 'no previous-compile pair was published')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an include graph nobody touched still compiles exactly once', async () => {
  const dir = project({
    'main.tex': DOC('\\input{chapters/ch1}\\bibliography{refs}'),
    'chapters/ch1.tex': 'chapter',
    'refs.bib': '@book{a}',
  })
  try {
    const h = await boot(dir)
    await delay(250)
    assert.equal(h.behaviour.runs, 1, 'no spurious convergence')
    assert.notEqual(internals(h.service).trusted, null, 'a graph that holds still is stable')
    const state = await h.service.getState(signal())
    assert.doesNotMatch(state.message ?? '', /又变了/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the table of contents the compiler writes is not an input', async () => {
  const dir = project({ 'main.tex': DOC('\\tableofcontents\\input{main.toc}') })
  try {
    const h = await boot(dir, {
      // Every run rewrites the file `\input{main.toc}` names, exactly as TeX does.
      // Counting it would make each run detect a change and recompile for ever.
      onRunReturned: (run) => {
        writeFileSync(join(dir, 'main.toc'), `\\contentsline {section}{S${run}}{${run}}`)
      },
    })
    await delay(300)
    assert.equal(h.behaviour.runs, 1, 'the compiler’s own output does not make a run unstable')
    assert.notEqual(internals(h.service).trusted, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an input that is a directory is unreadable, not unstable', async () => {
  const dir = project({ 'main.tex': DOC('\\input{chapters}'), 'chapters/ch1.tex': 'x' })
  try {
    const h = await boot(dir)
    await delay(250)
    // The same unreadable member before and after: the graph did not move. Refusing a
    // credential here would mean this project can never accept a revision.
    assert.equal(h.behaviour.runs, 1)
    assert.notEqual(internals(h.service).trusted, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a scan that throws does not fail the compile', async () => {
  const dir = project({ 'main.tex': DOC('\\input{ch}'), 'ch.tex': 'chapter' })
  try {
    const h = await boot(dir, {
      scanner: async () => {
        throw new Error('scan unavailable')
      },
    })
    const state = await h.service.getState(signal())
    // Fail-open: the compile is real, the credential is issued, and the status line
    // claims nothing about the input graph it could not read.
    assert.equal(state.status, 'ok')
    assert.notEqual(internals(h.service).trusted, null)
    assert.doesNotMatch(state.message ?? '', /又变了/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a graph that keeps moving stops being recompiled', async () => {
  const dir = project({ 'main.tex': DOC('\\input{ch}'), 'ch.tex': 'v0' })
  let writes = 0
  const h = await boot(dir, {
    // Every run rewrites the chapter again, which is what a formatter or a sync
    // client looks like from here.
    onRunReturned: () => {
      writes += 1
      writeFileSync(join(dir, 'ch.tex'), `v${writes}`)
    },
  })
  try {
    const first = h.behaviour.runs
    await h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= first + 3, 'two convergence runs', 30_000)
    await delay(400)
    // Two extra runs, then it stops: without the budget a file that never settles
    // would keep the panel on "正在编译" for ever.
    assert.equal(h.behaviour.runs, first + 3)
    const state = await h.service.getState(signal())
    assert.match(state.message ?? '', /已停止自动重编译/)
    assert.match(state.message ?? '', /ch\.tex/)
    assert.equal(internals(h.service).trusted, null, 'nothing is vouched for after the budget')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a root file edited mid-run is still reported as the root file', async () => {
  const dir = project({ 'main.tex': DOC('\\input{ch}'), 'ch.tex': 'chapter' })
  let writes = 0
  const h = await boot(dir, {
    onRunReturned: () => {
      writes += 1
      writeFileSync(join(dir, 'main.tex'), DOC(`\\input{ch} ${writes}`))
    },
  })
  try {
    const first = h.behaviour.runs
    await h.service.compileNow(signal())
    await until(() => h.behaviour.runs >= first + 3, 'two convergence runs', 30_000)
    await delay(400)
    const state = await h.service.getState(signal())
    // The root moved too, but the message must name the root: a reader told
    // "the input changed" would look at the chapter, which never did.
    assert.match(state.message ?? '', /根文件/)
    assert.doesNotMatch(state.message ?? '', /ch\.tex/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
