# 服务器 API 路径验证（2026-10-20）

## 2026-10-21 新 Session：AdsPower 填卡审查成功

- 使用用户本次提供的 Session 文件，接入用户已打开的 AdsPower 环境；真实登录校验通过，Plus 官网建单使用 PH/PHP。
- 用户已确认现有地址池为真实账单地址。填写卡池卡片与地址后，官网显示 Tax (0%) / PHP 0.00，Due today PHP 982.14。
- 正式 worker 输出 PAYMENT_REVIEW_READY、退出码 0。未提交付款、未记录扣款、未消费 CDK；退出后只读检查卡池 in_use 数量为 0。
- AdsPower 当前表单保留。脱敏截图 debug_screenshots/stripe/payment_review_1792580442228.png，日志 scratch/external-new-session-review.log（含账号/地址等私人信息，不公开）。
- 本次成功的是 external 模式，不代表 Linux persistent 模式的建单超时已经解决。

## 卡片填写审查：姓名可选调整与实际复测

- 用户确认地址池为真实账单地址，要求填写但不付款，并允许卡池姓名留空。
- 审查模式不再因卡池缺少姓名而提前停止：保留页面已有姓名，可选字段留空，页面 required/aria-required 明确要求时停止；审查模式不生成姓名，不回退随机地址。
- 新增 scripts/check-formal-review.cjs，强制 PAYMENT_REVIEW_ONLY=1、清空 CDK；开启付款请求拦截，截图遮挡输入框。
- 6 项审查测试通过，覆盖可选姓名为空、网页必填姓名拒绝空值、付款提交拦截与卡片释放。
- 两轮 Linux 正式 worker 均通过真实 Session 校验，但官网未返回新 Checkout，停在建单超时；未领取或填写卡片，未提交付款，未核实本次免税税额。
- 日志 scratch/formal-fill-review.log 和 scratch/formal-fill-review-2.log；失败截图 scratch/review-checkout-failure.png 与 scratch/review-checkout-failure-2.png。临时容器和数据库配置文件已清理，浏览器 profile 保留。

## 用户要求再次正式测试至付款前（最新）

- 使用当前 session.json，在独立 Linux Xvfb 容器重新启动正式 index.js worker，仅建单模式；本次单次运行退出码 0。
- 真实 Session 账号校验成功，官网新 Checkout HTTP 200，Plus / PH / PHP，空白卡片表单就绪，应付 PHP 1,100。
- 输出 CHECKOUT_PREFLIGHT_READY、paymentSubmitted=false；没有预留银行卡、填写卡片、提交付款或消耗 CDK。本次日志未出现验证交互，不据此宣称 403 已永久解决。
- 证据：scratch/formal-requested-check.log、scratch/formal-requested-check.png。3 项付款边界测试通过；浏览器正常关闭并释放锁，临时容器已删除，状态卷保留。生产服务器未操作。

## 正式 worker 接入结果（本轮最新）

- `server.js` 调度与 `index.js` 新增 persistent 模式，Linux Xvfb 完整 Chromium、持久化目录、跨进程互斥、同一页面完成真实 Session 校验及官网建单。旧本地 `.env` 未切换。
- `scripts/check-formal-checkout.cjs` 调用正式 worker，强制仅建单、清空 CDK；验证不需要数据库。mock 边界测试确认成功、表单不就绪、验证失败均不会调用卡池/付款/数据库。
- 本轮共六次真实 worker 运行：首次验证失败；第二次成功到空白支付表单；重启容器后第三次套餐面板未打开；第四次验证点击后未通过；第五次 Upgrade 打开了账号菜单而非套餐；修复打开套餐的正常 UI 操作后，第六次成功。
- 最终一次无需人工点击，记录两次正常验证交互后的官网成功响应，Session 真实账号校验通过；正式 worker 输出 HTTP 200、official_client、Plus、PH/PHP、cardFieldsReady=true、paymentSubmitted=false，退出码 0。未重试付款请求。
- 最新证据 `scratch/formal-checkout-final.png`，此前成功 `scratch/formal-checkout-ready.png`；失败截图也保留。不将这些样本宣称为长期成功率。
- `compose.formal-preflight.yml` 为独立仅建单检查；`compose.server.yml` 为待部署正式服务配置。操作方式及限制见 `SERVER_RUNTIME.md`。
- 本轮使用缓存 Linux 镜像安装 Xvfb 后复制当前源码验证，尚未验收从零构建整个生产支付镜像。没有连接或修改生产服务器，也没有进行实际付款。
- 最终 62 项针对性回归全部通过，两个 compose 文件静态检查通过。测试容器已删除，profile 卷保留；现有三个本地容器均 healthy。

