# dsh-telegram-login-approval

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 的 Web 访问加两层 Telegram 能力：

1. **登录带外批准** —— 有人尝试登录你的 DSH，必须你在手机上点确认，才发放会话 cookie。
2. **任务完成通知** —— 长任务跑完（或多轮任务结束）推一条消息到手机。

零 npm 依赖（只用 Node 内置能力），以 Cordis 插件形式挂载，**不改 DSH 源码**。

---

## 为什么需要它

DSH 的 Web 登录是「每进程随机 token → 换取**30 天**签名 cookie」。设计本身很强
（HMAC 签名、绑定 authority、`SameSite=Strict`、不信任转发头），但有两个缺口：

| 缺口 | 说明 |
|---|---|
| token 泄露即接管 | 拿到正确 token 可直接换到 30 天会话，中间**没有任何人工确认环节** |
| 没有 logout | 官方文档明确：撤销只能「删凭据记录 + 重启 `dsh`」 |

本插件补上第一个：**即使攻击者拿到了正确的 token，你不点确认就拿不到会话。**

## 工作原理

不接管 `/`，而是包装 `ctx.connection.authorizeIndex`。
index.html 的提供、目录遍历防护、`<base>` 注入全部保持 DSH 原样。

```
GET /?token=...
 └─ authorizeIndex()
      ├─ 已有会话                    → 交回 DSH，零打扰，不发通知
      ├─ 无 token / token 无效        → 交回 DSH，保持原 401
      ├─ 有效 token 且待批准          → 返回等待页（meta refresh 自动刷新）
      ├─ 有效 token 且已批准          → 交回 DSH 完成 303 + Set-Cookie
      └─ 有效 token 且被拒/过期/限流  → 返回对应结果页
```

**关键安全性质**：批准只是「准入」，不是「认证」。放行时仍然调用 DSH 原方法校验 token，
所以攻击者即使骗你点了确认，只要没有正确 token，最终仍是 **401**（双保险）。

## 安装

### 1. 准备 Telegram Bot

