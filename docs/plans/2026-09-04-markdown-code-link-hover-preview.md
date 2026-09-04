# Markdown 仓库代码链接悬浮预览、锁定与拖拽实施方案

- **日期**：2026-09-04
- **状态**：Reviewed / 可进入实现（含资源约束与功能开关）
- **首期范围**：文件管理器中的 Markdown 渲染预览
- **相关模块**：`MarkdownPreview.vue`、`useFilePathAnnotation.ts`、`highlight.ts`、`BottomSheet.vue`、`useSettingsConfig.ts`、`settingsFieldMap.ts`

---

## 一、评审结论

方案方向可行，但原草案有几处会在实现时造成返工，现已收敛为可直接开发的版本：

| 原方案问题 | 影响 | 本方案决策 |
| :--- | :--- | :--- |
| 只修改 `parseFileUri()` 的冒号正则 | 纯文本、行内代码和 Markdown 链接走不同解析分支，`:L10-L20` 仍可能漏标 | 同步修改 URI、纯文本、`<code>`、路径检测四条解析链，并补回归测试 |
| 使用 `mouseenter`/`mouseleave` 代理 | 两者不冒泡，挂在 `.markdown-body` 上无法可靠代理 `v-html` 内节点 | 使用 `mouseover`/`mouseout` + `relatedTarget`，卡片自身单独监听进入/离开 |
| “单击预览、双击打开”与现有点击打开冲突 | 首次点击已经调用 `openFilePath()`，双击无法成立，也会改变桌面端习惯 | 桌面保留单击打开，悬停预览；触屏点击路径文本预览，旁边的打开按钮仍直接打开 |
| 按行拆分 `highlight.js` 输出 | 多行注释、字符串的 `<span>` 可能跨行，直接 `split('\n')` 会破坏 HTML 和着色 | 高亮后的代码保持单个 `<pre><code>`，行号和目标行背景作为独立覆盖层渲染 |
| `window.innerWidth` 直接用于 fixed 定位 | 项目支持全局 CSS zoom，拖拽位置和边界会偏移 | 复用 `getZoomedViewport()` 与 `toFixedCSS()`，并在 resize/缩放后重新夹取位置 |
| “最多 2 个窗口”未定 | 状态、层级、拖拽、缓存和移动端行为均无法验收 | 首期明确为单实例；已锁定时普通 hover 不替换，快捷锁定新目标时才替换 |
| “大于 2MB 只解析前 5000 行”不可保证目标行可见 | 现有接口已经传回整个文件，且目标行可能在 5000 行以后 | 复用现有 10MB 上限接口，仅高亮最多 200 行；大文件不进入缓存，不伪装成范围读取 |
| 只限制行数和缓存大小 | 超长单行仍可能占用数 MB 并阻塞高亮；2–10MiB 文件成功时用户也不知道预览成本 | 增加渲染字节/单行上限、大文件提示、截断原因和资源验收；另提供本地开关让用户关闭悬停读取 |

首期不新增后端接口。现有 `GET /api/file/{encodedRelativePath}` 与 `GET /api/file?path={encodedAbsolutePath}` 已具备项目根目录、外部授权根目录、二进制识别和 10MB 限制，可直接复用。

---

## 二、背景与目标

Markdown 技术文档中经常出现仓库代码位置，例如：

- `web/src/stores/app.ts:L431-L446`
- `internal/service/scheduler.go:120-150`
- `[类型定义](packages/agent/src/types.ts#L431-L446)`
- `internal/handler/file.go`

用户通常只需要快速确认局部实现，不应被迫离开当前阅读位置。

### 目标

1. 开启开关后，桌面端悬停代码路径即可查看带真实行号、语法高亮和上下文的代码片段。
2. 瞬态预览可钉住，并在视口内拖拽；滚动 Markdown 时保持固定。
3. 触屏设备通过底部抽屉完成同等的查看、复制和打开操作。
4. 保留现有“打开完整文件并定位行号”能力，不破坏桌面端单击行为。
5. 对请求竞态、缓存陈旧、超大文件、二进制、目录和失效路径给出明确反馈。
6. 提供可持久化的本地开关，让用户可以关闭悬停预览带来的额外读取和内存开销。

### 非目标

- 首期不支持同时钉住多个窗口、窗口缩放或跨会话持久化位置。
- 不在聊天消息、分享页、导出的静态 HTML 中启用；后续可复用控制器扩展。
- 不在预览中编辑、执行代码或展示 Git blame/diff。
- 不为超大文件新增后端按行读取接口；若实际性能数据表明有需要，再单独立项。

