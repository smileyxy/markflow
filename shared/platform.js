/**
 * 浏览器平台适配模块（Chromium 多端统一适配层）
 *
 * 集中收口 Chrome / Microsoft Edge 在内部页面协议、商店域名拦截、
 * 快捷键设置页地址及系统根书签容器识别上的细微差异，保持业务层零硬编码。
 */

(function (global) {
  "use strict";

  const ROOT_BOOKMARK_IDS = new Set(["0", "1", "2", "3"]);

  const ROOT_FOLDER_NAME_RE =
    /^(根目录|书签栏|其他书签|移动设备书签|收藏夹栏|其他收藏夹|移动收藏夹|書籤列|其他書籤|行動裝置書籤|我的最愛列|其他我的最愛|行動我的最愛|Bookmarks bar|Other bookmarks|Mobile bookmarks|Favorites bar|Other favorites|Mobile favorites|ブックマーク バー|その他のブックマーク|お気に入りバー|その他のお気に入り|북마크바|기타 북마크|즐겨찾기 모음|기타 즐겨찾기|Lesezeichenleiste|Weitere Lesezeichen|Favoritenleiste|Weitere Favoriten|Barra de marcadores|Otros marcadores|Barra de favoritos|Otros favoritos)$/i;

  /**
   * 识别当前运行浏览器标识。
   * @param {string} [ua] 可选 User-Agent 字符串（默认读取 navigator.userAgent）
   * @returns {"edge"|"chrome"}
   */
  function detectBrowser(ua) {
    const rawUa =
      ua !== undefined && ua !== null
        ? String(ua)
        : typeof navigator !== "undefined" && navigator.userAgent
          ? navigator.userAgent
          : "";
    return /\bEdg(?:A|iOS)?\//i.test(rawUa) ? "edge" : "chrome";
  }

  /** 判断当前是否为 Microsoft Edge 浏览器 */
  function isEdgeBrowser(ua) {
    return detectBrowser(ua) === "edge";
  }

  /** 返回当前浏览器对应的扩展快捷键设置页地址 */
  function getShortcutsPageUrl(ua) {
    return isEdgeBrowser(ua)
      ? "edge://extensions/shortcuts"
      : "chrome://extensions/shortcuts";
  }

  /** 判断标签页 URL 是否为空白页或浏览器内置工具页 */
  function isUtilityTabUrl(url) {
    if (!url) return true;
    return /^(chrome:\/\/(newtab|bookmarks|extensions|settings|history|downloads|apps)|edge:\/\/(newtab|favorites|extensions|settings|history|downloads|apps|collections)|about:(blank|newtab))/i.test(
      String(url).trim()
    );
  }

  /** 判断站点图标 URL 是否为浏览器受限内部协议 */
  function isInternalFaviconUrl(url) {
    if (!url) return true;
    return /^(chrome|edge|chrome-untrusted|devtools|about):/i.test(String(url).trim());
  }

  /** 判断页面是否属于禁止扩展脚本注入的官方扩展商店页面 */
  function isRestrictedStoreUrl(url) {
    if (!url) return false;
    return /^https:\/\/(chrome\.google\.com|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(
      String(url).trim()
    );
  }

  /**
   * 判断书签节点或节点 ID 是否属于浏览器系统级根容器（根节点及一级栏位容器）。
   * 兼容通过固定 ID（0/1/2/3）及 `parentId === "0"` 双重识别。
   * @param {Object|string|number} nodeOrId 书签树节点对象或节点 ID
   * @returns {boolean}
   */
  function isRootBookmarkNode(nodeOrId) {
    if (nodeOrId === null || nodeOrId === undefined || nodeOrId === "") return false;
    if (typeof nodeOrId === "object") {
      const idStr =
        nodeOrId.id !== undefined && nodeOrId.id !== null ? String(nodeOrId.id) : "";
      const parentIdStr =
        nodeOrId.parentId !== undefined && nodeOrId.parentId !== null
          ? String(nodeOrId.parentId)
          : "";
      return ROOT_BOOKMARK_IDS.has(idStr) || parentIdStr === "0";
    }
    return ROOT_BOOKMARK_IDS.has(String(nodeOrId));
  }

  /** 判断目录名称是否为各语言环境下浏览器系统根书签栏名称 */
  function isRootFolderName(name) {
    if (!name) return true;
    return ROOT_FOLDER_NAME_RE.test(String(name).trim());
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.platform = {
    ROOT_BOOKMARK_IDS,
    detectBrowser,
    isEdgeBrowser,
    getShortcutsPageUrl,
    isUtilityTabUrl,
    isInternalFaviconUrl,
    isRestrictedStoreUrl,
    isRootBookmarkNode,
    isRootFolderName
  };
})(typeof window !== "undefined" ? window : globalThis);
