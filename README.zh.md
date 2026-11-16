# dsh-latex-preview

**在 DSH（DeepSeek Harness）里写 LaTeX：改稿即出新 PDF，编译不过一键丢给 Agent 修，在 PDF 上指哪儿改哪儿。**

一个 Cordis 双半插件（Host = Node / Client = Web），把 Tectonic 编译、PDF.js 预览与 SyncTeX 双向定位装进右侧栏。

简体中文 · [English](README.md)

---

## 它解决什么

写 LaTeX 的循环通常是这样：改 `.tex` → 切终端按编译 → 等 → 翻 PDF 找报错那一行 → 回编辑器找对应源码。三次上下文切换，一次报错。

这个插件把这条链压进侧栏：

| 平时 | 出错时 | 想改某处时 |
|---|---|---|
| 保存即编译，PDF 原地刷新，滚动位置不动 | 诊断列表点一下跳到源码行 | 在 PDF 上选中/框选 → 一句话 → Agent 改源码 → 自动重编 |

编译、渲染、SyncTeX、diff **全部在本机完成**，只有你主动发送的错误上下文或选区锚点会进 Agent 会话。

## 功能

- **实时预览**：`chokidar` 监听 + 500 ms 防抖，保存即编译，PDF 原地刷新。
- **滚动保持**：刷新前后保留阅读位置——这条是刻意做的，不是附赠（`captureScrollState()` 必须在新 PDF 加载**之前**跑）。
- **编译失败不清空**：编译前把旧 PDF 备份为 `.pdf.prev`，失败即回滚。**一次编译失败永远不会让预览变白。**
- **SyncTeX 双向跳转**：PDF 双击 → 源码行；源码行 → PDF 位置。始终 shell 调用 `synctex` CLI，不手写解析 `.synctex`。
- **编译错误一键交给 Agent**：把「文件:行 + 错误 + 源码上下文」组成 prompt，投递到当前会话；Agent 改完 `.tex`，文件监听自动重编。
- **在 PDF 上指一处让 AI 改**：选中文字或在任意位置拖框 → 原地浮出输入栏 → 写一句要求 → Agent 拿到**源码行范围**去改。
- **改动审核三档**：`手动审核`（每步都要你点「接受」）、`自动审核`（派一个**独立的 AI** 审这次改动，不通过自动把源码回滚）、`完全放开`（不设闸门）。审核结果与理由显示在状态栏。
- **PDF 上的差异高亮（git diff 观感）**：`差异 N` 按钮 + 色带，直接标在这次编译改过的行上——绿=新增、琥珀=修改，色带左边缘是红绿 gutter；删除处画红色斜纹接缝 + `−N 行` 计数标签。**悬停接缝会弹出被删的源码行（红色删除线、等宽字体）**——被删的文字在新 PDF 里已无像素，这是不重排版时唯一能看到它的方式。点击钉在状态栏。对比的是**上一次编译**的版本，不是磁盘上的当前文件。
- **对比视图（latexdiff，可选）**：`对比` 按钮把「已接受版 + 当前版」交给 `latexdiff` 合成第三份文档再编译——删除的文字以红色删除线**真实排进版面**、新增的文字带颜色，与 git diff 同等可读。需要一次额外编译；要求系统有 `latexdiff`（MiKTeX 发行的 `latexdiff.exe` 在 Windows 上还要求 Perl，如 Strawberry Perl），缺失时按钮给出安装指引、面板不受影响。
- **脱敏开关**：开启后只发「消息 + 行号」，不带源码、不带选中文字。
- **诊断可点击**：错误/警告列表点条目即跳转到对应源码位置。

## 环境要求

| 依赖 | 说明 |
|---|---|
| DSH | `0.2.2-rc.1`（插件按此版本的 Typert / slots 契约实现） |
| Node.js | ≥ 20（开发用 22.x） |
| `tectonic` | **需自行安装并在 PATH 中**，启动时校验 |
| `synctex` | 随 TeX 发行版提供，**需在 PATH 中**，启动时校验 |

`tectonic` 官方二进制覆盖 win-x64 / macos-universal / linux-x64；arm64 需 `cargo install tectonic`。缺失时面板会直接告诉你缺哪个（`latex-preview/binary-missing`），不会静默失败。

## 安装

