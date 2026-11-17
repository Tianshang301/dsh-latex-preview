/**
 * The one Host service the client half talks to.
 *
 * Shape follows the Typert Remote contract (verified 2026-11-16 against
 * `@deepseek-ai/dsh-typert-protocol@0.2.2-rc.1`):
 * - `TypertRemoteService` + `super(ctx, key, { namespace })` publishes the
 *   service to the Gateway; the client sees generated descriptors, never the
 *   instance.
 * - Every exported method takes JSON parameters plus a trailing client-supplied
 *   `AbortSignal`, and returns plain JSON. **A callback cannot cross the wire**,
 *   which is why there is no `onCompiled(cb)` — the client polls `getState()`.
 * - Failures are `RemoteError` codes, not thrown business errors.
 *
 * Composition: the service owns the sub-systems (watcher, compiler, diff, agent
 * bridge) as plain objects rather than Cordis services. They have no consumers
 * other than this service, and plain objects are far easier to drive in tests.
 *
 * @module dsh-latex-preview/services/latex-preview-service
 */

import type { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { basename, dirname, join } from 'node:path'
import { copyFile, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { checkBinaries } from '../utils/binaries.ts'
import { isRootCandidate, listTexFiles, resolveRoot, type RootResolution } from '../utils/root.ts'
import { synctexEdit, synctexView } from '../utils/synctex.ts'
import { CompileService, compilePaths } from './compile.ts'
import { DiffDocService } from './diffdoc.ts'
import { FileWatcher } from './watcher.ts'
import { lineDiff, normalizeLatexLine } from './diff.ts'
import { bandsFromHits, diffHunks, insertionAnchor, type DiffHunk } from './diff-regions.ts'
import { AgentBridge, buildSelectionPrompt, type AgentLike, type AgentRegistryLike } from './agent-bridge.ts'
import { renderDiffForReview, reviewDiff, type LlmLike, type ReviewRoute, type ReviewVerdict } from './reviewer.ts'
import { createApiHandler, type PreviewHost } from './http-api.ts'
import { mountStaticRoute, ROUTE_PREFIX, type StaticMount, type WebServerLike } from './static-route.ts'
import { assetsRoot, VIEWER_PATH, viewerAvailable } from '../utils/assets.ts'
import type {
  CompileResult,
  DiffBlock,
  DiffDocResult,
  DiffRegion,
  DiffRegionKind,
  DiffRegions,
  DiffSide,
  EditOutcome,
  EditRequest,
  PreviewState,
  ReviewMode,
  SyncEditHit,
  SyncViewHit,
} from '../types.ts'

/** Service key and wire namespace; must stay identical to the naming convention. */
export const SERVICE_KEY = 'latexPreview'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Live LaTeX preview state for the current workspace. */
    latexPreview: LatexPreviewService
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    'latex-preview/no-root-file': { readonly hint: string }
    'latex-preview/binary-missing': { readonly missing: readonly string[] }
    'latex-preview/no-pdf': { readonly hint: string }
    'latex-preview/handoff-failed': { readonly reason: string }
    'latex-preview/empty-instruction': Record<string, never>
    'latex-preview/no-source-map': Record<string, never>
    'latex-preview/nothing-to-review': Record<string, never>
    'latex-preview/revert-failed': { readonly detail: string }
  }
}

/** How many source lines one "change this spot" request may quote. */
const MAX_EDIT_LINES = 12

/** Hunks highlighted per revision; beyond this the overlay stops being readable. */
const MAX_DIFF_HUNKS = 24

/** `synctex view` calls one overlay may spend; each is a process per line. */
const MAX_DIFF_LINES = 40

/** How long the independent reviewer may take before the gate falls back to manual. */
const REVIEW_TIMEOUT_MS = 25_000

const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_FIRST_RUN_TIMEOUT_MS = 300_000

export class LatexPreviewService extends TypertRemoteService {
  private state: PreviewState
  private compiler: CompileService
  private diffDoc: DiffDocService | null = null
  private watcher: FileWatcher | null = null
  private readonly bridge: AgentBridge
  private agents: AgentRegistryLike | undefined
  private webServer: WebServerLike | undefined
  private disposeRoute: (() => void) | null = null
  private redact = false
  /**
   * Review gate for changes that already compiled (see {@link ReviewMode}).
   *
   * Defaults to `auto` — an independent model call decides — because that is the
   * only mode where the marks mean something without asking the user to babysit
   * every keystroke.
   */
  private review: ReviewMode = 'auto'
  /** `ctx.llm`, used only by the reviewer; absent in profiles without a model. */
  private llm: LlmLike | undefined
  /** True while a reviewer call is in flight, so two compiles cannot race. */
  private reviewing = false
  /** Last Session the panel named; the reviewer reads its model route from it. */
  private lastSessionId: string | undefined
  /** Profile default model, used when no Session has published a header yet. */
  private defaultModel: { currentSelection?(): { provider?: string; model?: string } } | undefined
  /**
   * Source of the last **accepted** revision — the left-hand side of every diff.
   *
   * Not the same thing as the PDF on disk previously: which revision counts as a
   * baseline depends on the review mode. `manual` leaves it in place until 接受,
   * `auto` moves it when the reviewer says yes, `open` moves it on every compile.
   * So it can lag the `prev` artefact pair by several compiles, and anything that
   * maps old line numbers must check {@link baseRevisionId} before trusting it.
   */
  private previousSource: string | null = null
  /** Source that produced the PDF currently on screen. */
  private compiledSource: string | null = null
  /**
   * Digest of the source whose artefacts the `prev` pair holds.
   *
   * The pair is written before every compile, but it only becomes a *baseline*
   * when the baseline moves to that revision. Keeping the digest lets the rest of
   * the service (and later the base view) refuse to pair a sync map with a
   * document that did not produce it.
   */
  private baseRevisionId: string | null = null
  private outDir: string
  private debounceMs = DEFAULT_DEBOUNCE_MS

  constructor(ctx: Context) {
    super(ctx, SERVICE_KEY, { namespace: SERVICE_KEY })

    this.outDir = join(process.cwd(), '.latex-preview')
    this.compiler = new CompileService({
      rootFile: join(process.cwd(), 'main.tex'),
      outDir: this.outDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstRunTimeoutMs: DEFAULT_FIRST_RUN_TIMEOUT_MS,
    })

    // Lazy lookups: neither service is guaranteed to exist in every profile.
    this.bridge = new AgentBridge(() => this.agents)
    ctx.inject(['agents'], (agentCtx) => {
      this.agents = agentCtx.get('agents') as unknown as AgentRegistryLike
    })
    ctx.inject(['llm'], (llmCtx) => {
      this.llm = llmCtx.get('llm') as unknown as LlmLike
    })
    ctx.inject(['agentDefaultModel'], (modelCtx) => {
      this.defaultModel = modelCtx.get('agentDefaultModel') as unknown as typeof this.defaultModel
    })
    ctx.inject(['webServer'], (webCtx) => {
      this.webServer = webCtx.get('webServer') as unknown as WebServerLike
      this.mountRoutes()
      webCtx.effect(() => () => this.unmountRoutes(), 'latex-preview: static route')
    })

    this.state = this.emptyState()
    void this.refreshBinaries()
  }