### 功能开关（默认关闭）

由于桌面悬停可能触发一次完整的文件 GET（当前后端上限为 10MiB），首期采用本地 opt-in 开关，避免升级后在用户无感知的情况下增加磁盘读取、网络传输和浏览器内存占用。

- **设置 key**：`markdownCodeLinkPreview`，类型 `boolean`，默认值 `false`。
- **设置位置**：设置 → 项目与文件 → 文件显示，使用现有 `SettingsItem` 的 `switch` 类型。
- **持久化范围**：通过 `useSettingsConfig().setLocalConfig()` 写入现有带前缀的 `localStorage`；不写入服务端，不需要重启，不跨用户/设备同步。
- **生效范围**：仅文件管理器的 Markdown `rendered` 模式；聊天消息、分享页、导出 HTML 和源码/raw 模式不受影响。
- **关闭时行为**：不注册 hover/focus/touch 预览代理，不挂载 `CodeLinkPreview`；已有预览立即关闭，abort 当前请求，清理 pending/bridge timer、rAF、`ResizeObserver`、窗口监听和拖拽 body class，并清空模块级预览缓存。现有 Markdown 链接单击、相邻打开按钮和目录跳转行为保持不变。
- **重新开启时行为**：只对之后的新 hover/focus/tap 生效，不自动恢复刚刚关闭的目标；首次交互仍遵守 250ms 延迟和路径类型校验。
- **资源语义**：关闭开关只保证前端不再主动发起新的预览请求；已经到达后端的请求可能仍完成读盘/编码，不能承诺服务端立即停止。

具体实现：

1. 在 `useSettingsConfig.ts` 的 `localDefaults` 增加 `markdownCodeLinkPreview: false`。
2. 在 `settingsFieldMap.ts` 的 `projectFiles` / `fileDisplaySection` 增加一个 local `switch` 条目，并在 `zh.ts`、`en.ts` 增加 label/description。
3. `useCodeLinkPreview()` 通过 `computed(() => !!localConfig.markdownCodeLinkPreview)` 暴露 `enabled`；所有入口（代理事件、快捷键、触屏点击、请求函数）都必须先检查 `enabled`。
4. `MarkdownPreview.vue` 只在 `enabled && viewMode === 'rendered'` 时挂载预览组件并绑定预览相关的 hover/focus/touch 委托；现有 `handleClick` 的打开逻辑始终保留，并在开关变为 `false` 时调用 composable 的 `close({ clearCache: true })`。
5. 开关切换、默认关闭、关闭时取消请求和清空缓存均需有组件/composable 测试；设置页测试需验证刷新页面后从 `localStorage` 恢复。

设置定义示例：

```ts
// useSettingsConfig.ts
markdownCodeLinkPreview: false,

// settingsFieldMap.ts → categoryItems.projectFiles
{ type: 'item', spec: {
  labelKey: 'settings.items.markdownCodeLinkPreview',
  descriptionKey: 'settings.items.markdownCodeLinkPreviewDesc',
  key: 'markdownCodeLinkPreview', type: 'switch', source: 'local',
  sectionHeader: 'settings.items.fileDisplaySection',
} },
```

控制器监听示例：

```ts
const enabled = computed(() => localConfig.markdownCodeLinkPreview === true)
watch(enabled, (on) => {
  if (!on) close({ clearCache: true })
})
```

推荐文案：

- 中文：`Markdown 代码链接悬停预览`；`桌面悬停或触屏点击 Markdown 中的代码路径时显示局部预览，可能增加文件读取和内存占用`。
- English: `Markdown code-link hover preview`; `Show a local preview when hovering on desktop or tapping on touch devices; this may increase file I/O and memory usage`.

---

## 三、适用对象与解析规则

### 3.1 可预览对象

仅处理 Markdown 渲染结果中的：

```css
.chat-file-path[data-file-path],
.chat-file-open-btn[data-file-path]
```

约束如下：

- `data-path-type="file"`：允许预览。
- `data-path-type="dir"`：不预览，保留原目录跳转能力。
- 尚未完成异步校验的节点先不发内容 GET，待 `data-path-type=file` 后再读取；后端返回 `NotAFile`、`FileNotFoundShort`/`FileNotFound` 或 `AccessDenied` 时不显示代码正文。
- 被 `verifyFilePaths()` 判定不存在并移除标注的节点不再触发。
- 外部绝对路径仍受后端 `rootPaths` 授权边界控制，前端不绕过现有校验。

