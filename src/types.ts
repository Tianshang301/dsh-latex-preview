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
  /** How changes are reviewed; mirrors the Host setting (see {@link ReviewMode}). */
  readonly review: ReviewMode
  /**
   * Viewer-wrapped URL of the latexdiff document, when one has been built.
   *
   * Null until the user asks for the 对比视图 and the build succeeds; cleared
   * again whenever the underlying revision moves (accept/revert/new compile).
   */
  readonly diffDocUrl: string | null
  /**
   * Same-origin URL of the PDF that produced the diff baseline, when its
   * artefacts are still paired with a matching `.synctex.gz`.
   *
   * Null on the first compile, after a revert, and whenever the baseline is a
   * revision this process did not compile — the UI must then say "旧版定位数据
   * 不可用" instead of drawing deleted hunks at guessed coordinates.
   */
  readonly basePdfUrl: string | null
  /** Viewer-wrapped {@link basePdfUrl}; null when the assets are not built. */
  readonly baseViewerUrl: string | null
  /** Short digest of the baseline source, to prove a snapshot belongs to it. */
  readonly baseRevisionId: string | null
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
  /** First line in the **new** revision (for a deletion: where it was removed). */
  readonly startLine: number
  readonly endLine: number
  /**
   * First line in the **old** revision this block covers, 1-based.
   *
   * Needed by the previous-revision view: a deleted line no longer exists in the
   * new PDF, but it does exist in the old one, and only its *old* number can be
   * looked up in the old `.synctex.gz`. For an insertion this is the position it
   * was inserted at, i.e. the old line it now follows.
   */
  readonly oldStart: number
  /** How many old lines the block covers; 0 for a pure insertion. */
  readonly oldLines: number
}

/**
 * How much say the user has over a change that already compiled.
 *
 * - `manual`: nothing counts until 接受; the reference stays put, so the marks
 *   accumulate every unaccepted change.
 * - `auto`: each compile is accepted, but can still be reverted until the next one.
 * - `open`: accepted, no safety net, no revert offered.
 */
export type ReviewMode = 'manual' | 'auto' | 'open'

/** Which document a set of regions describes. */
export type DiffSide = 'new' | 'base'

/** What a changed region means, in diff terms. */
export type DiffRegionKind = 'insert' | 'delete' | 'modify' | 'removed'

/** One highlight box drawn on a page of one revision's PDF. */
export interface DiffRegion {
  /** 1-based page. */
  readonly page: number
  /** Rectangle in PDF points, top-left origin (docs/spikes.md §B15). */
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  /**
   * What the band means.
   *
   * `delete` is the one kind with no pixels of its own: on the *new* PDF the
   * lines are gone, so it is drawn as a seam where they used to be. `removed` is
   * the same change seen on the *old* PDF, where the text is still typeset, so it
   * is a normal band.
   */
  readonly kind: DiffRegionKind
  /**
   * Source line range **in the document being shown**: new lines for a region
   * from the live PDF, old lines for one from {@link DiffRegions.side} `base`.
   */
  readonly lineStart: number
  readonly lineEnd: number
  /** Hover text: what changed and where. */
  readonly title: string
  /**
   * The removed source lines, capped (8 lines × 200 chars).
   *
   * A deletion has no pixels left in the new PDF; this is the only copy of the
   * removed words the viewer can show, as the struck-through deletion row.
   * Empty for a pure insertion (its lines render under the band).
   */
  readonly text?: string
  /** Lines the deletion removed; 0 (absent) for insert/modify bands. */
  readonly removed?: number
  /**
   * Draw this as a thin seam rather than a band over a line.
   *
   * Set where the marked line does not exist on the page being shown: a deletion
   * on the live PDF, an insertion on the previous one. Geometry, not colour —
   * `kind` alone cannot express it because the same kind can be a band on one
   * side and a seam on the other.
   */
  readonly seam?: boolean
}

/** Regions for one compiled revision, plus what the caps left out. */
export interface DiffRegions {
  /** `PreviewState.version` these regions belong to; the panel applies on match. */
  readonly version: number
  /** Which document these rectangles describe; `base` means the old PDF. */
  readonly side: DiffSide
  readonly regions: readonly DiffRegion[]
  /** Hunks skipped by the caps, so the UI can say so instead of lying. */
  readonly skipped: number
  /**
   * Why `side: 'base'` came back empty, when it did.
   *
   * The panel shows this instead of an empty overlay: "no previous revision" and
   * "its sync map could not be paired" are different facts, and drawing nothing
   * for both is what makes a UI feel broken.
   */
  readonly message?: string
}

/** Outcome of building the latexdiff 对比视图, as handed back to the client. */
export interface DiffDocResult {
  /** Whether a diff PDF exists after this call (freshly built or kept). */
  readonly ok: boolean
  /** Viewer-wrapped URL of the diff PDF, or null when none exists. */
  readonly url: string | null
  /** One-line outcome for the status bar. */
  readonly message: string
  /** First error line when the build failed, for the notice channel. */
  readonly detail?: string
  /** `PreviewState.version` this result was computed at. */
  readonly version: number
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
