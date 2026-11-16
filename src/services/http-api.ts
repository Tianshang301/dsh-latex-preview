/**
 * JSON API over the plugin's own same-origin route.
 *
 * Why not Typert Remote: the client half cannot `inject` a Host service — it waits
 * forever for a service that only exists in the Host process (observed on a real
 * DSH 0.2.2 boot: `dsh-latex-preview: pending (waiting for service: latexPreview)`).
 * The native answer is a generated Remote contribution, which requires the Typert
 * generator's program analysis and published artifacts we do not ship yet.
 *
 * `webServer.register` *is* verified working (same boot, route answered), so the
 * panel talks to the Host over this route instead. The response envelope is
 * deliberately identical to `RemoteResult` (`{ok,value}` / `{ok,error}`), so if the
 * generated Remote surface lands later, only the client's transport swaps.
 *
 * @module dsh-latex-preview/services/http-api
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { CompileResult, DiffBlock, DiffDocResult, DiffRegions, PreviewState, ReviewMode, SyncEditHit, SyncViewHit } from '../types.ts'
import { ROUTE_PREFIX } from './static-route.ts'
import type { EditOutcome, EditRequest } from '../types.ts'

/** URL prefix of the API, nested under the plugin's route. */
export const API_PREFIX = `${ROUTE_PREFIX}/api`

/** Largest request body accepted; every call here carries a small JSON object. */
const MAX_BODY_BYTES = 64 * 1024

/** The Host operations the panel calls. */
export interface PreviewHost {
  state(): PreviewState
  configure(request: {
    file?: string
    rootFile?: string
    outDir?: string
    redact?: boolean
    review?: ReviewMode
    debounceMs?: number
  }): Promise<PreviewState>
  compile(): Promise<CompileResult>
  diff(): Promise<readonly DiffBlock[]>
  diffRegions(): Promise<DiffRegions>
  diffDoc(): Promise<DiffDocResult>
  accept(): PreviewState
  revert(): Promise<PreviewState>
  jumpToPdf(request: { line: number; file?: string }): Promise<readonly SyncViewHit[]>
  jumpToSource(request: { page: number; x: number; y: number }): Promise<readonly SyncEditHit[]>
  sendError(request: { redact?: boolean; sessionId?: string }): Promise<{ ok: boolean; detail?: string }>
  editAt(request: EditRequest): Promise<EditOutcome>
  binaries(): Promise<PreviewState['binaries']>
}

/** Methods reachable over HTTP, mapped to their expected verb. */
const ROUTES: Record<string, 'GET' | 'POST'> = {
  state: 'GET',
  configure: 'POST',
  compile: 'POST',
  diff: 'POST',
  'diff-regions': 'POST',
  'diff-doc': 'POST',
  accept: 'POST',
  revert: 'POST',
  'jump-to-pdf': 'POST',
  'jump-to-source': 'POST',
  'send-error': 'POST',
  'edit-at': 'POST',
  binaries: 'POST',
}

/**
 * Build the request handler.
 * @param host - the operations to expose.
 * @returns a Node handler; errors are returned as `{ok:false,error}` rather than thrown.
 */
export function createApiHandler(host: PreviewHost) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(`${API_PREFIX}/`)) return false

    const name = url.pathname.slice(API_PREFIX.length + 1)
    const verb = ROUTES[name]
    if (!verb) {
      send(res, 404, { ok: false, error: { code: 'latex-preview/unknown-method', message: name } })
      return true
    }
    if (req.method !== verb) {
      send(res, 405, { ok: false, error: { code: 'latex-preview/bad-method', message: `expected ${verb}` } })
      return true
    }

    try {
      const body = verb === 'POST' ? await readJson(req) : {}
      const value = await dispatch(host, name, body)
      send(res, 200, { ok: true, value })
    } catch (error) {
      send(res, 200, {
        ok: false,
        error: {
          code: (error as { code?: string }).code ?? 'latex-preview/failed',
          message: error instanceof Error ? error.message : String(error),
        },
      })
    }
    return true
  }
}

/** Route one method name to the host operation. */
async function dispatch(host: PreviewHost, name: string, body: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'state':
      return host.state()
    case 'configure':
      return host.configure(body as Parameters<PreviewHost['configure']>[0])
    case 'compile':
      return host.compile()
    case 'diff':
      return host.diff()
    case 'diff-regions':
      return host.diffRegions()
    case 'diff-doc':
      return host.diffDoc()
    case 'accept':
      return host.accept()
    case 'revert':
      return host.revert()
    case 'jump-to-pdf':
      return host.jumpToPdf(body as Parameters<PreviewHost['jumpToPdf']>[0])
    case 'jump-to-source':
      return host.jumpToSource(body as Parameters<PreviewHost['jumpToSource']>[0])
    case 'send-error':
      return host.sendError(body as { redact?: boolean; sessionId?: string })
    case 'edit-at':
      return host.editAt(body as unknown as EditRequest)
    case 'binaries':
      return host.binaries()
    default:
      throw Object.assign(new Error(name), { code: 'latex-preview/unknown-method' })
  }
}

/** Read and parse a bounded JSON body. */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error('body too large'), { code: 'latex-preview/body-too-large' })
    }
    chunks.push(buffer)
  }
  if (chunks.length === 0) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  const parsed: unknown = JSON.parse(text)
  if (typeof parsed !== 'object' || parsed === null) {
    throw Object.assign(new Error('body must be an object'), { code: 'latex-preview/bad-body' })
  }
  return parsed as Record<string, unknown>
}

/** Write a JSON response. */
function send(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(Buffer.byteLength(body)),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}