  /** Idle state for a fresh service; kept in one place so shapes cannot drift. */
  private emptyState(): PreviewState {
    return {
      version: 0,
      rootFile: null,
      status: 'idle',
      pdfUrl: null,
      viewerUrl: null,
      compiledAt: null,
      diagnostics: [],
      binaries: { tectonic: false, synctex: false },
      message: null,
      watching: false,
      redact: this.redact,
      review: this.review,
      diffDocUrl: null,
      basePdfUrl: null,
      baseViewerUrl: null,
      baseRevisionId: null,
      durationMs: null,
      rootCandidates: [],
    }
  }

  /** Replace state and bump the version pollers watch. */
  private patch(next: Partial<PreviewState>): void {
    // The two switches live on the instance; mirror them into every snapshot so
    // the panel never renders a stale control.
    this.state = { ...this.state, redact: this.redact, review: this.review, ...next, version: this.state.version + 1 }
  }

  // ── Remote surface ────────────────────────────────────────────────────────

  /**
   * Current snapshot, safe to poll.
   * @param signal - client cancellation.
   * @returns an immutable snapshot of the preview state.
   */
  @Remote
  async getState(signal: AbortSignal): Promise<PreviewState> {
    signal.throwIfAborted()
    return this.state
  }

  /**
   * Point the service at a workspace and start watching it.
   *
   * Root resolution runs when `rootFile` is omitted: the directive/scan rules in
   * `utils/root.ts` decide, and an ambiguous directory is reported rather than
   * guessed.
   * @param request - workspace file, optional explicit root, optional output dir.
   * @param signal - client cancellation.
   * @returns the updated state.
   */
  @Remote
  async configure(
    request: { file?: string; rootFile?: string; outDir?: string; redact?: boolean; review?: ReviewMode; debounceMs?: number },
    signal: AbortSignal,
  ): Promise<PreviewState> {
    signal.throwIfAborted()
    return this.applyConfigure(request)
  }

  /** Shared configure body: the Remote method and the HTTP API both land here. */
  private async applyConfigure(request: {
    file?: string
    rootFile?: string
    outDir?: string
    redact?: boolean
    review?: ReviewMode
    debounceMs?: number
  }): Promise<PreviewState> {
    if (typeof request.redact === 'boolean') this.redact = request.redact
    if (request.review === 'manual' || request.review === 'auto' || request.review === 'open') {
      this.review = request.review
    }
    if (typeof request.debounceMs === 'number' && request.debounceMs >= 0) {
      this.debounceMs = Math.min(5000, Math.max(0, request.debounceMs))
    }

    let rootFile = request.rootFile ?? null
    let resolution: RootResolution | null = null
    if (!rootFile && !request.file) {
      // No hint at all: adopt the DSH process directory when it holds exactly one
      // compilable document. This is what makes "open DSH in a paper folder" work
      // without any configuration step.
      const candidates: string[] = []
      for (const candidate of await listTexFiles(process.cwd())) {
        if (await isRootCandidate(candidate)) candidates.push(candidate)
      }
      if (candidates.length === 1) {
        rootFile = candidates[0] as string
      } else {
        await this.stopWatching()
        this.patch({
          status: 'idle',
          rootCandidates: candidates,
          redact: this.redact,
          message:
            candidates.length === 0
              ? `当前工作目录没有含 \\documentclass 的 .tex：${process.cwd()}`
              : `工作目录有 ${candidates.length} 个候选主文件，请指定 rootFile`,
        })
        return this.state
      }
    }
    if (!rootFile && request.file) {
      resolution = await resolveRoot(request.file)
      rootFile = resolution.rootFile
      if (!rootFile) {
        await this.stopWatching()
        this.patch({
          status: 'idle',
          message: resolution.message,
          rootCandidates: resolution.candidates,
          redact: this.redact,
        })
        return this.state
      }
    }

    if (!rootFile) {
      throw new RemoteError('latex-preview/no-root-file', 'rootFile is required', {
        hint: '面板需要知道哪个 .tex 是主文件；可传 rootFile，或传一个 file 让服务自行解析',
      })
    }

    const outDir = request.outDir ?? this.outDir ?? join(dirname(rootFile), '.latex-preview')
    this.outDir = outDir
    this.compiler = new CompileService({
      rootFile,
      outDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstRunTimeoutMs: DEFAULT_FIRST_RUN_TIMEOUT_MS,
    })
    this.diffDoc = new DiffDocService({
      rootFile,
      outDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstRunTimeoutMs: DEFAULT_FIRST_RUN_TIMEOUT_MS,
    })
    const initial = await this.readSource(rootFile)
    this.previousSource = initial
    this.compiledSource = initial
    // A different root (or outDir) means any `prev` pair belongs to another
    // document; keeping it would let a sync map outlive the file it described.
    this.baseRevisionId = null

    await this.stopWatching()
    this.watcher = new FileWatcher({
      dirs: [dirname(rootFile)],
      outDir,
      debounceMs: this.debounceMs,
      onChange: () => {
        void this.runCompile().catch(() => undefined)
      },
    })
    this.watcher.start()

    this.patch({
      rootFile,
      status: 'idle',
      message: resolution?.message ?? `已配置主文件：${rootFile}`,
      rootCandidates: resolution?.candidates ?? [rootFile],
      watching: true,
      redact: this.redact,
      basePdfUrl: null,
      baseViewerUrl: null,
      baseRevisionId: null,
    })

    // First view of a workspace has no PDF yet; without this the panel stays
    // empty until the user presses 编译. Failures are already surfaced through
    // `runCompile`'s state patch, so a rejected promise here adds nothing.
    if (!this.state.pdfUrl) {
      void this.runCompile().catch(() => undefined)
    }
    return this.state
  }

  /**
   * Compile now, bypassing the debounce.
   * @param signal - client cancellation.
   * @returns the compile result.
   */
  @Remote
  async compileNow(signal: AbortSignal): Promise<CompileResult> {
    signal.throwIfAborted()
    return this.runCompile()
  }

