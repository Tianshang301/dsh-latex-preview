# 交接文档 · dsh-latex-preview

> 交接日期：2026-11-15
> 接手人预期投入：4–6 周全职，单人
> 一句话：给 DSH（DeepSeek Harness）做一个 LaTeX 实时预览插件，改稿即出新 PDF，改错了能一键把报错丢给 AI 修。

---

## 1. 先读什么（按顺序）

| 顺序 | 文件 | 作用 | 读多久 |
|---|---|---|---|
| 1 | 本文件 | 现状、决策、未决问题、怎么起步 | 15 分钟 |
| 2 | `DEVELOPMENT_PLAN.md` | 六周任务分解、验收门、风险登记 | 30 分钟 |
| 3 | `LaTeX Preview — 开发文档.md` | 规格书：架构、模块伪代码、API 契约 | 60 分钟 |
| 4 | `AGENTS.md` | 仓库级不变式速查（写代码时反复回看） | 5 分钟 |

规格书是**权威依据**，计划是**执行方案**。两者冲突时以规格书为准，但计划第 1 节列的 6 个悬案除外——那几处是我认为规格书判断有误或缺失的地方，逐条给了理由。

---

## 2. 当前状态（如实说明）

> **2026-11-16 更新**：脚手架已落地，§6 的悬案大部分已有结论。**动手前先读 `docs/spikes.md`**，那里是逐条的实测证据，本节下面的表格是交接当时的快照。

| 项 | 状态（2026-11-15 交接时） | 现状（2026-11-16） |
|---|---|---|
| 代码 | **零** | 可加载的空插件：`src/index.ts` + 服务骨架 + `utils/binaries.ts`（完整） |
| 构建 | 无 | `npx tsc -p tsconfig.json` + `node scripts/build-client.mjs` 均通过 |
| 契约探针 | 无 | `npx tsx test/contract/probe.ts` → 5 pass / 0 fail / 2 skip |
| 二进制 | tectonic 缺失 | **tectonic 0.17.0 已装并加入 PATH**；端到端试编通过 |
| 未验证 | B1–B6 | B1/B3/B8/B9 已定案；**B2/B7 仍阻塞 P0.5**；B6 待真实 profile |


不要指望 `pnpm build` 能跑，它还没被创建。计划里的 `pnpm build` / `pnpm verify` 是**待实现的目标**，不是现有脚本。

---

## 3. 本机环境实测（2026-11-15 探测结果）

| 依赖 | 状态 | 备注 |
|---|---|---|
| Node | ✅ v22.22.2 | 满足 |
| pnpm | ✅ 11.23.0 | 满足 |
| npm | ✅ 10.9.7 | 满足 |
| git | ✅ 2.55.0.windows.3 | 仓库尚未初始化，需 `git init` |
| **tectonic** | ❌ **未安装** | **接手第一件事：装它。** 否则连编译都跑不了 |
| synctex | ✅ 已安装（v1.21 引擎 / v1.5 工具） | 由 **MiKTeX** 提供，路径 `D:\Users\ASUS\AppData\Local\Programs\MiKTeX\miktex\bin\x64\synctex` |

**装 tectonic 的命令**（Windows x64）：

```bash
# 方式一：官方二进制（推荐，本机是 win-x64）
# 从 tectonic 官方 release 下载 tectonic-*-x86_64-pc-windows-msvc.zip，解压后把目录加入 PATH
# 方式二：若有 Rust
cargo install tectonic
```

装完必须验证 `tectonic --version` 能输出。

### 探测时发现的两个坑（写代码前务必知道）

**坑 A · `synctex --version` 的版本号在 stderr，且有两个版本号。**
实测该命令退出码 0，stdout 只有一行 `This is SyncTeX command line utility, version 1.5`，而 stderr 里还有 712 字节的用法说明，其中写着 `version 1.21`。检测逻辑如果只读 stdout 会拿到 `1.5`（工具版本），而引擎版本是 `1.21`。结论：**别把版本号用于兼容性判断**，只判断"命令能否正常执行"，需要版本就记录两个都记。

