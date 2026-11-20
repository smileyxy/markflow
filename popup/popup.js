/**
 * 弹窗主控制器
 *
 * 协调智能收藏与极速书签检索双视图：
 * 1. 按需采集当前页 DOM 语义摘要（受隐私开关与 550ms 超时保护）
 * 2. 依次执行精确查重、本地规则匹配、垂直站点历史归属与 AI 语义归类
 * 3. 支持单点 AI 标题润色、可搜索目录树筛选、同站邻近插入及操作撤销
 */

let currentTab = null;
let currentMode = "save"; // "save" | "search"
let treeAnalysis = null;
let preferences = {};
let aiConfig = { enabled: false };
let domainMemory = {};
let activeRules = [];

let selectedFolderId = "";
let aiRecommendedFolderId = "";
let userEditedTitle = false;
let userChangedFolder = false;
let pendingNewSubfolder = null;

let existingBookmark = null;
let undoState = null;
let countdownTimer = null;
let cachedPageContext = undefined;

// 目录筛选下拉状态
let comboOpen = false;
let filteredComboFolders = [];
let comboHighlightIdx = 0;

// 极速检索列表状态
let searchMatches = [];
let searchActiveIdx = 0;

function t(key, varsOrFallback) {
  return getLocaleString(preferences.language, key, varsOrFallback);
}

function isAiConfigured() {
  const activeCfg = MarkFlowEngine.resolveActiveProviderConfig(aiConfig);
  return Boolean(
    activeCfg.enabled && activeCfg.baseUrl && (activeCfg.apiKey || activeCfg.provider === "ollama")
  );
}

function showPopupError(message) {
  const strip = document.getElementById("popupErrorStrip");
  if (!strip) return;
  strip.textContent = message;
  strip.classList.remove("hidden");
  clearTimeout(showPopupError._timer);
  showPopupError._timer = setTimeout(() => {
    strip.classList.add("hidden");
  }, 4500);
}

function isBlankOrUtilityTab(url) {
  if (!url) return true;
  return /^(chrome:\/\/(newtab|bookmarks|extensions)|edge:\/\/newtab|about:(blank|newtab))/i.test(url);
}

document.addEventListener("DOMContentLoaded", async () => {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tabs || tabs.length === 0) return;
  currentTab = tabs[0];

  // 填充站点图标与身份预览信息
  const faviconEl = document.getElementById("siteFavicon");
  if (currentTab.favIconUrl && !currentTab.favIconUrl.startsWith("chrome://")) {
    faviconEl.src = currentTab.favIconUrl;
    faviconEl.onerror = () => {
      faviconEl.src = "../icons/icon16.png";
    };
  }
  const urlInfo = MarkFlowEngine.parseUrlInfo(currentTab.url || "");
  document.getElementById("siteDomainPreview").textContent =
    urlInfo.valid ? urlInfo.hostKey || urlInfo.hostname : currentTab.url || "";
  document.getElementById("urlPreview").textContent = currentTab.url || "";

  // 并行加载本地配置与完整书签树
  const isBlankTab = isBlankOrUtilityTab(currentTab.url);
  const [stored, tree] = await Promise.all([
    chrome.storage.local.get(["aiConfig", "rules", "preferences", "domainMemory"]),
    chrome.bookmarks.getTree()
  ]);

  preferences = Object.assign({}, MarkFlowEngine.DEFAULT_PREFERENCES, stored.preferences || {});
  aiConfig = stored.aiConfig || { enabled: false };
  domainMemory = stored.domainMemory || {};

  applyI18nToDocument(preferences.language);

  // 显示当前生效的标题命名风格标记
  const titleOriginBadge = document.getElementById("titleOriginBadge");
  if (titleOriginBadge) {
    const styleKeyMap = {
      scannable: "pop_style_scannable",
      concise: "pop_style_concise",
      faithful: "pop_style_faithful"
    };
    titleOriginBadge.textContent = t(styleKeyMap[preferences.titleStyle] || "pop_style_scannable");
  }

  // 已配置 AI 时在标题栏展示单点润色按钮
  const aiTitleBtn = document.getElementById("btnAiTitlePolish");
  if (aiTitleBtn && isAiConfigured() && !isBlankTab) {
    aiTitleBtn.classList.remove("hidden");
  }

  // 根据隐私开关按需读取页面语义摘要
  const shouldExtractDom = !isBlankTab && preferences.extractPageContext !== false;
  cachedPageContext = shouldExtractDom
    ? await extractPageSemanticContext(currentTab.id, currentTab.url)
    : null;
  if (cachedPageContext) {
    document.getElementById("deepContextBadge").classList.remove("hidden");
  }

  let rules = stored.rules;
  if (!rules || !Array.isArray(rules)) {
    rules = MarkFlowEngine.DEFAULT_UNIVERSAL_RULES;
    chrome.storage.local.set({ rules });
  }
  activeRules = rules;

  // 构建书签树目录画像与索引
  treeAnalysis = MarkFlowEngine.analyzeBookmarkTree(tree);
  document.getElementById("bookmarkCountBadge").textContent = String(treeAnalysis.bookmarks.length);

  // 初始化默认选中目录（优先首个一级分类或书签栏）
  const defaultFolder =
    treeAnalysis.folders.find(f => f.depth === 2) ||
    treeAnalysis.folders.find(f => f.id === "1") ||
    treeAnalysis.folders[0];
  if (defaultFolder) {
    setSelectedFolder(defaultFolder.id, false);
  }

  bindEvents();
  renderSearchLauncher("");

  // 空白页或新标签页直接进入极速书签检索视图
  if (isBlankTab) {
    setBadge("idle", String(treeAnalysis.bookmarks.length));
    switchMode("search");
    return;
  }

  // 本地预处理网页标题
  let localCleanTitle = currentTab.title || "";
  if (preferences.stripSuffixes) {
    localCleanTitle = MarkFlowEngine.cleanTitleLocally(localCleanTitle);
  }
  if (preferences.panguSpacing !== false) {
    localCleanTitle = MarkFlowEngine.addPanguSpacing(localCleanTitle);
  }
  document.getElementById("inputTitle").value = localCleanTitle;

  // 精确去重检查：若当前网址已存在，则进入就地编辑模式
  const existingList = MarkFlowEngine.findExistingBookmarks(currentTab.url, treeAnalysis.bookmarks);
  if (existingList.length > 0) {
    existingBookmark = existingList[0];
    enterDuplicateEditMode(existingBookmark, activeRules);
    return;
  }

  await runClassificationPipeline(localCleanTitle, activeRules);
});

