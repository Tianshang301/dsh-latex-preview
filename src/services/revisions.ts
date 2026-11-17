/**
 * The three revisions, and the two questions they answer.
 *
 * A LaTeX edit produces two different "what changed" questions, and conflating
 * them is what made an earlier version call a review baseline "上次编译版":
 *
 * | field             | moves when                                  | answers                                  |
 * |-------------------|---------------------------------------------|------------------------------------------|
 * | `accepted`        | 接受 / approving reviewer / every `open` compile | what still needs review (diff path A) |
 * | `previousCompile` | every successful compile whose content moved | what this save changed (diff path B)     |
 * | `current`         | every successful compile                    | what the PDF on screen was built from    |
 *
 * In `open` mode A and B coincide by construction — every compile is accepted, so
 * the previous compile *is* the accepted revision. In `manual` they diverge at the
 * first unaccepted change and stay apart until 接受, which is the whole point: A
 * accumulates review debt, B never does.
 *
 * Pure on purpose: this is the one place the semantics are written down, so it can
 * be tested without a compiler, a browser, or a Cordis context.
 *
 * @module dsh-latex-preview/services/revisions
 */

import type { DiffSide, ReviewMode } from '../types.ts'

/** The three source snapshots, all `null` before the workspace is configured. */
export interface Revisions {
  readonly accepted: string | null
  readonly previousCompile: string | null
  readonly current: string | null
}

/**
 * The state a freshly configured workspace starts in.
 *
 * What is on disk counts as both accepted and current: nothing needs reviewing
 * yet, and the PDF that will be produced describes exactly this file. There is no
 * previous compile until one has happened.
 * @param source - content of the root file.
 * @returns the initial revisions.
 */
export function initialRevisions(source: string | null): Revisions {
  return { accepted: source, previousCompile: null, current: source }
}

/**
 * Fold one successful compile into the model.
 *
 * @param revisions - state before the compile finished.
 * @param compiled - source the compiler actually read.
 * @param mode - review mode; only `open` advances the accepted revision here.
 * @returns the new state and whether the content moved at all. A redundant compile
 *   (same bytes) advances nothing, so pressing 编译 twice cannot erase the marks.
 */
export function advanceRevisions(
  revisions: Revisions,
  compiled: string,
  mode: ReviewMode,
): { revisions: Revisions; changed: boolean } {
  if (compiled === revisions.current) return { revisions, changed: false }
  return {
    revisions: {
      // `manual` waits for 接受, `auto` waits for the reviewer (which moves it
      // itself), `open` has no gate at all.
      accepted: mode === 'open' ? (revisions.current ?? compiled) : revisions.accepted,
      // Path B describes the compiler, not the review gate, so it always moves.
      previousCompile: revisions.current ?? compiled,
      current: compiled,
    },
    changed: true,
  }
}

/**
 * Mark the current revision accepted (接受, an approving reviewer, or a revert that
 * has already written the file back).
 * @param revisions - current state.
 * @returns the state with `accepted` caught up to `current`.
 */
export function acceptCurrent(revisions: Revisions): Revisions {
  return { ...revisions, accepted: revisions.current }
}

/**
 * The left-hand side of a diff, per side.
 * @param revisions - current state.
 * @param side - which document the caller is going to draw on.
 * @returns the source to compare against, or null when that side has no basis.
 */
export function diffBaseFor(revisions: Revisions, side: DiffSide): string | null {
  return side === 'compile' ? revisions.previousCompile : revisions.accepted
}

/**
 * Read a `side` out of an untrusted request body.
 *
 * Kept in one place because it used to be two: the Remote method and the HTTP route
 * each normalised the field, and the route kept a two-branch version after `compile`
 * was added — every request for the previous compile silently became `new`, and the
 * response looked perfectly normal (`side: 'new'`, bands on the live PDF).
 * @param value - whatever arrived on the wire.
 * @returns a known side; anything unrecognised falls back to `new`.
 */
export function parseDiffSide(value: unknown): DiffSide {
  return value === 'base' || value === 'compile' ? value : 'new'
}

/**
 * Whether anything still needs review.
 * @param revisions - current state.
 * @returns true when the PDF on screen is not the accepted revision.
 */
export function hasPendingChanges(revisions: Revisions): boolean {
  return revisions.current !== null && revisions.accepted !== null && revisions.current !== revisions.accepted
}
