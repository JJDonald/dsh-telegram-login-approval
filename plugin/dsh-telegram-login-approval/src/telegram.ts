/**
 * 极简 Telegram Bot 客户端（长轮询）。
 *
 * 只用 Node 内置能力：全局 `fetch` + `AbortController`。
 * 不引入任何 npm 依赖，因此可被 overlay 以绝对路径加载。
 *
 * 安全要点：
 *  - 只接受白名单内的数字用户 ID，且必须是私聊（chat.type === 'private'）
 *  - 日志中绝不出现 Bot Token、token 明文或 cookie
 *  - offset 持久化，进程重启不丢更新、不重复处理
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Telegram Update 的最小结构（只声明用到的字段）。 */
export interface TgUpdate {
  update_id: number
  message?: {
    message_id: number
    chat: { id: number; type?: string }
    from?: { id: number }
    text?: string
  }
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
    message?: { message_id: number; chat: { id: number } }
  }
}

/** 发送结果。 */
export interface SendResult {
  ok: boolean
  messageId: number
  description: string
}

/** 发送消息时的内联键盘按钮。 */
export interface InlineButton {
  text: string
  callbackData: string
}

/** Bot API 调用封装。 */
export class TelegramClient {
  private readonly apiBase: string

  constructor(
    private readonly token: string,
    private readonly log: (message: string) => void,
  ) {
    this.apiBase = `https://api.telegram.org/bot${token}`
  }

  /** 底层调用；任何异常都转为 { ok:false }，绝不向调用方抛网络错误。 */
  private async call(method: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
      const response = await fetch(`${this.apiBase}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        ...(signal !== undefined ? { signal } : {}),
      })
      const json = await response.json() as Record<string, unknown>
      return json
    } catch (error) {
      // 绝不把 token 带进日志（apiBase 含 token，只记错误本身）。
      const reason = error instanceof Error ? error.message : String(error)
      return { ok: false, description: `network: ${reason}` }
    }
  }

  /** 取本 Bot 身份，用于启动自检。 */
  async getMe(): Promise<{ ok: boolean; username: string; description: string }> {
    const res = await this.call('getMe', {})
    const result = res.result as { username?: string } | undefined
    return {
      ok: res.ok === true,
      username: result?.username ?? '',
      description: typeof res.description === 'string' ? res.description : '',
    }
  }

  /** 发送文本消息。 */
  async sendMessage(
    chatId: number,
    text: string,
    buttons: readonly InlineButton[] = [],
  ): Promise<SendResult> {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }
    if (buttons.length > 0) {
      payload.reply_markup = {
        inline_keyboard: [buttons.map(b => ({ text: b.text, callback_data: b.callbackData }))],
      }
    }
    const res = await this.call('sendMessage', payload)
    const result = res.result as { message_id?: number } | undefined
    return {
      ok: res.ok === true,
      messageId: Number(result?.message_id ?? 0),
      description: typeof res.description === 'string' ? res.description : '',
    }
  }

  /** 编辑既有消息（批准后更新卡片，避免重复消息）。 */
  async editMessageText(chatId: number, messageId: number, text: string): Promise<void> {
    await this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    })
  }

  /** 应答 callback（消除客户端加载动画）。 */
  async answerCallbackQuery(callbackQueryId: string, text: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text })
  }

  /**
   * 取一批更新。
   * @param offset - 已确认的下一个 update_id；-1 表示首次运行。
   * @param timeoutSeconds - 长轮询挂起秒数。
   */
  async getUpdates(offset: number, timeoutSeconds: number, signal?: AbortSignal): Promise<{ ok: boolean; updates: TgUpdate[]; description: string }> {
    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      allowed_updates: ['message', 'callback_query'],
    }
    if (offset >= 0) payload.offset = offset
    const res = await this.call('getUpdates', payload, signal)
    return {
      ok: res.ok === true,
      updates: Array.isArray(res.result) ? res.result as TgUpdate[] : [],
      description: typeof res.description === 'string' ? res.description : '',
    }
  }
}

/** offset 的持久化（不丢更新、不重复处理）。 */
export class OffsetStore {
  private next: number
  private readonly first: boolean

  constructor(private readonly file: string) {
    let parsed: { nextOffset?: number } = {}
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8')) as { nextOffset?: number }
    } catch {
      // 首次运行或文件损坏：从头开始（首次会跳过积压）。
    }
    const value = Number(parsed.nextOffset)
    this.next = Number.isSafeInteger(value) && value >= 0 ? value : -1
    this.first = this.next === -1
  }

  /** 首次运行：跳过安装前的历史积压，避免重放旧消息。 */
  isFirstRun(): boolean {
    return this.first
  }

  /** 当前 offset（-1 = 尚未建立游标）。 */
  current(): number {
    return this.next
  }

  /** 推进并落盘。 */
  advance(updateId: number): void {
    this.next = Math.max(this.next, updateId + 1)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ nextOffset: this.next }), 'utf8')
    } catch {
      // 落盘失败不影响本轮处理；下次重启会重放（幂等由 store 保证）。
    }
  }

  /** 首次运行时直接快进到最新，不处理积压。 */
  fastForward(updates: readonly TgUpdate[]): void {
    for (const update of updates) this.next = Math.max(this.next, update.update_id + 1)
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify({ nextOffset: this.next }), 'utf8')
    } catch {
      /* 同上 */
    }
  }
}