// ---------------- 当前页语义摘要提取 ---------------- //

async function extractPageSemanticContext(tabId, url) {
  if (!tabId || !url || !/^https?:\/\//i.test(url)) return null;
  if (/^https:\/\/(chrome\.google\.com|chromewebstore\.google\.com)/i.test(url)) return null;

  const timeoutPromise = new Promise(resolve => setTimeout(() => resolve(null), 550));

  const scriptPromise = chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        try {
          const getMeta = selectors => {
            for (const sel of selectors) {
              const el = document.querySelector(sel);
              const val = el && (el.getAttribute("content") || el.textContent);
              if (val && val.trim()) return val.trim().replace(/\s+/g, " ").slice(0, 220);
            }
            return "";
          };

          const siteName = getMeta(['meta[property="og:site_name"]', 'meta[name="application-name"]']);
          const description = getMeta([
            'meta[name="description"]',
            'meta[property="og:description"]',
            'meta[name="twitter:description"]'
          ]);
          const keywords = getMeta(['meta[name="keywords"]']).slice(0, 140);

          let schemaType = "";
          const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
          for (let i = 0; i < Math.min(ldScripts.length, 3); i++) {
            try {
              const parsed = JSON.parse(ldScripts[i].textContent || "{}");
              const items = Array.isArray(parsed) ? parsed : parsed["@graph"] || [parsed];
              const types = items.map(it => it && it["@type"]).flat().filter(v => typeof v === "string");
              if (types.length) {
                schemaType = types.slice(0, 3).join(", ");
                break;
              }
            } catch (e) {}
          }

          const h1El = document.querySelector("h1");
          const h1 = h1El ? h1El.textContent.trim().replace(/\s+/g, " ").slice(0, 120) : "";

          const h2s = Array.from(document.querySelectorAll("h2"))
            .map(el => el.textContent.trim().replace(/\s+/g, " "))
            .filter(txt => txt.length >= 2 && txt.length <= 60)
            .slice(0, 3)
            .join(" / ");

          const bcEl = document.querySelector('[aria-label*="breadcrumb" i], nav.breadcrumb, .breadcrumbs');
          const breadcrumbs = bcEl ? bcEl.textContent.trim().replace(/\s+/g, " ").slice(0, 120) : "";

          // 针对常见高信息密度平台提取正文特征
          const host = location.hostname.toLowerCase();
          let platformHint = "";
          if (host.includes("github.com")) {
            const aboutEl = document.querySelector(".BorderGrid-cell p.f4, [itemprop='about']");
            const topics = Array.from(document.querySelectorAll("a.topic-tag"))
              .map(a => a.textContent.trim())
              .filter(Boolean)
              .slice(0, 6)
              .join(", ");
            const langEl = document.querySelector("[itemprop='programmingLanguage']");
            const parts = [];
            if (aboutEl && aboutEl.textContent.trim()) parts.push(`About: ${aboutEl.textContent.trim()}`);
            if (topics) parts.push(`Topics: ${topics}`);
            if (langEl && langEl.textContent.trim()) parts.push(`Lang: ${langEl.textContent.trim()}`);
            platformHint = parts.join(" | ").slice(0, 240);
          } else if (host === "x.com" || host.includes("twitter.com")) {
            const tweetEl = document.querySelector('[data-testid="tweetText"]');
            const bioEl = document.querySelector('[data-testid="UserDescription"]');
            if (tweetEl && tweetEl.textContent.trim()) {
              platformHint = `Post: ${tweetEl.textContent.trim().replace(/\s+/g, " ").slice(0, 200)}`;
            } else if (bioEl && bioEl.textContent.trim()) {
              platformHint = `Bio: ${bioEl.textContent.trim().replace(/\s+/g, " ").slice(0, 180)}`;
            }
          } else if (host.includes("youtube.com")) {
            const chEl = document.querySelector("#channel-name a, ytd-channel-name a");
            if (chEl && chEl.textContent.trim()) {
              platformHint = `Channel: ${chEl.textContent.trim()}`;
            }
          }

          let excerpt = "";
          const container = document.querySelector("article, main, [role='main']") || document.body;
          if (container) {
            const paragraphs = container.querySelectorAll("p");
            for (let i = 0; i < Math.min(paragraphs.length, 8); i++) {
              const p = paragraphs[i];
              if (p.closest("nav, header, footer, aside")) continue;
              const txt = p.textContent.trim().replace(/\s+/g, " ");
              if (txt.length >= 25) {
                excerpt = txt.slice(0, 220);
                break;
              }
            }
          }

          if (!siteName && !description && !h1 && !platformHint && !excerpt && !keywords) {
            return null;
          }
          return { siteName, description, keywords, schemaType, h1, h2s, breadcrumbs, platformHint, excerpt };
        } catch (err) {
          return null;
        }
      }
    })
    .then(results => (results && results[0] && results[0].result ? results[0].result : null))
    .catch(() => null);

  return Promise.race([scriptPromise, timeoutPromise]);
}

