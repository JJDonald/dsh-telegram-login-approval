# DSH 远程访问加固：Telegram 带外登录批准

> 目标：把 openbear 的「静态密钥 + Telegram 二次确认」搬进 DeepSeek Harness，
> 以**单个插件**形式实现，不改 DSH 源码。
>
> 状态：规格（待实施）。所有技术断言均已在 DSH `master` 源码中核实，附代码位置。

---

## 0. 结论摘要

| 需求 | 结论 |
|---|---|
| 远程 Web 访问 | **不重做**。官方 `--public-url` / `--trusted-host` / `--tls-cert` 已完备 |
| TG 任务通知 | **不重做**。装现成插件 `dsh-telegram-duty` |
| TG 续聊（可选） | **不重做**。装 `hi-wenw/dsh-telegram-channel` |
| **登录带外批准 + 会话撤销** | **唯一要写的部分** ← 本规格 |

**为什么这是真空白**：DSH 官方文档明确承认没有 logout ——
「清除浏览器 cookie 会结束单个浏览器会话；删除 owner 凭据记录并重启 `dsh` 会撤销全部会话」
（`packages/client/connection/README.zh.md`，已知限制节）。
且启动 token 一旦泄露即可换取 **30 天** cookie。核对了 100+ 个 `dsh-plugin`，
**没有任何插件做 Web 登录的带外批准**。

---

## 1. DSH 现有认证机制（已被验证的事实）

来源：`packages/client/connection/src/browser-auth.ts`、`src/api-request-trust.ts`、
决策记录 `.agents/notes/implemented/architecture/2026-08-24-browser-token-authentication.zh.md`

- 每进程生成随机 32 字节 launch token（`randomBytes(SECRET_BYTES)`，`ProcessLaunchTokens` WeakMap 持有）
- `dsh web` 打印并打开 `http://127.0.0.1:3080/?token=<launchToken>`
- `GET /` 携带 token → 网关交换为签名 cookie（`303` → `./`，`no-store`，`referrer-policy: no-referrer`）
- cookie 格式 `v1.<base64url(payload)>.<base64url(HMAC-SHA256)>`，密钥存
  `ctx.credentials` 的 `client-connection/browser-session` grant 记录
- cookie 属性：host-only、`Path=/`、`HttpOnly`、`SameSite=Strict`、`Secure` 由监听器协议决定
- 有效期 `cookieMaxAgeDays` 默认 **30 天**；签名密钥持久化 ⇒ **cookie 跨重启有效**
- 无效凭据一律返回同一份最小 `401`（不泄露原因）
- Host/Origin 栅栏先于认证执行，防 DNS rebinding 与跨站请求，失败 403

### 与 openbear 的差距

| 维度 | openbear | DSH |
|---|---|---|
| 凭证强度 | 静态密钥（长期） | 每进程随机 token（强） |
| 泄露后果 | 攻击者仍需 TG 批准 | **直接换 30 天 cookie** |
| 会话撤销 | `/web` 踢出全部 + 重置密钥 | 仅「删记录 + 重启进程」 |
| 反代支持 | 无指引，且限流用 `request.remote` 会失效 | 官方完整指引，不信任转发头 |

**结论**：DSH 的加密与防篡改设计**强于** openbear；缺的只是**带外批准**与**可自助撤销**。

---

## 2. 已验证的技术接缝

| 能力 | 接口 / 位置 | 证据 |
|---|---|---|
| 注册精确路由 | `ctx.webServer.register({ kind, path, handler })` | `packages/host/webserver/src/index.ts:334` |
| **精确路由优先于 fallback** | `match()` 先查 exact 表，再前缀，最后 fallback | `webserver/src/index.ts:511-521`、分发处 `:394-405` |
| DSH 自带 index 占 fallback | `ctx.effect(() => ctx.webServer.registerFallback(...))` | `packages/host/frontend-static/src/index.ts:121` |
| 门禁检查（是否已认证） | `ctx.connection.requestRejection(req)` → `undefined` 即通过 | `packages/client/connection/src/rpc.ts:214-228` |
| 凭证交换（token→cookie） | `ctx.connection.authorizeIndex(req, res)`（**无** `secure` 参数） | `packages/client/connection/src/rpc-host.ts:122`、`rpc.ts:236` |
| 存储 TG bot token | `ctx.credentials` / `modifyRecord` | `packages/credentials/credentials/README.zh.md` |
| 事件订阅 | `session/event`、`agent/status`（`emit`） | `docs/event-producer-consumer.zh.md` |
| 插件范式 | `export function apply(ctx)` + `cordis.yml` overlay | `docs/user/develop/basic/index.zh.md` |
| 自动清理 | `ctx.effect(...)` 返回 disposer | 同上 |

