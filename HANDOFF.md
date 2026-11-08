# 项目交接（2026-11-08）

## 先了解当前状态

当前工作是原项目上的增量修改，未重新组织核心源码目录，避免破坏 require 路径、Docker 挂载和部署脚本。
本轮使用本地 Stripe/官网 Checkout 路线；仓库历史中的第三方代充 API 仍保留，但不是本次验收路线。

- `external`：连接已打开的 AdsPower 环境。曾用新 Session 成功登录、PH/PHP Plus 建单、填写卡片及用户确认的真实账单地址，看到零税额后停在付款前。
- `persistent`：Linux Xvfb + 持久化 Chromium，已接入正式 worker。曾成功仅建单，也多次因验证或套餐面板/Checkout 超时失败；不能承诺无人值守稳定运行。
- 没有验收真实扣款；没有部署生产服务器；完整生产镜像从零构建尚未验收。
- 已订阅 Plus（包括 iOS 订阅）的账号可能没有可用的再次购买入口。先确认账号套餐，不能把地区切换失败一律解释为代理问题。

## 本地启动

1. 使用 Node.js 22 LTS（脚本使用 `process.loadEnvFile`），执行 `npm ci`。
2. 从 `.env.example` 创建自己的 `.env`，配置 MySQL 和管理员初始化信息。不要提交真实凭据。
3. 本机启动脚本默认连接 `127.0.0.1:3310`，可通过 `LOCAL_DB_HOST`、`LOCAL_DB_PORT` 修改。
4. 需要新建本地数据库时可执行 `docker compose -f docker-compose.yml up -d mysql`。已有数据库请保留原数据卷，勿重新初始化。
5. 配置 `BROWSER_RUNTIME_MODE=external`、`BROWSER_EXTERNAL_CDP_PROFILE_DIR=<自己的 AdsPower profile 绝对路径>`、`CHECKOUT_MODE=official_client`，在 AdsPower 中打开该环境。
6. 执行 `npm run start:local`，默认后台 `http://127.0.0.1:3000/admin`。`LOCAL_PORT` 可改端口。

管理员账密仅在数据库首次初始化时从环境变量写入，改 `.env` 不覆盖已有数据库密码。
原开发机另有 3100 端口的另一份项目，不要混用其后台、卡池或数据库。
`start:local` 是 Windows 本机入口，强制 headed 模式；persistent 服务器模式请按照 `SERVER_RUNTIME.md` 使用 Xvfb，勿用此入口启动。

## 付款前验证入口

| 命令/配置 | 行为 | 数据库 |
|---|---|---|
| `npm run review:external -- /path/to/session.json` | AdsPower 登录、Plus PH/PHP 建单、填卡及真实地址，停止提交 | 需要本机卡池 |
| `docker compose -f compose.formal-preflight.yml run --rm --build preflight` | Linux 正式 worker，仅到空白支付表单 | 不需要 |
| `node scripts/check-formal-review.cjs` | Linux persistent 正式 worker，填卡后停止；需 DISPLAY、profile、Session 和 DB 环境变量 | 需要 |
| `docker compose -f compose.server.yml up -d --build` | 正式服务，正常激活任务可能提交付款 | 独立 MySQL |

预检参数：`PREFLIGHT_SESSION_FILE`、`PREFLIGHT_COUNTRY`（默认 PH）、`PREFLIGHT_PLAN`（默认 plus）；Linux 另需 `PERSISTENT_PROFILE_DIR` 和 `PREFLIGHT_PROXY`。
Session 应包含有效登录 Cookie，不能只依赖 accessToken。脚本不打印完整 Session，但日志/截图仍可能含邮箱、地址等私人信息。

审查入口强制 `PAYMENT_REVIEW_ONLY=1`，清空 CDK，不自动解除提交保护。
看到 `PAYMENT_REVIEW_READY` 才表示已填写成功。external 模式保留页面；persistent 模式正常关闭浏览器。
用户若明确要手动付款，需单独解除该页的审查保护；可在持有原 page/CDP 会话的进程中调用 `releasePaymentReviewGuard(page)`。
不应简单把审查环境变量改成 0 后重跑，那会进入实际付款路线。跨进程交接需要重新定位当前页面并谨慎处理保护，不要依赖未提交的 scratch 脚本。

## 代码导航

| 文件 | 职责 |
|---|---|
| `server.js` / `public/` | HTTP、管理后台、任务调度 |
| `index.js` | 登录→建单→仅建单退出/填卡审查/正式支付 |
| `browser-runtime.js` | standalone、pool、external、persistent 调度 |
| `browser-external.js` / `browser-persistent.js` | AdsPower CDP / 持久化 Chromium 与目录锁 |
| `session-auth.js` / `server-session.js` | Cookie 注入、真实账号校验、客户端登录准备 |
| `official-client-checkout.js` | 官网选择套餐地区，只接受本次新 Checkout 响应 |
| `chatgpt.js` / `checkout-api-policy.js` | API 路径及显式回退策略 |
| `checkout-preflight.js` | 核对会话、币种、支付表单 |
| `payment-retry.js` | 卡池预留与释放、填写协调、正式支付记录 |
| `stripe-payment.js` / `checkout-billing-frame.js` | 卡片与账单字段填写、税额验证 |
| `payment-review-guard.js` | 审查时阻止提交，允许税额报价刷新 |
| `tax-free-address.js` / `mysql-store.js` | 地址池、数据库和资产管理 |
| `scripts/` / `test/` | 可复用入口与测试 |

## 必须接手的限制

- persistent 同一 profile 不得并行使用；异常退出可能留下 `.task-lock`，确认旧浏览器停止后才可解除，不能自动抢锁。
- 原项目正式付款路线仍存在随机地址/姓名回退。审查模式已禁随机地址，姓名可选则留空、网页必填则停止；正式付款路线应另行审计后启用。
- 账单地址必须真实且有权使用，税额由官网决定；PH/PHP 是套餐地区与币种，不等于账单地址国家。
- 官方页面结构、文案和风控会变化，403、登录成功但 UI 未登录、地区控件变化等仍需诊断；不得以历史链接代替新建单成功。
- Session、数据库备份、卡片、代理订阅、浏览器 profile 必须通过私密渠道单独移交，Git 不包含这些运行资产。
- `scratch/` 是未跟踪实验材料，不是交付依赖。`SERVER_CHECKOUT.md` 中指向 scratch/截图的证据仅在原开发机存在。
- 原有 `docker-compose.override.yml` 会被默认 compose 自动加载；使用本次独立配置时始终显式传 `-f`。

## 测试

```sh
npm test
npm run test:node
```

Vitest 负责 `*.test.js`；Node runner 负责 `test/*.node-test.cjs`，两者不能混跑。
部分 Node 测试使用本机 Chrome（Playwright channel=chrome），需安装 Chrome；持久化浏览器实测只在 Linux + DISPLAY 下运行，其他平台会跳过。
这些回归不代表线上风控或真实付款已验证。`npm run test:all` 可运行两套测试，不会执行线上结账脚本。

交接检查结果：2026-11-08 执行 `npm ci --include=dev --ignore-scripts` 和 `npm run test:all`。
Vitest 7 项通过；Node 80 项通过、1 项 Linux DISPLAY 专用测试在 Windows 跳过，无失败。
安装时 npm 报告 34 项依赖漏洞（5 low、4 moderate、24 high、1 critical）；本轮未执行可能破坏兼容性的自动升级，接手后应单独审计和升级依赖。
