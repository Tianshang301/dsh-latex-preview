/**
 * Error hand-off: turn compile diagnostics into one message the Agent can act on.
 *
 * Two product constraints live here, not in the UI:
 * - **Redaction** (default off) drops source context and keeps message + line.
 *   Off by default because a fix without context is much worse; the switch exists
 *   so a user can opt into sending less.
 * - **One message per compile**, not one per diagnostic. Ten messages would make
 *   the Agent act ten times on the same file.
 *
 * The producer tag is `{ kind: 'plugin', plugin: 'latex-preview' }` — the real
 * contract, which the spec got wrong (docs/spikes.md §B8).
 *
 * @module dsh-latex-preview/services/agent-bridge
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { basename } from 'node:path'
import type { LatexDiagnostic } from '../types.ts'

/** Structural view of an Agent; the real one lives in `@deepseek-ai/dsh-agent`. */
export interface AgentLike {
  steer(message: unknown): void
}

/** Structural view of `ctx.agents` (AgentRegistry). */
export interface AgentRegistryLike {
  currentInitiator?(): AgentLike | undefined
  requireInitiator?(): AgentLike
  /** Look up the live agent for a Session id; the only reliable path outside a driver. */
  get?(id: string): AgentLike | undefined
}

/** Why a send did not happen. */
export type SendFailure = 'no-agent' | 'no-diagnostics' | 'threw'

/** Outcome of one hand-off. */
export interface SendOutcome {
  readonly ok: boolean
  readonly reason?: SendFailure
  readonly detail?: string
}

/** How much of the source the prompt may carry. */
export interface HandOffOptions {
  /** Redaction switch: when true, only message + line leave the machine. */
  readonly redact: boolean
  /** Cap on diagnostics included, so a 200-error log cannot blow up the message. */
  readonly maxItems?: number
}

const DEFAULT_MAX_ITEMS = 5

/**
 * Build the single user message describing a failed compile.
 * @param diagnostics - parsed diagnostics; errors are prioritised inside the caller.
 * @param options - redaction and item cap.
 * @returns the prompt text.
 */
export function buildErrorPrompt(diagnostics: readonly LatexDiagnostic[], options: HandOffOptions): string {
  const cap = options.maxItems ?? DEFAULT_MAX_ITEMS
  const errors = diagnostics.filter((d) => d.severity === 'error')
  const chosen = (errors.length > 0 ? errors : diagnostics).slice(0, cap)

  const head = [`LaTeX 编译失败，请修复后重新编译。共 ${errors.length || diagnostics.length} 个错误，下面列出前 ${chosen.length} 个：`]
  const body = chosen.map((d, index) => {
    const where = `${basename(d.file)}:${d.line > 0 ? d.line : '?'}`
    const lines = [`${index + 1}. 位置：${where}`, `   错误：${d.message}`]
    if (!options.redact && d.context.trim() !== '') {
      lines.push('   上下文：', '   ```latex', ...d.context.split(/\r?\n/).map((l) => `   ${l}`), '   ```')
    }
    return lines.join('\n')
  })

  const tail = options.redact
    ? ['（已开启脱敏模式：未发送源码上下文，请依据错误信息与行号定位并修改源文件。）']
    : ['请直接修改对应的 .tex 源文件修复上述错误，不要新建文件，也不要改动与错误无关的内容。']

  return [...head, '', ...body, '', ...tail].join('\n')
}

export class AgentBridge {
  constructor(private readonly resolveRegistry: () => AgentRegistryLike | undefined) {}

  /**
   * Send one compile's diagnostics to the agent that initiated the session.
   *
   * An HTTP route has no driver boundary, so `currentInitiator()` is empty there;
   * the panel therefore passes the Session id it is drawn in and that Agent is
   * used first. The initiator chain remains the fallback for in-process callers.
   * @param diagnostics - what the compile produced.
   * @param options - redaction and item cap.
   * @param explicit - agent resolved from the caller's Session, when known.
   * @returns whether the message was handed to an agent.
   */
  send(diagnostics: readonly LatexDiagnostic[], options: HandOffOptions, explicit?: AgentLike): SendOutcome {
    if (diagnostics.length === 0) return { ok: false, reason: 'no-diagnostics' }

    const registry = this.resolveRegistry()
    const agent =
      explicit ??
      registry?.currentInitiator?.() ??
      (registry?.requireInitiator ? safeRequire(registry) : undefined)
    if (!agent) {
      return {
        ok: false,
        reason: 'no-agent',
        detail: '当前没有可投递的会话（编译由文件监听触发，而非会话发起）；请从对话窗口重试',
      }
    }

    try {
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text: buildErrorPrompt(diagnostics, options) }],
          // `MessageSourceMap` in dsh-llm 0.2.2-rc.1 has no `plugin` kind (it
          // existed in 0.1.0-rc.6 and was removed), so a plugin-produced turn is
          // an ordinary user message. See docs/spikes.md §B8.
          source: { kind: 'user' },
        }),
      )
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: 'threw', detail: error instanceof Error ? error.message : String(error) }
    }
  }
}

/** `requireInitiator` throws when no boundary is active; that is a normal outcome here. */
function safeRequire(registry: AgentRegistryLike): AgentLike | undefined {
  try {
    return registry.requireInitiator?.()
  } catch {
    return undefined
  }
}
