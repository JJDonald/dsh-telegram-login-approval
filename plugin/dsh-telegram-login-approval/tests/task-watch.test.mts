/**
 * M2 单元验证：任务段聚合、静置复查、去重、清理。
 *
 * 关键性质（都是易错点）：
 *  1. 多轮任务只推**一条**通知（不是每轮一条）
 *  2. 静置期间若又开始跑 → **取消**通知（不误报完成）
 *  3. 静置后确实 idle → 推一条，并带上轮次数/耗时/最终文本
 *  4. dispose 后不再触发任何通知
 *
 * 运行：cd dsh && node --import tsx/esm ../plugin/dsh-telegram-login-approval/tests/task-watch.test.mts
 */

import { strict as assert } from 'node:assert'

const { TurnWatcher, classifyReason, reasonDetail, extractText, humanDuration, renderNotice } =
  await import('../src/task-watch.ts')

const results: Array<{ name: string; ok: boolean; detail: string }> = []
function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  try {
    const r = fn()
    if (r instanceof Promise) {
      return r.then(
        () => { results.push({ name, ok: true, detail: '' }) },
        (e: unknown) => { results.push({ name, ok: false, detail: e instanceof Error ? e.message : String(e) }) },
      )
    }
    results.push({ name, ok: true, detail: '' })
  } catch (error) {
    results.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) })
  }
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })

/** 组装一个受控的 watcher。 */
function makeWatcher(settleMs = 40) {
  const notices: Array<{ turns: number; reason: string; text: string; durationMs: number }> = []
  const idle = new Map<string, boolean>()
  const watcher = new TurnWatcher({
    settleMs,
    maxTextChars: 100,
    log: () => { /* 测试中忽略 */ },
    isIdle: (id) => idle.get(id) !== false,
    notify: (n) => { notices.push({ turns: n.turns, reason: n.reason, text: n.text, durationMs: n.durationMs }) },
  })
  return { watcher, notices, idle }
}

const turnStart = { type: 'turn/start', data: { turn: 1 } }
const turnEndOk = { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }
const assistantText = (t: string) => ({ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: t }] } } })

console.log('=== M2 单元验证（任务段聚合）===\n')

check('纯函数：classifyReason', () => {
  assert.equal(classifyReason({ kind: 'completed' }), 'completed')
  assert.equal(classifyReason({ kind: 'aborted', reason: 'user' }), 'aborted')
  assert.equal(classifyReason({ kind: 'error' }), 'error')
  assert.equal(classifyReason({ kind: 'max-tokens' }), 'max-tokens')
  assert.equal(classifyReason(null), 'other')
})

check('纯函数：reasonDetail 提取错误码与消息', () => {
  const d = reasonDetail({ kind: 'error', error: { code: 'TIMEOUT', message: 'upstream timed out' } })
  assert.equal(d, 'TIMEOUT: upstream timed out')
  assert.equal(reasonDetail({ kind: 'completed' }), '')
})

check('纯函数：extractText 只取 text 块', () => {
  const text = extractText({ content: [{ type: 'text', text: 'A' }, { type: 'reasoning', text: 'X' }, { type: 'text', text: 'B' }] })
  assert.equal(text, 'AB')
  assert.equal(extractText({}), '')
})

check('纯函数：humanDuration', () => {
  assert.equal(humanDuration(5_000), '5 秒')
  assert.equal(humanDuration(60_000), '1 分')
  assert.equal(humanDuration(90_000), '1 分 30 秒')
  assert.equal(humanDuration(3_600_000), '1 小时')
})

check('纯函数：renderNotice 含结果与文本', () => {
  const s = renderNotice(
    { sessionId: 's', turns: 2, durationMs: 5000, reason: 'completed', text: 'done!', detail: '', hadUserInput: true },
    (v) => v,
  )
  assert.ok(s.includes('任务完成'), '应含完成标题')
  assert.ok(s.includes('轮次：2'), '应含轮次')
  assert.ok(s.includes('done!'), '应含最终文本')
})

// --- 核心：多轮任务只通知一次 ---
await check('多轮任务只推一条通知（不是每轮一条）', async () => {
  const { watcher, notices, idle } = makeWatcher(40)
  watcher.onAgentStatus('s1', 'running')
  for (let i = 0; i < 4; i += 1) {
    watcher.onSessionEvent('s1', turnStart)
    watcher.onSessionEvent('s1', assistantText(`step ${String(i)}`))
    watcher.onSessionEvent('s1', turnEndOk)
  }
  assert.equal(watcher.activeCount(), 1, '应合并为一个任务段')
  idle.set('s1', true)
  watcher.onAgentStatus('s1', 'idle')
  await sleep(120)
  assert.equal(notices.length, 1, `期望 1 条通知，实际 ${String(notices.length)}`)
  assert.equal(notices[0]?.turns, 4, '应记录 4 轮')
  assert.equal(notices[0]?.text, 'step 3', '应保留最后一轮文本')
  watcher.dispose()
})

