/**
 * Startup checks for the two user-provided binaries (tectonic, synctex).
 *
 * Design notes, all verified on a real machine (2026-11-16):
 * - `synctex --version` prints the *tool* version to stdout but writes an
 *   "ERROR: Missing options" + usage block (containing the *engine* version) to
 *   stderr. `synctex help` puts both versions on stdout with exit 0 and no
 *   stderr — use that instead.
 * - The two binaries may come from different TeX distributions (on the machine
 *   this was written for: tectonic standalone, synctex shipped by MiKTeX), so
 *   the report always carries the resolved source path for both.
 * - Versions are reported for diagnostics only, never for compatibility gates.
 *
 * @module dsh-latex-preview/utils/binaries
 */

import { execFile } from 'node:child_process'

/** One resolved binary. */
export interface BinaryProbe {
  /** Command name searched on PATH. */
  readonly command: string
  /** Whether the command ran and produced plausible output. */
  readonly available: boolean
  /** Absolute path as resolved by the OS, when the probe succeeded. */
  readonly path?: string
  /** Version strings parsed out of the probe output, in output order. */
  readonly versions: readonly string[]
  /** Verbatim probe output (trimmed), kept for bug reports. */
  readonly raw?: string
  /** Why the probe failed, when it did. */
  readonly error?: string
}

/** The two binaries the plugin needs, with per-platform installation guidance. */
export interface BinaryReport {
  readonly tectonic: BinaryProbe
  readonly synctex: BinaryProbe
  /** Commands that are missing, in a stable order. */
  readonly missing: readonly string[]
  /** Human-readable, platform-aware installation guidance. */
  readonly guidance: readonly string[]
}

const PROBE_TIMEOUT_MS = 10_000

/**
 * Run one command and capture both streams without rejecting on non-zero exit.
 * @param command - executable name or absolute path.
 * @param args - argument list passed verbatim.
 * @returns stdout, stderr, and the exit code (or a synthetic failure).
 */
function run(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string; code: number; failure?: string }> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const code = typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : -1
        // ENOENT and friends carry no useful stdout; surface the message instead.
        if (code === -1) return resolve({ stdout: '', stderr: '', code, failure: error.message })
        return resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code })
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code: 0 })
    })
  })
}

/**
 * Extract version strings from free-form CLI output, de-duplicated.
 *
 * Two shapes occur in practice: `... version 1.5` (synctex) and a bare
 * `Tectonic 0.17.0` (tectonic prints no "version" word at all), so fall back to
 * a plain semver match when the labelled form is absent.
 */
function versionsOf(text: string): string[] {
  const labelled = text.match(/version\s+(\d+(?:\.\d+)+)/gi)
  const found = labelled ?? text.match(/\b\d+\.\d+\.\d+\b/g) ?? []
  return [...new Set(found.map((m) => m.replace(/version\s+/i, '')))]
}

/** Locate a command on PATH without executing it. */
async function which(command: string): Promise<string | undefined> {
  const locator = process.platform === 'win32' ? ['where', [command]] : ['which', [command]]
  const { stdout, code } = await run(locator[0] as string, locator[1] as string[])
  if (code !== 0) return undefined
  const first = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)
  return first || undefined
}

/**
 * Probe `tectonic --version`.
 * @param command - override for tests or non-PATH installs.
 * @returns the probe result.
 */
export async function probeTectonic(command = 'tectonic'): Promise<BinaryProbe> {
  const { stdout, stderr, code, failure } = await run(command, ['--version'])
  if (failure) return { command, available: false, versions: [], error: failure }
  const raw = `${stdout}${stderr}`.trim()
  const available = code === 0 && /tectonic/i.test(raw)
  return {
    command,
    available,
    ...(await withPath(command)),
    versions: versionsOf(raw),
    raw,
    ...(available ? {} : { error: `exit ${code}` }),
  }
}

/**
 * Probe `synctex help` (not `--version`, see the module note).
 * @param command - override for tests or non-PATH installs.
 * @returns the probe result.
 */
export async function probeSynctex(command = 'synctex'): Promise<BinaryProbe> {
  const { stdout, code, failure } = await run(command, ['help'])
  if (failure) return { command, available: false, versions: [], error: failure }
  const raw = stdout.trim()
  const available = code === 0 && /synctex/i.test(raw)
  return {
    command,
    available,
    ...(await withPath(command)),
    versions: versionsOf(raw),
    raw,
    ...(available ? {} : { error: `exit ${code}` }),
  }
}

/** Resolve the source path for a successfully probed command. */
async function withPath(command: string): Promise<{ path?: string }> {
  const resolved = await which(command)
  return resolved ? { path: resolved } : {}
}

/** Platform-specific installation hints shown when a binary is missing. */
function guidanceFor(missing: readonly string[]): string[] {
  const lines: string[] = []
  if (missing.includes('tectonic')) {
    lines.push(
      'tectonic 未找到。官方二进制：win-x64 / macos-universal / linux-x64；arm64 需 `cargo install tectonic`。',
      'Windows x64 示例：下载 tectonic-<ver>-x86_64-pc-windows-msvc.zip，解压后把目录加入 PATH。',
    )
  }
  if (missing.includes('synctex')) {
    lines.push(
      'synctex 未找到。它随 TeX 发行版分发（Tectonic 部分版本自带，MiKTeX/TeX Live 亦有），需出现在 PATH 中。',
    )
  }
  return lines
}

/**
 * Probe both binaries in parallel and assemble the startup report.
 * @returns the report; callers decide whether a missing binary is fatal.
 */
export async function checkBinaries(): Promise<BinaryReport> {
  const [tectonic, synctex] = await Promise.all([probeTectonic(), probeSynctex()])
  const missing = [tectonic, synctex].filter((b) => !b.available).map((b) => b.command)
  return { tectonic, synctex, missing, guidance: guidanceFor(missing) }
}

/** Render a report as log lines (no colour, one fact per line). */
export function formatReport(report: BinaryReport): string[] {
  const line = (b: BinaryProbe) =>
    b.available
      ? `${b.command}: ok  ${b.path ?? '(path unresolved)'}  versions=[${b.versions.join(', ') || 'unknown'}]`
      : `${b.command}: MISSING  ${b.error ?? ''}`.trimEnd()
  return [line(report.tectonic), line(report.synctex), ...report.guidance]
}
