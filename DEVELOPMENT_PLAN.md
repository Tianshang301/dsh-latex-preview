# dsh-latex-preview 开发计划

> 依据：`LaTeX Preview — 开发文档.md`（下称"规格书"）。
> 本文档只做三件事：**把规格书拆成可执行任务**、**把必须先验证的不确定性提前**、**给出每阶段的验收门**。

---

## 0. 现状判断

| 项 | 状态 |
|---|---|
| 规格书 | 完整可执行（架构、API 契约、模块伪代码、坑点、测试策略齐全） |
| 代码 | 零。无 `package.json`、无 git 仓库、无 `src/` |
| 二进制依赖 | `tectonic` / `synctex` 由用户环境提供，需开工首日检测 |
| 最大不确定性 | 不在 LaTeX 侧，而在 **DSH 宿主 API 的实际行为**（见 §1） |

结论：**第 1 周不要急着写 PDF 面板，先把 6 个宿主侧悬案验证掉**。规格书 §10 自己也承认 "PDF.js DOM 选择器与跨域坐标回传" 需实机验证；但实际上风险更高的还有 3 个它标为"已核验"的点，我在 §1 里单列了。

---

## 1. 开工前必须敲定的 6 个技术悬案（Blockers）

按风险从高到低。**每项给出验证方法 + 兜底方案，B1/B2/B3 必须在 Day 1–2 出结论**，否则后面 4 周的排期都是猜的。

### B1 · Host → Client 的事件通道能否传函数？（最高风险）

规格书 §2.1 写的是：

```typescript
// Client 半
api.onCompiled((result) => { ... })   // 把一个回调函数传给 Host 服务
```

如果 DSH 的 Host/Client 之间是**序列化 RPC**（Cordis 双半的常见实现），函数无法跨进程传递，这行代码在真机上会直接失效——而它是整个"文件变更 → PDF 刷新"链路的第一环。

- **验证**：写 20 行探针，Client 调 `ctx.latexPreview.onCompiled(cb)`，Host 侧 `cb('ping')`，看浏览器控制台是否收到。
- **兜底 A（首选）**：改成事件总线。Host `ctx.emit('latex-preview:compiled', payload)`，Client `ctx.on('latex-preview:compiled', handler)`。Cordis 事件本身是跨半的。
- **兜底 B**：Client 轮询 `api.getState()`（带 `version` 自增号），500ms 一次，代价是延迟与空转。
- **影响面**：`latex-preview-service.ts` 全部对外方法签名 + client `index.tsx` 数据流。

### B2 · 源码编辑器是 DSH 自带，还是我们要自己塞 CodeMirror？

规格书把 CodeMirror 6 列进技术栈（§1），但同时把面板注册到 `editor.panel.item`（§2.1）——这个槽位名暗示**面板是挂在 DSH 自己的编辑器面板里的**。两者矛盾。

- 若 DSH 自带编辑器：CodeMirror 整套工作（约 3–5 天）是冗余的，我们只需要「读当前行 / 滚动到指定行 / 画行级 diff 标记」的桥接 API。
- 若不自带：才需要自建编辑器，且 P1 的 diff 高亮成本上升。
- **验证**：查 DSH UI/槽位文档 + 在宿主里打印 `ctx.slots` 已有 key 列表，看 `editor.panel.item` 的宿主是谁。
- **兜底**：无编辑器 API 时，diff 高亮降级为独立面板（源码只读 + 行号），点击仅定位不编辑。
- **影响面**：P1 工作量 ±3–5 天，`src/client/diff-panel.tsx` 与 `synctex-bridge.ts` 的形态。

### B3 · `agent.steer()` 从哪拿 agent 实例？

规格书 §3.5 直接 `sendErrorToAgent(agent, ...)`，但没写 `agent` 怎么来的。这是"错误回传"这条差异化功能的唯一入口，拿不到就等于功能不存在。

- **验证**：在 Host 侧 `ctx.inject(['agent'], ...)` 探测服务名；同时看 `createUserMessage` 的签名与 `steer` 的接收方约定（当前会话？指定 sessionId？）。
- **兜底**：若没有公开 steer，退回 DSH 的公开输入通道（等价于用户手动发一条消息），并接受"不打断当前流"的体验损失。
- **影响面**：`src/services/agent-bridge.ts`，以及 P0 的验收标准。

### B4 · draftMode 与 SyncTeX 天然冲突 —— 建议 MVP 直接不做

