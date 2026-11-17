# 契约验证记录（spikes）

> 起点：2026-11-15 交接（`HANDOFF.md` §6 的 B1–B6 全部为"未验证假设"）。
> 本轮验证方式：**直接读已发布 npm 包的类型与源码 + 在本机实跑命令**，而非逆向猜测。
> 目标 DSH 版本：`@deepseek-ai/dsh@0.2.2-rc.1`（`cordis ~4.1.0`）。所有包**精确锁定**，不用 `^`。

## 0. 结论速查

| 编号 | 问题 | 结论 | 对计划的影响 |
|---|---|---|---|
| B1 | Host→Client 能否传回调 | **不能，且客户端连 Host 服务都 inject 不到**（真机验证：`pending (waiting for service: latexPreview)`）。Remote 参数只有 `json`/`lookup`，函数无法编码 | 面板改走插件同源 JSON 路由 `/.latex-preview/api/*` |
| B2 | 槽位 API 与可用槽位 | **已解决一半**：`ctx.slots.inject(key, cb)` 存在且写法正确；但 `editor.panel.item` **不存在**，改用 `sidebar.right.pane.tab`（keyed）。编辑器是否自带仍未知 | P0.5 已完成，见 §B13（还需第一级类型注册）；P1 的源码视图要自己做 |
| B3 | `agent` 实例从哪来 | **已解决**：Host 侧 `ctx.agent?: Agent`（`Agent.ctx` 派生上下文自带）+ `ctx.agents: AgentRegistry`；`Agent#steer(message: UserMessage)` | 错误回传可直接实现，不必降级 |
| B4 | draftMode | 维持"不做"（与 SyncTeX 硬冲突） | 不变 |
| B5 | 编译超时/单飞 | 规格书缺，必须补 | 不变 |
| B6 | pdfjs 资产与同源 | 未验证（需真实 profile 起服务） | 留到 P0.6 |
| **B7** | client bundle 的 loader 契约 | **已解决**：`window.__ModuleLoader__.load({ id, factory })`，工厂内返回 exports、副作用全在闭包里 | 构建脚本已按此实现并核对产物 |
| **B8** | 消息 `source` 的形状 | 规格书写错：不是字符串，是判别式对象。**0.2.2 里 `plugin` kind 已被移除**，插件产出的消息就是 `{ kind: 'user' }` | 已按 0.2.2 契约实现 |
| **B9** | `synctex` 输出格式 | 已实测：`view` 必须传**绝对路径+正斜杠**；字段是大写 `W:`/`H:`；`Column` 可为 `-1` | P1.1 的解析器按实测写，别照抄规格书正则 |
| **B10** | 本机 `pnpm run` 被拦 | 本机 pnpm 有供应链策略包装层，`pnpm run` 前置校验因"ignored build scripts"失败 | 本轮用 `npx tsc` / `npx tsx` 直调；不影响产物 |
| **B12** | PDF.js 查看器从哪来 | pdfjs-dist **不发** `viewer.html`/`viewer.mjs`，只有组件 `web/pdf_viewer.mjs` + `build/pdf.mjs`；`<iframe src=pdf>` 只能拿到浏览器内置查看器，`PDFViewerApplication` 不存在 | 自建 `viewer/` 页（组件拼装），`scripts/build-assets.mjs` 复制进 `assets/`；已真机渲染 1 页 |
| **B13** | 右侧栏 tab 怎么才算挂上 | 两级注册：`sidebarRightTabs.register({id,kind,…})` + keyed 槽（`key` 必须等于那个 `id`）。只做槽注册则**什么都不显示** | 已实现并真机跑通；服务须用 `ctx.inject` 动态注入 |
| **B14** | HTTP 路由里「发送给 Agent」 | `agents.currentInitiator()` 在无 driver 的请求里恒为空；须由面板传 sessionId，Host 用 `agents.get(id)` 解析 | 已实现并真机跑通（Agent 收到 prompt 并改文件） |
| **B15** | PDF 坐标换算 | `getViewport({scale:1})` 已是**点**；再乘 96/72 会把 y 缩到 0.75，反查落到页外 | 已修，双向跳转与选区定位都对齐到正确行 |
| **B16** | 框选 PDF 让 AI 改源码 | 文字层选区或拖框 → `synctex edit` 反查行范围 → 带源码行的 prompt → Agent 改 `.tex` → 自动重编 | 已实现并真机跑通（选中第 3 行准确命中） |
| **B17** | PDF 上的 diff 高亮 | 源码 hunk → `synctex view` → 每行色带（百分比定位）；顶边是 `v - H` 不是 `y`；删除只画接缝，锚定前一行底部 | 已实现并真机验证（覆盖率 0.82–0.88，删除接缝位置正确） |
| **B18** | 改动审核三档 | 手动=等接受；自动=派独立一次性模型调用审，否决即回滚；放开=不设闸门。路由取自 `requestHeader`，缺失时回落默认模型 | 已实现并真机验证（真实调用通过一次、否决并回滚一次） |
| **B19** | 覆盖层渲染三坑 | 绘制要代次+每页令牌+原子替换；`multiply` 混合模式会随底图变色，删；接缝按行高缩放；CSS 也要 `?v=` | 已修并真机验证（40 次快速缩放后每页仍只有 1 层） |
| **B20** | 旧版产物成对与基线 | 旧 PDF + 旧 SyncTeX 必须同名配对（CLI 按 basename 找）；失败要成对回滚；只在基线推进时采纳，否则丢弃 | 已实现并真机验证（失败前后 sha 与反查结果一致） |
| **B21** | diff 的行号为什么差一行 | `cleanupSemantic` 在**转回真实文本之后**跑，会把片段边界挪到行中间，每个块的行数都多 1；必须在一行一字符的阶段跑。另外 `synctex view` 对**空行**返回下一行的盒子 | 已修并真机验证（旧行号往返一致，空行不再误标） |
| **B22** | 在旧版 PDF 上标删除 | 旧行号 + 旧 SyncTeX 才能拿到被删文字的真实盒子（`kind: 'removed'` 红带 + 中线删除线）；该视图必须只读 | 已实现并真机验证（`main.prev.pdf` 加载、红带压在第二段、选区不起浮条） |

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

