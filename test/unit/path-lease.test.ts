/**
 * The lease lock's semantics, pinned before the service relies on them.
 *
 * Three invariants matter, each one a bug class this module exists to close:
 *
 * - **Writers exclude everything; readers exclude only writers.** Two diff builds
 *   reading the live PDF at once is normal; a restore deleting it under a reader is
 *   the bug.
 * - **FIFO with writer preference.** A writer waiting on a key must not be starved by
 *   readers that keep arriving — a reader arriving *behind* a waiting writer waits too,
 *   and the writer goes first. Readers directly behind a granted reader proceed
 *   together.
 * - **Release is exactly-once in effect.** Holders release from `finally`, and a
 *   `finally` can run twice around an error path; the second call must be a no-op.
 *
 * @module dsh-latex-preview/test/unit/path-lease
 */

import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import { LeaseDisposedError, PathLeaseRegistry } from '../../src/services/path-lease.ts'

test('readers coexist and writers exclude everything', async () => {
  const registry = new PathLeaseRegistry()
  const readerA = await registry.acquire('main.pdf', 'read')
  const readerB = await registry.acquire('main.pdf', 'read')
  assert.ok(readerA && readerB, 'two readers hold the same path at once')

  let writeGranted = false
  const writing = registry.acquire('main.pdf', 'write').then((ticket) => {
    writeGranted = true
    return ticket
  })
  await delay(20)
  assert.equal(writeGranted, false, 'a writer waits for both readers')

  readerA.release()
  await delay(20)
  assert.equal(writeGranted, false, 'and for the last one')

  readerB.release()
  const writer = await writing
  assert.equal(writeGranted, true)

  let readGranted = false
  const reading = registry.acquire('main.pdf', 'read').then((ticket) => {
    readGranted = true
    return ticket
  })
  await delay(20)
  assert.equal(readGranted, false, 'a reader waits for the active writer')

  writer.release()
  await reading
  assert.equal(readGranted, true)
})

test('a waiting writer blocks readers that arrive after it', async () => {
  const registry = new PathLeaseRegistry()
  const reader = await registry.acquire('main.pdf', 'read')

  const writerWaiter = registry.acquire('main.pdf', 'write')
  let writerGranted = false
  void writerWaiter.then((ticket) => {
    writerGranted = true
    return ticket
  })
  await delay(20)
  assert.equal(writerGranted, false, 'writer waits for the reader')

  // Arrives *behind* the waiting writer: it must not jump the queue.
  let lateReaderGranted = false
  const lateReader = registry.acquire('main.pdf', 'read').then((ticket) => {
    lateReaderGranted = true
    return ticket
  })
  await delay(20)
  assert.equal(lateReaderGranted, false, 'a reader behind a waiting writer waits too')

  reader.release()
  const writer = await writerWaiter
  assert.equal(writerGranted, true)
  await delay(20)
  assert.equal(lateReaderGranted, false, 'and still waits for the writer')

  writer.release()
  await lateReader
  assert.equal(lateReaderGranted, true)
})

test('readers behind a granted reader proceed together', async () => {
  const registry = new PathLeaseRegistry()
  const first = await registry.acquire('main.pdf', 'read')

  const second = registry.acquire('main.pdf', 'read')
  const third = registry.acquire('main.pdf', 'read')
  const secondTicket = await second
  const thirdTicket = await third
  assert.ok(secondTicket && thirdTicket, 'both readers granted without waiting for the first to finish')

  first.release()
  secondTicket.release()
  thirdTicket.release()
})

test('release wakes waiters in arrival order', async () => {
  const registry = new PathLeaseRegistry()
  const gate = await registry.acquire('main.pdf', 'write')
  const order: string[] = []

  const a = registry.acquire('main.pdf', 'read').then((ticket) => {
    order.push('a')
    return ticket
  })
  const b = registry.acquire('main.pdf', 'write').then((ticket) => {
    order.push('b')
    return ticket
  })
  const c = registry.acquire('main.pdf', 'read').then((ticket) => {
    order.push('c')
    return ticket
  })
  await delay(20)
  assert.deepEqual(order, [], 'nothing granted while the writer holds the key')

  gate.release()
  // The grant cascades: `a` is granted immediately, `b` only when `a` is put down, and
  // `c` only when `b` is — releasing out of order would deadlock the test, not the lock.
  const ticketA = await a
  ticketA.release()
  const ticketB = await b
  ticketB.release()
  const ticketC = await c
  assert.deepEqual(order, ['a', 'b', 'c'], 'FIFO: a (reader), b (writer), c (reader)')

  ticketC.release()
})

test('release is idempotent and double release frees the key exactly once', async () => {
  const registry = new PathLeaseRegistry()
  const ticket = await registry.acquire('main.pdf', 'write')
  ticket.release()
  assert.doesNotThrow(() => ticket.release(), 'a second release must not throw')

  const next = await registry.acquire('main.pdf', 'write')
  assert.ok(next, 'the key was freed by the first release only')
  next.release()
})

test('dispose rejects pending waiters and future acquisitions', async () => {
  const registry = new PathLeaseRegistry()
  const holder = await registry.acquire('main.pdf', 'write')
  const waiting = registry.acquire('main.pdf', 'read')

  registry.dispose('service unloading')
  await assert.rejects(waiting, LeaseDisposedError, 'a pending waiter is denied')
  await assert.rejects(registry.acquire('main.pdf', 'read'), LeaseDisposedError, 'so is a future one')

  // A holder that was already inside its I/O can still put the ticket down.
  assert.doesNotThrow(() => holder.release())
})