  /**
   * Read the latest line diff between the last compiled source and the current file.
   * @param signal - client cancellation.
   * @returns diff blocks; empty when no compile has happened.
   */
  @Remote
  async getDiff(signal: AbortSignal): Promise<readonly DiffBlock[]> {
    signal.throwIfAborted()
    return this.readDiff()
  }

  /** Diff body shared by the Remote method and the HTTP API. */
  private async readDiff(): Promise<readonly DiffBlock[]> {
    const head = this.compiledSource
    if (this.previousSource === null || head === null) return []
    return lineDiff(this.previousSource, head)
  }

  /**
   * Rectangles for the changes since the previous compile.
   *
   * Two sides, because a change has two halves and only one of them is on screen
   * at a time: `new` marks the live PDF (deletions can only be a seam there),
   * `base` marks the previous revision, where the deleted text *is* typeset and
   * therefore gets a real box out of the old `.synctex.gz`. The panel fetches
   * whichever one it is showing.
   * @param request.side - which revision to describe; defaults to `new`.
   * @param signal - client cancellation.
   * @returns regions tagged with the state version they were computed for.
   */
  @Remote
  async getDiffRegions(request: { side?: DiffSide }, signal: AbortSignal): Promise<DiffRegions> {
    signal.throwIfAborted()
    return this.readDiffRegions(request?.side === 'base' ? 'base' : 'new')
  }

  /** Body shared by the Remote method and the HTTP API. */
  private async readDiffRegions(side: DiffSide = 'new'): Promise<DiffRegions> {
    const version = this.state.version
    const empty: DiffRegions = { version, side, regions: [], skipped: 0 }
    const rootFile = this.state.rootFile
    const base = this.previousSource
    const head = this.compiledSource
    if (!rootFile || base === null || head === null) return empty

    const hunks = diffHunks(lineDiff(base, head))
    if (hunks.length === 0) {
      return side === 'base' ? { ...empty, message: '两版内容一致，旧版没有可标的地方' } : empty
    }
    const paths = compilePaths(rootFile, this.outDir)

    if (side === 'base') {
      // The pair is only usable as a map of the *baseline*: check the digest
      // rather than trust that the files on disk still describe `previousSource`.
      if (this.baseRevisionId === null || !this.state.basePdfUrl || this.baseRevisionId !== this.digestOf(base)) {
        return { ...empty, message: '旧版 PDF 与其 SyncTeX 未成对，无法定位被删除的内容' }
      }
      return this.baseRegions(version, rootFile, paths.basePdf, hunks, base)
    }

    if (!this.state.pdfUrl) return empty
    return this.newRegions(version, rootFile, paths.pdf, hunks, head)
  }

  /**
   * Bands on the **live** PDF.
   *
   * A deletion has no lines here, so it becomes a seam at the foot of the line
   * above the hole — see {@link readDiffRegions} for the other half.
   */
  private async newRegions(
    version: number,
    rootFile: string,
    pdf: string,
    hunks: readonly DiffHunk[],
    head: string,
  ): Promise<DiffRegions> {
    const sourceLines = head.split(/\r?\n/)
    const totalLines = Math.max(1, sourceLines.length)
    const regions: DiffRegion[] = []
    let budget = MAX_DIFF_LINES
    let skipped = Math.max(0, hunks.length - MAX_DIFF_HUNKS)

    for (const hunk of hunks.slice(0, MAX_DIFF_HUNKS)) {
      if (budget <= 0) {
        skipped += 1
        continue
      }
      const first = Math.min(Math.max(1, hunk.lineStart), totalLines)
      const last = Math.min(Math.max(first, hunk.lineEnd), totalLines)
      const hits: SyncViewHit[] = []

      if (hunk.kind === 'delete') {
        // Anchor above the hole, not below it: the line that took the deleted
        // block's place is often `\end{document}` or a comment, and `synctex view`
        // answers for those with the *page-number* box at the bottom of the sheet.
        // The text above the hole always renders, and the seam belongs at its foot.
        budget -= 1
        const anchor =
          first > 1
            ? await this.mappedLine(rootFile, pdf, totalLines, first - 1, 'before', (line) => isTypeset(sourceLines, line))
            : null
        if (anchor === null) {
          skipped += 1
          continue
        }
        hits.push(...anchor)
      } else {
        const lines = typesetLines(sampleLines(first, last, budget), sourceLines)
        budget -= lines.length
        // A range that is only blank lines renders nowhere: counting it as skipped
        // is honest, marking a neighbour would not be.
        if (lines.length === 0) {
          skipped += 1
          continue
        }
        for (const line of lines) {
          hits.push(...(await synctexView(rootFile, line, pdf, { cwd: this.outDir })))
        }
      }

      const where = first === last ? `第 ${first} 行` : `第 ${first}-${last} 行`
      const what =
        hunk.kind === 'delete'
          ? `在第 ${first} 行之前删除了 ${hunk.removed} 行（新 PDF 里已无内容，只留接缝）`
          : hunk.kind === 'insert'
            ? `新增${where}`
            : `修改${where}`
      const title = hunk.preview === '' ? what : `${what}：${hunk.preview}`

      for (const band of bandsFromHits(hits)) {
        // The seam sits at the foot of the line above the hole, which is where the
        // deleted content used to begin.
        const seam = hunk.kind === 'delete'
        regions.push({
          ...band,
          y: seam ? band.y + band.height : band.y,
          kind: hunk.kind,
          ...(seam ? { seam: true } : {}),
          lineStart: first,
          lineEnd: last,
          title,
          // The removed source lines: the new PDF has no pixels for them, the
          // deletion row in the overlay is the only place they can appear.
          text: hunk.text,
          removed: hunk.removed,
        })
      }
    }

    return { version, side: 'new', regions, skipped }
  }

