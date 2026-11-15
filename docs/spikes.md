# 契约验证记录（spikes）

> 起点：2026-11-15 交接（`HANDOFF.md` §6 的 B1–B6 全部为"未验证假设"）。
> 本轮验证方式：**直接读已发布 npm 包的类型与源码 + 在本机实跑命令**，而非逆向猜测。
> 目标 DSH 版本：`@deepseek-ai/dsh@0.2.2-rc.1`（`cordis ~4.1.0`）。所有包**精确锁定**，不用 `^`。

## 0. 结论速查

| 编号 | 问题 | 结论 | 对计划的影响 |
|---|---|---|---|
| B1 | Host→Client 能否传回调 | **不能，且客户端连 Host 服务都 inject 不到**（真机验证：`pending (waiting for service: latexPreview)`）。Remote 参数只有 `json`/`lookup`，函数无法编码 | 面板改走插件同源 JSON 路由 `/.latex-preview/api/*` |
| B2 | 槽位 API 与可用槽位 | **已解决一半**：`ctx.slots.inject(key, cb)` 存在且写法正确；但 `editor.panel.item` **不存在**，改用 `sidebar.right.pane.tab`（keyed）。编辑器是否自带仍未知 | P0.5 可开工；P1 的源码视图要自己做 |
| B3 | `agent` 实例从哪来 | **已解决**：Host 侧 `ctx.agent?: Agent`（`Agent.ctx` 派生上下文自带）+ `ctx.agents: AgentRegistry`；`Agent#steer(message: UserMessage)` | 错误回传可直接实现，不必降级 |
| B4 | draftMode | 维持"不做"（与 SyncTeX 硬冲突） | 不变 |
| B5 | 编译超时/单飞 | 规格书缺，必须补 | 不变 |
| B6 | pdfjs 资产与同源 | 未验证（需真实 profile 起服务） | 留到 P0.6 |
| **B7** | client bundle 的 loader 契约 | **已解决**：`window.__ModuleLoader__.load({ id, factory })`，工厂内返回 exports、副作用全在闭包里 | 构建脚本已按此实现并核对产物 |
| **B8** | 消息 `source` 的形状 | 规格书写错：不是字符串，是判别式对象。**0.2.2 里 `plugin` kind 已被移除**，插件产出的消息就是 `{ kind: 'user' }` | 已按 0.2.2 契约实现 |
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

## B2 · 槽位：API 已证实，`editor.panel.item` 不存在（改用 keyed 槽）

**结论**：`ctx.slots.inject(key, cb)` **确实存在**，规格书没记错；但规格书给的槽位 key `editor.panel.item` **在真实 DSH 里不存在**。

证据来自 `@deepseek-ai/dsh-client-runtime@0.0.1-rc.1` 的 `SlotsService`：

```ts
export declare class SlotsService extends Service {
  readonly register: SlotCore['register']        // 唯一注册入口
  /** 安装一个 effect，绑定到某个槽位声明的生命周期。 */
  inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void
  // 另有 entries(key) / getVersion(key) / subscribe(key, listener)
}
```

`inject` 的语义正是"等这个槽位被声明后，执行回调并接管其 dispose"——所以规格书那条
`ctx.slots.inject(key, () => ctx.slots.register(opts, Component))` 是正确写法，且**不该包 `ctx.effect`**（dispose 由 caller 的 fiber 管）。

真正可用槽位（从已发布插件的 `lib/client.js` 里逐个读出来的）：

| 槽位 key | kind | 谁声明 | 能否第三方占用 |
|---|---|---|---|
| `root` | single | runtime（shell 渲染） | ❌ 由 layout 的 AppFrame 占用 |
| `rightbar` | single | ui-sidebar-right | ❌ 已被占用 |
| `sidebar.right.pane.tab` | **keyed** | ui-sidebar-right（子槽位） | ✅ 按 id 注册，正是"右侧面板的一个标签页" |
| `sidebar.right.pane.tab.title` | keyed | 同上 | ✅ 标签标题 |
| `sidebar.right.tab.menu.item` | list | 同上 | ✅ 标签右键菜单项 |
| `sidebar.settings` | single | ui-settings | ❌ |
| `conversation.input.plan` / `conversation.session.header.corner` | — | ui-plan | 与预览无关 |
| `tool.call.toolview` | — | ui-skill | 与预览无关 |

**决策**：预览面板注册到 `sidebar.right.pane.tab`（keyed，scope session），id 用 `latex-preview`；标题注册到 `sidebar.right.pane.tab.title`。这与 ui-settings / ui-plan 的做法一致，是生态里唯一被验证过的第三方面板路径。

**代价**：面板依赖 `@deepseek-ai/dsh-client-ui-sidebar-right` 在场；它不在时 `inject` 的回调永不触发，面板静默不出现（不是错误，但 README 要写明）。

**B2 的另一半（编辑器是否自带）仍未回答**：所有可见包都没有源码编辑器面板，`editor.panel.item` 也不存在。P1 的"源码点击跳 PDF"需要重新找落点——候选是把源码视图做成我们自己 tab 内的只读 CodeMirror，成本回到规格书原本的估计。

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