**决定性的点**：DSH 自带的 `/` 登录处理注册在 **fallback**，而 `match()` **exact 优先**。
因此插件注册 `{ kind: 'exact', path: '/' }` 可合法接管登录入口，且**不产生路由冲突**
（`register()` 只在同一张表内检测重复）。

---

## 3. 插件设计

包名：`dsh-telegram-login-approval`

### 3.1 拦截点（已由实测修正）

**不接管 `/`**，而是包装 `ctx.connection.authorizeIndex`。

原因（实测见附录 A2）：`webserver.handle()` 命中 `exact` 路由后**不会回落 fallback**，
接管 `/` 就必须自己重新实现 index.html 的渲染、遍历防护与 `<base>` 注入。
而 `frontend-static` 的 fallback 在渲染 index 前会**按属性查找**调用
`() => ctx.connection.authorizeIndex(req, res)`。

**关键的实现约束（实测踩坑）**：`ctx.connection` 是 Cordis 的**服务 facade**，
**每次属性访问都返回新对象**（实测 `ctx.connection === ctx.connection` 为 `false`）。
因此：

- ❌ 在**实例**上 `defineProperty` 会被后续访问丢弃 —— 补丁静默失效，表现为门禁完全不生效。
- ✅ 必须改 **共享 prototype** 上的方法。
- ✅ 同理，`ctx.effect(fn)` 会**立即调用 `fn`** 并把**返回值**当 disposer；
  写成 `effect(() => callback())` 会在安装那一刻就执行清理（补丁装上即被还原）。
  正确写法是 `effect(() => callback)`。

```ts
const proto = Object.getPrototypeOf(ctx.connection)
const desc = Object.getOwnPropertyDescriptor(proto, 'authorizeIndex')
Object.defineProperty(proto, 'authorizeIndex', { value: patched, writable: true, configurable: true })
```

```
frontend-static.serveStatic()
 └─ authorizeIndex(req, res)          ← 插件改的是 prototype 上的这个方法
      ├─ requestRejection 通过 → 调原方法（已认证，零打扰）
      ├─ 无 token / token 无效 → 调原方法（保持 DSH 原 401）
      └─ 有效 token 且未批准  → 门禁：建 pending + 发 TG + 返回等待页
```

判定顺序（**先判态，不要先调原方法**）：`authorizeIndex` 成功时也返回 `false`
（它写完 303 + Set-Cookie），失败时**已经写过 401**，所以它不能用来判态、
也不能先调用再补写页面。判态必须用 `requestRejection`（纯检查、不写响应）。

另外：**token 有效性必须单独探测**。`requestRejection` 只回答「是否已认证」，
不校验 URL 里的 token；若只凭「URL 里有 token」就进入门禁，攻击者随便填假 token
即可反复触发 Telegram 通知。实现上用**抛弃的响应对象**调用一次原 `authorizeIndex`，
读其状态码（有效 = 303/200）—— 该调用无服务端副作用，只有签名 cookie 写入抛弃对象。

**接口注意**：`HostConnectionHandle`（`packages/client/connection/src/rpc.ts:193`）的公开成员为
`rpc` / `fetch` / `operator` / `allowsRemoteAuthorities` / `createSharedFetchHandler` /
`requestRejection` / `admit` / `authorizeIndex(request, response)` / `authenticatedUrl`。
**没有** `isAuthenticated` —— 它是 `HostConnectionService` 内部持有的 `browserAuth` 实例方法，
未暴露在公开 handle 上，因此判断「是否已认证」必须用 `requestRejection()`（返回 `undefined` 即通过）。
`authorizeIndex` **不接受** `secure` 参数：`Secure` 由 Connection 内部读
`ctx.get('webServer').protocol` 决定。