规格书 §3.1 说 draftMode 是"编译前源码预处理，向 `\documentclass` 后注入 draft 选项"。但注入必然要落到某个 `.tex` 文件上：

- 改用户源文件 → 不可接受（污染稿件、污染 git）。
- 编译临时副本 → `.synctex.gz` 里记录的是临时路径，**反向跳转（PDF→源码）全部失效**，且 `synctex edit` 返回的路径对不上。

- **决策建议**：MVP **不实现** draftMode。规格书 §5 的 P0/P0+ 验收标准里也没有它。留到 P2 之后作为"快速预览模式"单独设计（可用 `\includeonly` 或独立 outdir 副本 + 单独一套 synctex 映射）。
- 这条要在计划里显式"不做"，否则开发到 P1 会被它绊住。

### B5 · 编译超时与并发：规格书的 `compile.ts` 缺这两块

伪代码里 `spawnTectonic` 无超时、无并发控制。Tectonic 首次编译要下载 bundle，可能几分钟；用户连续保存会叠多个编译进程抢 `outDir`，`.prev` 备份/回滚会互相踩。

- **补设计**：`timeout`（常规 120s / 首次 300s，超时 kill 并触发回滚）+ **single-flight**（正在编译时新事件只置一个 pending 标记，结束后再跑一轮，不排队）。
- 影响 `compile.ts` 的状态机，属于 P0 必做项。

### B6 · pdfjs-dist viewer 资产与静态路由

`viewer.html` 不是单文件，需要 `build/` 下的 `pdf.worker`、`cmaps/`、`standard_fonts/`、locale 一起可访问。

- **验证**：本地起静态服务跑通 `viewer.html?file=/x.pdf`，确认 worker 路径与同源。
- **注意**：规格书要求"插件静态路由与 Web UI 同域"（坑 12）。若 `webServer.register` 只支持挂到别的 origin，滚动恢复整条链路要改走 postMessage，成本上升 1–2 天。

---

## 2. 任务分解（WBS）

命名 `Tn.m`，`P` 前缀为阶段。预估按"单人全职、熟悉 TS/Cordis"计。

### 阶段 0 · 探针（Day 1–2，约 2 人日）

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| T0.1 | 仓库初始化：git、`package.json`（ESM + `dsh` 字段）、`tsconfig.json`、`cordis.patch.yml`、LICENSE(MIT) | 可 `pnpm build` 的空壳 | — | 空插件能被 DSH 加载不报错 |
| T0.2 | 双半构建管线：Host 出 ESM 到 `lib/`，Client 出**懒加载 CJS**（顶层唯一语句是 loader 调用） | `lib/index.js` + `lib/client.js` | T0.1 | 检查 `lib/client.js` 首行结构符合规格书 §4 |
| T0.3 | **契约探针 `pnpm verify`**：`ctx.plugin(Service)`、`ctx.inject`、`ctx.slots.inject/register`、`createUserMessage`、`agent.steer` 五连冒烟 + 打印 DSH 版本 | `test/contract/`、npm script | T0.1 | 五连全绿，输出实际 API 形态 |
| T0.4 | **二进制检测**：`tectonic --version` / `synctex --version`，缺失时返回结构化错误 + 安装引导文案 | `src/utils/binaries.ts` | T0.3 | 两个都缺、缺一个、都在 —— 三种场景都有可读提示 |

> **Day 2 结束的硬性判决**：B1/B2/B3 必须有结论并记录到 `docs/spikes.md`。没有结论就停在这里找 DSH 文档/问人，不要开始写面板。

### 阶段 P0 · 双核最小闭环（Week 1–2，约 8 人日）

