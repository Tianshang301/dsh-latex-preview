/**
 * Wire contracts shared by both halves. Everything here must survive JSON.
 *
 * @module dsh-latex-preview/types
 */

/** One diagnostic produced by a compile, mirroring the `.log` parse result. */
export interface LatexDiagnostic {
  /** File the diagnostic is attributed to (absolute path). */
  readonly file: string
  /** 1-based source line, or 0 when the log did not carry one. */
  readonly line: number
  /** One-line message without the leading `!`. */
  readonly message: string
  /** Surrounding log excerpt; omitted from the wire when redaction is on. */
  readonly context: string
  readonly severity: 'error' | 'warning'
}

/** Compile lifecycle as seen by the UI. */
export type CompileState = 'idle' | 'compiling' | 'ok' | 'failed'

/** Snapshot of the preview service, polled by the client when events are unavailable. */
export interface PreviewState {
  /** Monotonic counter; the client uses it to skip redundant renders. */
  readonly version: number
  /** Resolved root `.tex` file, or null before the workspace is configured. */
  readonly rootFile: string | null
  readonly status: CompileState
  /** Same-origin URL of the current PDF, cache-busted per successful compile. */
  readonly pdfUrl: string | null
  /**
   * URL of our PDF.js viewer page, which wraps {@link pdfUrl}.
   *
   * Null when the assets are not built (`node scripts/build-assets.mjs`); the
   * panel then points the iframe straight at the PDF and the browser's own
   * viewer takes over, losing scroll preservation and page jumps.
   */
  readonly viewerUrl: string | null
  /** ISO timestamp of the last successful compile. */
  readonly compiledAt: string | null
  /** Diagnostics of the most recent attempt, newest compile wins. */
  readonly diagnostics: readonly LatexDiagnostic[]
  /** Whether each external binary was found at startup. */
  readonly binaries: { readonly tectonic: boolean; readonly synctex: boolean }
  /** One-line status for the panel's status bar (root resolution, failures, mount state). */
  readonly message: string | null
  /** Whether the file watcher currently has live handles. */
  readonly watching: boolean
  /** Mirror of the redaction switch, so the UI can render its state. */
  readonly redact: boolean
  /** Duration of the last compile in milliseconds. */
  readonly durationMs: number | null
  /** Candidate root files when resolution was ambiguous. */
  readonly rootCandidates: readonly string[]
}

/** Result of a forward SyncTeX jump (source line → PDF position). */
export interface SyncViewHit {
  readonly page: number
  readonly x: number
  readonly y: number
  readonly h: number
  readonly v: number
  readonly width: number
  readonly height: number
}

/** Result of a reverse SyncTeX jump (PDF point → source location). */
export interface SyncEditHit {
  /** Source file as reported by the tool; may differ from the root file under `\input`. */
  readonly file: string
  readonly line: number
  readonly column: number
}

/** One "change this spot" request, resolved from a rectangle in the PDF. */
export interface EditRequest {
  readonly page: number
  readonly x: number
  readonly y: number
  /** Second corner, when the user dragged a region instead of clicking. */
  readonly x2?: number
  readonly y2?: number
  /** What the user wants changed, in their own words. */
  readonly instruction: string
  /** Selected text: a hint from the PDF, never the thing being edited. */
  readonly text?: string
  readonly sessionId?: string
  readonly redact?: boolean
}

/** Where the request landed, and whether the Agent took it. */
export interface EditOutcome {
  readonly ok: boolean
  readonly file?: string
  readonly line?: number
  readonly lineEnd?: number
  readonly detail?: string
}

/** One line-level diff block. */
export interface DiffBlock {
  readonly type: 'insert' | 'delete' | 'equal'
  readonly text: string
  readonly startLine: number
  readonly endLine: number
}

/** Outcome of one compile attempt, as handed back to the client. */
export interface CompileResult {
  readonly ok: boolean
  /** Process exit code; null when the process was killed or never started. */
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number
  /** Absolute path of the PDF on disk, or null when none exists yet. */
  readonly pdfPath: string | null
  /** Same-origin URL with a cache-busting version, or null. */
  readonly pdfUrl: string | null
  /** Absolute path of the parsed `.log`, when Tectonic wrote one. */
  readonly logPath: string | null
  readonly diagnostics: readonly LatexDiagnostic[]
  /** Last lines of stdout — Tectonic prints bundle downloads here on first run. */
  readonly stdoutTail: string
  readonly stderrTail: string
  /** True when a failed compile restored the previous PDF. */
  readonly rolledBack: boolean
}

/** Tunables the client may push down; every field has a host-side default. */
export interface PreviewConfig {
  readonly rootFile: string | null
  /** Directory receiving pdf/log/synctex. Defaults to `<rootDir>/.latex-preview`. */
  readonly outDir: string
  readonly debounceMs: number
  /** Ordinary compile budget. */
  readonly timeoutMs: number
  /** First compile may download the bundle; give it more room. */
  readonly firstRunTimeoutMs: number
  /** Redaction switch for the error hand-off (product requirement, default off). */
  readonly redact: boolean
}
