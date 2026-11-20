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

    const currentProvider = appState.aiConfig.provider || "siliconflow";
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

    inputModel.addEventListener("input", () => syncActiveModelChip(inputModel.value.trim()));

    document.getElementById("btnToggleApiKey").addEventListener("click", () => {
      inputApiKey.type = inputApiKey.type === "password" ? "text" : "password";
    });

    document.getElementById("btnFetchModels").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "siliconflow";
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
        showToast(t("ai_toast_fetched", { count: models.length }));
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
      const curProvider = appState.aiConfig.provider || "siliconflow";
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
      showToast(t("ai_toast_saved"));
    });

    document.getElementById("btnTestAI").addEventListener("click", async () => {
      const provider = appState.aiConfig.provider || "siliconflow";
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
        const reply = await MarkFlowEngine.testAIConnection({ provider, baseUrl, apiKey, model });
        const proto = MarkFlowEngine.detectProtocol(provider, baseUrl);
        const protoTag = proto === "gemini" ? "Gemini Native" : "OpenAI Compatible";
        showToast(t("ai_toast_test_ok", { proto: protoTag, reply: String(reply).slice(0, 32) }));
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
      MarkFlowEngine.PROVIDER_PRESETS[providerKey] || MarkFlowEngine.PROVIDER_PRESETS.siliconflow;
    const inputBaseUrl = document.getElementById("inputBaseUrl");
    const inputApiKey = document.getElementById("inputApiKey");
    const inputModel = document.getElementById("inputModel");
    const baseUrlHint = document.getElementById("baseUrlHint");
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

  function renderFetchedModelsList(filterText) {
    const listEl = document.getElementById("fetchedModelsList");
    const inputModel = document.getElementById("inputModel");
    listEl.innerHTML = "";

    const q = (filterText || "").trim().toLowerCase();
    const matched = appState.fetchedModelIds.filter(id => !q || id.toLowerCase().includes(q));

    if (matched.length === 0) {
      listEl.innerHTML = `<span class="text-muted" style="font-size:12px; padding:4px;">${escapeHtml(
        t("ai_fetched_empty")
      )}</span>`;
      return;
    }

    matched.slice(0, 80).forEach(m => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "model-chip-btn" + (inputModel.value.trim() === m ? " active" : "");
      btn.textContent = m;
      btn.addEventListener("click", () => {
        inputModel.value = m;
        syncActiveModelChip(m);
        listEl.querySelectorAll(".model-chip-btn").forEach(b => {
          b.classList.toggle("active", b.textContent === m);
        });
      });
      listEl.appendChild(btn);
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
