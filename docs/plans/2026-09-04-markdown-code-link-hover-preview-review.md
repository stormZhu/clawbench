# Markdown 代码链接悬浮预览实现审查

审查范围：提交 `d1063206843eddd811f8e8c845325f28672a408d` 及其后的未提交改动。

审查日期：2026-09-04

## 结论

当前实现的主路径和测试框架已经基本齐全，但仍有 10 个需要处理的问题：3 个 P1、7 个 P2。主要风险集中在请求超时状态、事件分发冲突、全局快捷键、分享页功能越界、移动端错误恢复和 UI 缩放后的定位。

## 问题清单

### 1. [P1] 将 API 超时误判为主动取消

位置：`web/src/composables/useCodeLinkPreview.ts:166-171`

`apiGet()` 使用独立的 `AbortController` 实现 10 秒超时。内部超时发生时，这里会收到 `AbortError`，但传入的外部 `signal.aborted` 仍为 `false`。

当前代码只要错误名称是 `AbortError` 就静默返回，导致预览状态永久停留在 `loading`，用户也看不到错误或重试入口。

建议：

- 仅在外部 `signal.aborted === true` 时将请求视为主动取消。
- 将 API 内部超时映射为可区分的超时错误，或者在这里进入 `network/error` 状态。
- 增加内部超时与主动取消的独立测试。

### 2. [P1] 修饰键点击在未验证路径和目录上破坏原有行为

位置：`web/src/components/file/MarkdownPreview.vue:150-156`

已验证文件会在 capture 阶段由 composable 处理，并调用 `preventDefault()` 和 `stopPropagation()`。因此能够继续执行到父组件这段逻辑时，目标通常是尚未完成异步验证的路径或目录。

这里再次调用 `codeLinkPreview.handleClick()` 后无条件 `return`。当 composable 拒绝处理目标时，原有内部文件打开逻辑也被跳过，Markdown 链接可能按照浏览器默认行为打开错误的相对 URL，目录动作也可能被吞掉。

建议：

- 让 `handleClick()` 返回 `boolean`，只有确实处理事件后才 `return`；或
- 删除父组件中的重复预览分发，统一依赖 capture 监听；并
- 增加“验证完成前 Ctrl/Cmd+Click”和“目录 Ctrl/Cmd+Click”测试。

### 3. [P1] 全局 F2 监听与文件管理器重命名冲突

位置：`web/src/components/file/CodeLinkPreview.vue:681-686`

只要预览可见，挂在 `window` 上的监听就会拦截任意位置产生的 F2，并把焦点移入预览卡片。文件管理器自身使用 F2 重命名，因此可能同时打开重命名对话框并把焦点抢回预览；在其他输入控件中也会发生非预期拦截。

计划要求的是“来源节点上的 F2”，不是预览可见期间的全局快捷键。

建议：

- 仅当 `document.activeElement === preview.target.value?.anchorEl` 时处理 F2；或
- 在 Markdown 来源容器内绑定键盘事件，并确认事件目标就是当前来源节点；
- 增加预览可见但焦点位于文件列表、输入框和来源节点三种测试。

### 4. [P2] 分享页会意外启用仅面向文件管理器的预览功能

位置：`web/src/components/file/MarkdownPreview.vue:34-37`

`MarkdownPreview` 同时被 `ShareView` 使用。当前挂载条件只检查本地设置和 `rendered` 模式，因此同源 `localStorage` 中已经开启设置时，分享页也会挂载预览并注册事件。

分享页随后会请求受鉴权的 `/api/file`，而不是分享 token API。这既会产生无效请求，也违反计划中“仅文件管理器生效，分享页不受影响”的范围约束。

建议：

- 增加由调用方显式传入的 `enableCodeLinkPreview` 属性，文件管理器传 `true`、分享页保持 `false`；或
- 将预览功能的挂载移到只属于文件管理器的 `FileViewer` 层；
- 增加 ShareView 不挂载预览、不发送 `/api/file` 请求的测试。

### 5. [P2] 移动端超大文件没有详情或下载入口

位置：`web/src/components/file/CodeLinkPreview.vue:47-53`

BottomSheet 收到 `too-large` 后直接隐藏“打开完整文件”按钮，却没有像桌面浮窗一样提供“查看详情/下载”替代入口。用户只能看到错误并关闭抽屉，无法从当前流程继续处理文件。

建议：

- 在 `too-large` 状态显示“查看详情/下载”按钮；
- 复用桌面端的详情处理函数或完整文件入口；
- 增加移动端 `too-large` 状态的组件测试。

