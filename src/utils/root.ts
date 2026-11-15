/**
 * Root `.tex` resolution.
 *
 * Order (spec §3.1, refined): explicit `% !TEX root = …` wins; otherwise the
 * file itself if it carries `\documentclass`; otherwise the directory is scanned
 * and a single candidate is accepted. More than one candidate is *ambiguous* and
 * must be resolved by the user — compiling the wrong file silently produces a
 * PDF that looks valid and is wrong, which is worse than refusing.
 *
 * @module dsh-latex-preview/utils/root
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'

/** Why the resolution ended the way it did. */
export type RootReason = 'tex-root-directive' | 'documentclass' | 'single-candidate' | 'ambiguous' | 'none'

/** Result of a resolution attempt. */
export interface RootResolution {
  /** Chosen file, or null when nothing could be chosen unambiguously. */
  readonly rootFile: string | null
  /** Every file that carried a `\documentclass`, in directory order. */
  readonly candidates: readonly string[]
  readonly reason: RootReason
  /** Human-facing explanation for the UI. */
  readonly message: string
}

const MAX_SCAN_BYTES = 512 * 1024
const MAX_SCAN_DEPTH = 2

/** `% !TEX root = sub/main.tex` / `% !TEX root: main.tex` — TeXShop/LaTeX-Workshop compatible. */
const TEX_ROOT_RE = /^[ \t]*%\s*!TEX\s+root\s*[:=]\s*(.+?)\s*$/im
/** `\documentclass` at the start of a line (allowing leading whitespace). */
const DOCUMENTCLASS_RE = /^[ \t]*\\documentclass\b/m

/**
 * Read at most `MAX_SCAN_BYTES` of a file.
 * @param file - absolute path.
 * @returns the decoded text, or null when unreadable.
 */
async function readHead(file: string): Promise<string | null> {
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_SCAN_BYTES) return info.isFile() ? '' : null
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/**
 * Whether a file declares a document class (i.e. can be compiled on its own).
 * @param file - absolute path.
 * @returns true when `\documentclass` appears outside a comment.
 */
export async function isRootCandidate(file: string): Promise<boolean> {
  const text = await readHead(file)
  if (!text) return false
  return DOCUMENTCLASS_RE.test(text)
}

/**
 * Collect `.tex` files under a directory, breadth-first, up to a small depth.
 * Skips dot-directories so `outDir` and `.git` never enter the candidate set.
 * @param dir - directory to scan.
 * @returns absolute paths, sorted for stable output.
 */
export async function listTexFiles(dir: string): Promise<string[]> {
  const found: string[] = []
  const queue: Array<{ path: string; depth: number }> = [{ path: dir, depth: 0 }]

  while (queue.length > 0) {
    const next = queue.shift()
    if (!next) break
    let entries: Awaited<ReturnType<typeof readdir>>
    try {
      entries = await readdir(next.path, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(next.path, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        if (next.depth + 1 <= MAX_SCAN_DEPTH) queue.push({ path: full, depth: next.depth + 1 })
        continue
      }
      if (extname(entry.name).toLowerCase() === '.tex') found.push(full)
    }
  }
  return found.sort()
}

/**
 * Resolve the root file for a given starting point.
 * @param startFile - the file the user opened or saved (absolute, or resolved against cwd).
 * @param cwd - directory used when `startFile` is relative.
 * @returns the resolution; never throws.
 */
export async function resolveRoot(startFile: string, cwd = process.cwd()): Promise<RootResolution> {
  const file = isAbsolute(startFile) ? startFile : resolve(cwd, startFile)
  const text = await readHead(file)

  if (text === null) {
    return { rootFile: null, candidates: [], reason: 'none', message: `无法读取文件：${file}` }
  }

  const directive = TEX_ROOT_RE.exec(text)?.[1]
  if (directive) {
    const target = isAbsolute(directive) ? directive : resolve(dirname(file), directive)
    if (await isRootCandidate(target)) {
      return {
        rootFile: target,
        candidates: [target],
        reason: 'tex-root-directive',
        message: `按 % !TEX root 指令选主文件：${target}`,
      }
    }
    // A directive that points nowhere must not be silently ignored.
    return {
      rootFile: null,
      candidates: [],
      reason: 'none',
      message: `% !TEX root 指向的文件不存在或没有 \\documentclass：${target}`,
    }
  }

  if (DOCUMENTCLASS_RE.test(text)) {
    return { rootFile: file, candidates: [file], reason: 'documentclass', message: `该文件自身包含 \\documentclass：${file}` }
  }

  const candidates: string[] = []
  for (const candidate of await listTexFiles(dirname(file))) {
    if (candidate === file) continue
    if (await isRootCandidate(candidate)) candidates.push(candidate)
  }

  if (candidates.length === 1) {
    const only = candidates[0] as string
    return { rootFile: only, candidates, reason: 'single-candidate', message: `目录内唯一的主文件候选：${only}` }
  }
  if (candidates.length > 1) {
    return {
      rootFile: null,
      candidates,
      reason: 'ambiguous',
      message: `目录内有 ${candidates.length} 个可能的主文件，请在面板中选择（或加 % !TEX root 指令）`,
    }
  }
  return { rootFile: null, candidates: [], reason: 'none', message: `未找到含 \\documentclass 的 .tex 文件（起点：${file}）` }
}
