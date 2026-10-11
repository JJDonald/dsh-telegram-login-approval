/**
 * 跨模块的小工具：日志与请求头读取。
 *
 * 独立成文件，便于 index.ts 专注于门禁逻辑。
 */

/** DSH logger 的最小接口。 */
export interface MiniLogger {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

/**
 * 从 ctx 取 logger。
 *
 * Cordis 的 `ctx.logger` 既可调用（`ctx.logger.info(...)`）也可能带命名参数，
 * 这里统一包一层保证只输出字符串，避免不同版本签名差异导致崩溃。
 */
export function ctxLogger(ctx: unknown, scope: string): MiniLogger {
  const logger = (ctx as { logger?: Record<string, unknown> }).logger
  const wrap = (level: 'info' | 'warn' | 'error'): ((message: string) => void) => {
    const fn = logger?.[level]
    return (message: string): void => {
      if (typeof fn !== 'function') return
      try {
        // 传字符串即可：DSH 的迭代器签名接受单条消息。
        ;(fn as (message: string) => unknown).call(logger, message)
      } catch {
        // 日志失败绝不能影响门禁逻辑。
      }
    }
  }
  const fallback = (level: 'info' | 'warn' | 'error') => (message: string): void => {
    if (typeof logger?.[level] !== 'function') {
      // 没有任何可用 logger 时才落到 stdout（不含敏感信息）。
      process.stdout.write(`[${scope}] ${message}\n`)
    }
  }
  const info = wrap('info')
  const warn = wrap('warn')
  const error = wrap('error')
  return {
    info: (m) => { info(m); fallback('info')(m) },
    warn: (m) => { warn(m); fallback('warn')(m) },
    error: (m) => { error(m); fallback('error')(m) },
  }
}

/** 读取请求头（兼容 Headers 与普通对象两种形态）。 */
export function readHeader(
  headers: unknown,
  name: string,
): string {
  if (headers === null || headers === undefined) return ''
  if (typeof (headers as { get?: unknown }).get === 'function') {
    const value = (headers as { get: (n: string) => unknown }).get(name)
    return typeof value === 'string' ? value : ''
  }
  const record = headers as Record<string, unknown>
  const direct = record[name] ?? record[name.toLowerCase()] ?? record[capitalize(name)]
  if (typeof direct === 'string') return direct
  if (Array.isArray(direct)) return direct.join(', ')
  return ''
}

/** 首字母大写（HTTP 头名兼容）。 */
function capitalize(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1).toLowerCase()
}
