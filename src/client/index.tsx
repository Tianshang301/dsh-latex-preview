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
import type { PreviewApi } from './api.ts'

export const name = 'latex-preview-client'

/** Hard dependency: the generated Remote namespace for the Host service. */
export const inject = ['latexPreview']

/** Tab slot and its title slot, both declared by the right sidebar plugin. */
const TAB_SLOT = 'sidebar.right.pane.tab'
const TITLE_SLOT = 'sidebar.right.pane.tab.title'

/** Registration id; must be stable, it is the slot's entry key. */
const ENTRY_ID = 'latex-preview'

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
  latexPreview: PreviewApi
  slots?: SlotsServiceLike
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

  const api = ctx.latexPreview

  slots.inject(TITLE_SLOT, () =>
    slots.register({ name: TITLE_SLOT, id: ENTRY_ID, label: 'LaTeX' }, () => 'LaTeX' as unknown as ReactNode),
  )

  slots.inject(TAB_SLOT, () => slots.register({ name: TAB_SLOT, id: ENTRY_ID }, () => <LatexPreviewPanel api={api} />))
}