## B12 · PDF.js 查看器：pdfjs-dist 不带 viewer，得自己拼

**问题**：面板把 iframe 直接指向 `/.latex-preview/pdf/main.pdf`，浏览器用内置查看器显示——PDF 能看到，但 `window.PDFViewerApplication` 不存在，`client/pdf-viewer.ts` 的三件事全部降级：

- `captureScrollState()` 拿不到 `#viewerContainer` → 滚动保持失效（每次编译回到第 1 页）
- `scrollPageIntoView()` 不可用 → 诊断点击无法跳页
- 无法在页面上监听双击 → 反向 SyncTeX 无从触发

**根因不是"忘记拷资源"，而是 pdfjs-dist 4.x 的发布内容**：

```
pdfjs-dist@4.10.38/
  build/pdf.mjs, build/pdf.worker.mjs        ← API + worker
  web/pdf_viewer.mjs, web/pdf_viewer.css     ← 组件（PDFViewer/PDFLinkService/EventBus）
  web/images/, cmaps/, standard_fonts/       ← chrome 图标、CJK、Base-14 替代
  x 没有 viewer.html / viewer.mjs            ← 通用查看器应用不在 npm 包里
```

即：**没有可 iframe 的成品查看器**，只有可编程组件。两条路：

| 方案 | 代价 | 结论 |
|---|---|---|
| 从 mozilla 的 `pdf.js` 仓库 `web/` 搬 60+ 个文件 | 需与 4.10.38 对齐、长期跟上游 diff | 否 |
| 用 `pdf_viewer.mjs` 组件拼一个最小查看器 | ~100 行 + 一个 build script | **采用** |

**实现**（`viewer/`，构建时复制进 `assets/`）：

- `viewer.js`：`import * as pdfjs from '../pdfjs/pdf.mjs'` → `globalThis.pdfjsLib = pdfjs`（`pdf_viewer.mjs` 在模块求值时读这个全局）→ 再动态 `import('../pdfjs/pdf_viewer.mjs')`。顺序不能反，静态 import 会被提升。
- 结构照抄通用查看器的契约：`#viewerContainer`（**必须** `position:absolute`，`PDFViewer` 构造函数会断言）、`#viewer.pdfViewer`、`.page[data-page-number]`。
- `annotationMode: 0` + `textLayerMode: 0`：只读预览用不到注释层和文本层，省两次脚本加载与一轮渲染。
- `l10n` 用四行 stub：`PDFViewer` 只调用 `translate/pause/resume`（grep 实测），不需要 locale 文件。
- 暴露 `window.PDFViewerApplication = { pdfViewer, pdfDocument, eventBus, linkService }`，**这样 `client/pdf-viewer.ts` 一行都不用改**。
- 双击 → `postMessage({ source: 'latex-preview-viewer', type: 'sync-reverse', page, x, y })`；坐标 `(css / rect) * viewport * 0.75`（96dpi → 72pt），原点取左上（§B9 的 `y ≈ v`）。

**挂载点修正**：`/assets` 从 `join(process.cwd(), 'assets')` 改成 `assetsRoot()`（由 `import.meta.url` 推插件根）。原来那条路径既不存在、又依赖启动目录，是 `/assets` 404 的直接原因。

**真机验证**（DSH 0.2.2-rc.1，Edge headless，端口 3080）：

| 检查 | 结果 |
|---|---|
| `GET /.latex-preview/assets/viewer/index.html` | 200，681 B |
| `GET .../assets/pdfjs/pdf.mjs` | 200，658 371 B |
| `GET .../assets/pdfjs/pdf.worker.mjs` | 200，2 209 730 B |
| `GET .../assets/pdfjs/pdf_viewer.css` | 200，100 297 B |
| `GET .../assets/pdfjs/cmaps/UniGB-UCS2-H.bcmap` | 200，43 366 B |
| 查看器页内 `PDFViewerApplication` | 存在，`numPages: 1` |
| 渲染出的 `.page` / `canvas` | 1 / 1，canvas 816×1056 |
| 控制台错误 | 无（favicon 已用内联 SVG 去掉） |

`state.viewerUrl` 现在形如 `/.latex-preview/assets/viewer/index.html?file=%2F.latex-preview%2Fpdf%2Fmain.pdf&v=5`；资源缺失时返回 `null`，面板自动退回 `pdfUrl`（浏览器查看器），不会出现坏 iframe。

**打包**：`assets/` 是生成物（约 5.0 MiB），已进 `.gitignore`；`scripts/build-assets.mjs` 可重跑，`package.json` 的 `build` 与 `prepack` 都会调用它，`files` 早已包含 `assets`。

