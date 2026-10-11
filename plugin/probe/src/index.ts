/**
 * 探针插件：验证 DSH 是否允许第三方插件用 exact `/` 接管登录入口。
 *
 * 目的（P1 风险验证）：
 * 1. `ctx.webServer.register({kind:'exact', path:'/'})` 能否成功注册（不冲突）
 * 2. 注册后是否真的拦截 `GET /`（而非由 frontend-static 的 fallback 处理）
 * 3. 已认证请求是否仍能只读地判断状态（requestRejection）
 *
 * 刻意不引入任何 @deepseek-ai/* 依赖，只用 Node 内置模块，
 * 以便插件文件可放在仓库外仍能被加载。
 */

export const name = 'login-gate-probe'

/** 需要 webServer 与 connection 两个服务就绪后才注册路由。 */
export const inject = ['webServer', 'connection']

export function apply(ctx) {
  ctx.logger.info('[probe] apply() 已执行，准备注册 exact / 路由')

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: '/',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://probe.invalid')
      const hasToken = url.searchParams.getAll('token').length > 0

      // 只读探测：不调用 authorizeIndex，避免消费掉真实登录流程。
      let authenticated = false
      try {
        authenticated = ctx.connection.requestRejection({ headers: req.headers }) === undefined
      } catch (error) {
        ctx.logger.warn(`[probe] requestRejection 抛出: ${String(error)}`)
      }

      ctx.logger.info(
        `[probe] 拦截 GET / | method=${req.method} hasToken=${String(hasToken)} `
        + `authenticated=${String(authenticated)}`,
      )

      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(
        '<!doctype html><meta charset="utf-8">'
        + '<h1>PROBE: exact / 已被插件接管</h1>'
        + `<p>method=${String(req.method)}</p>`
        + `<p>hasToken=${String(hasToken)}</p>`
        + `<p>authenticated=${String(authenticated)}</p>`,
      )
    },
  })

  ctx.effect(() => dispose, 'login-gate-probe: exact / route')
  ctx.logger.info('[probe] exact / 路由注册成功')
}
