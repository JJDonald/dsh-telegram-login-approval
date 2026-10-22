/**
 * 集成验证：用假的 Cordis ctx + 假的 Telegram API 驱动完整的登录门禁流程。
 *
 * 为什么需要这个测试：真实 `dsh web` 跑通需要真实 Telegram Bot，
 * 而**安全关键路径**必须被验证：
 *   Secret Key 校验 → 生成带外批准 → Telegram 批准/拒绝 → 单次凭证交换 → 不可重放。
 * 这里用一个最小 fake ctx 直接驱动插件的 `apply`，并用假的 HTTPS 请求喂 Telegram update。
 *
 * 运行：
 *   cd dsh && node --import tsx/esm ../opendsh/tests/gate.test.mts
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { SessionStore } from '../src/sessions.ts'
import { FailureLimiter } from '../src/rate-limit.ts'
import { SettingsStore, validateSetting } from '../src/settings.ts'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'
import https from 'node:https'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { syncBuiltinESMExports } from 'node:module'

// 让插件把 offset 写到临时目录，避免污染。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'tla-test-'))
process.env.TLA_TEST_TOKEN = '123456:TEST_TOKEN_FOR_UNIT_TESTS'

const ORIGIN = 'https://test.example.com'
const ADMIN = 123456789
const SECRET = 'A'.repeat(43)
const TG_MESSAGE_ID = 42

const secretDir = mkdtempSync(join(tmpdir(), 'tla-secret-'))
const secretFile = join(secretDir, 'secret.key')
writeFileSync(secretFile, SECRET, { mode: 0o600 })
chmodSync(secretFile, 0o600)

// ---------------------------------------------------------------------------
// 假 Telegram API
// ---------------------------------------------------------------------------

interface TgUpdate {
  update_id: number
  message?: { message_id: number; chat: { id: number; type?: string }; from?: { id: number }; text?: string; reply_to_message?: { message_id: number } }
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
    message?: { message_id: number; chat: { id: number; type?: string } }
  }
}

const tg = { sendMessage: 0, getUpdates: 0, unknown: 0, texts: [] as string[], payloads: [] as Record<string, any>[] }
const queue: TgUpdate[] = []
let firstUpdatesDone = false

function json(value: Record<string, unknown>): Record<string, unknown> { return value }

async function telegramResponse(url: string, body: string): Promise<Record<string, unknown>> {
  const method = url.slice(url.lastIndexOf('/') + 1)
  const payload = JSON.parse(body) as Record<string, unknown>
  switch (method) {
    case 'getMe':
      return json({ ok: true, result: { username: 'testbot' } })
    case 'sendMessage':
      tg.sendMessage += 1
      tg.texts.push(String(payload.text ?? ''))
      tg.payloads.push(payload)
      return json({ ok: true, result: { message_id: TG_MESSAGE_ID } })
    case 'editMessageText':
    case 'answerCallbackQuery':
      return json({ ok: true, result: true })
    case 'getUpdates': {
      tg.getUpdates += 1
      if (!firstUpdatesDone) {
        // 首次运行：返回空批次，让插件快进历史积压。
        firstUpdatesDone = true
        return json({ ok: true, result: [] })
      }
      // 之后的每一次调用都等待测试推入一条 update。
      while (queue.length === 0) await new Promise<void>(r => setTimeout(r, 5))
      return json({ ok: true, result: [queue.shift()!] })
    }
    default:
      tg.unknown += 1
      return json({ ok: true, result: true })
  }
}

// HTTPS 替身沿用既有 Telegram 队列；全局 fetch 一旦被调用就让验证失败。
https.request = ((input: string, _options: unknown, callback: (response: Readable) => void) => {
  const req = new EventEmitter() as EventEmitter & { end(body: string): void }
  req.end = body => {
    void telegramResponse(String(input), body).then(
      value => { callback(Readable.from([JSON.stringify(value)])) },
      error => { req.emit('error', error) },
    )
  }
  return req
}) as typeof https.request
syncBuiltinESMExports()
globalThis.fetch = async () => { throw new Error('Telegram 不应经过全局 fetch') }

const mod = await import('../src/index.ts')

// ---------------------------------------------------------------------------
// Fake Cordis ctx（复现 DSH 的 facade + prototype 语义）
// ---------------------------------------------------------------------------

interface Written {
  status: number
  headers: Record<string, unknown>
  body: string
}

/** 服务实现放在共享 prototype 上：DSH 的 facade 每次访问都返回新对象。 */
class FakeConnection {
  /** 记录原 authorizeIndex 被真正调用的次数（即凭证交换次数）。 */
  static exchanges = 0

