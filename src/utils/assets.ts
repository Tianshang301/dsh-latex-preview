/**
 * Where the bundled PDF.js assets live on disk.
 *
 * Resolved from this module's own URL, not from `process.cwd()`: the Host may be
 * started anywhere, and the assets ship inside the package (see
 * `scripts/build-assets.mjs`). `import.meta.url` points at `lib/utils/assets.js`
 * when built, so the plugin root is two levels up.
 *
 * @module dsh-latex-preview/utils/assets
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Absolute path of the plugin package root. */
export function pluginRoot(): string {
  return fileURLToPath(new URL('../../', import.meta.url)).replace(/[\\/]+$/, '')
}

/** Absolute path of the generated assets directory. */
export function assetsRoot(): string {
  return join(pluginRoot(), 'assets')
}

/** URL path of the viewer page, relative to the static route prefix. */
export const VIEWER_PATH = '/assets/viewer/index.html'

/**
 * Whether the viewer page is actually on disk.
 *
 * Missing assets are a packaging problem, not a runtime one: the panel falls back
 * to the browser's built-in PDF viewer, so this must be a probe, never a throw.
 * @returns true when `assets/viewer/index.html` exists.
 */
export function viewerAvailable(): boolean {
  return existsSync(join(assetsRoot(), 'viewer', 'index.html'))
}
