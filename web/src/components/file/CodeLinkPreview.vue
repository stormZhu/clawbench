<template>
  <!-- Touch Device: BottomSheet mode -->
  <BottomSheet
    v-if="preview.visible.value && preview.mode.value === 'sheet'"
    :open="preview.visible.value"
    auto
    :title="sheetTitle"
    @close="preview.close()"
  >
    <div class="code-preview-sheet-body">
      <!-- Notices -->
      <div v-if="preview.isLargeFile.value" class="code-preview-notice notice-warning">
        {{ t('file.codePreview.largeFileNotice') }}
      </div>
      <div v-if="preview.slicedCode.value?.lineOutOfRange" class="code-preview-notice notice-warning">
        {{ t('file.codePreview.lineOutOfRange') }}
      </div>
      <div v-if="preview.slicedCode.value?.renderTruncated" class="code-preview-notice notice-info">
        {{ t('file.codePreview.truncatedNotice', { n: 200, size: '512KB' }) }}
      </div>

      <!-- Action buttons -->
      <div class="code-preview-sheet-actions">
        <button class="code-preview-btn" @click="handleCopy">
          {{ copied ? t('file.codePreview.copied') : t('file.codePreview.copy') }}
        </button>
        <button
          class="code-preview-btn"
          :class="{ 'is-active': isWordWrap }"
          @click="toggleWordWrap"
        >
          {{ isWordWrap ? t('file.codePreview.unwrap') : t('file.codePreview.wrap') }}
        </button>
        <button class="code-preview-btn" @click="preview.expandContext()">
          {{ t('file.codePreview.expand') }}
        </button>
        <button
          class="code-preview-btn"
          :disabled="preview.contextExpansion.value <= 0"
          @click="preview.shrinkContext()"
        >
          {{ t('file.codePreview.shrink') }}
        </button>
        <button class="code-preview-btn" @click="preview.refresh()">
          {{ t('file.codePreview.refresh') }}
        </button>
        <button
          v-if="preview.errorCode.value !== 'too-large'"
          class="code-preview-btn primary"
          @click="preview.openFull()"
        >
          {{ t('file.codePreview.openFull') }}
        </button>
      </div>

      <!-- Content Area -->
      <div class="code-preview-content">
        <!-- Loading -->
        <div v-if="preview.status.value === 'loading'" class="code-preview-status" aria-live="polite">
          <div class="code-preview-spinner" />
          <span>{{ t('file.codePreview.loading') }}</span>
        </div>

        <!-- Error -->
        <div v-else-if="preview.status.value === 'error'" class="code-preview-status" role="status">
          <span>{{ errorMessageText }}</span>
          <button v-if="preview.errorCode.value === 'network'" class="code-preview-btn" @click="preview.refresh()">
            {{ t('file.codePreview.retry') }}
          </button>
        </div>

        <!-- Code viewer -->
        <div
          v-else-if="preview.status.value === 'ready'"
          ref="sheetScrollRef"
          class="code-preview-scroll"
          :class="{ 'is-word-wrap': isWordWrap }"
        >
          <div class="code-preview-lines">
            <div
              v-for="line in codeLines"
              :key="line.lineNum"
              class="code-preview-line-row"
              :class="{ 'is-target-line': line.isTarget }"
            >
              <div
                class="code-preview-line-number"
                :class="{ 'is-target-line': line.isTarget }"
                aria-hidden="true"
              >
                {{ line.lineNum }}
              </div>
              <div class="code-preview-line-code">
                <code class="hljs" v-html="line.html || '&nbsp;'" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </BottomSheet>

  <!-- Desktop Floating: Teleport to body -->
  <Teleport v-else-if="preview.visible.value && preview.mode.value !== 'sheet'" to="body">
    <div
      ref="cardRef"
      class="code-link-preview-floating"
      role="dialog"
      :aria-label="t('file.codePreview.title')"
      :style="cardStyle"
      tabindex="-1"
      @pointerenter="preview.onCardPointerEnter"
      @pointerleave="preview.onCardPointerLeave"
      @focusin="preview.onCardFocusIn"
      @focusout="preview.onCardFocusOut"
      @keydown.esc.stop.prevent="handleEscape"
    >
      <!-- Titlebar / Drag Handle -->
      <div class="code-preview-header" @pointerdown="onDragPointerDown">
        <div class="code-preview-title" :title="preview.target.value?.filePath || ''">
          <span>{{ preview.target.value?.filePath || '' }}</span>
          <span v-if="preview.target.value?.lineStart" class="code-preview-range-badge">
            :{{ preview.target.value.lineStart }}<template v-if="preview.target.value.lineEnd && preview.target.value.lineEnd !== preview.target.value.lineStart">-{{ preview.target.value.lineEnd }}</template>
          </span>
        </div>

        <div class="code-preview-actions" @pointerdown.stop>
          <button
            ref="firstActionBtnRef"
            class="code-preview-btn"
            :title="t('file.codePreview.copy')"
            :aria-label="t('file.codePreview.copy')"
            @click="handleCopy"
          >
            {{ copied ? t('file.codePreview.copied') : t('file.codePreview.copy') }}
          </button>
          <button
            class="code-preview-btn"
            :title="t('file.codePreview.expand')"
            :aria-label="t('file.codePreview.expand')"
            @click="preview.expandContext()"
          >
            +5
          </button>
          <button
            class="code-preview-btn"
            :disabled="preview.contextExpansion.value <= 0"
            :title="t('file.codePreview.shrink')"
            :aria-label="t('file.codePreview.shrink')"
            @click="preview.shrinkContext()"
          >
            -5
          </button>
          <button
            class="code-preview-btn"
            :class="{ 'is-active': isWordWrap }"
            :title="isWordWrap ? t('file.codePreview.unwrap') : t('file.codePreview.wrap')"
            :aria-label="isWordWrap ? t('file.codePreview.unwrap') : t('file.codePreview.wrap')"
            :aria-pressed="isWordWrap"
            @click="toggleWordWrap"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M4 6h16M4 12h10a3 3 0 0 1 3 3v0a3 3 0 0 1-3 3H11m0 0l3-3m-3 3l3 3M4 18h4" />
            </svg>
          </button>
          <button
            class="code-preview-btn"
            :title="t('file.codePreview.refresh')"
            :aria-label="t('file.codePreview.refresh')"
            @click="preview.refresh()"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
            </svg>
          </button>
          <button
            class="code-preview-btn"
            :class="{ 'is-pinned': preview.isPinned.value }"
            :aria-pressed="preview.isPinned.value"
            :title="preview.isPinned.value ? t('file.codePreview.unpin') : t('file.codePreview.pin')"
            :aria-label="preview.isPinned.value ? t('file.codePreview.unpin') : t('file.codePreview.pin')"
            @click="preview.togglePin()"
          >
            <svg
              viewBox="0 0 24 24"
              width="12"
              height="12"
              :fill="preview.isPinned.value ? 'currentColor' : 'none'"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
            </svg>
          </button>
          <button
            v-if="preview.errorCode.value === 'too-large'"
            class="code-preview-btn"
            :title="t('file.codePreview.viewDetails')"
            :aria-label="t('file.codePreview.viewDetails')"
            @click="handleViewDetails"
          >
            {{ t('file.codePreview.viewDetails') }}
          </button>
          <button
            v-else
            class="code-preview-btn"
            :title="t('file.codePreview.openFull')"
            :aria-label="t('file.codePreview.openFull')"
            @click="preview.openFull()"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14L21 3" />
            </svg>
          </button>
          <button
            class="code-preview-btn close"
            :title="t('file.codePreview.close')"
            :aria-label="t('file.codePreview.close')"
            @click="preview.close()"
          >
            &times;
          </button>
        </div>
      </div>

      <!-- Notices -->
      <div class="code-preview-notices">
        <div v-if="preview.isLargeFile.value" class="code-preview-notice notice-warning">
          {{ t('file.codePreview.largeFileNotice') }}
        </div>
        <div v-if="preview.slicedCode.value?.lineOutOfRange" class="code-preview-notice notice-warning">
          {{ t('file.codePreview.lineOutOfRange') }}
        </div>
        <div v-if="preview.slicedCode.value?.renderTruncated" class="code-preview-notice notice-info">
          {{ t('file.codePreview.truncatedNotice', { n: 200, size: '512KB' }) }}
        </div>
      </div>

      <!-- Body / Scroll pane -->
      <div class="code-preview-content">
        <!-- Loading -->
        <div v-if="preview.status.value === 'loading'" class="code-preview-status" aria-live="polite">
          <div class="code-preview-spinner" />
          <span>{{ t('file.codePreview.loading') }}</span>
        </div>

        <!-- Error -->
        <div v-else-if="preview.status.value === 'error'" class="code-preview-status" role="status">
          <span>{{ errorMessageText }}</span>
          <button v-if="preview.errorCode.value === 'network'" class="code-preview-btn" @click="preview.refresh()">
            {{ t('file.codePreview.retry') }}
          </button>
        </div>

        <!-- Code Content -->
        <div
          v-else-if="preview.status.value === 'ready'"
          ref="scrollPaneRef"
          class="code-preview-scroll"
          :class="{ 'is-word-wrap': isWordWrap }"
        >
          <div class="code-preview-lines">
            <div
              v-for="line in codeLines"
              :key="line.lineNum"
              class="code-preview-line-row"
              :class="{ 'is-target-line': line.isTarget }"
            >
              <div
                class="code-preview-line-number"
                :class="{ 'is-target-line': line.isTarget }"
                aria-hidden="true"
              >
                {{ line.lineNum }}
              </div>
              <div class="code-preview-line-code">
                <code class="hljs" v-html="line.html || '&nbsp;'" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import BottomSheet from '@/components/common/BottomSheet.vue'