// --- 核心：静置期间重新开跑 → 取消通知 ---
await check('静置期间又开始跑 → 取消通知（不误报完成）', async () => {
  const { watcher, notices, idle } = makeWatcher(60)
  watcher.onAgentStatus('s2', 'running')
  watcher.onSessionEvent('s2', turnStart)
  watcher.onSessionEvent('s2', turnEndOk)
  idle.set('s2', true)
  watcher.onAgentStatus('s2', 'idle')
  // 静置窗口内，新的轮次被异步排入。
  await sleep(20)
  idle.set('s2', false)
  watcher.onAgentStatus('s2', 'running')
  watcher.onSessionEvent('s2', turnStart)
  await sleep(120)
  assert.equal(notices.length, 0, `不应有通知，实际 ${String(notices.length)}`)
  watcher.dispose()
})

// --- 静置后确实空闲 → 通知 ---
await check('静置后确实空闲 → 推一条通知', async () => {
  const { watcher, notices, idle } = makeWatcher(40)
  watcher.onAgentStatus('s3', 'running')
  watcher.onSessionEvent('s3', turnStart)
  watcher.onSessionEvent('s3', assistantText('final answer'))
  watcher.onSessionEvent('s3', turnEndOk)
  idle.set('s3', true)
  watcher.onAgentStatus('s3', 'idle')
  await sleep(110)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.text, 'final answer')
  watcher.dispose()
})

// --- 失败原因会体现在通知里 ---
await check('失败轮次 → reason=error', async () => {
  const { watcher, notices, idle } = makeWatcher(40)
  watcher.onAgentStatus('s4', 'running')
  watcher.onSessionEvent('s4', turnStart)
  watcher.onSessionEvent('s4', { type: 'turn/end', data: { turn: 1, reason: { kind: 'error' } } })
  idle.set('s4', true)
  watcher.onAgentStatus('s4', 'idle')
  await sleep(110)
  assert.equal(notices.length, 1)
  assert.equal(notices[0]?.reason, 'error')
  watcher.dispose()
})

// --- dispose 后不再通知 ---
await check('dispose 后不再触发通知', async () => {
  const { watcher, notices, idle } = makeWatcher(40)
  watcher.onAgentStatus('s5', 'running')
  watcher.onSessionEvent('s5', turnStart)
  watcher.onSessionEvent('s5', turnEndOk)
  idle.set('s5', true)
  watcher.onAgentStatus('s5', 'idle')
  watcher.dispose()          // 在静置到期前卸载
  await sleep(110)
  assert.equal(notices.length, 0, 'dispose 后不应有通知')
  assert.equal(watcher.activeCount(), 0)
})

// --- 超长文本截断 ---
await check('超长文本被截断', async () => {
  const { watcher, notices, idle } = makeWatcher(40)
  watcher.onAgentStatus('s6', 'running')
  watcher.onSessionEvent('s6', turnStart)
  watcher.onSessionEvent('s6', assistantText('x'.repeat(500)))
  watcher.onSessionEvent('s6', turnEndOk)
  idle.set('s6', true)
  watcher.onAgentStatus('s6', 'idle')
  await sleep(110)
  assert.equal(notices.length, 1)
  assert.ok((notices[0]?.text.length ?? 0) < 500, '应被截断')
  assert.ok(notices[0]?.text.includes('已截断'), '应标注截断')
  watcher.dispose()
})

// --- 没有 turn/start 的孤立事件不应产生通知 ---
await check('无 turn/start 的孤立事件不产生通知', async () => {
  const { watcher, notices } = makeWatcher(30)
  watcher.onSessionEvent('s7', turnEndOk)          // 没有 start
  watcher.onAgentStatus('s7', 'idle')
  await sleep(90)
  assert.equal(notices.length, 0)
  watcher.dispose()
})

let failed = 0
for (const r of results) {
  console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `\n     → ${r.detail}`}`)
  if (!r.ok) failed += 1
}
console.log(`\n通过 ${String(results.length - failed)}/${String(results.length)}`)
process.exit(failed === 0 ? 0 : 1)
