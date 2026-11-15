/**
 * File watcher: chokidar plus a debounce, never `tectonic -X watch`.
 *
 * `-X watch` is a known-broken combination with `compile` (spec §3.1, pitfall 1),
 * so compilation is driven from here instead. The debounce is the product: an
 * editor writing one save as five events must produce one compile.
 *
 * @module dsh-latex-preview/services/watcher
 */

import { watch, type FSWatcher } from 'chokidar'
import { resolve } from 'node:path'

/** What the watcher is asked to observe. */
export interface WatcherOptions {
  /** Directories to watch; the root file's directory is the usual case. */
  readonly dirs: readonly string[]
  /** Output directory to ignore, so writing a PDF never re-triggers a compile. */
  readonly outDir: string
  /** Debounce window in milliseconds. */
  readonly debounceMs: number
  /** Called once per settled burst. */
  readonly onChange: (paths: readonly string[]) => void
}

/** Extensions that can change the output. */
const WATCHED_EXTENSIONS = ['.tex', '.bib', '.sty', '.cls', '.bst', '.cfg', '.def']

export class FileWatcher {
  private watcher: FSWatcher | null = null
  private timer: NodeJS.Timeout | null = null
  private batch = new Set<string>()

  constructor(private opts: WatcherOptions) {}

  /** Whether the watcher currently has live handles. */
  get active(): boolean {
    return this.watcher !== null
  }

  /**
   * Start watching. Idempotent: calling twice keeps the first watcher.
   * @returns nothing; readiness is not awaited because chokidar emits `ready`
   *   after the initial scan and we do not want to block the plugin on it.
   */
  start(): void {
    if (this.watcher) return
    const outDir = resolve(this.opts.outDir)

    this.watcher = watch([...this.opts.dirs], {
      ignoreInitial: true,
      // `awaitWriteFinish` collapses the write-then-close pair that editors emit,
      // which the debounce alone cannot do reliably.
      awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
      ignored: (path: string) => {
        const normalised = path.replace(/\\/g, '/')
        if (normalised.includes('/node_modules/') || normalised.startsWith(outDir.replace(/\\/g, '/'))) return true
        if (normalised.includes('/.git/')) return true
        const lower = normalised.toLowerCase()
        if (lower.endsWith('.pdf') || lower.endsWith('.pdf.prev') || lower.endsWith('.synctex.gz')) return true
        // Directories must stay traversable: only reject non-matching files.
        if (!lower.includes('.')) return false
        return !WATCHED_EXTENSIONS.some((ext) => lower.endsWith(ext))
      },
    })

    this.watcher.on('all', (_event: string, path: string) => this.enqueue(path))
  }

  /** Queue one changed path into the current debounce window. */
  private enqueue(path: string): void {
    this.batch.add(path)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      const changed = [...this.batch]
      this.batch.clear()
      this.timer = null
      this.opts.onChange(changed)
    }, this.opts.debounceMs)
  }

  /**
   * Stop watching and drop any pending burst.
   * @returns a promise resolving when handles are closed.
   */
  async stop(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.batch.clear()
    const current = this.watcher
    this.watcher = null
    if (current) await current.close()
  }
}
