/**
 * What a compile actually read, as one comparable value.
 *
 * `stable` used to mean "the root `.tex` was the same before and after the run",
 * which is true of a document with `\input` chapters while a chapter is being
 * rewritten underneath the compiler: the PDF then describes neither the old nor the
 * new document, and the credential is issued anyway. A LaTeX document is a **graph**
 * — the root, everything it pulls in, and the images it places — so the question
 * "did the input move while the compiler held it" has to be asked of the graph.
 *
 * Two decisions shape this module, and both exist because the alternative breaks
 * something worse than the bug:
 *
 * 1. **TeX's own output is never an input.** `\input{main.toc}` and friends name
 *    files the compiler *creates*: absent before the run, present after, and their
 *    contents differ from run to run (page numbers). Counting them would make every
 *    compile "unstable", and the convergence recompile would never stop.
 * 2. **An unreadable file is content, not failure.** If `\input{secret}` is
 *    unreadable both before and after the run, the graph did not move, and refusing
 *    a credential forever would be worse than accepting that one file cannot be
 *    watched. What must not happen is an unreadable file *appearing* mid-run.
 *
 * A failed scan (I/O error, permission) is reported as `null` by the caller and
 * degrades to the old root-only comparison: failing closed here means "no compile is
 * ever stable", which is an infinite recompile loop, not a safety property.
 *
 * @module dsh-latex-preview/services/build-input
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, extname, relative, resolve, sep } from 'node:path'

/** The digest format; bump when the line grammar changes. */
const DIGEST_DOMAIN = 'dsh-build-input/1'

/** More files than this in one project, and the graph is reported as truncated. */
const MAX_ENTRIES = 512

/** Files above this are hashed but not parsed: a 2 GB `.tex` is not a document. */
const MAX_PARSE_BYTES = 4 * 1024 * 1024

/** Bytes inspected for a NUL, to avoid parsing a binary that was named `.tex`. */
const SNIFF_BYTES = 4096

/**
 * Extensions the **compiler** writes into the output directory.
 *
 * Only `\input`-style commands are filtered by this list. `\includegraphics` is not:
 * a figure is legitimately a `.pdf`, and that is also the name of the compile's own
 * output — the command is what tells them apart, not the extension.
 */
const GENERATED_EXTENSIONS = new Set([
  '.aux',
  '.toc',
  '.lof',
  '.lot',
  '.out',
  '.bbl',
  '.blg',
  '.idx',
  '.ind',
  '.ilg',
  '.nav',
  '.snm',
  '.vrb',
  '.fls',
  '.fdb_latexmk',
  '.log',
  '.pdf',
  '.synctex.gz',
  '.xdv',
  '.dvi',
])

/** Extensions `\includegraphics` may resolve to, in the order LaTeX tries them. */
const GRAPHICS_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.svg']

/** One file the compile read. */
export interface BuildInputEntry {
  /** Path relative to the root file's directory, `/`-separated. */
  readonly path: string
  /** sha256 of the raw bytes — no newline normalisation, no BOM stripping. */
  readonly sha256: string
}

/** The graph one compile read, and everything that was *named* but not read. */
export interface BuildInputManifest {
  /** Absolute root `.tex`, as `resolve()`d. Also present in `entries`. */
  readonly root: string
  /** sha256 over the canonical line set; see {@link digestOf}. */
  readonly digest: string
  readonly entries: readonly BuildInputEntry[]
  /** Named by the document, confirmed absent (after extension inference). */
  readonly missing: readonly string[]
  /** Present but not readable: a directory, or a permission/IO error. */
  readonly unreadable: readonly string[]
  /** The entry cap was hit; later files are not represented. */
  readonly truncated: boolean
}

/** Options for {@link scanBuildInput}. */
export interface ScanOptions {
  /**
   * The compile's output directory, tried as a second base for `\input`-style paths.
   *
   * Tectonic is spawned with `cwd = outDir`, so a document that works may in
   * principle resolve relative to either. Trying both is an over-approximation: it
   * can only make `stable` stricter, never issue a credential for an unseen file.
   */
  readonly outDir?: string
}