  // 同一套用例分别覆盖 0.2.0-rc.2 与 0.2.1-rc.2 的相反调用方向。
  static legacy = process.env.TLA_TEST_CONNECTION_MODE === 'legacy'
  browserAuth = { maxAgeMilliseconds: 30 * 86400_000 }
  private nativeRejection(req: { headers: Record<string, string> }): number | undefined {
    if (req.headers.host !== 'test.example.com' || (req.headers.origin && req.headers.origin !== ORIGIN)) return 403
    return req.headers.cookie?.includes('fake-session=v1.signed') ? undefined : 401
  }
  requestRejection(req: { headers: Record<string, string> }): number | undefined {
    if (FakeConnection.legacy) return this.nativeRejection(req)
    const result = this.admit(req)
    return 'rejection' in result ? result.rejection : undefined
  }
  admit(req: { headers: Record<string, string> }): { peer: FakeConnection } | { rejection: number } {
    const rejection = FakeConnection.legacy ? this.requestRejection(req) : this.nativeRejection(req)
    return rejection === undefined ? { peer: this } : { rejection }
  }

  authorizeIndex(_req: { url?: string }, res: { writeHead(s: number, h?: Record<string, string>): void; end(b?: string): void }): boolean {
    if (_req.url === '/' && this.requestRejection(_req as any) === undefined) return true
    FakeConnection.exchanges += 1
    res.writeHead(303, { 'set-cookie': 'fake-session=v1.signed' })
    res.end()
    return false
  }

  authenticatedUrl(base: string): string {
    return new URL('/__dsh_authenticated', base).toString()
  }
}

const logs: string[] = []
const effects: Array<() => void> = []
const httpServer = createServer()
const routes = new Map<string, (req: unknown, res: unknown) => unknown>()

function makeCtx(): unknown {
  const connection = new FakeConnection()
  return {
    connection,
    logger: {
      info: (m: string) => logs.push(`INFO ${m}`),
      warn: (m: string) => logs.push(`WARN ${m}`),
      error: (m: string) => logs.push(`ERROR ${m}`),
    },
    // Cordis 语义：立即调用 fn，把返回值当 disposer 保存。
    effect: (fn: () => (() => void) | void) => {
      const d = fn()
      if (typeof d === 'function') effects.push(d)
    },
    on: (_name: string, _fn: (...args: unknown[]) => void) => () => { /* 取消订阅 */ },
    webServer: {
      host: '127.0.0.1', port: 3080, server: httpServer,
      register: (route: { path: string; handler: (req: unknown, res: unknown) => unknown }) => {
        routes.set(route.path, route.handler)
        return () => { routes.delete(route.path) }
      },
    },
  }
}

// ---------------------------------------------------------------------------
// 假的请求 / 响应
// ---------------------------------------------------------------------------

function makeRes(): { written: Written; raw: Record<string, unknown> } {
  const written: Written = { status: 0, headers: {}, body: '' }
  const raw: Record<string, unknown> = {
    statusCode: 200,
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: unknown): void { written.headers[name.toLowerCase()] = value },
    writeHead(status: number, headers?: Record<string, unknown>): void {
      written.status = status
      for (const [k, v] of Object.entries(headers ?? {})) written.headers[k.toLowerCase()] = v
      raw.statusCode = status
      raw.headersSent = true
    },
    end(body?: unknown): void {
      written.body = typeof body === 'string' ? body : body === undefined ? '' : String(body)
      raw.writableEnded = true
    },
    resume(): void { /* body 已完整提供 */ },
  }
  return { written, raw }
}

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {},
  body?: string,
): Record<string, unknown> {
  const merged: Record<string, string> = { host: 'test.example.com', 'user-agent': 'tla-test', ...headers }
  if (body !== undefined) {
    merged['content-type'] = 'application/x-www-form-urlencoded'
    merged['content-length'] = String(Buffer.byteLength(body))
  }
  return {
    method,
    url,
    headers: merged,
    destroyed: false,
    resume(): void { /* 无实际 socket */ },
    iterator(): AsyncGenerator<Buffer> {
      const chunks = body === undefined ? [] : [Buffer.from(body)]
      return (async function* () { for (const chunk of chunks) yield chunk })()
    },
  }
}

