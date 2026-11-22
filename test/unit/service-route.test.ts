/**
 * The PDF route as the *service* mounts it.
 *
 * `static-route.test.ts` proves the handler resolves its directory per request;
 * what that test cannot show is whether the service actually hands it a getter, or
 * whether the panel and the route ever disagree about where the output went. These
 * tests mount the handler the service registered on a real HTTP server and fetch
 * through it, so the whole chain — configure, compile, state, URL, bytes — is one
 * assertion.
 *
 * The two failures this exists to catch:
 * - a route pinned to the directory DSH was started in, so switching workspace
 *   serves the old project's `main.pdf` at a URL that still looks valid;
 * - an artefact the service just withdrew from the panel staying reachable by URL,
 *   which is the same document, one address bar away.
 *
 * @module dsh-latex-preview/test/unit/service-route
 */

import { Context } from '@deepseek-ai/cordis'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { CompileService, compilePaths, type CompileOptions, type CompileRun } from '../../src/services/compile.ts'
import { LatexPreviewService } from '../../src/services/latex-preview-service.ts'
import type { PreviewState } from '../../src/types.ts'
import { fakeBinaries } from './support.ts'

const DOC = (body: string): string =>
  ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}', ''].join('\n')
const A = DOC('甲。')
const B = DOC('乙。')
const C = DOC('丙。')

const digestOf = (source: string): string => createHash('sha1').update(source).digest('hex').slice(0, 12)

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const signal = (): AbortSignal => new AbortController().signal

/** What the fake compiler should do next. */
interface Behaviour {
  runs: number
  /** Write half a PDF and exit non-zero instead of compiling. */
  partial?: boolean
}

function writeOutputs(outDir: string, rootFile: string, content: string): void {
  const stem = basename(rootFile, '.tex')
  writeFileSync(join(outDir, `${stem}.pdf`), `PDF:${digestOf(content)}`)
  writeFileSync(join(outDir, `${stem}.synctex.gz`), `SYNC:${digestOf(content)}`)
}

function factory(behaviour: Behaviour): (options: CompileOptions) => CompileService {
  return (options) =>
    new CompileService({
      ...options,
      run: async (): Promise<CompileRun> => {
        behaviour.runs += 1
        if (behaviour.partial) {
          writeFileSync(join(options.outDir, `${basename(options.rootFile, '.tex')}.pdf`), 'PDF:PARTIAL')
          writeFileSync(join(options.outDir, `${basename(options.rootFile, '.tex')}.synctex.gz`), 'SYNC:PARTIAL')
          return { code: 1, stdout: '', stderr: 'fake failure', timedOut: false }
        }
        writeOutputs(options.outDir, options.rootFile, readFileSync(options.rootFile, 'utf8'))
        return { code: 0, stdout: '', stderr: '', timedOut: false }
      },
    })
}

/** The handler the service registers, captured so tests can serve it. */interface Harness {
  readonly service: LatexPreviewService
  readonly behaviour: Behaviour
  /** Base URL of the mounted route, e.g. `http://127.0.0.1:1234/.latex-preview`. */
  readonly base: string
  /** Bytes served at a path below the route, or the status when it does not serve. */
  fetch(path: string): Promise<{ status: number; body: string }>
  /** POST an API method and return the envelope, exactly as the panel receives it. */
  post(method: string): Promise<{ ok: boolean; value?: unknown; error?: { code: string; message: string } }>
  close(): Promise<void>
}

/**
 * Boot a service whose static route is a real HTTP server.
 * @param workDir - directory holding `main.tex`.
 * @param onRunReturned - optional pause between the compiler returning and publishing.
 * @returns the harness.
 */
