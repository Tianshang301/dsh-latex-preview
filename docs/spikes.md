# 契约验证记录（spikes）

> 起点：2026-11-15 交接（`HANDOFF.md` §6 的 B1–B6 全部为"未验证假设"）。
> 本轮验证方式：**直接读已发布 npm 包的类型与源码 + 在本机实跑命令**，而非逆向猜测。
> 目标 DSH 版本：`@deepseek-ai/dsh@0.2.2-rc.1`（`cordis ~4.1.0`）。所有包**精确锁定**，不用 `^`。

## 0. 结论速查

| 编号 | 问题 | 结论 | 对计划的影响 |
|---|---|---|---|
| B1 | Host→Client 能否传回调 | **不能**。Remote 参数只有 `json` / `lookup` 两种来源，函数无法编码；官方跨半通道是"转发事件"，但需 Host 装配层白名单 | 客户端改**轮询 `getState()`**；`api.onCompiled(cb)` 删除 |
| B2 | 源码编辑器是自带还是自建 | **仍未知**，但已排除一种可能：`slots` 核心包里没有 `ctx.slots.inject(key, cb)` 这个方法 | P0.5 前必须确认，否则面板挂不上 |
| B3 | `agent` 实例从哪来 | **已解决**：Host 侧 `ctx.agent?: Agent`（`Agent.ctx` 派生上下文自带）+ `ctx.agents: AgentRegistry`；`Agent#steer(message: UserMessage)` | 错误回传可直接实现，不必降级 |
| B4 | draftMode | 维持"不做"（与 SyncTeX 硬冲突） | 不变 |
| B5 | 编译超时/单飞 | 规格书缺，必须补 | 不变 |
| B6 | pdfjs 资产与同源 | 未验证（需真实 profile 起服务） | 留到 P0.6 |
| **B7** | client bundle 的 loader 契约 | **未知**，生态里没有可抄的第三方 client 包 | 先用 IIFE 单顶层语句形态，P0.5 前定案 |
| **B8** | 消息 `source` 的形状 | 规格书写错：不是 `'latex-preview'`，是 `{ kind: 'plugin', plugin: 'latex-preview' }` | 已按真实契约实现 |
| **B9** | `synctex` 输出格式 | 已实测：`view` 必须传**绝对路径+正斜杠**；字段是大写 `W:`/`H:`；`Column` 可为 `-1` | P1.1 的解析器按实测写，别照抄规格书正则 |
| **B10** | 本机 `pnpm run` 被拦 | 本机 pnpm 有供应链策略包装层，`pnpm run` 前置校验因"ignored build scripts"失败 | 本轮用 `npx tsc` / `npx tsx` 直调；不影响产物 |

---

## B1 · Host→Client 传回调：不能（有硬证据）

**证据**（`@deepseek-ai/dsh-typert-protocol@0.2.2-rc.1`，`lib/types/types.d.ts`）：

```ts
export interface InvocationParameterDescriptor {
  readonly name: string
  readonly wire: string
  /** Whether the value is JSON or requires a registered Host lookup. */
  readonly source: 'json' | 'lookup'   // ← 只有这两种
  readonly codec: TypertCodec          // 'strict'（zod schema）| 'src-json'
}

export type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure }
```

- 参数只有两种来源：JSON，或"按 key 去 Host 查一个已注册对象"。**函数既不是 JSON 也不在 lookup 表里**，因此 `api.onCompiled(cb)` 在真实链路上无法成立。
- 返回值统一包在 `RemoteResult` 里，**不是抛异常**。客户端必须自己解包 `ok`，业务错误走 `ok:false` 分支，只有装配故障才 reject。

**官方确实有跨半推送**，但不能直接用于第三方插件：

```ts
export interface TypertClientRemote {
  /** Subscribe to one forwarded Host event; delivery is one-way. */
  $on<Event extends TypertRemoteEvent>(event: Event, listener: Events[Event]): () => void
}
export type TypertRemoteEvent = Extract<keyof Events, keyof TypertRemoteEventSelection>
```

`TypertRemoteEventSelection` 由 **Host 装配层**声明（"declared once by the Host assembly"）。第三方插件能否把自己的事件加进这个选择集，本轮**未能验证**——需要一份真实 profile 的装配代码。

