/**
 * The preview panel.
 *
 * Data flow (see docs/spikes.md §B1): the transport cannot push, so this polls
 * `getState()` and reacts to the `version` counter. A poll that returns the same
 * version does nothing — no re-render, no iframe reload.
 *
 * Scroll preservation ordering is the whole point of the iframe ref: capture the
 * old document's position **before** the new URL is assigned, restore after the
 * iframe reports `load`. Getting that order wrong is the bug users uninstall over.
 *
 * @module dsh-latex-preview/client/panel
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { POLL_INTERVAL_MS, unwrap, type PreviewApi } from './api.ts'
import { PDFViewer, PDFViewerAdapter } from './pdf-viewer.ts'
import type { DiffRegions, LatexDiagnostic, PreviewState, ReviewMode } from '../types.ts'

/** Everything the panel needs from the shell. */
export interface PanelProps {
  readonly api: PreviewApi
  /** Workspace file the panel should preview; omitted when the shell supplies none. */
  readonly file?: string
}

const styles = {
  root: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: '12px/1.5 system-ui, sans-serif' },
  bar: { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 8px', flexWrap: 'wrap' as const },
  button: {
    font: 'inherit',
    padding: '2px 8px',
    border: '1px solid rgba(0,0,0,.18)',
    borderRadius: 4,
    background: 'transparent',
    cursor: 'pointer',
  },
  status: { opacity: 0.75, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const },
  frame: { flex: '1 1 auto', minHeight: 0, border: 'none', width: '100%', background: '#f5f5f5' },
  list: { maxHeight: '30%', overflow: 'auto', margin: 0, padding: 0, listStyle: 'none', borderTop: '1px solid rgba(0,0,0,.1)' },
  item: { padding: '4px 8px', cursor: 'pointer', borderBottom: '1px solid rgba(0,0,0,.06)' },
  error: { color: '#b3261e' },
  warning: { color: '#8a6d00' },
  empty: { padding: 12, opacity: 0.7 },
} as const

/**
 * Session the sidebar is drawing this pane for.
 *
 * The panel cannot ask for it through props (the seat passes none) and the URL
 * carries no session id, but the sidebar marks the enclosing node with
 * `data-sidebar-right-session`. Reading it lets the Host resolve that Session's
 * Agent instead of relying on an initiator boundary an HTTP route never has.
 * @param node - any element inside the sidebar pane.
 * @returns the session key, or undefined outside a sidebar.
 */
function sessionIdOf(node: Element | null): string | undefined {
  return node?.closest('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session') ?? undefined
}

/**
 * Render the panel.
 * @param props - the Host API face and optional workspace file.
 * @returns the panel tree.
 */
