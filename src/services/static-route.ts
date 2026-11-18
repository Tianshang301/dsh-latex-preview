/**
 * Same-origin static route for the PDF, the `.synctex.gz`, and the PDF.js assets.
 *
 * Same origin is not a preference: `iframe.contentDocument` is how the viewer
 * adapter reads scroll state, and that only works on one origin (spec pitfall 12).
 *
 * Two things this handler must get right for PDF.js:
 * - **Range requests** — the viewer asks for byte ranges on large files; without
 *   206 responses it falls back to full downloads or fails outright.
 * - **No caching of the PDF** — every compile replaces the file, and a cached copy
 *   would show the previous revision with no visible error.
 *
 * The `webServer.register` shape is still unverified (docs/spikes.md §B6): this
 * module isolates the guess in one place, and mounting degrades to a logged
 * warning instead of a thrown error.
 *
 * @module dsh-latex-preview/services/static-route
 */

import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'

/** URL prefix the client uses; must match the naming convention. */
export const ROUTE_PREFIX = '/.latex-preview'

/** Content types the viewer and its assets need. */
const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.gz': 'application/gzip',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.pfb': 'application/octet-stream',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/** One mounted namespace: URL prefix → directory on disk. */
export interface StaticMount {
  /** URL path prefix, e.g. `/pdf`; appended to {@link ROUTE_PREFIX}. */
  readonly prefix: string
  /**
   * Absolute directory served under that prefix, or a getter for it.
   *
   * The getter exists because compiled output follows the *configured* workspace,
   * and configuration happens after this mount is registered: a captured string
   * would keep serving the directory DSH was started in, so a workspace elsewhere
   * would 404 on every PDF (or, worse, serve another project's file of the same
   * name). Resolved per request, and only then joined and checked.
   */
  readonly dir: string | (() => string)
  /** Whether browser caching is allowed (assets yes, compiled output no). */
  readonly cacheable: boolean
}

/**
 * Build a request handler serving the given mounts.
 * @param mounts - namespace table.
 * @param api - optional JSON API handler, tried first; returns true when it answered.
 * @returns a handler usable by any web server that passes Node's req/res.
 */
export function createStaticHandler(
  mounts: readonly StaticMount[],
  api?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (api && (await api(req, res))) return
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (!url.pathname.startsWith(ROUTE_PREFIX)) {
      res.writeHead(404).end('not found')
      return
    }
    const relative = url.pathname.slice(ROUTE_PREFIX.length)
    const mount = mounts.find((m) => relative === m.prefix || relative.startsWith(`${m.prefix}/`))
    if (!mount) {
      res.writeHead(404).end('no mount')
      return
    }

    const subPath = relative.slice(mount.prefix.length).replace(/^\/+/, '')
    // Resolve the directory first, then normalise the request against *it*: a
    // trailing-slash or `..` must be judged against the directory that is current
    // for this request, not the one that was current at mount time.
    const root = typeof mount.dir === 'function' ? mount.dir() : mount.dir
    const target = safeJoin(root, subPath)
    if (!target) {
      res.writeHead(403).end('forbidden')
      return
    }

    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(target)
    } catch {
      res.writeHead(404).end('not found')
      return
    }
    if (!info.isFile()) {
      res.writeHead(404).end('not a file')
      return
    }

    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream'
    const etag = `"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Cache-Control': mount.cacheable ? 'public, max-age=3600' : 'no-store',
      ETag: etag,
    }

    if (req.method === 'HEAD') {
      res.writeHead(200, { ...headers, 'Content-Length': String(info.size) }).end()
      return
    }

    const range = parseRange(req.headers.range, info.size)
    if (range) {
      headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`
      res.writeHead(206, { ...headers, 'Content-Length': String(range.end - range.start + 1) })
      createReadStream(target, { start: range.start, end: range.end }).pipe(res)
      return
    }

    res.writeHead(200, { ...headers, 'Content-Length': String(info.size) })
    createReadStream(target).pipe(res)
  }
}

/**
 * Join a URL sub-path to a root directory, refusing escapes.
 * @param root - absolute directory.
 * @param subPath - decoded relative path.
 * @returns absolute path inside `root`, or null when it would escape.
 */
function safeJoin(root: string, subPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(subPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const base = resolve(root)
  const target = resolve(base, normalize(decoded))
  if (target !== base && !target.startsWith(base + sep)) return null
  return join(target)
}

/** Parse a single `bytes=start-end` range; multi-range requests fall back to 200. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match) return null
  const [, rawStart, rawEnd] = match
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    const suffix = Number.parseInt(rawEnd as string, 10)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number.parseInt(rawStart as string, 10)
    end = rawEnd === '' ? size - 1 : Math.min(Number.parseInt(rawEnd as string, 10), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

/** Structural view of the Host web server service; the real shape is unverified. */
export interface WebServerLike {
  register?: (spec: { kind: 'exact' | 'prefix'; path: string; handler: unknown }) => unknown
}

/**
 * Mount the handler on the Host web server.
 *
 * Tries the documented `register({kind, path, handler})` shape; anything else is
 * reported rather than thrown, so a plugin with an unverified server API still
 * loads and the panel shows a readable error.
 * @param webServer - the `webServer` service.
 * @param mounts - namespaces to serve.
 * @returns a disposer, or null when the server API did not accept the route.
 */
export function mountStaticRoute(
  webServer: WebServerLike,
  mounts: readonly StaticMount[],
  api?: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>,
): (() => void) | null {
  if (typeof webServer.register !== 'function') return null
  const handler = createStaticHandler(mounts, api)
  const result = webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
  if (typeof result === 'function') return result as () => void
  // Some servers return a handle with its own disposer.
  if (result && typeof (result as { dispose?: unknown }).dispose === 'function') {
    return () => (result as { dispose: () => void }).dispose()
  }
  return () => undefined
}
