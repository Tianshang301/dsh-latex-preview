/**
 * Client half entry point.
 *
 * Mounting a right-sidebar tab takes **two** registrations, not one
 * (`docs/spikes.md` §B2/§B13):
 *
 * 1. **Stage one — the type.** `ctx.get('sidebarRightTabs').register(definition)`
 *    tells the sidebar that kind `latex-preview` exists. The sidebar builds its
 *    tab strip from its own type registry plus the session's layout, *not* from
 *    slot entries, so without this the strip stays empty no matter how correct
 *    the slot registration is. `definition.id` is also the key both stage-two
 *    slots resolve under (`renderSlot(..., { entryKey: definition.id })`).
 * 2. **Stage two — the body and the chip.** Keyed registrations into
 *    `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title`, keyed by that
 *    same id.
 *
 * Keyed slots take `key`, not `id`; passing `id` fails validation and the whole
 * client entry fails to activate with no error detail (observed on a real boot).
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

/** Tab kind: what `ctx.sidebarRight.openTab` names and the body renders for. */
const KIND = 'latex-preview'

/**
 * Entry key, which must equal the tab type's `id`: the seat resolves a body with
 * `entryKey: definition.id`, so a different key renders nothing.
 */
const ENTRY_ID = 'dsh-latex-preview'

/**
 * The subset of `SlotsService` we call. The real service's `register` is heavily
 * generic over a `SlotMap` that the owning plugin augments; depending on that
 * package would drag its runtime into our types for no benefit, so the contract
 * is declared structurally here and verified by a real profile run.
 */
interface SlotsServiceLike {
  inject(key: string, callback: () => () => void): () => void
  register(options: Record<string, unknown>, component: (props: never) => ReactNode): () => void
}

/** Tab-type registry published as `sidebarRightTabs`. */
interface TabTypesLike {
  register(definition: Record<string, unknown>): () => void
}

/** Cross-plugin sidebar face published as `sidebarRight`. */
interface SidebarRightLike {
  openTab(kind: string, options?: Record<string, unknown>): void
  /** Observable of the on-screen Session id; `openTab` throws while it is unset. */
  mounted?: { getSnapshot(): unknown; subscribe(listener: () => void): () => void }
}

/** The client context surface this plugin needs. */
export interface ClientContextLike {
  slots?: SlotsServiceLike
  /** Cordis fiber effect; owns disposal and unload cascade. */
  effect?: <T>(factory: () => T, label?: string) => T
  get?: (key: string) => unknown
  /**
   * Cordis dynamic inject: run the callback once the named services exist, and
   * tear it down if they disappear. Needed because the sidebar provides its
   * services on its own schedule — a bare `ctx.get` during activation can see
   * `undefined`, and then the tab type would never be declared.
   */
  inject?: (deps: string[], callback: (sub: ClientContextLike) => void) => void
}

/**
 * Read an optional service without trusting its presence.
 * @param ctx - client context.
 * @param key - service key.
 * @returns the service, or undefined when the profile does not provide it.
 */
function service<T>(ctx: ClientContextLike, key: string): T | undefined {
  try {
    return ctx.get?.(key) as T | undefined
  } catch {
    return undefined
  }
}


/**
 * Guide-entry glyph: a document with a folded corner and an "L" baseline.
 *
 * The guide draws a generic cube when a type supplies no icon, which reads as
 * "some plugin" rather than "LaTeX". Drawn inline so the bundle pulls in no
 * artwork package and inherits `currentColor`.
 * @param props - sizing from the guide's renderer.
 * @returns the glyph.
 */
function LatexGlyph({ size = 16, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M4 1.75h4.6L12 5.15V14H4z" />
      <path d="M8.6 1.75v3.4H12" />
      <path d="M6.1 8.1v3.2h2.4" />
    </svg>
  )
}

/**
 * Install the client half.
 * @param ctx - client context; every sidebar service is probed rather than
 *   required, so a shell without that plugin still loads this bundle quietly.
 */
export function apply(ctx: ClientContextLike): void {
  const slots = ctx.slots ?? service<SlotsServiceLike>(ctx, 'slots')
  if (!slots) {
    console.warn('[latex-preview] slot service unavailable; preview tab not mounted')
    return
  }

  const api: PreviewApi = new HttpPreviewApi()
  const own: <T>(factory: () => T, label?: string) => T =
    typeof ctx.effect === 'function' ? ctx.effect.bind(ctx) : (factory) => factory()

  /**
   * Open the tab once, when a Session is on screen.
   * `openTab` throws while none is, so the first successful call waits for the
   * sidebar to name one; one attempt per page load keeps a closed tab closed.
   * @param sub - context carrying `sidebarRight`.
   */
  const revealTab = (sub: ClientContextLike): void => {
    const sidebar = sub.get?.('sidebarRight') as SidebarRightLike | undefined
    if (!sidebar) return
    let opened = false
    const attempt = () => {
      if (opened) return
      try {
        sidebar.openTab(KIND)
        opened = true
      } catch {
        // No Session on screen yet; the retry loop or `mounted` will try again.
      }
    }
    own(() => {
      const mounted = sidebar.mounted
      // `openTab` needs an adopted session store, which is minted when a Session
      // is selected — after activation. A short bounded retry covers that gap
      // without polling forever; the `mounted` subscription then handles later
      // session switches.
      let tries = 0
      const timer = window.setInterval(() => {
        tries += 1
        attempt()
        if (opened || tries >= 20) window.clearInterval(timer)
      }, 500)
      attempt()
      const unsubscribe = mounted?.subscribe(attempt)
      return () => {
        window.clearInterval(timer)
        unsubscribe?.()
      }
    }, 'latex-preview: reveal tab')
  }

  /**
   * Stage one: declare the tab type. Without it the strip has no kind to draw.
   * @param sub - context carrying `sidebarRightTabs`.
   */
  const declareType = (sub: ClientContextLike): void => {
    const tabTypes = sub.get?.('sidebarRightTabs') as TabTypesLike | undefined
    if (!tabTypes) return
    own(
      () =>
        tabTypes.register({
          id: ENTRY_ID,
          kind: KIND,
          // Re-rendering the body on every revisit costs a PDF.js load; keeping it
          // mounted preserves scroll position across tab switches instead.
          keepMounted: true,
          title: () => 'LaTeX',
          // Also reachable from the strip's "+" guide page after being closed.
          guide: [
            {
              id: ENTRY_ID,
              order: 40,
              title: () => 'LaTeX 预览',
              description: () => '编译结果、PDF 预览与报错回传',
              icon: LatexGlyph,
            },
          ],
        }),
      'latex-preview: tab type',
    )
    revealTab(sub)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['sidebarRightTabs', 'sidebarRight'], declareType)
  } else {
    declareType(ctx)
  }

  // Stage two: the body and the chip, keyed by the type id.
  own(
    () => slots.inject(TITLE_SLOT, () => slots.register({ name: TITLE_SLOT, key: ENTRY_ID }, () => 'LaTeX')),
    'latex-preview: tab title',
  )
  own(
    () => slots.inject(TAB_SLOT, () => slots.register({ name: TAB_SLOT, key: ENTRY_ID }, () => <LatexPreviewPanel api={api} />)),
    'latex-preview: preview tab',
  )
}