import { highlightCode } from '@/utils/globals'
import { getFileType } from '@/utils/fileType'
import { clampCardPosition, splitHighlightedHtml } from '@/utils/codeLinkPreview'
import { toFixedCSS, useSettingsConfig } from '@/composables/useSettingsConfig'
import type { useCodeLinkPreview } from '@/composables/useCodeLinkPreview'
import '@/assets/code-link-preview.css'

const props = defineProps<{
  preview: ReturnType<typeof useCodeLinkPreview>
}>()

const { t } = useI18n()
const { localConfig } = useSettingsConfig()

const STORAGE_KEY_WRAP = 'clawbench:code-preview-word-wrap'

const cardRef = ref<HTMLElement | null>(null)
const scrollPaneRef = ref<HTMLElement | null>(null)
const sheetScrollRef = ref<HTMLElement | null>(null)
const firstActionBtnRef = ref<HTMLButtonElement | null>(null)
const copied = ref(false)
const isWordWrap = ref<boolean>(false)

try {
  const saved = localStorage.getItem(STORAGE_KEY_WRAP)
  if (saved !== null) {
    isWordWrap.value = saved === 'true'
  }
} catch {
  // ignore
}

const toggleWordWrap = () => {
  isWordWrap.value = !isWordWrap.value
  try {
    localStorage.setItem(STORAGE_KEY_WRAP, String(isWordWrap.value))
  } catch {
    // ignore
  }
  scrollToTargetLine()
}