---

## B13 · 右侧栏 tab 需要**两级**注册（B2 的补完）

上一轮只做了第二级：把 body 注册进 keyed 槽 `sidebar.right.pane.tab`。真机里槽条目确实 `active: true`，但**侧栏里什么也没出现**——因为侧栏的 tab 条不是从槽条目画的。

**证据**（`@deepseek-ai/dsh-client-ui-sidebar-right`）：

```js
// 侧栏从自己的类型注册表 + 会话 layout 画 tab
const definition = useTabTypes((types) => types.find((d) => d.kind === tab.kind));
const content = renderSlot(seat, {}, { entryKey: definition?.id ?? tab.kind, ... });
```

```js
// 服务面：provide 了两个键
ctx.reflect.provide("sidebarRightTabs", tabs);   // 类型注册表
ctx.reflect.provide("sidebarRight", controller); // 导航面（openTab/openResource）
```

所以顺序是：

1. **第一级（类型）**：`ctx.get('sidebarRightTabs').register({ id, kind, title, keepMounted, guide })`。
   - `id` 用包名（这是"实现身份"，全局唯一）；
   - `kind` 是 `openTab` 用的判别值；
   - **`id` 同时是第二级两个槽的 `key`**——`renderSlot` 用 `entryKey: definition.id` 查表，两边不一致就渲染不出来。
2. **第二级（内容）**：`ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: id }, Component))`，标题槽同理。

**时序坑**：这两个服务由侧栏插件在自己的 `apply` 里 provide，与本插件的激活顺序没有保证。直接 `ctx.get` 会读到 `undefined`（实测日志：`sidebarRightTabs unavailable; tab type not registered`）。必须用动态注入：

```ts
ctx.inject(['sidebarRightTabs', 'sidebarRight'], (sub) => { ... })
```

注意这与 `package.json#dsh.client.inject` 是两回事：后者仍需与导出的 `inject = ['slots']` 逐字一致（§B11 第 2 条），否则整条激活失败。

**打开时机**：`openTab(kind)` 在没有 on-screen Session 时抛异常。首次打开因此是「激活后再等会话」：500ms 重试（最多 20 次）+ 订阅 `sidebarRight.mounted`，任一路径成功即停。一次页面加载只自动打开一次——用户关掉就该保持关掉；之后可从 tab 条 `+` 的 guide 页重新打开（`definition.guide` 提供那一条胶囊）。

**顺带**：`configure()` 在首次配置且没有 PDF 时会立即编译一次，否则面板要等用户点「编译」才有内容。

### 真机验证（2026-11-16）

| 检查 | 结果 |
|---|---|
| guide 页出现「LaTeX 预览 / 编译结果、PDF 预览与报错回传」 | ✅ 说明类型注册成功 |
| 点该胶囊 → 侧栏出现 tab，标题「LaTeX」 | ✅ |
| tab 内工具条「编译 / 发送给 Agent / 脱敏」+ 状态「已配置主文件：E:////dsh-run////main.tex」 | ✅ |
| tab 内 iframe | ✅ `/.latex-preview/assets/viewer/index.html?file=%2F.latex-preview%2Fpdf%2Fmain.pdf&v=4` |
| iframe 内渲染 | ✅ 页面文字 "Hello from DSH LaTeX Preview." / "1 Demo" 可见 |
| 零点击路径（只打开会话） | ✅ 自动打开 tab 且自动完成首编，iframe 带上 PDF 版本号 |

---

## B14 · 「发送给 Agent」在 HTTP 路由里拿不到 initiator（已修）

真机点按钮的返回是：

```json
{"ok":false,"error":{"code":"latex-preview/handoff-failed",
 "message":"当前没有可投递的会话（编译由文件监听触发，而非会话发起）；请从对话窗口重试"}}
```

**原因**：`ctx.agents.currentInitiator()` 只在 driver 的异步边界内有效；面板走的是 HTTP 路由，整条链路没有任何 Agent 在跑，所以 initiator 恒为空。这不是"编译由监听触发"的问题，而是**跨进程调用天然没有因果父**。

**修法**（`dsh-agent` 的 `AgentRegistry.get(id: SessionId)` 是公开的）：

1. 面板从 DOM 读到所在会话键——侧栏把 `data-sidebar-right-session` 打在包裹节点上，`frameRef.closest('[data-sidebar-right-session]')` 即可（URL 里没有会话 id，SPA 状态不外露）。
2. 随 `sendErrorToAgent({ sessionId })` 传下去。
3. Host 侧 `agents.get(sessionId)` 解析出 live Agent —— 两种拼写都试（`session-<uuid>` 与去掉前缀的 `<uuid>`），失败则回落到 initiator 链。

**真机验证**：按钮由禁用变可点（有 1 个错误），点击后面板状态变「错误已发送给 Agent」，会话里出现完整 prompt（含 `main.tex:3`、`Undefined control sequence.`、源码上下文），Agent 随即 `读取 main.tex → 编辑 main.tex（+1 −1）`。

另外补了按钮的 `title`：`上次编译没有错误，无需发送` / `把这次的编译错误发给当前会话的 Agent`——之前禁用状态没有任何解释。

**顺带修掉的真 bug**：编译后换 PDF 时控制台出现

```
scrollPageIntoView: "1" is not a valid pageNumber parameter.
```

