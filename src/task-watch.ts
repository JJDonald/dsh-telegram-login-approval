/**
 * M2：任务完成通知。
 *
 * 监听 `session/event` 与 `agent/status`，在一次「任务段」结束时推送一条
 * Telegram 消息（成功给结论，失败给原因）。
 *
 * 设计要点（都是踩坑后的结论）：
 *
 * 1. **不能用单个 `turn/end` 当"任务完成"**：一个任务往往跨多轮（工具调用、
 *    计划步骤、goal 续跑）。单轮结束就通知会刷屏。
 *    因此用「任务段（stretch）」而不是「轮次」：从第一次 `turn/start` 开始，
 *    到 agent 变 `idle` 且**静置一小段**之后才判定结束。
 *
 * 2. **静置窗口必须有**：轮次刚结束时，其他调度器（goal 轮次、cron、
 *    队列中的后续输入）会**异步**排入下一轮。立即判定"完成"会误报。
 *    因此在 idle 后等 `settleMs`，再复查一次 agent 状态与邮箱：
 *    若期间又开始跑，取消本次通知。
 *
 * 3. **不重复通知**：每个 session 的任务段只推一次完成消息。
 *
 * 4. **不阻塞**：所有事件处理器都是同步返回（fire-and-forget），
 *    网络发送走独立队列，失败只记日志，绝不影响 session 提交。
 */

/** 一个任务段的进行中状态。 */
interface Stretch {
  startedAt: number
  /** 本段已完成的轮次数。 */
  turns: number
  /** 最近一轮的结束原因。 */
  lastReason: TurnReason
  /** 最近一轮的最终助手文本（可能为空）。 */
  lastText: string
  /** 静置计时器的句柄。 */
  settleTimer: ReturnType<typeof setTimeout> | undefined
}

/** 归一化后的轮次结束原因类别。 */
export type TurnReason = 'completed' | 'aborted' | 'error' | 'max-tokens' | 'interrupted' | 'other'

/** 一次完成通知的内容。 */
export interface CompletionNotice {
  sessionId: string
  turns: number
  durationMs: number
  reason: TurnReason
  /** 最终助手文本（已截断）。 */
  text: string
  /** 失败详情（仅当 reason 非 completed）。 */
  detail: string
  /** 本段期间是否收到过用户消息（用于判断是否值得通知）。 */
  hadUserInput: boolean
}

export interface TurnWatcherDeps {
  /** 发送通知；返回 Promise 但调用方不等待。 */
  notify: (notice: CompletionNotice) => void
  /** 静置窗口毫秒数。 */
  settleMs: number
  /** 单个 session 保留的最终文本上限（字符）。 */
  maxTextChars: number
  log: (message: string) => void
  /** 判定某个 session 是否已被 agent 报告为 idle；用于静置后复查。 */
  isIdle: (sessionId: string) => boolean
}

/** 从 turn/end 的 reason 归一化出类别。 */
export function classifyReason(reason: unknown): TurnReason {
  const kind = (reason as { kind?: unknown } | null | undefined)?.kind
  switch (kind) {
    case 'completed': return 'completed'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    case 'max-tokens': return 'max-tokens'
    case 'interrupted': return 'interrupted'
    default: return 'other'
  }
}

/** 从失败原因里取一句人类可读的说明。 */
export function reasonDetail(reason: unknown): string {
  const r = reason as { kind?: unknown; error?: { code?: unknown; message?: unknown }; reason?: unknown } | null | undefined
  if (r === null || r === undefined) return ''
  if (typeof r.kind === 'string' && r.kind === 'error') {
    const code = typeof r.error?.code === 'string' ? r.error.code : ''
    const message = typeof r.error?.message === 'string' ? r.error.message : ''
    return [code, message].filter(s => s !== '').join(': ')
  }
  if (typeof r.reason === 'string') return r.reason
  return ''
}

