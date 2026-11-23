/**
 * AI 语义模型配置标签页模块
 *
 * 支持各服务商独立持久化切换、推荐模型快捷胶囊选择、在线拉取可用模型列表以及接口连通测试。
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { DEFAULT_PROVIDERS, appState, t, showToast } = ctx;
  const { escapeHtml } = MarkFlowEngine;

  function initAiTab() {
    const chkAiEnabled = document.getElementById("chkAiEnabled");
    const inputBaseUrl = document.getElementById("inputBaseUrl");
    const inputApiKey = document.getElementById("inputApiKey");
    const inputModel = document.getElementById("inputModel");
    const presetBtns = document.querySelectorAll(".preset-btn");

    chkAiEnabled.checked = !!appState.aiConfig.enabled;

    const currentProvider = appState.aiConfig.provider || "deepseek";
    const activeConfig =
      appState.aiConfig.providers[currentProvider] || DEFAULT_PROVIDERS[currentProvider];

    inputBaseUrl.value = activeConfig.baseUrl || "";
    inputApiKey.value = activeConfig.apiKey || "";
    inputModel.value = activeConfig.model || "";

    updateProviderUiMeta(currentProvider);

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
        }

        appState.aiConfig.provider = targetProvider;
        presetBtns.forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        const nextCfg =
          appState.aiConfig.providers[targetProvider] || DEFAULT_PROVIDERS[targetProvider];
        inputBaseUrl.value = nextCfg.baseUrl || "";
        inputApiKey.value = nextCfg.apiKey || "";
        inputModel.value = nextCfg.model || "";

        document.getElementById("fetchedModelsPanel").classList.add("hidden");
        updateProviderUiMeta(targetProvider);
      });
    });

    inputBaseUrl.addEventListener("input", () => syncActiveEndpointChip(inputBaseUrl.value.trim()));
    inputModel.addEventListener("input", () => syncActiveModelChip(inputModel.value.trim()));

    document.getElementById("btnToggleApiKey").addEventListener("click", () => {
      inputApiKey.type = inputApiKey.type === "password" ? "text" : "password";
    });

    document.getElementById("btnFetchModels").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "deepseek";
      const baseUrl = inputBaseUrl.value.trim();
      const apiKey = inputApiKey.value.trim();

      if (!baseUrl || (!apiKey && provider !== "ollama")) {
        showToast(t("ai_toast_need_url_key"), true);
        return;
      }

      const fetchBtn = document.getElementById("btnFetchModels");
      fetchBtn.disabled = true;

      try {
        const models = await MarkFlowEngine.fetchAvailableModels({ provider, baseUrl, apiKey });
        if (!models.length) {
          showToast(t("ai_toast_no_models"), true);
          return;
        }
        appState.fetchedModelIds = models;
        document.getElementById("fetchedModelsFilter").value = "";
        renderFetchedModelsList("");
        document.getElementById("fetchedModelsPanel").classList.remove("hidden");
        showToast(
          models.isFallbackCatalog
            ? t("ai_toast_vertex_catalog", { count: models.length })
            : t("ai_toast_fetched", { count: models.length })
        );
      } catch (err) {
        showToast(t("ai_toast_fetch_err", { msg: err.message }), true);
      } finally {
        fetchBtn.disabled = false;
      }
    });

    document.getElementById("fetchedModelsFilter").addEventListener("input", e => {
      renderFetchedModelsList(e.target.value);
    });

    document.getElementById("btnCloseFetchedModels").addEventListener("click", () => {
      document.getElementById("fetchedModelsPanel").classList.add("hidden");
    });

    document.getElementById("btnSaveAI").addEventListener("click", async () => {
      const curProvider = appState.aiConfig.provider || "deepseek";
      appState.aiConfig.enabled = chkAiEnabled.checked;

      if (!appState.aiConfig.providers) appState.aiConfig.providers = {};
      appState.aiConfig.providers[curProvider] = {
        baseUrl: inputBaseUrl.value.trim(),
        apiKey: inputApiKey.value.trim(),
        model: inputModel.value.trim()
      };

      appState.aiConfig.baseUrl = inputBaseUrl.value.trim();
      appState.aiConfig.apiKey = inputApiKey.value.trim();
      appState.aiConfig.model = inputModel.value.trim();

      await chrome.storage.local.set({ aiConfig: appState.aiConfig });
      if (ctx.updateReorgTokenEstimate) ctx.updateReorgTokenEstimate();
      showToast(t("ai_toast_saved"));
    });

    document.getElementById("btnTestAI").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "deepseek";
      const baseUrl = inputBaseUrl.value.trim();
      const apiKey = inputApiKey.value.trim();
      const model = inputModel.value.trim();

      if (!baseUrl || !model || (!apiKey && provider !== "ollama")) {
        showToast(t("ai_toast_need_all"), true);
        return;
      }

      const testBtn = document.getElementById("btnTestAI");
      testBtn.disabled = true;
      testBtn.querySelector("span").textContent = t("btn_test_ai_loading");

      try {
        await MarkFlowEngine.testAIConnection({ provider, baseUrl, apiKey, model });
        const proto = MarkFlowEngine.detectProtocol(provider, baseUrl);
        const protoTag =
          proto === "anthropic"
            ? "Anthropic Claude"
            : proto === "vertex"
              ? "Vertex AI"
              : proto === "gemini"
                ? "Gemini Native"
                : "OpenAI Compatible";
        showToast(t("ai_toast_test_ok", { proto: protoTag }));
      } catch (err) {
        showToast(t("ai_toast_test_err", { msg: err.message }), true);
      } finally {
        testBtn.disabled = false;
        testBtn.querySelector("span").textContent = t("btn_test_ai");
      }
    });
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

    chipsList.innerHTML = "";
    if (preset.quickModels && preset.quickModels.length > 0) {
      preset.quickModels.forEach(m => {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "model-chip-btn" + (inputModel.value.trim() === m ? " active" : "");
        chip.textContent = m;
        chip.addEventListener("click", () => {
          inputModel.value = m;
          syncActiveModelChip(m);
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

  /**
   * 按模型厂商前缀或型号家族将模型 ID 归类分组，便于在折叠手风琴面板中浏览与筛选。
   */
  function groupFetchedModelIds(ids) {
    const VENDOR_NAMES = {
      google: "Google",
      anthropic: "Anthropic",
      openai: "OpenAI",
      deepseek: "DeepSeek",
      "x-ai": "xAI",
      meta: "Meta Llama",
      "meta-llama": "Meta Llama",
      qwen: "Qwen",
      mistralai: "Mistral",
      cohere: "Cohere"
    };

    const resolveGroup = rawId => {
      const s = String(rawId || "").trim();
      if (s.includes("/")) {
        const prefix = s.split("/")[0].toLowerCase();
        if (VENDOR_NAMES[prefix]) return VENDOR_NAMES[prefix];
        return prefix.replace(/[-_]+/g, " ").replace(/\b\w/g, c => c.toUpperCase());
      }
      const low = s.toLowerCase();
      if (/gemini-4/i.test(low)) return "Gemini 4.x";
      if (/gemini-3/i.test(low)) return "Gemini 3.x";
      if (/gemini-2\.5/i.test(low)) return "Gemini 2.5";
      if (/gemini-2/i.test(low)) return "Gemini 2.0";
      if (/claude-.*4|claude-4/i.test(low)) return "Claude 4.x";
      if (/claude-3/i.test(low)) return "Claude 3.x";
      if (/claude/i.test(low)) return "Claude";
      if (/gpt-6/i.test(low)) return "GPT-6";
      if (/gpt-5/i.test(low)) return "GPT-5";
      if (/gpt-4/i.test(low)) return "GPT-4";
      if (/^o[134](-|$)/i.test(low)) return "o-Series";
      if (/grok-4/i.test(low)) return "Grok 4";
      if (/grok-3/i.test(low)) return "Grok 3";
      if (/deepseek/i.test(low)) return "DeepSeek";
      if (/qwen/i.test(low)) return "Qwen";
      if (/llama/i.test(low)) return "Llama";
      if (/glm/i.test(low)) return "GLM";
      return "Other";
    };

    const map = new Map();
    for (const id of ids) {
      const groupName = resolveGroup(id);
      if (!map.has(groupName)) map.set(groupName, []);
      map.get(groupName).push(id);
    }

    return Array.from(map.entries()).map(([name, models]) => ({ name, models }));
  }

  function renderFetchedModelsList(filterText) {
    const listEl = document.getElementById("fetchedModelsList");
    const inputModel = document.getElementById("inputModel");
    listEl.innerHTML = "";
    listEl.classList.add("fetched-models-groups");

    const q = (filterText || "").trim().toLowerCase();
    const matched = appState.fetchedModelIds.filter(id => !q || id.toLowerCase().includes(q));

    if (matched.length === 0) {
      listEl.innerHTML = `<span class="text-muted" style="font-size:12px; padding:4px;">${escapeHtml(
        t("ai_fetched_empty")
      )}</span>`;
      return;
    }

    const currentVal = inputModel.value.trim();
    const groups = groupFetchedModelIds(matched);

    groups.forEach((grp, gIdx) => {
      const details = document.createElement("details");
      details.className = "model-group-accordion";
      const hasCurrent = currentVal && grp.models.includes(currentVal);
      if (q.length > 0 || gIdx < 2 || hasCurrent) {
        details.open = true;
      }

      const summary = document.createElement("summary");
      summary.className = "model-group-summary";
      summary.innerHTML = `<span>${escapeHtml(grp.name)}</span><span class="model-group-count">${grp.models.length}</span>`;

      const chipWrap = document.createElement("div");
      chipWrap.className = "model-group-chips";

      grp.models.forEach(m => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "model-chip-btn" + (currentVal === m ? " active" : "");
        btn.textContent = m;
        btn.addEventListener("click", () => {
          inputModel.value = m;
          syncActiveModelChip(m);
        });
        chipWrap.appendChild(btn);
      });

      details.appendChild(summary);
      details.appendChild(chipWrap);
      listEl.appendChild(details);
    });
  }

  function syncActiveModelChip(currentModelVal) {
    document.querySelectorAll("#modelQuickChips .model-chip-btn").forEach(btn => {
      btn.classList.toggle("active", btn.textContent === currentModelVal);
    });
    document.querySelectorAll("#fetchedModelsList .model-chip-btn").forEach(btn => {
      btn.classList.toggle("active", btn.textContent === currentModelVal);
    });
  }

  ctx.initAiTab = initAiTab;
  ctx.updateProviderUiMeta = updateProviderUiMeta;
})(window);