规格书 §3.5 写 `createUserMessage({ content, source: 'latex-preview' })`——字符串。真实契约是判别式对象，而且**跨版本变过一次**，这点很容易踩：

```ts
// @deepseek-ai/dsh-llm@0.1.0-rc.6
user:   { kind: 'user' }
plugin: { kind: 'plugin'; plugin: string } & ContextFormed   // ← 曾存在
model:  ModelMessageSource
tool:   ToolMessageSource

// @deepseek-ai/dsh-llm@0.2.2-rc.1（本项目目标版本）
user:   { kind: 'user' }
model:  ModelMessageSource
tool:   ToolMessageSource
'system-prompt': SystemPromptMessageSource
```

0.2.2 把 `plugin` kind 删了，所以插件产出的消息**就是一条普通用户消息**：`source: { kind: 'user' }`。本次实现最初按 0.1.0 的形状写成 `{ kind: 'plugin', plugin: 'latex-preview' }`，`tsc` 直接报 `TS2322: Type '"plugin"' is not assignable to ...`——这条报错本身就是契约证据。

`createUserMessage` 会分配 `id` 并 `freeze`（契约探针实测：`role=user`、`frozen=true`、`blocks=[text]`）。

**教训**：DSH developer preview 期间的破坏性变更不只发生在方法签名上，**联合类型的成员也会被删**。锁版本 + 每次升级重跑 `pnpm verify` 是唯一可靠的防线（对应风险登记表 R6）。

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

## B6 · 静态路由：形状已确认（真机跑通）

`@deepseek-ai/dsh-host-webserver` 的 `WebServer.register` 签名：

```ts
export interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string                                            // 绝对路径，无尾斜杠
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
register(route: WebRoute | WebResourceRoute): () => void   // 返回 disposer
```

真机验证（DSH 0.2.2-rc.1，端口 3080）：

| 请求 | 结果 |
|---|---|
| `GET /.latex-preview/api/state` | `{"ok":true,"value":{…}}` |
| `POST /.latex-preview/api/configure {}` | 自动认领 `process.cwd()` 下的 `main.tex` |
| `POST /.latex-preview/api/compile` | `ok:true, exitCode:0, durationMs:988` |
| `GET /.latex-preview/pdf/main.pdf` | `200 application/pdf`，6454 bytes，`%PDF-` 头 |
| 同 URL + `Range: bytes=0-99` | `206`，100 bytes |

即**同源静态路由可用，PDF.js 需要的 Range 也通过**。pdfjs 自身资产（worker/cmaps）仍未接。

## B11 · 真机联调（2026-11-16，DSH 0.2.2-rc.1 + Edge headless）

装好 CLI、用 `--patch` 把插件插进 web profile、headless 浏览器实际加载页面后，暴露了四个**只靠读类型发现不了**的问题：

### 1. 客户端不能 `inject` Host 服务（B1 的真正落点）

首轮真机的报错是：

```
dsh-latex-preview: pending (waiting for service: latexPreview)
```

Host 服务只存在于 Host 进程，客户端 `export const inject = ['latexPreview']` 会**永远等下去**。这正是 B1 的结论在运行时的样子：跨半通道只有 Remote 描述符/转发事件，没有服务对象本身。

而 Remote 描述符要靠 `@deepseek-ai/dsh-typert-generator` 做程序分析产出（它是库 API + tsdown 插件，不是 CLI），第三方包必须自己发布 `lib/typert.host.*` 与 `lib/typert.remote-client.*` 并以 `package/typert`、`package/client/typert` 暴露。

**决策**：面板改走**插件自己的同源 JSON 路由** `/.latex-preview/api/*`（`services/http-api.ts`），响应外层形状故意与 `RemoteResult` 一致（`{ok,value}` / `{ok,error}`），将来接上 Remote 只需换客户端的传输实现。

### 2. 代码里的 `inject` 必须与 `package.json#dsh.client.inject` 一致

两边不一致时，条目在 activation 阶段直接 `failed`，且**没有任何错误详情**（浏览器只打印 `web boot: 1 entry did not activate`，DOM 里也只有 `dsh-latex-preview: failed`）。

改法：`package.json` 写 `"inject": ["slots"]`，代码里就 `export const inject = ['slots']`。

### 3. keyed 槽位用 `key`，不是 `id`