/**
 * Scan the input graph rooted at one `.tex` file.
 * @param rootFile - absolute (or cwd-relative) root `.tex`.
 * @param options - see {@link ScanOptions}.
 * @returns the manifest; never throws for a missing/unreadable member file.
 */
export async function scanBuildInput(rootFile: string, options: ScanOptions = {}): Promise<BuildInputManifest> {
  const root = resolve(rootFile)
  const rootDir = dirname(root)
  const outDir = options.outDir === undefined ? null : resolve(options.outDir)
  const entries = new Map<string, string>()
  const missing = new Set<string>()
  const unreadable = new Set<string>()
  const visited = new Set<string>()
  let truncated = false

  const relOf = (abs: string): string => relative(rootDir, abs).split(sep).join('/')

  const queue: { readonly file: string; readonly parse: boolean }[] = [{ file: root, parse: true }]
  while (queue.length > 0) {
    const next = queue.shift()
    if (next === undefined) break
    let real: string
    try {
      real = await realpath(next.file)
    } catch {
      unreadable.add(relOf(next.file))
      continue
    }
    // `realpath` is the identity: `./ch.tex` and `ch.tex` are one file, and a
    // directory symlink cycle terminates instead of expanding forever.
    if (visited.has(real)) continue
    visited.add(real)
    if (entries.size >= MAX_ENTRIES) {
      truncated = true
      break
    }

    let bytes: Buffer
    try {
      bytes = await readFile(real)
    } catch {
      unreadable.add(relOf(next.file))
      continue
    }
    entries.set(relOf(next.file), createHash('sha256').update(bytes).digest('hex'))

    if (!next.parse || bytes.length > MAX_PARSE_BYTES) continue
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) continue
    const text = stripComments(stripBom(bytes.toString('utf8')))
    for (const reference of referencesIn(text, dirname(next.file), rootDir, outDir)) {
      if (reference.kind === 'source' && GENERATED_EXTENSIONS.has(extensionOf(reference.raw))) continue
      const found = await locate(reference)
      if (found.kind === 'file') {
        queue.push({ file: found.abs, parse: reference.kind === 'source' })
        continue
      }
      const key = relOf(found.abs)
      if (found.kind === 'missing') {
        // A package, class or bst that is not in the project lives in the TeX
        // distribution, so "absent here" is the normal case and says nothing about
        // this document. A *local* one that appears is an entry, which the digest
        // already sees; recording every `article.cls` would only add noise.
        if (reference.kind !== 'optional') missing.add(key)
      } else {
        unreadable.add(key)
      }
    }
  }

  const manifest: Omit<BuildInputManifest, 'digest'> = {
    root,
    entries: [...entries]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    missing: [...missing].sort(),
    unreadable: [...unreadable].sort(),
    truncated,
  }
  return { ...manifest, digest: digestOf(manifest) }
}

/**
 * Whether two scans describe the same graph.
 *
 * `digest` covers `entries`, `missing`, `unreadable` and `truncated` alike, so this
 * is the whole comparison: a chapter that appeared, a chapter that lost its read
 * permission and a file whose bytes changed are one kind of event each, and all
 * three move the digest.
 * @param a - the scan taken before the compile.
 * @param b - the scan taken after it.
 * @returns true only for the same root and the same graph.
 */
export function sameBuildInput(a: BuildInputManifest, b: BuildInputManifest): boolean {
  return a.root === b.root && a.digest === b.digest
}

/** What moved between two scans, for the status line. */
export type InputDiff =
  | { readonly moved: false }
  | { readonly moved: true; readonly paths: readonly string[]; readonly more: number }

/** How many moved paths the status line names before it says "and N more". */
const MAX_REPORTED = 4

/**
 * Name the members that changed between two scans.
 *
 * Compared per path rather than by digest alone so the status line can say *which*
 * chapter moved — a message that only says "the input changed" sends the reader
 * looking at the wrong file.
 * @param before - the pre-compile scan.
 * @param after - the post-compile scan.
 * @returns the moved paths, capped.
 */