`verifyFilePaths()` 在保留标注时，应给路径文本和相邻打开按钮同步写入 `data-path-type="file|dir"`；发生 fallback path 替换后也要更新该属性。

### 3.2 行号格式

统一支持：

- Hash：`#L10`、`#L10-L20`、`#10`、`#10-20`
- 冒号：`:10`、`:10-20`、`:L10`、`:L10-L20`、`:L10-20`
- Windows：`C:\repo\src\main.go:L10-L20`

需要同时修改以下位置，不能只改 `parseFileUri()`：

1. `parseFileUri()` 的冒号后缀解析；
2. `FILE_PATH_RE` 的可选行号后缀；
3. `extractLineInfo()` 的后缀剥离；
4. `extractLineInfoFromText()`；
5. `looksLikeFilePath()` 中用于判断裸路径的后缀剥离。

核心冒号格式统一为：

```ts
/:L?(\d+)(?:-L?(\d+))?$/i
```

行号必须为正整数。`lineEnd` 缺省时按单行目标处理；`lineEnd < lineStart` 时按单行 `lineStart` 处理，不静默交换用户输入。

---

## 四、交互规格

### 4.1 交互矩阵

| 环境 / 操作 | 路径文本 | 相邻打开按钮 | 预览内操作 |
| :--- | :--- | :--- | :--- |
| 桌面鼠标悬停 | 250ms 后显示瞬态预览 | 同样显示瞬态预览 | 指针进入卡片时保持；离开目标和卡片 200ms 后关闭 |
| 桌面普通单击 | Markdown `<a>` 保持现有打开行为；`code/span` 保持无动作 | 保持现有打开完整文件（超大文件进入详情/下载页） | 打开按钮调用 `openFilePath()` 并关闭预览 |
| 桌面 `Ctrl/Cmd + 单击` | 直接以锁定状态预览，不打开完整文件 | 同左 | 若已有锁定窗口则替换为新目标 |
| 键盘聚焦 | 原生可聚焦的 `<a>` 立即显示瞬态预览 | 按钮聚焦时立即显示瞬态预览 | `F2` 进入操作区；`Escape` 关闭并把焦点还给来源；Pin 使用 `aria-pressed` |
| 触屏单击 | 阻止链接默认打开，显示 BottomSheet | 始终打开完整文件 | 抽屉常驻至关闭，无 Pin 和拖拽按钮 |

触屏判断使用能力媒体查询 `(hover: none), (pointer: coarse)`，不只依赖屏幕宽度或 `isPC`。

行内 `code/span` 不额外添加 `tabindex`，避免路径文本和紧随其后的打开按钮形成重复 Tab 停靠点；键盘用户通过 Markdown 原生链接或相邻打开按钮触发预览。

当 `markdownCodeLinkPreview=false` 时，以上悬停、聚焦快捷预览和触屏 BottomSheet 入口全部关闭；原有 Markdown 链接、文件打开按钮、目录跳转和双击复制行为保持原样。

### 4.2 单实例规则

- 屏幕上最多存在一个预览实例。
- 瞬态状态下悬停新目标，取消旧请求并切换内容。
- 锁定状态下普通 hover 被忽略，避免阅读内容被意外替换。
- 锁定状态下 `Ctrl/Cmd + 单击` 新目标，原地替换并保持锁定。
- 从瞬态卡片开始拖拽时自动升格为锁定。
- 解除锁定后，如果指针和焦点都不在目标或卡片内，200ms 后关闭。
- Markdown 文件切换、退出 rendered 模式或组件卸载时，无条件关闭并中止请求。

### 4.3 状态机

```text
hidden
  ├─ hover/focus ───────────────► pending
  │                                ├─ 250ms 到期 ─► transient-loading
  │                                └─ 提前离开 ───► hidden
  ├─ Ctrl/Cmd+click ────────────► pinned-loading
  └─ touch tap ─────────────────► sheet-loading

transient-loading/ready/error
  ├─ pin 或 drag start ─────────► pinned-*
  ├─ 切换未锁定目标 ─────────────► transient-loading（请求代次 +1）
  └─ target/card 均离开 200ms ──► hidden

pinned-loading/ready/error
  ├─ 普通 hover ────────────────► 保持不变
  ├─ Ctrl/Cmd+click 新目标 ─────► pinned-loading
  ├─ unpin ─────────────────────► transient-*
  └─ close / Escape / full open ► hidden

sheet-loading/ready/error
  └─ close / backdrop / full open / 系统返回 ► hidden
```

