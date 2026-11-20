/**
 * 规则引擎标签页与编辑弹窗模块
 *
 * 管理本地规则的增删改查、启用切换、JSON 导入导出，以及弹窗内的实时 URL 匹配测试器。
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { appState, t, showToast, showConfirmModal } = ctx;
  const { escapeHtml, getFolderAccentColor } = MarkFlowEngine;

  function initRulesTab() {
    renderRulesTable();

    document.getElementById("btnAddRule").addEventListener("click", () => openRuleModal());
    document.getElementById("btnExportRules").addEventListener("click", exportRulesJSON);

    const fileInput = document.getElementById("fileInputRules");
    document.getElementById("btnImportRules").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", importRulesJSON);

    document.getElementById("btnResetRules").addEventListener("click", async () => {
      const ok = await showConfirmModal(t("rules_reset_title"), t("rules_reset_confirm"));
      if (ok) {
        appState.rules = JSON.parse(JSON.stringify(MarkFlowEngine.DEFAULT_UNIVERSAL_RULES));
        await chrome.storage.local.set({ rules: appState.rules });
        renderRulesTable();
        showToast(t("rules_toast_reset"));
      }
    });
  }

  function renderRulesTable() {
    const tbody = document.getElementById("rulesTableBody");
    tbody.innerHTML = "";

    const count = appState.rules.length;
    document.getElementById("rulesCountLabel").textContent = t("rules_count_label", { count });

    if (count === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 26px;">${escapeHtml(
        t("rules_empty_hint")
      )}</td></tr>`;
      return;
    }

    appState.rules.forEach((rule, idx) => {
      const tr = document.createElement("tr");
      const dotColor = getFolderAccentColor(rule.targetFolder || rule.id);
      tr.innerHTML = `
        <td>
          <label class="switch" style="transform: scale(0.8);">
            <input type="checkbox" ${rule.enabled ? "checked" : ""} data-idx="${idx}" class="chk-rule-toggle">
            <span class="slider round"></span>
          </label>
        </td>
        <td><strong>${escapeHtml(rule.name)}</strong></td>
        <td><code class="font-mono" style="font-size:12px; background:var(--accent-light); color:var(--accent); padding:3px 7px; border-radius:6px;">${escapeHtml(rule.pattern)}</code></td>
        <td><span class="dest-folder-pill"><span class="cat-dot" style="background:${dotColor};"></span>${escapeHtml(rule.targetFolder)}</span></td>
        <td><span class="text-muted">${escapeHtml(rule.targetSubfolder || "—")}</span></td>
        <td style="text-align: right;">
          <button class="icon-action-btn btn-edit-rule" data-id="${rule.id}" type="button" title="${escapeHtml(t("rules_edit_title"))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
          <button class="icon-action-btn delete btn-del-rule" data-id="${rule.id}" type="button" title="${escapeHtml(t("rules_delete_title"))}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
          </button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".chk-rule-toggle").forEach(chk => {
      chk.addEventListener("change", async e => {
        const idx = Number(e.target.getAttribute("data-idx"));
        appState.rules[idx].enabled = e.target.checked;
        await chrome.storage.local.set({ rules: appState.rules });
      });
    });

    tbody.querySelectorAll(".btn-edit-rule").forEach(btn => {
      btn.addEventListener("click", e => {
        const id = e.currentTarget.getAttribute("data-id");
        const rule = appState.rules.find(r => r.id === id);
        if (rule) openRuleModal(rule);
      });
    });

    tbody.querySelectorAll(".btn-del-rule").forEach(btn => {
      btn.addEventListener("click", async e => {
        const id = e.currentTarget.getAttribute("data-id");
        const target = appState.rules.find(r => r.id === id);
        const ok = await showConfirmModal(
          t("rules_delete_title"),
          t("rules_delete_confirm", { name: target ? target.name : "" })
        );
        if (ok) {
          appState.rules = appState.rules.filter(r => r.id !== id);
          await chrome.storage.local.set({ rules: appState.rules });
          renderRulesTable();
          showToast(t("rules_toast_deleted"));
        }
      });
    });
  }

  function exportRulesJSON() {
    const blob = new Blob([JSON.stringify(appState.rules, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `markflow-rules-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast(t("rules_toast_exported"));
  }

  function importRulesJSON(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const imported = JSON.parse(ev.target.result);
        if (!Array.isArray(imported)) throw new Error("JSON must be an array");

        appState.rules = imported;
        await chrome.storage.local.set({ rules: appState.rules });
        renderRulesTable();
        showToast(t("rules_toast_imported", { count: imported.length }));
      } catch (err) {
        showToast(t("rules_toast_import_err", { msg: err.message }), true);
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  // ---------------- 规则编辑弹窗与实时 URL 测试器 ---------------- //

  function updateLiveRuleTester() {
    const patternVal = document.getElementById("modalRulePattern").value.trim();
    const urlVal = document.getElementById("modalTestUrlInput").value.trim();
    const resEl = document.getElementById("modalTestUrlResult");
    if (!resEl) return;

    if (!urlVal || !patternVal) {
      resEl.classList.add("hidden");
      return;
    }

    const res = MarkFlowEngine.testRulePattern(urlVal, patternVal);
    resEl.classList.remove("hidden", "is-hit", "is-miss");

    if (res.matched) {
      resEl.classList.add("is-hit");
      resEl.textContent = t("modal_rule_test_hit", { segment: res.matchedSegment });
    } else {
      resEl.classList.add("is-miss");
      resEl.textContent = t("modal_rule_test_miss");
    }
  }

  function initRuleModal() {
    const btnClose = document.getElementById("btnModalClose");
    const btnCancel = document.getElementById("btnModalCancel");
    const btnSave = document.getElementById("btnModalSave");
    const selTop = document.getElementById("modalSelectTopFolder");
    const selSub = document.getElementById("modalSelectSubFolder");
    const customSubInput = document.getElementById("modalCustomSubFolderInput");

    btnClose.addEventListener("click", closeRuleModal);
    btnCancel.addEventListener("click", closeRuleModal);

    document.getElementById("modalRulePattern").addEventListener("input", updateLiveRuleTester);
    document.getElementById("modalTestUrlInput").addEventListener("input", updateLiveRuleTester);

    selTop.addEventListener("change", () => updateSubFolderDropdown());
    selSub.addEventListener("change", () => {
      if (selSub.value === "__custom__") {
        customSubInput.classList.remove("hidden");
        customSubInput.focus();
      } else {
        customSubInput.classList.add("hidden");
      }
    });

    btnSave.addEventListener("click", async () => {
      const name = document.getElementById("modalRuleName").value.trim();
      const pattern = document.getElementById("modalRulePattern").value.trim();
      const targetFolder = selTop.value;
      const targetSubfolder =
        selSub.value === "__custom__" ? customSubInput.value.trim() : selSub.value;

      if (!name || !pattern || !targetFolder) {
        showToast(t("rules_toast_required"), true);
        return;
      }

      if (appState.editingRuleId) {
        const rule = appState.rules.find(r => r.id === appState.editingRuleId);
        if (rule) {
          rule.name = name;
          rule.pattern = pattern;
          rule.targetFolder = targetFolder;
          rule.targetSubfolder = targetSubfolder;
        }
      } else {
        appState.rules.unshift({
          id: "rule_" + Date.now(),
          enabled: true,
          name,
          pattern,
          matchType: "wildcard",
          targetFolder,
          targetSubfolder
        });
      }

      await chrome.storage.local.set({ rules: appState.rules });
      renderRulesTable();
      closeRuleModal();
      showToast(t("rules_toast_saved"));
    });
  }

  function updateSubFolderDropdown(selectedSubValue = "") {
    const selTop = document.getElementById("modalSelectTopFolder");
    const selSub = document.getElementById("modalSelectSubFolder");
    const customSubInput = document.getElementById("modalCustomSubFolderInput");

    const chosenTopTitle = selTop.value;
    const topItem = appState.folderHierarchy.find(f => f.title === chosenTopTitle);

    selSub.innerHTML = "";

    const optNone = document.createElement("option");
    optNone.value = "";
    optNone.textContent = t("modal_sub_none");
    selSub.appendChild(optNone);

    let hasMatchedSub = false;
    if (topItem && topItem.subfolders && topItem.subfolders.length > 0) {
      topItem.subfolders.forEach(sub => {
        const opt = document.createElement("option");
        opt.value = sub.title;
        opt.textContent = sub.title;
        if (sub.title === selectedSubValue) {
          opt.selected = true;
          hasMatchedSub = true;
        }
        selSub.appendChild(opt);
      });
    }

    const optCustom = document.createElement("option");
    optCustom.value = "__custom__";
    optCustom.textContent = t("modal_sub_custom");
    selSub.appendChild(optCustom);

    if (selectedSubValue && !hasMatchedSub) {
      optCustom.selected = true;
      customSubInput.classList.remove("hidden");
      customSubInput.value = selectedSubValue;
    } else {
      customSubInput.classList.add("hidden");
      customSubInput.value = "";
    }

    if (ctx.syncCustomSelects) ctx.syncCustomSelects();
  }

  function openRuleModal(rule = null) {
    const modal = document.getElementById("ruleModal");
    const title = document.getElementById("modalTitle");
    const selTop = document.getElementById("modalSelectTopFolder");
    const testUrlInput = document.getElementById("modalTestUrlInput");
    const testResult = document.getElementById("modalTestUrlResult");

    selTop.innerHTML = "";
    if (appState.folderHierarchy.length === 0) {
      const opt = document.createElement("option");
      opt.value = t("pop_default_bar_name");
      opt.textContent = t("pop_default_bar_name");
      selTop.appendChild(opt);
    } else {
      appState.folderHierarchy.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.title;
        opt.textContent = f.title;
        selTop.appendChild(opt);
      });
    }

    testUrlInput.value = "";
    testResult.classList.add("hidden");

    if (rule) {
      appState.editingRuleId = rule.id;
      title.textContent = t("modal_edit_rule");
      document.getElementById("modalRuleName").value = rule.name;
      document.getElementById("modalRulePattern").value = rule.pattern;
      selTop.value =
        rule.targetFolder || (appState.folderHierarchy[0] ? appState.folderHierarchy[0].title : "");
      updateSubFolderDropdown(rule.targetSubfolder || "");
    } else {
      appState.editingRuleId = null;
      title.textContent = t("modal_add_rule");
      document.getElementById("modalRuleName").value = "";
      document.getElementById("modalRulePattern").value = "";
      if (appState.folderHierarchy.length > 0) {
        selTop.value = appState.folderHierarchy[0].title;
      }
      updateSubFolderDropdown("");
    }

    modal.classList.remove("hidden");
    if (ctx.syncCustomSelects) ctx.syncCustomSelects();
  }

  function closeRuleModal() {
    document.getElementById("ruleModal").classList.add("hidden");
    appState.editingRuleId = null;
  }

  ctx.initRulesTab = initRulesTab;
  ctx.renderRulesTable = renderRulesTable;
  ctx.initRuleModal = initRuleModal;
})(window);
