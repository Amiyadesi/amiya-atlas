# Amiya Atlas

**你只管说，Atlas 替你记住。**

本地优先的私人数字记忆层：自然输入 → AI 提案 → 用户确认 → 加密保存 → 搜索和探索。你不用先选模板，也不用维护一张数据库表。

## 当前可用链路

- Capture-first 首页、文本原文保存、待确认 Inbox
- 全局快速输入、按需读取剪贴板、本地语音转写；所有入口共用提案确认流程
- 可编辑 Proposal、原文依据与不确定项、确认后才写入实体 / 关系 / 生命周期
- 原有加密 SQLite，旧库和旧 Atlas JSON 兼容；API Key 同样加密保存
- 实体详情、原文追溯、基础搜索、地区别名与自然语言名称 / 地区过滤
- 默认一跳的关系画布、筛选、缩放、平移、按需展开
- 默认本地模型、已有 Ollama、自定义 OpenAI-compatible URL / Key / Model
- 加密备份恢复、脱敏导出；已有浏览器捕获桥保留兼容

Windows x64 桌面版在 **设置 → Atlas Local → 下载并使用所选模型** 中首次准备 Ollama v0.35.0 和默认 Qwen3.5 2B Q4_K_M，也可选择 4B。2B 模型约 1.9 GB，运行时另约 1.5 GB，需要额外解压空间；下载安装完成后本机解析可离线使用。其他平台可连接已有 Ollama 或兼容 API。

## 快捷与语音

Atlas 运行时可从其他应用唤起快速输入；最小化也能使用。快捷键冲突会在设置中显示，也可关闭全局快捷键。

| 快捷键（Windows）    | 动作                            |
| -------------------- | ------------------------------- |
| Ctrl + Shift + Space | 打开快速输入                    |
| Ctrl + Alt + V       | 打开输入并读取剪贴板文字        |
| Ctrl + Alt + R       | 打开输入并开始录音              |
| Ctrl + Enter         | 整理当前输入                    |
| Esc                  | 取消录音 / 转写，或关闭快速输入 |

**设置 → 语音输入 → 下载并准备语音模型**：多语言 Whisper Small Q5_1 模型约 190 MB，运行时约 9 MB，下载内容先校验 SHA-256。录音最长 60 秒，停止后在本机转成可编辑文字；核对名称与数字，按 Ctrl + Enter 得到提案，最后确认保存。麦克风需要系统授权，锁定记忆库会停止录音并取消转写。音频与临时转写文件会在完成、取消或出错后删除；进入加密记忆的是核对后的文字与输入来源。内置语音目前支持 Windows x64。

系统听写也可输入到文本框（Windows 为 Win + H），由操作系统提供服务。内置 Whisper 转写始终在本机运行；如果选择了远程记忆模型，点击「帮我记住」后会将文字发送给该模型。

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

默认模型验证：在本机默认模型服务运行时，执行 `node scripts/evaluate-local.mjs`。它检查 Saily、SuperGrok、邮箱 / Cloudflare / 域名、Gmail、HSBC、阿里云杭州、已有记忆更新和两种地区查询，不发送用户真实清单。

本轮对比了 0.8B、2B、4B；默认保留通过测试且等待更短的 2B。预热、最多 8 个 CPU 线程和 10 分钟保活减少重复加载；同机 7 条 Capture 的中位时间从 7.0 秒到 5.6 秒，查询约 1.3–1.4 秒。这是小样本开发机结果，日常输入仍需要检查提案。比较方法与结果见 [快捷与语音说明](docs/quick-capture-voice.md)。GitHub Actions 的 `atlas-windows-preview` artifact 提供 Windows 预览安装包。

## 设计与边界

详见 [重启说明](docs/reboot-v0.2.md)。LLM 负责理解，数据库负责事实；模型接口没有数据库写入能力。

云同步、手机端、外部服务自动同步和插件市场仍在后续阶段。此轮继续以是否愿意每天主动记东西为标准。

`staging/*`（README 除外）忽略；个人真实清单、密码、Token、私钥、CVV 和带凭据的 URL 不提交到仓库。脱敏导出不包含原始输入、提案和模型认证信息。新版本可读旧数据库；首次升级前导出加密备份，保存新增记录后不要用旧版二进制打开新库。