每次目标变化递增 `requestId` 并 abort 前一个 `AbortController`。只有当前 `requestId` 的响应可以写入 UI，杜绝快速划过多个链接后显示旧文件。

---

## 五、代码片段与高亮规则

### 5.1 展示范围

定义：

```ts
const DEFAULT_CONTEXT = 3
const DEFAULT_NO_RANGE_LINES = 30
const MAX_RENDER_LINES = 200
const MAX_RENDER_BYTES = 512 * 1024
const MAX_LINE_BYTES = 128 * 1024
```

- 有目标行：默认展示 `[lineStart - 3, lineEnd + 3]`，夹取到文件实际范围。
- 无目标行：展示文件前 30 行，不设置目标行高亮。
- `lineStart` 超过文件总行数：展示文件末尾最多 30 行，并显示“请求行号超出文件范围”。
- 目标范围自身超过 200 行：仅展示从目标起点开始的前 200 行，并显示截断提示；打开完整文件仍携带原始行范围。
- `+5`：目标范围上下各增加 5 行；无范围时向下增加 10 行。
- `−5`：回退一档，但不小于默认上下文或默认 30 行。
- 所有范围最终同时受 `MAX_RENDER_LINES`、`MAX_RENDER_BYTES` 限制；单个物理行另外受 `MAX_LINE_BYTES` 限制，先达到任一上限即停止渲染。
- 使用真实物理行号；兼容 LF、CRLF 和文件末尾空行。

`sliceCodeForPreview()` 必须返回 `renderTruncated` 及原因（`lines`、`bytes` 或 `line`），这样用户能区分“目标范围很大”和“内容本身过长”。这些上限只限制切片、高亮和 DOM，不限制当前复用 GET 已经传输的完整文件。

复制按钮复制“当前展示的原始代码文本”，不包含行号、提示文本和 HTML。

### 5.2 高亮结构

复用：

```ts
highlightCode(codeSlice, getFileType(filePath).lang || 'plaintext')
```

为避免破坏跨行 token，禁止把 `highlightedHtml` 按换行拆成多个 `v-html` 节点。建议 DOM 结构：

```html
<div class="code-preview-scroll">
  <div class="code-preview-gutter"><!-- 真实行号 --></div>
  <div class="code-preview-code-pane">
    <div class="code-preview-line-backgrounds"><!-- 目标行背景 --></div>
    <pre><code class="hljs" v-html="highlightedHtml" /></pre>
  </div>
</div>
```

约束：

- gutter、背景层和 `<pre>` 使用相同固定 `line-height`；默认不换行，横向滚动。
- gutter 可 `position: sticky; left: 0`，横向滚动时仍可见。
- `highlightCode()` 对未知语言会转义 HTML，因此 `v-html` 只接收其返回值，不接收未经处理的文件内容。
- 目标行背景放在代码下层，文本保持可选择、可复制。

---

## 六、读取、缓存与错误处理

### 6.1 请求契约

沿用 `FileContent`：

```ts
interface FileContentResponse {
  content: string
  name: string
  path: string
  supported: boolean
  isBinary?: boolean
  truncated?: boolean
  size: number
}
```

URL 构造必须与 `store.selectFile()` 一致：

```ts
function buildPreviewUrl(path: string): string {
  if (isAbsolutePath(path)) {
    return `/api/file?path=${encodeURIComponent(path)}`
  }
  return `/api/file/${encodeURIComponent(path.replace(/^\/+/, ''))}`
}
```

不要调用 `store.selectFile()` 拉取预览，否则会污染当前文件、导航栈和加载状态。

### 6.2 缓存策略

使用模块级、按访问顺序更新的加权 LRU：

- Key：`${projectRoot}::${normalizedPath}`，防止切换项目后串内容。
- TTL：30 秒；标题栏提供刷新按钮，可显式绕过缓存。
- 上限：20 个文件且总估算内容不超过 8MiB，任一条件超限即从最旧项开始驱逐。
- 单文件内容超过 2MiB 时仍可本次预览，但不写入缓存。
- 缓存只存原始响应；切片和高亮按当前范围即时计算。
- 项目根目录变化时清空缓存。

