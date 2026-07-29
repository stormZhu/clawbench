import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick, reactive } from 'vue'
import { createI18n } from 'vue-i18n'
import ContentBlocks from '@/components/chat/ContentBlocks.vue'

// ── Mocks ──

vi.mock('@/utils/renderToolDetail.ts', () => ({
  handleToolAction: vi.fn().mockReturnValue(false),
  shouldAutoExpandTool: (name: string) => name === 'AskUserQuestion' || name === 'PermissionApproval',
}))

vi.mock('@/utils/icons', () => ({
  getToolIcon: (name: string) => {
    const map: Record<string, { icon: any; category: string }> = {
      Read: { icon: 'EyeIcon', category: 'file' },
      Bash: { icon: 'TerminalIcon', category: 'bash' },
      AskUserQuestion: { icon: 'AskIcon', category: 'ask' },
      PermissionApproval: { icon: 'ShieldIcon', category: 'permission' },
    }
    return map[name] || { icon: 'WrenchIcon', category: 'fallback' }
  },
  toolDisplayName: (name: string) => name,
}))

vi.mock('@/composables/useMarkdownRenderer.ts', () => ({
  // Complete path (done/history): full enhancements
  renderMarkdown: (text: string) => ({
    html: `<p data-complete="1">${text}</p>`,
    detectedPaths: [],
    detectedSHAs: [],
  }),
  // Live streaming path: lightweight when skipEnhancements
  renderMarkdownHtml: (text: string, opts?: { skipEnhancements?: boolean }) =>
    opts?.skipEnhancements
      ? `<p data-lite="1">${text}</p>`
      : `<p data-full="1">${text}</p>`,
}))

vi.mock('@/composables/useFilePathAnnotation.ts', () => ({
  useFilePathAnnotation: () => ({
    verifyFilePaths: vi.fn(),
    openFilePath: vi.fn(),
  }),
  annotateFilePaths: (html: string) => ({ html, detectedPaths: [] }),
}))

vi.mock('@/composables/useCommitHashAnnotation.ts', () => ({
  useCommitHashAnnotation: () => ({
    verifyCommitHashes: vi.fn(),
  }),
  annotateCommitHashes: (html: string) => ({ html, detectedSHAs: [] }),
}))

vi.mock('@/utils/appLog', () => ({
  appLog: { d: vi.fn(), i: vi.fn(), w: vi.fn(), e: vi.fn() },
}))

vi.mock('@/utils/contentBlocks.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/contentBlocks.ts')>()
  return {
    ...actual,
    isSevereWarning: (block: any) => block.reason === 'disconnect',
    isRetriableWarning: (block: any) =>
      block.reason === 'request_failed' ||
      block.reason === 'disconnect' ||
      block.reason === 'backend_exit' ||
      (block.type === 'error' && !block.reason),
    getWarningText: (block: any) => block.text || block.reason || '',
    getRetryText: (block: any) => `Retrying (${block.attempt}/${block.maxAttempts})…: ${block.text || ''}`,
    statusClass: (task: any) => `status-${task.status}`,
    statusLabel: (task: any, t: any) => task.status,
    statusLabelSimple: (task: any, t: any) => task.status,
    formatTime: (iso: any) => iso,
    askQuestionSummary: (input: any) => input?.question || '',
    blockKey: (msgId: any, bi: number) => `${msgId}:${bi}`,
    blockTaskKey: (msgId: any, bi: number) => `${msgId}-${bi}`,
    buildTaskKeyIndex: () => ({}),
    hasScheduledTasks: () => false,
    scheduledTaskKeys: () => [],
    extractAtCommand: (text: string) => {
      if (text.startsWith('@chatsearch')) return { command: '@chatsearch', rest: text.slice(11) }
      if (text.startsWith('@task')) return { command: '@task', rest: text.slice(5) }
      return null
    },
    extractSlashCommand: (text: string) => {
      if (text.startsWith('/')) {
        const parts = text.split(' ')
        return { command: parts[0], rest: parts.slice(1).join(' ') }
      }
      return null
    },
  }
})