// ---------------- 分类管线与重复编辑模式 ---------------- //

function enterDuplicateEditMode(bm, rules = []) {
  document.getElementById("saveTabLabel").textContent = t("pop_tab_saved");
  document.getElementById("btnSave").textContent = t("pop_btn_update");
  document.getElementById("countdownLabel").textContent = t("pop_hint_edit_mode");
  setBadge("saved", t("pop_badge_saved"));

  document.getElementById("inputTitle").value = bm.title;
  setSelectedFolder(bm.parentId, false);

  // 重复状态下若同样命中本地规则，一并提示规则归属信息
  const matchedRule = MarkFlowEngine.matchRuleEngine(currentTab.url, rules);
  const reasonEl = document.getElementById("folderMatchedReason");
  reasonEl.textContent = matchedRule
    ? t("pop_reason_rule_hit", { name: matchedRule.name })
    : t("pop_reason_current");

  const banner = document.getElementById("duplicateBanner");
  document.getElementById("dupFolderLabel").textContent = bm.folderBreadcrumb;
  banner.classList.remove("hidden");
}

async function runSingleAiTitlePolish() {
  if (!isAiConfigured() || !currentTab) return;
  const btn = document.getElementById("btnAiTitlePolish");
  const titleInput = document.getElementById("inputTitle");
  stopCountdown();

  btn.disabled = true;
  titleInput.classList.add("is-shimmering");
  setBadge("ai", t("pop_badge_ai_naming"));

  try {
    const folder = treeAnalysis && treeAnalysis.folderMap.get(String(selectedFolderId));
    let localClean = currentTab.title || titleInput.value;
    if (preferences.stripSuffixes) localClean = MarkFlowEngine.cleanTitleLocally(localClean);
    if (preferences.panguSpacing !== false) localClean = MarkFlowEngine.addPanguSpacing(localClean);

    const polished = await MarkFlowEngine.generateCleanTitleOnly({
      url: currentTab.url,
      rawTitle: currentTab.title,
      localCleanTitle: localClean,
      pageContext: cachedPageContext,
      targetFolderName: folder ? folder.breadcrumb : "",
      aiConfig,
      preferences,
      usePangu: preferences.panguSpacing !== false
    });

    if (polished) {
      titleInput.value = polished;
      userEditedTitle = false;
    }
    setBadge("ai", t("pop_badge_rule_ai"));
  } catch (err) {
    console.warn("AI title polish failed:", err);
    showPopupError(err.message || "AI request failed");
    setBadge("idle", t("pop_badge_ready"));
  } finally {
    btn.disabled = false;
    titleInput.classList.remove("is-shimmering");
  }
}

