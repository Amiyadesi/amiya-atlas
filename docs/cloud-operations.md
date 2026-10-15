# Relakeep 官网与登录配置

所有凭据放在未跟踪的 `_private/cloud/server.env`，部署到香港服务器 `/opt/relakeep/server.env`，文件权限为 600。不要贴到聊天、提交 Git 或写入官网构建文件。

## 域名

Cloudflare Pages 项目为 `relakeep`，备用域名为 `relakeep.pages.dev`。在 `sayori.org` 的 DNS 添加 `atlas` 的 CNAME，目标 `relakeep.pages.dev`，再等待 Pages 的自定义域名和证书状态变为 Active。

正式登录统一使用 `https://atlas.sayori.org`。`PUBLIC_ORIGIN`、平台回调与官网访问域名必须一致；备用 Pages 地址用于查看站点，不作为另一套登录回调。

## GitHub

在 GitHub 的 Settings → Developer settings → OAuth Apps 创建应用：

| 设置                                      | 值                                                  |
| ----------------------------------------- | --------------------------------------------------- |
| Application name                          | Relakeep 络笺                                       |
| Homepage URL                              | `https://atlas.sayori.org`                          |
| Authorization callback URL / Redirect URI | `https://atlas.sayori.org/api/auth/callback/github` |

保持 wildcard 与 GitHub Device Flow 关闭。桌面设备授权由 Better Auth 处理。应用只请求 `read:user` 和 `user:email`。

将 Client ID 与 Client Secret 保存为 `GITHUB_CLIENT_ID`、`GITHUB_CLIENT_SECRET`。两项必须同时配置，否则服务拒绝启动。

## Google

在 Google Cloud 新建独立 Relakeep 项目，不改其他网站的 OAuth 客户端。配置 Google Auth Platform 的品牌信息，使用官网首页、`/privacy` 隐私页、支持邮箱 `me@sayori.org` 和授权域 `sayori.org`。

受众使用 External。仅配置 `openid`、`email`、`profile`。先添加测试用户完成联调，再按控制台的要求发布；若控制台要求域名或品牌验证，应完成后再公开入口。

创建 Web application 类型客户端：

| 设置                          | 值                                                  |
| ----------------------------- | --------------------------------------------------- |
| Authorized JavaScript origins | `https://atlas.sayori.org`                          |
| Authorized redirect URIs      | `https://atlas.sayori.org/api/auth/callback/google` |

下载客户端 JSON 并保存在 `_private`，将客户端 ID / Secret 保存为 `GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET`。应用使用在线登录，不请求离线权限，也不合并之前授予的额外 Google scopes。

## 邮箱验证码

在 Resend 验证 `atlas.sayori.org`，按控制台实际记录配置 DKIM 与发送域 DNS；不要猜记录值。创建限制到该发件域的发送凭据，保存为 `RESEND_API_KEY`。发件人为 `络笺 Relakeep <no-reply@atlas.sayori.org>`。

实际发送一次验证码，检查收件箱与垃圾邮件。验证码 10 分钟有效，服务端保存哈希；日志不得记录验证码或收件地址。

## 部署与验收

1. `npm run check --workspace @relakeep/server`。
2. `npm test --workspace @relakeep/server`。本地测试验证回调、权限、验证码与设备授权契约；它不能代替平台真实登录。
3. 把私有 `server.env` 复制到香港服务器，用已审核镜像重建容器。单纯 `docker restart` 不会重新加载 env-file。
4. 检查 `/api/features` 中 email、github、google 的值。`true` 表示完整凭据已加载，还需逐一实际登录验证。
5. 分别测试三种登录、退出、显式关联与解除关联，再测试桌面设备授权和余额读取。

香港使用现代 Docker socket `/run/docker-modern.sock`。后端只监听 `127.0.0.1:4190`，Pages Worker 代理同域 `/api/*`。新环境联调时收费和云模型开关保持 `false`；当前正式环境的状态见下文。

每次部署使用独立版本 tag，`scripts/ops/deploy-cloud.sh` 会记录上一个镜像。回滚用 `scripts/ops/rollback-cloud.sh`，不会自动回滚数据库或凭据。

## 云数据库备份与恢复

每天由 `relakeep-backup.timer` 加密备份数据库和已解析的服务配置，传到 Sayori 的 `/opt/relakeep-backups/cloud`，保留 30 天。Sayori 的接收 key 只允许备份存储、校验与清理。age 私钥只在本机保存，丢失私钥将无法解密。

在仓库根目录验证实际备份：

```powershell
npm run build --workspace @relakeep/server
node scripts/ops/verify-cloud-backup.mjs relakeep-cloud-YYYYMMDDTHHMMSSZ.tar.gz.age
```

脚本在 `_private/cloud` 新建独立恢复目录，验证 age 解密、备份成员、SQLite 完整性，并用恢复副本启动后端。它不会覆盖生产数据库。

生产恢复先停止 Relakeep 容器，保留当前数据库与 env 的加密快照，再把已验证副本替换到 `/opt/relakeep/data/relakeep.sqlite`，移走旧 WAL/SHM，恢复 `server.env.json` 中的配置并设置数据库属主 1000:1000。确认本次镜像兼容，重建容器并逐一检查登录、余额及 webhook。恢复过程中禁止同时运行两个写入同一数据库的容器。

## Home CPA 云模型连接

