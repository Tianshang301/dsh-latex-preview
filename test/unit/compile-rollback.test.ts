/**
 * Rollback, half-rollback, and the first compile that fails.
 *
 * The compile service is driven through its injected runner rather than a real
 * Tectonic process: what needs testing is what the *service* does with a given
 * outcome — restore both halves, refuse to report a clean rollback when it could
 * restore only one, and delete partial output when there is nothing to fall back
 * to. A real Tectonic will not fail on cue with a half-written PDF.
 *
 * @module dsh-latex-preview/test/unit/compile-rollback
 */

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { CompileService, compilePaths, type CompileRun } from '../../src/services/compile.ts'

/** One throwaway workspace per test. */
interface Fixture {
  readonly rootFile: string
  readonly outDir: string
  readonly paths: ReturnType<typeof compilePaths>
  readonly service: CompileService
  /** Write the artefacts a successful run would leave behind. */
  seed(pdf: string, synctex: string): Promise<void>
  /** Bytes of a file, or null when it is gone. */
  read(path: string): Promise<string | null>
}

/**
 * Build a workspace whose compiler is the given function.
 * @param dir - temporary directory the fixture lives in.
 * @param run - what the fake compiler does.
 * @returns the fixture.
 */
async function fixture(dir: string, run: (timeoutMs: number) => Promise<CompileRun>): Promise<Fixture> {
  const rootFile = join(dir, 'main.tex')
  const outDir = join(dir, '.latex-preview')
  await mkdir(outDir, { recursive: true })
  await writeFile(rootFile, '\\documentclass{article}\n\\begin{document}\nA\n\\end{document}\n', 'utf8')
  const paths = compilePaths(rootFile, outDir)
  const service = new CompileService({
    rootFile,
    outDir,
    timeoutMs: 5_000,
    firstRunTimeoutMs: 5_000,
    run,
  })
  return {
    rootFile,
    outDir,
    paths,
    service,
    seed: async (pdf, synctex) => {
      await writeFile(paths.pdf, pdf, 'utf8')
      await writeFile(paths.synctex, synctex, 'utf8')
    },
    read: async (path) => {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
  }
}

/** Run one test body in a fresh temporary directory, then clean it up. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-latex-rollback-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

const ok = (): CompileRun => ({ code: 0, stdout: '', stderr: '', timedOut: false })
const failed = (): CompileRun => ({ code: 1, stdout: '', stderr: '', timedOut: false })

test('a successful compile keeps the pre-compile copies as the previous revision', async () => {
  await withDir(async (dir) => {
    const seen: string[] = []
    const f = await fixture(dir, async () => {
      await writeFile(f.paths.pdf, 'pdf-v2', 'utf8')
      await writeFile(f.paths.synctex, 'synctex-v2', 'utf8')
      seen.push('ran')
      return ok()
    })
    await f.seed('pdf-v1', 'synctex-v1')
    const result = await f.service.run()

    assert.equal(result.ok, true)
    assert.equal(result.rolledBack, false)
    assert.equal(result.rollbackIncomplete, false)
    assert.equal(result.artifactState, 'current', 'the new artefacts are this run’s output')
    // The pair is left for the publisher (artifacts.ts), not promoted by the runner.
    assert.equal(await f.read(f.paths.prev), 'pdf-v1')
    assert.equal(await f.read(f.paths.prevSynctex), 'synctex-v1')
    assert.equal(await f.read(f.paths.pdf), 'pdf-v2')
    assert.equal(await f.read(f.paths.basePdf), null)
    assert.equal(seen.length, 1)
  })
})

test('a failed compile restores the PDF and the sync map together', async () => {
  await withDir(async (dir) => {
    // The fake run leaves the previous artefacts untouched, like Tectonic refusing
    // to write anything at all.
    const f = await fixture(dir, async () => failed())
    await f.seed('pdf-v1', 'synctex-v1')
    const result = await f.service.run()

    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, true)
    assert.equal(result.rollbackIncomplete, false)
    assert.equal(result.artifactState, 'restored', 'the failure did not damage the previous revision')
    assert.equal(await f.read(f.paths.pdf), 'pdf-v1')
    assert.equal(await f.read(f.paths.synctex), 'synctex-v1')
    assert.equal(result.pdfPath, f.paths.pdf)
  })
})

test('restoring only the PDF is reported as an incomplete rollback', async () => {
  await withDir(async (dir) => {
    // Removing the backup mid-run is the only way to make one half unrecoverable
    // while the other still succeeds — the case the flag exists for.
    const f = await fixture(dir, async () => {
      await writeFile(f.paths.pdf, 'pdf-broken', 'utf8')
      await writeFile(f.paths.synctex, 'synctex-broken', 'utf8')
      await unlink(f.paths.prevSynctex)
      return failed()
    })
    await f.seed('pdf-v1', 'synctex-v1')
    const result = await f.service.run()

    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, false, 'a half-done restore is not a rollback')
    assert.equal(result.rollbackIncomplete, true)
    assert.equal(result.artifactState, 'unavailable', 'a mixed pair is not showable')
    assert.equal(result.pdfPath, null, 'and no path may invite the caller to show it')
    // Half a pair is not a pair. The PDF came back but nothing can describe *which*
    // document it is (its map belongs to a different run), so both halves are
    // deleted rather than left in `outDir` for a static route or the next backup.
    assert.equal(await f.read(f.paths.pdf), null)
    assert.equal(await f.read(f.paths.synctex), null)
  })
})

test('a first compile that fails leaves no PDF behind', async () => {
  await withDir(async (dir) => {
    const f = await fixture(dir, async () => {
      // A real failure can still leave a partial file; it must not be shown.
      await writeFile(f.paths.pdf, 'pdf-partial', 'utf8')
      await writeFile(f.paths.synctex, 'synctex-partial', 'utf8')
      return failed()
    })
    const result = await f.service.run()

    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, false)
    assert.equal(result.rollbackIncomplete, false, 'nothing was there to roll back')
    assert.equal(result.artifactState, 'unavailable')
    assert.equal(await f.read(f.paths.pdf), null)
    assert.equal(await f.read(f.paths.synctex), null)
    assert.equal(result.pdfPath, null)
  })
})

test('a run that exits zero without producing a PDF is a failure', async () => {
  await withDir(async (dir) => {
    const f = await fixture(dir, async () => ok())
    const result = await f.service.run()

    assert.equal(result.ok, false)
    assert.equal(result.rolledBack, false)
    assert.equal(result.artifactState, 'unavailable')
    assert.equal(result.pdfPath, null)
  })
})

test('a failed backup plus a partial PDF leaves nothing to serve', async () => {
  await withDir(async (dir) => {
    // The exact sequence the review asked for: the backup cannot be made, the
    // compiler writes half a PDF anyway, then exits non-zero. Nothing about the
    // file that remains can be vouched for — not even that it is the previous
    // revision — so it must not survive in the output directory, where the static
    // route would serve it to anyone holding the last URL.
    const f = await fixture(dir, async () => {
      await writeFile(f.paths.pdf, 'pdf-partial', 'utf8')
      await writeFile(f.paths.synctex, 'synctex-partial', 'utf8')
      await writeFile(f.paths.log, '! Undefined control sequence.\n', 'utf8')
      return failed()
    })
    await f.seed('pdf-v1', 'synctex-v1')
    // A directory where the backup's temporary file must go: the pair cannot be
    // copied, so this run has nothing to restore from.
    await mkdir(`${f.paths.prev}.tmp`, { recursive: true })
    const result = await f.service.run()

    assert.equal(result.ok, false)
    assert.equal(result.backup.status, 'failed')
    assert.equal(result.rollbackIncomplete, true)
    assert.equal(result.artifactState, 'unavailable')
    assert.equal(result.pdfPath, null)
    assert.equal(await f.read(f.paths.pdf), null, 'the partial PDF is deleted, not merely hidden')
    assert.equal(await f.read(f.paths.synctex), null, 'and so is the map that would point into it')
    assert.equal(await f.read(f.paths.prev), null, 'no half-made backup stands in for the old revision')
    // The log is evidence for the user, not a preview target: it stays.
    assert.notEqual(result.logPath, null)
  })
})

test('the sync map backup is dropped when the previous revision had none', async () => {
  await withDir(async (dir) => {
    const f = await fixture(dir, async () => {
      await writeFile(f.paths.pdf, 'pdf-v2', 'utf8')
      await writeFile(f.paths.synctex, 'synctex-v2', 'utf8')
      return ok()
    })
    // A PDF with no map: an interrupted earlier run.
    await writeFile(f.paths.pdf, 'pdf-v1', 'utf8')
    const result = await f.service.run()

    assert.equal(result.ok, true)
    let leftover = true
    try {
      await stat(f.paths.prevSynctex)
    } catch {
      leftover = false
    }
    assert.equal(leftover, false, 'a stale map must not be offered as the previous revision')
  })
})
