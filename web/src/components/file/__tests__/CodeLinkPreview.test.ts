import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { ref, reactive, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'
import CodeLinkPreview from '@/components/file/CodeLinkPreview.vue'
import type { useCodeLinkPreview } from '@/composables/useCodeLinkPreview'

// Mock highlightCode
vi.mock('@/utils/globals', () => ({
  highlightCode: (code: string) => `<span class="hl">${code}</span>`,
}))

// Mock fileType
vi.mock('@/utils/fileType', () => ({
  getFileType: () => ({ lang: 'typescript' }),
}))

// Mock settings config
const mockLocalConfig = reactive<Record<string, any>>({
  uiScale: 1,
  markdownCodeLinkPreview: true,
})
vi.mock('@/composables/useSettingsConfig', () => ({
  useSettingsConfig: () => ({
    localConfig: mockLocalConfig,
  }),
  toFixedCSS: (val: number) => val,
  getZoomedViewport: () => ({ width: 1024, height: 768 }),
}))

const i18n = createI18n({
  legacy: false,
  locale: 'en',
  messages: {
    en: {
      file: {
        codePreview: {
          title: 'Code Preview',
          copy: 'Copy code',
          copied: 'Copied',
          refresh: 'Refresh',
          pin: 'Pin preview',
          unpin: 'Unpin preview',
          openFull: 'Open full file',
          viewDetails: 'View details / Download',
          close: 'Close preview',
          expand: 'Expand context (+5)',
          shrink: 'Shrink context (-5)',
          wrap: 'Wrap lines',
          unwrap: 'Unwrap lines',
          loading: 'Loading code...',
          retry: 'Retry',
          largeFileNotice: 'Large file: preview shows partial content and may load slower',
          truncatedNotice: 'Preview truncated (up to {n} lines / {size})',
          lineOutOfRange: 'Requested line is out of file range',
          binaryNotSupported: 'Binary file cannot be previewed',
          fileTooLarge: 'File exceeds 10MiB limit, cannot be previewed online',
          dirNotSupported: 'Directories cannot be previewed as code',
          notFound: 'File not found',
          accessDenied: 'Access denied',
          loadError: 'Failed to load code',
        },
      },
    },
  },
})

function createMockPreviewController(overrides: Partial<ReturnType<typeof useCodeLinkPreview>> = {}) {
  const visible = ref(true)
  const status = ref<'idle' | 'loading' | 'ready' | 'error'>('ready')
  const mode = ref<'transient' | 'pinned' | 'sheet'>('transient')
  const isPinned = ref(false)
  const target = ref<any>({
    filePath: 'src/main.ts',
    lineStart: 10,
    lineEnd: 20,
    anchorEl: document.createElement('span'),
  })
  const fileContent = ref<any>({
    content: 'line 1\nline 2',
    name: 'main.ts',
    path: 'src/main.ts',
    supported: true,
    size: 20,
  })
  const slicedCode = ref<any>({
    code: 'const x = 10\nconst y = 20',
    startLine: 10,
    endLine: 11,
    totalLines: 50,
    highlightStart: 10,
    highlightEnd: 10,
    lineOutOfRange: false,
    renderTruncated: false,
  })
  const errorCode = ref<any>(null)
  const errorMessage = ref<string | null>(null)
  const isLargeFile = ref(false)
  const contextExpansion = ref(0)
  const placement = ref<any>({
    viewportX: 100,
    viewportY: 100,
    cssLeft: '100px',
    cssTop: '100px',
    quadrant: 'bottom-right',
  })

  return {
    enabled: ref(true),
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
    placement,
    showPreview: vi.fn(),
    close: vi.fn(() => {
      visible.value = false
    }),
    pin: vi.fn(() => {
      isPinned.value = true
      mode.value = 'pinned'
    }),
    unpin: vi.fn(() => {
      isPinned.value = false
      mode.value = 'transient'
    }),
    togglePin: vi.fn(() => {
      if (isPinned.value) {
        isPinned.value = false
        mode.value = 'transient'
      } else {
        isPinned.value = true
        mode.value = 'pinned'
      }
    }),
    refresh: vi.fn(),
    expandContext: vi.fn(),
    shrinkContext: vi.fn(),
    openFull: vi.fn(),
    onCardPointerEnter: vi.fn(),
    onCardPointerLeave: vi.fn(),
    onCardFocusIn: vi.fn(),
    onCardFocusOut: vi.fn(),
    handleMouseOver: vi.fn(),
    handleMouseOut: vi.fn(),
    handleFocusIn: vi.fn(),
    handleFocusOut: vi.fn(),
    handleClick: vi.fn(),
    updatePlacement: vi.fn(),
    bindEvents: vi.fn(),
    unbindEvents: vi.fn(),
    ...overrides,
  } as unknown as ReturnType<typeof useCodeLinkPreview>
}

describe('CodeLinkPreview.vue', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    localStorage.clear()
  })

  it('renders loading status with aria-live="polite"', () => {
    const preview = createMockPreviewController({
      status: ref('loading'),
    })
    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating')
    expect(floating).not.toBeNull()
    const loadingEl = floating?.querySelector('[aria-live="polite"]')
    expect(loadingEl).not.toBeNull()
    expect(loadingEl?.textContent).toContain('Loading code...')
  })

  it('renders code snippet, line numbers, and highlight target background', () => {
    const preview = createMockPreviewController({
      status: ref('ready'),
      slicedCode: ref({
        code: 'const a = 1\nconst b = 2',
        startLine: 10,
        endLine: 11,
        totalLines: 50,
        highlightStart: 10,
        highlightEnd: 10,
        lineOutOfRange: false,
        renderTruncated: false,
      }),
    })

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating')
    expect(floating).not.toBeNull()

    // Gutter line numbers
    const lineNumbers = floating?.querySelectorAll('.code-preview-line-number')
    expect(lineNumbers?.length).toBe(2)
    expect(lineNumbers?.[0].textContent?.trim()).toBe('10')
    expect(lineNumbers?.[0].classList.contains('is-target-line')).toBe(true)
    expect(lineNumbers?.[1].textContent?.trim()).toBe('11')
    expect(lineNumbers?.[1].classList.contains('is-target-line')).toBe(false)

    // Code content
    const codeEl = floating?.querySelector('code.hljs')
    expect(codeEl).not.toBeNull()
    expect(codeEl?.textContent).toContain('const a = 1')
  })

  it('renders large file notice when isLargeFile is true', () => {
    const preview = createMockPreviewController({
      isLargeFile: ref(true),
    })
    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const notice = document.querySelector('.code-preview-notice.notice-warning')
    expect(notice).not.toBeNull()
    expect(notice?.textContent).toContain('Large file')
  })

  it('renders binary file error with open full file button', () => {
    const preview = createMockPreviewController({
      status: ref('error'),
      errorCode: ref('binary'),
    })
    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating')
    expect(floating?.textContent).toContain('Binary file cannot be previewed')
    // Header openFull button is still available
    const openBtn = floating?.querySelector('button[title="Open full file"]')
    expect(openBtn).not.toBeNull()
  })

  it('renders too-large error with view details button instead of openFull', () => {
    const preview = createMockPreviewController({
      status: ref('error'),
      errorCode: ref('too-large'),
    })
    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating')
    expect(floating?.textContent).toContain('File exceeds 10MiB limit')
    const detailsBtn = floating?.querySelector('button[title="View details / Download"]')
    expect(detailsBtn).not.toBeNull()
    const openFullBtn = floating?.querySelector('button[title="Open full file"]')
    expect(openFullBtn).toBeNull()
  })

  it('toggles pin and updates aria-pressed', async () => {
    const isPinned = ref(false)
    const mode = ref<'transient' | 'pinned' | 'sheet'>('transient')
    const preview = createMockPreviewController({
      isPinned,
      mode,
      togglePin: vi.fn(() => {
        isPinned.value = !isPinned.value
        mode.value = isPinned.value ? 'pinned' : 'transient'
      }),
    })

    const wrapper = mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const pinBtn = document.querySelector('button[title="Pin preview"]') as HTMLButtonElement
    expect(pinBtn).not.toBeNull()
    expect(pinBtn.getAttribute('aria-pressed')).toBe('false')

    pinBtn.click()
    expect(preview.togglePin).toHaveBeenCalled()
  })

  it('renders BottomSheet when in sheet mode', () => {
    const preview = createMockPreviewController({
      mode: ref('sheet'),
    })

    const wrapper = mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    // In sheet mode, teleported floating dialog is not rendered
    expect(document.querySelector('.code-link-preview-floating')).toBeNull()
    // BottomSheet component is rendered
    expect(wrapper.findComponent({ name: 'BottomSheet' }).exists()).toBe(true)
  })

  it('handles Escape to close and focus origin', () => {
    const anchor = document.createElement('a')
    document.body.appendChild(anchor)
    anchor.focus = vi.fn()

    const preview = createMockPreviewController({
      target: ref({
        filePath: 'test.ts',
        anchorEl: anchor,
      }),
    })

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating') as HTMLElement
    floating.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

    expect(preview.close).toHaveBeenCalled()
    expect(anchor.focus).toHaveBeenCalled()
  })

  it('triggers context expansion and shrinking on button clicks', async () => {
    const preview = createMockPreviewController({
      contextExpansion: ref(1),
    })

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating') as HTMLElement
    const expandBtn = floating.querySelector('button[title="Expand context (+5)"]') as HTMLButtonElement
    const shrinkBtn = floating.querySelector('button[title="Shrink context (-5)"]') as HTMLButtonElement

    expect(expandBtn).not.toBeNull()
    expect(shrinkBtn).not.toBeNull()

    expandBtn.click()
    expect(preview.expandContext).toHaveBeenCalled()

    shrinkBtn.click()
    expect(preview.shrinkContext).toHaveBeenCalled()
  })

  it('supports header dragging with pointer events', () => {
    const preview = createMockPreviewController()

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const header = document.querySelector('.code-preview-header') as HTMLElement
    expect(header).not.toBeNull()

    // Mock setPointerCapture and releasePointerCapture
    header.setPointerCapture = vi.fn()
    header.releasePointerCapture = vi.fn()

    header.dispatchEvent(new PointerEvent('pointerdown', { clientX: 100, clientY: 100, pointerId: 1, bubbles: true }))
    expect(header.setPointerCapture).toHaveBeenCalledWith(1)

    window.dispatchEvent(new PointerEvent('pointermove', { clientX: 150, clientY: 160 }))
    const floating = document.querySelector('.code-link-preview-floating') as HTMLElement
    expect(floating.style.left).toBeDefined()

    header.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }))
    expect(header.releasePointerCapture).toHaveBeenCalledWith(1)
  })

  it('handles F2 shortcut to focus first action button', () => {
    const preview = createMockPreviewController()

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const copyBtn = document.querySelector('button[title="Copy code"]') as HTMLButtonElement
    expect(copyBtn).not.toBeNull()
    copyBtn.focus = vi.fn()

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2' }))

    expect(copyBtn.focus).toHaveBeenCalled()
  })

  it('toggles word-wrap and updates class and aria-pressed', async () => {
    const preview = createMockPreviewController()

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const wrapBtn = document.querySelector('button[title="Wrap lines"]') as HTMLButtonElement
    expect(wrapBtn).not.toBeNull()
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('false')

    const scrollPane = document.querySelector('.code-preview-scroll') as HTMLElement
    expect(scrollPane.classList.contains('is-word-wrap')).toBe(false)

    // Click toggle
    wrapBtn.click()
    await nextTick()

    expect(scrollPane.classList.contains('is-word-wrap')).toBe(true)
    expect(wrapBtn.getAttribute('aria-pressed')).toBe('true')
  })

  it('centers target line on scrollPane when ready', async () => {
    const preview = createMockPreviewController({
      status: ref('ready'),
      slicedCode: ref({
        code: Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n'),
        startLine: 1,
        endLine: 50,
        totalLines: 100,
        highlightStart: 25,
        highlightEnd: 25,
        lineOutOfRange: false,
        renderTruncated: false,
      }),
    })

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const scrollPane = document.querySelector('.code-preview-scroll') as HTMLElement
    expect(scrollPane).not.toBeNull()

    // Mock clientHeight and offsetTop for testing scroll calculation
    Object.defineProperty(scrollPane, 'clientHeight', { value: 300, configurable: true })
    let mockScrollTop = 0
    Object.defineProperty(scrollPane, 'scrollTop', {
      get: () => mockScrollTop,
      set: (val: number) => {
        mockScrollTop = val
      },
      configurable: true,
    })

    const targetRow = scrollPane.querySelector('.code-preview-line-row.is-target-line') as HTMLElement
    expect(targetRow).not.toBeNull()
    Object.defineProperty(targetRow, 'clientHeight', { value: 20, configurable: true })
    Object.defineProperty(targetRow, 'offsetTop', { value: 480, configurable: true })

    const wrapBtn = document.querySelector('button[title="Wrap lines"]') as HTMLButtonElement
    expect(wrapBtn).not.toBeNull()
    wrapBtn.click()
    await nextTick()
    await nextTick()

    // Target line offsetTop=480, containerHeight=300, targetHeight=20 -> (300-20)/2 = 140 -> scrollTop = 480 - 140 = 340
    expect(scrollPane.scrollTop).toBe(340)
  })

  it('applies dynamic maxHeight to cardStyle when placement.maxHeight is present', () => {
    const preview = createMockPreviewController({
      placement: ref({
        viewportX: 100,
        viewportY: 60,
        cssLeft: '100px',
        cssTop: '60px',
        maxHeight: 320,
        quadrant: 'clamped',
      }),
    })

    mount(CodeLinkPreview, {
      props: { preview },
      global: { plugins: [i18n] },
    })

    const floating = document.querySelector('.code-link-preview-floating') as HTMLElement
    expect(floating).not.toBeNull()
    expect(floating.style.maxHeight).toContain('320px')
  })
})
