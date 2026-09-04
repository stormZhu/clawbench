/**
 * Composable for Markdown repository code link hover preview, pin, and drag.
 *
 * Responsibilities:
 * - Lifecycle & state machine: hidden / pending / transient / pinned / sheet
 * - 250ms hover delay & 200ms bridge leave delay
 * - Single active instance across screen
 * - Request generation tracking & AbortController to prevent race conditions
 * - Deduplication and LRU caching (previewCache)
 * - Switch: markdownCodeLinkPreview (default false)
 * - Touch detection ((hover: none), (pointer: coarse))
 */

import { ref, computed, watch, onUnmounted, getCurrentInstance, type Ref } from 'vue'
import { store } from '@/stores/app'
import { appLog } from '@/utils/appLog'
import { apiGet } from '@/utils/api'
import { openFilePath } from '@/composables/useFilePathAnnotation'
import { useSettingsConfig } from '@/composables/useSettingsConfig'
import {
  sliceCodeForPreview,
  buildPreviewUrl,
  placeNearAnchor,
  previewCache,
  LARGE_FILE_THRESHOLD_BYTES,
  type CodeSliceResult,
  type FileContentResponse,
  type CardPlacementResult,
} from '@/utils/codeLinkPreview'

export type PreviewStatus = 'idle' | 'loading' | 'ready' | 'error'
export type PreviewMode = 'transient' | 'pinned' | 'sheet'
export type PreviewErrorCode = 'binary' | 'too-large' | 'not-file' | 'not-found' | 'access-denied' | 'network'

export interface PreviewTarget {
  filePath: string
  lineStart?: number
  lineEnd?: number
  anchorEl?: HTMLElement
}

export interface UseCodeLinkPreviewOptions {
  containerRef?: Ref<HTMLElement | null>
}