PDF.js 对坏页码**只警告不抛错**，所以滚动保持会静默失效。`scrollToPage` 现在统一 `Math.trunc(Number(page))` 并拒绝非正数。

---

## B15 · PDF 坐标换算：`getViewport({scale:1})` 已经是点，不用再乘 96/72

**症状**：选中 PDF 里第 3 行的 “Hello world.”，反查结果却是 `main.tex:6`（`\end{document}`）。整页纵向偏了约三行。

**定位**：在真实页面里取一组几何量，再对 `synctex edit` 做 y 扫描：

```
spanText  Hello world.
rect.top  177.16   box.top   8     box.h  1056
viewport  612 × 792
y (旧算法) 95.15
```

`612×792` 正好是 Letter 的**点**尺寸（8.5×11 in × 72）。也就是说 `page.getViewport({ scale: 1 })` 返回的已经是 PDF 点，而 DOM 上的 `.page` 元素是 816×1056 CSS px（96 dpi）。旧代码把「占元素高度的比例 × 792」的结果又乘了 `72/96`，等于把 y 缩到 0.75 倍，落进了页眉空白区。

y 扫描（x=120，单位点，origin 左上）：

| y | 30–90 | 120 | 150 | 200–400 | 500+ |
|---|---|---|---|---|---|
| 反查行 | 6（无 tag，落到末行） | 3 | 4 | 5 | 5/6 |

**结论与修法**：`x = 比例 × viewport.width`，`y = 比例 × viewport.height`，不乘任何 dpi 系数；原点确实是左上（y 增大向下），`flipY` 保持可选。`viewer/viewer.js` 的 `toPdfRect` 与 `client/pdf-viewer.ts` 的 `pdfPointFromClick` 都已改。改完后第 3 行→`main.tex:3`、第 5 行→`main.tex:5`，与源码逐行对得上。

---

## B18 · 改动审核：手动 / 独立 AI / 完全放开

**问题**：AI 改完 `.tex` 会自动编译，改坏了只能靠人发现。需要一道可调的闸门。

**三档语义**（`ReviewMode`，存于服务实例，`configure({review})` 可改）：

| 档位 | 编译成功后 | 基准（diff 的左边） | 撤回 |
|---|---|---|---|
| `manual` 手动审核 | 挂着等「接受」 | 不动，标记累积每次未接受的改动 | 「撤销」写回基准 |
| `auto` 自动审核 | 派一个独立 AI 审，按结论决定 | AI 通过才上前 | AI 否决时自动回滚 |
| `open` 完全放开 | 直接认账 | 立刻上前 | 不提供 |

「基准」是 `previousSource`，「当前」是 `compiledSource`；diff 永远算这两者之间，标记也就是「还没被接受的部分」。

### 独立审核者不是当前会话的 Agent

当前会话的 Agent **就是改文件的那个**，让它审自己的改动毫无意义，而且它还能再改。所以审核者是一次**独立的一次性模型调用**：自带 system prompt、无工具、无历史，只能回答 `accept` / `reject`。实现在 `services/reviewer.ts`，与 `agent-bridge`（发消息给会话）是两条完全不同的路径。

**模型路由从哪来**：`agent.session.requestHeader().config` 是官方 `dsh-experimental-auto-review` 取 provider/model 的地方，照抄即可。但**新会话在第一次对话前没有 header**（实测返回 undefined），此时回落到 `ctx.agentDefaultModel.currentSelection()`——这也是下一轮对话会用的模型。

**解析要保守**：先找 JSON，再退化为关键字扫描；两者都失败就是 `unavailable`。`unavailable` 绝不当作通过——闸门打不开时转手动（标记保留、提示「请点接受或撤销」），而不是放行。

**否决即回滚**：`reject` 走的是和手动「撤销」同一个 `applyRevert()`——把基准内容写回源文件并重编译。所以否决是有破坏性的，`reviewer` 的 system prompt 必须把「什么算不可接受」写死（引入错误、删掉不该删的、留占位/TODO、顺手改无关部分）。

### 真机验证（真实 DeepSeek 调用，非 mock）

| 场景 | 结果 |
|---|---|
| 改一行正文 | `自动审核通过：仅修改正文一行文字，语法无误，未触及结构或无关内容。` |
| 把正文换成 `TODO`、删掉所有内容 | `自动审核未通过，已回滚：…删除正文并加入 TODO 占位`，源文件被写回并重新编译 |
| 新会话无 header 时 | 回落到默认模型，仍能审；没有默认模型则转手动 |
| 手动档改动 | 出现「接受 2 / 撤销」，点接受后标记清零 |
| 审核超时 | 25s 后判 `unavailable`，转手动（避免一直显示「审核中」） |

### 顺带修掉的状态悬挂

`compiler.run()` 一旦抛错（不是编译失败，是没起来），`status` 会永远停在 `compiling`，面板看起来像卡死。现在 catch 后先 patch 成 `failed` 再抛出。

### 删除改成红色斜纹

纯删除没有内容可染色，之前只画 2px 虚线，太弱。现在画**红色斜纹带**（`repeating-linear-gradient`）+ 左侧实心红边：读起来是「这里少了一块」，而不是「这一行被改了」。带高最初固定 7px，现已改成按行高缩放（§B19）。

---

## B19 · 覆盖层的三个渲染陷阱：异步竞争、混合模式、缓存

