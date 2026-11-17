/**
 * The manifest is a commit record, so these tests attack it.
 *
 * Every case here is a way a pair of files can look fine on disk and still be
 * wrong: one half from an older run, a truncated copy, a manifest left over from a
 * pair that has since been replaced. `verify()` has to say no in all of them — a
 * false positive is a marker drawn at a plausible but wrong place, with no error.
 *
 * @module dsh-latex-preview/test/unit/artifacts
 */

import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { ArtifactStore, artifactPaths } from '../../src/services/artifacts.ts'

/** A store plus its three paths, in a throwaway directory. */
interface Fixture {
  readonly paths: ReturnType<typeof artifactPaths>
  readonly store: ArtifactStore
  /** Write a source PDF / sync map the store can publish from. */
  source(pdf: string, synctex: string): Promise<{ pdf: string; synctex: string }>
}

/**
 * Create a fixture.
 * @param dir - temporary directory.
 * @returns the fixture.
 */
function fixture(dir: string): Fixture {
  const paths = artifactPaths(dir, 'main', 'prev')
  const store = new ArtifactStore(paths)
  return {
    paths,
    store,
    source: async (pdf, synctex) => {
      const src = artifactPaths(dir, 'source', 'tmp')
      await writeFile(src.pdf, pdf, 'utf8')
      await writeFile(src.synctex, synctex, 'utf8')
      return { pdf: src.pdf, synctex: src.synctex }
    },
  }
}

/** Run one test body in a fresh temporary directory, then clean it up. */
async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-latex-artifacts-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a published pair verifies and names its revision', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    const src = await f.source('pdf-bytes', 'synctex-bytes')
    assert.equal(await f.store.publish({ revisionId: 'rev-1', ...src }), true)

    const manifest = await f.store.verify()
    assert.ok(manifest, 'a fresh pair must verify')
    assert.equal(manifest.revisionId, 'rev-1')
    assert.equal(manifest.pdf.bytes, 'pdf-bytes'.length)
    assert.equal(manifest.pdf.file, 'main.prev.pdf')
    assert.equal(manifest.synctex.file, 'main.prev.synctex.gz')
  })
})

test('nothing verifies before anything is published', async () => {
  await withDir(async (dir) => {
    assert.equal(await fixture(dir).store.verify(), null)
  })
})

test('a replaced PDF under the old manifest does not verify', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    const src = await f.source('pdf-v1', 'synctex-v1')
    await f.store.publish({ revisionId: 'rev-1', ...src })

    // Something else overwrote the PDF — a half-finished copy, or an older file
    // restored by hand. The map no longer describes this document.
    await writeFile(f.paths.pdf, 'pdf-v2-other', 'utf8')
    assert.equal(await f.store.verify(), null)
  })
})

test('a replaced sync map under the old manifest does not verify', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    const src = await f.source('pdf-v1', 'synctex-v1')
    await f.store.publish({ revisionId: 'rev-1', ...src })

    await writeFile(f.paths.synctex, 'synctex-from-another-build', 'utf8')
    assert.equal(await f.store.verify(), null)
  })
})

test('two files without a manifest are not a pair', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    await writeFile(f.paths.pdf, 'pdf', 'utf8')
    await writeFile(f.paths.synctex, 'synctex', 'utf8')
    assert.equal(await f.store.verify(), null)
  })
})

test('a truncated manifest does not verify', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    const src = await f.source('pdf', 'synctex')
    await f.store.publish({ revisionId: 'rev-1', ...src })

    const raw = await readFile(f.paths.manifest, 'utf8')
    await writeFile(f.paths.manifest, raw.slice(0, raw.length - 12), 'utf8')
    assert.equal(await f.store.verify(), null)
  })
})

test('a manifest claiming another file name does not verify', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    const src = await f.source('pdf', 'synctex')
    await f.store.publish({ revisionId: 'rev-1', ...src })

    const manifest = JSON.parse(await readFile(f.paths.manifest, 'utf8')) as Record<string, unknown>
    ;(manifest.pdf as Record<string, unknown>).file = 'main.recent.pdf'
    await writeFile(f.paths.manifest, JSON.stringify(manifest), 'utf8')
    assert.equal(await f.store.verify(), null)
  })
})

test('publishing with a missing source fails and leaves nothing verified', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    const src = await f.source('pdf', 'synctex')
    // Publish a good pair first, so "leaves nothing" means "drops the old claim too".
    await f.store.publish({ revisionId: 'rev-1', ...src })
    assert.ok(await f.store.verify())

    const ok = await f.store.publish({ revisionId: 'rev-2', pdf: join(dir, 'missing.pdf'), synctex: src.synctex })
    assert.equal(ok, false)
    assert.equal(await f.store.verify(), null)
  })
})

test('republishing replaces the pair and its revision', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    await f.store.publish({ revisionId: 'rev-1', ...(await f.source('pdf-1', 'synctex-1')) })
    await f.store.publish({ revisionId: 'rev-2', ...(await f.source('pdf-2', 'synctex-2')) })

    const manifest = await f.store.verify()
    assert.equal(manifest?.revisionId, 'rev-2')
    assert.equal(await readFile(f.paths.pdf, 'utf8'), 'pdf-2')
    assert.equal(await readFile(f.paths.synctex, 'utf8'), 'synctex-2')
  })
})

test('drop removes the manifest and both files', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    await f.store.publish({ revisionId: 'rev-1', ...(await f.source('pdf', 'synctex')) })
    await f.store.drop()

    const left: string[] = []
    for (const path of [f.paths.manifest, f.paths.pdf, f.paths.synctex]) {
      try {
        await stat(path)
        left.push(path)
      } catch {
        /* gone, as intended */
      }
    }
    assert.deepEqual(left, [])
    assert.equal(await f.store.verify(), null)
  })
})

test('an interrupted publish leaves no temp files that verify', async () => {
  await withDir(async (dir) => {
    const f = fixture(dir)
    await f.store.publish({ revisionId: 'rev-1', ...(await f.source('pdf', 'synctex')) })
    // Simulate a crash between the two installs: a temp file with real content.
    await writeFile(`${f.paths.pdf}.tmp`, 'half-copied', 'utf8')

    const names = await readdir(dir)
    assert.ok(names.some((name) => name.endsWith('.tmp')), 'the fixture did write a temp file')
    const manifest = await f.store.verify()
    assert.ok(manifest, 'a stray .tmp must not disturb a verified pair')
  })
})
