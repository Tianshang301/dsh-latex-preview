# AGENTS.md

## Repo state (read this first)

- **Point-and-edit works** (2026-11-16): the viewer enables the text layer, a selection or rubber-band region becomes a PDF-point rectangle, the Host reverse-jumps it with `synctex edit` into a source line range, and the Agent gets that range plus the user's sentence. PDF text is never used as content. Shares the sessionId→Agent path from §B14. See `docs/spikes.md` §B15/§B16.
- **Right-sidebar tab needs two registrations** (2026-11-16): `ctx.get('sidebarRightTabs').register({id, kind, ...})` declares the tab type, then the keyed slots `sidebar.right.pane.tab` / `.title` supply the body and chip under `key === definition.id`. Slot-only registration renders nothing. Both services must be reached with dynamic `ctx.inject`, since the sidebar provides them on its own schedule. See `docs/spikes.md` §B13.
- **PDF.js viewer is bundled, not assumed** (2026-11-16): pdfjs-dist ships components only (`web/pdf_viewer.mjs`), no `viewer.html`, so `viewer/` holds a ~100-line page assembled from them and `scripts/build-assets.mjs` copies the runtime + that page into `assets/` (git-ignored, ~5 MiB). `utils/assets.ts` resolves the directory from `import.meta.url`; `/assets` is mounted from there, not from `process.cwd()`. See `docs/spikes.md` §B12.
- **P0 verified end-to-end inside a real DSH 0.2.2-rc.1 boot** (2026-11-16, headless Edge): plugin loads, `webServer` route answers (PDF 200, Range 206), compile 988ms, client bundle served and applied, keyed tab registered. The panel talks to the Host over its own same-origin JSON route `/.latex-preview/api/*` — the client cannot inject a Host service. See `docs/spikes.md` §B11.
- **P0 host pipeline is implemented and verified on a real machine** (2026-11-16): `utils/{binaries,root,log-parser,synctex}.ts`, `services/{compile,watcher,diff,agent-bridge,static-route}.ts`, wired through `LatexPreviewService` (8 `@Remote` methods). Client half registers a keyed tab into `sidebar.right.pane.tab` (NOT `editor.panel.item` — that slot does not exist) and renders `client/panel.tsx`. Not yet exercised inside a real DSH profile: the static route shape (B6) and the panel's composed props.
- **Read `docs/spikes.md` before writing any code.** It replaces most of HANDOFF §6's open questions with evidence read out of the real published packages.
- Source of truth for design: `docs/LaTeX Preview — 开发文档.md` — but note it is **wrong on three points**, corrected in `docs/spikes.md`: (a) callbacks cannot cross Host↔Client, (b) `createUserMessage` takes `source: { kind: 'user' }` — a discriminated object, and `dsh-llm@0.2.2-rc.1` removed the old `plugin` kind, (c) `synctex` field/regex details differ from the spec's parser.
- Key docs (all under `docs/`): `spikes.md` (verified contracts), `HANDOFF.md` (status/decisions), `DEVELOPMENT_PLAN.md` (WBS + risks + gates), `LaTeX Preview — 开发文档.md` (architecture).
- Commands: `npx tsc -p tsconfig.json --noEmit` (typecheck), `npx tsx test/contract/probe.ts` (contract probe), `npx tsc -p tsconfig.json && node scripts/build-client.mjs` (build). `pnpm run <script>` is broken on this machine — see `docs/spikes.md` §B10.

## What is being built

`dsh-latex-preview`: a DSH (DeepSeek Harness) **Cordis dual-half plugin** (Host = Node, Client = web) for live LaTeX preview. Stack: Tectonic compiler, PDF.js viewer, SyncTeX jumps, `diff-match-patch` line diff, CodeMirror 6. TypeScript throughout.

## Non-obvious invariants (easy to get wrong)

- Host services extend Cordis `Service` and call `super(ctx, 'latexPreview')`; the service is exposed as `ctx.latexPreview`.
- Host acquires other services with `ctx.inject(deps, cb)`, **not** `ctx.get()` inside `apply` (services may not exist yet).
- Client declares hard deps via `export const inject = ['latexPreview']`; optional deps use `ctx.get` and probe at use site.
- Register client slots as `ctx.slots.inject(key, () => ctx.slots.register(...))` and **never wrap it in `ctx.effect`** — doing so throws `Invalid effect` and the panel silently never appears.
- Every route/timer/listener needs a disposer registered with `ctx.effect(() => dispose, label)`.
- `package.json` is ESM (`"type": "module"`) for Host, but built `lib/client.js` must be a **lazily-loaded CJS bundle**: only top-level statement is the module-loader call, side effects inside the factory.
- Do **not** use `tectonic -X watch` (known broken combo). Use chokidar + debounce.
- Compile safety: copy PDF to `.pdf.prev` before compiling; on failure restore it. A failed compile must never blank the PDF.
- `draftMode` = rewrite source after `\documentclass` with `\PassOptionsToPackage{draft}{...}`; it is not a Tectonic CLI flag.
- SyncTeX: always shell out to the `synctex` CLI. Hand-parsing `.synctex` is explicitly forbidden by the spec/manpage.
- PDF.js CSS coords vs synctex PDF coords differ: flip y, scale `72/96`, account for page scale/padding/scroll offset.
- Scroll preservation: `captureScrollState()` must run **before** loading the new PDF; clamp restored page with `Math.min` (out-of-range pages are silently ignored).
- `tectonic` and `synctex` are user-provided binaries; verify both at startup. Official binaries: win-x64 / macos-universal / linux-x64; arm64 needs `cargo install tectonic`.

## Privacy boundary (product requirement)

Compile, render, SyncTeX, and diff run on the local machine. Only error context / annotation anchors are sent to the DSH Agent, via `createUserMessage({ content, source })` + `agent.steer()`. A redaction switch (default off) must be able to send only message + line number. Warn on first enable and on every send.

## Planned layout / milestones

- `src/` Host (Node), `src/client/` browser half, `assets/pdfjs/`, `i18n/`, `test/`.
- Milestones P0 → P3 in spec §5. **Do not cut** scroll preservation or PDF artifact rollback; P2 annotation is the first thing to drop.
- Verification target: `pnpm verify` smoke-tests `ctx.plugin(Service)`, `ctx.inject`, `ctx.slots.inject/register`, `createUserMessage`, `agent.steer`.
