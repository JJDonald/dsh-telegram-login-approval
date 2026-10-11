# 原生 WebUI 远程持久设置

## 使用与范围

`remoteSettings` 默认 `true`，也可以在插件 overlay 中显式设置：

```yaml
remoteSettings: true
```

正常通过 Secret Key + Telegram 批准登录后，打开 **DSH 原生 WebUI 的设置/模型页**，配置提供商、模型、API Key 和默认模型。
不需要手改 DSH 安装文件，不增加独立模型网页、TG 模型编辑或新的写入 API。

**启用的是原生 settings 整页的 Host persistence，不只模型。** 其他基于原生 `configForms` 的设置也能使用 Host 提供的表单。
保存仍由原生 `settings/describe/update/mutate` 等接口、profile 配置编辑器和 credentials provider 负责，原生校验、冲突检查与只读限制不变。
API Key 通过原生 `credentials/set` 保存；原生 describe 不返回密钥值。由环境变量提供的只读凭据仍不可从网页覆盖。
若 profile 缺少 settings/configEditor/凭据 provider，或配置被命令行 overlay 覆盖，原生页面仍可能报告不可写；插件不会绕过它们。

`remoteSettings: false` 不安装任何客户端适配，保持实际安装的上游源码和行为。
这不是撤销登录会话或关闭后端写 API：后端已有写接口始终由原生认证及插件会话层保护；功能开关只决定原生客户端是否选择 Host 表单。
改变开关后重新加载页面获取相应模块版本，已运行页面不可能从服务端撤回已执行的 JavaScript。

## Origin 与安全边界

远程启用条件为浏览器 `location.origin === 当前runtime.publicOrigin`，精确匹配协议、域名和端口。
值来自本次启动的设置（已保存的 `web-settings.json` 优先于 overlay 初值），只把公开 origin 作为源码中的字符串字面量，不注入任何密钥、Cookie、nonce 或内存 launch token。
TG 保存新的公开地址不会修改正在运行的适配；下次人工启动才加载新值，与现有启动桥保持一致。

真实 `ctx.remote.$host.isLoopback` **不修改**；上游原有 loopback 分支保留，其他远程 origin 仍选择 `memory`。
不替换全局 `fetch`、不污染全局 loopback 判定、不增加 trustedHosts、不改变后端 Host/Origin fence 或任何权限。
可公开读取客户端源码不等于获得写权限：未认证、仅有旧DSH Cookie、会话过期/撤销的调用仍被原有门禁拒绝。

## 适配点与支持版本

已验证 **DSH 0.2.0-rc.2** 的两个实际接口：

1. `@deepseek-ai/dsh-client-ui-settings` 原生客户端 `apply(ctx)` 中唯一的
   `const persistence = ctx.remote.$host.isLoopback ? "host" : "memory";`，其结果同时传给 `SettingsDescribeMirror` 和 `ConfigForms`。
2. `clientModules` 的原始 `ClientModuleRegistry`：`table`、`compose()`、`rebuilt()`、`readSourceMap`、artifact baseline 与 graph/rebuilt 通知机制。

实现位于 `src/remote-settings.ts`。通过 `Symbol.for('cordis.original')` 取得一个 registry 的真实对象，包装该对象的方法；不改全局 prototype，也不包装任意包或任意路由。
仅针对上述 settings 包及精确单一选择表达式做内存转换，并确认原生 mirror/forms 调用结构。原来的包路径、安装文件和磁盘源码保持不变。

如现有安装含旧的单-origin 手工 OR 条件，适配会**替换**那处条件为本次运行 origin，而非在其旁边追加第二个允许域名。
本轮开发不修改/删除该手工文件；后续部署可按批准流程恢复原版。关闭或卸载插件只恢复实际上游源码，**不会自动消除磁盘上的旧手工条件**。

## 缓存、资源和 HMR

