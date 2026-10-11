/**
 * DSH 登录带外批准插件。
 *
 * 切入点（已由实测确定）：包装 `ctx.connection.authorizeIndex`。
 *   frontend-static 的 fallback 在渲染 index 前以属性查找方式调用它，
 *   因此替换实例方法即可插入门禁，而 index.html 的渲染、遍历防护、
 *   <base> 注入全部保持 DSH 原样。
 *
 * 安全模型：
 *   - 批准 = 「准入」而非「认证」。放行时仍调用 DSH 原方法校验 token，
 *     因此拿不到正确 token 的攻击者即使骗到批准，最终仍是 401。
 *   - 批准单次消费，不可重放。
 *   - pending 仅存内存：进程重启即失效（fail-closed）。
 *   - 配置缺失直接抛错，绝不静默退化为「无门禁」。
 */

import { ctxLogger, readHeader } from './util.ts'
import { ConfigError, resolveConfig, type RawConfig } from './config.ts'
import { ApprovalStore, hashToken, shortHash, type PendingApproval } from './approvals.ts'
import { TriggerLimiter } from './rate-limit.ts'
import { OffsetStore, TelegramClient, type TgUpdate } from './telegram.ts'
import { renderGatePage } from './page.ts'
import { installTaskNotify } from './task-notify.ts'

export const name = 'telegram-login-approval'

/** 必须等这两个服务就绪后才包装。 */
/** 必须等这些服务就绪后才包装 / 订阅。 */
export const inject = ['webServer', 'connection']

/** callback_data 前缀；格式 `tla:<approve|deny>:<uuid>`。 */
const CB_PREFIX = 'tla'

/** 门禁期间自动刷新间隔（秒）。 */
const REFRESH_SECONDS = 3

/** 长轮询挂起秒数。 */
const POLL_TIMEOUT_SECONDS = 25

/** 任务段结束后的静置窗口（毫秒）；用于避开紧随其后的异步排入。 */
const SETTLE_MS = 800

/** 完成通知里最终回答的最大字符数（Telegram 单条上限 4096）。 */
const NOTICE_MAX_CHARS = 3200

/**
 * 限流计数键。
 *
 * 刻意用**单一全局键**而非 per-IP：本插件运行在 DSH 进程内，拿不到可信客户端 IP
 * （DSH 不采信 X-Forwarded-*，反代之后 socket 对端恒为代理）。
 * 若按不可信 IP 计数，攻击者可轻易伪造键绕过。全局冷却才是真正生效的防线。
 */
const LIMIT_KEY = 'global'
interface AuthorizeIndexFn {
  (request: { method?: string | undefined; url?: string | undefined; headers: unknown }, response: unknown): boolean
}