以下为此前独立实验的历史记录。

状态：最新 Session 已在 Linux Xvfb 持久化完整浏览器中通过真实登录校验，并经官网客户端成功新建 Plus 结账会话（HTTP 200）；已打开付款前页面，未提交付款。尚不代表生产部署或长期无人值守稳定性验收通过。

## 最新验收成功：新 Session → 人机验证 → 新结账会话

- 在同一个 Linux Chromium 进程中保持完整有头模式（Xvfb）和原持久化目录，不在步骤之间反复关闭重启。
- 首页 HTTP 200；强制写入本次 session.json Cookie 并通过真实 /api/auth/session 校验，目标账号匹配。
- 更新客户端页面时遇到 403。等待页面和可见复选框完整显示，依据实际截图正常点击一次；随后主文档 HTTP 200，显示 Plus 套餐页。
- 调用现有 createOfficialClientCheckout，观察器在点击前安装；只接受本次 POST /backend-api/payments/checkout 返回的新会话。官网响应 HTTP 200，套餐 chatgptplusplan、地区 PH、币种 PHP 经请求校验，未读取历史链接冒充成功。
- 官网自动导航到本次 Checkout。截图显示空白银行卡表单、ChatGPT Plus、应付 PHP 1,100（含 VAT 12%）。未填写卡片、未点击 Subscribe，未调用支付 worker、卡池或 CDK 方法。
- 对输入 session.json 做 SHA256 核对，测试输入与当前文件一致。证据：scratch/checkout-audit.json（脱敏摘要）、scratch/verified-new-session-checkout.json（含结账链接，应保密）、debug_screenshots/network-check/verified-new-session-checkout.png。
- 成功交互脚本 scratch/goal-browser.cjs 保留。此次包含代理依据截图确认控件就绪的交互；不能据此声称无人值守的控件识别和长期稳定性已解决。直接 API 旧路径未在本轮认定修复，成功的是官网客户端路径。
- 浏览器正常关闭；临时容器清理，kc-pay-browser-validation 卷保留正常生成的浏览器状态。生产服务器和现有本地服务未修改。

## Session 挑战页处理修复与验证（最新）

- 新增 session-challenge-page.js：当同源 Session fetch 明确返回 cf-mitigated: challenge 且启用可见交互回调时，在当前浏览器显示精确的 /api/auth/session GET 页面，最多调用一次交互回调，仅接受该端点真实导航响应。未循环重放请求，未重试任何付款 POST。
- 修复成功返回 JSON 页面可能没有标题、被通用页面检测错误拒绝的问题。只对精确 Session 端点且 application/json 响应允许此分支，调用方仍校验真实 JSON 与目标账号。
- 禁止对 Session JSON 页面截图，避免凭据被写入截图；诊断仍仅存端点类别和状态码。
- 32 项针对性测试通过，包括回调完成但没有认证响应不能算成功、空 JSON 不能算登录、响应监听清理与已存在 Session 流程回归。
- 一次 Linux 实测在 public 首页仍被验证拦截，未到 Session fetch，因此本次修复的真实上游效果尚未验证。不能宣称 403 已解决。记录 scratch/session-challenge-fix-run.log。
- 停止并移除诊断容器，保留原状态卷；未建单、未付款、未操作生产服务器。

## 再次提供 Session 后的复测（最新）

- 用户再次附上 session.json 并要求继续。输入包含 AccessToken 和登录 Cookie，token 的 exp 尚未到期；未输出凭据。
- 独立 Linux Xvfb 容器使用原持久化卷，official_client 预检设置 PREFLIGHT_REPLACE_SESSION=1。
- 官网首页 HTTP 200；新 Cookie 写入后 /api/auth/session 返回 HTTP 403 / cf-mitigated: challenge，无法验证新账号登录。程序恢复原登录 Cookie，停止后续建单。
- 此次未进入 Checkout，不能认定 Session 无效或建单接口失败；没有新订单、付款或卡池操作。
- 诊断记录 scratch/session-recheck-official.log；截图 debug_screenshots/network-check/session-recheck.png 为主页面状态，不是 Session fetch 响应正文截图。
- kc-pay-session-recheck 容器已清理，状态卷保留，现有三个本地服务仍 healthy；未操作生产服务器。

