/**
 * The PDF route must follow the configured workspace.
 *
 * The mount table is registered once, when the Host web server is injected, and the
 * output directory is decided later by `configure`. A captured string therefore
 * serves whatever directory DSH was started in — for a workspace elsewhere that is
 * a 404 on every PDF, and for two workspaces sharing a file name it is the *other*
 * project's document, at a URL that looks perfectly valid.
 *
 * Exercised through a real HTTP server rather than a fake `res`: range handling and
 * 404s are part of the contract, and they are what the viewer actually depends on.
 *
 * @module dsh-latex-preview/test/unit/static-route
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createStaticHandler, ROUTE_PREFIX, type StaticMount } from '../../src/services/static-route.ts'

/** Serve `mounts` on an ephemeral port and hand back its base URL. */
async function serve(mounts: readonly StaticMount[]): Promise<{ server: Server; base: string }> {
  const server = createServer(createStaticHandler(mounts))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no port')
  return { server, base: `http://127.0.0.1:${address.port}${ROUTE_PREFIX}` }
}

test('the served directory is resolved per request, not at mount time', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-latex-route-'))
  const a = join(root, 'a')
  const b = join(root, 'b')
  mkdirSync(a)
  mkdirSync(b)
  writeFileSync(join(a, 'main.pdf'), 'PDF-FROM-A')
  writeFileSync(join(b, 'main.pdf'), 'PDF-FROM-B')

  let current = a
  const { server, base } = await serve([{ prefix: '/pdf', dir: () => current, cacheable: false }])
  try {
    assert.equal(await (await fetch(`${base}/pdf/main.pdf`)).text(), 'PDF-FROM-A')

    current = b
    assert.equal(await (await fetch(`${base}/pdf/main.pdf`)).text(), 'PDF-FROM-B', 'followed the switch')

    // A workspace with no PDF must not fall back to the previous one.
    rmSync(join(b, 'main.pdf'))
    assert.equal((await fetch(`${base}/pdf/main.pdf`)).status, 404)
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a static directory still works, and traversal is refused either way', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-latex-route-'))
  const inside = join(root, 'out')
  mkdirSync(inside)
  writeFileSync(join(inside, 'main.pdf'), 'PDF')
  writeFileSync(join(root, 'secret.txt'), 'NOT-FOR-YOU')

  const { server, base } = await serve([{ prefix: '/pdf', dir: () => inside, cacheable: false }])
  try {
    assert.equal(await (await fetch(`${base}/pdf/main.pdf`)).text(), 'PDF')

    // Dot segments can be removed by URL parsing before the handler sees them
    // (404 "no mount"), or survive as backslashes on Windows (403 "forbidden").
    // Either is acceptable; returning the file is not.
    for (const path of ['/pdf/%2e%2e/secret.txt', '/pdf/..%5Csecret.txt', '/pdf/%2e%2e%5Csecret.txt']) {
      const response = await fetch(`${base}${path}`)
      assert.ok([403, 404].includes(response.status), `${path} → ${response.status}`)
      assert.ok(!(await response.text()).includes('NOT-FOR-YOU'), `${path} leaked the file`)
    }
  } finally {
    server.close()
    rmSync(root, { recursive: true, force: true })
  }
})
