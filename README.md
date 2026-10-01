# Amiya Atlas

本地优先的个人数字基础设施图谱：保存资产元数据、关系和生命周期；密码、Token、SSH 私钥和 CVV 留在 Vaultwarden 等权威来源中。

## V0.1

- Windows desktop：Tauri 2 + Svelte + TypeScript + Vite
- Argon2id 派生 KEK、随机 Vault Key、XChaCha20-Poly1305 逐记录加密 SQLite
- Entity / Field / Relation / Event、搜索、Quick Add、关系列表、到期与复核提醒
- Atlas JSON 导入、加密备份/恢复、脱敏导出
- Chrome/Edge Manifest V3 Native Messaging 捕获当前网站并关联 Identity

## 开发

```powershell
npm install
npm run dev
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npm run build:desktop
```

`npm run build:desktop` 会生成 `src-tauri/target/release/bundle/nsis/` 下的 Windows 安装包。安装器以当前用户注册 Chrome/Edge Native Messaging host。

## 真实清单

`staging/atlas-real-staging.json` 是根据研究报告整理的一次性本地元数据 staging 文件，包含约 87 个实体、34 条关系和 3 个事件。`staging/*`（README 除外）被 Git 忽略；真实清单不要提交仓库，也不要把密码、Token、私钥、CVV 或带凭据的订阅 URL 写入其中。

浏览器插件权限只有 `activeTab`、`nativeMessaging` 和 `storage`，不会申请全站 URL、Cookie、History 或表单密码权限。