这里的 2MiB 是“是否缓存”的阈值，不宣称减少网络传输。后端仍负责 10MB 文件上限。

### 6.3 错误映射

| 条件 | UI 行为 |
| :--- | :--- |
| `isBinary=true` | 显示“二进制文件无法预览”，保留打开完整文件按钮 |
| `FileTooLarge` | 显示“文件超过 10MiB，无法在线预览”，提供查看文件详情/下载入口，不显示误导性的“打开完整文件” |
| `NotAFile` | 标记为目录并关闭瞬态卡片；触屏抽屉显示“目录不支持代码预览” |
| `FileNotFoundShort` 或 `FileNotFound` | 显示文件不存在；清除该路径缓存 |
| `AccessDenied` | 显示无权访问，不泄露绝对路径之外的额外信息 |
| 网络错误 / 非 JSON 响应 | 显示可重试状态；记录 `appLog.w()`，禁止使用 `console.*` |
| 请求被 abort | 静默结束，不显示错误 |

补充两类用户可感知状态：

| 条件 | UI 行为 |
| :--- | :--- |
| 成功响应 `size > 2MiB` | 仍允许本次预览，但在标题栏显示“文件较大，预览仅显示局部内容，加载可能较慢”；该响应不写入缓存 |
| `renderTruncated=true` | 显示“预览已截断（最多 {n} 行 / {size}）”，复制只复制实际展示的内容 |

错误文案全部进入 `web/src/i18n/locales/zh.ts` 与 `en.ts`，按钮必须有本地化 `title`/`aria-label`。

### 6.4 资源预算与可感知性

- 后端现有 `GET /api/file` 在 10MiB 前读取完整文件；一次请求可能同时存在 `os.ReadFile` 的字节切片、JSON 字符串和编码缓冲。前端取消请求不能保证服务端已经停止读取，因此 `AbortController` 只负责防止旧响应写入 UI，不能作为资源限流手段。
- 预览控制器同一时刻最多保留一个活动请求；相同缓存 key 的重复触发复用 in-flight Promise。请求必须带 10 秒超时（复用 `apiGet()` 或显式组合 `AbortSignal`），并在组件卸载、文件切换、raw mode、项目/权限根切换时 abort 和清理。
- 未完成 `verifyFilePaths()` 的节点先不发内容 GET；先等待 `data-path-type=file`，目录和不存在路径不得通过悬停触发一次完整文件读取。
- LRU 的 8MiB 是逻辑缓存预算，不等于浏览器堆上限。缓存估算至少按 `content.length * 2` 计量，并在 `get/set` 时清理过期项；登出、项目切换和权限根变化时清空。高亮 HTML、当前切片和 DOM 不计入缓存预算，需由 `MAX_RENDER_BYTES` 另行约束。
- 没有元数据预检时，客户端无法在请求前知道文件是否超过 2MiB 或 10MiB；“大文件”提示只能在收到响应后显示。若必须在传输前提示或避免完整传输，需后续增加 `HEAD/metadata` 或按范围读取接口。
- 资源验收至少记录：快速划过 20 个链接时的最大 in-flight 请求数、网络传输量、浏览器堆增长和主线程长任务，以及服务端 1/5/10MiB 文件并发读取时的 RSS/CPU。验收目标是单组件不超过一个活动请求、渲染内容不超过上述字节上限，且取消旧目标后不会继续更新 UI。

---

## 七、组件与职责拆分

### 7.1 新增文件

| 文件 | 职责 |
| :--- | :--- |
| `web/src/utils/codeLinkPreview.ts` | 纯函数：行范围归一化、带行/字节上限的代码切片、URL 构造、锚点定位、拖拽 clamp、缓存大小估算 |
| `web/src/composables/useCodeLinkPreview.ts` | 状态机、hover/focus/touch 代理、开关监听、计时器、AbortController/超时、单请求复用、LRU、请求和缓存刷新 |
| `web/src/components/file/CodeLinkPreview.vue` | 桌面 Teleport 浮窗；窄/粗指针模式下复用 `BottomSheet`；加载、错误和代码正文 UI |
| `web/src/assets/code-link-preview.css` | Teleport 节点的全局样式、主题变量、目标行、拖拽态和 reduced-motion |
| `web/src/utils/__tests__/codeLinkPreview.test.ts` | 纯函数和边界测试 |
| `web/src/composables/__tests__/useCodeLinkPreview.test.ts` | 状态机、计时器、请求竞态和缓存测试 |
| `web/src/components/file/__tests__/CodeLinkPreview.test.ts` | 渲染、Pin、拖拽、键盘、BottomSheet 与可访问性测试 |