**起因**：外部评审提出「覆盖层可能被旧绘制覆盖」，并怀疑 `mix-blend-mode` 让颜色失真。逐条对着代码核对后：前两条成立，第三条（自建 Canvas + devicePixelRatio）不适用——这个页面用的是 `PDFViewer` 组件，从不自己 `page.render()`。

### 一、`paintDiffPage()` 真的有竞争

原实现是「先删旧层 → `await getPage()` → 建新层 → append」，中间没有代次检查。而 `pagerendered` 在缩放、滚动、重排版时都会再触发一次，`diff` 消息也会。于是：

```
A: 收到旧 regions → 删层 → await getPage()
B: 收到新 regions → 删层 → await getPage()
B: 先恢复 → append 新层
A: 后恢复 → append 旧层   ← 旧标记盖新标记，且同页两个 .diffLayer
```

实测在连续缩放时会短暂出现两个 `.diffLayer`（`painted` 里也残留被移除页面的条目）。

**修法**（`viewer/viewer.js`）：

1. **代次**：每条 `diff` 消息 `diffGeneration += 1`；绘制开始时记下代次，提交前比对，不等就丢弃。
2. **每页令牌**：`pagePaintTokens`（`WeakMap`）给每次绘制一个递增 ticket，同一页后发起的绘制会作废先前的。
3. **原子替换**：新层先 append、再移除旧层，页面不会在重绘中间失去标记。
4. **提交前检查**：`pdfDocument` 是否换了、`pageEl.isConnected` 是否为 false（PDF.js 已销毁该页）。
5. `painted` 只在成功提交后整体替换该页的条目，不再在 await 期间 push。

`pagerendered` 也改成优先用 `event.source.div`（刚渲染完的那个页面元素），按页码重查可能命中重建后的另一个实例。

**验证**（真机，40 次连续快速改 `currentScale`，60ms 间隔）：每页 `.diffLayer` 恒为 1，无孤儿层，40 次后仍能命中删除接缝并弹出被删源码行。

### 二、`mix-blend-mode: multiply` 该删

它把色带与 PDF 底图相乘：同一块琥珀色压在白底上是浅黄，压在深色公式或图片上会变暗甚至看不见；不同浏览器的合成结果也不一致。

改成普通 alpha 合成，颜色略降（绿 0.22→0.16、琥珀 0.26→0.18），左侧 gutter 实心边继续承担「这是哪类改动」。实测 `getComputedStyle(band).mixBlendMode === 'normal'`，`backgroundColor` 为 `rgba(46, 160, 67, 0.16)`。

### 三、接缝高度不该固定成 7px

固定 CSS 像素意味着 50% 缩放下那条缝比行还粗、200% 下细成一条线。改为按行高算：

```
linePx  = (region.height / viewport.height) * pageEl.clientHeight
seamPx  = clamp(2, 8, linePx * 0.55)
```

实测 `seam` 高度 0.5×→3.7px、1×→7.5px、2×→8px（上限截断）。命中测试用同一个 `seamPx`，并以 8px 为下限，否则低缩放下这条缝无法 hover。

### 四、坐标换算要共用一个函数

绘制原本按 `region / viewport * 100%` 算，命中测试按 `region / entry.width * box.width` 另算一遍。数学上等价，但两处各改一次就会「看得见、点不着」。现在统一为 `regionPercent()`（绘制）与 `regionClientRect()`（命中），后者只把百分比换回 client 坐标。

### 五、`viewer.css` 也要带版本号

`viewer.js` 早就用 `?v=` 了，但两张 CSS 仍是固定 URL，而 `/assets` 的 `max-age=3600` 会缓存它们——改样式要等一小时，改脚本却下次编译就生效，很容易误判成「样式没生效」。现在 `index.html` 用一小段内联脚本把同一个 `?v=` 拼到 `viewer.css` 上（`pdf_viewer.css` 属依赖，保持固定 URL）。实测 `<link href="viewer.css?v=10">`。

### 没改的部分，以及理由

- **不自建 Canvas、不手动乘 devicePixelRatio**：页面用 `PDFViewer` 组件，底层 Canvas 由它管理；自己再画一层只会引入两套缩放基准。
- **`annotationMode: 0` 保持不变**：注释层是有意关闭的，预览是只读的。若将来「批注消失」被当成渲染 bug，先看这里。
- **旋转页面没有处理**：`getViewport()` 会应用 `/Rotate`，而 SyncTeX 的盒子是未旋转的 PDF 坐标，两者在非零旋转下不能直接按宽高比换算。LaTeX 常规输出不旋转页面，所以先记为边界而不是盲改——要支持必须用真实旋转 fixture 验证。
- **没有加 `test/visual/` 视觉回归**：外部评审建议了一套浏览器 × DPR × 页面尺寸矩阵，这里暂不引入——它需要真实的 Chromium 矩阵和像素基线，维护成本高于当前的收益。真机手工验证记录在上一节。

---

## B20 · 旧版产物必须与「基线」成对，而不是与「上一次编译」成对

**目标**：为「在旧版 PDF 上显示被删除内容」准备可信的地基——一对**同源**的旧 PDF + 旧 SyncTeX，且必须属于 diff 真正使用的基线。

**先证明配对规则**：`synctex view -o <pdf>` 是按 **basename** 找同名 `.synctex.gz` 的，不会去别处凑。实测把当前的 `main.synctex.gz` 暂时藏起来后，`synctex view -o main.prev.pdf` 仍然命中 `Page:1`——它读的是 `main.prev.synctex.gz`。所以旧版必须成对命名：

