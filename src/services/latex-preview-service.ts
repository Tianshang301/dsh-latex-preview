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
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { checkBinaries } from '../utils/binaries.ts'
import { isRootCandidate, listTexFiles, resolveRoot, type RootResolution } from '../utils/root.ts'
import { synctexEdit, synctexView } from '../utils/synctex.ts'
import { CompileService, compilePaths, type CompileOptions, type CompilePaths } from './compile.ts'
import { ArtifactStore, pairHashes } from './artifacts.ts'
import {
  issueTrust,
  manifestStillDescribes,
  trustCovers,
  workspaceIdOf,
  type TrustedArtifacts,
} from './provenance.ts'
import {
  acceptCurrent,
  advanceRevisions,
  diffBaseFor,
  hasPendingChanges,
  parseDiffSide,
  initialRevisions,
  type Revisions,
} from './revisions.ts'
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
  BackupResult,
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

/** Constructor options; every field is optional so `ctx.plugin(Service)` still works. */
export interface ServiceOptions {
  /**
   * Builds the compiler for a workspace.
   *
   * The only reason this exists is testability: a service-level test has to control
   * what one compile produces *and* what the source looks like when it starts and
   * finishes, which is exactly the pair of facts `CompileService.run` alone cannot
   * express.
   */
  readonly compileFactory?: (options: CompileOptions) => CompileService
}

