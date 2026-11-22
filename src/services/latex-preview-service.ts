/**
 * The one Host service the client half talks to.
 *
 * Shape follows the Typert Remote contract (verified 2026-11-16 against
 * `@deepseek-ai/dsh-typert-protocol@0.2.2-rc.5`):
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
import { basename, dirname, extname, join, resolve } from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { checkBinaries, type BinaryReport } from '../utils/binaries.ts'
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
import { PathLeaseRegistry } from './path-lease.ts'
import {
  diffBuildInput,
  sameBuildInput,
  scanBuildInput,
  type BuildInputManifest,
  type InputDiff,
} from './build-input.ts'
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
    'latex-preview/artifact-busy': { readonly detail: string }
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

/**
 * How many convergence recompiles one request may trigger.
 *
 * A compile whose input moved under it is re-run to show the edit that landed
 * mid-flight — and a save that lands during *every* run (a formatter, a sync tool,
 * the user holding Ctrl+S) would otherwise recompile for ever with no credential
 * ever issued. Two extra runs is enough to converge on a settled file and small
 * enough that the panel is never stuck on "正在编译" because of a loop.
 */
const MAX_CONVERGE = 2

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
  /**
   * Replaces the `tectonic` / `synctex` probe.
   *
   * The real probe spawns processes with a 10 s budget, so a test that patches the
   * flags can be overwritten by the probe landing later — the failure looks like
   * "the compile never ran" and only shows up on a slower machine. Injecting the
   * answer removes the race instead of waiting for it.
   */
  readonly binaryProbe?: () => Promise<BinaryReport>
  /**
   * Called after the compiler returns and the run is still current, before anything
   * is published.
   *
   * Exists so a test can hold a run exactly in the window that used to be unguarded:
   * the `workspace` check has passed, but `readSource`, the two publishes and the
   * credential have not happened yet. Same rationale as {@link compileFactory} —
   * the seam is a position in time, and nothing else can produce it on demand.
   */
  readonly onRunReturned?: (workspace: { id: string; generation: number }) => Promise<void>
  /**
   * Builds the diff-document service for a workspace.
   *
   * Same rationale as {@link compileFactory}: a test has to hold a diff *build* —
   * which reads the live pair for up to two minutes — in a chosen instant, and no
   * other seam can park it. It is also the reader the path lease's read mode exists
   * for, so the lease tests need to be able to make it slow.
   */
  readonly diffDocFactory?: (options: {
    rootFile: string
    outDir: string
    timeoutMs: number
    firstRunTimeoutMs: number
  }) => DiffDocService
  /**
   * Scans the files one compile is about to read.
   *
   * Same rationale as {@link binaryProbe}: an injected *answer* rather than a mocked
   * module. Two behaviours of the wiring cannot be produced from a real directory —
   * a scan that throws (the fail-open path must still publish) and a scan that is
   * slow enough for a `configure` to land in the middle of it.
   */
  readonly buildInputScanner?: (rootFile: string, outDir: string) => Promise<BuildInputManifest>
}

/**
 * One configured workspace, captured as a value.
 *
 * The compiler, the directory and the identity always belong together: a half-applied
 * `configure` used to be observable (new compiler, old root file), and a compile that
 * started in one workspace could publish its artefacts into another's store, because
 * every step re-read `this.outDir` / `this.state.rootFile` at the moment it needed
 * them. Replacing the whole object at once gives a compile one thing to hold on to
 * and one identity to compare against when it finishes.
 */
interface Workspace {
  /** Bumped on every switch; a compile whose generation is stale publishes nothing. */
  readonly generation: number
  /** `workspaceIdOf(rootFile, outDir)`, the identity a credential is bound to. */
  readonly id: string
  readonly rootFile: string
  readonly outDir: string
  readonly compiler: CompileService
}

/**
 * A workspace plus the paths derived from it, resolved once.
 *
 * Every operation that writes artefacts or a credential takes one of these instead
 * of reading `this.state.rootFile` / `this.workDir`. Those two fields describe the
 * *current* configuration, so reading them from inside a task that started earlier
 * is how a compile of A ended up publishing into B's directory after a switch — the
 * identity and the paths must travel together or not at all.
 */
interface WorkspaceContext {
  readonly workspace: Workspace
  readonly paths: CompilePaths
}

/**
 * One compile, as a value: which workspace, where its files are, what was on disk
 * and in the editor when the process started, and the version state it must not read
 * again.
 *
 * The three extra fields are snapshots, not conveniences. `revisions` is what the
 * compile is allowed to advance from; reading `this.revisions()` after the process
 * returns means a 接受 that landed in between is silently overwritten by an older
 * view. `review` decides whether a change is auto-reviewed. `trusted` is the
 * credential for the bytes being replaced — the one this run's publish is allowed to
 * rely on, even if a later compile has already replaced `this.trusted`.
 */
interface BuildContext extends WorkspaceContext {
  /** Source that produced the artefacts this run is about to overwrite. */
  readonly before: string | null
  /** Source the compiler read, as re-read just before it started. */
  readonly input: string | null
  /**
   * Every file the document pulls in, as hashed just before the run.
   *
   * A snapshot like the rest: re-scanning afterwards is the *second* half of the
   * comparison, never a replacement for this one — two scans of two different graphs
   * would agree with each other and disagree with the compiler. `null` means the scan
   * failed, and `stable` degrades to the root-only comparison (see
   * {@link compileOnce}).
   */
  readonly inputManifest: BuildInputManifest | null
  /** The three revisions as they stood when the run started. */
  readonly revisions: Revisions
  /** The review gate in force when the run started. */
  readonly review: ReviewMode
  /** Credential for `before`'s bytes, as it stood when the run started. */
  readonly trusted: TrustedArtifacts | null
}

/**
 * What one artefact operation achieved.
 *
 * `null` used to mean all three of "nothing to publish", "the pair was withdrawn" and
 * "the workspace is gone", and the caller could not tell them apart — which is how a
 * stale run kept working after its workspace had been replaced.
 */
type StoreOutcome =
  /** A pair is published and its URLs are in the state. */
  | 'published'
  /** Nothing could be vouched for, so the pair was withdrawn. */
  | 'withdrawn'
  /** The workspace changed; no further operation may start. */
  | 'stale'

/**
 * A claim on one artifact path set, held for the life of a task.
 *
 * The key is the resolved `main.pdf`; every other name in the set (`prev`, `recent`,
 * the sync maps, the manifests) derives from the same stem and directory, so one key
 * covers all of them.
 *
 * `mode` is what the task does with those files, and it matters: two diff builds may
 * read the live PDF at once, but nothing may write while anything reads. `running`
 * separates a **reservation** — a task sitting in the queue, which will write later —
 * from a task that is inside its I/O right now. The two questions the registry answers
 * need exactly that distinction:
 *
 * - "may a configure restore here?" — no if *any* lease exists, because a queued task
 *   will write and a running one is reading;
 * - "is anyone touching these files this instant?" — only running leases count, and a
 *   task comparing against them must exclude its own.
 */
interface PathLease {
  /** `resolve(paths.pdf)`. */
  readonly key: string
  /** Identity, so a task can exclude itself rather than deadlocking on its own lease. */
  readonly owner: symbol
  readonly mode: 'read' | 'write'
  /** False while the task is still queued: a reservation, not I/O. */
  running: boolean
}

/** A lease plus the two operations its holder needs. */
interface HeldLease {
  readonly lease: PathLease
  /** Declare that this task's I/O is starting (it has left the queue). */
  begin(): void
  /** Drop the claim; idempotent, and safe to call from a `finally`. */
  release(): void
}

/** A workspace that is ready to become the active one, and nothing else. */
interface PreparedWorkspace {
  readonly workspace: Workspace
  readonly initial: string | null
  readonly resolution: RootResolution | null
  /**
   * State fields for the accepted pair; empty on a settings refresh.
   *
   * `null` means the restore was **deferred**: the candidate writes over the file
   * names the active workspace is using right now, so its restore has to wait until
   * no compile can be writing there (see {@link artifactPathsBusy}).
   */
  readonly restored: Partial<PreviewState> | null
  readonly diffDoc: DiffDocService
  /** Same workspace, same source: keep the PDF, the pairs and the revisions. */
  readonly refresh: boolean
  /** Whether the caller named the output directory. */
}

/** The two revision pairs that live in one path set. */
interface Stores {
  readonly paths: CompilePaths
  readonly accepted: ArtifactStore
  readonly recent: ArtifactStore
}