```
main.pdf                main.prev.pdf
main.synctex.gz         main.prev.synctex.gz
```

名字不配（`main.prev.pdf` + `main.synctex.gz`）不会报错，只会把旧行号映射到新文档上。

### 两类副本，职责不同

| 文件 | 用途 | 生命周期 |
|---|---|---|
| `main.pdf.prev` / `main.synctex.gz.prev` | 编译失败时回滚 | 瞬态：失败即被 restore 消费，成功则提升 |
| `main.prev.pdf` / `main.prev.synctex.gz` | 基线的旧版产物，供旧版视图定位 | 持久：直到基线换了主人 |

### 失败必须成对回滚（这是修掉的现存 bug）

原来只备份/还原 PDF，`.synctex.gz` 每次被 tectonic 覆盖：编译失败后屏幕上是旧 PDF，定位表却可能是新一次编译的，于是**双击反查会落到错误行且不报错**。现在两份一起备份、一起还原。

实测（真实 tectonic）：故意写 `\undefinedmacro` 触发失败，失败前后 `main.pdf` 与 `main.synctex.gz` 的 sha256 完全一致，且 `synctex view -i 5:0` 的返回值（`Page:1 x:165.268341`）不变。

### 采纳/丢弃：不能在编译层决定

「上一版」是哪一版取决于审核模式：手动模式下编译成功但没点接受，基线**不该**动。所以 `compile.ts` 只负责产出候选对，由服务决定它算不算基线：

```ts
// runCompile: before = 本次编译前屏幕上那一版
await this.adoptBaseArtifacts(before)
// adopt: previousSource === before 才认，否则删除这对文件
```

基线追上来时（接受 / 自动审核通过 / 回滚）直接**从当前产物复制**，不必二次编译：

```ts
previousSource = compiledSource
await this.snapshotBaseFromCurrent()
```

`baseRevisionId` 是基线源码的 sha1 前 12 位，写在状态里；任何用到旧行号的地方都应先比对它，而不是相信磁盘上恰好有个 `prev` 文件。

### 验证矩阵（真机，open / manual 两种模式）

| 场景 | 期望 | 实测 |
|---|---|---|
| 全新 outDir 首次编译 | 无旧版产物，`baseRevisionId` 为 null | null ✔ |
| open 模式连续两次成功编译 | 旧版对描述第一版 | `baseRevisionId` 有值，`main.prev.pdf` 仅比 `main.pdf` 早一次编译 ✔ |
| manual 模式：编译后待审 | 旧版对 = 基线（未含待审改动） | 采纳，`previousSource` 与产物同源 ✔ |
| manual 模式：连续三次编译仍待审 | 基线落后于候选对 → 丢弃 | 第二次起 `baseRevisionId` 变 null ✔ |
| 点「接受」 | 基线 = 当前，产物从磁盘复制 | `baseRevisionId` 变为当前内容摘要 ✔ |
| 编译失败 | PDF 与 synctex 一起回滚，基线不动 | sha 与反查结果均不变，`baseRevisionId` 不变 ✔ |

### 已知边界

- `configure()` 会重建 compile/watcher 并把 `previousSource`/`compiledSource` 重置为当前文件内容——也就是说**切换审核模式会顺手把当前内容认成基线**。这是既有行为，本轮未改；首次切换后看到「旧版对突然对上了」不是 bug。
- 基线只在内存里。进程重启后 `previousSource` 为 null，下一次编译会把磁盘上的孤儿对删掉（`adopt(null)`），因此不会出现「配上了但没有基线」的假象。
- 旧版视图（下一步）必须只读：旧行号属于旧源码，拿去 `edit-at` 会改错行。

---

## B21 · diff 的行号差一行：`cleanupSemantic` 的边界位移

**现象**：一个只改了中间一段的文档，色带整体落在改动**下一行**；「删除了 N 行」的 N 也比实际多 1。

**根因**：`lineDiff` 的顺序是 `diff_linesToChars_` → `diff_main` → `diff_charsToLines_` → `diff_cleanupSemantic`。最后那一步是在**真实文本**上跑的，它会把片段边界挪到字符级的"语义边界"，于是片段可能以 `\n` 开头——那个 `\n` 其实是**上一行的行尾**，被算成了本块的第一行。三种时机对比（同一对输入）：

| 时机 | 片段 |
|---|---|
| 不跑 cleanup | `0 "…A\n"` `-1 "B\nC\n"` `1 "B2\n"` `0 "D\n"` `1 "NEW\n"` |
| **转回文本前**（一行一字符） | `0 "…A\n"` `-1 "B\nC\nD\n"` `1 "B2\nD\nNEW\n"` `0 "E\n…"` |
| 转回文本后（原实现） | `0 "…A\nB"` `-1 "\nC\nD"` `1 "2\nD\nNEW"` `0 "\nE\n…"` |

只有第二行那种（`charspace`）既保持**行对齐**，又把 delete+insert 合并成一处改动。故改为 `diff_linesToChars_` → `diff_main` → `diff_cleanupSemantic` → `diff_charsToLines_`。修正后同一例：`modify new 4-6 / old 4-6`（旧侧= B,C,D，新侧= B2,D,NEW），总行数与文档一致。

### 另一个坑：空行会返回**下一行**的盒子

