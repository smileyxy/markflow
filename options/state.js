/**
 * 控制台共享状态、书签树读取与通用交互组件
 *
 * 集中管理跨标签页共享的 appState、存储初始化、多语言访问函数、
 * 浮动 Toast 提示条以及应用内确认对话框。
 */

(function (global) {
  "use strict";

  const DEFAULT_PROVIDERS = Object.fromEntries(
    Object.entries(MarkFlowEngine.PROVIDER_PRESETS).map(([key, p]) => [
      key,
      { baseUrl: p.baseUrl, apiKey: p.apiKey, model: p.model }
    ])
  );

  const appState = {
    rules: [],
    aiConfig: {
      enabled: false,
      provider: "siliconflow",
      providers: {}
    },
    preferences: Object.assign({}, MarkFlowEngine.DEFAULT_PREFERENCES),
    domainMemory: {},
    treeAnalysis: null,
    folderHierarchy: [],
    allFoldersTree: [],
    editingRuleId: null,

    // 在线拉取的模型列表缓存
    fetchedModelIds: [],

    // 智能整理与目录重构状态
    reorgMode: "existing",        // "existing" | "rebuild"
    activeReorgMode: "existing",  // "existing" | "rebuild" | "sort_only"
    lockedL1Ids: new Set(),
    blueprintCategories: [],
    rebuildRawBookmarks: [],
    activeTargetFolders: [],
    previewCategoryFilter: "ALL",
    reorgItems: []
  };

  /** 读取当前语言对应的本地化文案，支持 `{key}` 参数插值 */
  function t(key, varsOrFallback) {
    return getLocaleString(appState.preferences.language, key, varsOrFallback);
  }

  /** 从本地存储与 Chrome 书签树初始化控制台全量状态 */
  async function loadState() {
    const [stored, tree] = await Promise.all([
      chrome.storage.local.get(["aiConfig", "rules", "preferences", "domainMemory"]),
      chrome.bookmarks.getTree()
    ]);

    if (!stored.rules || !Array.isArray(stored.rules)) {
      appState.rules = JSON.parse(JSON.stringify(MarkFlowEngine.DEFAULT_UNIVERSAL_RULES));
      await chrome.storage.local.set({ rules: appState.rules });
    } else {
      appState.rules = stored.rules;
    }

    appState.preferences = Object.assign(
      {},
      MarkFlowEngine.DEFAULT_PREFERENCES,
      stored.preferences || {}
    );
    appState.preferences.language = resolveDisplayLanguage(appState.preferences.language);

    appState.domainMemory = stored.domainMemory || {};

    // 各服务商独立持久化配置，并在未自定义密钥时平滑迁移旧版默认模型名
    const storedAi = stored.aiConfig || {};
    appState.aiConfig = {
      enabled: !!storedAi.enabled,
      provider: storedAi.provider || "siliconflow",
      providers: {}
    };

    for (const [key, val] of Object.entries(DEFAULT_PROVIDERS)) {
      const savedSlot = (storedAi.providers && storedAi.providers[key]) || {};
      const merged = Object.assign({}, val, savedSlot);
      const hasCustomKey = merged.apiKey && merged.apiKey !== "ollama";
      if (!hasCustomKey && MarkFlowEngine.LEGACY_DEFAULT_MODELS.has(merged.model)) {
        merged.model = val.model;
      }
      appState.aiConfig.providers[key] = merged;
    }

    // 兼容历史单服务商扁平字段结构
    if (storedAi.baseUrl && (!storedAi.providers || Object.keys(storedAi.providers).length === 0)) {
      const cur = appState.aiConfig.provider;
      if (appState.aiConfig.providers[cur]) {
        appState.aiConfig.providers[cur].baseUrl = storedAi.baseUrl;
        appState.aiConfig.providers[cur].apiKey = storedAi.apiKey || "";
        if (storedAi.model) appState.aiConfig.providers[cur].model = storedAi.model;
      }
    }

    parseFolderStructures(tree);
  }

  /** 解析书签树并刷新目录层级缓存 */
  function parseFolderStructures(tree) {
    appState.treeAnalysis = MarkFlowEngine.analyzeBookmarkTree(tree);
    appState.allFoldersTree = appState.treeAnalysis.folders;
    appState.folderHierarchy = extractFolderHierarchy(tree);
  }

  /** 提取一、二级目录层级，供规则弹窗级联选择器使用 */
  function extractFolderHierarchy(tree) {
    const hierarchy = [];
    if (!tree || tree.length === 0 || !tree[0].children) return hierarchy;

    for (const rootChild of tree[0].children) {
      if (!rootChild.children) continue;

      for (const child of rootChild.children) {
        if (child.url === undefined) {
          const subfolders = [];
          if (child.children) {
            for (const sub of child.children) {
              if (sub.url === undefined) {
                subfolders.push({ id: sub.id, title: sub.title });
              }
            }
          }
          hierarchy.push({
            id: child.id,
            title: child.title,
            subfolders,
            parentRootTitle:
              rootChild.title || (rootChild.id === "1" ? "Bookmarks Bar" : "Other Bookmarks")
          });
        }
      }

      hierarchy.push({
        id: rootChild.id,
        title: rootChild.title || (rootChild.id === "1" ? "Bookmarks Bar" : "Other Bookmarks"),
        subfolders: [],
        isRoot: true
      });
    }

    return hierarchy;
  }

  /** 显示右上角浮动带图标 Toast 通知 */
  function showToast(msg, isError = false) {
    const alertEl = document.getElementById("toastAlert");
    const iconSvg = isError
      ? `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`
      : `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
    alertEl.innerHTML = `${iconSvg}<span>${MarkFlowEngine.escapeHtml(msg)}</span>`;
    alertEl.className = `toast-alert ${isError ? "toast-error" : "toast-success"}`;
    alertEl.classList.remove("hidden");

    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      alertEl.classList.add("hidden");
    }, 3800);
  }

  /** 弹出应用内确认对话框，返回 Promise<boolean> */
  function showConfirmModal(title, message) {
    return new Promise(resolve => {
      const modal = document.getElementById("confirmModal");
      const titleEl = document.getElementById("confirmModalTitle");
      const msgEl = document.getElementById("confirmModalMessage");
      const btnOk = document.getElementById("btnConfirmOk");
      const btnCancel = document.getElementById("btnConfirmCancel");

      titleEl.textContent = title;
      msgEl.textContent = message;
      modal.classList.remove("hidden");

      const cleanup = result => {
        modal.classList.add("hidden");
        btnOk.removeEventListener("click", onOk);
        btnCancel.removeEventListener("click", onCancel);
        modal.removeEventListener("click", onBackdrop);
        resolve(result);
      };

      const onOk = () => cleanup(true);
      const onCancel = () => cleanup(false);
      const onBackdrop = e => {
        if (e.target === modal) cleanup(false);
      };

      btnOk.addEventListener("click", onOk);
      btnCancel.addEventListener("click", onCancel);
      modal.addEventListener("click", onBackdrop);
    });
  }

  global.MarkFlowOptions = {
    DEFAULT_PROVIDERS,
    appState,
    t,
    loadState,
    parseFolderStructures,
    showToast,
    showConfirmModal
  };
})(window);