/** What one `configure` call may carry; every field is optional. */
interface ConfigureRequest {
  /** A file inside the project; used to resolve the root when `rootFile` is absent. */
  readonly file?: string
  /** Explicit root `.tex`. */
  readonly rootFile?: string
  /** Explicit output directory; its absence means "next to the root file". */
  readonly outDir?: string
  /** Redact file contents before they reach an Agent. */
  readonly redact?: boolean
  /** Which review gate new changes pass through. */
  readonly review?: ReviewMode
  /** Watcher debounce, in milliseconds. */
  readonly debounceMs?: number
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
  /** How many convergence recompiles this request has already spent. */
  readonly converge?: number
}

export class LatexPreviewService extends TypertRemoteService {
  private state: PreviewState
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
  /**
   * The workspace whose change is being reviewed, if any.
   *
   * Per workspace, not a global boolean: a review for A can legitimately run while B
   * is being reviewed after a switch (both verdicts are re-checked against their
   * workspace before they touch anything), but the *same* workspace must not start a
   * second review while one is in flight. The old single boolean silently skipped
   * B's review entirely whenever A's was still running.
   */
  private reviewing: Workspace | null = null
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
  /** Answers "are the binaries there"; injectable so tests are not racing a spawn. */
  private readonly binaryProbe: () => Promise<BinaryReport>
  /** Optional pause between the compiler returning and the first publish. */
  private readonly onRunReturned?: (workspace: { id: string; generation: number }) => Promise<void>
  /** Hashes what a compile is about to read; injectable so the fail-open path is testable. */
  private readonly buildInputScanner: (rootFile: string, outDir: string) => Promise<BuildInputManifest>
  /** Builds the diff-document service; injectable so tests can hold a build mid-read. */
  private readonly diffDocFactory: (options: {
    rootFile: string
    outDir: string
    timeoutMs: number
    firstRunTimeoutMs: number
  }) => DiffDocService
  /** Tail of the lifecycle queue: compiles, 接受, 撤销 and reviewer verdicts. */
  private lifecycleQueue: Promise<void> = Promise.resolve()
  /**
   * Who holds which artifact paths, queued or running.
   *
   * The queue serialises the *bookkeeping*, but `configure` is not in it, so a
   * restore could otherwise delete pairs under a compile that is still writing to the
   * same names — and the window that mattered was not "is the active workspace using
   * this path" but "is any task, current or stale, still going to write it". The
   * registry is keyed by resolved PDF path; see {@link PathLease}.
   */
  private readonly leases = new Map<string, Set<PathLease>>()
  /**
   * The lock behind the registry: this is what *waits*.
   *
   * The registry above only answers "are these paths spoken for" — it made a writer
   * meeting a reader refuse outright (`artifact-busy`) and a reader meeting a writer
   * read bytes that were mid-flight. This lock is FIFO, reader-writer: writers wait
   * for readers to drain, readers wait for writers, and both are granted in arrival
   * order so neither side can starve the other.
   */
  private readonly ioLock = new PathLeaseRegistry()
  /** Tail of the configure queue; see {@link applyConfigure}. */
  private configureQueue: Promise<unknown> = Promise.resolve()
  /** The configured workspace; null until `configure` has run. */
  private workspace: Workspace | null = null
  /** Generation counter for {@link workspace}. */
  private workspaceGeneration = 0
  /**
   * Whether the output directory came from the caller.
   *
   * The constructor seeds it with `<cwd>/.latex-preview`, which is right for the
   * common case (DSH started inside the paper folder) but wrong as a *default*: a
   * workspace elsewhere must compile next to its own root file, not into whatever
   * directory DSH happens to be running from. Without this flag the seeded value
   * wins and the per-workspace fallback below never runs.
   */
  private debounceMs = DEFAULT_DEBOUNCE_MS