- 转换后的字节、功能版本标识与当前 origin 生成新的12位模块 revision；registry 正常从模块 revision 派生 combo 与启动图 revision。不会在原 immutable URL 下偷偷换字节。
- 单包和多包 combo、graph preload 及 package-local chunk URL 都继续由原生 registry 管理。未修改的 chunk 字节与原生资源路由不被劫持，只随所属模块 revision 正常换URL。
- 原生资源保持 `public, max-age=31536000, immutable`；当前接口不设置 ETag，插件也不伪造 ETag。HEAD 仍不生成正文。
- 转换过的主 bundle 不使用旧 TypeScript source map，改由原生组合器生成**包含转换源码的 identity map**；其他包和 chunk 的原生 map 不变。调试可定位生成的 JavaScript，但此模块不再映射回原始 TypeScript。
- `compose()` 每次都在原生组合资源之前处理当前 settings row，所以初始化扫描、后续加载/重挂载均不依赖浏览器脚本先后或“before注入能找到对象”的假设。
- `rebuilt()` 仅对 settings 包按当前原生算法读取新的 baseline/源码，适配后发布实际 revision。HMR 的 rebuilt 和 graph 通知因此不会重新装回未适配源码；其他包沿用原方法。
- 上游保留一代旧 batch 给竞态请求；旧 single-module/chunk revision 可能返回404。旧 URL 不会变成新版字节。
- 卸载恢复该 registry 的原始方法描述符和当前原生 settings row（包括最后一次HMR后的源码），重新组合并通知 graph。既有客户端缓存不需要手工清除：重加载使用恢复后的 revision。

## 可选加载和升级失败

登录插件的主 `inject` 仍只有 `webServer`、`connection`。UI适配是独立的 `ctx.inject(['clientModules'], ...)` 子 fiber；未安装该服务不会无限等待登录门禁或阻止 `DSH_TELEGRAM_GATE_READY`。
父插件或模块服务卸载时，Cordis effect disposer 负责完整还原。READY/UNLOADED 和现有启动桥逻辑保持原状。

启动日志有 `remoteSettings` 前缀：

- 等待/注册可选服务时说明登录门禁不等待它。
- 成功时明确「原生 settings host 持久配置已适配」及其公开 origin。
- 包尚未注册、源码不匹配、registry接口不兼容时记录 `remoteSettings 未启用` 及原因，保留上游UI行为，**不关闭登录门禁**。

DSH升级后若适配点改变，本功能不猜测替换新源码。HMR出现未知新源码也保留它并警告；原生UI是否支持远程配置此时由上游决定。
应检查日志并重新验证，不能把登录 gate READY 当成此可选功能已经就绪。

## 本轮最小验证边界

使用仓库内临时材料和本机临时端口，无真实Telegram消息、用户模型、真实API Key或付费调用：

- 从现役源码**仅在临时副本/内存去掉旧手工条件**，验证未手改原版表达式；安装文件前后SHA-256相同。
- 实际 ClientModuleRegistry 的单模块/combo/HEAD/map/revision/HMR接口验证；旧缓存URL不会承载转换后的新字节，卸载还原原方法及源码。
- 执行完整原生 settings factory、mirror、forms：匹配origin时Host并调用describe/mutate，其他远程origin时memory且不发这些调用，真实isLoopback不变。
- 原生Cordis/WebServer/Connection/Gateway/SettingsController/SettingsForms临时装配：表单通过真实HTTP settings接口编辑测试模型、提供商和默认模型，configEditor边界使用临时profile写入替身；原生LocalCredentialProvider将假测试Key持久化并脱敏describe。此检查不声称测试了完整生产profile热重载或浏览器DOM。
- 未认证/仅旧Cookie401、不同Origin403；功能关闭、已保存运行origin、待生效origin不立即切换、不兼容源码和卸载路径验证。已有gate集成检查21/21通过。

确切限制：适配绑定上述版本和接口；不安装缺失provider，不绕过只读/overlay覆盖，不保证新增上游模块布局自动兼容；仅恢复原生页面已有能力，不提供新的模型/凭据功能。