async function runClassificationPipeline(localCleanTitle, rules = [], forceAI = false) {
  const reasonEl = document.getElementById("folderMatchedReason");
  const onboardingEl = document.getElementById("aiOnboardingStrip");
  const titleInput = document.getElementById("inputTitle");
  if (onboardingEl) onboardingEl.classList.add("hidden");

  const aiReady = isAiConfigured();

  // 第一阶段：本地规则匹配（用户点击“AI 重整”时跳过）
  if (!forceAI) {
    const matchedRule = MarkFlowEngine.matchRuleEngine(currentTab.url, rules);
    if (matchedRule) {
      const targetFolder = MarkFlowEngine.findFolderByRule(matchedRule, treeAnalysis.folders);
      if (targetFolder) {
        setSelectedFolder(targetFolder.id, false);
      }
      reasonEl.textContent = t("pop_reason_rule_hit", { name: matchedRule.name });

      if (preferences.ruleMatchUseAiTitle && aiReady) {
        setBadge("ai", t("pop_badge_ai_naming"));
        titleInput.classList.add("is-shimmering");
        try {
          const polished = await MarkFlowEngine.generateCleanTitleOnly({
            url: currentTab.url,
            rawTitle: currentTab.title,
            localCleanTitle,
            pageContext: cachedPageContext,
            targetFolderName: targetFolder ? targetFolder.breadcrumb : "",
            aiConfig,
            preferences,
            usePangu: preferences.panguSpacing !== false
          });
          if (polished && !userEditedTitle) {
            titleInput.value = polished;
          }
          setBadge("ai", t("pop_badge_rule_ai"));
        } catch (err) {
          console.warn("Rule-match AI title naming fallback:", err);
          setBadge("rule", t("pop_badge_rule"));
        } finally {
          titleInput.classList.remove("is-shimmering");
        }
      } else {
        setBadge("rule", t("pop_badge_rule"));
      }

      if (!existingBookmark && currentMode === "save" && !comboOpen) {
        startCountdown(preferences.autoSaveCountdown);
      }
      return;
    }
  }

  // 第二阶段：同站历史归属预锚定
  const domainAffinity = MarkFlowEngine.computeDomainAffinity(
    currentTab.url,
    treeAnalysis,
    domainMemory
  );
  if (domainAffinity && !userChangedFolder && !existingBookmark) {
    setSelectedFolder(domainAffinity.folderId, false);
    reasonEl.textContent = `${t("pop_badge_domain")}: ${domainAffinity.reason}`;
  }

  // 第三阶段：AI 语义分类
  const activeCfg = MarkFlowEngine.resolveActiveProviderConfig(aiConfig);
  if (aiReady) {
    setBadge("ai", t("pop_badge_ai_loading"));
    reasonEl.textContent = cachedPageContext ? t("pop_reason_ai_deep") : t("pop_reason_ai_calling");
    titleInput.classList.add("is-shimmering");

    try {
      const result = await MarkFlowEngine.classifySinglePage({
        url: currentTab.url,
        rawTitle: currentTab.title,
        localCleanTitle,
        pageContext: cachedPageContext,
        treeAnalysis,
        domainAffinity,
        aiConfig,
        preferences,
        usePangu: preferences.panguSpacing !== false
      });

      if (result.title && (!userEditedTitle || forceAI)) {
        titleInput.value = result.title;
      }

      if (result.folderId && (!userChangedFolder || forceAI)) {
        aiRecommendedFolderId = result.folderId;
        setSelectedFolder(result.folderId, false);
        reasonEl.textContent = result.reason || t("pop_reason_ai_matched");
      }

      const providerNames = {
        siliconflow: "SiliconFlow",
        gemini: "Gemini",
        deepseek: "DeepSeek",
        openai: "OpenAI",
        ollama: "Ollama"
      };
      const shortProvider = providerNames[activeCfg.provider] || "AI";
      setBadge("ai", t("pop_badge_ai_done", { provider: shortProvider }));

      renderCandidatePills(result.alternativeFolders || []);

      if (result.suggestedSubfolder) {
        showSubfolderSuggestion(result.suggestedSubfolder, selectedFolderId);
      } else {
        hideSubfolderSuggestion();
      }

      if (!existingBookmark && currentMode === "save" && !comboOpen) {
        startCountdown(preferences.autoSaveCountdown);
      }
    } catch (err) {
      console.warn("AI classification fallback:", err);
      if (domainAffinity) {
        setBadge("rule", t("pop_badge_domain"));
        reasonEl.textContent = domainAffinity.reason;
      } else {
        setBadge("idle", t("pop_badge_default"));
        reasonEl.textContent = t("pop_reason_ai_fallback");
      }
      if (!existingBookmark) startCountdown(preferences.autoSaveCountdown);
    } finally {
      titleInput.classList.remove("is-shimmering");
    }
  } else {
    if (onboardingEl && !existingBookmark) {
      onboardingEl.classList.remove("hidden");
    }
    if (domainAffinity) {
      setBadge("rule", t("pop_badge_domain"));
      reasonEl.textContent = domainAffinity.reason;
    } else {
      setBadge("idle", t("pop_badge_default"));
      reasonEl.textContent = forceAI ? t("pop_reason_ai_need_setup") : t("pop_reason_ai_unconfigured");
    }
    if (!existingBookmark) startCountdown(preferences.autoSaveCountdown);
  }
}

function setBadge(type, text) {
  const badgeEl = document.getElementById("engineBadge");
  const badgeText = document.getElementById("engineBadgeText");
  badgeEl.className = `badge badge-${type}`;
  badgeText.textContent = text;
}

// ---------------- 可搜索目录选择器与备选胶囊 ---------------- //

function setSelectedFolder(folderId, isManualUserAction = false) {
  const folder = treeAnalysis && treeAnalysis.folderMap.get(String(folderId));
  if (!folder) return;

  selectedFolderId = folder.id;
  document.getElementById("selectedFolderText").textContent = folder.breadcrumb;
  const dotEl = document.getElementById("selectedFolderDot");
  if (dotEl) {
    dotEl.style.background = MarkFlowEngine.getFolderAccentColor(folder.topL1Id || folder.id);
  }

  if (isManualUserAction) {
    userChangedFolder = true;
    stopCountdown();
    hideSubfolderSuggestion();
    document.getElementById("folderMatchedReason").textContent = t("pop_reason_manual");
    document.querySelectorAll(".alt-pill").forEach(btn => {
      btn.classList.toggle("active", btn.getAttribute("data-fid") === folder.id);
    });
  }
}

function toggleCombobox(forceState) {
  const dropdown = document.getElementById("folderComboDropdown");
  const trigger = document.getElementById("folderComboTrigger");
  const searchInput = document.getElementById("folderSearchInput");

  comboOpen = typeof forceState === "boolean" ? forceState : !comboOpen;
  trigger.setAttribute("aria-expanded", comboOpen ? "true" : "false");

  if (comboOpen) {
    stopCountdown();
    dropdown.classList.remove("hidden");
    searchInput.value = "";
    renderComboOptions("");
    setTimeout(() => searchInput.focus(), 10);
  } else {
    dropdown.classList.add("hidden");
  }
}