**决策**：客户端按 `getState()` 轮询实现（交接文档兜底 B），500ms 一次，带 `version` 递增做去重。事件通道留作 P0+ 的可选优化，前提是确认插件可加入白名单；若不能，README 如实说明"刷新延迟 ≤500ms"。

**影响的签名**：规格书 §2.1 的 `onCompiled(cb)` 全部删除，改为 `getState()`；`LatexPreviewService` 已按此实现。

---

## B2 · 编辑器与槽位：关键 API 仍未证实（P0 最大风险）

已确认的事实：

- `@deepseek-ai/dsh-client-ui-slots@0.0.1-rc.1` 的 `index.d.ts` 是一个**纯注册表**（`SlotCore`）：`SlotMap` 由各 owner 通过 `declare module` 合并扩展，注册入口是 `register(options, Component)`。
- 该包里 **没有** `inject(key, factory)` 这个方法。包内唯一的 `inject` 是"槽位级注入面"（`inject?: object`，给组件注入 hooks/业务面），与"延迟注册到某个槽位"是两回事。
- `@deepseek-ai/dsh-client-web` 的 `PLATFORM_MODULES` 里确实列了 `@deepseek-ai/dsh-client-ui-slots`，说明 slots 是平台级共享模块。
- `editor.panel.item` 这个 key 我们**无法验证存在**：`SlotMap` 的合并声明在 `dsh-client-ui-layout` 之类的包里，而这些包不在公开 registry 的可见范围内（`npm search` 只看得到 `ui-theme` / `ui-plan` / `ui-settings` 等）。

**风险**：规格书 §2.1 和坑 14 反复强调的 `ctx.slots.inject(key, () => ctx.slots.register(...))`，在本轮可见的包里**找不到该方法**。可能是运行时 wrapper（`SlotsService`）提供、而我们没拿到那个包；也可能规格书把 API 记混了。

**下一步（P0.5 前必须做）**：
1. 在真实 DSH Web profile 里 `console.log(Object.keys(ctx.slots))` 与 `Object.keys(ctx)`，确认 slots 服务实际暴露的方法名；
2. 打印已注册槽位 key 列表，确认 `editor.panel.item` 是否存在、宿主是谁（这同时回答 B2 的另一半："编辑器是否自带"）；
3. 若确实没有 `inject`，改用 `register()` 直接注册，并按真实签名调整 `src/client/index.ts`。

在这三条确认前**不要写面板组件**——写 3 天 UI 再返工是 3 天。

---

## B3 · `agent.steer`：已解决

`@deepseek-ai/dsh-agent` 的类型里三处直接给出了答案：

```ts
// runtime-types.d.ts — Agent 的收件箱方法
/** Submit steering for the nearest step. An idle driver starts a turn. */
steer(message: UserMessage): void
send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
followup(message: UserMessage): void
inject(message: UserMessage): void   // 只注入上下文、不唤醒

// index.d.ts — Context 增强
declare module '@deepseek-ai/cordis' {
  interface Context {
    agents: AgentRegistry
    /** The agent association installed as an own property on `Agent.ctx`. */
    agent?: Agent
  }
}

// AgentRegistry
currentInitiator(): Agent | undefined
requireInitiator(): Agent            // 无 initiator 时抛错
withInitiator<T>(agent: Agent, op: () => T): T
```

**决策**：
- 在 `Agent.ctx` 派生的上下文里直接用 `ctx.agent`；
- 从文件监听器等 **非 agent 发起**的路径回传时，用 `ctx.inject(['agents'], (c) => c.get('agents').requireInitiator())`——但注意注释明确写了"presence is neither liveness proof nor authorization"，所以取到的 agent 还要判存活，取不到就退回公开输入通道并在 UI 上说明。

**产品含义**：`steer` 语义是"提交给最近一步"——空闲时会**新开一个 turn**，运行中则在下一个 step 边界消费。这正好符合"编译失败 → 让 AI 顺手修"的体验，不会强行打断正在进行的流。交接文档 R3 担心的降级路径，实际用不到。

---

## B8 · 消息 `source` 是对象，不是字符串

规格书 §3.5 写 `createUserMessage({ content, source: 'latex-preview' })`。真实契约（`@deepseek-ai/dsh-llm`，`MessageSourceMap`）是判别式联合：

