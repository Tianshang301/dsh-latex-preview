/**
 * Copy the PDF.js runtime and our viewer page into `assets/`.
 *
 * Why a copy instead of a symlink into node_modules: the Host serves `assets/`
 * over HTTP, and the published package must contain those bytes, because
 * pdfjs-dist will not be installed on the user's machine.
 *
 * Layout produced (all under `assets/`):
 *
 *   pdfjs/pdf.mjs              API, sets `globalThis.pdfjsLib` for the viewer
 *   pdfjs/pdf.worker.mjs       parsing worker
 *   pdfjs/pdf_viewer.mjs       viewer components (PDFViewer/PDFLinkService)
 *   pdfjs/pdf_viewer.css       `.page` / layer styles
 *   pdfjs/images/              viewer chrome referenced by the CSS
 *   pdfjs/cmaps/, standard_fonts/   CJK + base-14 substitutes
 *   viewer/{index.html,viewer.js,viewer.css}   our page
 *
 * Run `node scripts/build-assets.mjs`; `prepack` does it automatically.
 *
 * @module dsh-latex-preview/scripts/build-assets
 */

import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const assets = join(root, 'assets')
const pdfjsSrc = join(root, 'node_modules', 'pdfjs-dist')

/** Files copied verbatim from pdfjs-dist, as `[from, to]` pairs. */
const PDFJS_FILES = [
  ['build/pdf.mjs', 'pdfjs/pdf.mjs'],
  ['build/pdf.worker.mjs', 'pdfjs/pdf.worker.mjs'],
  ['web/pdf_viewer.mjs', 'pdfjs/pdf_viewer.mjs'],
  ['web/pdf_viewer.css', 'pdfjs/pdf_viewer.css'],
  ['LICENSE', 'pdfjs/LICENSE'],
]

/** Directories copied recursively from pdfjs-dist. */
const PDFJS_DIRS = [
  ['web/images', 'pdfjs/images'],
  ['cmaps', 'pdfjs/cmaps'],
  ['standard_fonts', 'pdfjs/standard_fonts'],
]

/** Our viewer page. */
const VIEWER_FILES = ['index.html', 'viewer.js', 'viewer.css']

/**
 * Recursively total the byte size of a path.
 * @param {string} target - file or directory.
 * @returns {Promise<number>} bytes.
 */
async function sizeOf(target) {
  const info = await stat(target)
  if (info.isFile()) return info.size
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(target, { withFileTypes: true })
  let total = 0
  for (const entry of entries) total += await sizeOf(join(target, entry.name))
  return total
}

const version = JSON.parse(await readFile(join(pdfjsSrc, 'package.json'), 'utf8')).version

await rm(assets, { recursive: true, force: true })
await mkdir(join(assets, 'pdfjs'), { recursive: true })
await mkdir(join(assets, 'viewer'), { recursive: true })

for (const [from, to] of PDFJS_FILES) {
  const target = join(assets, to)
  await mkdir(dirname(target), { recursive: true })
  await cp(join(pdfjsSrc, from), target)
}

for (const [from, to] of PDFJS_DIRS) {
  await cp(join(pdfjsSrc, from), join(assets, to), { recursive: true })
}

for (const file of VIEWER_FILES) {
  await cp(join(root, 'viewer', file), join(assets, 'viewer', file))
}

// A manifest makes "are the assets current?" answerable without hashing a tree.
await writeFile(
  join(assets, 'manifest.json'),
  `${JSON.stringify({ pdfjs: version, generator: 'scripts/build-assets.mjs', builtAt: new Date().toISOString() }, null, 2)}\n`,
)

const total = await sizeOf(assets)
console.log(`assets built: pdfjs ${version}, ${(total / 1024 / 1024).toFixed(2)} MiB -> ${assets}`)
