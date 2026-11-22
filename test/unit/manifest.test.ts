/**
 * The manifest is the part of the plugin the harness reads before any of this code
 * runs, and it fails silently when it is wrong: a missing `dsh` block means the
 * package is never composed into a profile, a stale `engines.dsh` means the launcher
 * refuses it with a version error nobody can act on, and an import of a package that
 * is neither a dependency nor a peer crashes at load time in the host process.
 *
 * None of that is reachable from unit tests of the service, so it is asserted here
 * against the real `package.json` and the real installed versions.
 *
 * @module dsh-latex-preview/test/unit/manifest
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

interface Manifest {
  readonly name: string
  readonly version: string
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly engines?: Record<string, string>
  readonly dsh?: {
    readonly manifestVersion?: number
    readonly bundle?: { readonly patch?: string | string[] }
    readonly client?: { readonly platform?: string; readonly inject?: readonly string[] }
  }
}

const manifest: Manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

/** Version of one installed `@deepseek-ai` package. */
function installed(pkg: string): string {
  const path = join(ROOT, 'node_modules', '@deepseek-ai', pkg, 'package.json')
  assert.equal(existsSync(path), true, `${pkg} is not installed; run pnpm install`)
  return (JSON.parse(readFileSync(path, 'utf8')) as { version: string }).version
}

/** Every `@deepseek-ai/*` specifier imported from the source tree. */
function importedPackages(dir: string, found = new Set<string>()): Set<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      importedPackages(path, found)
      continue
    }
    if (!/\.(?:ts|tsx)$/.test(entry)) continue
    for (const match of readFileSync(path, 'utf8').matchAll(/from\s+'(@deepseek-ai\/[^']+)'/g)) {
      found.add((match[1] as string).split('/').slice(0, 2).join('/'))
    }
  }
  return found
}

test('the manifest declares its format, its bundle and its client half', () => {
  assert.equal(manifest.dsh?.manifestVersion, 1, 'manifest format 1')
  const patch = manifest.dsh?.bundle?.patch
  assert.equal(typeof patch, 'string', 'one patch file')
  assert.equal(existsSync(join(ROOT, patch as string)), true, `${String(patch)} exists`)
  assert.equal(manifest.dsh?.client?.platform, 'web')
  // The client half mounts into the right sidebar, which it reaches through the slot
  // service; declaring it keeps the loader's module table consistent with the entry's
  // own `inject` export.
  assert.deepEqual(manifest.dsh?.client?.inject, ['slots'])
})

test('the declared DSH range covers the versions actually installed', () => {
  const range = manifest.engines?.dsh
  assert.equal(typeof range, 'string', 'engines.dsh is what the launcher checks')
  // `^0.2.2-rc.5` is `>=0.2.2-rc.5 <0.3.0`: it accepts later release candidates of
  // this patch and the 0.2.2 release, and refuses a different minor — which is the
  // honest claim, because the Typert and slot contracts are what we compile against.
  const expected = /^\^(\d+\.\d+\.\d+)-rc\.\d+$/.exec(range as string)
  assert.ok(expected, `unexpected range ${String(range)}`)
  const tuple = expected[1] as string
  for (const pkg of ['dsh-typert-protocol', 'dsh-llm']) {
    const version = installed(pkg)
    assert.equal(version.startsWith(`${tuple}-`), true, `${pkg}@${version} is inside ${String(range)}`)
  }
  // The peer range must agree with the engine range, or an install resolves one
  // version and the launcher is told another is acceptable.
  assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh-llm'], `^${tuple}-rc.5`)
})

test('every @deepseek-ai package the source imports is declared', () => {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ])
  for (const pkg of importedPackages(join(ROOT, 'src'))) {
    assert.equal(declared.has(pkg), true, `${pkg} is imported but not declared in package.json`)
  }
})
