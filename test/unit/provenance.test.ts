/**
 * The rule that decides who may name a revision.
 *
 * Kept as its own test file because it is the one place where "the manifest checks
 * out" and "we know what produced these bytes" are deliberately different answers.
 *
 * @module dsh-latex-preview/test/unit/provenance
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { issueTrust, manifestStillDescribes, trustCovers, workspaceIdOf } from '../../src/services/provenance.ts'

const claim = {
  workspaceId: workspaceIdOf('/papers/a/main.tex', '/papers/a/.latex-preview'),
  sourceDigest: 'aaaa1111bbbb',
  pdfSha256: 'pdf-hash',
  synctexSha256: 'sync-hash',
}

test('a workspace id separates projects and output directories', () => {
  const here = workspaceIdOf('/papers/a/main.tex', '/papers/a/.latex-preview')
  assert.equal(here, workspaceIdOf('/papers/a/main.tex', '/papers/a/.latex-preview'), 'stable')
  assert.notEqual(here, workspaceIdOf('/papers/b/main.tex', '/papers/b/.latex-preview'), 'another project')
  assert.notEqual(here, workspaceIdOf('/papers/a/main.tex', '/tmp/out'), 'another output directory')
})

test('a credential authorises exactly the claim it was issued for', () => {
  const trusted = issueTrust(claim)
  assert.equal(trustCovers(trusted, claim), true)
})

test('every field is load-bearing', () => {
  const trusted = issueTrust(claim)
  const variants = [
    { ...claim, workspaceId: workspaceIdOf('/other/main.tex', '/other/.latex-preview') },
    { ...claim, sourceDigest: 'cccc2222dddd' },
    { ...claim, pdfSha256: 'another-pdf' },
    { ...claim, synctexSha256: 'another-sync' },
  ]
  for (const variant of variants) {
    assert.equal(trustCovers(trusted, variant), false, JSON.stringify(variant))
  }
})

test('no credential authorises nothing', () => {
  assert.equal(trustCovers(null, claim), false)
})

test('a pair may keep being shown while its manifest names the revision', () => {
  assert.equal(manifestStillDescribes({ revisionId: 'aaaa1111bbbb' }, 'aaaa1111bbbb'), true)
  assert.equal(manifestStillDescribes({ revisionId: 'cccc2222dddd' }, 'aaaa1111bbbb'), false)
  assert.equal(manifestStillDescribes(null, 'aaaa1111bbbb'), false)
})