| ID | 任务 | 产出 | 依赖 | 验收 |
|---|---|---|---|---|
| P0.1 | `watcher.ts`：chokidar 3.x 监听 `.tex/.bib/.sty/.cls`，防抖 400–600ms，忽略 `outDir` 与 `*.pdf*` | 文件变更事件 | T0.3 | 保存 10 次只触发 1–2 次编译 |
| P0.2 | `compile.ts`：spawn + 超时 + single-flight + `.prev` 备份/回滚（含 B5 设计） | 编译服务 | P0.1 | 失败回滚后 PDF 仍在；成功删 `.prev` |
| P0.3 | 根文件解析：`% !TEX root` → `\documentclass` 扫描 → 未确定时拒绝编译并提示选择 | `src/utils/root.ts` | P0.2 | 多根目录下正确选中主文件 |
| P0.4 | 静态路由：`ctx.inject(['webServer'], ...)` 注册 `/.latex-preview/*` → `outDir` + `assets/pdfjs/`，disposer 走 `ctx.effect` | `src/services/static-route.ts` | T0.3 | 浏览器可直接打开 PDF URL，同源 |
| P0.5 | Client 面板骨架：`export const inject = ['latexPreview']` + `slots.inject(...)`（**不包 ctx.effect**） | `src/client/index.tsx` | B1、B2 | 面板出现在编辑器侧栏，卸载插件后干净消失 |
| P0.6 | `pdf-viewer.ts` 适配层 + iframe viewer.html（先不做滚动保持） | 预览可用 | P0.4、P0.5、B6 | 改 tex → PDF 刷新，手动滚动正常 |
| P0.7 | `error-parser.ts`：error（`!`+`l.N`）与 warning 双级解析 | 结构化错误 | — | 单元测试 ≥5 样本通过 |
| P0.8 | `agent-bridge.ts` 最小版：`buildErrorPrompt` + 一键发送（含脱敏分支，先不加提示 UI） | 错误→Agent 通路 | P0.7、B3 | 注入 `\undefined` → 点"发送给 Agent" → 会话里出现消息 → AI 回写 → PDF 刷新 |

**P0 门（Week 2 末）**：规格书 §5 原话"改 .tex → PDF 刷新；AI 写错 → 点修复 → Agent 收到并回写 → PDF 刷新"。**这条不通过就不进 Week 3。**

### 阶段 P0+ · 体验补完（Week 3，约 5 人日）

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| P0+.1 | 滚动保持：`captureScrollState()` 在加载新 PDF **之前**调用；`restoreScrollState()` 用 `Math.min` 钳制页码 | P0.6 | 删掉文档后 5 页 → PDF 不跳首页、不跳末页；page 一致、ratio 误差 <5% |
| P0+.2 | 产物回滚加固：原子 rename、首次编译失败单独提示、"保留最近 3 次成功编译中间产物"、`清理缓存` 按钮 | P0.2 | 规格书 §8 对应三条打勾 |
| P0+.3 | 完整错误面板：warning 可折叠、点击跳源码（依赖 B2 结论）、严重度配色 | P0.7 | warning 与 error 分区展示 |
| P0+.4 | 隐私合规 UI：首次启用弹窗（内容将离开本机）+ "发送给 Agent"按钮旁常驻提示 + 脱敏开关默认关 | P0.8 | 脱敏开 → prompt 中不含源码上下文 |
| P0+.5 | 首编 bundle 下载进度提示（Tectonic 首次会拉依赖） | P0.2 | 进度条/日志输出可见 |
| P0+.6 | 错误样本回归集：`test/fixtures/errors/` 收集 ≥10 个真实 `.log` | P0.7 | 规格书 §8 清单项 |

**P0+ 门**：滚动保持 + 产物回滚。规格书明确 **"底线，任何情况不砍"**。

### 阶段 P1 · 双向跳转 + diff（Week 4，约 6 人日）

| ID | 任务 | 依赖 | 验收 |
|---|---|---|---|
| P1.1 | `synctex.ts`：`synctexView` / `synctexEdit` + `parseView` / `parseEdit`（一律走 CLI，不手写解析器） | P0.2 | 固定字符串输出单测 100% |
| P1.2 | **坐标换算实机标定**：`pdfPointFromClick`（y 翻转 + `72/96` + `pageScale` + `pagePaddingTop`） | P1.1、P0.6 | 滚动 3 屏后双击，偏差 <1 行；三种 zoom 下都准 |
| P1.3 | 正向跳转：源码行 → PDF 页 + 高亮 overlay | P1.1、P1.2 | 点击 20 个不同位置，命中率 >90% |
| P1.4 | 反向跳转：PDF 双击 → `synctex edit` → 源码行 | 同上 | 同上 |
| P1.5 | `diff.ts`：`lineDiff` + `startLine/endLine` + LaTeX 规范化（去注释、并空格、规范转义） | — | 与人工核对一致 |
| P1.6 | diff 面板高亮 + 点击定位；无 PDF 映射时降级为"仅高亮源码 + 状态栏提示" | P1.5、B2 | 规格书 §3.3 降级路径可演示 |

**P1 门**：规格书 §5 —— 源码点击跳 PDF、PDF 双击跳源码、滚动 3 屏后坐标不漂移。

### 阶段 P2 · 批注闭环（Week 5，约 4 人日）— **第一个可砍项**

