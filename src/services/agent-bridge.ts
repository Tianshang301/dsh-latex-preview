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

/**
 * Request header of a Session: which provider and model it is talking to.
 *
 * The reviewer needs the same route the user already chose, and this is the only
 * documented place it is published (docs/spikes.md §B18).
 */
export interface SessionHeaderLike {
  requestHeader?(): { config?: { provider?: string; model?: string } } | undefined
}

/** Structural view of an Agent; the real one lives in `@deepseek-ai/dsh-agent`. */
export interface AgentLike {
  steer(message: unknown): void
  session?: SessionHeaderLike
}

/** Structural view of `ctx.agents` (AgentRegistry). */
export interface AgentRegistryLike {
  currentInitiator?(): AgentLike | undefined
  requireInitiator?(): AgentLike
  /** Look up the live agent for a Session id; the only reliable path outside a driver. */
  get?(id: string): AgentLike | undefined
  /** Every live agent; last resort for reading a model route. */
  list?(): AgentLike[]
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

/** One rectangle in the PDF turned into a request to change its source. */
export interface SelectionPromptInput {
  /** Source file SyncTeX reported; absolute. */
  readonly file: string
  /** First and last source line the rectangle covers. */
  readonly lineStart: number
  readonly lineEnd: number
  /** Those lines of source, already read (empty when redacting). */
  readonly lines: readonly string[]
  /** Text the user selected, as a hint only; bad for formulas and ligatures. */
  readonly quoted: string
  /** What the user asked for, in their own words. */
  readonly instruction: string
  readonly redact: boolean
}

/**
 * Build the prompt for a "change this spot" request.
 *
 * The rectangle is the anchor, not the content: the source lines are what the
 * Agent edits, which is why a garbled text extraction does not matter here.
 * @param input - resolved source location plus the user's instruction.
 * @returns the prompt text.
 */
export function buildSelectionPrompt(input: SelectionPromptInput): string {
  const range = input.lineStart === input.lineEnd ? `${input.lineStart}` : `${input.lineStart}-${input.lineEnd}`
  const head = [
    `用户在你编译出的 PDF 上指了一处位置，想要修改对应的源码。`,
    `位置：${basename(input.file)}:${range}`,
    `用户的要求：${input.instruction}`,
  ]

  if (input.redact) {
    head.push('（已开启脱敏模式：未附带源码与选中文本，请依据行号自行读取文件。）')
    head.push('请只改这一处相关的内容，不要新建文件，也不要改动无关部分；改完我会重新编译。')
    return head.join('\n')
  }

  if (input.quoted.trim() !== '') {
    head.push(`用户选中的文字（从 PDF 提取，可能因连字或公式而不准，仅作参考）：「${input.quoted.trim().slice(0, 200)}」`)
  }
  head.push('', '这一段当前的源码：', '```latex')
  for (let i = 0; i < input.lines.length; i++) {
    head.push(`${input.lineStart + i}: ${input.lines[i] ?? ''}`)
  }
  head.push('```', '')
  head.push('请只修改这一段相关的内容，不要新建文件，也不要改动无关部分；改完我会重新编译验证。')
  return head.join('\n')
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
    return this.deliver(buildErrorPrompt(diagnostics, options), explicit)
  }

  /**
   * Deliver one prepared prompt to an Agent.
   * @param text - the message body.
   * @param explicit - agent resolved from the caller's Session, when known.
   * @returns whether the message was handed over.
   */
  deliver(text: string, explicit?: AgentLike): SendOutcome {
    const registry = this.resolveRegistry()
    const agent =
      explicit ??
      registry?.currentInitiator?.() ??
      (registry?.requireInitiator ? safeRequire(registry) : undefined)
    if (!agent) {
      return {
        ok: false,
        reason: 'no-agent',
        detail: '当前没有可投递的会话（未从会话发起，且找不到对应 Agent）；请从对话窗口重试',
      }
    }

    try {
      agent.steer(
        createUserMessage({
          content: [{ type: 'text', text }],
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