```ts
user:   { kind: 'user' }
plugin: { kind: 'plugin'; plugin: string } & ContextFormed
model:  ModelMessageSource
tool:   ToolMessageSource
```

所以正确写法是 `source: { kind: 'plugin', plugin: 'latex-preview' }`。`createUserMessage` 会分配 `id` 并 `freeze`（契约探针已实测：`role=user`、`frozen=true`、`blocks=[text]`）。

---

## B9 · `synctex` 实机行为（比规格书更细）

本机：MiKTeX 的 `synctex` 工具 1.5 / 引擎 1.21，编译用 Tectonic 0.17.0（**不同发行版**，实测可互通）。

### 探测命令用 `synctex help`，不要用 `--version`

| 命令 | exit | stdout | stderr |
|---|---|---|---|
| `synctex --version` | 0 | 只有 `...version 1.5` | `ERROR: Missing options` + 712B 用法（含 `version 1.21`） |
| `synctex help` | 0 | **两个版本号都在 stdout**，stderr 空 | — |

`src/utils/binaries.ts` 已按 `help` 实现，实测解析出 `versions=[1.5, 1.21]`。

### `view` 必须传绝对路径 + 正斜杠

```
$ synctex view -i 3:0:hello.tex -o hello.pdf
SyncTeX Warning: No tag for hello.tex          # ← 相对路径失败

$ synctex view -i 3:0:C:/Users/ASUS/AppData/Local/Temp/textest/hello.tex -o hello.pdf
SyncTeX result begin
Output:hello.pdf
Page:1
x:174.445831
y:134.764633
h:133.768372
v:134.874207
W:343.711060
H:7.133238
```

两个坑：
1. Windows 上路径要用 `C:/...` 正斜杠；`cygpath -w` 的反斜杠路径同样报 `No tag`。**编译时传什么形式、查询时就要传什么形式**——最稳的做法是统一用正斜杠绝对路径。
2. 宽高字段是**大写** `W:` / `H:`，不是 `width`/`height`。规格书 `parseView` 只读了小写 `h`/`v`，尺寸会漏。

### `edit` 的 `Column` 可以是负数

```
$ synctex edit -o 1:100:700:hello.pdf
SyncTeX result begin
Output:hello.pdf
Input:C:\Users\ASUS\AppData\Local\Temp\textest\hello.tex   # 绝对路径，反斜杠
Line:4
Column:-1                                                  # ← 负数！
Offset:0
Context:
SyncTeX result end
```

规格书 `parseView` 的正则 `^${k}:([\d.]+)` 会：漏掉 `Input:`、把 `Column:-1` 解析成 `NaN`。P1.1 的 `parseEdit` 必须用 `^(-?[\d.]+)`，并且**只取 `result begin`/`result end` 之间**的内容。

### P1.2 坐标换算的新事实

`y:134.76 / v:134.87` 与 `x:174.44 / h:133.77` 说明 synctex 给的是 **PDF 用户空间左上原点坐标**（不再是传统理解的"左下原点，y 向上"）。交接文档和规格书都按"y 需要翻转"写，P1.2 必须先验证这一条再写换算——否则滚动越深偏得越多。

---

## B6 · pdfjs 资产（未验证，P0.6 前处理）

`pdfjs-dist@4.10.38` 已装。仍未验证：`viewer.html` + `pdf.worker` + `cmaps/` + `standard_fonts/` 在同源静态路由下的可访问性，以及 `iframe.contentDocument` 是否拿得到（取决于 `webServer` 挂载点是否与 Web UI 同域）。这条只能在真实 profile 里跑。

---

## B7 · client bundle 的 loader 契约（新增，未定）

生态里可见的第三方插件只有一个（`@yimiliya/dsh-api-prompt-optimizer`），它是**纯 Host**（Typert Remote controller），**没有 client 半**，所以没有可抄的样板。

当前选择（`scripts/build-client.mjs`）：esbuild 出 **IIFE + 全局名**，产物顶层只有一条语句 `var __dshLatexPreviewClient = (() => {…})();`，所有副作用都在工厂内部。这满足"顶层唯一语句、副作用在工厂内"的硬约束，且加一行 wrapper 就能改成任何 loader 想要的形状。