### 6. [P2] 相同目标判断遗漏 `lineEnd`

位置：`web/src/composables/useCodeLinkPreview.ts:364-366`

当前只比较文件路径和 `lineStart`。如果两个链接指向同一文件和同一起始行，但结束行不同，例如 `L10-L20` 与 `L10-L30`，第二次悬停会被误判为同一目标，继续显示旧范围。

建议：

- 将 `lineEnd` 纳入目标相等判断；
- 最好抽取统一的 `isSamePreviewTarget()`，避免后续其他入口采用不一致的比较规则；
- 增加同文件、同起点、不同终点的切换测试。

### 7. [P2] UI scale 改变后 fixed 坐标可能继续使用旧缩放值

位置：

- `web/src/components/file/CodeLinkPreview.vue:432-444`
- `web/src/components/file/CodeLinkPreview.vue:565-585`
- `web/src/components/file/CodeLinkPreview.vue:669-675`

`cardStyle` 调用了 `toFixedCSS()`，但 computed 本身没有响应式依赖 `localConfig.uiScale`。缩放变化后，如果拖拽坐标的 clamp 结果数值没有改变，重新写入相同的 `dragX/dragY` 不会触发样式重算。

未拖拽的 pinned 卡片也存在问题：`syncPlacementWithCard()` 会因为已有 placement 而提前返回，继续使用旧缩放下生成的 `cssLeft/cssTop`。结果是卡片视觉位置偏移，严重时可能越界。

建议：

- 让 `cardStyle` 显式读取 `localConfig.uiScale`；
- placement 保存 viewport 坐标，渲染时根据当前缩放动态生成 CSS 坐标；
- UI scale 变化时重新测量尺寸并 clamp，但不要破坏 pinned 卡片的 viewport 位置；
- 增加 100% → 150%/200% 的 pinned 和已拖拽两类测试。

### 8. [P2] 未提交改动的默认上下文与计划和验收标准不一致

位置：`web/src/utils/codeLinkPreview.ts:16`

未提交改动把单行目标的默认上下文从前后各 3 行改成前后各 30 行，使普通单行目标默认创建约 61 行 DOM。与此同时，计划、函数注释和手动验收仍明确要求前后各 3 行。

边缘位置新增的“向另一侧补足窗口”逻辑也不再是计划中的简单范围夹取。

建议：

- 如果没有新的产品决策，恢复 `DEFAULT_CONTEXT = 3` 和原有夹取语义；
- 如果确定采用 30 行，必须同步计划、函数注释、交互文案、性能预算和手动验收标准；
- 不要仅修改测试来适配新常量，而保留相互冲突的规格。

### 9. [P2] 窗口失焦时没有结束拖拽

位置：`web/src/components/file/CodeLinkPreview.vue:689-706`

拖拽只在 `pointerup`、`pointercancel` 和组件卸载时结束。用户通过 Cmd-Tab、Alt-Tab 或其他方式切换窗口时，不保证浏览器一定产生对应的 pointer 结束事件。

此时 `isDragging` 和 `body.code-preview-dragging` 可能持续保留，回到页面后整个页面的光标和选中行为仍处于拖拽状态。

建议：

- 在挂载时监听 `window.blur` 并调用 `stopDragging()`；
- 卸载时移除该监听；
- 确保没有 PointerEvent 参数时也能移除 pointermove 监听和释放所有拖拽状态；
- 增加失焦中断拖拽的测试。

### 10. [P2] 关闭按钮没有恢复来源焦点

位置：`web/src/components/file/CodeLinkPreview.vue:208-212`

Escape 通过 `handleEscape()` 关闭并恢复 `anchorEl` 焦点，但关闭按钮直接调用 `preview.close()`。键盘用户激活关闭按钮后，当前焦点节点会随 Teleport 内容一起卸载，焦点通常退回到 `body`，无法继续从原链接导航。

建议：

- 抽取统一的 `closeAndRestoreFocus()`，供 Escape 和关闭按钮共同使用；
- 仅在来源节点仍位于 DOM 且可聚焦时恢复焦点；
- 增加使用键盘激活关闭按钮后的焦点恢复测试。

## 验证记录

- 相关专项 Vitest 共 317 项通过。
- 测试过程报告 4 个 vue-i18n 异步泄漏警告，虽然退出码为 0，仍建议修复测试卸载和异步清理。
- `vue-tsc --noEmit` 通过。
- 相关 ESLint 检查通过；测试文件仅有配置忽略提示。
- `git diff --check` 未通过：`web/src/utils/codeLinkPreview.ts:595` 文件末尾存在多余空行。

