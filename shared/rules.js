/**
 * 本地规则匹配引擎模块
 *
 * 支持纯域名（含自动子域与端口容错）、通配符表达式以及显式正则表达式，
 * 可在零网络开销下完成毫秒级目标目录定位。
 */

(function (global) {
  "use strict";

  const { parseUrlInfo } = global.MarkFlowModules.utils;

  /**
   * 检测单个 URL 是否命中指定规则表达式。
   * 支持多分隔符（|、全角 ｜、中英文逗号与换行）、/regex/flags、通配符 * 及纯域名。
   * @param {string} rawUrl 待检测网址
   * @param {string} patternString 规则表达式字符串
   * @returns {{ matched: boolean, matchedSegment: string, mode: string }}
   */
  function testRulePattern(rawUrl, patternString) {
    if (!rawUrl || !patternString) return { matched: false, matchedSegment: "", mode: "" };

    const url = String(rawUrl).trim();
    const uInfo = parseUrlInfo(url);
    const segments = String(patternString)
      .split(/[|｜,，\r\n]+/)
      .map(s => s.trim())
      .filter(Boolean);

    for (const seg of segments) {
      // 1. 显式正则表达式：/pattern/flags
      const regexLiteral = seg.match(/^\/(.+)\/([gimsuy]*)$/);
      if (regexLiteral) {
        try {
          const flags = regexLiteral[2].includes("i") ? regexLiteral[2] : regexLiteral[2] + "i";
          const re = new RegExp(regexLiteral[1], flags);
          if (re.test(url)) {
            return { matched: true, matchedSegment: seg, mode: "regex" };
          }
        } catch (e) {}
        continue;
      }

      // 2. 通配符表达式（含 *），对无末尾 * 的主机通配符自动容忍端口与路径
      if (seg.includes("*")) {
        const escaped = seg
          .replace(/[-[\]{}()+?.,\\^$|#\s]/g, "\\$&")
          .replace(/\*/g, ".*");

        const hasTrailingWildcard = seg.endsWith("*");
        const hasPathSlash = /\/[^*]/.test(seg.replace(/^https?:\/\//i, ""));
        const suffixTolerance = !hasTrailingWildcard && !hasPathSlash ? "(?::\\d+)?(?:/.*)?$" : "$";
        const prefixTolerance =
          !seg.startsWith("*") && !/^https?:\/\//i.test(seg) ? "^(?:https?://)?" : "^";

        try {
          const re = new RegExp(`${prefixTolerance}${escaped}${suffixTolerance}`, "i");
          if (re.test(url)) {
            return { matched: true, matchedSegment: seg, mode: "wildcard" };
          }
          if (uInfo.valid) {
            const hostRe = new RegExp(`^${escaped}$`, "i");
            if (hostRe.test(uInfo.hostname) || hostRe.test(uInfo.hostKey)) {
              return { matched: true, matchedSegment: seg, mode: "wildcard_host" };
            }
          }
        } catch (e) {}
        continue;
      }

      // 3. 纯域名或关键字匹配：纯域名强制校验点号边界，避免 example.com 误命中 evil-example.com
      const lowerSeg = seg.toLowerCase().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
      if (!lowerSeg) continue;

      const isPureHostOrDomain =
        !lowerSeg.includes("/") &&
        /^\.?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?$/.test(lowerSeg);

      if (uInfo.valid && !lowerSeg.includes("/")) {
        const cleanHostRule = lowerSeg.replace(/^\./, "");
        if (
          uInfo.hostname === cleanHostRule ||
          uInfo.hostname.endsWith("." + cleanHostRule) ||
          uInfo.hostKey === cleanHostRule ||
          uInfo.hostKey.endsWith("." + cleanHostRule)
        ) {
          return { matched: true, matchedSegment: seg, mode: "domain" };
        }
        if (isPureHostOrDomain) continue;
      }

      if (url.toLowerCase().includes(seg.toLowerCase())) {
        return { matched: true, matchedSegment: seg, mode: "substring" };
      }
    }

    return { matched: false, matchedSegment: "", mode: "" };
  }

  /**
   * 按配置顺序遍历已启用的本地规则，返回首条命中的规则对象。
   * @param {string} url 当前网址
   * @param {Array} rules 规则列表
   * @returns {Object|null}
   */
  function matchRuleEngine(url, rules) {
    if (!url || !Array.isArray(rules)) return null;
    for (const rule of rules) {
      if (!rule.enabled || !rule.pattern) continue;
      if (testRulePattern(url, rule.pattern).matched) return rule;
    }
    return null;
  }

  /**
   * 根据命中的规则定义，在当前书签目录列表中定位最匹配的目标文件夹。
   * 查找顺序：二级子目录精确/包含匹配 → 一级主目录匹配 → 语义别名匹配 → 书签栏兜底。
   * @param {Object} rule 命中的规则对象
   * @param {Array} folders 扁平目录列表
   * @returns {Object|null}
   */
  function findFolderByRule(rule, folders) {
    if (!rule || !folders || !folders.length) return null;

    if (rule.targetFolder) {
      if (rule.targetSubfolder) {
        const subMatch = folders.find(
          f => f.title === rule.targetSubfolder || f.title.includes(rule.targetSubfolder)
        );
        if (subMatch) return subMatch;
      }
      const topMatch = folders.find(
        f => f.title === rule.targetFolder || f.title.includes(rule.targetFolder)
      );
      if (topMatch) return topMatch;
    }

    if (rule.semanticAlias) {
      const keywords = rule.semanticAlias
        .split("|")
        .map(k => k.trim().toLowerCase())
        .filter(Boolean);
      const matched = folders.find(f => {
        const lower = f.title.toLowerCase();
        return keywords.some(kw => lower.includes(kw));
      });
      if (matched) return matched;
    }

    return folders.find(f => f.id === "1") || folders[0] || null;
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.rules = {
    testRulePattern,
    matchRuleEngine,
    findFolderByRule
  };
})(typeof window !== "undefined" ? window : globalThis);
