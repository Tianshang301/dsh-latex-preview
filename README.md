# dsh-latex-preview

**Write LaTeX inside DSH (DeepSeek Harness): save and the PDF is already there, compile errors go straight to the Agent, and you can point at a spot in the PDF to have it changed.**

A Cordis dual-half plugin (Host = Node, Client = Web) that puts Tectonic compilation, PDF.js preview, and two-way SyncTeX navigation into the right sidebar.

English · [简体中文](README.zh.md)

---

## The problem it removes

The LaTeX loop usually goes like this: edit the `.tex` → switch to a terminal → compile → wait → find the error line in the PDF → hunt for the matching source line. Three context switches per typo.

This plugin collapses that into the sidebar:

| While writing | When it breaks | When you want something changed |
|---|---|---|
| Save → compile → PDF refreshes in place, scroll position kept | Click a diagnostic to scroll the PDF to where that line landed | Select or box a region in the PDF → one sentence → the Agent edits the source → recompile |

Compiling, rendering, SyncTeX, and diffing all run **on your machine**. Only what you explicitly send reaches the Agent session — plus the change diff when auto review is on (see [Privacy boundary](#privacy-boundary)).

## Features

- **Live preview** — `chokidar` watch plus a 500 ms debounce; save and the PDF refreshes in place.
- **Scroll preservation** — your reading position survives the refresh. This is deliberate, not incidental: `captureScrollState()` has to run **before** the new PDF loads.
- **A failed compile never blanks the preview** — the old PDF is copied to `.pdf.prev` before compiling and restored on failure.
- **Two-way SyncTeX** — double-click the PDF and the status line names the source line under the cursor; click a diagnostic and the PDF scrolls to where that line landed. Always shells out to the `synctex` CLI; the `.synctex` file is never hand-parsed.
- **One-click error hand-off** — builds a prompt from "file:line + message + source context" and steers it into the current session. The Agent fixes the `.tex`, the watcher recompiles.
- **Point at the PDF, change the source** — select text, or drag a box over anything → an inline bar appears → type one sentence → the Agent receives the **source line range** to edit.
- **Three review modes** — `手动审核` (you accept every change), `自动审核` (a **separate AI** reviews each change and rolls the source back when it says no), `完全放开` (no gate). The verdict and its reason land in the status bar.
- **Diff highlight on the PDF (git-diff look)** — a `差异 N` button and coloured bands over the lines this compile changed: green for added, amber for modified, with a red/green **gutter strip** on each band's left edge; a deletion draws a red hatched seam plus a `−N 行` count chip. **Hovering a seam pops the removed source lines up — struck through, monospace, red** — the deleted words have no pixels left in the new PDF, and this is the only way to show them without re-typesetting. Click to pin in the status bar. Computed against the *previous compiled* revision, not the file on disk.
- **对比视图 (latexdiff view, optional)** — the `对比` button hands the accepted and current revisions to `latexdiff`, which merges them into a third document that is then compiled: removed text is **typeset struck through in red**, added text is coloured — as readable as a git diff. Costs one extra compile and requires `latexdiff` (MiKTeX's `latexdiff.exe` additionally needs Perl on Windows, e.g. Strawberry Perl); when it is missing the button explains instead of failing.
- **Redaction switch** — when on, only "message + line number" is sent; no source, no selected text.
- **Clickable diagnostics** — clicking an error or warning scrolls the PDF to where that source line landed, printing the page and coordinates in the status line (the reverse direction, source → PDF).

## Requirements

| Dependency | Notes |
|---|---|
| DSH | `0.2.2-rc.1` (the plugin targets this version's Typert / slots contracts) |
| Node.js | ≥ 20 (developed on 22.x) |
| `tectonic` | **You install it** and put it on `PATH`; verified at startup |
| `synctex` | Shipped with your TeX distribution, **must be on `PATH`**; verified at startup |
| `latexdiff` | **Optional**, only for `对比`; MiKTeX's `latexdiff.exe` additionally needs Perl |

Official `tectonic` binaries cover win-x64 / macos-universal / linux-x64; on arm64 use `cargo install tectonic`. When something is missing the panel names it (`latex-preview/binary-missing`) instead of failing silently.

## Install

The plugin is mounted as "a directory plus a Cordis patch". Put it in your workspace's `node_modules`, then declare it:

```bash
# 1. Get the plugin (or drop this repo in place)
cd your-workspace
mkdir -p node_modules
ln -s /path/to/dsh-latex-preview node_modules/dsh-latex-preview   # Windows: mklink /D

# 2. Build it
cd node_modules/dsh-latex-preview
npm install
npm run build        # tsc + client bundle + assets

# 3. Write a patch
cd your-workspace
cat > latex-preview.yml <<'EOF'
- insert:
    - id: latex-preview
      name: dsh-latex-preview
EOF

# 4. Start
npx dsh web --patch ./latex-preview.yml
```

A LaTeX preview tab shows up in the right sidebar. `main.tex` in the workspace root is the default compile entry; the panel can change it.

> `assets/` and `lib/` are build output (git-ignored). `npm run build` copies the PDF.js runtime and the viewer page into `assets/` (~5 MiB).

## Usage

### The panel

The top strip is one row: `编译` / Compile, a **review-mode** dropdown, `发送给 Agent` / Send to Agent, then the controls that only exist when they mean something — `接受 N` (manual review, changes pending), `撤销` / Revert (any mode but open, changes pending), `差异 N` (disabled when this compile changed nothing), `对比` / Diff view, and the `脱敏` / Redaction checkbox, ending with a status line (compile result and duration, or the last message). The middle is the PDF, the bottom is the diagnostics list. If `tectonic` is missing the whole panel is replaced by an install hint and a `重新检测` / Re-check button.

| Action | Result |
|---|---|
| Save a `.tex` | Compiles automatically after the 500 ms debounce |
| Double-click the PDF | Names the source line under the cursor in the status line |
| Click a diagnostic | Scrolls the PDF to where that source line landed, with page and coordinates in the status line |
| "Send to Agent" | Hands this compile's errors to the current session (disabled with an explanation when there are none) |
| "差异 N" / Diff N | Toggles the change highlight; the title says how many hunks and whether the caps left any out |
| Hover a band | Shows which source line changed and the first sensible characters of it; hovering a deletion seam/chip pops up **the removed lines**, struck through |
| "对比" / Diff view | Builds and shows the latexdiff document (removed text typeset struck through); click again to return to the live PDF; needs `latexdiff` (plus Perl for MiKTeX on Windows), with guidance when missing |
| Review dropdown | Manual / Auto (independent AI) / Fully open |
| "接受 N" / Accept N | Marks the change set accepted and clears the marks (manual mode only) |
| "撤销" / Revert | Writes the source back to the previous revision and recompiles; needs a second click |

### Review modes

The diff is always computed between **the last accepted revision** and **the PDF you are looking at**, so the marks are literally "what has not been signed off yet". The mode decides who signs.

| Mode | After a compile | Marks | Revert |
|---|---|---|---|
| `手动审核` / Manual | waits for you; nothing counts yet | accumulate every change since the last 接受 | yes |
| `自动审核` / Auto | a **separate one-shot model call** reviews the diff — no tools, no history, not the Agent that made the change | that one change | yes, and a rejection performs it |
| `完全放开` / Open | accepted immediately | that one change, informational only | not offered |

Auto review needs a model route: it reads the session's `requestHeader()`, falling back to the profile's default model. If either is missing, or the call fails or exceeds 25 s, the verdict is **manual** — it never approves by default.

### Point at a spot, change the source

1. **Select text** — drag to select; an inline bar appears below the selection (the text layer is enabled).
2. **Box a region** — where there is no text layer (formulas, figures, tables, margins), drag a rectangle; the same bar appears on release.
3. Type one sentence ("make this Chinese", "simplify this formula") and press Enter.
4. The Host reverse-jumps both corners with `synctex edit`, takes the line range within one file, reads those source lines, and sends them with your request.
5. The Agent edits the `.tex` → the watcher recompiles → the PDF refreshes in place.

**The PDF is an anchor, never the content.** What reaches the Agent is **source lines**, not text extracted from the PDF — formulas and ligatures extract badly, source is always clean. The selected string rides along as an explicitly unreliable hint. That is why selecting a formula does not make the Agent guess.

## Privacy boundary

Compiling, rendering, SyncTeX, and diffing stay **local**. Content leaves the machine in exactly three cases:

1. you press "Send to Agent" (or trigger a point-and-edit) — the prompt goes to the current session;
2. the same, with redaction on — every send says so first;
3. **auto review is selected** and a change compiles: the diff between the accepted and current revision goes to the provider/model that session is configured for. Manual and open review send nothing.

Redaction (`redact`, off by default) sends "message + line number" only: no source lines, no selected text.

## Known limits

- **Reverse lookup is line-accurate, not character-accurate.** SyncTeX maps boxes to lines and `Column` is often `-1`; selecting one word yields the line (or lines) containing it.
- **Scanned PDFs have no text layer**, so boxing may fail to resolve. Tectonic always emits a text layer, so this does not affect previews produced here.
- **Cross-page selections** reverse-jump only the current page's part.
- **A deletion is not re-typeset** — the new PDF has no room left where it was, so the overlay draws a seam plus a `−N` chip and **pops the removed source lines up on hover** (struck through, capped at 8 lines × 200 chars); for removed text in real typesetting use `对比` (latexdiff re-typesets a merged document; requires latexdiff, and Perl for MiKTeX's build on Windows).
- **The highlight is capped** at 24 hunks / 40 resolved lines per revision; longer blocks are sampled evenly rather than truncated, and the surplus is reported in the button's title.
- **Auto review spends model calls** and can be wrong. It runs only in that mode, and a timeout (25 s) or a missing model **falls back to manual** — it never approves by default.
- **Revert and a rejecting reviewer write the source file** (back to the previous revision, then recompile). That is the plugin's only destructive action, which is why the button arms on a second click.
- One point-and-edit quotes at most **12 source lines** (`MAX_EDIT_LINES`), so boxing a whole page cannot dump a whole page into the prompt.
- The first compile may download TeX packages, so its timeout is 5 minutes (2 minutes afterwards).

## Architecture

```
src/
  index.ts                       Host entry; registers the service
  services/
    latex-preview-service.ts     Typert Remote service (13 @Remote methods)
    compile.ts                   Tectonic invocation + artifact rollback
    watcher.ts                   chokidar + debounce
    diff.ts                      line-level diff
    diff-regions.ts              hunks → PDF band/seam coordinates (with removed text)
    diffdoc.ts                   latexdiff 对比视图 (optional capability)
    reviewer.ts                  the independent reviewer (one-shot model call)
    agent-bridge.ts              prompt assembly + agent.steer delivery
    http-api.ts                  same-origin JSON routes /.latex-preview/api/*
    static-route.ts              /assets static mount
  utils/                         binaries / root / log-parser / synctex / assets
  client/                        panel.tsx / pdf-viewer.ts / api.ts / index.tsx
viewer/                          PDF.js viewer page (selection, box, inline bar, diff layer, removed-text flyout)
```

Two constraints worth knowing up front:

- **Callbacks cannot cross the Host↔Client wire.** The client polls `getState()` and reacts to the `version` counter — an unchanged version does nothing: no re-render, no iframe reload.
- **The panel talks over an HTTP route, which has no Agent driver**, so `currentInitiator()` is always empty there. The panel reads the session id from the sidebar's `data-sidebar-right-session` and the Host resolves it with `agents.get(id)`.

HTTP routes the panel uses (`POST`, except `state` which is `GET`): `state` `configure` `compile` `diff` `diff-regions` `diff-doc` `accept` `revert` `jump-to-pdf` `jump-to-source` `send-error` `edit-at` `binaries`.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run verify       # contract probe (5 pass / 0 fail / 2 skip)
npm run build        # tsc + client bundle + assets
npm run assets       # rebuild only the PDF.js runtime and viewer page
npm run binaries     # check tectonic / synctex
```

> `pnpm run` is broken on the machine this was developed on; use `npm run` or `npx`.

Read [`docs/spikes.md`](docs/spikes.md) before changing code — it records the contracts as measured against the real packages (PDF.js coordinate conversion, slot registration, the actual `createUserMessage` signature) and saves most of the trial and error. Other docs:

| File | Contents |
|---|---|
| [`docs/spikes.md`](docs/spikes.md) | Verified contracts and traps (B1–B18) |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | Status, decisions, open questions |
| [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) | Work breakdown, gates, risk register |
| [`docs/LaTeX Preview — 开发文档.md`](docs/LaTeX%20Preview%20—%20开发文档.md) | Architecture and API contract spec |
| [`AGENTS.md`](AGENTS.md) | Repo-level invariants cheat sheet |
| [`CHANGELOG.md`](CHANGELOG.md) | What each unreleased change added, fixed or changed |

## License

[MIT](LICENSE) © 2026 Tianshang301