export function diffBuildInput(before: BuildInputManifest, after: BuildInputManifest): InputDiff {
  if (sameBuildInput(before, after)) return { moved: false }
  const stateOf = (manifest: BuildInputManifest): Map<string, string> => {
    const map = new Map<string, string>()
    for (const entry of manifest.entries) map.set(entry.path, `f:${entry.sha256}`)
    for (const path of manifest.missing) map.set(path, 'm')
    for (const path of manifest.unreadable) map.set(path, 'u')
    if (manifest.truncated) map.set('\u0000truncated', 't')
    return map
  }
  const left = stateOf(before)
  const right = stateOf(after)
  const moved = [...new Set([...left.keys(), ...right.keys()])]
    .filter((path) => left.get(path) !== right.get(path))
    .map((path) => path.replace(/^\u0000truncated$/, '(truncated)'))
    .sort()
  return {
    moved: true,
    paths: moved.slice(0, MAX_REPORTED),
    more: Math.max(0, moved.length - MAX_REPORTED),
  }
}

/**
 * The digest line set, in one place so the format is readable.
 *
 * Named-but-absent members are part of it so the digest describes the whole graph
 * rather than only the files it managed to hash: a chapter that appears turns its
 * `m` line into an `f` line, and a directory that shadows a chapter turns its `m`
 * line into a `u` line. Both are changes to what the compiler will read.
 */
function digestOf(manifest: Omit<BuildInputManifest, 'digest'>): string {
  const lines = [
    ...manifest.entries.map((entry) => `f\u0000${entry.path}\u0000${entry.sha256}`),
    ...manifest.missing.map((path) => `m\u0000${path}`),
    ...manifest.unreadable.map((path) => `u\u0000${path}`),
  ]
  // Sorted *before* hashing: two scans of the same tree visit files in whatever
  // order the queue produced, and the digest must not depend on that.
  lines.sort()
  if (manifest.truncated) lines.push('t')
  return createHash('sha256').update(`${DIGEST_DOMAIN}\u0000${manifest.root}\u0000${lines.join('\n')}`).digest('hex')
}

/** What a command asked for, before the filesystem has an opinion. */
interface Reference {
  /** The argument as written (first candidate, extension already inferred). */
  readonly raw: string
  /** Bases to try, in order. */
  readonly bases: readonly string[]
  /** Extensions to append when the name has none. */
  readonly extensions: readonly string[]
  /** `source` paths are filtered for compiler output; `graphics` ones are not. */
  readonly kind: 'source' | 'graphics' | 'optional'
}

/**
 * Resolve one reference against the filesystem.
 * @param reference - the parsed command argument.
 * @returns the file that exists, or why nothing did.
 */
async function locate(reference: Reference): Promise<{ readonly kind: 'file' | 'dir' | 'error' | 'missing'; readonly abs: string }> {
  const firstBase = reference.bases[0] ?? ''
  // The name a missing member is *reported* under: the first base plus the inferred
  // extension. Reporting the last base tried would name `.latex-preview/ch.tex` for
  // a chapter that simply does not exist.
  const canonical =
    reference.extensions.length > 0
      ? `${joinBase(firstBase, reference.raw)}${reference.extensions[0] ?? ''}`
      : joinBase(firstBase, reference.raw)
  let sawError = false
  let sawDir = false
  let problem = canonical
  for (const base of reference.bases) {
    const first = joinBase(base, reference.raw)
    const candidates =
      reference.extensions.length > 0 ? [first, ...reference.extensions.map((extension) => `${first}${extension}`)] : [first]
    for (const candidate of distinct(candidates)) {
      const observation = await probe(candidate)
      if (observation === 'file') return { kind: 'file', abs: candidate }
      // Report the name that actually explained the failure — a directory called
      // `chapters` says more than the `chapters.tex` that was never there.
      if (observation === 'dir') {
        sawDir = true
        problem = candidate
      }
      if (observation === 'error') {
        sawError = true
        problem = candidate
      }
    }
  }
  // A directory is *present* but not readable as a file; an IO error is not proof of
  // absence either. Both are "unreadable", which is content rather than failure.
  return { kind: sawError ? 'error' : sawDir ? 'dir' : 'missing', abs: problem }
}

