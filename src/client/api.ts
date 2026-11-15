/**
 * Client-side face of the Host service.
 *
 * The Host methods reach the browser as generated Remote descriptors, and every
 * call resolves to `RemoteResult<T>` — a tagged result, not a thrown error
 * (docs/spikes.md §B1). Unwrapping is centralised here so components never branch
 * on the transport shape.
 *
 * The descriptors themselves are produced by the Typert generator from the Host
 * types; until that artifact exists this module declares the surface by hand and
 * mirrors the Host signatures exactly.
 *
 * @module dsh-latex-preview/client/api
 */

import type { CompileResult, DiffBlock, PreviewState, SyncEditHit, SyncViewHit } from '../types.ts'

/** Transport envelope every Remote call resolves to. */
export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }

/** Host methods this panel uses. */
export interface PreviewApi {
  getState(signal?: AbortSignal): Promise<RemoteResult<PreviewState>>
  configure(
    request: { file?: string; rootFile?: string; outDir?: string; redact?: boolean; debounceMs?: number },
    signal?: AbortSignal,
  ): Promise<RemoteResult<PreviewState>>
  compileNow(signal?: AbortSignal): Promise<RemoteResult<CompileResult>>
  getDiff(signal?: AbortSignal): Promise<RemoteResult<readonly DiffBlock[]>>
  jumpToPdf(request: { line: number; file?: string }, signal?: AbortSignal): Promise<RemoteResult<readonly SyncViewHit[]>>
  jumpToSource(request: { page: number; x: number; y: number }, signal?: AbortSignal): Promise<RemoteResult<readonly SyncEditHit[]>>
  sendErrorToAgent(request: { redact?: boolean }, signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; detail?: string }>>
  recheckBinaries(signal?: AbortSignal): Promise<RemoteResult<PreviewState['binaries']>>
}

/** Outcome of an unwrapped call. */
export type Unwrapped<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly message: string }

/**
 * Run one Remote call and flatten the transport envelope.
 * @param call - a promise resolving to a `RemoteResult`.
 * @returns the value, or a message suitable for the status bar.
 */
export async function unwrap<T>(call: Promise<RemoteResult<T>>): Promise<Unwrapped<T>> {
  try {
    const result = await call
    if (result.ok) return { ok: true, value: result.value }
    return { ok: false, message: `${result.error.code}: ${result.error.message}` }
  } catch (error) {
    // Only assembly faults reject (unmounted method, arity mismatch).
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Poll interval for `getState`; the spec's transport has no push channel (B1). */
export const POLL_INTERVAL_MS = 500

/** Base path of the plugin's own same-origin API. */
const API_BASE = '/.latex-preview/api'

/**
 * `PreviewApi` implemented over the Host's same-origin JSON route.
 *
 * The panel cannot `inject` the Host service (`docs/spikes.md` §B1 — the client
 * fiber waits for a service that only exists in the Host process), and the Typert
 * Remote path needs generated artifacts we do not publish yet. The route is
 * verified working on a real DSH boot, and its envelope is the same
 * `RemoteResult` shape, so only this class would change if Remote lands later.
 */
export class HttpPreviewApi implements PreviewApi {
  private call<T>(method: string, body?: unknown, signal?: AbortSignal): Promise<RemoteResult<T>> {
    return fetch(`${API_BASE}/${method}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    }).then(async (response) => {
      const payload = (await response.json()) as RemoteResult<T>
      if (typeof payload === 'object' && payload !== null && 'ok' in payload) return payload
      return { ok: false as const, error: { code: 'latex-preview/bad-response', message: `HTTP ${response.status}` } }
    })
  }

  getState(signal?: AbortSignal): Promise<RemoteResult<PreviewState>> {
    return this.call('state', undefined, signal)
  }

  configure(
    request: { file?: string; rootFile?: string; outDir?: string; redact?: boolean; debounceMs?: number },
    signal?: AbortSignal,
  ): Promise<RemoteResult<PreviewState>> {
    return this.call('configure', request, signal)
  }

  compileNow(signal?: AbortSignal): Promise<RemoteResult<CompileResult>> {
    return this.call('compile', {}, signal)
  }

  getDiff(signal?: AbortSignal): Promise<RemoteResult<readonly DiffBlock[]>> {
    return this.call('diff', {}, signal)
  }

  jumpToPdf(request: { line: number; file?: string }, signal?: AbortSignal): Promise<RemoteResult<readonly SyncViewHit[]>> {
    return this.call('jump-to-pdf', request, signal)
  }

  jumpToSource(
    request: { page: number; x: number; y: number },
    signal?: AbortSignal,
  ): Promise<RemoteResult<readonly SyncEditHit[]>> {
    return this.call('jump-to-source', request, signal)
  }

  sendErrorToAgent(request: { redact?: boolean }, signal?: AbortSignal): Promise<RemoteResult<{ ok: boolean; detail?: string }>> {
    return this.call('send-error', request, signal)
  }

  recheckBinaries(signal?: AbortSignal): Promise<RemoteResult<PreviewState['binaries']>> {
    return this.call('binaries', {}, signal)
  }
}
