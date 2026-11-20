/**
 * 智能整理与目录架构重构标签页模块
 *
 * 支持三种工作流：
 * 1. 归入现有目录 & 内部优先级排序
 * 2. 零 Token 纯目录内优先级排序
 * 3. 两阶段全盘目录体系重构（蓝图审阅编辑 → 批量映射与孤岛收敛 → 原子落地与旧空目录清理）
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { appState, t, parseFolderStructures, showToast } = ctx;
  const { escapeHtml } = MarkFlowEngine;

  /** 标记顶部启动按钮是否已降级为次级样式（当下方蓝图或预览卡片展开时降级，突出唯一主操作） */
  let isStartButtonDemoted = false;

  /** 导出当前全量书签树为标准 Netscape HTML 备份文件 */
  async function downloadBookmarksBackup() {
    const preTree = await chrome.bookmarks.getTree();
    const backupHtml = generateNetscapeBookmarkHtml(preTree);
    const blob = new Blob([backupHtml], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.download = `markflow-bookmarks-backup-${timestamp}.html`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 控制启动按钮视觉层级：下方出现蓝图或预览确认卡片时降级为次级按钮，避免双主按钮冲突 */
  function setStartButtonDemoted(demoted) {
    isStartButtonDemoted = Boolean(demoted);
    const btn = document.getElementById("btnStartReorganize");
    if (btn) {
      btn.classList.toggle("btn-primary", !isStartButtonDemoted);
      btn.classList.toggle("btn-secondary", isStartButtonDemoted);
    }
    syncReorgStartButtonLabel();
  }

  function initReorganizeTab() {
    const radioModeExisting = document.getElementById("radioModeExisting");
    const radioModeRebuild = document.getElementById("radioModeRebuild");
    const modeCardExisting = document.getElementById("modeCardExisting");
    const modeCardRebuild = document.getElementById("modeCardRebuild");

    const existingOpts = document.getElementById("existingModeOptions");
    const rebuildOpts = document.getElementById("rebuildModeOptions");

    const radioAll = document.getElementById("radioScopeAll");
    const radioFolder = document.getElementById("radioScopeFolder");
    const folderGroup = document.getElementById("reorgFolderSelectGroup");

    const selIconStyle = document.getElementById("selRebuildIconStyle");
    if (appState.treeAnalysis && !appState.treeAnalysis.styleProfile.mainUsesEmoji) {
      selIconStyle.value = "plain";
    }

    const onModeSwitch = () => {
      appState.reorgMode = radioModeRebuild.checked ? "rebuild" : "existing";
      const isRebuild = appState.reorgMode === "rebuild";

      modeCardExisting.classList.toggle("active", !isRebuild);
      modeCardRebuild.classList.toggle("active", isRebuild);
      existingOpts.classList.toggle("hidden", isRebuild);
      rebuildOpts.classList.toggle("hidden", !isRebuild);

      document.getElementById("reorgBlueprintContainer").classList.add("hidden");
      document.getElementById("reorgPreviewContainer").classList.add("hidden");

      if (isRebuild) renderLockedFoldersChecklist();
      setStartButtonDemoted(false);
    };

    radioModeExisting.addEventListener("change", onModeSwitch);
    radioModeRebuild.addEventListener("change", onModeSwitch);

    radioAll.addEventListener("change", () => folderGroup.classList.add("hidden"));
    radioFolder.addEventListener("change", () => {
      folderGroup.classList.remove("hidden");
      populateReorgFolderSelect();
    });

    const btnManualBackup = document.getElementById("btnManualBackup");
    if (btnManualBackup) {
      btnManualBackup.addEventListener("click", async () => {
        try {
          await downloadBookmarksBackup();
          showToast(t("reorg_toast_backup_done"));
        } catch (err) {
          showToast(t("reorg_toast_apply_err", { msg: err.message }), true);
        }
      });
    }

    document.getElementById("btnStartReorganize").addEventListener("click", () => {
      if (appState.reorgMode === "rebuild") {
        runBlueprintGenerationStage();
      } else {
        runExistingFoldersReorganizer();
      }
    });

    const btnQuickSort = document.getElementById("btnQuickSortOnly");
    if (btnQuickSort) btnQuickSort.addEventListener("click", runQuickSortOnlyPreview);

    document.getElementById("btnRegenBlueprint").addEventListener("click", runBlueprintGenerationStage);
    document.getElementById("btnAddBlueprintL1").addEventListener("click", addNewBlueprintCategory);
    document.getElementById("btnConfirmBlueprint").addEventListener("click", runBlueprintMappingStage);
    document.getElementById("btnApplyReorganize").addEventListener("click", applyReorganizerChanges);

    populateReorgFolderSelect();
    renderLockedFoldersChecklist();
  }

  function syncReorgStartButtonLabel() {
    const lbl = document.getElementById("btnStartReorgLabel");
    if (!lbl) return;
    let key;
    if (appState.reorgMode === "rebuild") {
      key = "btn_gen_blueprint";
    } else {
      key = isStartButtonDemoted ? "btn_reorg_rerun" : "btn_start_reorg";
    }
    lbl.setAttribute("data-i18n", key);
    lbl.textContent = t(key);
  }

  function populateReorgFolderSelect() {
    const sel = document.getElementById("selReorgFolder");
    if (!sel) return;
    sel.innerHTML = "";

    appState.allFoldersTree.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.displayText;
      sel.appendChild(opt);
    });

    if (ctx.syncCustomSelects) ctx.syncCustomSelects();
  }

  function renderLockedFoldersChecklist() {
    const container = document.getElementById("lockedFoldersList");
    const group = document.getElementById("lockedFoldersGroup");
    if (!container || !appState.treeAnalysis) return;

    const l1Folders = appState.treeAnalysis.folders.filter(f => f.depth === 2 && f.parentId === "1");
    if (l1Folders.length === 0) {
      group.classList.add("hidden");
      return;
    }

    group.classList.remove("hidden");
    container.innerHTML = "";

    l1Folders.forEach(f => {
      const isChecked = appState.lockedL1Ids.has(f.id);
      const label = document.createElement("label");
      label.className = "locked-folder-pill" + (isChecked ? " is-locked" : "");

      const chk = document.createElement("input");
      chk.type = "checkbox";
      chk.checked = isChecked;
      chk.addEventListener("change", () => {
        if (chk.checked) appState.lockedL1Ids.add(f.id);
        else appState.lockedL1Ids.delete(f.id);
        label.classList.toggle("is-locked", chk.checked);
      });

      const span = document.createElement("span");
      span.textContent = f.title;

      label.appendChild(chk);
      label.appendChild(span);
      container.appendChild(label);
    });
  }

  // ---------------- 模式一（快捷分支）：零 Token 仅重排目录内顺序 ---------------- //

  async function runQuickSortOnlyPreview() {
    const isAll = document.getElementById("radioScopeAll").checked;
    const targetFolderId = document.getElementById("selReorgFolder").value;

    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    let rootNodes = [];
    if (isAll) {
      rootNodes = tree[0].children || [];
    } else {
      const found = findNodeById(tree[0], targetFolderId);
      if (found) rootNodes = [found];
    }

    const rawBookmarks = collectBookmarks(rootNodes);
    if (rawBookmarks.length === 0) {
      showToast(t("reorg_toast_empty_scope"), true);
      return;
    }

    appState.activeReorgMode = "sort_only";
    appState.activeTargetFolders = appState.allFoldersTree;
    appState.previewCategoryFilter = "ALL";
    document.getElementById("reorgBlueprintContainer").classList.add("hidden");

    const byFolder = new Map();
    rawBookmarks.forEach((bm, idx) => {
      const funcGroup = MarkFlowEngine.inferLocalFuncGroup(bm.url, bm.title);
      const entry = {
        _origOrderIdx: idx,
        id: bm.id,
        originalTitle: bm.title,
        url: bm.url,
        cleanTitle: bm.title,
        currentFolderId: bm.parentId,
        currentFolderName: bm.parentTitle,
        targetFolderId: bm.parentId,
        targetFolderName: bm.parentTitle,
        funcGroup,
        reason: t("reorg_reason_sort_only"),
        ignored: false
      };
      if (!byFolder.has(bm.parentId)) byFolder.set(bm.parentId, []);
      byFolder.get(bm.parentId).push(entry);
    });

    const sortedAll = [];
    for (const [, folderItems] of byFolder.entries()) {
      sortedAll.push(...MarkFlowEngine.sortFolderBookmarksByPriority(folderItems));
    }

    appState.reorgItems = sortedAll;
    renderReorgPreviewTable();
    const previewBox = document.getElementById("reorgPreviewContainer");
    previewBox.classList.remove("hidden");
    setStartButtonDemoted(true);
    previewBox.scrollIntoView({ behavior: "smooth", block: "start" });

    showToast(t("reorg_toast_sort_preview", { count: sortedAll.length }));
  }

  // ---------------- 模式一：归入现有目录 & 内部排序 ---------------- //

  async function runExistingFoldersReorganizer() {
    const isAll = document.getElementById("radioScopeAll").checked;
    const targetFolderId = document.getElementById("selReorgFolder").value;

    const btnStart = document.getElementById("btnStartReorganize");
    const progressBox = document.getElementById("reorgProgressContainer");
    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");
    const previewBox = document.getElementById("reorgPreviewContainer");

    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    let rootNodes = [];
    if (isAll) {
      rootNodes = tree[0].children || [];
    } else {
      const found = findNodeById(tree[0], targetFolderId);
      if (found) rootNodes = [found];
    }

    const rawBookmarks = collectBookmarks(rootNodes);
    if (rawBookmarks.length === 0) {
      showToast(t("reorg_toast_empty_scope"), true);
      return;
    }

    appState.activeReorgMode = "existing";
    appState.activeTargetFolders = appState.allFoldersTree;
    appState.previewCategoryFilter = "ALL";

    btnStart.disabled = true;
    progressBox.classList.remove("hidden");
    previewBox.classList.add("hidden");
    document.getElementById("reorgBlueprintContainer").classList.add("hidden");
    progressBar.style.width = "0%";
    progressText.textContent = t("reorg_prog_prepare", { count: rawBookmarks.length });
    progressPercent.textContent = "0%";

    await executeBatchMapping(rawBookmarks, appState.treeAnalysis, true);

    if (document.getElementById("chkSortInFolders").checked) {
      sortPreviewItemsByDestinationFolder();
    }

    btnStart.disabled = false;
    progressBox.classList.add("hidden");
    renderReorgPreviewTable();
    previewBox.classList.remove("hidden");
    setStartButtonDemoted(true);
    previewBox.scrollIntoView({ behavior: "smooth", block: "start" });
    showToast(t("reorg_toast_existing_ready", { count: appState.reorgItems.length }));
  }

  // ---------------- 模式二（阶段一）：生成与编辑两级目录蓝图 ---------------- //

  async function runBlueprintGenerationStage() {
    const activeCfg = MarkFlowEngine.resolveActiveProviderConfig(appState.aiConfig);
    if (!activeCfg.enabled || !activeCfg.baseUrl || (!activeCfg.apiKey && activeCfg.provider !== "ollama")) {
      showToast(t("reorg_toast_need_ai"), true);
      return;
    }

    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    const unlockedBookmarks = collectUnlockedBookmarks(tree[0].children || [], appState.lockedL1Ids);
    if (unlockedBookmarks.length === 0) {
      showToast(t("reorg_toast_no_unlocked"), true);
      return;
    }

    const lockedFolders = appState.treeAnalysis.folders.filter(f => appState.lockedL1Ids.has(f.id));
    const iconStyle = document.getElementById("selRebuildIconStyle").value || "emoji";

    const btnStart = document.getElementById("btnStartReorganize");
    const btnRegen = document.getElementById("btnRegenBlueprint");
    const progressBox = document.getElementById("reorgProgressContainer");
    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");
    const bpBox = document.getElementById("reorgBlueprintContainer");
    const previewBox = document.getElementById("reorgPreviewContainer");

    btnStart.disabled = true;
    btnRegen.disabled = true;
    previewBox.classList.add("hidden");
    bpBox.classList.add("hidden");
    progressBox.classList.remove("hidden");
    progressBar.style.width = "35%";
    progressText.textContent = t("reorg_prog_blueprint", { count: unlockedBookmarks.length });
    progressPercent.textContent = "1/2";

    try {
      const blueprint = await MarkFlowEngine.generateTaxonomyBlueprint({
        bookmarks: unlockedBookmarks,
        lockedFolders,
        iconStyle,
        aiConfig: appState.aiConfig,
        preferences: appState.preferences
      });

      appState.blueprintCategories = blueprint;
      appState.rebuildRawBookmarks = unlockedBookmarks;

      progressBar.style.width = "100%";
      renderBlueprintEditor();
      bpBox.classList.remove("hidden");
      setStartButtonDemoted(true);
      bpBox.scrollIntoView({ behavior: "smooth", block: "start" });
      showToast(t("reorg_toast_bp_ready", { count: blueprint.length }));
    } catch (err) {
      showToast(t("reorg_toast_bp_err", { msg: err.message }), true);
    } finally {
      btnStart.disabled = false;
      btnRegen.disabled = false;
      progressBox.classList.add("hidden");
    }
  }

  function renderBlueprintEditor() {
    const grid = document.getElementById("blueprintCardsGrid");
    grid.innerHTML = "";

    const delSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

    appState.blueprintCategories.forEach((cat, cIdx) => {
      const card = document.createElement("div");
      card.className = "blueprint-card";

      const header = document.createElement("div");
      header.className = "bp-card-header";

      const l1Input = document.createElement("input");
      l1Input.type = "text";
      l1Input.className = "bp-l1-input";
      l1Input.value = cat.title;
      l1Input.placeholder = t("reorg_bp_l1_ph");
      l1Input.addEventListener("input", e => {
        appState.blueprintCategories[cIdx].title = e.target.value;
      });

      const delCatBtn = document.createElement("button");
      delCatBtn.type = "button";
      delCatBtn.className = "icon-action-btn delete";
      delCatBtn.title = t("reorg_bp_del_l1");
      delCatBtn.innerHTML = delSvg;
      delCatBtn.addEventListener("click", () => {
        if (appState.blueprintCategories.length <= 1) {
          showToast(t("reorg_toast_bp_min_one"), true);
          return;
        }
        appState.blueprintCategories.splice(cIdx, 1);
        renderBlueprintEditor();
      });

      header.appendChild(l1Input);
      header.appendChild(delCatBtn);
      card.appendChild(header);

      const subList = document.createElement("div");
      subList.className = "bp-sub-list";

      const subs = cat.subfolders || [];
      if (subs.length === 0) {
        const flatHint = document.createElement("div");
        flatHint.className = "bp-flat-hint";
        const hintParts = [t("reorg_bp_flat_hint")];
        if (cat.scopeHint) hintParts.push(cat.scopeHint);
        flatHint.textContent = hintParts.join(" · ");
        subList.appendChild(flatHint);
      }

      subs.forEach((sub, sIdx) => {
        const row = document.createElement("div");
        row.className = "bp-sub-row";

        const branch = document.createElement("span");
        branch.className = "bp-sub-branch";
        branch.textContent = sIdx === subs.length - 1 ? "└──" : "├──";

        const subInput = document.createElement("input");
        subInput.type = "text";
        subInput.className = "bp-sub-input";
        subInput.value = sub.title;
        subInput.placeholder = t("reorg_bp_l2_ph");
        const tipParts = [];
        if (sub.scopeHint) tipParts.push(sub.scopeHint);
        if (sub.seedSamples && sub.seedSamples.length) tipParts.push(sub.seedSamples.join(" | "));
        subInput.title = tipParts.join("\n");
        subInput.addEventListener("input", e => {
          appState.blueprintCategories[cIdx].subfolders[sIdx].title = e.target.value;
        });

        const delSubBtn = document.createElement("button");
        delSubBtn.type = "button";
        delSubBtn.className = "icon-action-btn delete";
        delSubBtn.title = t("reorg_bp_del_l2");
        delSubBtn.innerHTML = delSvg;
        delSubBtn.addEventListener("click", () => {
          appState.blueprintCategories[cIdx].subfolders.splice(sIdx, 1);
          renderBlueprintEditor();
        });

        row.appendChild(branch);
        row.appendChild(subInput);
        row.appendChild(delSubBtn);
        subList.appendChild(row);
      });

      card.appendChild(subList);

      const addSubBtn = document.createElement("button");
      addSubBtn.type = "button";
      addSubBtn.className = "bp-add-sub-btn";
      addSubBtn.textContent = t("reorg_bp_add_l2");
      addSubBtn.addEventListener("click", () => {
        appState.blueprintCategories[cIdx].subfolders.push({
          id: `bp_${cIdx}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          title: t("reorg_bp_new_l2"),
          scopeHint: ""
        });
        renderBlueprintEditor();
        const inputs = grid.querySelectorAll(".blueprint-card")[cIdx].querySelectorAll(".bp-sub-input");
        const last = inputs[inputs.length - 1];
        if (last) {
          last.focus();
          last.select();
        }
      });

      card.appendChild(addSubBtn);
      grid.appendChild(card);
    });
  }

  function addNewBlueprintCategory() {
    const iconStyle = document.getElementById("selRebuildIconStyle").value || "emoji";
    const baseName = t("reorg_bp_new_l1");
    appState.blueprintCategories.push({
      id: `bp_custom_${Date.now()}`,
      title: iconStyle === "emoji" ? `📁 ${baseName}` : baseName,
      subfolders: [{ id: `bp_sub_${Date.now()}`, title: t("reorg_bp_general_l2"), scopeHint: "" }]
    });
    renderBlueprintEditor();
    const cards = document.querySelectorAll("#blueprintCardsGrid .blueprint-card");
    const lastCard = cards[cards.length - 1];
    if (lastCard) {
      const inp = lastCard.querySelector(".bp-l1-input");
      if (inp) {
        inp.focus();
        inp.select();
      }
    }
  }

  // ---------------- 模式二（阶段二）：按确认蓝图批量映射与孤岛收敛 ---------------- //

  async function runBlueprintMappingStage() {
    const cleanedBlueprint = appState.blueprintCategories
      .map(cat => ({
        id: cat.id,
        title: String(cat.title || "").trim(),
        originalTitle: cat.originalTitle || "",
        scopeHint: cat.scopeHint || "",
        seedSamples: Array.isArray(cat.seedSamples) ? cat.seedSamples : [],
        subfolders: (cat.subfolders || [])
          .map(s => ({
            id: s.id,
            title: String(s.title || "").trim(),
            originalTitle: s.originalTitle || "",
            scopeHint: s.scopeHint || "",
            seedSamples: Array.isArray(s.seedSamples) ? s.seedSamples : []
          }))
          .filter(s => s.title.length > 0)
      }))
      .filter(cat => cat.title.length > 0);

    if (cleanedBlueprint.length === 0) {
      showToast(t("reorg_toast_bp_min_one"), true);
      return;
    }

    appState.blueprintCategories = cleanedBlueprint;
    const iconStyle = document.getElementById("selRebuildIconStyle").value || "emoji";
    let blueprintTree = MarkFlowEngine.buildBlueprintTreeAnalysis(cleanedBlueprint, iconStyle);

    const translatedBlueprintMemory = MarkFlowEngine.translateDomainMemoryToBlueprint(
      appState.domainMemory,
      appState.treeAnalysis,
      blueprintTree
    );

    appState.activeReorgMode = "rebuild";
    appState.activeTargetFolders = blueprintTree.folders.filter(f => f.depth >= 2);
    appState.previewCategoryFilter = "ALL";

    const btnConfirm = document.getElementById("btnConfirmBlueprint");
    const progressBox = document.getElementById("reorgProgressContainer");
    const previewBox = document.getElementById("reorgPreviewContainer");

    btnConfirm.disabled = true;
    progressBox.classList.remove("hidden");
    previewBox.classList.add("hidden");

    try {
      await executeBatchMapping(
        appState.rebuildRawBookmarks,
        blueprintTree,
        true,
        translatedBlueprintMemory
      );

      const { consolidatedCategories, rolledUpCount } = MarkFlowEngine.consolidateOrphanSubfolders(
        appState.reorgItems,
        appState.blueprintCategories
      );
      appState.blueprintCategories = consolidatedCategories;
      blueprintTree = MarkFlowEngine.buildBlueprintTreeAnalysis(consolidatedCategories, iconStyle);
      appState.activeTargetFolders = blueprintTree.folders.filter(f => f.depth >= 2);
      renderBlueprintEditor();

      sortPreviewItemsByDestinationFolder();
      renderReorgPreviewTable();
      previewBox.classList.remove("hidden");
      previewBox.scrollIntoView({ behavior: "smooth", block: "start" });

      showToast(
        rolledUpCount > 0
          ? t("reorg_toast_mapped_orphan", { count: appState.reorgItems.length, orphan: rolledUpCount })
          : t("reorg_toast_mapped", { count: appState.reorgItems.length })
      );
    } catch (err) {
      showToast(t("reorg_toast_map_err", { msg: err.message }), true);
    } finally {
      btnConfirm.disabled = false;
      progressBox.classList.add("hidden");
    }
  }

  function sortPreviewItemsByDestinationFolder() {
    const byDest = new Map();
    for (const item of appState.reorgItems) {
      const key = String(item.targetFolderId || item.currentFolderId || "1");
      if (!byDest.has(key)) byDest.set(key, []);
      byDest.get(key).push(item);
    }

    const ordered = [];
    for (const [, list] of byDest.entries()) {
      ordered.push(...MarkFlowEngine.sortFolderBookmarksByPriority(list));
    }
    appState.reorgItems = ordered;
  }

  // ---------------- 批量映射核心调度 ---------------- //

  async function executeBatchMapping(
    rawBookmarks,
    targetTreeAnalysis,
    useDomainAffinity = true,
    domainMemoryOverride = null
  ) {
    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");

    const effectiveMemory = domainMemoryOverride || appState.domainMemory || {};
    const orderedBookmarks = MarkFlowEngine.clusterBookmarksForBatching(rawBookmarks);
    const collectedItems = [];

    const total = orderedBookmarks.length;
    const activeCfg = MarkFlowEngine.resolveActiveProviderConfig(appState.aiConfig);
    const canUseAI =
      activeCfg.enabled &&
      activeCfg.baseUrl &&
      (activeCfg.apiKey || activeCfg.provider === "ollama");
    const usePangu = appState.preferences.panguSpacing !== false;
    const ruleAiTitle = Boolean(appState.preferences.ruleMatchUseAiTitle && canUseAI);

    const BATCH_SIZE = 12;
    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = orderedBookmarks.slice(i, i + BATCH_SIZE);
      const unhandledByRule = [];

      for (const bm of batch) {
        let cleanTitle = MarkFlowEngine.cleanTitleLocally(bm.title);
        if (usePangu) cleanTitle = MarkFlowEngine.addPanguSpacing(cleanTitle);

        const matchedRule = !targetTreeAnalysis.isBlueprint
          ? MarkFlowEngine.matchRuleEngine(bm.url, appState.rules)
          : null;

        if (matchedRule) {
          const targetF = MarkFlowEngine.findFolderByRule(matchedRule, targetTreeAnalysis.folders);
          const destId = targetF ? targetF.id : bm.parentId;
          const destName = targetF ? targetF.breadcrumb : bm.parentTitle;

          if (ruleAiTitle) {
            try {
              cleanTitle = await MarkFlowEngine.generateCleanTitleOnly({
                url: bm.url,
                rawTitle: bm.title,
                localCleanTitle: cleanTitle,
                targetFolderName: destName,
                aiConfig: appState.aiConfig,
                preferences: appState.preferences,
                usePangu
              });
            } catch (e) {}
          }

          collectedItems.push({
            _origOrderIdx: bm._origOrderIdx ?? 0,
            id: bm.id,
            originalTitle: bm.title,
            url: bm.url,
            cleanTitle,
            currentFolderId: bm.parentId,
            currentFolderName: bm.parentTitle,
            targetFolderId: destId,
            targetFolderName: destName,
            funcGroup: MarkFlowEngine.inferLocalFuncGroup(bm.url, cleanTitle),
            reason: t("reorg_reason_rule", { name: matchedRule.name }),
            ignored: false
          });
          MarkFlowEngine.recordRollingMappingAnchor(targetTreeAnalysis, bm.url, cleanTitle, destId);
        } else {
          const domainAffinity = useDomainAffinity
            ? MarkFlowEngine.computeDomainAffinity(bm.url, targetTreeAnalysis, effectiveMemory)
            : null;
          unhandledByRule.push({ bm, cleanTitle, domainAffinity });
        }
      }

      if (unhandledByRule.length > 0) {
        if (canUseAI) {
          try {
            const aiResults = await MarkFlowEngine.classifyBatchBookmarks({
              items: unhandledByRule,
              treeAnalysis: targetTreeAnalysis,
              aiConfig: appState.aiConfig,
              preferences: appState.preferences,
              usePangu
            });

            unhandledByRule.forEach((item, idx) => {
              const res = aiResults[idx] || {};
              const finalTitle = res.cleanTitle || item.cleanTitle;
              const finalFolderId = res.targetFolderId || item.bm.parentId;
              collectedItems.push({
                _origOrderIdx: item.bm._origOrderIdx ?? 0,
                id: item.bm.id,
                originalTitle: item.bm.title,
                url: item.bm.url,
                cleanTitle: finalTitle,
                currentFolderId: item.bm.parentId,
                currentFolderName: item.bm.parentTitle,
                targetFolderId: finalFolderId,
                targetFolderName: res.targetFolderName || item.bm.parentTitle,
                funcGroup:
                  res.funcGroup || MarkFlowEngine.inferLocalFuncGroup(item.bm.url, finalTitle),
                reason: res.reason || t("reorg_reason_ai"),
                ignored: false
              });
              MarkFlowEngine.recordRollingMappingAnchor(
                targetTreeAnalysis,
                item.bm.url,
                finalTitle,
                finalFolderId
              );
            });
          } catch (err) {
            console.warn("Batch AI error, falling back:", err);
            const fallbackFolder =
              targetTreeAnalysis.folders.find(f => f.depth === 3) ||
              targetTreeAnalysis.folders.find(f => f.depth === 2) ||
              targetTreeAnalysis.folders[0];

            unhandledByRule.forEach(item => {
              const fbId = item.domainAffinity
                ? item.domainAffinity.folderId
                : targetTreeAnalysis.isBlueprint
                  ? fallbackFolder.id
                  : item.bm.parentId;
              const fbName = item.domainAffinity
                ? item.domainAffinity.breadcrumb
                : targetTreeAnalysis.isBlueprint
                  ? fallbackFolder.breadcrumb
                  : item.bm.parentTitle;

              collectedItems.push({
                _origOrderIdx: item.bm._origOrderIdx ?? 0,
                id: item.bm.id,
                originalTitle: item.bm.title,
                url: item.bm.url,
                cleanTitle: item.cleanTitle,
                currentFolderId: item.bm.parentId,
                currentFolderName: item.bm.parentTitle,
                targetFolderId: fbId,
                targetFolderName: fbName,
                funcGroup: MarkFlowEngine.inferLocalFuncGroup(item.bm.url, item.cleanTitle),
                reason: item.domainAffinity ? item.domainAffinity.reason : t("reorg_reason_fallback"),
                ignored: false
              });
            });
          }
        } else {
          unhandledByRule.forEach(item => {
            const fallbackId = item.domainAffinity
              ? item.domainAffinity.folderId
              : item.bm.parentId;
            const fallbackName = item.domainAffinity
              ? item.domainAffinity.breadcrumb
              : item.bm.parentTitle;
            collectedItems.push({
              _origOrderIdx: item.bm._origOrderIdx ?? 0,
              id: item.bm.id,
              originalTitle: item.bm.title,
              url: item.bm.url,
              cleanTitle: item.cleanTitle,
              currentFolderId: item.bm.parentId,
              currentFolderName: item.bm.parentTitle,
              targetFolderId: fallbackId,
              targetFolderName: fallbackName,
              funcGroup: MarkFlowEngine.inferLocalFuncGroup(item.bm.url, item.cleanTitle),
              reason: item.domainAffinity ? item.domainAffinity.reason : t("reorg_reason_local"),
              ignored: false
            });
          });
        }
      }

      const currentCount = Math.min(i + BATCH_SIZE, total);
      const pct = Math.round((currentCount / total) * 100);
      progressBar.style.width = `${pct}%`;
      progressText.textContent = t("reorg_prog_mapping", { done: currentCount, total });
      progressPercent.textContent = `${pct}%`;
    }

    collectedItems.sort((a, b) => a._origOrderIdx - b._origOrderIdx);
    appState.reorgItems = collectedItems;
  }

  // ---------------- 预览表格、KPI 统计与分类筛选 ---------------- //

  function resolveItemTopCategory(item, folderMapById) {
    const folder = folderMapById.get(String(item.targetFolderId));
    if (!folder) return { id: "OTHER", title: t("reorg_filter_other") };
    if (folder.depth === 2) return { id: String(folder.id), title: folder.title };
    if (folder.depth >= 3) {
      const topId = folder.topL1Id || folder.parentId;
      const parent = folderMapById.get(String(topId));
      if (parent) return { id: String(parent.id), title: parent.title };
    }
    return { id: String(folder.id), title: folder.title };
  }

  function updateReorgKpiSummary() {
    const active = appState.reorgItems.filter(i => !i.ignored);
    const changed = active.filter(
      i => i.cleanTitle !== i.originalTitle || String(i.targetFolderId) !== String(i.currentFolderId)
    );
    const uniqueFolders = new Set(active.map(i => String(i.targetFolderId || i.currentFolderId)));

    document.getElementById("kpiTotalCount").textContent = String(active.length);
    document.getElementById("kpiChangedCount").textContent = String(changed.length);
    document.getElementById("kpiFolderCount").textContent = String(uniqueFolders.size);
  }

  function renderPreviewCategoryStatsBar(folderChoices) {
    const bar = document.getElementById("reorgCategoryStatsBar");
    if (!bar) return;
    bar.innerHTML = "";

    const folderMapById = new Map(folderChoices.map(f => [String(f.id), f]));
    const countsByL1 = new Map();
    let activeTotal = 0;

    folderChoices
      .filter(f => f.depth === 2)
      .forEach(f => {
        countsByL1.set(String(f.id), { id: String(f.id), title: f.title, count: 0 });
      });

    for (const item of appState.reorgItems) {
      if (item.ignored) continue;
      activeTotal++;
      const top = resolveItemTopCategory(item, folderMapById);
      if (!countsByL1.has(top.id)) {
        countsByL1.set(top.id, { id: top.id, title: top.title, count: 0 });
      }
      countsByL1.get(top.id).count++;
    }

    const makePill = (filterId, label, count) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className =
        "stat-filter-pill" + (appState.previewCategoryFilter === filterId ? " active" : "");
      btn.innerHTML = `<span>${escapeHtml(label)}</span><span class="stat-pill-count">${count}</span>`;
      btn.addEventListener("click", () => {
        appState.previewCategoryFilter = filterId;
        renderReorgPreviewTable();
      });
      return btn;
    };

    bar.appendChild(makePill("ALL", t("reorg_filter_all"), activeTotal));
    for (const entry of countsByL1.values()) {
      if (entry.count > 0 || appState.previewCategoryFilter === entry.id) {
        bar.appendChild(makePill(entry.id, entry.title, entry.count));
      }
    }
  }

  function renderReorgPreviewTable() {
    const tbody = document.getElementById("reorgPreviewTableBody");
    tbody.innerHTML = "";

    const folderChoices =
      appState.activeTargetFolders && appState.activeTargetFolders.length > 0
        ? appState.activeTargetFolders
        : appState.allFoldersTree;

    const folderMapById = new Map(folderChoices.map(f => [String(f.id), f]));
    updateReorgKpiSummary();
    renderPreviewCategoryStatsBar(folderChoices);

    const restoreSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
    const skipSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

    let renderedCount = 0;

    appState.reorgItems.forEach((item, idx) => {
      if (appState.previewCategoryFilter !== "ALL") {
        const top = resolveItemTopCategory(item, folderMapById);
        if (top.id !== appState.previewCategoryFilter) return;
      }
      renderedCount++;

      const tr = document.createElement("tr");
      if (item.ignored) tr.style.opacity = "0.42";

      const groupBadge =
        item.funcGroup && item.funcGroup !== "常规条目"
          ? `<span class="func-group-badge">${escapeHtml(item.funcGroup)}</span>`
          : "";

      tr.innerHTML = `
        <td>
          <div style="font-weight: 600; font-size: 13px; max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(item.originalTitle)}">${escapeHtml(item.originalTitle)}</div>
          <div style="font-size: 11px; color: var(--text-muted); max-width: 240px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" class="font-mono">${escapeHtml(item.url)}</div>
        </td>
        <td>
          <input type="text" class="form-input reorg-title-input" data-idx="${idx}" value="${escapeHtml(item.cleanTitle)}" style="font-size: 12px; padding: 6px 8px;">
          <div style="font-size: 11px; color: var(--accent); margin-top: 3px; display: flex; align-items: center; flex-wrap: wrap;">
            <span>${escapeHtml(item.reason)}</span>${groupBadge}
          </div>
        </td>
        <td>
          <span class="text-muted" style="font-size: 12px;" title="${escapeHtml(item.currentFolderName)}">${escapeHtml(item.currentFolderName)}</span>
        </td>
        <td>
          <select class="form-select font-mono reorg-folder-select" data-idx="${idx}" style="font-size: 11px; padding: 4px 6px;"></select>
        </td>
        <td style="text-align: right;">
          <button class="icon-action-btn reorg-toggle-btn" data-idx="${idx}" type="button" title="${escapeHtml(item.ignored ? t("reorg_action_restore") : t("reorg_action_skip"))}">
            ${item.ignored ? restoreSvg : skipSvg}
          </button>
        </td>
      `;

      const sel = tr.querySelector(".reorg-folder-select");
      folderChoices.forEach(f => {
        const opt = document.createElement("option");
        opt.value = f.id;
        opt.textContent = f.displayText;
        if (String(f.id) === String(item.targetFolderId)) opt.selected = true;
        sel.appendChild(opt);
      });

      tbody.appendChild(tr);
    });

    if (renderedCount === 0) {
      tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color:var(--text-muted); padding:20px;">${escapeHtml(
        t("reorg_filter_empty")
      )}</td></tr>`;
    }

    tbody.querySelectorAll(".reorg-title-input").forEach(inp => {
      inp.addEventListener("input", e => {
        const idx = Number(e.target.getAttribute("data-idx"));
        appState.reorgItems[idx].cleanTitle = e.target.value.trim();
        updateReorgKpiSummary();
      });
    });

    tbody.querySelectorAll(".reorg-folder-select").forEach(sel => {
      sel.addEventListener("change", e => {
        const idx = Number(e.target.getAttribute("data-idx"));
        appState.reorgItems[idx].targetFolderId = e.target.value;
        const f = folderChoices.find(item => String(item.id) === String(e.target.value));
        if (f) appState.reorgItems[idx].targetFolderName = f.breadcrumb;
        updateReorgKpiSummary();
        renderPreviewCategoryStatsBar(folderChoices);
      });
    });

    tbody.querySelectorAll(".reorg-toggle-btn").forEach(btn => {
      btn.addEventListener("click", e => {
        const idx = Number(e.currentTarget.getAttribute("data-idx"));
        appState.reorgItems[idx].ignored = !appState.reorgItems[idx].ignored;
        renderReorgPreviewTable();
      });
    });
  }

  // ---------------- 原子落地、倒序精准排序与自动 HTML 备份 ---------------- //

  /**
   * 对单个 Chrome 目录内的子节点实施确定性排序：
   * 先将子文件夹倒序移至索引 0 保持置顶，再将目标书签按倒序移至子文件夹末尾位置。
   * 全部移动均为“向更小索引移动”，可彻底避免 Chromium 同目录前向移动引起的索引偏移问题。
   */
  async function enforceFolderBookmarkOrder(folderId, orderedBookmarkIds) {
    if (!folderId || !orderedBookmarkIds || orderedBookmarkIds.length <= 1) return;
    const fid = String(folderId);
    const liveChildren = await chrome.bookmarks.getChildren(fid);
    const subfolders = liveChildren.filter(c => !c.url);
    const liveBookmarkIds = new Set(liveChildren.filter(c => !!c.url).map(c => String(c.id)));

    for (let s = subfolders.length - 1; s >= 0; s--) {
      await chrome.bookmarks.move(String(subfolders[s].id), { parentId: fid, index: 0 });
    }

    const targetStartIdx = subfolders.length;
    const validOrdered = orderedBookmarkIds.filter(id => liveBookmarkIds.has(String(id)));
    for (let i = validOrdered.length - 1; i >= 0; i--) {
      await chrome.bookmarks.move(String(validOrdered[i]), {
        parentId: fid,
        index: targetStartIdx
      });
    }
  }

  async function applyReorganizerChanges() {
    const activeItems = appState.reorgItems.filter(i => !i.ignored);
    if (activeItems.length === 0) {
      showToast(t("reorg_toast_no_active"), true);
      return;
    }

    const btnApply = document.getElementById("btnApplyReorganize");
    btnApply.disabled = true;

    try {
      // 执行任何书签变更前，先导出标准 Netscape HTML 安全备份
      await downloadBookmarksBackup();

      if (appState.activeReorgMode === "rebuild") {
        const virtualToRealId = new Map();
        const protectedNewIds = new Set();

        for (const cat of appState.blueprintCategories) {
          const createdL1 = await chrome.bookmarks.create({ parentId: "1", title: cat.title });
          virtualToRealId.set(String(cat.id), String(createdL1.id));
          protectedNewIds.add(String(createdL1.id));

          for (const sub of cat.subfolders || []) {
            const createdL2 = await chrome.bookmarks.create({
              parentId: String(createdL1.id),
              title: sub.title
            });
            virtualToRealId.set(String(sub.id), String(createdL2.id));
            protectedNewIds.add(String(createdL2.id));
          }
        }

        const itemsByRealFolder = new Map();
        let updatedCount = 0;
        for (const item of activeItems) {
          if (item.cleanTitle && item.cleanTitle !== item.originalTitle) {
            await chrome.bookmarks.update(item.id, { title: item.cleanTitle });
          }
          const realDestId = virtualToRealId.get(String(item.targetFolderId)) || "1";
          if (String(realDestId) !== String(item.currentFolderId)) {
            await chrome.bookmarks.move(item.id, { parentId: String(realDestId) });
          }
          if (!itemsByRealFolder.has(realDestId)) itemsByRealFolder.set(realDestId, []);
          itemsByRealFolder.get(realDestId).push(item);
          updatedCount++;
        }

        for (const [fid, bucket] of itemsByRealFolder.entries()) {
          const sorted = MarkFlowEngine.sortFolderBookmarksByPriority(bucket);
          await enforceFolderBookmarkOrder(fid, sorted.map(it => it.id));
        }

        const removedFolders = await cleanupEmptyOldFolders(protectedNewIds, appState.lockedL1Ids);

        appState.domainMemory = MarkFlowEngine.migrateDomainMemoryAfterRebuild({
          oldDomainMemory: appState.domainMemory,
          oldTreeAnalysis: appState.treeAnalysis,
          activeItems,
          virtualToRealId,
          lockedL1Ids: appState.lockedL1Ids
        });
        await chrome.storage.local.set({ domainMemory: appState.domainMemory });

        document.getElementById("reorgBlueprintContainer").classList.add("hidden");
        document.getElementById("reorgPreviewContainer").classList.add("hidden");
        showToast(t("reorg_toast_rebuild_done", { count: updatedCount, removed: removedFolders }));
      } else {
        const shouldSort =
          appState.activeReorgMode === "sort_only" ||
          document.getElementById("chkSortInFolders").checked;

        const itemsByDestFolder = new Map();
        let updatedCount = 0;

        for (const item of activeItems) {
          if (item.cleanTitle && item.cleanTitle !== item.originalTitle) {
            await chrome.bookmarks.update(item.id, { title: item.cleanTitle });
          }
          const destId = String(item.targetFolderId || item.currentFolderId);
          if (destId !== String(item.currentFolderId)) {
            await chrome.bookmarks.move(item.id, { parentId: destId });
          }
          if (!itemsByDestFolder.has(destId)) itemsByDestFolder.set(destId, []);
          itemsByDestFolder.get(destId).push(item);
          updatedCount++;
        }

        let sortedFoldersCount = 0;
        if (shouldSort) {
          for (const [fid, bucket] of itemsByDestFolder.entries()) {
            if (bucket.length > 1) {
              const sorted = MarkFlowEngine.sortFolderBookmarksByPriority(bucket);
              await enforceFolderBookmarkOrder(fid, sorted.map(it => it.id));
              sortedFoldersCount++;
            }
          }
        }

        document.getElementById("reorgPreviewContainer").classList.add("hidden");
        showToast(
          shouldSort
            ? t("reorg_toast_existing_sorted_done", { count: updatedCount, folders: sortedFoldersCount })
            : t("reorg_toast_existing_done", { count: updatedCount })
        );
      }

      const postTree = await chrome.bookmarks.getTree();
      parseFolderStructures(postTree);
      populateReorgFolderSelect();
      renderLockedFoldersChecklist();
      setStartButtonDemoted(false);
    } catch (err) {
      showToast(t("reorg_toast_apply_err", { msg: err.message }), true);
    } finally {
      btnApply.disabled = false;
    }
  }

  /** 后序遍历清理迁空后的旧文件夹（仅使用 remove 而非 removeTree，确保非空及锁定目录绝对安全） */
  async function cleanupEmptyOldFolders(protectedNewIds, lockedL1Ids) {
    let removedCount = 0;
    const freshTree = await chrome.bookmarks.getTree();
    const rootChildren = (freshTree[0] && freshTree[0].children) || [];

    async function sweepFolder(node, insideLocked = false) {
      if (!node || node.url !== undefined) return;
      const idStr = String(node.id);
      const isLockedSubtree = insideLocked || lockedL1Ids.has(idStr);

      if (node.children && node.children.length > 0) {
        for (const child of node.children) {
          if (child.url === undefined) {
            await sweepFolder(child, isLockedSubtree);
          }
        }
      }

      if (
        idStr === "0" ||
        idStr === "1" ||
        idStr === "2" ||
        idStr === "3" ||
        isLockedSubtree ||
        protectedNewIds.has(idStr)
      ) {
        return;
      }

      try {
        const liveChildren = await chrome.bookmarks.getChildren(idStr);
        if (liveChildren.length === 0) {
          await chrome.bookmarks.remove(idStr);
          removedCount++;
        }
      } catch (e) {}
    }

    for (const rootContainer of rootChildren) {
      await sweepFolder(rootContainer, false);
    }
    return removedCount;
  }

  function generateNetscapeBookmarkHtml(tree) {
    let html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
`;

    function traverse(node, indent = "    ") {
      let result = "";
      if (!node.children) return result;

      for (const child of node.children) {
        if (child.url) {
          result += `${indent}<DT><A HREF="${escapeHtml(child.url)}" ADD_DATE="${Math.floor(Date.now() / 1000)}">${escapeHtml(child.title)}</A>\n`;
        } else {
          result += `${indent}<DT><H3 ADD_DATE="${Math.floor(Date.now() / 1000)}">${escapeHtml(child.title)}</H3>\n`;
          result += `${indent}<DL><p>\n`;
          result += traverse(child, indent + "    ");
          result += `${indent}</DL><p>\n`;
        }
      }
      return result;
    }

    html += traverse(tree[0]);
    html += `</DL><p>\n`;
    return html;
  }

  function formatFolderTrail(parentTrail, folderNode) {
    const name = (folderNode.title || "").trim();
    const idStr = String(folderNode.id || "");
    if (!name || idStr === "0" || idStr === "1" || idStr === "2" || idStr === "3") {
      return parentTrail || name || "Bookmarks Bar";
    }
    if (!parentTrail || /^(根目录|书签栏|其他书签|移动设备书签|Bookmarks bar|Other bookmarks)$/i.test(parentTrail)) {
      return name;
    }
    return `${parentTrail} › ${name}`;
  }

  function collectBookmarks(nodes, parentTrail = "") {
    let list = [];
    if (!nodes) return list;

    for (const node of nodes) {
      if (node.url) {
        list.push({
          id: String(node.id),
          title: node.title,
          url: node.url,
          parentId: String(node.parentId || ""),
          parentTitle: parentTrail || "Bookmarks Bar"
        });
      } else if (node.children) {
        list = list.concat(collectBookmarks(node.children, formatFolderTrail(parentTrail, node)));
      }
    }
    return list;
  }

  function collectUnlockedBookmarks(nodes, lockedL1Set, parentTrail = "") {
    let list = [];
    if (!nodes) return list;

    for (const node of nodes) {
      if (node.url) {
        list.push({
          id: String(node.id),
          title: node.title,
          url: node.url,
          parentId: String(node.parentId || ""),
          parentTitle: parentTrail || "Bookmarks Bar"
        });
      } else if (node.children) {
        if (lockedL1Set && lockedL1Set.has(String(node.id))) continue;
        list = list.concat(
          collectUnlockedBookmarks(node.children, lockedL1Set, formatFolderTrail(parentTrail, node))
        );
      }
    }
    return list;
  }

  function findNodeById(node, id) {
    if (String(node.id) === String(id)) return node;
    if (!node.children) return null;
    for (const child of node.children) {
      const found = findNodeById(child, id);
      if (found) return found;
    }
    return null;
  }

  ctx.initReorganizeTab = initReorganizeTab;
  ctx.syncReorgStartButtonLabel = syncReorgStartButtonLabel;
  ctx.populateReorgFolderSelect = populateReorgFolderSelect;
  ctx.renderLockedFoldersChecklist = renderLockedFoldersChecklist;
})(window);
