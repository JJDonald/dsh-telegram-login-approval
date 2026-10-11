/**
 * DSH 登录带外批准插件。
 *
 * 切入点（已由实测确定）：包装 `ctx.connection.authorizeIndex`。
 *   frontend-static 的 fallback 在渲染 index 前以属性查找方式调用它，
 *   因此替换实例方法即可插入门禁，而 index.html 的渲染、遍历防护、
 *   <base> 注入全部保持 DSH 原样。
 *
 * 安全模型：
 *   - 长期独立 Secret Key 经 HTTPS POST 验证，再由管理员 Telegram 批准。
 *   - 批准绑定浏览器随机 nonce 与 requestId；内部 token 仅在服务内存交换原 Cookie。
 *   - 批准单次消费，不可重放。
 *   - pending 仅存内存：进程重启即失效（fail-closed）。
 *   - 配置缺失直接抛错，绝不静默退化为「无门禁」。
 */

import { ctxLogger } from './util.ts'
import { ConfigError, resolveConfig, type RawConfig } from './config.ts'
import { ApprovalStore, type PendingApproval } from './approvals.ts'
import { TriggerLimiter, FailureLimiter } from './rate-limit.ts'
import { SessionStore } from './sessions.ts'
import { SettingsStore } from './settings.ts'
import { WebPanel } from './web-panel.ts'
import { OffsetStore, TelegramClient, type TgUpdate } from './telegram.ts'
import { escapeHtml } from './page.ts'
import { WebLogin, type LoginConnection } from './web-login.ts'
import type { IncomingMessage, ServerResponse, Server } from 'node:http'
import { installTaskNotify } from './task-notify.ts'

export const name = 'telegram-login-approval'

/** 必须等这两个服务就绪后才包装。 */
/** 必须等这些服务就绪后才包装 / 订阅。 */
export const inject = ['webServer', 'connection']