同时这意味着插件**无法直接拿到** launch token，只能通过 `authorizeIndex` 让 DSH 自己完成校验。
因此门禁的判定依据是「本请求是否携带通过认证的凭证」，而不是比对 token 明文
（比对由 DSH 在 `authorizeIndex` 内完成，插件不参与）。

### 3.2 时序（MVP：meta refresh 轮询，无长连接）

```
浏览器               插件                     Telegram            用户
  │  GET /?token=T      │                        │                 │
  ├────────────────────>│                        │                 │
  │                     │ 1. requestRejection     │                 │
  │                     │    通过? → 交回 DSH 原流程（不发通知）      │
  │                     │ 2. 限流 / 冷却检查       │                 │
  │                     │ 3. 建 pending(id)       │                 │
  │                     │    绑定 sha256(T)+IP    │                 │
  │                     ├──── 发送确认卡片 ──────>│                 │
  │                     │                        ├── 推送 ────────>│
  │  <「等待手机确认…」  │                        │                 │
  │     meta refresh 3s │                        │  点 ✅ / ❌     │
  │                     │<─────── callback ──────┤<────────────────┤
  │                     │ 4. 校验: pending? 未过期? 非消费过?        │
  │  GET /?token=T (重放)│                       │                 │
  ├────────────────────>│ 5. 已批准（本请求未认证）│                 │
  │                     │ 6. 重放时再调原 authorizeIndex          │
  │                     │    → DSH 校验 token，通过则发 cookie       │
  │  <── 303 + Set-Cookie (由 DSH 完成交换) ──────┤                 │
```

要点：
- **批准只是「准入」而非「认证」**：第 6 步仍调用 DSH 的 `authorizeIndex` 做真实校验。
  攻击者没有正确 token 时，即使你误点批准，最终仍是 401（双保险）。
- 用 `meta refresh` 而非长连接：无 SSE/WS 复杂度，刷新即重放，天然容错。
- 重放依赖 URL 中仍有 `token` —— DSH 只在成功后才 303 到干净的 `./`，
  失败时 URL 保持带 token，刷新即重新触发门禁。

### 3.3 状态与数据结构

pending 状态**仅存内存**（重启即丢 = fail-closed，符合安全默认）：

```ts
interface PendingApproval {
  id: string            // 随机
  tokenHash: string     // sha256(launch token)，不存明文
  ip: string
  userAgent: string
  createdAt: number
  expiresAt: number     // 默认 300s
  status: 'pending' | 'approved' | 'denied' | 'consumed'
  decidedBy?: number    // TG user id
  tgMessageId?: number  // 用于批准后编辑消息
}
```

批准后**单次消费**（`consumed`），防止同一批准被复用 → 对齐 openbear 的原子 claim。

### 3.4 配置（cordis.yml overlay）

```yaml
- id: telegram-login-approval
  config:
    enabled: true
    botTokenRef: TELEGRAM_LOGIN_BOT_TOKEN   # 凭据名，不写明文
    adminChatId: 123456789                  # 白名单，仅私聊
    ttlSeconds: 300
    maxPendingPerIp: 3
    cooldownSeconds: 600
    notifyOnDeny: true
    # 可选：会话撤销
    enableRevokeCommand: true
```

- `botTokenRef` 走 `ctx.credentials`，**配置文件里不出现明文 token**（对齐 DSH 的凭据 seam）。
- `adminChatId` 必须为数字且仅私聊，非白名单消息一律忽略并记日志。

### 3.5 会话撤销（补 DSH 缺口）

TG 命令 `/revoke`：
1. 删除 `client-connection/browser-session` grant 记录（走 `ctx.credentials.modifyRecord`）
2. 提示「下次重启 `dsh` 后全部会话失效」
3. 可选：若已装 `dsh-bridge`，调用其平滑重启

TG 命令 `/sessions`：仅回报「当前共享 cookie 的浏览器数量不可观测」的事实说明，
不臆造不存在的会话列表。

### 3.6 预期源码结构

