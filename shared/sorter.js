/**
 * 目录内优先级排序与邻近插入模块
 *
 * 按照视觉扫视效率由高到低的三级规则对书签排序：
 * 1. 功能/用途聚簇（大聚簇优先，常规未分组项置后）
 * 2. 同站点 / 同局域网主机紧邻（子域名自然序，端口按数值升序）
 * 3. 自然标题序（兼容中英文与数字）
 */

(function (global) {
  "use strict";

  const { parseUrlInfo } = global.MarkFlowModules.utils;

  /**
   * 在零网络请求前提下，基于域名、路径与标题特征推断书签所属的轻量功能聚簇标签。
   * @param {string} url 书签地址
   * @param {string} title 书签标题
   * @returns {string}
   */
  function inferLocalFuncGroup(url, title) {
    const u = parseUrlInfo(url);
    const text = `${title || ""} ${u.hostname || ""} ${u.pathHint || ""}`.toLowerCase();

    if (/swagger|openapi|apidoc|graphql|redoc|postman|接口文档/.test(text)) return "接口文档";
    if (/admin|dashboard|console|manager|manage|panel|portainer|dsm|homeassistant|后台|管理|面板|控制台/.test(text)) {
      return "管理控制";
    }
    if (/login|signin|auth|sso|casdoor|vaultwarden|bitwarden|登录|认证|权限|密码/.test(text)) {
      return "账号认证";
    }
    if (/jellyfin|plex|emby|netflix|youtube|bilibili|vimeo|moontv|music|spotify|影音|视频|音乐|观影/.test(text)) {
      return "影音播放";
    }
    if (/jellyseerr|overseerr|sonarr|radarr|aria2|qbittorrent|transmission|pan\.|drive|nextcloud|cloud|选片|下载|网盘|云盘/.test(text)) {
      return "资源云盘";
    }
    if (/docs\.|developer\.|devdocs|mdn|wiki|guide|manual|tutorial|文档|教程|指南|手册/.test(text)) {
      return "文档参考";
    }
    if (/github\.com|gitlab\.com|gitee\.com|bitbucket|code\.|git\.|仓库|托管/.test(text)) {
      return "代码协作";
    }
    if (/chat|gpt|claude|gemini|deepseek|openai|siliconflow|ai\.|对话|模型|助手/.test(text)) {
      return "AI服务";
    }
    if (/shop|mall|store|wap|商城|官网|购物/.test(text)) return "业务门户";
    return "常规条目";
  }

  /**
   * 对同一目录下的书签数组执行多规则优先级排序。
   * 支持 5 种排序模式：
   * - smart: 功能聚簇 → 同站点/局域网端口紧邻 → 自然标题
   * - site: 同站点/局域网端口紧邻（大站优先）→ 自然标题
   * - title_asc: 标题自然序 A → Z（兼容中文与数字）
   * - newest: 最新收藏优先（按 dateAdded 降序）
   * - oldest: 最早收藏优先（按 dateAdded 升序）
   * @param {Array<Object>} items 书签项列表
   * @param {string} [sortRule="smart"] 排序规则标识
   * @returns {Array<Object>} 排序后的新数组
   */
  function sortFolderBookmarksByPriority(items, sortRule = "smart") {
    if (!Array.isArray(items) || items.length <= 1) return items || [];

    const rule = sortRule || "smart";
    const enriched = items.map((item, origIdx) => {
      const u = parseUrlInfo(item.url);
      const funcGroup =
        (item.funcGroup || "").trim() || inferLocalFuncGroup(item.url, item.cleanTitle || item.title);
      const siteClusterKey = u.valid
        ? u.isIpOrLocal
          ? `lan:${u.hostname}`
          : `dom:${u.baseDomain}`
        : "other";
      const portNum = u.port ? parseInt(u.port, 10) : 0;
      const titleKey = (item.cleanTitle || item.title || "").trim();
      const dateAdded = Number(item.dateAdded || 0);

      return {
        item,
        origIdx,
        funcGroup,
        siteClusterKey,
        hostname: u.hostname || "",
        portNum: Number.isFinite(portNum) ? portNum : 0,
        titleKey,
        dateAdded: Number.isFinite(dateAdded) ? dateAdded : 0
      };
    });

    const funcCounts = new Map();
    const siteCounts = new Map();
    for (const entry of enriched) {
      funcCounts.set(entry.funcGroup, (funcCounts.get(entry.funcGroup) || 0) + 1);
      siteCounts.set(entry.siteClusterKey, (siteCounts.get(entry.siteClusterKey) || 0) + 1);
    }

    const collator = new Intl.Collator(["zh-Hans-CN", "en"], {
      numeric: true,
      sensitivity: "base"
    });

    const compareBySiteAndTitle = (a, b) => {
      if (a.siteClusterKey !== b.siteClusterKey) {
        const scDiff =
          (siteCounts.get(b.siteClusterKey) || 0) - (siteCounts.get(a.siteClusterKey) || 0);
        if (scDiff !== 0) return scDiff;
        const skCmp = collator.compare(a.siteClusterKey, b.siteClusterKey);
        if (skCmp !== 0) return skCmp;
      }
      if (a.hostname !== b.hostname) {
        const hCmp = collator.compare(a.hostname, b.hostname);
        if (hCmp !== 0) return hCmp;
      }
      if (a.portNum !== b.portNum) {
        return a.portNum - b.portNum;
      }
      const tCmp = collator.compare(a.titleKey, b.titleKey);
      if (tCmp !== 0) return tCmp;
      return a.origIdx - b.origIdx;
    };

    enriched.sort((a, b) => {
      if (rule === "title_asc") {
        const tCmp = collator.compare(a.titleKey, b.titleKey);
        return tCmp !== 0 ? tCmp : a.origIdx - b.origIdx;
      }

      if (rule === "newest") {
        if (a.dateAdded !== b.dateAdded) return b.dateAdded - a.dateAdded;
        const tCmp = collator.compare(a.titleKey, b.titleKey);
        return tCmp !== 0 ? tCmp : a.origIdx - b.origIdx;
      }

      if (rule === "oldest") {
        if (a.dateAdded !== b.dateAdded) return a.dateAdded - b.dateAdded;
        const tCmp = collator.compare(a.titleKey, b.titleKey);
        return tCmp !== 0 ? tCmp : a.origIdx - b.origIdx;
      }

      if (rule === "site") {
        return compareBySiteAndTitle(a, b);
      }

      // 默认 smart 模式：功能聚簇 → 同站点与端口紧邻 → 自然标题顺序
      if (a.funcGroup !== b.funcGroup) {
        if (a.funcGroup === "常规条目") return 1;
        if (b.funcGroup === "常规条目") return -1;
        const fcDiff = (funcCounts.get(b.funcGroup) || 0) - (funcCounts.get(a.funcGroup) || 0);
        if (fcDiff !== 0) return fcDiff;
        const fgCmp = collator.compare(a.funcGroup, b.funcGroup);
        if (fgCmp !== 0) return fgCmp;
      }

      return compareBySiteAndTitle(a, b);
    });

    return enriched.map(e => e.item);
  }

  /**
   * 计算单条新增书签在目标文件夹内的建议插入位置。
   * 优先紧邻同主机或同主域的已有书签，其次紧邻同功能聚簇；无邻近项时返回 undefined（默认追加末尾）。
   * @param {string} newUrl 新书签 URL
   * @param {string} newTitle 新书签标题
   * @param {Array} siblingNodes 目标文件夹内现有的直接子节点数组
   * @returns {number|undefined}
   */
  function computeSmartInsertionIndex(newUrl, newTitle, siblingNodes = []) {
    if (!newUrl || !Array.isArray(siblingNodes) || siblingNodes.length === 0) {
      return undefined;
    }

    const newInfo = parseUrlInfo(newUrl);
    if (!newInfo.valid) return undefined;

    const newSiteKey = newInfo.isIpOrLocal ? newInfo.hostname : newInfo.baseDomain;
    let lastSameHostIdx = -1;
    let lastSameDomainIdx = -1;

    siblingNodes.forEach((node, idx) => {
      if (!node || !node.url) return;
      const sib = parseUrlInfo(node.url);
      if (!sib.valid) return;
      if (sib.hostname === newInfo.hostname) {
        lastSameHostIdx = idx;
      }
      const sibSiteKey = sib.isIpOrLocal ? sib.hostname : sib.baseDomain;
      if (!newInfo.isMultiTopic && sibSiteKey && sibSiteKey === newSiteKey) {
        lastSameDomainIdx = idx;
      }
    });

    if (lastSameHostIdx >= 0) return lastSameHostIdx + 1;
    if (lastSameDomainIdx >= 0) return lastSameDomainIdx + 1;

    const targetFunc = inferLocalFuncGroup(newUrl, newTitle);
    if (targetFunc !== "常规条目") {
      let lastFuncIdx = -1;
      siblingNodes.forEach((node, idx) => {
        if (!node || !node.url) return;
        if (inferLocalFuncGroup(node.url, node.title) === targetFunc) {
          lastFuncIdx = idx;
        }
      });
      if (lastFuncIdx >= 0) return lastFuncIdx + 1;
    }

    return undefined;
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.sorter = {
    inferLocalFuncGroup,
    sortFolderBookmarksByPriority,
    computeSmartInsertionIndex
  };
})(typeof window !== "undefined" ? window : globalThis);