// Dragging coordinates in viewport pixels
const dragX = ref<number | null>(null)
const dragY = ref<number | null>(null)
let isDragging = false
let startPointerX = 0
let startPointerY = 0
let startCardX = 0
let startCardY = 0
let resizeObserver: ResizeObserver | null = null

const sheetTitle = computed(() => {
  const path = props.preview.target.value?.filePath || ''
  const start = props.preview.target.value?.lineStart
  const end = props.preview.target.value?.lineEnd
  if (start) {
    const range = end && end !== start ? `:${start}-${end}` : `:${start}`
    return `${path}${range}`
  }
  return path || t('file.codePreview.title')
})

const errorMessageText = computed(() => {
  const code = props.preview.errorCode.value
  if (code === 'binary') return t('file.codePreview.binaryNotSupported')
  if (code === 'too-large') return t('file.codePreview.fileTooLarge')
  if (code === 'not-file') return t('file.codePreview.dirNotSupported')
  if (code === 'not-found') return t('file.codePreview.notFound')
  if (code === 'access-denied') return t('file.codePreview.accessDenied')
  return props.preview.errorMessage.value || t('file.codePreview.loadError')
})

const isTargetLine = (lineNum: number): boolean => {
  const sliced = props.preview.slicedCode.value
  if (!sliced?.highlightStart) return false
  const start = sliced.highlightStart
  const end = sliced.highlightEnd ?? start
  return lineNum >= start && lineNum <= end
}

export interface FormattedCodeLine {
  lineNum: number
  html: string
  isTarget: boolean
}

const codeLines = computed<FormattedCodeLine[]>(() => {
  const sliced = props.preview.slicedCode.value
  if (!sliced?.code) return []
  const filePath = props.preview.target.value?.filePath || ''
  const lang = getFileType(filePath).lang || 'plaintext'
  const fullHtml = highlightCode(sliced.code, lang)
  const lineHtmls = splitHighlightedHtml(fullHtml)

  const result: FormattedCodeLine[] = []
  const start = sliced.startLine
  for (let i = 0; i < lineHtmls.length; i++) {
    const lineNum = start + i
    result.push({
      lineNum,
      html: lineHtmls[i],
      isTarget: isTargetLine(lineNum),
    })
  }
  return result
})

const getRelativeOffsetTop = (child: HTMLElement, parent: HTMLElement): number => {
  let top = 0
  let el: HTMLElement | null = child
  while (el && el !== parent) {
    top += el.offsetTop
    el = el.offsetParent as HTMLElement | null
  }
  return top
}