```
dsh-telegram-login-approval/
├── package.json            # peerDeps: @deepseek-ai/cordis, dsh-client-connection, dsh-host-webserver
├── tsconfig.json
├── README.md / README.zh.md
├── src/
│   ├── index.ts            # apply(ctx)：注册 exact / 路由 + TG 长轮询 + 命令
│   ├── approvals.ts        # PendingApproval 表、过期、单次消费
│   ├── rate-limit.ts       # 按 IP 限流 / 冷却
│   ├── telegram.ts         # getUpdates 长轮询、sendMessage、editMessageText、callback 应答
│   ├── page.ts             # 「等待确认」HTML（含 meta refresh）
│   └── types.ts
└── tests/
    ├── approvals.spec.ts
    ├── rate-limit.spec.ts
    ├── gate.spec.ts        # 拦截逻辑：已认证直通 / 未认证拦截 / 批准后 authorizeIndex
    └── loader-composition.spec.ts
```

参照实现：`packages/experimental/webhook-github/src/handler.ts`（精确路由 + 有界 body + 签名校验）。

---

## 4. 安全分析

### 威胁模型

| 威胁 | 缓解 |
|---|---|
| launch token 泄露 | 仍需 TG 批准；批准不可复用 |
| 通知轰炸（DoS 你本人） | 按 IP 限流 + 全局冷却 + `maxPendingPerIp` |
| 伪造 TG 回调 | 校验 `callback_query.from.id === adminChatId`；callback_data 带随机 id 且不可预测 |
| 重放同一批准 | 单次消费，`consumed` 后不可再用 |
| 拿不到 token 的攻击者 | 批准后仍过 `authorizeIndex` → 401（双保险） |
| TG 侧非白名单/群聊 | 强制数字 id 且 `chat.type === 'private'`，其余静默丢弃并记日志 |
| 插件自身异常 | 异常一律 **fail-closed**（拒绝放行），记录日志，不影响 DSH 其余路由 |

### 明确不做的事

- **不**信任 `X-Forwarded-*`（与 DSH 立场一致：认证只认监听器自身的 authority）
- **不**改写或持久化 DSH 的签名密钥与 cookie
- **不**记录 token 明文（只存 sha256）
- **不**在日志中回显 token、cookie、TG token

---

## 5. 验收标准

实施完成后必须逐条验证：

> 状态图例：`[x]` = 已实测通过；`[ ]` = 待验证（需要真实 Telegram Bot 或 Linux 部署）。
> 详细证据见附录 A6。

**A. 基础放行**
- [x] `GET /?token=<无效值>` → **401**，且**不进入门禁**（不占用通知额度）
- [x] `GET /?token=<有效值>`（无 cookie）→ **200 + 等待页**（触发 TG 通知）
- [x] 已持有有效 cookie 再访问 `/` → 直接 303（**不触发**通知，零打扰）

**B. 拒绝路径**
- [x] 同一 token 重复访问 → **复用同一 pending**（不重复通知）
- [x] 批准后调原 `authorizeIndex` 完成凭证交换 → **303 + Set-Cookie**
- [ ] TG 点 ❌ → 浏览器看到拒绝页（需真实 Bot）
- [ ] 静置超过 `ttlSeconds` → 自动过期（逻辑已实现，待端到端确认）
- [ ] 同一批准重复 consume → 第二次失败（单次消费，已实现待实测）

**C. 攻击面**
- [x] 无 token → 401（保持 DSH 原语义，不被插件接管）
- [x] 无效 token → 401（**不触发通知**，防轰炸）
- [x] 未认证请求不泄漏内部信息（等待页只回显请求编号前 8 位）
- [ ] 连续触发 → 全局冷却生效（逻辑已实现，待实测）
- [ ] 非白名单 TG 用户 → 静默忽略并记日志（需真实 Bot）
- [ ] 群聊消息 → 同上（需真实 Bot）

**D. 不破坏 DSH**
- [x] `/assets/*` 静态资源仍返回 **200**（不受门禁影响）
- [x] 插件卸载（effect dispose）→ prototype 方法**还原为原实现**
- [x] 未装插件时行为不变（`GET /` → 401、有效 token → 303）
- [x] 插件加载失败时 DSH 仍启动（实测确认是软失败，有告警）
- [ ] `/api/*` 与 WebSocket 行为与未装插件时一致（待完整回归）

**E. 撤销**
- [ ] `/revoke` 删除凭据记录后，重启 `dsh` 使全部旧 cookie 失效（M4 范围，待实现）

---

