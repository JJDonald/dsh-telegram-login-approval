import { escapeHtml } from './page.ts'

export type LoginState = 'form' | 'waiting' | 'denied' | 'expired' | 'rate-limited' | 'invalid'

/**
 * 无脚本、无外部资源；Secret Key 只存在于密码输入和 POST 正文。
 *
 * @param botUsername - 已配置的 Bot 用户名（不含 @）；为空时使用不含 @handle 的通用文案，
 *   避免把某一部署的 Bot 写死进源码。
 */
export function renderLoginPage(state: LoginState, detail = '', refresh = false, botUsername = ''): string {
  const at = botUsername === '' ? '确认 Bot' : `@${botUsername}`
  const titles: Record<LoginState, string> = {
    form: '登录 DeepSeek Harness', waiting: '等待 Telegram 确认',
    denied: '登录已被拒绝', expired: '登录请求已过期',
    'rate-limited': '登录尝试过于频繁', invalid: 'Secret Key 不正确',
  }
  const descriptions: Record<LoginState, string> = {
    form: '请输入独立的 DSH Secret Key，然后在 Telegram 上确认本次登录。',
    waiting: `请在 ${at} 对应卡片点击「确认登录」。本页会自动刷新。`,
    denied: '本次请求未获批准，没有发放登录凭证。',
    expired: '请求已失效或已经使用，请重新登录。',
    'rate-limited': '请稍后再试。', invalid: '请检查密钥后重试。没有发送 Telegram 登录通知。',
  }
  const form = state === 'form' || state === 'invalid'
    ? `<form method="post" action="/login" autocomplete="on">
<label for="secret">Secret Key</label>
<input id="secret" name="secret" type="password" autocomplete="current-password" maxlength="128" required autofocus>
<button type="submit">登录并请求 Telegram 确认</button>
</form><p class="hint">获取密钥：向 ${at} 私聊发送 <code>/key</code>。</p>`
    : state === 'waiting' ? '' : '<a href="/">返回登录</a>'
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<meta name="referrer" content="same-origin">
${refresh ? '<meta http-equiv="refresh" content="3">' : ''}
<title>${escapeHtml(titles[state])} · DSH</title><style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
*{box-sizing:border-box}body{margin:0;min-height:100svh;display:grid;place-items:center;background:#f4f6fa;color:#172238;padding:20px}
main{width:100%;max-width:420px;padding:30px;border:1px solid #e2e7ef;border-radius:16px;background:#fff;box-shadow:0 8px 32px #17223808}
h1{font-size:22px;margin:0 0 12px}p{font-size:14px;line-height:1.7;color:#586579}label{display:block;font-size:14px;margin:24px 0 8px}
input,button{width:100%;font:inherit;border-radius:8px;padding:12px}input{border:1px solid #bac5d4;background:transparent;color:inherit}
input:focus{outline:2px solid #386ae8;outline-offset:2px}button{border:0;margin-top:16px;background:#386ae8;color:white;font-size:14px;cursor:pointer}
.hint{font-size:12px;margin-top:20px}a{display:inline-block;margin-top:16px;color:#386ae8}code{font:inherit}
@media(prefers-color-scheme:dark){body{background:#101720;color:#e7edf5}main{background:#192330;border-color:#344154}p{color:#a7b5c8}input{border-color:#596a80}a{color:#8faeff}}
</style></head><body><main><h1>${escapeHtml(titles[state])}</h1><p>${escapeHtml(descriptions[state])}</p>
${detail ? `<p>${escapeHtml(detail)}</p>` : ''}${form}</main></body></html>`
}
