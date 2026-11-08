# KC GPT 自动充值系统

接手当前分支请先读 **[交接说明](HANDOFF.md)**：包含启动方式、模块索引、付款前审查入口、已验证范围与未解决问题。服务器模式见 [SERVER_RUNTIME.md](SERVER_RUNTIME.md)，历史实验见 [SERVER_CHECKOUT.md](SERVER_CHECKOUT.md)。

> **KC ChatGPT PLUS 訂閱開通平台**  
> 使用者貼上 Session 與兌換 CDK 後，可使用本地 Stripe 自動化流程，或啟用第三方代充 API 建立並輪詢代充訂單。  
> 配套管理後台：卡池管理、CDK 管理、任務監控、帳單稽核、第三方代充積分與套餐狀態、並發控制。

| 开发者 | TG | 
|--------|-----|
| **KC** | KcCatk |

[License: MIT](LICENSE) · Node.js 20+ · MySQL 8 · Playwright · Docker · [GitHub](https://github.com/KC-CatK/KC-PAY-GPT)

> ## 加入 Telegram 社群
> **[點此加入 AI科研組 Telegram 群組](https://t.me/+xPBORDjtky9mM2Mx)**

---

## 这是什么

`KC-GPT-PAY`（KC GPT 自动充值系统）是一套 **Node.js + Playwright + MySQL** 服务端方案，包含：

- **用户前台**（`/public/index.html`）：卡密兑换、Session 提交、订阅自动开通、状态查询
- **管理后台**（`/admin`）：卡池 / CDK / 任务 / 账单 / 系统配置 / 运行日志
- **本地自動化引擎**：Stripe Checkout 填表、信用卡輪換、hCaptcha 求解、反指紋瀏覽器與失敗重試
- **第三方代充 API**：支援套餐／積分查詢、Session 預檢、代充建單、訂單輪詢，以及失敗訂單的供應商卡密前綴顯示

啟用第三方代充 API 後，前台兌換會完全改走供應商代充流程，不再使用本地開通。

> ⚠️ **仅供学习与研究**。使用前请确保符合目标平台 ToS 与所在地法律法规。**开发者不对任何滥用导致的封号、扣款、法律纠纷负责。**

---

## 系统要求

| 组件 | 要求 |
|------|------|
| **Node.js** | ≥ 20.x |
| **MySQL** | ≥ 8.0 |
| **記憶體** | ≥ 2 GB（本地瀏覽器自動化建議 4 GB+） |
| **磁盘** | ≥ 5 GB（含 Chromium + Python hCaptcha 依赖） |
| **操作系统** | Linux / macOS / Windows |

Linux 无图形界面跑 headless 时，需安装 Playwright 系统依赖（见下方各平台说明）。

---

## 部署教程

### 方式一：Docker 一键部署（推荐）

适合 Linux 云服务器、macOS、Windows（Docker Desktop），**自带 MySQL 8**，无需单独装数据库。

#### 1. 安装 Docker

```bash
# Ubuntu / Debian（一键脚本）
curl -fsSL https://get.docker.com | sh
sudo systemctl enable docker && sudo systemctl start docker

# macOS / Windows — 安装 Docker Desktop
# https://www.docker.com/products/docker-desktop/
```

#### 2. 拉取代码并配置

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
cp .env.example .env
```

编辑 `.env`，至少填写：

```env
DB_PASSWORD=your_strong_mysql_password   # MySQL root 密码
ADMIN_PASSWORD=your_admin_password         # 后台登录密码
PROXY=http://user:pass@proxy-host:port     # 本地自動化或第三方訂單代理（選填）
BROWSER_POOL=0                              # 預設關閉瀏覽器池
```

#### 3. 一键启动

```bash
docker compose up -d
```

首次构建镜像需数分钟（含 Playwright Chromium + hCaptcha Python 依赖）。启动成功后：

| 地址 | 说明 |
|------|------|
| `http://服务器IP:3000/` | 用户前台（卡密兑换） |
| `http://服务器IP:3000/admin-login` | 后台登录（默认路径可在后台修改） |

#### 4. Docker 常用命令

```bash
# 查看应用日志
docker compose logs -f app

# 重启应用
docker compose restart app

# 停止并移除容器（数据卷保留，MySQL 数据不丢）
docker compose down

# 更新代码后重新构建
docker compose up -d --build

# 进入容器调试
docker compose exec app bash
```

> **注意**：请勿使用 `docker compose down -v`，否则会删除 MySQL 数据卷。配置写入 MySQL 后，重启容器不会丢失。

---

## 第三方代充 API

在後台「系統配置 → 第三方代充 API」填寫 API Key 後啟用。預設 Base URL 為：

```text
https://kc.vpss.eu.cc/
```

啟用後，系統會：

1. 使用供應商 `/plans` 取得 GPT 與積分套餐資訊。
2. 以 `/balance` 顯示可用積分與 USD 餘額。
3. 以 `/pay/inspect` 檢查 Session 格式與 JWT 有效期，再以 `/pay` 建立代充訂單。
4. 輪詢供應商訂單結果；後台僅顯示失敗代充訂單及上游公開的 `topup_code` 前綴，不會保存或展示完整卡密。

API Key 至少需要 `plans:read`、`balance:read`、`pay:write` Scope；如需使用任務查詢，另需 `tasks:read`。完整供應商協議見 [對接 API 文件](对接api.md)。

> 瀏覽器池預設關閉（`BROWSER_POOL=0`）。第三方代充模式不使用本地瀏覽器開通流程。

---

### 方式二：多端裸机部署

适合不想用 Docker、或需要在本地调试的场景。

#### Windows 本机 Chrome + 现有 Docker MySQL

本机已安装 Chrome、Node.js 20.12+，并使用本仓库 Compose MySQL（映射到本机 3310）时：

```powershell
npm ci --omit=dev --ignore-scripts
npx playwright install ffmpeg
docker compose up -d mysql
docker compose stop app
npm run start:local
```

打开 `http://localhost:3000/admin-login`。此启动方式读取 `.env` 中的数据库及后台凭据，默认使用本机有头 Chrome、独立任务浏览器，不为浏览器任务配置代理；配置 external 模式时改为连接现有 AdsPower 环境，也不修改数据库中的代理配置。数据库仍保留在 Docker 数据卷中。若仍遇到真人验证，需要人工完成验证。

任务默认开启录屏，即使使用已安装的 Chrome，也需要执行上面的 `npx playwright install ffmpeg` 安装 Playwright 配套 FFmpeg；缺失时会在创建页面时报 `Executable doesn't exist ... ffmpeg-win64.exe`。

可通过 `LOCAL_PORT`、`LOCAL_DB_HOST`、`LOCAL_DB_PORT` 调整本机服务和数据库地址；默认分别为 `3000`、`127.0.0.1`、`3310`。设置 `LOCAL_CHROMIUM_CHANNEL=msedge` 可改用已安装的 Edge。恢复 Docker 应用时，先停止本机 Node 服务释放 3000 端口，再执行 `docker compose start app`。

支付链接调试可接入手动打开的 AdsPower 环境：在 `.env` 设置 `CHECKOUT_DEBUG_CDP_PROFILE_DIR` 为该环境的浏览器数据目录（包含 `DevToolsActivePort`），重启本机服务。每次调试会重新读取端口，使用现有环境的代理、Cookie 和浏览器配置；提交包含有效 sessionToken（也支持 cookies[] / cookieHeader 登录 Cookie）的 Session JSON 后，任务会自动切换账号并验证真实登录状态；仅有 accessToken 时要求浏览器已经登录同一账号。切换失败会恢复原登录。任务不注入项目的 Session 模拟脚本或指纹脚本，不创建新浏览器上下文、不关闭现有环境。此模式不录屏，保留失败截图，同一环境的调试串行执行；环境未打开时直接报错，不回退到 Chrome。单独设置 CHECKOUT_DEBUG_CDP_PROFILE_DIR 时仅对支付链接调试生效；正式任务接入见下方官网客户端建单配置。默认 API 模式下，AdsPower 支付链接调试与自动支付流程共用 Checkout API 建单代码；只有本次调用实际返回新结账链接才会报告成功，失败时保留上游错误，不读取已有页面链接作为成功结果。

#### macOS / Linux 一键安装

```bash
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
chmod +x scripts/install.sh
./scripts/install.sh
```

脚本会自动检测系统（macOS / Ubuntu / Debian / CentOS 等），安装 Node.js 20+、npm 依赖、Playwright Chromium 及 Linux 系统库。

#### Windows 一键安装

以**管理员权限**打开 PowerShell：

```powershell
git clone https://github.com/KC-CatK/KC-PAY-GPT.git KC-GPT-PAY
cd KC-GPT-PAY
powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1
```

#### 手动安装（各平台通用）

**① 安装 Node.js 20+**

```bash
# macOS (Homebrew)
brew install node@20

# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS / RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# Windows — 下载 LTS 安装包
# https://nodejs.org/
```

**② 安装 Playwright 系统依赖（仅 Linux 服务器）**

```bash
# Ubuntu / Debian 推荐
npx playwright install --with-deps chromium

# 或手动安装常见依赖
sudo apt-get install -y wget curl fonts-liberation fonts-noto-cjk \
    libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 libgbm1 \
    libgtk-3-0 libnspr4 libnss3 libx11-xcb1 libxcomposite1 libxdamage1 \
    libxrandr2 libxss1 libasound2 libpangocairo-1.0-0 libxshmfence1
```

macOS / Windows 无需额外系统依赖。

**③ 安装项目依赖**

```bash
npm install --production
npx playwright install chromium
```

**④ 安装并初始化 MySQL 8**

```bash
# Ubuntu
sudo apt-get install -y mysql-server && sudo systemctl start mysql

# macOS
brew install mysql && brew services start mysql

# 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS plus_papay CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
```

**⑤ 配置环境变量**

```bash
cp .env.example .env
# 编辑 .env
```

裸机部署关键项：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=你的MySQL密码
DB_NAME=plus_papay
ADMIN_PASSWORD=你的后台密码
PROXY=http://user:pass@proxy-host:port
HEADFUL=0          # 调试时可设为 1 开启有头浏览器
```

**⑥ 启动服务**

```bash
npm start
# 或调试模式（有头浏览器）
npm run start:headful
```

启动成功示例：

```
🔓 [资产锁] 启动时已重置所有 in_use 标记
数据库表检查完成
http://localhost:3000
MySQL => root@127.0.0.1:3306/plus_papay
```

---

### 方式三：PM2 生产守护（裸机推荐）

```bash
npm install -g pm2
pm2 start server.js --name kc-gpt-pay
pm2 startup          # 配置开机自启
pm2 save
pm2 logs kc-gpt-pay  # 查看日志
pm2 restart kc-gpt-pay
```

---

### 方式四：Nginx 反向代理 + HTTPS

通过域名访问或启用 HTTPS 时，在 Nginx 中反代到 `127.0.0.1:3000`：

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400;
    }
}
```

免费 HTTPS（Let's Encrypt）：

```bash
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## 首次使用

1. 打开后台 → **系统配置**：填写代理、支付地区（默认菲律宾 PHP）、邮箱通道、hCaptcha 等
2. **卡池管理** → 批量导入信用卡（格式：`卡号|有效期|CVC|持卡人姓名`）
3. **免税地址** → 确认当前地区有足够地址模板（默认已预置）
4. **CDK 管理** → 生成 Plus / Pro 5x / Pro 20x 激活码
5. 用户访问前台 → 输入 CDK → 粘贴 Session JSON → 提交，约 3–5 分钟自动开通
6. 在 **任务管理** / **运行日志** 查看进度与结果

---

## 主要功能

| 模块 | 说明 |
|------|------|
| **CDK 兑换** | Plus / Pro 5x / Pro 20x 三档套餐，一卡一充 |
| **信用卡卡池** | 批量导入、智能选卡、冷却机制、Stripe 拒卡自动报废、失败换卡重试 |
| **支付地区** | PH / US / SG / MY 可切换，配套免税地址池 |
| **账单审计** | 自动记录每笔支付，支持筛选与 CSV 导出 |
| **瀏覽器池** | 本地自動化的可選多槽位模式；目前預設關閉（`BROWSER_POOL=0`） |
| **hCaptcha** | VLM / 打码平台 / Python solver 多通道 |
| **反指纹** | Stealth + 30+ 指纹点修正，支持真 Chrome / Edge |
| **Telegram 通知** | 任务成功 / 失败推送（后台配置） |
| **并发 & 维护模式** | 前台并发上限、维护开关，保存即生效 |

---

## 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                     server.js (Express)                      │
│   /api/redeem/*   /api/cdk/*   /api/admin/*   /api/public/* │
└─────────────────────────────────────────────────────────────┘
         │                                    │
         ▼                                    ▼
┌─────────────────────┐            ┌─────────────────────┐
│  product_activator  │            │  public/admin.html  │
│  任务调度 / 重试     │            │  KC GPT 管理后台     │
└─────────────────────┘            └─────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  index.js / stripe-payment.js / session-auth.js / browser-pool │
│  Stripe Checkout 自动化 · Session 鉴权 · 卡池支付 · 重试      │
└─────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│  MySQL — 卡池 / CDK / 任务 / 账单 / 配置 / Session 记录       │
└─────────────────────────────────────────────────────────────┘
```

---

## 目录结构

```
.
├── server.js              # Express 入口、REST API
├── product_activator.js   # 任务调度核心
├── index.js               # Stripe 支付主流程（子进程）
├── stripe-payment.js      # Checkout 表单自动化
├── session-auth.js        # Session 解析与鉴权
├── browser-pool.js        # 浏览器池管理
├── mysql-store.js         # MySQL 全部 CRUD
├── payment-retry.js       # 支付重试与换卡逻辑
├── region-config.js       # 支付地区配置
├── hcaptcha/              # Python hCaptcha solver
├── public/
│   ├── index.html         # 用户前台
│   ├── admin.html         # 管理后台
│   └── admin-login.html   # 后台登录
├── scripts/
│   ├── install.sh         # macOS / Linux 一键安装
│   └── install-windows.ps1
├── docker-compose.yml     # Docker 一键部署
├── Dockerfile
├── mysql-schema.sql
├── .env.example
└── 对接api.md             # 第三方代充 API 對接文件
```

---

## 接口文档

本系統 REST API 請依 `server.js` 路由使用；第三方代充接口見 [對接 API 文件](对接api.md)。常用接口：

| 用途 | Method + Path | 鉴权 |
|------|---------------|------|
| 用户兑换开通 | `POST /api/redeem-product` | 无 |
| 查询 CDK 状态 | `GET /api/cdk/query?cdk=...` | 无 |
| 后台登录 | `POST /api/admin/login` | 密码 |
| 卡池批量导入 | `POST /api/admin/cards/import` | Bearer |
| 外部卡池推送 | `POST /api/external/cards/push` | X-API-Key |
| 账单 CSV 导出 | `GET /api/admin/billing/export` | Bearer |
| 实时运行日志 | `GET /api/admin/runtime-logs` | Bearer |

---

## 常见问题

**Q: Docker 里浏览器崩溃？**  
A: `docker-compose.yml` 已配置 `shm_size: 2gb`。仍崩溃可改为 `4gb`，并确保宿主机内存 ≥ 4 GB。

**Q: Linux 上 Chromium 启动失败？**  
A: 执行 `npx playwright install-deps chromium`，确认 `HEADFUL=0`（无头模式）。

**Q: MySQL 连接被拒绝？**  
A: Docker 模式下 `DB_HOST=mysql`（compose 服务名）；裸机模式下 `DB_HOST=127.0.0.1`。确认 MySQL 服务已启动。

**Q: Stripe 一直 `redirect_status=failed`？**  
A: 多为卡 BIN 被风控、余额不足或代理 IP 不干净。换卡、换代理、确认支付地区设置。

**Q: 卡池枯竭怎么办？**  
A: 后台批量导入，或配置 Webhook `POST /api/external/cards/push` 自动补货。

**Q: 修改哪些文件需要重启？**  
A: `server.js`、`mysql-store.js`、`product_activator.js` 等主进程文件需重启；`index.js`、`stripe-payment.js` 等子进程文件下次任务自动加载。

**Q: Windows 上 Playwright 安装失败？**  
A: 管理员 PowerShell 执行：`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`，再 `npx playwright install chromium`。

---

## 端口说明

| 端口 | 用途 |
|------|------|
| 3000 | Web 服务 + WebSocket（可通过 `PORT` 环境变量修改） |
| 3306 | MySQL（Docker 模式下映射到宿主机） |
| 19222+ | 瀏覽器池 CDP 連接埠（僅啟用 `BROWSER_POOL=1` 時使用） |

---

## 开发者 & 联系方式

| 项目 | 信息 |
|------|------|
| 开发者 | **KC** |
| TG | **KcCatk** |




---

### 官网客户端建单验证

`CHECKOUT_DEBUG_MODE=official_client` 可让支付链接调试通过当前已登录的官网客户端创建新订单，支持 Plus、Pro 5x 和 Pro 20x 月付。选择 Personal 和目标账单地区后点击对应套餐；Pro 必要时先展开 See all plans，再在新结账会话选择 Standard（`pro_5x` → `chatgptprolite`）或 More usage（`pro_20x` → `chatgptpro`），校验本次建单/档位更新请求与所选档位。要求 HTTP 200 和新的结账会话，不读取已有链接作为成功，不重放或生成安全校验令牌，失败不会回退成成功。调试在建单后停止，不执行付款。

正式任务和调试统一使用官网客户端建单时，配置 `CHECKOUT_MODE=official_client`、`BROWSER_RUNTIME_MODE=external`、`BROWSER_EXTERNAL_CDP_PROFILE_DIR=<AdsPower 环境数据目录>`。本机已启用这组配置。浏览器环境必须预先打开。账号不一致或未登录时，正式任务使用本次 Session 中的登录 Cookie 自动切换，并通过真实 /api/auth/session 验证目标账号；支持长 Cookie 分块，失败恢复旧登录。缺少有效登录 Cookie、环境关闭或套餐不支持时直接报错。同一环境内调试和正式任务互斥执行，环境代理保持不变，不使用浏览器池。Plus、Pro 5x 和 Pro 20x 已在 PH/PHP 环境验证至填表完成、官网显示零税额的付款前页面，未验证实际扣款。

`PAYMENT_REVIEW_ONLY=1` 仅用于填表后的人工审查运行：沿用正式建单与卡池预留/释放，填完卡和账单后停止，不提交付款、不写支付账单/使用次数。提交保护仅放行精确的官网税额报价接口 `/backend-api/payments/checkout/taxes`，仍阻止确认付款接口。指定的美国州账单填写完成后需确认官网页面税额为零，否则停止；地址池名称不证明免税资格，必须使用真实适用的账单信息，税额以官网实际结果为准。审查标志不应作为付款成功处理，也不应全局启用。

`CHECKOUT_DEBUG_VERIFY_PAGE=1` 让支付链接调试进一步验证支付表单：必须出现卡号、有效期、CVC 输入框，并读到任务币种的应付金额。`PAYMENT_PREFLIGHT_ONLY=1` 可在正式 worker 中执行同样验证后停止，输出 `CHECKOUT_PREFLIGHT_READY`；不会进入银行卡预留、填卡或提交付款。预检成功不等于付款成功，也不会标记 CDK 激活成功。该标志仅用于手动运行预检，不应加入正常服务配置。

AdsPower 任务遇到可见人机验证时等待人工完成，不调用自动解题；等待期间任务可继续，超时或失败保留当前任务页。当前进程内每个环境只能执行一个任务。正式任务已关闭付款前审查和预检停止开关，会自动提交付款并按实际结果记录账单和卡片使用；拒付换卡次数遵循 `PAYMENT_MAX_CARD_ATTEMPTS`（本机为 3），整单重试遵循 `MAX_PROCESS_ATTEMPTS` 和错误分类（默认 1 次）。支付链接调试及显式运行的审查脚本仍保留各自的停止行为。提交后结果不明仍需人工核对；本次仅验证到表单就绪，未验证实际扣款、订阅生效或跨任务自动恢复。

## 免责声明

本项目所有代码以 **「AS IS」** 形式发布，开发者**不对以下情形负责**：

- 因使用本项目导致的 OpenAI 账号封禁、银行卡风控
- 违反目标平台 ToS 或所在地法律法规所引起的任何后果
- 因使用本项目导致的资金损失、数据泄露、第三方权益受损

**使用即表示你已阅读、理解并接受以上条款。**

---

## 许可

[MIT License](LICENSE) © KC