## 用户更新 Session 后的实测（最新）

- 通过 PREFLIGHT_REPLACE_SESSION=1 强制安装此次输入的登录 Cookie，避免同邮箱被识别为已登录后沿用旧 Cookie。仍保留原有浏览器目录，并真实验证目标账号。
- 首页 HTTP 200、Session HTTP 200；线上返回 token 与新输入完全一致，两者 exp 均未到期。此轮没有出现之前的建单 401，不能将所有后续失败继续归因于旧凭据。
- 单次 API 建单返回 HTTP 403，且 cf-mitigated: challenge，明确为挑战拦截；没有取得新结账会话。记录 scratch/new-session-api.log。
- 随后单独测试 official_client，public 首页出现挑战且一次可见交互未通过，在登录与建单前停止。记录 scratch/new-session-official.log。这次无法评估官网建单接口结果。
- 未付款，未使用卡池或 CDK，生产服务器未操作。诊断容器移除，命名卷中的浏览器状态保留。

## 建单返回 401 与认证请求诊断（最新）

- 新增 browser-request-diagnostics.js，仅记录阶段、端点类别和状态码，不记录 URL 参数、请求体、响应正文或凭据；最多 100 条事件。
- 官网客户端路径：homepage 200、真实 session 200，客户端刷新后首页 403，未发出建单请求。记录 scratch/client-diagnostic-run.log。
- 单独选 PERSISTENT_CHECKOUT_MODE=api，在同一真实登录页面直接执行一次 Checkout：homepage 200、session 200、checkout 401（非 cf-mitigated challenge），上游明确返回“Your authentication token has expired. Please try refreshing it.”。没有生成订单。记录 scratch/persistent-api-run.log。
- 本地输入 token 的 exp 尚未到期，不代表接口一定接受；本次建单使用的是线上 Session API 返回的 token，未核实其与输入 token 是否一致，也未核实其 exp。不能据此声称输入 token 已过期或账号 Cookie 无效。
- Session fetch 增加 cache:no-store，预检增加只输出 token 相等与到期布尔值的诊断。后续核对运行在 public 阶段被挑战拦截，没有取得 token 对比结果；缓存问题仍是假设，未证实。
- 36 项相关测试通过，语法、Compose 静态及 diff 检查通过。需要重新登录后导出的完整 Session 作为新的认证输入，再进行有限验收；不在聊天或日志中粘贴 token。
- 已停止并移除诊断容器，保留浏览器状态卷；生产环境未修改，未付款。

持久化预检的建单方式可通过 PERSISTENT_CHECKOUT_MODE=api 或 official_client 显式选择，默认 official_client；两者不会自动互相回退。

## 页面复用与客户端登录同步诊断（最新）

- 真实 Session 校验支持复用当前已加载的同源页面：不再为了校验额外创建标签或导航；校验页面须属于同一上下文和 chatgpt.com，调用后不关闭调用方页面。默认调用方式兼容旧实现。
- 修复可见验证 iframe 刚挂载时高度为零就被判定不支持的时序问题，改为在已有超时内等待标准尺寸；仍只点击一次。
- Linux 本轮一次真实 Session 校验通过，随后套餐操作超时。截图 debug_screenshots/network-check/page-reuse-checkout.png 显示官网 Log in or sign up 弹窗，而非挑战页。这证明仅 Session API 成功不足以认定网页客户端已登录。
- 预检增加客户端登录入口检查，仅切换账号或仍显示登录入口时刷新一次；刷新后仍未登录则 CLIENT_SESSION_NOT_READY，避免错误等待套餐按钮。该修复后的一次实测又在 public 阶段被挑战拦截，未进入客户端同步检查，不能声称同步问题已实测修复。
- 43 项相关回归测试通过。没有新结账会话、没有付款。临时 kc-pay-page-reuse 容器停止移除，保留原 kc-pay-browser-validation 卷；未操作生产环境。