/** 从 assistant/message 事件里抽取纯文本。 */
export function extractText(message: unknown): string {
  const content = (message as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const b = block as { type?: unknown; text?: unknown }
    if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('')
}

/**
 * 任务段跟踪器。
 *
 * 事件源是 DSH 的 `session/event` 与 `agent/status`；
 * 该类只做状态维护 + 定时判定，不碰网络。
 */
export class TurnWatcher {
  private readonly stretches = new Map<string, Stretch>()
  /** agent 报告的当前状态（`agent/status`）。 */
  private readonly status = new Map<string, 'idle' | 'running'>()
  private disposed = false

  constructor(private readonly deps: TurnWatcherDeps) {}

  /** 供 `agent/status` 使用。 */
  onAgentStatus(sessionId: string, status: string): void {
    if (this.disposed) return
    const normalized = status === 'running' ? 'running' : 'idle'
    this.status.set(sessionId, normalized)
    if (normalized === 'idle') {
      this.scheduleSettle(sessionId)
    } else {
      this.cancelSettle(sessionId)
    }
  }

  /** 供 `session/event` 使用。 */
  onSessionEvent(sessionId: string, event: { type?: unknown; data?: unknown }): void {
    if (this.disposed) return
    const type = event?.type
    const data = event?.data

    if (type === 'turn/start') {
      // 新任务段开始（或已有段继续）。
      const existing = this.stretches.get(sessionId)
      if (existing === undefined) {
        this.stretches.set(sessionId, {
          startedAt: Date.now(),
          turns: 0,
          lastReason: 'other',
          lastText: '',
          settleTimer: undefined,
        })
      } else {
        this.cancelSettle(sessionId)
      }
      return
    }

    if (type === 'turn/end') {
      const stretch = this.stretches.get(sessionId)
      if (stretch === undefined) return
      stretch.turns += 1
      stretch.lastReason = classifyReason((data as { reason?: unknown } | undefined)?.reason)
      return
    }

    if (type === 'assistant/message') {
      const stretch = this.stretches.get(sessionId)
      if (stretch === undefined) return
      const text = extractText((data as { message?: unknown } | undefined)?.message)
      // 只保留最新一条非空文本作为"最终回答"。
      if (text.trim() !== '') {
        stretch.lastText = text.length > this.deps.maxTextChars
          ? `${text.slice(0, this.deps.maxTextChars)}\n…（已截断）`
          : text
      }
      return
    }
  }

  /** idle 后等一个静置窗口，再复查；期间若又跑起来就取消。 */
  private scheduleSettle(sessionId: string): void {
    const stretch = this.stretches.get(sessionId)
    if (stretch === undefined || stretch.settleTimer !== undefined) return
    stretch.settleTimer = setTimeout(() => {
      stretch.settleTimer = undefined
      this.finalize(sessionId)
    }, this.deps.settleMs)
  }

  private cancelSettle(sessionId: string): void {
    const stretch = this.stretches.get(sessionId)
    if (stretch?.settleTimer !== undefined) {
      clearTimeout(stretch.settleTimer)
      stretch.settleTimer = undefined
    }
  }

  /** 静置结束：复查状态后判定任务段完成。 */
  private finalize(sessionId: string): void {
    if (this.disposed) return
    const stretch = this.stretches.get(sessionId)
    if (stretch === undefined) return

    // 复查：静置期间可能已被新的排入唤醒。
    if (this.status.get(sessionId) === 'running' || !this.deps.isIdle(sessionId)) {
      this.cancelSettle(sessionId)
      return
    }

    this.stretches.delete(sessionId)
    const durationMs = Date.now() - stretch.startedAt
    const notice: CompletionNotice = {
      sessionId,
      turns: stretch.turns,
      durationMs,
      reason: stretch.lastReason,
      text: stretch.lastText,
      detail: '',
      hadUserInput: true,
    }
    try {
      this.deps.notify(notice)
    } catch (error) {
      this.deps.log(`通知发送失败（已忽略）: ${String(error)}`)
    }
  }

  /** 供诊断与测试。 */
  activeCount(): number {
    return this.stretches.size
  }

  /** 卸载：清掉所有计时器，避免 dispose 后仍触发通知。 */
  dispose(): void {
    this.disposed = true
    for (const id of [...this.stretches.keys()]) this.cancelSettle(id)
    this.stretches.clear()
    this.status.clear()
  }
}

/** 把耗时渲染成人类可读文本。 */
export function humanDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${String(totalSeconds)} 秒`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds === 0 ? `${String(minutes)} 分` : `${String(minutes)} 分 ${String(seconds)} 秒`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  return restMinutes === 0 ? `${String(hours)} 小时` : `${String(hours)} 小时 ${String(restMinutes)} 分`
}

/** 组装 Telegram 消息文本（HTML 模式）。 */
export function renderNotice(notice: CompletionNotice, escape: (s: string) => string): string {
  const head = notice.reason === 'completed'
    ? '✅ <b>任务完成</b>'
    : notice.reason === 'aborted'
      ? '⏹ <b>任务已中止</b>'
      : notice.reason === 'max-tokens'
        ? '⚠️ <b>任务因输出上限中断</b>'
        : notice.reason === 'interrupted'
          ? '⚠️ <b>任务被进程重启中断</b>'
          : '❌ <b>任务失败</b>'

  const lines = [head, '']
  lines.push(`轮次：${String(notice.turns)}　耗时：${humanDuration(notice.durationMs)}`)
  if (notice.detail !== '') lines.push(`原因：${escape(notice.detail)}`)
  if (notice.text.trim() !== '') {
    lines.push('', escape(notice.text))
  }
  return lines.join('\n')
}