const scrollToTargetLine = () => {
  nextTick(() => {
    const scrollEl = scrollPaneRef.value || sheetScrollRef.value
    if (!scrollEl) return
    const targetEls = scrollEl.querySelectorAll('.code-preview-line-row.is-target-line')
    if (targetEls.length > 0) {
      const firstEl = targetEls[0] as HTMLElement
      const lastEl = targetEls[targetEls.length - 1] as HTMLElement
      const rangeTop = getRelativeOffsetTop(firstEl, scrollEl)
      const rangeBottom = getRelativeOffsetTop(lastEl, scrollEl) + lastEl.clientHeight
      const rangeHeight = rangeBottom - rangeTop
      const containerHeight = scrollEl.clientHeight
      const idealScrollTop = rangeHeight >= containerHeight
        ? rangeTop
        : rangeTop - Math.floor((containerHeight - rangeHeight) / 2)
      scrollEl.scrollTop = Math.max(0, idealScrollTop)
    }
  })
}

const cardStyle = computed(() => {
  if (dragX.value !== null && dragY.value !== null) {
    return {
      left: `${toFixedCSS(dragX.value)}px`,
      top: `${toFixedCSS(dragY.value)}px`,
    }
  }
  const plc = props.preview.placement.value
  if (plc) {
    const style: Record<string, string> = {
      left: plc.cssLeft,
      top: plc.cssTop,
    }
    if (plc.maxHeight && plc.maxHeight > 0) {
      style.maxHeight = `min(65vh, 480px, ${toFixedCSS(plc.maxHeight)}px)`
    }
    return style
  }
  const anchor = props.preview.target.value?.anchorEl
  if (anchor && typeof anchor.getBoundingClientRect === 'function') {
    const r = anchor.getBoundingClientRect()
    return {
      left: `${toFixedCSS(Math.max(16, r.left))}px`,
      top: `${toFixedCSS(r.bottom + 8)}px`,
    }
  }
  return {
    left: '16px',
    top: '60px',
  }
})

const handleCopy = async () => {
  const code = props.preview.slicedCode.value?.code
  if (!code) return

  try {
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(code)
    } else {
      const textarea = document.createElement('textarea')
      textarea.value = code
      textarea.style.position = 'fixed'
      textarea.style.opacity = '0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      textarea.remove()
    }
    copied.value = true
    setTimeout(() => {
      copied.value = false
    }, 1500)
  } catch {
    // ignore
  }
}

const handleViewDetails = () => {
  // If file is too large, trigger full open which in Clawbench leads to details/download
  props.preview.openFull()
}

const handleEscape = () => {
  const anchor = props.preview.target.value?.anchorEl
  props.preview.close()
  if (anchor && typeof anchor.focus === 'function' && document.body.contains(anchor)) {
    anchor.focus()
  }
}

// Drag handling
const onDragPointerDown = (e: PointerEvent) => {
  if (e.button !== 0) return
  if (!cardRef.value) return

  props.preview.pin()

  const cardRect = cardRef.value.getBoundingClientRect()
  startPointerX = e.clientX
  startPointerY = e.clientY
  startCardX = dragX.value !== null ? dragX.value : cardRect.left
  startCardY = dragY.value !== null ? dragY.value : cardRect.top

  dragX.value = startCardX
  dragY.value = startCardY
  isDragging = true

  const target = e.currentTarget as HTMLElement
  target.setPointerCapture(e.pointerId)
  target.addEventListener('pointermove', onDragPointerMove)
  target.addEventListener('pointerup', onDragPointerUp, { once: true })
  target.addEventListener('pointercancel', onDragPointerCancel, { once: true })

  document.body.classList.add('code-preview-dragging')
}

const onDragPointerMove = (e: PointerEvent) => {
  if (!isDragging || !cardRef.value) return
  const deltaX = e.clientX - startPointerX
  const deltaY = e.clientY - startPointerY
  const nextX = startCardX + deltaX
  const nextY = startCardY + deltaY

  requestAnimationFrame(() => {
    if (!cardRef.value || !isDragging) return
    const cardRect = cardRef.value.getBoundingClientRect()
    const clamped = clampCardPosition(nextX, nextY, cardRect.width, cardRect.height)
    dragX.value = clamped.viewportX
    dragY.value = clamped.viewportY
  })
}

const stopDragging = (e?: PointerEvent) => {
  if (!isDragging) return
  isDragging = false
  document.body.classList.remove('code-preview-dragging')

  if (e && e.currentTarget) {
    const target = e.currentTarget as HTMLElement
    try {
      target.releasePointerCapture(e.pointerId)
    } catch {
      // ignore
    }
    target.removeEventListener('pointermove', onDragPointerMove)
  }
}