export function LatexPreviewPanel({ api, file }: PanelProps): ReactNode {
  const [state, setState] = useState<PreviewState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [hits, setHits] = useState<string | null>(null)
  const [diff, setDiff] = useState<DiffRegions | null>(null)
  const [showDiff, setShowDiff] = useState(true)
  // Reverting writes the source file, so the button arms first and disarms itself.
  const [armRevert, setArmRevert] = useState(false)
  // Which document the iframe shows: the live PDF, or the latexdiff 对比视图.
  const [view, setView] = useState<'live' | 'diff'>('live')
  // Last built diff-doc URL; the Host also mirrors it in `state.diffDocUrl`, but
  // the swap must not wait for the next poll after the button click.
  const [diffDocUrl, setDiffDocUrl] = useState<string | null>(null)

  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const viewerRef = useRef<PDFViewer | null>(null)
  const lastVersion = useRef(-1)
  const lastUrl = useRef<string | null>(null)
  const configured = useRef(false)
  // The viewer announces `ready` after a document swap, which is the only moment
  // a message reaches it; these carry the latest overlay state there.
  const diffRef = useRef<DiffRegions | null>(null)
  const showDiffRef = useRef(true)
  showDiffRef.current = showDiff
  const viewRef = useRef<'live' | 'diff'>('live')
  viewRef.current = view

  /** Lazily create the viewer adapter once the iframe exists. */
  const viewer = useCallback((): PDFViewer | null => {
    const frame = frameRef.current
    if (!frame) return null
    if (!viewerRef.current) viewerRef.current = new PDFViewer(new PDFViewerAdapter(frame))
    return viewerRef.current
  }, [])

  // Point the Host at our workspace once. Without a file prop this asks the Host
  // to adopt its own working directory, which is the common "opened in a paper
  // folder" case.
  useEffect(() => {
    if (configured.current) return
    configured.current = true
    void unwrap(api.configure(file ? { file } : {})).then((result) => {
      if (!result.ok) setNotice(result.message)
    })
  }, [api, file])

  // Poll the Host. The transport has no push channel, so this is the data flow.
  useEffect(() => {
    let alive = true
    const tick = async () => {
      const result = await unwrap(api.getState())
      if (!alive) return
      if (!result.ok) {
        setNotice(result.message)
        return
      }
      if (result.value.version === lastVersion.current) return
      lastVersion.current = result.value.version
      setState(result.value)
    }
    void tick()
    const timer = window.setInterval(() => void tick(), POLL_INTERVAL_MS)
    return () => {
      alive = false
      window.clearInterval(timer)
    }
  }, [api])

  // Regions belong to one compiled revision. Fetch them whenever the version
  // moves, and drop the old ones immediately — showing last revision's bands on
  // a new PDF is worse than showing nothing.
  useEffect(() => {
    const version = state?.version
    if (version === undefined) return
    let alive = true
    setDiff(null)
    diffRef.current = null
    void (async () => {
      const result = await unwrap(api.getDiffRegions())
      if (!alive || !result.ok) return
      if (result.value.version !== lastVersion.current) return
      setDiff(result.value)
      diffRef.current = result.value
    })()
    return () => {
      alive = false
    }
  }, [api, state?.version])

  // Push on every change; `ready` pushes again, because a swapped document starts
  // with a fresh listener that missed everything sent before it existed.
  // Bands belong to the live PDF; the 对比视图 is a different document, so the
  // overlay is suppressed while it is on screen.
  useEffect(() => {
    diffRef.current = diff
    viewer()?.showDiff(diff?.regions ?? [], showDiff && view === 'live')
  }, [diff, showDiff, view, viewer])

  // Our PDF.js page when the assets are built, otherwise the raw PDF so the
  // browser's viewer still shows something. Swap only when the URL changed.
  // In 对比视图 the iframe shows the latexdiff document instead.
  const liveUrl = state?.viewerUrl ?? state?.pdfUrl ?? null
  const pdfUrl = view === 'diff' ? (diffDocUrl ?? liveUrl) : liveUrl
  useEffect(() => {
    if (!pdfUrl || pdfUrl === lastUrl.current) return
    const frame = frameRef.current
    if (!frame) return
    // Must happen before the new document loads, even across a viewer swap.
    viewer()?.captureScrollState()
    lastUrl.current = pdfUrl
    frame.src = pdfUrl
  }, [pdfUrl, viewer])

  // The viewer reports readiness and double-clicks over postMessage; `load` on
  // the iframe fires before the PDF has any pages, so `ready` is the reliable
  // moment to restore scroll and to accept reverse jumps.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as
        | {
            source?: string
            type?: string
            page?: number
            x?: number
            y?: number
            x2?: number
            y2?: number
            text?: string
            instruction?: string
            line?: number
            title?: string
            message?: string
          }
        | null
      if (!data || data.source !== 'latex-preview-viewer') return
      if (data.type === 'ready') {
        viewer()?.restoreScrollState()
        viewer()?.showDiff(diffRef.current?.regions ?? [], showDiffRef.current && viewRef.current === 'live')
        return
      }
      if (data.type === 'error' && data.message) {
        setNotice(data.message)
        return
      }
      if (data.type === 'edit-request' && typeof data.page === 'number' && typeof data.instruction === 'string') {
        const request = {
          page: data.page,
          x: data.x ?? 0,
          y: data.y ?? 0,
          ...(typeof data.x2 === 'number' ? { x2: data.x2 } : {}),
          ...(typeof data.y2 === 'number' ? { y2: data.y2 } : {}),
          instruction: data.instruction,
          ...(data.text ? { text: data.text } : {}),
          sessionId: sessionIdOf(frameRef.current),
        }
        void (async () => {
          setNotice('正在定位源码并发送…')
          const result = await unwrap(api.editAt(request))
          if (!result.ok) {
            setNotice(result.message)
            return
          }
          const where = result.value.lineEnd && result.value.lineEnd !== result.value.line
            ? `${result.value.file}:${result.value.line}-${result.value.lineEnd}`
            : `${result.value.file}:${result.value.line}`
          setNotice(`已把修改要求发给 Agent（${where}）`)
        })()
        return
      }
      if (data.type === 'diff-click' && typeof data.line === 'number') {
        // Pin what the hover tooltip said; it disappears with the cursor.
        setHits(typeof data.title === 'string' && data.title !== '' ? data.title : `差异位置：第 ${data.line} 行`)
        return
      }
      if (data.type === 'sync-reverse' && typeof data.page === 'number') {
        void (async () => {
          const result = await unwrap(api.jumpToSource({ page: data.page as number, x: data.x ?? 0, y: data.y ?? 0 }))
          if (!result.ok) {
            setNotice(result.message)
            return
          }
          const hit = result.value[0]
          setHits(hit ? `反向跳转：第 ${hit.line} 行` : '该位置没有源码映射')
        })()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [api, viewer])

  useEffect(() => {
    if (!armRevert) return
    const timer = window.setTimeout(() => setArmRevert(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armRevert])

  // `state.version` the currently shown diff document was built at.
  const diffDocAt = useRef(-1)
  // The Host clears `diffDocUrl` when the revision moves (accept, revert, a
  // compile with new content); a version at or below the build's cannot have
  // cleared it, which is what stops this from firing in the gap between the
  // click and the next poll.
  useEffect(() => {
    if (view !== 'diff') return
    if (state && state.diffDocUrl === null && state.version > diffDocAt.current) setView('live')
  }, [state, view])

  /** Run one action with the busy flag and a single error channel. */
  const run = useCallback(async (action: () => Promise<{ ok: boolean; message?: string }>) => {
    setWorking(true)
    setNotice(null)
    try {
      const result = await action()
      if (!result.ok && result.message) setNotice(result.message)
    } finally {
      setWorking(false)
    }
  }, [])

  const onCompile = useCallback(() => {
    void run(async () => {
      const result = await unwrap(api.compileNow())
      return result.ok ? { ok: true } : { ok: false, message: result.message }
    })
  }, [api, run])

  const onSendToAgent = useCallback(() => {
    void run(async () => {
      const result = await unwrap(api.sendErrorToAgent({ sessionId: sessionIdOf(frameRef.current) }))
      if (!result.ok) return { ok: false, message: result.message }
      setNotice('错误已发送给 Agent')
      return { ok: true }
    })
  }, [api, run])

  const onToggleRedact = useCallback(
    (redact: boolean) => {
      void run(async () => {
        const result = await unwrap(api.configure({ redact }))
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      })
    },
    [api, run],
  )

  const onSetReview = useCallback(
    (review: ReviewMode) => {
      void run(async () => {
        const result = await unwrap(api.configure({ review }))
        return result.ok ? { ok: true } : { ok: false, message: result.message }
      })
    },
    [api, run],
  )

  const onAccept = useCallback(() => {
    void run(async () => {
      const result = await unwrap(api.acceptChanges())
      if (!result.ok) return { ok: false, message: result.message }
      setNotice('已接受这次改动')
      return { ok: true }
    })
  }, [api, run])

  const onRevert = useCallback(() => {
    if (!armRevert) {
      setArmRevert(true)
      setNotice('再点一次「确认撤销」：源码会写回上一版并重新编译')
      return
    }
    setArmRevert(false)
    void run(async () => {
      const result = await unwrap(api.revertChanges())
      if (!result.ok) return { ok: false, message: result.message }
      setNotice('已回滚到上一版')
      return { ok: true }
    })
  }, [api, run, armRevert])

  /** Enter or leave the latexdiff 对比视图 (deletions visible, struck through). */
  const onDiffDoc = useCallback(() => {
    if (view === 'diff') {
      setView('live')
      return
    }
    void run(async () => {
      const result = await unwrap(api.buildDiffDoc())
      if (!result.ok) return { ok: false, message: result.message }
      const value = result.value
      if (!value.ok || !value.url) {
        return { ok: false, message: value.detail ? `${value.message}：${value.detail}` : value.message }
      }
      diffDocAt.current = value.version
      setDiffDocUrl(value.url)
      setView('diff')
      return { ok: true }
    })
  }, [api, run, view])

  const onSelectDiagnostic = useCallback(
    (diagnostic: LatexDiagnostic) => {
      void run(async () => {
        const result = await unwrap(api.jumpToPdf({ line: diagnostic.line }))
        if (!result.ok) return { ok: false, message: result.message }
        const hit = result.value[0]
        if (!hit) {
          setHits('该位置没有 PDF 映射（可能在导言区或宏定义内）')
          return { ok: true }
        }
        viewer()?.jumpToPage(hit.page)
        setHits(`第 ${hit.page} 页 · x=${hit.x.toFixed(1)} y=${hit.y.toFixed(1)}`)
        return { ok: true }
      })
    },
    [api, run, viewer],
  )

  // One hunk paints several bands, so count distinct hunks, not rectangles.
  const diffCount = useMemo(
    () => new Set((diff?.regions ?? []).map((region) => `${region.kind}:${region.lineStart}`)).size,
    [diff],
  )

  const errors = useMemo(() => state?.diagnostics.filter((d) => d.severity === 'error') ?? [], [state])
  const warnings = useMemo(() => state?.diagnostics.filter((d) => d.severity === 'warning') ?? [], [state])

  if (!state) {
    return <div style={styles.root}><div style={styles.empty}>正在连接 LaTeX Preview 服务…</div></div>
  }

  if (!state.binaries.tectonic) {
    return (
      <div style={styles.root}>
        <div style={styles.empty}>
          未检测到 <code>tectonic</code>。请先安装并确保它在 PATH 中，然后点下面的按钮重新检测。
          <div style={{ marginTop: 8 }}>
            <button style={styles.button} onClick={() => void run(async () => unwrap(api.recheckBinaries()).then((r) => ({ ok: r.ok })))}>
              重新检测
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.root}>
      <div style={styles.bar}>
        <button style={styles.button} disabled={working} onClick={onCompile}>
          {state.status === 'compiling' ? '编译中…' : '编译'}
        </button>
        <select
          style={{ ...styles.button, paddingRight: 2 }}
          value={state.review}
          disabled={working}
          onChange={(event) => onSetReview(event.target.value as ReviewMode)}
          title="改动审核方式：手动=每一步都要你接受；自动=派一个独立 AI 审，不通过自动回滚；完全放开=不设闸门"
        >
          <option value="manual">手动审核</option>
          <option value="auto">自动审核（独立 AI）</option>
          <option value="open">完全放开</option>
        </select>
        <button
          style={styles.button}
          disabled={working || errors.length === 0}
          onClick={onSendToAgent}
          title={
            errors.length === 0
              ? '上次编译没有错误，无需发送'
              : '把这次的编译错误发给当前会话的 Agent'
          }
        >
          发送给 Agent
        </button>
        {diffCount > 0 && state.review === 'manual' && (
          <button
            style={{ ...styles.button, borderColor: '#1a7f37', color: '#1a7f37' }}
            disabled={working}
            onClick={onAccept}
            title="把这次改动记为已接受，清掉标记"
          >
            接受 {diffCount}
          </button>
        )}
        {diffCount > 0 && state.review !== 'open' && (
          <button
            style={{ ...styles.button, ...(armRevert ? { borderColor: '#cf222e', color: '#cf222e' } : {}) }}
            disabled={working}
            onClick={onRevert}
            title="把源码写回上一版已接受的版本，并重新编译"
          >
            {armRevert ? '确认撤销' : '撤销'}
          </button>
        )}
        <button
          style={{ ...styles.button, opacity: diffCount === 0 ? 0.5 : showDiff ? 1 : 0.65 }}
          disabled={diffCount === 0}
          onClick={() => setShowDiff((value) => !value)}
          title={
            diffCount === 0
              ? '与上一次编译相比没有变化'
              : `${showDiff ? '隐藏' : '显示'}高亮：${diffCount} 处改动${
                  diff && diff.skipped > 0 ? `（另有 ${diff.skipped} 处超出标注上限）` : ''
                }`
          }
        >
          差异 {diffCount}
        </button>
        <button
          style={{ ...styles.button, opacity: view === 'diff' ? 1 : diffCount === 0 ? 0.5 : 0.85 }}
          disabled={working || (diffCount === 0 && view === 'live')}
          onClick={onDiffDoc}
          title={
            view === 'diff'
              ? '回到当前 PDF'
              : '生成并查看 latexdiff 对比版 PDF：删除的文字以红色删除线渲染、新增的文字带颜色；需要一次额外编译'
          }
        >
          {view === 'diff' ? '退出对比' : '对比'}
        </button>
        <label style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <input type="checkbox" checked={state.redact} onChange={(event) => onToggleRedact(event.target.checked)} />
          脱敏
        </label>
        <span style={styles.status} title={state.rootFile ?? ''}>
          {notice ?? hits ?? state.message ?? (state.rootFile ? state.rootFile : '未配置主文件')}
        </span>
      </div>

      <iframe
        ref={frameRef}
        style={styles.frame}
        title="LaTeX PDF preview"
        onLoad={() => viewer()?.restoreScrollState()}
      />

      {(errors.length > 0 || warnings.length > 0) && (
        <ul style={styles.list}>
          {[...errors, ...warnings].map((diagnostic, index) => (
            <li
              key={`${diagnostic.file}:${diagnostic.line}:${index}`}
              style={{ ...styles.item, ...(diagnostic.severity === 'error' ? styles.error : styles.warning) }}
              onClick={() => onSelectDiagnostic(diagnostic)}
              title={diagnostic.context}
            >
              {diagnostic.severity === 'error' ? '✕' : '!'}{' '}
              {diagnostic.line > 0 ? `第 ${diagnostic.line} 行 · ` : ''}
              {diagnostic.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
