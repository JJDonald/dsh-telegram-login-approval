import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ApprovalStore, hashToken, type PendingApproval } from './approvals.ts'
import { TriggerLimiter } from './rate-limit.ts'
import { readHeader } from './util.ts'
import { renderLoginPage, type LoginState } from './login-page.ts'

const NONCE_COOKIE = '__Host-dsh-login'
const CLEAR_NONCE = `${NONCE_COOKIE}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Strict`
const INPUT_WINDOW_MS = 60_000
const MAX_INPUTS = 10
const BODY_LIMIT = 4096

export interface LoginConnection {
  requestRejection(request: { headers: unknown }): number | undefined
  authenticatedUrl(baseUrl: string): string
}
export type AuthorizeIndex = (request: { method?: string; url?: string; headers: unknown }, response: unknown) => boolean
interface LoginOptions {
  origin: string
  /** Bot 用户名（不含 @）；空串时页面使用通用文案。 */
  botUsername: string
  secretFile: string
  connection: LoginConnection
  original: AuthorizeIndex
  store: ApprovalStore
  limiter: TriggerLimiter
  sendConfirmation(item: PendingApproval): Promise<void>
}

/** Secret Key 与 launch token 均仅留在服务内存，不作为页面内容或日志字段。 */
export class WebLogin {
  private readonly secret: Buffer
  private readonly internalUrl: string
  private inputStartedAt = 0
  private inputs = 0

  constructor(private readonly options: LoginOptions) {
    const stat = statSync(options.secretFile)
    if (stat.uid !== 0 || (stat.mode & 0o077) !== 0 || !stat.isFile()) {
      throw new Error('DSH Secret Key 文件必须为 root-only 普通文件')
    }
    this.secret = Buffer.from(readFileSync(options.secretFile, 'utf8').trim(), 'utf8')
    if (this.secret.length !== 43) throw new Error('DSH Secret Key 文件格式无效')
    const internal = new URL(options.connection.authenticatedUrl(`${options.origin}/`))
    this.internalUrl = internal.pathname + internal.search
  }

  /** 只供管理员主动私聊 /key 的既有白名单处理器调用。 */
  adminKey(): string { return this.secret.toString('utf8') }

  private trusted(req: IncomingMessage, post = false): boolean {
    if (readHeader(req.headers, 'host') !== new URL(this.options.origin).host) return false
    if (readHeader(req.headers, 'sec-fetch-site') === 'cross-site') return false
    const origin = readHeader(req.headers, 'origin')
    return post ? origin === this.options.origin : origin === '' || origin === this.options.origin
  }

  private nonce(req: IncomingMessage): string {
    const values = readHeader(req.headers, 'cookie').split(';')
      .map(part => part.trim()).filter(part => part.startsWith(`${NONCE_COOKIE}=`))
    if (values.length !== 1) return ''
    const value = values[0]!.slice(NONCE_COOKIE.length + 1)
    return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : ''
  }

  private html(req: IncomingMessage, res: ServerResponse, state: LoginState, status = 200, detail = '', refresh = false): void {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
      'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    })
    res.end(req.method === 'HEAD' ? undefined : renderLoginPage(state, detail, refresh, this.options.botUsername))
  }

  private reject(res: ServerResponse, status: number): void {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
    res.end(status === 403 ? 'forbidden' : 'unauthorized')
  }

  /** 包装所有真实 index 入口；旧 launch-token 从不被交给原认证交换。 */
  authorizeIndex(req: IncomingMessage, res: ServerResponse): boolean {
    if (!this.trusted(req)) { this.reject(res, 403); return false }
    if (new URL(req.url!, this.options.origin).searchParams.has('token')) {
      this.reject(res, 401); return false
    }
    let rejection: number | undefined
    try { rejection = this.options.connection.requestRejection(req) }
    catch { this.reject(res, 401); return false }
    if (rejection === undefined) return this.options.original.call(this.options.connection, req, res)
    if (rejection === 403) { this.reject(res, 403); return false }
    this.html(req, res, 'form')
    return false
  }