const onDragPointerUp = (e: PointerEvent) => {
  stopDragging(e)
}

const onDragPointerCancel = (e: PointerEvent) => {
  stopDragging(e)
}

const syncPlacementWithCard = () => {
  if (!cardRef.value || dragX.value !== null || dragY.value !== null) return
  // If pinned and already has placement, keep current position so it doesn't jump on document scroll
  if (props.preview.mode.value === 'pinned' && props.preview.placement.value) return
  const anchor = props.preview.target.value?.anchorEl
  if (!anchor || typeof anchor.getBoundingClientRect !== 'function') return
  const cardRect = cardRef.value.getBoundingClientRect()
  if (cardRect.width > 0 && cardRect.height > 0) {
    props.preview.updatePlacement(anchor, cardRect.width, cardRect.height)
  }
}

const clampCurrentPosition = () => {
  if (!cardRef.value) return
  const cardRect = cardRef.value.getBoundingClientRect()
  if (dragX.value !== null && dragY.value !== null) {
    const clamped = clampCardPosition(dragX.value, dragY.value, cardRect.width, cardRect.height)
    dragX.value = clamped.viewportX
    dragY.value = clamped.viewportY
  } else {
    syncPlacementWithCard()
  }
}

// Reset custom dragged position when closing
watch(
  () => props.preview.visible.value,
  (vis) => {
    if (!vis) {
      dragX.value = null
      dragY.value = null
      stopDragging()
    } else {
      if (props.preview.status.value === 'ready') {
        scrollToTargetLine()
      }
      nextTick(() => {
        syncPlacementWithCard()
      })
    }
  }
)

// When target changes, clear drag position if not pinned and re-sync placement
watch(
  () => props.preview.target.value,
  () => {
    if (props.preview.mode.value !== 'pinned') {
      dragX.value = null
      dragY.value = null
    }
    nextTick(() => {
      syncPlacementWithCard()
    })
  }
)

// Re-sync placement when code loads or context changes (card height changes)
watch(
  () => props.preview.status.value,
  (st) => {
    if (st === 'ready') {
      scrollToTargetLine()
    }
    nextTick(() => {
      syncPlacementWithCard()
    })
  }
)

watch(
  codeLines,
  () => {
    if (props.preview.visible.value && props.preview.status.value === 'ready') {
      scrollToTargetLine()
    }
  }
)

watch(
  () => props.preview.contextExpansion.value,
  () => {
    nextTick(() => {
      syncPlacementWithCard()
    })
  }
)

// Dynamically observe cardRef with ResizeObserver whenever it mounts/unmounts
watch(
  () => cardRef.value,
  (newEl, oldEl) => {
    if (oldEl && resizeObserver) {
      resizeObserver.unobserve(oldEl)
    }
    if (newEl && resizeObserver) {
      resizeObserver.observe(newEl)
      nextTick(() => {
        syncPlacementWithCard()
      })
    }
  }
)

// Watch uiScale and window resize to maintain clamped position
watch(
  () => localConfig.uiScale,
  () => {
    nextTick(() => clampCurrentPosition())
  }
)

const onWindowResize = () => {
  clampCurrentPosition()
}

// Focus handling for F2
const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'F2' && props.preview.visible.value) {
    e.preventDefault()
    firstActionBtnRef.value?.focus()
  }
}

onMounted(() => {
  window.addEventListener('resize', onWindowResize)
  window.addEventListener('keydown', onKeyDown)

  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      clampCurrentPosition()
    })
    if (cardRef.value) {
      resizeObserver.observe(cardRef.value)
    }
  }
})

onBeforeUnmount(() => {
  stopDragging()
  window.removeEventListener('resize', onWindowResize)
  window.removeEventListener('keydown', onKeyDown)
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
})
</script>

<style scoped>
.code-preview-sheet-body {
  display: flex;
  flex-direction: column;
  height: 100%;
  max-height: 70dvh;
  overflow: hidden;
}

.code-preview-sheet-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-secondary, #f8f9fa);
  border-bottom: 1px solid var(--border-color, #e0e0e0);
  overflow-x: auto;
  flex-shrink: 0;
}

.code-preview-range-badge {
  color: var(--text-secondary, #888);
  font-weight: 400;
}

.code-preview-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(0, 0, 0, 0.1);
  border-top-color: var(--primary-color, #1a73e8);
  border-radius: 50%;
  animation: code-preview-spin 0.8s linear infinite;
}

@keyframes code-preview-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
