/**
 * 通用偏好设置、全量配置迁移与赞赏页模块
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { appState, t, showToast, showConfirmModal } = ctx;

  function populatePreferencesControls() {
    const pref = appState.preferences || MarkFlowEngine.DEFAULT_PREFERENCES;
    document.getElementById("selTitleStyle").value = pref.titleStyle || "scannable";
    document.getElementById("selAiLanguage").value = pref.aiLanguage || "ui";
    document.getElementById("selSubfolderPolicy").value = pref.subfolderPolicy || "balanced";
    document.getElementById("chkRuleMatchUseAiTitle").checked = Boolean(pref.ruleMatchUseAiTitle);
    document.getElementById("chkExtractPageContext").checked = pref.extractPageContext !== false;
    document.getElementById("selCountdown").value = String(pref.autoSaveCountdown ?? 0);
    document.getElementById("chkStripSuffixes").checked = pref.stripSuffixes !== false;
    document.getElementById("chkPanguSpacing").checked = pref.panguSpacing !== false;
    document.getElementById("txtCustomInstruction").value = pref.customInstruction || "";
    refreshMemoryCountLabel();
    if (ctx.syncCustomSelects) ctx.syncCustomSelects();
  }

  function initPreferencesTab() {
    populatePreferencesControls();

    const persistPreferences = async toastMsg => {
      appState.preferences.titleStyle = document.getElementById("selTitleStyle").value;
      appState.preferences.aiLanguage = document.getElementById("selAiLanguage").value;
      appState.preferences.subfolderPolicy = document.getElementById("selSubfolderPolicy").value;
      appState.preferences.ruleMatchUseAiTitle =
        document.getElementById("chkRuleMatchUseAiTitle").checked;
      appState.preferences.extractPageContext =
        document.getElementById("chkExtractPageContext").checked;
      appState.preferences.autoSaveCountdown = parseInt(
        document.getElementById("selCountdown").value,
        10
      );
      appState.preferences.stripSuffixes = document.getElementById("chkStripSuffixes").checked;
      appState.preferences.panguSpacing = document.getElementById("chkPanguSpacing").checked;
      appState.preferences.customInstruction = document
        .getElementById("txtCustomInstruction")
        .value.trim()
        .slice(0, 300);

      await chrome.storage.local.set({ preferences: appState.preferences });
      if (toastMsg) showToast(toastMsg);
    };

    [
      "selTitleStyle",
      "selAiLanguage",
      "selSubfolderPolicy",
      "chkRuleMatchUseAiTitle",
      "chkExtractPageContext",
      "selCountdown",
      "chkStripSuffixes",
      "chkPanguSpacing"
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", () => persistPreferences(t("pref_toast_autosaved")));
    });

    const txtCustom = document.getElementById("txtCustomInstruction");
    txtCustom.addEventListener("blur", () => {
      const nextVal = txtCustom.value.trim().slice(0, 300);
      if (nextVal !== (appState.preferences.customInstruction || "")) {
        persistPreferences(t("pref_toast_note_saved"));
      }
    });

    document
      .getElementById("btnSavePreferences")
      .addEventListener("click", () => persistPreferences(t("pref_toast_all_saved")));

    document.getElementById("btnOpenShortcuts").addEventListener("click", () => {
      chrome.tabs.create({ url: MarkFlowEngine.platform.getShortcutsPageUrl() });
    });

    document.getElementById("btnClearDomainMemory").addEventListener("click", async () => {
      const ok = await showConfirmModal(t("pref_memory_title"), t("pref_clear_memory_confirm"));
      if (!ok) return;
      appState.domainMemory = {};
      await chrome.storage.local.set({ domainMemory: {} });
      refreshMemoryCountLabel();
      showToast(t("pref_toast_memory_cleared"));
    });

    document.getElementById("btnExportAllSettings").addEventListener("click", exportAllSettingsJSON);
    const allSettingsInput = document.getElementById("fileInputAllSettings");
    document
      .getElementById("btnImportAllSettings")
      .addEventListener("click", () => allSettingsInput.click());
    allSettingsInput.addEventListener("change", importAllSettingsJSON);
  }

  function exportAllSettingsJSON() {
    const appVersion =
      typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : "1.0.0";
    const payload = {
      schema: "markflow-settings-bundle",
      version: appVersion,
      exportedAt: new Date().toISOString(),
      note: "API keys are intentionally excluded for security.",
      preferences: appState.preferences,
      rules: appState.rules,
      domainMemory: appState.domainMemory
    };

    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `markflow-settings-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t("pref_toast_exported"));
  }

  function importAllSettingsJSON(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const parsed = JSON.parse(ev.target.result);
        if (!parsed || typeof parsed !== "object") {
          throw new Error("Invalid JSON file");
        }

        const toSave = {};
        if (parsed.preferences && typeof parsed.preferences === "object") {
          appState.preferences = Object.assign(
            {},
            MarkFlowEngine.DEFAULT_PREFERENCES,
            parsed.preferences
          );
          toSave.preferences = appState.preferences;
        }
        if (Array.isArray(parsed.rules)) {
          appState.rules = parsed.rules;
          toSave.rules = appState.rules;
        }
        if (parsed.domainMemory && typeof parsed.domainMemory === "object") {
          appState.domainMemory = parsed.domainMemory;
          toSave.domainMemory = appState.domainMemory;
        }

        if (Object.keys(toSave).length === 0) {
          throw new Error("No valid MarkFlow settings found");
        }

        await chrome.storage.local.set(toSave);

        populatePreferencesControls();
        if (ctx.renderRulesTable) ctx.renderRulesTable();
        if (appState.preferences.language) {
          const resolved = resolveDisplayLanguage(appState.preferences.language);
          document.getElementById("selLanguage").value = resolved;
          applyI18nToDocument(resolved);
          if (ctx.updateProviderUiMeta) ctx.updateProviderUiMeta(appState.aiConfig.provider);
          if (ctx.syncReorgStartButtonLabel) ctx.syncReorgStartButtonLabel();
          if (ctx.syncCustomSelects) ctx.syncCustomSelects();
        }
        showToast(t("pref_toast_imported"));
      } catch (err) {
        showToast(t("pref_toast_import_err", { msg: err.message }), true);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function refreshMemoryCountLabel() {
    const el = document.getElementById("memoryCountLabel");
    if (!el) return;
    const count = Object.keys(appState.domainMemory || {}).length;
    el.textContent = t("pref_memory_count", { count });
  }

  /** 检测赞赏码图片加载状态，加载成功时隐藏占位视图 */
  function initSponsorTab() {
    const qrImg = document.getElementById("wechatQrImg");
    const placeholder = document.getElementById("wechatQrPlaceholder");
    if (!qrImg || !placeholder) return;

    const showImg = () => {
      qrImg.classList.remove("hidden");
      placeholder.classList.add("hidden");
    };
    const showPlaceholder = () => {
      qrImg.classList.add("hidden");
      placeholder.classList.remove("hidden");
    };

    qrImg.addEventListener("load", showImg);
    qrImg.addEventListener("error", showPlaceholder);

    if (qrImg.complete) {
      if (qrImg.naturalWidth > 0) showImg();
      else showPlaceholder();
    }
  }

  ctx.initPreferencesTab = initPreferencesTab;
  ctx.refreshMemoryCountLabel = refreshMemoryCountLabel;
  ctx.initSponsorTab = initSponsorTab;
})(window);
