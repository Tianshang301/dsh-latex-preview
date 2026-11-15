/**
 * Host half entry point.
 *
 * Registering the service is the only job this milestone: no watcher, no
 * compiler yet (T0.1 acceptance = "an empty plugin loads without errors").
 *
 * Invariants that bite here (see AGENTS.md):
 * - Other services are acquired with `ctx.inject(deps, cb)`, never `ctx.get()`
 *   inside `apply` — the service fiber may not exist yet.
 * - Every side effect returns a disposer registered through `ctx.effect`.
 *
 * @module dsh-latex-preview
 */

import type { Context } from '@deepseek-ai/cordis'
import { LatexPreviewService } from './services/latex-preview-service.ts'

export const name = 'latex-preview'

/** Hard dependencies of the Host half; empty until the static route lands (P0.4). */
export const inject: string[] = []

/**
 * Install the Host half.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(LatexPreviewService)

  // P0.4 will mount the same-origin static route here:
  //   ctx.inject(['webServer'], (wctx) => {
  //     const dispose = wctx.get('webServer').register({ ... })
  //     wctx.effect(() => dispose, 'latex-preview: static route')
  //   })
}
