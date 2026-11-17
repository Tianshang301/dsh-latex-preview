# Changelog

Notable changes to `dsh-latex-preview`. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

**No release has been cut yet.** `package.json` is still `0.0.0` and there are no tags, so everything below is the initial implementation gathered under `[Unreleased]`. It is grouped by capability rather than by commit, because one day of work added the whole product.

## [Unreleased]

### Added

**Preview pipeline**

- Live preview: a chokidar watcher (500 ms debounce) recompiles the root file on save; the first compile gets 300 s, later ones 120 s.
- Compile safety: the current PDF is copied to `.pdf.prev` before each run and restored on failure, so a broken edit never blanks the page.
- Bundled PDF.js viewer. `pdfjs-dist` ships components only (no `viewer.html`), so `viewer/` is a 38-line page assembled from `web/pdf_viewer.mjs`; `scripts/build-assets.mjs` copies the runtime and the page into `assets/` (~5 MiB, git-ignored), mounted from the module's own directory rather than `process.cwd()`.
- Scroll preservation across recompiles, with the restored page clamped (`Math.min`) because PDF.js silently ignores an out-of-range page.
- Diagnostics parsed out of the Tectonic log, rendered under the PDF; clicking one reverse-jumps to its source line.

**SyncTeX, both directions**

- Source line → PDF rectangle (`synctex view`), used by `jump-to-pdf` and by the diff overlay.
- PDF point → source line (`synctex edit`), used by the double-click reverse jump and by point-and-edit.
- Both answers are surfaced through the panel's status area rather than a modal, because they are consulted constantly.

**Point-and-edit**

- Select text in the PDF, or drag a rubber-band region where there is no text layer, and an inline bar appears for a one-line instruction.
- The Host reverse-jumps **both corners** into a source line range (capped at 12 lines, `MAX_EDIT_LINES`) and hands the Agent that range plus the sentence.
- **The PDF is an anchor, never the content**: what reaches the Agent is source lines, not extracted PDF text, because formulas and ligatures extract badly. The selected string rides along as an explicitly unreliable hint.

**Diff on the PDF**

- `差异 N` toggle paints the lines this compile changed: green for added, amber for modified, red for removed.
- Hover a band for its source line and text; click to pin that description in the status area.
- The reference is the **previous compiled revision**, not the file on disk — see the baseline fix below.
- Caps: 24 hunks and 40 resolved lines per revision. Longer blocks are **sampled evenly** rather than truncated (highlighting only the top would imply the change ends there); the surplus is reported in the button's title instead of being silently dropped.

**Deletions, two layers**

- The overlay carries the removed source lines (`DiffRegion.text`, 8 lines × 200 chars), draws a `−N 行` chip at the text column's right edge, and pops the removed lines up struck through on hover in a monospace flyout.
- `对比` / Compare re-typesets: `latexdiff` merges the accepted and current revisions into a third document, compiled on demand via `POST diff-doc`. Removed text is typeset struck through in red, added text coloured — the only fully faithful rendering of a deletion. Single-flight, inherits the compile timeout, and a failed diff build keeps the last diff PDF.
- The overlay layer needs no extra binary, so deletions stay visible even where `latexdiff` is unavailable.

**Review gate**

- Three modes, switchable from the toolbar:
  - `手动审核` — nothing counts until 接受; the reference stays put, so the marks accumulate every unaccepted change.
  - `自动审核` — a **separate one-shot model call** reviews the change: its own system prompt, no tools, no history.
  - `完全放开` — the reference advances immediately; no gate, no revert.
- The reviewer is deliberately **not** the session's Agent, because that Agent is the thing that wrote the change and can still edit it.
- 接受 clears the marks; 撤销 writes the source back to the last accepted revision and recompiles. That is the plugin's only destructive action, so the button arms on a second click.
- Reviewer route comes from `agent.session.requestHeader().config` — the same source the first-party auto-review layer reads — falling back to `agentDefaultModel.currentSelection()` because a fresh Session publishes no header until its first turn.
- A missing route, an unparsable verdict, a failed call or a 25 s timeout degrades to **manual**, never to approval.

**Previous-revision artefacts**

- Every compile keeps the PDF **and** its `.synctex.gz` of the revision that preceded it, as one pair (`main.prev.pdf` ↔ `main.prev.synctex.gz`; the names must match because `synctex view -o` finds the map by name).
- The pair becomes a *baseline* only when the baseline actually moves: 接受, auto approval or revert copy the artefacts on screen; a pending manual change deletes the pair instead of leaving a snapshot that would map old line numbers onto the wrong document.
- State publishes `basePdfUrl`, `baseViewerUrl` and `baseRevisionId` (a digest of the baseline source) so the UI can show a previous revision — and refuse to when the pairing is not provable. Nothing draws it yet; this is the groundwork for viewing deleted content in its original typesetting.

**Client and integration**

- Keyed right-sidebar tab, declared through `sidebarRightTabs.register` plus the `sidebar.right.pane.tab` / `.title` slots; slot-only registration renders nothing.
- The panel talks to the Host over its own same-origin JSON route `/.latex-preview/api/*` (13 routes), because the client half cannot reach a Host service.
- 13 `@Remote` methods mirror the routes for in-process callers.
- `发送给 Agent` hands the current compile failure to the session, with a redaction switch.

### Changed