## Linux 同一持久化浏览器的交互与登录结果（最新）

- 独立容器 kc-pay-xvfb-interaction，持久化 Docker 卷 kc-pay-browser-validation，目录 /profiles/normal-browser。完整 Chromium + Xvfb，沿用当前 Clash 出口。
- 根据可见截图正常点击一次复选框后，官网由 403 进入 HTTP 200；关闭浏览器并重启同一目录，官网仍 HTTP 200。证据 scratch/xvfb-interaction-report.json、debug_screenshots/network-check/xvfb-after.png、xvfb-restart.png。
- 此后用已有 Session 的真实 Cookie 校验，确认目标账号登录成功；另一次浏览器重启也通过真实账号校验。这是实际进展，不再是“所有 Linux 交互均失败”。
- 官网建单阶段再次出现验证页，未观察到本次 Checkout API 响应；没有取得新订单。截图 xvfb-checkout-failed.png。
- 增加预检专用、默认关闭的 PERSISTENT_VISIBLE_VERIFICATION=1：仅对标准可见复选框做一次普通指针交互；校验必须观察主文档 200 和非空正常标题，不把瞬时空标题当成功。不修改令牌，不处理图片题，不循环点击。正式支付模式未启用该功能。
- 修复首页标题初始化早于验证页标题造成漏检的问题，及交互后只看标题可能误判的问题。Session 仍必须返回真实用户 JSON，回调执行不等于认证成功。
- 最后一次测试首页可访问，但 /api/auth/session 再次被验证拦截，故未继续建单。不能把单次通过宣传为无人值守稳定性通过。
- 已停止诊断容器；保留上述命名卷中的浏览器状态以便后续诊断，包含账号凭据，应按密钥保护。未将其导出到源码、镜像或生产服务器。

结论：已验证“Linux 上可以通过一次验证、保留状态并真实登录”，但尚未验证完整建单到付款前页面，且重复验证问题仍存在。

## 验证页网络与可见交互诊断（最新）

- 无账号的普通 Chrome 访问中，主要 challenge 脚本 GET/POST 返回 200；一条子域请求报告 ERR_ABORTED，另有 204 和 401 响应。不能仅凭 401 或 ERR_ABORTED 判定代理故障，未发现足以解释整个验证失败的加载错误。
- 截图显示明确的“请验证您是真人”复选框。首次 DOM 定位未找到封装内的控件而超时，没有点击；后续通过浏览器 frame 元素位置正常指针点击一次，未注入验证脚本、修改令牌或使用求解服务。
- 点击后发生验证 POST 和官网重新导航，但主页面再次 HTTP 403，回到复选框。等待 15 秒后仍未通过，停止重复交互。
- 该交互测试为 Windows 无头 Chrome；不能将其声称为 Linux Xvfb 下交互通过或失败的证明。Linux Xvfb 的既有结果仍为首次访问被拦截。
- 截图 debug_screenshots/network-check/public-challenge.png，脱敏网络摘要 scratch/public-network-check.json。未读取 Session、建单或支付。尚无已验证的无人值守完成方案。

## Xvfb + 完整 Chromium + 持久化目录实测（最新）

- 新增 scripts/check-persistent-browser.cjs 和 compose.persistent-preflight.yml；Dockerfile.preflight 增加 xvfb/xauth。浏览器 headless=false，通过容器内部虚拟显示启动，不开放桌面端口。
- 默认 public 阶段不读取 Session，不调用建单。session 阶段才使用真实登录校验；checkout 阶段使用官网客户端并止于付款前表单。后两阶段由于 public 失败尚未实测。
- 在独立 kc-pay-xvfb-check 临时容器安装 Xvfb/xauth 成功，未改现有服务。该测试基于已有 Linux 镜像，不等于新的 Dockerfile 整体构建通过。
- 本地 HTTP 页面测试：完整 Chromium 关闭并重新启动后，持久化 Cookie 和 localStorage 均恢复，1 项集成测试通过（实际 Linux + DISPLAY，未跳过）。
- 同一 Clash 出口下首次官网访问仍为 HTTP 403 / SESSION_HUMAN_VERIFICATION_REQUIRED；允许正常脚本运行并等待 15 秒后仍未通过。没有账号注入、建单或付款。
- 此次证明基础设施无需人工桌面操作可以运行，但不能证明能自动通过上游验证。首次建立有效登录状态的门槛依然存在，不能凭持久化目录为空就宣称解决。

