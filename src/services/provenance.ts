/**
 * Who is allowed to claim that a PDF came from a revision.
 *
 * A manifest (see `artifacts.ts`) proves *integrity*: these bytes are the bytes it
 * recorded. That is not the same claim as *provenance* — that the bytes were
 * produced by compiling that revision — and the difference is the whole bug class
 * this module exists for. Two ways integrity passes while provenance is false:
 *
 * 1. a `main.pdf` left over from an earlier session is copied to `prev` and
 *    published under the digest of the source currently on disk;
 * 2. the source changes while the compiler is running, so the PDF describes one
 *    revision and the post-compile `readSource` returns another.
 *
 * The answer here is deliberately narrow: only the process that ran the compiler
 * may issue a credential, and the credential names the exact bytes it produced
 * (hashes) together with the workspace they belong to. Anything else — a restart,
 * a workspace switch, a failed backup — leaves the credential absent, and absence
 * means "do not publish a revision", never "publish anyway".
 *
 * Pure functions only: the decision must be testable without a compiler.
 *
 * @module dsh-latex-preview/services/provenance
 */

import { createHash } from 'node:crypto'

/** Hashes of the two files that make one artefact pair. */
export interface PairHashes {
  /** sha256 of the PDF. */
  readonly pdfSha256: string
  /** sha256 of its `.synctex.gz`. */
  readonly synctexSha256: string
}

/**
 * Permission to publish a pair as a named revision.
 *
 * Issued by the service only after it has itself compiled, hashed the result and
 * confirmed the source did not move underneath the compiler.
 */
export interface TrustedArtifacts extends PairHashes {
  /** Identity of the workspace (`rootFile` + `outDir`); credentials do not travel. */
  readonly workspaceId: string
  /** Digest of the source the compiler read. */
  readonly sourceDigest: string
}

/** What a publish site is about to claim. */
export interface Claim extends PairHashes {
  readonly workspaceId: string
  readonly sourceDigest: string
}

/**
 * Stable identity for a workspace.
 *
 * Both halves matter: the same document compiled into a different output directory
 * has different artefacts, and the same output directory holds artefacts for only
 * one root file.
 * @param rootFile - absolute root `.tex`.
 * @param outDir - absolute output directory.
 * @returns short hex digest, used only for equality.
 */
export function workspaceIdOf(rootFile: string, outDir: string): string {
  return createHash('sha1').update(`${rootFile}\u0000${outDir}`).digest('hex').slice(0, 12)
}

/**
 * Issue a credential for a pair this process just produced.
 * @param claim - workspace, source digest and hashes of the files as they sit on disk.
 * @returns the credential.
 */
export function issueTrust(claim: Claim): TrustedArtifacts {
  return {
    workspaceId: claim.workspaceId,
    sourceDigest: claim.sourceDigest,
    pdfSha256: claim.pdfSha256,
    synctexSha256: claim.synctexSha256,
  }
}

/**
 * Whether a credential authorises exactly this claim.
 *
 * All four fields must match: a credential for another workspace, another revision
 * or other bytes authorises nothing. There is no partial credit — a pair whose PDF
 * matches but whose sync map does not is precisely the mixed pair this guards.
 * @param trusted - the credential currently held, or null.
 * @param claim - what the caller wants to publish.
 * @returns true only for an exact match.
 */
export function trustCovers(trusted: TrustedArtifacts | null, claim: Claim): boolean {
  if (trusted === null) return false
  return (
    trusted.workspaceId === claim.workspaceId &&
    trusted.sourceDigest === claim.sourceDigest &&
    trusted.pdfSha256 === claim.pdfSha256 &&
    trusted.synctexSha256 === claim.synctexSha256
  )
}

/**
 * Whether an existing accepted pair may stay published.
 *
 * Kept separate from {@link trustCovers} because this is not a publish: the pair
 * was committed earlier (possibly by an earlier process) and the only question is
 * whether it still describes the accepted revision. Integrity plus a matching
 * revision id is enough — requiring a fresh credential here would delete a valid
 * pair on every restart, which is how the accepted view kept disappearing.
 * @param manifest - result of the pair's `verify()`, or null.
 * @param acceptedDigest - digest of the accepted revision.
 * @returns true when the pair may keep being shown.
 */
export function manifestStillDescribes(
  manifest: { readonly revisionId: string } | null,
  acceptedDigest: string,
): boolean {
  return manifest !== null && manifest.revisionId === acceptedDigest
}
