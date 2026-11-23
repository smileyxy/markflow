<div align="center">

<img src="icons/icon128.png" alt="MarkFlow AI Logo" width="88" height="88" />

# MarkFlow AI

**面向心流体验的本地规则 + 多模型 AI 书签自动归类、智能整理与极速检索扩展**

**[English](README.md)** · **简体中文**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-安装扩展-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/iclflcfabddfogenahenikehdnpbhjgm)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-5B5BD6.svg?style=flat-square)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-12805C.svg?style=flat-square)](manifest.json)
[![Zero Build](https://img.shields.io/badge/Architecture-Zero%20Build%20%7C%20Vanilla%20ES6-64748B.svg?style=flat-square)](#项目结构)
[![i18n](https://img.shields.io/badge/i18n-7%20Languages-0EA5E9.svg?style=flat-square)](#多语言支持)

[界面预览](#-界面预览) · [核心能力](#-核心能力) · [安装方式](#-安装方式) · [支持的 AI 模型](#-支持的-ai-服务商) · [快捷键](#-快捷键速查) · [隐私保护](#-隐私保护与纯本地架构) · [开源协议](#-开源协议)

</div>

---

## ✨ 为什么选择 MarkFlow AI？

传统的浏览器书签栏往往随着时间演变为难以检索的「收藏夹黑洞」：冗长的 SEO 网页标题、散落各处的重复链接、杂乱无章的层级目录，让收藏失去了复用的意义。

**MarkFlow AI** 采用 **「0ms 本地规则引擎 + 多模型 AI 语义分析 + 本地域名亲和记忆」** 混合架构，在不改变你使用 Chrome 原生书签习惯的前提下，将每一次收藏与全库整理变成轻松顺滑的心流体验：

- ⚡ **毫秒级规则直达**：常用域名、自托管内网服务或开发文档，直接由本地规则 0ms 锁定目录，零 Token 消耗。
- 🧠 **跨模型一致命名与归类**：长篇 SEO 标题自动清洗为易扫视的精炼标题，并依据现有书签树上下文推荐最合适的二级目录。
- 🗂️ **可控的存量书签整理**：既可保留现有目录结构并按优先级重排内部顺序，也可先审阅/编辑蓝图再全盘重构两级体系，落地前自动导出标准 HTML 安全备份。
- 🔍 **极速键盘书签启动器**：在任意页面或新标签页按下 `Alt + B`，`Tab` 一键切入本地模糊搜索，键盘上下选择、回车即达。

---

## 🖼️ 界面预览

### 心流收藏浮窗 & 极速书签启动器
<p align="center">
  <img src="docs/screenshots/02-popup-launcher.png" alt="MarkFlow AI 心流收藏与极速检索双模式" width="100%" />
</p>

### 书签库智能整理与 3 级优先级排序
<p align="center">
  <img src="docs/screenshots/01-reorganize.png" alt="MarkFlow AI 智能整理与目录内优先级排序" width="100%" />
</p>

<table>
  <tr>
    <td width="50%">
      <p align="center"><strong>多模型 AI &amp; Vertex AI 配置</strong></p>
      <img src="docs/screenshots/03-ai-config.png" alt="AI 语义模型与 Vertex AI 配置" width="100%" />
    </td>
    <td width="50%">
      <p align="center"><strong>本地规则引擎与实时 URL 测试器</strong></p>
      <img src="docs/screenshots/04-rules-engine.png" alt="本地规则引擎与实时测试器" width="100%" />
    </td>
  </tr>
</table>

---

## 🚀 核心能力

### 1. 智能整理与目录架构重构
- **归入现有目录 & 内部排序**：保留你熟悉的文件夹骨架，批量清洗标题、纠偏错位书签，并按 **P1 同功能聚簇 → P2 同站点/端口紧邻 → P3 自然序** 重排每个目录内的书签顺序。
- **0 Token 极速纯重排**：不消耗任何 AI 额度，直接基于本地功能分组与域名/端口聚类对现有目录完成顺序整理。
- **两阶段全盘目录重构**：
  1. **蓝图设计阶段**：AI 分析全量书签分布并生成精炼的两级目录草案，支持锁定特定一级目录（保持原封不动）、自由改名或增删节点；
  2. **原子落地阶段**：批量映射归位、自动收拢单条孤岛子目录、按优先级重排并安全清理迁空的旧文件夹。
- **双重安全兜底**：控制台顶部随时可「手动备份书签」，且每次确认应用变更前自动下载带时间戳的标准 Netscape HTML 备份文件。

### 2. 本地智能规则引擎
- 支持 **纯域名**（如 `homelab.local`，自动兼容多级子域名与自定义端口）、**通配符**（`*github.com*`）、**正则表达式**（`/docs\..+\.dev/i`），并支持用 `|`、全角 `｜`、逗号或换行分隔多条匹配条件。
- 规则编辑弹窗内置 **实时 URL 匹配测试器**，粘贴任意网址即可即时验证命中状态与命中片段。
- 支持自由开关 **「命中本地规则时仍用 AI 命名标题」**，在 0ms 精准锁定目录与高质量标题清洗之间按需权衡。

### 3. 心流收藏弹窗 & 极速书签启动器
- 任意网页按 `Alt + B` 立即弹出收藏浮窗，展示清洗后的推荐标题与二级目录路径，支持一键 AI 重新命名或新建子目录。
- 在新标签页唤醒扩展时自动切入 **检索模式**；按 `Tab` 可在收藏/检索之间瞬间切换，输入关键词即可毫秒级过滤全部历史书签。
- 支持可选的 **自动保存倒计时**、**盘古之白（中英文自动空格）**、**标题风格切换（扫视型 / 极简短名 / 保真精简）** 与 **自定义 AI 补充说明**。

### 4. 多语言支持
完整适配 **7 种界面语言**（涵盖 Chrome 扩展元数据 `_locales/`、弹窗与控制台全部界面）：

`简体中文` · `繁體中文（台灣 / 香港 / 澳門）` · `English` · `日本語` · `한국어` · `Deutsch` · `Español`

---

## 🤖 支持的 AI 服务商

所有服务商的端点、密钥与模型均 **独立持久化保存**，切换服务商不会覆盖已有配置，并支持一键从接口实时拉取可用 `/models` 列表：

| 服务商 | 接口协议 | 典型推荐模型 | 说明 |
| :--- | :--- | :--- | :--- |
| **Google Gemini & Vertex AI** | Gemini `v1beta` · Vertex AI Express · Vertex AI 项目端点 | `gemini-3.8-flash` / `gemini-3.5-flash` | 内置 **Gemini API**、**Vertex AI Express**（`aiplatform.googleapis.com/v1/publishers/google`）与 **Vertex AI 项目/区域端点** 一键预设，自动识别 API Key 或 `Bearer` / `ya29.` OAuth Token；填入 `/v1` 或 `/openai` 中转地址自动切换兼容模式 |
| **SiliconFlow (硅基流动)** | OpenAI Compatible | `DeepSeek-V4.1-Flash` / `Qwen3.5-35B-A3B` | 国内直连高速响应，高性价比 |
| **DeepSeek** | OpenAI Compatible | `deepseek-flash` / `deepseek-v4-pro` | 中文技术与通用场景表现稳定 |
| **OpenAI** | OpenAI Compatible | `gpt-6-luna` / `gpt-6.1-terra` | 全球通用高稳定端点 |
| **Ollama (Local)** | Local OpenAI Compatible | `qwen3.5:9b` / `gemma4:12b` | 100% 本地离线运行，无需 API Key |
| **Custom Endpoint** | OpenAI / Gemini / Vertex | 任意自定义模型 ID | 兼容 OpenRouter、自建中转、Vertex 代理或企业内网网关 |

---

## ⚡ 安装方式

### 方式一：从 Chrome 网上应用店安装（推荐）
直接从 Chrome 商店一键安装，支持后续自动更新：

👉 **[前往 Chrome Web Store 安装 MarkFlow AI](https://chromewebstore.google.com/detail/iclflcfabddfogenahenikehdnpbhjgm)**

### 方式二：从 GitHub Releases 下载安装
1. 前往 [Releases 页面](https://github.com/smileyxy/markflow/releases) 下载最新版本的 `markflow-v*.zip` 并解压到本地目录；
2. 打开 Chrome / Edge / Brave 地址栏访问 `chrome://extensions/`，开启右上角 **「开发者模式」**；
3. 点击 **「加载已解压的扩展程序」**，选择刚刚解压的文件夹即可使用。

### 方式三：克隆源码本地体验
本项目采用 **纯原生 Manifest V3 零构建架构**，无需安装 Node.js 或任何构建工具：

```bash
git clone https://github.com/smileyxy/markflow.git
```

在 `chrome://extensions/` 中开启开发者模式并加载克隆后的项目根目录即可直接运行。

---

## ⌨️ 快捷键速查

| 快捷键 | 作用域 | 功能说明 |
| :--- | :--- | :--- |
| `Alt + B` | 全局网页 / 新标签页 | 唤醒 MarkFlow 浮窗（在 `chrome://extensions/shortcuts` 可自定义） |
| `Tab` | 扩展弹窗内 | 在「收藏当前页」与「极速书签检索」模式间切换 |
| `↑` / `↓` | 检索模式下 | 上下移动高亮选中的历史书签 |
| `Enter` | 收藏 / 检索模式 | 确认保存当前书签 / 在新标签页打开高亮书签（`Ctrl+Enter` 后台打开） |
| `Esc` | 扩展弹窗 / 控制台弹窗 | 关闭当前弹层、灯箱预览或下拉菜单 |

---

## 🔒 隐私保护与纯本地架构

MarkFlow AI 坚持 **Local-First & Zero-Server** 原则，严格遵循 Chrome Web Store 隐私与 Limited Use 政策（详见 [PRIVACY.md](PRIVACY.md)）：

- **零云端中转与遥测**：无任何自建后端、账号体系或第三方埋点，书签数据原生托管于浏览器并兼容 Chrome 自带同步。
- **密钥仅存本地**：API Key 仅保存在本机 `chrome.storage.local`，请求由浏览器直连你所指定的 AI 服务商或本地 Ollama 实例。
- **最小权限与按需提取**：仅在你主动触发收藏时按需读取当前页标题与摘要（可在「通用偏好」中一键关闭页面正文读取），绝不在后台静默监控浏览行为。

---

## 📁 项目结构

```text
markflow/
├── manifest.json             # Manifest V3 扩展清单与最小权限声明
├── _locales/                 # Chrome 扩展名称与描述 7 国语言包
├── background/
│   └── service-worker.js     # 扩展生命周期初始化与默认配置引导
├── shared/                   # 核心引擎模块化层（无框架依赖）
│   ├── constants.js          # 服务商预设、多主题站点白名单与默认规则常量
│   ├── utils.js              # 标题清洗、盘古之白与通用辅助工具
│   ├── tree.js               # 书签树拓扑分析、蓝图构建与孤岛子目录收敛
│   ├── rules.js              # 本地规则引擎（域名/通配符/正则实时匹配）
│   ├── sorter.js             # 目录内 3 级优先级排序与增量插入位置计算
│   ├── llm.js                # Gemini API / Vertex AI / OpenAI 统一通信适配层
│   ├── classifier.js         # 单条收藏与批量整理核心归类调度器
│   ├── i18n.js               # 7 语种动态翻译与 DOM 自动注入
│   └── locales/              # 7 个独立语言词典文件
├── popup/                    # 心流收藏弹窗 & 极速键盘书签启动器
├── options/                  # 控制台页面（智能整理 / AI / 规则 / 偏好 / 赞赏 / 关于）
│   └── guide/                # 关于页 3 步快速上手离线实景缩略图
├── docs/screenshots/         # 中英文 README 与商店实景预览图
├── icons/                    # 扩展图标资源
├── PRIVACY.md                # 隐私政策说明
├── CHANGELOG.md              # 版本变更记录
├── README.md                 # 英文说明文档（默认）
└── LICENSE                   # GNU GPL-3.0 开源协议
```

---

## 📄 开源协议

本项目基于 **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)** 协议开源。

你可以自由使用、学习、修改与分发本项目代码；若你基于本项目发布衍生作品，须同样以 GPL-3.0 协议开放源代码并保留原始版权声明。
