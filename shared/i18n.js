/**
 * MarkFlow 多语言本地化运行时
 *
 * 支持 7 套完整语言包：简体中文（zh_CN）、繁體中文（zh_TW，同时覆盖台湾与港澳地区）、
 * English（en）、日本語（ja）、한국어（ko）、Deutsch（de）、Español（es）。
 * 各语言词典拆分存放于 shared/locales/*.js，通过 register() 按需注册。
 */

(function (global) {
  "use strict";

  const I18N_DICTIONARY = {};

  /**
   * 注册指定语言区域的文案词典。
   * @param {string} locale 语言代码（如 zh_CN、zh_TW、en 等）
   * @param {Object<string, string>} messages 键值文案表
   */
  function register(locale, messages) {
    if (!locale || !messages) return;
    I18N_DICTIONARY[locale] = Object.assign(I18N_DICTIONARY[locale] || {}, messages);
  }

  /**
   * 根据用户已选语言或浏览器系统语言解析最终生效的语言代码。
   * 繁体中文区域（zh-TW、zh-HK、zh-MO、zh-Hant）统一映射至 zh_TW。
   * @param {string} savedLang 存储的语言标识
   * @returns {string} 已注册的语言代码
   */
  function resolveDisplayLanguage(savedLang) {
    if (savedLang && I18N_DICTIONARY[savedLang]) return savedLang;
    if (savedLang && /^zh[-_](hk|mo|tw|hant)/i.test(savedLang)) return "zh_TW";

    const nav = (typeof navigator !== "undefined" && navigator.language ? navigator.language : "en").toLowerCase();
    if (/^zh[-_](tw|hk|mo|hant)/.test(nav)) return "zh_TW";
    if (nav.startsWith("zh")) return "zh_CN";
    if (nav.startsWith("ja")) return "ja";
    if (nav.startsWith("ko")) return "ko";
    if (nav.startsWith("de")) return "de";
    if (nav.startsWith("es")) return "es";
    return "en";
  }

  /**
   * 获取本地化字符串并支持 `{key}` 占位符插值。
   * 第三参数可传插值对象（如 `{ count: 12 }`）或兜底文案字符串。
   * @param {string} lang 目标语言代码
   * @param {string} key 文案键名
   * @param {Object|string} [varsOrFallback] 插值参数对象或兜底文案
   * @returns {string}
   */
  function getLocaleString(lang, key, varsOrFallback) {
    const effective = resolveDisplayLanguage(lang);
    const dict = I18N_DICTIONARY[effective] || I18N_DICTIONARY.en || {};
    const fallbackText = typeof varsOrFallback === "string" ? varsOrFallback : "";
    let template =
      dict[key] ||
      (I18N_DICTIONARY.en && I18N_DICTIONARY.en[key]) ||
      (I18N_DICTIONARY.zh_CN && I18N_DICTIONARY.zh_CN[key]) ||
      fallbackText ||
      key;

    if (varsOrFallback && typeof varsOrFallback === "object") {
      template = template.replace(/\{(\w+)\}/g, (_, k) =>
        varsOrFallback[k] !== undefined && varsOrFallback[k] !== null ? String(varsOrFallback[k]) : ""
      );
    }
    return template;
  }

  /**
   * 批量将词典文案应用到当前文档的 data-i18n 与 data-i18n-placeholder 节点。
   * @param {string} lang 目标语言代码
   */
  function applyI18nToDocument(lang) {
    const effective = resolveDisplayLanguage(lang);
    const dict = I18N_DICTIONARY[effective] || I18N_DICTIONARY.en || {};
    const htmlLangMap = {
      zh_CN: "zh-CN",
      zh_TW: "zh-Hant",
      en: "en",
      ja: "ja",
      ko: "ko",
      de: "de",
      es: "es"
    };
    if (typeof document !== "undefined") {
      document.documentElement.lang = htmlLangMap[effective] || "en";

      document.querySelectorAll("[data-i18n]").forEach(el => {
        const key = el.getAttribute("data-i18n");
        if (dict[key]) el.textContent = dict[key];
      });

      document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
        const key = el.getAttribute("data-i18n-placeholder");
        if (dict[key]) el.placeholder = dict[key];
      });
    }
  }

  global.I18N_DICTIONARY = I18N_DICTIONARY;
  global.resolveDisplayLanguage = resolveDisplayLanguage;
  global.getLocaleString = getLocaleString;
  global.applyI18nToDocument = applyI18nToDocument;
  global.MarkFlowI18n = {
    register,
    dictionary: I18N_DICTIONARY,
    resolveDisplayLanguage,
    t: getLocaleString,
    applyToDocument: applyI18nToDocument
  };
})(typeof window !== "undefined" ? window : globalThis);
