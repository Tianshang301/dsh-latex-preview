/**
 * A previous revision's artefacts, published as one transaction.
 *
 * The pair this module guards is a **PDF plus the `.synctex.gz` that describes it**,
 * and the whole point is that they are never mixed: a PDF from revision B next to a
 * sync map from revision C produces markers in plausible-looking but wrong places,
 * with no error anywhere. Two mechanisms prevent that:
 *
 * 1. **A manifest is the commit record.** `verify()` trusts a pair only when the
 *    manifest exists *and* the hashes of the files on disk are the hashes it names.
 *    Two files alone prove nothing — they may be leftovers from an older run, a
 *    half-finished copy, or a pair whose second file failed to land.
 * 2. **Publish order is fail-closed.** The manifest is removed first, the files are
 *    installed second, and a fresh manifest is written last. A crash at any point
 *    leaves either no manifest or one that no longer matches, so `verify()` says no.
 *
 * The names must keep pairing: `synctex view -o main.prev.pdf` looks for
 * `main.prev.synctex.gz` by basename (docs/spikes.md §B20), which is why both files
 * carry the same tag rather than living in versioned subdirectories.
 *
 * @module dsh-latex-preview/services/artifacts
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/** Bumped when the manifest shape changes; an unknown version is not trusted. */
const MANIFEST_VERSION = 1

/** One file recorded by the manifest. */
export interface ArtifactFile {
  /** Basename, so the record survives a move of the whole output directory. */
  readonly file: string
  /** sha256 of the bytes on disk when this record was written. */
  readonly sha256: string
  readonly bytes: number
}

/** What a published pair claims about itself. */
export interface ArtifactManifest {
  readonly version: number
  /** Digest of the **source** that produced the pair (see the service's `digestOf`). */
  readonly revisionId: string
  readonly pdf: ArtifactFile
  readonly synctex: ArtifactFile
  /** ISO timestamp, for humans reading the file and for ordering two snapshots. */
  readonly createdAt: string
}

/** Paths of one pair; the three names share a tag so SyncTeX can find the map. */
export interface ArtifactPaths {
  readonly pdf: string
  readonly synctex: string
  readonly manifest: string
}

/**
 * Derive the three paths of one tagged pair.
 * @param outDir - the compile output directory.
 * @param stem - root file stem (`main`).
 * @param tag - `prev` (accepted revision) or `recent` (previous compile).
 * @returns absolute paths.
 */
export function artifactPaths(outDir: string, stem: string, tag: string): ArtifactPaths {
  const name = `${stem}.${tag}`
  return {
    pdf: join(outDir, `${name}.pdf`),
    synctex: join(outDir, `${name}.synctex.gz`),
    manifest: join(outDir, `${name}.manifest.json`),
  }
}

/** sha256 of a file, streamed in one read; these files are small. */
async function hashFile(path: string): Promise<ArtifactFile> {
  const bytes = await readFile(path)
  return {
    file: basename(path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    bytes: bytes.byteLength,
  }
}

/** Whether a path exists and is a regular file with content. */
async function usable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size > 0
  } catch {
    return false
  }
}

/** Remove a file, ignoring "already gone". */
async function removeQuietly(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    /* nothing to do */
  }
}

export class ArtifactStore {
  constructor(private readonly paths: ArtifactPaths) {}

  /**
   * The manifest, but only when the files on disk still match it.
   *
   * Hashing on every check is deliberate: the pair is a few hundred kilobytes and
   * the alternative is trusting a file that a crashed write may have truncated.
   * @returns the verified manifest, or null when the pair is absent, incomplete,
   *   unparsable, or no longer matches its own record.
   */
  async verify(): Promise<ArtifactManifest | null> {
    let manifest: ArtifactManifest
    try {
      const raw = await readFile(this.paths.manifest, 'utf8')
      const parsed = JSON.parse(raw) as ArtifactManifest
      if (parsed?.version !== MANIFEST_VERSION || typeof parsed.revisionId !== 'string') return null
      if (!parsed.pdf || !parsed.synctex) return null
      manifest = parsed
      if (manifest.pdf.file !== basename(this.paths.pdf)) return null
      if (manifest.synctex.file !== basename(this.paths.synctex)) return null
      if (!(await usable(this.paths.pdf)) || !(await usable(this.paths.synctex))) return null
      const [pdf, synctex] = await Promise.all([hashFile(this.paths.pdf), hashFile(this.paths.synctex)])
      if (pdf.sha256 !== manifest.pdf.sha256 || pdf.bytes !== manifest.pdf.bytes) return null
      if (synctex.sha256 !== manifest.synctex.sha256 || synctex.bytes !== manifest.synctex.bytes) return null
      return manifest
    } catch {
      // Missing, unreadable, or not JSON: indistinguishable from "never published".
      return null
    }
  }

  /**
   * Install a pair and commit it with a manifest.
   *
   * @param input.revisionId - digest of the source that produced the two files.
   * @param input.pdf - source PDF to install.
   * @param input.synctex - source sync map to install; must describe `pdf`.
   * @returns true only when both files and the manifest are in place and verified.
   */
  async publish(input: { revisionId: string; pdf: string; synctex: string }): Promise<boolean> {
    if (!(await usable(input.pdf)) || !(await usable(input.synctex))) {
      await this.drop()
      return false
    }
    await mkdir(dirname(this.paths.manifest), { recursive: true }).catch(() => undefined)
    // 1. Retire the old claim first: from here on nothing may trust the files.
    await removeQuietly(this.paths.manifest)
    try {
      // 2. Install both files. A failed copy leaves no manifest, so verify() fails.
      await this.install(input.pdf, this.paths.pdf)
      await this.install(input.synctex, this.paths.synctex)
      const [pdf, synctex] = await Promise.all([hashFile(this.paths.pdf), hashFile(this.paths.synctex)])
      const manifest: ArtifactManifest = {
        version: MANIFEST_VERSION,
        revisionId: input.revisionId,
        pdf,
        synctex,
        createdAt: new Date().toISOString(),
      }
      // 3. Commit. An atomic rename means a reader never sees a half-written JSON.
      const tmp = `${this.paths.manifest}.tmp`
      await writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8')
      await removeQuietly(this.paths.manifest)
      await rename(tmp, this.paths.manifest)
      return true
    } catch {
      await this.drop()
      return false
    }
  }

  /**
   * Retire the pair.
   *
   * The manifest goes first so a concurrent reader cannot see a valid record over
   * files that are mid-deletion.
   */
  async drop(): Promise<void> {
    await removeQuietly(this.paths.manifest)
    await removeQuietly(this.paths.pdf)
    await removeQuietly(this.paths.synctex)
    await removeQuietly(`${this.paths.manifest}.tmp`)
  }

  /** Copy one file into place, replacing any previous version. */
  private async install(from: string, to: string): Promise<void> {
    const tmp = `${to}.tmp`
    await copyFile(from, tmp)
    // Windows refuses to rename over an existing file; removing first keeps the
    // window between the two calls harmless, because the manifest is already gone.
    await removeQuietly(to)
    await rename(tmp, to)
  }
}
