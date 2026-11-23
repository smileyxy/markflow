<div align="center">

<img src="icons/icon128.png" alt="MarkFlow AI Logo" width="88" height="88" />

# MarkFlow AI

**Local Rule Engine + Multi-Model AI Semantic Bookmark Organizer, Sorter & Quick Launcher**

**English** · **[简体中文](README.zh-CN.md)**

[![Chrome Web Store](https://img.shields.io/badge/Chrome%20Web%20Store-Install%20Extension-4285F4?style=flat-square&logo=googlechrome&logoColor=white)](https://chromewebstore.google.com/detail/iclflcfabddfogenahenikehdnpbhjgm)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-5B5BD6.svg?style=flat-square)](LICENSE)
[![Manifest V3](https://img.shields.io/badge/Chrome-Manifest%20V3-12805C.svg?style=flat-square)](manifest.json)
[![Zero Build](https://img.shields.io/badge/Architecture-Zero%20Build%20%7C%20Vanilla%20ES6-64748B.svg?style=flat-square)](#project-structure)
[![i18n](https://img.shields.io/badge/i18n-7%20Languages-0EA5E9.svg?style=flat-square)](#multi-language-support)

[Screenshots](#-screenshots) · [Features](#-core-features) · [Installation](#-installation) · [AI Providers](#-supported-ai-providers) · [Shortcuts](#-keyboard-shortcuts) · [Privacy](#-privacy--local-first-architecture) · [License](#-license)

</div>

---

## ✨ Why MarkFlow AI?

Browser bookmark bars quickly turn into unsearchable clutter: bloated SEO page titles, scattered duplicate links, and inconsistent folders.

**MarkFlow AI** combines a **0ms Local Rule Engine**, **Multi-Model AI Semantic Classification**, and **Local Domain Affinity Memory** — keeping all your bookmarks natively inside Chrome while turning every save and library cleanup into an effortless, keyboard-first flow:

- ⚡ **0ms Deterministic Routing**: Frequent domains, self-hosted homelab services, and docs match locally in zero milliseconds without spending AI tokens.
- 🧠 **Consistent Naming & Filing**: Strips noisy SEO suffixes into clean scannable titles and picks the best matching subfolder from your existing tree.
- 🗂️ **Safe, Controllable Bulk Cleanup**: Reorganize inside existing folders with 3-tier priority sorting, or design and edit a two-level folder blueprint before migrating — backed up automatically as standard HTML.
- 🔍 **Instant Keyboard Bookmark Launcher**: Press `Alt + B` anywhere, hit `Tab` (or open on a New Tab), type multiple keywords, and jump right to any bookmark.

---

## 🖼️ Screenshots

### Flow Capture Popup & Instant Bookmark Launcher
<p align="center">
  <img src="docs/screenshots/en/02-popup-launcher.png" alt="MarkFlow AI Flow Capture and Quick Bookmark Launcher" width="100%" />
</p>

### Smart Reorganizer & 3-Tier In-Folder Priority Sorting
<p align="center">
  <img src="docs/screenshots/en/01-reorganize.png" alt="MarkFlow AI Smart Reorganizer and Priority Sort" width="100%" />
</p>

<table>
  <tr>
    <td width="50%">
      <p align="center"><strong>Multi-Model AI &amp; Vertex AI Configuration</strong></p>
      <img src="docs/screenshots/en/03-ai-config.png" alt="AI Model and Vertex AI Configuration" width="100%" />
    </td>
    <td width="50%">
      <p align="center"><strong>Local Rule Engine &amp; Live URL Tester</strong></p>
      <img src="docs/screenshots/en/04-rules-engine.png" alt="Local Rule Engine and Live URL Match Tester" width="100%" />
    </td>
  </tr>
</table>

---

## 🚀 Core Features

### 1. Smart Reorganizer & Taxonomy Architect
- **Fit Existing Folders & Sort**: Preserves your familiar folders while cleaning titles, relocating misplaced links, and sorting inside each folder with **5 sort rules** (*Smart Priority Tiered*, *Site Domain & Port*, *Title A → Z*, *Newest First*, *Oldest First*) plus a **Changed-Only Preview & Apply** toggle so untouched bookmarks stay intact.
- **0-Token Quick Sort**: Reorder bookmarks inside existing folders purely locally using your chosen sort rule without any AI calls.
- **Two-Stage Full Rebuild**:
  1. **Blueprint Review**: AI proposes a two-level folder hierarchy with **5 visual folder styles** (Semantic Icons, Dual Icons, Plain Text, Numbered `01`, Minimal Symbol `◆`) where you can lock existing folders, rename nodes, or add/remove subfolders;
  2. **Atomic Migration**: Bulk-maps bookmarks (with a real-time **local Token Estimator** before running), folds single-item orphan subfolders, sorts every destination folder, and safely removes empty legacy folders.
- **Dual Backup Safety**: Export a standard Netscape HTML backup anytime with one click, plus automatic timestamped HTML backup downloads before applying any bulk changes.

### 2. Local Rule Engine
- Matches by **bare domain** (automatically handles nested subdomains and custom ports), **wildcards** (`*github.com*`), or **regular expressions** (`/docs\..+\.dev/i`), supporting multiple separators (`|`, commas, newlines).
- Includes a built-in **Live URL Match Tester** inside the rule modal to verify exact rule hits in real time.
- Optional toggle to pair 0ms rule folder routing with lightweight AI title cleanup.

### 3. Flow-State Capture & Quick Bookmark Launcher
- Press `Alt + B` on any page to inspect/edit the cleaned title and suggested subfolder, or hit `Enter` to save immediately.
- Triggering the popup on a New Tab opens directly in **Search Mode**; press `Tab` anytime to toggle between Save and Search with multi-keyword fuzzy matching and keyboard navigation.
- Configurable **Auto-Save Countdown**, **CJK-Latin spacing (Pangu)**, **3 Title Styles**, **Custom AI Instructions**, and full JSON settings export/import.

### 4. Multi-Language Support
Full localized UI & extension metadata across **7 languages**:

`English` · `简体中文` · `繁體中文 (台灣 / 香港 / 澳門)` · `日本語` · `한국어` · `Deutsch` · `Español`

---

## 🤖 Supported AI Providers

Each provider stores its Base URL, credential, and model ID independently, with one-click live `/models` fetching and collapsible vendor/family model grouping:

| Provider | Protocol | Recommended Models | Notes |
| :--- | :--- | :--- | :--- |
| **DeepSeek** | OpenAI Compatible | `deepseek-flash` / `deepseek-v4-pro` | Default preset; fast technical & multilingual classification |
| **SiliconFlow** | OpenAI Compatible | `DeepSeek-V4.1-Flash` / `Qwen3.5-35B-A3B` | Fast, cost-effective OpenAI-compatible hosting |
| **OpenRouter** | OpenAI Compatible | `google/gemini-2.5-flash` / `anthropic/claude-sonnet-4` | Unified gateway across 100+ models grouped by vendor prefix |
| **Google Gemini & Vertex AI** | Gemini `v1beta` · Vertex AI Express · Vertex AI Project | `gemini-3.8-flash` / `gemini-3.5-flash` | Built-in presets for **Gemini API**, **Vertex AI Express**, and **Vertex AI Project** endpoints (auto API Key / `Bearer` / `ya29.` OAuth + built-in Vertex catalog fallback) |
| **Claude (Anthropic)** | Anthropic Messages (`/v1/messages`) | `claude-sonnet-4-5` / `claude-haiku-4-5` | Native browser-direct CORS Messages API support |
| **OpenAI** | OpenAI Compatible | `gpt-6-luna` / `gpt-6.1-terra` | Standard global OpenAI endpoint |
| **Grok (xAI)** | OpenAI Compatible | `grok-3-mini` / `grok-4-fast` | Official xAI API endpoint |
| **Ollama (Local)** | Local OpenAI Compatible | `qwen3.5:9b` / `gemma4:12b` | 100% offline local inference, no API Key & zero token cost |
| **Custom Endpoint** | OpenAI / Anthropic / Gemini / Vertex | Any Model ID | Supports self-hosted gateways, enterprise proxies, or custom relays |

---

## ⚡ Installation

### Option 1: Chrome Web Store (Recommended)
Install directly with automatic updates from the official Chrome Web Store listing:

👉 **[Install MarkFlow AI from Chrome Web Store](https://chromewebstore.google.com/detail/iclflcfabddfogenahenikehdnpbhjgm)**

### Option 2: GitHub Releases
1. Download the latest `markflow-v*.zip` from [GitHub Releases](https://github.com/smileyxy/markflow/releases) and extract it locally.
2. Open `chrome://extensions/` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder.

### Option 3: Load Unpacked from Source
**Zero-build native Manifest V3 architecture** — no Node.js or bundler required:

```bash
git clone https://github.com/smileyxy/markflow.git
```

Enable **Developer mode** at `chrome://extensions/` and click **Load unpacked** on the cloned repository folder.

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Context | Action |
| :--- | :--- | :--- |
| `Alt + B` | Any Webpage / New Tab | Open MarkFlow popup (customizable at `chrome://extensions/shortcuts`) |
| `Tab` | Inside Popup | Toggle between Save Mode and Quick Search Launcher |
| `↑` / `↓` | Search Mode | Move highlight across matched bookmarks |
| `Enter` | Save / Search Mode | Confirm save / open highlighted bookmark (`Ctrl+Enter` opens in background tab) |
| `Esc` | Popup / Options Modals | Close current overlay, lightbox preview, or dropdown |

---

## 🔒 Privacy & Local-First Architecture

MarkFlow AI is designed strictly **Local-First & Zero-Server**, adhering to Chrome Web Store Privacy and Limited Use policies (see [PRIVACY.md](PRIVACY.md)):

- **Zero Servers & Zero Telemetry**: No developer backend, no accounts, and no analytics/tracking SDKs. Bookmarks stay in Chrome's native bookmark tree with standard Chrome Sync compatibility.
- **Keys Stay Local**: API keys are stored solely in your browser's `chrome.storage.local` and sent directly to your configured AI endpoint or local Ollama instance.
- **Minimal On-Demand Permissions**: Page metadata is only read when you deliberately trigger bookmark capture (and can be disabled anytime in **Preferences**).

---

## 📁 Project Structure

```text
markflow/
├── manifest.json             # Manifest V3 manifest & minimal permissions
├── _locales/                 # Chrome Web Store & extension metadata for 7 locales
├── background/
│   └── service-worker.js     # Lifecycle defaults & storage initialization
├── shared/                   # Zero-dependency modular core engine
│   ├── constants.js          # Provider presets, multi-topic domains, default rules
│   ├── utils.js              # Title cleaner, Pangu spacing, helpers
│   ├── tree.js               # Bookmark tree analyzer & blueprint orphan folding
│   ├── rules.js              # Local rule engine (domain / wildcard / regex)
│   ├── sorter.js             # 3-tier priority sorter & deterministic insertion index
│   ├── llm.js                # Unified Gemini API / Vertex AI / OpenAI client
│   ├── classifier.js         # Single & batch semantic classification orchestrator
│   ├── i18n.js               # Dynamic 7-language i18n runtime
│   └── locales/              # 7 standalone locale dictionaries
├── popup/                    # Flow capture popup & keyboard bookmark launcher
├── options/                  # Settings & Smart Reorganizer dashboard
│   └── guide/                # Offline quick-start guide screenshots
├── docs/screenshots/         # Bilingual README & Store showcase screenshots
├── icons/                    # Extension icons
├── PRIVACY.md                # Privacy policy
├── CHANGELOG.md              # Release notes
├── README.zh-CN.md           # Chinese README
└── LICENSE                   # GNU GPL-3.0 License
```

---

## 📄 License

This project is open source under the **[GNU General Public License v3.0 (GPL-3.0)](LICENSE)**.
