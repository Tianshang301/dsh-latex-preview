/**
 * The one Host service the client half talks to.
 *
 * Shape follows the Typert Remote contract (verified 2026-11-16 against
 * `@deepseek-ai/dsh-typert-protocol@0.1.0-rc.6` and a published third-party
 * plugin):
 * - `TypertRemoteService` + `super(ctx, key, { namespace })` publishes the
 *   service to the Gateway; the client sees generated descriptors, never the
 *   instance itself.
 * - Every exported method takes JSON parameters plus a trailing client-supplied
 *   `AbortSignal`, and returns plain JSON. **A callback cannot cross the wire**,
 *   which is why there is no `onCompiled(cb)` here — the client polls
 *   `getState()` (fallback B in the handoff) until a forwarded event is proven
 *   to work for a third-party plugin.
 * - Failures are reported as `RemoteError` codes, not thrown business errors.
 *
 * @module dsh-latex-preview/services/latex-preview-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { checkBinaries } from '../utils/binaries.ts'
import type { PreviewState } from '../types.ts'

/** Service key and wire namespace; must stay identical to the naming convention. */
export const SERVICE_KEY = 'latexPreview'

/** Error codes the client is allowed to branch on. */
export const ErrorCode = {
  notImplemented: 'latex-preview/not-implemented',
  noRootFile: 'latex-preview/no-root-file',
  binaryMissing: 'latex-preview/binary-missing',
} as const

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live LaTeX preview state for the current workspace. */
    latexPreview: LatexPreviewService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'latex-preview/not-implemented': { readonly feature: string }
    'latex-preview/no-root-file': { readonly hint: string }
    'latex-preview/binary-missing': { readonly missing: readonly string[] }
  }
}

export class LatexPreviewService extends TypertRemoteService {
  private state: PreviewState

  constructor(ctx: Context) {
    super(ctx, SERVICE_KEY, { namespace: SERVICE_KEY })
    this.state = {
      version: 0,
      rootFile: null,
      status: 'idle',
      pdfUrl: null,
      compiledAt: null,
      diagnostics: [],
      binaries: { tectonic: false, synctex: false },
    }
    void this.refreshBinaries()
  }

  /**
   * Probe the external binaries once and fold the result into the state.
   * Never throws: a missing binary is a UI-visible condition, not a crash.
   * @returns the probe result, or undefined when the probe itself failed.
   */
  async refreshBinaries(): Promise<PreviewState['binaries'] | undefined> {
    try {
      const report = await checkBinaries()
      this.state = {
        ...this.state,
        binaries: { tectonic: report.tectonic.available, synctex: report.synctex.available },
      }
      this.bump()
      return this.state.binaries
    } catch (error) {
      this.ctx.logger?.('latex-preview')?.warn?.('binary probe failed: %s', String(error))
      return undefined
    }
  }

  /**
   * Current snapshot, safe to poll.
   * @param signal - client cancellation.
   * @returns an immutable snapshot of the preview state.
   */
  @Remote
  async getState(signal: AbortSignal): Promise<PreviewState> {
    signal.throwIfAborted()
    return this.state
  }

  /**
   * Force a re-probe of `tectonic` / `synctex` (the UI's "recheck" affordance).
   * @param signal - client cancellation.
   * @returns the fresh availability flags.
   */
  @Remote
  async recheckBinaries(signal: AbortSignal): Promise<PreviewState['binaries']> {
    signal.throwIfAborted()
    const binaryState = await this.refreshBinaries()
    if (!binaryState) {
      throw new RemoteError('latex-preview/binary-missing', 'binary probe could not run', { missing: [] })
    }
    return binaryState
  }

  /** Advance the version counter so pollers can detect a change without diffing. */
  private bump(): void {
    this.state = { ...this.state, version: this.state.version + 1 }
  }
}

export default LatexPreviewService
