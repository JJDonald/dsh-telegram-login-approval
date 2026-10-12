# Telegram Web 管理台

## 操作入口

仅 `adminChatId` 本人的 Bot **私聊**可使用 `/web`、`/start`、`/key`、设置文字与回调。
`/web` 展示 🌐 Web 管理台：启用状态、当前实际 `host:port`、内部监听地址、当前公开 HTTPS origin、待下次启动的网络配置、访问密钥、有效浏览器 Session 数、仍待决定的登录数及各期限。
密钥仅在管理员主动请求的卡片中显示，不写日志。

按钮布局：

| 左列 | 右列 |
| --- | --- |
| 绑定地址 | 绑定端口 |
| 自定义地址 | Session有效期 |
| 登录确认有效期 | 失败登录冷却时间 |
| 重置访问密钥 | 当前登录会话 |

底部「踢出全部Web会话」。只有当前管理卡片有效（10分钟）；旧卡片的随机标识或消息 ID 不匹配则拒绝。
设置需**回复 Bot 发来的设置提示**，而非任意新消息；`/cancel` 取消，`/web` 重新打开。
重置密钥、逐个/全部踢出都会弹出新的二次确认卡片，确认单次消费。

「当前登录会话」每页5个，显示安全短 ID、登录/到期时间（UTC ISO格式）、浏览器 UA（显示前80字符）。
完整内部 ID 仅作按钮标识；不显示凭证、Cookie 或其哈希。这里不是 DSH 的任务会话。
不能取得可信客户端 IP，明确不采信 `X-Forwarded-*`。

## 配置的生效与边界

| 项目 | 支持输入 | 生效策略 |
| --- | --- | --- |
| 绑定地址 | `127.0.0.1` / `0.0.0.0`（DSH实际支持） | 保存待下次人工启动加载；`0.0.0.0` 会监听所有IPv4接口，需自行审核网络暴露 |
| 绑定端口 | 1–65535整数 | 保存待下次人工启动加载 |
| 自定义地址 | 规范 `https://域名[:端口]`，无尾斜杠、路径、查询、用户名 | 保存待下次人工启动加载；不会自动改代理、TLS、DNS |
| Session有效期 | 1–当前DSH原生Cookie寿命的整数天，默认30 | 新创建Web Session使用；旧Session保持原到期 |
| 登录确认有效期 | 30–3600整数秒，默认300 | 新批准及其nonce Cookie使用；旧批准保持原到期 |
| 失败登录冷却 | 60–86400整数秒，默认600 | 仅错误密钥受限；新发生的冷却使用新值，已启动冷却保持原截止 |

保存的 `web-settings.json` 优先于 overlay 默认值。绑定/公开地址保存不影响本次运行，卡片明确同时展示当前运行值和待生效值；期限保存即影响后续新条目。
原生 DSH Cookie 的服务端签名验证完全保留，独立会话层只进一步缩短寿命，不修改其签名字段或假装通过改浏览器 Max-Age 延长。
上限读取实际 `connection.browserAuth.maxAgeMilliseconds`；默认原生30天，因此默认可选1–30天。
若人工配置了更短原生寿命，需同步降低插件 `sessionDays` 或已保存的设置，否则启动报错而不是无声放宽。
若要更长寿命，必须后续人工修改 DSH `connection` 行的 `cookieMaxAgeDays` 后重启；不能只改插件设置。

错误密钥限流是**全局**10次错误/60秒后进入配置的冷却，默认10分钟。
先完成 Host/Origin、Content-Type 与4 KiB正文限制，再以正文完成时刻校验密钥。错误密钥在冷却中返回429及 Retry-After，不再计数或延长截止；未冷却时记录错误并返回401。正确密钥不检查或计入错误桶，即使该桶冷却中仍可复用待审批请求或申请新审批；仍受独立通知配额限制，且必须经Telegram批准后才能兑换原生与独立会话。
与 `windowSeconds/maxTriggersPerWindow/cooldownSeconds` 的 **Telegram 确认通知触发限流**独立；后者仍沿用原参数，避免手机通知轰炸。
计数、冷却与未决批准在内存中，进程重启会清空；不声称支持 per-IP 冷却。

重置密钥先备份、同步落盘、原子替换后更新内存；保持 root 所有与600。
**不会自动踢出既有会话，也不会撤销已创建的批准请求**，二次确认明确说明这一点。需要撤销时另用踢出按钮。

## 会话安全与升级