/** 走真实的 prototype 调用路径（与 DSH 的调用方式一致）。 */
function request(method: string, url: string, headers: Record<string, string> = {}, body?: string): Written {
  const { written, raw } = makeRes()
  const connection = new FakeConnection()
  ;(Object.getPrototypeOf(connection) as { authorizeIndex: (...a: unknown[]) => unknown })
    .authorizeIndex.call(connection, makeReq(method, url, headers), raw)
  return written
}

async function callRoute(path: string, method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Written> {
  const handler = routes.get(path)
  if (handler === undefined) throw new Error(`路由未注册: ${path}`)
  const { written, raw } = makeRes()
  await handler(makeReq(method, url, headers, body), raw)
  return written
}

async function postLogin(cookie?: string, secret = SECRET): Promise<Written> {
  const headers: Record<string, string> = { origin: ORIGIN, 'sec-fetch-site': 'same-origin' }
  if (cookie !== undefined) headers.cookie = cookie
  return callRoute('/login', 'POST', '/login', headers, new URLSearchParams({ secret }).toString())
}

async function getStatus(cookie: string, requestId: string): Promise<Written> {
  return callRoute('/login/status', 'GET', `/login/status?request=${requestId}`, { cookie })
}

function cookieOf(out: Written): string {
  const raw = String(out.headers['set-cookie'] ?? '')
  const value = /__Host-dsh-login=([A-Za-z0-9_-]+)/.exec(raw)?.[1]
  if (value === undefined) throw new Error(`响应未设置 nonce cookie: ${raw}`)
  return `__Host-dsh-login=${value}`
}

function requestIdOf(out: Written): string {
  const location = String(out.headers.location ?? '')
  const id = new URL(location, ORIGIN).searchParams.get('request')
  if (id === null || id === '') throw new Error(`响应未带 request id: ${location}`)
  return id
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/** 轮询状态页直到出现期望状态码（批准/拒绝是异步经长轮询送达的）。 */
async function pollStatus(cookie: string, requestId: string, want: number, tries = 150): Promise<Written> {
  let out = await getStatus(cookie, requestId)
  for (let i = 0; i < tries && out.status !== want; i += 1) {
    await sleep(20)
    out = await getStatus(cookie, requestId)
  }
  return out
}

function callbackUpdate(id: string, data: string, from = ADMIN): TgUpdate {
  return {
    update_id: Math.floor(Math.random() * 1_000_000),
    callback_query: {
      id: `cb-${id.slice(0, 6)}`,
      from: { id: from },
      data,
      message: { message_id: TG_MESSAGE_ID, chat: { id: from, type: 'private' } },
    },
  }
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

const results: Array<{ name: string; ok: boolean; detail: string }> = []

async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    results.push({ name, ok: true, detail: '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

console.log('=== 登录门禁集成验证（fake ctx + fake Telegram）===\n')

const ctx = makeCtx()
const originalAdmit = FakeConnection.prototype.admit
const originalRejection = FakeConnection.prototype.requestRejection
console.log(`Connection 调用方向：${FakeConnection.legacy ? '旧版 admit → requestRejection' : '新版 requestRejection → admit'}\n`)

await check('插件 apply 成功执行', () => {
  mod.apply(ctx, {
    enabled: true,
    adminChatId: ADMIN,
    dryRun: false,
    publicOrigin: ORIGIN,
    botUsername: 'testbot',
    secretFile,
    botTokenRef: 'TLA_TEST_TOKEN',
  })
  assert.ok(logs.some(l => l.includes('已包装 connection.authorizeIndex')), '未记录包装日志')
  assert.ok(logs.some(l => l.includes('已订阅 session/event')), '任务通知未订阅')
  assert.ok(routes.has('/login') && routes.has('/login/status'), '登录路由未注册')
})

await check('prototype 补丁生效（新 facade 也命中）', () => {
  const patched = (Object.getPrototypeOf(new FakeConnection()) as { authorizeIndex: { name: string } }).authorizeIndex
  assert.equal(patched.name, 'patched', `期望 patched，实际 ${patched.name}`)
})

await check('未认证 GET / → 200 登录表单（不落入 DSH 的 401）', () => {
  const out = request('GET', '/')
  assert.equal(out.status, 200, `期望 200，实际 ${out.status}`)
  assert.ok(out.body.includes('Secret Key'), '应包含 Secret Key 输入')
  assert.ok(out.body.includes('@testbot'), '提示文案应使用配置的 botUsername')
  // 源码不应硬编码任何具体部署的 Bot：页面只呈现配置值。
  assert.ok(!out.body.includes('@dsh'), '不应残留硬编码 Bot 用户名')
})

await check('【安全】旧 launch token 查询参数被明确拒绝（401）', () => {
  const out = request('GET', '/?token=LEGACY_LAUNCH_TOKEN')
  assert.equal(out.status, 401, `期望 401，实际 ${out.status}`)
})

await check('错误 Secret Key → 401 且不发送任何 Telegram 通知', async () => {
  const before = tg.sendMessage
  const out = await postLogin(undefined, 'B'.repeat(43))
  assert.equal(out.status, 401, `期望 401，实际 ${out.status}`)
  assert.ok(out.body.includes('Secret Key 不正确'), '应返回密钥错误页')
  assert.equal(tg.sendMessage, before, '错误密钥不应触发确认卡片')
})

let cookie = ''
let requestId = ''
let sessionCookie = ''
let pendingCookie = ''
await check('正确 Secret Key → 303 到等待页并下发 nonce cookie', async () => {
  const before = tg.sendMessage
  const out = await postLogin()
  assert.equal(out.status, 303, `期望 303，实际 ${out.status}`)
  cookie = cookieOf(out)
  requestId = requestIdOf(out)
  const setCookie = String(out.headers['set-cookie'])
  assert.ok(setCookie.includes('Secure') && setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'), `cookie 属性不足: ${setCookie}`)
  assert.equal(tg.sendMessage, before + 1, '应发送一条确认卡片')
})

await check('等待页显示请求编号且自动刷新', async () => {
  const out = await getStatus(cookie, requestId)
  assert.equal(out.status, 200, `期望 200，实际 ${out.status}`)
  assert.ok(out.body.includes('等待 Telegram 确认'), '应返回等待页')
  assert.ok(out.body.includes('请求编号'), '等待页应含请求编号')
  assert.ok(out.body.includes('http-equiv="refresh"'), '等待页应自动刷新')
})

await check('重复提交复用同一请求（不轰炸通知）', async () => {
  const before = tg.sendMessage
  const out = await postLogin(cookie)
  assert.equal(out.status, 303, `期望 303，实际 ${out.status}`)
  assert.equal(requestIdOf(out), requestId, '应复用同一请求编号')
  assert.equal(tg.sendMessage, before, '重复提交不应再发确认卡片')
})

await check('【安全】非白名单 Telegram 用户无法批准', async () => {
  queue.push(callbackUpdate(requestId, `tla:approve:${requestId}`, 999))
  await sleep(60)
  const out = await getStatus(cookie, requestId)
  assert.equal(out.status, 200, `非白名单批准后仍应等待，实际 ${out.status}`)
  assert.ok(logs.some(l => l.includes('忽略非白名单 callback')), '应记录忽略日志')
})

await check('【安全】Telegram 批准 → 单次交换 DSH 凭证（303 → /）', async () => {
  queue.push(callbackUpdate(requestId, `tla:approve:${requestId}`))
  const out = await pollStatus(cookie, requestId, 303)
  assert.equal(out.status, 303, `期望 303，实际 ${out.status}`)
  assert.equal(out.headers.location, '/', '应重定向到根路径')
  const setCookie = out.headers['set-cookie'] as string[]
  assert.ok(Array.isArray(setCookie), '应同时写入原生会话、新会话与清理 nonce cookie')
  assert.ok(String(setCookie[0]).includes('; Secure'), '会话 cookie 应追加 Secure')
  assert.ok(String(setCookie[1]).includes('__Host-dsh-login=;'), '应清除 nonce cookie')
  assert.ok(String(setCookie[2]).startsWith('__Host-dsh-web-session='), '必须签发新会话层')
  sessionCookie = `fake-session=v1.signed; ${setCookie[2]!.split(';')[0]}`
})

await check('【安全】admit 与 requestRejection 双入口都要求两层 Cookie，并保留原生 fence', () => {
  const connection = new FakeConnection()
  for (const [headers, status] of [
    [{}, 401],
    [{ cookie: 'fake-session=v1.signed' }, 401],
    [{ cookie: sessionCookie.replace('fake-session=v1.signed; ', '') }, 401],
    [{ cookie: sessionCookie, origin: 'https://evil.example' }, 403],
    [{ cookie: sessionCookie, host: 'evil.example' }, 403],
  ] as Array<[Record<string, string>, number]>) {
    const req = makeReq('POST', '/api/settings.describe', headers) as any
    assert.deepEqual(connection.admit(req), { rejection: status })
    assert.equal(connection.requestRejection(req), status)
  }
  const accepted = makeReq('POST', '/api/settings.describe', { cookie: sessionCookie }) as any
  assert.ok('peer' in connection.admit(accepted), '合法双层会话应通过直接 admit')
  assert.equal(connection.requestRejection(accepted), undefined)
})

await check('【安全】批准不可重放：再次访问等待页被拒', async () => {
  const out = await getStatus(cookie, requestId)
  assert.equal(out.status, 401, `期望 401，实际 ${out.status}`)
})

await check('Telegram 拒绝 → 403 且不发凭证', async () => {
  const created = await postLogin()
  const denyCookie = cookieOf(created)
  const denyId = requestIdOf(created)
  queue.push(callbackUpdate(denyId, `tla:deny:${denyId}`))
  const out = await pollStatus(denyCookie, denyId, 403)
  assert.equal(out.status, 403, `期望 403，实际 ${out.status}`)
  assert.ok(out.body.includes('登录已被拒绝'), '应返回拒绝页')
})

// ---------------------------------------------------------------------------
// 配置校验（隐私改造：publicOrigin / botUsername 必须来自配置）
// ---------------------------------------------------------------------------

const base = { adminChatId: ADMIN, dryRun: true, publicOrigin: ORIGIN, secretFile }

await check('配置：缺少 adminChatId 抛错', () => {
  assert.throws(() => resolveConfig({ dryRun: true, publicOrigin: ORIGIN, secretFile }), /adminChatId/)
})

await check('配置：非 HTTPS publicOrigin 抛错', () => {
  assert.throws(() => resolveConfig({ ...base, publicOrigin: 'http://test.example.com' }), /publicOrigin/)
})

await check('配置：非法 botUsername 抛错', () => {
  assert.throws(() => resolveConfig({ ...base, botUsername: 'a' }), /botUsername/)
})

await check('配置：botUsername 去掉前导 @ 并规范化', () => {
  assert.equal(resolveConfig({ ...base, botUsername: '@TestBot' }).botUsername, 'TestBot')
  assert.equal(resolveConfig({ ...base, botUsername: '' }).botUsername, '', '未配置时应为空串')
})

await check('配置：批准TTL可调且限定30–3600秒', () => {
  assert.equal(resolveConfig({ ...base, ttlSeconds: 60 }).ttlSeconds, 60)
  assert.throws(() => resolveConfig({ ...base, ttlSeconds: 29 }))
})

await check('绑定配置：接受具体 IPv4/IPv6，拒绝通配地址并保留原保存值', () => {
  for (const host of ['127.0.0.1', '192.0.2.7', '::1', '2001:db8::7', '::ffff:127.0.0.1']) {
    assert.equal(validateSetting('host', host, 30), host)
  }
  for (const host of ['0.0.0.0', '::', '0:0:0:0:0:0:0:0', '::0.0.0.0', '::ffff:0.0.0.0', '::ffff:0:0', 'localhost', '[::1]', 'fe80::1%eth0']) {
    assert.throws(() => validateSetting('host', host, 30), /绑定地址|绑定|地址/)
  }
  const file = join(process.env.DSH_HOME!, 'host-settings.json')
  const defaults = { host: '127.0.0.1', port: 3080, publicOrigin: ORIGIN, sessionDays: 30, approvalSeconds: 300, failureCooldownSeconds: 600 }
  const settings = new SettingsStore(file, defaults, 30)
  settings.set('host', '::1')
  const saved = readFileSync(file, 'utf8')
  assert.throws(() => settings.set('host', '0.0.0.0'), /通配/)
  assert.equal(settings.value.host, '::1')
  assert.equal(readFileSync(file, 'utf8'), saved)
  writeFileSync(file, JSON.stringify({ host: '0.0.0.0' }))
  assert.throws(() => new SettingsStore(file, defaults, 30), /通配/, '旧通配设置须明确报错，不静默放宽或迁移')
})

await check('启动脚本 --check：校验默认和保存地址，拒绝通配值，不启动DSH', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tla-serve-'))
  const file = join(dir, 'serve.json')
  const config = { dshBin: '/not-executed-dsh.js', patch: '/unused-overlay.yml', dataDir: dir, host: '127.0.0.1', port: 3080, publicOrigin: ORIGIN }
  const run = () => spawnSync(process.execPath, ['--experimental-transform-types', fileURLToPath(new URL('../scripts/serve.ts', import.meta.url)), file, '--check'], { encoding: 'utf8' })
  writeFileSync(file, JSON.stringify(config))
  let result = run()
  assert.equal(result.status, 0, result.stderr)
  let args = JSON.parse(result.stdout).args as string[]
  assert.equal(args[args.indexOf('--host') + 1], '127.0.0.1')
  writeFileSync(join(dir, 'web-settings.json'), JSON.stringify({ host: '::1' }))
  result = run()
  assert.equal(result.status, 0, result.stderr)
  args = JSON.parse(result.stdout).args
  assert.equal(args[args.indexOf('--host') + 1], '::1')
  writeFileSync(join(dir, 'web-settings.json'), JSON.stringify({ host: '0.0.0.0' }))
  result = run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /通配/)
  assert.equal(result.stdout, '')
})

await check('【安全】仅原生旧Cookie被拒，新会话可持久化且多浏览器独立', () => {
  const c = new FakeConnection()
  assert.equal(c.requestRejection(makeReq('GET', '/api', { cookie: 'fake-session=v1.signed' }) as any), 401)
  assert.equal(c.requestRejection(makeReq('GET', '/api', { cookie: sessionCookie }) as any), undefined)
  assert.equal(c.requestRejection(makeReq('GET', '/api', { cookie: sessionCookie, origin: 'https://evil.example' }) as any), 403)
  const file = `${process.env.DSH_HOME}/storages/telegram-login-approval/web-sessions.json`
  const restarted = new SessionStore(file)
  assert.ok(restarted.find({ headers: { host: 'test.example.com', cookie: sessionCookie } }))
  const second = restarted.create('test.example.com', 'second browser', 1).split(';')[0]!
  assert.equal(restarted.list().length, 2)
  assert.ok(restarted.find({ headers: { host: 'test.example.com', cookie: sessionCookie } }))
  restarted.revoke(restarted.list()[1]!.id)
  const again = new SessionStore(file)
  assert.equal(again.find({ headers: { host: 'test.example.com', cookie: second } }), undefined)
  assert.ok(again.find({ headers: { host: 'test.example.com', cookie: sessionCookie } }))
  assert.ok(!readFileSync(file, 'utf8').includes(sessionCookie.split('=')[2]!), '落盘不得有原始会话token')
})

await check('【安全】管理卡片私聊/消息绑定、设置回复绑定、踢出二次确认与日志不泄密', async () => {
  const command = (from: number, type: string) => ({ update_id: 1000001, message: { message_id: 91, from: { id: from }, chat: { id: from, type }, text: '/web' } })
  const before = tg.sendMessage
  queue.push(command(999, 'private'), command(ADMIN, 'group'))
  await sleep(60)
  assert.equal(tg.sendMessage, before)
  queue.push(command(ADMIN, 'private')); await sleep(60)
  let payload = tg.payloads.at(-1)!
  assert.ok(payload.text.includes('🌐 <b>Web 管理台</b>'))
  assert.equal(payload.reply_markup.inline_keyboard[0].length, 2)
  const setData = payload.reply_markup.inline_keyboard[2][0].callback_data
  const wrong = callbackUpdate('web', setData)
  wrong.callback_query!.message!.message_id = 999
  queue.push(wrong); await sleep(40)
  assert.equal(tg.payloads.at(-1), payload)
  queue.push(callbackUpdate('web', setData)); await sleep(40)
  assert.ok(tg.payloads.at(-1)!.reply_markup.force_reply)
  queue.push({ update_id: 1000002, message: { message_id: 92, from: { id: ADMIN }, chat: { id: ADMIN, type: 'private' }, text: '60', reply_to_message: { message_id: TG_MESSAGE_ID } } } as TgUpdate)
  await sleep(60)
  const file = `${process.env.DSH_HOME}/storages/telegram-login-approval/web-settings.json`
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).approvalSeconds, 60)
  const next = await postLogin()
  pendingCookie = cookieOf(next)
  assert.ok(String(next.headers['set-cookie']).includes('Max-Age=60'))
  queue.push(command(ADMIN, 'private')); await sleep(40)
  payload = tg.payloads.at(-1)!
  const kickAll = payload.reply_markup.inline_keyboard[4][0].callback_data
  queue.push(callbackUpdate('web', kickAll)); await sleep(40)
  assert.equal(new FakeConnection().requestRejection(makeReq('GET', '/api', { cookie: sessionCookie }) as any), undefined, '首次点击不应撤销')
  const yes = tg.payloads.at(-1)!.reply_markup.inline_keyboard[0][0].callback_data
  queue.push(callbackUpdate('web', yes)); await sleep(60)
  assert.equal(new FakeConnection().requestRejection(makeReq('GET', '/api', { cookie: sessionCookie }) as any), 401)
  assert.deepEqual(new FakeConnection().admit(makeReq('GET', '/api', { cookie: sessionCookie }) as any), { rejection: 401 }, '撤销后直接 admit 也须拒绝')
  assert.equal(request('GET', '/', { cookie: sessionCookie }).status, 200, '撤销后首页必须回登录表单')
  assert.equal(new SessionStore(`${process.env.DSH_HOME}/storages/telegram-login-approval/web-sessions.json`).list().length, 0)
  assert.ok(!logs.join('\n').includes(SECRET) && !logs.join('\n').includes(sessionCookie))
})

await check('【安全】错误密钥全局冷却600秒只限制错误输入，正确密钥仍可复用待审批', async () => {
  // 前面的首条错误仍在同一窗口，补9次达到10次。
  for (let i = 0; i < 9; i++) assert.equal((await postLogin(undefined, 'bad')).status, 401)
  const out = await postLogin(undefined, 'bad')
  assert.equal(out.status, 429)
  assert.ok(Number(out.headers['retry-after']) > 590)
  // 复用此前待审批nonce，避免把独立通知配额耗尽误判为错误桶限制。
  const correct = await postLogin(pendingCookie)
  assert.equal(correct.status, 303)
  assert.ok(String(correct.headers.location).startsWith('/login/status?request='))
  assert.equal(correct.headers['set-cookie'], undefined, '复用审批不能直接签发会话')
  const limit = new FailureLimiter(600)
  for (let i = 0; i < 10; i++) limit.record(100000)
  assert.equal(limit.check(100000), 600)
  limit.cooldownSeconds = 60
  assert.equal(limit.check(100000), 600, '旧冷却不变')
  assert.equal(limit.check(700001), 0)
})

await check('卸载后还原原型方法', () => {
  for (const dispose of effects) dispose()
  const proto = Object.getPrototypeOf(new FakeConnection()) as { authorizeIndex: { name: string } }
  assert.equal(proto.authorizeIndex.name, 'authorizeIndex', '应还原为原方法')
  assert.equal(FakeConnection.prototype.admit, originalAdmit, 'admit 描述符应还原')
  assert.equal(FakeConnection.prototype.requestRejection, originalRejection, 'requestRejection 描述符应还原')
  assert.ok('peer' in new FakeConnection().admit(makeReq('GET', '/api', { cookie: 'fake-session=v1.signed' }) as any))
  assert.equal(new FakeConnection().requestRejection(makeReq('GET', '/api', { cookie: 'fake-session=v1.signed' }) as any), undefined, 'requestRejection应还原')
})

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------

let failed = 0
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     → ${r.detail}`}`)
  if (!r.ok) failed += 1
}
console.log(`\n通过 ${String(results.length - failed)}/${String(results.length)}`)
console.log(`（Telegram 调用：sendMessage=${String(tg.sendMessage)} getUpdates=${String(tg.getUpdates)} 未知=${String(tg.unknown)}）`)
process.exit(failed === 0 ? 0 : 1)