## 6. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 | 环境：clone DSH、`pnpm install`、`pnpm run build`、跑通 `dsh web` | 本机能打开 Web UI |
| P1 | 插件脚手架 + `exact /` 路由能拦住并放行（先不做 TG） | A 组的一半：未认证被拦、已有 cookie 直通 |
| P2 | 接 TG 长轮询 + 确认卡片 + callback 批准 | A、B 组通过 |
| P3 | 限流、单次消费、fail-closed 加固 | C 组通过 |
| P4 | `/revoke` 会话撤销 | E 组通过 |
| P5 | 部署：TLS + 反代 + `--public-url` / `--trusted-host`；装 `dsh-telegram-duty` | 公网可访问，通知可用 |

**每个阶段独立可验收**，P1 即可证明拦截路径成立（最高风险项最先验证）。

---

## 7. 已知风险与限制

1. **DSH 处于开发者预览**，官方警告将有破坏性变更。插件依赖
   `ctx.webServer.register` / `ctx.connection.authorizeIndex` / `ctx.credentials`，
   升级后需回归 A~E 全部用例。
2. **`requestRejection` / `authorizeIndex` 在公开的 `HostConnectionHandle` 接口上**，
   但未承诺长期稳定；若上游改名或调整语义，需适配（改动集中在单文件，可控）。
3. **pending 状态不持久化**：进程重启后未决批准丢失。这是刻意的 fail-closed 选择。
4. **无「当前会话列表」可展示**：DSH 无 logout/session-list API，`/sessions` 只能说明事实，
   不能列出设备。若要设备管理需先向上游提需求。
5. **限流的 IP 来源**在反代后仍取 `request.remote`（socket 对端）。若部署在反代之后，
   所有请求同源 ⇒ 限流退化为全局。**这是 DSH 的既有立场（不信任转发头）**，
   因此本插件采用「全局冷却 + maxPendingPerIp」而非纯 IP 计数；
   如需真按 IP，应由反代层做（fail2ban / nginx limit_req）。
6. **不影响 TG 通知插件的选择**：本插件与 `dsh-telegram-duty` 可共存（不同职责），
   但两者都用 bot token 时建议用**不同的 Bot**，避免 `getUpdates` 争抢更新。

---

## 附录 A：实测结果（2026-10-11，本机 Windows）

环境：DSH `0.2.1-alpha.2`（commit `d7432673`），Node `v24.15.0`，pnpm `12.11.2`。
DSH 已 clone 至 `/f/workspace/opendsh/dsh`，`pnpm install` + `pnpm run build` 均成功。

### A1. DSH 原生认证行为（6/6 与文档一致）

| 用例 | 期望 | 实测 |
|---|---|---|
| `GET /` 无 token | 401 | **401** ✅ |
| `GET /?token=<错误值>` | 401 | **401** ✅ |
| `GET /?token=<正确值>` | 303 + Set-Cookie | **303** ✅ |
| 用换来的 cookie 访问 `/` | 200 | **200** ✅ |
| `/api/*` 无认证 | 401 | **401** ✅ |
| 带 cookie + 跨站 `Origin` | 403 | **403** ✅ |

实测 cookie（印证文档描述）：

```
set-cookie: dsh-auth-<sha256(authority)> = v1.<base64url(payload)>.<base64url(HMAC-SHA256)>
  Max-Age=2592000; Path=/; HttpOnly; SameSite=Strict
payload = { version:1, authority:"127.0.0.1:8189", issuedAt, expiresAt }
```

`Max-Age=2592000` = **30 天**，与 `cookieMaxAgeDays` 默认值一致。

### A2. 切入点验证（关键，且修正了原设计）

用两个真实探针插件在 `dsh web` 上实测：

**探针 1 — 注册 `exact /` 路由**：注册成功、无冲突、确实拦截 `GET /`。
**但有一个隐患**：`webserver` 的 `handle()` 命中 exact 路由后**不会回落 fallback**，
因此接管 `/` 就必须**自己渲染 index.html** —— 要自行解析 `distIndex`、
复制 `frontend-static` 的遍历防护与 `<base href="./">` 注入。脆弱且重复。

**探针 2 — 包装 `ctx.connection.authorizeIndex`**：✅ **可行且更优**。

