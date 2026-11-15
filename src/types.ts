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
  /** ISO timestamp of the last successful compile. */
  readonly compiledAt: string | null
  /** Diagnostics of the most recent attempt, newest compile wins. */
  readonly diagnostics: readonly LatexDiagnostic[]
  /** Whether each external binary was found at startup. */
  readonly binaries: { readonly tectonic: boolean; readonly synctex: boolean }
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

/** One line-level diff block. */
export interface DiffBlock {
  readonly type: 'insert' | 'delete' | 'equal'
  readonly text: string
  readonly startLine: number
  readonly endLine: number
}