/** Per-run overrides for one compile. */
interface RunOptions {
  /**
   * Source that produced the artefacts currently on disk, when it is not
   * `currentSource`.
   *
   * 撤销 writes the baseline back to disk *before* compiling, so the PDF being
   * replaced belongs to the revision that is being discarded — not to the source
   * that is about to be read.
   */
  readonly beforeOverride?: string | null
  /** Skip the reviewer: a revert is not a proposal, it is the undo of one. */
  readonly suppressReview?: boolean
}

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
   * **Accepted** revision — the left-hand side of the review diff (path A).
   *
   * Moves on 接受, on an approving reviewer, and on every compile while the mode is
   * `open`. In `manual` it can lag the current revision by several compiles, which
   * is the point: every change not yet accepted keeps its marks. Its artefacts live
   * in the `prev` pair, published only when this field moved to them.
   */
  private acceptedSource: string | null = null
  /**
   * Source that produced the **previous successful compile** — the left-hand side of
   * the change-since-last-save diff (path B).
   *
   * Moves on every compile whose content actually changed, whatever the review mode,
   * so it is null until a second revision has been compiled. Its artefacts live in
   * the `recent` pair and are republished on every successful compile.
   */
  private previousCompileSource: string | null = null
  /** **Current** revision: the source the PDF on screen was compiled from. */
  private currentSource: string | null = null
  /**
   * Digest of the source the accepted pair claims to describe.
   *
   * Mirrors `manifest.revisionId` of the `prev` pair. Everything that maps old line
   * numbers checks it before trusting the pair (docs/spikes.md §B23).
   */
  private baseRevisionId: string | null = null
  /**
   * Identity of the workspace the fields above describe (`rootFile` + `outDir`).
   *
   * A credential names a workspace; switching projects must therefore invalidate it
   * even when the two happen to share a source digest.
   */
  private workspaceId: string | null = null
  /**
   * Permission to publish a pair as a named revision, for the pair this process
   * produced itself.
   *
   * Null on start, after a workspace switch, and whenever a compile failed without
   * a clean rollback. Null means "publish no revision" — never "publish anyway"
   * (services/provenance.ts explains why integrity is not provenance).
   */
  private trusted: TrustedArtifacts | null = null
  /** Builds the compiler; injectable so service tests can drive real compiles. */
  private readonly compileFactory: (options: CompileOptions) => CompileService
  /** Tail of the compile queue; see {@link runCompile}. */
  private compileQueue: Promise<void> = Promise.resolve()
  private outDir: string
  /**
   * Whether {@link outDir} came from the caller.
   *
   * The constructor seeds it with `<cwd>/.latex-preview`, which is right for the
   * common case (DSH started inside the paper folder) but wrong as a *default*: a
   * workspace elsewhere must compile next to its own root file, not into whatever
   * directory DSH happens to be running from. Without this flag the seeded value
   * wins and the per-workspace fallback below never runs.
   */
  private outDirExplicit = false
  private debounceMs = DEFAULT_DEBOUNCE_MS

  constructor(ctx: Context, options: ServiceOptions = {}) {
    super(ctx, SERVICE_KEY, { namespace: SERVICE_KEY })

    this.compileFactory = options.compileFactory ?? ((compileOptions) => new CompileService(compileOptions))
    this.outDir = join(process.cwd(), '.latex-preview')
    this.compiler = this.compileFactory({
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
      recentPdfUrl: null,
      recentViewerUrl: null,
      recentRevisionId: null,
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

    const outDir =
      request.outDir ?? (this.outDirExplicit ? this.outDir : join(dirname(rootFile), '.latex-preview'))
    if (request.outDir) this.outDirExplicit = true
    this.outDir = outDir
    this.compiler = this.compileFactory({
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
    const workspace = workspaceIdOf(rootFile, outDir)
    // A credential names the workspace it was issued in: the same source digest in
    // another project says nothing about these bytes.
    if (this.workspaceId !== workspace) this.trusted = null
    this.workspaceId = workspace
    // A fresh configure starts from "what is on disk is the accepted revision and
    // the current one"; the previous-compile revision is unknown until we compile.
    this.acceptedSource = initial
    this.currentSource = initial
    this.previousCompileSource = null
    // Restore before the single state commit: the restore needs a root file that is
    // not in `state` yet, and letting it patch `state` itself is what allowed the
    // commit below to erase the result again. It returns the fields instead.
    const restored = await this.restoreArtifacts(rootFile, outDir, initial)

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
      // A workspace switch must not inherit the previous project's PDF: the panel
      // would present it as this document's output, and the automatic first compile
      // below is skipped whenever `pdfUrl` is already set.
      pdfUrl: null,
      viewerUrl: null,
      compiledAt: null,
      diagnostics: [],
      diffDocUrl: null,
      ...restored,
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
    const head = this.currentSource
    const base = diffBaseFor(this.revisions(), 'new')
    if (base === null || head === null) return []
    return lineDiff(base, head)
  }

  /**
   * Rectangles for one side of a change.
   *
   * Three sides, because the plugin keeps three revisions and two of them can be
   * shown next to what is on screen:
   *
   * | side      | left-hand side      | document drawn on        | answers                     |
   * |-----------|---------------------|--------------------------|-----------------------------|
   * | `new`     | accepted            | the live PDF             | what needs accepting        |
   * | `base`    | accepted            | the accepted pair        | where the removed text was  |
   * | `compile` | previous compile    | the recent pair          | what the last save changed  |
   *
   * `new` and `base` are the same comparison drawn on two documents (path A); a
   * deletion can only be a seam on the first and a real band on the second.
   * @param request.side - which revision to describe; defaults to `new`.
   * @param signal - client cancellation.
   * @returns regions tagged with the state version they were computed for.
   */
  @Remote
  async getDiffRegions(request: { side?: DiffSide }, signal: AbortSignal): Promise<DiffRegions> {
    signal.throwIfAborted()
    return this.readDiffRegions(parseDiffSide(request?.side))
  }

  /**
   * Body shared by the Remote method and the HTTP API.
   * @param side - which document to describe.
   * @returns regions, with a message instead of bands when that side cannot be shown.
   */
  private async readDiffRegions(side: DiffSide = 'new'): Promise<DiffRegions> {
    const version = this.state.version
    const empty: DiffRegions = { version, side, regions: [], skipped: 0 }
    const rootFile = this.state.rootFile
    const head = this.currentSource
    if (!rootFile || head === null) return empty
    const stores = this.artifactPathsNow()
    if (!stores) return empty

    // Path B compares against the previous compile, path A against the accepted
    // revision; everything else (documents, manifests) follows from that choice.
    const left = diffBaseFor(this.revisions(), side)
    if (left === null) {
      return side === 'new' ? empty : { ...empty, message: '还没有上一版可供对照' }
    }
    const hunks = diffHunks(lineDiff(left, head))
    if (hunks.length === 0) {
      return side === 'new' ? empty : { ...empty, message: '两版内容一致，没有可标的地方' }
    }

    if (side === 'new') {
      if (!this.state.pdfUrl) return empty
      return this.newRegions(version, rootFile, stores.paths.pdf, hunks, head)
    }

    // Both other sides need a *verified* pair: the manifest must exist, both files
    // must still hash to what it records, and it must name the revision we just
    // diffed against. Anything less and the line numbers would point at a document
    // that is not on screen (docs/spikes.md §B23).
    const store = side === 'base' ? stores.accepted : stores.recent
    const pdf = side === 'base' ? stores.paths.basePdf : stores.paths.recentPdf
    const manifest = await store.verify()
    if (!manifest || manifest.revisionId !== this.digestOf(left)) {
      await (side === 'base' ? this.dropBaseArtifacts() : this.dropRecentArtifacts())
      return { ...empty, message: '旧版 PDF 与其 SyncTeX 未能成对校验，无法定位被删除的内容' }
    }
    return this.baseRegions(version, side, rootFile, pdf, hunks, left)
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
    side: 'base' | 'compile',
    rootFile: string,
    basePdf: string,
    hunks: readonly DiffHunk[],
    base: string,
  ): Promise<DiffRegions> {
    // The title has to name the document the user is looking at: the same hunk is
    // "已接受版第 7 行" on one side and "上次编译版第 7 行" on the other.
    const label = side === 'base' ? '已接受版' : '上次编译版'
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
            ? `${label}第 ${anchorLine} 行之前新增了内容（那一版 PDF 里没有这段）`
            : `${label}第 ${anchorLine} 行之后新增了内容（那一版 PDF 里没有这段）`
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
      const title = hunk.preview === '' ? `${label}${where}：${what}` : `${label}${where}：${what}（${hunk.preview}）`
      for (const band of bandsFromHits(hits)) {
        regions.push({ ...band, kind, lineStart: first, lineEnd: last, title })
      }
    }

    return { version, side, regions, skipped }
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
    const base = this.acceptedSource
    const head = this.currentSource
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
    if (!hasPendingChanges(this.revisions())) {
      throw new RemoteError('latex-preview/nothing-to-review', '没有待审核的改动', {})
    }
    this.acceptedSource = this.currentSource
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
    const target = this.acceptedSource
    if (!rootFile || target === null || !hasPendingChanges(this.revisions())) {
      throw new RemoteError('latex-preview/nothing-to-review', '没有可撤回的改动', {})
    }

    await writeFile(rootFile, target, 'utf8')
    // The PDF on screen still belongs to the revision being thrown away, so the
    // compile must be told what it is replacing instead of inferring it from a
    // `currentSource` we just moved. Moving it here would also make the compile
    // look like a no-op and leave the previous-compile snapshot pointing at the
    // baseline rather than at the document the user was reading.
    const discarded = this.currentSource
    let result: CompileResult
    try {
      result = await this.runCompile({ beforeOverride: discarded, suppressReview: true })
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
    if (this.currentSource !== target) {
      // The file changed again while the revert compiled; the state now describes
      // that newer content, so calling it "rolled back" would be false.
      throw new RemoteError('latex-preview/revert-failed', '源码已回滚，但编译期间文件又被修改，屏幕上不是回滚后的版本', {
        detail: '文件在回滚编译期间被改动',
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
    const target = this.currentSource
    const base = this.acceptedSource
    if (this.reviewing || target === null || base === null || target === base) return

    this.reviewing = true
    this.patch({ message: '自动审核中：正在请独立 AI 审这次改动…' })
    try {
      const verdict = await this.runReview(base, target)
      // Another compile landed while the reviewer was thinking; that change gets
      // its own review, and applying this verdict to it would be wrong.
      if (this.currentSource !== target) return

      if (verdict.verdict === 'unavailable') {
        this.patch({ message: `自动审核不可用（${verdict.reason}），已转手动：请点「接受」或「撤销」` })
        return
      }
      if (verdict.verdict === 'accept') {
        this.acceptedSource = target
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

  /** The three snapshots as one value, for the pure revision rules. */
  private revisions(): Revisions {
    return { accepted: this.acceptedSource, previousCompile: this.previousCompileSource, current: this.currentSource }
  }

  /** Adopt a revision set produced by `revisions.ts`. */
  private applyRevisions(next: Revisions): void {
    this.acceptedSource = next.accepted
    this.previousCompileSource = next.previousCompile
    this.currentSource = next.current
  }

  /**
   * Short digest identifying a source revision.
   * @param source - full source text.
   * @returns 12 hex characters; enough to compare snapshots, not a security hash.
   */
  private digestOf(source: string): string {
    return createHash('sha1').update(source).digest('hex').slice(0, 12)
  }

  /**
   * Paths of both revision pairs, or null before a root file is known.
   * @param rootFile - workspace root; defaults to the state's.
   * @param outDir - workspace output dir; defaults to the service's.
   * @returns `{ paths, accepted, recent }` stores, or null.
   */
  private artifactPathsNow(
    rootFile: string | null = this.state.rootFile,
    outDir: string = this.outDir,
  ): { paths: CompilePaths; accepted: ArtifactStore; recent: ArtifactStore } | null {
    if (!rootFile) return null
    const paths = compilePaths(rootFile, outDir)
    return {
      paths,
      accepted: new ArtifactStore({ pdf: paths.basePdf, synctex: paths.baseSynctex, manifest: paths.baseManifest }),
      recent: new ArtifactStore({ pdf: paths.recentPdf, synctex: paths.recentSynctex, manifest: paths.recentManifest }),
    }
  }

  /**
   * Whether this process may claim `source` produced the bytes at these paths.
   *
   * The credential must name this workspace, this revision *and* these hashes. A
   * manifest alone cannot answer this: it records what the bytes were, never who
   * compiled them (services/provenance.ts).
   * @param source - revision the caller wants to name.
   * @param hashes - hashes of the files as they sit on disk right now.
   * @returns true only for an exact match.
   */
  private claimCovers(source: string | null, hashes: { pdfSha256: string; synctexSha256: string }): boolean {
    if (source === null || this.workspaceId === null) return false
    return trustCovers(this.trusted, {
      workspaceId: this.workspaceId,
      sourceDigest: this.digestOf(source),
      pdfSha256: hashes.pdfSha256,
      synctexSha256: hashes.synctexSha256,
    })
  }

  /**
   * Issue a credential for the pair currently on screen.
   *
   * Only called right after this process compiled it and confirmed the input did not
   * move; the hashes are of the files on disk, so the credential names the exact
   * bytes a later publish would install.
   * @param rootFile - workspace root.
   * @param source - source the compile read.
   * @returns the credential, or null when the pair cannot be hashed.
   */
  private async issueTrustFor(rootFile: string, source: string | null): Promise<TrustedArtifacts | null> {
    const stores = this.artifactPathsNow(rootFile)
    if (!stores || source === null || this.workspaceId === null) return null
    const hashes = await pairHashes(stores.paths.pdf, stores.paths.synctex)
    if (hashes === null) return null
    return issueTrust({
      workspaceId: this.workspaceId,
      sourceDigest: this.digestOf(source),
      pdfSha256: hashes.pdfSha256,
      synctexSha256: hashes.synctexSha256,
    })
  }

  /**
   * Publish the pair that describes the **previous compile** (diff path B).
   *
   * Three gates, all of which must pass: the backup copied both halves this run,
   * the bytes on disk hash to what the backup recorded, and this process holds a
   * credential for `before` naming exactly those hashes. Anything less and the
   * previous-compile view is withdrawn rather than drawn from a guess.
   * @param before - source that produced the artefacts now sitting in `prev`.
   * @param backup - what the compile's backup step reported.
   */
  private async publishCompileArtifacts(before: string | null, backup: BackupResult): Promise<void> {
    const stores = this.artifactPathsNow()
    if (!stores || before === null || backup.status !== 'complete') {
      await this.dropRecentArtifacts()
      return
    }
    const hashes = await pairHashes(stores.paths.prev, stores.paths.prevSynctex)
    if (
      hashes === null ||
      hashes.pdfSha256 !== backup.pdfSha256 ||
      hashes.synctexSha256 !== backup.synctexSha256 ||
      !this.claimCovers(before, hashes)
    ) {
      await this.dropRecentArtifacts()
      return
    }
    const id = this.digestOf(before)
    const ok = await stores.recent.publish({
      revisionId: id,
      pdf: stores.paths.prev,
      synctex: stores.paths.prevSynctex,
    })
    if (!ok) {
      await this.dropRecentArtifacts()
      return
    }
    this.publishRecentUrls(id)
  }

  /**
   * Keep the accepted pair honest after a compile (diff path A).
   *
   * Two cases, and they are not the same question:
   *
   * - The accepted revision **moved to** what this compile replaced (`open`, a
   *   revert, or a redundant compile): publish those bytes — but only with a
   *   credential proving this process compiled them, for the same reason as above.
   * - It did not (`manual`/`auto` with a pending change): the pair already on disk
   *   still describes the accepted revision, because compiles no longer overwrite
   *   it. Keep it when its manifest still names that revision — dropping it would
   *   take away the one document where removed text is still typeset.
   * @param expected - source that produced the artefacts in the `prev` copies.
   * @param backup - what the compile's backup step reported.
   */
  private async adoptBaseArtifacts(expected: string | null, backup: BackupResult): Promise<void> {
    const stores = this.artifactPathsNow()
    const accepted = this.acceptedSource
    if (!stores || accepted === null) {
      await this.dropBaseArtifacts()
      return
    }
    const id = this.digestOf(accepted)

    if (expected !== null && accepted === expected && backup.status === 'complete') {
      const hashes = await pairHashes(stores.paths.prev, stores.paths.prevSynctex)
      const proven =
        hashes !== null &&
        hashes.pdfSha256 === backup.pdfSha256 &&
        hashes.synctexSha256 === backup.synctexSha256 &&
        this.claimCovers(accepted, hashes)
      if (proven) {
        const ok = await stores.accepted.publish({
          revisionId: id,
          pdf: stores.paths.prev,
          synctex: stores.paths.prevSynctex,
        })
        if (!ok) {
          await this.dropBaseArtifacts()
          return
        }
        this.publishBaseUrls(id)
        return
      }
      // Those bytes may still be the accepted revision even though this process
      // cannot re-attest them — it is a restart, and the pair was published by the
      // process that compiled it. Fall through to the manifest check instead of
      // deleting a pair that is still correct.
    }

    const manifest = await stores.accepted.verify()
    if (manifestStillDescribes(manifest, id)) this.publishBaseUrls(id)
    else await this.dropBaseArtifacts()
  }

  /**
   * Replace the accepted pair with the artefacts currently on screen.
   *
   * Used when the baseline catches up with what is displayed (接受, an approving
   * reviewer): the current PDF *is* the baseline then, so it can be installed
   * without a second compile — provided this process compiled it, which is what the
   * credential says.
   */
  private async snapshotBaseFromCurrent(): Promise<void> {
    const stores = this.artifactPathsNow()
    const source = this.acceptedSource
    if (!stores || source === null) {
      await this.dropBaseArtifacts()
      return
    }
    const hashes = await pairHashes(stores.paths.pdf, stores.paths.synctex)
    if (hashes === null || !this.claimCovers(source, hashes)) {
      // The PDF is on screen but nobody can say which revision produced it, so it
      // must not be promoted to a baseline that later line-number lookups trust.
      await this.dropBaseArtifacts()
      return
    }
    const id = this.digestOf(source)
    const ok = await stores.accepted.publish({ revisionId: id, pdf: stores.paths.pdf, synctex: stores.paths.synctex })
    if (!ok) {
      await this.dropBaseArtifacts()
      return
    }
    this.publishBaseUrls(id)
  }

  /** Forget the accepted pair: its revision can no longer be mapped honestly. */
  private async dropBaseArtifacts(): Promise<void> {
    const stores = this.artifactPathsNow()
    if (stores) await stores.accepted.drop()
    this.patch({ basePdfUrl: null, baseViewerUrl: null, baseRevisionId: null })
  }

  /** Forget the previous-compile pair. */
  private async dropRecentArtifacts(): Promise<void> {
    const stores = this.artifactPathsNow()
    if (stores) await stores.recent.drop()
    this.patch({ recentPdfUrl: null, recentViewerUrl: null, recentRevisionId: null })
  }

  /** Mirror a published pair into the state as URLs the panel can use. */
  private publishBaseUrls(id: string): void {
    this.patch(this.urlsFor(id, 'base'))
  }

  /** Mirror the previous-compile pair into the state. */
  private publishRecentUrls(id: string): void {
    this.patch(this.urlsFor(id, 'recent'))
  }

  /**
   * Build the state patch for one published pair.
   * @param id - revision digest, used as the cache-busting version.
   * @param tag - which pair; selects the field names and the file name.
   * @returns the fields to patch.
   */
  private urlsFor(id: string, tag: 'base' | 'recent'): Partial<PreviewState> {
    const stores = this.artifactPathsNow()
    if (!stores) return {}
    return this.urlsAt(stores, id, tag)
  }

  /**
   * Same as {@link urlsFor}, for a workspace that is not in `state` yet.
   * @param stores - the workspace's paths.
   * @param id - revision digest.
   * @param tag - which pair.
   * @returns the fields to publish.
   */
  private urlsAt(
    stores: { paths: CompilePaths },
    id: string,
    tag: 'base' | 'recent',
  ): Partial<PreviewState> {
    const file = tag === 'base' ? stores.paths.basePdf : stores.paths.recentPdf
    const route = `${ROUTE_PREFIX}/pdf/${encodeURIComponent(basename(file))}`
    const viewer = viewerAvailable()
      ? `${ROUTE_PREFIX}${VIEWER_PATH}?file=${encodeURIComponent(route)}&v=${id}`
      : null
    return tag === 'base'
      ? { basePdfUrl: `${route}?v=${id}`, baseViewerUrl: viewer, baseRevisionId: id }
      : { recentPdfUrl: `${route}?v=${id}`, recentViewerUrl: viewer, recentRevisionId: id }
  }

  /**
   * What the artefacts on disk are allowed to claim, at configure time.
   *
   * A manifest survives a restart, so an accepted pair can be picked up again — but
   * only when its recorded `revisionId` is the digest of the source we just adopted.
   * Anything else is deleted rather than shown against line numbers it does not
   * describe. A previous-compile pair is never restored: which revision it holds is
   * known only to the process that compiled it.
   *
   * Returns the state fields instead of patching them: `applyConfigure` is about to
   * commit one snapshot, and a restore that patched on its own would be erased by
   * that commit — which is exactly what used to happen.
   * @param rootFile - workspace root.
   * @param outDir - workspace output dir.
   * @param source - the accepted revision.
   * @returns the publication fields for the configuration snapshot.
   */
  private async restoreArtifacts(rootFile: string, outDir: string, source: string | null): Promise<Partial<PreviewState>> {
    const vanished: Partial<PreviewState> = {
      basePdfUrl: null,
      baseViewerUrl: null,
      baseRevisionId: null,
      recentPdfUrl: null,
      recentViewerUrl: null,
      recentRevisionId: null,
    }
    const stores = this.artifactPathsNow(rootFile, outDir)
    if (!stores || source === null) {
      if (stores) {
        await stores.accepted.drop()
        await stores.recent.drop()
      }
      return vanished
    }
    await stores.recent.drop()

    const digest = this.digestOf(source)
    const manifest = await stores.accepted.verify()
    if (!manifestStillDescribes(manifest, digest)) {
      await stores.accepted.drop()
      return vanished
    }
    return this.urlsAt(stores, digest, 'base')
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

  /**
   * Serialise compiles, then run one.
   *
   * `CompileService.run` already single-flights the *process*, but this method also
   * moves the revision snapshots and publishes artefacts — and two interleaved
   * bookkeepings are not the same thing as one. A watcher that fires twice for a
   * single save produced exactly that: the second run copied the PDF the first had
   * just written, published it under the older revision, and the first run's publish
   * was then dropped as stale. One at a time is the only way the snapshots and the
   * pairs stay in step.
   * @param run - caller overrides; see {@link RunOptions}.
   * @returns the compile result, with its URL filled in.
   */
  private runCompile(run: RunOptions = {}): Promise<CompileResult> {
    const next = this.compileQueue.then(
      () => this.compileOnce(run),
      () => this.compileOnce(run),
    )
    this.compileQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * One compile, with state transitions around it.
   * @param run - caller overrides; see {@link RunOptions}.
   * @returns the compile result, with its URL filled in.
   */
  private async compileOnce(run: RunOptions = {}): Promise<CompileResult> {
    const rootFile = this.state.rootFile
    if (!rootFile) {
      throw new RemoteError('latex-preview/no-root-file', 'nothing configured', { hint: '先调用 configure' })
    }
    if (!this.state.binaries.tectonic) {
      throw new RemoteError('latex-preview/binary-missing', 'tectonic is not available', { missing: ['tectonic'] })
    }

    // What the artifacts on disk describe *before* this compile overwrites them.
    // Not always what `currentSource` says: 撤销 writes the file back first, and the
    // PDF on screen still belongs to the revision it is throwing away.
    const before = run.beforeOverride !== undefined ? run.beforeOverride : this.currentSource
    // The input the compiler is about to read. Comparing it with the file after the
    // run is the only way to notice an edit that landed mid-compile: the PDF then
    // belongs to neither snapshot, and must not be given a credential.
    const input = await this.readSource(rootFile)
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

    const compiled = result.ok ? await this.readSource(rootFile) : null
    // A compile is only as trustworthy as its input: if the file changed while the
    // compiler had it open, the PDF corresponds to neither the before- nor the
    // after-snapshot.
    const stable = result.ok && compiled !== null && compiled === input
    let contentChanged = false

    if (result.ok) {
      // Advance only when the content actually moved. A redundant compile (the user
      // pressing 编译 twice, or the watcher reporting one save) must not erase the
      // marks they are looking at, and it must not republish "上次编译" either: the
      // last compile before the current one is still the answer, and overwriting it
      // with the revision that is already on screen loses the comparison.
      const advanced = stable && compiled !== null ? advanceRevisions(this.revisions(), compiled, this.review) : null
      if (advanced?.changed) {
        // Publish before advancing: the credential that authorises the pre-compile
        // copies describes the bytes that were on screen a moment ago, and the
        // advance is what decides whether those bytes also become a baseline.
        await this.publishCompileArtifacts(before, result.backup)
        this.applyRevisions(advanced.revisions)
        contentChanged = true
        if (this.review === 'auto' && run.suppressReview !== true) void this.queueReview()
      }
      await this.adoptBaseArtifacts(before, result.backup)
      // The credential for the bytes now on screen. Withheld when the input moved:
      // an unprovable pair is exactly what must never be published later.
      this.trusted = stable ? await this.issueTrustFor(rootFile, compiled) : null
    } else if (result.rollbackIncomplete) {
      // The PDF on screen and the sync map behind it may now disagree, so neither
      // old-revision view can be trusted for this state — nor the pair itself.
      this.trusted = null
      await this.dropBaseArtifacts()
      await this.dropRecentArtifacts()
    }

    if (result.ok && !stable) {
      // Converge: the edit that landed mid-compile is now on disk, and the PDF on
      // screen predates it.
      void this.runCompile().catch(() => undefined)
    }

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
      message: this.describe(result, stable),
    })
    return { ...result, pdfUrl }
  }

  /** One-line status for the panel. */
  private describe(result: CompileResult, stable = true): string {
    if (result.ok) {
      return stable
        ? `编译成功（${(result.durationMs / 1000).toFixed(1)}s）`
        : `编译成功（${(result.durationMs / 1000).toFixed(1)}s），但编译期间源码又变了，正在重新编译`
    }
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
      diffRegions: (request) => this.readDiffRegions(parseDiffSide(request.side)),
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
      // A getter, not a snapshot: `outDir` follows the configured workspace.
      { prefix: '/pdf', dir: () => this.outDir, cacheable: false },
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
