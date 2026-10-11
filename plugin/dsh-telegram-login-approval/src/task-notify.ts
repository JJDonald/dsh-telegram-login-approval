/**
 * M2 接线：把 TurnWatcher 挂到真实的 DSH 事件源上。
 *
 * 单独成文件的原因：让 index.ts（门禁核心）保持可读，
 * 且事件接线可以在测试里独立驱动。
 */

import { TurnWatcher, renderNotice, type CompletionNotice } from './task-watch.ts'
import { escapeHtml } from './page.ts'

/** 最小的 logger 接口（与 util.ts 的 MiniLogger 兼容）。 */
export interface NotifyLogger {
  info: (message: string) => void
  warn: (message: string) => void
}

/** 最小的发送接口（TelegramClient 满足）。 */
export interface NotifySender {
  sendMessage: (chatId: number, text: string, buttons?: readonly never[]) => Promise<{ ok: boolean; description: string }>
}

export interface TaskNotifyOptions {
  /** DSH 的插件上下文（需要 `on` 与 `effect`）。 */
  ctx: unknown
  /** 发送目标（你的 Telegram 用户 id）。 */
  adminChatId: number
  /** 静置窗口毫秒数。 */
  settleMs: number
  /** 通知正文最大字符数。 */
  maxTextChars: number
  /** `true` 时不联网络，只记日志。 */
  dryRun: boolean
  client: NotifySender
  log: NotifyLogger
  /** 注册清理回调（对应 index.ts 的 ctxEffect）。 */
  registerEffect: (callback: () => void, label: string) => void
}

/**
 * 订阅 `session/event` 与 `agent/status`，在任务段结束时推送通知。
 *
 * 设计要点见 task-watch.ts：用「任务段 + 静置复查」而不是「单轮结束」，
 * 避免一个多轮任务被拆成多条通知。
 *
 * @returns 实际是否订阅成功（失败不影响登录门禁）。
 */
export function installTaskNotify(options: TaskNotifyOptions): boolean {
  const { ctx, client, log, adminChatId, settleMs, maxTextChars, dryRun, registerEffect } = options

  const idleState = new Map<string, boolean>()

  /** 发送完成通知。 */
  async function send(notice: CompletionNotice): Promise<void> {
    if (dryRun) {
      log.info(
        `[dryRun] 任务完成通知：session=${notice.sessionId.slice(0, 8)} `
        + `轮次=${String(notice.turns)} 原因=${notice.reason} 耗时=${String(notice.durationMs)}ms`,
      )
      return
    }
    const result = await client.sendMessage(adminChatId, renderNotice(notice, escapeHtml))
    if (result.ok) {
      log.info(`已发送任务完成通知 | session=${notice.sessionId.slice(0, 8)} reason=${notice.reason}`)
    } else {
      log.warn(`发送任务完成通知失败: ${result.description}`)
    }
  }

  const watcher = new TurnWatcher({
    settleMs,
    maxTextChars,
    log: (m) => { log.warn(m) },
    // 静置后复查：未显式标记为 running 即视为 idle。
    isIdle: (sessionId) => idleState.get(sessionId) !== false,
    notify: (notice) => { void send(notice) },
  })

  /** `session/event` 监听器。 */
  function onSessionEvent(session: unknown, event: unknown): void {
    try {
      const sessionId = String((session as { id?: unknown } | null)?.id ?? '')
      if (sessionId === '') return
      watcher.onSessionEvent(sessionId, event as { type?: unknown; data?: unknown })
    } catch (error) {
      // 监听器绝不能影响 session 提交。
      log.warn(`处理 session/event 失败（已忽略）: ${String(error)}`)
    }
  }

  /** `agent/status` 监听器。 */
  function onAgentStatus(payload: unknown): void {
    try {
      const p = payload as { agent?: { session?: { id?: unknown } }; status?: unknown } | null
      const sessionId = String(p?.agent?.session?.id ?? '')
      if (sessionId === '') return
      const status = String(p?.status ?? '')
      idleState.set(sessionId, status !== 'running')
      watcher.onAgentStatus(sessionId, status)
    } catch (error) {
      log.warn(`处理 agent/status 失败（已忽略）: ${String(error)}`)
    }
  }

  const on = (ctx as { on?: (name: string, fn: (...args: unknown[]) => void) => unknown } | null)?.on
  if (typeof on !== 'function') {
    log.warn('ctx.on 不可用，任务完成通知未启用（登录门禁不受影响）')
    return false
  }

  const disposers: Array<() => void> = []
  try {
    const d1 = on.call(ctx, 'session/event', onSessionEvent)
    if (typeof d1 === 'function') disposers.push(d1 as () => void)
    const d2 = on.call(ctx, 'agent/status', onAgentStatus)
    if (typeof d2 === 'function') disposers.push(d2 as () => void)
  } catch (error) {
    // 订阅失败不阻断登录门禁：门禁是安全路径，必须继续可用。
    log.warn(`订阅任务事件失败（任务通知不可用，登录门禁不受影响）: ${String(error)}`)
    return false
  }

  registerEffect(() => {
    // 先停计时器，避免 dispose 之后仍触发通知。
    watcher.dispose()
    for (const d of disposers) {
      try { d() } catch { /* 取消订阅失败不影响卸载 */ }
    }
    log.info('已取消任务事件订阅')
  }, 'task-notify')

  log.info('已订阅 session/event 与 agent/status（任务完成通知已启用）')
  return true
}