async function mount(
  workDir: string,
  onRunReturned?: (workspace: { id: string; generation: number }) => Promise<void>,
): Promise<Harness> {
  const behaviour: Behaviour = { runs: 0 }
  let handler: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>) | null =
    null
  const ctx = new Context()
  // Provided before construction, because that is the real order: the web server
  // exists first and `configure` arrives later, which is why the mount cannot be a
  // captured string.
  ctx.provide('webServer', {
    register: (spec: { handler: unknown }) => {
      handler = spec.handler as typeof handler
      return () => undefined
    },
  })
  const service = new LatexPreviewService(ctx, {
    // Deterministic availability: the real probe spawns `tectonic` with a 10 s
    // budget and can land after any test-side patch, vetoing the fake compiler.
    binaryProbe: async () => fakeBinaries(),
    onRunReturned,
    compileFactory: factory(behaviour),
  })
  await delay(0)
  assert.ok(handler, 'the service registered a route; without one these tests prove nothing')

  const server: Server = createServer((req, res) => {
    void handler?.(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')

  await service.configure({ rootFile: join(workDir, 'main.tex'), review: 'manual' }, signal())
  await (service as unknown as { watcher: { stop(): Promise<void> } }).watcher.stop()

  const base = `http://127.0.0.1:${address.port}/.latex-preview`
  return {
    service,
    behaviour,
    base,
    async fetch(path: string) {
      const response = await fetch(`${base}${path}`)
      return { status: response.status, body: await response.text() }
    },
    async post(method: string) {
      const response = await fetch(`${base}/api/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      return (await response.json()) as { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    },
    close: async () => {
      await (service as unknown as { watcher: { stop(): Promise<void> } }).watcher.stop()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** Wait until the compile `configure` kicked off has been rendered. */
async function settled(harness: Harness, timeoutMs = 20_000): Promise<PreviewState> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const state = await harness.service.getState(signal())
    // Say *why* rather than timing out: a vetoed compiler and a swallowed exception
    // both look like "nothing happened" from the outside.
    if (!state.binaries.tectonic) {
      throw new Error(`the binary probe vetoed the fake compiler: ${JSON.stringify(state.binaries)}`)
    }
    if (harness.behaviour.runs > 0 && state.status === 'failed') {
      throw new Error(`the compile failed: ${state.message ?? ''}`)
    }
    const done = harness.behaviour.runs > 0 && state.durationMs !== null && state.status === 'ok'
    if (done) return state
    await delay(20)
  }
  throw new Error('compile never settled')
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

/** A fresh workspace with `main.tex` holding `source`. */
function workspace(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-latex-service-route-'))
  writeFileSync(join(dir, 'main.tex'), source)
  return dir
}

test('the PDF route follows the workspace the service was configured with', async () => {
  const a = workspace(A)
  const b = workspace(B)
  const harness = await mount(a)
  try {
    await settled(harness)
    const first = await harness.fetch('/pdf/main.pdf')
    assert.equal(first.status, 200)
    assert.equal(first.body, `PDF:${digestOf(A)}`, 'the URL the panel was given serves this workspace')

    // Same file name in another workspace: the one case where a route pinned to the
    // startup directory looks perfectly healthy while serving the wrong document.
    await harness.service.configure({ rootFile: join(b, 'main.tex'), review: 'manual' }, signal())
    await (harness.service as unknown as { watcher: { stop(): Promise<void> } }).watcher.stop()
    await settled(harness)

    const second = await harness.fetch('/pdf/main.pdf')
    assert.equal(second.status, 200)
    assert.equal(second.body, `PDF:${digestOf(B)}`, 'the same path now serves the new workspace')
    assert.equal(readFileSync(join(a, '.latex-preview', 'main.pdf'), 'utf8'), `PDF:${digestOf(A)}`, "A's file is untouched")
  } finally {
    await harness.close()
    rmSync(a, { recursive: true, force: true })
    rmSync(b, { recursive: true, force: true })
  }
})

test('a PDF withdrawn after a failed backup is no longer reachable', async () => {
  const dir = workspace(A)
  const harness = await mount(dir)
  const outDir = join(dir, '.latex-preview')
  try {
    const state = await settled(harness)
    assert.notEqual(state.pdfUrl, null)
    const served = await harness.fetch('/pdf/main.pdf')
    assert.equal(served.status, 200, 'and it is reachable while it is trusted')

    // Backup impossible, compiler writes half a PDF, exits non-zero: the sequence
    // the review named. The panel must stop offering it *and* the URL must stop
    // answering, because a stale URL outlives the state that withdrew it.
    mkdirSync(`${compilePaths(join(dir, 'main.tex'), outDir).prev}.tmp`)
    harness.behaviour.partial = true
    writeFileSync(join(dir, 'main.tex'), B)
    const result = await harness.service.compileNow(signal())
    const after = await harness.service.getState(signal())

    assert.equal(result.artifactState, 'unavailable')
    assert.equal(result.pdfPath, null)
    assert.equal(result.pdfUrl, null, 'the result must not carry a URL either')
    assert.equal(after.pdfUrl, null)
    assert.equal(after.viewerUrl, null)

    const gone = await harness.fetch('/pdf/main.pdf')
    assert.equal(gone.status, 404, 'the file is deleted, so the old URL is a plain 404')
    assert.ok(!gone.body.includes('PARTIAL'))
  } finally {
    await harness.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the PDF route does not serve the rest of the build directory', async () => {
  const dir = workspace(A)
  const harness = await mount(dir)
  const outDir = join(dir, '.latex-preview')
  try {
    await settled(harness)
    // Neither of these is a document; both sit next to one.
    writeFileSync(join(outDir, 'main.log'), 'log')
    writeFileSync(join(outDir, 'main.prev.manifest.json'), '{}')

    for (const path of ['/pdf/main.log', '/pdf/main.prev.manifest.json', '/pdf/main.pdf.prev']) {
      const response = await harness.fetch(path)
      assert.equal(response.status, 404, `${path} → ${response.status}`)
      assert.ok(!response.body.includes('log'), `${path} answered with the file`)
    }
    assert.equal((await harness.fetch('/pdf/main.pdf')).status, 200, 'the PDF itself is still served')
  } finally {
    await harness.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an acceptance sent over HTTP waits for the compile that owns the pair', async () => {
  const dir = workspace(A)
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const harness = await mount(dir, async () => {
    if (!gate) return
    const held = gate
    gate = null
    await held
  })
  try {
    await settled(harness)
    // One accepted revision and one pending change, so 接受 has work to do.
    writeFileSync(join(dir, 'main.tex'), B)
    const second = await harness.post('compile')
    assert.equal(second.ok, true, JSON.stringify(second.error))
    assert.equal((await harness.service.getState(signal())).baseRevisionId, digestOf(A))

    // The run that holds the pair: the compiler returns — so `main.pdf` already holds
    // C's bytes — and nothing has been published or credentialed yet.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    writeFileSync(join(dir, 'main.tex'), C)
    const runs = harness.behaviour.runs
    const running = harness.service.compileNow(signal())
    await until(() => harness.behaviour.runs > runs, 'the held run to reach the compiler')

    // 接受 reads `main.pdf` off disk and promotes it. Sent now, it would read C's
    // bytes against B's credential, refuse the pair and delete the baseline; the route
    // therefore has to join the queue the compile is holding.
    const accepting = harness.post('accept')
    const early = await Promise.race([
      accepting.then(() => 'done' as const),
      delay(200).then(() => 'pending' as const),
    ])
    assert.equal(early, 'pending', 'an acceptance must not read the pair inside the compile’s window')

    hold.release?.()
    await running
    const accepted = await accepting
    assert.equal(accepted.ok, true, JSON.stringify(accepted.error))

    const state = await harness.service.getState(signal())
    // Queue order: the compile published C, then the acceptance promoted it.
    assert.equal(state.baseRevisionId, digestOf(C), 'the acceptance promoted the revision it saw')
    assert.notEqual(state.basePdfUrl, null, 'and the pair is still offered')
    // End to end: the baseline bytes are the document on screen, served over the route.
    assert.equal((await harness.fetch('/pdf/main.prev.pdf')).body, `PDF:${digestOf(C)}`)
  } finally {
    hold.release?.()
    await harness.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a revert sent over HTTP waits for the compile in flight', async () => {
  const dir = workspace(A)
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const harness = await mount(dir, async () => {
    if (!gate) return
    const held = gate
    gate = null
    await held
  })
  try {
    await settled(harness)
    // accepted = A, current = B: 撤销 has a baseline to go back to.
    writeFileSync(join(dir, 'main.tex'), B)
    await harness.post('compile')

    // Park a compile after its compiler returned. The revert click lands *now*, over
    // HTTP, while the queue is held by that run.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    writeFileSync(join(dir, 'main.tex'), C)
    const runs = harness.behaviour.runs
    const running = harness.service.compileNow(signal())
    await until(() => harness.behaviour.runs > runs, 'the held run to reach the compiler')

    const reverting = harness.post('revert')
    const early = await Promise.race([
      reverting.then(() => 'done' as const),
      delay(200).then(() => 'pending' as const),
    ])
    assert.equal(early, 'pending', 'the revert must join the queue behind the compile')

    hold.release?.()
    await running
    const reverted = await reverting
    assert.equal(reverted.ok, true, JSON.stringify((reverted as { error?: { message: string } }).error))

    const state = await harness.service.getState(signal())
    assert.equal(readFileSync(join(dir, 'main.tex'), 'utf8'), A, 'the source went back to the baseline')
    assert.equal(state.baseRevisionId, digestOf(A))
    assert.equal(readFileSync(join(dir, '.latex-preview', 'main.pdf'), 'utf8'), `PDF:${digestOf(A)}`, 'the page is the reverted document')
  } finally {
    hold.release?.()
    await harness.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a revert whose workspace went away reports the switch instead of acting on the new one', async () => {
  const dirA = workspace(A)
  const dirB = workspace(B)
  let gate: Promise<void> | null = null
  const hold: { release?: () => void } = {}
  const harness = await mount(dirA, async () => {
    if (!gate) return
    const held = gate
    gate = null
    await held
  })
  try {
    await settled(harness)
    writeFileSync(join(dirA, 'main.tex'), C)
    // Park the compile after its compiler returned: the revert click lands while
    // the queue is held by that run, so the workspace switch below beats the
    // queued task instead of racing it mid-compile.
    gate = new Promise<void>((resolve) => {
      hold.release = resolve
    })
    const runs = harness.behaviour.runs
    const running = harness.service.compileNow(signal())
    await until(() => harness.behaviour.runs > runs, 'the held run to reach the compiler')

    // 撤销 is clicked for A, and the click is what the task must remember.
    const reverting = harness.post('revert')
    await delay(30)
    await harness.service.configure({ rootFile: join(dirB, 'main.tex'), review: 'manual' }, signal())

    hold.release?.()
    await running
    const reverted = await reverting
    assert.equal(reverted.ok, false, 'the click was for A; acting on B would be wrong')
    assert.match(
      (reverted as { error?: { message: string } }).error?.message ?? '',
      /工作区已切换/,
      JSON.stringify(reverted.error),
    )

    const state = await harness.service.getState(signal())
    assert.equal(state.rootFile, join(dirB, 'main.tex'))
    assert.equal(readFileSync(join(dirB, 'main.tex'), 'utf8'), B, "B's source is untouched by A's revert")
  } finally {
    hold.release?.()
    await harness.close()
    rmSync(dirA, { recursive: true, force: true })
    rmSync(dirB, { recursive: true, force: true })
  }
})