function renderComboOptions(filterQuery) {
  const listEl = document.getElementById("folderOptionsList");
  listEl.innerHTML = "";

  const q = (filterQuery || "").trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  filteredComboFolders = treeAnalysis.folders.filter(f => {
    if (f.id === "2" && f.directBookmarkCount === 0 && !q) return false;
    if (!tokens.length) return true;
    return tokens.every(tk => f.searchKey.includes(tk));
  });

  if (filteredComboFolders.length === 0) {
    listEl.innerHTML = `<div class="launcher-empty" style="padding:14px;">${MarkFlowEngine.escapeHtml(
      t("pop_folder_no_match")
    )}</div>`;
    comboHighlightIdx = -1;
    return;
  }

  const currentIdx = filteredComboFolders.findIndex(f => f.id === selectedFolderId);
  comboHighlightIdx = currentIdx >= 0 ? currentIdx : 0;

  filteredComboFolders.forEach((f, idx) => {
    const row = document.createElement("div");
    row.className =
      "combo-option" +
      (f.id === selectedFolderId ? " is-selected" : "") +
      (idx === comboHighlightIdx ? " is-highlighted" : "");
    row.setAttribute("role", "option");

    const mainWrap = document.createElement("div");
    mainWrap.className = "combo-opt-main";

    const dot = document.createElement("span");
    dot.className = "cat-dot";
    dot.style.background = MarkFlowEngine.getFolderAccentColor(f.topL1Id || f.id);

    const labelSpan = document.createElement("span");
    labelSpan.className = "combo-opt-label";
    labelSpan.textContent = q ? f.breadcrumb : f.displayText;

    mainWrap.appendChild(dot);
    mainWrap.appendChild(labelSpan);
    row.appendChild(mainWrap);

    if (f.directBookmarkCount > 0) {
      const countSpan = document.createElement("span");
      countSpan.className = "combo-opt-count";
      countSpan.textContent = String(f.directBookmarkCount);
      row.appendChild(countSpan);
    }

    row.addEventListener("click", () => {
      setSelectedFolder(f.id, true);
      toggleCombobox(false);
    });

    listEl.appendChild(row);
  });

  scrollComboHighlightedIntoView();
}

function updateComboHighlight(delta) {
  if (!filteredComboFolders.length) return;
  comboHighlightIdx =
    (comboHighlightIdx + delta + filteredComboFolders.length) % filteredComboFolders.length;
  const rows = document.querySelectorAll("#folderOptionsList .combo-option");
  rows.forEach((r, i) => r.classList.toggle("is-highlighted", i === comboHighlightIdx));
  scrollComboHighlightedIntoView();
}

function scrollComboHighlightedIntoView() {
  const active = document.querySelector("#folderOptionsList .combo-option.is-highlighted");
  if (active) active.scrollIntoView({ block: "nearest" });
}

function renderCandidatePills(altFolders) {
  const row = document.getElementById("candidatePillsRow");
  const list = document.getElementById("candidatePillsList");
  list.innerHTML = "";

  if (!altFolders || altFolders.length === 0) {
    row.classList.add("hidden");
    return;
  }

  const primaryFolder = treeAnalysis.folderMap.get(String(aiRecommendedFolderId));
  const pillsData = primaryFolder ? [primaryFolder, ...altFolders] : altFolders;

  pillsData.slice(0, 3).forEach(folder => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "alt-pill" + (folder.id === selectedFolderId ? " active" : "");
    btn.setAttribute("data-fid", folder.id);
    btn.title = folder.breadcrumb;
    btn.textContent = folder.title;
    btn.addEventListener("click", () => {
      setSelectedFolder(folder.id, folder.id !== aiRecommendedFolderId);
      document.querySelectorAll(".alt-pill").forEach(b => {
        b.classList.toggle("active", b.getAttribute("data-fid") === folder.id);
      });
    });
    list.appendChild(btn);
  });

  row.classList.remove("hidden");
}

// ---------------- 子目录新建建议 ---------------- //

