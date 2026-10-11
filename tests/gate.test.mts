/**
 * 集成验证：用假的 Cordis ctx + 假的 Telegram API 驱动完整的登录门禁流程。
 *
 * 为什么需要这个测试：真实 `dsh web` 跑通需要真实 Telegram Bot，
 * 而**安全关键路径**必须被验证：
 *   Secret Key 校验 → 生成带外批准 → Telegram 批准/拒绝 → 单次凭证交换 → 不可重放。
 * 这里用一个最小 fake ctx 直接驱动插件的 `apply`，并用假的 `fetch` 喂 Telegram update。
 *
 * 运行：
 *   cd dsh && node --import tsx/esm ../opendsh/tests/gate.test.mts
 */

import { strict as assert } from 'node:assert'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/config.ts'

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
  message?: { message_id: number; chat: { id: number; type?: string }; from?: { id: number }; text?: string }
  callback_query?: {
    id: string
    from: { id: number }
    data?: string
    message?: { message_id: number; chat: { id: number; type?: string } }
  }
}

const tg = { sendMessage: 0, getUpdates: 0, unknown: 0, texts: [] as string[] }
const queue: TgUpdate[] = []
let firstUpdatesDone = false

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
  const url = String(typeof input === 'string' ? input : (input as { url: string }).url)
  const method = url.slice(url.lastIndexOf('/') + 1)
  const payload = init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>
  switch (method) {
    case 'getMe':
      return json({ ok: true, result: { username: 'testbot' } })
    case 'sendMessage':
      tg.sendMessage += 1
      tg.texts.push(String(payload.text ?? ''))
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
}) as typeof fetch

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

  requestRejection(_req: { headers: unknown }): number | undefined {
    // 未认证：返回 401，门禁据此渲染登录表单。
    return 401
  }

  authorizeIndex(_req: { url?: string }, res: { writeHead(s: number, h?: Record<string, string>): void; end(b?: string): void }): boolean {
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
  assert.ok(Array.isArray(setCookie), '应同时写入会话与清理 nonce 两个 cookie')
  assert.ok(String(setCookie[0]).includes('; Secure'), '会话 cookie 应追加 Secure')
  assert.ok(String(setCookie[1]).includes('__Host-dsh-login=;'), '应清除 nonce cookie')
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

await check('配置：浏览器批准 TTL 固定为 300 秒', () => {
  assert.throws(() => resolveConfig({ ...base, ttlSeconds: 60 }), /TTL/)
})

await check('卸载后还原原型方法', () => {
  for (const dispose of effects) dispose()
  const proto = Object.getPrototypeOf(new FakeConnection()) as { authorizeIndex: { name: string } }
  assert.equal(proto.authorizeIndex.name, 'authorizeIndex', '应还原为原方法')
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
