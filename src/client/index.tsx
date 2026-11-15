/**
 * Client half entry point.
 *
 * Slot choice is evidence-based (docs/spikes.md §B2): `editor.panel.item` does not
 * exist in DSH 0.2.2, and the only third-party-reachable panel slot is the keyed
 * `sidebar.right.pane.tab` declared by `@deepseek-ai/dsh-client-ui-sidebar-right`.
 * We therefore contribute one tab plus its title, both keyed by our package id.
 *
 * Registration shape follows the verified third-party convention:
 *
 * ```ts
 * ctx.slots.inject(key, () => ctx.slots.register({ name: key, id }, Component))
 * ```
 *
 * It must NOT be wrapped in `ctx.effect`: `inject` already owns the lifecycle and
 * returns the disposer for the caller's fiber (spec pitfall 14).
 *
 * @module dsh-latex-preview/client
 */

import type { ReactNode } from 'react'
import { LatexPreviewPanel } from './panel.tsx'
import { HttpPreviewApi, type PreviewApi } from './api.ts'

export const name = 'latex-preview-client'

/**
 * No service dependency: the Host service lives in the Host process and is
 * unreachable from here (B1). The panel talks to the Host over its same-origin
 * JSON route instead, so this half only needs the slot service.
 */
export const inject = ['slots']

/** Tab slot and its title slot, both declared by the right sidebar plugin. */
const TAB_SLOT = 'sidebar.right.pane.tab'
const TITLE_SLOT = 'sidebar.right.pane.tab.title'

/**
 * Keyed-slot key. Keyed slots (`kind: 'keyed'`) identify an entry by `key`, not
 * `id` — passing `id` fails validation and the whole client entry fails to
 * activate (observed on a real boot).
 */
const ENTRY_KEY = 'latex-preview'

/**
 * The subset of `SlotsService` we call. The real service's `register` is heavily
 * generic over a `SlotMap` that the owning plugin augments; depending on that
 * package would drag its runtime into our types for no benefit, so the contract
 * is declared structurally here and verified by the first real profile run.
 */
interface SlotsServiceLike {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: never) => ReactNode): () => void
}

/** The client context surface this plugin needs. */
export interface ClientContextLike {
  slots?: SlotsServiceLike
  /** Cordis fiber effect; owns disposal and unload cascade. */
  effect?: <T>(factory: () => T, label?: string) => T
  get?: (key: string) => unknown
}

/**
 * Install the client half.
 * @param ctx - client context; `slots` is probed rather than injected so a shell
 *   without the sidebar plugin still loads this bundle quietly.
 */
export function apply(ctx: ClientContextLike): void {
  const slots = ctx.slots ?? (ctx.get?.('slots') as SlotsServiceLike | undefined)
  if (!slots) {
    console.warn('[latex-preview] slot service unavailable; preview tab not mounted')
    return
  }

  const api: PreviewApi = new HttpPreviewApi()
  // `ctx.effect` ties the registration to this fiber so an unload removes it; the
  // reference plugins register exactly this way.
  const own: <T>(factory: () => T, label?: string) => T =
    typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (factory) => factory()

  try {
  own(
    () => slots.inject(TITLE_SLOT, () => slots.register({ name: TITLE_SLOT, key: ENTRY_KEY }, () => 'LaTeX')),
    'latex-preview: tab title',
  )
  own(
    () => slots.inject(TAB_SLOT, () => slots.register({ name: TAB_SLOT, key: ENTRY_KEY }, () => <LatexPreviewPanel api={api} />)),
    'latex-preview: preview tab',
  )
  } catch (error) {
    console.error('[latex-preview] apply failed', error)
    throw error
  }
}
