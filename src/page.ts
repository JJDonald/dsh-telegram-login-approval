/**
 * 门禁期间返回给浏览器的等待页。
 *
 * 使用 meta refresh 而非 SSE/WebSocket：
 *  - 无长连接复杂度，刷新即重新触发 authorizeIndex
 *  - 断网/休眠后恢复天然容错
 *  - 不依赖前端 bundle，纯静态 HTML
 *
 * 安全性：页面不回显 token、IP 之外的信息；token 留在 URL 里供刷新重放。
 */

/** HTML 转义，防止把外部输入拼进页面时产生注入。 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 页面状态。 */
export type GateState = 'waiting' | 'denied' | 'expired' | 'rate-limited' | 'approved-replay'

interface PageOptions {
  state: GateState
  /** 自动刷新间隔（秒）；0 表示不刷新。 */
  refreshSeconds: number
  /** 附加说明（已转义）。 */
  detail?: string
}

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f4f5f7; color: #1f2328;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .card {
    background: #fff; border: 1px solid #e3e5e8; border-radius: 12px;
    padding: 32px 28px; max-width: 420px; width: calc(100% - 40px);
    box-shadow: 0 1px 2px rgba(0,0,0,.04);
  }
  h1 { margin: 0 0 10px; font-size: 19px; font-weight: 600; letter-spacing: .01em; }
  p { margin: 0; font-size: 14px; line-height: 1.65; color: #57606a; }
  .detail { margin-top: 14px; font-size: 13px; color: #6e7781; }
  .dot {
    display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: #d0a215; margin-right: 8px; vertical-align: 2px;
    animation: pulse 1.6s ease-in-out infinite;
  }
  .dot.err { background: #cf222e; animation: none; }
  @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
  @media (prefers-reduced-motion: reduce) { .dot { animation: none } }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3 }
    .card { background: #161b22; border-color: #30363d }
    p { color: #8b949e } .detail { color: #6e7781 }
  }
`

const TITLES: Record<GateState, string> = {
  waiting: '等待手机确认',
  denied: '登录已被拒绝',
  expired: '登录请求已过期',
  'rate-limited': '请求过于频繁',
  'approved-replay': '确认已完成，正在进入',
}

/** 渲染等待/结果页。 */
export function renderGatePage(options: PageOptions): string {
  const { state, refreshSeconds, detail } = options
  const isError = state === 'denied' || state === 'expired' || state === 'rate-limited'
  const dotClass = isError ? 'dot err' : 'dot'
  const refresh = refreshSeconds > 0
    ? `<meta http-equiv="refresh" content="${String(refreshSeconds)}">`
    : ''

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
${refresh}
<title>${escapeHtml(TITLES[state])} · DSH</title>
<style>${STYLES}</style>
</head>
<body>
  <div class="card">
    <h1><span class="${dotClass}"></span>${escapeHtml(TITLES[state])}</h1>
    <p>${escapeHtml(defaultBody(state))}</p>
    ${detail !== undefined && detail !== '' ? `<p class="detail">${escapeHtml(detail)}</p>` : ''}
  </div>
</body>
</html>
`
}

/** 各状态的默认正文。 */
function defaultBody(state: GateState): string {
  switch (state) {
    case 'waiting':
      return '已向你的 Telegram 发送登录确认，请在手机上点击「确认登录」。此页面会自动刷新，无需手动操作。'
    case 'denied':
      return '你在 Telegram 上拒绝了本次登录，未发放任何登录凭证。如非本人操作，请在 Telegram 中重置访问密钥。'
    case 'expired':
      return '本次登录确认已超时失效，未发放任何登录凭证。请重新打开带 token 的登录地址。'
    case 'rate-limited':
      return '短时间内触发了过多登录确认。出于安全考虑已暂时冷却，请稍后重试。'
    case 'approved-replay':
      return '确认已完成，正在进入控制台。'
  }
}

/** 极简的纯文本错误响应（不泄露内部信息）。 */
export function renderPlainError(status: number, message: string): { status: number; body: string } {
  return { status, body: `${message}\n` }
}