  /**
   * Bands on the **previous** revision's PDF.
   *
   * This is the view where a deletion is finally a first-class citizen: the lines
   * still exist on that page, so `synctex view -o main.prev.pdf` returns their
   * real boxes and they are painted as ordinary bands. A pure insertion has
   * nothing to highlight here, so it keeps the seam treatment — pointing at the
   * line after which the new text appeared.
   */
  private async baseRegions(
    version: number,
    rootFile: string,
    basePdf: string,
    hunks: readonly DiffHunk[],
    base: string,
  ): Promise<DiffRegions> {
    // The *old* source is what the old line numbers index; using the new one
    // here would decide which lines are blank against the wrong document.
    const sourceLines = base.split(/\r?\n/)
    const totalLines = Math.max(1, sourceLines.length)
    const regions: DiffRegion[] = []
    let budget = MAX_DIFF_LINES
    let skipped = Math.max(0, hunks.length - MAX_DIFF_HUNKS)

    for (const hunk of hunks.slice(0, MAX_DIFF_HUNKS)) {
      if (budget <= 0) {
        skipped += 1
        continue
      }

      if (hunk.oldLines === 0) {
        // Insertion: nothing on the old page to tint, so mark where it landed.
        // `oldStart` is the first old line *after* the insertion; the seam belongs
        // on the one before it (see `insertionAnchor`).
        budget -= 1
        const { line: anchorLine, edge } = insertionAnchor(hunk.oldStart, totalLines)
        const anchor = await this.mappedLine(
          rootFile,
          basePdf,
          totalLines,
          anchorLine,
          'before',
          (line) => isTypeset(sourceLines, line),
        )
        if (anchor === null) {
          skipped += 1
          continue
        }
        const title =
          edge === 'top'
            ? `旧版第 ${anchorLine} 行之前新增了内容（旧版 PDF 里没有这段）`
            : `旧版第 ${anchorLine} 行之后新增了内容（旧版 PDF 里没有这段）`
        for (const band of bandsFromHits(anchor)) {
          regions.push({
            ...band,
            y: edge === 'top' ? band.y : band.y + band.height,
            kind: 'insert',
            seam: true,
            lineStart: anchorLine,
            lineEnd: anchorLine,
            title,
          })
        }
        continue
      }

      const first = Math.min(Math.max(1, hunk.oldStart), totalLines)
      const last = Math.min(Math.max(first, hunk.oldStart + hunk.oldLines - 1), totalLines)
      const lines = typesetLines(sampleLines(first, last, budget), sourceLines)
      budget -= lines.length
      if (lines.length === 0) {
        skipped += 1
        continue
      }
      const hits: SyncViewHit[] = []
      for (const line of lines) {
        hits.push(...(await synctexView(rootFile, line, basePdf, { cwd: this.outDir })))
      }
      const kind: DiffRegionKind = hunk.kind === 'delete' ? 'removed' : 'modify'
      const where = first === last ? `第 ${first} 行` : `第 ${first}-${last} 行`
      const what = kind === 'removed' ? `这 ${hunk.removed} 行已被删除` : '这一处已被改写'
      const title = hunk.preview === '' ? `旧版${where}：${what}` : `旧版${where}：${what}（${hunk.preview}）`
      for (const band of bandsFromHits(hits)) {
        regions.push({ ...band, kind, lineStart: first, lineEnd: last, title })
      }
    }

    return { version, side: 'base', regions, skipped }
  }

  /**
   * Build the latexdiff 对比视图 between the accepted and the current revision.
   *
   * This is the answer to "how do deletions show up in a PDF": they cannot, not
   * on the new PDF, so a third document is compiled in which the removed text
   * *is* typeset — struck through in red — right where it used to stand, and
   * added text is blue (see `services/diffdoc.ts`). Costs one extra tectonic run,
   * which is why it is button-driven instead of riding every compile.
   * @param signal - client cancellation.
   * @returns the outcome with a viewer-wrapped URL on success.
   */
  @Remote
  async buildDiffDoc(signal: AbortSignal): Promise<DiffDocResult> {
    signal.throwIfAborted()
    return this.applyDiffDoc()
  }

  /** Shared diff-document body: the Remote method and the HTTP API land here. */
  private async applyDiffDoc(): Promise<DiffDocResult> {
    const rootFile = this.state.rootFile
    const base = this.previousSource
    const head = this.compiledSource
    if (!rootFile || !this.diffDoc || base === null || head === null) {
      return { ok: false, url: this.state.diffDocUrl, message: '尚未配置主文件，无法生成对比视图', version: this.state.version }
    }
    if (base === head) {
      return { ok: false, url: null, message: '没有可对比的改动（当前版与已接受版一致）', version: this.state.version }
    }

    const build = await this.diffDoc.build(base, head)
    if (!build.ok || !build.pdfPath) {
      this.patch({ diffDocUrl: null })
      return { ok: false, url: null, message: build.message, ...(build.detail ? { detail: build.detail } : {}), version: this.state.version }
    }

    const route = `${ROUTE_PREFIX}/pdf/${encodeURIComponent(basename(build.pdfPath))}`
    // Same wrap as the live PDF: our viewer page when the assets exist, the raw
    // PDF route otherwise (the browser viewer then takes over, losing jumps).
    const url = viewerAvailable() ? `${ROUTE_PREFIX}${VIEWER_PATH}?file=${encodeURIComponent(route)}&v=${this.state.version + 1}` : route
    this.patch({ diffDocUrl: url, message: build.message })
    return { ok: true, url, message: build.message, version: this.state.version }
  }

  /**
   * Sign off the changes compiled so far.
   *
   * Only meaningful in `manual` review: the reference used by the diff moves up to
   * the current PDF, which clears the marks. In `auto` the reference already moved
   * and this is a no-op with an error, so the panel does not offer it there.
   * @param signal - client cancellation.
   * @returns the state after acceptance.
   */
  @Remote
  async acceptChanges(signal: AbortSignal): Promise<PreviewState> {
    signal.throwIfAborted()
    return this.applyAccept()
  }

  /** Shared acceptance body. */
  private async applyAccept(): Promise<PreviewState> {
    if (!this.hasPendingChanges()) {
      throw new RemoteError('latex-preview/nothing-to-review', '没有待审核的改动', {})
    }
    this.previousSource = this.compiledSource
    // The revision being accepted is the one on screen, so its artifacts can be
    // copied straight from disk — no second compile, and the pair now belongs to
    // the baseline the diff will use.
    await this.snapshotBaseFromCurrent()
    this.patch({ message: '已接受这次改动', diffDocUrl: null })
    return this.state
  }

  /**
   * Put the source back to the last accepted revision and recompile.
   *
   * This writes the root file — the one destructive action in the plugin — so the
   * panel arms the button with a second click rather than firing on one.
   * @param signal - client cancellation.
   * @returns the state after the recompile.
   */
  @Remote
  async revertChanges(signal: AbortSignal): Promise<PreviewState> {
    signal.throwIfAborted()
    return this.applyRevert()
  }

