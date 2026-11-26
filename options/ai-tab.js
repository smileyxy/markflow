/**
 * AI 语义模型配置标签页模块
 *
 * 支持各服务商独立持久化切换、推荐模型快捷胶囊选择、在线拉取可用模型列表以及接口连通测试。
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { DEFAULT_PROVIDERS, appState, t, showToast, formatFriendlyAiError } = ctx;
  const { escapeHtml } = MarkFlowEngine;

  function hasPermissionsApi() {
    return typeof chrome !== "undefined" && chrome.permissions;
  }

  async function hasOptionalOriginPermission(originPattern) {
    if (!originPattern || !hasPermissionsApi() || typeof chrome.permissions.contains !== "function") {
      return true;
    }
    try {
      return await chrome.permissions.contains({ origins: [originPattern] });
    } catch (e) {
      return false;
    }
  }

  async function requestOptionalOriginPermission(originPattern) {
    if (!originPattern || !hasPermissionsApi() || typeof chrome.permissions.request !== "function") {
      return true;
    }
    try {
      return await chrome.permissions.request({ origins: [originPattern] });
    } catch (e) {
      return false;
    }
  }

  async function revokeAllVertexPriorityPermissions() {
    if (!hasPermissionsApi() || typeof chrome.permissions.remove !== "function") return;
    const origins = Array.isArray(MarkFlowEngine.VERTEX_PRIORITY_OFFICIAL_ORIGINS)
      ? MarkFlowEngine.VERTEX_PRIORITY_OFFICIAL_ORIGINS
      : [];
    if (origins.length === 0) return;
    try {
      const granted = [];
      for (const origin of origins) {
        if (await hasOptionalOriginPermission(origin)) {
          granted.push(origin);
        }
      }
      if (granted.length > 0) {
        await chrome.permissions.remove({ origins: granted });
      }
    } catch (e) {}
  }

  async function ensureVertexPriorityPermissionForUrl(baseUrl) {
    const info = MarkFlowEngine.getVertexPriorityOriginInfo(baseUrl);
    if (!info.supported) {
      showToast(t("ai_toast_vertex_priority_region"), true);
      return false;
    }
    if (info.isOfficialGoogle && info.originPattern) {
      const already = await hasOptionalOriginPermission(info.originPattern);
      if (!already) {
        const granted = await requestOptionalOriginPermission(info.originPattern);
        if (!granted) {
          showToast(t("ai_toast_vertex_priority_denied"), true);
          return false;
        }
      }
    }
    return true;
  }

  function initAiTab() {
    const chkAiEnabled = document.getElementById("chkAiEnabled");
    const inputBaseUrl = document.getElementById("inputBaseUrl");
    const inputApiKey = document.getElementById("inputApiKey");
    const inputModel = document.getElementById("inputModel");
    const chkVertexPriority = document.getElementById("chkVertexPriority");
    const btnToggleKeyGuide = document.getElementById("btnToggleKeyGuide");
    const btnCloseKeyGuide = document.getElementById("btnCloseKeyGuide");
    const apiKeyGuidePanel = document.getElementById("apiKeyGuidePanel");
    const btnVertexPriorityTip = document.getElementById("btnVertexPriorityTip");
    const vertexPriorityTipWrap = document.getElementById("vertexPriorityTipWrap");
    const presetBtns = document.querySelectorAll(".preset-btn");

    const setPriorityTipOpen = open => {
      if (!vertexPriorityTipWrap) return;
      vertexPriorityTipWrap.classList.toggle("is-open", Boolean(open));
      if (btnVertexPriorityTip) {
        btnVertexPriorityTip.setAttribute("aria-expanded", open ? "true" : "false");
      }
    };

    chkAiEnabled.checked = !!appState.aiConfig.enabled;

    const currentProvider = appState.aiConfig.provider || "deepseek";
    const activeConfig =
      appState.aiConfig.providers[currentProvider] || DEFAULT_PROVIDERS[currentProvider];

    inputBaseUrl.value = activeConfig.baseUrl || "";
    inputApiKey.value = activeConfig.apiKey || "";
    inputModel.value = activeConfig.model || "";
    if (chkVertexPriority) {
      chkVertexPriority.checked = Boolean(
        appState.aiConfig.providers.gemini && appState.aiConfig.providers.gemini.vertexPriority
      );
      if (currentProvider === "gemini" && chkVertexPriority.checked) {
        const info = MarkFlowEngine.getVertexPriorityOriginInfo(inputBaseUrl.value.trim());
        if (!info.supported) {
          chkVertexPriority.checked = false;
          appState.aiConfig.providers.gemini.vertexPriority = false;
        } else if (info.isOfficialGoogle && info.originPattern) {
          hasOptionalOriginPermission(info.originPattern).then(granted => {
            if (!granted) {
              chkVertexPriority.checked = false;
              if (appState.aiConfig.providers.gemini) {
                appState.aiConfig.providers.gemini.vertexPriority = false;
              }
              syncVertexPriorityActiveHint();
            }
          });
        }
      }
    }

    updateProviderUiMeta(currentProvider);
    syncVertexPriorityActiveHint();

    if (btnToggleKeyGuide && apiKeyGuidePanel) {
      btnToggleKeyGuide.addEventListener("click", () => {
        setPriorityTipOpen(false);
        setKeyGuideOpen(true);
      });
    }

    if (btnCloseKeyGuide) {
      btnCloseKeyGuide.addEventListener("click", () => setKeyGuideOpen(false));
    }

    if (apiKeyGuidePanel) {
      apiKeyGuidePanel.addEventListener("click", e => {
        if (e.target === apiKeyGuidePanel) {
          setKeyGuideOpen(false);
        }
      });
    }

    if (btnVertexPriorityTip && vertexPriorityTipWrap) {
      btnVertexPriorityTip.addEventListener("click", e => {
        e.stopPropagation();
        const nextOpen = !vertexPriorityTipWrap.classList.contains("is-open");
        setPriorityTipOpen(nextOpen);
      });
    }

    document.addEventListener("click", e => {
      if (vertexPriorityTipWrap && !vertexPriorityTipWrap.contains(e.target)) {
        setPriorityTipOpen(false);
      }
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        setKeyGuideOpen(false);
        setPriorityTipOpen(false);
      }
    });

    if (chkVertexPriority) {
      chkVertexPriority.addEventListener("change", async () => {
        if (!appState.aiConfig.providers.gemini) {
          appState.aiConfig.providers.gemini = Object.assign({}, DEFAULT_PROVIDERS.gemini);
        }
        if (chkVertexPriority.checked) {
          const ok = await ensureVertexPriorityPermissionForUrl(inputBaseUrl.value.trim());
          if (!ok) {
            chkVertexPriority.checked = false;
            appState.aiConfig.providers.gemini.vertexPriority = false;
            syncVertexPriorityActiveHint();
            return;
          }
          appState.aiConfig.providers.gemini.vertexPriority = true;
        } else {
          appState.aiConfig.providers.gemini.vertexPriority = false;
          if (!appState.savedGeminiVertexPriority) {
            await revokeAllVertexPriorityPermissions();
          }
        }
        syncVertexPriorityActiveHint();
      });
    }

    presetBtns.forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-provider") === currentProvider);

      btn.addEventListener("click", () => {
        const targetProvider = btn.getAttribute("data-provider");
        const prevProvider = appState.aiConfig.provider;

        // 切换前暂存当前输入框内的配置到对应服务商槽位，避免切回时丢失
        if (prevProvider && appState.aiConfig.providers[prevProvider]) {
          appState.aiConfig.providers[prevProvider].baseUrl = inputBaseUrl.value.trim();
          appState.aiConfig.providers[prevProvider].apiKey = inputApiKey.value.trim();
          appState.aiConfig.providers[prevProvider].model = inputModel.value.trim();
          if (prevProvider === "gemini" && chkVertexPriority) {
            appState.aiConfig.providers[prevProvider].vertexPriority = Boolean(
              chkVertexPriority.checked
            );
          }
        }

        appState.aiConfig.provider = targetProvider;
        presetBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const nextCfg =
          appState.aiConfig.providers[targetProvider] || DEFAULT_PROVIDERS[targetProvider];
        inputBaseUrl.value = nextCfg.baseUrl || "";
        inputApiKey.value = nextCfg.apiKey || "";
        inputModel.value = nextCfg.model || "";
        if (chkVertexPriority && targetProvider === "gemini") {
          chkVertexPriority.checked = Boolean(nextCfg.vertexPriority);
        }

        setKeyGuideOpen(false);
        setPriorityTipOpen(false);
        document.getElementById("modelPickerModal").classList.add("hidden");
        updateProviderUiMeta(targetProvider);
      });
    });

    inputBaseUrl.addEventListener("input", () => {
      const val = inputBaseUrl.value.trim();
      syncActiveEndpointChip(val);
      syncVertexPriorityUi(appState.aiConfig.provider || "deepseek", val);
      syncApiKeyGuideUi(appState.aiConfig.provider || "deepseek", val);
    });
    inputModel.addEventListener("input", () => syncActiveModelChip(inputModel.value.trim()));

    document.getElementById("btnToggleApiKey").addEventListener("click", () => {
      inputApiKey.type = inputApiKey.type === "password" ? "text" : "password";
    });

    async function fetchAndStoreModels({ provider, baseUrl, apiKey, currentModel = "", forceRefresh = false }) {
      const cacheKey = `${provider}|${baseUrl}|${apiKey}`;
      if (!forceRefresh && appState.fetchedModelsCacheKey === cacheKey && appState.fetchedModelIds.length > 0) {
        return {
          models: appState.fetchedModelIds,
          fromCache: true,
          isFallbackCatalog: appState.fetchedModelsIsFallback,
          isVertexProbed: appState.fetchedModelsIsProbed
        };
      }

      const models = await MarkFlowEngine.fetchAvailableModels({
        provider,
        baseUrl,
        apiKey,
        currentModel,
        extraModels: appState.customVertexModels || []
      });
      if (!models.length) {
        return {
          models: [],
          fromCache: false,
          isFallbackCatalog: false,
          isVertexProbed: false
        };
      }

      appState.fetchedModelIds = models;
      appState.fetchedModelsCacheKey = cacheKey;
      appState.fetchedModelsIsFallback = Boolean(models.isFallbackCatalog);
      appState.fetchedModelsIsProbed = Boolean(models.isVertexProbed);
      return {
        models,
        fromCache: false,
        isFallbackCatalog: appState.fetchedModelsIsFallback,
        isVertexProbed: appState.fetchedModelsIsProbed
      };
    }

    function openModelPickerModal() {
      const modal = document.getElementById("modelPickerModal");
      const titleEl = document.getElementById("modelPickerTitle");
      const totalBadge = document.getElementById("modelPickerTotalBadge");
      const searchInput = document.getElementById("modelPickerSearch");
      const clearBtn = document.getElementById("btnClearModelSearch");
      const providerKey = appState.aiConfig.provider || "deepseek";
      const preset =
        MarkFlowEngine.PROVIDER_PRESETS[providerKey] || MarkFlowEngine.PROVIDER_PRESETS.deepseek;

      if (titleEl) {
        titleEl.textContent = `${t("ai_picker_title")} · ${preset.name}`;
      }
      if (totalBadge) {
        totalBadge.textContent = String(appState.fetchedModelIds.length);
      }
      if (searchInput) searchInput.value = "";
      if (clearBtn) clearBtn.classList.add("hidden");

      const { entries, groups } = buildModelPickerGroups(
        appState.fetchedModelIds,
        t("ai_picker_other")
      );
      const currentVal = inputModel.value.trim();
      const matchedEntry = currentVal ? entries.find(e => e.id === currentVal) : null;
      const targetGroupKey = matchedEntry ? matchedEntry.displayGroupKey : "ALL";
      const hasGroup = groups.some(g => g.key === targetGroupKey);
      appState.modelPickerActiveGroup = hasGroup ? targetGroupKey : "ALL";

      modal.classList.remove("hidden");
      renderModelPickerModal();

      const selectedEl = document.querySelector("#modelPickerList .model-picker-item.is-selected");
      if (selectedEl && typeof selectedEl.scrollIntoView === "function") {
        selectedEl.scrollIntoView({ block: "nearest" });
      }
      if (searchInput) searchInput.focus();
    }

    function closeModelPickerModal() {
      const modal = document.getElementById("modelPickerModal");
      if (modal) modal.classList.add("hidden");
    }

    const resolveModelsToast = result => {
      if (result.isVertexProbed) {
        return t("ai_toast_vertex_probed", { count: result.models.length });
      }
      if (result.isFallbackCatalog) {
        return t("ai_toast_vertex_catalog", { count: result.models.length });
      }
      return t("ai_toast_fetched", { count: result.models.length });
    };

    document.getElementById("btnFetchModels").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "deepseek";
      const baseUrl = inputBaseUrl.value.trim();
      const apiKey = inputApiKey.value.trim();
      const currentModel = inputModel.value.trim();

      if (!baseUrl || (!apiKey && provider !== "ollama")) {
        showToast(t("ai_toast_need_url_key"), true);
        return;
      }

      const fetchBtn = document.getElementById("btnFetchModels");
      fetchBtn.disabled = true;
      fetchBtn.classList.add("is-spinning");

      try {
        const result = await fetchAndStoreModels({
          provider,
          baseUrl,
          apiKey,
          currentModel,
          forceRefresh: false
        });
        if (!result.models.length) {
          showToast(t("ai_toast_no_models"), true);
          return;
        }
        openModelPickerModal();
        if (!result.fromCache) {
          showToast(resolveModelsToast(result));
        }
      } catch (err) {
        showToast(t("ai_toast_fetch_err", { msg: formatFriendlyAiError(err) }), true);
      } finally {
        fetchBtn.disabled = false;
        fetchBtn.classList.remove("is-spinning");
      }
    });

    document.getElementById("btnRefreshModels").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "deepseek";
      const baseUrl = inputBaseUrl.value.trim();
      const apiKey = inputApiKey.value.trim();
      const currentModel = inputModel.value.trim();

      if (!baseUrl || (!apiKey && provider !== "ollama")) {
        showToast(t("ai_toast_need_url_key"), true);
        return;
      }

      const refreshBtn = document.getElementById("btnRefreshModels");
      refreshBtn.disabled = true;
      refreshBtn.classList.add("is-spinning");

      try {
        const result = await fetchAndStoreModels({
          provider,
          baseUrl,
          apiKey,
          currentModel,
          forceRefresh: true
        });
        if (!result.models.length) {
          showToast(t("ai_toast_no_models"), true);
          return;
        }
        const totalBadge = document.getElementById("modelPickerTotalBadge");
        if (totalBadge) totalBadge.textContent = String(result.models.length);
        renderModelPickerModal();
        showToast(resolveModelsToast(result));
      } catch (err) {
        showToast(t("ai_toast_fetch_err", { msg: formatFriendlyAiError(err) }), true);
      } finally {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove("is-spinning");
      }
    });

    const searchInput = document.getElementById("modelPickerSearch");
    const clearSearchBtn = document.getElementById("btnClearModelSearch");
    if (searchInput) {
      searchInput.addEventListener("input", () => {
        renderModelPickerModal();
      });
    }
    if (clearSearchBtn) {
      clearSearchBtn.addEventListener("click", () => {
        if (searchInput) {
          searchInput.value = "";
          searchInput.focus();
        }
        renderModelPickerModal();
      });
    }

    document.getElementById("btnCloseModelPicker").addEventListener("click", closeModelPickerModal);
    document.getElementById("modelPickerModal").addEventListener("click", e => {
      if (e.target && e.target.id === "modelPickerModal") {
        closeModelPickerModal();
      }
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape") {
        const modal = document.getElementById("modelPickerModal");
        if (modal && !modal.classList.contains("hidden")) {
          closeModelPickerModal();
        }
      }
    });

    document.getElementById("btnSaveAI").addEventListener("click", async () => {
      const curProvider = appState.aiConfig.provider || "deepseek";
      const baseUrl = inputBaseUrl.value.trim();
      const apiKey = inputApiKey.value.trim();
      const model = inputModel.value.trim();
      let vertexPriority =
        curProvider === "gemini" && chkVertexPriority ? Boolean(chkVertexPriority.checked) : false;

      if (vertexPriority && MarkFlowEngine.isVertexAiUrl(baseUrl)) {
        const permitted = await ensureVertexPriorityPermissionForUrl(baseUrl);
        if (!permitted) {
          if (chkVertexPriority) chkVertexPriority.checked = false;
          vertexPriority = false;
          if (appState.aiConfig.providers.gemini) {
            appState.aiConfig.providers.gemini.vertexPriority = false;
          }
          syncVertexPriorityActiveHint();
          return;
        }
      }

      appState.aiConfig.enabled = chkAiEnabled.checked;

      if (!appState.aiConfig.providers) appState.aiConfig.providers = {};
      appState.aiConfig.providers[curProvider] = {
        baseUrl,
        apiKey,
        model,
        vertexPriority
      };

      appState.aiConfig.baseUrl = baseUrl;
      appState.aiConfig.apiKey = apiKey;
      appState.aiConfig.model = model;
      appState.aiConfig.vertexPriority = vertexPriority;

      await chrome.storage.local.set({ aiConfig: appState.aiConfig });
      appState.savedGeminiVertexPriority = Boolean(
        appState.aiConfig.providers.gemini && appState.aiConfig.providers.gemini.vertexPriority
      );
      if (!appState.savedGeminiVertexPriority) {
        await revokeAllVertexPriorityPermissions();
      }
      if (ctx.updateReorgTokenEstimate) ctx.updateReorgTokenEstimate();
      showToast(t("ai_toast_saved"));
    });

    document.getElementById("btnTestAI").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "deepseek";
      const baseUrl = inputBaseUrl.value.trim();
      const apiKey = inputApiKey.value.trim();
      const model = inputModel.value.trim();
      const useVertexPriority = Boolean(
        provider === "gemini" &&
          MarkFlowEngine.isVertexAiUrl(baseUrl) &&
          chkVertexPriority &&
          chkVertexPriority.checked
      );

      if (!baseUrl || !model || (!apiKey && provider !== "ollama")) {
        showToast(t("ai_toast_need_all"), true);
        return;
      }

      if (useVertexPriority) {
        const permitted = await ensureVertexPriorityPermissionForUrl(baseUrl);
        if (!permitted) {
          if (chkVertexPriority) chkVertexPriority.checked = false;
          if (appState.aiConfig.providers.gemini) {
            appState.aiConfig.providers.gemini.vertexPriority = false;
          }
          syncVertexPriorityActiveHint();
          return;
        }
      }

      const testBtn = document.getElementById("btnTestAI");
      testBtn.disabled = true;
      testBtn.querySelector("span").textContent = t("btn_test_ai_loading");

      try {
        let trafficType = "";
        await MarkFlowEngine.testAIConnection({
          provider,
          baseUrl,
          apiKey,
          model,
          vertexPriority: useVertexPriority,
          onMeta: meta => {
            trafficType = (meta && meta.trafficType) || "";
          }
        });
        if (useVertexPriority && trafficType === "ON_DEMAND_PRIORITY") {
          showToast(t("ai_toast_test_ok_priority"));
        } else {
          showToast(t("ai_toast_test_ok"));
        }
      } catch (err) {
        showToast(t("ai_toast_test_err", { msg: formatFriendlyAiError(err) }), true);
      } finally {
        testBtn.disabled = false;
        testBtn.querySelector("span").textContent = t("btn_test_ai");
      }
    });
  }

  function resolveApiKeyGuideContext(providerKey, baseUrl) {
    const preset =
      MarkFlowEngine.PROVIDER_PRESETS[providerKey] || MarkFlowEngine.PROVIDER_PRESETS.deepseek;
    const guide = preset && preset.keyGuide;
    if (!guide) {
      return { entry: null, displayName: preset ? preset.name : "" };
    }
    if (providerKey === "gemini") {
      if (MarkFlowEngine.isVertexAiUrl(baseUrl)) {
        if (/\/projects\/[^/]+\/locations\/[^/]+/i.test(baseUrl || "")) {
          return {
            entry: guide.vertexProject || guide.vertexExpress || guide.default,
            displayName: "Vertex AI Project"
          };
        }
        return {
          entry: guide.vertexExpress || guide.default,
          displayName: "Vertex AI Express"
        };
      }
      return { entry: guide.default, displayName: "Gemini API" };
    }
    return { entry: guide, displayName: preset.name };
  }

  /** 将包含反引号代码片段的指引文本安全渲染为普通文本与等宽高亮/可复制芯片 */
  function appendFormattedGuideText(container, text) {
    const parts = String(text || "").split(/(`[^`]+`)/g);
    for (const part of parts) {
      if (!part) continue;
      if (part.startsWith("`") && part.endsWith("`") && part.length >= 2) {
        const code = part.slice(1, -1);
        const isCopyable = /^(?:ollama\s+pull\b|OLLAMA_ORIGINS=)/i.test(code);
        if (isCopyable) {
          const copyBtn = document.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "key-guide-code is-copyable";
          copyBtn.title = t("ai_guide_copy_hint");
          copyBtn.textContent = code;
          copyBtn.addEventListener("click", async () => {
            try {
              if (navigator.clipboard && navigator.clipboard.writeText) {
                await navigator.clipboard.writeText(code);
              }
            } catch (e) {}
            showToast(t("ai_toast_copied", { text: code }));
          });
          container.appendChild(copyBtn);
        } else {
          const codeEl = document.createElement("code");
          codeEl.className = "key-guide-code";
          codeEl.textContent = code;
          container.appendChild(codeEl);
        }
      } else {
        container.appendChild(document.createTextNode(part));
      }
    }
  }

  function syncVertexPriorityActiveHint() {
    const row = document.getElementById("vertexPriorityRow");
    const chk = document.getElementById("chkVertexPriority");
    const pill = document.getElementById("vertexPriorityPill");
    const hintEl = document.getElementById("vertexPriorityActiveHint");
    const checked = Boolean(chk && chk.checked);
    const rowVisible = Boolean(row && !row.classList.contains("hidden"));
    if (pill) pill.classList.toggle("is-active", checked);
    if (hintEl) hintEl.classList.toggle("hidden", !(rowVisible && checked));
  }

  function setKeyGuideOpen(open) {
    const panel = document.getElementById("apiKeyGuidePanel");
    if (panel) panel.classList.toggle("hidden", !open);
  }

  function syncVertexPriorityUi(providerKey, baseUrl) {
    const row = document.getElementById("vertexPriorityRow");
    if (!row) return;
    const isGeminiVertex = providerKey === "gemini" && MarkFlowEngine.isVertexAiUrl(baseUrl);
    row.classList.toggle("hidden", !isGeminiVertex);
    syncVertexPriorityActiveHint();
  }

  function syncApiKeyGuideUi(providerKey, baseUrl) {
    const triggerTextEl = document.getElementById("btnToggleKeyGuideText");
    const portalEl = document.getElementById("linkGuidePortal");
    const portalTextEl = document.getElementById("linkGuidePortalText");
    const titleEl = document.getElementById("apiKeyGuideTitle");
    const stepsEl = document.getElementById("apiKeyGuideSteps");
    const { entry, displayName } = resolveApiKeyGuideContext(providerKey, baseUrl);

    if (triggerTextEl) {
      triggerTextEl.textContent =
        entry && entry.url
          ? t(entry.linkLabelKey || "ai_btn_get_key")
          : t("ai_btn_key_guide");
    }

    if (portalEl && portalTextEl) {
      if (entry && entry.url) {
        portalEl.href = entry.url;
        portalTextEl.textContent = t(entry.linkLabelKey || "ai_btn_get_key");
        portalEl.classList.remove("hidden");
      } else {
        portalEl.classList.add("hidden");
      }
    }

    if (titleEl) {
      titleEl.textContent = t("ai_guide_panel_title", { name: displayName || "" });
    }

    if (stepsEl) {
      stepsEl.innerHTML = "";
      const rawSteps = entry && entry.stepsKey ? t(entry.stepsKey) : "";
      const lines = String(rawSteps || "")
        .split("\n")
        .map(line => line.replace(/^\d+\.\s*/, "").trim())
        .filter(Boolean);

      lines.forEach((line, idx) => {
        const row = document.createElement("div");
        row.className = "key-guide-step-row";
        row.setAttribute("role", "listitem");

        const sepIdx = line.indexOf("::");
        const stepTitle = sepIdx !== -1 ? line.slice(0, sepIdx).trim() : "";
        const stepBody = sepIdx !== -1 ? line.slice(sepIdx + 2).trim() : line;

        const badge = document.createElement("span");
        badge.className = "key-guide-step-num";
        badge.textContent = String(idx + 1);
        row.appendChild(badge);

        const content = document.createElement("div");
        content.className = "key-guide-step-content";

        if (stepTitle) {
          const titleSpan = document.createElement("div");
          titleSpan.className = "key-guide-step-title";
          titleSpan.textContent = stepTitle;
          content.appendChild(titleSpan);
        }

        const body = document.createElement("p");
        body.className = "key-guide-step-body";
        appendFormattedGuideText(body, stepBody);
        content.appendChild(body);

        row.appendChild(content);
        stepsEl.appendChild(row);
      });
    }
  }

  function updateProviderUiMeta(providerKey) {
    const preset =
      MarkFlowEngine.PROVIDER_PRESETS[providerKey] || MarkFlowEngine.PROVIDER_PRESETS.deepseek;
    const inputBaseUrl = document.getElementById("inputBaseUrl");
    const inputApiKey = document.getElementById("inputApiKey");
    const inputModel = document.getElementById("inputModel");
    const baseUrlHint = document.getElementById("baseUrlHint");
    const epContainer = document.getElementById("endpointQuickChipsContainer");
    const epList = document.getElementById("endpointQuickChips");
    const chipsContainer = document.getElementById("modelQuickChipsContainer");
    const chipsList = document.getElementById("modelQuickChips");

    inputBaseUrl.placeholder = preset.baseUrl || "https://api.example.com/v1";
    inputApiKey.placeholder = preset.keyPlaceholder || "sk-...";
    inputModel.placeholder = preset.model || "model-id";

    if (baseUrlHint) {
      const hintKey = preset.urlHintKey || "ai_base_url_hint";
      baseUrlHint.setAttribute("data-i18n", hintKey);
      baseUrlHint.textContent = t(hintKey);
    }

    if (epContainer && epList) {
      epList.innerHTML = "";
      if (preset.quickEndpoints && preset.quickEndpoints.length > 0) {
        preset.quickEndpoints.forEach(ep => {
          const chip = document.createElement("button");
          chip.type = "button";
          chip.className = "model-chip-btn";
          chip.textContent = ep.label;
          chip.dataset.url = ep.url;
          chip.addEventListener("click", () => {
            inputBaseUrl.value = ep.url;
            syncActiveEndpointChip(ep.url);
            syncVertexPriorityUi(providerKey, ep.url);
            syncApiKeyGuideUi(providerKey, ep.url);
            const phIdx = ep.url.indexOf("PROJECT_ID");
            if (phIdx !== -1) {
              inputBaseUrl.focus();
              inputBaseUrl.setSelectionRange(phIdx, phIdx + "PROJECT_ID".length);
            }
          });
          epList.appendChild(chip);
        });
        syncActiveEndpointChip(inputBaseUrl.value.trim());
        epContainer.classList.remove("hidden");
      } else {
        epContainer.classList.add("hidden");
      }
    }

    syncVertexPriorityUi(providerKey, inputBaseUrl.value.trim());
    syncApiKeyGuideUi(providerKey, inputBaseUrl.value.trim());

    chipsList.innerHTML = "";
    if (preset.quickModels && preset.quickModels.length > 0) {
      const currentModelVal = inputModel.value.trim();
      preset.quickModels.forEach(entry => {
        const modelId = typeof entry === "string" ? entry : entry.id;
        const chip = document.createElement("button");
        chip.type = "button";
        chip.dataset.modelId = modelId;
        chip.className = "model-chip-btn" + (currentModelVal === modelId ? " active" : "");
        chip.textContent = modelId;
        chip.addEventListener("click", () => {
          inputModel.value = modelId;
          syncActiveModelChip(modelId);
        });
        chipsList.appendChild(chip);
      });
      chipsContainer.classList.remove("hidden");
    } else {
      chipsContainer.classList.add("hidden");
    }
  }

  function syncActiveEndpointChip(currentUrl) {
    const normalized = (currentUrl || "").trim().replace(/\/+$/, "");
    document.querySelectorAll("#endpointQuickChips .model-chip-btn").forEach(btn => {
      const targetUrl = (btn.dataset.url || "").replace(/\/+$/, "");
      let isMatch = normalized === targetUrl;
      if (!isMatch && targetUrl.includes("PROJECT_ID")) {
        isMatch = /\/projects\/[^/]+\/locations\/[^/]+/i.test(normalized);
      }
      btn.classList.toggle("active", isMatch);
    });
  }

  const VENDOR_ALIASES = {
    "deepseek-ai": "DeepSeek",
    deepseek: "DeepSeek",
    qwen: "Qwen",
    alibaba: "Qwen",
    "zai-org": "GLM (Zhipu)",
    thudm: "GLM (Zhipu)",
    "z-ai": "GLM (Zhipu)",
    zhipu: "GLM (Zhipu)",
    zhipuai: "GLM (Zhipu)",
    google: "Google",
    anthropic: "Anthropic",
    openai: "OpenAI",
    "x-ai": "xAI",
    xai: "xAI",
    meta: "Meta Llama",
    "meta-llama": "Meta Llama",
    mistralai: "Mistral",
    mistral: "Mistral",
    moonshotai: "Moonshot",
    moonshot: "Moonshot",
    minimax: "MiniMax",
    minimaxai: "MiniMax",
    baidu: "Baidu",
    "baidu-ernie": "Baidu",
    bytedance: "ByteDance",
    "bytedance-seed": "ByteDance",
    doubao: "ByteDance",
    tencent: "Tencent",
    internlm: "InternLM",
    shanghai_ai_lab: "InternLM",
    stepfun: "StepFun",
    "stepfun-ai": "StepFun",
    cohere: "Cohere",
    cohereforai: "Cohere",
    nvidia: "NVIDIA",
    microsoft: "Microsoft",
    perplexity: "Perplexity",
    "01-ai": "01.AI",
    "baichuan-inc": "Baichuan",
    baichuan: "Baichuan",
    inclusionai: "InclusionAI",
    kwai: "Kwai",
    kwaipilot: "Kwai",
    nousresearch: "Nous Research",
    allenai: "AllenAI"
  };

  const GROUP_PRIORITY = [
    "DeepSeek",
    "Qwen",
    "GLM (Zhipu)",
    "Google",
    "Anthropic",
    "OpenAI",
    "xAI",
    "Meta Llama",
    "Mistral",
    "Moonshot",
    "MiniMax",
    "ByteDance",
    "Baidu",
    "Tencent"
  ];

  function resolveGroupSortTuple(key, itemCount) {
    const prioIdx = GROUP_PRIORITY.indexOf(key);
    if (prioIdx !== -1) {
      return [0, prioIdx, -itemCount];
    }
    let m;
    if ((m = /^Gemini (\d+(?:\.\d+)?)/i.exec(key))) {
      return [100, -parseFloat(m[1]), -itemCount];
    }
    if ((m = /^Claude(?: (\d+(?:\.\d+)?))?/i.exec(key))) {
      return [101, m[1] ? -parseFloat(m[1]) : 0, -itemCount];
    }
    if ((m = /^GPT-(\d+(?:\.\d+)?)/i.exec(key))) {
      return [102, -parseFloat(m[1]), -itemCount];
    }
    if (key === "o-Series") {
      return [103, 0, -itemCount];
    }
    if ((m = /^Grok (\d+(?:\.\d+)?)/i.exec(key))) {
      return [104, -parseFloat(m[1]), -itemCount];
    }
    return [999, 0, -itemCount];
  }

  /**
   * 识别通道前缀（如 Pro/、Free/、LoRA/）与后缀标签（:free / :thinking），
   * 剥离修饰前缀后归一化模型所属厂商与动态世代家族。
   */
  function parseModelEntry(rawId) {
    const id = String(rawId || "").trim();
    const badges = [];
    const seenBadges = new Set();

    const addBadge = (text, tone) => {
      const k = text.toLowerCase();
      if (!seenBadges.has(k)) {
        seenBadges.add(k);
        badges.push({ text, tone });
      }
    };

    let working = id;
    while (true) {
      const m = working.match(/^(Pro|LoRA|Free|Vendor-[A-Z0-9-]+)\/(.+)$/i);
      if (!m) break;
      const tag = m[1];
      working = m[2];
      if (/^pro$/i.test(tag)) addBadge("Pro", "pro");
      else if (/^free$/i.test(tag)) addBadge("Free", "free");
      else if (/^lora$/i.test(tag)) addBadge("LoRA", "neutral");
      else addBadge(tag, "neutral");
    }

    const colonIdx = working.lastIndexOf(":");
    if (colonIdx > 0) {
      const suffix = working.slice(colonIdx + 1).toLowerCase();
      if (/^(free|thinking|extended|beta)$/.test(suffix)) {
        working = working.slice(0, colonIdx);
        if (suffix === "free") addBadge("Free", "free");
        else if (suffix === "thinking") addBadge("Thinking", "reason");
        else if (suffix === "extended") addBadge("Extended", "neutral");
        else if (suffix === "beta") addBadge("Beta", "neutral");
      }
    }

    let groupKey = "__OTHER__";
    let shortName = working;

    if (working.includes("/")) {
      const slashIdx = working.indexOf("/");
      const vendorRaw = working.slice(0, slashIdx).toLowerCase();
      shortName = working.slice(working.lastIndexOf("/") + 1) || working;
      groupKey =
        VENDOR_ALIASES[vendorRaw] ||
        vendorRaw.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
    } else {
      const low = working.toLowerCase();
      let fm;
      if ((fm = /^gemini-(\d+(?:\.\d+)?)/i.exec(low))) {
        const ver = fm[1];
        const major = ver.split(".")[0];
        if (ver.startsWith("2.5")) groupKey = "Gemini 2.5";
        else if (major === "2") groupKey = "Gemini 2.0";
        else groupKey = `Gemini ${major}.x`;
      } else if ((fm = /^claude-(?:[a-z]+-)?(\d+)/i.exec(low))) {
        groupKey = `Claude ${fm[1]}.x`;
      } else if (/^claude/i.test(low)) {
        groupKey = "Claude";
      } else if ((fm = /^gpt-(\d+)/i.exec(low))) {
        groupKey = `GPT-${fm[1]}`;
      } else if (/^o[134](-|$)/i.test(low)) {
        groupKey = "o-Series";
      } else if ((fm = /^grok-(\d+)/i.exec(low))) {
        groupKey = `Grok ${fm[1]}`;
      } else if (/deepseek/i.test(low)) {
        groupKey = "DeepSeek";
      } else if (/qwen/i.test(low)) {
        groupKey = "Qwen";
      } else if (/(?:^|[-_])(glm|chatglm)/i.test(low)) {
        groupKey = "GLM (Zhipu)";
      } else if (/llama/i.test(low)) {
        groupKey = "Meta Llama";
      } else if (/ernie/i.test(low)) {
        groupKey = "Baidu";
      }
    }

    if (
      !seenBadges.has("thinking") &&
      /(?:^|[-_/])(r1|qwq|reasoner|thinking)(?:[-_./:]|$)|^o[134](?:-|$)/i.test(shortName)
    ) {
      addBadge("Reasoning", "reason");
    }
    if (/-preview(?:[-_./:]|$)/i.test(shortName)) {
      addBadge("Preview", "neutral");
    }

    const searchParts = [
      id,
      shortName,
      groupKey === "__OTHER__" ? "" : groupKey,
      ...badges.map(b => b.text)
    ];

    return {
      id,
      displayName: shortName || id,
      groupKey,
      displayGroupKey: groupKey,
      badges,
      searchText: searchParts.join(" ").toLowerCase()
    };
  }

  /**
   * 按厂商与热门程度整理模型分组；当分组数超过 10 个时，将排名 10 之后仅 1 条模型的冷门厂商归入「其他」。
   */
  function buildModelPickerGroups(rawIds, otherLabel = "Other") {
    const entries = (Array.isArray(rawIds) ? rawIds : []).map(parseModelEntry);
    const groupMap = new Map();

    for (const entry of entries) {
      if (!groupMap.has(entry.groupKey)) {
        groupMap.set(entry.groupKey, []);
      }
      groupMap.get(entry.groupKey).push(entry);
    }

    const rawOther = groupMap.get("__OTHER__") || [];
    groupMap.delete("__OTHER__");

    const nonOtherGroups = Array.from(groupMap.entries()).map(([key, items]) => ({
      key,
      label: key,
      items
    }));

    nonOtherGroups.sort((a, b) => {
      const ta = resolveGroupSortTuple(a.key, a.items.length);
      const tb = resolveGroupSortTuple(b.key, b.items.length);
      for (let i = 0; i < ta.length; i++) {
        if (ta[i] !== tb[i]) return ta[i] - tb[i];
      }
      return a.key.localeCompare(b.key);
    });

    const groups = [];
    const otherBucket = [...rawOther];
    const shouldFoldTail = nonOtherGroups.length > 10;

    nonOtherGroups.forEach((grp, idx) => {
      if (shouldFoldTail && idx >= 10 && grp.items.length === 1) {
        otherBucket.push(...grp.items);
      } else {
        grp.items.forEach(item => {
          item.displayGroupKey = grp.key;
        });
        groups.push(grp);
      }
    });

    if (otherBucket.length > 0) {
      otherBucket.forEach(item => {
        item.displayGroupKey = "__OTHER__";
      });
      groups.push({
        key: "__OTHER__",
        label: otherLabel || "Other",
        items: otherBucket
      });
    }

    return { entries, groups };
  }

  function renderModelPickerModal() {
    const sidebarEl = document.getElementById("modelPickerGroups");
    const listEl = document.getElementById("modelPickerList");
    const searchInput = document.getElementById("modelPickerSearch");
    const clearBtn = document.getElementById("btnClearModelSearch");
    const inputModel = document.getElementById("inputModel");
    if (!sidebarEl || !listEl) return;

    const q = (searchInput ? searchInput.value : "").trim().toLowerCase();
    if (clearBtn) {
      clearBtn.classList.toggle("hidden", q.length === 0);
    }

    const { entries, groups } = buildModelPickerGroups(
      appState.fetchedModelIds,
      t("ai_picker_other")
    );
    const matchedEntries = entries.filter(item => !q || item.searchText.includes(q));

    const matchedByGroup = new Map();
    for (const item of matchedEntries) {
      const k = item.displayGroupKey;
      if (!matchedByGroup.has(k)) matchedByGroup.set(k, []);
      matchedByGroup.get(k).push(item);
    }

    const visibleGroups = groups
      .map(grp => ({
        key: grp.key,
        label: grp.label,
        filteredItems: matchedByGroup.get(grp.key) || []
      }))
      .filter(grp => q.length === 0 || grp.filteredItems.length > 0);

    if (
      appState.modelPickerActiveGroup !== "ALL" &&
      !visibleGroups.some(g => g.key === appState.modelPickerActiveGroup)
    ) {
      appState.modelPickerActiveGroup = "ALL";
    }

    const sidebarFrag = document.createDocumentFragment();
    const makeGroupBtn = (key, label, count) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "model-picker-group-btn" + (appState.modelPickerActiveGroup === key ? " is-active" : "");
      btn.innerHTML = `<span class="model-picker-group-name">${escapeHtml(label)}</span><span class="model-picker-group-count">${count}</span>`;
      btn.addEventListener("click", () => {
        appState.modelPickerActiveGroup = key;
        renderModelPickerModal();
        listEl.scrollTop = 0;
      });
      return btn;
    };

    sidebarFrag.appendChild(makeGroupBtn("ALL", t("ai_picker_all"), matchedEntries.length));
    for (const grp of visibleGroups) {
      sidebarFrag.appendChild(makeGroupBtn(grp.key, grp.label, grp.filteredItems.length));
    }
    sidebarEl.replaceChildren(sidebarFrag);

    const activeGroupObj =
      appState.modelPickerActiveGroup === "ALL"
        ? null
        : visibleGroups.find(g => g.key === appState.modelPickerActiveGroup);
    const itemsToRender = activeGroupObj ? activeGroupObj.filteredItems : matchedEntries;

    const currentVal = inputModel ? inputModel.value.trim() : "";
    const listFrag = document.createDocumentFragment();

    if (itemsToRender.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "model-picker-empty";
      const emptyMsg = document.createElement("span");
      emptyMsg.textContent = t("ai_fetched_empty");
      emptyEl.appendChild(emptyMsg);

      const rawQuery = searchInput ? searchInput.value.trim() : "";
      const providerKey = appState.aiConfig.provider || "deepseek";
      const baseUrlInput = document.getElementById("inputBaseUrl");
      const apiKeyInput = document.getElementById("inputApiKey");
      const baseUrlVal = baseUrlInput ? baseUrlInput.value.trim() : "";
      const apiKeyVal = apiKeyInput ? apiKeyInput.value.trim() : "";

      if (rawQuery && MarkFlowEngine.detectProtocol(providerKey, baseUrlVal) === "vertex") {
        const probeBtn = document.createElement("button");
        probeBtn.type = "button";
        probeBtn.className = "model-picker-probe-btn";
        probeBtn.textContent = t("ai_picker_probe_custom", { model: rawQuery });
        probeBtn.addEventListener("click", async () => {
          probeBtn.disabled = true;
          try {
            const verifiedId = await MarkFlowEngine.probeSingleVertexModel({
              baseUrl: baseUrlVal,
              apiKey: apiKeyVal,
              modelId: rawQuery
            });
            if (!Array.isArray(appState.customVertexModels)) appState.customVertexModels = [];
            if (!appState.customVertexModels.includes(verifiedId)) {
              appState.customVertexModels.push(verifiedId);
              await chrome.storage.local.set({ customVertexModels: appState.customVertexModels });
            }
            if (!appState.fetchedModelIds.includes(verifiedId)) {
              appState.fetchedModelIds = [verifiedId, ...appState.fetchedModelIds];
            }
            const totalBadge = document.getElementById("modelPickerTotalBadge");
            if (totalBadge) totalBadge.textContent = String(appState.fetchedModelIds.length);
            if (inputModel) inputModel.value = verifiedId;
            syncActiveModelChip(verifiedId);
            const modal = document.getElementById("modelPickerModal");
            if (modal) modal.classList.add("hidden");
            showToast(t("ai_toast_probe_custom_ok", { model: verifiedId }));
          } catch (err) {
            probeBtn.disabled = false;
            showToast(
              t("ai_toast_probe_custom_err", { model: rawQuery, msg: formatFriendlyAiError(err) }),
              true
            );
          }
        });
        emptyEl.appendChild(probeBtn);
      }

      listFrag.appendChild(emptyEl);
    } else {
      const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

      for (const entry of itemsToRender) {
        const isSelected = currentVal === entry.id;
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "model-picker-item" + (isSelected ? " is-selected" : "");

        const badgesHtml = entry.badges
          .map(b => `<span class="model-badge model-badge-${b.tone}">${escapeHtml(b.text)}</span>`)
          .join("");
        const selectedHtml = isSelected
          ? `<span class="model-picker-selected-tag">${checkSvg}<span>${escapeHtml(
              t("ai_picker_selected")
            )}</span></span>`
          : "";

        btn.innerHTML = `
          <div class="model-picker-item-main">
            <div class="model-picker-item-head">
              <span class="model-picker-item-name">${escapeHtml(entry.displayName)}</span>
              ${badgesHtml}
            </div>
            <span class="model-picker-item-id">${escapeHtml(entry.id)}</span>
          </div>
          ${selectedHtml}
        `;

        btn.addEventListener("click", () => {
          if (inputModel) inputModel.value = entry.id;
          syncActiveModelChip(entry.id);
          const modal = document.getElementById("modelPickerModal");
          if (modal) modal.classList.add("hidden");
        });
        listFrag.appendChild(btn);
      }
    }

    listEl.replaceChildren(listFrag);
  }

  function syncActiveModelChip(currentModelVal) {
    document.querySelectorAll("#modelQuickChips .model-chip-btn").forEach(btn => {
      const chipId = btn.dataset.modelId || btn.textContent;
      btn.classList.toggle("active", chipId === currentModelVal);
    });
  }

  ctx.initAiTab = initAiTab;
  ctx.updateProviderUiMeta = updateProviderUiMeta;
  ctx.parseModelEntry = parseModelEntry;
  ctx.buildModelPickerGroups = buildModelPickerGroups;
})(window);
