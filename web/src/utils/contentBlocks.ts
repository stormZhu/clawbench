/**
 * Pure functions extracted from ContentBlocks.vue for testability.
 * These are stateless utility functions with no Vue reactivity dependencies.
 */

/** Reasons that indicate a severe issue (red error-level styling) */
const SEVERE_REASONS = new Set(['disconnect', 'timeout', 'restart', 'panic'])

/**
 * Reasons where a user-facing "Retry" action is useful: resending the previous
 * user message through the normal chat path (backend-agnostic).
 * Excludes pure user-initiated cancels.
 */
const RETRIABLE_REASONS = new Set([
  'request_failed',
  'empty',
  'panic',
  'timeout',
  'backend_exit',
  'disconnect',
  'restart',
  'parse_error',
])

/** English generic fallback used by some backends when no detail is available. */
const GENERIC_REQUEST_FAILED_RE = /^AI request failed\.?$/i

/**
 * Unwrap ACP JSON-RPC error blobs so the chat UI shows the real agent/API
 * reason instead of {"code":-32603,"message":"Internal error","data":"..."}.
 * Also collapses repeated "acp: prompt:" prefixes from older backends.
 */
export function unwrapAcpErrorDetail(text: string): string {
  if (!text) return ''
  let s = text.trim()
  // Collapse historical double-wrap: "acp: prompt: acp: prompt: ..."
  while (/^acp:\s*prompt:\s*/i.test(s)) {
    s = s.replace(/^acp:\s*prompt:\s*/i, '').trim()
  }
  const jsonStart = s.indexOf('{"code":')
  if (jsonStart < 0) {
    // Re-attach a single prefix when we stripped one from a plain detail.
    return text.trim().startsWith('acp: prompt:') && !s.startsWith('acp:')
      ? 'acp: prompt: ' + s
      : (s || text.trim())
  }
  const raw = s.slice(jsonStart)
  try {
    const obj = JSON.parse(raw) as {
      code?: number
      message?: string
      data?: unknown
    }
    const dataDetail = extractRpcDataDetail(obj.data)
    if (dataDetail) {
      const msg = (obj.message || '').trim()
      if (msg && !isGenericJsonRpcMessage(msg) && !dataDetail.includes(msg)) {
        return msg + ': ' + dataDetail
      }
      return dataDetail
    }
    const msg = (obj.message || '').trim()
    if (msg && !isGenericJsonRpcMessage(msg)) return msg
  } catch {
    // keep original
  }
  return text.trim()
}

function isGenericJsonRpcMessage(msg: string): boolean {
  const m = msg.trim().toLowerCase()
  return m === 'internal error' || m === 'server error' || m === 'unknown error'
}