| ID | 任务 | 依赖 |
|---|---|---|
| P2.1 | PDF.js text layer 取选中文本 + 位置 | P1.1 |
| P2.2 | `synctexEdit` 反查源码行 → 结构化 prompt | P2.1 |
| P2.3 | 圈选 UI + 发送（复用 P0+.4 的隐私提示） | P2.2 |

**P2 门**：圈选"改简洁" → AI 改写 → diff 高亮。

### 阶段 P3 · 打磨上架（Week 6，约 4 人日）

README（隐私边界 + 平台矩阵 + 已知限制 + 30s 动图）、i18n 中英文案（无硬编码中文）、npm 发布、提交 DSH Workshop 索引、Playwright E2E（可选）。

**P3 门**：规格书 §8 自查清单全绿。

---

## 3. 周历（默认 6 周，可压到 4 周）

| 周 | 主线 | 出口 |
|---|---|---|
| W1 | 探针 + 脚手架 + watcher/compile/静态路由 | 能编译、能加载 PDF |
| W2 | 面板 + 数据流 + 错误回传 | **P0 闭环跑通** |
| W3 | 滚动保持 + 错误面板 + 合规 UI | P0+ 完成（可对外演示） |
| W4 | SyncTeX 双向 + diff | P1 完成 |
| W5 | 批注 | P2 完成（可砍） |
| W6 | README/i18n/发布 | 上架 |

**压缩到 4 周的办法**：砍 P2（批注）+ P3 的 Playwright + i18n 只做中文。**W1 的探针不压缩**——那是唯一能毁掉整个排期的环节。

---

## 4. 风险登记表

| # | 风险 | 概率 | 影响 | 应对 |
|---|---|---|---|---|
| R1 | 回调无法跨 Host/Client（B1） | 中 | 高（数据流重写 1–2 天） | 事件总线兜底，Day 2 定案 |
| R2 | DSH 编辑器无行级 API（B2） | 中 | 中（P1 降级） | diff 走独立面板，P1 验收标准相应下调 |
| R3 | `agent.steer` 不可公开调用（B3） | 中 | 高（差异化功能失效） | 退回公开输入通道，README 如实说明 |
| R4 | iframe 跨域导致滚动恢复失效（坑 12/B6） | 低 | 中（+1–2 天） | 全链路改 postMessage |
| R5 | Tectonic 首编下载慢/被墙 | 中 | 低 | 预下载提示 + 离线缓存模式 |
| R6 | DSH preview API 破坏性变更（坑 7） | 中 | 中 | 精确锁版本 + `pnpm verify` 每周跑 |
| R7 | SyncTeX 在深 `\input` 链下漂移（§3.4） | 高 | 低 | README 已知限制；不做补救 |
| R8 | pdfLaTeX 专属宏包不兼容（坑 2） | 中 | 低 | README 说明 + latexmk 降级链（P3 之后） |

---

## 5. 明确"不做"清单

- **draftMode**（B4 冲突，MVP 不做）
- **增量渲染**（规格书 §3.2：P95 >5s 才做）
- **`tectonic -X watch`**（坑 1，永远不用）
- **手写 `.synctex` 解析器**（坑 6，明令禁止）
- **PDF 二进制走 postMessage**（一律走同源静态 URL）

---

## 6. 质量门（每阶段必跑）

1. `pnpm build` 无 TS 错误；`lib/client.js` 结构断言（顶层单一 loader 语句）
2. `pnpm verify` 契约五连绿
3. 单元：`parseLatexLog` / `parseView` / `parseEdit` / `lineDiff` / `pdfPointFromClick`
4. 手工冒烟：改 tex → 刷新；接线错 → 错误 → 发 Agent；删页 → 不跳首页
5. `ctx.effect` 全覆盖检查：每条路由/定时器/监听器都有 disposer（热重载两次，看有无重复面板/重复编译）

---

## 7. 现在就能做的三件事

1. 检测本机 `tectonic` / `synctex`：`tectonic --version && synctex --version`
2. 落地 T0.1 脚手架（`package.json` + `tsconfig` + `cordis.patch.yml`）
3. 写 T0.3 契约探针，一次性把 B1/B2/B3 打出来

---

## 附：对规格书的两处订正

1. **`AGENTS.md` 说规格书是 GBK/CP936 编码 —— 实际是 UTF-8**（首字节 `E5 BC 80`，正常解码无乱码）。后续不必再做转码。
2. **`compile.ts` 缺超时与并发控制**（B5），已在 P0.2 补入。
