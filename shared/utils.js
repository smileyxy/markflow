/**
 * 通用工具函数模块
 *
 * 涵盖 URL 解析与归一化、标题清洗与盘古空格排版、Emoji 前缀处理、
 * HTML 安全转义以及目录色彩标记生成。
 */

(function (global) {
  "use strict";

  const { MULTI_TOPIC_DOMAINS, FOLDER_DOT_PALETTE } = global.MarkFlowModules.constants;

  /**
   * 提取域名的可注册主域（eTLD+1），支持常见双段国家顶级域。
   * 对纯 IPv4 地址直接原样返回。
   * @param {string} hostname 小写主机名
   * @returns {string}
   */
  function getRegistrableDomain(hostname) {
    if (!hostname || /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return hostname;
    const parts = hostname.split(".");
    if (parts.length <= 2) return hostname;

    const twoPartTlds = new Set([
      "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn",
      "co.jp", "ne.jp", "or.jp", "co.uk", "org.uk",
      "com.hk", "com.tw", "co.kr"
    ]);
    const tail2 = parts.slice(-2).join(".");
    if (twoPartTlds.has(tail2) && parts.length >= 3) {
      return parts.slice(-3).join(".");
    }
    return tail2;
  }

  /**
   * 将书签 URL 归一化，便于精确去重比对。
   * 去除多余末尾斜杠并统一主机名大小写，同时保留单页应用常用的 `#/` 哈希路由。
   * @param {string} rawUrl 原始 URL
   * @returns {string}
   */
  function normalizeBookmarkUrl(rawUrl) {
    if (!rawUrl) return "";
    try {
      const u = new URL(rawUrl);
      const keepHash = u.hash && u.hash.startsWith("#/");
      const cleanPath = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
      return `${u.protocol}//${u.host.toLowerCase()}${cleanPath}${u.search}${keepHash ? u.hash : ""}`;
    } catch (e) {
      return String(rawUrl).trim();
    }
  }

  /**
   * 解析 URL 结构信息，提取主机名、端口、内网标识、多主题标记与可读路径摘要。
   * @param {string} rawUrl 原始网址
   * @returns {Object}
   */
  function parseUrlInfo(rawUrl) {
    try {
      const u = new URL(rawUrl);
      const hostname = u.hostname.toLowerCase().replace(/^www\./, "");
      const isIpOrLocal =
        hostname === "localhost" ||
        /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) ||
        hostname.endsWith(".local") ||
        hostname.endsWith(".lan");

      const hostKey = u.port ? `${hostname}:${u.port}` : hostname;
      const baseDomain = getRegistrableDomain(hostname);
      const isMultiTopic =
        MULTI_TOPIC_DOMAINS.has(hostname) || MULTI_TOPIC_DOMAINS.has(baseDomain);

      const pathSegments = u.pathname
        .split("/")
        .filter(Boolean)
        .slice(0, 4)
        .map(seg => {
          try {
            return decodeURIComponent(seg).slice(0, 40);
          } catch (e) {
            return seg.slice(0, 40);
          }
        });

      const hashRoute = u.hash && u.hash.startsWith("#/") ? u.hash.slice(1, 45) : "";

      return {
        valid: true,
        protocol: u.protocol,
        hostname,
        port: u.port || "",
        hostKey,
        baseDomain,
        isIpOrLocal,
        isMultiTopic,
        pathHint:
          (pathSegments.length ? "/" + pathSegments.join("/") : "/") +
          (hashRoute ? ` (${hashRoute})` : ""),
        normalizedUrl: normalizeBookmarkUrl(rawUrl)
      };
    } catch (e) {
      return {
        valid: false,
        protocol: "",
        hostname: "",
        port: "",
        hostKey: "",
        baseDomain: "",
        isIpOrLocal: false,
        isMultiTopic: false,
        pathHint: "",
        normalizedUrl: rawUrl || ""
      };
    }
  }

  /**
   * 在中日韩字符与拉丁字母/数字之间补充标准单空格，提升混排阅读体验。
   * @param {string} text 输入文本
   * @returns {string}
   */
  function addPanguSpacing(text) {
    if (!text) return "";
    let s = String(text);
    s = s.replace(/([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af])([a-zA-Z0-9$@%#&])/g, "$1 $2");
    s = s.replace(/([a-zA-Z0-9$@%#&])([\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af])/g, "$1 $2");
    return s.replace(/\s{2,}/g, " ").trim();
  }

  /**
   * 本地正则清洗网页标题中的未读数前缀、常见站点 SEO 尾缀及冗余装饰标签。
   * @param {string} raw 原始网页标题
   * @returns {string}
   */
  function cleanTitleLocally(raw) {
    if (!raw) return "";
    let clean = String(raw).trim();
    clean = clean.replace(/^\(\d+\+?\)\s*/, "");
    const suffixRegex =
      /(\s*[-_—|·]\s*(博客园|CSDN博客|CSDN|简书|SegmentFault\s*思否|SegmentFault|稀土掘金|掘金|知乎|哔哩哔哩|bilibili|官方中文文档|中文文档|中文网|官方网站|官网|开源中国|V2EX|吾爱破解|什么值得买|小红书|抖音)).*$/i;
    clean = clean.replace(suffixRegex, "");
    clean = clean.replace(/\s*-\s*Powered by (Discuz!|WordPress|phpwind).*$/i, "");
    clean = clean.replace(/^[【\[(](?:原创|转载|转|置顶|最新|推荐|官方|精华)[】\])]\s*/i, "");
    clean = clean.replace(/\s{2,}/g, " ").trim();
    return clean.length >= 2 ? clean : String(raw).trim();
  }

  /**
   * 判断标题是否过于模糊或残缺（例如仅有“登录”“首页”“Dashboard”等通用词）。
   * @param {string} title 待检测标题
   * @returns {boolean}
   */
  function isVagueShortTitle(title) {
    if (!title) return true;
    const t = String(title).trim().toLowerCase();
    if (t.length <= 1 || /^https?:\/\//i.test(t)) return true;
    const vagueSet = new Set([
      "首页", "官网", "官方网站", "官方文档", "文档", "控制台", "登录", "管理后台", "后台", "欢迎", "未命名",
      "home", "homepage", "dashboard", "console", "login", "sign in", "signin", "admin",
      "index", "documentation", "docs", "welcome", "untitled", "swagger", "swagger ui"
    ]);
    return vagueSet.has(t);
  }

  /**
   * 对模型生成的标题进行最终收口校验与排版规范化。
   * 若模型输出为空或仍为模糊词，则结合上级目录上下文或域名兜底补全可读名称。
   */
  function finalizeTitle(aiTitle, fallbackTitle, usePangu = true, url = "", parentContext = "") {
    let t = (aiTitle || "").trim();
    t = t.replace(/^["'「『]+|["'」』]+$/g, "").trim();

    if (!t || isVagueShortTitle(t)) {
      if (fallbackTitle && !isVagueShortTitle(fallbackTitle)) {
        t = fallbackTitle;
      } else {
        const u = parseUrlInfo(url);
        const baseLabel = t || fallbackTitle || "Web Page";
        if (parentContext && !/^(根目录|书签栏|其他书签|Bookmarks)/i.test(parentContext)) {
          const leafCtx = parentContext.split("›").pop().trim();
          t = `${leafCtx} · ${baseLabel}`;
        } else if (u.valid && u.hostKey) {
          t = `${u.hostKey} · ${baseLabel}`;
        } else {
          t = fallbackTitle || t || "Untitled";
        }
      }
    }

    t = t.replace(/\s*·\s*/g, " · ");
    if (usePangu) {
      t = addPanguSpacing(t);
    }
    return t;
  }

  /** 检测字符串开头是否包含 Emoji 图标 */
  function hasLeadingEmoji(str) {
    if (!str) return false;
    return /^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(str.trim());
  }

  /** 移除字符串开头的 Emoji 图标及多余空格 */
  function stripLeadingEmoji(str) {
    if (!str) return "";
    return str.replace(/^[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D]+\s*/gu, "").trim();
  }

  /** 对动态文本进行基础 HTML 实体转义，防止注入 */
  function escapeHtml(str) {
    if (!str) return "";
    return String(str).replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);
  }

  /**
   * 根据目录名称或 ID 生成稳定的标识圆点颜色，提升目录列表扫视效率。
   * @param {string} seed 目录标识文本
   * @returns {string} 十六进制颜色值
   */
  function getFolderAccentColor(seed) {
    const str = String(seed || "default");
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return FOLDER_DOT_PALETTE[hash % FOLDER_DOT_PALETTE.length];
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.utils = {
    getRegistrableDomain,
    normalizeBookmarkUrl,
    parseUrlInfo,
    addPanguSpacing,
    cleanTitleLocally,
    isVagueShortTitle,
    finalizeTitle,
    hasLeadingEmoji,
    stripLeadingEmoji,
    escapeHtml,
    getFolderAccentColor
  };
})(typeof window !== "undefined" ? window : globalThis);
