# Privacy Policy for MarkFlow AI

**Last Updated:** November 2026

MarkFlow AI ("the Extension") is an open-source browser extension for Chromium-based browsers (including Google Chrome and Microsoft Edge), released under the GNU General Public License v3.0 (GPL-3.0). Official website: [https://markflow.smileyxy.dpdns.org/](https://markflow.smileyxy.dpdns.org/) · Online Privacy Policy: [https://markflow.smileyxy.dpdns.org/privacy](https://markflow.smileyxy.dpdns.org/privacy). Protecting user privacy is a foundational design principle of this project. This Privacy Policy explains how data is handled when you use the Extension.

---

## 1. Zero Data Collection Architecture

MarkFlow AI operates with a **strictly local, zero-server architecture**:

- We do **NOT** collect, store, track, transmit, or sell any personal data, browsing history, URLs, bookmark titles, or usage telemetry.
- The Extension has **no backend server**, no cloud account system, and no third-party analytics or advertising SDKs.

---

## 2. Browser Permissions & Purpose

Each permission declared in `manifest.json` is used strictly for the single purpose of organizing, saving, and searching your browser bookmarks:

| Permission | Purpose |
| :--- | :--- |
| **`bookmarks`** | Reads your local bookmark/favorites folder tree to present folder choices and reorganization previews, and creates, renames, moves, or sorts bookmarks only when you explicitly trigger an action. |
| **`activeTab`** & **`scripting`** | Reads the title, URL, and optional on-demand page metadata (description and primary headings) of the active tab **solely at the moment you invoke the Extension popup or keyboard shortcut**. No background scripts monitor or record your browsing activity. On-demand page context extraction can be disabled at any time in **Preferences**. |
| **`storage`** | Stores your local preferences, custom domain rules, domain affinity memory, and self-provided AI API credentials inside your own browser's extension local storage (`storage.local`). |
| **`optional_host_permissions`** *(opt-in only)* | MarkFlow AI declares **zero required `host_permissions`** on installation. Two strictly opt-in capabilities use on-demand permissions: (1) Three official Vertex AI endpoints (`aiplatform.googleapis.com`, `us-aiplatform.googleapis.com`, `eu-aiplatform.googleapis.com`) are requested one host at a time only if you enable **Vertex AI Priority** mode, and revoked when turned off. (2) Temporary `https://*/*` and `http://*/*` access is requested strictly when you click **Dead Link Scan** so your browser can perform local `HEAD`/`GET` reachability checks (`credentials: "omit"`, zero cookies or browsing history collected), and is automatically revoked via `chrome.permissions.remove` as soon as scanning completes or is canceled (if declined, scanning falls back to zero-permission `no-cors` connectivity probing). |

---

## 3. Direct User-Controlled AI Queries

AI semantic classification and title refinement are completely optional and controlled by you:

- When enabled, page metadata (title, URL, and optional page summary) is sent **directly from your browser** to the AI API endpoint you configured (e.g., Google Gemini, SiliconFlow, DeepSeek, OpenAI, a custom OpenAI/Gemini-compatible endpoint, or your own local Ollama server).
- Your API Key is sent only inside the provider's authentication header (`Authorization` or `x-goog-api-key`) directly to your chosen provider. It never passes through any proxy or server operated by MarkFlow AI.
- When you use **Local Rules** (with AI naming off), **0-Token Quick Sort**, **Duplicate Bookmark Merge**, **Dead Link Cleanup**, or **Local Ollama**, zero data is sent to any developer server.

---

## 4. Store Policy Compliance

MarkFlow AI strictly adheres to both the [Chrome Web Store Developer Program Policies](https://developer.chrome.com/docs/webstore/program-policies/) (including all **Limited Use** requirements) and the [Microsoft Edge Add-ons Store Developer Policies](https://learn.microsoft.com/microsoft-edge/extensions-chromium/store-policies/developer-policies). Because the Extension is open-source under GPL-3.0, every network call and permission usage can be independently audited in the source code.

---

## 5. Contact & Support

If you have any questions about this Privacy Policy or how MarkFlow AI handles data, please open an issue in the [MarkFlow AI GitHub repository](https://github.com/smileyxy/markflow/issues) or reach out through the corresponding extension store support page (Chrome Web Store or Microsoft Edge Add-ons).
