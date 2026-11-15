/**
 * Standalone binary check: `pnpm binaries`.
 * Prints one fact per line so it can be pasted into a bug report.
 *
 * @module dsh-latex-preview/scripts/check-binaries
 */

import { checkBinaries, formatReport } from '../src/utils/binaries.ts'

const report = await checkBinaries()
for (const line of formatReport(report)) console.log(line)
process.exitCode = report.missing.length === 0 ? 0 : 1
