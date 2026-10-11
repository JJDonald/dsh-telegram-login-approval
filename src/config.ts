/**
 * 插件的配置类型与解析。
 *
 * 设计约束：本插件**不使用任何裸模块导入**（只用 node: 内置），
 * 以便通过 cordis.yml overlay 以绝对路径加载——overlay 加载时，
 * 插件目录位于 dsh 仓库之外，无法解析 @deepseek-ai/* 依赖。
 */

/** overlay 中的原始配置。 */
export interface RawConfig {
  /** 总开关；false 时插件完全不包装 authorizeIndex（等价于未安装）。 */
  enabled?: boolean
  /** 唯一公开 HTTPS origin。 */
  publicOrigin?: string
  /** Bot 用户名（不含 @）；仅用于页面提示文案与 `/key` 指令匹配，可选。 */
  botUsername?: string
  /** root-only 持久 Secret Key 文件。 */
  secretFile?: string
  /** 凭据名（环境变量名），用于解析 Telegram Bot Token。 */
  botTokenRef?: string
  /** 直接给 Bot Token（不推荐；优先用 botTokenRef）。 */
  botToken?: string
  /** 唯一被接受的 Telegram 数字用户 ID。 */
  adminChatId?: number
  /** 一次批准请求的有效期（秒）。 */
  ttlSeconds?: number
  /** 限流窗口（秒）。 */
  windowSeconds?: number
  /** 单个窗口内允许触发的次数上限。 */
  maxTriggersPerWindow?: number
  /** 触发限流后的冷却时长（秒）。 */
  cooldownSeconds?: number
  /** 被拒绝时是否回发一条 Telegram 消息。 */
  notifyOnDeny?: boolean
  /** 演习模式：不真正调用 Telegram API，只写日志（用于本地验证）。 */
  dryRun?: boolean
  /** 状态目录；默认 $DSH_HOME/storages/telegram-login-approval。 */
  dataDir?: string
}

/** 校验并补默认值后的运行时配置。 */
export interface ResolvedConfig {
  publicOrigin: string
  /** 规范化后的 Bot 用户名（无 @）；未配置时为空串，页面提示自动降级为通用文案。 */
  botUsername: string
  secretFile: string
  botToken: string
  adminChatId: number
  ttlSeconds: number
  windowSeconds: number
  maxTriggersPerWindow: number
  cooldownSeconds: number
  notifyOnDeny: boolean
  dryRun: boolean
  dataDir: string
}

/** 配置校验失败时抛出，携带明确原因（绝不静默降级）。 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(`telegram-login-approval: ${message}`)
    this.name = 'ConfigError'
  }
}

/** 从环境变量按名解析 Bot Token（不使用 credentials 服务，避免额外依赖）。 */
function resolveBotToken(raw: RawConfig): string {
  const direct = typeof raw.botToken === 'string' ? raw.botToken.trim() : ''
  if (direct !== '') return direct
  const ref = typeof raw.botTokenRef === 'string' ? raw.botTokenRef.trim() : ''
  if (ref === '') return ''
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
    throw new ConfigError(`botTokenRef "${ref}" 不是合法的环境变量名`)
  }
  return (process.env[ref] ?? '').trim()
}

/** 正整数校验。 */
function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null) return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new ConfigError(`${name} 必须是正整数，收到 ${JSON.stringify(value)}`)
  }
  return n
}

/**
 * 校验配置。
 *
 * 与 DSH 的软失败不同，这里**缺配置即抛错**：
 * 登录门禁是安全路径，不允许静默退化为「无门禁」。
 */
export function resolveConfig(raw: RawConfig | undefined): ResolvedConfig {
  const cfg: RawConfig = raw ?? {}
  const token = resolveBotToken(cfg)

  const adminChatId = cfg.adminChatId === undefined ? 0 : Number(cfg.adminChatId)
  if (!Number.isSafeInteger(adminChatId) || adminChatId <= 0) {
    throw new ConfigError('adminChatId 必须是正的 Telegram 数字用户 ID（用 @userinfobot 查询）')
  }

  const dryRun = cfg.dryRun === true
  if (token === '' && !dryRun) {
    throw new ConfigError('缺少 Bot Token：请设置 botTokenRef 指向的环境变量，或设 dryRun: true 做本地验证')
  }

  const publicOrigin = cfg.publicOrigin ?? ''
  if (!/^https:\/\/[a-z0-9.-]+$/.test(publicOrigin)) {
    throw new ConfigError('publicOrigin 必须是配置的 HTTPS 公网域名 origin')
  }
  const secretFile = cfg.secretFile ?? ''
  if (!secretFile.startsWith('/')) throw new ConfigError('secretFile 必须是 root-only 凭据的绝对路径')
  const botUsername = (cfg.botUsername ?? '').trim().replace(/^@/, '')
  if (botUsername !== '' && !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(botUsername)) {
    throw new ConfigError(`botUsername "${botUsername}" 不是合法的 Telegram Bot 用户名`)
  }
  if (cfg.ttlSeconds !== undefined && Number(cfg.ttlSeconds) !== 300) throw new ConfigError('浏览器批准 TTL 固定为300秒')
  const dshHome = (process.env.DSH_HOME ?? '.').trim() || '.'
  return {
    publicOrigin,
    botUsername,
    secretFile,
    botToken: token,
    adminChatId,
    ttlSeconds: positiveInt(cfg.ttlSeconds, 300, 'ttlSeconds'),
    windowSeconds: positiveInt(cfg.windowSeconds, 600, 'windowSeconds'),
    maxTriggersPerWindow: positiveInt(cfg.maxTriggersPerWindow, 3, 'maxTriggersPerWindow'),
    cooldownSeconds: positiveInt(cfg.cooldownSeconds, 600, 'cooldownSeconds'),
    notifyOnDeny: cfg.notifyOnDeny !== false,
    dryRun,
    dataDir: typeof cfg.dataDir === 'string' && cfg.dataDir.trim() !== ''
      ? cfg.dataDir.trim()
      : `${dshHome.replace(/[\\/]+$/, '')}/storages/telegram-login-approval`,
  }
}
