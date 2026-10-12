# dsh-telegram-login-approval

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 的 Web 访问加两层 Telegram 能力：

1. **登录带外批准** —— 有人尝试登录你的 DSH，必须你在手机上点确认，才发放会话 cookie。
2. **任务完成通知** —— 长任务跑完（或多轮任务结束）推一条消息到手机。

另外默认恢复配置的公开 HTTPS origin 上 **DSH 原生 WebUI 设置页的 Host 持久配置**：
直接在原生模型页编辑模型、提供商、API Key 和默认模型，不增加独立网页或 TG 模型编辑。
`remoteSettings: false` 可关闭。注意这启用的是**原生 settings 整页**，不只模型；
已有登录批准、会话及 Host/Origin 保护不变。详见 [远程原生设置](docs/remote-settings.md)。

零 npm 依赖（只用 Node 内置能力），以 Cordis 插件形式挂载，**不改 DSH 源码**。

---

## 为什么需要它

DSH 的 Web 登录是「每进程随机 token → 换取**30 天**签名 cookie」。设计本身很强
（HMAC 签名、绑定 authority、`SameSite=Strict`、不信任转发头），但有两个缺口：

| 缺口 | 说明 |
|---|---|
| token 泄露即接管 | 拿到正确 token 可直接换到 30 天会话，中间**没有任何人工确认环节** |
| 没有 logout | 官方文档明确：撤销只能「删凭据记录 + 重启 `dsh`」 |

本插件补上这两个缺口：**旧 launch token 不能直接登录；必须输入独立密钥并经 Telegram 批准。**
同时增加持久化、可撤销的独立浏览器会话。升级后旧浏览器须重新登录一次，不保留仅有旧 DSH Cookie 的兼容路径。

## 工作原理

不接管 `/` 的静态提供，而是包装共享 `ctx.connection.authorizeIndex` 和 `requestRejection`，
在 DSH 原生签名 Cookie 之外叠加独立持久化会话，并在 WebServer upgrade 分发前检查。
index.html 的提供、目录遍历防护、`<base>` 注入及原 Host/Origin fence 全部保持 DSH 原样。

登录入口不再依赖 URL 里的 token，而是要求一个**长期独立 Secret Key**：

```
GET /                       → 未认证，返回登录表单（不落 DSH 的 401）
POST /login  (secret)       → 校验 Secret Key
                              ├─ 错误                → 401；错误桶冷却中为 429，不发通知
                              ├─ 已有待批准/已批准    → 303 复用同一请求（不轰炸通知）
                              ├─ 正确但通知配额耗尽  → 429
                              └─ 正确               → 新建批准请求
                                                        ├─ 下发 nonce cookie
                                                        ├─ 发 Telegram 确认卡片
                                                        └─ 303 → /login/status?request=...
GET /login/status?request=… → 校验 nonce cookie 与请求绑定
                              ├─ pending             → 200 等待页（meta refresh 自动刷新）
                              ├─ denied / expired    → 403 / 410
                              └─ approved            → 单次消费，交回 DSH 完成 303 + Set-Cookie
```

**关键安全性质**：批准只是「准入」，不是「认证」。批准后仍由 DSH 原方法签发会话 cookie，
且批准**单次消费**、绑定浏览器 nonce——重放等待页只会得到 401。
还会签发独立 `__Host-dsh-web-session` Cookie；服务端只存随机凭证哈希和会话元数据。
任意多个浏览器可分别获批，不互相顶掉；过期/撤销实际拦截首页、API 与新 WS，并关闭该会话已有 WS。

### 旧 launch token 已停用

早期版本（M1）用 URL 里的 `?token=...` 作为门禁信号。该模型已**移除**：
带 `token` 查询参数的请求现在被明确拒绝（401），不再进入批准流程。
规格文档见 [`docs/dsh-telegram-login-approval.md`](docs/dsh-telegram-login-approval.md)（M1 历史设计）。

## 安装

### 1. 准备 Telegram Bot