/** callback_data 前缀；格式 `tla:<approve|deny>:<uuid>`。 */
const CB_PREFIX = 'tla'

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

  const webServer = (ctx as { webServer: {
    host: string; port: number; server: Server
    register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): void | Promise<void> }): () => void
  } }).webServer
  const nativeAge = (connection.browserAuth as { maxAgeMilliseconds: number })?.maxAgeMilliseconds
  if (!Number.isSafeInteger(nativeAge) || nativeAge < 86400_000 || !webServer.server || typeof webServer.server.emit !== 'function') {
    throw new ConfigError('DSH browserAuth寿命或WebServer.server接口不符合要求')
  }
  const settings = new SettingsStore(`${config.dataDir}/web-settings.json`, {
    host: webServer.host, port: webServer.port, publicOrigin: config.publicOrigin,
    sessionDays: config.sessionDays, approvalSeconds: config.ttlSeconds,
    failureCooldownSeconds: config.failureCooldownSeconds,
  }, Math.floor(nativeAge / 86400_000))
  // 网络配置以本次启动读取的值为准；运行中保存不改变当前origin/fence/listener。
  const runtime = { host: webServer.host, port: webServer.port, publicOrigin: settings.value.publicOrigin }
  const store = new ApprovalStore(settings.value.approvalSeconds)
  const failures = new FailureLimiter(settings.value.failureCooldownSeconds)
  const sessions = new SessionStore(`${config.dataDir}/web-sessions.json`)
  const login = new WebLogin({
    origin: runtime.publicOrigin,
    botUsername: config.botUsername,
    secretFile: config.secretFile,
    connection: connection as unknown as LoginConnection,
    original,
    store,
    limiter,
    failures,
    sessions,
    settings,
    sendConfirmation,
  })
  for (const [path, handler] of [
    ['/login', login.login.bind(login)],
    ['/login/status', login.status.bind(login)],
  ] as const) {
    const dispose = webServer.register({ kind: 'exact', path, handler })
    ctxEffect(ctx, dispose, `${name}: ${path}`)
  }
  const patched: AuthorizeIndexFn = (req, res) => login.authorizeIndex(req as IncomingMessage, res as ServerResponse)

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
  const rejectionDesc = Object.getOwnPropertyDescriptor(proto, 'requestRejection')
  if (!rejectionDesc || typeof rejectionDesc.value !== 'function') throw new ConfigError('无法定位requestRejection prototype')
  const originalRejection = rejectionDesc.value as (req: { headers: unknown }) => number | undefined
  Object.defineProperty(proto, 'requestRejection', { ...rejectionDesc, value: function (this: unknown, req: { headers: unknown }) {
    const result = originalRejection.call(this, req)
    return result ?? (sessions.find(req) ? undefined : 401)
  } })
  const disposeUpgrades = sessions.guardUpgrades(webServer.server, req => (connection as unknown as LoginConnection).requestRejection(req))
  // 以 prototype 上的实现为准：facade 上的方法可能是包装过的，原样调用最可靠。
  Object.defineProperty(proto, 'authorizeIndex', {
    value: patched,
    writable: true,
    configurable: true,
    enumerable: protoDesc.enumerable ?? false,
  })
  log.info(`已包装 connection.authorizeIndex（prototype；ttl=${String(store.ttlSeconds)}s, dryRun=${String(config.dryRun)}）`)

  // 卸载时还原共享 prototype（ctx.effect 在 fiber dispose 时调用）。
  ctxEffect(ctx, () => {
    disposeUpgrades()
    Object.defineProperty(proto, 'requestRejection', rejectionDesc)
    Object.defineProperty(proto, 'authorizeIndex', protoDesc)
    process.stdout.write('DSH_TELEGRAM_GATE_UNLOADED\n')
    log.info('已还原 connection.authorizeIndex')
  }, `${name}: restore authorizeIndex`)


  // ---------------------------------------------------------------------
  // Telegram 确认与轮询
  // ---------------------------------------------------------------------

  const panel = new WebPanel({
    client, admin: config.adminChatId, botUsername: config.botUsername,
    settings, sessions, runtime, pendingCount: () => store.pendingCount(),
    key: () => login.adminKey(), resetKey: () => login.resetKey(),
    changed: () => {
      store.ttlSeconds = settings.value.approvalSeconds
      failures.cooldownSeconds = settings.value.failureCooldownSeconds
    },
  })

  /** 发送确认卡片。 */
  async function sendConfirmation(item: PendingApproval): Promise<void> {
    const text = [
      '🔐 <b>DSH 登录确认</b>',
      '',
      '有浏览器正在请求登录你的 DeepSeek Harness。',
      '',
      `请求编号：<code>${item.id.slice(0, 8)}</code>`,
      `有效期：${String((item.expiresAt - item.createdAt) / 1000)} 秒`,
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
    if (await panel.handle(update)) return
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
      if (message.chat.type !== 'private' || message.chat.id !== config.adminChatId) return
      if (config.dryRun) return
      if (message.text.trim() === '/key' || (config.botUsername !== '' && message.text.trim() === `/key@${config.botUsername}`)) {
        await client.sendMessage(config.adminChatId, `🔑 <b>DSH 独立 Secret Key</b>\n\n<code>${escapeHtml(login.adminKey())}</code>\n\n仅用于 ${escapeHtml(runtime.publicOrigin)} ，请勿分享。`)
        return
      }
      await client.sendMessage(config.adminChatId, '本 Bot 用于 DSH 登录确认与任务通知。管理台请发送 /web，获取独立 Secret Key 请发送 /key。')
    }
  }

  /** 处理按钮回调。 */
  async function handleCallback(callback: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    // 白名单校验：必须是本人。
    if (callback.from.id !== config.adminChatId || callback.message?.chat.id !== config.adminChatId || callback.message?.chat.type !== 'private') {
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
    if (action !== 'approve' && action !== 'deny') {
      await client.answerCallbackQuery(callback.id, '未知操作')
      return
    }
    const approved = action === 'approve'

    const item = store.byIdLookup(id)
    if (item === undefined) {
      await client.answerCallbackQuery(callback.id, '该请求已失效')
      return
    }
    if (callback.message.message_id !== item.tgMessageId) {
      await client.answerCallbackQuery(callback.id, '该卡片不对应此请求')
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
      const res = await client.getUpdates(offset, offsets.isFirstRun() ? 0 : POLL_TIMEOUT_SECONDS)

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
        } catch {
          // 毒消息要 ack（记日志），否则会永远重试。
          log.warn('处理 update 失败（已跳过；不记录消息、凭证或错误正文）')
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

  process.stdout.write('DSH_TELEGRAM_GATE_READY\n')
  log.info(`门禁已就绪（adminChatId=${String(config.adminChatId)}, 状态条目=${String(store.size())}）`)
}

// -------------------------------------------------------------------------
// 小工具
// -------------------------------------------------------------------------

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
