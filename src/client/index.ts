/**
 * Client half entry point (browser).
 *
 * Deliberately dependency-free at this milestone: it declares the Host service
 * as a hard dependency and probes for the slot service, but renders nothing
 * yet. The panel arrives with P0.5, once the slot key for the preview pane and
 * the Remote mounting contract are confirmed (see docs/spikes.md, B1/B2).
 *
 * @module dsh-latex-preview/client
 */

export const name = 'latex-preview-client'

/** Hard dependency: the generated Remote namespace for the Host service. */
export const inject = ['latexPreview']

/** Minimal shape of the slot service we probe for; avoids depending on its package yet. */
interface SlotServiceLike {
  register?: (options: Record<string, unknown>, component: unknown) => unknown
}

/**
 * Install the client half.
 * @param ctx - Client context (typed loosely until the web shell types are available).
 */
export function apply(ctx: { get?: (key: string) => unknown; slots?: SlotServiceLike }): void {
  const slots = ctx.slots ?? (ctx.get?.('slots') as SlotServiceLike | undefined)
  if (!slots?.register) {
    console.warn('[latex-preview] slot service unavailable; preview panel not mounted')
    return
  }
  // P0.5 registers the panel here, following the one verified pattern:
  //   ctx.slots.inject(key, () => ctx.slots.register(opts, Component))
  // — never wrapped in ctx.effect (throws `Invalid effect`, panel silently vanishes).
  console.info('[latex-preview] client loaded; awaiting slot registration (P0.5)')
}