**坑 B · 本机 synctex 来自 MiKTeX，不是 Tectonic 自带。**
规格书假设 `synctex` 随 Tectonic 分发。本机实际情况是 Tectonic 还没装、synctex 已由 MiKTeX 提供。这不一定是坏事（版本兼容性通常没问题），但意味着**不能假设两者来自同一个 TeX 发行版**。启动检测要分别报告 `tectonic` 和 `synctex` 的**来源路径**，方便排查"synctex 定位不准是不是版本不匹配"。

---

## 4. 命名约定（已定，不要改回去）

产品名：**LaTeX Preview**。下表是全部标识符的唯一取值来源，代码、文档、README、npm 页面、发布信息一律照此。

| 用途 | 值 |
|---|---|
| 产品名 | `LaTeX Preview` |
| npm 包名 | `dsh-latex-preview`（npm 上未被占用；`dsh-` 前缀是 DSH 插件生态的命名空间约定，不是"for DeepSeek Harness"的标题后缀） |
| cordis patch id | `latex-preview` |
| 槽位 id | `latex-preview` |
| 服务键 / `ctx.<键>` | `latexPreview` |
| 服务类名 | `LatexPreviewService` |
| 文件名 | `latex-preview-service.ts` 等 |
| 事件前缀 | `latex-preview:` |
| 消息来源标记 | `{ kind: 'plugin', plugin: 'latex-preview' }` |

**工作目录**：`E:\dsh-latex-preview`。发布时仓库名应为 `dsh-latex-preview`。

---

## 5. 已经定下的决策（附理由，避免你重新讨论一遍）

| # | 决策 | 理由 |
|---|---|---|
| D1 | **不做 draftMode** | 规格书 §3.1 要求在 `\documentclass` 后注入 draft 选项，但注入必然落到某个 `.tex` 上：改用户文件不可接受；编译临时副本会让 `.synctex.gz` 记录临时路径，**反向跳转（PDF→源码）全部失效**。这是硬冲突，不是取舍问题。 |
| D2 | 编译必须加**超时** | 规格书伪代码没有。Tectonic 首编要下载 bundle，可能分钟级；无超时会永久挂起。建议常规 120s / 首次 300s。 |
| D3 | 编译必须加**单飞（single-flight）** | 规格书伪代码没有。连续保存会叠多个进程抢同一 `outDir`，`.prev` 备份与回滚互相踩，可能把好 PDF 覆盖成坏的。 |
| D4 | 一律走 `synctex` **CLI** | 手写 `.synctex` 解析器被官方 manpage 明确禁止。规格书坑 6 已列。 |
| D5 | PDF 走**同源静态 URL**，不走 postMessage 传二进制 | 大文件传二进制会把主线程拖死；同源还能让 iframe 内 DOM 可访问，滚动恢复才做得了。 |
| D6 | **滚动位置保持 + 编译产物回滚**是底线 | 规格书明确"任何情况下不砍"。前者决定用户会不会卸载，后者决定编译失败时会不会看到白屏。 |
| D7 | 第一个可砍项是 **P2 批注** | 规格书的砍功能顺序：P2 批注 > P1 diff 点击跳转 > P0+ warning 级。排期紧就砍这个。 |
| D8 | 版本**精确锁定**，不用 `^` | DSH 处于 developer preview，API 有破坏性变更（规格书坑 7）。 |

---

## 6. 六个未决问题（接手后的第一优先级）

规格书第 10 节自称"已完成 API 契约核验"，但下面三条我认为核验不足。**B1/B2/B3 必须在 Day 1–2 出结论**，否则后面四周的排期都是猜的。

### B1 · Host → Client 能不能传回调函数？（最高风险）

规格书 §2.1 写 `api.onCompiled((result) => {...})`——Client 把一个**函数**传给 Host 服务。如果双半之间是序列化 RPC（Cordis 双半的常见实现），函数过不去，而这是"文件变更 → PDF 刷新"整条链路的第一环。