独立镜像可成功构建后，预检命令如下；请使用专用目录/卷，禁止与 AdsPower 或其他任务共用浏览器目录：

```bash
PREFLIGHT_PROXY=http://host.docker.internal:7897 \
docker compose -f compose.persistent-preflight.yml run --build --rm preflight
```

public 阶段通过后才考虑设置 PERSISTENT_CHECK_STAGE=session，再设置 checkout。默认不启用后两阶段；所有阶段均不执行付款。profile 卷包含后续登录状态，应按凭据保护，不提交 Git，也不打入镜像。

## 排除预检干扰及核实实际代理（最新补充）

- 使用普通 Playwright Chrome 新建上下文，无账号 Cookie、无请求拦截、未禁用 Service Worker，访问官网并等待正常脚本运行 15 秒。初始 HTTP 403 / cf-mitigated: challenge，结束时标题仍为“请稍候…”。这次未调用 Session 或 Checkout 接口，未点击验证控件。
- 因此不能将之前的 403 归因于预检脚本的非 GET 请求拦截，也不能将匿名访问被拦截判定为用户 Session 失效。
- 只读查询 Mihomo 实际运行 API（通过现有 named pipe）：运行模式为 global，GLOBAL 选择“🇵🇭【东南亚】菲律宾【3x】”。磁盘配置的 rule 模式不是实际运行状态；AI 分组选择的菲律宾02未参与全局模式路由。未修改模式、节点或订阅。
- 当前自有支付流程继续保留；用户明确不采用第三方代充。上游访问拦截尚未修复，不把新增诊断或测试通过描述为真实支付恢复。

## Linux 实测结果（最新）

- Docker Linux 引擎已恢复。独立 Dockerfile.preflight 构建因 Docker Hub 认证端点解析/连接失败而中断，未生成新镜像。
- 改用本机已有 kc-pay-gpt-local-app:latest（镜像 ID 28f49cafd077），只读挂载当前预检 JS 和 Session，在独立 --rm 容器执行，不修改现有应用容器。不是新 Dockerfile 构建通过的证明。
- Linux Chromium 147.0.7727.15 无头启动成功，容器可连接 host.docker.internal:7897（本机 Docker Desktop 的实际测试结果，不保证普通 Linux 宿主机也能访问 loopback 代理）。
- 浏览器路径：真实 Cookie 注入后，官网首页返回 Cloudflare HTTP 403 / SESSION_HUMAN_VERIFICATION_REQUIRED，未进入 Session fetch 或建单。
- HTTP 路径：通过同一 Clash 代理单次 Checkout 请求返回 HTTP 403 / CHECKOUT_ACCESS_DENIED，没有新建结账订单。
- Linux 下 36 项针对性回归测试全部通过；日志 scratch/linux-server-tests.log。不代表真实建单或付款通过。
- 临时容器自动移除，现有三个应用/数据库容器继续 healthy。未连接生产服务器，没有付款、卡池预留或 CDK 消耗。

结论：已排除 Linux Chromium 启动失败、容器无法连接代理这两类问题；当前出口下 Windows 和 Linux 都被上游拒绝，不能仅靠把项目搬到服务器解决。不要反复建单、自动切换节点试探或把拦截当成登录成功。按用户要求保留自有支付路线；当前网站内部 Checkout 路径尚不满足无人值守验收要求。

## 第二轮修复结果

- 纯 HTTP 建单函数现在接受显式 proxy，使用 ProxyAgent 支持 HTTP/SOCKS；禁止自动重定向和环境代理覆盖，避免带认证请求走错出口。网络错误不输出 Axios 凭据。
- 后台任务新增 BROWSER_PROXY_MODE=environment：直接使用 PROXY，不读取数据库代理池；缺少 PROXY 时停止，不悄悄直连。默认数据库代理行为与 AdsPower 模式保持兼容。
- 无头预检先安装真实 Cookie，访问官网首页，再用同源 fetch 校验真实 Session；首页已被拒绝则立即停止，不重试或处理验证码。
- 实测一：显式使用 Clash 7897 的纯 HTTP Checkout 请求返回 403，无新订单。
- 实测二：无头 Chrome 访问官网首页即返回 Cloudflare 403 / SESSION_HUMAN_VERIFICATION_REQUIRED，未执行同源 Session 请求或建单。
- 36 项针对性测试通过。上述修复不代表已消除上游访问限制；Linux 实测及支付验收仍未完成。