const i18n = createI18n({
  legacy: false, locale: 'en',
  messages: { en: {
    chat: {
      message: { deepThinking: 'Deep Thinking', thinkingInProgress: 'in progress' },
      contentBlocks: {
        cancelled: 'Cancelled',
        loading: 'Loading...',
        scheduledTaskCreated: 'Task created',
        frequency: 'Frequency',
        executor: 'Executor',
        repeat: 'Repeat',
        status: 'Status',
        lastRun: 'Last run',
        nextRun: 'Next run',
        viewDetail: 'View detail',
        taskDeleted: 'Task deleted',
        retry: 'Retry', retrying: 'Retrying…', retryingAttempt: 'Retrying ({n}/{max})…',
        retryingAttemptOnly: 'Retrying (#{n})…',
        autoRetryBadge: 'Auto-retry',
        waitingForResponse: 'Waiting for AI response…',
        waitingElapsedSec: 'Waited {n}s',
        waitingElapsedMinSec: 'Waited {m}m {s}s',
        waitingSlowHint: 'Taking longer than usual. You can cancel and retry.',
        errorHints: {
          networkGrok: 'Cannot reach Grok API (network/proxy). Check connectivity and retry.',
          networkGeneric: 'Network request failed. Check connectivity and retry.',
        },
        ragUntitled: 'Untitled',
      },
    },
    tool: {
      askUser: { name: 'Ask' },
      permission: {
        approved: 'Approved',
        approvedOnce: 'Approved · Once',
        approvedSession: 'Approved · Session',
        approvedRemember: 'Approved · Remember',
        denied: 'Denied',
        deniedAlways: 'Denied · Always',
        autoApproved: 'Auto-Approved',
      },
    },
  } },
})

const LucideStub = { template: '<span class="lucide-stub" />' }

function mountBlocks(props: Record<string, unknown> = {}) {
  return mount(ContentBlocks, {
    props: {
      blocks: [],
      msgId: 'msg-1',
      renderTextBlock: (text: string) => `<p>${text}</p>`,
      formatToolInput: () => '',
      toolCallSummary: () => '',
      ...props,
    },
    global: {
      plugins: [i18n],
      stubs: {
        'lucide-vue-next': LucideStub,
        Brain: LucideStub,
        ChevronRight: LucideStub,
        CheckCircle2: LucideStub,
        AlertCircle: LucideStub,
        AlertTriangle: LucideStub,
        XCircle: LucideStub,
      },
    },
  })
}

