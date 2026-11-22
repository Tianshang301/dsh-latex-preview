/**
 * What a compile read, as a graph.
 *
 * `stable` used to compare the root `.tex` with itself, which is silent about every
 * file the root pulls in. These tests pin the scan that replaces that comparison:
 * which commands count as dependencies, which files are **not** dependencies (the
 * compiler's own output), and how a change is named so the status line can point at
 * the file that moved.
 *
 * Real directories, no mocked `fs`: the interesting failures are all in resolution
 * (`ch` → `ch.tex`, `./ch.tex` → `ch.tex`, a directory that is not a file), and a
 * mock would assert the resolver against itself.
 *
 * @module dsh-latex-preview/test/unit/build-input
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import {
  BUILD_INPUT_LIMITS,
  diffBuildInput,
  sameBuildInput,
  scanBuildInput,
  type BuildInputManifest,
} from '../../src/services/build-input.ts'

/** Build a project tree from a `relative path → contents` map. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-build-input-'))
  for (const [path, contents] of Object.entries(files)) {
    const absolute = join(dir, path)
    mkdirSync(dirname(absolute), { recursive: true })
    writeFileSync(absolute, contents)
  }
  return dir
}

/** A `main.tex` around a body. */
const DOC = (body: string): string =>
  ['\\documentclass{article}', '\\begin{document}', body, '\\end{document}', ''].join('\n')

/** The scanned paths, for readable assertions. */
const pathsOf = (manifest: BuildInputManifest): string[] => manifest.entries.map((entry) => entry.path)