- **验法**：20 行探针。Client 调 `ctx.latexPreview.onCompiled(cb)`，Host 侧 `cb('ping')`，看浏览器控制台有没有反应。
- **兜底 A（首选）**：改成事件总线 `ctx.emit('latex-preview:compiled', payload)` / `ctx.on(...)`。Cordis 事件本身跨半。
- **兜底 B**：Client 轮询 `getState()`（带自增 version），500ms 一次，代价是延迟与空转。
- **影响面**：`latex-preview-service.ts` 全部对外签名 + client `index.tsx` 数据流。

### B2 · 源码编辑器是 DSH 自带，还是要自己塞 CodeMirror？

规格书把 CodeMirror 6 列进技术栈，但面板注册在 `editor.panel.item`——这个槽位名暗示**面板挂在 DSH 自己的编辑器里**。两者矛盾。

- 若 DSH 自带：CodeMirror 那套（约 3–5 天）**整体冗余**，只需"读当前行 / 滚动到行 / 画行标记"的桥。
- 若不自带：才需要自建，P1 成本上升。
- **验法**：打印 `ctx.slots` 已有的 key 列表，看 `editor.panel.item` 的宿主是谁。
- **兜底**：无编辑器 API 时，diff 高亮降级为独立只读面板。

### B3 · `agent.steer()` 的 agent 实例从哪来？

规格书 §3.5 直接 `sendErrorToAgent(agent, ...)`，但**没写 agent 怎么拿**。这是"错误回传"这个差异化功能的唯一入口。

- **验法**：Host 侧 `ctx.inject(['agent'], ...)` 探测服务名；确认 `createUserMessage` 签名与 `steer` 的投递目标（当前会话？sessionId？）。
- **兜底**：退回 DSH 公开输入通道，等价于用户手发一条消息，接受"会打断当前流"的体验损失，README 如实说明。

### B4 · draftMode —— 已决策不做，见 D1

### B5 · 编译超时与并发 —— 已决策要做，见 D2/D3

### B6 · pdfjs-dist 的 viewer 资产与同源

`viewer.html` 不是单文件，需要 `pdf.worker`、`cmaps/`、`standard_fonts/`、locale 一起可访问。且必须与 Web UI **同源**，否则 `iframe.contentDocument` 拿不到，滚动恢复整条链路要改走 postMessage（+1–2 天）。

- **验法**：本地起静态服务跑通 `viewer.html?file=/x.pdf`，确认 worker 路径与同源。

---

## 7. 起步顺序（第一周照这个走）

**Day 1 上午**

1. 装 tectonic，验证 `tectonic --version` 与 `synctex --version` 都能执行
2. `git init` + 首个 commit（把现有 3 个 md 提交进去，留个干净的起点）
3. 建 `package.json`（`"type": "module"` + `dsh` 字段，照规格书 §4 抄）、`tsconfig.json`、`cordis.patch.yml`
4. 建 `docs/spikes.md`，用来记录 §6 的验证结论

**Day 1 下午 – Day 2：写契约探针（这是最值钱的两天）**

写一个能跑的最小插件，依次验证五件事并把实际观察结果记进 `docs/spikes.md`：

- `ctx.plugin(Service)` 能否注册、`super(ctx, 'latexPreview')` 能否生效
- `ctx.inject(['webServer'], cb)` 能否拿到 webServer
- `ctx.slots.inject(key, () => ctx.slots.register(...))` 面板能否出现（**不包 `ctx.effect`**）
- `createUserMessage({ content, source })` 返回什么
- `agent.steer(...)` 能否投递到当前会话

**Day 2 结束的硬性判决**：B1/B2/B3 必须有结论。**没结论就停在这里，去查 DSH 文档或问人，不要开始写 PDF 面板。** 在错误的假设上写 3 天 UI，返工成本是 3 天。

**Day 3 起**：进 P0.1（watcher）→ P0.2（compile）→ P0.4（静态路由）→ P0.6（预览）。

---

## 8. 写代码时最容易犯的错（从规格书 14 条坑里挑最致命的 5 条）