function extractRpcDataDetail(data: unknown): string {
  if (data == null) return ''
  if (typeof data === 'string') return data.trim()
  if (typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    for (const k of ['error', 'details', 'message', 'detail', 'reason']) {
      const v = d[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    try {
      return JSON.stringify(d)
    } catch {
      return ''
    }
  }
  return String(data)
}

/**
 * Check if a warning block represents a severe issue.
 * Severe warnings render with red/error-level styling.
 */
export function isSevereWarning(block: { reason?: string }): boolean {
  return SEVERE_REASONS.has(block.reason || '')
}

/**
 * Whether this error/warning block should show a Retry button.
 * Error blocks without a reason are treated as retriable (raw backend failures).
 */
export function isRetriableWarning(block: { type?: string; reason?: string }): boolean {
  if (block.reason) return RETRIABLE_REASONS.has(block.reason)
  // Bare error blocks (no reason code) — allow retry so the user can re-send.
  return block.type === 'error'
}

/**
 * Localized auto-retry status text, e.g. "Retrying (2/3)…".
 * Optionally appends backend detail after a colon.
 */
export function getRetryTitle(
  block: { attempt?: number; maxAttempts?: number },
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const attempt = Number(block.attempt) || 0
  const maxAttempts = Number(block.maxAttempts) || 0
  let base: string
  if (attempt > 0 && maxAttempts > 0) {
    base = t('chat.contentBlocks.retryingAttempt', { n: attempt, max: maxAttempts })
  } else if (attempt > 0) {
    base = t('chat.contentBlocks.retryingAttemptOnly', { n: attempt })
  } else {
    base = t('chat.contentBlocks.retrying')
  }
  // t() may return the key itself when missing
  if (base.startsWith('chat.contentBlocks.')) {
    if (attempt > 0 && maxAttempts > 0) base = `Retrying (${attempt}/${maxAttempts})…`
    else if (attempt > 0) base = `Retrying (#${attempt})…`
    else base = 'Retrying…'
  }
  return base
}

/**
 * Human-readable retry detail (previous failure reason).
 * Unwraps ACP JSON-RPC blobs and maps common network failures to i18n copy.
 */
export function getRetryDetail(
  block: { text?: string },
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const raw = (block.text || '').trim()
  if (!raw) return ''
  return humanizeStreamErrorDetail(raw, t)
}

/**
 * Localized auto-retry status text, e.g. "Retrying (2/3)…: rate limited".
 * Title and detail are also available separately via getRetryTitle/getRetryDetail
 * for multi-line UI cards.
 */
export function getRetryText(
  block: { attempt?: number; maxAttempts?: number; text?: string },
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const base = getRetryTitle(block, t)
  const detail = getRetryDetail(block, t)
  if (!detail) return base
  return detail.includes('\n') ? `${base}\n${detail}` : `${base}: ${detail}`
}

/** True when blocks already show real model progress (not just status chrome). */
export function hasStreamingProgress(
  blocks: Array<{ type?: string }> | null | undefined
): boolean {
  if (!blocks || blocks.length === 0) return false
  return blocks.some((b) => {
    const t = b?.type || ''
    return t === 'text' || t === 'thinking' || t === 'tool_use' || t === 'tool_result'
  })
}

/** True when a retry status card is already present. */
export function hasRetryStatus(
  blocks: Array<{ type?: string }> | null | undefined
): boolean {
  if (!blocks || blocks.length === 0) return false
  return blocks.some((b) => b?.type === 'retry')
}

/**
 * Whether the empty-stream waiting card should show.
 * Hidden once real content or an explicit retry card is present.
 */
export function shouldShowWaitingStatus(
  streaming: boolean,
  cancelled: boolean,
  blocks: Array<{ type?: string }> | null | undefined
): boolean {
  return !!streaming && !cancelled && !hasStreamingProgress(blocks) && !hasRetryStatus(blocks)
}

/** Format elapsed wait seconds as mm:ss or "Ns". */
export function formatWaitElapsed(
  seconds: number,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const s = Math.max(0, Math.floor(seconds || 0))
  if (s < 60) {
    let out = t('chat.contentBlocks.waitingElapsedSec', { n: s })
    if (out.startsWith('chat.contentBlocks.')) out = `Waited ${s}s`
    return out
  }
  const m = Math.floor(s / 60)
  const rem = s % 60
  let out = t('chat.contentBlocks.waitingElapsedMinSec', { m, s: rem })
  if (out.startsWith('chat.contentBlocks.')) out = `Waited ${m}m ${rem}s`
  return out
}

/**
 * Map common backend/network failure strings to friendlier i18n copy.
 * Falls back to unwrapped raw detail.
 */
export function humanizeStreamErrorDetail(
  text: string,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  const unwrapped = unwrapAcpErrorDetail(text || '')
  const lower = unwrapped.toLowerCase()
  const mapKey = (key: string, fallback: string): string => {
    const translated = t(key)
    return translated.startsWith('chat.contentBlocks.') ? fallback : translated
  }
  const withRaw = (friendly: string): string => {
    // Keep raw detail for debugging, but lead with the friendly summary.
    if (!unwrapped || unwrapped === friendly) return friendly
    if (friendly.includes(unwrapped)) return friendly
    return `${friendly}\n${unwrapped}`
  }
  if (
    lower.includes('cli-chat-proxy.grok.com') ||
    lower.includes('api.x.ai') ||
    (lower.includes('reqwest') && lower.includes('error sending request'))
  ) {
    return withRaw(mapKey(
      'chat.contentBlocks.errorHints.networkGrok',
      'Cannot reach Grok API (network/proxy). Check connectivity and retry.'
    ))
  }
  if (
    lower.includes('error sending request for url') ||
    lower.includes('connection reset') ||
    lower.includes('connection timed out') ||
    lower.includes('timed out') ||
    lower.includes('network unreachable') ||
    lower.includes('dns error') ||
    lower.includes('name or service not known')
  ) {
    return withRaw(mapKey(
      'chat.contentBlocks.errorHints.networkGeneric',
      'Network request failed. Check connectivity and retry.'
    ))
  }
  return unwrapped
}

/**
 * Get localized warning/error text.
 * Uses reason code to look up i18n key, falls back to block.text.
 * For parse_error / backend_exit / request_failed, appends detail from block.text
 * so the user sees the real backend/agent error instead of a bare label.
 */
export function getWarningText(
  block: { reason?: string; text?: string },
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  if (block.reason) {
    const key = `chat.contentBlocks.warningReasons.${block.reason}`
    const translated = t(key)
    // t() returns the key itself when not found — fall back to block.text
    if (translated !== key) {
      // request_failed: show backend/agent detail (unwrap + humanize network errors)
      if (block.reason === 'request_failed' && block.text) {
        const detail = humanizeStreamErrorDetail(block.text, t)
        if (detail && !GENERIC_REQUEST_FAILED_RE.test(detail)) {
          return detail.includes('\n')
            ? translated + '\n' + detail
            : translated + ': ' + detail
        }
      }
      // For parse_error: append detail after ": " from block.text
      // For backend_exit: append stderr after "\n" from block.text
      if ((block.reason === 'parse_error' || block.reason === 'backend_exit') && block.text) {
        const unwrapped = unwrapAcpErrorDetail(block.text)
        const newlineIdx = unwrapped.indexOf('\n')
        if (newlineIdx >= 0) {
          // If unwrap already removed the generic label, show full unwrapped text
          if (!unwrapped.startsWith(translated) && unwrapped !== block.text.trim()) {
            return translated + '\n' + unwrapped
          }
          return translated + unwrapped.substring(newlineIdx)
        }
        const colonIdx = unwrapped.indexOf(': ')
        if (colonIdx >= 0 && unwrapped === block.text.trim()) {
          return translated + ': ' + unwrapped.substring(colonIdx + 2)
        }
        if (unwrapped && unwrapped !== block.text.trim()) {
          return translated + ': ' + unwrapped
        }
        if (colonIdx >= 0) {
          return translated + ': ' + unwrapped.substring(colonIdx + 2)
        }
      }
      return translated
    }
  }
  // Fallback: no reason code or no matching i18n key — still unwrap/humanize
  return block.text ? humanizeStreamErrorDetail(block.text, t) : ''
}

/**
 * Get CSS class for a task's status indicator.
 */
export function statusClass(task: { status: string }): string {
  if (task.status === 'active') return 'status-active'
  if (task.status === 'paused') return 'status-paused'
  if (task.status === 'completed') return 'status-completed'
  return ''
}

/**
 * Get detailed status label for a scheduled task.
 */
export function statusLabel(
  task: { status: string; runCount: number; runningCount: number },
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  if (task.status === 'active') {
    const execLabel = t('chat.contentBlocks.statusExecutions', { count: task.runCount })
    if (task.runningCount > 0) return `${t('chat.contentBlocks.statusRunning')} (${execLabel})`
    return `${t('chat.contentBlocks.statusActive')} (${execLabel})`
  }
  if (task.status === 'paused') return t('chat.contentBlocks.statusPaused')
  if (task.status === 'completed') return t('chat.contentBlocks.statusCompleted')
  return task.status
}

/**
 * Get simple (short) status label for a scheduled task badge.
 */
export function statusLabelSimple(
  task: { status: string },
  t: (key: string) => string
): string {
  if (task.status === 'active') return t('chat.contentBlocks.statusActive')
  if (task.status === 'paused') return t('chat.contentBlocks.statusPaused')
  if (task.status === 'completed') return t('chat.contentBlocks.statusCompleted')
  return task.status
}

/**
 * Format an ISO timestamp into a human-readable relative or absolute time string.
 * - < 1 min: "just now"
 * - < 1 hour: "X minutes ago/from now"
 * - < 1 day: "X hours ago/from now"
 * - else: locale date string
 */
export function formatTime(
  iso: string | null | undefined,
  locale: string,
  t: (key: string, params?: Record<string, unknown>) => string
): string {
  if (!iso) return ''
  const d = new Date(iso)
  const now = new Date()
  const diff = d.getTime() - now.getTime()
  const absDiff = Math.abs(diff)
  if (absDiff < 60000) return t('chat.contentBlocks.justNow')
  if (absDiff < 3600000) {
    const count = Math.round(absDiff / 60000)
    return diff > 0
      ? t('chat.contentBlocks.minutesFromNow', { count })
      : t('chat.contentBlocks.minutesAgo', { count })
  }
  if (absDiff < 86400000) {
    const count = Math.round(absDiff / 3600000)
    return diff > 0
      ? t('chat.contentBlocks.hoursFromNow', { count })
      : t('chat.contentBlocks.hoursAgo', { count })
  }
  return d.toLocaleDateString(locale === 'zh' ? 'zh-CN' : 'en-US')
}

/**
 * Generate a short summary for an ask-question block.
 * Returns the first question's header if available, otherwise the question text.
 */
export function askQuestionSummary(input: Record<string, unknown>): string {
  if (!input || !Array.isArray(input.questions) || input.questions.length === 0) return ''
  const q = input.questions[0]
  const header = q.header || ''
  const question = q.question || ''
  if (header) return header
  return question
}

/** True when the tool is a PermissionApproval interactive card. */
export function isPermissionApprovalTool(name?: string | null): boolean {
  return (name || '').toLowerCase() === 'permissionapproval'
}

/**
 * Whether a PermissionApproval card has already been resolved.
 * Matches renderPermissionApproval: auto-approved OR real user result (done + output).
 * Pending cards stay expanded so the user can act; settled cards default to collapsed.
 */
export function isPermissionApprovalSettled(block: {
  name?: string
  done?: boolean
  output?: unknown
  input?: Record<string, unknown> | null
}): boolean {
  if (!isPermissionApprovalTool(block.name)) return false
  const input = block.input
  if (input && typeof input === 'object' && !Array.isArray(input) && input.autoApproved === true) {
    return true
  }
  return !!(block.done && block.output)
}

/**
 * Whether an auto-expand tool detail panel should be visible.
 * - Pending PermissionApproval: always open (approval buttons / context needed)
 * - Settled PermissionApproval: follows expandedTools (default collapsed)
 * - Other auto-expand tools (e.g. AskUserQuestion): always open
 */
export function shouldShowAutoExpandToolDetail(
  block: {
    name?: string
    done?: boolean
    output?: unknown
    input?: Record<string, unknown> | null
  },
  expanded: boolean,
): boolean {
  if (isPermissionApprovalTool(block.name)) {
    if (!isPermissionApprovalSettled(block)) return true
    return !!expanded
  }
  return true
}

/** Settled PermissionApproval outcome for compact bar / detail badges. */
export type PermissionApprovalResultKind =
  | 'auto_approved'
  | 'allow_once'
  | 'allow_session'
  | 'allow_remember'
  | 'approved'
  | 'reject_once'
  | 'reject_always'
  | 'denied'

/** Parsed wire format from FormatPermissionDecisionOutput. */
export interface PermissionDecisionParts {
  decision: 'auto_approved' | 'approved' | 'cancelled'
  kind: string
  /** ACP option id when present (4-part wire format). */
  optionId: string
  label: string
}

// 4-part: decision|kind|optionId|label  (current)
const PERMISSION_DECISION_RE_V2 = /^(auto_approved|approved|cancelled)\|([^|]*)\|([^|]*)\|(.*)$/s
// 3-part legacy: decision|kind|label
const PERMISSION_DECISION_RE_V1 = /^(auto_approved|approved|cancelled)\|([^|]*)\|(.*)$/s

/**
 * Parse structured permission tool_result output.
 * Also accepts legacy plain values: Auto-Approved / Approved / Cancelled.
 */
export function parsePermissionDecisionOutput(output?: unknown): PermissionDecisionParts | null {
  if (typeof output !== 'string' || !output) return null
  const m2 = output.match(PERMISSION_DECISION_RE_V2)
  if (m2) {
    return {
      decision: m2[1] as PermissionDecisionParts['decision'],
      kind: m2[2] || '',
      optionId: m2[3] || '',
      label: m2[4] || '',
    }
  }
  const m1 = output.match(PERMISSION_DECISION_RE_V1)
  if (m1) {
    return {
      decision: m1[1] as PermissionDecisionParts['decision'],
      kind: m1[2] || '',
      optionId: '',
      label: m1[3] || '',
    }
  }
  const plain = output.trim()
  if (/^auto-approved$/i.test(plain)) return { decision: 'auto_approved', kind: '', optionId: '', label: '' }
  if (/^approved$/i.test(plain)) return { decision: 'approved', kind: '', optionId: '', label: '' }
  if (/^cancelled$/i.test(plain)) return { decision: 'cancelled', kind: '', optionId: '', label: '' }
  return null
}

/** True when this allow_always option is Codex-style "remember command prefix". */
function isRememberCommandOption(optionId: string, label: string): boolean {
  const id = (optionId || '').toLowerCase()
  const l = (label || '').toLowerCase()
  // Codex uses optionId accept_execpolicy_amendment for "Allow Commands Starting With …"
  if (id === 'accept_execpolicy_amendment' || id.includes('execpolicy') || id.includes('amendment')) {
    return true
  }
  // Labels vary: "Allow and Remember Command Pattern" or dynamic "Allow Commands Starting With `cmd`"
  return /remember|pattern|记住|starting with|commands starting/.test(l)
}

function refinePermissionKind(
  kind: string,
  label: string,
  optionId: string = '',
): PermissionApprovalResultKind | null {
  const k = (kind || '').toLowerCase()
  if (k === 'allow_once') return 'allow_once'
  if (k === 'allow_always') {
    // Codex (and similar) reuse allow_always for both session-scope and command-pattern memory.
    if (isRememberCommandOption(optionId, label)) return 'allow_remember'
    return 'allow_session'
  }
  if (k === 'reject_once') return 'reject_once'
  if (k === 'reject_always') return 'reject_always'
  return null
}

/**
 * Classify the settled PermissionApproval result for UI badges.
 * Prefers structured tool_result output (decision|kind|label); falls back to
 * autoApproved flag and legacy Approved/Cancelled strings.
 */
export function getPermissionApprovalResultKind(block: {
  name?: string
  done?: boolean
  status?: string
  output?: unknown
  input?: Record<string, unknown> | null
}): PermissionApprovalResultKind | null {
  if (!isPermissionApprovalTool(block.name)) return null

  const parsed = parsePermissionDecisionOutput(block.output)
  if (parsed) {
    if (parsed.decision === 'auto_approved') return 'auto_approved'
    const refined = refinePermissionKind(parsed.kind, parsed.label, parsed.optionId)
    if (refined) return refined
    if (parsed.decision === 'cancelled') return 'denied'
    return 'approved'
  }

  const input = block.input
  if (input && typeof input === 'object' && !Array.isArray(input) && input.autoApproved === true) {
    return 'auto_approved'
  }
  if (!(block.done && block.output)) return null
  if (block.status === 'error') return 'denied'
  return 'approved'
}

/** i18n key under tool.permission.* for a result kind. */
export function permissionApprovalResultI18nKey(
  kind: PermissionApprovalResultKind | null | undefined,
): string {
  switch (kind) {
    case 'auto_approved':
      return 'tool.permission.autoApproved'
    case 'allow_once':
      return 'tool.permission.approvedOnce'
    case 'allow_session':
      return 'tool.permission.approvedSession'
    case 'allow_remember':
      return 'tool.permission.approvedRemember'
    case 'approved':
      return 'tool.permission.approved'
    case 'reject_once':
      return 'tool.permission.denied'
    case 'reject_always':
      return 'tool.permission.deniedAlways'
    case 'denied':
      return 'tool.permission.denied'
    default:
      return ''
  }
}

/** Map ACP option kind (+ label) to result kind for optimistic click feedback. */
export function permissionOptionToResultKind(
  optionKind?: string,
  optionLabel?: string,
  optionId?: string,
): PermissionApprovalResultKind {
  const refined = refinePermissionKind(optionKind || '', optionLabel || '', optionId || '')
  if (refined) return refined
  const k = (optionKind || '').toLowerCase()
  if (k.startsWith('reject')) return 'denied'
  if (k.startsWith('allow')) return 'approved'
  return 'approved'
}

/**
 * Build a block key for DOM rendering and tool expand state tracking.
 * Uses msgId if available, otherwise msgIndex.
 */
export function blockKey(msgId: string | number, bi: number): string {
  return msgId ? `db-${msgId}-${bi}` : `local-${bi}`
}

/**
 * Build a key for blockTasks/blockAskQuestions lookup.
 * Prefix format: "msgId-blockIdx"
 */
export function blockTaskKey(msgId: string | number, bi: number): string {
  return `${msgId}-${bi}`
}

/**
 * Build an index: block index → sorted array of scheduled task keys.
 * This pre-computes the mapping to avoid O(n) scan per block per render.
 */
export function buildTaskKeyIndex(
  msgId: string | number | undefined,
  blockTasks: Record<string, unknown>
): Record<string, string[]> {
  if (!msgId) return {}
  const index: Record<string, string[]> = {}
  const prefix = `${msgId}-`
  for (const k of Object.keys(blockTasks)) {
    if (!k.startsWith(prefix)) continue
    const rest = k.slice(prefix.length)
    const dashIdx = rest.indexOf('-')
    if (dashIdx === -1) continue
    const bi = rest.slice(0, dashIdx)
    ;(index[bi] || (index[bi] = [])).push(k)
  }
  // Sort each group by key (tag index is already part of the key string)
  for (const bi of Object.keys(index)) index[bi].sort()
  return index
}

/**
 * Check if a block has any scheduled tasks based on the pre-computed index.
 */
export function hasScheduledTasks(
  taskKeyIndex: Record<string, string[]>,
  bi: string | number
): boolean {
  return !!(taskKeyIndex[bi]?.length)
}

/**
 * Return all scheduled task keys for a block, sorted by tag index.
 */
export function scheduledTaskKeys(
  taskKeyIndex: Record<string, string[]>,
  bi: string | number
): string[] {
  return taskKeyIndex[bi] || []
}

// ────────────────────────────────────────────────────────────
// @ command badge detection
// ────────────────────────────────────────────────────────────

/** Match @ command prefix at start of text: @chatsearch or @task followed by space */
const AT_COMMAND_RE = /^(@chatsearch|@task)(\s[\s\S]*)?$/

export interface AtCommandBadge {
  command: string    // e.g. "@chatsearch"
  rest: string       // e.g. " my query" (including the leading space) or ""
}

/**
 * Extract @ command prefix from a text block.
 * Returns null if the text doesn't start with an @ command.
 */
export function extractAtCommand(text: string): AtCommandBadge | null {
  if (!text.startsWith('@')) return null
  const match = text.match(AT_COMMAND_RE)
  if (!match) return null
  return { command: match[1], rest: match[2] || '' }
}

// ────────────────────────────────────────────────────────────
// Slash command badge detection (ACP backend commands)
// ────────────────────────────────────────────────────────────

/** Match slash command prefix at start of text: /command-name (with optional space+rest) */
const SLASH_COMMAND_RE = /^\/(\w[\w:-]*)(\s[\s\S]*)?$/

export interface SlashCommandBadge {
  command: string    // e.g. "/commit"
  rest: string       // e.g. " fix auth bug" (including the leading space) or ""
}

/**
 * Extract slash command prefix from a text block.
 * Returns null if the text doesn't start with a slash command.
 * Unlike @ commands, slash commands are dynamic (from ACP) — any /word match is valid.
 */
export function extractSlashCommand(text: string): SlashCommandBadge | null {
  if (!text.startsWith('/')) return null
  const match = text.match(SLASH_COMMAND_RE)
  if (!match) return null
  return { command: '/' + match[1], rest: match[2] || '' }
}