应用户要求，官网云 AI 复用 home 的 CPA。`QWEN_API_KEY`、`QWEN_BASE_URL`、`QWEN_MODEL` 沿用现有配置名称，实际用于 OpenAI 兼容接口。`CLOUD_MODELS` 是 JSON 数组，每项含公开 `id`、`name` 和仅后端可见的 `upstream`。第一项为默认模型；不配置数组时沿用 `QWEN_MODEL`。

当前配置 DeepSeek V4 Flash、DeepSeek V4.1 Flash、GPT-6 Luna。前两项指向 `relakeep-llmpm/relakeep-deepseek-v4-flash`、`relakeep-llmpm/relakeep-deepseek-v4.1-flash`，GPT 指向 `gpt-6-luna`。官网账户页保存模型选择，已有软件下次云请求直接使用，无需重新安装。有效已付款月周期可选模型；加量包单独使用默认模型。订阅失效后可在账户页切回默认模型，继续使用加量包。

价格保持月订阅 ¥20 / HK$23.50 / US$2.99，每个已付款周期 300 次；加量包同价 300 次。各模型成功调用均扣一次，失败释放额度。没有注册赠送额度。

内部管理员权限保存于 `cloud_preferences`：`unlimited=1` 允许不消耗购买额度，`internal_usd_cents` 仅为产品内部余额显示。当前仅授予已验证的 `me@sayori.org`，内部余额 US$999,999,999。它不创建 Stripe 资金或付款记录。外部账户接口只能更改 `model`，不能修改管理员权限。

三个新提供的 Codex Free 账户已导入 home CPA，并已实际通过 GPT-6 Luna 查询。AgentRouter 的替换密钥调用 `https://agentrouter.org/v1/models` 仍返回 HTTP 401 `unauthorized client detected`，配置仅保存到 home 私有目录，没有加入生产模型池。

连接路径：Relakeep 容器 → `172.17.0.1:28082` → 香港本机 `127.0.0.1:28081` → 现有 SSH 反向隧道 → home CPA。容器内配置 `QWEN_BASE_URL=http://172.17.0.1:28082/v1`，密钥只保存到本机私有配置和香港 `server.env`。入口只绑定 Docker 网桥，CPA 仍校验 Bearer Key。

home 的 `cliproxyapi.service` 和 `cpa-reverse-tunnel.service` 已启用，用户 `amiya` 已开启 linger。隧道配置 `Restart=always`、30 秒保活、连续 3 次无响应后重连；复用该隧道，不新增公网 API。香港通过系统自带的 `systemd-socket-proxyd` 转发容器请求：

```sh
cp scripts/ops/relakeep-cpa.socket scripts/ops/relakeep-cpa.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now relakeep-cpa.socket
```

socket 使用 `FreeBind=true`，允许开机时早于 Docker 网桥绑定端口，不让 socket 启动依赖 Docker 而形成顺序环。更换 CPA 客户端密钥后需同步私有 env 并重建 Relakeep 容器；重启不会重新读取 env-file。模型供应商不可用时保留失败返还额度行为。

切换前 env 备份为 `/opt/relakeep/server.env.before-home-cpa-20261014`；源码与镜像保留 `0.4.1` 和 `0.4.1-cpa1`。回退时先恢复原 env，再执行 `scripts/ops/rollback-cloud.sh`。原阿里云配置仍存在服务未开通问题，恢复该配置不会使其自动可用。

## 当前状态（2026-10-15）

- 后端、Pages 网站与同域 API 代理已部署。
- GitHub 与 Google 凭据已在香港后端加载，Google 独立项目 `relakeep` 已发布为正式版。正式域名的 `/api/features` 已返回 `github: true`、`google: true`。
- `atlas.sayori.org` 已配置 CNAME 到 `relakeep.pages.dev`，HTTPS 与同域 API 已可用。Resend 发信域已验证，专用凭据仅允许该域发信；邮箱验证码入口已开放，直接邮箱注册限制常见域名。
- 按用户要求，配置完成后停止额外联调与重复检查。
- Stripe 正式受限密钥已接入，创建两项产品、六项价格、Customer Portal 与签名 webhook。密钥、价格 ID 和签名 secret 保存到本机私有配置及香港后端。正式套餐与云 AI 开关已按用户指示开启；实际付款由用户完成。
- 云模型接入 home CPA。DeepSeek V4 Flash 的整理提取对象、付款关联和到期月份已通过既有 Proposal 校验；本轮三种候选模型均通过实际智能查询。新 Codex 账户按用户授权导入；原阿里云凭据保留在私有备份，不再用于生产。
- 香港后端新增账户模型选择与内部管理员额度，沿用 `0.4.1` 客户端与 AI 数据契约。三种模型实际查询均正确返回日本地区 JP。公开 `/api/features` 的 billing/cloud/email/github/google 继续开放；本轮没有重跑 OAuth 或真实付款。
- Windows `0.4.1` 已升级安装，原 Vault 保留；首次主密码解锁默认勾选“记住这台电脑”，后续自动打开。默认不自动锁定，可选择闲置时间；`Ctrl + Shift + L` 手动锁定或设备解锁。
- 公开模板 `Amiyadesi/relakeep-vault-template` 已发布。用户从模板创建 Private 仓库，clone 后用脚本上传加密备份；这不是自动同步。

官方配置参考：[GitHub OAuth](https://www.better-auth.com/docs/authentication/github)、[Google OAuth](https://www.better-auth.com/docs/authentication/google)。