`synctex view -i 8:0:main.tex` 对空行没有盒子，实测它给出的是第 9 行的盒子（真实文档 `Charlie paragraph.` 被删后）：

| 查询 | 得到的盒子 | 反查回的行 |
|---|---|---|
| 旧版 pdf + 旧行号 7（`Charlie paragraph.`） | p1 y=151.7 h=9.1 | 7 ✔ |
| 旧版 pdf + 旧行号 8（空行） | p1 y=163.7 h=9.0 | 9 ✘（这是 Delta） |
| 旧版 pdf + 旧行号 11（只在旧版存在） | p1 y=175.7 h=9.0 | 11 ✔ |
| 新版 pdf + 行号 11 | p1 y=696.0 h=6.6 | 10（页脚页码盒子，见 §B17） |

所以在解析范围内要先滤掉空行（`typesetLines`）：空行没有字形，不标才是诚实的；整段都是空行时计入 `skipped`。真机上该修复删掉了压在「第三段」上的那条假红带。

**真机验证**（真实 tectonic 编译，`main.tex` 三行正文、中段整段删除）：

| 场景 | 结果 |
|---|---|
| `lineDiff` + `diffHunks` | `delete old 7+2 new 7`，`removed=2`（与文档一致） |
| 旧版视图区域 | 1 个 `kind: 'removed'`，`lines 7-8`，y=171，h=10（不再有第二条） |
| 新版视图区域 | 1 个 `kind: 'delete'` + `seam: true`，y=181 |
| 后端往返 | 旧行号 7 → 盒子 → `synctex edit` → 行 7 ✔ |

---

## B22 · 旧版视图：被删除的文字回到它原来的位置

**目标**：新版 PDF 上，删除只能是一道接缝——排好的字没了就是没了。让用户看到"删掉了什么、原来在哪"的唯一办法，是把**上一版 PDF**拿出来，在它上面按**旧行号 + 旧 SyncTeX** 标出那些行（产物成对规则见 §B20）。

**契约**：

- `getDiffRegions({ side })`：`new` = 当前 PDF，`base` = 上一版 PDF；每个 `DiffRegion` 的 `lineStart/lineEnd` 是**所显示那份文档**的行号。`DiffRegions.side` 随结果返回，`message` 在不该画的时候说明原因（"未成对""两版一致"），而不是静静返回空。
- 旧侧：被删的行走 `kind: 'removed'`（红带 + 中线删除线，字确实还在页上）；被改写的行 `kind: 'modify'`；纯新增没有可染的像素，保留接缝并指向"插在哪一行之后"。
- `DiffRegion.seam` 是**几何**标记（这条线不在当前这页上），取代原来 `kind === 'delete'` 的判断——同一个 kind 在一侧是带、在另一侧是缝。
- 面板只在显示的哪一侧时取哪一侧的区域（每侧一整套 `synctex view` 进程），并在旧版视图期间给查看器发 `{type:'mode', readOnly:true}`。

**为什么必须只读**：旧版页面的每个像素都对应**旧**行号。`edit-at` 会把旧行号当新行号去改源码，`dblclick` 反查报出的行在新文件里是另一段文字，点色带跳行同理。所以这三条链路在旧版视图里**关闭**而不是给出错误答案；文字仍可选中复制（选区照常），只是不浮出发送条。

**真机验证**（DSH 0.2.2-rc.1 + Edge headless，`review: open` 让基线自动推进）：

| 场景 | 期望 | 实测 |
|---|---|---|
| 删掉一整段后 | `baseRevisionId` 有值、`basePdfUrl` 指向 `main.prev.pdf` | ✔ `bcacf6464e1f` |
| 点「上次编译版」 | iframe 切到 `main.prev.pdf`，出现 `.diff-removed` | ✔ 1 条，box y=236 h=13 |
| 旧带的提示 | 指明是旧版行号 | ✔「旧版第 7-8 行：这 2 行已被删除（第二段…）」 |
| 旧版视图里选中文字 | 选区正常、**不出现**浮条 | ✔ `selected:"第二段：这一"`，`editBar:false` |
| 当前视图里同样选中（对照） | 浮条出现 | ✔ `editBar:true` |
| 点「回到当前」 | 回到 `main.pdf`，接缝恢复 | ✔ 1 条 `diff-delete` |
| 基线消失（撤销/新进程） | 面板自动切回当前并说明 | 已实现（`baseRevisionId === null` 时 setView('live')），未单独真机演练 |

**边界**：旧版视图只能描述"基线 → 当前"这一对，因此它永远和 diff 高亮同源；`latexdiff` 的第三份文档（§B17 之前的两层方案）仍是"想要真正重排版式删除线"时的选项，两者不冲突。

---

## B17 · PDF 上的 diff 高亮：`v - H` 才是盒子顶边，`y` 不是

**目标**：在 PDF 上把「这次编译改了什么」画出来，行为接近 git diff。

**做法**：源码 `lineDiff` → 折叠成 hunk（相邻 delete+insert 合并为 `modify`）→ 每行 `synctex view` 取盒子 → 按行合并成色带 → 查看器用**百分比**定位叠在页面上（缩放自动跟随，无需 resize 钩子）。

### 坐标：`y` 是参考线，顶边是 `v - H`

第一版用 `(x, y, W, H)` 画，色带整体落到文字**下方**。在真实页面里把三种候选矩形与文字层 span 做重叠度对比：