- Deletion rendering went from a 2 px dashed seam to a 7 px red hatched band to a chip plus struck-through hover flyout, because a seam cannot say *what* was removed and a filled band reads as "this line changed".
- `viewer/index.html` imports `viewer.js?v=<page version>`; `/assets` is served with `max-age=3600`, so a rebuilt viewer used to land an hour late.
- README split into an English main page and `README.zh.md`; both link to each other and are edited in the same commit.

### Fixed

- **PDF coordinates were scaled twice.** `page.getViewport({ scale: 1 })` already returns points (Letter → 612×792), but the click-to-point path also applied `72/96`, shrinking y to 0.75 and landing every lookup a few lines high — sometimes off the page.
- **`synctex view`'s `y` is not the box top.** Comparing candidate rectangles against the text layer's spans showed `v - H` coincides with the line (full vertical overlap) while `y` sits below it, so every diff band was drawn a line low.
- **`getDiff` always returned empty.** `previousSource` was overwritten with the current file after every successful compile, i.e. `diff(x, x)`. It now holds the previous *compiled* revision, alongside `compiledSource` for the current PDF, and only advances when the content actually changed — so pressing 编译 twice no longer erases the marks.
- **A deletion seam could land in the footer.** `synctex view` answers for `\end{document}` with the *page-number* box, so anchoring at the line after the hole put the marker at the bottom of the sheet. It now anchors at the foot of the line **above** the hole, and counts the hunk as skipped when nothing near it maps.
- **`发送给 Agent` failed on the HTTP route** even with real errors: `agents.currentInitiator()` only resolves inside a driver's async boundary, so it is always empty for a request. The panel now reads `data-sidebar-right-session` from its pane and the Host resolves `agents.get(id)` (both key spellings), falling back to the initiator chain.
- **A compile that could not start left the panel stuck on `正在编译`.** `compiler.run()` throwing (not failing) had no terminal state; it is now patched to `failed` before rethrowing.
- **A failed compile left the PDF and its sync map out of step.** Only the PDF was backed up and restored, so `.synctex.gz` kept whatever the failed run wrote — the screen showed the old document while reverse lookup used the new map, landing on the wrong line without any error. Both files are now copied aside and restored together; verified byte-identical before and after an induced failure.
- **`scrollPageIntoView` received a string page number.** PDF.js only warns on that, so scroll restoration was failing silently.
- **The diff overlay could paint a stale layer over a fresh one.** `paintDiffPage` awaits `getPage()`, and `pagerendered` fires again on every zoom and scroll, so two paints of one page could interleave — a slow older one would append its band after the newer one, leaving two `.diffLayer`s and hit-test entries for a layer that no longer existed. Painting now carries a generation and a per-page ticket and discards its own result when either moved; the new layer is swapped in before the old one is removed. Verified with 40 rapid zoom changes: one layer per page, no orphans.
- **Band colours depended on what was underneath.** `mix-blend-mode: multiply` tinted every band with the page content, so the same amber was pale over text and nearly invisible over a dark formula. Bands now composite normally (alpha only), with the left gutter carrying the kind.
- **The deletion seam was a fixed 7 px**, i.e. thicker than the text at 50 % zoom and a hairline at 200 %. It now follows the line height, clamped to 2–8 px.
- **`viewer.css` was cached for an hour** while `viewer.js` was already versioned, so a style fix looked like it had no effect. Both now carry the page's `?v=`.
- Hand-off prompt source is `{ kind: 'user' }` — `dsh-llm@0.2.2-rc.1` removed the `plugin` kind the design doc assumed.

### Docs

- `docs/spikes.md` §B11–§B18 record the verified contracts and the three findings above, including the geometry sweeps that produced them.
- `AGENTS.md` carries the repo-state invariants: box top is `v - H`, bands are `pointer-events: none` and positioned in percent, the diff baseline is two *compiled* snapshots, the reviewer must not be the session's Agent, and both READMEs change in one commit.
- MIT `LICENSE`, © 2026 Tianshang301; `package.json` gained a matching `author`.
- README (both languages) describes what the panel actually does: the toolbar shows `接受`/`撤销`/`差异`/`对比`/`脱敏` conditionally, clicking a diagnostic scrolls the **PDF** to that line (not the editor), double-click only names the line in the status line, `latexdiff` is listed as an optional requirement, and a review-mode table states what each mode does to the reference.

### Security / privacy

- Compiling, rendering, SyncTeX and diffing stay local. Content enters the Agent session only on an explicit send or point-and-edit; auto review is the one path that sends anything to a model provider (below).
- `redact` (off by default) sends "message + line number" only: no source lines, no selected text.
- **Auto review is the one path that sends content to a model provider**: the diff between the accepted and current revision goes to whichever provider/model the session is configured for. It runs only when that mode is selected.

### Known limits

- Reverse lookup and the highlight are **line-accurate, not character-accurate**; `Column` from SyncTeX is often `-1`.
- Scanned PDFs have no text layer, so boxing may fail to resolve.
- Cross-page selections reverse-jump only the part on the current page.
- Deletions are shown as a chip plus hover text, not re-typeset, unless `对比` is used — and MiKTeX's `latexdiff.exe` needs a system Perl, absent on some Windows machines; the probe degrades to an install hint rather than throwing.
- Auto review spends model calls and can be wrong.
- `tectonic` and `synctex` are user-provided binaries, verified at startup; a missing one reports `binary-missing` rather than failing quietly.
