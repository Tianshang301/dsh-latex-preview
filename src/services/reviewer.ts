/**
 * An independent reviewer for changes that already compiled.
 *
 * "Automatic review" here means what it says: a **separate** model call, with its
 * own system prompt, no tools, no conversation history, no ability to edit the
 * file. It sees the unified diff and answers accept or reject. The plugin decides
 * with a strict parser and never treats an unreadable answer as approval.
 *
 * Why not the session's own Agent: that Agent wrote the change. Asking it to
 * approve its own work is theatre, and it would also be able to edit files again.
 *
 * The route (provider + model) comes from the Session's request header, the same
 * source `@deepseek-ai/dsh-experimental-auto-review` uses, so the reviewer speaks
 * with the model the user already chose (docs/spikes.md §B18).
 *
 * @module dsh-latex-preview/services/reviewer
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { DiffBlock } from '../types.ts'

/** Provider route for one model call. */
export interface ReviewRoute {
  readonly provider: string
  readonly model: string
}

/** Structural view of `ctx.llm`; keeps this module free of the runtime version. */
export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    system?: string
    messages: unknown[]
    maxTokens?: number
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

/** What the reviewer decided. `unavailable` is never treated as approval. */
export interface ReviewVerdict {
  readonly verdict: 'accept' | 'reject' | 'unavailable'
  /** One sentence for the status bar; the reviewer's own words when it gave them. */
  readonly reason: string
}

/** How much of the diff one review may carry. */
const MAX_DIFF_LINES = 80

/** Ceiling on the reviewer's answer; it only needs to emit a small JSON object. */
const MAX_REVIEW_TOKENS = 600

const SYSTEM_PROMPT = [
  '你是一个独立的代码审核者，审核一份 LaTeX 源码的改动是否应该被接受。',
  '你没有编辑权限，只能判断。改动来自另一个 AI 编辑后自动编译的结果。',
  '接受（accept）的标准：改动与预期意图一致、语法正确、不会破坏文档结构或已通过编译的内容、没有顺手改动无关部分。',
  '拒绝（reject）的标准：引入了明显错误、删掉了不该删的内容、改动范围远超必要、疑似把测试/占位内容留在文档里。',
  '只输出一个 JSON 对象，不要输出解释性段落或代码块标记：',
  '{"verdict":"accept|reject","reason":"不超过 40 字的中文理由"}',
].join('\n')

/**
 * Render diff blocks as a compact unified diff for the reviewer.
 *
 * Unchanged context is kept to two lines per gap: an isolated `+` line is often
 * only judgeable next to what surrounds it, but the whole document is not needed
 * and would waste the reviewer's attention.
 * @param blocks - blocks from `lineDiff`, in document order.
 * @param limit - maximum lines rendered.
 * @returns the diff text.
 */
export function renderDiffForReview(blocks: readonly DiffBlock[], limit = MAX_DIFF_LINES): string {
  const lines: string[] = []
  let skipped = 0
  const pushContext = (text: string): void => {
    const all = text.split('\n')
    if (text.endsWith('\n')) all.pop()
    if (all.length === 0) return
    const kept = all.length <= 3 ? all : [all[0]!, '…', all[all.length - 1]!]
    for (const line of kept) lines.push(line === '…' ? '…' : `  ${line}`)
  }

  for (const block of blocks) {
    if (lines.length >= limit) {
      skipped += 1
      continue
    }
    if (block.type === 'equal') {
      pushContext(block.text)
      continue
    }
    const prefix = block.type === 'insert' ? '+' : '-'
    for (const line of block.text.split('\n')) {
      if (line === '' && block.text.endsWith('\n')) continue
      if (lines.length >= limit) {
        skipped += 1
        break
      }
      lines.push(`${prefix} ${line}`)
    }
  }

  const body = lines.join('\n')
  return skipped === 0 ? body : `${body}\n…（还有 ${skipped} 段未展示）`
}

/**
 * Ask an independent model whether this change should stand.
 *
 * Never throws: a missing route, an empty answer, or a malformed one all come back
 * as `unavailable`, because the caller must fall back to asking the user rather
 * than applying a change nobody approved.
 * @param llm - the LLM service (`ctx.llm`).
 * @param route - provider and model to call.
 * @param diff - rendered diff.
 * @param signal - cancellation.
 * @returns the verdict.
 */
export async function reviewDiff(
  llm: LlmLike,
  route: ReviewRoute,
  diff: string,
  signal?: AbortSignal,
): Promise<ReviewVerdict> {
  if (diff.trim() === '') {
    return { verdict: 'accept', reason: '没有实际改动' }
  }

  let text = ''
  try {
    const stream = llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      maxTokens: MAX_REVIEW_TOKENS,
      messages: [createUserMessage({ content: [{ type: 'text', text: diff }], source: { kind: 'user' } })],
      ...(signal ? { signal } : {}),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    }
  } catch (error) {
    return { verdict: 'unavailable', reason: `审核调用失败：${error instanceof Error ? error.message : String(error)}` }
  }

  return parseVerdict(text)
}

/**
 * Read the reviewer's answer.
 *
 * A substring match is the fallback, not the primary path, but it is deliberately
 * conservative: a sentence that merely *mentions* "reject" counts as a rejection,
 * because the failure we care about is waving through something unapproved.
 * @param text - raw model output.
 * @returns the parsed verdict.
 */
export function parseVerdict(text: string): ReviewVerdict {
  const trimmed = text.trim()
  if (trimmed === '') return { verdict: 'unavailable', reason: '审核者没有返回内容' }

  const json = trimmed.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const parsed: unknown = JSON.parse(json[0])
      const record = parsed as { verdict?: unknown; reason?: unknown }
      const verdict = typeof record.verdict === 'string' ? record.verdict.toLowerCase() : ''
      const reason = typeof record.reason === 'string' ? record.reason.trim() : ''
      if (verdict === 'accept' || verdict === 'reject') {
        return { verdict, reason: reason === '' ? (verdict === 'accept' ? '审核通过' : '审核未通过') : reason }
      }
    } catch {
      // Fall through to the keyword scan; the model wrote prose around its JSON.
    }
  }

  const lower = trimmed.toLowerCase()
  if (lower.includes('reject')) return { verdict: 'reject', reason: trimmed.slice(0, 80) }
  if (lower.includes('accept')) return { verdict: 'accept', reason: trimmed.slice(0, 80) }
  return { verdict: 'unavailable', reason: '审核者的回答无法解析' }
}