### 7.2 修改文件

| 文件 | 改动 |
| :--- | :--- |
| `web/src/composables/useFilePathAnnotation.ts` | 完整支持 `:L` 行号；验证后写入 `data-path-type` |
| `web/src/composables/__tests__/useFilePathAnnotation.test.ts` | 覆盖 URI、`<a>`、`<code>`、纯文本、Windows 路径和 fallback 替换 |
| `web/src/components/file/MarkdownPreview.vue` | 挂载预览组件；读取 `markdownCodeLinkPreview` 开关；把 bodyRef 与文件切换生命周期交给 composable；在现有打开逻辑前处理修饰键和触屏点击 |
| `web/src/components/file/__tests__/MarkdownPreview.test.ts` | 验证桌面点击不回归、触屏分工、目录忽略、文件切换清理 |
| `web/src/composables/useSettingsConfig.ts` | 增加 `markdownCodeLinkPreview` 本地默认值 `false`，复用现有 localStorage 持久化 |
| `web/src/components/settings/settingsFieldMap.ts` | 在“项目与文件 → 文件显示”增加 `markdownCodeLinkPreview` local switch 条目 |
| `web/src/components/settings/__tests__/SettingsCategory.test.ts`（或现有设置页测试） | 验证开关展示、切换持久化和重新挂载恢复 |
| `web/src/i18n/locales/zh.ts`、`en.ts` | 新增 `settings.items.markdownCodeLinkPreview`/`...Desc`，以及预览标题、按钮、加载、大文件、截断和错误文案 |
| `docs/spec/features/file-management.md`、`docs/spec/client/frontend-architecture.md` | 记录开关默认关闭、作用范围、完整 GET 的资源语义和大文件可感知状态 |

首期不修改 Go 后端，因此无需新增后端功能测试；但资源验收仍需覆盖现有 `GetFile` 在 1/5/10MiB 文件和并发请求下的 RSS/CPU/响应耗时。若后续增加按行读取 API，必须复用 `resolveFilePath()` 的授权逻辑并单独覆盖路径穿越、外部授权根、符号链接、二进制和超大行等测试。

---

## 八、桌面浮窗布局与拖拽

### 8.1 渲染与定位

- 桌面浮窗使用 `<Teleport to="body">`，避免被 `.markdown-body` 或文件容器的 overflow/transform 裁切。
- `position: fixed`；默认宽度 `min(680px, calc(100vw - 16px))`，最大高度 `min(60vh, 520px)`。
- 初次定位优先级：目标右下 → 左下 → 右上 → 左上，均不可完整容纳时再夹取到安全区域。
- 与目标至少间隔 8px，视口四周保留 8px；顶部额外叠加 `--header-safe-area-top`。
- 复用 `getZoomedViewport()` 和 `toFixedCSS()`；不能直接把 `clientX/clientY` 当作 CSS `left/top`。
- 浮窗层级应高于文件正文和 diff marker，低于全局模态框和 AppHeader；在样式中集中定义，禁止组件内零散魔数。

### 8.2 拖拽

- 仅标题栏空白区可开始拖拽，按钮区 `@pointerdown.stop`。
- 仅响应主按钮 `event.button === 0`。
- 开始时调用 `setPointerCapture()`、设置 `touch-action: none`，并自动 Pin。
- `pointermove` 用 `requestAnimationFrame` 合帧；更新前执行 zoom-aware clamp。
- `pointerup`、`pointercancel`、窗口失焦和组件卸载都必须结束拖拽并清理 body class。
- `ResizeObserver` 监听卡片尺寸变化；同时 watch `useSettingsConfig().localConfig.uiScale`。`window.resize`、UI scale 变化或内容展开后都在下一帧重新 clamp，保证标题栏始终可见。
- 首期不持久化坐标；切换目标后保留当前锁定窗口位置，关闭再打开恢复自动定位。

### 8.3 移动端

- 使用现有 `BottomSheet`，最大高度约 `70dvh`，正文内部滚动。
- 抽屉打开后通过现有焦点管理和系统返回行为关闭。
- 不显示 Pin 和拖拽控件，因为 BottomSheet 本身已常驻至用户关闭。
- 保留复制、刷新、扩展/收缩上下文、打开完整文件（超大文件为详情/下载）和关闭操作；触控目标至少 44×44px。