- 原生DSH签名Cookie继续承担原有认证，额外 `__Host-dsh-web-session` 必须对应未过期、未撤销、当前Host的持久哈希记录。两层缺一不可。
- 升级后仅有旧DSH Cookie的浏览器必须重新登录一次；没有旧Cookie兼容通道。
- 多浏览器独立获批，各有32字节随机凭证，不互相顶掉。批准请求仍单次消费并绑定nonce。
- `authorizeIndex` 与 `requestRejection` 包装共享prototype；API仍走DSH原认证和Host/Origin fence，卸载完整恢复描述符。
- WebServer的实际 `server.emit` 在原upgrade路由之前检查两层认证；不移除/替换上游协议路由，不绕过原 fence。
- 通过的upgrade原socket按Session跟踪；撤销立即destroy该会话所有socket，到期计时也会关闭；新upgrade拒绝。卸载恢复emit并关闭已跟踪socket。
- 合法新会话在插件/进程重启后继续有效（同时要求DSH原生签名凭据保留）；撤销后的记录不会重建或从备份自动复活。
- `web-sessions.json` 只含哈希、随机ID、Host、时间与UA，不保存原始会话凭证。
- 密钥、nonce、Cookie与Bot Token不作为日志字段；Telegram继续只用 `node:https`，保留既有Token错误脱敏。管理操作异常仅输出无正文的固定错误信息。

文件写入使用600临时文件、内容fsync、rename与目录fsync；已有文件先备份为同目录 `.bak` 并设600，备份失败即停止。
内存只在保存成功后变更，写入失败不会回复「成功」。新会话持久化失败时不签发Cookie；已消费的批准须重新发起。
JSON损坏会阻断启动，不静默重建会话。备份由管理员人工恢复，**不要用旧会话备份恢复被撤销的凭证**。
如发生rename之后的磁盘同步失败，面板报告失败，请人工检查实际文件与备份，不要凭失败消息假定磁盘完全未改变。

## 启动衔接（后续人工部署）

本仓库提供 `scripts/serve.ts` 和 `scripts/serve.example.json`；本功能开发不执行部署、重启或系统配置变更。

1. 后续部署时把代码、overlay及启动脚本放入经批准的部署路径。overlay使用 `botTokenRef`；Bot Token仅沿既有环境凭据路径提供，不写入serve配置。
2. 复制 `scripts/serve.example.json` 到部署的私有配置位置，填写实际 `dshBin`、`patch`、绝对 `dataDir` 和初始 `host/port/publicOrigin`。overlay必须显式使用同一 `dataDir`，公开地址初值也一致；保持既有 `DSH_HOME` 和原生DSH签名凭据，才能保留合法新会话。
3. 只读检查：

   ```sh
   node --experimental-transform-types /path/to/plugin/scripts/serve.ts /path/to/serve.json --check
   ```

   不启动DSH、不访问网络。检查输出读取保存的网络值并形成真实 `--host`、`--port`、`--trusted-host` 参数。
4. 人工核对nginx upstream端口/地址、server_name、TLS与DNS；自行按批准流程改代理。插件和脚本不会自动更改它们。
5. 经批准的人工启动入口改为：

   ```sh
   node --experimental-transform-types /path/to/plugin/scripts/serve.ts /path/to/serve.json
   ```

   脚本使用同一个Node运行DSH，保留参数顺序 `--profile web --patch ... --no-open ...`，不新增npm运行依赖。
   子进程打印 `DSH_TELEGRAM_GATE_READY` 后才接受 `dsh web: ...` 的就绪输出；上游带launch token的整行被截获，替换为无凭证公开地址。
   缺READY或出现 `DSH_TELEGRAM_GATE_UNLOADED` 即终止其DSH子进程fail-closed（仅在以后实际使用该启动脚本时发生）。
6. 下次管理员在TG保存绑定/公开地址后，仍须人工安排启动与代理更新；该脚本在每次启动读取 `dataDir/web-settings.json`。单纯继续旧固定参数serve.py不会加载新的绑定值。

本脚本不是服务安装器，也不是热重载/自动重启器；附带线上serve.py仅作为启动衔接参考，未修改。

## 确切限制

单进程、单管理员、单公开origin；不能多个进程共享同一可写状态目录。真实客户端IP不可得。
内部HTTP地址仅报告监听位置；浏览器Cookie要求HTTPS，不能拿内部地址绕过公开Host认证。
不追溯取消已进入处理的HTTP请求或已有SSE流，但后续API/首页请求被拒，现有WS被关闭。
改变公开origin后原origin的会话不会跨Host迁移；DSH原生签名也绑定authority，浏览器需在新地址重新批准登录。
依赖当前DSH实现的共享prototype、纯同步Cookie签发、`browserAuth.maxAgeMilliseconds` 与 WebServer.server/upgrade事件；DSH升级后应验证这些接口。