- `frontend-static` 的 fallback 在渲染 index 前以 **`() => ctx.connection.authorizeIndex(req, res)`**
  调用（调用时属性查找），因此替换实例方法即生效
- 实测：未认证与带 token 的 `GET /` 都进入包装后的实现
- 实测：`/assets/*` 仍返回 **200**（静态资源保持公开，不经过该路径）

**结论：采用探针 2 的方案。** 插件不接管 `/`，只在 `authorizeIndex` 外层加门禁；
index.html 的提供、遍历校验、base 注入全部保持 DSH 原样。

```
GET /  →  frontend-static fallback  →  serveStatic()
                                          └─ authorizeIndex()  ← 插件在此包装
                                               ├─ 已认证 → 调原方法（凭证交换/200）
                                               └─ 未认证 → 建 pending + 发 TG + 返回等待页
```

### A3. 插件加载方式（实测有效）

- overlay 文件用 `- insert:` + `- id:` / `name:` 指定**绝对路径**
- **Windows 上路径必须写成 `F:/workspace/...`**；写成 `/f/workspace/...` 会解析为
  `F:/f/workspace/...` 导致 `failed to import`
- 启动命令的正确参数顺序（`--patch` 属于 `dsh` 层，且在 `--profile` 之后、app 参数之前）：

```bash
node --import tsx/esm apps/cli/src/bin.ts \
  --profile web \
  --patch F:/workspace/opendsh/cordis.yml \
  --no-open --port <PORT>
```

- **overlay 插件加载失败是软失败**：DSH 打印 `1 entry did not activate` 后**仍继续启动**
  （安全默认 = 不因插件失败阻断服务）；因此插件必须显式自检并让失败可见。

### A4. 本机环境注意事项

- **端口 3080 在 Windows 上不可用**：它落在系统保留段 `3033–3132`
  （`netsh interface ipv4 show excludedportrange protocol=tcp`），会 `EACCES`。
  本机开发请用保留段外的端口（实测 `8188`–`8193` 均可用）。
- `dsh web` 的 `--port` / `--public-url` / `--trusted-host` / `--tls-cert` / `--tls-key`
  均存在（见 `docs/cli-help.zh.md`）。
- **DSH 拒绝 `--host 0.0.0.0`**，与官方文档一致。
- 后台进程随 shell 退出会被回收，测试需在同一命令内完成启停。

### A5. 部署目标

- 生产部署为 Linux 服务器（DSH 官方支持；Windows 仅用于开发验证）
- 端口 3080 的保留段问题只影响 Windows，Linux 上无此限制

### A6. M1 实现与验证结果

M1（登录带外批准）已实现于仓库根目录（`src/`），7 个模块：

| 文件 | 职责 |
|---|---|
| `src/index.ts` | 插件入口：prototype 补丁、门禁状态机、TG 轮询、callback |
| `src/config.ts` | 配置校验（缺失即抛错，绝不静默降级） |
| `src/approvals.ts` | pending 表：复用、过期、单次消费 |
| `src/rate-limit.ts` | 全局固定窗口限流 + 冷却 |
| `src/telegram.ts` | Bot API 客户端（仅 `fetch`）+ offset 持久化 |
| `src/page.ts` | 等待/拒绝/过期/限流页（含 `meta refresh`、HTML 转义） |
| `src/util.ts` | logger 适配与请求头读取 |

**集成测试（fake ctx，9/9 通过）**

```
cd dsh && node --import tsx/esm ../opendsh/tests/gate.test.mts

✅ 插件 apply 成功执行
✅ prototype 补丁生效（新 facade 也命中）
✅ 无 token → 401（不接管）
✅ 无效 token → 401（不进入门禁）
✅ 有效 token 首次 → 200 等待页
✅ 同一 token 重复访问复用 pending（不轰炸通知）
✅ 【安全】已批准 + 有效 token → 交换凭证（303）
✅ 静态资源路径不被门禁影响
✅ 卸载后还原原型方法

通过 9/9（dryRun 下 fetch 调用次数：0）
```

**真实 `dsh web` 实测**