  /** Shared revert body. */
  private async applyRevert(): Promise<PreviewState> {
    const rootFile = this.state.rootFile
    const target = this.previousSource
    if (!rootFile || target === null || !this.hasPendingChanges()) {
      throw new RemoteError('latex-preview/nothing-to-review', '没有可撤回的改动', {})
    }

    await writeFile(rootFile, target, 'utf8')
    // Line both snapshots up *before* compiling: otherwise the compile sees the
    // reverted file as a brand-new change and paints the rollback as a diff.
    this.compiledSource = target
    let result: CompileResult
    try {
      result = await this.runCompile()
    } catch (error) {
      throw new RemoteError('latex-preview/revert-failed', '源码已回滚，但重新编译没有启动', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    if (!result.ok) {
      throw new RemoteError('latex-preview/revert-failed', '源码已回滚，但重新编译失败；PDF 仍是回滚前那一版', {
        detail: result.diagnostics[0]?.message ?? 'unknown',
      })
    }
    // The rolled-back content is the baseline, so the pair must describe it
    // rather than the revision that was just thrown away.
    await this.snapshotBaseFromCurrent()
    this.patch({ message: '已回滚到上一版', diffDocUrl: null })
    return this.state
  }

  /**
   * Send the change just compiled to an independent reviewer.
   *
   * Runs detached: compiling must not wait on a model call. The reviewer's verdict
   * decides — accept moves the reference, reject rolls the source back — and a
   * failed or unreadable review deliberately degrades to manual rather than
   * passing the change through.
   */
  private async queueReview(): Promise<void> {
    const target = this.compiledSource
    const base = this.previousSource
    if (this.reviewing || target === null || base === null || target === base) return

    this.reviewing = true
    this.patch({ message: '自动审核中：正在请独立 AI 审这次改动…' })
    try {
      const verdict = await this.runReview(base, target)
      // Another compile landed while the reviewer was thinking; that change gets
      // its own review, and applying this verdict to it would be wrong.
      if (this.compiledSource !== target) return

      if (verdict.verdict === 'unavailable') {
        this.patch({ message: `自动审核不可用（${verdict.reason}），已转手动：请点「接受」或「撤销」` })
        return
      }
      if (verdict.verdict === 'accept') {
        this.previousSource = target
        // Same reason as 接受: the approved revision is the one on screen.
        await this.snapshotBaseFromCurrent()
        this.patch({ message: `自动审核通过：${verdict.reason}`, diffDocUrl: null })
        return
      }
      await this.applyRevert()
      this.patch({ message: `自动审核未通过，已回滚：${verdict.reason}`, diffDocUrl: null })
    } catch (error) {
      this.patch({
        message: `自动审核出错（${error instanceof Error ? error.message : String(error)}），已转手动`,
      })
    } finally {
      this.reviewing = false
    }
  }

  /**
   * Run one reviewer call on the diff between two revisions.
   * @param base - last accepted content.
   * @param target - content currently shown.
   * @returns the verdict; `unavailable` when no model or route is reachable.
   */
  private async runReview(base: string, target: string): Promise<ReviewVerdict> {
    if (!this.llm) return { verdict: 'unavailable', reason: '当前 profile 没有可用的模型服务' }
    const route = this.reviewRoute()
    if (!route) return { verdict: 'unavailable', reason: '读不到当前会话的模型路由' }
    const diff = renderDiffForReview(lineDiff(base, target))
    if (diff.trim() === '') return { verdict: 'accept', reason: '没有实际改动' }
    // A stalled provider must not leave the panel saying "审核中" indefinitely.
    return Promise.race([
      reviewDiff(this.llm, route, diff),
      new Promise<ReviewVerdict>((resolve) => {
        setTimeout(() => resolve({ verdict: 'unavailable', reason: '审核超时（25s）' }), REVIEW_TIMEOUT_MS).unref?.()
      }),
    ])
  }

  /**
   * Provider and model the reviewer should use.
   *
   * Taken from the Session's request header — the same source the first-party
   * auto-review layer reads — because the plugin owns no model configuration of
   * its own. Tried in order: the Session the panel last named, the initiator
   * boundary, then any live Agent.
   * @returns the route, or null when no Agent publishes one.
   */
  private reviewRoute(): ReviewRoute | null {
    const candidates: AgentLike[] = []
    const named = this.agentFor(this.lastSessionId)
    if (named) candidates.push(named)
    const initiator = this.agents?.currentInitiator?.()
    if (initiator) candidates.push(initiator)
    for (const agent of this.agents?.list?.() ?? []) candidates.push(agent)

    for (const agent of candidates) {
      const config = agent.session?.requestHeader?.()?.config
      const provider = config?.provider
      const model = config?.model
      if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
        return { provider, model }
      }
    }

    // A fresh Session has no request header until its first turn, and the panel's
    // compile can happen before that; the profile default is the same model the
    // next turn would use.
    try {
      const selection = this.defaultModel?.currentSelection?.()
      const provider = selection?.provider
      const model = selection?.model
      if (typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '') {
        return { provider, model }
      }
    } catch {
      // A profile without a default model is a miss, not a failure.
    }
    return null
  }

  /**
   * Short digest identifying a source revision.
   * @param source - full source text.
   * @returns 12 hex characters; enough to compare snapshots, not a security hash.
   */
  private digestOf(source: string): string {
    return createHash('sha1').update(source).digest('hex').slice(0, 12)
  }

  /** Whether a path exists, without throwing. */
  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Decide what the `prev` artefact pair means after a successful compile.
   *
   * The pair was written before this compile, so it describes `expected` — the
   * revision that was on screen. It is a usable baseline only when the baseline
   * actually moved to it (`open`, or a redundant compile); in `manual`/`auto`
   * pending review it describes a revision the baseline does not point at, and
   * keeping it would pair deleted line numbers with the wrong document.
   * @param expected - source that produced the artefacts in the pair.
   */
  private async adoptBaseArtifacts(expected: string | null): Promise<void> {
    const rootFile = this.state.rootFile
    if (!rootFile) return
    const paths = compilePaths(rootFile, this.outDir)
    const paired = (await this.fileExists(paths.basePdf)) && (await this.fileExists(paths.baseSynctex))
    if (!paired || expected === null || this.previousSource !== expected) {
      await this.dropBaseArtifacts()
      return
    }
    this.baseRevisionId = this.digestOf(expected)
    this.publishBaseUrls()
  }

  /**
   * Replace the pair with the artefacts currently on screen.
   *
   * Used when the baseline catches up with what is displayed (接受, auto approval,
   * revert): at that moment the current PDF *is* the baseline, so it can be
   * copied without a second compile.
   */
  private async snapshotBaseFromCurrent(): Promise<void> {
    const rootFile = this.state.rootFile
    const source = this.previousSource
    if (!rootFile || source === null) {
      await this.dropBaseArtifacts()
      return
    }
    const paths = compilePaths(rootFile, this.outDir)
    if (!(await this.fileExists(paths.pdf)) || !(await this.fileExists(paths.synctex))) {
      await this.dropBaseArtifacts()
      return
    }
    await copyFile(paths.pdf, paths.basePdf).catch(() => undefined)
    await copyFile(paths.synctex, paths.baseSynctex).catch(() => undefined)
    this.baseRevisionId = this.digestOf(source)
    this.publishBaseUrls()
  }

  /** Forget the pair: its revision can no longer be mapped honestly. */
  private async dropBaseArtifacts(): Promise<void> {
    const rootFile = this.state.rootFile
    if (rootFile) {
      const paths = compilePaths(rootFile, this.outDir)
      await rm(paths.basePdf, { force: true }).catch(() => undefined)
      await rm(paths.baseSynctex, { force: true }).catch(() => undefined)
    }
    this.baseRevisionId = null
    this.patch({ basePdfUrl: null, baseViewerUrl: null, baseRevisionId: null })
  }

  /** Mirror the current pair into the state as URLs the panel can use. */
  private publishBaseUrls(): void {
    const rootFile = this.state.rootFile
    const id = this.baseRevisionId
    if (!rootFile || id === null) return
    const name = basename(compilePaths(rootFile, this.outDir).basePdf)
    const route = `${ROUTE_PREFIX}/pdf/${encodeURIComponent(name)}`
    this.patch({
      basePdfUrl: `${route}?v=${id}`,
      baseViewerUrl: viewerAvailable()
        ? `${ROUTE_PREFIX}${VIEWER_PATH}?file=${encodeURIComponent(route)}&v=${id}`
        : null,
      baseRevisionId: id,
    })
  }

  /** Whether the PDF differs from the last accepted revision. */
  private hasPendingChanges(): boolean {
    return this.compiledSource !== null && this.previousSource !== null && this.compiledSource !== this.previousSource
  }

  /**
   * Forward jump: source line → PDF position.
   * @param request - line number; `file` defaults to the root file.
   * @param signal - client cancellation.
   * @returns every hit SyncTeX reports.
   */
  @Remote
  async jumpToPdf(request: { line: number; file?: string }, signal: AbortSignal): Promise<readonly SyncViewHit[]> {
    signal.throwIfAborted()
    return this.view(request)
  }

  /** Forward-jump body shared by the Remote method and the HTTP API. */
  private async view(request: { line: number; file?: string }): Promise<readonly SyncViewHit[]> {
    const pdf = this.requirePdf()
    const file = request.file ?? this.state.rootFile
    if (!file) throw new RemoteError('latex-preview/no-root-file', 'no file to jump from', { hint: '先 configure' })
    return synctexView(file, request.line, pdf, { cwd: this.outDir })
  }

  /**
   * Reverse jump: PDF point → source location.
   * @param request - page and PDF coordinates.
   * @param signal - client cancellation.
   * @returns every hit SyncTeX reports.
   */
  @Remote
  async jumpToSource(request: { page: number; x: number; y: number }, signal: AbortSignal): Promise<readonly SyncEditHit[]> {
    signal.throwIfAborted()
    return this.edit(request)
  }

  /** Reverse-jump body shared by the Remote method and the HTTP API. */
  private async edit(request: { page: number; x: number; y: number }): Promise<readonly SyncEditHit[]> {
    const pdf = this.requirePdf()
    return synctexEdit(request.page, request.x, request.y, pdf, { cwd: this.outDir })
  }

  /**
   * Turn a rectangle in the PDF into a change request on its source.
   *
   * Only the rectangle is taken from the PDF; the source lines behind it are what
   * the Agent edits, which is why extracting text from prose/formulas does not
   * matter. Both corners are resolved when the user dragged a region, so a
   * multi-line selection becomes a line range rather than one line.
   * @param request - page, rectangle, the user's instruction, and their session.
   * @param signal - client cancellation.
   * @returns the resolved location once the Agent has taken the message.
   */
  @Remote
  async editAt(request: EditRequest, signal: AbortSignal): Promise<EditOutcome> {
    signal.throwIfAborted()
    return this.applyEdit(request)
  }

  /** Shared body of the Remote method and the HTTP API. */
  private async applyEdit(request: EditRequest): Promise<EditOutcome> {
    this.lastSessionId = request.sessionId ?? this.lastSessionId
    const pdf = this.requirePdf()
    const instruction = (request.instruction ?? '').trim()
    if (instruction === '') {
      throw new RemoteError('latex-preview/empty-instruction', '请先说明想怎么改这里', {})
    }

    const hits = await synctexEdit(request.page, request.x, request.y, pdf, { cwd: this.outDir })
    if (typeof request.x2 === 'number' && typeof request.y2 === 'number') {
      hits.push(...(await synctexEdit(request.page, request.x2, request.y2, pdf, { cwd: this.outDir })))
    }

    const located = hits.filter((hit) => hit.line > 0)
    const first = located[0]
    if (!first) {
      throw new RemoteError('latex-preview/no-source-map', '这个位置没有可定位的源码行（可能在导言区、宏定义或图片内部）', {})
    }

    const sameFile = located.filter((hit) => hit.file === first.file)
    const lineStart = Math.min(...sameFile.map((hit) => hit.line))
    const rawEnd = Math.max(...sameFile.map((hit) => hit.line))
    // A tall region can cover a whole page; cap what is quoted to the Agent.
    const lineEnd = Math.min(rawEnd, lineStart + MAX_EDIT_LINES - 1)

    const redact = request.redact ?? this.redact
    const lines = redact ? [] : await this.readLines(first.file, lineStart, lineEnd)

    const outcome = this.bridge.deliver(
      buildSelectionPrompt({
        file: first.file,
        lineStart,
        lineEnd,
        lines,
        quoted: request.text ?? '',
        instruction,
        redact,
      }),
      this.agentFor(request.sessionId),
    )

    if (!outcome.ok) {
      throw new RemoteError('latex-preview/handoff-failed', outcome.detail ?? outcome.reason ?? 'unknown', {
        reason: outcome.reason ?? 'unknown',
      })
    }

    this.patch({
      message: `已把这个位置的修改要求发给 Agent（${basename(first.file)}:${lineStart === lineEnd ? lineStart : `${lineStart}-${lineEnd}`}）`,
    })
    return { ok: true, file: basename(first.file), line: lineStart, lineEnd }
  }

  /**
   * First nearby line that SyncTeX can actually place on a page.
   *
   * @param rootFile - absolute path of the root source.
   * @param pdf - the compiled PDF.
   * @param totalLines - line count of the compiled source.
   * @param line - the line to start from.
   * @param direction - search up or down first when `line` itself renders nothing.
   * @param renders - whether a line can have a box at all; blank lines answer with
   *   the *next* rendered line's box instead of nothing (docs/spikes.md §B21), so
   *   callers that need "the line above the hole" must exclude them here.
   * @returns hits for the first line that renders, or null when none does.
   */
  private async mappedLine(
    rootFile: string,
    pdf: string,
    totalLines: number,
    line: number,
    direction: 'before' | 'after' = 'after',
    renders?: (line: number) => boolean,
  ): Promise<SyncViewHit[] | null> {
    const offsets = direction === 'before' ? [0, -1, -2, -3, -4, 1, 2, 3, 4] : [0, 1, 2, 3, 4, -1, -2, -3, -4]
    const candidates: number[] = []
    for (const offset of offsets) {
      const candidate = line + offset
      if (candidate < 1 || candidate > totalLines || candidates.includes(candidate)) continue
      if (renders && !renders(candidate)) continue
      candidates.push(candidate)
    }
    for (const candidate of candidates) {
      const hits = await synctexView(rootFile, candidate, pdf, { cwd: this.outDir })
      const useful = hits.filter((hit) => hit.page > 0 && hit.width > 0 && hit.height > 0)
      if (useful.length > 0) return useful
    }
    return null
  }

  /**
   * Read a 1-based inclusive line range from a source file.
   * @param file - absolute path SyncTeX reported.
   * @param start - first line, 1-based.
   * @param end - last line, 1-based inclusive.
   * @returns the lines; empty when the file cannot be read.
   */
  private async readLines(file: string, start: number, end: number): Promise<string[]> {
    try {
      const text = await readFile(file, 'utf8')
      return text.split(/\r?\n/).slice(start - 1, end)
    } catch {
      return []
    }
  }

  /**
   * Hand the current compile failure to the Agent.
   * @param request.redact - overrides the stored switch for this send only.
   * @param signal - client cancellation.
   * @returns whether the message reached an agent.
   */
  @Remote
  async sendErrorToAgent(request: { redact?: boolean }, signal: AbortSignal): Promise<{ ok: boolean; detail?: string }> {
    signal.throwIfAborted()
    return this.handOff(request)
  }

  /** Error hand-off body shared by the Remote method and the HTTP API. */
  private async handOff(request: { redact?: boolean; sessionId?: string }): Promise<{ ok: boolean; detail?: string }> {
    this.lastSessionId = request.sessionId ?? this.lastSessionId
    const outcome = this.bridge.send(
      this.state.diagnostics,
      { redact: request.redact ?? this.redact },
      this.agentFor(request.sessionId),
    )
    if (!outcome.ok) {
      throw new RemoteError('latex-preview/handoff-failed', outcome.detail ?? outcome.reason ?? 'unknown', {
        reason: outcome.reason ?? 'unknown',
      })
    }
    return { ok: true }
  }

  /**
   * Resolve the live Agent of a Session.
   *
   * Needed because this route is not driven by an Agent, so there is no initiator
   * boundary to inherit from (`docs/spikes.md` §B14). The DOM exposes the sidebar's
   * session key, which may or may not carry its own prefix, so both spellings are
   * tried and neither is trusted.
   * @param sessionId - value read by the panel from the sidebar's session node.
   * @returns the agent, or undefined when the id matches no live Session.
   */
  private agentFor(sessionId: string | undefined): AgentLike | undefined {
    if (!sessionId) return undefined
    const registry = this.agents
    if (!registry?.get) return undefined
    const candidates = [sessionId, sessionId.replace(/^session-/, '')]
    for (const candidate of candidates) {
      try {
        const agent = registry.get(candidate)
        if (agent) return agent
      } catch {
        // A malformed id is a miss, not a failure; try the next spelling.
      }
    }
    return undefined
  }

  /**
   * Force a re-probe of `tectonic` / `synctex` (the UI's "recheck" affordance).
   * @param signal - client cancellation.
   * @returns the fresh availability flags.
   */
  @Remote
  async recheckBinaries(signal: AbortSignal): Promise<PreviewState['binaries']> {
    signal.throwIfAborted()
    const binaryState = await this.refreshBinaries()
    if (!binaryState) {
      throw new RemoteError('latex-preview/binary-missing', 'binary probe could not run', { missing: [] })
    }
    return binaryState
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** Probe both binaries and fold the result into the state. Never throws. */
  private async refreshBinaries(): Promise<PreviewState['binaries'] | undefined> {
    try {
      const report = await checkBinaries()
      const binaries = { tectonic: report.tectonic.available, synctex: report.synctex.available }
      this.patch({ binaries })
      return binaries
    } catch (error) {
      this.ctx.logger?.('latex-preview')?.warn?.('binary probe failed: %s', String(error))
      return undefined
    }
  }

  /** One compile, with state transitions around it. */
  private async runCompile(): Promise<CompileResult> {
    const rootFile = this.state.rootFile
    if (!rootFile) {
      throw new RemoteError('latex-preview/no-root-file', 'nothing configured', { hint: '先调用 configure' })
    }
    if (!this.state.binaries.tectonic) {
      throw new RemoteError('latex-preview/binary-missing', 'tectonic is not available', { missing: ['tectonic'] })
    }

    // What the artifacts on disk describe *before* this compile overwrites them.
    const before = this.compiledSource
    this.patch({ status: 'compiling', message: '正在编译…' })
    let result: CompileResult
    try {
      result = await this.compiler.run()
    } catch (error) {
      // Without this the state stays 'compiling' forever and the panel looks hung.
      this.patch({
        status: 'failed',
        message: `编译没有启动：${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    }
    const version = this.state.version + 1
    const pdfRoute = result.pdfPath ? `${ROUTE_PREFIX}/pdf/${encodeURIComponent(basename(result.pdfPath))}` : null
    const pdfUrl = pdfRoute ? `${pdfRoute}?v=${version}` : null
    // Our viewer wraps the PDF; without the assets the browser's own viewer is
    // the only option, hence the null fallback (never a broken iframe URL).
    const viewerUrl =
      pdfRoute && viewerAvailable()
        ? `${ROUTE_PREFIX}${VIEWER_PATH}?file=${encodeURIComponent(pdfRoute)}&v=${version}`
        : null

    let contentChanged = false
    if (result.ok) {
      const compiled = await this.readSource(rootFile)
      // Advance only when the content actually moved. A redundant compile (the
      // user pressing 编译 twice) must not erase the marks they are looking at,
      // and a failed compile keeps the old PDF, so its baseline stays.
      if (compiled !== this.compiledSource) {
        // Only `open` advances the reference here. `manual` waits for 接受; `auto`
        // waits for the reviewer, and moves it itself once the verdict is in.
        if (this.review === 'open') this.previousSource = this.compiledSource ?? compiled
        this.compiledSource = compiled
        contentChanged = true
        if (this.review === 'auto') void this.queueReview()
      }
    }

    // A failed compile leaves the pair untouched: the baseline did not move, so
    // whatever was valid before is still valid.
    if (result.ok) await this.adoptBaseArtifacts(before)

    this.patch({
      status: result.ok ? 'ok' : 'failed',
      pdfUrl: result.pdfPath ? pdfUrl : this.state.pdfUrl,
      viewerUrl: result.pdfPath ? viewerUrl : this.state.viewerUrl,
      // A new revision makes the built 对比视图 stale; it must be rebuilt on
      // demand rather than silently shown against the wrong baseline.
      diffDocUrl: contentChanged ? null : this.state.diffDocUrl,
      compiledAt: result.ok ? new Date().toISOString() : this.state.compiledAt,
      diagnostics: result.diagnostics,
      durationMs: result.durationMs,
      message: this.describe(result),
    })
    return { ...result, pdfUrl }
  }

  /** One-line status for the panel. */
  private describe(result: CompileResult): string {
    if (result.ok) return `编译成功（${(result.durationMs / 1000).toFixed(1)}s）`
    if (result.timedOut) return '编译超时，已保留上一次的 PDF'
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length
    return result.rolledBack
      ? `编译失败（${errors} 个错误），已回滚到上一次的 PDF`
      : `编译失败（${errors} 个错误）`
  }

  /** Absolute PDF path or a RemoteError the UI can explain. */
  private requirePdf(): string {
    const rootFile = this.state.rootFile
    if (!rootFile) throw new RemoteError('latex-preview/no-pdf', 'no root file', { hint: '先 configure' })
    return compilePaths(rootFile, this.outDir).pdf
  }

  /** Read the root source, tolerating a missing file. */
  private async readSource(file: string): Promise<string | null> {
    try {
      return await readFile(file, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * Bind the same-origin JSON API to this service.
   *
   * Separate from the `@Remote` surface on purpose: the Remote names cannot be
   * reused 1:1 (`compileNow` vs `compile`), and keeping the mapping in one place
   * documents that both faces share the same bodies.
   * @returns the host operations exposed over HTTP.
   */
  private httpHost(): PreviewHost {
    return {
      state: () => this.state,
      configure: (request) => this.applyConfigure(request),
      compile: () => this.runCompile(),
      diff: () => this.readDiff(),
      diffRegions: (request) => this.readDiffRegions(request.side === 'base' ? 'base' : 'new'),
      diffDoc: () => this.applyDiffDoc(),
      accept: () => this.applyAccept(),
      revert: () => this.applyRevert(),
      jumpToPdf: (request) => this.view(request),
      jumpToSource: (request) => this.edit(request),
      sendError: (request) => this.handOff(request),
      editAt: (request) => this.applyEdit(request),
      binaries: async () => (await this.refreshBinaries()) ?? this.state.binaries,
    }
  }

  /** Mount the static route if the web server is known and the shape fits. */
  private mountRoutes(): void {
    if (!this.webServer || this.disposeRoute) return
    const mounts: StaticMount[] = [
      { prefix: '/pdf', dir: this.outDir, cacheable: false },
      // Packaged assets, not `process.cwd()/assets`: the viewer must be found
      // wherever DSH happens to be started from (see utils/assets.ts).
      { prefix: '/assets', dir: assetsRoot(), cacheable: true },
    ]
    const dispose = mountStaticRoute(this.webServer, mounts, createApiHandler(this.httpHost()))
    if (!dispose) {
      this.ctx.logger?.('latex-preview')?.warn?.('webServer.register unavailable; PDF will not be reachable over HTTP')
      this.patch({ message: '静态路由挂载失败：webServer 接口不匹配（见 docs/spikes.md B6）' })
      return
    }
    this.disposeRoute = dispose

    if (!viewerAvailable()) {
      this.ctx.logger?.('latex-preview')?.warn?.(
        'PDF.js assets missing at %s; the panel will fall back to the browser viewer',
        assetsRoot(),
      )
      this.patch({ message: 'PDF.js 资源缺失，已退化为浏览器内置查看器（运行 node scripts/build-assets.mjs 补齐）' })
    }
  }

  /** Release the route; safe to call twice. */
  private unmountRoutes(): void {
    this.disposeRoute?.()
    this.disposeRoute = null
  }

  /** Stop watching, if watching. */
  private async stopWatching(): Promise<void> {
    if (!this.watcher) return
    await this.watcher.stop()
    this.watcher = null
  }

  /**
   * Cordis calls this when the owning fiber unloads.
   * @returns nothing.
   */
  async [Symbol.dispose](): Promise<void> {
    this.unmountRoutes()
    await this.stopWatching()
  }
}

export default LatexPreviewService

/**
 * Whether a source line can have a box on the page.
 *
 * Judged on the *normalised* line, so a blank line and a comment-only line both
 * count as nothing to render — and `synctex view` answers for either with the
 * next rendered line's box, so "walk up to the line above the hole" must skip them
 * rather than accept that answer (docs/spikes.md §B21).
 * @param sourceLines - the revision's lines, already split.
 * @param line - 1-based line number.
 * @returns false when the line carries no typeset content.
 */
function isTypeset(sourceLines: readonly string[], line: number): boolean {
  const text = sourceLines[line - 1]
  return text !== undefined && normalizeLatexLine(text) !== ''
}

/**
 * Drop blank lines from a sampled range.
 *
 * `synctex view` has no box for an empty line and answers with the **next** rendered
 * line's box instead (measured: old line 8, a blank, came back as line 9's box),
 * so a blank line in the middle of a hunk paints an unchanged line as changed.
 * A blank line has no glyphs, so marking nothing is the truthful answer — and a
 * hunk that is *only* blanks counts as skipped rather than pointing at a neighbour.
 * @param lines - 1-based line numbers, ascending.
 * @param sourceLines - the revision's lines, already split.
 * @returns the numbers whose line is not blank.
 */
function typesetLines(lines: readonly number[], sourceLines: readonly string[]): number[] {
  return lines.filter((line) => isTypeset(sourceLines, line))
}

/**
 * Pick the lines of a range that fit the budget, spread evenly.
 *
 * A 40-line paragraph cannot cost 40 `synctex view` processes, and highlighting
 * only its top would look like the change ends early. Even sampling keeps a mark
 * near the beginning, middle, and end of the block.
 * @param first - first line, 1-based.
 * @param last - last line, inclusive.
 * @param budget - how many lines may still be resolved.
 * @returns the lines to resolve, ascending.
 */
function sampleLines(first: number, last: number, budget: number): number[] {
  const count = last - first + 1
  if (count <= budget) return Array.from({ length: count }, (_, i) => first + i)
  if (budget <= 0) return []
  const step = count / budget
  return Array.from({ length: budget }, (_, i) => first + Math.floor(i * step))
}
