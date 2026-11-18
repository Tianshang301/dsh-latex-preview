/**
 * A FIFO reader-writer lock over named paths.
 *
 * The service-level lease registry answers "are these paths spoken for"; this class
 * answers the harder half — *wait* until they are free, in a fair order. It exists
 * because the two halves of the conflict are not symmetric in the service: writers
 * (compile, restore, publish) already run inside the lifecycle queue and serialise
 * against each other, but a diff build reads the live pair for up to two minutes
 * *outside* that queue. Before this lock, a writer that met a reader was **refused**
 * (`artifact-busy`) and a reader that met a writer read whatever bytes were mid-flight;
 * both sides now wait instead.
 *
 * Semantics, kept deliberately boring:
 *
 * - **FIFO**: waiters are granted in arrival order, so a waiting writer blocks readers
 *   that arrive after it (no writer starvation), and readers directly behind a granted
 *   reader proceed together (reads stay concurrent).
 * - **Idempotent release**: every holder releases from a `finally`, and a `finally`
 *   can run twice around an error path.
 * - **`dispose`**: the service is going away; pending waiters are rejected so nothing
 *   hangs on a lock nobody will release, and further acquisitions fail fast. Held
 *   tickets stay releasable — their holders are already inside their I/O.
 *
 * @module dsh-latex-preview/services/path-lease
 */

/** What a holder does with the path set. */
export type LeaseMode = 'read' | 'write'

/** A granted claim; release exactly once (the second call is a no-op). */
export interface LeaseTicket {
  readonly key: string
  readonly mode: LeaseMode
  release(): void
}

interface Waiter {
  readonly mode: LeaseMode
  readonly owner: symbol
  grant(): void
  deny(error: Error): void
}

interface LockState {
  /** Granted writer, if any — at most one per key. */
  writer: symbol | null
  /** Granted readers; any number while no writer is active. */
  readers: Set<symbol>
  /** Arrival order is the grant order. */
  queue: Waiter[]
}

/** Why `acquire` can reject; carries the disposed reason to pending waiters. */
export class LeaseDisposedError extends Error {
  constructor(message = 'path lease registry is disposed') {
    super(message)
    this.name = 'LeaseDisposedError'
  }
}

export class PathLeaseRegistry {
  private readonly locks = new Map<string, LockState>()
  private disposed = false

  /**
   * Take a claim on `key`, waiting until the mode is compatible with every active
   * holder and every earlier waiter.
   * @param key - the claimed path set (the resolved PDF path in this service).
   * @param mode - readers coexist; nothing coexists with a writer.
   * @returns a ticket whose `release` must be called once, from a `finally`.
   */
  async acquire(key: string, mode: LeaseMode): Promise<LeaseTicket> {
    if (this.disposed) throw new LeaseDisposedError()
    const state = this.locks.get(key) ?? { writer: null, readers: new Set<symbol>(), queue: [] }
    this.locks.set(key, state)

    const owner = Symbol('path-lease')
    const ticket: LeaseTicket = {
      key,
      mode,
      release: () => {
        if (ticketReleased) return
        ticketReleased = true
        this.release(state, owner, mode)
      },
    }
    let ticketReleased = false

    let granted = false
    await new Promise<void>((resolve, reject) => {
      state.queue.push({
        mode,
        owner,
        grant: () => {
          granted = true
          resolve()
        },
        deny: (error) => {
          granted = false
          reject(error)
        },
      })
      this.pump(state)
    })
    // `dispose` rejects waiters without granting them; a denied waiter owns nothing.
    if (!granted) return { key, mode, release: () => undefined }
    return ticket
  }

  /**
   * Reject every pending waiter and refuse future acquisitions.
   * @param reason - surfaced to waiters, so a hung lock is diagnosable.
   */
  dispose(reason?: string): void {
    if (this.disposed) return
    this.disposed = true
    const error = new LeaseDisposedError(reason)
    for (const state of this.locks.values()) {
      for (const waiter of state.queue) waiter.deny(error)
      state.queue = []
    }
  }

  /** Whether `mode` may be granted to the caller right now. */
  private grantable(state: LockState, mode: LeaseMode): boolean {
    if (mode === 'write') return state.writer === null && state.readers.size === 0
    return state.writer === null
  }

  /** Grant from the head of the queue while the head is compatible. */
  private pump(state: LockState): void {
    while (state.queue.length > 0 && this.grantable(state, state.queue[0]?.mode ?? 'write')) {
      const waiter = state.queue.shift()
      if (!waiter) return
      if (waiter.mode === 'write') state.writer = waiter.owner
      else state.readers.add(waiter.owner)
      waiter.grant()
    }
  }

  private release(state: LockState, owner: symbol, mode: LeaseMode): void {
    if (mode === 'write' && state.writer === owner) state.writer = null
    else state.readers.delete(owner)
    this.pump(state)
  }
}