| 用例 | 结果 |
|---|---|
| 无 token | **401** ✅（保持 DSH 原语义） |
| 无效 token | **401** ✅（不触发通知） |
| 有效 token 首次 | **200**，页面含「等待手机确认 / 请求编号 / 剩余有效期约 300 秒」 ✅ |
| 同一 token 连续 5 次 | 始终同一请求编号，复用 pending ✅ |
| 4 个假 token 试探 | 全部 401，不占额度 ✅ |
| `/assets/*` | **200** ✅（不受影响） |
| 插件加载告警 | **0** 条 ✅ |

**开发过程中发现并修复的 5 个真实缺陷**（都是"看起来能跑但实际不工作"的类型）：

1. **`authorizeIndex` 不能用返回值判态** —— 成功也返回 `false`（已写 303），失败时已写 401。
   → 改用 `requestRejection` 做纯检查。
2. **必须改 prototype，不能改实例** —— `ctx.connection` 每次访问返回新 facade，
   实例上的补丁被静默丢弃（症状：门禁完全不生效，但无任何报错）。
3. **`ctx.effect(fn)` 会立即调用 `fn`** —— 写成 `effect(() => callback())` 导致
   补丁装上瞬间被还原、轮询刚启动就被置停。正确写法 `effect(() => callback)`。
4. **无效 token 会触发通知** —— 只判断"URL 里有 token"不够，攻击者可填假 token
   轰炸手机。→ 用抛弃响应调用原 `authorizeIndex` 探测 token 真伪。
5. **`dryRun` 仍发起网络请求** —— 轮询无条件启动。→ dryRun 下完全不启动轮询
   （由集成测试的 fetch 计数发现）。

### A7. M2 实现与验证结果

M2（任务完成通知）已实现，新增两个模块：

| 文件 | 职责 |
|---|---|
| `src/task-watch.ts` | 任务段聚合器（纯逻辑，不碰网络）：`TurnWatcher`、`classifyReason`、`renderNotice` |
| `src/task-notify.ts` | 接线：订阅 `session/event` + `agent/status`，发送 Telegram 通知 |

**为什么不用"每轮结束就通知"**：一个任务常跨多轮（工具调用、计划步骤、goal 续跑），
逐轮通知会刷屏。改为「**任务段**（stretch）」聚合并加**静置窗口**：
agent 变 `idle` 后等待 `800ms` 再复查，若期间又被异步排入则取消通知。

**单元测试（12/12 通过）**

```
cd dsh && node --import tsx/esm ../opendsh/tests/task-watch.test.mts

✅ 纯函数：classifyReason / reasonDetail / extractText / humanDuration / renderNotice
✅ 多轮任务只推一条通知（不是每轮一条）        ← 4 轮合并为 1 条
✅ 静置期间又开始跑 → 取消通知（不误报完成）    ← 最易错的路径
✅ 静置后确实空闲 → 推一条通知
✅ 失败轮次 → reason=error
✅ dispose 后不再触发通知
✅ 超长文本被截断
✅ 无 turn/start 的孤立事件不产生通知

通过 12/12
```

**真实 `dsh web` 接线验证**：插件在真实 `ctx` 上订阅成功
（`ctx.on` / `ctx.effect` 均为 function，`installTaskNotify` 返回 true），
且 M1 门禁行为未受影响（无 token → 401、无效 token → 401、有效 token → 200、
静态资源 → 200、加载告警 0 条）。

**M2 的设计约束（写入代码注释）**：

- 事件监听器**绝不抛错**（全部 try/catch）——否则会污染 `session/event` 的提交路径。
- 订阅失败**不阻断登录门禁**：门禁是安全路径，必须继续可用。
- `dispose` 时**先清计时器**再取消订阅，避免卸载后仍弹通知。

### A8. 尚未完成的部分

- **真实 Telegram 端到端**：需真实 Bot Token 与 `@userinfobot` 的数字 ID。
  当前所有验证均在 `dryRun` 下完成，**未与真实 Telegram API 交互过**。
  具体未覆盖：点按钮批准/拒绝、消息分页、`editMessageText`、Bot 自检 `getMe`。
- **M4 `/revoke` 会话撤销**：尚未实现。
- **Linux 部署与反代验收**：尚未做（本机为 Windows）。
- **`/api/*` 与 WebSocket 完整回归**：未逐项比对（门禁只包 `authorizeIndex`，
  理论上不影响，但未实测）。
