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
import { readFile } from 'node:fs/promises'
import { checkBinaries } from '../utils/binaries.ts'
import { isRootCandidate, listTexFiles, resolveRoot, type RootResolution } from '../utils/root.ts'
import { synctexEdit, synctexView } from '../utils/synctex.ts'
import { CompileService, compilePaths } from './compile.ts'
import { FileWatcher } from './watcher.ts'
import { lineDiff } from './diff.ts'
import { AgentBridge, type AgentRegistryLike } from './agent-bridge.ts'
import { createApiHandler, type PreviewHost } from './http-api.ts'
import { mountStaticRoute, ROUTE_PREFIX, type StaticMount, type WebServerLike } from './static-route.ts'
import type { CompileResult, DiffBlock, PreviewState, SyncEditHit, SyncViewHit } from '../types.ts'

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
  }
}

const DEFAULT_DEBOUNCE_MS = 500
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_FIRST_RUN_TIMEOUT_MS = 300_000

export class LatexPreviewService extends TypertRemoteService {
  private state: PreviewState
  private compiler: CompileService
  private watcher: FileWatcher | null = null
  private readonly bridge: AgentBridge
  private agents: AgentRegistryLike | undefined
  private webServer: WebServerLike | undefined
  private disposeRoute: (() => void) | null = null
  private redact = false
  private previousSource: string | null = null
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
      compiledAt: null,
      diagnostics: [],
      binaries: { tectonic: false, synctex: false },
      message: null,
      watching: false,
      redact: this.redact,
      durationMs: null,
      rootCandidates: [],
    }
  }

  /** Replace state and bump the version pollers watch. */
  private patch(next: Partial<PreviewState>): void {
    this.state = { ...this.state, ...next, version: this.state.version + 1 }
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
    request: { file?: string; rootFile?: string; outDir?: string; redact?: boolean; debounceMs?: number },
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
    debounceMs?: number
  }): Promise<PreviewState> {
    if (typeof request.redact === 'boolean') this.redact = request.redact
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
    this.previousSource = await this.readSource(rootFile)

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
    })
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
    const rootFile = this.state.rootFile
    if (!rootFile || this.previousSource === null) return []
    const current = await this.readSource(rootFile)
    if (current === null) return []
    return lineDiff(this.previousSource, current)
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
  private async handOff(request: { redact?: boolean }): Promise<{ ok: boolean; detail?: string }> {
    const outcome = this.bridge.send(this.state.diagnostics, {
      redact: request.redact ?? this.redact,
    })
    if (!outcome.ok) {
      throw new RemoteError('latex-preview/handoff-failed', outcome.detail ?? outcome.reason ?? 'unknown', {
        reason: outcome.reason ?? 'unknown',
      })
    }
    return { ok: true }
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

    this.patch({ status: 'compiling', message: '正在编译…' })
    const result = await this.compiler.run()
    const pdfUrl = result.pdfPath ? `${ROUTE_PREFIX}/pdf/${encodeURIComponent(basename(result.pdfPath))}?v=${this.state.version + 1}` : null

    if (result.ok) {
      this.previousSource = await this.readSource(rootFile)
    }

    this.patch({
      status: result.ok ? 'ok' : 'failed',
      pdfUrl: result.pdfPath ? pdfUrl : this.state.pdfUrl,
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
      jumpToPdf: (request) => this.view(request),
      jumpToSource: (request) => this.edit(request),
      sendError: (request) => this.handOff(request),
      binaries: async () => (await this.refreshBinaries()) ?? this.state.binaries,
    }
  }

  /** Mount the static route if the web server is known and the shape fits. */
  private mountRoutes(): void {
    if (!this.webServer || this.disposeRoute) return
    const mounts: StaticMount[] = [
      { prefix: '/pdf', dir: this.outDir, cacheable: false },
      { prefix: '/assets', dir: join(process.cwd(), 'assets'), cacheable: true },
    ]
    const dispose = mountStaticRoute(this.webServer, mounts, createApiHandler(this.httpHost()))
    if (!dispose) {
      this.ctx.logger?.('latex-preview')?.warn?.('webServer.register unavailable; PDF will not be reachable over HTTP')
      this.patch({ message: '静态路由挂载失败：webServer 接口不匹配（见 docs/spikes.md B6）' })
      return
    }
    this.disposeRoute = dispose
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
