/**
 * 书签树分析与历史归属推断模块
 *
 * 负责将 Chrome 原生书签树扁平化为结构化目录画像与书签索引，
 * 并提供精确查重及垂直站点历史归属计算。
 */

(function (global) {
  "use strict";

  const { MULTI_TOPIC_DOMAINS } = global.MarkFlowModules.constants;
  const {
    parseUrlInfo,
    normalizeBookmarkUrl,
    cleanTitleLocally,
    hasLeadingEmoji
  } = global.MarkFlowModules.utils;

  /**
   * 遍历 Chrome 书签树，构建目录层级列表、样本摘要、命名风格画像与站点分布统计。
   * @param {Array} tree chrome.bookmarks.getTree() 返回的根节点数组
   * @returns {Object} 包含 folders、folderMap、bookmarks、hostFolderCounts 等结构化信息
   */
  function analyzeBookmarkTree(tree) {
    const folders = [];
    const bookmarks = [];
    const folderMap = new Map();
    const hostFolderCounts = new Map();
    const ipHostFolderCounts = new Map();

    function recordDomainFolder(urlInfo, folderId) {
      if (!urlInfo.valid || !folderId || urlInfo.isMultiTopic) return;

      if (!hostFolderCounts.has(urlInfo.hostKey)) {
        hostFolderCounts.set(urlInfo.hostKey, new Map());
      }
      const exactMap = hostFolderCounts.get(urlInfo.hostKey);
      exactMap.set(folderId, (exactMap.get(folderId) || 0) + 1);

      const secondaryKey = urlInfo.isIpOrLocal ? urlInfo.hostname : urlInfo.baseDomain;
      if (secondaryKey && !MULTI_TOPIC_DOMAINS.has(secondaryKey)) {
        if (!ipHostFolderCounts.has(secondaryKey)) {
          ipHostFolderCounts.set(secondaryKey, new Map());
        }
        const secMap = ipHostFolderCounts.get(secondaryKey);
        secMap.set(folderId, (secMap.get(folderId) || 0) + 1);
      }
    }

    function walk(nodes, parentPrefix = "", depth = 0, breadcrumbParts = [], topL1Id = "") {
      if (!nodes || !nodes.length) return;

      const folderSiblings = nodes.filter(n => n.url === undefined);

      for (const node of nodes) {
        if (node.url !== undefined) {
          const uInfo = parseUrlInfo(node.url);
          const parentFolder = folderMap.get(String(node.parentId));
          const cleanSampleTitle = cleanTitleLocally(node.title || "").slice(0, 26);

          bookmarks.push({
            id: String(node.id),
            title: node.title || uInfo.hostname || "Untitled",
            url: node.url,
            normalizedUrl: uInfo.normalizedUrl,
            hostname: uInfo.hostname,
            hostKey: uInfo.hostKey,
            parentId: String(node.parentId || ""),
            topL1Id: topL1Id || "",
            folderTitle: parentFolder ? parentFolder.title : "Bookmarks Bar",
            folderBreadcrumb: parentFolder ? parentFolder.breadcrumb : "Bookmarks Bar",
            dateAdded: Number(node.dateAdded || 0)
          });

          if (parentFolder) {
            parentFolder.directBookmarkCount++;
            if (parentFolder.samples.length < 4 && cleanSampleTitle) {
              const sampleLabel = uInfo.hostname
                ? `${cleanSampleTitle} [${uInfo.isIpOrLocal ? uInfo.hostKey : uInfo.hostname}]`
                : cleanSampleTitle;
              if (!parentFolder.samples.includes(sampleLabel)) {
                parentFolder.samples.push(sampleLabel);
              }
            }
          }

          recordDomainFolder(uInfo, String(node.parentId || ""));
          continue;
        }

        // 跳过 Chrome 虚拟根节点（id === "0"）
        if (node.id === "0") {
          if (node.children) walk(node.children, "", 1, [], "");
          continue;
        }

        const folderIndex = folderSiblings.indexOf(node);
        const isLastSibling = folderIndex === folderSiblings.length - 1;
        const title =
          node.title ||
          (node.id === "1" ? "书签栏" : node.id === "2" ? "其他书签" : "移动设备书签");

        let prefix = "";
        let nextPrefix = parentPrefix;
        if (depth === 1) {
          prefix = "";
          nextPrefix = "";
        } else if (depth === 2) {
          prefix = isLastSibling ? "└── " : "├── ";
          nextPrefix = isLastSibling ? "    " : "│   ";
        } else {
          prefix = parentPrefix + (isLastSibling ? "└── " : "├── ");
          nextPrefix = parentPrefix + (isLastSibling ? "    " : "│   ");
        }

        const nextBreadcrumbParts = depth === 1 ? [title] : [...breadcrumbParts, title];
        const cleanBreadcrumb =
          depth >= 2 && nextBreadcrumbParts.length > 1
            ? nextBreadcrumbParts.slice(1).join(" › ")
            : title;
        const currentL1Id = depth === 2 ? String(node.id) : topL1Id;

        const folderObj = {
          id: String(node.id),
          title,
          displayText: prefix ? `${prefix}${title}` : title,
          breadcrumb: cleanBreadcrumb,
          depth,
          parentId: String(node.parentId || ""),
          topL1Id: currentL1Id,
          directBookmarkCount: 0,
          samples: [],
          searchKey: `${title} ${cleanBreadcrumb}`.toLowerCase()
        };

        folders.push(folderObj);
        folderMap.set(String(node.id), folderObj);

        if (node.children && node.children.length > 0) {
          walk(node.children, nextPrefix, depth + 1, nextBreadcrumbParts, currentL1Id);
        }
      }
    }

    walk(tree, "", 0, [], "");

    const depth2 = folders.filter(f => f.depth === 2);
    const depth3 = folders.filter(f => f.depth === 3);
    const mainEmojiRatio =
      depth2.length > 0 ? depth2.filter(f => hasLeadingEmoji(f.title)).length / depth2.length : 0;
    const subEmojiRatio =
      depth3.length > 0 ? depth3.filter(f => hasLeadingEmoji(f.title)).length / depth3.length : 0;

    return {
      folders,
      folderMap,
      bookmarks,
      hostFolderCounts,
      ipHostFolderCounts,
      styleProfile: {
        mainUsesEmoji: mainEmojiRatio >= 0.5,
        subUsesEmoji: subEmojiRatio >= 0.5
      }
    };
  }

  /**
   * 在书签索引中检索与目标 URL 等价的已有书签。
   * @param {string} rawUrl 当前页面 URL
   * @param {Array} bookmarks 扁平书签列表
   * @returns {Array}
   */
  function findExistingBookmarks(rawUrl, bookmarks) {
    if (!rawUrl || !bookmarks || !bookmarks.length) return [];
    const targetNorm = normalizeBookmarkUrl(rawUrl);
    return bookmarks.filter(b => b.normalizedUrl === targetNorm || b.url === rawUrl);
  }

  /**
   * 基于用户手动修正记忆与同站点历史分布，计算垂直站点的推荐归属目录。
   * 多主题综合平台直接返回 null，避免按平台外壳误判。
   * @param {string} rawUrl 目标网页 URL
   * @param {Object} treeAnalysis 书签树分析结果
   * @param {Object} [domainMemory] 用户历史手动修正的站点目录映射
   * @returns {Object|null}
   */
  function computeDomainAffinity(rawUrl, treeAnalysis, domainMemory = {}) {
    const uInfo = parseUrlInfo(rawUrl);
    if (!uInfo.valid || uInfo.isMultiTopic || !treeAnalysis) return null;

    const { folderMap, hostFolderCounts, ipHostFolderCounts } = treeAnalysis;

    // 优先命中用户曾手动调整过的站点偏好记录
    const memFolderId =
      domainMemory &&
      (domainMemory[uInfo.hostKey] ||
        (uInfo.isIpOrLocal ? domainMemory[uInfo.hostname] : domainMemory[uInfo.baseDomain]));
    if (memFolderId && folderMap.has(String(memFolderId))) {
      const f = folderMap.get(String(memFolderId));
      if (f.id !== "2") {
        return {
          folderId: f.id,
          folderTitle: f.title,
          breadcrumb: f.breadcrumb,
          confidence: "exact_memory",
          reason: `${uInfo.hostKey}`
        };
      }
    }

    if (!hostFolderCounts || !ipHostFolderCounts) return null;

    // 统计同域名/同主机历史书签分布，仅在主目录占比 ≥ 70% 时采用
    const pickDominantFolder = (countsMap, label) => {
      if (!countsMap || countsMap.size === 0) return null;
      let total = 0;
      let bestId = null;
      let bestCount = 0;
      for (const [fid, cnt] of countsMap.entries()) {
        if (fid === "1" || fid === "2") continue;
        total += cnt;
        if (cnt > bestCount) {
          bestCount = cnt;
          bestId = fid;
        }
      }
      if (bestId && folderMap.has(bestId) && bestCount / total >= 0.7) {
        const f = folderMap.get(bestId);
        return {
          folderId: f.id,
          folderTitle: f.title,
          breadcrumb: f.breadcrumb,
          count: bestCount,
          confidence: bestCount >= 2 ? "high" : "medium",
          reason: `${label}`
        };
      }
      return null;
    };

    const exactHit = pickDominantFolder(hostFolderCounts.get(uInfo.hostKey), uInfo.hostKey);
    if (exactHit) return exactHit;

    const secondaryKey = uInfo.isIpOrLocal ? uInfo.hostname : uInfo.baseDomain;
    return pickDominantFolder(ipHostFolderCounts.get(secondaryKey), secondaryKey);
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.tree = {
    analyzeBookmarkTree,
    findExistingBookmarks,
    computeDomainAffinity
  };
})(typeof window !== "undefined" ? window : globalThis);