test('an include is a member, with or without its extension, once', async () => {
  const dir = project({
    'main.tex': DOC('\\input{chapters/ch1}\\input{./chapters/ch1.tex}'),
    'chapters/ch1.tex': '\\input{chapters/ch2}',
    'chapters/ch2.tex': 'second',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['chapters/ch1.tex', 'chapters/ch2.tex', 'main.tex'])
    assert.deepEqual(manifest.missing, [])
    assert.deepEqual(manifest.unreadable, [])
    assert.equal(manifest.root, join(dir, 'main.tex'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('two scans of an unchanged tree agree', async () => {
  const dir = project({
    'main.tex': DOC('\\input{ch}\\bibliography{refs}'),
    'ch.tex': 'chapter',
    'refs.bib': '@book{a}',
  })
  try {
    const first = await scanBuildInput(join(dir, 'main.tex'))
    const second = await scanBuildInput(join(dir, 'main.tex'))
    assert.equal(sameBuildInput(first, second), true)
    assert.deepEqual(diffBuildInput(first, second), { moved: false })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a chapter edited between two scans moves the digest and is named', async () => {
  const dir = project({ 'main.tex': DOC('\\input{ch}'), 'ch.tex': 'one' })
  try {
    const before = await scanBuildInput(join(dir, 'main.tex'))
    writeFileSync(join(dir, 'ch.tex'), 'two')
    const after = await scanBuildInput(join(dir, 'main.tex'))
    assert.equal(sameBuildInput(before, after), false)
    const diff = diffBuildInput(before, after)
    assert.equal(diff.moved, true)
    assert.deepEqual(diff.moved ? diff.paths : [], ['ch.tex'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a chapter that appears where the document already named one is a change', async () => {
  const dir = project({ 'main.tex': DOC('\\input{chapters/ch3}') })
  try {
    const before = await scanBuildInput(join(dir, 'main.tex'))
    // Before the file exists the name is recorded as absent; after it exists the same
    // name is an entry, and that swap is what makes creating a chapter visible at all
    // (the root, and therefore the revision it stands for, never changed).
    assert.deepEqual(before.missing, ['chapters/ch3.tex'])
    mkdirSync(join(dir, 'chapters'), { recursive: true })
    writeFileSync(join(dir, 'chapters/ch3.tex'), 'third')
    const after = await scanBuildInput(join(dir, 'main.tex'))
    assert.equal(sameBuildInput(before, after), false)
    assert.deepEqual(pathsOf(after), ['chapters/ch3.tex', 'main.tex'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a name that resolves to a directory is unreadable, not missing, and is symmetric', async () => {
  const dir = project({ 'main.tex': DOC('\\input{chapters}'), 'chapters/ch1.tex': 'x' })
  try {
    const before = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(before.unreadable, ['chapters'])
    assert.deepEqual(before.missing, [])
    // The same unreadable set twice is the same graph: refusing a credential forever
    // because one member is a directory would mean "never stable" for that project.
    assert.equal(sameBuildInput(before, await scanBuildInput(join(dir, 'main.tex'))), true)
    // …but a file of that name appearing beside the directory *is* a change: the
    // resolver now reads a chapter where it previously read a directory.
    writeFileSync(join(dir, 'chapters.tex'), 'now a file')
    const other = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(other.unreadable, [])
    assert.deepEqual(pathsOf(other), ['chapters.tex', 'main.tex'])
    assert.equal(sameBuildInput(before, other), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the compiler’s own output is never a dependency', async () => {
  const dir = project({
    // A table of contents is created by the first run and rewritten by every later
    // one. Counting it would make each compile detect a change and recompile for
    // ever, which is the failure this filter exists to prevent.
    'main.tex': DOC('\\tableofcontents\\input{main.toc}\\input{main.aux}\\input{main.bbl}'),
    'main.toc': '\\contentsline {section}{A}{1}',
    'main.aux': '\\relax',
    'main.bbl': '\\begin{thebibliography}{1}\\end{thebibliography}',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['main.tex'])
    assert.deepEqual(manifest.missing, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('comments, verbatim-ish pipes and macro arguments are not references', async () => {
  const dir = project({
    'main.tex': DOC(
      [
        '% \\input{commented}',
        '50\\% \\input{live}',
        '\\input|"ls"',
        '\\input{\\chapdir/x}',
      ].join('\n'),
    ),
    'live.tex': 'live',
    'commented.tex': 'commented',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['live.tex', 'main.tex'])
    // A macro-valued path is not "missing": it was never resolvable here, and
    // reporting it would put a file that does not exist into the digest.
    assert.deepEqual(manifest.missing, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a multi-line argument, a BOM and CRLF are all read as one document', async () => {
  const dir = project({
    'main.tex': '\uFEFF' + '\r\n\\documentclass{article}\r\n\\input{%\r\n  ch\r\n}\r\n',
    'ch.tex': 'chapter',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['ch.tex', 'main.tex'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('comma lists are split, and only local packages are looked for', async () => {
  const dir = project({
    'main.tex': DOC('\\usepackage{amsmath,mypkg}\\bibliography{one,two}\\bibliographystyle{plain}'),
    'mypkg.sty': '\\ProvidesPackage{mypkg}',
    'one.bib': '@book{a}',
    'two.bib': '@book{b}',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['main.tex', 'mypkg.sty', 'one.bib', 'two.bib'])
    // `amsmath` lives in the TeX distribution, so "not in this project" is the normal
    // answer for a package and must not be reported: every document would carry a
    // permanent list of distribution names. A *local* `mypkg.sty` appearing later is
    // an entry, which the digest already sees.
    assert.deepEqual(manifest.missing, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('\\endinput stops parsing, so what follows is not a member', async () => {
  const dir = project({
    'main.tex': DOC('\\input{ch}'),
    'ch.tex': 'body\n\\endinput\n\\input{never}',
    'never.tex': 'never',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['ch.tex', 'main.tex'])
    assert.deepEqual(manifest.missing, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('\\InputIfFileExists names a member whether or not it exists', async () => {
  const dir = project({
    'main.tex': DOC('\\InputIfFileExists{version}{\\input{version}}{}\\InputIfFileExists{missing}{}{}'),
    'version.tex': 'v1',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['main.tex', 'version.tex'])
    assert.deepEqual(manifest.missing, ['missing.tex'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('\\subimport resolves against its own file while \\import resolves against the root', async () => {
  const dir = project({
    'main.tex': DOC('\\input{sub/a}'),
    'sub/a.tex': '\\subimport{}{b}\\import{}{c}',
    // `\subimport{}{b}` from `sub/a.tex` is `sub/b.tex`; `\import{}{c}` is `c.tex`.
    'sub/b.tex': 'b',
    'c.tex': 'c',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['c.tex', 'main.tex', 'sub/a.tex', 'sub/b.tex'])
    assert.deepEqual(manifest.missing, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('\\includegraphics is resolved through \\graphicspath, and a misplaced one is not "missing" twice', async () => {
  const dir = project({
    'main.tex': DOC('\\graphicspath{{figs/}}\\includegraphics[width=3cm]{plot}\\includegraphics{figs/logo.png}'),
    'figs/plot.png': 'png',
    'figs/logo.png': 'png',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['figs/logo.png', 'figs/plot.png', 'main.tex'])
    assert.deepEqual(manifest.missing, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cycle across chapters terminates', async () => {
  const dir = project({
    'main.tex': DOC('\\input{a}'),
    'a.tex': '\\input{b}',
    'b.tex': '\\input{a}',
  })
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.deepEqual(pathsOf(manifest), ['a.tex', 'b.tex', 'main.tex'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the same bytes hashed twice give the same digest, and one byte moved does not', async () => {
  const dir = project({ 'main.tex': DOC('\\input{ch}'), 'ch.tex': 'alpha' })
  try {
    const before = await scanBuildInput(join(dir, 'main.tex'))
    // Line endings are a real edit, not a cosmetic one: normalising them would hide
    // a CRLF→LF conversion from the digest.
    writeFileSync(join(dir, 'ch.tex'), 'alpha\r\n')
    const after = await scanBuildInput(join(dir, 'main.tex'))
    assert.equal(sameBuildInput(before, after), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a tree larger than the cap is reported as truncated, and truncation is part of the digest', async () => {
  const files: Record<string, string> = { 'main.tex': DOC('') }
  const includes: string[] = []
  for (let index = 0; index < BUILD_INPUT_LIMITS.entries + 8; index += 1) {
    files[`ch/${index}.tex`] = `${index}`
    includes.push(`\\input{ch/${index}}`)
  }
  files['main.tex'] = DOC(includes.join(''))
  const dir = project(files)
  try {
    const manifest = await scanBuildInput(join(dir, 'main.tex'))
    assert.equal(manifest.truncated, true)
    assert.equal(manifest.entries.length, BUILD_INPUT_LIMITS.entries)
    const again = await scanBuildInput(join(dir, 'main.tex'))
    assert.equal(sameBuildInput(manifest, again), true, 'two truncated scans of the same tree agree')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
