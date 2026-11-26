/**
 * 智能整理与书签库清理工作台模块
 *
 * 支持五种工作流（均配备阶段聚焦折叠、随时 AbortController 中止及强制安全备份）：
 * 1. 归入现有目录 & 内部优先级排序
 * 2. 零 Token 纯目录内优先级排序
 * 3. 两阶段全盘目录体系重构（蓝图审阅编辑 → 批量映射与孤岛收敛 → 原子落地与旧空目录清理）
 * 4. 零 Token 重复书签规范化合并
 * 5. 零 Token 失效链接并发探测与分级清理（按需临时授权，扫完自动撤销）
 */

(function (global) {
  "use strict";

  const ctx = global.MarkFlowOptions;
  const { appState, t, parseFolderStructures, showToast, formatFriendlyAiError } = ctx;
  const { escapeHtml } = MarkFlowEngine;

  const DEADLINK_HOST_ORIGINS = ["https://*/*", "http://*/*"];

  let lastBatchMappingContext = null;
  let lastBatchErrorSummary = "";
  let lastConfigSummaryMeta = null;
  let reorgRetryInFlight = false;
  let activeAbortController = null;
  let activeRunKind = null;
  let currentWorkspaceStage = "config"; // "config" | "blueprint" | "preview"

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

  function isAbortedSignalOrErr(signal, err) {
    return Boolean((signal && signal.aborted) || (err && MarkFlowEngine.isAbortError(err)));
  }

  function setActionButtonsDisabled(disabled) {
    [
      "btnStartReorganize",
      "btnQuickSortOnly",
      "btnSummaryRerun",
      "btnRegenBlueprint",
      "btnConfirmBlueprint",
      "btnApplyReorganize",
      "btnRetryFailedReorg",
      "btnResumeUnprocessed"
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = disabled;
    });
  }

  function beginCancellableRun(kind, subHintKey = "reorg_prog_cancel_hint") {
    if (activeAbortController) {
      activeAbortController.abort();
    }
    activeRunKind = kind;
    activeAbortController = typeof AbortController === "function" ? new AbortController() : null;

    const progressBox = document.getElementById("reorgProgressContainer");
    const subEl = document.getElementById("reorgProgressSub");
    const cancelBtn = document.getElementById("btnCancelReorg");
    const cancelLbl = document.getElementById("btnCancelReorgLabel");

    if (subEl) subEl.textContent = t(subHintKey);
    if (cancelBtn) cancelBtn.disabled = false;
    if (cancelLbl) cancelLbl.textContent = t("reorg_btn_cancel");
    if (progressBox) progressBox.classList.remove("hidden");

    setActionButtonsDisabled(true);
    return activeAbortController ? activeAbortController.signal : null;
  }

  function cancelActiveReorgTask() {
    if (!activeAbortController) return;
    const cancelBtn = document.getElementById("btnCancelReorg");
    const cancelLbl = document.getElementById("btnCancelReorgLabel");
    if (cancelBtn) cancelBtn.disabled = true;
    if (cancelLbl) cancelLbl.textContent = t("reorg_btn_canceling");
    activeAbortController.abort();
  }

  function endCancellableRun() {
    activeAbortController = null;
    activeRunKind = null;
    const progressBox = document.getElementById("reorgProgressContainer");
    const cancelBtn = document.getElementById("btnCancelReorg");
    const cancelLbl = document.getElementById("btnCancelReorgLabel");
    if (progressBox) progressBox.classList.add("hidden");
    if (cancelBtn) cancelBtn.disabled = false;
    if (cancelLbl) cancelLbl.textContent = t("reorg_btn_cancel");
    setActionButtonsDisabled(false);
  }

  function getSelectedSortRule() {
    const sel = document.getElementById("selReorgSortRule");
    return (sel && sel.value) || (appState.preferences && appState.preferences.reorgSortRule) || "smart";
  }

  function getFolderMap() {
    return appState.treeAnalysis && appState.treeAnalysis.folderMap
      ? appState.treeAnalysis.folderMap
      : new Map();
  }

  function isCoveredBySelectedAncestor(folderId, selectedSet, folderMap) {
    if (!selectedSet || selectedSet.size === 0 || !folderMap) return false;
    let cur = folderMap.get(String(folderId));
    const visited = new Set([String(folderId)]);
    while (cur && cur.parentId) {
      const pid = String(cur.parentId);
      if (visited.has(pid)) break;
      visited.add(pid);
      if (selectedSet.has(pid)) return true;
      cur = folderMap.get(pid);
    }
    return false;
  }

  function pruneSelectedScopeIds() {
    if (!appState.selectedScopeFolderIds) appState.selectedScopeFolderIds = new Set();
    const folderMap = getFolderMap();
    for (const id of Array.from(appState.selectedScopeFolderIds)) {
      if (!folderMap.has(String(id))) {
        appState.selectedScopeFolderIds.delete(id);
      }
    }
    for (const id of Array.from(appState.selectedScopeFolderIds)) {
      if (isCoveredBySelectedAncestor(id, appState.selectedScopeFolderIds, folderMap)) {
        appState.selectedScopeFolderIds.delete(id);
      }
    }
  }

  function getSelectedScopeFolders(tree) {
    pruneSelectedScopeIds();
    const selectedSet = appState.selectedScopeFolderIds;
    if (!selectedSet || selectedSet.size === 0) return [];
    const ordered = (appState.allFoldersTree || []).filter(f => selectedSet.has(String(f.id)));
    if (ordered.length > 0 || !tree || !tree[0]) return ordered;
    const fallback = [];
    selectedSet.forEach(fid => {
      const node = findNodeById(tree[0], fid);
      if (node) {
        fallback.push({
          id: String(node.id),
          title: node.title || String(fid),
          breadcrumb: node.title || String(fid)
        });
      }
    });
    return fallback;
  }

  function formatScopeSelectionText(selectedFolders, emptyKey = "reorg_scope_none") {
    if (!selectedFolders || selectedFolders.length === 0) return t(emptyKey);
    if (selectedFolders.length === 1) {
      const f = selectedFolders[0];
      return f.breadcrumb || f.title;
    }
    const previewNames = selectedFolders
      .slice(0, 2)
      .map(f => f.title || f.breadcrumb)
      .join(" / ");
    return t("reorg_scope_summary", {
      count: selectedFolders.length,
      names: selectedFolders.length > 2 ? `${previewNames}…` : previewNames
    });
  }

  function getScopeSummaryLabel(tree) {
    const radioAll = document.getElementById("radioScopeAll");
    if (!radioAll || radioAll.checked) return t("reorg_scope_all");
    return formatScopeSelectionText(getSelectedScopeFolders(tree), "reorg_scope_select");
  }

  function getModeBadgeText(mode) {
    if (mode === "rebuild") return t("reorg_mode_rebuild");
    if (mode === "sort_only") return t("btn_quick_sort_only");
    if (mode === "dedup") return t("reorg_mode_dedup");
    if (mode === "deadlinks") return t("reorg_mode_deadlinks");
    return t("reorg_mode_existing");
  }

  function buildSummaryDetailText(mode, meta = {}) {
    const scopeLabel = meta.scopeLabel || getScopeSummaryLabel();
    if (mode === "rebuild") {
      const lockedCnt = appState.lockedL1Ids ? appState.lockedL1Ids.size : 0;
      const lockedShort = t("reorg_locked_label").replace(/[（(].*$/, "").trim();
      return `${t("reorg_mode_rebuild")} · ${lockedShort}: ${lockedCnt}`;
    }
    if (mode === "dedup") {
      const stratSel = document.getElementById("selDedupStrategy");
      const stratOpt = stratSel && stratSel.options[stratSel.selectedIndex];
      const stratLabel = stratOpt ? stratOpt.textContent : "";
      return `${t("reorg_scope_label")}: ${scopeLabel}${stratLabel ? ` · ${stratLabel}` : ""}`;
    }
    if (mode === "deadlinks") {
      const skipLocal = document.getElementById("chkDeadlinkSkipLocal");
      const skipStr = skipLocal && skipLocal.checked ? t("reorg_dead_skip_local") : t("reorg_tab_all");
      return `${t("reorg_scope_label")}: ${scopeLabel} · ${skipStr}`;
    }
    const selRule = document.getElementById("selReorgSortRule");
    const ruleOpt = selRule && selRule.options[selRule.selectedIndex];
    const ruleLabel = ruleOpt ? ruleOpt.textContent : "";
    return `${t("reorg_scope_label")}: ${scopeLabel}${ruleLabel ? ` · ${ruleLabel}` : ""}`;
  }

  function syncSummaryBarDom() {
    const bar = document.getElementById("reorgConfigSummaryBar");
    const badgeEl = document.getElementById("reorgSummaryModeBadge");
    const textEl = document.getElementById("reorgSummaryText");
    const toggleLbl = document.getElementById("btnToggleConfigDrawerLabel");
    const rerunLbl = document.getElementById("btnSummaryRerunLabel");
    const card = document.getElementById("reorgConfigCard");
    if (!bar || !card) return;

    const showSummary = currentWorkspaceStage !== "config";
    bar.classList.toggle("hidden", !showSummary);
    card.classList.toggle("hidden", showSummary && !appState.reorgConfigExpanded);
    bar.classList.toggle("is-expanded", showSummary && appState.reorgConfigExpanded);

    if (showSummary) {
      const effectiveMode = (lastConfigSummaryMeta && lastConfigSummaryMeta.mode) || appState.activeReorgMode || appState.reorgMode;
      if (badgeEl) badgeEl.textContent = getModeBadgeText(effectiveMode);
      if (textEl) textEl.textContent = buildSummaryDetailText(effectiveMode, lastConfigSummaryMeta || {});
      if (toggleLbl) {
        toggleLbl.textContent = appState.reorgConfigExpanded
          ? t("reorg_btn_collapse_config")
          : t("reorg_btn_edit_config");
      }
      if (rerunLbl) {
        const isScan = effectiveMode === "dedup" || effectiveMode === "deadlinks";
        rerunLbl.textContent = isScan ? t("reorg_btn_rescan") : t("btn_reorg_rerun");
      }
    }
  }

  /** 控制工作台阶段焦点：进入蓝图或预览后自动折叠配置大卡为一行摘要条，把首屏空间留给待审列表 */
  function enterWorkspaceStage(stage, summaryMeta = null) {
    currentWorkspaceStage = stage;
    if (summaryMeta) lastConfigSummaryMeta = summaryMeta;

    if (stage === "config") {
      appState.reorgConfigExpanded = true;
      document.getElementById("reorgBlueprintContainer").classList.add("hidden");
      document.getElementById("reorgPreviewContainer").classList.add("hidden");
    } else if (stage === "blueprint") {
      appState.reorgConfigExpanded = false;
      document.getElementById("reorgBlueprintContainer").classList.remove("hidden");
      document.getElementById("reorgPreviewContainer").classList.add("hidden");
    } else if (stage === "preview") {
      appState.reorgConfigExpanded = false;
      document.getElementById("reorgPreviewContainer").classList.remove("hidden");
    }

    syncSummaryBarDom();
  }

  /** 判断单条 AI 预览项是否包含实质变动（标题修改、目标目录变更或同目录内排序移位） */
  function isItemChanged(item) {
    if (!item) return false;
    return (
      (item.cleanTitle && item.cleanTitle !== item.originalTitle) ||
      String(item.targetFolderId) !== String(item.currentFolderId) ||
      Boolean(item.orderChanged)
    );
  }

  function isItemSucceededChanged(item) {
    return Boolean(item && !item.ignored && !item.aiFailed && !item.unprocessed && isItemChanged(item));
  }

  /** 判断条目在“全部变动/默认审阅”模式下是否可见（包含已整理变动项与失败待重试项） */
  function isItemVisibleInPreview(item) {
    if (!item) return false;
    return isItemChanged(item) || Boolean(item.aiFailed) || Boolean(item.unprocessed);
  }

  /**
   * 标记每个目标目录内的书签是否发生相对位置变化：
   * 比较调整后同目录内的书签顺序与原书签顺序，仅对实际发生移位的条目或迁入新条目置为 orderChanged=true。
   */
  function markOrderChangedFlags(items) {
    if (!Array.isArray(items)) return;
    items.forEach(it => {
      it.orderChanged = false;
    });

    if (appState.activeReorgMode === "rebuild") {
      items.forEach(it => {
        if (String(it.targetFolderId) !== String(it.currentFolderId)) {
          it.orderChanged = false;
        }
      });
      return;
    }

    const shouldSort =
      appState.activeReorgMode === "sort_only" ||
      (document.getElementById("chkSortInFolders") &&
        document.getElementById("chkSortInFolders").checked);

    const byTarget = new Map();
    for (const item of items) {
      if (item.ignored || item.unprocessed) continue;
      const destId = String(item.targetFolderId || item.currentFolderId || "1");
      if (!byTarget.has(destId)) byTarget.set(destId, []);
      byTarget.get(destId).push(item);
    }

    for (const [destId, bucket] of byTarget.entries()) {
      const stayed = bucket.filter(it => String(it.currentFolderId) === destId);
      const hasIncoming = stayed.length < bucket.length;

      if (!shouldSort && !hasIncoming) continue;

      const origOrdered = [...stayed].sort((a, b) => {
        const idxDiff = (a.origIndex ?? 0) - (b.origIndex ?? 0);
        return idxDiff !== 0 ? idxDiff : (a._origOrderIdx ?? 0) - (b._origOrderIdx ?? 0);
      });
      const origRankMap = new Map(origOrdered.map((it, idx) => [String(it.id), idx]));

      bucket.forEach((it, newIdx) => {
        if (String(it.currentFolderId) !== destId) {
          it.orderChanged = false;
          return;
        }
        if (hasIncoming) {
          if (origRankMap.get(String(it.id)) !== newIdx) {
            it.orderChanged = true;
          }
        } else if (origRankMap.get(String(it.id)) !== newIdx) {
          it.orderChanged = true;
        }
      });
    }
  }

  function formatApproxTokens(count) {
    if (count >= 1000) {
      return `~${(count / 1000).toFixed(1)}K`;
    }
    return `~${count}`;
  }

  function collectScopedBookmarksFromTree(tree) {
    const radioAll = document.getElementById("radioScopeAll");
    const isAll = !radioAll || radioAll.checked;
    const rootChildren = (tree && tree[0] && tree[0].children) || [];
    if (isAll) {
      return collectBookmarks(rootChildren);
    }

    pruneSelectedScopeIds();
    const selectedSet = appState.selectedScopeFolderIds;
    if (!selectedSet || selectedSet.size === 0) return [];

    const list = [];
    const seenIds = new Set();

    function walkScoped(nodes, parentTrail = "", parentIsRoot = false, inScope = false) {
      if (!nodes) return;
      for (const node of nodes) {
        if (node.url) {
          if (!inScope) continue;
          const bid = String(node.id);
          if (seenIds.has(bid)) continue;
          seenIds.add(bid);
          list.push({
            id: bid,
            title: node.title,
            url: node.url,
            origIndex: Number(node.index ?? 0),
            dateAdded: Number(node.dateAdded || 0),
            parentId: String(node.parentId || ""),
            parentTitle: parentTrail || "Bookmarks Bar"
          });
        } else if (node.children) {
          const nextIsRoot = MarkFlowEngine.platform.isRootBookmarkNode(node);
          const nextInScope = inScope || selectedSet.has(String(node.id));
          walkScoped(
            node.children,
            formatFolderTrail(parentTrail, node, parentIsRoot),
            nextIsRoot,
            nextInScope
          );
        }
      }
    }

    walkScoped(rootChildren, "", false, false);
    return list;
  }

  function ensureValidScopeSelection() {
    const radioAll = document.getElementById("radioScopeAll");
    if (!radioAll || radioAll.checked) return true;
    pruneSelectedScopeIds();
    if (appState.selectedScopeFolderIds.size > 0) return true;

    showToast(t("reorg_scope_toast_need_folder"), true);
    if (currentWorkspaceStage !== "config" && !appState.reorgConfigExpanded) {
      appState.reorgConfigExpanded = true;
      syncSummaryBarDom();
    }
    // 延迟至当前点击事件冒泡完成后再打开浮层，避免触发 document 的外部点击关闭逻辑
    setTimeout(() => openScopeFoldersMenu(), 0);
    return false;
  }

  /** 根据当前模式、书签范围与本地规则命中率计算并渲染预计消耗或扫描提示 */
  async function updateReorgTokenEstimate() {
    const el = document.getElementById("reorgTokenEstimate");
    const textEl = document.getElementById("reorgTokenEstimateText");
    if (!el || !textEl || typeof chrome === "undefined" || !chrome.bookmarks) return;

    try {
      const tree = await chrome.bookmarks.getTree();
      let scopedBookmarks = [];
      if (appState.reorgMode === "rebuild") {
        scopedBookmarks = collectUnlockedBookmarks(tree[0].children || [], appState.lockedL1Ids);
      } else {
        scopedBookmarks = collectScopedBookmarksFromTree(tree);
      }

      const radioFolder = document.getElementById("radioScopeFolder");
      el.classList.remove("is-free", "is-empty");
      if (
        appState.reorgMode !== "rebuild" &&
        radioFolder &&
        radioFolder.checked &&
        appState.selectedScopeFolderIds.size === 0
      ) {
        textEl.textContent = t("reorg_scope_est_pick_hint");
        return;
      }
      if (scopedBookmarks.length === 0) {
        textEl.textContent = t("reorg_est_empty");
        return;
      }

      if (appState.reorgMode === "dedup") {
        el.classList.add("is-free");
        textEl.textContent = t("reorg_est_dedup", { total: scopedBookmarks.length });
        return;
      }

      if (appState.reorgMode === "deadlinks") {
        const skipLocal =
          document.getElementById("chkDeadlinkSkipLocal") &&
          document.getElementById("chkDeadlinkSkipLocal").checked;
        const checkable = scopedBookmarks.filter(bm => {
          if (!MarkFlowEngine.isCheckableHttpUrl(bm.url)) return false;
          if (skipLocal && MarkFlowEngine.isPrivateOrLocalUrl(bm.url)) return false;
          return true;
        });
        el.classList.add("is-free");
        textEl.textContent = t("reorg_est_deadlinks", {
          count: checkable.length,
          total: scopedBookmarks.length
        });
        return;
      }

      const est = MarkFlowEngine.estimateReorganizeTokens({
        mode: appState.reorgMode,
        bookmarks: scopedBookmarks,
        rules: appState.rules,
        treeAnalysis: appState.treeAnalysis,
        aiConfig: appState.aiConfig,
        preferences: appState.preferences
      });

      if (!est.aiEnabled && appState.reorgMode !== "rebuild") {
        el.classList.add("is-free");
        textEl.textContent = t("reorg_est_zero_ai", { total: est.totalBookmarks });
      } else if (est.isLocalFree) {
        el.classList.add("is-free");
        textEl.textContent = t("reorg_est_tokens_local", {
          tokens: formatApproxTokens(est.estimatedTokens),
          batches: est.batchCount
        });
      } else {
        textEl.textContent = t("reorg_est_tokens", {
          provider: est.providerLabel,
          tokens: formatApproxTokens(est.estimatedTokens),
          batches: est.batchCount,
          aiCount: est.aiCount,
          ruleCount: est.ruleMatchedCount
        });
      }
    } catch (e) {}
  }

  function initReorganizeTab() {
    const modeRadios = [
      { mode: "existing", radio: "radioModeExisting", card: "modeCardExisting" },
      { mode: "rebuild", radio: "radioModeRebuild", card: "modeCardRebuild" },
      { mode: "dedup", radio: "radioModeDedup", card: "modeCardDedup" },
      { mode: "deadlinks", radio: "radioModeDeadlinks", card: "modeCardDeadlinks" }
    ];

    const scopePanel = document.getElementById("reorgSharedScopePanel");
    const existingOpts = document.getElementById("existingModeOptions");
    const rebuildOpts = document.getElementById("rebuildModeOptions");
    const dedupOpts = document.getElementById("dedupModeOptions");
    const deadlinkOpts = document.getElementById("deadlinkModeOptions");

    const radioAll = document.getElementById("radioScopeAll");
    const radioFolder = document.getElementById("radioScopeFolder");
    const lblScopeAll = document.getElementById("lblScopeAll");
    const lblScopeFolder = document.getElementById("lblScopeFolder");
    const folderGroup = document.getElementById("reorgFolderSelectGroup");

    const syncScopeSegmentedUi = () => {
      const isFolder = Boolean(radioFolder && radioFolder.checked);
      if (lblScopeAll) lblScopeAll.classList.toggle("is-active", !isFolder);
      if (lblScopeFolder) lblScopeFolder.classList.toggle("is-active", isFolder);
      if (folderGroup) folderGroup.classList.toggle("hidden", !isFolder);
      if (!isFolder) closeScopeFoldersMenu();
    };

    const selSortRule = document.getElementById("selReorgSortRule");
    if (selSortRule) {
      selSortRule.value = (appState.preferences && appState.preferences.reorgSortRule) || "smart";
      selSortRule.addEventListener("change", async () => {
        appState.preferences.reorgSortRule = selSortRule.value;
        await chrome.storage.local.set({ preferences: appState.preferences });
        const previewBox = document.getElementById("reorgPreviewContainer");
        if (
          previewBox &&
          !previewBox.classList.contains("hidden") &&
          ["existing", "rebuild", "sort_only"].includes(appState.activeReorgMode) &&
          appState.reorgItems.length > 0
        ) {
          sortPreviewItemsByDestinationFolder();
          renderReorgPreviewTable({ preserveFilterScroll: true });
          syncSummaryBarDom();
        }
      });
    }

    const selIconStyle = document.getElementById("selRebuildIconStyle");
    if (appState.treeAnalysis && !appState.treeAnalysis.styleProfile.mainUsesEmoji) {
      selIconStyle.value = "plain";
    }

    const applyModePanelsVisibility = targetMode => {
      appState.reorgMode = targetMode;
      modeRadios.forEach(item => {
        const cardEl = document.getElementById(item.card);
        const radEl = document.getElementById(item.radio);
        const isActive = item.mode === targetMode;
        if (cardEl) cardEl.classList.toggle("active", isActive);
        if (radEl) radEl.checked = isActive;
      });

      if (scopePanel) scopePanel.classList.toggle("hidden", targetMode === "rebuild");
      if (existingOpts) existingOpts.classList.toggle("hidden", targetMode !== "existing");
      if (rebuildOpts) rebuildOpts.classList.toggle("hidden", targetMode !== "rebuild");
      if (dedupOpts) dedupOpts.classList.toggle("hidden", targetMode !== "dedup");
      if (deadlinkOpts) deadlinkOpts.classList.toggle("hidden", targetMode !== "deadlinks");

      if (targetMode === "rebuild") renderLockedFoldersChecklist();
      syncReorgStartButtonLabel();
      updateReorgTokenEstimate();
    };

    const onModeSwitch = targetMode => {
      if (activeAbortController) return;
      lastBatchMappingContext = null;
      lastBatchErrorSummary = "";
      applyModePanelsVisibility(targetMode);
      enterWorkspaceStage("config");
    };

    modeRadios.forEach(item => {
      const el = document.getElementById(item.radio);
      if (el) {
        el.addEventListener("change", () => {
          if (el.checked) onModeSwitch(item.mode);
        });
      }
    });

    radioAll.addEventListener("change", () => {
      syncScopeSegmentedUi();
      updateReorgTokenEstimate();
    });
    radioFolder.addEventListener("change", () => {
      syncScopeSegmentedUi();
      populateReorgFolderSelect();
      updateReorgTokenEstimate();
    });
    syncScopeSegmentedUi();

    const chkSkipLocal = document.getElementById("chkDeadlinkSkipLocal");
    if (chkSkipLocal) {
      chkSkipLocal.addEventListener("change", updateReorgTokenEstimate);
    }

    const chkStripTrack = document.getElementById("chkDedupStripTracking");
    const chkIgnoreHash = document.getElementById("chkDedupIgnoreHash");
    const selDedupStrat = document.getElementById("selDedupStrategy");
    const onDedupOptionLiveUpdate = () => {
      if (
        appState.activeReorgMode === "dedup" &&
        currentWorkspaceStage === "preview" &&
        !activeAbortController
      ) {
        runDuplicateScanner({ stayQuiet: true });
      }
    };
    if (chkStripTrack) chkStripTrack.addEventListener("change", onDedupOptionLiveUpdate);
    if (chkIgnoreHash) chkIgnoreHash.addEventListener("change", onDedupOptionLiveUpdate);
    if (selDedupStrat) selDedupStrat.addEventListener("change", onDedupOptionLiveUpdate);

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

    const dispatchStartByMode = mode => {
      if (mode === "rebuild") {
        runBlueprintGenerationStage();
      } else if (mode === "dedup") {
        runDuplicateScanner();
      } else if (mode === "deadlinks") {
        runDeadLinkScanner();
      } else if (mode === "sort_only") {
        runQuickSortOnlyPreview();
      } else {
        runExistingFoldersReorganizer();
      }
    };

    document.getElementById("btnStartReorganize").addEventListener("click", () => {
      dispatchStartByMode(appState.reorgMode);
    });

    const btnSummaryRerun = document.getElementById("btnSummaryRerun");
    if (btnSummaryRerun) {
      btnSummaryRerun.addEventListener("click", () => {
        const rerunMode =
          appState.activeReorgMode === "sort_only" ? "sort_only" : appState.reorgMode;
        dispatchStartByMode(rerunMode);
      });
    }

    const btnToggleDrawer = document.getElementById("btnToggleConfigDrawer");
    if (btnToggleDrawer) {
      btnToggleDrawer.addEventListener("click", () => {
        appState.reorgConfigExpanded = !appState.reorgConfigExpanded;
        syncSummaryBarDom();
      });
    }

    const btnCancelReorg = document.getElementById("btnCancelReorg");
    if (btnCancelReorg) {
      btnCancelReorg.addEventListener("click", cancelActiveReorgTask);
    }

    const btnQuickSort = document.getElementById("btnQuickSortOnly");
    if (btnQuickSort) btnQuickSort.addEventListener("click", runQuickSortOnlyPreview);

    document.getElementById("btnRegenBlueprint").addEventListener("click", runBlueprintGenerationStage);
    document.getElementById("btnAddBlueprintL1").addEventListener("click", addNewBlueprintCategory);
    document.getElementById("btnConfirmBlueprint").addEventListener("click", runBlueprintMappingStage);
    document.getElementById("btnApplyReorganize").addEventListener("click", applyReorganizerChanges);

    const btnRetryFailed = document.getElementById("btnRetryFailedReorg");
    if (btnRetryFailed) btnRetryFailed.addEventListener("click", retryFailedBatchItems);

    const btnResumeUnproc = document.getElementById("btnResumeUnprocessed");
    if (btnResumeUnproc) btnResumeUnproc.addEventListener("click", resumeUnprocessedBatchItems);

    document.querySelectorAll("#reorgAiStatusGroup .status-filter-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        appState.previewStatusFilter = btn.getAttribute("data-status") || "changed";
        renderReorgPreviewTable({ preserveFilterScroll: true });
      });
    });

    const selCategoryFilter = document.getElementById("selReorgCategoryFilter");
    if (selCategoryFilter) {
      selCategoryFilter.addEventListener("change", () => {
        appState.previewCategoryFilter = selCategoryFilter.value || "ALL";
        renderReorgPreviewTable({ preserveFilterScroll: true });
      });
    }

    const btnResetDedup = document.getElementById("btnResetDedupSelection");
    if (btnResetDedup) {
      btnResetDedup.addEventListener("click", () => {
        appState.dedupGroups.forEach(group => {
          group.keepId = group.defaultKeepId;
          group.members.forEach(m => {
            m.isKeep = String(m.id) === String(group.defaultKeepId);
            m.removeChecked = !m.isKeep;
          });
          group.members.sort((a, b) => Number(b.isKeep) - Number(a.isKeep));
        });
        renderDedupPreview();
      });
    }

    document.querySelectorAll("#reorgDeadlinkStatusGroup .status-filter-pill").forEach(btn => {
      btn.addEventListener("click", () => {
        appState.deadlinkFilter = btn.getAttribute("data-dead-filter") || "all";
        renderDeadlinkPreview();
      });
    });

    const btnDeadHigh = document.getElementById("btnDeadSelectHigh");
    if (btnDeadHigh) {
      btnDeadHigh.addEventListener("click", () => {
        appState.deadlinkResults.forEach(item => {
          item.selectedForDelete = item.category === "dead";
        });
        renderDeadlinkPreview();
      });
    }

    const btnDeadClear = document.getElementById("btnDeadClearAll");
    if (btnDeadClear) {
      btnDeadClear.addEventListener("click", () => {
        appState.deadlinkResults.forEach(item => {
          item.selectedForDelete = false;
        });
        renderDeadlinkPreview();
      });
    }

    const chkDeadVisible = document.getElementById("chkDeadSelectVisible");
    if (chkDeadVisible) {
      chkDeadVisible.addEventListener("change", () => {
        const checked = chkDeadVisible.checked;
        getVisibleDeadlinkItems().forEach(item => {
          item.selectedForDelete = checked;
        });
        renderDeadlinkPreview();
      });
    }

    applyModePanelsVisibility(appState.reorgMode || "existing");
    populateReorgFolderSelect();
    renderLockedFoldersChecklist();
    updateReorgTokenEstimate();
  }

  function syncReorgStartButtonLabel() {
    const lbl = document.getElementById("btnStartReorgLabel");
    if (!lbl) return;
    let key = "btn_start_reorg";
    if (appState.reorgMode === "rebuild") {
      key = "btn_gen_blueprint";
    } else if (appState.reorgMode === "dedup") {
      key = "btn_start_dedup";
    } else if (appState.reorgMode === "deadlinks") {
      key = "btn_start_deadlinks";
    }
    lbl.setAttribute("data-i18n", key);
    lbl.textContent = t(key);
  }

  function closeScopeFoldersMenu() {
    const wrap = document.getElementById("scopeFoldersDropdown");
    const trigger = document.getElementById("btnScopeFoldersTrigger");
    const menu = document.getElementById("scopeFoldersMenu");
    if (menu) menu.classList.add("hidden");
    if (trigger) trigger.setAttribute("aria-expanded", "false");
    if (wrap) wrap.classList.remove("is-open");
  }

  function openScopeFoldersMenu() {
    const wrap = document.getElementById("scopeFoldersDropdown");
    const trigger = document.getElementById("btnScopeFoldersTrigger");
    const menu = document.getElementById("scopeFoldersMenu");
    if (!wrap || !trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    menu.classList.toggle("csel-up", spaceBelow < 220 && rect.top > spaceBelow + 40);
    menu.classList.remove("hidden");
    trigger.setAttribute("aria-expanded", "true");
    wrap.classList.add("is-open");
  }

  function syncScopeFoldersSummary() {
    const summaryEl = document.getElementById("scopeFoldersSummary");
    const trigger = document.getElementById("btnScopeFoldersTrigger");
    if (!summaryEl) return;

    const selected = getSelectedScopeFolders();
    summaryEl.textContent = formatScopeSelectionText(selected, "reorg_scope_none");
    if (trigger) {
      trigger.classList.toggle("is-placeholder", selected.length === 0);
      trigger.title =
        selected.length > 0 ? selected.map(f => f.breadcrumb || f.title).join(" / ") : "";
    }
  }

  function syncScopeTreeItemStates() {
    const container = document.getElementById("scopeFoldersList");
    if (!container) return;
    const folderMap = getFolderMap();
    const checkSvg = `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

    container.querySelectorAll(".scope-tree-item").forEach(itemBtn => {
      const fid = itemBtn.dataset.folderId || "";
      const isSelected = appState.selectedScopeFolderIds.has(fid);
      const isCovered =
        !isSelected && isCoveredBySelectedAncestor(fid, appState.selectedScopeFolderIds, folderMap);

      itemBtn.classList.toggle("is-selected", isSelected);
      itemBtn.classList.toggle("is-covered", isCovered);
      itemBtn.disabled = isCovered;
      if (isCovered) itemBtn.setAttribute("aria-disabled", "true");
      else itemBtn.removeAttribute("aria-disabled");
      itemBtn.setAttribute("aria-selected", String(isSelected || isCovered));

      const chkSpan = itemBtn.querySelector(".scope-tree-check");
      if (chkSpan) chkSpan.innerHTML = isSelected || isCovered ? checkSvg : "";

      let tagSpan = itemBtn.querySelector(".scope-tree-tag");
      if (isCovered) {
        if (!tagSpan) {
          tagSpan = document.createElement("span");
          tagSpan.className = "scope-tree-tag";
          itemBtn.appendChild(tagSpan);
        }
        tagSpan.textContent = t("reorg_scope_included");
      } else if (tagSpan) {
        tagSpan.remove();
      }
    });
  }

  function bindScopeFoldersDropdown() {
    const wrap = document.getElementById("scopeFoldersDropdown");
    const trigger = document.getElementById("btnScopeFoldersTrigger");
    const menu = document.getElementById("scopeFoldersMenu");
    const clearBtn = document.getElementById("btnScopeClearAll");
    if (!wrap || !trigger || !menu || wrap._mfBound) return;
    wrap._mfBound = true;

    const isOpen = () => !menu.classList.contains("hidden");
    trigger.addEventListener("click", () => {
      if (isOpen()) closeScopeFoldersMenu();
      else openScopeFoldersMenu();
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        appState.selectedScopeFolderIds.clear();
        syncScopeTreeItemStates();
        syncScopeFoldersSummary();
        updateReorgTokenEstimate();
      });
    }

    document.addEventListener("click", e => {
      if (isOpen() && !wrap.contains(e.target)) {
        closeScopeFoldersMenu();
      }
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen()) {
        closeScopeFoldersMenu();
        trigger.focus();
      }
    });
  }

  function populateReorgFolderSelect() {
    const container = document.getElementById("scopeFoldersList");
    if (!container) return;

    bindScopeFoldersDropdown();
    pruneSelectedScopeIds();

    const folders = appState.allFoldersTree || [];
    const frag = document.createDocumentFragment();

    folders.forEach(f => {
      const fid = String(f.id);
      const itemBtn = document.createElement("button");
      itemBtn.type = "button";
      itemBtn.className = "scope-tree-item" + (f.depth === 1 ? " is-root" : "");
      itemBtn.dataset.folderId = fid;
      const indentPx = 10 + Math.min(Math.max(0, (f.depth || 1) - 1), 5) * 18;
      itemBtn.style.paddingLeft = `${indentPx}px`;
      itemBtn.setAttribute("role", "option");

      const chkSpan = document.createElement("span");
      chkSpan.className = "scope-tree-check";

      const nameSpan = document.createElement("span");
      nameSpan.className = "scope-tree-name";
      nameSpan.textContent = f.title;
      nameSpan.title = f.breadcrumb || f.title;

      itemBtn.appendChild(chkSpan);
      itemBtn.appendChild(nameSpan);

      itemBtn.addEventListener("click", () => {
        if (isCoveredBySelectedAncestor(fid, appState.selectedScopeFolderIds, getFolderMap())) {
          return;
        }
        if (appState.selectedScopeFolderIds.has(fid)) {
          appState.selectedScopeFolderIds.delete(fid);
        } else {
          appState.selectedScopeFolderIds.add(fid);
        }
        pruneSelectedScopeIds();
        syncScopeTreeItemStates();
        syncScopeFoldersSummary();
        updateReorgTokenEstimate();
      });

      frag.appendChild(itemBtn);
    });

    container.replaceChildren(frag);
    syncScopeTreeItemStates();
    syncScopeFoldersSummary();
  }

  function syncLockedFoldersSummary() {
    const summaryEl = document.getElementById("lockedFoldersSummary");
    if (!summaryEl) return;
    const folders =
      appState.treeAnalysis && Array.isArray(appState.treeAnalysis.folders)
        ? appState.treeAnalysis.folders
        : [];
    const l1Folders = folders.filter(f => f.depth === 2 && f.parentId === "1");
    const lockedNames = l1Folders
      .filter(f => appState.lockedL1Ids.has(f.id))
      .map(f => f.title);

    if (lockedNames.length === 0) {
      summaryEl.textContent = t("reorg_locked_none");
      return;
    }
    const previewNames = lockedNames.slice(0, 2).join(" / ");
    summaryEl.textContent = t("reorg_locked_summary", {
      count: lockedNames.length,
      names: lockedNames.length > 2 ? `${previewNames}…` : previewNames
    });
  }

  function bindLockedFoldersDropdown() {
    const wrap = document.getElementById("lockedFoldersDropdown");
    const trigger = document.getElementById("btnLockedFoldersTrigger");
    const menu = document.getElementById("lockedFoldersMenu");
    const clearBtn = document.getElementById("btnLockedClearAll");
    if (!wrap || !trigger || !menu || wrap._mfBound) return;
    wrap._mfBound = true;

    const isOpen = () => !menu.classList.contains("hidden");
    const closeMenu = () => {
      menu.classList.add("hidden");
      trigger.setAttribute("aria-expanded", "false");
      wrap.classList.remove("is-open");
    };
    const openMenu = () => {
      const rect = trigger.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      menu.classList.toggle("csel-up", spaceBelow < 185 && rect.top > spaceBelow + 40);
      menu.classList.remove("hidden");
      trigger.setAttribute("aria-expanded", "true");
      wrap.classList.add("is-open");
    };

    trigger.addEventListener("click", () => {
      if (isOpen()) closeMenu();
      else openMenu();
    });

    if (clearBtn) {
      clearBtn.addEventListener("click", () => {
        appState.lockedL1Ids.clear();
        renderLockedFoldersChecklist();
        updateReorgTokenEstimate();
      });
    }

    document.addEventListener("click", e => {
      if (isOpen() && !wrap.contains(e.target)) {
        closeMenu();
      }
    });

    document.addEventListener("keydown", e => {
      if (e.key === "Escape" && isOpen()) {
        closeMenu();
        trigger.focus();
      }
    });
  }

  function renderLockedFoldersChecklist() {
    const container = document.getElementById("lockedFoldersList");
    const group = document.getElementById("lockedFoldersGroup");
    if (!container || !appState.treeAnalysis) return;

    bindLockedFoldersDropdown();

    const l1Folders = appState.treeAnalysis.folders.filter(f => f.depth === 2 && f.parentId === "1");
    if (l1Folders.length === 0) {
      group.classList.add("hidden");
      syncLockedFoldersSummary();
      return;
    }

    group.classList.remove("hidden");
    container.innerHTML = "";

    const lockIconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;
    const unlockDotSvg = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="7"></circle></svg>`;

    l1Folders.forEach(f => {
      const isLocked = appState.lockedL1Ids.has(f.id);
      const itemBtn = document.createElement("button");
      itemBtn.type = "button";
      itemBtn.className = "locked-msel-item" + (isLocked ? " is-locked" : "");
      itemBtn.setAttribute("role", "option");
      itemBtn.setAttribute("aria-selected", String(isLocked));

      const nameSpan = document.createElement("span");
      nameSpan.className = "locked-msel-name";
      nameSpan.textContent = f.title;
      nameSpan.title = f.title;

      const lockSpan = document.createElement("span");
      lockSpan.className = "locked-msel-lock";
      lockSpan.innerHTML = isLocked ? lockIconSvg : unlockDotSvg;

      itemBtn.appendChild(nameSpan);
      itemBtn.appendChild(lockSpan);

      itemBtn.addEventListener("click", () => {
        const nextLocked = !appState.lockedL1Ids.has(f.id);
        if (nextLocked) appState.lockedL1Ids.add(f.id);
        else appState.lockedL1Ids.delete(f.id);
        itemBtn.classList.toggle("is-locked", nextLocked);
        itemBtn.setAttribute("aria-selected", String(nextLocked));
        lockSpan.innerHTML = nextLocked ? lockIconSvg : unlockDotSvg;
        syncLockedFoldersSummary();
        updateReorgTokenEstimate();
      });

      container.appendChild(itemBtn);
    });

    syncLockedFoldersSummary();
  }

  /** 控制统一预览容器内部 3 套工作视图（AI 整理 / 重复合并 / 失效清理）的显隐与标题文案 */
  function setActivePreviewSurface(kind) {
    const isAi = kind === "ai";
    const isDedup = kind === "dedup";
    const isDead = kind === "deadlinks";

    document.getElementById("reorgAiStatusGroup").classList.toggle("hidden", !isAi);
    document.getElementById("reorgDedupStatusGroup").classList.toggle("hidden", !isDedup);
    document.getElementById("reorgDeadlinkStatusGroup").classList.toggle("hidden", !isDead);
    const proxyBanner = document.getElementById("deadlinkProxyHintBanner");
    if (proxyBanner && !isDead) {
      proxyBanner.classList.add("hidden");
    }

    const titleEl = document.getElementById("reorgPreviewTitle");
    const subEl = document.getElementById("reorgPreviewSubtitle");
    const applyBtn = document.getElementById("btnApplyReorganize");
    const applyLbl = document.getElementById("btnApplyReorgLabel");

    if (isDedup) {
      titleEl.textContent = t("reorg_dedup_preview_title");
      subEl.textContent = t("reorg_backup_tip");
      applyLbl.textContent = t("btn_apply_dedup");
    } else if (isDead) {
      titleEl.textContent = t("reorg_dead_preview_title");
      subEl.textContent = t("reorg_backup_tip");
      applyLbl.textContent = t("btn_apply_deadlinks");
    } else {
      titleEl.textContent = t("reorg_preview_title");
      subEl.textContent = t("reorg_backup_tip");
      applyLbl.textContent = t("btn_apply_reorg");
    }
    if (applyBtn) applyBtn.classList.remove("hidden");
  }

  function pickInitialAiStatusFilter(items) {
    const succCnt = items.filter(isItemSucceededChanged).length;
    const failCnt = items.filter(i => !i.ignored && i.aiFailed).length;
    const unprocCnt = items.filter(i => i.unprocessed).length;

    if (succCnt === 0 && failCnt > 0) return "failed";
    if (succCnt === 0 && failCnt === 0 && unprocCnt > 0) return "unprocessed";
    if (succCnt === 0 && failCnt === 0 && unprocCnt === 0) return "all";
    return "changed";
  }

  // ---------------- 模式一（快捷分支）：零 Token 仅重排目录内顺序 ---------------- //

  async function runQuickSortOnlyPreview() {
    if (activeAbortController) return;
    if (!ensureValidScopeSelection()) return;
    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    const rawBookmarks = collectScopedBookmarksFromTree(tree);
    if (rawBookmarks.length === 0) {
      showToast(t("reorg_toast_empty_scope"), true);
      return;
    }

    appState.activeReorgMode = "sort_only";
    appState.activeTargetFolders = appState.allFoldersTree;
    appState.previewCategoryFilter = "ALL";
    lastBatchMappingContext = null;
    lastBatchErrorSummary = "";
    document.getElementById("reorgBlueprintContainer").classList.add("hidden");

    const sortRule = getSelectedSortRule();
    const byFolder = new Map();
    rawBookmarks.forEach((bm, idx) => {
      const funcGroup = MarkFlowEngine.inferLocalFuncGroup(bm.url, bm.title);
      const entry = {
        _origOrderIdx: idx,
        origIndex: bm.origIndex ?? 0,
        dateAdded: bm.dateAdded || 0,
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
        ignored: false,
        aiFailed: false,
        unprocessed: false,
        orderChanged: false
      };
      if (!byFolder.has(bm.parentId)) byFolder.set(bm.parentId, []);
      byFolder.get(bm.parentId).push(entry);
    });

    const sortedAll = [];
    for (const [, folderItems] of byFolder.entries()) {
      sortedAll.push(...MarkFlowEngine.sortFolderBookmarksByPriority(folderItems, sortRule));
    }

    markOrderChangedFlags(sortedAll);
    appState.reorgItems = sortedAll;
    appState.previewStatusFilter = pickInitialAiStatusFilter(sortedAll);

    setActivePreviewSurface("ai");
    renderReorgPreviewTable();
    enterWorkspaceStage("preview", { mode: "sort_only", scopeLabel: getScopeSummaryLabel(tree) });
    window.scrollTo({ top: 0, behavior: "smooth" });

    showToast(t("reorg_toast_sort_preview", { count: sortedAll.length }));
  }

  // ---------------- 模式一：归入现有目录 & 内部排序 ---------------- //

  async function runExistingFoldersReorganizer() {
    if (activeAbortController) return;
    if (!ensureValidScopeSelection()) return;
    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");
    const previewBox = document.getElementById("reorgPreviewContainer");

    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    const rawBookmarks = collectScopedBookmarksFromTree(tree);
    if (rawBookmarks.length === 0) {
      showToast(t("reorg_toast_empty_scope"), true);
      return;
    }

    appState.activeReorgMode = "existing";
    appState.activeTargetFolders = appState.allFoldersTree;
    appState.previewCategoryFilter = "ALL";
    document.getElementById("reorgBlueprintContainer").classList.add("hidden");
    previewBox.classList.add("hidden");

    const signal = beginCancellableRun("existing", "reorg_prog_cancel_hint");
    progressBar.style.width = "0%";
    progressText.textContent = t("reorg_prog_prepare", { count: rawBookmarks.length });
    progressPercent.textContent = "0%";

    try {
      const mappingSummary = await executeBatchMapping(
        rawBookmarks,
        appState.treeAnalysis,
        true,
        null,
        signal
      );

      if (mappingSummary.canceled && mappingSummary.completedCount === 0) {
        enterWorkspaceStage("config");
        showToast(t("reorg_toast_canceled_empty"));
        return;
      }

      if (document.getElementById("chkSortInFolders").checked) {
        sortPreviewItemsByDestinationFolder();
      } else {
        markOrderChangedFlags(appState.reorgItems);
      }

      appState.previewStatusFilter = pickInitialAiStatusFilter(appState.reorgItems);
      setActivePreviewSurface("ai");
      renderReorgPreviewTable();
      enterWorkspaceStage("preview", { mode: "existing", scopeLabel: getScopeSummaryLabel(tree) });
      window.scrollTo({ top: 0, behavior: "smooth" });

      if (mappingSummary.canceled) {
        showToast(
          t("reorg_toast_canceled_partial", {
            done: mappingSummary.completedCount,
            remaining: mappingSummary.unprocessedCount
          })
        );
      } else if (mappingSummary.failedCount > 0) {
        showToast(
          t("reorg_toast_partial_err", {
            failed: mappingSummary.failedCount,
            msg: mappingSummary.errorSummary
          }),
          true
        );
      } else {
        showToast(t("reorg_toast_existing_ready", { count: appState.reorgItems.length }));
      }
    } finally {
      endCancellableRun();
    }
  }

  // ---------------- 模式二（阶段一）：生成与编辑两级目录蓝图 ---------------- //

  async function runBlueprintGenerationStage() {
    if (activeAbortController) return;
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

    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");
    const bpBox = document.getElementById("reorgBlueprintContainer");
    const previewBox = document.getElementById("reorgPreviewContainer");

    previewBox.classList.add("hidden");
    bpBox.classList.add("hidden");

    const signal = beginCancellableRun("blueprint", "reorg_prog_cancel_hint");
    progressBar.style.width = "35%";
    progressText.textContent = t("reorg_prog_blueprint", { count: unlockedBookmarks.length });
    progressPercent.textContent = "1/2";

    try {
      const blueprint = await MarkFlowEngine.generateTaxonomyBlueprint({
        bookmarks: unlockedBookmarks,
        lockedFolders,
        iconStyle,
        aiConfig: appState.aiConfig,
        preferences: appState.preferences,
        signal
      });

      appState.blueprintCategories = blueprint;
      appState.rebuildRawBookmarks = unlockedBookmarks;
      appState.activeReorgMode = "rebuild";

      progressBar.style.width = "100%";
      renderBlueprintEditor();
      enterWorkspaceStage("blueprint", { mode: "rebuild", scopeLabel: t("reorg_scope_all") });
      window.scrollTo({ top: 0, behavior: "smooth" });
      showToast(t("reorg_toast_bp_ready", { count: blueprint.length }));
    } catch (err) {
      if (isAbortedSignalOrErr(signal, err)) {
        if (appState.blueprintCategories && appState.blueprintCategories.length > 0 && currentWorkspaceStage !== "config") {
          enterWorkspaceStage("blueprint");
        } else {
          enterWorkspaceStage("config");
        }
        showToast(t("reorg_toast_canceled_bp"));
      } else {
        showToast(t("reorg_toast_bp_err", { msg: formatFriendlyAiError(err) }), true);
      }
    } finally {
      endCancellableRun();
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
    let catTitle = baseName;
    if (iconStyle === "emoji" || iconStyle === "emoji_both") {
      catTitle = `📁 ${baseName}`;
    } else if (iconStyle === "numbered") {
      const nextNum = String(appState.blueprintCategories.length + 1).padStart(2, "0");
      catTitle = `${nextNum} ${baseName}`;
    } else if (iconStyle === "symbol") {
      catTitle = `◆ ${baseName}`;
    }
    const subTitle = iconStyle === "emoji_both" ? `📂 ${t("reorg_bp_general_l2")}` : t("reorg_bp_general_l2");
    appState.blueprintCategories.push({
      id: `bp_custom_${Date.now()}`,
      title: catTitle,
      subfolders: [{ id: `bp_sub_${Date.now()}`, title: subTitle, scopeHint: "" }]
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
    if (activeAbortController) return;
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

    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");
    const previewBox = document.getElementById("reorgPreviewContainer");

    previewBox.classList.add("hidden");
    const signal = beginCancellableRun("rebuild_map", "reorg_prog_cancel_hint");
    progressBar.style.width = "0%";
    progressText.textContent = t("reorg_prog_prepare", { count: appState.rebuildRawBookmarks.length });
    progressPercent.textContent = "0%";

    try {
      const mappingSummary = await executeBatchMapping(
        appState.rebuildRawBookmarks,
        blueprintTree,
        true,
        translatedBlueprintMemory,
        signal
      );

      if (mappingSummary.canceled && mappingSummary.completedCount === 0) {
        enterWorkspaceStage("blueprint");
        showToast(t("reorg_toast_canceled_empty"));
        return;
      }

      let rolledUpCount = 0;
      if (!mappingSummary.canceled) {
        const consolidated = MarkFlowEngine.consolidateOrphanSubfolders(
          appState.reorgItems,
          appState.blueprintCategories
        );
        rolledUpCount = consolidated.rolledUpCount;
        appState.blueprintCategories = consolidated.consolidatedCategories;
        blueprintTree = MarkFlowEngine.buildBlueprintTreeAnalysis(
          consolidated.consolidatedCategories,
          iconStyle
        );
        appState.activeTargetFolders = blueprintTree.folders.filter(f => f.depth >= 2);
        if (lastBatchMappingContext) {
          lastBatchMappingContext.targetTreeAnalysis = blueprintTree;
        }
        renderBlueprintEditor();
      }

      sortPreviewItemsByDestinationFolder();
      appState.previewStatusFilter = pickInitialAiStatusFilter(appState.reorgItems);
      setActivePreviewSurface("ai");
      renderReorgPreviewTable();
      enterWorkspaceStage("preview", { mode: "rebuild", scopeLabel: t("reorg_scope_all") });
      window.scrollTo({ top: 0, behavior: "smooth" });

      if (mappingSummary.canceled) {
        showToast(
          t("reorg_toast_canceled_partial", {
            done: mappingSummary.completedCount,
            remaining: mappingSummary.unprocessedCount
          })
        );
      } else if (mappingSummary.failedCount > 0) {
        showToast(
          t("reorg_toast_partial_err", {
            failed: mappingSummary.failedCount,
            msg: mappingSummary.errorSummary
          }),
          true
        );
      } else {
        showToast(
          rolledUpCount > 0
            ? t("reorg_toast_mapped_orphan", { count: appState.reorgItems.length, orphan: rolledUpCount })
            : t("reorg_toast_mapped", { count: appState.reorgItems.length })
        );
      }
    } catch (err) {
      if (isAbortedSignalOrErr(signal, err)) {
        enterWorkspaceStage("blueprint");
        showToast(t("reorg_toast_canceled_empty"));
      } else {
        showToast(t("reorg_toast_map_err", { msg: formatFriendlyAiError(err) }), true);
      }
    } finally {
      endCancellableRun();
    }
  }

  function sortPreviewItemsByDestinationFolder() {
    const sortRule = getSelectedSortRule();
    const byDest = new Map();
    const tailUnprocessed = [];

    for (const item of appState.reorgItems) {
      if (item.unprocessed) {
        tailUnprocessed.push(item);
        continue;
      }
      const key = String(item.targetFolderId || item.currentFolderId || "1");
      if (!byDest.has(key)) byDest.set(key, []);
      byDest.get(key).push(item);
    }

    const ordered = [];
    for (const [, list] of byDest.entries()) {
      ordered.push(...MarkFlowEngine.sortFolderBookmarksByPriority(list, sortRule));
    }
    ordered.push(...tailUnprocessed);
    markOrderChangedFlags(ordered);
    appState.reorgItems = ordered;
  }

  // ---------------- 批量映射核心调度（支持随时中断并保留已完成批次） ---------------- //

  async function executeBatchMapping(
    rawBookmarks,
    targetTreeAnalysis,
    useDomainAffinity = true,
    domainMemoryOverride = null,
    signal = null
  ) {
    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");

    const effectiveMemory = domainMemoryOverride || appState.domainMemory || {};
    const orderedBookmarks = MarkFlowEngine.clusterBookmarksForBatching(rawBookmarks);
    const collectedItems = [];
    const processedIds = new Set();

    lastBatchMappingContext = {
      targetTreeAnalysis,
      useDomainAffinity,
      domainMemoryOverride
    };
    lastBatchErrorSummary = "";
    let failedCount = 0;
    let canceled = Boolean(signal && signal.aborted);

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
      if (signal && signal.aborted) {
        canceled = true;
        break;
      }

      const batch = orderedBookmarks.slice(i, i + BATCH_SIZE);
      const unhandledByRule = [];

      for (const bm of batch) {
        if (signal && signal.aborted) {
          canceled = true;
          break;
        }

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
                usePangu,
                signal
              });
            } catch (e) {
              if (isAbortedSignalOrErr(signal, e)) {
                canceled = true;
                break;
              }
            }
          }

          processedIds.add(String(bm.id));
          collectedItems.push({
            _origOrderIdx: bm._origOrderIdx ?? 0,
            origIndex: bm.origIndex ?? 0,
            dateAdded: bm.dateAdded || 0,
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
            ignored: false,
            aiFailed: false,
            unprocessed: false,
            aiErrorDetail: ""
          });
          MarkFlowEngine.recordRollingMappingAnchor(targetTreeAnalysis, bm.url, cleanTitle, destId);
        } else {
          const domainAffinity = useDomainAffinity
            ? MarkFlowEngine.computeDomainAffinity(bm.url, targetTreeAnalysis, effectiveMemory)
            : null;
          unhandledByRule.push({ bm, cleanTitle, domainAffinity });
        }
      }

      if (canceled) break;

      if (unhandledByRule.length > 0) {
        if (canUseAI) {
          try {
            const aiResults = await MarkFlowEngine.classifyBatchBookmarks({
              items: unhandledByRule,
              treeAnalysis: targetTreeAnalysis,
              aiConfig: appState.aiConfig,
              preferences: appState.preferences,
              usePangu,
              signal
            });

            unhandledByRule.forEach((item, idx) => {
              const res = aiResults[idx] || {};
              const finalTitle = res.cleanTitle || item.cleanTitle;
              const finalFolderId = res.targetFolderId || item.bm.parentId;
              processedIds.add(String(item.bm.id));
              collectedItems.push({
                _origOrderIdx: item.bm._origOrderIdx ?? 0,
                origIndex: item.bm.origIndex ?? 0,
                dateAdded: item.bm.dateAdded || 0,
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
                ignored: false,
                aiFailed: false,
                unprocessed: false,
                aiErrorDetail: ""
              });
              MarkFlowEngine.recordRollingMappingAnchor(
                targetTreeAnalysis,
                item.bm.url,
                finalTitle,
                finalFolderId
              );
            });
          } catch (err) {
            if (isAbortedSignalOrErr(signal, err)) {
              canceled = true;
              break;
            }

            console.warn("Batch AI error, falling back:", err);
            const friendlyErr = formatFriendlyAiError(err);
            if (!lastBatchErrorSummary) lastBatchErrorSummary = friendlyErr;
            failedCount += unhandledByRule.length;

            const fallbackFolder =
              targetTreeAnalysis.folders.find(f => f.depth === 3) ||
              targetTreeAnalysis.folders.find(f => f.depth === 2) ||
              targetTreeAnalysis.folders[0];

            unhandledByRule.forEach(item => {
              processedIds.add(String(item.bm.id));
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
                origIndex: item.bm.origIndex ?? 0,
                dateAdded: item.bm.dateAdded || 0,
                id: item.bm.id,
                originalTitle: item.bm.title,
                url: item.bm.url,
                cleanTitle: item.cleanTitle,
                currentFolderId: item.bm.parentId,
                currentFolderName: item.bm.parentTitle,
                targetFolderId: fbId,
                targetFolderName: fbName,
                funcGroup: MarkFlowEngine.inferLocalFuncGroup(item.bm.url, item.cleanTitle),
                reason: item.domainAffinity
                  ? t("reorg_reason_ai_failed_domain", { domain: item.domainAffinity.reason })
                  : t("reorg_reason_fallback"),
                ignored: false,
                aiFailed: true,
                unprocessed: false,
                aiErrorDetail: friendlyErr,
                _retryInput: item
              });
            });
          }
        } else {
          unhandledByRule.forEach(item => {
            processedIds.add(String(item.bm.id));
            const fallbackId = item.domainAffinity
              ? item.domainAffinity.folderId
              : item.bm.parentId;
            const fallbackName = item.domainAffinity
              ? item.domainAffinity.breadcrumb
              : item.bm.parentTitle;
            collectedItems.push({
              _origOrderIdx: item.bm._origOrderIdx ?? 0,
              origIndex: item.bm.origIndex ?? 0,
              dateAdded: item.bm.dateAdded || 0,
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
              ignored: false,
              aiFailed: false,
              unprocessed: false,
              aiErrorDetail: ""
            });
          });
        }
      }

      const currentCount = processedIds.size;
      const pct = Math.round((currentCount / total) * 100);
      progressBar.style.width = `${pct}%`;
      progressText.textContent = t("reorg_prog_mapping", { done: currentCount, total });
      progressPercent.textContent = `${pct}%`;
    }

    const completedCount = processedIds.size;
    let unprocessedCount = 0;

    if (canceled && completedCount > 0) {
      orderedBookmarks.forEach(bm => {
        if (processedIds.has(String(bm.id))) return;
        unprocessedCount++;
        let localClean = MarkFlowEngine.cleanTitleLocally(bm.title);
        if (usePangu) localClean = MarkFlowEngine.addPanguSpacing(localClean);
        const domainAffinity = useDomainAffinity
          ? MarkFlowEngine.computeDomainAffinity(bm.url, targetTreeAnalysis, effectiveMemory)
          : null;

        collectedItems.push({
          _origOrderIdx: bm._origOrderIdx ?? 0,
          origIndex: bm.origIndex ?? 0,
          dateAdded: bm.dateAdded || 0,
          id: bm.id,
          originalTitle: bm.title,
          url: bm.url,
          cleanTitle: bm.title,
          currentFolderId: bm.parentId,
          currentFolderName: bm.parentTitle,
          targetFolderId: bm.parentId,
          targetFolderName: bm.parentTitle,
          funcGroup: MarkFlowEngine.inferLocalFuncGroup(bm.url, bm.title),
          reason: t("reorg_reason_unprocessed"),
          ignored: Boolean(targetTreeAnalysis.isBlueprint),
          aiFailed: false,
          unprocessed: true,
          aiErrorDetail: "",
          _retryInput: { bm, cleanTitle: localClean, domainAffinity }
        });
      });
    }

    collectedItems.sort((a, b) => a._origOrderIdx - b._origOrderIdx);
    appState.reorgItems = collectedItems;
    return {
      total,
      completedCount,
      unprocessedCount,
      failedCount,
      canceled,
      errorSummary: lastBatchErrorSummary
    };
  }

  /** 公共重跑辅助：支持局部重试 AI 失败项或续跑中止后未处理项，且过程同样支持随时取消 */
  async function runPartialReorgRecovery(targetKind) {
    if (reorgRetryInFlight || activeAbortController || !lastBatchMappingContext) return;
    const isResume = targetKind === "unprocessed";
    const targetItems = isResume
      ? appState.reorgItems.filter(i => i.unprocessed && i._retryInput)
      : appState.reorgItems.filter(i => !i.ignored && i.aiFailed && i._retryInput);
    if (targetItems.length === 0) return;

    const activeCfg = MarkFlowEngine.resolveActiveProviderConfig(appState.aiConfig);
    const canUseAI =
      activeCfg.enabled &&
      activeCfg.baseUrl &&
      (activeCfg.apiKey || activeCfg.provider === "ollama");
    if (!canUseAI) {
      showToast(t("reorg_toast_need_ai"), true);
      return;
    }

    const targetTreeAnalysis = lastBatchMappingContext.targetTreeAnalysis;
    const usePangu = appState.preferences.panguSpacing !== false;
    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");

    reorgRetryInFlight = true;
    const signal = beginCancellableRun("retry", "reorg_prog_cancel_hint");
    progressBar.style.width = "0%";
    progressText.textContent = t("reorg_prog_prepare", { count: targetItems.length });
    progressPercent.textContent = "0%";

    let succeededCount = 0;
    let stillFailedCount = 0;
    let remainingUnprocessed = 0;
    let latestError = "";
    let canceled = false;

    try {
      const BATCH_SIZE = 12;
      for (let i = 0; i < targetItems.length; i += BATCH_SIZE) {
        if (signal && signal.aborted) {
          canceled = true;
          remainingUnprocessed = targetItems.length - i;
          break;
        }

        const chunkEntries = targetItems.slice(i, i + BATCH_SIZE);
        const retryInputs = chunkEntries.map(entry => entry._retryInput);

        try {
          const aiResults = await MarkFlowEngine.classifyBatchBookmarks({
            items: retryInputs,
            treeAnalysis: targetTreeAnalysis,
            aiConfig: appState.aiConfig,
            preferences: appState.preferences,
            usePangu,
            signal
          });

          chunkEntries.forEach((entry, idx) => {
            const res = aiResults[idx] || {};
            if (res.cleanTitle && !entry.userEditedTitle) {
              entry.cleanTitle = res.cleanTitle;
            }
            if (res.targetFolderId && !entry.userChangedFolder) {
              entry.targetFolderId = res.targetFolderId;
              entry.targetFolderName = res.targetFolderName || entry.targetFolderName;
            }
            entry.funcGroup =
              res.funcGroup || MarkFlowEngine.inferLocalFuncGroup(entry.url, entry.cleanTitle);
            entry.reason = res.reason || t("reorg_reason_ai");
            entry.aiFailed = false;
            entry.unprocessed = false;
            entry.ignored = false;
            entry.aiErrorDetail = "";
            delete entry._retryInput;

            MarkFlowEngine.recordRollingMappingAnchor(
              targetTreeAnalysis,
              entry.url,
              entry.cleanTitle,
              entry.targetFolderId
            );
            succeededCount++;
          });
        } catch (err) {
          if (isAbortedSignalOrErr(signal, err)) {
            canceled = true;
            remainingUnprocessed = targetItems.length - i;
            break;
          }
          const friendlyErr = formatFriendlyAiError(err);
          if (!latestError) latestError = friendlyErr;
          chunkEntries.forEach(entry => {
            entry.aiFailed = true;
            entry.unprocessed = false;
            entry.aiErrorDetail = friendlyErr;
            stillFailedCount++;
          });
        }

        const done = Math.min(i + BATCH_SIZE, targetItems.length);
        const pct = Math.round((done / targetItems.length) * 100);
        progressBar.style.width = `${pct}%`;
        progressText.textContent = t("reorg_prog_mapping", { done, total: targetItems.length });
        progressPercent.textContent = `${pct}%`;
      }

      if (!isResume) {
        lastBatchErrorSummary = latestError;
      }

      const sortChk = document.getElementById("chkSortInFolders");
      if (appState.activeReorgMode === "rebuild" || (sortChk && sortChk.checked)) {
        sortPreviewItemsByDestinationFolder();
      } else {
        markOrderChangedFlags(appState.reorgItems);
      }

      if (canceled) {
        showToast(
          t("reorg_toast_canceled_partial", {
            done: succeededCount,
            remaining: remainingUnprocessed
          })
        );
      } else if (stillFailedCount === 0) {
        showToast(
          t(isResume ? "reorg_toast_resume_ok" : "reorg_toast_retry_ok", { count: succeededCount })
        );
      } else {
        showToast(t("reorg_toast_partial_err", { failed: stillFailedCount, msg: latestError }), true);
      }
    } finally {
      reorgRetryInFlight = false;
      endCancellableRun();
      if (
        (appState.previewStatusFilter === "failed" &&
          appState.reorgItems.filter(i => !i.ignored && i.aiFailed).length === 0) ||
        (appState.previewStatusFilter === "unprocessed" &&
          appState.reorgItems.filter(i => i.unprocessed).length === 0)
      ) {
        appState.previewStatusFilter = pickInitialAiStatusFilter(appState.reorgItems);
      }
      renderReorgPreviewTable({ preserveFilterScroll: true });
    }
  }

  /** 仅针对先前调用 AI 失败且未被跳过的书签发起局部重试 */
  function retryFailedBatchItems() {
    return runPartialReorgRecovery("failed");
  }

  /** 仅针对中途取消后保留下来的未处理书签继续 AI 归类 */
  function resumeUnprocessedBatchItems() {
    return runPartialReorgRecovery("unprocessed");
  }

  // ---------------- 统一状态筛选栏、目录过滤与 AI 预览表 ---------------- //

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

  function itemMatchesStatusFilter(item, statusFilter) {
    if (statusFilter === "success") return isItemSucceededChanged(item);
    if (statusFilter === "failed") return !item.ignored && Boolean(item.aiFailed);
    if (statusFilter === "unprocessed") return Boolean(item.unprocessed);
    if (statusFilter === "changed") return !item.ignored && !item.unprocessed && (isItemChanged(item) || Boolean(item.aiFailed));
    return true; // "all"
  }

  function updateReorgStatusStrip(folderChoices) {
    const allItems = appState.reorgItems;
    const activeItems = allItems.filter(i => !i.ignored && !i.unprocessed);
    const successCount = activeItems.filter(i => !i.aiFailed && isItemChanged(i)).length;
    const failedCount = activeItems.filter(i => i.aiFailed).length;
    const unprocessedCount = allItems.filter(i => i.unprocessed).length;
    const changedCount = successCount + failedCount;
    const uniqueFolders = new Set(
      activeItems.map(i => String(i.targetFolderId || i.currentFolderId))
    );

    document.getElementById("cntFilterChanged").textContent = String(changedCount);
    document.getElementById("cntFilterSuccess").textContent = String(successCount);
    document.getElementById("cntFilterFailed").textContent = String(failedCount);
    document.getElementById("cntFilterUnprocessed").textContent = String(unprocessedCount);
    document.getElementById("cntFilterAll").textContent = String(allItems.length);

    document.getElementById("btnFilterFailed").classList.toggle("hidden", failedCount === 0);
    document.getElementById("btnFilterUnprocessed").classList.toggle("hidden", unprocessedCount === 0);

    const folderMeta = document.getElementById("reorgFolderCountMeta");
    if (folderMeta) {
      folderMeta.textContent = t("reorg_meta_folders", { folders: uniqueFolders.size });
    }

    document.querySelectorAll("#reorgAiStatusGroup .status-filter-pill").forEach(btn => {
      btn.classList.toggle(
        "active",
        btn.getAttribute("data-status") === appState.previewStatusFilter
      );
    });

    const canceledBanner = document.getElementById("reorgCanceledBanner");
    const btnResume = document.getElementById("btnResumeUnprocessed");
    if (canceledBanner && btnResume) {
      if (unprocessedCount > 0) {
        btnResume.textContent = t("reorg_btn_resume_unprocessed", { count: unprocessedCount });
        canceledBanner.classList.remove("hidden");
      } else {
        canceledBanner.classList.add("hidden");
      }
    }

    populateCategoryFilterDropdown(folderChoices);
  }

  function populateCategoryFilterDropdown(folderChoices) {
    const sel = document.getElementById("selReorgCategoryFilter");
    if (!sel) return;

    const folderMapById = new Map(folderChoices.map(f => [String(f.id), f]));
    const countsByL1 = new Map();

    folderChoices
      .filter(f => f.depth === 2)
      .forEach(f => {
        countsByL1.set(String(f.id), { id: String(f.id), title: f.title, count: 0 });
      });

    let statusTotal = 0;
    for (const item of appState.reorgItems) {
      if (!itemMatchesStatusFilter(item, appState.previewStatusFilter)) continue;
      statusTotal++;
      const top = resolveItemTopCategory(item, folderMapById);
      if (!countsByL1.has(top.id)) {
        countsByL1.set(top.id, { id: top.id, title: top.title, count: 0 });
      }
      countsByL1.get(top.id).count++;
    }

    const currentVal = appState.previewCategoryFilter || "ALL";
    sel.innerHTML = "";

    const optAll = document.createElement("option");
    optAll.value = "ALL";
    optAll.textContent = `${t("reorg_folder_filter_all")} (${statusTotal})`;
    sel.appendChild(optAll);

    for (const entry of countsByL1.values()) {
      if (entry.count > 0 || entry.id === currentVal) {
        const opt = document.createElement("option");
        opt.value = entry.id;
        opt.textContent = `${entry.title} (${entry.count})`;
        sel.appendChild(opt);
      }
    }

    sel.value = Array.from(sel.options).some(o => o.value === currentVal) ? currentVal : "ALL";
    appState.previewCategoryFilter = sel.value;
    if (ctx.syncCustomSelects) ctx.syncCustomSelects();
  }

  function renderBatchErrorBanner() {
    const banner = document.getElementById("reorgBatchErrorBanner");
    const textEl = document.getElementById("reorgBatchErrorText");
    const btnRetry = document.getElementById("btnRetryFailedReorg");
    if (!banner || !textEl || !btnRetry) return;

    const failedActive = appState.reorgItems.filter(i => !i.ignored && i.aiFailed);
    if (failedActive.length === 0) {
      banner.classList.add("hidden");
      return;
    }

    const sampleMsg = failedActive[0].aiErrorDetail || lastBatchErrorSummary || t("pop_ai_err_generic");
    textEl.textContent = sampleMsg;
    textEl.title = t("reorg_batch_err_banner", {
      count: failedActive.length,
      msg: sampleMsg
    });
    btnRetry.textContent = t("reorg_btn_retry_failed", { count: failedActive.length });
    btnRetry.disabled = reorgRetryInFlight;
    banner.classList.remove("hidden");
  }

  function renderReorgPreviewTable(opts = {}) {
    document.getElementById("reorgAiTableWrap").classList.remove("hidden");
    document.getElementById("reorgDedupListWrap").classList.add("hidden");
    document.getElementById("reorgDeadlinkTableWrap").classList.add("hidden");
    document.getElementById("reorgCleanEmptyState").classList.add("hidden");

    const tbody = document.getElementById("reorgPreviewTableBody");
    const strip = document.getElementById("reorgCompactStatsStrip");
    const isStripVisible = Boolean(strip && strip.offsetParent !== null);
    const prevStripTop =
      isStripVisible && opts.preserveFilterScroll ? strip.getBoundingClientRect().top : null;

    const folderChoices =
      appState.activeTargetFolders && appState.activeTargetFolders.length > 0
        ? appState.activeTargetFolders
        : appState.allFoldersTree;

    const folderMapById = new Map(folderChoices.map(f => [String(f.id), f]));
    updateReorgStatusStrip(folderChoices);
    renderBatchErrorBanner();

    const restoreSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"></polyline><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"></path></svg>`;
    const skipSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

    const rowFrag = document.createDocumentFragment();
    let renderedCount = 0;

    appState.reorgItems.forEach((item, idx) => {
      if (!itemMatchesStatusFilter(item, appState.previewStatusFilter)) return;
      if (appState.previewCategoryFilter !== "ALL") {
        const top = resolveItemTopCategory(item, folderMapById);
        if (top.id !== appState.previewCategoryFilter) return;
      }
      renderedCount++;

      const tr = document.createElement("tr");
      if (item.ignored && !item.unprocessed) tr.style.opacity = "0.42";
      else if (item.unprocessed) tr.style.opacity = "0.74";

      const groupBadge =
        item.funcGroup && item.funcGroup !== "常规条目"
          ? `<span class="func-group-badge">${escapeHtml(item.funcGroup)}</span>`
          : "";
      const titleChanged = Boolean(item.cleanTitle && item.cleanTitle !== item.originalTitle);
      const folderChanged = String(item.targetFolderId) !== String(item.currentFolderId);
      const orderBadge =
        !titleChanged && !folderChanged && item.orderChanged
          ? `<span class="order-only-badge">${escapeHtml(t("reorg_badge_order_only"))}</span>`
          : "";
      const reasonTooltip = item.aiErrorDetail ? `${item.reason}: ${item.aiErrorDetail}` : item.reason;
      const reasonClass = item.aiFailed
        ? " is-error"
        : item.unprocessed
          ? " is-unprocessed"
          : "";

      tr.innerHTML = `
        <td>
          <div class="reorg-cell-ellipsis" style="font-weight: 600; font-size: 13px;" title="${escapeHtml(item.originalTitle)}">${escapeHtml(item.originalTitle)}</div>
          <div class="reorg-cell-ellipsis font-mono" style="font-size: 11px; color: var(--text-muted);" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
        </td>
        <td>
          <input type="text" class="form-input reorg-title-input" data-idx="${idx}" value="${escapeHtml(item.cleanTitle)}">
          <div class="reorg-preview-meta">
            <span class="reorg-preview-reason${reasonClass}" title="${escapeHtml(reasonTooltip)}">${escapeHtml(item.reason)}</span>${groupBadge}${orderBadge}
          </div>
        </td>
        <td>
          <div class="text-muted reorg-cell-ellipsis" style="font-size: 12px;" title="${escapeHtml(item.currentFolderName)}">${escapeHtml(item.currentFolderName)}</div>
        </td>
        <td>
          <select class="form-select font-mono reorg-folder-select" data-idx="${idx}" style="width: 100%; font-size: 11px; padding: 4px 6px;"></select>
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

      rowFrag.appendChild(tr);
    });

    if (renderedCount === 0) {
      const emptyTr = document.createElement("tr");
      const emptyMsg =
        appState.reorgItems.length > 0 && appState.reorgItems.every(i => !isItemVisibleInPreview(i))
          ? t("reorg_all_clean_hint")
          : t("reorg_filter_empty");
      emptyTr.innerHTML = `<td colspan="5" style="text-align:center; color:var(--text-muted); padding:24px;">${escapeHtml(
        emptyMsg
      )}</td>`;
      rowFrag.appendChild(emptyTr);
    }

    tbody.replaceChildren(rowFrag);

    const tableWrap = tbody.parentElement && tbody.parentElement.parentElement;
    if (tableWrap && tableWrap.scrollTop > 0) {
      tableWrap.scrollTop = 0;
    }

    if (strip && prevStripTop !== null) {
      const nextStripTop = strip.getBoundingClientRect().top;
      const scrollDelta = nextStripTop - prevStripTop;
      if (Math.abs(scrollDelta) > 1) {
        window.scrollBy({ top: scrollDelta, behavior: "instant" });
      }
    }

    tbody.querySelectorAll(".reorg-title-input").forEach(inp => {
      inp.addEventListener("input", e => {
        const idx = Number(e.target.getAttribute("data-idx"));
        appState.reorgItems[idx].cleanTitle = e.target.value.trim();
        appState.reorgItems[idx].userEditedTitle = true;
        updateReorgStatusStrip(folderChoices);
      });
    });

    tbody.querySelectorAll(".reorg-folder-select").forEach(sel => {
      sel.addEventListener("change", e => {
        const idx = Number(e.target.getAttribute("data-idx"));
        appState.reorgItems[idx].targetFolderId = e.target.value;
        appState.reorgItems[idx].userChangedFolder = true;
        appState.reorgItems[idx].unprocessed = false;
        appState.reorgItems[idx].ignored = false;
        const f = folderChoices.find(item => String(item.id) === String(e.target.value));
        if (f) appState.reorgItems[idx].targetFolderName = f.breadcrumb;
        markOrderChangedFlags(appState.reorgItems);
        updateReorgStatusStrip(folderChoices);
      });
    });

    tbody.querySelectorAll(".reorg-toggle-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        const idx = Number(btn.getAttribute("data-idx"));
        appState.reorgItems[idx].ignored = !appState.reorgItems[idx].ignored;
        renderReorgPreviewTable({ preserveFilterScroll: true });
      });
    });
  }

  // ---------------- 模式三：0 Token 重复书签合并 ---------------- //

  async function runDuplicateScanner({ stayQuiet = false } = {}) {
    if (activeAbortController) return;
    if (!ensureValidScopeSelection()) return;
    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    const scopedBookmarks = collectScopedBookmarksFromTree(tree);
    if (scopedBookmarks.length === 0) {
      showToast(t("reorg_toast_empty_scope"), true);
      return;
    }

    const folderDepthMap = new Map();
    if (appState.treeAnalysis && Array.isArray(appState.treeAnalysis.folders)) {
      appState.treeAnalysis.folders.forEach(f => {
        folderDepthMap.set(String(f.id), Number(f.depth || 1));
      });
    }

    const stripTracking = Boolean(
      document.getElementById("chkDedupStripTracking") &&
        document.getElementById("chkDedupStripTracking").checked
    );
    const ignoreHash = Boolean(
      document.getElementById("chkDedupIgnoreHash") &&
        document.getElementById("chkDedupIgnoreHash").checked
    );
    const strategy =
      (document.getElementById("selDedupStrategy") &&
        document.getElementById("selDedupStrategy").value) ||
      "smart";

    const scanResult = MarkFlowEngine.findDuplicateBookmarkGroups(scopedBookmarks, {
      stripTracking,
      ignoreHash,
      strategy,
      folderDepthMap
    });

    appState.activeReorgMode = "dedup";
    appState.dedupGroups = scanResult.groups;
    appState.dedupMeta = {
      totalScanned: scanResult.totalBookmarksScanned,
      groupCount: scanResult.duplicateGroupCount
    };

    document.getElementById("reorgBlueprintContainer").classList.add("hidden");
    setActivePreviewSurface("dedup");
    renderDedupPreview();
    enterWorkspaceStage("preview", { mode: "dedup", scopeLabel: getScopeSummaryLabel(tree) });

    if (!stayQuiet) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (scanResult.duplicateGroupCount > 0) {
        showToast(
          t("reorg_dedup_toast_ready", {
            groups: scanResult.duplicateGroupCount,
            remove: scanResult.removableCount
          })
        );
      } else {
        showToast(t("reorg_dedup_empty_title"));
      }
    }
  }

  function renderDedupPreview() {
    document.getElementById("reorgAiTableWrap").classList.add("hidden");
    document.getElementById("reorgDeadlinkTableWrap").classList.add("hidden");

    const listWrap = document.getElementById("reorgDedupListWrap");
    const emptyState = document.getElementById("reorgCleanEmptyState");
    const applyBtn = document.getElementById("btnApplyReorganize");

    const groups = appState.dedupGroups || [];
    const removeCount = groups.reduce(
      (sum, g) => sum + g.members.filter(m => !m.isKeep && m.removeChecked).length,
      0
    );
    const keepCount = groups.reduce(
      (sum, g) => sum + g.members.filter(m => m.isKeep || !m.removeChecked).length,
      0
    );

    document.getElementById("dedupStatGroups").textContent = t("reorg_dedup_stat_groups", {
      count: groups.length
    });
    document.getElementById("dedupStatKeep").textContent = t("reorg_dedup_stat_keep", {
      count: keepCount
    });
    document.getElementById("dedupStatRemove").textContent = t("reorg_dedup_stat_remove", {
      count: removeCount
    });

    if (applyBtn) {
      applyBtn.disabled = removeCount === 0;
    }

    if (groups.length === 0) {
      listWrap.classList.add("hidden");
      listWrap.innerHTML = "";
      document.getElementById("reorgCleanEmptyTitle").textContent = t("reorg_dedup_empty_title");
      document.getElementById("reorgCleanEmptyDesc").textContent = t("reorg_dedup_empty_desc");
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");
    listWrap.classList.remove("hidden");

    const openSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
    const frag = document.createDocumentFragment();

    groups.forEach((group, gIdx) => {
      const card = document.createElement("div");
      card.className = "dedup-group-card";

      const header = document.createElement("div");
      header.className = "dedup-group-header";
      header.innerHTML = `
        <span class="dedup-canonical-url font-mono" title="${escapeHtml(group.canonicalUrl)}">${escapeHtml(group.canonicalUrl)}</span>
        <span class="dedup-group-count">${escapeHtml(t("reorg_dedup_group_badge", { count: group.members.length }))}</span>
      `;
      card.appendChild(header);

      const membersWrap = document.createElement("div");
      membersWrap.className = "dedup-members-wrap";

      group.members.forEach((m, mIdx) => {
        const row = document.createElement("div");
        row.className = "dedup-member-row" + (m.isKeep ? " is-kept" : "");

        const rightControlHtml = m.isKeep
          ? `<span class="dedup-badge-keep">${escapeHtml(t("reorg_dedup_badge_keep"))}</span>`
          : `<label class="dedup-remove-toggle">
               <input type="checkbox" class="dedup-member-chk" data-g="${gIdx}" data-m="${mIdx}" ${m.removeChecked ? "checked" : ""}>
               <span class="${m.removeChecked ? "dedup-badge-remove" : "dedup-badge-also-keep"}">${escapeHtml(
                 m.removeChecked ? t("reorg_dedup_badge_remove") : t("reorg_dedup_badge_also_keep")
               )}</span>
             </label>`;

        row.innerHTML = `
          <input type="radio" class="dedup-member-radio" name="dedup_keep_${gIdx}" data-g="${gIdx}" data-m="${mIdx}" ${m.isKeep ? "checked" : ""}>
          <div class="dedup-member-main">
            <div class="dedup-member-title" title="${escapeHtml(m.title)}">${escapeHtml(m.title || m.url)}</div>
            <div class="dedup-member-url font-mono" title="${escapeHtml(m.url)}">${escapeHtml(m.url)}</div>
          </div>
          <div class="dedup-member-folder" title="${escapeHtml(m.parentTitle)}">${escapeHtml(m.parentTitle)}</div>
          ${rightControlHtml}
          <a class="deadlink-open-btn" href="${escapeHtml(m.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t("reorg_open_verify_title"))}">${openSvg}</a>
        `;

        membersWrap.appendChild(row);
      });

      card.appendChild(membersWrap);
      frag.appendChild(card);
    });

    listWrap.replaceChildren(frag);

    listWrap.querySelectorAll(".dedup-member-radio").forEach(radio => {
      radio.addEventListener("change", () => {
        const gIdx = Number(radio.getAttribute("data-g"));
        const mIdx = Number(radio.getAttribute("data-m"));
        const group = appState.dedupGroups[gIdx];
        if (!group || !group.members[mIdx]) return;
        const nextKeepId = String(group.members[mIdx].id);
        group.keepId = nextKeepId;
        group.members.forEach(item => {
          item.isKeep = String(item.id) === nextKeepId;
          item.removeChecked = !item.isKeep;
        });
        renderDedupPreview();
      });
    });

    listWrap.querySelectorAll(".dedup-member-chk").forEach(chk => {
      chk.addEventListener("change", () => {
        const gIdx = Number(chk.getAttribute("data-g"));
        const mIdx = Number(chk.getAttribute("data-m"));
        const group = appState.dedupGroups[gIdx];
        if (!group || !group.members[mIdx]) return;
        group.members[mIdx].removeChecked = Boolean(chk.checked);
        renderDedupPreview();
      });
    });
  }

  // ---------------- 模式四：0 Token 失效链接清理（按需临时授权 + 自动撤销） ---------------- //

  async function acquireDeadLinkScanPermission() {
    if (
      typeof chrome === "undefined" ||
      !chrome.permissions ||
      typeof chrome.permissions.contains !== "function"
    ) {
      return { mode: "cors", grantedByUs: false };
    }
    try {
      const already = await chrome.permissions.contains({ origins: DEADLINK_HOST_ORIGINS });
      if (already) return { mode: "cors", grantedByUs: false };
      const granted = await chrome.permissions.request({ origins: DEADLINK_HOST_ORIGINS });
      if (granted) return { mode: "cors", grantedByUs: true };
      return { mode: "no-cors", grantedByUs: false, declined: true };
    } catch (err) {
      return { mode: "no-cors", grantedByUs: false, declined: true };
    }
  }

  async function releaseDeadLinkScanPermission(permState) {
    if (
      !permState ||
      !permState.grantedByUs ||
      typeof chrome === "undefined" ||
      !chrome.permissions ||
      typeof chrome.permissions.remove !== "function"
    ) {
      return;
    }
    try {
      await chrome.permissions.remove({ origins: DEADLINK_HOST_ORIGINS });
    } catch (e) {}
  }

  async function runDeadLinkScanner() {
    if (activeAbortController) return;
    if (!ensureValidScopeSelection()) return;
    const tree = await chrome.bookmarks.getTree();
    parseFolderStructures(tree);

    const scopedBookmarks = collectScopedBookmarksFromTree(tree);
    if (scopedBookmarks.length === 0) {
      showToast(t("reorg_toast_empty_scope"), true);
      return;
    }

    const skipLocal = Boolean(
      document.getElementById("chkDeadlinkSkipLocal") &&
        document.getElementById("chkDeadlinkSkipLocal").checked
    );

    const permState = await acquireDeadLinkScanPermission();
    if (permState.declined) {
      showToast(t("reorg_dead_perm_fallback_toast"));
    }

    const progressBar = document.getElementById("reorgProgressBar");
    const progressText = document.getElementById("reorgProgressText");
    const progressPercent = document.getElementById("reorgProgressPercent");
    const previewBox = document.getElementById("reorgPreviewContainer");

    document.getElementById("reorgBlueprintContainer").classList.add("hidden");
    previewBox.classList.add("hidden");

    const signal = beginCancellableRun("deadlinks", "reorg_prog_cancel_hint");
    progressBar.style.width = "0%";
    progressText.textContent = t("reorg_prog_prepare", { count: scopedBookmarks.length });
    progressPercent.textContent = "0%";

    try {
      const scanResult = await MarkFlowEngine.scanDeadBookmarks({
        bookmarks: scopedBookmarks,
        skipLocal,
        mode: permState.mode,
        concurrency: 6,
        timeoutMs: 8000,
        retryConcurrency: 2,
        retryTimeoutMs: 22000,
        signal,
        onProgress: ({ phase, done, total }) => {
          const pct = total > 0 ? Math.round((done / total) * 100) : 100;
          progressBar.style.width = `${pct}%`;
          progressText.textContent =
            phase === "retry"
              ? t("reorg_prog_deadlinks_retry", { done, total })
              : t("reorg_prog_deadlinks", { done, total });
          progressPercent.textContent = `${pct}%`;
        }
      });

      if (scanResult.canceled && scanResult.scannedCount === 0) {
        enterWorkspaceStage("config");
        showToast(t("reorg_toast_canceled_empty"));
        return;
      }

      appState.activeReorgMode = "deadlinks";
      appState.deadlinkResults = scanResult.results;
      appState.deadlinkMeta = {
        mode: scanResult.mode,
        canceled: scanResult.canceled,
        scannedCount: scanResult.scannedCount,
        aliveCount: scanResult.aliveCount,
        protectedCount: scanResult.protectedCount || 0,
        skippedCount: scanResult.skippedCount,
        deadCount: scanResult.deadCount,
        reviewCount: scanResult.reviewCount,
        unprocessedCount: scanResult.unprocessedCount,
        proxyHint: scanResult.proxyHint || null
      };
      appState.deadlinkFilter = "all";

      setActivePreviewSurface("deadlinks");
      renderDeadlinkPreview();
      enterWorkspaceStage("preview", { mode: "deadlinks", scopeLabel: getScopeSummaryLabel(tree) });
      window.scrollTo({ top: 0, behavior: "smooth" });

      if (scanResult.canceled) {
        showToast(
          t("reorg_toast_canceled_deadlinks", {
            scanned: scanResult.scannedCount,
            issues: scanResult.results.length
          })
        );
      } else if (scanResult.results.length === 0) {
        showToast(t("reorg_dead_empty_title"));
      } else {
        showToast(
          t("reorg_dead_toast_ready", {
            dead: scanResult.deadCount,
            review: scanResult.reviewCount
          })
        );
      }
    } finally {
      await releaseDeadLinkScanPermission(permState);
      endCancellableRun();
    }
  }

  function getVisibleDeadlinkItems() {
    const items = appState.deadlinkResults || [];
    if (appState.deadlinkFilter === "dead") return items.filter(i => i.category === "dead");
    if (appState.deadlinkFilter === "review") return items.filter(i => i.category === "review");
    return items;
  }

  function renderDeadlinkPreview() {
    document.getElementById("reorgAiTableWrap").classList.add("hidden");
    document.getElementById("reorgDedupListWrap").classList.add("hidden");

    const tableWrap = document.getElementById("reorgDeadlinkTableWrap");
    const emptyState = document.getElementById("reorgCleanEmptyState");
    const tbody = document.getElementById("reorgDeadlinkTableBody");
    const applyBtn = document.getElementById("btnApplyReorganize");

    const allIssues = appState.deadlinkResults || [];
    const meta = appState.deadlinkMeta || {};
    const deadCount = allIssues.filter(i => i.category === "dead").length;
    const reviewCount = allIssues.filter(i => i.category === "review").length;
    const selectedCount = allIssues.filter(i => i.selectedForDelete).length;

    document.getElementById("cntDeadAll").textContent = String(allIssues.length);
    document.getElementById("cntDeadHigh").textContent = String(deadCount);
    document.getElementById("cntDeadReview").textContent = String(reviewCount);

    document.querySelectorAll("#reorgDeadlinkStatusGroup .status-filter-pill").forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-dead-filter") === appState.deadlinkFilter);
    });

    const metaNote = document.getElementById("deadlinkMetaNote");
    if (metaNote) {
      metaNote.textContent =
        (meta.protectedCount || 0) > 0
          ? t("reorg_dead_meta_summary_protected", {
              alive: meta.aliveCount || 0,
              protected: meta.protectedCount || 0,
              skipped: meta.skippedCount || 0
            })
          : t("reorg_dead_meta_summary", {
              alive: meta.aliveCount || 0,
              skipped: meta.skippedCount || 0
            });
    }

    const modeBadge = document.getElementById("deadlinkModeBadge");
    if (modeBadge) {
      if (meta.mode === "no-cors") {
        modeBadge.textContent = t("reorg_dead_badge_nocors");
        modeBadge.classList.remove("hidden");
      } else if (meta.canceled) {
        modeBadge.textContent = t("reorg_dead_badge_canceled");
        modeBadge.classList.remove("hidden");
      } else {
        modeBadge.classList.add("hidden");
      }
    }

    const proxyBanner = document.getElementById("deadlinkProxyHintBanner");
    const proxyBannerText = document.getElementById("deadlinkProxyHintText");
    if (proxyBanner && proxyBannerText) {
      const hint = meta.proxyHint;
      if (allIssues.length > 0 && hint && hint.suspected) {
        if (hint.reason === "global_sites") {
          const sampleDomains = (hint.globalFailedDomains || []).slice(0, 3).join(" / ");
          proxyBannerText.textContent = t("reorg_dead_proxy_hint_global", {
            domains: sampleDomains
          });
        } else if (hint.reason === "tls_cluster") {
          proxyBannerText.textContent = t("reorg_dead_proxy_hint_tls", {
            count: hint.tlsHostCount || 0
          });
        } else {
          proxyBannerText.textContent = t("reorg_dead_proxy_hint_ratio", {
            count: hint.timeoutCount || 0
          });
        }
        proxyBanner.classList.remove("hidden");
      } else {
        proxyBanner.classList.add("hidden");
      }
    }

    if (applyBtn) {
      applyBtn.disabled = selectedCount === 0;
    }

    if (allIssues.length === 0) {
      tableWrap.classList.add("hidden");
      tbody.innerHTML = "";
      document.getElementById("reorgCleanEmptyTitle").textContent = t("reorg_dead_empty_title");
      document.getElementById("reorgCleanEmptyDesc").textContent = t("reorg_dead_empty_desc");
      emptyState.classList.remove("hidden");
      return;
    }

    emptyState.classList.add("hidden");
    tableWrap.classList.remove("hidden");

    const visibleItems = getVisibleDeadlinkItems();
    const chkAllVisible = document.getElementById("chkDeadSelectVisible");
    if (chkAllVisible) {
      chkAllVisible.checked =
        visibleItems.length > 0 && visibleItems.every(i => i.selectedForDelete);
    }

    const openSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`;
    const frag = document.createDocumentFragment();

    if (visibleItems.length === 0) {
      const emptyTr = document.createElement("tr");
      emptyTr.innerHTML = `<td colspan="5" style="text-align:center; color:var(--text-muted); padding:24px;">${escapeHtml(
        t("reorg_filter_empty")
      )}</td>`;
      frag.appendChild(emptyTr);
    } else {
      visibleItems.forEach(item => {
        const globalIdx = allIssues.indexOf(item);
        const tr = document.createElement("tr");
        const pillClass = item.category === "dead" ? "is-dead" : "is-review";
        const reasonText = item.reasonKey ? t(item.reasonKey) : "";

        tr.innerHTML = `
          <td class="deadlink-check-cell" style="text-align: center;">
            <input type="checkbox" class="deadlink-row-chk" data-idx="${globalIdx}" ${item.selectedForDelete ? "checked" : ""}>
          </td>
          <td>
            <div class="reorg-cell-ellipsis" style="font-weight: 600; font-size: 13px;" title="${escapeHtml(item.title)}">${escapeHtml(item.title || item.url)}</div>
            <div class="reorg-cell-ellipsis font-mono" style="font-size: 11px; color: var(--text-muted);" title="${escapeHtml(item.url)}">${escapeHtml(item.url)}</div>
          </td>
          <td>
            <div class="text-muted reorg-cell-ellipsis" style="font-size: 12px;" title="${escapeHtml(item.parentTitle)}">${escapeHtml(item.parentTitle)}</div>
          </td>
          <td>
            <div class="deadlink-status-cell">
              <span class="deadlink-code-pill ${pillClass}">${escapeHtml(item.codeLabel)}</span>
              <span class="deadlink-reason-text" title="${escapeHtml(reasonText)}">${escapeHtml(reasonText)}</span>
            </div>
          </td>
          <td style="text-align: right;">
            <a class="deadlink-open-btn" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(t("reorg_open_verify_title"))}">${openSvg}</a>
          </td>
        `;
        frag.appendChild(tr);
      });
    }

    tbody.replaceChildren(frag);

    tbody.querySelectorAll(".deadlink-row-chk").forEach(chk => {
      chk.addEventListener("change", () => {
        const idx = Number(chk.getAttribute("data-idx"));
        if (appState.deadlinkResults[idx]) {
          appState.deadlinkResults[idx].selectedForDelete = Boolean(chk.checked);
          const curVisible = getVisibleDeadlinkItems();
          if (chkAllVisible) {
            chkAllVisible.checked =
              curVisible.length > 0 && curVisible.every(i => i.selectedForDelete);
          }
          if (applyBtn) {
            applyBtn.disabled = appState.deadlinkResults.every(i => !i.selectedForDelete);
          }
        }
      });
    });
  }

  // ---------------- 原子落地、倒序精准排序、删除变空祖先目录与自动 HTML 备份 ---------------- //

  /**
   * 仅针对本次删除书签后可能变空的父目录向上递归清理（严格使用 remove 而非 removeTree）。
   */
  async function cleanupEmptiedAncestorFolders(initialParentIds) {
    const queue = Array.from(new Set(initialParentIds.map(String).filter(Boolean)));
    const visited = new Set();
    let removedCount = 0;

    while (queue.length > 0) {
      const fid = queue.shift();
      if (!fid || visited.has(fid)) continue;
      visited.add(fid);

      try {
        const nodes = await chrome.bookmarks.get(fid);
        const folderNode = nodes && nodes[0];
        if (!folderNode || folderNode.url !== undefined) continue;
        if (MarkFlowEngine.platform.isRootBookmarkNode(folderNode)) continue;

        const children = await chrome.bookmarks.getChildren(fid);
        if (children.length === 0) {
          await chrome.bookmarks.remove(fid);
          removedCount++;
          if (folderNode.parentId) queue.push(String(folderNode.parentId));
        }
      } catch (e) {}
    }

    return removedCount;
  }

  async function refreshBookmarkTreeAndUi() {
    const postTree = await chrome.bookmarks.getTree();
    parseFolderStructures(postTree);
    populateReorgFolderSelect();
    renderLockedFoldersChecklist();
    updateReorgTokenEstimate();
    enterWorkspaceStage("config");
  }

  async function applyDedupChanges() {
    const toRemove = [];
    for (const g of appState.dedupGroups || []) {
      for (const m of g.members) {
        if (!m.isKeep && m.removeChecked) {
          toRemove.push(m);
        }
      }
    }

    if (toRemove.length === 0) {
      showToast(t("reorg_dedup_toast_none_selected"), true);
      return;
    }

    const btnApply = document.getElementById("btnApplyReorganize");
    btnApply.disabled = true;
    try {
      await downloadBookmarksBackup();
      const parentIds = [];
      let removed = 0;
      for (const bm of toRemove) {
        if (bm.parentId) parentIds.push(bm.parentId);
        await chrome.bookmarks.remove(String(bm.id));
        removed++;
      }
      const removedFolders = await cleanupEmptiedAncestorFolders(parentIds);
      appState.dedupGroups = [];
      await refreshBookmarkTreeAndUi();
      showToast(
        removedFolders > 0
          ? t("reorg_dedup_toast_done_folders", { count: removed, folders: removedFolders })
          : t("reorg_dedup_toast_done", { count: removed })
      );
    } catch (err) {
      showToast(t("reorg_toast_apply_err", { msg: err.message }), true);
    } finally {
      btnApply.disabled = false;
    }
  }

  async function applyDeadlinkChanges() {
    const toRemove = (appState.deadlinkResults || []).filter(i => i.selectedForDelete);
    if (toRemove.length === 0) {
      showToast(t("reorg_dead_toast_none_selected"), true);
      return;
    }

    const btnApply = document.getElementById("btnApplyReorganize");
    btnApply.disabled = true;
    try {
      await downloadBookmarksBackup();
      const parentIds = [];
      let removed = 0;
      for (const bm of toRemove) {
        if (bm.parentId) parentIds.push(bm.parentId);
        await chrome.bookmarks.remove(String(bm.id));
        removed++;
      }
      const removedFolders = await cleanupEmptiedAncestorFolders(parentIds);
      appState.deadlinkResults = [];
      await refreshBookmarkTreeAndUi();
      showToast(
        removedFolders > 0
          ? t("reorg_dead_toast_done_folders", { count: removed, folders: removedFolders })
          : t("reorg_dead_toast_done", { count: removed })
      );
    } catch (err) {
      showToast(t("reorg_toast_apply_err", { msg: err.message }), true);
    } finally {
      btnApply.disabled = false;
    }
  }

  /**
   * 对单个 Chrome 目录内的子节点实施确定性排序：
   * 先将子文件夹倒序移至索引 0 保持置顶，再将目标书签按倒序移至子文件夹末尾位置。
   * 全部移动均为“向更小索引移动”，可彻底避免 Chromium 同目录前向移动引起的索引偏移问题。
   */
  async function enforceFolderBookmarkOrder(folderId, orderedBookmarkIds) {
    if (!folderId || !orderedBookmarkIds || orderedBookmarkIds.length <= 1) return false;
    const fid = String(folderId);
    const liveChildren = await chrome.bookmarks.getChildren(fid);
    const subfolders = liveChildren.filter(c => !c.url);
    const liveBookmarks = liveChildren.filter(c => !!c.url);
    const liveBookmarkIds = new Set(liveBookmarks.map(c => String(c.id)));

    const subfoldersInFront = liveChildren.slice(0, subfolders.length).every(c => !c.url);
    const validOrdered = orderedBookmarkIds.filter(id => liveBookmarkIds.has(String(id))).map(String);
    const currentPrefix = liveBookmarks.slice(0, validOrdered.length).map(c => String(c.id));
    const orderAlreadyMatches =
      subfoldersInFront &&
      validOrdered.length === currentPrefix.length &&
      validOrdered.every((id, idx) => id === currentPrefix[idx]);

    if (orderAlreadyMatches) return false;

    if (!subfoldersInFront) {
      for (let s = subfolders.length - 1; s >= 0; s--) {
        await chrome.bookmarks.move(String(subfolders[s].id), { parentId: fid, index: 0 });
      }
    }

    const targetStartIdx = subfolders.length;
    for (let i = validOrdered.length - 1; i >= 0; i--) {
      await chrome.bookmarks.move(String(validOrdered[i]), {
        parentId: fid,
        index: targetStartIdx
      });
    }
    return true;
  }

  async function applyReorganizerChanges() {
    if (appState.activeReorgMode === "dedup") {
      return applyDedupChanges();
    }
    if (appState.activeReorgMode === "deadlinks") {
      return applyDeadlinkChanges();
    }

    const activeItems = appState.reorgItems.filter(i => !i.ignored && !i.unprocessed);
    if (activeItems.length === 0) {
      showToast(t("reorg_toast_no_active"), true);
      return;
    }

    const sortRule = getSelectedSortRule();
    if (appState.activeReorgMode !== "rebuild") {
      const changedItems = activeItems.filter(isItemChanged);
      if (changedItems.length === 0) {
        showToast(t("reorg_toast_no_changes"));
        return;
      }
    }

    const btnApply = document.getElementById("btnApplyReorganize");
    btnApply.disabled = true;

    try {
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
          const sorted = MarkFlowEngine.sortFolderBookmarksByPriority(bucket, sortRule);
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

        await refreshBookmarkTreeAndUi();
        showToast(t("reorg_toast_rebuild_done", { count: updatedCount, removed: removedFolders }));
      } else {
        const shouldSort =
          appState.activeReorgMode === "sort_only" ||
          document.getElementById("chkSortInFolders").checked;

        const itemsByDestFolder = new Map();
        const dirtyFolderIds = new Set();
        let updatedCount = 0;

        for (const item of activeItems) {
          const titleChanged = Boolean(item.cleanTitle && item.cleanTitle !== item.originalTitle);
          if (titleChanged) {
            await chrome.bookmarks.update(item.id, { title: item.cleanTitle });
          }
          const destId = String(item.targetFolderId || item.currentFolderId);
          const folderChanged = destId !== String(item.currentFolderId);
          if (folderChanged) {
            await chrome.bookmarks.move(item.id, { parentId: destId });
          }
          if (titleChanged || folderChanged || item.orderChanged) {
            updatedCount++;
          }
          if (folderChanged || item.orderChanged) {
            dirtyFolderIds.add(destId);
          }
          if (!itemsByDestFolder.has(destId)) itemsByDestFolder.set(destId, []);
          itemsByDestFolder.get(destId).push(item);
        }

        let sortedFoldersCount = 0;
        if (shouldSort) {
          for (const [fid, bucket] of itemsByDestFolder.entries()) {
            if (bucket.length > 1 && dirtyFolderIds.has(fid)) {
              const sorted = MarkFlowEngine.sortFolderBookmarksByPriority(bucket, sortRule);
              const didReorder = await enforceFolderBookmarkOrder(fid, sorted.map(it => it.id));
              if (didReorder) sortedFoldersCount++;
            }
          }
        }

        await refreshBookmarkTreeAndUi();
        showToast(
          shouldSort
            ? t("reorg_toast_existing_sorted_done", { count: updatedCount, folders: sortedFoldersCount })
            : t("reorg_toast_existing_done", { count: updatedCount })
        );
      }
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
        MarkFlowEngine.platform.isRootBookmarkNode(node) ||
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

  function formatFolderTrail(parentTrail, folderNode, parentIsRoot = false) {
    const name = (folderNode.title || "").trim();
    if (MarkFlowEngine.platform.isRootBookmarkNode(folderNode)) {
      return name || parentTrail || "Bookmarks Bar";
    }
    if (!parentTrail || parentIsRoot || MarkFlowEngine.platform.isRootFolderName(parentTrail)) {
      return name;
    }
    return `${parentTrail} › ${name}`;
  }

  function collectBookmarks(nodes, parentTrail = "", parentIsRoot = false) {
    let list = [];
    if (!nodes) return list;

    for (const node of nodes) {
      if (node.url) {
        list.push({
          id: String(node.id),
          title: node.title,
          url: node.url,
          origIndex: Number(node.index ?? 0),
          dateAdded: Number(node.dateAdded || 0),
          parentId: String(node.parentId || ""),
          parentTitle: parentTrail || "Bookmarks Bar"
        });
      } else if (node.children) {
        const nextIsRoot = MarkFlowEngine.platform.isRootBookmarkNode(node);
        list = list.concat(
          collectBookmarks(node.children, formatFolderTrail(parentTrail, node, parentIsRoot), nextIsRoot)
        );
      }
    }
    return list;
  }

  function collectUnlockedBookmarks(nodes, lockedL1Set, parentTrail = "", parentIsRoot = false) {
    let list = [];
    if (!nodes) return list;

    for (const node of nodes) {
      if (node.url) {
        list.push({
          id: String(node.id),
          title: node.title,
          url: node.url,
          origIndex: Number(node.index ?? 0),
          dateAdded: Number(node.dateAdded || 0),
          parentId: String(node.parentId || ""),
          parentTitle: parentTrail || "Bookmarks Bar"
        });
      } else if (node.children) {
        if (lockedL1Set && lockedL1Set.has(String(node.id))) continue;
        const nextIsRoot = MarkFlowEngine.platform.isRootBookmarkNode(node);
        list = list.concat(
          collectUnlockedBookmarks(
            node.children,
            lockedL1Set,
            formatFolderTrail(parentTrail, node, parentIsRoot),
            nextIsRoot
          )
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

  /** 语言切换后刷新摘要条、范围与锁定目录摘要、动态预览文案与按钮标题 */
  function refreshReorgDynamicI18n() {
    syncReorgStartButtonLabel();
    populateReorgFolderSelect();
    syncLockedFoldersSummary();
    updateReorgTokenEstimate();
    syncSummaryBarDom();
    if (currentWorkspaceStage === "preview") {
      if (appState.activeReorgMode === "dedup") {
        setActivePreviewSurface("dedup");
        renderDedupPreview();
      } else if (appState.activeReorgMode === "deadlinks") {
        setActivePreviewSurface("deadlinks");
        renderDeadlinkPreview();
      } else {
        setActivePreviewSurface("ai");
        renderReorgPreviewTable({ preserveFilterScroll: true });
      }
    }
  }

  ctx.initReorganizeTab = initReorganizeTab;
  ctx.syncReorgStartButtonLabel = syncReorgStartButtonLabel;
  ctx.populateReorgFolderSelect = populateReorgFolderSelect;
  ctx.renderLockedFoldersChecklist = renderLockedFoldersChecklist;
  ctx.updateReorgTokenEstimate = updateReorgTokenEstimate;
  ctx.refreshReorgDynamicI18n = refreshReorgDynamicI18n;
})(window);
