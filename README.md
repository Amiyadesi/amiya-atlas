# Amiya Atlas

**你只管说，Atlas 替你记住。**

本地优先的私人数字记忆层：自然输入 → AI 提案 → 用户确认 → 加密保存 → 搜索和探索。你不用先选模板，也不用维护一张数据库表。

## 当前可用链路

- Capture-first 首页、文本原文保存、待确认 Inbox
- 可编辑 Proposal、原文依据与不确定项、确认后才写入实体 / 关系 / 生命周期
- 原有加密 SQLite，旧库和旧 Atlas JSON 兼容；API Key 同样加密保存
- 实体详情、原文追溯、基础搜索、地区别名与自然语言名称 / 地区过滤
- 默认一跳的关系画布、筛选、缩放、平移、按需展开
- 默认本地模型、已有 Ollama、自定义 OpenAI-compatible URL / Key / Model
- 加密备份恢复、脱敏导出；已有浏览器捕获桥保留兼容

Windows x64 桌面版在 **设置 → Atlas Local → 下载并准备默认模型** 中首次准备 Ollama v0.35.0 和 Qwen3.5 2B。模型约 1.9 GB，运行时另约 1.5 GB，需要额外解压空间；下载安装完成后本机解析可离线使用。其他平台可连接已有 Ollama 或兼容 API。

## 开发与检查

技术基础：Tauri 2 + Svelte 5 + TypeScript + Vite + Zod，Rust + 逐记录加密 SQLite。

```powershell
npm ci
npm run dev             # 临时内存预览，刷新即重置
npm test                # 提案、确认、搜索和模型边界
npm run test:ui         # 首次先 npx playwright install chromium
npm run build
npm run test:core       # 无图形依赖的 Rust / SQLite 测试
npm run build:desktop   # Windows 构建原有捕获桥与桌面安装包
```

Windows 开发运行桌面版：

```powershell
npm run build:host
npm run tauri dev
```

默认模型验证：在本机默认模型服务运行时，执行 `node scripts/evaluate-local.mjs`。它检查 Saily 号码属性、SuperGrok 月份精度和不续费策略、邮箱 / Cloudflare / 域名关系，不发送用户真实清单。

## 设计与边界

详见 [重启说明](docs/reboot-v0.2.md)。LLM 负责理解，数据库负责事实；模型接口没有数据库写入能力。

语音、云同步、手机端、外部服务自动同步和插件市场仍在后续阶段。此轮先验证你是否愿意连续三天主动记东西。

`staging/*`（README 除外）忽略；个人真实清单、密码、Token、私钥、CVV 和带凭据的 URL 不提交到仓库。脱敏导出不包含原始输入、提案和模型认证信息。新版本可读旧数据库；首次升级前导出加密备份，保存新增记录后不要用旧版二进制打开新库。
