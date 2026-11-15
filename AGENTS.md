# AGENTS.md

## Repo state (read this first)

- **Scaffolded, not feature-complete** (as of 2026-11-16). `package.json`, lockfile, tsconfigs, `cordis.patch.yml`, git history exist. `src/` holds a loadable empty plugin: `utils/binaries.ts` (complete) + `services/latex-preview-service.ts` (skeleton with `@Remote getState/recheckBinaries`). No watcher, no compiler, no panel yet.
- **Read `docs/spikes.md` before writing any code.** It replaces most of HANDOFF §6's open questions with evidence read out of the real published packages.
- Source of truth for design: `Visual LaTeX for DeepSeek Harness — 开发文档.md` — but note it is **wrong on three points**, corrected in `docs/spikes.md`: (a) callbacks cannot cross Host↔Client, (b) `createUserMessage` takes `source: { kind:'plugin', plugin:'latex-preview' }`, not a bare string, (c) `synctex` field/regex details differ from the spec's parser.
- Key docs: `docs/spikes.md` (verified contracts), `HANDOFF.md` (status/decisions), `DEVELOPMENT_PLAN.md` (WBS + risks + gates), spec (architecture).
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