| 候选 | 第 4 行（`Hello LaTeX…`） | 第 5 行（公式行） |
|---|---|---|
| `y`（原实现） | 只压到 `√` 的下缘，oy≈9.3/14 | 落到下一行尾部，oy≈9.3/19 |
| `v - H` | **完全重合**，oy=13.6/14 | **完全重合**，oy=14/19 |
| `y - H` | 偏上约 2px，oy≈12/14 | 偏上，oy≈12/19 |

所以 `synctex view` 的 `v` 是盒子**底边**、`H` 是行高，顶边 = `v - H`（`y` 是中间某条参考线，不是顶边）。修正后色带对文字层 span 的垂直覆盖率 0.82–0.88（差值来自 `H` 比 DOM 行高多出的行距）。反查方向（`synctex edit`，§B15）不受影响，那是另一套参数。

### 删除：`\end{document}` 会返回**页码盒子**

纯删除没有内容可染色，只能画一道接缝。若锚定「删除位置所在的新行」，在文档末尾时那一行常是 `\end{document}`，`synctex view` 对它返回的盒子是**页脚页码**（y≈936，页面底部），接缝就会画到页面底部空白里，而且滚出视口后连 hover 都打不到。

改为**锚定前一行、画在该行底部**（内容原本就结束在那里）：接缝落在最后一行文字下沿 1px 处，tooltip 正常。前一行若也不渲染（注释、空行），向前最多找 4 行，全都无映射时计入 `skipped` 并在按钮 title 里说明，而不是乱画一个位置。

### 基线：diff 必须对「上一版 PDF」而不是「磁盘上的文件」

原来的 `previousSource` 在每次成功编译后被改写成当前内容，等于 `diff` 永远返回空——这条路径此前没有 UI 在用，所以一直没暴露。现在分开存两个快照：`previousSource`（上一次成功编译的内容，对应 `.pdf.prev`）与 `compiledSource`（当前 PDF 的内容），diff 在两者之间计算；成功编译时仅在内容真的变化时推进基线，因此**连续点两次「编译」不会把高亮抹掉**。

### 交互取舍：覆盖层不吃鼠标

`.diffLayer` 与色带全部 `pointer-events: none`。若让色带可点，恰好是「改动过的那几行」选不中文字——正好废掉本插件最主要的交互。悬停说明与点击跳转改为在容器上按矩形做命中测试（删除接缝 2px，纵向命中区放宽到 8px）。

### 上限与代价

每处改动一次 `synctex view` 进程开销，所以：最多 24 个 hunk、每版最多 40 行解析；超出的行用**均匀采样**（否则 40 行的段落只有顶部被标，看起来像改动提前结束）。超限部分计入 `skipped`，按钮 title 显示「另有 N 处超出标注上限」。

**真机验证**（DSH 0.2.2-rc.1 + Edge headless，真实 tectonic 编译）：

| 场景 | 结果 |
|---|---|
| 改一行 + 插一行 | 2 个色带：`modify`/`insert`，垂直覆盖率 0.88 / 0.82，hover 显示「修改第 5 行：…」 |
| 只删一行（文档中段） | 1 道虚线接缝，压在前一行文字下沿，tooltip「在第 7 行之前删除了 1 行…」 |
| 点「差异 N」 | 色带整体隐藏/恢复 |
| 无改动再点「编译」 | 高亮保留（基线未推进） |
| 点击色带 | 状态栏钉住说明文字 |

---

## B16 · 「在 PDF 上选一处，让 AI 改」的落地

**交互**：在 PDF 里选中文字，或在没有文字层的地方拖一个框 → 原地浮出一条输入栏 → 写一句要求 → 发给当前会话的 Agent。改的始终是 `.tex`，PDF 只是定位入口。

**实现要点**：

- 文字层必须开（`textLayerMode: 1`）；它为 `window.getSelection()` 提供可选文本。注释层仍关闭。
- 框选只在鼠标按下点**不在** `.textLayer` 内时启动，所以普通文本选择不会被打断；阈值 12px，避免误触变成选区。
- 两个角点都做 `synctex edit` 反查，取同一文件内的 `min..max` 行，跨行选区因此得到行范围；上限 12 行（`MAX_EDIT_LINES`），避免框住整页时把整页源码塞给 Agent。
- **不提取 PDF 文本作为内容**：公式、连字抽出来常是乱码。选中的文字只作为「仅供参考」的一句附注，真正给 Agent 的是源码行。
- 输入栏画在查看器页面内（`#editBar`），而不是 React 侧——省掉跨 iframe 的坐标换算；提交后只 postMessage 一个 `edit-request`。
- Host 侧新增 `POST /.latex-preview/api/edit-at`，复用 §B14 的 sessionId→Agent 解析；脱敏开关照旧（开时不带源码、不带选中文字）。

**真机验证**（DSH 0.2.2-rc.1 + Edge headless）：

| 场景 | 结果 |
|---|---|
| 选中 "Hello world." → 输入要求 → 提交 | 状态「已把修改要求发给 Agent（main.tex:3）」，会话收到带 `3: Hello ...` 源码块的 prompt |
| 选中第 5 行文本 | 反查 `main.tex:5`，与源码一致 |
| 在正文空白处拖框（无文字层） | 浮条显示「第 1 页选区」，反查 `main.tex:5-6`（行范围） |
| Agent 收到后 | 直接编辑 `.tex`，文件监听触发重编，PDF 原地刷新 |

---
