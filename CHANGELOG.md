# Changelog

All notable changes to **MarkFlow AI** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-24

### 🚀 Highlights / 核心亮点
- 🤖 **Multi-Provider AI Gateway** — Added OpenRouter, native Anthropic Claude (`/v1/messages`), Grok (xAI), and Google Vertex AI (Express API Key & Project OAuth, with transparent Gemini 4 `locations/global` routing) / 新增 OpenRouter、Claude 原生接口、Grok 与 Google Vertex AI（Express 密钥自动全局路由 Gemini 4）。
- 🎯 **Master-Detail Model Picker** — Replaced the stacked accordion list with a centered split modal supporting normalized vendor prefixes, dynamic generation grouping, live search, and free Vertex `:countTokens` probing / 升级为居中主从分栏模型选择弹窗，自动归一化厂商与代际分组，支持检索与 Vertex 零计费可用性实测。
- 🗂️ **Smart Reorganizer Upgrades** — Added 5 in-folder sort rules, 5 folder icon styles, Changed-Only filter, local Token Estimator, single-row preview table & partial `Retry Failed` / 智能整理新增 5 种排序规则、5 种重构风格、仅展示变动项、Token 估算、单行省略预览与「↻ 仅重试失败项」。
- 🛡️ **Resilient Error & Retry UX** — Added Popup AI failure banner (`Retry` / expandable details / `Config`), explicit batch `AI Failed` markers, and friendly overflow-safe notifications / 弹窗新增 AI 失败提示条与一键重试，全局报错友好脱敏收敛并防溢出。

### 🆕 Added / 新增
- Add OpenRouter, Claude (Anthropic Messages), Grok (xAI), and Google Vertex AI (Express & Project) with independent persistent configs and quick endpoint chips / 新增 OpenRouter、Claude、Grok 与 Vertex AI 预设及端点快捷切换
- Add centered Master-Detail `#modelPickerModal` with vendor normalization, collapsible/selectable family sidebar, and custom Vertex `:countTokens` single-model verification / 新增主从分栏模型选择弹窗与 Vertex 单模型实测入口
- Add 5 in-folder sort rules, 5 blueprint visual styles, Changed-Only filter toggle, real-time local Token Estimator, and sponsor QR refresh / 新增 5 排序规则、5 视觉风格、仅变动过滤、Token 估算并更新赞赏码
- Add Popup `#aiErrorStrip` retry/config bar (`classifyPopupAiError` / countdown auto-pause) and Smart Reorganizer `#reorgBatchErrorBanner` (`↻ Retry Failed`) / 新增弹窗失败重试条（失败暂停倒计时）与智能整理局部批次重试

### ⚡ Improved / 优化
- Upgrade Smart Reorganizer preview into fixed-column full-width inputs with single-row ellipsis and `Order only` badge / 预览行改为全宽输入框 + 单行省略对齐与「仅排序」徽章
- Simplify sort toggle label (`reorg_sort_toggle_label`) and connection verification toast (`Connection verified` / `连接成功，接口通信正常`) / 精简排序复选文案与测试连接成功提示
- Sanitize verbose upstream API quota/auth/model errors (`sanitizeErrorExcerpt`, `classifyAiError`) and harden Toast multi-line flex wrapping / 统一 AI 报错脱敏归因并加固 Toast 多行文本防溢出
- Expand bilingual `README.md` (English default) & `README.zh-CN.md` with updated showcase screenshots and Chrome Web Store priority / 优化双语 README 文档、实景截图与 Chrome 商店优先安装指引
- Upgrade GitHub Release workflow to automatically publish bilingual highlights, merged commits, diff summary, and compare links / 升级自动发版工作流，固定输出双语亮点、合并提交与代码对比链接

### 🐞 Fixed / 修复
- Fix Vertex AI Express `GET /models` 401 and Gemini 4 regional 404 via first-party discovery, two-pass `:countTokens` probing, and session `locations/global` routing / 修复 Vertex AI Express 拉取模型列表与 Gemini 4 调用失败问题
- Fix Smart Reorganizer category pill filter scroll jump, custom select menu width clipping (`max-content`), and silent `"本地兜底"` fallback masking / 修复预览筛选滚动跳变、排序下拉截断与静默兜底遮蔽问题
- Ensure Popup `providerNames` displays `OpenRouter`, `Claude`, and `Grok` cleanly and Enter key on strip buttons does not prematurely submit save / 补齐弹窗服务商名称显示并防止提示条按钮回车误保存

## [1.0.0] - 2026-11-20

### Added
- **智能书签整理与两阶段架构重构**
  - 新增「归入现有目录 & 内部优先级排序」模式，按 **P1 同功能聚簇 → P2 同站点/端口紧邻 → P3 自然序** 确定性重排目录内顺序，并提供 **0 Token 极速纯重排** 入口。
  - 新增「全盘重构目录体系」工作流：先生成可自由编辑的两级目录蓝图，再统一批量映射、自动收拢孤岛子目录并清理腾空的旧空目录。
  - 支持在智能整理页面随时点击「手动备份书签」导出标准 Netscape HTML 备份，且每次应用结构变更前自动触发备份下载。
- **本地规则引擎与实时 URL 测试器**
  - 规则匹配器支持纯域名（自动兼容多级子域名与自定义端口）、通配符 `*`、正则表达式 `/pattern/i` 与多种分隔符，并在规则编辑弹窗内置实时 URL 匹配测试器。
  - 支持在通用偏好中配置「命中本地规则时仍用 AI 命名标题」，同时保留弹窗内随时一键 AI 命名。
- **多模型 AI 语义双引擎**
  - 原生兼容 Google Gemini (v1beta)、SiliconFlow、DeepSeek、OpenAI、本地 Ollama 及任意自定义兼容端点；支持各服务商独立持久化配置与实时拉取在线 `/models` 列表。
  - 支持标题风格（扫视型 / 极简短名 / 保真精简）、AI 生成语言、子目录新建倾向、盘古之白、自动保存倒计时、自定义补充说明与全量配置 JSON 迁移。
- **7 种语言国际化支持**
  - 完整适配简体中文、繁體中文（覆盖台湾/香港/澳门）、English、日本語、한국어、Deutsch、Español，同步覆盖 Chrome 扩展清单 `_locales/`、弹窗与控制台界面。
- **Soft Tactile Glass 界面与自定义毛玻璃下拉组件**
  - 控制台采用悬浮毛玻璃侧边栏、自定义毛玻璃下拉菜单、高可读性色彩目录圆点与零模糊悬停微交互，全面适配浅色与深色系统主题。
  - 「关于与隐私」内置核心特性一览与 3 步实景上手教程，一键直达对应配置页。

### Architecture
- 纯原生 **Manifest V3** 零构建架构（Vanilla ES6 + CSS Custom Properties），模块化拆分 `shared/` 与 `options/`，零外部运行时依赖、零云端中转服务器。
- 以 **GNU General Public License v3.0 (GPL-3.0)** 协议正式开源。