纯 HTTP 单次建单诊断（只创建订单，不执行付款）：

```powershell
$env:PREFLIGHT_TRANSPORT='http'
$env:PREFLIGHT_PROXY='http://127.0.0.1:7897'
node scripts/check-server-checkout.cjs
```

切回浏览器诊断使用 PREFLIGHT_TRANSPORT=browser。两种诊断互不自动回退，失败不会反复建单。

## 已确认的问题

- 历史记录：浏览器内同源 API 请求解决了 Node 网络 IPv6 超时，但上游返回 HTTP 400 unusual activity。补齐业务参数后仍失败，不能认定为 API 已修复。
- 本次 Windows 无头 Chrome + 本机 Clash HTTP 代理测试：在新建上下文中注入有效期内 Session 的真实登录 Cookie 后，/api/auth/session 被 Cloudflare HTTP 403 验证拦截。未进入建单。
- 首轮本机 Docker Linux 引擎未运行；后续已有 Linux 实测，见上方最新结果。

## 已完成调整

- API 失败默认停止，只有显式 CHECKOUT_API_UI_FALLBACK=1 才保留旧版 UI 回退。
- API 错误保留状态码及分类，不把认证失败、访问拒绝、限流和 unusual activity 混为一谈。
- 正式 worker 的 API 预检补上支付表单 readiness 校验。
- 独立预检不调用支付 worker、不连接数据库、不预留卡、不消费 CDK；网络写入只允许新建 Checkout，不允许付款请求。遇到验证停止，不自动处理验证码。
- session.json、日志、scratch 和运行数据排除在镜像构建上下文之外。

## 本机预检

在项目目录运行 PowerShell；只在受保护的本地 session.json 保存完整 Session，切勿提交凭据。

```powershell
$env:PREFLIGHT_CHROMIUM_CHANNEL='chrome'
$env:PREFLIGHT_PROXY='http://127.0.0.1:7897'
node scripts/check-server-checkout.cjs
```

本工具不读取 .env，不接管 AdsPower。必须提供真实登录 Cookie；会验证服务器返回的账号与输入相同。成功只代表创建了新结账订单，不代表表单或支付成功。

## 使用独立镜像的 Linux 容器预检（镜像构建尚未通过）

```bash
docker compose -f compose.preflight.yml build preflight
PREFLIGHT_SESSION_FILE=/secure/session.json \
PREFLIGHT_PROXY=http://host.docker.internal:7897 \
docker compose -f compose.preflight.yml run --rm preflight
```

代理地址只是示例：容器不能访问宿主机仅监听 127.0.0.1 的代理。需让专用代理监听受防火墙保护的 Docker 可达接口，或让 Mihomo 与预检服务位于同一专用 Docker 网络并使用服务名；不要公开代理或控制接口。不导入 Windows 的 .env 或浏览器目录。

## 后续验收与上线门槛

1. Linux 真实登录与单次 API 建单通过；被验证或拒绝时停止，不反复请求。
2. API 付款前预检确认本次会话、卡片字段、应付金额与币种。
3. 单独验收付款结果、结果不明时的核对及重复提交保护。当前不承诺无人值守。
4. 再准备独立应用/MySQL/Mihomo Compose、新子域名及 Nginx 配置，核实生产资源、端口和备份。不要在现有 sub2api 目录直接执行本项目 Compose。

候选运行参数为 BROWSER_RUNTIME_MODE=standalone、BROWSER_POOL=0、HEADFUL=0、CHECKOUT_MODE=api、CHECKOUT_API_UI_FALLBACK=0，清空 external profile 配置。不要使用 start:local（会强制有头 Chrome）；容器使用 node server.js。

当前后台任务默认从数据库代理池选代理。专用服务器代理应显式设置 BROWSER_PROXY_MODE=environment 和 PROXY=http://mihomo:7890（示例，需同一 Docker 网络可达）；只设置 PROXY 不会覆盖数据库代理池。上线前核实实际出口，初期并发保持 1。
