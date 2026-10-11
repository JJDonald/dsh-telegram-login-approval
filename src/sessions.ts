import { randomBytes, randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import type { IncomingMessage, Server } from 'node:http'
import { hashToken } from './approvals.ts'
import { readHeader } from './util.ts'
import { readJson, savePrivate } from './persistence.ts'

export const SESSION_COOKIE = '__Host-dsh-web-session'
export interface WebSession {
  id: string
  tokenHash: string
  authority: string
  createdAt: number
  expiresAt: number
  userAgent: string
}

/** 原生 DSH Cookie + 此独立层缺一不可；落盘不包含任何原始凭证。 */
export class SessionStore {
  private records: WebSession[]
  private readonly sockets = new Map<Socket, { id: string; timer: ReturnType<typeof setTimeout> }>()
  constructor(private readonly file: string) {
    this.records = readJson<WebSession[]>(file) ?? []
    if (!Array.isArray(this.records) || this.records.some(s =>
      typeof s.id !== 'string' || !/^[a-f0-9]{64}$/.test(s.tokenHash) || typeof s.authority !== 'string' ||
      !Number.isSafeInteger(s.createdAt) || !Number.isSafeInteger(s.expiresAt) || s.expiresAt <= s.createdAt || typeof s.userAgent !== 'string')) {
      throw new Error('Web 会话文件格式无效')
    }
  }
  list(): WebSession[] { return this.records.filter(s => s.expiresAt > Date.now()).map(s => ({ ...s })) }
  find(request: { headers: unknown }): WebSession | undefined {
    const cookies = readHeader(request.headers, 'cookie').split(';').map(s => s.trim()).filter(s => s.startsWith(`${SESSION_COOKIE}=`))
    if (cookies.length !== 1) return undefined
    const token = cookies[0]!.slice(SESSION_COOKIE.length + 1)
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const hash = hashToken(token)
    const authority = readHeader(request.headers, 'host')
    return this.records.find(s => s.tokenHash === hash && s.authority === authority && s.expiresAt > Date.now())
  }
  create(authority: string, userAgent: string, days: number): string {
    const token = randomBytes(32).toString('base64url')
    const now = Date.now()
    const next = [...this.list(), { id: randomUUID(), tokenHash: hashToken(token), authority,
      userAgent: userAgent.slice(0, 200), createdAt: now, expiresAt: now + days * 86400_000 }]
    savePrivate(this.file, JSON.stringify(next) + '\n')
    this.records = next
    return `${SESSION_COOKIE}=${token}; Max-Age=${days * 86400}; Path=/; Secure; HttpOnly; SameSite=Strict`
  }
  revoke(id?: string): void {
    const next = id === undefined ? [] : this.records.filter(s => s.id !== id)
    savePrivate(this.file, JSON.stringify(next) + '\n')
    this.records = next
    for (const [socket, entry] of this.sockets) if (id === undefined || entry.id === id) socket.destroy()
  }
  private track(socket: Socket, session: WebSession): void {
    // Node 单个计时器上限约24.8天；按剩余时间分段，最终在实际到期时关闭。
    const schedule = (): ReturnType<typeof setTimeout> => setTimeout(() => {
      if (session.expiresAt <= Date.now()) socket.destroy()
      else this.sockets.get(socket)!.timer = schedule()
    }, Math.min(session.expiresAt - Date.now(), 2147483647))
    this.sockets.set(socket, { id: session.id, timer: schedule() })
    socket.once('close', () => {
      const entry = this.sockets.get(socket)
      if (entry) clearTimeout(entry.timer)
      this.sockets.delete(socket)
    })
  }
  /** 在原 upgrade 路由分发前把守；通过后原 fence/握手/协议所有者照常运行。 */
  guardUpgrades(server: Server, rejection: (req: IncomingMessage) => number | undefined): () => void {
    const original = server.emit
    const store = this
    const own = Object.getOwnPropertyDescriptor(server, 'emit')
    server.emit = function (event: string | symbol, ...args: any[]): boolean {
      if (event === 'upgrade') {
        const [req, socket] = args as [IncomingMessage, Socket]
        const status = rejection(req)
        const session = store.find(req)
        if (status !== undefined || !session) {
          socket.end(`HTTP/1.1 ${status ?? 401} ${status === 403 ? 'Forbidden' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
          return true
        }
        store.track(socket, session)
      }
      return original.call(this, event, ...args)
    }
    return () => {
      if (own) Object.defineProperty(server, 'emit', own)
      else delete (server as any).emit
      for (const [socket, entry] of store.sockets) { clearTimeout(entry.timer); socket.destroy() }
      store.sockets.clear()
    }
  }
}