export function apply(ctx: unknown, rawConfig?: RawConfig): void {
  const log = ctxLogger(ctx, name)
  const config = resolveConfig(rawConfig)

  // 总开关：显式关闭时完全不包装（等价于未安装）。
  if (rawConfig?.enabled === false) {
    log.info('enabled=false，不启用登录门禁')
    return
  }

  const store = new ApprovalStore(config.ttlSeconds)
  const limiter = new TriggerLimiter(config.windowSeconds, config.maxTriggersPerWindow, config.cooldownSeconds)
  const client = new TelegramClient(config.botToken, (message) => { log.info(message) })
  const offsets = new OffsetStore(`${config.dataDir}/offset.json`)

  // ---------------------------------------------------------------------
  // 包装 authorizeIndex
  // ---------------------------------------------------------------------
  const connection = (ctx as { connection: Record<string, unknown> }).connection
  const original = connection.authorizeIndex as AuthorizeIndexFn
  if (typeof original !== 'function') {
    throw new ConfigError('ctx.connection.authorizeIndex 不是函数，DSH 版本可能已变更')
  }
  /** 纯检查方法：不写响应，仅返回 401/403 或 undefined。 */
  const rejectionFn = connection.requestRejection as
    | ((request: { headers: unknown }) => number | undefined)
    | undefined
  if (typeof rejectionFn !== 'function') {
    throw new ConfigError('ctx.connection.requestRejection 不是函数，DSH 版本可能已变更')
  }

  /** 提取请求中的 launch token（仅用于哈希比对，绝不留存明文）。 */
  function extractToken(req: { url?: string | undefined }): string {
    try {
      const url = new URL(req.url ?? '/', 'http://dsh.invalid')
      const tokens = url.searchParams.getAll('token')
      return tokens.length > 0 ? tokens.join('') : ''
    } catch {
      return ''
    }
  }

  /**
   * 只读判断请求是否已认证。
   *
   * 为什么要用 `requestRejection` 而不是先调 `authorizeIndex`：
   *   `authorizeIndex` 在**成功时也返回 false**（它写完 303 + Set-Cookie 后返回 false），
   *   失败时**已经写过 401 响应**。因此它既不能用来判态，也不能先调用再补写页面。
   *   `requestRejection` 是纯检查（返回 401/403 或 undefined），不写任何响应，
   *   正好适合「先判态、再决定是否接管」。
   */
  function isAuthenticated(req: { headers: unknown }): boolean {
    try {
      return rejectionFn.call(connection, req) === undefined
    } catch (error) {
      // 判态失败：按未认证处理（fail-closed）。
      log.warn(`requestRejection 抛出异常（按未认证处理）: ${String(error)}`)
      return false
    }
  }

  /**
   * 判断 launch token 是否**真实有效**（用一次性响应做探测器）。
   *
   * 为什么必须做这一步：`requestRejection` 只回答「是否已认证」，
   * 不校验 URL 里的 token。若只凭「URL 里有 token」就进入门禁，
   * 攻击者随便填一个假 token 就能反复触发 Telegram 通知（骚扰/耗尽批准额度）。
   *
   * 做法：用一个**抛弃的响应对象**调用原 `authorizeIndex`，读它写出的状态码。
   * 安全依据：`authorizeIndex` 只做「比对 token → 写 303+签名 cookie」或「写 401」，
   * 不修改任何服务端状态（无会话表写入、无计数器），因此用探测器调用没有副作用；
   * 探测产生的 Set-Cookie 只写进抛弃对象，不会到浏览器。
   *
   * @returns true = token 有效（真实登录请求）；false = 无效（按 DSH 原语义 401）。
   */
  function isTokenValid(req: { method?: string | undefined; url?: string | undefined; headers: unknown }): boolean {
    let status = 0
    const probe = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      writeHead(code: number): void {
        status = code
        this.statusCode = code
        this.headersSent = true
      },
      end(): void {
        this.writableEnded = true
      },
    }
    try {
      original.call(connection, req, probe)
    } catch (error) {
      log.warn(`token 探测异常（按无效处理）: ${String(error)}`)
      return false
    }
    // 有效 token 会写 303；已授权直出会写 200。
    return status >= 200 && status < 400
  }

  const patched: AuthorizeIndexFn = (req, res) => {
    // 1) 已认证：零打扰，直接交回 DSH 原流程（不触发任何通知）。
    if (isAuthenticated(req)) {
      return original.call(connection, req, res)
    }

    // 2) 未认证。只有「带**有效** token 的请求」才进入门禁：
    //    无 token 或 token 无效的请求保持 DSH 原本的 401 语义。
    if (extractToken(req) === '') {
      return original.call(connection, req, res)
    }
    if (!isTokenValid(req)) {
      return original.call(connection, req, res)
    }

    const tokenHash = hashToken(extractToken(req))
    const existing = store.find(tokenHash)
    const now = Date.now()

    // 3) 已被批准：不做任何响应，直接把请求交给 DSH 完成真正的凭证交换。
    //    注意：token 的真伪仍由 DSH 校验 —— 批准只是「准入」，不是「认证」。
    if (existing !== undefined && existing.status === 'approved') {
      log.info(`批准生效，放行凭证交换 | id=${existing.id.slice(0, 8)} hash=${shortHash(tokenHash)}`)
      const result = original.call(connection, req, res)
      // 交换成功才消费批准；失败（如 token 错误）保留批准以便用户重试。
      if (result === true || didWriteSuccess(res)) {
        store.consume(existing.id)
      }
      return result
    }

    // 4) 已被拒绝 / 已过期：给出明确页面，且不再触发通知。
    if (existing !== undefined && (existing.status === 'denied' || existing.status === 'expired')) {
      const state = existing.status === 'denied' ? 'denied' : 'expired'
      writeHtml(res, renderGatePage({ state, refreshSeconds: 0 }))
      return false
    }

    // 5) 限流检查（防止攻击者用登录入口轰炸手机）。
    const decision = limiter.check(LIMIT_KEY, now)
    if (!decision.allowed) {
      writeHtml(res, renderGatePage({
        state: 'rate-limited',
        refreshSeconds: 0,
        detail: `请在约 ${String(decision.retryAfterSeconds)} 秒后重试。`,
      }))
      return false
    }

    // 6) 新建或复用 pending：复用可避免刷新导致的通知轰炸。
    const { item, created } = store.createOrReuse(
      tokenHash,
      'socket-peer',
      readHeader(req.headers, 'user-agent').slice(0, 200),
    )
    if (created) {
      limiter.record(LIMIT_KEY, now)
      void sendConfirmation(item)
    }

    const remainSeconds = Math.max(0, Math.round((item.expiresAt - now) / 1000))
    writeHtml(res, renderGatePage({
      state: 'waiting',
      refreshSeconds: REFRESH_SECONDS,
      detail: `请求编号 ${item.id.slice(0, 8)}，剩余有效期约 ${String(remainSeconds)} 秒。`,
    }))
    return false
  }

  /**
   * 安装补丁。
   *
   * **必须改共享 prototype，不能改实例**（实测结论）：
   *   `ctx.connection` 是 Cordis 的服务 facade，**每次属性访问都返回新对象**
   *   （实测 `ctx.connection === ctx.connection` 为 false）。
   *   因此在某个实例上 defineProperty 会被后续访问丢弃，补丁静默失效。
   *   而 prototype 是共享且稳定的，改它才能让所有 facade 都生效。
   *   实测：改 prototype 后，真实 `GET /?token=...` 请求确实命中了补丁。
   */
  const proto = Object.getPrototypeOf(connection) as Record<string, unknown>
  const protoDesc = Object.getOwnPropertyDescriptor(proto, 'authorizeIndex')
  if (protoDesc === undefined || typeof protoDesc.value !== 'function') {
    throw new ConfigError('无法定位 connection.authorizeIndex 的 prototype 描述符，DSH 版本可能已变更')
  }
  const originalFromProto = protoDesc.value as AuthorizeIndexFn
  // 以 prototype 上的实现为准：facade 上的方法可能是包装过的，原样调用最可靠。
  Object.defineProperty(proto, 'authorizeIndex', {
    value: patched,
    writable: true,
    configurable: true,
    enumerable: protoDesc.enumerable ?? false,
  })
  log.info(`已包装 connection.authorizeIndex（prototype；ttl=${String(config.ttlSeconds)}s, dryRun=${String(config.dryRun)}）`)

  // 卸载时还原共享 prototype（ctx.effect 在 fiber dispose 时调用）。
  ctxEffect(ctx, () => {
    Object.defineProperty(proto, 'authorizeIndex', {
      value: originalFromProto,
      writable: true,
      configurable: true,
      enumerable: protoDesc.enumerable ?? false,
    })
    log.info('已还原 connection.authorizeIndex')
  }, `${name}: restore authorizeIndex`)


  // ---------------------------------------------------------------------
  // Telegram 确认与轮询
  // ---------------------------------------------------------------------

  /** 发送确认卡片。 */
  async function sendConfirmation(item: PendingApproval): Promise<void> {
    const text = [
      '🔐 <b>DSH 登录确认</b>',
      '',
      '有浏览器正在请求登录你的 DeepSeek Harness。',
      '',
      `请求编号：<code>${item.id.slice(0, 8)}</code>`,
      `有效期：${String(config.ttlSeconds / 60)} 分钟`,
      '',
      '如果不是你本人操作，请点「拒绝」。',
    ].join('\n')

    if (config.dryRun) {
      log.info(`[dryRun] 将发送确认卡片：${item.id.slice(0, 8)}`)
      return
    }

    const result = await client.sendMessage(config.adminChatId, text, [
      { text: '✅ 确认登录', callbackData: `${CB_PREFIX}:approve:${item.id}` },
      { text: '❌ 拒绝', callbackData: `${CB_PREFIX}:deny:${item.id}` },
    ])
    if (result.ok) {
      store.setMessageId(item.id, result.messageId)
      log.info(`已发送确认卡片 | id=${item.id.slice(0, 8)} msgId=${String(result.messageId)}`)
    } else {
      log.warn(`发送确认卡片失败: ${result.description}`)
    }
  }

  /** 处理一条 update。 */
  async function handleUpdate(update: TgUpdate): Promise<void> {
    const callback = update.callback_query
    if (callback !== undefined) {
      await handleCallback(callback)
      return
    }
    // 普通私聊消息：仅作最小响应，不构成任何授权。
    const message = update.message
    if (message !== undefined && message.text !== undefined) {
      const fromId = message.from?.id ?? 0
      if (fromId !== config.adminChatId) return
      if (message.chat.type !== 'private') return
      if (config.dryRun) return
      await client.sendMessage(config.adminChatId, '本 Bot 仅用于 DSH 登录确认，请在上方卡片上点击按钮。')
    }
  }

  /** 处理按钮回调。 */
  async function handleCallback(callback: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    // 白名单校验：必须是本人。
    if (callback.from.id !== config.adminChatId) {
      log.warn(`忽略非白名单 callback | from=${String(callback.from.id)}`)
      return
    }

    const parts = (callback.data ?? '').split(':')
    if (parts.length !== 3 || parts[0] !== CB_PREFIX) {
      await client.answerCallbackQuery(callback.id, '未知操作')
      return
    }
    const action = parts[1]
    const id = parts[2] ?? ''
    const approved = action === 'approve'

    const item = store.byIdLookup(id)
    if (item === undefined) {
      await client.answerCallbackQuery(callback.id, '该请求已失效')
      return
    }
    if (item.status !== 'pending') {
      await client.answerCallbackQuery(callback.id, `该请求已${item.status === 'approved' ? '确认' : '处理'}`)
      return
    }

    const decided = store.decide(id, approved, callback.from.id)
    // 只有真正从未决变为已决时才回应「成功」，否则如实报告状态。
    const effective = decided?.status === 'approved' || decided?.status === 'denied'
    await client.answerCallbackQuery(callback.id, effective ? (approved ? '已确认' : '已拒绝') : `请求已${decided?.status ?? '失效'}`)

    if (!effective) return

    log.info(`${approved ? '批准' : '拒绝'}登录请求 | id=${id.slice(0, 8)} by=${String(callback.from.id)}`)

    // 更新卡片，避免重复点击。
    const messageId = item.tgMessageId
    if (messageId > 0) {
      const label = approved
        ? '✅ <b>已确认</b>：浏览器正在进入。'
        : '❌ <b>已拒绝</b>：未发放任何登录凭证。'
      await client.editMessageText(config.adminChatId, messageId, `${label}\n\n请求编号：<code>${id.slice(0, 8)}</code>`)
    }
  }

  /** 长轮询循环。 */
  let stopped = false
  let pollDone: Promise<void> = Promise.resolve()

  async function pollLoop(): Promise<void> {
    let backoffMs = 1000
    while (!stopped) {
      const offset = offsets.current()
      const res = await client.getUpdates(offset, POLL_TIMEOUT_SECONDS)

      if (!res.ok) {
        if (!stopped) {
          log.warn(`getUpdates 失败，${String(Math.round(backoffMs / 1000))}s 后重试: ${res.description}`)
          await sleep(backoffMs)
          backoffMs = Math.min(backoffMs * 2, 60_000)
        }
        continue
      }
      backoffMs = 1000

      if (offsets.isFirstRun()) {
        // 首次运行：跳过安装前的历史积压，避免重放旧消息。
        offsets.fastForward(res.updates)
        log.info(`首次运行，跳过 ${String(res.updates.length)} 条历史更新`)
        continue
      }

      for (const update of res.updates) {
        if (stopped) break
        try {
          await handleUpdate(update)
        } catch (error) {
          // 毒消息要 ack（记日志），否则会永远重试。
          log.warn(`处理 update 失败（已跳过）: ${String(error)}`)
        }
        offsets.advance(update.update_id)
      }
    }
  }

  // dryRun 下**完全不启动轮询**：不发起任何 Telegram 网络请求，
  // 只保留门禁与页面行为，便于本地无网络验证。
  if (config.dryRun) {
    log.info('dryRun=true：不启动 Telegram 轮询，也不发送任何通知')
  } else {
    pollDone = pollLoop()
    ctxEffect(ctx, () => {
      stopped = true
      void pollDone
      log.info('已停止 Telegram 轮询')
    }, `${name}: poller`)
  }

  // ---------------------------------------------------------------------
  // M2：任务完成通知（订阅 session/event 与 agent/status）
  // ---------------------------------------------------------------------
  // 订阅失败不阻断登录门禁（门禁是安全路径，必须继续可用）。
  installTaskNotify({
    ctx,
    adminChatId: config.adminChatId,
    settleMs: SETTLE_MS,
    maxTextChars: NOTICE_MAX_CHARS,
    dryRun: config.dryRun,
    client,
    log,
    registerEffect: (callback, label) => { ctxEffect(ctx, callback, `${name}: ${label}`) },
  })

  if (!config.dryRun) {
    void client.getMe().then(
      (me) => {
        if (me.ok) log.info(`Telegram Bot 已连接: @${me.username}`)
        else log.warn(`Bot 自检失败（轮询将继续重试）: ${me.description}`)
      },
      (error: unknown) => { log.warn(`Bot 自检异常: ${String(error)}`) },
    )
  }

  log.info(`门禁已就绪（adminChatId=${String(config.adminChatId)}, 状态条目=${String(store.size())}）`)
}