function showSubfolderSuggestion(subfolderName, parentFolderId) {
  if (!subfolderName) return;
  const box = document.getElementById("subfolderSuggestionBox");
  const nameEl = document.getElementById("suggestedSubfolderName");
  const btnAccept = document.getElementById("btnAcceptSubfolder");

  pendingNewSubfolder = null;
  nameEl.textContent = subfolderName;
  btnAccept.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg><span>${MarkFlowEngine.escapeHtml(
    t("pop_btn_accept_sub")
  )}</span>`;
  btnAccept.style.background = "var(--accent-primary)";
  box.classList.remove("hidden");

  btnAccept.onclick = () => {
    pendingNewSubfolder = { parentId: String(parentFolderId), name: subfolderName };
    btnAccept.innerHTML = `<span>✓ ${MarkFlowEngine.escapeHtml(t("pop_btn_accepted_sub"))}</span>`;
    btnAccept.style.background = "var(--success-color)";
    document.getElementById("folderMatchedReason").textContent = t("pop_reason_will_create_sub", {
      name: subfolderName
    });
    stopCountdown();
  };
}

function hideSubfolderSuggestion() {
  pendingNewSubfolder = null;
  document.getElementById("subfolderSuggestionBox").classList.add("hidden");
}

// ---------------- 保存、更新、删除与邻近插入 ---------------- //

async function saveBookmark() {
  stopCountdown();
  if (!currentTab || isBlankOrUtilityTab(currentTab.url)) return;

  const title =
    document.getElementById("inputTitle").value.trim() || currentTab.title || currentTab.url;
  let parentId = selectedFolderId || "1";
  const url = currentTab.url;

  try {
    let savedFolderName = t("pop_default_bar_name");
    let createdFolderId = null;

    if (pendingNewSubfolder && String(pendingNewSubfolder.parentId) === String(parentId)) {
      const createdFolder = await chrome.bookmarks.create({
        parentId: String(parentId),
        title: pendingNewSubfolder.name
      });
      parentId = createdFolder.id;
      createdFolderId = createdFolder.id;
      savedFolderName = pendingNewSubfolder.name;
    } else {
      const f = treeAnalysis.folderMap.get(String(parentId));
      if (f) savedFolderName = f.breadcrumb;
    }

    await persistDomainFeedbackIfApplicable(url, parentId);

    if (existingBookmark) {
      undoState = {
        type: "update",
        bookmarkId: existingBookmark.id,
        prevTitle: existingBookmark.title,
        prevParentId: existingBookmark.parentId,
        createdFolderId
      };
      if (title !== existingBookmark.title) {
        await chrome.bookmarks.update(existingBookmark.id, { title });
      }
      if (String(parentId) !== String(existingBookmark.parentId)) {
        const siblings = await chrome.bookmarks.getChildren(String(parentId));
        const insertIndex = MarkFlowEngine.computeSmartInsertionIndex(url, title, siblings);
        const movePayload = { parentId: String(parentId) };
        if (typeof insertIndex === "number" && insertIndex >= 0 && insertIndex <= siblings.length) {
          movePayload.index = insertIndex;
        }
        await chrome.bookmarks.move(existingBookmark.id, movePayload);
      }
      showSuccessOverlay(
        t("pop_success_updated"),
        t("pop_success_updated_desc", { folder: savedFolderName })
      );
    } else {
      // 新增书签时优先插入至同站点或同功能书签紧邻位置
      const siblings = await chrome.bookmarks.getChildren(String(parentId));
      const insertIndex = MarkFlowEngine.computeSmartInsertionIndex(url, title, siblings);
      const createPayload = { parentId: String(parentId), title, url };
      if (typeof insertIndex === "number" && insertIndex >= 0 && insertIndex <= siblings.length) {
        createPayload.index = insertIndex;
      }
      const created = await chrome.bookmarks.create(createPayload);
      undoState = {
        type: "create",
        bookmarkId: created.id,
        createdFolderId
      };
      showSuccessOverlay(
        t("pop_success_saved"),
        t("pop_success_saved_desc", { folder: savedFolderName })
      );
    }
  } catch (err) {
    console.error("Failed to save bookmark:", err);
    showPopupError(t("pop_err_save", { msg: err.message }));
  }
}

async function deleteExistingBookmark() {
  if (!existingBookmark) return;
  stopCountdown();
  try {
    undoState = {
      type: "delete",
      prevTitle: existingBookmark.title,
      prevUrl: existingBookmark.url,
      prevParentId: existingBookmark.parentId
    };
    await chrome.bookmarks.remove(existingBookmark.id);
    showSuccessOverlay(
      t("pop_success_removed"),
      t("pop_success_removed_desc", { folder: existingBookmark.folderBreadcrumb })
    );
  } catch (err) {
    showPopupError(t("pop_err_remove", { msg: err.message }));
  }
}

async function persistDomainFeedbackIfApplicable(url, chosenFolderId) {
  const uInfo = MarkFlowEngine.parseUrlInfo(url);
  if (!uInfo.valid || uInfo.isMultiTopic || chosenFolderId === "1" || chosenFolderId === "2") {
    return;
  }
  if (userChangedFolder || String(chosenFolderId) !== String(aiRecommendedFolderId)) {
    const key = uInfo.isIpOrLocal ? uInfo.hostKey : uInfo.hostname;
    domainMemory[key] = String(chosenFolderId);

    const keys = Object.keys(domainMemory);
    if (keys.length > 300) {
      delete domainMemory[keys[0]];
    }
    await chrome.storage.local.set({ domainMemory });
  }
}

function showSuccessOverlay(titleText, descText) {
  document.getElementById("successTitle").textContent = titleText;
  document.getElementById("successDesc").textContent = descText;
  document.getElementById("successOverlay").classList.remove("hidden");
  setTimeout(() => window.close(), 1050);
}

// ---------------- 极速书签检索启动器 ---------------- //

function switchMode(targetMode) {
  currentMode = targetMode;
  const isSave = targetMode === "save";

  document.getElementById("tabBtnSave").classList.toggle("active", isSave);
  document.getElementById("tabBtnSave").setAttribute("aria-selected", String(isSave));
  document.getElementById("tabBtnSearch").classList.toggle("active", !isSave);
  document.getElementById("tabBtnSearch").setAttribute("aria-selected", String(!isSave));

  document.getElementById("viewSave").classList.toggle("hidden", !isSave);
  document.getElementById("viewSearch").classList.toggle("hidden", isSave);

  if (!isSave) {
    stopCountdown();
    toggleCombobox(false);
    const searchInput = document.getElementById("bookmarkSearchInput");
    setTimeout(() => {
      searchInput.focus();
      searchInput.select();
    }, 15);
  } else {
    setTimeout(() => document.getElementById("inputTitle").focus(), 15);
  }
}

function renderSearchLauncher(rawQuery) {
  const listEl = document.getElementById("searchResultsList");
  const sectionLabel = document.getElementById("searchSectionLabel");
  listEl.innerHTML = "";

  if (!treeAnalysis) return;
  const q = (rawQuery || "").trim().toLowerCase();
  const tokens = q ? q.split(/\s+/).filter(Boolean) : [];

  if (!tokens.length) {
    sectionLabel.textContent = t("pop_search_recent");
    searchMatches = [...treeAnalysis.bookmarks]
      .sort((a, b) => b.dateAdded - a.dateAdded)
      .slice(0, 20);
  } else {
    const scored = [];
    for (const bm of treeAnalysis.bookmarks) {
      const titleLower = bm.title.toLowerCase();
      const folderLower = bm.folderBreadcrumb.toLowerCase();
      const hostLower = (bm.hostKey || bm.hostname || bm.url).toLowerCase();
      const haystack = `${titleLower} ${folderLower} ${hostLower}`;

      if (!tokens.every(tk => haystack.includes(tk))) continue;

      let score = 0;
      for (const tk of tokens) {
        if (titleLower.startsWith(tk)) score += 35;
        else if (titleLower.includes(tk)) score += 20;
        if (hostLower.includes(tk)) score += 14;
        if (folderLower.includes(tk)) score += 10;
      }
      scored.push({ bm, score });
    }
    scored.sort((a, b) => b.score - a.score || b.bm.dateAdded - a.bm.dateAdded);
    searchMatches = scored.slice(0, 35).map(s => s.bm);
    sectionLabel.textContent = t("pop_search_matches", { count: scored.length });
  }

  if (searchMatches.length === 0) {
    searchActiveIdx = -1;
    listEl.innerHTML = `<div class="launcher-empty">${MarkFlowEngine.escapeHtml(
      t("pop_search_empty")
    )}</div>`;
    return;
  }

  searchActiveIdx = 0;

  searchMatches.forEach((bm, idx) => {
    const item = document.createElement("div");
    item.className = "search-item" + (idx === 0 ? " is-active" : "");
    item.setAttribute("role", "option");

    const mono = document.createElement("div");
    mono.className = "item-monogram";
    mono.textContent = getMonogramChar(bm.hostname || bm.title);

    const main = document.createElement("div");
    main.className = "item-main";

    const titleEl = document.createElement("div");
    titleEl.className = "item-title";
    titleEl.innerHTML = highlightTokens(bm.title, tokens);

    const subEl = document.createElement("div");
    subEl.className = "item-sub";
    subEl.innerHTML = `<span class="item-folder-badge">${highlightTokens(
      bm.folderBreadcrumb,
      tokens
    )}</span><span class="item-domain">${MarkFlowEngine.escapeHtml(bm.hostKey || bm.hostname)}</span>`;

    main.appendChild(titleEl);
    main.appendChild(subEl);

    const hint = document.createElement("span");
    hint.className = "item-enter-hint";
    hint.textContent = "↵";

    item.appendChild(mono);
    item.appendChild(main);
    item.appendChild(hint);

    item.addEventListener("mouseenter", () => setSearchActiveIndex(idx, false));
    item.addEventListener("click", e => {
      openLauncherBookmark(bm, e.ctrlKey || e.metaKey || e.button === 1);
    });

    listEl.appendChild(item);
  });
}

function setSearchActiveIndex(nextIdx, scroll = true) {
  if (!searchMatches.length) return;
  searchActiveIdx = (nextIdx + searchMatches.length) % searchMatches.length;
  const rows = document.querySelectorAll("#searchResultsList .search-item");
  rows.forEach((r, i) => r.classList.toggle("is-active", i === searchActiveIdx));
  if (scroll && rows[searchActiveIdx]) {
    rows[searchActiveIdx].scrollIntoView({ block: "nearest" });
  }
}

function openLauncherBookmark(bm, inBackground = false) {
  if (!bm || !bm.url) return;
  if (inBackground) {
    chrome.tabs.create({ url: bm.url, active: false });
    setBadge("saved", t("pop_badge_bg_opened"));
    return;
  }
  if (currentTab && isBlankOrUtilityTab(currentTab.url)) {
    chrome.tabs.update(currentTab.id, { url: bm.url });
  } else {
    chrome.tabs.create({ url: bm.url, active: true });
  }
  window.close();
}

function getMonogramChar(str) {
  if (!str) return "M";
  const cleaned = str.replace(/^(https?:\/\/)?(www\.)?/i, "").trim();
  return cleaned.charAt(0) || "B";
}

function highlightTokens(text, tokens) {
  const safe = MarkFlowEngine.escapeHtml(text || "");
  if (!tokens || !tokens.length) return safe;
  const escapedTokens = tokens
    .map(tk => tk.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .filter(Boolean);
  if (!escapedTokens.length) return safe;
  const regex = new RegExp(`(${escapedTokens.join("|")})`, "gi");
  return safe.replace(regex, "<mark>$1</mark>");
}

// ---------------- 自动保存倒计时 ---------------- //

function startCountdown(seconds) {
  stopCountdown();
  if (!seconds || seconds <= 0 || currentMode !== "save") {
    document.getElementById("countdownContainer").style.display = "none";
    if (!existingBookmark) {
      document.getElementById("countdownLabel").textContent = t("pop_hint_enter_save");
    }
    return;
  }

  const container = document.getElementById("countdownContainer");
  const bar = document.getElementById("countdownBar");
  const label = document.getElementById("countdownLabel");

  container.style.display = "block";
  bar.style.transition = "none";
  bar.style.transform = "scaleX(1)";
  requestAnimationFrame(() => {
    bar.style.transition = `transform ${seconds}s linear`;
    bar.style.transform = "scaleX(0)";
  });

  let remaining = seconds;
  label.textContent = t("pop_hint_countdown", { sec: remaining });

  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining > 0) {
      label.textContent = t("pop_hint_countdown", { sec: remaining });
    } else {
      clearInterval(countdownTimer);
      countdownTimer = null;
      saveBookmark();
    }
  }, 1000);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
  const bar = document.getElementById("countdownBar");
  if (bar) bar.style.transition = "none";
  document.getElementById("countdownContainer").style.display = "none";
  if (!existingBookmark) {
    document.getElementById("countdownLabel").textContent = t("pop_hint_enter_save");
  }
}

// ---------------- 交互事件与全局快捷键 ---------------- //

function bindEvents() {
  document.getElementById("tabBtnSave").addEventListener("click", () => {
    if (!isBlankOrUtilityTab(currentTab && currentTab.url)) {
      switchMode("save");
    }
  });
  document.getElementById("tabBtnSearch").addEventListener("click", () => switchMode("search"));

  document.getElementById("btnSave").addEventListener("click", saveBookmark);
  document.getElementById("btnCancel").addEventListener("click", () => {
    stopCountdown();
    window.close();
  });
  document.getElementById("btnOptions").addEventListener("click", () => {
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options/options.html"));
    }
  });

  const btnGoSetupAI = document.getElementById("btnGoSetupAI");
  if (btnGoSetupAI) {
    btnGoSetupAI.addEventListener("click", () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#tab-ai") });
      window.close();
    });
  }

  const btnAiTitlePolish = document.getElementById("btnAiTitlePolish");
  if (btnAiTitlePolish) {
    btnAiTitlePolish.addEventListener("click", runSingleAiTitlePolish);
  }

  document.getElementById("btnDeleteExisting").addEventListener("click", deleteExistingBookmark);
  document.getElementById("btnReanalyzeAI").addEventListener("click", () => {
    const rawClean = MarkFlowEngine.cleanTitleLocally(currentTab.title || "");
    runClassificationPipeline(rawClean, [], true);
  });

  document.getElementById("btnUndo").addEventListener("click", async () => {
    if (!undoState) return;
    try {
      if (undoState.type === "create") {
        await chrome.bookmarks.remove(undoState.bookmarkId);
        if (undoState.createdFolderId) {
          await chrome.bookmarks.remove(undoState.createdFolderId).catch(() => {});
        }
      } else if (undoState.type === "update") {
        await chrome.bookmarks.update(undoState.bookmarkId, { title: undoState.prevTitle });
        await chrome.bookmarks.move(undoState.bookmarkId, { parentId: undoState.prevParentId });
        if (undoState.createdFolderId) {
          await chrome.bookmarks.remove(undoState.createdFolderId).catch(() => {});
        }
      } else if (undoState.type === "delete") {
        await chrome.bookmarks.create({
          parentId: undoState.prevParentId,
          title: undoState.prevTitle,
          url: undoState.prevUrl
        });
      }
      document.getElementById("successDesc").textContent = t("pop_success_undone");
      setTimeout(() => window.close(), 450);
    } catch (e) {
      window.close();
    }
  });

  document.getElementById("inputTitle").addEventListener("input", () => {
    userEditedTitle = true;
    stopCountdown();
  });

  document.getElementById("folderComboTrigger").addEventListener("click", () => toggleCombobox());
  document.getElementById("folderSearchInput").addEventListener("input", e => {
    renderComboOptions(e.target.value);
  });

  document.getElementById("bookmarkSearchInput").addEventListener("input", e => {
    renderSearchLauncher(e.target.value);
  });

  document.addEventListener("click", e => {
    if (comboOpen && !document.getElementById("folderCombobox").contains(e.target)) {
      toggleCombobox(false);
    }
  });

  window.addEventListener("keydown", e => {
    if (e.isComposing) return;

    if (e.key === "Tab" && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (comboOpen) {
        e.preventDefault();
        toggleCombobox(false);
        return;
      }
      if (!isBlankOrUtilityTab(currentTab && currentTab.url)) {
        e.preventDefault();
        switchMode(currentMode === "save" ? "search" : "save");
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      switchMode("search");
      return;
    }

    if (currentMode === "save") {
      if (comboOpen) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          updateComboHighlight(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          updateComboHighlight(-1);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (comboHighlightIdx >= 0 && filteredComboFolders[comboHighlightIdx]) {
            setSelectedFolder(filteredComboFolders[comboHighlightIdx].id, true);
            toggleCombobox(false);
          }
        } else if (e.key === "Escape") {
          e.preventDefault();
          toggleCombobox(false);
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        saveBookmark();
      } else if (e.key === "Escape") {
        window.close();
      }
      return;
    }

    if (currentMode === "search") {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSearchActiveIndex(searchActiveIdx + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSearchActiveIndex(searchActiveIdx - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (searchActiveIdx >= 0 && searchMatches[searchActiveIdx]) {
          openLauncherBookmark(searchMatches[searchActiveIdx], e.ctrlKey || e.metaKey);
        }
      } else if (e.key === "Escape") {
        const inp = document.getElementById("bookmarkSearchInput");
        if (inp.value) {
          e.preventDefault();
          inp.value = "";
          renderSearchLauncher("");
        } else {
          window.close();
        }
      }
    }
  });
}