`sidebar.right.pane.tab` 是 `kind: 'keyed'`。真实写法（来自 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`）：

```js
ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
  name: 'sidebar.right.pane.tab',
  key: TEXTPREVIEW_ID,          // ← key，不是 id
  // …children / store / inject
}, TextPreview)), 'ui-sidebar-documentpreview: text body')
```

标题槽同理，只传 `{ name, key }`（**没有 `label` 字段**，标题由组件渲染）。传 `id` 会失败。

顺带修正规格书坑 14：真实插件是 `ctx.effect(() => ctx.slots.inject(...), label)`——包 `ctx.effect` 是**对的**（`inject` 返回幂等 disposer，包一层只是把 dispose 挂到 fiber）。规格书那句"不要包 effect"针对的是把 `register` 的返回值错当 effect 用。

### 4. 声明了 peer 依赖会被版本门禁拦下

把 `@deepseek-ai/dsh-client-ui-sidebar-right` 写成（即使 optional 的）peer 后，启动日志变成：

```
disabling profile plugin row "latex-preview": Plugin dsh-latex-preview@0.0.0 is
incompatible with dsh 0.2.2-rc.1: requirements {"@deepseek-ai/dsh-client-ui-sidebar-right":"0.1.5-alpha.1"}
```

DSH 会把 peer 依赖当作**硬性运行时要求**逐条比对。结论：面板对侧栏的依赖是"运行期探测"，不应写进 peer；需要时用 `dsh plugin allow-version` 显式豁免。

### 真机验证清单

| 检查 | 结果 |
|---|---|
| Host 插件加载 | ✅ 无 `disabled`、无失败 |
| `ctx.inject(['webServer'])` | ✅ 路由挂上并响应 |
| 二进制探测 | ✅ `tectonic:true, synctex:true`（进程 PATH 决定） |
| configure 自动认领 cwd | ✅ `E://dsh-run//main.tex` |
| 编译 | ✅ 988ms，PDF 6454 bytes |
| 静态路由 + Range | ✅ 200 / 206 |
| 客户端 bundle 送达 | ✅ 走 `/plugins/??dsh-latex-preview/client.js&rev=…`，14684 bytes |
| `apply` 执行 + 槽位注册 | ✅ 两个 keyed 槽注册完成，无异常 |
| 标签页可见 | ⚠️ 未验证：需要打开一个 workspace 会话才会出现右侧栏 |

### 遗留问题

- **面板首次可见性未验证**：着陆页没有右侧栏，必须先进入某个 workspace 会话。headless 下点击项目没有进入会话（可能是需要真实工作区目录），这一步留给手工确认。
- **面板拿不到工作区文件路径**：目前靠 Host 的 `process.cwd()` 认领；正确做法是接 session/workspace 服务（`ctx.workspace`？未验证）。
- **pdfjs 资产**：仍需接 `assets/pdfjs/`（worker、cmaps、standard_fonts）。

`pdfjs-dist@4.10.38` 已装。仍未验证：`viewer.html` + `pdf.worker` + `cmaps/` + `standard_fonts/` 在同源静态路由下的可访问性，以及 `iframe.contentDocument` 是否拿得到（取决于 `webServer` 挂载点是否与 Web UI 同域）。这条只能在真实 profile 里跑。

---

## B7 · client bundle 的 loader 契约：已解决

`@deepseek-ai/dsh-client-modules@0.0.1-rc.1` 的 `manifest.d.ts` 把契约写死了：

```ts
/** The shape a client bundle hands to window.__ModuleLoader__.load (registration handoff). */
export interface ClientPluginHandoff {
  id: string                                   // 插件 id = 包名，必须与 graph row 一致
  factory: (require: (spec: string) => unknown) => Record<string, unknown>
}
window.__ModuleLoader__?: { load(handoff: ClientPluginHandoff): void }
```

原文注释把要点说尽了：*"executing a plugin bundle only REGISTERS its factory; every module body side effect — including CSS injection — lives inside the factory closure and runs at materialization, not at script execution."*

所以产物必须是**恰好一条顶层语句**：

```js
window.__ModuleLoader__.load({
  id: "dsh-latex-preview",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    /* …整个 bundle… */
    return module.exports;
  },
});
```

`require` 是模块表给的同步 require，平台单例（`react`、`@deepseek-ai/cordis`、slots 包）从这里来，**不能打进 bundle**——第二份 React 会让 hooks 与 slot renderer 同时失效。

`scripts/build-client.mjs` 已按此实现（esbuild `format: 'cjs'` + banner/footer 包壳，id 从 `package.json` 读），产物结构已核对：顶层只有 `window.__ModuleLoader__.load({…})` 一条语句。

---

## B10 · 本机 pnpm 的工具链问题（环境，不是设计）

本机 pnpm 11.23.0 外面套了一层供应链策略校验，`pnpm run *` 会先跑 `pnpm install` 做依赖状态检查，而 install 因 `esbuild` 的 build script 被忽略（`ERR_PNPM_IGNORED_BUILDS`）返回 1 → 所有 `pnpm <script>` 全部失败。

尝试过且**无效**：`package.json` 的 `pnpm.onlyBuiltDependencies`、`.npmrc` 的 `only-built-dependencies[]`、`pnpm-workspace.yaml`（`onlyBuiltDependencies` 用 list 形式报 schema 错，object 形式被接受但仍被忽略）。

**补充（2026-11-16 二次尝试）**：pnpm 11 会自己生成 `pnpm-workspace.yaml`，内容是

```yaml
allowBuilds:
  esbuild: set this to true or false
```

照着填 `esbuild: true` 之后重装，**仍然**报 `ERR_PNPM_IGNORED_BUILDS`。这条 pnpm 外面套了供应链策略层（启动时会打印 "Lockfile passes supply-chain policies"），构建脚本被策略拦掉，不是配置能解决的。结论：`pnpm run` 在这台机器上不可用，继续直调。

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