---

## 九、可访问性与细节

- 桌面交互卡片使用 `role="dialog"` 和可本地化的 `aria-label`，不使用只允许非交互内容的 `role="tooltip"`。
- Pin 按钮提供 `aria-pressed`；加载状态使用 `aria-live="polite"`，错误使用 `role="status"`。
- 路径过长时视觉省略，但完整路径保留在可访问名称或 HintTooltip 中。
- Teleport 后的卡片不在来源节点旁边的自然 Tab 顺序中，因此来源节点上的 `F2` 显式把焦点移到卡片首个操作按钮；卡片关闭时把焦点还给仍在 DOM 中的来源节点。
- `Escape` 优先关闭当前预览，不传播到 FileOverlay；没有预览时不拦截。
- 焦点从目标移动到 Teleport 卡片时不能触发关闭；需要与 hover 相同的 200ms bridge delay。
- 卡片不是模态框，不设置 `aria-modal="true"`，也不把焦点困在卡片内；最后一个操作之后的 Tab 回到正常页面顺序。
- 遵守 `prefers-reduced-motion`，禁用浮现位移和拖拽后的回弹动画。
- 代码正文使用全局 `--font-mono`、`--code-bg`、`--code-syntax-*` 和现有 hljs 深浅色主题。

---

## 十、实施顺序

### 阶段 1：解析与纯函数

1. 补齐 `:L` 全链路解析和现有测试。
2. 实现 `normalizePreviewRange()`、`sliceCodeForPreview()`、`buildPreviewUrl()`、`placeNearAnchor()`、`clampCardPosition()`。
3. 为 LF/CRLF、文件首尾、倒序范围、越界范围、行/字节/单行上限和 CSS zoom 坐标补测试。

### 阶段 2：桌面瞬态预览

1. 实现控制器的 pending/loading/ready/error 和请求代次。
2. 接入 MarkdownPreview 的委托 hover 与 focus 事件。
3. 完成 Teleport、定位、高亮、真实行号、复制、刷新和完整打开。
4. 接入 `markdownCodeLinkPreview` 开关：默认关闭；关闭时不监听、不请求，并清理活动预览与缓存。
5. 确认桌面普通点击行为与当前版本完全一致。

### 阶段 3：Pin 与拖拽

1. 实现单实例锁定规则、快捷锁定和解除锁定。
2. 实现 Pointer Capture、rAF 合帧、zoom-aware clamp、resize/内容变化回收。
3. 补 pointercancel、卸载清理和快速切换目标的测试。

### 阶段 4：触屏与收尾

1. 接入 BottomSheet 和触屏点击分工。
2. 完成键盘、ARIA、i18n、reduced-motion 和主题适配。
3. 完成设置页开关、localStorage 恢复和关闭时资源清理测试。
4. 更新 `docs/spec/features/file-management.md` 与 `docs/spec/client/frontend-architecture.md`。
5. 执行专项测试、前端完整测试、资源基准和推送前检查。

---

## 十一、自动化测试清单

### `useFilePathAnnotation.test.ts`

- `:10`、`:10-20`、`:L10`、`:L10-L20`、`:L10-20`；
- `#L10-L20` 与 `#10-20` 不回归；
- `<a href>`、纯 `<code>`、普通文本三种 DOM 路径均写入相同行号；
- `C:\repo\main.go:L10-L20` 不把盘符冒号误判为行号；
- fallback 替换后 path、line attrs、`data-path-type` 一致；
- 目录写入 `data-path-type=dir`，不存在路径移除标注。

### `codeLinkPreview.test.ts`

- 单行、多行、无范围、CRLF、末尾空行；
- 文件头尾上下文夹取、行号越界和倒序范围；
- 超过 200 行时截断且保留原始打开范围；
- 超过 `MAX_RENDER_BYTES`、单行超过 `MAX_LINE_BYTES` 时截断并返回原因；正常小文件不误报；
- URL 对相对路径、Unix 绝对路径、Windows 绝对路径正确编码；
- 锚点四象限定位、窄视口夹取、CSS zoom 换算；
- 加权 LRU 的命中提升、TTL 过期、按条数和字节数驱逐。

### `useCodeLinkPreview.test.ts`

