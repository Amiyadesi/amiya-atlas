# Relakeep 0.4：多端、自建服务器与 WebDAV

目标：Android、Windows、Linux 共用本地加密记忆库；手动迁移、自建服务器与 WebDAV 自动同步；电脑可用 localhost:5011 网页，Docker 提供个人资产与关系图网页。不提供官方云存储。

方案：复用 Rust Vault 和 Svelte UI。自建服务器或 WebDAV 存放经过认证加密的同步快照，客户端保存加密基线，使用强 ETag 条件写入和按记录三方合并；同一记录冲突必须确认，保留密文备份。模型凭据、云会话、同步凭据不进入自动同步包。本机网页只监听 loopback；Android 不启动 HTTP 服务。

自建登录：单用户首次设置码建号，随后关闭注册；Better Auth 密码、验证器 2FA、通行密钥、设备授权。登录环境记录默认关闭，可清除已保存信息并撤销会话。客户端填写域名或 HTTPS IP:端口，系统浏览器登录并确认设备码。公网需要设备信任的 HTTPS；通行密钥入口限 HTTPS 域名或 localhost。网页模式在用户自己的服务器解密，不能描述为浏览器端到端加密。

文件：src-tauri/src/sync.rs 与 vault.rs 负责加密同步；http.rs、commands.rs 与独立 binary 负责本机/Docker 网页；desktop.rs 和平台配置负责 Android/Linux；src/lib/runtime.ts、SyncSettings 与响应布局负责共用界面；server/src/selfhost.ts 与 ServerAuth/ServerSecurity 负责自建登录；scripts、Dockerfile 与平台配置负责可安装产物。

验证：必要 Rust/Svelte 构建；临时脱敏库核验合并、冲突、条件写入；Windows 安装包、Android APK、Linux 包、Docker 启动。保留原 Vault 与全部既有 dirty work。不重跑 OAuth、支付或 UI 测试套件。

## 任务
- [x] 实现 WebDAV 加密传输、基线、自动合并、冲突选择。
- [x] 接入设置与自动同步，完善跨平台手动文件导入导出。
- [x] 实现电脑 loopback 网页与 Docker 自建网页服务。
- [x] 实现自建密码登录、设备授权、2FA、通行密钥、登录环境记录与会话撤销。
- [x] Android 平台兼容、手机布局、文件选择和签名 arm64 APK 构建。
- [x] Linux deb / 独立网页程序、Docker 配置、部署教程与可安装产物。
- [x] 必要构建、更新本机与官网下载，记录真实交付范围。

## 交付 — 2026-10-14

- Windows 0.4.0 已覆盖升级到 D:/tools/Amiya Atlas/amiya-atlas.exe，安装版本已确认；原加密 Vault 保留，升级前密文另存于 _private。
- Android APK 包名 org.sayori.atlas、版本 0.4.0 / 4000、最低 Android 7、arm64；APK v2 签名验证通过。未进行手机真机验收。
- Linux deb 与独立 relakeep-web 在隔离 Debian Bookworm 运行环境启动通过；本机网页入口已确认。交付 deb 与保留执行权限的 tar.gz，不交付 AppImage。
- Docker 自建镜像在临时脱敏实例启动通过；交付可构建的源码部署包，未代用户创建永久个人服务器。
- 既有同步与自建认证定向检查完成；官网构建通过，Pages 部署 5ca0caca.relakeep.pages.dev，atlas.sayori.org 下载页列出全部 0.4.0 包，六个安装/部署/教程地址均返回 200。
- 教程：docs/relakeep-0.4.md、官网 /guide#sync 与 /guide#selfhost。Android 关闭或被系统暂停后不保证后台同步；应用打开、回前台、恢复网络以及打开期间每 30 秒同步。
- Atlas 工作树保留，未提交或推送。本轮未重跑官网 OAuth、支付或完整测试套件。
