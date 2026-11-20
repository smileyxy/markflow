# Privacy Policy for MarkFlow AI

**Last Updated:** November 2026

MarkFlow AI ("the Extension") is an open-source browser extension released under the GNU General Public License v3.0 (GPL-3.0). Protecting user privacy is a foundational design principle of this project. This Privacy Policy explains how data is handled when you use the Extension.

---

## 1. Zero Data Collection Architecture

MarkFlow AI operates with a **strictly local, zero-server architecture**:

- We do **NOT** collect, store, track, transmit, or sell any personal data, browsing history, URLs, bookmark titles, or usage telemetry.
- The Extension has **no backend server**, no cloud account system, and no third-party analytics or advertising SDKs.

---

## 2. Chrome Permissions & Purpose

Each permission declared in `manifest.json` is used strictly for the single purpose of organizing, saving, and searching your browser bookmarks:

| Permission | Purpose |
| :--- | :--- |
| **`bookmarks`** | Reads your local bookmark folder tree to present folder choices and reorganization previews, and creates, renames, moves, or sorts bookmarks only when you explicitly trigger an action. |
| **`activeTab`** & **`scripting`** | Reads the title, URL, and optional on-demand page metadata (description and primary headings) of the active tab **solely at the moment you invoke the Extension popup or keyboard shortcut**. No background scripts monitor or record your browsing activity. On-demand page context extraction can be disabled at any time in **Preferences**. |
| **`storage`** | Stores your local preferences, custom domain rules, domain affinity memory, and self-provided AI API credentials inside your own browser's `chrome.storage.local`. |

---

## 3. Direct User-Controlled AI Queries

AI semantic classification and title refinement are completely optional and controlled by you:

- When enabled, page metadata (title, URL, and optional page summary) is sent **directly from your browser** to the AI API endpoint you configured (e.g., Google Gemini, SiliconFlow, DeepSeek, OpenAI, a custom OpenAI/Gemini-compatible endpoint, or your own local Ollama server).
- Your API Key is sent only inside the provider's authentication header (`Authorization` or `x-goog-api-key`) directly to your chosen provider. It never passes through any proxy or server operated by MarkFlow AI.
- When you use **Local Rules** (with AI naming off), **0-Token Quick Sort**, or **Local Ollama**, zero data leaves your device.

---

## 4. Chrome Web Store Policy Compliance

MarkFlow AI strictly adheres to the [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/), including all **Limited Use** requirements. Because the Extension is open-source under GPL-3.0, every network call and permission usage can be independently audited in the source code.

---

## 5. Contact & Support

If you have any questions about this Privacy Policy or how MarkFlow AI handles data, please open an issue in the [MarkFlow AI GitHub repository](https://github.com/smileyxy/markflow/issues) or reach out through the Chrome Web Store support tab.