/** `stat` one candidate, without distinguishing the many ways it can fail. */
async function probe(abs: string): Promise<'file' | 'dir' | 'missing' | 'error'> {
  try {
    const info = await stat(abs)
    return info.isFile() ? 'file' : 'dir'
  } catch (error) {
    return isMissing(error) ? 'missing' : 'error'
  }
}

/** Whether a `stat` failure means "no such file" rather than "cannot look". */
function isMissing(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Join a base with a possibly `/`-separated relative name. */
function joinBase(base: string, name: string): string {
  return resolve(base, name.split('/').join(sep))
}

/** De-duplicate while keeping order. */
function distinct(values: readonly string[]): readonly string[] {
  return [...new Set(values)]
}

/** The extension a file claims, with the one double-suffixed case handled. */
function extensionOf(name: string): string {
  if (name.toLowerCase().endsWith('.synctex.gz')) return '.synctex.gz'
  return extname(name).toLowerCase()
}

/** Drop a leading BOM so the first `\documentclass` is still the first line. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Remove `%` comments, keeping the line structure.
 *
 * A character walk, not a regex: `\%` is a literal percent and `\\%` is a line break
 * followed by a comment, so the decision is "how many backslashes immediately before
 * this `%`" — which is exactly what a lookbehind cannot express.
 * @param text - source with comments.
 * @returns the same text with comments removed and `\n` preserved.
 */
function stripComments(text: string): string {
  let out = ''
  let backslashes = 0
  let inComment = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char === '\n') {
      inComment = false
      backslashes = 0
      out += char
      continue
    }
    if (inComment) continue
    if (char === '%' && backslashes % 2 === 0) {
      inComment = true
      continue
    }
    backslashes = char === '\\' ? backslashes + 1 : 0
    out += char
  }
  return out
}

/** `\input{...}`, one argument. */
const INCLUDE_RE = /\\(input|include|subfile|InputIfFileExists)\s*\*?\s*\{([^}]*)\}/g
/** `\import{dir}{name}` and its five relatives: two arguments. */
const IMPORT_RE = /\\(import|subimport|inputfrom|subinputfrom|includefrom|subincludefrom)\s*\*?\s*\{([^}]*)\}\s*\{([^}]*)\}/g
/** `\bibliography{a,b}`. */
const BIBLIOGRAPHY_RE = /\\bibliography\s*\{([^}]*)\}/g
/** `\addbibresource[opts]{name.bib}`. */
const ADDBIB_RE = /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
/** `\bibliographystyle{plain}` — a local `.bst` is editable too. */
const BIBSTYLE_RE = /\\bibliographystyle\s*\{([^}]*)\}/g
/** `\usepackage[opts]{a,b}` and `\RequirePackage{p}`. */
const PACKAGE_RE = /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
/** `\documentclass[opts]{article}`. */
const CLASS_RE = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
/** `\includegraphics*[opts]{name}`. */
const GRAPHICS_RE = /\\includegraphics\s*\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g
/** `\graphicspath{{figs/}{../fig/}}`. */
const GRAPHICSPATH_RE = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/g

/**
 * Every member the document names, as resolvable references.
 *
 * Deliberately an over-approximation in three places, each for a reason: `verbatim`
 * bodies are not skipped (a fake `\input` costs one hash), `\includeonly` is not
 * honoured (scanning an unused chapter can only make the check stricter), and a
 * macro-valued argument is dropped rather than guessed.
 * @param text - source with comments already stripped.
 * @param currentDir - directory of the file being parsed, for `\subimport`.
 * @param rootDir - the main file's directory; most commands resolve here.
 * @param outDir - second base for `\input`, or null.
 * @returns the references, in document order.
 */
