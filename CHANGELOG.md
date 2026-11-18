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

**Artefact provenance**

- **A revision is published only when this process can prove it produced the bytes.** A manifest records *integrity* (these are the bytes it named), which is a different claim from *provenance* (they were compiled from that revision). `services/provenance.ts` holds the credential: workspace, source digest, and both file hashes, issued only right after a compile that read a source it re-read unchanged. All three publish sites check it — 上次编译版, 已接受版 from the backup, and 已接受版 from the current PDF. No credential means no revision, never a guess.
- **The compile's backup is a decision, not a copy.** `BackupResult` is `complete` / `pdf-only` / `unavailable` / `failed`; the two files are copied to `.tmp` names and renamed only once both succeeded, and the hashes are recorded so the service can confirm the bytes it is about to claim. `complete` is required before anything may be published.
- **Compiles are serialised at the service level.** `CompileService.run` already single-flights the process, but the revision snapshots and the artefact publishes are this service's own bookkeeping, and two interleaved bookkeepings are not one.
- **A redundant compile republishes nothing.** "上次编译" answers *what did the last save change*; a compile of unchanged content has no answer, and letting it overwrite the pair loses the comparison.
- **A restart re-adopts an accepted pair** when its manifest still names the source on disk, and the restore result is committed in the same state patch as the rest of the configuration instead of being patched separately first.
- `npm test` now runs 54 cases, including service-level ones that drive a real `LatexPreviewService` in a real Cordis context with a real `CompileService` whose process is faked (`ServiceOptions.compileFactory`). `.github/workflows/ci.yml` runs typecheck, test typecheck and tests on Node 22 via pnpm.

**Previous-revision view**

- `上次编译版` shows the PDF of the revision the diff is measured against, with the lines that have since been **deleted** painted as ordinary red bands with a midline strikethrough — the one place that text is still typeset, in its original position. The live PDF can only ever show a seam there.
- The old bands come from the *old* line numbers looked up in the *old* SyncTeX (`.prev.pdf` ↔ `.prev.synctex.gz`), so a deletion is placed by measurement rather than by guessing the seam above the hole. Verified round-trip: old line 7 resolves to the deleted paragraph's box and reads back as line 7, while a line that exists only in the old revision resolves there and not in the new document.
- That view is **read-only**: selection, double-click and band clicks resolve against old line numbers, so they are suppressed rather than answered wrongly. Text stays selectable/copyable.
- Pure insertions keep the seam treatment there (the old page has nothing to tint), pointing at the line the new text was inserted after. A base view that cannot be proven to pair with the baseline says so instead of drawing nothing.

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
- State publishes `basePdfUrl`, `baseViewerUrl` and `baseRevisionId` (a digest of the baseline source) so the UI can show a previous revision — and refuse to when the pairing is not provable. The `上次编译版` view is what consumes it.

**Client and integration**

- Keyed right-sidebar tab, declared through `sidebarRightTabs.register` plus the `sidebar.right.pane.tab` / `.title` slots; slot-only registration renders nothing.
- The panel talks to the Host over its own same-origin JSON route `/.latex-preview/api/*` (13 routes), because the client half cannot reach a Host service.
- 13 `@Remote` methods mirror the routes for in-process callers.
- `发送给 Agent` hands the current compile failure to the session, with a redaction switch.

**Revision model and artefact integrity**

- Three source snapshots with distinct jobs, encoded once in `services/revisions.ts` and tested there: **accepted** (moves on 接受 / approving reviewer / every `open` compile), **previous compile** (moves on every successful compile whose content changed), **current** (what the PDF on screen was built from). `manual` makes the first two diverge at the first unaccepted change and keeps them apart, which is the entire reason for having both.
- Two diff paths, each with its own left-hand side and its own document: `new` = accepted → current drawn on the live PDF; `base` = the same comparison drawn on the accepted revision's PDF; `compile` = previous compile → current drawn on the previous compile's PDF. Sides are parsed by one function (`parseDiffSide`) so the Remote method and the HTTP route cannot disagree.
- `上次编译版` now means the previous compile (path B, "what did this save change") and `已接受版` is a separate button for path A ("where did the unaccepted deletion go"), each shown only when its pair verifies.
- **Artefacts are published as a transaction** (`services/artifacts.ts`): a PDF + `.synctex.gz` pair is installed under a manifest that records both files' sha256 and the source revision it describes. `verify()` trusts the pair only when the manifest exists and both hashes still match; publishing removes the manifest first, installs both files, and writes the manifest last, so a crash at any point leaves nothing trustworthy behind. Both revision views refuse to draw from an unverified pair and say so.
- `main.prev.*` (accepted) and `main.recent.*` (previous compile) are separate pairs; compiles no longer overwrite the accepted pair, so it survives several pending compiles instead of being discarded.

**Tests**

- `npm test` runs `tsx --test test/unit/*.test.ts` — `node:test`, no new dependency. The first suite pins the previous-revision insertion anchor: above the first line, between two lines, after the last line, in front of a closing tag, and the clamps at both ends. It also asserts the diff really emits a *pure* insertion (0 old lines) for each, so the anchor rule cannot silently start applying to a `modify`.

### Changed

