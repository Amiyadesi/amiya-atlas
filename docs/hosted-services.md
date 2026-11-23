# 音乐站与络笺使用说明

更新：2026-10-16。络笺网页为 0.9.3，音乐已迁到 Home。

| 入口 | 用途 | 登录 |
| --- | --- | --- |
| https://music.sayori.org/music/ | 音乐搜索、播放、下载、歌单 | 站内登录页，使用原用户名和密码 |
| https://amiya-atlas.sayori.org | 络笺个人网页与同步服务 | 个人站账户或已配置的通行密钥 |
| https://atlas.sayori.org | 官网、套餐与云 AI 账户 | 原有官网账户 |

初始登录信息在本机 `_private/hosting-20261015/登录信息.md`，不提交 Git。部署没有读取或上传电脑原有的记忆库。

## 开始使用络笺

1. 打开个人站并登录。在空库页面创建记忆库，或导入电脑软件导出的加密备份，输入原库主密码。导入后页面立即更新。
2. 到「设置 → 官网账户」打开授权页，登录官网并确认。返回后选择云模型、查看余额；云请求使用官网已购额度。
3. 到「设置 → 服务器登录」关联同一官网账户。
4. 电脑或 Android 安装 0.9.2，登录相同官网账户，在同步设置选择发现的个人服务器，确认连接并开启自动同步。
5. 首次遇到不同记忆库时，核对后选择采用哪一份库；导入远端库需要原库主密码，替换前保留加密备份。

不关联官网也能同步：在个人站「设置 → 服务器登录 → 同步密钥」生成密钥，在客户端「设置 → 同步 → 自建服务器」填写 `https://amiya-atlas.sayori.org`，选择使用密钥。密钥只显示一次，可为每台设备分别生成和撤销。也保留浏览器设备授权方式。

客户端打开期间每 30 秒检查同步，回到前台或恢复网络也会触发。Android 被系统暂停后不保证后台运行。同一条目发生冲突时，按提示选择保留本机或远端。

「服务器登录」还可添加通行密钥、开启两步验证和管理会话。启用两步验证后保存恢复码；登录环境记录默认关闭。

「关系图 → 关系」显示全库三维节点。拖动旋转、滚轮缩放，点「全屏」展开；点击球体与搜索补全选中资产使用相同的聚焦方式，邻居展开、无关节点移到外围，同时打开侧栏。点「查看详情」可编辑、收藏。球体大小随关联数变化，标签支持星星等图案。「记忆 → 从字段补全关联」可预览已有字段对应的关系。

「账本 → 记一笔」填写金额即可保存，账户可留空，账户与分类均可手填新名称。「项目 → 经营项目」勾选后才进入损益统计。「投资」自动获取支持的币种价格和汇率，显示来源与更新时间。

完整安装、备份和财务教程见 [relakeep-0.9.md](relakeep-0.9.md)。Windows 与 Linux 网页包已更新为 0.9.3，Android APK 和 Debian 桌面包目前仍为 0.9.2，可通过个人站使用新交互。旧 0.4 客户端不能保留新财务记录。

## 开始使用音乐站

1. 打开音乐站，在页面内登录。登录会话有效期为 7 天；更改网址参数、搜索、切换设置页均不再弹出浏览器密码框。
2. 搜索歌曲或歌手，选择来源并播放或下载；也可粘贴平台歌曲、歌单链接。
3. 需要平台 Cookie 时打开右上角「设置」配置，沿用当前登录会话。
4. 「浏览器下载」保存到自己的设备；选择保存到服务器时，文件保存在 Home 的持久目录。

上游为 https://github.com/guohuiyuan/go-music-dl ，使用官方镜像，未修改其代码。来源能否解析取决于音乐平台与所需登录状态。

## 服务器位置