describe('ContentBlocks', () => {
  // ── Text blocks ──

  describe('text blocks', () => {
    it('renders a text block', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Hello world' }],
      })
      expect(wrapper.find('.content-blocks').exists()).toBe(true)
      expect(wrapper.html()).toContain('Hello world')
    })

    it('renders @chatsearch badge for text starting with @chatsearch', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: '@chatsearch how to do X' }],
      })
      expect(wrapper.find('.at-command-badge').exists()).toBe(true)
      expect(wrapper.find('.at-command-badge').text()).toBe('@chatsearch')
    })

    it('renders @task badge for text starting with @task', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: '@task run tests' }],
      })
      expect(wrapper.find('.at-command-badge').exists()).toBe(true)
    })

    it('renders slash command badge for text starting with /', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: '/commit fix bug' }],
      })
      expect(wrapper.find('.slash-command-badge').exists()).toBe(true)
      expect(wrapper.find('.slash-command-badge').text()).toBe('/commit')
    })
  })

  // ── Tool use blocks ──

  describe('tool_use blocks', () => {
    it('renders a tool call bar', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'Read', done: true, status: 'success' }],
      })
      expect(wrapper.find('.chat-tool-call').exists()).toBe(true)
    })

    it('shows spinner when tool is not done', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'Read', done: false, status: '' }],
      })
      expect(wrapper.find('.tool-spinner').exists()).toBe(true)
    })

    it('shows check icon when tool is done', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'Read', done: true, status: 'success' }],
      })
      expect(wrapper.find('.tool-check').exists()).toBe(true)
    })

    it('shows error icon when tool has error status', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'Read', done: true, status: 'error' }],
      })
      expect(wrapper.find('.tool-error-icon').exists()).toBe(true)
    })

    it('emits show-tool-detail on tool click for non-auto-expand tools', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'Read', done: true, status: 'success', id: 'tool-1' }],
      })

      await wrapper.find('.chat-tool-call').trigger('click')

      expect(wrapper.emitted('show-tool-detail')).toBeTruthy()
      const detail = wrapper.emitted('show-tool-detail')![0][0] as any
      expect(detail.name).toBe('Read')
    })

    it('emits toggle-tool on click for AskUserQuestion', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'AskUserQuestion', done: true, status: 'success', id: 'tool-2', input: {} }],
      })

      await wrapper.find('.chat-tool-call').trigger('click')

      expect(wrapper.emitted('toggle-tool')).toBeTruthy()
    })

    it('renders auto-expand detail for AskUserQuestion', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'AskUserQuestion', done: true, status: 'success', id: 'tool-2', input: { question: 'Test?' } }],
      })
      expect(wrapper.find('.tool-detail').exists()).toBe(true)
    })

    it('keeps pending PermissionApproval detail expanded by default', () => {
      const wrapper = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: false,
          id: 'perm-1',
          input: {
            toolName: 'Bash',
            toolInput: JSON.stringify({ command: 'ls -la' }),
            options: [{ name: 'Allow', kind: 'allow_once', optionId: 'a1' }],
          },
        }],
      })
      expect(wrapper.find('.tool-detail').exists()).toBe(true)
    })

    it('collapses settled auto-approved PermissionApproval by default', () => {
      const wrapper = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-2',
          output: 'Auto-Approved',
          input: {
            toolName: 'Bash',
            toolInput: JSON.stringify({ command: 'python3 long script' }),
            autoApproved: true,
          },
        }],
      })
      expect(wrapper.find('.tool-detail').exists()).toBe(false)
      expect(wrapper.find('.tool-chevron').exists()).toBe(true)
      expect(wrapper.find('.permission-bar-result').exists()).toBe(true)
      expect(wrapper.find('.permission-bar-result').text()).toBe('Auto-Approved')
      expect(wrapper.find('.permission-bar-result').classes()).toContain('is-auto_approved')
    })

    it('shows approved badge on collapsed manual PermissionApproval', () => {
      const wrapper = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-2b',
          output: 'Approved',
          input: {
            toolName: 'Bash',
            toolInput: JSON.stringify({ command: 'echo ok' }),
          },
        }],
      })
      expect(wrapper.find('.tool-detail').exists()).toBe(false)
      expect(wrapper.find('.permission-bar-result').text()).toBe('Approved')
      expect(wrapper.find('.permission-bar-result').classes()).toContain('is-approved')
    })

    it('shows once vs session badges from structured permission output', () => {
      const once = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-once',
          output: 'approved|allow_once|allow_once|Allow Once',
          input: { toolName: 'Bash' },
        }],
      })
      expect(once.find('.permission-bar-result').text()).toBe('Approved · Once')
      expect(once.find('.permission-bar-result').classes()).toContain('is-allow_once')

      const session = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-session',
          output: 'approved|allow_always|allow_always|Allow for Session',
          input: { toolName: 'Bash' },
        }],
      })
      expect(session.find('.permission-bar-result').text()).toBe('Approved · Session')
      expect(session.find('.permission-bar-result').classes()).toContain('is-allow_session')

      const remember = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-remember',
          output: 'approved|allow_always|accept_execpolicy_amendment|Allow Commands Starting With `./build.sh`',
          input: { toolName: 'Bash' },
        }],
      })
      expect(remember.find('.permission-bar-result').text()).toBe('Approved · Remember')
      expect(remember.find('.permission-bar-result').classes()).toContain('is-allow_remember')
    })

    it('hides result badge while PermissionApproval detail is expanded', () => {
      const wrapper = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-2c',
          output: 'Auto-Approved',
          input: { autoApproved: true, toolName: 'Bash' },
        }],
        expandedTools: { 'msg-1:0': true },
      })
      expect(wrapper.find('.tool-detail').exists()).toBe(true)
      expect(wrapper.find('.permission-bar-result').exists()).toBe(false)
    })

    it('expands settled PermissionApproval when expandedTools is set', () => {
      const wrapper = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-3',
          output: 'Approved',
          input: {
            toolName: 'Bash',
            toolInput: JSON.stringify({ command: 'echo hi' }),
            autoApproved: true,
          },
        }],
        expandedTools: { 'msg-1:0': true },
      })
      expect(wrapper.find('.tool-detail').exists()).toBe(true)
    })

    it('emits toggle-tool on click for PermissionApproval', async () => {
      const wrapper = mountBlocks({
        blocks: [{
          type: 'tool_use',
          name: 'PermissionApproval',
          done: true,
          status: 'success',
          id: 'perm-4',
          output: 'Auto-Approved',
          input: { autoApproved: true, toolName: 'Bash' },
        }],
      })
      await wrapper.find('.chat-tool-call').trigger('click')
      expect(wrapper.emitted('toggle-tool')).toBeTruthy()
    })

    it('sets data-category on tool call', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'tool_use', name: 'Read', done: true, status: 'success' }],
      })
      expect(wrapper.find('.chat-tool-call').attributes('data-category')).toBe('file')
    })
  })

  // ── Thinking blocks ──

  describe('thinking blocks', () => {
    it('renders a thinking block', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Analyzing...', done: true }],
      })
      expect(wrapper.find('.chat-thinking').exists()).toBe(true)
    })

    it('adds thinking-expanded-done class when streaming and not done', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Thinking...', done: false }],
        streaming: true,
      })
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-streaming')
    })

    it('adds thinking-collapsed class when done', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Done thinking', done: true }],
        streaming: false,
      })
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-collapsed')
    })

    it('expands inline on thinking header click when collapsed', async () => {
      vi.useFakeTimers()
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Deep thought', done: true, _key: 'thinking-0' }],
        streaming: false,
      })

      // Thinking block starts collapsed
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-collapsed')

      // Toggle lives on the header only (content may contain file-path links)
      await wrapper.find('.thinking-header').trigger('click')
      await nextTick()

      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-expanded-done')
      expect(wrapper.find('.chat-thinking').classes()).not.toContain('thinking-collapsed')
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })

    it('does not emit show-thinking-detail on thinking header click', async () => {
      vi.useFakeTimers()
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Deep thought', done: true }],
        streaming: false,
      })

      await wrapper.find('.thinking-header').trigger('click')

      expect(wrapper.emitted('show-thinking-detail')).toBeFalsy()
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })

    it('does not collapse when clicking file-path links inside thinking content', async () => {
      // Regression: whole-card click handler used to collapse on any content click,
      // swallowing file-open navigation for annotated paths inside thinking blocks.
      vi.useFakeTimers()
      const wrapper = mountBlocks({
        blocks: [{
          type: 'thinking',
          text: 'See src/foo.ts for details',
          done: true,
          _key: 'thinking-0',
        }],
        streaming: false,
      })

      // Expand via header
      await wrapper.find('.thinking-header').trigger('click')
      await nextTick()
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-expanded-done')

      // Inject a file-path annotation into the rendered thinking content (mirrors
      // annotateFilePaths output) and click it — card must stay expanded.
      const content = wrapper.find('.thinking-inline-content')
      content.element.innerHTML =
        '<p>See <span class="chat-file-path" data-file-path="src/foo.ts">src/foo.ts</span> for details</p>'
      const pathEl = content.find('.chat-file-path')
      expect(pathEl.exists()).toBe(true)
      await pathEl.trigger('click')
      await nextTick()

      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-expanded-done')
      expect(wrapper.find('.chat-thinking').classes()).not.toContain('thinking-collapsed')
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })

    it('does not collapse when clicking thinking content body (only header toggles)', async () => {
      vi.useFakeTimers()
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Body text', done: true, _key: 'thinking-0' }],
        streaming: false,
      })

      await wrapper.find('.thinking-header').trigger('click')
      await nextTick()
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-expanded-done')

      // Click the content body itself — must not collapse
      await wrapper.find('.thinking-inline-content').trigger('click')
      await nextTick()
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-expanded-done')

      // Header click still collapses
      await wrapper.find('.thinking-header').trigger('click')
      await nextTick()
      // After collapse animation starts: either collapsing or fully collapsed
      const classes = wrapper.find('.chat-thinking').classes()
      expect(
        classes.includes('thinking-collapsed') || classes.includes('thinking-collapsing')
      ).toBe(true)
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })

    it('shows spinner and in-progress status when streaming and not done', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Thinking...', done: false }],
        streaming: true,
      })
      expect(wrapper.find('.thinking-spinner').exists()).toBe(true)
      expect(wrapper.find('.thinking-status').text()).toBe('in progress')
    })

    it('does not show spinner when done (even if streaming)', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Done', done: true }],
        streaming: true,
      })
      expect(wrapper.find('.thinking-spinner').exists()).toBe(false)
      expect(wrapper.find('.thinking-status').exists()).toBe(false)
    })

    it('renders complete thinking HTML when done (not stale lite throttle snapshot)', () => {
      // Regression: shared throttle cache could leave expanded-done thinking on a
      // partial markdown snapshot ("2. …" cut off). Done blocks must use full render.
      vi.useFakeTimers()
      const fullText = '1. First point\n2. Second point with full reasoning about files'
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: fullText, done: true, _key: 'thinking-0' }],
        streaming: true, // message still streaming, but thinking is done
      })
      const html = wrapper.find('.thinking-inline-content').html()
      expect(html).toContain('data-complete="1"')
      expect(html).toContain('1. First point')
      expect(html).toContain('2. Second point with full reasoning about files')
      expect(html).not.toContain('data-lite="1"')
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })

    it('uses lightweight markdown while thinking is still live-streaming', () => {
      vi.useFakeTimers()
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'partial…', done: false, _key: 'thinking-0' }],
        streaming: true,
      })
      const html = wrapper.find('.thinking-inline-content').html()
      expect(html).toContain('data-lite="1"')
      expect(html).toContain('partial…')
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })

    it('re-expands with complete text after message ends (history path)', async () => {
      vi.useFakeTimers()
      const fullText = 'Complete reasoning block with all steps preserved'
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: fullText, done: true, _key: 'thinking-0' }],
        streaming: false,
      })
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-collapsed')

      await wrapper.find('.thinking-header').trigger('click')
      await nextTick()

      const html = wrapper.find('.thinking-inline-content').html()
      expect(html).toContain('data-complete="1"')
      expect(html).toContain(fullText)
      wrapper.unmount()
      vi.advanceTimersByTime(1000)
      vi.useRealTimers()
    })
  })

  // ── Error / Warning blocks ──

  describe('error and warning blocks', () => {
    it('renders an error block', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'error', text: 'Something went wrong' }],
      })
      expect(wrapper.find('.chat-error-card').exists()).toBe(true)
      expect(wrapper.find('.error-text').text()).toBe('Something went wrong')
    })

    it('renders severe warning as error-level', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'warning', reason: 'disconnect', text: 'Connection lost' }],
      })
      expect(wrapper.find('.chat-error-card').exists()).toBe(true)
    })

    it('renders normal warning with amber styling', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'warning', reason: 'parse_error', text: 'Parse error: bad JSON' }],
      })
      expect(wrapper.find('.chat-warning-card').exists()).toBe(true)
    })

    it('shows retry button for request_failed when not streaming', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'warning', reason: 'request_failed', text: 'acp: prompt: boom' }],
        streaming: false,
      })
      expect(wrapper.find('.error-retry-btn').exists()).toBe(true)
      expect(wrapper.find('.error-retry-btn').text()).toBe('Retry')
    })

    it('hides retry button while streaming', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'warning', reason: 'request_failed', text: 'acp: prompt: boom' }],
        streaming: true,
      })
      expect(wrapper.find('.error-retry-btn').exists()).toBe(false)
    })

    it('emits retry when retry button is clicked', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'error', reason: 'request_failed', text: 'AI request failed: rate limit' }],
        streaming: false,
      })
      await wrapper.find('.error-retry-btn').trigger('click')
      expect(wrapper.emitted('retry')).toBeTruthy()
      expect(wrapper.emitted('retry')!.length).toBe(1)
    })

    it('renders auto-retry status card with attempt count', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'retry', attempt: 2, maxAttempts: 3, text: 'rate limited', reason: 'retrying' }],
        streaming: true,
      })
      expect(wrapper.find('.chat-retry-card').exists()).toBe(true)
      expect(wrapper.find('.retry-badge').text()).toContain('Auto-retry')
      expect(wrapper.find('.retry-title').text()).toContain('Retrying (2/3)')
      expect(wrapper.find('.retry-detail').text()).toContain('rate limited')
      expect(wrapper.find('.retry-spinner').exists()).toBe(true)
      expect(wrapper.find('.error-retry-btn').exists()).toBe(false)
    })

    it('keeps retry spinner while streaming', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'retry', attempt: 2, maxAttempts: 3, text: 'rate limited', reason: 'retrying' }],
        streaming: true,
        cancelled: false,
      })
      expect(wrapper.find('.retry-spinner').exists()).toBe(true)
      expect(wrapper.find('.chat-retry-card').classes()).not.toContain('is-done')
    })

    it('stops retry spinner after cancel/interrupt', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'retry', attempt: 2, maxAttempts: 3, text: 'rate limited', reason: 'retrying' }],
        streaming: false,
        cancelled: true,
      })
      expect(wrapper.find('.chat-retry-card').exists()).toBe(true)
      expect(wrapper.find('.retry-spinner').exists()).toBe(false)
      expect(wrapper.find('.chat-retry-card').classes()).toContain('is-done')
    })

    it('stops retry spinner when retry block is marked done', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'retry', attempt: 3, maxAttempts: 3, text: 'failed', reason: 'retrying', done: true }],
        streaming: true,
      })
      expect(wrapper.find('.retry-spinner').exists()).toBe(false)
      expect(wrapper.find('.chat-retry-card').classes()).toContain('is-done')
    })

    it('does not show retry for non-retriable reasons', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'warning', reason: 'user_cancel', text: 'cancelled' }],
        streaming: false,
      })
      expect(wrapper.find('.error-retry-btn').exists()).toBe(false)
    })
  })

  // ── Streaming / Cancelled markers ──

  describe('streaming and cancelled markers', () => {
    it('shows placeholder dots when streaming with content', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Hello' }],
        streaming: true,
        cancelled: false,
      })
      expect(wrapper.find('.placeholder-dots').exists()).toBe(true)
      expect(wrapper.find('.chat-waiting-card').exists()).toBe(false)
    })

    it('shows waiting card when streaming with empty blocks', () => {
      const wrapper = mountBlocks({
        blocks: [],
        streaming: true,
        cancelled: false,
      })
      expect(wrapper.find('.chat-waiting-card').exists()).toBe(true)
      expect(wrapper.find('.waiting-title').text()).toContain('Waiting for AI response')
      expect(wrapper.find('.placeholder-dots').exists()).toBe(false)
    })

    it('hides waiting card once retry status is present', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'retry', attempt: 2, maxAttempts: 3, text: 'network', reason: 'retrying' }],
        streaming: true,
        cancelled: false,
      })
      expect(wrapper.find('.chat-waiting-card').exists()).toBe(false)
      expect(wrapper.find('.chat-retry-card').exists()).toBe(true)
    })

    it('hides placeholder dots when not streaming', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Hello' }],
        streaming: false,
        cancelled: false,
      })
      expect(wrapper.find('.placeholder-dots').exists()).toBe(false)
      expect(wrapper.find('.chat-waiting-card').exists()).toBe(false)
    })

    it('does not render outer cancelled mark (moved to ChatMessageItem)', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Hello' }],
        streaming: false,
        cancelled: true,
      })
      // Outer cancelled mark is now rendered in ChatMessageItem, not ContentBlocks
      expect(wrapper.find('.chat-cancelled-mark').exists()).toBe(false)
    })

    it('does not render outer cancelled mark when last block is thinking', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Thought', done: true }],
        streaming: false,
        cancelled: true,
      })
      // Outer cancelled mark is now rendered in ChatMessageItem, not ContentBlocks
      expect(wrapper.find('.chat-cancelled-mark').exists()).toBe(false)
    })

    it('shows inline cancelled mark when last block is thinking', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Thought', done: true }],
        streaming: false,
        cancelled: true,
      })
      expect(wrapper.find('.chat-cancelled-mark-inline').exists()).toBe(true)
    })
  })

  // ── Summary mode ──

  describe('summary mode', () => {
    it('shows summary text when showingSummary and summary are set', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Original content' }],
        summary: 'Summary text',
        showingSummary: true,
      })
      expect(wrapper.html()).toContain('Summary text')
    })

    it('hides summary when showingSummary is false', () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Original content' }],
        summary: 'Summary text',
        showingSummary: false,
      })
      // Summary div should be hidden via v-show
      const summaryDiv = wrapper.find('[v-show]')
      // The original content should be visible
      expect(wrapper.html()).toContain('Original content')
    })
    it('shows RAG results in summary mode', () => {
      const ragItem = {
        sessionId: 'sess-1',
        sessionTitle: 'Chat about Go',
        createdAt: '2026-07-19T10:00:00Z',
        summary: 'Discussion about Go error handling',
      }
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: '<rag-results>...</rag-results>' }],
        summary: 'Summary text',
        showingSummary: true,
        blockRagResults: { 'msg-1-0': [ragItem] },
      })
      expect(wrapper.html()).toContain('Summary text')
      expect(wrapper.find('.rag-result-card').exists()).toBe(true)
      expect(wrapper.html()).toContain('Chat about Go')
    })

    it('shows RAG results in summary mode even when blockRagResults not pre-filled', async () => {
      // Simulates message loaded from DB with showingSummary=true —
      // blockRagResults starts empty. detectRagInText(block) checks block.text
      // for <rag-results>, so the v-else-if condition matches and getBlockHtml
      // triggers renderTextBlock which fills blockRagResults as side-effect.
      const ragItem = {
        sessionId: 's1',
        sessionTitle: 'RAG Title',
        summary: 'RAG summary text',
      }
      const ragResults = reactive<Record<string, unknown>>({})
      const cache = new Map<string, string>()
      const staticBlockCache = {
        get: (msgId, bi, text) => cache.get(`${msgId}-${bi}`),
        set: (msgId, bi, text, html) => cache.set(`${msgId}-${bi}`, html),
        isDeferred: () => false,
        scheduleUpgrade: () => {},
      }
      const renderFn = vi.fn((text: string, msgId: string, bi: number) => {
        if (text.includes('<rag-results>')) {
          ragResults[`${msgId}-${bi}`] = [ragItem]
        }
        return `<p>${text.replace(/<rag-results>.*?<\/rag-results>/, '')}</p>`
      })
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Some text <rag-results><rag-item><session-id>s1</session-id><session-title>RAG Title</session-title><summary>RAG summary text</summary></rag-item></rag-results>' }],
        summary: 'Summary text',
        showingSummary: true,
        blockRagResults: ragResults,
        renderTextBlock: renderFn,
        staticBlockCache,
      })
      await nextTick()
      expect(wrapper.find('.rag-result-card').exists()).toBe(true)
      expect(wrapper.html()).toContain('RAG Title')
    })

    it('shows RAG results without summary (non-summary mode)', () => {
      const ragItem = {
        sessionId: 'sess-1',
        sessionTitle: 'Chat about Go',
        createdAt: '2026-07-19T10:00:00Z',
        summary: 'Discussion about Go error handling',
      }
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: '<rag-results>...</rag-results>' }],
        showingSummary: false,
        blockRagResults: { 'msg-1-0': [ragItem] },
      })
      expect(wrapper.find('.rag-result-card').exists()).toBe(true)
      expect(wrapper.html()).toContain('Chat about Go')
    })
  })

  // ── Thinking block collapse animation ──

  describe('thinking block collapse animation', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('does not set collapse state when streaming ends with no thinking blocks', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'text', text: 'Hello' }],
        streaming: true,
      })

      await wrapper.setProps({ streaming: false })
      await nextTick()

      const thinking = wrapper.find('.chat-thinking')
      expect(thinking.exists()).toBe(false)
    })

    it('transitions from streaming to collapsed when streaming ends', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Deep thought content', done: false }],
        streaming: true,
      })

      // The thinking block should have streaming class
      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-streaming')

      // End streaming — block collapses to chip
      await wrapper.setProps({ streaming: false })
      await nextTick()

      // After streaming ends, block should be collapsed
      const thinking = wrapper.find('.chat-thinking')
      expect(thinking.classes()).not.toContain('thinking-streaming')
      expect(thinking.classes()).toContain('thinking-collapsed')
    })

    it('transitions to expanded-done when thinking_done fires mid-stream', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Thinking...', done: false }],
        streaming: true,
      })

      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-streaming')

      // Simulate thinking_done: set block.done = true — block stays expanded during streaming
      await wrapper.setProps({
        blocks: [{ type: 'thinking', text: 'Thinking complete', done: true }],
      })
      await nextTick()

      // Should no longer be streaming (done=true overrides streaming prop)
      const thinking = wrapper.find('.chat-thinking')
      expect(thinking.classes()).not.toContain('thinking-streaming')
      // Block should be expanded-done or collapsed depending on ref availability
      expect(thinking.classes().some(c => c === 'thinking-expanded-done' || c === 'thinking-collapsed')).toBe(true)
    })

    it('cleans up timers on unmount to prevent leaks', async () => {
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Deep thought', done: false }],
        streaming: true,
      })

      await wrapper.setProps({ streaming: false })
      await nextTick()

      // Unmount before timers fire — should not throw
      wrapper.unmount()

      // Advance all timers — should not cause Vue warnings or errors
      vi.advanceTimersByTime(10000)
    })

    it('shows thinking-collapsed class when not streaming and done (DB-loaded)', () => {
      // Static state: not streaming, block done — should show collapsed chip
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Final thought', done: true }],
        streaming: false,
      })
      const thinking = wrapper.find('.chat-thinking')
      expect(thinking.classes()).toContain('thinking-collapsed')
      expect(thinking.classes()).not.toContain('thinking-streaming')
    })

    it('collapses to chip after streaming ends', async () => {
      // After streaming ends, all thinking blocks collapse to chip.
      // User can click the chip to re-expand.
      const wrapper = mountBlocks({
        blocks: [{ type: 'thinking', text: 'Deep thought', done: false, _key: 'thinking-0' }],
        streaming: true,
      })

      expect(wrapper.find('.chat-thinking').classes()).toContain('thinking-streaming')

      await wrapper.setProps({ streaming: false })
      await nextTick()

      // Block should be collapsed
      const classes = wrapper.find('.chat-thinking').classes()
      expect(classes).toContain('thinking-collapsed')
    })
  })
})
