/**
 * Revision semantics: accepted vs previous compile vs current.
 *
 * These pin the two diff paths apart, because the failure mode is subtle: in `open`
 * mode both baselines always agree, so a bug that conflates them looks fine until
 * someone switches to 手动审核 and the second compile quietly moves the wrong one.
 *
 * @module dsh-latex-preview/test/unit/revisions
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  acceptCurrent,
  advanceRevisions,
  diffBaseFor,
  hasPendingChanges,
  initialRevisions,
  parseDiffSide,
} from '../../src/services/revisions.ts'

test('a fresh workspace has a current revision and no previous compile', () => {
  const revisions = initialRevisions('A')
  assert.deepEqual(revisions, { accepted: 'A', previousCompile: null, current: 'A' })
  assert.equal(hasPendingChanges(revisions), false)
})

test('manual review advances the previous compile but not the accepted revision', () => {
  const first = advanceRevisions(initialRevisions('A'), 'B', 'manual')
  assert.equal(first.changed, true)
  assert.deepEqual(first.revisions, { accepted: 'A', previousCompile: 'A', current: 'B' })
  assert.equal(diffBaseFor(first.revisions, 'new'), 'A', 'path A still compares against A')
  assert.equal(diffBaseFor(first.revisions, 'compile'), 'A', 'and B happens to agree once')
  assert.equal(hasPendingChanges(first.revisions), true)

  const second = advanceRevisions(first.revisions, 'C', 'manual')
  assert.deepEqual(second.revisions, { accepted: 'A', previousCompile: 'B', current: 'C' })
  assert.equal(diffBaseFor(second.revisions, 'new'), 'A', 'path A accumulates review debt')
  assert.equal(diffBaseFor(second.revisions, 'compile'), 'B', 'path B is only ever one compile back')
})

test('accepting catches the accepted revision up to the current one', () => {
  const pending = advanceRevisions(initialRevisions('A'), 'B', 'manual').revisions
  const accepted = acceptCurrent(pending)
  assert.deepEqual(accepted, { accepted: 'B', previousCompile: 'A', current: 'B' })
  assert.equal(hasPendingChanges(accepted), false)
  assert.equal(diffBaseFor(accepted, 'new'), 'B')
})

test('open mode moves both baselines on every compile', () => {
  let revisions = initialRevisions('A')
  const first = advanceRevisions(revisions, 'B', 'open')
  revisions = first.revisions
  const second = advanceRevisions(revisions, 'C', 'open')

  assert.deepEqual(second.revisions, { accepted: 'B', previousCompile: 'B', current: 'C' })
  assert.equal(diffBaseFor(second.revisions, 'new'), diffBaseFor(second.revisions, 'compile'))
})

test('auto review leaves the accepted revision alone until a verdict arrives', () => {
  const pending = advanceRevisions(initialRevisions('A'), 'B', 'auto')
  assert.equal(pending.revisions.accepted, 'A', 'the reviewer decides, not the compile')
  assert.equal(acceptCurrent(pending.revisions).accepted, 'B')
})

test('a redundant compile advances nothing', () => {
  const revisions = advanceRevisions(initialRevisions('A'), 'B', 'manual').revisions
  const again = advanceRevisions(revisions, 'B', 'manual')
  assert.equal(again.changed, false)
  assert.equal(again.revisions, revisions, 'the same object comes back, so nothing downstream moves')
})

test('the accepted revision still follows the current one in manual mode', () => {
  // 撤销 writes the accepted revision back to disk and recompiles, so the compile
  // that follows sees the accepted content as `current` again.
  const pending = advanceRevisions(initialRevisions('A'), 'B', 'manual').revisions
  const reverted = acceptCurrent({ ...pending, current: 'A' })
  assert.deepEqual(reverted, { accepted: 'A', previousCompile: 'A', current: 'A' })
  assert.equal(hasPendingChanges(reverted), false)
})

test('an unconfigured workspace has no diff base at all', () => {
  const revisions = initialRevisions(null)
  assert.equal(diffBaseFor(revisions, 'new'), null)
  assert.equal(diffBaseFor(revisions, 'compile'), null)
  assert.equal(hasPendingChanges(revisions), false)
})

test('an unknown or missing side falls back to new, but compile survives', () => {
  assert.equal(parseDiffSide('compile'), 'compile', 'this is the case a stale route used to eat')
  assert.equal(parseDiffSide('base'), 'base')
  assert.equal(parseDiffSide('new'), 'new')
  assert.equal(parseDiffSide(undefined), 'new')
  assert.equal(parseDiffSide(null), 'new')
  assert.equal(parseDiffSide('bogus'), 'new')
})
