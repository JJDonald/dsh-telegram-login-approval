/**
 * 探针 2：验证「包装 ctx.connection.authorizeIndex」这一更干净的切入点。
 *
 * 为什么换思路：
 *   探针 1 证明 exact `/` 可以被接管，但 DSH 的分发在命中 exact 路由后
 *   不会回落 fallback，因此接管 `/` 就必须自己渲染 index.html
 *   （要自行解析 distIndex、复制 frontend-static 的遍历校验与 <base> 注入）。
 *
 * 更干净的做法：不抢 `/`，而是包装 `connection.authorizeIndex`。
 *   - frontend-static 的 fallback 每次渲染 index 前都会调用它，
 *     且是调用时属性查找（`() => ctx.connection.authorizeIndex(req, res)`），
 *     所以替换实例上的方法即可生效。
 *   - index.html 的提供、遍历防护、base 注入全部保持 DSH 原样。
 *   - 我们只在「凭证交换」之前插入门禁。
 *
 * 本探针只验证两件事：
 *   1. 能否成功给 `ctx.connection.authorizeIndex` 赋值（对象是否可写）
 *   2. 包装后，未认证的 `GET /` 是否走到我们的实现
 */

export const name = 'authorize-index-probe'

export const inject = ['webServer', 'connection']

export function apply(ctx) {
  const connection = ctx.connection
  const original = connection.authorizeIndex

  ctx.logger.info(`[probe2] connection 类型=${String(connection?.constructor?.name)}`)
  ctx.logger.info(`[probe2] 原始 authorizeIndex 类型=${typeof original}`)

  // 关键验证 1：实例是否可写
  let patchable = false
  try {
    connection.authorizeIndex = function patched(req, res) {
      const url = new URL(req.url ?? '/', 'http://probe.invalid')
      ctx.logger.info(
        `[probe2] authorizeIndex 被调用 | method=${String(req.method)} `
        + `path=${url.pathname} hasToken=${String(url.searchParams.getAll('token').length > 0)}`,
      )
      // 探针行为：不真正交换凭证，只回一个可识别页面。
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8">'
        + '<h1>PROBE2: authorizeIndex 已被包装</h1>'
        + `<p>path=${url.pathname}</p>`,
      )
      return false
    }
    patchable = true
  } catch (error) {
    ctx.logger.warn(`[probe2] 赋值失败: ${String(error)}`)
  }
  ctx.logger.info(`[probe2] 可包装=${String(patchable)}`)

  // 关键验证 2：赋值后读回来是不是我们的函数
  ctx.logger.info(
    `[probe2] 读回类型=${typeof connection.authorizeIndex} `
    + `已替换=${String(connection.authorizeIndex !== original)}`,
  )

  ctx.effect(() => () => {
    connection.authorizeIndex = original
    ctx.logger.info('[probe2] 已还原 authorizeIndex')
  }, 'authorize-index-probe: restore')
}