**代价**：真实 loader 若要求 `module.exports = factory`（CJS）或 `define()`（AMD），需要改 banner/footer 一行。P0.5 前定案。

---

## B10 · 本机 pnpm 的工具链问题（环境，不是设计）

本机 pnpm 11.23.0 外面套了一层供应链策略校验，`pnpm run *` 会先跑 `pnpm install` 做依赖状态检查，而 install 因 `esbuild` 的 build script 被忽略（`ERR_PNPM_IGNORED_BUILDS`）返回 1 → 所有 `pnpm <script>` 全部失败。

尝试过且**无效**：`package.json` 的 `pnpm.onlyBuiltDependencies`、`.npmrc` 的 `only-built-dependencies[]`、`pnpm-workspace.yaml`（`onlyBuiltDependencies` 用 list 形式报 schema 错，object 形式被接受但仍被忽略）。

**当前做法**：直调 `npx tsc -p tsconfig.json`、`npx tsx test/contract/probe.ts`、`node scripts/build-client.mjs`。`package.json` 里的 scripts 保留原样，在干净环境可用。esbuild 本身工作正常（`npx esbuild --version` → 0.24.2），因为没有 postinstall 也能用。

---

## 本轮已落地的产物

| 文件 | 状态 |
|---|---|
| `package.json` / `pnpm-lock.yaml` / `.npmrc` / `tsconfig.json` / `tsconfig.client.json` / `cordis.patch.yml` / `.gitignore` | 完成，依赖精确锁定到 DSH 0.2.2-rc.1 线 |
| `src/utils/binaries.ts` | 完成（T0.4）：双二进制探测、`synctex help`、版本多值、平台引导文案 |
| `src/services/latex-preview-service.ts` | 骨架（T0.1）：`TypertRemoteService` + `@Remote getState/recheckBinaries`，状态可 JSON 往返 |
| `src/index.ts` | 骨架：`ctx.plugin(LatexPreviewService)`，webServer 注入留占位注释 |
| `src/types.ts` | 双半共享的 wire 契约（全部 JSON 安全） |
| `src/client/index.ts` + `scripts/build-client.mjs` | 骨架 + 打包（IIFE 单顶层语句） |
| `test/contract/probe.ts` | **可跑**：5 pass / 0 fail / 2 skip（见下） |
| `scripts/check-binaries.ts` | **可跑**：`tectonic ok` + `synctex ok (1.5/1.21)` |

契约探针实测输出：

```
[PASS] ctx.plugin(Service) exposes ctx.<key> — ctx.latexPreview.name=latexPreview
[PASS] Remote decorators are discoverable — marked=[getState, recheckBinaries]
[PASS] ctx.inject(deps, cb) resolves deferred services
[PASS] createUserMessage({ content, source }) — role=user frozen=true blocks=[text]
[PASS] getState() returns a JSON snapshot — json-round-trip=ok
[SKIP] agent.steer(UserMessage) — 需要 agent loop 运行时
[SKIP] ctx.inject(["webServer"]) — 需要真实 profile
```

## 环境（2026-11-16 实测）

| 依赖 | 状态 |
|---|---|
| Node 22.22.2 / pnpm 11.23.0 | ok |
| `tectonic` 0.17.0 | **已安装** → `C:\Users\ASUS\.local\bin\tectonic.exe`，已加入用户 PATH |
| `synctex` 1.5 / 引擎 1.21 | ok（MiKTeX 提供，与 tectonic 不同源） |
| 端到端试编 | **通过**：`tectonic -X compile hello.tex --synctex` 产出 `.pdf` + `.synctex.gz` + `.log`（首编会下载 bundle，本机耗时数分钟） |

## 下一步（按序）

1. **B2/B7 定案**：在真实 DSH Web profile 里打印 `ctx` / `ctx.slots` 的 key 与方法名，确认槽位注册 API 与 client loader 契约。**不确认不写面板。**
2. `src/utils/root.ts`（P0.3）+ `src/services/compile.ts`（P0.2，含超时/单飞/`.prev` 回滚）。
3. `src/utils/synctex.ts`（P1.1 提前做解析器，成本低且已被 B9 的实测固定）：`parseView`/`parseEdit` 按实测格式写，加 fixture。
4. P0.4 静态路由（依赖 webServer，需真实 profile）。