function referencesIn(text: string, currentDir: string, rootDir: string, outDir: string | null): Reference[] {
  // `\endinput` ends the file as far as TeX is concerned; anything after it is not
  // read, so treating it as an input would add a file the compiler never opened.
  const end = text.indexOf('\\endinput')
  const body = end === -1 ? text : text.slice(0, end)
  const bases = distinct(outDir === null ? [rootDir] : [rootDir, outDir])
  const graphicsPaths = graphicsSearchPaths(body)
  const references: Reference[] = []

  const push = (raw: string, kind: Reference['kind'], base: readonly string[], extensions: readonly string[]): void => {
    const name = raw.trim()
    // A path built from a macro (`\chapdir/x`) or a TeX parameter (`#1`) cannot be
    // resolved here. Guessing would report a file that does not exist as missing,
    // and a wrong digest is worse than a smaller one.
    if (name === '' || /[\\#{}]/.test(name)) return
    references.push({ raw: name, bases: base, extensions, kind })
  }

  for (const match of body.matchAll(INCLUDE_RE)) {
    push(match[2] ?? '', 'source', bases, ['.tex'])
  }
  for (const match of body.matchAll(IMPORT_RE)) {
    const command = match[1] ?? ''
    // `\subimport` is relative to the *including* file; `\import` to the main one.
    const base = command.startsWith('sub') ? [currentDir] : [rootDir]
    const directory = (match[2] ?? '').trim()
    const name = (match[3] ?? '').trim()
    if (/[\\#{}]/.test(directory)) continue
    push(directory === '' ? name : `${directory.replace(/\/+$/, '')}/${name}`, 'source', base, ['.tex'])
  }
  for (const match of body.matchAll(BIBLIOGRAPHY_RE)) {
    for (const name of splitList(match[1] ?? '')) push(name, 'source', bases, ['.bib'])
  }
  for (const match of body.matchAll(ADDBIB_RE)) {
    for (const name of splitList(match[1] ?? '')) {
      // `*.bib` is a glob resolved by biblatex; there is no single file to hash.
      if (name.includes('*')) continue
      push(name, 'source', bases, ['.bib'])
    }
  }
  for (const match of body.matchAll(BIBSTYLE_RE)) {
    for (const name of splitList(match[1] ?? '')) push(name, 'optional', bases, ['.bst'])
  }
  for (const match of body.matchAll(PACKAGE_RE)) {
    // A comma list is the common form and the easiest one to get wrong: only the
    // first name of `\usepackage{amsmath,amssymb}` is a package the author may
    // have vendored, and the second is just as likely to be local.
    for (const name of splitList(match[1] ?? '')) push(name, 'optional', bases, ['.sty'])
  }
  for (const match of body.matchAll(CLASS_RE)) {
    push(match[1] ?? '', 'optional', bases, ['.cls'])
  }
  for (const match of body.matchAll(GRAPHICS_RE)) {
    const name = (match[1] ?? '').trim()
    if (name === '' || /[\\#{}]/.test(name)) continue
    // `\graphicspath` is a search list, not a set of independent references: a figure
    // found under one prefix must not also be reported missing under the others, so
    // every prefix becomes a base of **one** reference, with the document's own
    // directory last — LaTeX tries the declared prefixes first, then the file as written.
    const bases = distinct([...graphicsPaths.map((prefix) => joinBase(rootDir, prefix)), rootDir])
    push(name, 'graphics', bases, hasExtension(name) ? [] : GRAPHICS_EXTENSIONS)
  }
  return references
}

/**
 * `\graphicspath` entries, in declaration order, as `prefix/`-terminated strings.
 * @param body - source with comments stripped.
 * @returns the prefixes, always ending in `/`, or `['']` when there is no directive.
 */
function graphicsSearchPaths(body: string): string[] {
  const prefixes: string[] = []
  for (const match of body.matchAll(GRAPHICSPATH_RE)) {
    for (const inner of (match[1] ?? '').matchAll(/\{([^}]*)\}/g)) {
      const prefix = (inner[1] ?? '').trim()
      if (prefix === '') continue
      prefixes.push(prefix.endsWith('/') ? prefix : `${prefix}/`)
    }
  }
  return prefixes.length > 0 ? prefixes : ['']
}

/** Split a comma list, trimming blanks. */
function splitList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
}

/** Whether a name already carries an extension (a dot in its last segment). */
function hasExtension(name: string): boolean {
  return extname(name) !== ''
}

/** Exposed so tests can assert the cap without opening 512 files. */
export const BUILD_INPUT_LIMITS = { entries: MAX_ENTRIES, parseBytes: MAX_PARSE_BYTES } as const