  constructor(ctx: Context, options: ServiceOptions = {}) {
    super(ctx, SERVICE_KEY, { namespace: SERVICE_KEY })

    this.compileFactory = options.compileFactory ?? ((compileOptions) => new CompileService(compileOptions))
    this.binaryProbe = options.binaryProbe ?? checkBinaries
    this.onRunReturned = options.onRunReturned
    this.buildInputScanner =
      options.buildInputScanner ?? ((rootFile, outDir) => scanBuildInput(rootFile, { outDir }))
    this.diffDocFactory =
      options.diffDocFactory ??
      ((diffOptions) => new DiffDocService(diffOptions))

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

  /** Directory the current workspace compiles into (the process default before configure). */
  private get workDir(): string {
    return this.workspace?.outDir ?? join(process.cwd(), '.latex-preview')
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
  async configure(request: ConfigureRequest, signal: AbortSignal): Promise<PreviewState> {
    signal.throwIfAborted()
    return this.applyConfigure(request)
  }

  /** Shared configure body: the Remote method and the HTTP API both land here. */
  private applyConfigure(request: ConfigureRequest): Promise<PreviewState> {
    // One configure at a time. The body awaits root resolution, a source read and an
    // artefact restore, and it assigns `this.workspace` in the middle of that: two
    // overlapping calls used to interleave into "workspace = B, state.rootFile = A",
    // the same half-applied configuration the Workspace value exists to prevent.
    const next = this.configureQueue.then(
      () => this.configureOnce(request),
      () => this.configureOnce(request),
    )
    this.configureQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /** The configure body itself; {@link applyConfigure} serialises it. */
  private async configureOnce(request: ConfigureRequest): Promise<PreviewState> {
    // The switches land in locals first: a configuration that fails while resolving
    // or restoring must not have changed how the *running* workspace behaves.
    const redact = typeof request.redact === 'boolean' ? request.redact : this.redact
    const review =
      request.review === 'manual' || request.review === 'auto' || request.review === 'open'
        ? request.review
        : this.review
    const debounceMs =
      typeof request.debounceMs === 'number' && request.debounceMs >= 0
        ? Math.min(5000, Math.max(0, request.debounceMs))
        : this.debounceMs

    // Nothing is assigned to `this` until the candidate is fully prepared, so there is
    // no moment at which the service holds a half-initialised workspace — the state
    // that used to be reachable while `restoreArtifacts` was still running.
    const prepared = await this.prepareWorkspace(request)
    if (!prepared) return this.state
    return this.activateWorkspace(prepared, { redact, review, debounceMs })
  }

  /**
   * Resolve, read and restore a candidate workspace without touching the active one.
   *
   * Every write here is confined to the candidate's own `outDir`. If anything throws
   * or the root cannot be resolved, the workspace on screen is untouched — the
   * previous version assigned `this.workspace` first and restored afterwards, so a
   * failed restore left a live workspace whose artefacts nobody had verified.
   * @param request - what the caller asked for.
   * @returns the candidate, or null when the request resolved to "no workspace".
   */
  private async prepareWorkspace(request: ConfigureRequest): Promise<PreparedWorkspace | null> {
    let rootFile = request.rootFile ?? null
    let resolution: RootResolution | null = null
    if (!rootFile && !request.file && this.workspace !== null) {
      // A request with no file at all is a *settings* change (`{ review }`,
      // `{ redact }`), and the document it applies to is the one on screen. Falling
      // through to the process directory instead would abandon a workspace the caller
      // never asked to leave — and with it the published pairs.
      rootFile = this.workspace.rootFile
    }
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
        return null
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
        return null
      }
    }

    if (!rootFile) {
      throw new RemoteError('latex-preview/no-root-file', 'rootFile is required', {
        hint: '面板需要知道哪个 .tex 是主文件；可传 rootFile，或传一个 file 让服务自行解析',
      })
    }

    // One spelling per document. A caller may pass `paper/./main.tex` or a relative
    // path; resolving here makes the identity (`workspaceIdOf`) and the comparison
    // below agree about what "the same file" means.
    const root = resolve(rootFile)
    const current = this.workspace
    // An explicit `outDir` belongs to the **root file** it was given for, not to the
    // process. Making it sticky meant `configure(A, outDir=X)` followed by
    // `configure(B)` wrote B's artefacts into X — a directory that already holds A's —
    // and B's restore then deleted A's pairs by name. Reusing the current directory
    // only while the root file is unchanged keeps a settings refresh a refresh
    // (`panel.tsx` never sends `outDir`), without leaking across projects.
    const outDir = resolve(
      request.outDir ?? (current !== null && resolve(current.rootFile) === root ? current.outDir : join(dirname(root), '.latex-preview')),
    )
    const compiler = this.compileFactory({
      rootFile: root,
      outDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstRunTimeoutMs: DEFAULT_FIRST_RUN_TIMEOUT_MS,
    })
    const diffDoc = this.diffDocFactory({
      rootFile: root,
      outDir,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      firstRunTimeoutMs: DEFAULT_FIRST_RUN_TIMEOUT_MS,
    })
    const initial = await this.readSource(root)
    const id = workspaceIdOf(root, outDir)
    const workspace: Workspace = {
      generation: this.workspaceGeneration + 1,
      id,
      rootFile: root,
      outDir,
      compiler,
    }

    // A repeat configure of the same workspace with the same source is a settings
    // refresh, not a new revision: the PDF, both published pairs and the three
    // revisions stay. Restoring artefacts here would delete the previous-compile
    // pair, whose wording nobody could recover (the text behind it is not stored).
    const refresh = this.workspace?.id === id && initial !== null && initial === this.currentSource
    if (refresh) {
      return { workspace, initial, resolution, restored: {}, diffDoc, refresh }
    }
    // Restore against the candidate's own paths — but only while nothing else is
    // writing to them. A different `outDir`, or a different root file in the same
    // `outDir`, produces a different file name, and then the prepare step is genuinely
    // isolated. When the names *are* spoken for — by the active workspace, by a
    // compile that is still writing, or by a task still queued for those names — a
    // restore now would delete pairs under that writer, so it moves behind the queue.
    if (this.artifactPathsBusy(workspace)) {
      return { workspace, initial, resolution, restored: null, diffDoc, refresh: false }
    }
    // Hold the candidate's paths for the duration: a compile queued while this restore
    // runs must see the claim rather than start writing into files being deleted.
    const held = this.holdLease(compilePaths(root, outDir), 'write')
    held.begin()
    try {
      const restored = await this.restoreArtifacts(root, outDir, initial, held.lease)
      return { workspace, initial, resolution, restored, diffDoc, refresh: false }
    } finally {
      held.release()
    }
  }

  /**
   * Make a prepared workspace the active one.
   *
   * The assignment block has no `await` in it, so no compile can observe half a
   * switch: either the old workspace is current or the new one is.
   * @param prepared - the candidate from {@link prepareWorkspace}.
   * @param options - the switches that were only committed because preparation worked.
   * @returns the state after activation.
   */
  private async activateWorkspace(
    prepared: PreparedWorkspace,
    options: { redact: boolean; review: ReviewMode; debounceMs: number },
  ): Promise<PreviewState> {
    if (prepared.restored === null) {
      // The candidate's artifact names are spoken for, so its restore — which deletes
      // both pairs by name — must not run while something is writing there.
      // `configure` stays out of the queue in general (a first compile takes minutes),
      // but a colliding restore joins it: the switch is then ordered against the writer
      // instead of racing it over the same files. The lease is taken here, before the
      // task is queued, so the claim covers the waiting period too.
      const paths = this.pathsOf(prepared.workspace)
      return this.enqueueLeased(paths, 'write', (lease) => this.commitActivation(prepared, options, lease))
    }
    return this.commitActivation(prepared, options)
  }

  /**
   * Make a prepared workspace the active one, restoring its artefacts first.
   *
   * The assignment block has no `await` in it, so no compile can observe half a
   * switch: either the old workspace is current or the new one is.
   * @param prepared - the candidate from {@link prepareWorkspace}.
   * @param options - the switches that were only committed because preparation worked.
   * @returns the state after activation.
   */
  private async commitActivation(
    prepared: PreparedWorkspace,
    options: { redact: boolean; review: ReviewMode; debounceMs: number },
    self?: PathLease,
  ): Promise<PreviewState> {
    const { workspace, initial, diffDoc, resolution } = prepared
    this.redact = options.redact
    this.review = options.review
    this.debounceMs = options.debounceMs

    // Before the assignment block, because stopping is asynchronous and the old
    // watcher must not be able to fire once the new workspace is live.
    await this.stopWatching()
    // Deferred restores run here, with the queue held and this task's own lease already
    // in the registry: `self` is what keeps that claim from reading as a conflict.
    const restored =
      prepared.restored ?? (await this.restoreArtifacts(workspace.rootFile, workspace.outDir, initial, self))

    // Read before the assignment below, or it compares the new workspace with itself.
    const sameWorkspace = this.workspace?.id === workspace.id
    this.workspaceGeneration = workspace.generation
    this.workspace = workspace
    this.diffDoc = diffDoc
    if (prepared.refresh) {
      // Nothing about the document changed; only the settings and the watcher.
      this.patch({ watching: true, redact: this.redact, message: '配置已更新（同一工作区）' })
      this.startWatcher(workspace)
      return this.state
    }

    this.acceptedSource = initial
    this.currentSource = initial
    this.previousCompileSource = null
    // A credential names the workspace it was issued in: the same source digest in
    // another project says nothing about these bytes.
    if (!sameWorkspace) this.trusted = null
    this.patch({
      rootFile: workspace.rootFile,
      status: 'idle',
      message: resolution?.message ?? `已配置主文件：${workspace.rootFile}`,
      rootCandidates: resolution?.candidates ?? [workspace.rootFile],
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

    this.startWatcher(workspace)

    // First view of a workspace has no PDF yet; without this the panel stays
    // empty until the user presses 编译. Failures are already surfaced through
    // `runCompile`'s state patch, so a rejected promise here adds nothing.
    if (!this.state.pdfUrl) {
      void this.runCompile({}, workspace).catch(() => undefined)
    }
    return this.state
  }

  /**
   * Watch the workspace that is being activated.
   *
   * The handler passes *its* workspace, so a change event queued before a switch
   * cannot compile the workspace that replaced it.
   * @param workspace - the workspace this watcher belongs to.
   */
  private startWatcher(workspace: Workspace): void {
    this.watcher = new FileWatcher({
      dirs: [dirname(workspace.rootFile)],
      outDir: workspace.outDir,
      debounceMs: this.debounceMs,
      onChange: () => {
        if (this.workspace !== workspace) return
        void this.runCompile({}, workspace).catch(() => undefined)
      },
    })
    this.watcher.start()
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
    const ctx = this.currentContext()
    if (!ctx) return empty
    const stores = this.storesOf(ctx.paths)

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
      await (side === 'base' ? this.dropBaseArtifacts(ctx) : this.dropRecentArtifacts(ctx))
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
          hits.push(...(await synctexView(rootFile, line, pdf, { cwd: this.workDir })))
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
        hits.push(...(await synctexView(rootFile, line, basePdf, { cwd: this.workDir })))
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
    // A context, not a set of loose reads: the build can take two minutes, and the
    // result must land in the workspace that asked for it or nowhere.
    const ctx = this.currentContext()
    const base = this.acceptedSource
    const head = this.currentSource
    if (!ctx || !this.diffDoc || base === null || head === null) {
      return { ok: false, url: this.state.diffDocUrl, message: '尚未配置主文件，无法生成对比视图', version: this.state.version }
    }
    if (base === head) {
      return { ok: false, url: null, message: '没有可对比的改动（当前版与已接受版一致）', version: this.state.version }
    }

    // A **read** lease: the build reads the live pair and both sync maps, so a compile
    // or a restore must not run beside it — but another reader may. It is not a writer,
    // and treating it as one would serialise every diff build behind every compile.
    // The lock is what waits: this call sits outside the lifecycle queue, so a writer
    // that arrives first is waited for, not raced and not refused.
    const held = this.holdLease(ctx.paths, 'read')
    const ticket = await this.ioLock.acquire(held.lease.key, 'read')
    held.begin()
    let build: Awaited<ReturnType<DiffDocService['build']>>
    try {
      build = await this.diffDoc.build(base, head)
    } finally {
      ticket.release()
      held.release()
    }
    // Path leases keep two tasks off the same files; they say nothing about *whose*
    // result this is. Three things can move under a two-minute build: the workspace
    // (a switch), the accepted revision (接受, an approving reviewer, 撤销) and the
    // current one (another compile). Any of them makes this answer describe a pair of
    // revisions nobody can see, so it is dropped rather than written into a state that
    // has already moved on.
    if (!this.isCurrent(ctx)) {
      return { ok: false, url: this.state.diffDocUrl, message: '工作区已切换，本次对比视图未生成', version: this.state.version }
    }
    if (this.acceptedSource !== base || this.currentSource !== head) {
      return { ok: false, url: this.state.diffDocUrl, message: '对比基准已变化（编译或接受），请重新生成对比视图', version: this.state.version }
    }
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
    return this.acceptQueued()
  }

  /**
   * Queue one acceptance.
   *
   * Both faces come through here — the Remote method and the same-origin HTTP route.
   * The route used to call {@link applyAccept} directly, which put a revision change
   * next to a running compile: accepting reads the PDF *on disk* and promotes it, so
   * a compile that has already written its new bytes but not yet published them hands
   * the acceptance a PDF its credential does not describe. The pair is then refused
   * and the baseline deleted — an accept that silently destroyed the comparison.
   * @returns the state after acceptance.
   */
  private acceptQueued(): Promise<PreviewState> {
    // The click belongs to the workspace that was on screen; a switch between the click
    // and the queue task must not accept the new project's pending change.
    const workspace = this.workspace
    return this.enqueueLeased(this.pathsOf(workspace), 'write', () => this.applyAccept(workspace))
  }

  /**
   * Shared acceptance body.
   *
   * Runs on the lifecycle queue, so no compile can be between its own two halves
   * while this reads the pair. The revision is passed explicitly instead of being
   * read out of `this` by the helper: `acceptedSource` is the answer this call is
   * *producing*, and a run that lost its workspace must not relabel the new one.
   * @returns the state after acceptance.
   */
  private async applyAccept(workspace: Workspace | null): Promise<PreviewState> {
    // Captured by the queue caller, so the click and the task name the same project.
    const ctx = workspace !== undefined && this.workspace === workspace ? this.currentContext() : null
    if (!ctx || this.workspace !== workspace) {
      throw new RemoteError('latex-preview/nothing-to-review', '工作区已切换，本次操作没有执行', {})
    }
    if (!hasPendingChanges(this.revisions())) {
      throw new RemoteError('latex-preview/nothing-to-review', '没有待审核的改动', {})
    }
    const source = this.currentSource
    if (source === null) throw new RemoteError('latex-preview/nothing-to-review', '没有待审核的改动', {})
    // The revision being accepted is the one on screen, so its artifacts can be
    // copied straight from disk — no second compile, and the pair now belongs to
    // the baseline the diff will use.
    const outcome = await this.snapshotBaseFromCurrent(ctx, source)
    if (outcome === 'stale' || !this.isCurrent(ctx)) return this.state
    this.acceptedSource = source
    this.commit(ctx, {
      // Saying "accepted" while the pair was refused would leave the panel claiming a
      // comparison the next diff call cannot build.
      message:
        outcome === 'withdrawn'
          ? '已接受这次改动；这一版 PDF 无法校验，已从对比中撤下'
          : '已接受这次改动',
      diffDocUrl: null,
    })
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
    return this.revertQueued()
  }

  /**
   * Queue one revert.
   *
   * Same reason as {@link acceptQueued}: 撤销 writes the root file and then compiles,
   * which is the one sequence that must not interleave with an HTTP acceptance or a
   * compile that is already publishing.
   * @returns the state after the recompile.
   */
  private revertQueued(): Promise<PreviewState> {
    // Same capture as 接受: the click belongs to the workspace that was on screen.
    const workspace = this.workspace
    return this.enqueueLeased(this.pathsOf(workspace), 'write', () => this.applyRevert(workspace))
  }

  /**
   * Shared revert body.
   *
   * Called from inside a queue task, so it runs the compile directly instead of
   * re-entering {@link runCompile} — the task would then be waiting for a job that is
   * queued behind itself.
   * @param workspace - the workspace the click was made for; the task refuses to act
   * on a different one, because "roll this project back" has no meaning for the
   * project that replaced it.
   * @returns the state after the recompile.
   */
  private async applyRevert(workspace: Workspace | null): Promise<PreviewState> {
    if (workspace === null || this.workspace !== workspace) {
      throw new RemoteError('latex-preview/revert-failed', '工作区已切换，本次撤销没有执行', {
        detail: '工作区已切换',
      })
    }
    const ctx = this.currentContext()
    const target = this.acceptedSource
    if (!ctx || target === null || !hasPendingChanges(this.revisions())) {
      throw new RemoteError('latex-preview/nothing-to-review', '没有可撤回的改动', {})
    }

    await writeFile(ctx.workspace.rootFile, target, 'utf8')
    // The PDF on screen still belongs to the revision being thrown away, so the
    // compile must be told what it is replacing instead of inferring it from a
    // `currentSource` we just moved. Moving it here would also make the compile
    // look like a no-op and leave the previous-compile snapshot pointing at the
    // baseline rather than at the document the user was reading.
    const discarded = this.currentSource
    let result: CompileResult
    try {
      result = await this.compileOnce({ beforeOverride: discarded, suppressReview: true }, ctx.workspace)
    } catch (error) {
      throw new RemoteError('latex-preview/revert-failed', '源码已回滚，但重新编译没有启动', {
        detail: error instanceof Error ? error.message : String(error),
      })
    }
    // The file was written back before any await, so a switch can only land during
    // the compile. From here the panel belongs to another project and this revert has
    // no state to report into: `compileOnce` already refused to publish anything.
    if (!this.isCurrent(ctx)) throw this.switchedDuringRevert()
    if (!result.ok) {
      // Two different failures wear the same "recompile failed": a rollback that put
      // the old pair back, and one that could not — and in the second case the PDF
      // the user was reading is gone, so the message must not claim otherwise.
      throw new RemoteError(
        'latex-preview/revert-failed',
        result.artifactState === 'restored'
          ? '源码已回滚，但重新编译失败；PDF 仍是回滚前那一版'
          : '源码已回滚，但重新编译失败，且这一版 PDF 无法校验，已从预览中撤下',
        { detail: result.diagnostics[0]?.message ?? 'unknown' },
      )
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
    if ((await this.snapshotBaseFromCurrent(ctx, target)) === 'stale') throw this.switchedDuringRevert()
    this.commit(ctx, { message: '已回滚到上一版', diffDocUrl: null })
    return this.state
  }

  /**
   * The error 撤销 reports when its workspace went away while it recompiled.
   *
   * Not a silent success: the file *was* written back, so the panel must be able to
   * say that the revert landed on disk but nothing was committed for the project now
   * on screen.
   * @returns the error to throw.
   */
  private switchedDuringRevert(): RemoteError {
    return new RemoteError('latex-preview/revert-failed', '源码已回滚，但工作区在重新编译期间切换，本次回滚没有提交到面板', {
      detail: '工作区已切换',
    })
  }

  /**
   * Send the change just compiled to an independent reviewer.
   *
   * Runs detached: compiling must not wait on a model call — and neither must the
   * queue. The call itself stays outside {@link enqueue}; only the verdict's effects
   * (a baseline promotion, a rollback) go back in, re-checked against the workspace
   * and revision they were produced for.
   * @param workspace - the workspace the change belongs to.
   */
  private async queueReview(workspace: Workspace): Promise<void> {
    const target = this.currentSource
    const base = this.acceptedSource
    if (this.reviewing === workspace || target === null || base === null || target === base) return
    if (this.workspace !== workspace) return

    this.reviewing = workspace
    this.patch({ message: '自动审核中：正在请独立 AI 审这次改动…' })
    try {
      const verdict = await this.runReview(base, target)
      // The verdict publishes or rolls back, so it takes the same write lease a compile
      // does — against the workspace it decided about.
      await this.enqueueLeased(this.pathsOf(workspace), 'write', () =>
        this.applyVerdict(workspace, target, verdict),
      )
    } catch (error) {
      // A reviewer that failed for a project nobody is looking at any more must not
      // write its complaint into the new project's status line.
      if (this.workspace === workspace) {
        this.patch({
          message: `自动审核出错（${error instanceof Error ? error.message : String(error)}），已转手动`,
        })
      }
    } finally {
      // Only clear our own claim: if a switch happened mid-review, the flag now names
      // another workspace and that one's review must keep its protection.
      if (this.reviewing === workspace) this.reviewing = null
    }
  }

  /**
   * Apply a verdict, if it still describes what is on screen.
   *
   * The reviewer can take 25 s, which is long enough for another compile, a
   * 接受/撤销, or a workspace switch to land. All three make the verdict about a
   * document that is no longer current, so it is dropped rather than applied.
   * @param workspace - the workspace the reviewed change belonged to.
   * @param target - the revision that was reviewed.
   * @param verdict - what the reviewer decided.
   */
  private async applyVerdict(workspace: Workspace, target: string, verdict: ReviewVerdict): Promise<void> {
    if (this.workspace !== workspace) return
    // Another compile landed while the reviewer was thinking; that change gets its
    // own review, and applying this verdict to it would be wrong.
    if (this.currentSource !== target) return

    if (verdict.verdict === 'unavailable') {
      this.patch({ message: `自动审核不可用（${verdict.reason}），已转手动：请点「接受」或「撤销」` })
      return
    }
    if (verdict.verdict === 'accept') {
      const ctx = this.currentContext()
      if (!ctx) return
      // The approved revision is the one on screen. Passed explicitly, and only
      // committed once the promotion is: a verdict that lands after a switch must not
      // relabel the workspace the panel is now showing.
      if ((await this.snapshotBaseFromCurrent(ctx, target)) === 'stale') return
      this.acceptedSource = target
      this.commit(ctx, { message: `自动审核通过：${verdict.reason}`, diffDocUrl: null })
      return
    }
    await this.applyRevert(workspace)
    if (this.workspace === workspace) {
      this.patch({ message: `自动审核未通过，已回滚：${verdict.reason}`, diffDocUrl: null })
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
   * Paths of one workspace, or null when there is none.
   *
   * Takes the workspace rather than reading `state.rootFile` / `workDir`: those
   * fields describe the *current* configuration, and a task that started earlier
   * must resolve its own paths against the workspace it captured.
   * @param workspace - the workspace to describe; defaults to the current one.
   * @returns the path set, or null before `configure`.
   */
  private pathsOf(workspace: Workspace | null = this.workspace): CompilePaths | null {
    return workspace ? compilePaths(workspace.rootFile, workspace.outDir) : null
  }

  /**
   * The two revision stores that live in one path set.
   * @param paths - resolved paths of that workspace.
   * @returns the accepted and previous-compile stores.
   */
  private storesOf(paths: CompilePaths): Stores {
    return {
      paths,
      accepted: new ArtifactStore({ pdf: paths.basePdf, synctex: paths.baseSynctex, manifest: paths.baseManifest }),
      recent: new ArtifactStore({ pdf: paths.recentPdf, synctex: paths.recentSynctex, manifest: paths.recentManifest }),
    }
  }

  /** Stores of the configured workspace, or null before `configure`. */
  private storesNow(): Stores | null {
    const paths = this.pathsOf()
    return paths ? this.storesOf(paths) : null
  }

  /** A context for operations that act on the workspace as it stands right now. */
  private currentContext(): WorkspaceContext | null {
    const workspace = this.workspace
    const paths = this.pathsOf(workspace)
    return workspace && paths ? { workspace, paths } : null
  }

  /**
   * Claim an artifact path set for one task.
   *
   * Taken when the task is *queued*, not when it starts: a task that is merely waiting
   * in the queue will still write those files, and that is enough to make a configure
   * into the same names wait. The claim is released in the task's `finally`, i.e. after
   * its last I/O — never when a run is judged stale, because being stale changes
   * whether the bytes may be *published*, not whether they are being *written*.
   * @param paths - the path set the task will touch; null claims nothing.
   * @param mode - what it does with them.
   * @returns the lease and its two operations.
   */
  private holdLease(paths: CompilePaths | null, mode: PathLease['mode']): HeldLease {
    const lease: PathLease = { key: paths ? resolve(paths.pdf) : '', owner: Symbol('latex-preview/lease'), mode, running: false }
    if (!paths) return { lease, begin: () => undefined, release: () => undefined }
    const set = this.leases.get(lease.key) ?? new Set<PathLease>()
    set.add(lease)
    this.leases.set(lease.key, set)
    let released = false
    return {
      lease,
      begin: () => {
        lease.running = true
      },
      release: () => {
        if (released) return
        released = true
        set.delete(lease)
        if (set.size === 0) this.leases.delete(lease.key)
      },
    }
  }

  /**
   * A lease on `key` that conflicts with a writer, or null.
   *
   * Read/write semantics: writers exclude everything, readers exclude writers. Two
   * diff builds may read the live PDF together; nothing may write next to either.
   * @param key - resolved PDF path.
   * @param options - `self` to exclude the asking task's own lease, `runningOnly` to
   * ignore tasks that are still queued.
   * @returns the blocking lease, or null when the path is free.
   */
  private blockingLease(
    key: string,
    options: { self?: PathLease; runningOnly?: boolean } = {},
  ): PathLease | null {
    const set = this.leases.get(key)
    if (!set) return null
    for (const lease of set) {
      if (lease === options.self) continue
      if (options.runningOnly === true && !lease.running) continue
      // A reader is only blocked by a writer; a writer is blocked by either.
      if (lease.mode === 'write' || options.self?.mode !== 'read') return lease
    }
    return null
  }

  /**
   * Whether a candidate would take over a path set someone else is using or about to.
   *
   * Deliberately not "does this equal the active workspace's path": a stale task keeps
   * its lease until its I/O finishes, and that task is exactly the writer a restore
   * must not delete files under. Any lease counts — a queued one will write, a running
   * reader is reading — which is why the answer is about *resources*, not identity.
   * @param candidate - the workspace about to be activated.
   * @returns true when the candidate's artifacts are spoken for.
   */
  private artifactPathsBusy(candidate: Workspace): boolean {
    const next = this.pathsOf(candidate)
    if (!next) return false
    const key = resolve(next.pdf)
    const current = this.pathsOf()
    if (current !== null && resolve(current.pdf) === key) return true
    return this.blockingLease(key) !== null
  }

  /**
   * Refuse to touch a path set that another task is inside right now.
   *
   * The last line of defence, not the mechanism: `restoreArtifacts` only runs when
   * {@link artifactPathsBusy} said the set was free, so this must never fire. It
   * exists because the recurring form of this bug is a new code path that forgets to
   * look — a thrown error is far better than a directory describing two projects.
   * @param paths - the set about to be deleted or overwritten.
   * @param self - the caller's own lease, so holding one is not a conflict.
   */
  private assertArtifactPathsQuiet(paths: CompilePaths, self?: PathLease): void {
    const key = resolve(paths.pdf)
    const blocking = this.blockingLease(key, { self, runningOnly: true })
    if (blocking) {
      throw new RemoteError('latex-preview/artifact-busy', '这组产物正被另一个任务写入，本次操作已取消', {
        detail: `${key} (${blocking.mode})`,
      })
    }
  }

  /**
   * Whether a task's workspace is still the configured one.
   *
   * Object identity, not the generation number: a `Workspace` is replaced wholesale
   * and never mutated, so identity is the cheapest exact answer — the generation is
   * there to make the intent readable in logs and tests.
   * @param ctx - the context a running task captured.
   * @returns true when nothing has switched since.
   */
  private isCurrent(ctx: WorkspaceContext): boolean {
    return this.workspace === ctx.workspace
  }

  /**
   * Patch the state, but only if the task that wants to is still current.
   *
   * The guard belongs on the write, not on the read: an `if (stale) return` at the
   * top of a block is exactly what the previous version had, and it does not cover
   * the awaits *inside* the block.
   * @param ctx - the context that produced these fields.
   * @param next - the fields to publish.
   * @returns true when the patch was applied.
   */
  private commit(ctx: WorkspaceContext, next: Partial<PreviewState>): boolean {
    if (!this.isCurrent(ctx)) return false
    this.patch(next)
    return true
  }

  /**
   * Replace the three revisions, but only for the run that owns them.
   *
   * Revisions are the one piece of state a compile *writes* rather than derives, and
   * they are what 接受 and 撤销 write too. Both run on the same queue, so a snapshot
   * taken at the start of a run is still the truth when it finishes — this guard is
   * what makes the snapshot safe to use instead of re-reading `this.revisions()`.
   * @param ctx - the run that computed these revisions.
   * @param next - the three revisions to install.
   * @returns true when the run was still current.
   */
  private commitRevisions(ctx: BuildContext, next: Revisions): boolean {
    if (!this.isCurrent(ctx)) return false
    this.applyRevisions(next)
    return true
  }

  /**
   * The result a run reports when its workspace is gone.
   *
   * Deliberately not an error: the user switched projects, and the panel they are
   * looking at now has nothing to do with this run. It says "no artefact can be
   * vouched for" and carries no URL, which is true — this run's PDF belongs to a
   * workspace nobody is displaying any more.
   * @param result - what the compiler returned, when it got that far.
   * @returns a result with nothing publishable in it.
   */
  private discarded(result?: CompileResult): CompileResult {
    return {
      ...(result ?? {
        ok: false,
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        pdfPath: null,
        artifactState: 'unavailable' as const,
        pdfUrl: null,
        logPath: null,
        diagnostics: [],
        stdoutTail: '',
        stderrTail: '',
        rolledBack: false,
        rollbackIncomplete: false,
        backup: { status: 'unavailable' as const },
      }),
      // Whatever the compiler did, none of it belongs to the workspace that is on
      // screen now: no path, no URL, and `unavailable` rather than `current` so a
      // caller that only looks at the state cannot mistake it for displayable.
      pdfPath: null,
      artifactState: 'unavailable' as const,
      pdfUrl: null,
    }
  }

  /**
   * Whether this process may claim `source` produced the bytes at these paths.
   *
   * The credential must name this workspace, this revision *and* these hashes. A
   * manifest alone cannot answer this: it records what the bytes were, never who
   * compiled them (services/provenance.ts).
   * @param ctx - workspace the claim is made about, not the current one.
   * @param source - revision the caller wants to name.
   * @param hashes - hashes of the files as they sit on disk right now.
   * @param trusted - the credential to test against; a run passes the one it captured
   * when it started, because that is the only one that can describe `before`.
   * @returns true only for an exact match.
   */
  private claimCovers(
    ctx: WorkspaceContext,
    source: string | null,
    hashes: { pdfSha256: string; synctexSha256: string },
    trusted: TrustedArtifacts | null,
  ): boolean {
    if (source === null) return false
    return trustCovers(trusted, {
      workspaceId: ctx.workspace.id,
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
  private async issueTrustFor(ctx: WorkspaceContext, source: string | null): Promise<TrustedArtifacts | null> {
    if (source === null) return null
    const hashes = await pairHashes(ctx.paths.pdf, ctx.paths.synctex)
    if (hashes === null) return null
    return issueTrust({
      workspaceId: ctx.workspace.id,
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
   * @param ctx - the run's workspace, not whatever is configured when it resumes.
   * @param before - source that produced the artefacts now sitting in `prev`.
   * @param backup - what the compile's backup step reported.
   */
  private async publishCompileArtifacts(ctx: BuildContext, before: string | null, backup: BackupResult): Promise<StoreOutcome> {
    if (!this.isCurrent(ctx)) return 'stale'
    const stores = this.storesOf(ctx.paths)
    if (before === null || backup.status !== 'complete') {
      return this.dropRecentArtifacts(ctx)
    }
    const hashes = await pairHashes(stores.paths.prev, stores.paths.prevSynctex)
    // First asynchronous boundary inside the helper: the workspace may have been
    // replaced while the pair was being hashed, and starting a publish now would
    // touch files nobody asked about.
    if (!this.isCurrent(ctx)) return 'stale'
    if (
      hashes === null ||
      hashes.pdfSha256 !== backup.pdfSha256 ||
      hashes.synctexSha256 !== backup.synctexSha256 ||
      !this.claimCovers(ctx, before, hashes, ctx.trusted)
    ) {
      return this.dropRecentArtifacts(ctx)
    }
    const id = this.digestOf(before)
    const ok = await stores.recent.publish({
      revisionId: id,
      pdf: stores.paths.prev,
      synctex: stores.paths.prevSynctex,
    })
    // The publish itself is already on disk and cannot be undone; what must not
    // happen is a URL for it appearing in a workspace that has moved on.
    if (!this.isCurrent(ctx)) return 'stale'
    if (!ok) return this.dropRecentArtifacts(ctx)
    this.publishRecentUrls(ctx, id)
    return 'published'
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
   * @param ctx - the run's workspace.
   * @param expected - source that produced the artefacts in the `prev` copies.
   * @param backup - what the compile's backup step reported.
   */
  private async adoptBaseArtifacts(ctx: BuildContext, expected: string | null, backup: BackupResult): Promise<StoreOutcome> {
    if (!this.isCurrent(ctx)) return 'stale'
    const stores = this.storesOf(ctx.paths)
    const accepted = ctx.revisions.accepted
    if (accepted === null) return this.dropBaseArtifacts(ctx)
    const id = this.digestOf(accepted)

    if (expected !== null && accepted === expected && backup.status === 'complete') {
      const hashes = await pairHashes(stores.paths.prev, stores.paths.prevSynctex)
      if (!this.isCurrent(ctx)) return 'stale'
      const proven =
        hashes !== null &&
        hashes.pdfSha256 === backup.pdfSha256 &&
        hashes.synctexSha256 === backup.synctexSha256 &&
        this.claimCovers(ctx, accepted, hashes, ctx.trusted)
      if (proven) {
        const ok = await stores.accepted.publish({
          revisionId: id,
          pdf: stores.paths.prev,
          synctex: stores.paths.prevSynctex,
        })
        if (!this.isCurrent(ctx)) return 'stale'
        if (!ok) return this.dropBaseArtifacts(ctx)
        this.publishBaseUrls(ctx, id)
        return 'published'
      }
      // Those bytes may still be the accepted revision even though this process
      // cannot re-attest them — it is a restart, and the pair was published by the
      // process that compiled it. Fall through to the manifest check instead of
      // deleting a pair that is still correct.
    }

    const manifest = await stores.accepted.verify()
    if (!this.isCurrent(ctx)) return 'stale'
    if (manifestStillDescribes(manifest, id)) {
      this.publishBaseUrls(ctx, id)
      return 'published'
    }
    return this.dropBaseArtifacts(ctx)
  }

  /**
   * Replace the accepted pair with the artefacts currently on screen.
   *
   * Used when the baseline catches up with what is displayed (接受, an approving
   * reviewer): the current PDF *is* the baseline then, so it can be installed
   * without a second compile — provided this process compiled it, which is what the
   * credential says.
   * @param ctx - the workspace whose accepted pair is being promoted; defaults to
   * the configured one, which is what 接受 and the reviewer use.
   */
  private async snapshotBaseFromCurrent(ctx: WorkspaceContext, source: string | null): Promise<StoreOutcome> {
    if (source === null) return this.dropBaseArtifacts(ctx)
    const stores = this.storesOf(ctx.paths)
    const hashes = await pairHashes(stores.paths.pdf, stores.paths.synctex)
    if (!this.isCurrent(ctx)) return 'stale'
    if (hashes === null || !this.claimCovers(ctx, source, hashes, this.trusted)) {
      // The PDF is on screen but nobody can say which revision produced it, so it
      // must not be promoted to a baseline that later line-number lookups trust.
      return this.dropBaseArtifacts(ctx)
    }
    const id = this.digestOf(source)
    const ok = await stores.accepted.publish({ revisionId: id, pdf: stores.paths.pdf, synctex: stores.paths.synctex })
    if (!this.isCurrent(ctx)) return 'stale'
    if (!ok) return this.dropBaseArtifacts(ctx)
    this.publishBaseUrls(ctx, id)
    return 'published'
  }

  /**
   * Forget the accepted pair: its revision can no longer be mapped honestly.
   * @param ctx - whose pair to drop; a stale run drops only its own.
   * @returns what happened, so a caller can stop instead of continuing.
   */
  private async dropBaseArtifacts(ctx: WorkspaceContext): Promise<StoreOutcome> {
    if (!this.isCurrent(ctx)) return 'stale'
    await this.storesOf(ctx.paths).accepted.drop()
    if (!this.isCurrent(ctx)) return 'stale'
    this.commit(ctx, { basePdfUrl: null, baseViewerUrl: null, baseRevisionId: null })
    return 'withdrawn'
  }

  /**
   * Forget the previous-compile pair.
   * @param ctx - whose pair to drop; a stale run must not take the new workspace's.
   * @returns what happened, so a caller can stop instead of continuing.
   */
  private async dropRecentArtifacts(ctx: WorkspaceContext): Promise<StoreOutcome> {
    if (!this.isCurrent(ctx)) return 'stale'
    await this.storesOf(ctx.paths).recent.drop()
    if (!this.isCurrent(ctx)) return 'stale'
    this.commit(ctx, { recentPdfUrl: null, recentViewerUrl: null, recentRevisionId: null })
    return 'withdrawn'
  }

  /**
   * Mirror a published pair into the state as URLs the panel can use.
   * @param ctx - the workspace the pair belongs to.
   * @param id - revision digest.
   */
  private publishBaseUrls(ctx: WorkspaceContext, id: string): void {
    this.commit(ctx, this.urlsFor(ctx, id, 'base'))
  }

  /**
   * Mirror the previous-compile pair into the state.
   * @param ctx - the workspace the pair belongs to.
   * @param id - revision digest.
   */
  private publishRecentUrls(ctx: WorkspaceContext, id: string): void {
    this.commit(ctx, this.urlsFor(ctx, id, 'recent'))
  }

  /**
   * Build the state patch for one published pair.
   * @param ctx - the workspace the pair belongs to.
   * @param id - revision digest, used as the cache-busting version.
   * @param tag - which pair; selects the field names and the file name.
   * @returns the fields to patch.
   */
  private urlsFor(ctx: WorkspaceContext, id: string, tag: 'base' | 'recent'): Partial<PreviewState> {
    return this.urlsAt({ paths: ctx.paths }, id, tag)
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
  private async restoreArtifacts(
    rootFile: string,
    outDir: string,
    source: string | null,
    self?: PathLease,
  ): Promise<Partial<PreviewState>> {
    const vanished: Partial<PreviewState> = {
      basePdfUrl: null,
      baseViewerUrl: null,
      baseRevisionId: null,
      recentPdfUrl: null,
      recentViewerUrl: null,
      recentRevisionId: null,
    }
    const paths = compilePaths(rootFile, outDir)
    // This deletes both pairs by name. Nobody else may be inside these paths right
    // now; `self` is the caller's own claim, which is not a conflict with itself.
    this.assertArtifactPathsQuiet(paths, self)
    const stores = this.storesOf(paths)
    if (source === null) {
      await stores.accepted.drop()
      await stores.recent.drop()
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
    return synctexView(file, request.line, pdf, { cwd: this.workDir })
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
    return synctexEdit(request.page, request.x, request.y, pdf, { cwd: this.workDir })
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

    const hits = await synctexEdit(request.page, request.x, request.y, pdf, { cwd: this.workDir })
    if (typeof request.x2 === 'number' && typeof request.y2 === 'number') {
      hits.push(...(await synctexEdit(request.page, request.x2, request.y2, pdf, { cwd: this.workDir })))
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
      const hits = await synctexView(rootFile, candidate, pdf, { cwd: this.workDir })
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
      const report = await this.binaryProbe()
      const binaries = { tectonic: report.tectonic.available, synctex: report.synctex.available }
      this.patch({ binaries })
      return binaries
    } catch (error) {
      this.ctx.logger?.('latex-preview')?.warn?.('binary probe failed: %s', String(error))
      return undefined
    }
  }

  /**
   * Serialise the operations that move workspace state, then run one.
   *
   * `CompileService.run` already single-flights the *process*, but this method also
   * moves the revision snapshots and publishes artefacts — and two interleaved
   * bookkeepings are not the same thing as one. A watcher that fires twice for a
   * single save produced exactly that: the second run copied the PDF the first had
   * just written, published it under the older revision, and the first run's publish
   * was then dropped as stale. One at a time is the only way the snapshots and the
   * pairs stay in step.
   *
   * 接受 and 撤销 go through the same queue, because they rewrite the very revisions a
   * compile advances from; `configure` does not, because a first compile can take
   * minutes and switching projects must not wait for it (prepare-then-activate is
   * what makes that safe).
   * @param operation - the body to serialise.
   * @returns its result.
   */
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lifecycleQueue.then(operation, operation)
    this.lifecycleQueue = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  /**
   * Queue an operation that touches one artifact path set, holding its lease.
   *
   * The claim is taken **before** the operation is queued — that is the point: a task
   * waiting in the queue is invisible to everything else, and a `configure` that ran
   * during that wait would restore over files the task is about to write. `begin()`
   * marks the transition from reservation to I/O, and the `finally` releases it after
   * the last `await` of the task, including a rejection — a lease that leaks on an
   * error path would block every later switch to those paths for the life of the
   * process.
   * @param paths - the path set the operation will touch.
   * @param mode - what it does with them.
   * @param operation - the body; receives the lease so a nested check can exclude it.
   * @returns the operation's result.
   */
  private enqueueLeased<T>(
    paths: CompilePaths | null,
    mode: PathLease['mode'],
    operation: (lease: PathLease) => Promise<T>,
  ): Promise<T> {
    const held = this.holdLease(paths, mode)
    return this.enqueue(async () => {
      // The reservation said "these paths are spoken for"; the lock is what actually
      // waits for the speakers to finish. A writer waits for readers to drain (a diff
      // build reads the live pair for minutes, outside this queue) and a reader waits
      // for the writer. Waiting here is safe: readers never enter this queue, so no
      // queue task can wait on another queue task's lock.
      const ticket = held.lease.key === '' ? null : await this.ioLock.acquire(held.lease.key, mode)
      held.begin()
      try {
        return await operation(held.lease)
      } finally {
        ticket?.release()
        held.release()
      }
    })
  }

  /**
   * Queue one compile.
   * @param run - caller overrides; see {@link RunOptions}.
   * @param expected - the workspace the caller believes is active; a watcher or a
   * configure passes the one it captured, so a queued event cannot compile the
   * workspace that replaced it. Omitted means "whatever is active when the task runs".
   * @returns the compile result, with its URL filled in.
   */
  private runCompile(run: RunOptions = {}, expected?: Workspace): Promise<CompileResult> {
    // Resolved at *enqueue* time, not inside the task: the lease has to name the paths
    // this request will write, and a task sitting in the queue must already be visible
    // to a configure looking at the same directory. `expected` still wins, so a watcher
    // or a configure binds its own workspace.
    const workspace = expected ?? this.workspace
    if (!workspace) {
      return Promise.reject(
        new RemoteError('latex-preview/no-root-file', 'nothing configured', { hint: '先调用 configure' }),
      )
    }
    return this.enqueueLeased(this.pathsOf(workspace), 'write', async () => {
      if (this.workspace !== workspace) return this.discarded()
      return this.compileOnce(run, workspace)
    })
  }

  /**
   * One compile, with state transitions around it.
   *
   * The whole run hangs off one {@link BuildContext}: the workspace, its paths, the
   * three revisions, the review mode and the credential — all captured before the
   * process starts. Every window that used to be unguarded is followed by an
   * {@link isCurrent} check, because a `configure` can land during any of them and
   * the state it moves is not the state this run may touch. A stale run returns
   * `pdfUrl: null` and performs no store operation at all.
   * @param run - caller overrides; see {@link RunOptions}.
   * @param active - the workspace this run belongs to, already verified by the queue.
   * @returns the compile result, with its URL filled in.
   */
  private async compileOnce(run: RunOptions = {}, active?: Workspace): Promise<CompileResult> {
    const workspace = active ?? this.workspace
    const paths = this.pathsOf(workspace)
    if (!workspace || !paths) {
      throw new RemoteError('latex-preview/no-root-file', 'nothing configured', { hint: '先调用 configure' })
    }
    const rootFile = workspace.rootFile
    if (!this.state.binaries.tectonic) {
      throw new RemoteError('latex-preview/binary-missing', 'tectonic is not available', { missing: ['tectonic'] })
    }

    // What the artifacts on disk describe *before* this compile overwrites them.
    // Not always what `currentSource` says: 撤销 writes the file back first, and the
    // PDF on screen still belongs to the revision it is throwing away.
    const before = run.beforeOverride !== undefined ? run.beforeOverride : this.currentSource
    // The graph the compiler is about to read. Scanned *before* `readSource` so the
    // snapshot is never later than the text: a member edited between the two would
    // otherwise be hashed after the edit and look unchanged.
    const inputManifest = await this.scanInputs(rootFile, workspace.outDir)
    // The input the compiler is about to read. Comparing it with the file after the
    // run is the only way to notice an edit that landed mid-compile: the PDF then
    // belongs to neither snapshot, and must not be given a credential.
    const input = await this.readSource(rootFile)
    const ctx: BuildContext = {
      workspace,
      paths,
      before,
      input,
      inputManifest,
      revisions: this.revisions(),
      review: this.review,
      trusted: this.trusted,
    }
    if (!this.isCurrent(ctx)) return this.discarded()

    this.commit(ctx, { status: 'compiling', message: '正在编译…' })
    let result: CompileResult
    try {
      result = await workspace.compiler.run()
    } catch (error) {
      if (!this.isCurrent(ctx)) return this.discarded()
      // Without this the state stays 'compiling' forever and the panel looks hung.
      this.commit(ctx, {
        status: 'failed',
        message: `编译没有启动：${error instanceof Error ? error.message : String(error)}`,
      })
      throw error
    }
    // Another workspace took over while this run was inside the compiler. Its PDF is
    // real and sits in the old outDir, but nothing about it may reach the new
    // workspace: no state patch, no published pair, no credential.
    if (!this.isCurrent(ctx)) return this.discarded(result)
    if (this.onRunReturned) {
      await this.onRunReturned({ id: workspace.id, generation: workspace.generation })
      // The window this seam opens is the one that produced the bug: the run has
      // passed its check and every step below is still ahead of it.
      if (!this.isCurrent(ctx)) return this.discarded(result)
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
    if (!this.isCurrent(ctx)) return this.discarded(result)
    // The same graph, read again. Skipped for a failed run: no credential is issued
    // for it anyway, and the scan can be hundreds of files.
    let inputsMoved: InputDiff = { moved: false }
    if (result.ok && compiled !== null && ctx.inputManifest !== null) {
      const after = await this.scanInputs(rootFile, workspace.outDir)
      // A scan is a long `await`: a `configure` can land inside it, and the answer
      // would then belong to a workspace this run no longer speaks for.
      if (!this.isCurrent(ctx)) return this.discarded(result)
      if (after !== null) inputsMoved = diffBuildInput(ctx.inputManifest, after)
    }
    // A compile is only as trustworthy as its input: if the root file changed while
    // the compiler had it open, the PDF corresponds to neither the before- nor the
    // after-snapshot. The same is true of any file the root pulls in — a chapter
    // rewritten mid-run leaves the PDF describing half of each document.
    const rootMoved = !(compiled !== null && compiled === input)
    const stable = result.ok && compiled !== null && !rootMoved && !inputsMoved.moved
    let contentChanged = false

    if (result.ok) {
      // Advance only when the content actually moved. A redundant compile (the user
      // pressing 编译 twice, or the watcher reporting one save) must not erase the
      // marks they are looking at, and it must not republish "上次编译" either: the
      // last compile before the current one is still the answer, and overwriting it
      // with the revision that is already on screen loses the comparison.
      //
      // The three revisions come from the context, not from `this`: 接受 and 撤销 run
      // on the same queue, so nothing could have changed them mid-run, and reading
      // them again afterwards is how an older view used to overwrite a newer one.
      const advanced =
        stable && compiled !== null ? advanceRevisions(ctx.revisions, compiled, ctx.review) : null
      if (advanced?.changed) {
        // Publish before advancing: the credential that authorises the pre-compile
        // copies describes the bytes that were on screen a moment ago, and the
        // advance is what decides whether those bytes also become a baseline.
        const published = await this.publishCompileArtifacts(ctx, before, result.backup)
        if (published === 'stale') return this.discarded(result)
        this.commitRevisions(ctx, advanced.revisions)
        contentChanged = true
      }
      const adopted = await this.adoptBaseArtifacts(ctx, before, result.backup)
      if (adopted === 'stale') return this.discarded(result)
      // The credential for the bytes now on screen. Withheld when the input moved:
      // an unprovable pair is exactly what must never be published later.
      const credential = stable && compiled !== null ? await this.issueTrustFor(ctx, compiled) : null
      // Written only after the guard: a credential issued for A's bytes must never
      // become B's, and `trusted` is read by every later publish.
      if (!this.isCurrent(ctx)) return this.discarded(result)
      this.trusted = credential
      // Start the reviewer *last*. It can approve within a tick, and approving means
      // promoting the current PDF to the baseline — which needs the credential
      // issued on the line above. Starting it earlier let a fast reviewer reach
      // `snapshotBaseFromCurrent()` while `trusted` still described the revision
      // being replaced, so the promoted pair was refused and dropped.
      if (contentChanged && ctx.review === 'auto' && run.suppressReview !== true) void this.queueReview(workspace)
    } else if (result.artifactState === 'unavailable') {
      // No artefact can be vouched for — a partial rollback, a backup that never
      // landed, or a first compile that failed. Withdraw every claim rather than
      // leave the panel pointing at bytes of unknown origin.
      this.trusted = null
      const droppedBase = await this.dropBaseArtifacts(ctx)
      if (droppedBase === 'stale') return this.discarded(result)
      await this.dropRecentArtifacts(ctx)
    }

    // Converge: the edit that landed mid-compile is now on disk, and the PDF on
    // screen predates it. Bounded, because a save that lands during *every* run would
    // otherwise recompile for ever; `void` because a queued task awaiting a compile
    // would be waiting on itself.
    const converge = run.converge ?? 0
    const recompiling = result.ok && !stable && converge < MAX_CONVERGE && this.isCurrent(ctx)
    if (recompiling) {
      void this.runCompile({ converge: converge + 1 }, workspace).catch(() => undefined)
    }

    // `restored` keeps showing the previous revision (the compile failed but put it
    // back); `unavailable` shows nothing, because keeping the old URL would present
    // an artefact this compile cannot account for as if it were the current one.
    const showable = result.artifactState !== 'unavailable' && result.pdfPath !== null
    if (!this.commit(ctx, {
      status: result.ok ? 'ok' : 'failed',
      pdfUrl: showable ? pdfUrl : null,
      viewerUrl: showable ? viewerUrl : null,
      // The viewer must not try to reload a document that is no longer offered.
      ...(showable ? {} : { basePdfUrl: null, baseViewerUrl: null, baseRevisionId: null }),
      ...(showable ? {} : { recentPdfUrl: null, recentViewerUrl: null, recentRevisionId: null }),
      // A new revision makes the built 对比视图 stale; it must be rebuilt on
      // demand rather than silently shown against the wrong baseline.
      diffDocUrl: contentChanged ? null : this.state.diffDocUrl,
      compiledAt: result.ok ? new Date().toISOString() : this.state.compiledAt,
      diagnostics: result.diagnostics,
      durationMs: result.durationMs,
      message: this.describe(result, { stable, rootMoved, inputs: inputsMoved, recompiling }),
    })) {
      return this.discarded(result)
    }
    // The *returned* result must agree with the state. Handing back the URL of a
    // PDF we just withdrew from the panel is the same lie in a different place: a
    // caller that renders `result.pdfUrl` would show bytes nobody can vouch for.
    return { ...result, pdfUrl: showable ? pdfUrl : null }
  }

  /**
   * One-line status for the panel.
   *
   * A successful-but-unstable run has three different stories and the line must tell
   * the right one: the root moved (the old wording), a member of the graph moved (the
   * reader needs the file name, or they will look at the root and see nothing), or the
   * budget ran out (nothing is going to change by waiting).
   * @param result - the compile.
   * @param stability - what the two input scans and the convergence budget decided.
   * @returns the line to show.
   */
  private describe(
    result: CompileResult,
    stability: { readonly stable: boolean; readonly rootMoved: boolean; readonly inputs: InputDiff; readonly recompiling: boolean } = {
      stable: true,
      rootMoved: false,
      inputs: { moved: false },
      recompiling: false,
    },
  ): string {
    if (result.ok) {
      const took = `编译成功（${(result.durationMs / 1000).toFixed(1)}s）`
      if (stability.stable) return took
      const subject = stability.rootMoved ? '根文件' : namedInputs(stability.inputs)
      return stability.recompiling
        ? `${took}，但编译期间${subject}又变了，正在重新编译`
        : `${took}，但编译期间${subject}反复变化，已停止自动重编译；本次 PDF 不作为可接受的版本`
    }
    const errors = result.diagnostics.filter((d) => d.severity === 'error').length
    // Every sentence below has to match what is actually on screen. "保留上一次的
    // PDF" is only true for a clean rollback; when the artefacts were withdrawn,
    // saying it would promise a document the panel is no longer showing.
    if (result.rolledBack) return `编译失败（${errors} 个错误），已回滚到上一次的 PDF`
    if (result.timedOut) return '编译超时，已终止；本次没有可校验的 PDF，预览已撤下'
    if (result.artifactState === 'unavailable') return `编译失败（${errors} 个错误），PDF 无法校验，预览已撤下`
    return `编译失败（${errors} 个错误）`
  }

  /** Absolute PDF path or a RemoteError the UI can explain. */
  private requirePdf(): string {
    const paths = this.pathsOf()
    if (!paths) throw new RemoteError('latex-preview/no-pdf', 'no root file', { hint: '先 configure' })
    return paths.pdf
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
   * Hash the input graph, degrading to `null` instead of failing the compile.
   *
   * A scan that throws means "we could not look", not "the document is broken": the
   * compile is real either way, and the consequence is only that `stable` falls back
   * to the root-only comparison. Failing the run instead would turn a permission
   * error in `../shared/refs.bib` into "this project never compiles again".
   * @param rootFile - the workspace's root `.tex`.
   * @param outDir - its output directory, tried as a second base for includes.
   * @returns the manifest, or null when scanning is impossible.
   */
  private async scanInputs(rootFile: string, outDir: string): Promise<BuildInputManifest | null> {
    try {
      return await this.buildInputScanner(rootFile, outDir)
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
      // Both mutations go through the same queue as compiles: an acceptance reads
      // the PDF on disk, and a compile that is between "wrote its bytes" and
      // "published them" would hand it a document no credential describes.
      accept: () => this.acceptQueued(),
      revert: () => this.revertQueued(),
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
      {
        prefix: '/pdf',
        dir: () => this.workDir,
        // A PDF and nothing else. The same directory holds the compile log, both
        // manifests and the `.prev` copies; a route that serves them is a file
        // browser over the build directory, and one of those copies is all it
        // would take to show a revision the panel has already withdrawn.
        accept: (name) => extname(name).toLowerCase() === '.pdf',
        cacheable: false,
      },
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
    // A held ticket is released by its own `finally`; what must not survive the service
    // is a waiter — nobody would ever wake it.
    this.ioLock.dispose('latex-preview service unloaded')
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

/**
 * Name the input members that moved, for the status line.
 *
 * The reader who is told "the input changed" looks at the root file and sees nothing,
 * so the paths have to be named — capped, because a status line is one line.
 * @param inputs - the diff from `diffBuildInput`.
 * @returns the joined paths, or a generic word when only the root is identifiable.
 */
function namedInputs(inputs: InputDiff): string {
  if (!inputs.moved || inputs.paths.length === 0) return '输入'
  const named = inputs.paths.join('、')
  return inputs.more > 0 ? `${named} 等 ${inputs.paths.length + inputs.more} 个文件` : named
}