- hover 249ms 不显示、250ms 进入加载、离开后取消；
- 从目标移动到卡片不会关闭，完全离开 200ms 后关闭；
- 快速 A→B 时 A 的迟到响应不能覆盖 B；
- 同一 key 的重复触发复用一个请求，10 秒超时后进入可重试错误；
- abort 不显示错误，网络错误可重试；
- Pin 后 hover B 不替换，快捷锁定 B 才替换；
- 项目切换、Markdown 文件切换、raw mode、unmount 均清理计时器和请求；
- 缓存命中不发请求，刷新强制发请求，大文件不缓存；开关关闭时活动请求被取消且缓存清空。

### 组件与集成测试

- loading/error/ready/binary/too-large 五种 UI；
- `size > 2MiB` 的成功响应显示大文件提示；`FileTooLarge` 显示无法在线预览和下载/详情入口，不显示误导性的“打开完整文件”；
- 真实行号、目标背景、复制内容、上下文扩展与收缩；
- 行数/字节/超长单行三种截断提示及复制边界；
- Pin 的 `aria-pressed`、F2 进入卡片、Escape 关闭和来源焦点恢复；
- drag start 自动 Pin，边缘 clamp，pointercancel 清理；
- 触屏路径文本打开 BottomSheet，打开按钮仍调用 `openFilePath()`；
- 桌面 Markdown 链接和打开按钮的原有单击行为不回归；
- 目录 hover 不发文件内容请求；开关默认关闭、切换后不再发起预览请求且刷新页面仍能恢复设置。

---

## 十二、手动验收标准

准备一个 Markdown 文件，包含以下目标：

```md
`web/src/stores/app.ts:L431-L446`
[文件读取](internal/handler/file.go#L275-L350)
`internal/handler`
`missing/not-found.ts:L10`
```

验收必须全部通过：

1. 桌面悬停 250ms 后出现预览，目标行与前后 3 行正确，快速划过不会闪出旧内容。
2. 鼠标从路径跨到卡片不会消失；离开两者约 200ms 后消失。
3. Pin 后滚动 Markdown 不移动；拖到四个边缘均无法丢失标题栏；调整 UI scale 后位置仍正确。
4. 点击完整打开后进入原文件并定位原始行范围，预览关闭。
5. 目录不弹代码卡片；丢失、二进制、超大和无权限文件显示正确的本地化状态。
6. 触屏点击路径文本打开 BottomSheet，点击相邻打开按钮直接打开文件，没有 synthetic hover 残留。
7. 仅键盘可以聚焦链接或打开按钮，以 F2 进入卡片，完成 Pin/打开操作，并按 Escape 关闭且恢复来源焦点。
8. 深色/浅色主题下代码、目标行、边框和按钮对比度可读；200% UI scale 和 320px 宽视口无溢出。
9. 切换 Markdown 文件或源代码模式后，旧浮窗、计时器、请求和拖拽 body class 全部清理。
10. 设置开关默认关闭；开启后才出现预览，关闭后已有预览立即消失、请求取消、缓存清空，刷新页面后设置仍保持。
11. 3MiB 文件显示“大文件、仅展示局部”提示但仍可查看目标片段；超过 10MiB 显示“无法在线预览”并提供下载/详情入口；超长单行显示截断提示且页面不冻结。

建议验证命令：

```bash
cd web && pnpm exec vitest run \
  src/composables/__tests__/useFilePathAnnotation.test.ts \
  src/utils/__tests__/codeLinkPreview.test.ts \
  src/composables/__tests__/useCodeLinkPreview.test.ts \
  src/components/file/__tests__/CodeLinkPreview.test.ts \
  src/components/file/__tests__/MarkdownPreview.test.ts \
  src/components/settings/__tests__/SettingsCategory.test.ts \
  src/components/settings/__tests__/settingsFieldMap.test.ts

npm test
./scripts/pre-push-checks.sh
```

---

## 十三、后续演进条件

满足下列任一条件时，再设计后端按行预览 API：

- 真实性能采样显示 2–10MB 文件的悬停读取明显影响交互；
- 用户需要预览超过当前 10MB 上限的日志或生成文件；
- 需要基于文件修改时间做强一致缓存；
- 需要按符号边界而非固定上下文扩展代码片段。

届时建议返回 `{ content, displayStart, displayEnd, totalLines, size, modified, isBinary }`，并通过 `ETag/If-None-Match` 或 `modified` 做缓存校验；该扩展不阻塞本期前端功能。