插件以「目录 + Cordis patch」方式挂载。把它放进工作区的 `node_modules`，再用 patch 声明加载：

```bash
# 1. 取得插件（或直接把本仓库放到位）
cd your-workspace
mkdir -p node_modules
ln -s /path/to/dsh-latex-preview node_modules/dsh-latex-preview   # Windows 用 mklink /D

# 2. 构建
cd node_modules/dsh-latex-preview
npm install
npm run build        # tsc + client bundle + assets

# 3. 写一个 patch
cd your-workspace
cat > latex-preview.yml <<'EOF'
- insert:
    - id: latex-preview
      name: dsh-latex-preview
EOF

# 4. 启动
npx dsh web --patch ./latex-preview.yml
```

启动后右侧栏出现 LaTeX 预览页签；工作区根目录的 `main.tex` 默认作为编译入口，也可在面板里改。

> `assets/` 与 `lib/` 是构建产物（已 gitignore）。`npm run build` 会把 PDF.js 运行时与查看器页面一起拷进 `assets/`（约 5 MiB）。

## 使用

### 面板

顶部是状态与操作区（编译状态与耗时、`编译`、`发送给 Agent`，二进制缺失时另有`重新检测`），中间是 PDF，底部是诊断列表。

| 操作 | 结果 |
|---|---|
| 保存 `.tex` | 防抖 500 ms 后自动编译 |
| 双击 PDF 某处 | 反查源码并跳转 |
| 点某条诊断 | 跳到对应源码行 |
| 「发送给 Agent」 | 把本次编译错误投递给当前会话（无错误时按钮禁用并说明原因） |
| 「差异 N」 | 开关高亮；title 说明共几处、是否有超出上限的未标注 |
| 悬停色带 | 显示改的是哪一行、改成了什么；悬停删除接缝/标签弹出**被删的源码行**（红色删除线） |
| 「对比」 | 生成并查看 latexdiff 对比版 PDF（删除文字真实排版、带删除线）；再点一次退回当前 PDF；需 `latexdiff`（Windows 的 MiKTeX 版需另装 Perl），缺失时给出指引 |
| 审核方式（下拉） | 手动 / 自动（独立 AI）/ 完全放开 |
| 「接受 N」 | 把这次改动记为已接受，清掉标记（仅手动档） |
| 「撤销」 | 把源码写回上一版并重编；需点两次确认 |

### 在 PDF 上指一处改一处

1. **选中文字**：直接拖选，选区下方浮出输入栏（文字层已开启）。
2. **框选区域**：在没有文字层的地方（公式、图、表格、页边）拖一个框，松手同样浮出输入栏。
3. 写一句要求（如「这句改成中文」「把这个公式化简」），回车发送。
4. Host 用 `synctex edit` 反查两个角点 → 取同文件内的行范围 → 读那几行源码 → 连同你的要求发给 Agent。
5. Agent 改 `.tex` → 文件监听重编 → PDF 原地刷新。

**关键设计：PDF 只当锚点，不当内容。** 真正给 Agent 的是**源码行**，不是从 PDF 抽出的文本——公式与连字抽出来常是乱码，源码永远干净。选中的字符串只作为「仅供参考」的附注。因此选中一个公式也不会让 Agent 瞎改。

## 隐私边界

编译、渲染、SyncTeX、diff **全在本机**。离开本机只有三种情况：

1. 你点「发送给 Agent」（或触发一次指哪改哪）——prompt 进入当前会话；
2. 同上，但开了脱敏——每次发送都会先说明；
3. **选了「自动审核」**且有改动编译成功：审核请求会把「已接受版本 ↔ 当前版本」的 diff 发给该会话配置的 provider/model。手动审核与完全放开不发。

脱敏（`redact`，默认关闭）开启后，只发送「消息 + 行号」，不带源码行、不带选中文字。

## 已知限制

