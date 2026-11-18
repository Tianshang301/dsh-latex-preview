/**
 * Shared fixtures for the service-level tests.
 *
 * The binary probe is the one thing these tests must never do for real: the
 * production probe spawns `tectonic` with a 10 s budget, so any test that patches
 * the availability flags can have them overwritten a few milliseconds later — the
 * compile is then vetoed before the fake process runs, which looks exactly like a
 * compiler that never started. Injecting the answer removes the race rather than
 * waiting it out.
 *
 * @module dsh-latex-preview/test/unit/support
 */

import type { BinaryProbe, BinaryReport } from '../../src/utils/binaries.ts'

/** A probe result that says both binaries are installed. */
export function fakeBinaries(): BinaryReport {
  const probe = (command: string): BinaryProbe => ({
    command,
    available: true,
    path: `/usr/local/bin/${command}`,
    versions: ['test'],
    raw: `${command} (test fixture)`,
  })
  return { tectonic: probe('tectonic'), synctex: probe('synctex'), missing: [], guidance: [] }
}