// -------------------------------------------------------------------------
// 小工具
// -------------------------------------------------------------------------

/**
 * 判断原 `authorizeIndex` 是否**成功完成了凭证交换**。
 *
 * 它成功时返回 false（响应已由它写成 303 + Set-Cookie），因此不能看返回值。
 * 判据：它已写出响应头，且状态码是 2xx/3xx（成功交换或已授权直出）。
 * 401/403 等失败状态返回 false，从而不消费批准、允许用户重试。
 */
function didWriteSuccess(res: unknown): boolean {
  const response = res as { statusCode?: number; headersSent?: boolean; writableEnded?: boolean }
  const wrote = response.headersSent === true || response.writableEnded === true
  if (!wrote) return false
  const status = Number(response.statusCode ?? 0)
  return status >= 200 && status < 400
}
/** 写一个 HTML 响应；即使客户端已断开也不抛错。 */
function writeHtml(res: unknown, html: string): void {
  const response = res as {
    writeHead?: (status: number, headers?: Record<string, string>) => unknown
    end?: (body?: string) => unknown
    headersSent?: boolean
    writableEnded?: boolean
  }
  try {
    if (response.writableEnded === true) return
    response.writeHead?.(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    })
    response.end?.(html)
  } catch {
    // 响应对象可能是已被 DSH 写过的形态；忽略写入失败。
  }
}

/**
 * 注册一个 Cordis effect（作用域清理）。
 *
 * **关键语义**：`ctx.effect(fn)` 会**立即调用 `fn`**，并把 `fn` 的**返回值**当作
 * 卸载时的 disposer。因此必须写 `effect(() => callback)`（返回函数本身），
 * 写成 `effect(() => callback())` 会在安装那一刻就执行清理 —— 实测后果是
 * 补丁装上后立刻被还原、轮询刚启动就被置停。
 *
 * @param callback - 卸载时执行的清理函数。
 * @param label - 诊断用的 effect 标签。
 */
function ctxEffect(ctx: unknown, callback: () => void, label: string): void {
  const effect = (ctx as { effect?: (fn: () => (() => void), label?: string) => unknown }).effect
  if (typeof effect === 'function') {
    effect(() => callback, label)
  }
}

/** Promise 版 sleep。 */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => { setTimeout(resolve, ms) })
}
