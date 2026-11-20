# Changelog

All notable changes to **MarkFlow AI** will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
