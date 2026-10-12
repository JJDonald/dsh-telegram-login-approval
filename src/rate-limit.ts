/**
 * 触发限流：防止攻击者用登录入口轰炸你的手机。
 *
 * 诚实说明（见规格文档风险 5）：本插件运行在 DSH 内部，
 * 拿不到可信的客户端 IP —— DSH 明确不采信 X-Forwarded-*，
 * 且反向代理之后 socket 对端恒为代理本身。
 * 因此这里采用「全局冷却 + 每窗口计数」为主，
 * 真实按 IP 的限流应交给反代层（nginx limit_req / fail2ban）。
 */

/** 限流判定结果。 */
export interface LimitDecision {
  allowed: boolean
  /** 被拒绝时还需等待的秒数。 */
  retryAfterSeconds: number
}

interface Bucket {
  count: number
  windowStart: number
  blockedUntil: number
}

/** 固定窗口计数 + 冷却。 */
export class TriggerLimiter {
  private readonly buckets = new Map<string, Bucket>()

  constructor(
    private readonly windowSeconds: number,
    private readonly maxPerWindow: number,
    private readonly cooldownSeconds: number,
  ) {}

  /** 只读检查，不计数。 */
  check(key: string, now = Date.now()): LimitDecision {
    const bucket = this.buckets.get(key)
    if (bucket === undefined) return { allowed: true, retryAfterSeconds: 0 }
    if (bucket.blockedUntil > now) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000),
      }
    }
    return { allowed: true, retryAfterSeconds: 0 }
  }

  /** 记一次获准触发；达到上限即进入冷却，不额外放行第 N+1 次。 */
  record(key: string, now = Date.now()): void {
    const windowMs = this.windowSeconds * 1000
    let bucket = this.buckets.get(key)
    if (bucket === undefined || now - bucket.windowStart > windowMs) {
      bucket = { count: 0, windowStart: now, blockedUntil: 0 }
      this.buckets.set(key, bucket)
    }
    bucket.count += 1
    if (bucket.count >= this.maxPerWindow) {
      bucket.blockedUntil = now + this.cooldownSeconds * 1000
      // 冷却开始后重置窗口，冷却结束时重新计数。
      bucket.count = 0
      bucket.windowStart = now
    }
  }

  /** 供诊断使用。 */
  size(): number {
    return this.buckets.size
  }
}

/** 错误密钥冷却：全局10次错误/60秒；调用方仅对错误输入检查/计数，正确输入不受限。旧冷却保留原截止时间。 */
export class FailureLimiter {
  private startedAt = 0
  private failures = 0
  private blockedUntil = 0
  constructor(public cooldownSeconds: number) {}
  check(now = Date.now()): number { return Math.max(0, Math.ceil((this.blockedUntil - now) / 1000)) }
  record(now = Date.now()): void {
    if (now - this.startedAt >= 60_000) { this.startedAt = now; this.failures = 0 }
    this.failures += 1
    if (this.failures >= 10) {
      this.blockedUntil = now + this.cooldownSeconds * 1000
      this.failures = 0
      this.startedAt = now
    }
  }
}