- **反查精度到行，不到字符。** SyncTeX 返回的是盒子到行的映射，`Column` 常为 `-1`。选一个词得到的是它所在的行（可能多行）。
- **扫描版 PDF 无文字层**，框选可能定位失败。本插件的 PDF 都是 Tectonic 现编的，一定有文字层。
- **跨页选区**只按当前页那一段反查。
- **删除的行不重排版**：新 PDF 里那几行已经没有空间，所以叠加层只画接缝 + `−N 行` 标签，**悬停弹出被删的源码行**（红色删除线，最多 8 行、每行截断 200 字）；要看删除文字的**真实排版**，用「对比」（latexdiff 重排一版，需要 latexdiff，Windows 的 MiKTeX 版还要求系统装有 Perl）。
- **高亮有上限**：每版最多 24 处改动、40 行解析；更长的块用均匀采样而不是截断，超出部分在按钮 title 里说明。
- **自动审核会消耗模型调用**，且 AI 可能判断错。它只在你开了 `自动审核` 时运行，超时 25 秒或读不到模型时**转手动**，不会默认放行。
- **撤销 / 审核否决会写源文件**（回滚到上一版并重编），这是插件唯一的破坏性动作，所以按钮需要二次确认。
- 一次指哪改哪最多附带 **12 行**源码（`MAX_EDIT_LINES`），避免框住整页时把整页塞进 prompt。
- 首次编译可能要下载 TeX 宏包，超时放宽到 5 分钟（后续 2 分钟）。

## 架构

```
src/
  index.ts                       Host 入口，注册服务
  services/
    latex-preview-service.ts     Typert Remote 服务（13 个 @Remote 方法）
    compile.ts                   Tectonic 调用 + 产物回滚
    watcher.ts                   chokidar + 防抖
    diff.ts                      行级 diff
    diff-regions.ts              hunks → PDF 色带/接缝坐标（含被删行文本）
    diffdoc.ts                   latexdiff 对比文档（可选能力）
    reviewer.ts                  改动审核（manual / auto / open）
    agent-bridge.ts              prompt 组装 + agent.steer 投递
    http-api.ts                  同源 JSON 路由 /.latex-preview/api/*
    static-route.ts              /assets 静态挂载
  utils/                         binaries / root / log-parser / synctex / assets
  client/                        panel.tsx / pdf-viewer.ts / api.ts / index.tsx
viewer/                          PDF.js 查看器页面（选区、框选、浮条、差异层）
```

两条必须知道的约束：

- **Host↔Client 传不了回调**。客户端轮询 `getState()`，靠 `version` 计数器判断是否变化——版本没变就什么都不做，不重渲染、不重载 iframe。
- **面板走 HTTP 路由，那条链路上没有 Agent driver**，所以 `currentInitiator()` 恒为空。面板改为从侧栏的 `data-sidebar-right-session` 读出会话 id，Host 用 `agents.get(id)` 解析出 live Agent。

面板可用的 HTTP 接口（`POST`，除 `state` 为 `GET`）：`state` `configure` `compile` `diff` `diff-regions` `diff-doc` `accept` `revert` `jump-to-pdf` `jump-to-source` `send-error` `edit-at` `binaries`。

## 开发

```bash
npm run typecheck    # tsc --noEmit
npm run verify       # 契约探针（5 pass / 0 fail / 2 skip）
npm run build        # tsc + client bundle + assets
npm run assets       # 只重建 PDF.js 运行时与查看器页面
npm run binaries     # 检查 tectonic / synctex
```

> 本机 `pnpm run` 不可用，请用 `npm run` 或 `npx`。

改代码前请先读 [`docs/spikes.md`](docs/spikes.md)：那里是逐条实测读出来的契约证据（PDF.js 坐标换算、slots 注册、`createUserMessage` 的真实签名等），能省掉大半试错。其余文档：

| 文件 | 内容 |
|---|---|
| [`docs/spikes.md`](docs/spikes.md) | 已验证的契约与踩坑记录（B1–B18） |
| [`docs/HANDOFF.md`](docs/HANDOFF.md) | 状态、决策、未决问题 |
| [`docs/DEVELOPMENT_PLAN.md`](docs/DEVELOPMENT_PLAN.md) | 任务分解、验收门、风险登记 |
| [`docs/LaTeX Preview — 开发文档.md`](docs/LaTeX%20Preview%20—%20开发文档.md) | 架构与 API 契约规格书 |
| [`AGENTS.md`](AGENTS.md) | 仓库级不变式速查 |
| [`CHANGELOG.md`](CHANGELOG.md) | 每个尚未发布的变更改了什么、修了什么 |

## License

[MIT](LICENSE) © 2026 Tianshang301