- `getDiffRegions` takes `{ side: 'new' | 'base' | 'compile' }` and every region says which document it describes; the panel fetches only the side on screen (each one costs a `synctex view` sweep).
- Diff bands are now positioned by the document's own line numbering on both sides: the source diff carries `oldStart`/`oldLines` alongside the new ones, which is what makes an old-revision lookup possible at all.
- Deletion rendering went from a 2 px dashed seam to a 7 px red hatched band to a chip plus struck-through hover flyout, because a seam cannot say *what* was removed and a filled band reads as "this line changed".
- `viewer/index.html` imports `viewer.js?v=<page version>`; `/assets` is served with `max-age=3600`, so a rebuilt viewer used to land an hour late.
- README split into an English main page and `README.zh.md`; both link to each other and are edited in the same commit.

### Fixed

- **A leftover PDF could be published as the revision currently on disk.** The pre-compile copy was taken from whatever `main.pdf` happened to be there — possibly compiled by an earlier session from a different source — and committed under the digest of the file just read. Both revision views would then draw correct-looking bands in wrong places, with every hash check passing. Fixed by the credential above: nothing is published without a compile this process ran and verified.
- **`configure` restored artefacts before the state knew the root file, then erased them.** `restoreArtifacts()` read `state.rootFile` (still null on the first configure of a process, so it silently did nothing) and the configuration patch that followed reset the six publication fields anyway. The restore now takes the workspace explicitly and returns state fields, so exactly one snapshot is committed.
- **`outDir` never fell back to the workspace.** The constructor seeds `outDir` with `<cwd>/.latex-preview`, and `configure` used `request.outDir ?? this.outDir ?? <rootDir>/.latex-preview` — the middle term is always set, so a workspace outside the process directory compiled its artefacts into the wrong folder. The seeded value is now tracked as a default rather than a choice.
- **Switching workspace kept the previous PDF on screen** and skipped the first compile, because the automatic compile is gated on `pdfUrl` being empty.
- **撤销 named the wrong revision as its predecessor.** `applyRevert` moved `currentSource` to the baseline before compiling, so the compile believed it was replacing the *baseline* rather than the document being discarded: the previous-compile pair was published with the wrong digest (or, after the credential check, dropped). The revert now passes `beforeOverride` and suppresses the reviewer.
- **A failed backup is not a rollback.** With the pair uncopyable, the service reported `rolledBack` from a restore that had nothing to restore from; the result now carries the backup status and a `failed` backup forces `rollbackIncomplete`.
- **A compile whose input changed mid-run claimed the new source.** The PDF belongs to neither snapshot then, so the credential is withheld and a follow-up compile converges.
- **`baseRegions()` always answered `side: 'base'`,** even for a 上次编译版 request — the panel keys results by the side it asked for, so this was invisible until something read the field.
- **A failed compile could report a clean rollback after restoring only the PDF.** `rolledBack` came from the PDF's restore alone, so a sync map that could not be put back left the state claiming "rolled back" while reverse jumps read a map for a document that was no longer on screen. Both halves are now restored and reported together (`rollbackIncomplete`), and both revision pairs are dropped when they could not be.
- **A first compile that failed left its partial output behind.** With no previous PDF to restore, the failed run's half-written `main.pdf` stayed on disk and could be served as if it had compiled; it is now removed, along with its sync map.

- **Every diff line number was one too high, which put bands on the wrong line.** `diff_cleanupSemantic` was being run *after* `diff_charsToLines_`, so it moved fragment boundaries to character-level semantic edges — a fragment then began with a newline that actually terminated the previous line, and each block's line count gained one. A paragraph split in three painted the line after the change. Normalisation now runs while the text is still one character per line, so fragments stay line-aligned and the counts are exact.
- **A blank line inside a change painted an unchanged line.** `synctex view` has no box for an empty line and answers with the *next* rendered line's box, so a deleted paragraph whose range included the blank line after it produced two bands, the second over text nobody had touched. Blank lines are dropped from the resolved range on both sides.
- **An insertion just above `\end{document}` marked the page footer.** The previous-revision seam for a pure insertion was anchored at `hunk.oldStart` — the first old line *after* the insertion — instead of the line before it. Above the closing tag that anchor is `\end{document}` itself, and `synctex view` answers for it with the page-number box (measured on a real compile: y≈695.6, the footer, versus 197.6 for the right line). `insertionAnchor()` now decides the line **and** which edge to draw on, so an insertion at the very top of a file hangs on line 1's top edge instead of being clamped to its bottom; the walk to that anchor also skips blank and comment-only lines, which answer with the *next* rendered line's box and had put a mid-document insertion one paragraph low.
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
- The previous-revision view only exists while the baseline's artefacts are still paired with it. A pending change that the baseline has not moved to, a revert, or a fresh process deletes the pair, and the view then says so.
- That view is read-only by construction: its line numbers belong to the old source.
- Scanned PDFs have no text layer, so boxing may fail to resolve.
- Cross-page selections reverse-jump only the part on the current page.
- Deletions are shown as a chip plus hover text, not re-typeset, unless `对比` is used — and MiKTeX's `latexdiff.exe` needs a system Perl, absent on some Windows machines; the probe degrades to an install hint rather than throwing.
- Auto review spends model calls and can be wrong.
- `tectonic` and `synctex` are user-provided binaries, verified at startup; a missing one reports `binary-missing` rather than failing quietly.