export function useCodeLinkPreview(options: UseCodeLinkPreviewOptions = {}) {
  const { containerRef } = options
  const { localConfig } = useSettingsConfig()

  const enabled = computed(() => localConfig.markdownCodeLinkPreview === true)

  // Reactive preview state
  const visible = ref(false)
  const status = ref<PreviewStatus>('idle')
  const mode = ref<PreviewMode>('transient')
  const target = ref<PreviewTarget | null>(null)
  const fileContent = ref<FileContentResponse | null>(null)
  const slicedCode = ref<CodeSliceResult | null>(null)
  const errorCode = ref<PreviewErrorCode | null>(null)
  const errorMessage = ref<string | null>(null)
  const isLargeFile = ref(false)
  const contextExpansion = ref(0)
  const extraAboveLines = ref(0)
  const extraBelowLines = ref(0)
  const placement = ref<CardPlacementResult | null>(null)
  const isPinned = computed(() => mode.value === 'pinned')

  // Timers & concurrency
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let leaveTimer: ReturnType<typeof setTimeout> | null = null
  let currentRequestId = 0
  let currentAbortController: AbortController | null = null

  // Pointer & focus states
  let isPointerInTarget = false
  let isPointerInCard = false
  let isTargetFocused = false
  let isCardFocused = false

  const clearPendingTimer = () => {
    if (pendingTimer) {
      clearTimeout(pendingTimer)
      pendingTimer = null
    }
  }

  const clearLeaveTimer = () => {
    if (leaveTimer) {
      clearTimeout(leaveTimer)
      leaveTimer = null
    }
  }

  const isTouchDevice = (): boolean => {
    if (typeof window === 'undefined' || typeof window.matchMedia === 'undefined') return false
    return window.matchMedia('(hover: none), (pointer: coarse)').matches
  }

  const updateSlice = () => {
    if (!fileContent.value) return
    slicedCode.value = sliceCodeForPreview(
      fileContent.value.content,
      target.value?.lineStart,
      target.value?.lineEnd,
      {
        contextExpansion: contextExpansion.value,
        expandAboveLines: extraAboveLines.value,
        expandBelowLines: extraBelowLines.value,
      }
    )
  }

  const updatePlacement = (anchorEl?: HTMLElement, customWidth?: number, customHeight?: number) => {
    const el = anchorEl || target.value?.anchorEl
    if (!el || typeof el.getBoundingClientRect !== 'function') return
    const rect = el.getBoundingClientRect()
    // Realistic card dimensions (compact initial estimate before DOM measurement)
    const cardWidth = customWidth ?? Math.min(640, typeof window !== 'undefined' ? window.innerWidth - 24 : 640)
    const cardHeight = customHeight ?? Math.min(260, typeof window !== 'undefined' ? Math.min(260, window.innerHeight * 0.4) : 240)
    placement.value = placeNearAnchor(rect, cardWidth, cardHeight)
  }

  const fetchPreview = async (newTarget: PreviewTarget, forceRefresh = false) => {
    const reqId = ++currentRequestId
    if (currentAbortController) {
      currentAbortController.abort()
    }
    currentAbortController = new AbortController()
    const signal = currentAbortController.signal

    status.value = 'loading'
    errorCode.value = null
    errorMessage.value = null
    isLargeFile.value = false

    const projectRoot = store.state.projectRoot || ''
    const cacheKey = previewCache.buildKey(projectRoot, newTarget.filePath)

    if (forceRefresh) {
      previewCache.delete(cacheKey)
    } else {
      const cached = previewCache.get(cacheKey)
      if (cached) {
        if (reqId !== currentRequestId) return
        fileContent.value = cached
        isLargeFile.value = (cached.size ?? 0) > LARGE_FILE_THRESHOLD_BYTES
        updateSlice()
        status.value = 'ready'
        return
      }
    }

    try {
      const url = buildPreviewUrl(newTarget.filePath)
      const resp = await apiGet<FileContentResponse>(url, { signal, timeoutMs: 10_000 })
      if (reqId !== currentRequestId) return

      if (resp.isBinary) {
        status.value = 'error'
        errorCode.value = 'binary'
        return
      }

      fileContent.value = resp
      isLargeFile.value = (resp.size ?? 0) > LARGE_FILE_THRESHOLD_BYTES
      if (!isLargeFile.value) {
        previewCache.set(cacheKey, resp)
      }

      updateSlice()
      status.value = 'ready'
    } catch (err: unknown) {
      if (reqId !== currentRequestId) return
      const errObj = err as { name?: string; msgKey?: string; message?: string; status?: number }
      if (errObj?.name === 'AbortError' || signal.aborted) {
        // Aborted silently
        return
      }
      appLog.w('CodeLinkPreview', 'Failed to fetch file content for preview', { path: newTarget.filePath, error: err })
      status.value = 'error'
      const msgKey = errObj?.msgKey || ''
      const msg = errObj?.message || ''
      if (msgKey === 'FileTooLarge' || msg.includes('too large') || errObj?.status === 413) {
        errorCode.value = 'too-large'
      } else if (msgKey === 'NotAFile') {
        errorCode.value = 'not-file'
      } else if (msgKey === 'FileNotFoundShort' || msgKey === 'FileNotFound' || msg.includes('not found')) {
        errorCode.value = 'not-found'
        previewCache.delete(cacheKey)
      } else if (msgKey === 'AccessDenied' || msg.includes('Access denied')) {
        errorCode.value = 'access-denied'
      } else {
        errorCode.value = 'network'
        errorMessage.value = msg || 'Network error'
      }
    }
  }

  const showPreview = (newTarget: PreviewTarget, previewMode: PreviewMode = 'transient') => {
    if (!enabled.value) return

    clearPendingTimer()
    clearLeaveTimer()

    const wasPinned = mode.value === 'pinned'
    target.value = newTarget
    mode.value = wasPinned && previewMode !== 'sheet' ? 'pinned' : previewMode
    contextExpansion.value = 0
    extraAboveLines.value = 0
    extraBelowLines.value = 0
    visible.value = true

    if (mode.value !== 'sheet') {
      updatePlacement(newTarget.anchorEl)
    }

    fetchPreview(newTarget)
  }

  const close = (opts: { clearCache?: boolean } = {}) => {
    clearPendingTimer()
    clearLeaveTimer()

    if (currentAbortController) {
      currentAbortController.abort()
      currentAbortController = null
    }

    visible.value = false
    status.value = 'idle'
    target.value = null
    fileContent.value = null
    slicedCode.value = null
    errorCode.value = null
    errorMessage.value = null
    isLargeFile.value = false
    contextExpansion.value = 0
    extraAboveLines.value = 0
    extraBelowLines.value = 0
    placement.value = null
    mode.value = 'transient'

    isPointerInTarget = false
    isPointerInCard = false
    isTargetFocused = false
    isCardFocused = false

    if (opts.clearCache) {
      previewCache.clear()
    }
  }

  const checkAndClose = () => {
    if (mode.value === 'pinned' || mode.value === 'sheet') return
    if (!isPointerInTarget && !isPointerInCard && !isTargetFocused && !isCardFocused) {
      close()
    }
  }

  const pin = () => {
    if (!visible.value || mode.value === 'sheet') return
    mode.value = 'pinned'
    clearLeaveTimer()
  }

  const unpin = () => {
    if (!visible.value || mode.value === 'sheet') return
    mode.value = 'transient'
    clearLeaveTimer()
    leaveTimer = setTimeout(() => checkAndClose(), 200)
  }

  const togglePin = () => {
    if (mode.value === 'pinned') unpin()
    else pin()
  }

  const refresh = () => {
    if (!target.value) return
    fetchPreview(target.value, true)
  }

  const expandContext = () => {
    contextExpansion.value += 1
    updateSlice()
  }

  const shrinkContext = () => {
    if (contextExpansion.value <= 0 && extraAboveLines.value <= 0 && extraBelowLines.value <= 0) return
    if (contextExpansion.value > 0) contextExpansion.value -= 1
    extraAboveLines.value = Math.max(0, extraAboveLines.value - 5)
    extraBelowLines.value = Math.max(0, extraBelowLines.value - 5)
    updateSlice()
  }

  const expandAbove = (count = 10) => {
    extraAboveLines.value += Math.max(1, count)
    updateSlice()
  }

  const expandBelow = (count = 10) => {
    extraBelowLines.value += Math.max(1, count)
    updateSlice()
  }

  const expandToTop = () => {
    if (!slicedCode.value) return
    const remaining = Math.max(0, slicedCode.value.startLine - 1)
    if (remaining > 0) {
      extraAboveLines.value += remaining
      updateSlice()
    }
  }

  const expandToBottom = () => {
    if (!slicedCode.value) return
    const remaining = Math.max(0, slicedCode.value.totalLines - slicedCode.value.endLine)
    if (remaining > 0) {
      extraBelowLines.value += remaining
      updateSlice()
    }
  }

  const openFull = () => {
    if (!target.value) return
    const { filePath, lineStart, lineEnd } = target.value
    openFilePath(filePath, lineStart, lineEnd)
    close()
  }

  // Card pointer/focus events
  const onCardPointerEnter = () => {
    isPointerInCard = true
    clearLeaveTimer()
  }

  const onCardPointerLeave = () => {
    isPointerInCard = false
    if (mode.value === 'transient') {
      clearLeaveTimer()
      leaveTimer = setTimeout(() => checkAndClose(), 200)
    }
  }

  const onCardFocusIn = () => {
    isCardFocused = true
    clearLeaveTimer()
  }

  const onCardFocusOut = (_e: FocusEvent) => {
    isCardFocused = false
    if (mode.value === 'transient') {
      clearLeaveTimer()
      leaveTimer = setTimeout(() => checkAndClose(), 200)
    }
  }

  // Target extraction helper
  const extractTargetFromElement = (el: HTMLElement): PreviewTarget | null => {
    const targetEl = el.closest<HTMLElement>('.chat-file-path[data-file-path], .chat-file-open-btn[data-file-path]')
    if (!targetEl) return null

    // Check verification status: must be file, not dir or unverified
    const pathType = targetEl.getAttribute('data-path-type')
    if (pathType !== 'file') return null

    const filePath = targetEl.getAttribute('data-file-path')
    if (!filePath) return null

    const startAttr = targetEl.getAttribute('data-line-start')
    const endAttr = targetEl.getAttribute('data-line-end')
    const lineStart = startAttr ? parseInt(startAttr, 10) : undefined
    const lineEnd = endAttr ? parseInt(endAttr, 10) : undefined

    return {
      filePath,
      lineStart,
      lineEnd,
      anchorEl: targetEl,
    }
  }

  // Container event delegation
  const handleMouseOver = (e: MouseEvent) => {
    if (!enabled.value) return
    if (isTouchDevice()) return

    const targetEl = (e.target as HTMLElement)?.closest<HTMLElement>('.chat-file-path[data-file-path], .chat-file-open-btn[data-file-path]')
    if (!targetEl) return

    // Avoid synthetic events if relatedTarget is within same targetEl
    const related = e.relatedTarget as HTMLElement | null
    if (related && targetEl.contains(related)) return

    const extracted = extractTargetFromElement(targetEl)
    if (!extracted) return

    isPointerInTarget = true
    clearLeaveTimer()

    // If currently pinned, normal hover is ignored
    if (mode.value === 'pinned') return

    // If target already matches, do nothing
    if (visible.value && target.value?.filePath === extracted.filePath && target.value?.lineStart === extracted.lineStart) {
      return
    }

    clearPendingTimer()
    pendingTimer = setTimeout(() => {
      showPreview(extracted, 'transient')
    }, 250)
  }

  const handleMouseOut = (e: MouseEvent) => {
    if (!enabled.value) return
    const targetEl = (e.target as HTMLElement)?.closest<HTMLElement>('.chat-file-path[data-file-path], .chat-file-open-btn[data-file-path]')
    if (!targetEl) return

    const related = e.relatedTarget as HTMLElement | null
    if (related && targetEl.contains(related)) return

    isPointerInTarget = false
    clearPendingTimer()

    if (mode.value === 'transient') {
      clearLeaveTimer()
      leaveTimer = setTimeout(() => checkAndClose(), 200)
    }
  }

  const handleFocusIn = (e: FocusEvent) => {
    if (!enabled.value) return
    const targetEl = (e.target as HTMLElement)?.closest<HTMLElement>('a.chat-file-path[data-file-path], button.chat-file-open-btn[data-file-path]')
    if (!targetEl) return

    const extracted = extractTargetFromElement(targetEl)
    if (!extracted) return

    isTargetFocused = true
    clearLeaveTimer()

    if (mode.value === 'pinned') return

    showPreview(extracted, 'transient')
  }

  const handleFocusOut = (_e: FocusEvent) => {
    if (!enabled.value) return
    isTargetFocused = false
    if (mode.value === 'transient') {
      clearLeaveTimer()
      leaveTimer = setTimeout(() => checkAndClose(), 200)
    }
  }

  const handleClick = (e: MouseEvent) => {
    if (!enabled.value) return

    const targetEl = (e.target as HTMLElement)?.closest<HTMLElement>('.chat-file-path[data-file-path], .chat-file-open-btn[data-file-path]')
    if (!targetEl) return

    const extracted = extractTargetFromElement(targetEl)
    if (!extracted) return

    const isModifier = e.ctrlKey || e.metaKey

    // 1. Ctrl / Cmd + Click: toggle or replace with pinned preview
    if (isModifier) {
      e.preventDefault()
      e.stopPropagation()
      showPreview(extracted, 'pinned')
      return
    }

    // 2. Touch tap on path text -> open BottomSheet
    if (isTouchDevice()) {
      const isPathText = targetEl.classList.contains('chat-file-path')
      if (isPathText) {
        e.preventDefault()
        e.stopPropagation()
        showPreview(extracted, 'sheet')
        return
      }
      // Tap on open button -> let ordinary handleClick in MarkdownPreview handle openFilePath
    }
  }

  // Bind delegation to container
  const bindEvents = (el: HTMLElement | null) => {
    if (!el) return
    el.addEventListener('mouseover', handleMouseOver)
    el.addEventListener('mouseout', handleMouseOut)
    el.addEventListener('focusin', handleFocusIn)
    el.addEventListener('focusout', handleFocusOut)
    el.addEventListener('click', handleClick, true)
  }

  const unbindEvents = (el: HTMLElement | null) => {
    if (!el) return
    el.removeEventListener('mouseover', handleMouseOver)
    el.removeEventListener('mouseout', handleMouseOut)
    el.removeEventListener('focusin', handleFocusIn)
    el.removeEventListener('focusout', handleFocusOut)
    el.removeEventListener('click', handleClick, true)
  }

  if (containerRef) {
    watch(
      () => containerRef.value,
      (newEl, oldEl) => {
        if (oldEl) unbindEvents(oldEl)
        if (newEl && enabled.value) bindEvents(newEl)
      },
      { immediate: true }
    )
  }

  // Watch switch state: when turned off, close immediately and clear cache
  watch(enabled, (on) => {
    if (!on) {
      close({ clearCache: true })
      if (containerRef?.value) unbindEvents(containerRef.value)
    } else {
      if (containerRef?.value) bindEvents(containerRef.value)
    }
  })

  // Watch file changes in store: close preview when user switches Markdown file
  watch(
    () => store.state.currentFile?.path,
    () => {
      close({ clearCache: false })
    }
  )

  if (getCurrentInstance()) {
    onUnmounted(() => {
      close()
      if (containerRef?.value) unbindEvents(containerRef.value)
    })
  }

  return {
    enabled,
    visible,
    status,
    mode,
    isPinned,
    target,
    fileContent,
    slicedCode,
    errorCode,
    errorMessage,
    isLargeFile,
    contextExpansion,
    extraAboveLines,
    extraBelowLines,
    placement,
    showPreview,
    close,
    pin,
    unpin,
    togglePin,
    refresh,
    expandContext,
    shrinkContext,
    expandAbove,
    expandBelow,
    expandToTop,
    expandToBottom,
    openFull,
    onCardPointerEnter,
    onCardPointerLeave,
    onCardFocusIn,
    onCardFocusOut,
    handleMouseOver,
    handleMouseOut,
    handleFocusIn,
    handleFocusOut,
    handleClick,
    updatePlacement,
    bindEvents,
    unbindEvents,
  }
}