- 找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 token
- 找 [@userinfobot](https://t.me/userinfobot) 查你的**数字用户 ID**

> 建议**与其它 TG 插件使用不同的 Bot**。Telegram 的 `getUpdates` 一个 Bot 只能有一个消费者，
> 共用 Bot 会导致两个插件互相抢更新。

### 2. 放置插件

```bash
git clone https://github.com/JJDonald/dsh-telegram-login-approval.git
```

### 3. 配置 overlay

复制 `cordis.example.yml`，把 `<PLUGIN_DIR>` 换成插件在本机的**绝对路径**：

```yaml
- insert:
    - id: telegram-login-approval
      name: '/home/you/dsh-telegram-login-approval/src/index.ts'   # Windows: 'F:/path/...'
      config:
        botTokenRef: TELEGRAM_LOGIN_BOT_TOKEN
        adminChatId: 123456789        # 改成你自己的数字 ID
        dryRun: false
```

### 4. 启动

```bash
export TELEGRAM_LOGIN_BOT_TOKEN='123456:ABC...'

cd /path/to/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts \
  --profile web \
  --patch /path/to/cordis.yml \
  --no-open --port 8188
```

> `--patch` 属于 `dsh` 层级参数，必须放在 `--profile` **之后**、app 参数（`--no-open` 等）**之前**。

### 5. 首次登录

打开启动时打印的 `http://127.0.0.1:8188/?token=...`。
浏览器会显示「等待手机确认」，同时 Telegram 收到带 **✅ 确认登录 / ❌ 拒绝** 按钮的卡片。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不包装（等价于未安装） |
| `botTokenRef` | — | Bot Token 的**环境变量名**（推荐） |
| `botToken` | — | 直接写 token（不推荐，容易误提交） |
| `adminChatId` | 必填 | 唯一被接受的 Telegram 数字用户 ID |
| `ttlSeconds` | `300` | 批准请求有效期 |
| `windowSeconds` | `600` | 限流窗口 |
| `maxTriggersPerWindow` | `3` | 窗口内最多触发次数 |
| `cooldownSeconds` | `600` | 超限后的冷却时长 |
| `notifyOnDeny` | `true` | 是否回发拒绝提示 |
| `dryRun` | `false` | `true` = 不碰网络，仅本地验证门禁行为 |
| `dataDir` | `$DSH_HOME/storages/telegram-login-approval` | offset 落盘目录 |

**配置缺失会直接抛错**，而不是静默退化成「无门禁」——这是安全路径，
不允许「忘配就等于不生效」。

## 任务完成通知

订阅 `session/event` 与 `agent/status`，在一次「任务段」结束时推送一条消息。

**为什么不逐轮通知**：一个任务常跨多轮（工具调用、计划步骤），每轮结束都推会刷屏。
因此把轮次聚合成**任务段**：

1. 第一次 `turn/start` 开启任务段，后续轮次并入同一段；
2. agent 变 `idle` 后等待**静置窗口**（`SETTLE_MS = 800ms`）；
3. 窗口结束后**复查**：若期间又被排入新轮次，则取消通知（不误报完成）；
4. 确实空闲才推送一条，附轮次数、耗时、状态与最终回答。

状态：`✅ 完成` / `⏹ 已中止` / `❌ 失败` / `⚠️ 输出上限` / `⚠️ 进程重启中断`。
正文超过 3200 字符自动截断。

## 测试

```bash
npm install        # 只装 tsx
npm test
```

或在 DSH 仓库内直接运行：

```bash
cd /path/to/deepseek-harness
node --import tsx/esm /path/to/dsh-telegram-login-approval/tests/gate.test.mts        # 9 个用例
node --import tsx/esm /path/to/dsh-telegram-login-approval/tests/task-watch.test.mts  # 12 个用例
```

**21 个用例，全部不需要真实 Bot**（`dryRun` 下零网络请求）。

覆盖的关键性质：

- 门禁判定：无 token / 无效 token → 401；有效 token → 等待页
- `prototype` 补丁确实生效（新 facade 也命中）
- 同一 token 重复访问复用 pending（不轰炸通知）
- 卸载后原型方法还原
- 多轮任务只推一条通知；静置期重新开跑则取消通知
- `dispose` 后不再触发通知

## 安全说明

- 批准请求**只存内存**，进程重启即全部失效（fail-closed）。
- 批准**单次消费**，不可重放。
- **日志不出现 token / cookie / Bot Token**；pending 只存 `sha256(token)`。
- 只接受 `adminChatId` 的**私聊**消息，其余静默忽略并记日志。
- 插件异常一律 **fail-closed**（按未认证处理），不擅自放行。
- 限流用**全局单键**而非 per-IP：插件运行在 DSH 进程内，拿不到可信客户端 IP
  （DSH 不采信 `X-Forwarded-*`）。真正的按 IP 限流应放在反代层
  （nginx `limit_req` / fail2ban）。

## 已知限制

- DSH 处于**开发者预览**，官方警告会有破坏性变更。本插件依赖
  `ctx.connection.authorizeIndex` / `requestRejection` 与 `ctx.webServer`，
  DSH 升级后建议重跑测试。
- 依赖 `authorizeIndex` 无服务端副作用（只签名 cookie、不写状态）。
  若上游改为写会话表，`isTokenValid` 的探测方式需要重新评估。
- **会话撤销（`/revoke`）尚未实现**。当前撤销全部会话仍需「删凭据记录 + 重启 `dsh`」。
- 批准请求不持久化 —— 这是刻意的 fail-closed 选择，不是缺陷。

## 实现要点（给想改代码的人）

三个容易踩的坑，都已写进代码注释：

1. **必须改共享 prototype，不能改实例**。`ctx.connection` 是 Cordis 的服务 facade，
   每次属性访问都返回新对象，实例上的 `defineProperty` 会被静默丢弃。
2. **`ctx.effect(fn)` 会立即调用 `fn`**，并把**返回值**当 disposer。
   写成 `effect(() => callback())` 会在安装那一刻就执行清理。
3. **`authorizeIndex` 不能用返回值判态**。它成功时也返回 `false`（已写 303），
   失败时已经写过 401。判态要用 `requestRejection`（纯检查、不写响应）。

## 许可

[MIT](LICENSE)