- 找 [@BotFather](https://t.me/BotFather) 发 `/newbot`，拿到 token
- 找 [@userinfobot](https://t.me/userinfobot) 查你的**数字用户 ID**

> 建议**与其它 TG 插件使用不同的 Bot**。Telegram 的 `getUpdates` 一个 Bot 只能有一个消费者，
> 共用 Bot 会导致两个插件互相抢更新。

### 2. 生成 Secret Key

登录不再是「拿到 URL 就能进」，而是要输入一个独立密钥：

```bash
install -d -m 700 /etc/dsh
install -m 600 /dev/null /etc/dsh/web-secret.key
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))" > /etc/dsh/web-secret.key
```

文件必须是 **root 所有、权限 600 的普通文件**（32 字节随机数据编码为无填充 base64url，正好 43 字符；与管理台重置密钥一致）。
插件启动时会强制校验，不满足直接抛错——不会静默放行。

在管理员 Telegram 私聊发送 `/key` 可取回密钥；发送 `/web` 或 `/start` 打开 **🌐 Web 管理台**。
管理台展示实际绑定、内部/公开地址、密钥、Web 会话数、待批准数和各期限；支持交互设置、会话列表与踢出。
重置密钥、逐个/全部踢出均二次确认。完整说明见 [Web 管理台与启动衔接](docs/web-console.md)。

### 3. 放置插件

```bash
git clone https://github.com/JJDonald/dsh-telegram-login-approval.git
```

### 4. 配置 overlay

复制 `cordis.example.yml`，把 `<PLUGIN_DIR>` 换成插件在本机的**绝对路径**：

```yaml
- insert:
    - id: telegram-login-approval
      name: '/home/you/dsh-telegram-login-approval/src/index.ts'   # Windows: 'F:/path/...'
      config:
        botTokenRef: TELEGRAM_LOGIN_BOT_TOKEN
        adminChatId: 123456789                        # 改成你自己的数字 ID
        publicOrigin: 'https://dsh.example.com'       # 你的公开 HTTPS origin
        botUsername: 'example_bot'                    # 你的 Bot 用户名（不含 @）
        secretFile: '/etc/dsh/web-secret.key'         # 上一步生成的文件
        dryRun: false
```

### 5. 启动

```bash
export TELEGRAM_LOGIN_BOT_TOKEN='123456:ABC...'

cd /path/to/deepseek-harness
node --import tsx/esm apps/cli/src/bin.ts \
  --profile web \
  --patch /path/to/cordis.yml \
  --no-open --port 8188
```

> `--patch` 属于 `dsh` 层级参数，必须放在 `--profile` **之后**、app 参数（`--no-open` 等）**之前**。

**要让管理台保存的绑定地址/端口生效**，后续部署必须采用 [`scripts/serve.ts`](scripts/serve.ts)
启动衔接（配置 [`scripts/serve.example.json`](scripts/serve.example.json)），或人工将保存值写入实际启动参数。
脚本从 `web-settings.json` 加载绑定与公开地址，传入 `--host/--port/--trusted-host`；
保留 READY/UNLOADED fail-closed 衔接并截获含 launch token 的上游 URL 输出。
详见 [部署步骤](docs/web-console.md#启动衔接后续人工部署)。**面板不会自动重启或修改 nginx/DNS。**

### 6. 首次登录

直接访问 `https://<你的 publicOrigin>/`，输入 Secret Key。
浏览器显示「等待 Telegram 确认」，同时 Telegram 收到带 **✅ 确认登录 / ❌ 拒绝** 按钮的卡片。
点确认后页面自动跳转进入。

## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | `false` 时完全不包装（等价于未安装） |
| `remoteSettings` | `true` | 为本次运行的公开 HTTPS origin 启用原生 settings 整页 Host 持久配置；`false` 保持上游客户端不变 |
| `publicOrigin` | **必填** | 本部署唯一的公开 HTTPS origin，如 `https://dsh.example.com` |
| `botUsername` | `''` | Bot 用户名（不含 `@`）；仅用于页面文案与 `/key@<bot>` 匹配 |
| `secretFile` | **必填** | root-only Secret Key 文件的绝对路径 |
| `botTokenRef` | — | Bot Token 的**环境变量名**（推荐） |
| `botToken` | — | 直接写 token（不推荐，容易误提交） |
| `adminChatId` | **必填** | 唯一被接受的 Telegram 数字用户 ID |
| `ttlSeconds` | `300` | 新批准有效期，30–3600 整数秒；nonce Cookie 同步使用该期限 |
| `sessionDays` | `30` | 新Web会话有效期，整数天；不得超过当前DSH原生 `cookieMaxAgeDays` |
| `failureCooldownSeconds` | `600` | 全局10次错误密钥/60秒后仅限制错误输入，60–86400整数秒；正确密钥不受此冷却影响 |
| `windowSeconds` | `600` | Telegram确认通知触发限流窗口（与错误密钥冷却独立） |
| `maxTriggersPerWindow` | `3` | 窗口内最多触发次数 |
| `cooldownSeconds` | `600` | 通知触发超限后的冷却时长（不控制错误密钥冷却） |
| `notifyOnDeny` | `true` | 是否回发拒绝提示 |
| `dryRun` | `false` | `true` = 不碰网络，仅本地验证门禁行为 |
| `dataDir` | `$DSH_HOME/storages/telegram-login-approval` | offset、Web设置与会话落盘目录；与启动衔接配置保持一致 |

**配置缺失会直接抛错**，而不是静默退化成「无门禁」——这是安全路径，
不允许「忘配就等于不生效」。`publicOrigin` 与 `botUsername` 都是配置项，
源码里不写死任何具体域名或 Bot。面板设置保存后优先于 overlay 默认值；
期限设置立即用于新条目，旧会话/批准/已启动冷却保持原截止时间。
绑定/公开地址只在下次人工启动加载，面板同时显示运行值与待生效值。

## 原生 WebUI 远程设置

默认开启，支持 DSH **0.2.0-rc.2** 的 `dsh-client-ui-settings` / `clientModules` 适配点。
经正常登录后在原生模型页配置，仍调用原生 `settings/describe/update/mutate`、`credentials/set` 等接口；
保存由 DSH 的 profile 配置编辑器和凭据 provider 完成。环境变量提供的只读 API Key 仍不可覆盖。
插件不伪造 `isLoopback`、不改全局 `fetch`、不放宽后端认证或其他 origin。

实现仅在内存中改原生 settings 模块的单一 host/memory 选择表达式，
使用当前运行 `publicOrigin`（已保存启动值优先）；TG 修改地址仍只在下次启动生效。
原生 registry 为转换后的源码生成独立模块/combo revision，source map 使用转换源码的 identity map；
HMR 再发布时仍适配同一模块，卸载恢复原始方法和当前上游源码。**不修改 DSH 安装文件**。

这是一项可选 UI 功能：缺 `clientModules` 不阻塞登录门禁；源码或接口不兼容时明确记录
`remoteSettings 未启用`，保留上游行为，门禁仍正常。DSH 升级后应检查该诊断并重新验证适配。
后续部署如果还有旧手工修改，可另行经批准恢复原版文件；本插件不自动修改它。
关闭功能也不会移除安装文件中已有的手工条件。完整边界见 [功能说明](docs/remote-settings.md)。

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
node --experimental-transform-types /path/to/dsh-telegram-login-approval/tests/gate.test.mts  # 21 个用例
node --experimental-transform-types /path/to/dsh-telegram-login-approval/tests/task-watch.test.mts  # 12 个用例
```

**33 个用例，全部不需要真实 Bot**：用 fake ctx + 假 HTTPS 请求驱动完整的
「Secret Key → 带外批准 → 单次凭证交换 → 不可重放」链路。

覆盖的关键性质：

- 未认证 `GET /` → 200 登录表单（不落入 DSH 的 401）；旧 `?token=` → 401
- 错误 Secret Key → 401 且**不发**任何 Telegram 通知
- 正确 Secret Key → 303 + nonce cookie；重复提交复用同一请求（不轰炸通知）
- 非白名单 Telegram 用户无法批准
- 批准 → 303 交换凭证并清除 nonce；**不可重放**（再次访问 401）
- 拒绝 → 403 且不发凭证
- 配置校验：缺 `adminChatId` / 非 HTTPS `publicOrigin` / 非法 `botUsername` 均抛错
- `prototype` 补丁确实生效（新 facade 也命中）；卸载后还原
- 新会话哈希持久化、多浏览器独立、旧 Cookie 拒绝、撤销后不复活
- 管理台私聊/消息绑定、设置回复绑定、踢出二次确认、错误密钥全局冷却
- 多轮任务只推一条通知；静置期重新开跑则取消通知；`dispose` 后不再触发

## 安全说明

- 批准请求**只存内存**，进程重启即全部失效（fail-closed）。
- 批准**单次消费**，不可重放；批准绑定浏览器随机 nonce（`__Host-` cookie）。
- **日志不出现 Secret Key / nonce / cookie / Bot Token**；pending 只存 `sha256(nonce)`。
- Telegram 请求使用 Node 内置 `node:https`，不经过全局 `fetch`，避免 bili 等同进程模型代理钩子记录含 Bot Token 的 URL；网络异常与 API 错误说明中的 Token 统一脱敏。
- 若旧版本已把 Bot Token 写入日志，升级不会消除旧记录或撤销 Token；需在 BotFather 更换 Token，并更新部署环境变量。
- 只接受 `adminChatId` 的**私聊**消息，其余静默忽略并记日志。
- 插件异常一律 **fail-closed**（按未认证处理），不擅自放行。
- 输入正文限制 4 KiB，完成正文读取后校验密钥；错误密钥不触发任何通知，冷却中返回429及 Retry-After且不延长截止。正确密钥不检查或计入错误桶，仍受Telegram通知配额限制并必须获批。
- 限流用**全局单键**而非 per-IP：插件运行在 DSH 进程内，拿不到可信客户端 IP
  （DSH 不采信 `X-Forwarded-*`）。真正的按 IP 限流应放在反代层
  （nginx `limit_req` / fail2ban）。

## 已知限制

- DSH 处于**开发者预览**，官方警告会有破坏性变更。本插件依赖
  `ctx.connection.authorizeIndex` / `requestRejection` / `browserAuth.maxAgeMilliseconds` 与 `ctx.webServer.server`，
  DSH 升级后建议重跑测试。
- 依赖 `authorizeIndex` 无服务端副作用（只签名 cookie、不写状态）。
  若上游改为写会话表，探测方式需要重新评估。
- 撤销通过 `/web` 的逐个/全部踢出按钮，不提供独立 `/revoke` 指令。
- 批准请求不持久化 —— 这是刻意的 fail-closed 选择，不是缺陷。
- 单进程管理一个状态目录；不支持多个DSH进程共享写同一会话/设置文件。
- 不取消已进入处理的HTTP请求或已有SSE响应；新API请求被拒，已有WS会被关闭。
- Session期限上限来自DSH实际原生Cookie寿命（默认30天）；更长寿命须后续人工调整DSH配置并重启，不能仅改浏览器Max-Age。
- 内部地址是实际监听信息，不是绕过公开HTTPS认证的登录入口；无法取得可信真实客户端IP。
- WS治理依赖已提供的WebServer.server和Node upgrade分发；DSH接口变更后需要重新验证。

## 实现要点（给想改代码的人）

四个容易踩的坑，都已写进代码注释：

1. **必须改共享 prototype，不能改实例**。`ctx.connection` 是 Cordis 的服务 facade，
   每次属性访问都返回新对象，实例上的 `defineProperty` 会被静默丢弃。
2. **`ctx.effect(fn)` 会立即调用 `fn`**，并把**返回值**当 disposer。
   写成 `effect(() => callback())` 会在安装那一刻就执行清理。
3. **`authorizeIndex` 不能用返回值判态**。它成功时也返回 `false`（已写 303），
   失败时已经写过 401。判态要用 `requestRejection`（纯检查、不写响应）。
4. **凭证交换必须拦截 DSH 的 `writeHead`**，确认它确实写了 303 + `Set-Cookie` 才放行；
   否则说明 DSH 侧认证未完成，直接抛错而不是发一个空会话。

## 许可

[MIT](LICENSE)