  /** 输入正文的真实边界：最多4KiB，网络中断不会触发通知或凭证交换。 */
  private async body(req: IncomingMessage): Promise<string | undefined> {
    if (Number(readHeader(req.headers, 'content-length')) > BODY_LIMIT) return undefined
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > BODY_LIMIT) return undefined
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }

  async login(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end(); return }
    if (!this.trusted(req, true)) { this.reject(res, 403); return }
    if (new URL(req.url!, this.options.origin).search !== '') { this.reject(res, 400); return }
    const now = Date.now()
    if (now - this.inputStartedAt >= INPUT_WINDOW_MS) { this.inputStartedAt = now; this.inputs = 0 }
    if (this.inputs >= MAX_INPUTS) {
      res.setHeader('retry-after', String(Math.ceil((this.inputStartedAt + INPUT_WINDOW_MS - now) / 1000)))
      this.html(req, res, 'rate-limited', 429); return
    }
    this.inputs += 1
    if (readHeader(req.headers, 'content-type').split(';')[0] !== 'application/x-www-form-urlencoded') {
      this.reject(res, 415); return
    }
    let body: string | undefined
    try { body = await this.body(req) }
    catch { if (!res.destroyed) this.reject(res, 400); return }
    if (body === undefined) {
      res.setHeader('connection', 'close'); this.reject(res, 413); req.resume(); return
    }
    const secrets = new URLSearchParams(body).getAll('secret')
    const supplied = Buffer.from(secrets.length === 1 ? secrets[0]! : '', 'utf8')
    if (supplied.length !== this.secret.length || !timingSafeEqual(supplied, this.secret)) {
      this.html(req, res, 'invalid', 401); return
    }
    const existingNonce = this.nonce(req)
    const existing = existingNonce === '' ? undefined : this.options.store.find(hashToken(existingNonce))
    if (existing?.status === 'pending' || existing?.status === 'approved') {
      res.writeHead(303, { location: `/login/status?request=${existing.id}`, 'cache-control': 'no-store' }); res.end(); return
    }
    const limit = this.options.limiter.check('global', now)
    if (!limit.allowed) {
      this.html(req, res, 'rate-limited', 429, `请在约 ${limit.retryAfterSeconds} 秒后重试。`); return
    }
    const nonce = randomBytes(32).toString('base64url')
    const { item } = this.options.store.createOrReuse(hashToken(nonce), 'socket-peer', readHeader(req.headers, 'user-agent').slice(0, 200))
    this.options.limiter.record('global', now)
    void this.options.sendConfirmation(item)
    res.writeHead(303, {
      location: `/login/status?request=${item.id}`, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
      'set-cookie': `${NONCE_COOKIE}=${nonce}; Max-Age=300; Path=/; Secure; HttpOnly; SameSite=Strict`,
    })
    res.end()
  }

  status(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end(); return }
    if (!this.trusted(req)) { this.reject(res, 403); return }
    const ids = new URL(req.url!, this.options.origin).searchParams.getAll('request')
    const item = ids.length === 1 ? this.options.store.byIdLookup(ids[0]!) : undefined
    const nonce = this.nonce(req)
    if (!item || nonce === '' || item.tokenHash !== hashToken(nonce)) {
      this.html(req, res, 'expired', 401); return
    }
    if (item.status === 'denied' || item.status === 'expired') {
      this.html(req, res, item.status, item.status === 'denied' ? 403 : 410); return
    }
    if (item.status === 'pending') {
      const remain = Math.max(0, Math.ceil((item.expiresAt - Date.now()) / 1000))
      this.html(req, res, 'waiting', 200, `请求编号 ${item.id.slice(0, 8)} · 剩余约 ${remain} 秒`, true); return
    }
    // 消费在原同步签发之前完成，另一请求不能竞争重用同一次批准。
    this.options.store.consume(item.id)
    const writeHead = res.writeHead
    res.writeHead = function (status: number, headers?: any): ServerResponse {
      if (status !== 303 || typeof headers?.['set-cookie'] !== 'string') {
        throw new Error('DSH 原认证未完成 Cookie 交换')
      }
      return writeHead.call(res, status, {
        ...headers, location: '/',
        'set-cookie': [`${headers['set-cookie']}; Secure`, CLEAR_NONCE],
      })
    } as typeof res.writeHead
    try {
      this.options.original.call(this.options.connection, { method: 'GET', url: this.internalUrl, headers: req.headers }, res)
    } finally { res.writeHead = writeHead }
  }
}
