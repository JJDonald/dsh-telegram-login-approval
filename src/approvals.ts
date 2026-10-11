/**
 * 待批准请求的存储（仅内存）。
 *
 * 刻意不持久化：进程重启后未决批准全部丢失 = fail-closed。
 * 浏览器登录会话另由 SessionStore 持久化，不计入此表。
 */
import { createHash, randomUUID } from 'node:crypto'

/** 一条批准请求的状态。 */
export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired'

/** 一条批准请求。 */
export interface PendingApproval {
  /** 随机 id，用于 Telegram callback_data（不可预测）。 */
  id: string
  /** sha256(浏览器随机 nonce)；**绝不存明文 token**。 */
  tokenHash: string
  ip: string
  userAgent: string
  createdAt: number
  expiresAt: number
  status: ApprovalStatus
  /** 作出决定的 Telegram 用户 id。 */
  decidedBy: number
  /** 已发送的确认消息 id（用于批准后编辑）。 */
  tgMessageId: number
  /** 同一请求被触发的次数（刷新会累加，用于限流与去重）。 */
  triggers: number
}

/** 过期条目在被彻底清理前的保留时长：便于区分「过期」与「从未存在」。 */
const EXPIRED_RETENTION_MS = 3600_000
/** 内存中最多保留的条目数，防止无界增长。 */
const MAX_ENTRIES = 512

/** nonce → sha256 十六进制。 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** 供日志使用的短标识（不泄露 token）。 */
export function shortHash(hash: string): string {
  return hash.slice(0, 12)
}

/** 待批准请求表。 */
export class ApprovalStore {
  private readonly byId = new Map<string, PendingApproval>()
  private readonly byTokenHash = new Map<string, string>()

  constructor(public ttlSeconds: number) {}

  /** 清理过期条目并回收内存。 */
  private sweep(now: number): void {
    for (const [id, item] of this.byId) {
      if ((item.status === 'pending' || item.status === 'approved') && item.expiresAt <= now) {
        item.status = 'expired'
      }
      const stale = item.status !== 'pending' && now - item.expiresAt > EXPIRED_RETENTION_MS
      if (stale || this.byId.size > MAX_ENTRIES) {
        this.byId.delete(id)
        if (this.byTokenHash.get(item.tokenHash) === id) {
          this.byTokenHash.delete(item.tokenHash)
        }
      }
    }
  }

  /**
   * 为同一浏览器 nonce 复用未决请求，避免刷新导致的通知轰炸。
   * @returns 复用或新建的请求，以及是否为新建。
   */
  createOrReuse(tokenHash: string, ip: string, userAgent: string): { item: PendingApproval; created: boolean } {
    const now = Date.now()
    this.sweep(now)

    const existingId = this.byTokenHash.get(tokenHash)
    if (existingId !== undefined) {
      const existing = this.byId.get(existingId)
      if (existing !== undefined) {
        existing.triggers += 1
        return { item: existing, created: false }
      }
    }

    const item: PendingApproval = {
      id: randomUUID(),
      tokenHash,
      ip,
      userAgent,
      createdAt: now,
      expiresAt: now + this.ttlSeconds * 1000,
      status: 'pending',
      decidedBy: 0,
      tgMessageId: 0,
      triggers: 1,
    }
    this.byId.set(item.id, item)
    this.byTokenHash.set(tokenHash, item.id)
    return { item, created: true }
  }

  /** 按 nonce 哈希查找（含已过期条目，便于给出准确提示）。 */
  find(tokenHash: string): PendingApproval | undefined {
    const now = Date.now()
    this.sweep(now)
    const id = this.byTokenHash.get(tokenHash)
    if (id === undefined) return undefined
    return this.byId.get(id)
  }

  /** 按 id 查找，供 Telegram 回调使用。 */
  byIdLookup(id: string): PendingApproval | undefined {
    this.sweep(Date.now())
    return this.byId.get(id)
  }

  /**
   * 记录一次决定。仅当仍是 pending 且未过期时生效。
   * @returns 生效后的条目；未生效（已决定或已过期）时返回当前状态。
   */
  decide(id: string, approved: boolean, decidedBy: number, now = Date.now()): PendingApproval | undefined {
    const item = this.byId.get(id)
    if (item === undefined) return undefined
    if (item.status !== 'pending') return item
    if (item.expiresAt <= now) {
      item.status = 'expired'
      return item
    }
    item.status = approved ? 'approved' : 'denied'
    item.decidedBy = decidedBy
    return item
  }

  /** 记录确认消息 id。 */
  setMessageId(id: string, messageId: number): void {
    const item = this.byId.get(id)
    if (item !== undefined) item.tgMessageId = messageId
  }

  /** 单次消费：批准只能兑换一次凭证。 */
  consume(id: string): void {
    const item = this.byId.get(id)
    if (item === undefined) return
    if (this.byTokenHash.get(item.tokenHash) === id) {
      this.byTokenHash.delete(item.tokenHash)
    }
    this.byId.delete(id)
  }

  pendingCount(): number {
    this.sweep(Date.now())
    return [...this.byId.values()].filter(s => s.status === 'pending').length
  }

  /** 供诊断使用。 */
  size(): number {
    return this.byId.size
  }
}
