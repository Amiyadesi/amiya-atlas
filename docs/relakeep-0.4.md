# 络笺 0.4.1：多端使用

## 本机与手机

Windows 安装程序直接覆盖升级；原记忆库保留。Android 安装 arm64 APK。Linux 使用 deb 包，或独立 relakeep-web 网页程序。

Debian / Ubuntu 安装：`sudo apt install ./Relakeep_0.4.1_amd64.deb`。Linux 独立网页版解压后进入文件夹，运行 `./relakeep-web`，打开终端给出的网页链接。

## 录入、编辑与登录

首页点「手动记录」，或在「记忆」点「新建记录」，填写名称和类型；可添加字段、关联和提醒，保存即可。不需要模型或云账户。打开记录后点「编辑」修改或删除；「关系图」可选择记录并展开关联。

Windows 首次解锁勾选「记住这台电脑」，下次打开直接进入。默认不因闲置锁定；在「设置 → 自动锁定」可选择时间。`Ctrl + Shift + L` 手动锁定，设备解锁开启后同一快捷键可打开。旧库尚未记住设备时，需要先输入一次原主密码。

桌面「登录官网账户」会打开系统浏览器，在官网登录并批准设备码。云账户用于余额和云 AI，不替换本地记忆库的加密密码。使用云 AI 时在设置选择「官网云服务」；本地模型和自带 API 仍可直接选择。

手机首次启动可以创建记忆库，也可以点击「导入加密备份」。手机数据仍保存在本机；不启动 localhost 服务。

电脑「设置 → 同步 → 浏览器打开」进入 `http://localhost:5011`。访问口令由桌面自动传入；网页与桌面使用同一个本机库。关闭桌面后，本机网页服务停止。独立 `relakeep-web` 启动时给出含本次启动访问口令的网页地址，避免把地址分享给别人。

## 手动迁移

1. 源设备「设置 → 记忆与备份 → 导出加密备份」。
2. 把 JSON 文件传给目标设备。
3. 目标设备「恢复加密备份」，输入源库主密码。恢复会替换目标库，原库另存为密文。

脱敏清单用于查看或分享，不是完整备份。API Key、模型配置、官网会话不会进入自动同步包；完整手动备份包含各设备原有加密设置。

## 用已有网盘自动同步

需要支持 WebDAV 与强 ETag 条件写入的网盘，如自行部署的 Nextcloud。在网盘创建专用文件夹和应用密码。

「设置 → 同步 → 网盘 / WebDAV」填文件夹 URL（结尾 `/`）、用户名、应用密码，勾选自动同步，保存。Nextcloud URL 示例：`https://cloud.example/remote.php/dav/files/用户名/relakeep/`。

其他设备先导入第一台的加密备份，再填写同一 WebDAV 地址；若显示另一份记忆库，点击「导入远端记忆库」，输入远端主密码。密码不发送给网盘。

应用打开、回到前台、恢复网络后会同步；打开期间每 30 秒同步。独立条目变化自动合并，同一条目的并发修改需选择本机或远端。确认时保留两份密文备份。Android 被系统暂停或关闭时不会持续同步。

## 自建服务器

服务器安装 Docker Compose；在源码目录执行：

```sh
node scripts/init-selfhost.mjs selfhost.env https://atlas.example.com
docker compose -f compose.yaml -f compose.https.yaml up -d --build
```

域名指向服务器，开放 80/443。Caddy 自动提供 HTTPS。`selfhost.env` 内的首次设置码 `RELAKEEP_SETUP_TOKEN` 用于创建唯一登录账户；`BETTER_AUTH_SECRET` 应保持不变。两项不要公开或提交 Git。

只有本机使用时可执行：

```sh
node scripts/init-selfhost.mjs selfhost.env http://localhost:5011
docker compose up -d --build
```

网页打开域名，首次填设置码、邮箱、登录密码，再创建或导入记忆库。服务器登录密码与记忆库主密码是两项独立凭据。

电脑/Android：「设置 → 同步 → 自建服务器」填域名或 `https://IP:端口`，点击保存；系统浏览器登录同一服务器，确认设备码。回到应用，授权自动保存。首次远端库不一致时选择导入远端。服务器 HTTPS 证书必须被设备信任；不能关闭证书验证。

输入 IP:端口会按 HTTPS 连接。裸 HTTP 仅支持 localhost；公网密码、会话及网页中解密的数据需 HTTPS。使用 IP 部署时自行配置有效证书；使用域名更容易自动签发证书，也支持通行密钥。

网页提供同一套资产列表、搜索、关系图、录入和导入导出。服务器同步对象只存密文；但网页模式在自建服务器上解密，因此管理员需信任该服务器。仅使用 WebDAV 原生客户端时，网盘不获得解密密钥。

## 登录安全

网页「设置 → 服务器登录」：

- 两步验证：输入登录密码，在验证器中打开密钥，输入验证码确认；保存恢复码。
- 通行密钥：HTTPS 域名下点击添加，按系统指纹/设备 PIN 提示完成。IP 地址不提供通行密钥入口。
- 记录登录环境：默认关闭。开启后保存登录 IP 和浏览器/设备信息；关闭会清除当前会话中已保存的信息。
- 登录会话：可逐项退出，撤销相应设备授权。

此首版自建服务为单用户，不提供公开注册；首次配置完成后关闭注册入口。官网 OAuth 与购买账户保持独立。

## 服务器备份与更新

备份整个 Docker 数据卷，包含加密 Vault、同步副本、登录账户、2FA/通行密钥与会话。备份身份数据时加密归档并限制访问；仅导出资产 JSON 不会备份登录凭据。

升级前保存当前镜像与数据卷备份，执行 `docker compose build && docker compose up -d`。回退使用原镜像与同一数据卷。不要执行 `docker compose down -v`，它会删除记忆库。

## 本地构建

- Windows：`npm ci`，`npm run build:desktop`。
- Linux：安装 Rust、Node、GTK3、WebKitGTK 4.1 等 Tauri 依赖，运行 `sh scripts/build-linux.sh`。
- Android（Windows 构建）：JDK17+、SDK Platform36、Build Tools36.0.0、NDK28.2.13676358；设置 `ANDROID_HOME`、`JAVA_HOME`，运行 `scripts/build-android.ps1`。脚本编译 Rust 后复制 JNI 库，不需要开启 Windows 符号链接权限。正式签名用 `RELAKEEP_ANDROID_KEYSTORE`、`RELAKEEP_ANDROID_STORE_PASSWORD`、`RELAKEEP_ANDROID_KEY_PASSWORD` 环境变量；keystore 与密码留在私有目录。

参考：Tauri v2 [平台依赖](https://v2.tauri.app/start/prerequisites/)、Better Auth [两步验证](https://www.better-auth.com/docs/plugins/2fa) / [通行密钥](https://www.better-auth.com/docs/plugins/passkey) / [设备授权](https://www.better-auth.com/docs/plugins/device-authorization)。
