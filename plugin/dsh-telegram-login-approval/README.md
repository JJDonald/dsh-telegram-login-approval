# dsh-telegram-login-approval

给 **DeepSeek Harness (DSH)** 的 Web 访问加两层 Telegram 能力：

1. **登录带外批准**（M1）—— 登录必须你在手机上点确认。
2. **任务完成通知**（M2）—— 长任务跑完推一条消息到手机。

## 为什么需要它

DSH 的 Web 登录是「每进程随机 token → 换取 **30 天** 签名 cookie」。设计本身很强
（HMAC 签名、绑定 authority、`SameSite=Strict`、不信任转发头），但有两个缺口：

1. **token 一旦泄露 = 直接换到 30 天会话**，中间没有任何人工确认环节。
2. **没有 logout**：官方文档明确说撤销只能「删凭据记录 + 重启 `dsh`」。

本插件补上缺口 1：即使攻击者拿到了正确的 token，**你不点确认就拿不到会话**。

## 工作原理

不接管 `/`，而是包装 `ctx.connection.authorizeIndex`（改共享 prototype）。
index.html 的提供、目录遍历防护、`<base>` 注入全部保持 DSH 原样。

```
GET /?token=...
 └─ authorizeIndex()
      ├─ requestRejection 通过（已有会话） → 交回 DSH，零打扰，不发通知
      ├─ 无 token / token 无效             → 交回 DSH，保持原 401
      ├─ 有效 token 且处于 pending          → 返回等待页（meta refresh 自动刷新）
      ├─ 有效 token 且已批准                → 交回 DSH 完成 303 + Set-Cookie
      └─ 有效 token 且已拒绝/过期/限流      → 返回对应结果页
```

**关键安全性质**：批准只是「准入」，不是「认证」。放行时仍然调用 DSH 原方法校验
token，所以攻击者即使骗你点了确认，只要没有正确 token，最终仍是 401（双保险）。

## 安装

1. 在 `@BotFather` 建一个 Bot，拿到 token（建议**与其它 TG 插件用不同的 Bot**，
   因为 Telegram 的 `getUpdates` 一个 Bot 只能有一个消费者）。
2. 用 `@userinfobot` 查你的数字用户 ID。
3. 设置环境变量并把 overlay 挂到 web profile。

`cordis.yml`：

```yaml
- insert:
    - id: telegram-login-approval
      name: 'F:/workspace/opendsh/plugin/dsh-telegram-login-approval/src/index.ts'
      config:
        enabled: true
        botTokenRef: TELEGRAM_LOGIN_BOT_TOKEN   # 环境变量名，不写明文
        adminChatId: 123456789                  # 你的数字 ID
        ttlSeconds: 300
        dryRun: false
```

启动（`--patch` 属于 `dsh` 层，必须在 `--profile` 之后、app 参数之前）：

```bash
export TELEGRAM_LOGIN_BOT_TOKEN='123456:ABC...'
node --import tsx/esm apps/cli/src/bin.ts \
  --profile web \
  --patch F:/workspace/opendsh/plugin/dsh-telegram-login-approval/cordis.yml \
  --no-open --port 8188
```

> **Windows 路径注意**：overlay 里的 `name` 必须写成 `F:/workspace/...`。
> 写成 `/f/workspace/...` 会被解析成 `F:/f/workspace/...` 导致 `failed to import`。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不包装（等价于未安装） |
| `botTokenRef` | — | Bot Token 的**环境变量名**（推荐） |
| `botToken` | — | 直接写 token（不推荐，会进版本库） |
| `adminChatId` | 必填 | 唯一被接受的 Telegram 数字用户 ID |
| `ttlSeconds` | `300` | 批准请求有效期 |
| `windowSeconds` | `600` | 限流窗口 |
| `maxTriggersPerWindow` | `3` | 窗口内最多触发次数 |
| `cooldownSeconds` | `600` | 超限后的冷却时长 |
| `notifyOnDeny` | `true` | 是否回发拒绝提示 |
| `dryRun` | `false` | `true` = 不碰网络，仅本地验证门禁行为 |
| `dataDir` | `$DSH_HOME/storages/telegram-login-approval` | offset 落盘目录 |

**配置缺失会直接抛错**（而不是静默退化成"无门禁"）：这是安全路径，
不允许"忘配就等于不生效"。

## 安全说明

- 批准请求**只存内存**，进程重启即全部失效（fail-closed）。
- 批准**单次消费**，不可重放。
- **日志不出现 token / cookie / Bot Token**；pending 只存 `sha256(token)`。
- 只接受 `adminChatId` 的**私聊**消息，其余静默忽略并记日志。
- 插件异常一律 **fail-closed**（按未认证处理），不擅自放行。
- 限流用**全局单键**而非 per-IP：插件运行在 DSH 进程内，拿不到可信客户端 IP
  （DSH 不采信 `X-Forwarded-*`）。真正的按 IP 限流应放在反代层
  （nginx `limit_req` / fail2ban）。

## 任务完成通知（M2）

订阅 DSH 的 `session/event` 与 `agent/status`，在一次「任务段」结束时推送一条消息。

**为什么不逐轮通知**：一个任务常跨多轮（工具调用、计划步骤、goal 续跑），
每轮结束都推会刷屏。因此把轮次聚合成**任务段**：

1. 第一次 `turn/start` 开启一个任务段，后续轮次并入同一段；
2. agent 变 `idle` 后等待**静置窗口**（`SETTLE_MS = 800ms`）；
3. 窗口结束后**复查**：若期间又被排入新轮次，则取消本次通知（不误报完成）；
4. 确实空闲才推送一条，附轮次数、耗时、状态与最终回答。

通知状态：`✅ 完成` / `⏹ 已中止` / `❌ 失败` / `⚠️ 输出上限` / `⚠️ 进程重启中断`。
正文超过 `NOTICE_MAX_CHARS`（3200）自动截断。

## 测试

```bash
cd dsh
# M1 登录门禁：9 个用例
node --import tsx/esm ../plugin/dsh-telegram-login-approval/tests/gate.test.mts
# M2 任务段聚合：12 个用例
node --import tsx/esm ../plugin/dsh-telegram-login-approval/tests/task-watch.test.mts
```

两组共 **21 个用例**，**都不需要真实 Bot**（`dryRun` 下零网络请求）。

## 已知限制

- DSH 处于**开发者预览**，官方警告会有破坏性变更。插件依赖
  `ctx.connection.authorizeIndex` / `requestRejection` 与
  `ctx.webServer`，升级后需重跑测试。
- 依赖 `authorizeIndex` 无服务端副作用（只签名 cookie、不写状态）。
  若上游改为写会话表，则 `isTokenValid` 的探测方式需要重新评估。
- 本插件只解决「登录准入」。**会话撤销（`/revoke`）尚未实现**。
- pending 状态不持久化 —— 这是刻意的 fail-closed 选择，不是缺陷。
