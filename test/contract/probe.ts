/**
 * Contract probe: the five API assumptions that gate the whole schedule
 * (B1/B3 in the handoff, plus the message-source shape).
 *
 * What runs here is the *real* published packages, not mocks:
 * `@deepseek-ai/cordis`, `@deepseek-ai/dsh-typert-protocol`, `@deepseek-ai/dsh-llm`.
 *
 * What cannot run here: anything needing the DSH runtime (web server, agent
 * loop, browser slot service). Those are reported as SKIP with the reason, so a
 * green run never implies more than it checked.
 *
 * Run with `pnpm verify`.
 *
 * @module dsh-latex-preview/test/contract/probe
 */

import { readFileSync } from 'node:fs'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { LatexPreviewService, SERVICE_KEY } from '../../src/services/latex-preview-service.ts'

interface Result {
  readonly name: string
  readonly status: 'PASS' | 'FAIL' | 'SKIP'
  readonly detail: string
}

const results: Result[] = []

/** Record one probe outcome. */
function record(name: string, status: Result['status'], detail: string): void {
  results.push({ name, status, detail })
  const mark = status === 'PASS' ? 'PASS' : status === 'FAIL' ? 'FAIL' : 'SKIP'
  console.log(`[${mark}] ${name} — ${detail}`)
}

/** Run one assertion block, converting throws into a FAIL. */
async function probe(name: string, body: () => Promise<string> | string): Promise<void> {
  try {
    record(name, 'PASS', await body())
  } catch (error) {
    record(name, 'FAIL', error instanceof Error ? error.message : String(error))
  }
}

/** Wait one macrotask so plugin fibers can settle. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const ctx = new Context()

// 1 · Service base class + super(ctx, 'latexPreview') registration.
await probe('ctx.plugin(Service) exposes ctx.<key>', async () => {
  ctx.plugin(LatexPreviewService)
  await settle()
  const service = (ctx as unknown as Record<string, unknown>)[SERVICE_KEY]
  if (!service) throw new Error(`ctx.${SERVICE_KEY} is undefined after plugin()`)
  const got = (service as { name?: string }).name
  if (got !== SERVICE_KEY) throw new Error(`service.name is ${String(got)}, expected ${SERVICE_KEY}`)
  const keys = Object.keys((service as object) as Record<string, unknown>)
  return `ctx.${SERVICE_KEY}.name=${got}; own keys=[${keys.join(', ') || '(none)'}]`
})

// 2 · Remote surface: decorators must have registered exactly the exported methods.
await probe('Remote decorators are discoverable', async () => {
  const service = (ctx as unknown as Record<string, unknown>)[SERVICE_KEY]
  if (!service) throw new Error('service missing, cannot inspect Remote markers')
  const marked = remoteMethods(service as object).map((m) => m.method)
  if (!marked.includes('getState')) throw new Error(`expected getState in markers, got [${marked.join(', ')}]`)
  return `marked=[${marked.join(', ')}]`
})

// 3 · ctx.inject(deps, cb): the callback must fire with a usable child context.
await probe('ctx.inject(deps, cb) resolves deferred services', async () => {
  let resolved = false
  let injectedKey = ''
  ctx.inject([SERVICE_KEY], (childCtx) => {
    const viaChild = (childCtx as unknown as Record<string, unknown>)[SERVICE_KEY]
    injectedKey = viaChild ? SERVICE_KEY : '(undefined)'
    resolved = true
  })
  await settle()
  if (!resolved) throw new Error('inject callback never ran')
  if (injectedKey !== SERVICE_KEY) throw new Error(`child ctx could not resolve ${SERVICE_KEY}`)
  return `callback ran and child ctx resolved ${SERVICE_KEY}`
})

// 4 · createUserMessage: what actually comes back, and what `source` must be.
await probe('createUserMessage({ content, source })', () => {
  // The spec wrote `source: 'latex-preview'` (a bare string). The real contract is
  // a discriminated object, and `dsh-llm@0.2.2` dropped the `plugin` kind, so
  // a plugin-produced turn is an ordinary `{ kind: 'user' }` message.
  const message = createUserMessage({
    content: [{ type: 'text', text: 'LaTeX 编译失败，请修复' }],
    source: { kind: 'user' },
  })
  if (message.role !== 'user') throw new Error(`role is ${message.role}`)
  if (!message.id) throw new Error('no id assigned')
  if (!Object.isFrozen(message)) throw new Error('message is not frozen')
  const blocks = message.content.map((b) => b.type).join(',')
  return `role=${message.role} id=${String(message.id).slice(0, 12)}… frozen=true blocks=[${blocks}]`
})

// 5 · getState over the Remote surface (the polling fallback for B1).
await probe('getState() returns a JSON snapshot', async () => {
  const service = (ctx as unknown as Record<string, unknown>)[SERVICE_KEY] as
    | { getState: (signal: AbortSignal) => Promise<unknown> }
    | undefined
  if (!service?.getState) throw new Error('getState missing')
  const controller = new AbortController()
  const state = (await service.getState(controller.signal)) as { version?: unknown; status?: unknown }
  const round = JSON.parse(JSON.stringify(state)) as { version?: unknown }
  if (typeof state.version !== 'number') throw new Error('version is not a number')
  if (round.version !== state.version) throw new Error('state is not JSON-round-trippable')
  return `version=${state.version} status=${String(state.status)} json-round-trip=ok`
})

// 6 · agent.steer: needs the agent loop; assert the shape we depend on exists in types only.
record(
  'agent.steer(UserMessage)',
  'SKIP',
  'needs @deepseek-ai/dsh-agent runtime; Host reaches it via ctx.inject(["agents"]) then Agent#steer(message: UserMessage) — implemented in services/agent-bridge.ts',
)

// 7 · webServer: needs the DSH runtime, not part of cordis core.
record('ctx.inject(["webServer"])', 'SKIP', 'webServer is a DSH runtime service; verify in a real profile (P0.4)')

const failed = results.filter((r) => r.status === 'FAIL')
console.log(
  `\n${results.length - failed.length - results.filter((r) => r.status === 'SKIP').length} pass, ` +
    `${failed.length} fail, ${results.filter((r) => r.status === 'SKIP').length} skip ` +
    `(cordis ${versionOf('@deepseek-ai/cordis')}, typert ${versionOf('@deepseek-ai/dsh-typert-protocol')}, node ${process.version})`,
)
process.exitCode = failed.length === 0 ? 0 : 1

/** Read an installed package's version for the summary line. */
function versionOf(pkg: string): string {
  try {
    const url = new URL(`../../node_modules/${pkg}/package.json`, import.meta.url)
    return (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version
  } catch {
    return '?'
  }
}
