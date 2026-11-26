/**
 * 零 Token 书签库本地清理引擎（重复书签规范化合并 & 失效链接探测）
 *
 * 1. 重复书签合并：纯本地 URL 规范化（协议/www/斜杠/追踪参数/参数排序），按目录深度与收藏时间推荐保留副本。
 * 2. 失效链接清理：自动跳过内网与非 HTTP(S) 书签；支持按需 CORS HEAD→GET 双重校验与零权限 no-cors 降级探测，
 *    支持并发限制、AbortSignal 随时中断及高置信/需复核分级。
 */

(function (global) {
  "use strict";

  const TRACKING_QUERY_PARAMS = new Set([
    "spm",
    "spm_id_from",
    "from_spmid",
    "vd_source",
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "yclid",
    "mc_cid",
    "mc_eid",
    "igshid",
    "si",
    "share_source",
    "share_medium",
    "share_plat",
    "share_session_id",
    "share_tag",
    "share_times",
    "_hsenc",
    "_hsmi",
    "mkt_tok",
    "ref_src",
    "ref_url",
    "oly_anon_id",
    "oly_enc_id",
    "vero_id",
    "hsctatracking",
    "ck_subscriber_id",
    "wickedid",
    "twclid",
    "ttclid"
  ]);

  /** 明确表明站点在线但拒绝匿名/爬虫探测的保护性 HTTP 状态码 */
  const PROTECTED_HTTP_STATUSES = new Set([401, 403, 405, 406, 412, 418, 429, 451]);

  /** 非 Cloudflare WAF（如加速乐/CSDN/云加速/安全狗）返回 521 JS 质询时的服务端特征 */
  const WAF_SERVER_PATTERN = /\bwaf\b|jiasule|yunjiasu|chuangyu|safedog|qax|anquanbao|360wzb|aliyunwaf/i;

  function readSafeHeader(res, headerName) {
    if (!res || !res.headers || !headerName) return "";
    if (typeof res.headers.get === "function") {
      return String(res.headers.get(headerName) || "").trim();
    }
    const targetLower = String(headerName).toLowerCase();
    for (const [k, v] of Object.entries(res.headers)) {
      if (String(k).toLowerCase() === targetLower) {
        return String(v || "").trim();
      }
    }
    return "";
  }

  function isCloudflareResponse({ server = "", cfRay = "" } = {}) {
    return Boolean(String(cfRay || "").trim()) || /cloudflare/i.test(String(server || ""));
  }

  /**
   * 区分国产 WAF JS-Cookie 质询（521）与 Cloudflare 源站宕机（521）：
   * Cloudflare 521 保留在需人工复核；非 Cloudflare 且命中 WAF Server 头或前 2KB 含 JS 质询脚本时归为受保护。
   */
  function isWafChallenge521({ status = 0, server = "", cfRay = "", bodySnippet = "" } = {}) {
    if (Number(status) !== 521) return false;
    if (isCloudflareResponse({ server, cfRay })) return false;
    if (WAF_SERVER_PATTERN.test(String(server || ""))) return true;

    const snippet = String(bodySnippet || "");
    if (!/<script[\s>]/i.test(snippet)) return false;
    return /(?:document\.cookie|window\.onload|setTimeout\s*\(|location\.(?:href|replace|reload)|eval\s*\(|__jsl|waf_captcha|challenge)/i.test(
      snippet
    );
  }

  async function readTinyBodyPrefix(res, maxBytes = 2048) {
    try {
      if (res && res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks = [];
        let totalBytes = 0;
        try {
          while (totalBytes < maxBytes) {
            const { value, done } = await reader.read();
            if (done || !value) break;
            const len = Math.min(value.byteLength || value.length || 0, maxBytes - totalBytes);
            if (len > 0) {
              chunks.push(value.subarray ? value.subarray(0, len) : value.slice(0, len));
              totalBytes += len;
            }
          }
        } finally {
          reader.cancel().catch(() => {});
        }
        if (typeof TextDecoder === "function") {
          const merged = new Uint8Array(totalBytes);
          let offset = 0;
          for (const ch of chunks) {
            merged.set(ch, offset);
            offset += ch.byteLength || ch.length || 0;
          }
          return new TextDecoder("utf-8", { fatal: false }).decode(merged);
        }
        return chunks.map(ch => String.fromCharCode.apply(null, Array.from(ch))).join("");
      }
      if (res && typeof res.text === "function") {
        const txt = await res.text();
        if (res.body && typeof res.body.cancel === "function") {
          res.body.cancel().catch(() => {});
        }
        return String(txt || "").slice(0, maxBytes);
      }
    } catch (e) {
      return "";
    }
    return "";
  }

  /**
   * 按域名轮询打散 URL 顺序，防止同站点（如多个 CSDN 博客链接）连续并发请求触发 WAF 限流质询。
   */
  function interleaveUrlsByHost(urls) {
    const groups = new Map();
    for (const rawUrl of Array.isArray(urls) ? urls : []) {
      const str = String(rawUrl || "");
      let hostKey = str;
      try {
        hostKey = new URL(str).hostname.toLowerCase() || str;
      } catch (e) {
        hostKey = str;
      }
      if (!groups.has(hostKey)) groups.set(hostKey, []);
      groups.get(hostKey).push(str);
    }

    const queues = Array.from(groups.values());
    const result = [];
    let idx = 0;
    let remaining = true;
    while (remaining) {
      remaining = false;
      for (const q of queues) {
        if (idx < q.length) {
          result.push(q[idx]);
          remaining = true;
        }
      }
      idx++;
    }
    return result;
  }

  /** 仅用于扫描后本地交叉统计是否存在“忘记开代理”现象，不主动向这些域名发起任何额外请求 */
  const GLOBAL_REFERENCE_DOMAINS = new Set([
    "google.com",
    "withgoogle.com",
    "youtube.com",
    "youtu.be",
    "github.com",
    "gitlab.com",
    "x.com",
    "twitter.com",
    "grok.com",
    "x.ai",
    "openai.com",
    "chatgpt.com",
    "claude.ai",
    "anthropic.com",
    "perplexity.ai",
    "poe.com",
    "wikipedia.org",
    "reddit.com",
    "medium.com",
    "telegram.org",
    "t.me",
    "discord.com",
    "instagram.com",
    "facebook.com",
    "twitch.tv",
    "quora.com",
    "pinterest.com",
    "dropbox.com",
    "huggingface.co",
    "notion.so",
    "vercel.com",
    "docker.com",
    "stackoverflow.com"
  ]);

  function matchGlobalReferenceDomain(rawUrl) {
    try {
      let host = new URL(String(rawUrl || "").trim()).hostname.toLowerCase();
      if (host.startsWith("www.")) host = host.slice(4);
      for (const domain of GLOBAL_REFERENCE_DOMAINS) {
        if (host === domain || host.endsWith("." + domain)) {
          return domain;
        }
      }
    } catch (e) {
      return "";
    }
    return "";
  }

  /**
   * 零额外网络请求的代理/网络环境异常识别：仅统计本次用户书签扫描结果自身信号，
   * 当多个常见海外站点集体失败（含 SNI 阻断引发的 TLS / CERT）、多个不同域名同时 HTTPS 握手受阻，
   * 或两轮超时比例异常偏高时返回提醒依据。
   */
  function detectDeadLinkProxyAnomaly({ scannedUniqueCount = 0, results = [] } = {}) {
    const seenUrls = new Set();
    const globalFailedSet = new Set();
    const tlsHostSet = new Set();
    let timeoutCount = 0;

    for (const item of Array.isArray(results) ? results : []) {
      if (!item || !item.url) continue;
      const key = String(item.url);
      if (seenUrls.has(key)) continue;
      seenUrls.add(key);

      if (item.codeLabel === "TIMEOUT") {
        timeoutCount++;
      } else if (item.codeLabel === "TLS / CERT") {
        try {
          let host = new URL(key).hostname.toLowerCase();
          if (host.startsWith("www.")) host = host.slice(4);
          if (host) tlsHostSet.add(host);
        } catch (e) {}
      }

      if (
        item.codeLabel === "TIMEOUT" ||
        item.codeLabel === "DNS / NET" ||
        item.codeLabel === "TLS / CERT"
      ) {
        const matched = matchGlobalReferenceDomain(key);
        if (matched) globalFailedSet.add(matched);
      }
    }

    const tlsHostCount = tlsHostSet.size;
    const globalFailedDomains = Array.from(globalFailedSet).sort();
    const totalScanned = Number(scannedUniqueCount) || 0;

    if (globalFailedDomains.length >= 2) {
      return {
        suspected: true,
        reason: "global_sites",
        timeoutCount,
        tlsHostCount,
        scannedUniqueCount: totalScanned,
        globalFailedDomains
      };
    }

    if (tlsHostCount >= 5) {
      return {
        suspected: true,
        reason: "tls_cluster",
        timeoutCount,
        tlsHostCount,
        scannedUniqueCount: totalScanned,
        globalFailedDomains
      };
    }

    if (timeoutCount >= 5 && totalScanned > 0 && timeoutCount / totalScanned >= 0.15) {
      return {
        suspected: true,
        reason: "high_timeout_ratio",
        timeoutCount,
        tlsHostCount,
        scannedUniqueCount: totalScanned,
        globalFailedDomains
      };
    }

    return {
      suspected: false,
      reason: "",
      timeoutCount,
      tlsHostCount,
      scannedUniqueCount: totalScanned,
      globalFailedDomains
    };
  }

  function isTrackingParamKey(key) {
    const lower = String(key || "").trim().toLowerCase();
    return lower.startsWith("utm_") || TRACKING_QUERY_PARAMS.has(lower);
  }

  function buildAbortError() {
    const err = new Error("Operation aborted");
    err.name = "AbortError";
    return err;
  }

  function isCleanerAbortError(err) {
    if (!err) return false;
    return err.name === "AbortError" || err.code === 20 || /aborted|AbortError/i.test(String(err.message || err));
  }

  /**
   * 对书签 URL 进行确定性规范化用于重复检测。
   * 仅剔除追踪统计参数，保留时间/搜索/分页/文章 ID 等语义参数；默认保留 #hash 锚点。
   */
  function normalizeUrlForDedup(
    rawUrl,
    { stripTracking = true, ignoreHash = false, ignoreWww = true, ignoreProtocol = true } = {}
  ) {
    const trimmed = String(rawUrl || "").trim();
    if (!trimmed) return "";

    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        const protocol = ignoreProtocol ? "https:" : parsed.protocol;
        let hostname = parsed.hostname.toLowerCase();
        if (ignoreWww && hostname.startsWith("www.") && hostname.slice(4).includes(".")) {
          hostname = hostname.slice(4);
        }

        let port = parsed.port || "";
        if ((parsed.protocol === "http:" && port === "80") || (parsed.protocol === "https:" && port === "443")) {
          port = "";
        }

        let pathname = (parsed.pathname || "/").replace(/\/{2,}/g, "/");
        if (pathname.length > 1) {
          pathname = pathname.replace(/\/+$/, "") || "/";
        }

        const paramEntries = [];
        parsed.searchParams.forEach((value, key) => {
          if (stripTracking && isTrackingParamKey(key)) return;
          paramEntries.push([key, value]);
        });
        paramEntries.sort((a, b) => {
          if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
          if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
          return 0;
        });

        const ParamsCtor =
          typeof URLSearchParams === "function"
            ? URLSearchParams
            : parsed.searchParams && parsed.searchParams.constructor;
        let queryString = "";
        if (typeof ParamsCtor === "function") {
          const nextParams = new ParamsCtor();
          for (const [k, v] of paramEntries) {
            nextParams.append(k, v);
          }
          queryString = nextParams.toString();
        } else if (paramEntries.length > 0) {
          queryString = paramEntries
            .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join("&");
        }
        const hash = ignoreHash ? "" : parsed.hash && parsed.hash !== "#" ? parsed.hash : "";

        return `${protocol}//${hostname}${port ? `:${port}` : ""}${pathname}${queryString ? `?${queryString}` : ""}${hash}`;
      }

      const schemeNormalized = parsed.protocol.toLowerCase();
      return `${schemeNormalized}${trimmed.slice(parsed.protocol.length)}`;
    } catch (e) {
      return trimmed;
    }
  }

  function hasReadableBookmarkTitle(bm) {
    const title = String((bm && bm.title) || "").trim();
    if (!title) return false;
    const rawUrl = String((bm && bm.url) || "").trim();
    return title.toLowerCase() !== rawUrl.toLowerCase();
  }

  function getFolderDepthForBookmark(bm, folderDepthMap) {
    if (!bm || !folderDepthMap || typeof folderDepthMap.get !== "function") return 1;
    const val = folderDepthMap.get(String(bm.parentId || ""));
    return typeof val === "number" && Number.isFinite(val) ? val : 1;
  }

  function compareCleanUrlPreference(a, b) {
    const urlA = String((a && a.url) || "");
    const urlB = String((b && b.url) || "");
    const httpsA = urlA.startsWith("https://") ? 1 : 0;
    const httpsB = urlB.startsWith("https://") ? 1 : 0;
    if (httpsB !== httpsA) return httpsB - httpsA;
    if (urlA.length !== urlB.length) return urlA.length - urlB.length;
    return 0;
  }

  /**
   * 按选定策略从同一组重复书签中选出默认保留的最佳副本：
   * - smart（推荐）：已深层归类的目录优先 → 可读标题优先 → 最早收藏时间优先 → 更干净的 HTTPS URL
   * - oldest：最早添加优先（无时间戳排后），平局时保留目录更深者
   * - newest：最新添加优先，平局时保留目录更深者
   */
  function selectPreferredDuplicateBookmark(members, folderDepthMap = null, strategy = "smart") {
    if (!Array.isArray(members) || members.length === 0) return null;
    if (members.length === 1) return members[0];

    const normOldTime = t => {
      const n = Number(t || 0);
      return n > 0 ? n : Number.MAX_SAFE_INTEGER;
    };
    const normNewTime = t => {
      const n = Number(t || 0);
      return n > 0 ? n : -1;
    };

    const sorted = [...members].sort((a, b) => {
      if (strategy === "oldest") {
        const timeDiff = normOldTime(a.dateAdded) - normOldTime(b.dateAdded);
        if (timeDiff !== 0) return timeDiff;
      } else if (strategy === "newest") {
        const timeDiff = normNewTime(b.dateAdded) - normNewTime(a.dateAdded);
        if (timeDiff !== 0) return timeDiff;
      }

      const depthDiff =
        getFolderDepthForBookmark(b, folderDepthMap) - getFolderDepthForBookmark(a, folderDepthMap);
      if (depthDiff !== 0) return depthDiff;

      const titleDiff = Number(hasReadableBookmarkTitle(b)) - Number(hasReadableBookmarkTitle(a));
      if (titleDiff !== 0) return titleDiff;

      if (strategy === "smart") {
        const timeDiff = normOldTime(a.dateAdded) - normOldTime(b.dateAdded);
        if (timeDiff !== 0) return timeDiff;
      }

      const urlDiff = compareCleanUrlPreference(a, b);
      if (urlDiff !== 0) return urlDiff;

      return Number(a._origOrderIdx ?? a.origIndex ?? 0) - Number(b._origOrderIdx ?? b.origIndex ?? 0);
    });

    return sorted[0];
  }

  /** 按规范化 URL 扫描并返回全部重复书签组及推荐保留/删除状态 */
  function findDuplicateBookmarkGroups(
    bookmarks = [],
    { stripTracking = true, ignoreHash = false, strategy = "smart", folderDepthMap = null } = {}
  ) {
    const list = Array.isArray(bookmarks) ? bookmarks : [];
    const buckets = new Map();

    list.forEach((bm, idx) => {
      if (!bm || !bm.url) return;
      const canonicalUrl = normalizeUrlForDedup(bm.url, { stripTracking, ignoreHash });
      if (!canonicalUrl) return;
      if (!buckets.has(canonicalUrl)) buckets.set(canonicalUrl, []);
      buckets.get(canonicalUrl).push(Object.assign({}, bm, { _origOrderIdx: idx }));
    });

    const groups = [];
    let removableCount = 0;

    for (const [canonicalUrl, rawMembers] of buckets.entries()) {
      if (rawMembers.length < 2) continue;
      const keepItem = selectPreferredDuplicateBookmark(rawMembers, folderDepthMap, strategy);
      const keepId = keepItem ? String(keepItem.id) : String(rawMembers[0].id);

      const members = rawMembers
        .map(m => {
          const isKeep = String(m.id) === keepId;
          const mNorm = normalizeUrlForDedup(m.url, { stripTracking, ignoreHash });
          return {
            id: String(m.id),
            title: m.title || "",
            url: m.url,
            parentId: String(m.parentId || ""),
            parentTitle: m.parentTitle || "",
            dateAdded: Number(m.dateAdded || 0),
            folderDepth: getFolderDepthForBookmark(m, folderDepthMap),
            isKeep,
            removeChecked: !isKeep,
            urlDiffersFromCanonical: String(m.url).trim() !== mNorm
          };
        })
        .sort((a, b) => Number(b.isKeep) - Number(a.isKeep));

      removableCount += members.filter(m => m.removeChecked).length;

      groups.push({
        key: canonicalUrl,
        canonicalUrl,
        defaultKeepId: keepId,
        keepId,
        members
      });
    }

    groups.sort((a, b) => {
      const sizeDiff = b.members.length - a.members.length;
      if (sizeDiff !== 0) return sizeDiff;
      return a.canonicalUrl.localeCompare(b.canonicalUrl);
    });

    return {
      groups,
      totalBookmarksScanned: list.length,
      duplicateGroupCount: groups.length,
      removableCount
    };
  }

  function isCheckableHttpUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  function isPrivateIpv4Host(hostname) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    const c = Number(m[3]);
    const d = Number(m[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    return false;
  }

  /** 判断 URL 是否为本地回环、私有局域网 IP 或内网短域名，默认不作为公网死链处理 */
  function isPrivateOrLocalUrl(rawUrl) {
    try {
      const parsed = new URL(String(rawUrl || "").trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
      const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (!host) return true;

      if (
        host === "localhost" ||
        host.endsWith(".localhost") ||
        host.endsWith(".local") ||
        host.endsWith(".lan") ||
        host.endsWith(".home") ||
        host.endsWith(".internal") ||
        host.endsWith(".intranet") ||
        host.endsWith(".arpa")
      ) {
        return true;
      }

      if (host.includes(":")) {
        if (host === "::1" || host === "::" || host.startsWith("fe80:") || /^f[cd][0-9a-f]{0,2}:/.test(host)) {
          return true;
        }
        if (host.startsWith("::ffff:")) {
          return isPrivateIpv4Host(host.slice(7));
        }
        return false;
      }

      if (isPrivateIpv4Host(host)) return true;
      if (!host.includes(".")) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  /**
   * 将网络探测结果映射为：
   * - alive / protected（站点存活或受防爬/WAF JS 质询/鉴权拦截，不进异常列表）
   * - dead（高置信 404/410/真死链，默认勾选）
   * - review（TLS 证书异常 / 超时 / 444 / 5xx 等需人工复核项，默认不勾选）
   */
  function classifyDeadLinkOutcome({
    mode = "cors",
    status = 0,
    timedOut = false,
    networkError = false,
    tlsError = false,
    wafChallenge = false
  } = {}) {
    if (timedOut) {
      return {
        category: "review",
        defaultChecked: false,
        timedOut: true,
        codeLabel: "TIMEOUT",
        reasonKey: "reorg_dead_reason_timeout"
      };
    }

    if (tlsError) {
      return {
        category: "review",
        defaultChecked: false,
        codeLabel: "TLS / CERT",
        reasonKey: "reorg_dead_reason_tls_cert"
      };
    }

    if (networkError) {
      return {
        category: "dead",
        defaultChecked: true,
        codeLabel: "DNS / NET",
        reasonKey: "reorg_dead_reason_unreachable"
      };
    }

    if (mode === "no-cors" && status === 0) {
      return { category: "alive", defaultChecked: false, codeLabel: "OK", reasonKey: "" };
    }

    if (status >= 200 && status < 400) {
      return {
        category: "alive",
        defaultChecked: false,
        codeLabel: `HTTP ${status}`,
        reasonKey: ""
      };
    }

    if (PROTECTED_HTTP_STATUSES.has(status) || wafChallenge) {
      return {
        category: "protected",
        defaultChecked: false,
        codeLabel: status ? `HTTP ${status}` : "WAF",
        reasonKey: ""
      };
    }

    if (status === 404) {
      return {
        category: "dead",
        defaultChecked: true,
        codeLabel: "HTTP 404",
        reasonKey: "reorg_dead_reason_404"
      };
    }

    if (status === 410) {
      return {
        category: "dead",
        defaultChecked: true,
        codeLabel: "HTTP 410",
        reasonKey: "reorg_dead_reason_410"
      };
    }

    if (status === 444) {
      return {
        category: "review",
        defaultChecked: false,
        codeLabel: "HTTP 444",
        reasonKey: "reorg_dead_reason_444"
      };
    }

    if (status >= 500 && status < 600) {
      return {
        category: "review",
        defaultChecked: false,
        codeLabel: `HTTP ${status}`,
        reasonKey: "reorg_dead_reason_server_err"
      };
    }

    if (status >= 400) {
      return {
        category: "review",
        defaultChecked: false,
        codeLabel: `HTTP ${status}`,
        reasonKey: "reorg_dead_reason_http_other"
      };
    }

    return {
      category: "alive",
      defaultChecked: false,
      codeLabel: "OK",
      reasonKey: ""
    };
  }

  /**
   * 探测单个 URL 的连通性与状态码；在 CORS 模式下对 HEAD 返回异常状态自动使用轻量 GET 二次核验，
   * 并在 521 场景区分非 Cloudflare WAF JS 质询（受保护）与 Cloudflare 源站宕机（需复核）；
   * 在网络/TLS 失败时自动补测裸域 HTTPS 与手动跟随 HTTP，区分真实死域名与证书漏配/过期站点。
   */
  async function probeSingleBookmarkLink(
    url,
    { mode = "cors", timeoutMs = 8000, preferGet = false, signal = null, fetchImpl = null } = {}
  ) {
    const doFetch = fetchImpl || global.fetch;
    if (typeof doFetch !== "function") {
      throw new Error("fetch API is unavailable");
    }

    const executeProbe = async (
      targetUrl,
      method,
      probeMode,
      { redirect = "follow", probeTimeoutMs = timeoutMs, sendHtmlAccept = false } = {}
    ) => {
      if (signal && signal.aborted) throw buildAbortError();

      let timedOut = false;
      let canceledByOuter = false;
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      const onOuterAbort = () => {
        canceledByOuter = true;
        if (ctrl) ctrl.abort();
      };

      if (signal && ctrl && typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onOuterAbort, { once: true });
      }
      const timer =
        ctrl && typeof setTimeout === "function"
          ? setTimeout(() => {
              timedOut = true;
              ctrl.abort();
            }, probeTimeoutMs)
          : null;

      try {
        const init = {
          method,
          redirect,
          cache: "no-store",
          credentials: "omit"
        };
        if (probeMode === "no-cors") {
          init.mode = "no-cors";
        } else if (sendHtmlAccept) {
          init.headers = {
            Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
          };
        }
        if (ctrl) init.signal = ctrl.signal;

        const res = await doFetch(targetUrl, init);
        const status = Number((res && res.status) || 0);
        const type = String((res && res.type) || "");
        const server = readSafeHeader(res, "server");
        const cfRay = readSafeHeader(res, "cf-ray");
        const isCloudflare = isCloudflareResponse({ server, cfRay });
        let wafChallenge = false;

        if (status === 521 && probeMode === "cors" && !isCloudflare) {
          if (isWafChallenge521({ status, server, cfRay })) {
            wafChallenge = true;
            if (res && res.body && typeof res.body.cancel === "function") {
              res.body.cancel().catch(() => {});
            }
          } else if (method === "GET") {
            const bodySnippet = await readTinyBodyPrefix(res, 2048);
            wafChallenge = isWafChallenge521({ status, server, cfRay, bodySnippet });
          } else if (res && res.body && typeof res.body.cancel === "function") {
            res.body.cancel().catch(() => {});
          }
        } else if (res && res.body && typeof res.body.cancel === "function") {
          res.body.cancel().catch(() => {});
        }

        return {
          status,
          type,
          timedOut: false,
          networkError: false,
          wafChallenge,
          isCloudflare
        };
      } catch (err) {
        if (canceledByOuter || (signal && signal.aborted)) {
          throw buildAbortError();
        }
        if (timedOut) {
          return {
            status: 0,
            type: "",
            timedOut: true,
            networkError: false,
            wafChallenge: false,
            isCloudflare: false
          };
        }
        if (isCleanerAbortError(err)) {
          throw buildAbortError();
        }
        return {
          status: 0,
          type: "",
          timedOut: false,
          networkError: true,
          wafChallenge: false,
          isCloudflare: false
        };
      } finally {
        if (timer !== null && typeof clearTimeout === "function") clearTimeout(timer);
        if (signal && ctrl && typeof signal.removeEventListener === "function") {
          signal.removeEventListener("abort", onOuterAbort);
        }
      }
    };

    const recoverFromNetworkError = async (targetUrl, probeMode) => {
      try {
        const parsed = new URL(String(targetUrl || "").trim());
        const hostLower = parsed.hostname.toLowerCase();

        // 补测 A：若 www. 子域因证书仅签给裸域而报错，补测裸域 HTTPS
        if (hostLower.startsWith("www.") && hostLower.slice(4).includes(".")) {
          const portPart =
            parsed.port && parsed.port !== "80" && parsed.port !== "443" ? `:${parsed.port}` : "";
          const bareHttpsUrl = `https://${hostLower.slice(4)}${portPart}${parsed.pathname}${parsed.search}${parsed.hash}`;
          const bareRes = await executeProbe(bareHttpsUrl, "GET", probeMode, {
            redirect: "follow",
            sendHtmlAccept: probeMode === "cors",
            probeTimeoutMs: Math.min(timeoutMs, 6000)
          });
          if (!bareRes.networkError && !bareRes.timedOut) {
            if (probeMode === "no-cors") {
              return classifyDeadLinkOutcome({ mode: "no-cors", status: 0 });
            }
            if (
              (bareRes.status >= 200 && bareRes.status < 400) ||
              PROTECTED_HTTP_STATUSES.has(bareRes.status) ||
              bareRes.wafChallenge
            ) {
              return classifyDeadLinkOutcome({
                mode: "cors",
                status: bareRes.status,
                wafChallenge: bareRes.wafChallenge
              });
            }
          }
        }

        // 补测 B：标准端口用 http:// 手动不跟跳转探测主机是否在线，识别证书过期/失效站点
        if (!parsed.port || parsed.port === "80" || parsed.port === "443") {
          const httpManualUrl = `http://${hostLower}${parsed.pathname}${parsed.search}${parsed.hash}`;
          const httpCheck = await executeProbe(httpManualUrl, "GET", probeMode, {
            redirect: "manual",
            probeTimeoutMs: Math.min(timeoutMs, 5000)
          });
          if (!httpCheck.networkError && !httpCheck.timedOut) {
            return classifyDeadLinkOutcome({ mode: probeMode, tlsError: true });
          }
        }
      } catch (err) {
        if (isCleanerAbortError(err) || (signal && signal.aborted)) {
          throw buildAbortError();
        }
      }

      return classifyDeadLinkOutcome({ mode: probeMode, networkError: true });
    };

    if (mode === "no-cors") {
      const noCorsRes = await executeProbe(url, "GET", "no-cors");
      if (noCorsRes.networkError && !noCorsRes.timedOut) {
        return recoverFromNetworkError(url, "no-cors");
      }
      return classifyDeadLinkOutcome(Object.assign({ mode: "no-cors" }, noCorsRes));
    }

    if (preferGet) {
      const getRes = await executeProbe(url, "GET", "cors", {
        sendHtmlAccept: true,
        probeTimeoutMs: timeoutMs
      });
      if (getRes.networkError && !getRes.timedOut) {
        return recoverFromNetworkError(url, "cors");
      }
      return classifyDeadLinkOutcome(Object.assign({ mode: "cors" }, getRes));
    }

    const headRes = await executeProbe(url, "HEAD", "cors");
    if (headRes.timedOut) {
      return classifyDeadLinkOutcome(Object.assign({ mode: "cors" }, headRes));
    }

    // 许多站点与网关拒绝 HEAD 请求并返回 400/404/405/410/444/501/非CF-521 或直接断开连接，补一次 GET 核验并检查 WAF 特征
    const shouldVerifyWithGet =
      headRes.networkError ||
      headRes.status === 400 ||
      headRes.status === 404 ||
      headRes.status === 405 ||
      headRes.status === 410 ||
      headRes.status === 444 ||
      headRes.status === 501 ||
      (headRes.status === 521 && !headRes.isCloudflare && !headRes.wafChallenge);

    if (shouldVerifyWithGet) {
      const getRes = await executeProbe(url, "GET", "cors", { sendHtmlAccept: true });
      if (getRes.networkError && !getRes.timedOut) {
        return recoverFromNetworkError(url, "cors");
      }
      return classifyDeadLinkOutcome(Object.assign({ mode: "cors" }, getRes));
    }

    return classifyDeadLinkOutcome(Object.assign({ mode: "cors" }, headRes));
  }

  /**
   * 两阶段自适应限流扫描书签有效性：
   * 第一阶段 6 并发 8s 快扫（按域名轮询打散并发防止同站防爬误伤）；对首轮超时项在第二阶段降为 2 并发 + 22s 直接 GET 复测，
   * 救回慢加载活站（如冷启动或文档站），并等待系统连接超时暴露真正失联/黑洞死链。
   */
  async function scanDeadBookmarks({
    bookmarks = [],
    skipLocal = true,
    mode = "cors",
    concurrency = 6,
    timeoutMs = 8000,
    retryConcurrency = 2,
    retryTimeoutMs = 22000,
    signal = null,
    onProgress = null,
    fetchImpl = null
  } = {}) {
    const list = Array.isArray(bookmarks) ? bookmarks : [];
    const checkableBookmarks = [];
    let skippedCount = 0;

    for (const bm of list) {
      if (!bm || !bm.url || !isCheckableHttpUrl(bm.url)) {
        skippedCount++;
        continue;
      }
      if (skipLocal && isPrivateOrLocalUrl(bm.url)) {
        skippedCount++;
        continue;
      }
      checkableBookmarks.push(bm);
    }

    const urlBuckets = new Map();
    for (const bm of checkableBookmarks) {
      const key = String(bm.url);
      if (!urlBuckets.has(key)) urlBuckets.set(key, []);
      urlBuckets.get(key).push(bm);
    }

    const uniqueUrls = interleaveUrlsByHost(Array.from(urlBuckets.keys()));
    const outcomeByUrl = new Map();
    const retryUrls = [];
    let nextIdx = 0;
    let doneUrls = 0;
    let aliveCount = 0;
    let protectedCount = 0;
    let deadCount = 0;
    let reviewCount = 0;
    let canceled = Boolean(signal && signal.aborted);

    const recordFinalOutcome = (targetUrl, outcome) => {
      outcomeByUrl.set(targetUrl, outcome);
      const groupCount = urlBuckets.get(targetUrl).length;
      if (outcome.category === "dead") deadCount += groupCount;
      else if (outcome.category === "review") reviewCount += groupCount;
      else if (outcome.category === "protected") protectedCount += groupCount;
      else aliveCount += groupCount;
    };

    const workerCount = Math.max(1, Math.min(Number(concurrency) || 6, uniqueUrls.length || 1));

    const runWorker = async () => {
      while (!canceled) {
        if (signal && signal.aborted) {
          canceled = true;
          break;
        }
        const currentIdx = nextIdx;
        nextIdx++;
        if (currentIdx >= uniqueUrls.length) break;

        const targetUrl = uniqueUrls[currentIdx];
        try {
          const outcome = await probeSingleBookmarkLink(targetUrl, {
            mode,
            timeoutMs,
            signal,
            fetchImpl
          });
          doneUrls++;

          if (outcome && outcome.timedOut && retryTimeoutMs > 0) {
            retryUrls.push(targetUrl);
          } else {
            recordFinalOutcome(targetUrl, outcome);
          }

          if (typeof onProgress === "function") {
            onProgress({
              phase: "scan",
              done: doneUrls,
              total: uniqueUrls.length,
              retryQueued: retryUrls.length,
              deadCount,
              reviewCount,
              protectedCount,
              currentUrl: targetUrl
            });
          }
        } catch (err) {
          if (isCleanerAbortError(err) || (signal && signal.aborted)) {
            canceled = true;
            break;
          }
          const fallbackOutcome = classifyDeadLinkOutcome({ mode, networkError: true });
          recordFinalOutcome(targetUrl, fallbackOutcome);
          doneUrls++;
          if (typeof onProgress === "function") {
            onProgress({
              phase: "scan",
              done: doneUrls,
              total: uniqueUrls.length,
              retryQueued: retryUrls.length,
              deadCount,
              reviewCount,
              protectedCount,
              currentUrl: targetUrl
            });
          }
        }
      }
    };

    if (uniqueUrls.length > 0 && !canceled) {
      await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
    }

    if (!canceled && retryUrls.length > 0 && retryTimeoutMs > 0) {
      const orderedRetryUrls = interleaveUrlsByHost(retryUrls);
      let retryNextIdx = 0;
      let retryDone = 0;
      const retryWorkerCount = Math.max(
        1,
        Math.min(Number(retryConcurrency) || 2, orderedRetryUrls.length)
      );

      if (typeof onProgress === "function") {
        onProgress({
          phase: "retry",
          done: 0,
          total: orderedRetryUrls.length,
          scanTotal: uniqueUrls.length,
          deadCount,
          reviewCount,
          protectedCount,
          currentUrl: ""
        });
      }

      const runRetryWorker = async () => {
        while (!canceled) {
          if (signal && signal.aborted) {
            canceled = true;
            break;
          }
          const currentIdx = retryNextIdx;
          retryNextIdx++;
          if (currentIdx >= orderedRetryUrls.length) break;

          const targetUrl = orderedRetryUrls[currentIdx];
          try {
            const outcome = await probeSingleBookmarkLink(targetUrl, {
              mode,
              timeoutMs: retryTimeoutMs,
              preferGet: true,
              signal,
              fetchImpl
            });
            recordFinalOutcome(targetUrl, outcome);
            retryDone++;

            if (typeof onProgress === "function") {
              onProgress({
                phase: "retry",
                done: retryDone,
                total: orderedRetryUrls.length,
                scanTotal: uniqueUrls.length,
                deadCount,
                reviewCount,
                protectedCount,
                currentUrl: targetUrl
              });
            }
          } catch (err) {
            if (isCleanerAbortError(err) || (signal && signal.aborted)) {
              canceled = true;
              break;
            }
            const fallbackOutcome = classifyDeadLinkOutcome({ mode, networkError: true });
            recordFinalOutcome(targetUrl, fallbackOutcome);
            retryDone++;
            if (typeof onProgress === "function") {
              onProgress({
                phase: "retry",
                done: retryDone,
                total: orderedRetryUrls.length,
                scanTotal: uniqueUrls.length,
                deadCount,
                reviewCount,
                protectedCount,
                currentUrl: targetUrl
              });
            }
          }
        }
      };

      await Promise.all(Array.from({ length: retryWorkerCount }, () => runRetryWorker()));
    }

    const results = [];
    let scannedCount = 0;
    let unprocessedCount = 0;

    for (const [url, members] of urlBuckets.entries()) {
      const outcome = outcomeByUrl.get(url);
      if (!outcome) {
        unprocessedCount += members.length;
        continue;
      }
      scannedCount += members.length;
      if (outcome.category === "dead" || outcome.category === "review") {
        for (const bm of members) {
          results.push({
            id: String(bm.id),
            title: bm.title || "",
            url: bm.url,
            parentId: String(bm.parentId || ""),
            parentTitle: bm.parentTitle || "",
            category: outcome.category,
            codeLabel: outcome.codeLabel,
            reasonKey: outcome.reasonKey,
            selectedForDelete: Boolean(outcome.defaultChecked)
          });
        }
      }
    }

    results.sort((a, b) => {
      if (a.category !== b.category) return a.category === "dead" ? -1 : 1;
      return a.url.localeCompare(b.url);
    });

    const proxyHint = detectDeadLinkProxyAnomaly({
      scannedUniqueCount: outcomeByUrl.size,
      results
    });

    return {
      canceled,
      mode,
      scannedCount,
      totalCheckable: checkableBookmarks.length,
      skippedCount,
      aliveCount,
      protectedCount,
      deadCount,
      reviewCount,
      unprocessedCount,
      proxyHint,
      results
    };
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.cleaner = {
    TRACKING_QUERY_PARAMS,
    PROTECTED_HTTP_STATUSES,
    GLOBAL_REFERENCE_DOMAINS,
    normalizeUrlForDedup,
    selectPreferredDuplicateBookmark,
    findDuplicateBookmarkGroups,
    isCheckableHttpUrl,
    isPrivateOrLocalUrl,
    isWafChallenge521,
    interleaveUrlsByHost,
    classifyDeadLinkOutcome,
    detectDeadLinkProxyAnomaly,
    probeSingleBookmarkLink,
    scanDeadBookmarks
  };
})(typeof window !== "undefined" ? window : globalThis);
