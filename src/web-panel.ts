import { randomBytes } from 'node:crypto'
import { escapeHtml as e } from './page.ts'
import { SettingsStore, validateSetting, type Setting } from './settings.ts'
import { SessionStore } from './sessions.ts'
import { TelegramClient, type InlineButton, type TgUpdate } from './telegram.ts'

interface PanelOptions {
  client: TelegramClient
  admin: number
  botUsername: string
  settings: SettingsStore
  sessions: SessionStore
  runtime: { host: string; port: number; publicOrigin: string }
  pendingCount(): number
  key(): string
  resetKey(): void
  changed(): void
}
interface Card { messageId: number; token: string; expiresAt: number; field?: Setting; confirm?: string }
const labels: Record<Setting, string> = {
  host: '绑定地址', port: '绑定端口', publicOrigin: '自定义地址', sessionDays: 'Session有效期',
  approvalSeconds: '登录确认有效期', failureCooldownSeconds: '失败登录冷却时间',
}

/** 一个当前管理卡片；回调同时绑定随机标识 + 私聊消息ID，设置必须回复指定提示。 */
export class WebPanel {
  private card?: Card
  constructor(private readonly o: PanelOptions) {}
  private button(token: string, text: string, action: string): InlineButton {
    return { text, callbackData: `web:${token}:${action}` }
  }
  private async send(text: string, rows: (t: string) => InlineButton[][], extra: Partial<Card> = {}): Promise<void> {
    const token = randomBytes(6).toString('hex')
    const result = await this.o.client.sendMessage(this.o.admin, text, rows(token), extra.field !== undefined)
    if (!result.ok) throw new Error('Telegram 管理卡片发送失败')
    this.card = { messageId: result.messageId, token, expiresAt: Date.now() + 600_000, ...extra }
  }
  async show(): Promise<void> {
    const { runtime: r, settings, sessions } = this.o
    const s = settings.value
    const bind = (host: string, port: number) => `${host.includes(':') ? `[${host}]` : host}:${port}`
    const internal = `http://${bind(r.host, r.port)}/`
    const text = ['🌐 <b>Web 管理台</b>', '状态：启用', `当前绑定：<code>${e(bind(r.host, r.port))}</code>`,
      `内部访问地址：${e(internal)}（认证仍需公开HTTPS Host，不是另一个登录入口）`,
      `当前公开地址：${e(r.publicOrigin)}`, `待下次人工启动：${e(bind(s.host, s.port))} · ${e(s.publicOrigin)}`,
      `访问密钥：<code>${e(this.o.key())}</code>`, `当前 Web Session：${sessions.list().length}`,
      `待确认登录：${this.o.pendingCount()}`, `Session有效期：${s.sessionDays} 天（上限 ${settings.maxDays} 天）`,
      `登录确认有效期：${s.approvalSeconds} 秒`, `失败登录冷却：${s.failureCooldownSeconds} 秒（全局10次错误/60秒）`,
      '', '设置期限仅影响新条目；绑定/公开地址仅保存，需人工重启与代理配置。'].join('\n')
    await this.send(text, t => [
      [this.button(t, labels.host, 'set-host'), this.button(t, labels.port, 'set-port')],
      [this.button(t, labels.publicOrigin, 'set-publicOrigin'), this.button(t, labels.sessionDays, 'set-sessionDays')],
      [this.button(t, labels.approvalSeconds, 'set-approvalSeconds'), this.button(t, labels.failureCooldownSeconds, 'set-failureCooldownSeconds')],
      [this.button(t, '重置访问密钥', 'reset'), this.button(t, '当前登录会话', 'list-0')],
      [this.button(t, '踢出全部Web会话', 'all')],
    ])
  }
  private async list(page: number): Promise<void> {
    const sessions = this.o.sessions.list()
    const pages = Math.max(1, Math.ceil(sessions.length / 5))
    page = Math.min(page, pages - 1)
    const visible = sessions.slice(page * 5, page * 5 + 5)
    const text = ['🌐 <b>浏览器登录会话</b>', `共 ${sessions.length} 个 · 第 ${page + 1}/${pages} 页`,
      '不是DSH任务会话；真实客户端IP不可得，不采信转发头。', ...visible.map(s =>
        `\nID：<code>${e(s.id.slice(0, 8))}</code>\n登录：${new Date(s.createdAt).toISOString()}\n到期：${new Date(s.expiresAt).toISOString()}\n浏览器：${e(s.userAgent.slice(0, 80) || '未提供UA')}`)].join('\n')
    await this.send(text, t => [
      ...visible.map(s => [this.button(t, `踢出 ${s.id.slice(0, 8)}`, `kick-${s.id}`)]),
      ...(page > 0 ? [[this.button(t, '上一页', `list-${page - 1}`)]] : []),
      ...(page + 1 < pages ? [[this.button(t, '下一页', `list-${page + 1}`)]] : []),
      [this.button(t, '返回管理台', 'home')],
    ])
  }
  async handle(update: TgUpdate): Promise<boolean> {
    const m = update.message
    if (m) {
      if (m.from?.id !== this.o.admin || m.chat.id !== this.o.admin || m.chat.type !== 'private') return false
      const text = (m.text ?? '').trim()
      const command = text.replace(new RegExp(`@${this.o.botUsername}$`), '')
      if (command === '/web' || command === '/start') { await this.show(); return true }
      if (command === '/cancel') { this.card = undefined; await this.o.client.sendMessage(this.o.admin, '已取消。发送 /web 打开管理台。'); return true }
      const card = this.card
      if (!card?.field) return false
      if (card.expiresAt <= Date.now() || m.reply_to_message?.message_id !== card.messageId) {
        await this.o.client.sendMessage(this.o.admin, '设置未保存：请回复当前设置提示（10分钟内），或发送 /web 重开。'); return true
      }
      try { validateSetting(card.field, text, this.o.settings.maxDays) }
      catch (error) { await this.o.client.sendMessage(this.o.admin, e((error as Error).message)); return true }
      try { this.o.settings.set(card.field, text); this.o.changed() }
      catch { await this.o.client.sendMessage(this.o.admin, '保存失败，未确认变更成功。请检查状态文件与权限。'); return true }
      this.card = undefined
      await this.o.client.sendMessage(this.o.admin, ['host', 'port', 'publicOrigin'].includes(card.field)
        ? '已保存待生效配置。没有重启或修改代理；下次使用启动衔接脚本人工启动加载。' : '已保存，新条目使用新值，旧条目保持原到期/冷却时间。')
      await this.show(); return true
    }
    const cb = update.callback_query
    if (!cb?.data?.startsWith('web:')) return false
    if (cb.from.id !== this.o.admin || cb.message?.chat.id !== this.o.admin || cb.message.chat.type !== 'private') return true
    const [, token, action] = cb.data.split(':')
    const card = this.card
    if (!card || token !== card.token || cb.message.message_id !== card.messageId || card.expiresAt <= Date.now() || card.field) {
      await this.o.client.answerCallbackQuery(cb.id, '此卡片已失效，请发送 /web'); return true
    }
    await this.o.client.answerCallbackQuery(cb.id, '处理中')
    if (action === 'home' || action === 'cancel') { await this.show(); return true }
    if (action?.startsWith('set-')) {
      const field = action.slice(4) as Setting
      if (!(field in labels)) return true
      const range = field === 'host' ? '推荐 127.0.0.1；也可填本机具体 IPv4/IPv6 地址（如 ::1，无方括号或 %zone），禁止 0.0.0.0 / :: 等通配地址' : field === 'port' ? '1–65535整数' : field === 'publicOrigin' ? 'https://域名[:端口]，无尾斜杠或路径' : field === 'sessionDays' ? `1–${this.o.settings.maxDays} 整数天` : field === 'approvalSeconds' ? '30–3600整数秒' : '60–86400整数秒'
      await this.send(`请<b>回复此消息</b>设置「${labels[field]}」：${e(range)}\n10分钟内有效；/cancel 取消。`, () => [], { field }); return true
    }
    if (/^list-\d+$/.test(action ?? '')) { await this.list(Number(action!.slice(5))); return true }
    if (action === 'reset' || action === 'all' || /^kick-[a-f0-9-]{36}$/.test(action ?? '')) {
      const detail = action === 'reset' ? '重置访问密钥？旧密钥立即失效，但现有Web会话和已创建批准请求不会被踢出。' : action === 'all' ? '踢出全部Web会话？已有WS连接也会关闭，所有浏览器需重新批准登录。' : `踢出会话 ${e(action!.slice(5, 13))}？其已有WS连接会关闭。`
      await this.send(detail, t => [[this.button(t, '确认操作', 'yes'), this.button(t, '取消', 'cancel')]], { confirm: action }); return true
    }
    if (action === 'yes' && card.confirm) {
      this.card = undefined // 确认单次消费，避免重放重置
      try {
        if (card.confirm === 'reset') this.o.resetKey()
        else this.o.sessions.revoke(card.confirm === 'all' ? undefined : card.confirm.slice(5))
      } catch { await this.o.client.sendMessage(this.o.admin, '持久化失败，未确认操作成功；请检查文件与备份。'); return true }
      await this.o.client.sendMessage(this.o.admin, '操作已完成。')
      await this.show(); return true
    }
    return true
  }
}
