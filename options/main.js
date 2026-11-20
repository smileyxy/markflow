/**
 * 控制台启动入口与导航路由模块
 *
 * 负责按顺序初始化应用状态、多语言切换器、侧边栏标签页切换（含 URL Hash 深链）及各功能模块。
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { appState, t, loadState, showToast } = ctx;

  function syncStaticTooltips() {
    const ghLink = document.getElementById("linkSidebarGithub");
    if (ghLink) ghLink.title = t("sidebar_github_title");
  }

  function initLanguageSwitcher() {
    const selLang = document.getElementById("selLanguage");
    const userLang = resolveDisplayLanguage(appState.preferences.language);
    appState.preferences.language = userLang;
    selLang.value = userLang;
    applyI18nToDocument(userLang);
    syncStaticTooltips();

    selLang.addEventListener("change", async e => {
      const chosenLang = e.target.value;
      appState.preferences.language = chosenLang;
      await chrome.storage.local.set({ preferences: appState.preferences });
      applyI18nToDocument(chosenLang);
      syncStaticTooltips();
      if (ctx.updateProviderUiMeta) ctx.updateProviderUiMeta(appState.aiConfig.provider);
      if (ctx.syncReorgStartButtonLabel) ctx.syncReorgStartButtonLabel();
      if (ctx.renderRulesTable) ctx.renderRulesTable();
      if (ctx.refreshMemoryCountLabel) ctx.refreshMemoryCountLabel();
      if (ctx.syncCustomSelects) ctx.syncCustomSelects();
      showToast(t("lang_switched_toast"));
    });
  }

  function activateTab(tabId) {
    const navBtns = document.querySelectorAll(".nav-item");
    const panes = document.querySelectorAll(".tab-pane");
    const targetBtn = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
    const targetPane = document.getElementById(tabId);
    if (!targetBtn || !targetPane) return;

    navBtns.forEach(b => b.classList.remove("active"));
    panes.forEach(p => p.classList.remove("active"));
    targetBtn.classList.add("active");
    targetPane.classList.add("active");

    if (tabId === "tab-reorganize") {
      if (ctx.populateReorgFolderSelect) ctx.populateReorgFolderSelect();
      if (ctx.renderLockedFoldersChecklist) ctx.renderLockedFoldersChecklist();
    } else if (tabId === "tab-preferences") {
      if (ctx.refreshMemoryCountLabel) ctx.refreshMemoryCountLabel();
    }
  }

  function initTabs() {
    document.querySelectorAll(".nav-item").forEach(btn => {
      btn.addEventListener("click", () => {
        activateTab(btn.getAttribute("data-tab"));
      });
    });

    // 关于页新手教程中的快捷跳转按钮
    document.querySelectorAll(".guide-jump-btn[data-jump-tab]").forEach(btn => {
      btn.addEventListener("click", () => {
        const target = btn.getAttribute("data-jump-tab");
        if (target) {
          activateTab(target);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      });
    });

    const initialHash = (window.location.hash || "").replace(/^#/, "");
    if (initialHash && document.getElementById(initialHash)) {
      activateTab(initialHash);
    }
  }

  function initGuideLightbox() {
    const modal = document.getElementById("guideLightboxModal");
    const imgEl = document.getElementById("guideLightboxImg");
    const titleEl = document.getElementById("guideLightboxTitle");
    const btnClose = document.getElementById("btnLightboxClose");
    if (!modal || !imgEl || !titleEl) return;

    const closeLightbox = () => modal.classList.add("hidden");

    document.querySelectorAll(".guide-shot-btn[data-shot-src]").forEach(btn => {
      btn.addEventListener("click", () => {
        const src = btn.getAttribute("data-shot-src");
        const titleKey = btn.getAttribute("data-shot-title-key");
        imgEl.src = src;
        titleEl.textContent = titleKey ? t(titleKey) : "Preview";
        modal.classList.remove("hidden");
      });
    });

    if (btnClose) btnClose.addEventListener("click", closeLightbox);
    modal.addEventListener("click", e => {
      if (e.target === modal) closeLightbox();
    });
    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && !modal.classList.contains("hidden")) closeLightbox();
    });
  }

  document.addEventListener("DOMContentLoaded", async () => {
    await loadState();
    initLanguageSwitcher();
    initTabs();
    ctx.initRulesTab();
    ctx.initAiTab();
    ctx.initReorganizeTab();
    ctx.initPreferencesTab();
    ctx.initSponsorTab();
    ctx.initRuleModal();
    initGuideLightbox();
    if (ctx.initCustomSelects) ctx.initCustomSelects();
  });
})(window);
