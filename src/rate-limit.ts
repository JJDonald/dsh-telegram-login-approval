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

  /** 记一次触发；超限则进入冷却。 */
  record(key: string, now = Date.now()): void {
    const windowMs = this.windowSeconds * 1000
    const bucket = this.buckets.get(key)
    if (bucket === undefined || now - bucket.windowStart > windowMs) {
      this.buckets.set(key, { count: 1, windowStart: now, blockedUntil: 0 })
      return
    }
    bucket.count += 1
    if (bucket.count > this.maxPerWindow) {
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