1. **槽位注册包了 `ctx.effect`** → 激活阶段抛 `Invalid effect`，表现为"插件装上了但面板不出现"，且不报明显错误，极难查。正确写法：`ctx.slots.inject(key, () => ctx.slots.register(opts, Component))`，直接调用，不包。
2. **在 `apply` 里用 `ctx.get()` 拿其他服务** → 拿到 `undefined`，因为服务 fiber 此时可能还没创建。Host 半一律用 `ctx.inject(deps, cb)`。
3. **忘了给路由/定时器/监听器注册 disposer** → 热重载后出现重复编译、重复面板。每个副作用都要 `ctx.effect(() => dispose, label)`。
4. **`lib/client.js` 打成 ESM** → 必须是懒加载 **CJS**，顶层唯一语句是模块加载器调用，所有副作用放工厂内部。构建配置要专门处理。
5. **用 `tectonic -X watch`** → 官方 issue 记录的已知缺陷，watch 与 compile 组合不可用。用 chokidar + 防抖。

补充一条不在规格书里但会咬人的：**`synctex --version` 的版本号在 stderr**（见 §3 坑 A）。

---

## 9. 验收标准（每阶段的硬门槛）

| 阶段 | 门槛 | 不过怎么办 |
|---|---|---|
| P0 | 改 `.tex` → PDF 刷新；注入错误 → 点"发送给 Agent" → 会话出现消息 → AI 回写 → PDF 刷新 | 不进第 3 周 |
| P0+ | 删掉文档后 5 页 → PDF 不跳首页、不跳末页；编译失败旧 PDF 仍在；脱敏开 prompt 不含源码 | 这是底线，必须修，不能绕 |
| P1 | 源码点击跳 PDF；PDF 双击跳源码；滚动 3 屏后坐标不漂移 | 可降级为"仅高亮不跳转"，但要在 README 写明 |
| P2 | 圈选文字 → AI 改写 → diff 高亮 | 可砍 |
| P3 | 规格书 §8 自查清单全绿 | — |

性能目标（MVP）：增量编译 P50 < 2s / P95 < 5s（≤50 页）；PDF 加载到可交互 < 800ms；滚动恢复页码一致、ratio 误差 < 5%。

---

## 10. 隐私边界（产品要求，不是技术细节）

编译、渲染、SyncTeX、diff **全在本机**，稿件内容不出本机。

但两条功能会把内容发出去：**错误回传 Agent**（发错误上下文）和 **PDF 批注发 Agent**（发批注锚点 + 用户指令）。

必须做到：

- README 明确声明这条边界
- 插件**首次启用**时弹窗告知
- "发送给 Agent"按钮旁**常驻**提示，不是只在首次
- 提供"错误脱敏"开关（默认关）：开启后只发错误消息与行号，不发源码上下文。默认关但要可开——默认开会让错误修复效果变差，默认关需要用户主动选，这是产品权衡，规格书选的是后者

这条写进 README 之前，不要发布。

---

## 11. 需要向 DSH 官方确认的事（我查不到的部分）

- `webServer.register` 的路由挂载点是否与 Web UI 同源（决定 B6 的走向）
- `agent` 服务的正式键名与 `steer` 的投递语义（B3）
- `editor.panel.item` 槽位的宿主与可用 props（B2）
- Client 与 Host 之间是否支持传函数（B1）
- 是否有官方的最小插件模板可以照抄（能省半天）

这几条建议直接问 DSH 团队或在官方文档/示例插件里搜，比逆向猜快得多。

---

## 12. 一句话总结交接内容

**设计已经想清楚了，代码一行没写。** 你接手后最重要的不是赶紧写 UI，而是花两天把 §6 的三个悬案验证掉——那三个答案决定数据流怎么写。规格书是可以照着写的，除了 draftMode（别做）和编译超时/并发（必须补）这两处。

有疑问优先看 `DEVELOPMENT_PLAN.md` 的风险登记表和 `AGENTS.md` 的不变式清单，这两处覆盖了 80% 的"为什么当初这么做"。
