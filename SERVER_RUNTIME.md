# 服务器持久化浏览器运行方式

## 当前范围

正式 `server.js` 调度器与 `index.js` worker 已支持 `BROWSER_RUNTIME_MODE=persistent`。
Chromium 在 Linux Xvfb 中运行，登录、正常页面验证和官网建单共用同一个页面；不需要 AdsPower。
此模式必须显式选择 `CHECKOUT_MODE=official_client`，不自动回退到其他建单路线。

同一个 profile 同时只允许一个 worker。跨进程 `.task-lock` 防止多个任务切换同一登录状态；
浏览器正常关闭才释放锁。发生强制杀进程或主机断电后，必须先确认该目录没有活跃 Chromium，
再移除该目录下的空 `.task-lock`。不自动抢占未知持有者的锁。
浏览器目录包含登录凭据，应只给服务账号访问；不要放入 Git 或公开下载目录。

## 先运行正式 worker 的仅建单检查

准备当前有效的 `session.json`，设置容器可访问的 `PREFLIGHT_PROXY`，运行：

```sh
docker compose -f compose.formal-preflight.yml run --rm --build preflight
```

该配置独立于本地 compose override，不启动 Web 服务或数据库。
`scripts/check-formal-checkout.cjs` 强制清空 CDK、启用 `PAYMENT_PREFLIGHT_ONLY=1`，调用真实 `index.js`。
通过真实账号校验后新建 Checkout、检查币种与空白卡片表单，输出 `CHECKOUT_PREFLIGHT_READY` 即结束；
不会调用银行卡分配、填写或付款代码。环境变量默认地区 PH、套餐 Plus，可以通过
`PREFLIGHT_COUNTRY`、`PREFLIGHT_PLAN` 指定；输入文件通过 `PREFLIGHT_SESSION_FILE` 指定。

新 compose 默认创建独立空 profile，不自动使用本机实验的 `kc-pay-browser-validation` 卷。
已有 profile 上的成功不等于新服务器首次启动也必然通过验证。遇到未通过的人机验证会报错退出，
不会承诺消除 403，也不会循环建单直到成功。

## 独立部署配置（尚未在生产服务器执行）

`compose.server.yml` 提供独立 MySQL、网络、浏览器状态卷和应用数据卷。
需要设置 `DB_PASSWORD`、`ADMIN_PASSWORD`、`PROXY`，可用单独私有环境文件加载：

```sh
docker compose --env-file server.env -f compose.server.yml config --quiet
docker compose --env-file server.env -f compose.server.yml up -d --build
```

这是正式服务启动命令，正常激活任务会继续进入现有支付流程；不要将它当成仅建单检查命令。
应先在目标服务器通过上面的独立预检，再决定启用正式激活服务。
Web 默认只监听 `127.0.0.1:3108`，通过服务器现有 Nginx 新增独立域名转发；MySQL 不暴露宿主机端口。
没有复用或修改 sub2api 的数据库、目录、端口。新服务预留约 4 GB 内存上限，部署前检查宿主机余量。

`PROXY` 必须是容器可达的服务器代理地址；Windows 的 `127.0.0.1:7897` 不能直接用于远程服务器。
需要在服务器部署自己的 Mihomo 并导入订阅，或提供已有可达代理；本次未部署代理或修改订阅。

正式服务建议串行提交任务。并发占用同一 profile 会明确失败，不能共享该目录运行另一个预检容器。
本次仅测试 worker 建单边界，未进行实际付款，也未验收生产服务器网络或从零构建完整支付镜像。
