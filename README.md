# love-delete-account

《我们的爱情》后端 Worker：账号注销（幂等）+ 情侣等级 / 邮件 / 签到（服务器说了算）。

- 部署：推送到 main 分支后，Cloudflare Git 集成自动部署。
- 密钥（EASEMOB_ORG / EASEMOB_APP / EASEMOB_CLIENT_ID / EASEMOB_CLIENT_SECRET / ADMIN_KEY）只存在 Cloudflare 控制台里，不在代码和仓库里。
- KV 绑定 IDEM_KV / LEVEL_KV 见 wrangler.toml。
- 测试：love-deploy-test 已连 GitHub（main 分支），推一次代码触发首次 Git 部署，验证绑定/密钥是否保留。
- 正式 Worker love-delete-account 已连 GitHub（main 分支），v4 由 Git 自动部署。