| 主机 | 服务 | 本机端口 | 持久目录 | 内存上限 |
| --- | --- | --- | --- | --- |
| Home | `music-dl` | `127.0.0.1:18082` | `/home/amiya/services/music-dl/data` | 384 MiB |
| 香港 | `relakeep-selfhost` | `127.0.0.1:5011` | `/opt/relakeep-selfhost/data` | 384 MiB |
| 香港 | 商业后台 `relakeep` | `127.0.0.1:4190` | `/opt/relakeep/data` | 512 MiB |

音乐域名保持不变：香港 nginx → `127.0.0.1:28083` → Home `18082`。Home 的用户服务 `music-reverse-tunnel.service` 建立直连转发并自动重连。音乐存储和程序运行在 Home，媒体流量仍经过香港 HTTPS 入口，不经过 Sayori。此迁移释放香港存储和运行资源，不减少香港转发流量。

Home 当前根分区可用约 62 GiB，未调整磁盘分区。香港两个新域名仍为直连 A 记录，未经过 Cloudflare 媒体代理。原商业后台每日加密备份到 Sayori 的任务保持原状。

## 日常维护

从电脑连接时显式跳过默认跳板：

```powershell
ssh -o ProxyJump=none home
ssh -o ProxyJump=none company-server-01
```

Home 上：

```sh
docker ps --filter name=music-dl
docker restart music-dl
systemctl --user status music-reverse-tunnel.service
systemctl --user restart music-reverse-tunnel.service
df -h /
```

香港上：

```sh
d() { /opt/docker-27.5.1/docker -H unix:///run/docker-modern.sock "$@"; }
d ps
d restart relakeep-selfhost
nginx -t
```

HTTP 上游只监听环回地址。容器有自动重启、内存上限与日志限制。Home 用户已开启 linger，转发服务可在注销后运行。

香港 nginx 配置在 `/etc/nginx/conf.d/music.sayori.org.conf` 和 `/etc/nginx/conf.d/relakeep-personal.conf`，仓库副本在 `deploy/hk/`。证书目录 `/etc/nginx/ssl/relakeep-personal/`、HTTP 验证目录 `/var/lib/relakeep-acme` 和现有续期任务需要保留。

## 备份、升级与回滚

络笺日常从「设置」导出加密备份。迁移个人站时还应加密保存 `/opt/relakeep-selfhost/data` 与 `/opt/relakeep-selfhost/server.env`，保留登录、通行密钥、两步验证、身份密钥及同步副本。升级不要更改数据挂载、`BETTER_AUTH_SECRET` 或原 Compose 项目名，不要执行 `compose down -v`。

当前络笺镜像是 `relakeep:selfhost-0.9.3` 和 `relakeep:connected-0.9.3`。升级前个人站备份在 `/opt/relakeep-selfhost/before-0.9.3.tar.gz.age`；旧容器 `relakeep-selfhost-before-0.9.3`、`relakeep-before-connected-0.9.3` 保留停机。本轮保留的旧容器为 0.9.2。回滚前先停止当前服务并备份新增数据，再切回旧容器；回滚会撤回这次记账、行情及点击聚焦的修改。

音乐备份 Home 的 `/home/amiya/services/music-dl/data`，复制数据库目录前先停止 `music-dl`。镜像源固定为 `guohuiyuan/go-music-dl@sha256:d1730e3c0ea66e51feb8c0b50d3afd43b45c84db3d1d09ebef24406acdd1915c`；Home 加载后的本地标签为 `relakeep-music:home-20261016`。音乐与个人站尚未新增自动异地备份。

音乐迁移前的数据保存在香港 `/opt/music-dl/before-home-20261015.tgz`，旧容器 `music-dl` 已停止并禁用自动重启。旧入口配置保存在 `/etc/nginx/conf.d/music.sayori.org.conf.before-home-20261016`。需要迁回香港时，先停止 Home 容器并把最新 `data` 复制回香港，再启动香港旧容器、恢复其自动重启，恢复旧 nginx 配置并通过 `nginx -t` 后重载；只恢复旧快照会失去迁移后的更改。

已验证 Home 容器健康、直连转发、HTTPS 登录和带 Cookie 的首页、查询参数、设置页访问。未做批量音乐下载、真实记忆库导入或手机真机验收。
