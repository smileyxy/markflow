/**
 * 大模型多协议通信适配模块
 *
 * 统一封装 Google Gemini、Google Vertex AI、Anthropic Claude（/v1/messages）与
 * OpenAI 兼容协议（/chat/completions），并负责模型列表拉取、连通性检测及 JSON 容错提取。
 */

(function (global) {
  "use strict";

  const { PROVIDER_PRESETS } = global.MarkFlowModules.constants;

  /** 构造携带 HTTP 状态码的接口异常，便于上层精准归因 */
  function createApiError(message, status) {
    const err = new Error(message);
    if (status) err.status = status;
    return err;
  }

  /** 构造标准中断异常，用于用户主动取消请求时与普通网络/超时故障区分 */
  function createAbortError(message = "Operation aborted") {
    const err = new Error(message);
    err.name = "AbortError";
    return err;
  }

  /** 判断异常是否由 AbortSignal / AbortController 主动中止引发 */
  function isAbortError(err) {
    if (!err) return false;
    if (err.name === "AbortError" || err.code === 20) return true;
    const msg = String(err.message || err || "");
    return /aborted|AbortError/i.test(msg);
  }

  /** 裁剪并脱敏接口报错正文：去掉冗长的配额指标说明与文档外链，保留简短可读原因 */
  function sanitizeErrorExcerpt(raw, maxLen = 110) {
    const src = String(raw || "").trim();
    if (!src) return "";

    let text = src
      .replace(
        /(?:\b(?:For more information|To monitor your current|See\s+https?:\/\/|Please retry in)|\*\s*Quota exceeded)[\s\S]*/i,
        ""
      )
      .replace(/https?:\/\/\S+/gi, "")
      .replace(/\s+/g, " ")
      .replace(/[,;:*.\s]+$/g, "")
      .trim();

    if (!text) {
      text = src.replace(/https?:\/\/\S+/gi, "").replace(/\s+/g, " ").trim();
    }
    if (!text) return "";
    return text.length > maxLen ? `${text.slice(0, maxLen).trim()}…` : text;
  }

  /** 将原始接口异常归类为用户友好的错误类别与摘要键 */
  function classifyAiError(err) {
    const raw = String((err && err.message) || err || "").trim();
    const lower = raw.toLowerCase();
    const status = Number(err && err.status) || 0;
    const excerpt = sanitizeErrorExcerpt(raw);

    if (
      /exceeded your current quota|insufficient_quota|insufficient balance|credit balance|billing|free_tier|limit:\s*0|quota exceeded/.test(
        lower
      )
    ) {
      return { code: "quota", summaryKey: "pop_ai_err_quota", preferConfig: true, raw, excerpt };
    }
    if (
      status === 401 ||
      status === 403 ||
      /\b(401|403)\b|unauthorized|forbidden|invalid.?api.?key|api.?key.?not.?valid|unauthenticated|permission.?denied|authentication|oauth2|api keys are not supported/.test(
        lower
      )
    ) {
      return { code: "auth", summaryKey: "pop_ai_err_auth", preferConfig: true, raw, excerpt };
    }
    if (
      status === 404 ||
      /\b404\b|not.?found|does not exist|project_id|model.*empty|not configured|publisher model/.test(
        lower
      )
    ) {
      return { code: "model", summaryKey: "pop_ai_err_model", preferConfig: true, raw, excerpt };
    }
    if (status === 429 || /\b429\b|rate.?limit|too many requests|resource.?exhausted/.test(lower)) {
      return {
        code: "rate_limit",
        summaryKey: "pop_ai_err_rate_limit",
        preferConfig: false,
        raw,
        excerpt
      };
    }
    if (/abort|timeout|timed.?out/.test(lower)) {
      return { code: "timeout", summaryKey: "pop_ai_err_timeout", preferConfig: false, raw, excerpt };
    }
    if (/failed to fetch|network|connection|econn|dns/.test(lower)) {
      return { code: "network", summaryKey: "pop_ai_err_network", preferConfig: false, raw, excerpt };
    }
    if (
      status >= 500 ||
      /\b50[0234]\b|internal server|bad gateway|service unavailable|overloaded/.test(lower)
    ) {
      return { code: "server", summaryKey: "pop_ai_err_server", preferConfig: false, raw, excerpt };
    }
    if (/invalid json|empty model response/.test(lower)) {
      return {
        code: "response",
        summaryKey: "pop_ai_err_response",
        preferConfig: false,
        raw,
        excerpt
      };
    }
    return { code: "generic", summaryKey: "pop_ai_err_generic", preferConfig: false, raw, excerpt };
  }

  /** Vertex AI Express / 官方模型库默认候选列表（覆盖 Gemini 4 / 3.x / 2.5 GA 与 Preview） */
  const VERTEX_AI_CURATED_MODELS = [
    "gemini-4-carbon",
    "gemini-4-argon",
    "gemini-4-neon",
    "gemini-4-hydrogen",
    "gemini-3.8-flash",
    "gemini-3.7-flash",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro",
    "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview",
    "gemini-3-pro",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "gemini-2.5-flash-preview-05-20",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite"
  ];

  /**
   * 解析当前激活的服务商配置，合并用户保存值与默认预设。
   * @param {Object} aiConfig 存储中的 aiConfig 对象
   * @returns {Object}
   */
  function resolveActiveProviderConfig(aiConfig) {
    const cfg = aiConfig || {};
    const provider = cfg.provider || "deepseek";
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.deepseek;
    const saved = (cfg.providers && cfg.providers[provider]) || {};

    return {
      enabled: !!cfg.enabled,
      provider,
      providerLabel: preset.name,
      baseUrl: (saved.baseUrl || cfg.baseUrl || preset.baseUrl || "").trim(),
      apiKey: (saved.apiKey || cfg.apiKey || preset.apiKey || "").trim(),
      model: (saved.model || cfg.model || preset.model || "").trim(),
      vertexPriority: Boolean(
        saved.vertexPriority !== undefined ? saved.vertexPriority : cfg.vertexPriority
      )
    };
  }

  /** 官方支持 Vertex AI Priority PayGo 的端点主机及其可选权限模式 */
  const VERTEX_PRIORITY_OFFICIAL_HOSTS = new Map([
    ["aiplatform.googleapis.com", "https://aiplatform.googleapis.com/*"],
    ["us-aiplatform.googleapis.com", "https://us-aiplatform.googleapis.com/*"],
    ["eu-aiplatform.googleapis.com", "https://eu-aiplatform.googleapis.com/*"]
  ]);

  /** 解析 Base URL 对应的 Vertex AI Priority 支持情况与所需的官方可选域名权限 */
  function getVertexPriorityOriginInfo(baseUrl) {
    const raw = (baseUrl || "").trim();
    if (!raw) {
      return { supported: false, isOfficialGoogle: false, originPattern: "" };
    }
    let normalized = raw;
    if (!/^https?:\/\//i.test(normalized)) {
      normalized = `https://${normalized}`;
    }
    try {
      const host = new URL(normalized).hostname.toLowerCase();
      if (VERTEX_PRIORITY_OFFICIAL_HOSTS.has(host)) {
        return {
          supported: true,
          isOfficialGoogle: true,
          originPattern: VERTEX_PRIORITY_OFFICIAL_HOSTS.get(host)
        };
      }
      if (/(?:^|[.-])aiplatform\.googleapis\.com$/i.test(host)) {
        return { supported: false, isOfficialGoogle: true, originPattern: "" };
      }
      return { supported: true, isOfficialGoogle: false, originPattern: "" };
    } catch (e) {
      return { supported: false, isOfficialGoogle: false, originPattern: "" };
    }
  }

  /** 生成 Vertex AI Priority PayGo 专用请求头 */
  function buildVertexPriorityHeaders(enabled) {
    if (!enabled) return {};
    return {
      "X-Vertex-AI-LLM-Request-Type": "shared",
      "X-Vertex-AI-LLM-Shared-Request-Type": "priority"
    };
  }

  /** 判定 Base URL 是否指向 Google Vertex AI（官方或反代路径） */
  function isVertexAiUrl(baseUrl) {
    const clean = (baseUrl || "").trim().replace(/\/+$/, "");
    return (
      /aiplatform\.googleapis\.com/i.test(clean) ||
      /\/publishers\/google(\/models(\/[^/]+)?)?$/i.test(clean) ||
      /\/projects\/[^/]+\/locations\/[^/]+/i.test(clean)
    );
  }

  /**
   * 根据服务商标识与 Base URL 自动判定通信协议（gemini、vertex、anthropic 或 openai）。
   * 显式 OpenAI 路径（含 Vertex /endpoints/openapi 与 /openai 中转）优先走 openai 协议。
   */
  function detectProtocol(provider, baseUrl) {
    const clean = (baseUrl || "").trim().replace(/\/+$/, "");
    if (
      /\/chat\/completions$/i.test(clean) ||
      /\/endpoints\/openapi(\/chat\/completions)?$/i.test(clean) ||
      /\/openai(\/v1)?$/i.test(clean)
    ) {
      return "openai";
    }
    if (isVertexAiUrl(clean)) {
      return "vertex";
    }
    if (
      provider === "claude" ||
      /api\.anthropic\.com/i.test(clean) ||
      /\/v1\/messages$/i.test(clean)
    ) {
      return "anthropic";
    }
    if (provider === "gemini") {
      if (/\/v1$/i.test(clean) && !/googleapis\.com/i.test(clean)) {
        return "openai";
      }
      return "gemini";
    }
    if (/generativelanguage\.googleapis\.com\/v1(beta|alpha)?$/i.test(clean)) {
      return "gemini";
    }
    return "openai";
  }

  function normalizeGeminiBaseUrl(baseUrl) {
    let clean = (baseUrl || "https://generativelanguage.googleapis.com/v1beta")
      .trim()
      .replace(/\/+$/, "");

    // 剥离误粘贴的完整 :generateContent 或 /models 后缀，还原基础前缀
    clean = clean
      .replace(/\/models\/[^/]+:(?:stream)?generateContent$/i, "")
      .replace(/\/models\/[^/]+$/i, "")
      .replace(/\/models$/i, "");

    if (isVertexAiUrl(clean)) {
      if (/^https?:\/\/[^/]*aiplatform\.googleapis\.com$/i.test(clean)) {
        return `${clean}/v1/publishers/google`;
      }
      if (!/\/publishers\/google$/i.test(clean)) {
        if (
          /\/v1(?:beta\d*)?$/i.test(clean) ||
          /\/projects\/[^/]+\/locations\/[^/]+$/i.test(clean)
        ) {
          return `${clean}/publishers/google`;
        }
        if (/aiplatform\.googleapis\.com/i.test(clean) && !/\/v1/i.test(clean)) {
          return `${clean}/v1/publishers/google`;
        }
      }
      return clean;
    }

    if (!/\/v1(beta|alpha)?$/i.test(clean)) {
      clean = `${clean}/v1beta`;
    }
    return clean;
  }

  function normalizeAnthropicBaseUrl(baseUrl) {
    let clean = (baseUrl || "https://api.anthropic.com/v1")
      .trim()
      .replace(/\/+$/, "")
      .replace(/\/messages$/i, "");
    if (!/\/v\d+(?:beta\d*)?$/i.test(clean)) {
      clean = `${clean}/v1`;
    }
    return clean;
  }

  /** 构建 Gemini / Vertex AI 请求鉴权头（自动区分 OAuth Bearer Token 与 API Key） */
  function buildGeminiAuthHeaders(apiKey, includeContentType = true) {
    const headers = {};
    if (includeContentType) headers["Content-Type"] = "application/json";
    const raw = (apiKey || "").trim();
    if (!raw) return headers;
    if (/^Bearer\s+/i.test(raw)) {
      headers["Authorization"] = raw;
    } else if (/^ya29\./i.test(raw)) {
      headers["Authorization"] = `Bearer ${raw}`;
    } else {
      headers["x-goog-api-key"] = raw;
    }
    return headers;
  }

  /** 构建 Anthropic Claude 原生接口请求头（含浏览器直接访问必需请求头） */
  function buildAnthropicHeaders(apiKey, includeContentType = true) {
    const headers = {
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
    };
    if (includeContentType) headers["Content-Type"] = "application/json";
    const raw = (apiKey || "").trim();
    if (raw) headers["x-api-key"] = raw;
    return headers;
  }

  /** 为 OpenRouter 请求附带标准来源标识 */
  function applyOpenRouterHeaders(headers, baseUrl) {
    if (/openrouter\.ai/i.test(baseUrl || "")) {
      headers["HTTP-Referer"] = "https://markflow.smileyxy.dpdns.org/";
      headers["X-Title"] = "MarkFlow AI";
    }
    return headers;
  }

  /** 按最新世代与高性价比优先级对远程拉取的模型 ID 排序 */
  function prioritizeModelIds(ids) {
    const unique = Array.from(new Set(ids));
    const scoreModel = id => {
      const s = id.toLowerCase();
      let score = 0;
      if (/hydrogen|flash|lite|luna|mini|nano|a3b|8b|9b|turbo|haiku|fast/i.test(s)) score += 30;
      if (
        /gemini-[4-9]|gemini-3\.8|gemini-3\.5|gpt-[6-9]|claude-(?:[a-z]+-)?[5-9]|claude-sonnet-4|claude-haiku-4|grok-[4-9]|deepseek-v[4-9]|deepseek-flash|qwen[3-9]|glm-[5-9]/i.test(
          s
        )
      ) {
        score += 40;
      }
      if (/preview|exp|legacy|0301|0613/i.test(s)) score -= 15;
      return score;
    };
    return unique.sort((a, b) => scoreModel(b) - scoreModel(a) || a.localeCompare(b));
  }

  /**
   * 校验并返回规范化后的 Gemini / Vertex AI 基础端点，未替换占位符时给出明确提示。
   */
  function resolveGeminiEndpointBase(baseUrl) {
    const cleanBase = normalizeGeminiBaseUrl(baseUrl);
    if (/\/projects\/PROJECT_ID\//i.test(cleanBase)) {
      throw new Error("Vertex AI: Please replace PROJECT_ID in Base URL with your Google Cloud project ID.");
    }
    return cleanBase;
  }

  /** 会话级 Express -> locations/global 路由映射缓存（key: cleanBase|apiKey） */
  const vertexGlobalBaseCache = new Map();

  function isOfficialVertexExpressBase(cleanBase) {
    return /^https?:\/\/[^/]*aiplatform\.googleapis\.com\/v1(?:beta\d*)?\/publishers\/google$/i.test(
      cleanBase || ""
    );
  }

  function getVertexCacheKey(cleanBase, apiKey) {
    return `${cleanBase || ""}|${(apiKey || "").trim()}`;
  }

  function getCachedVertexGlobalBase(cleanBase, apiKey) {
    if (!isOfficialVertexExpressBase(cleanBase)) return "";
    return vertexGlobalBaseCache.get(getVertexCacheKey(cleanBase, apiKey)) || "";
  }

  function rememberVertexGlobalBase(cleanBase, apiKey, globalBase) {
    if (isOfficialVertexExpressBase(cleanBase) && globalBase) {
      vertexGlobalBaseCache.set(getVertexCacheKey(cleanBase, apiKey), globalBase);
    }
  }

  /**
   * 当 Vertex AI Express 端点被默认路由到区域（如 locations/us-central1）并因模型仅存于 global 返回 404 时，
   * 从 Google 错误文本中提取项目编号，推导对应的 locations/global 端点。
   */
  function deriveVertexGlobalBaseFromError(cleanBase, errMsg) {
    if (!isOfficialVertexExpressBase(cleanBase)) return "";
    const m = String(errMsg || "").match(
      /projects\/([A-Za-z0-9._-]+)\/locations\/(?!global\b)[A-Za-z0-9._-]+\/publishers\/google/i
    );
    if (!m) return "";
    return cleanBase.replace(
      /\/publishers\/google$/i,
      `/projects/${encodeURIComponent(m[1])}/locations/global/publishers/google`
    );
  }

  /**
   * 统一执行 Gemini / Vertex POST 请求：若官方 Express 端点在区域路由遇 404，则透明升级至 locations/global 并缓存。
   */
  async function postGeminiWithVertexRouting({
    cleanBase,
    apiKey,
    encodedModel,
    action,
    isVertex,
    headers,
    body,
    signal = null
  }) {
    const cachedGlobal = isVertex ? getCachedVertexGlobalBase(cleanBase, apiKey) : "";
    let effectiveBase = cachedGlobal || cleanBase;
    let endpoint = `${effectiveBase}/models/${encodedModel}:${action}`;

    const doPost = targetEndpoint =>
      fetch(
        targetEndpoint,
        signal ? { method: "POST", headers, body, signal } : { method: "POST", headers, body }
      );

    let res = await doPost(endpoint);
    let cachedErrJson = null;

    if (isVertex && res.status === 404) {
      cachedErrJson = await res.json().catch(() => null);
      const msg = (cachedErrJson && cachedErrJson.error && cachedErrJson.error.message) || "";
      let fallbackBase = "";

      if (effectiveBase === cleanBase) {
        fallbackBase = deriveVertexGlobalBaseFromError(cleanBase, msg);
        if (fallbackBase) {
          rememberVertexGlobalBase(cleanBase, apiKey, fallbackBase);
        }
      } else {
        fallbackBase = cleanBase;
      }

      if (fallbackBase && fallbackBase !== effectiveBase) {
        if (signal && signal.aborted) throw createAbortError();
        effectiveBase = fallbackBase;
        endpoint = `${effectiveBase}/models/${encodedModel}:${action}`;
        res = await doPost(endpoint);
        cachedErrJson = null;
      }
    }

    return { res, endpoint, cachedErrJson };
  }

  function extractGeminiStyleModelIds(data) {
    const rawModels = Array.isArray(data && data.models)
      ? data.models
      : Array.isArray(data && data.publisherModels)
        ? data.publisherModels
        : Array.isArray(data && data.data)
          ? data.data
          : [];
    return rawModels
      .filter(m => {
        const name = typeof m === "string" ? m : m.id || m.name || "";
        const methods = m && m.supportedGenerationMethods;
        const supportsGen = !Array.isArray(methods) || methods.includes("generateContent");
        return name && supportsGen && !/embedding|imagen|veo|aqa|tts|audio/i.test(name);
      })
      .map(m =>
        String(typeof m === "string" ? m : m.id || m.name || "").replace(
          /^(?:publishers\/google\/)?models\//i,
          ""
        )
      )
      .filter(Boolean);
  }

  /**
   * 静默查询 Google 官方 Gemini API 在线模型列表，用于补充最新发布的模型 ID 到 Vertex 探测候选池。
   * 仅访问 Google 一方官方域名 generativelanguage.googleapis.com，任一错误均安全忽略并回退为空。
   */
  async function discoverGoogleFirstPartyModels(apiKey) {
    const useTimeout =
      typeof AbortController === "function" && typeof setTimeout === "function";
    const ctrl = useTimeout ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 4000) : null;
    try {
      const res = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
        ctrl
          ? { method: "GET", headers: buildGeminiAuthHeaders(apiKey, false), signal: ctrl.signal }
          : { method: "GET", headers: buildGeminiAuthHeaders(apiKey, false) }
      );
      if (!res.ok) return [];
      const data = await res.json().catch(() => ({}));
      return extractGeminiStyleModelIds(data);
    } catch (e) {
      return [];
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * 针对用户手动输入的单个模型 ID，通过免费 POST :countTokens 接口实时验证是否在当前 Vertex AI 密钥下可用。
   */
  async function probeSingleVertexModel({ baseUrl, apiKey, modelId }) {
    const cleanBase = resolveGeminiEndpointBase(baseUrl);
    const cleanId = String(modelId || "")
      .trim()
      .replace(/^(?:publishers\/google\/)?models\//i, "")
      .replace(/:(?:stream)?generateContent$/i, "");
    if (!cleanId) {
      throw new Error("Vertex AI: Model ID cannot be empty.");
    }

    const headers = buildGeminiAuthHeaders(apiKey, true);
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "ok" }] }]
    });
    const useTimeout =
      typeof AbortController === "function" && typeof setTimeout === "function";
    const ctrl = useTimeout ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;

    try {
      const { res, cachedErrJson } = await postGeminiWithVertexRouting({
        cleanBase,
        apiKey,
        encodedModel: encodeURIComponent(cleanId),
        action: "countTokens",
        isVertex: true,
        headers,
        body,
        signal: ctrl ? ctrl.signal : null
      });
      if (res.ok) return cleanId;
      const errJson = cachedErrJson || (await res.json().catch(() => null));
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `HTTP ${res.status}: ${res.statusText}`;
      throw new Error(`Vertex AI: ${msg}`);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * 针对 Google Vertex AI Express API Key 等不支持 GET /models 枚举列表的凭证，
   * 并行调用零计费 POST :countTokens 接口实测当前密钥下可用模型；若区域路由导致 404，自动升级至 locations/global 二轮补测。
   */
  async function probeVertexAvailableModels({ cleanBase, apiKey, extraModels = [] }) {
    const cleanModelId = raw =>
      String(raw || "")
        .trim()
        .replace(/^(?:publishers\/google\/)?models\//i, "")
        .replace(/:(?:stream)?generateContent$/i, "");

    const candidateSet = new Set();
    for (const raw of [...extraModels, ...VERTEX_AI_CURATED_MODELS]) {
      const cleaned = cleanModelId(raw);
      if (cleaned) candidateSet.add(cleaned);
    }
    const candidates = Array.from(candidateSet);
    if (candidates.length === 0) return [];

    const headers = buildGeminiAuthHeaders(apiKey, true);
    const body = JSON.stringify({
      contents: [{ role: "user", parts: [{ text: "ok" }] }]
    });
    const useTimeout =
      typeof AbortController === "function" && typeof setTimeout === "function";

    const runProbeBatch = async (targetBase, modelIds) => {
      const verified = [];
      const notFound = [];
      let discoveredGlobalBase = "";
      let authErrorMsg = "";
      let lastErrMsg = "";

      await Promise.all(
        modelIds.map(async modelId => {
          const endpoint = `${targetBase}/models/${encodeURIComponent(modelId)}:countTokens`;
          const ctrl = useTimeout ? new AbortController() : null;
          const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null;
          try {
            const res = await fetch(
              endpoint,
              ctrl
                ? { method: "POST", headers, body, signal: ctrl.signal }
                : { method: "POST", headers, body }
            );
            if (res.ok) {
              verified.push(modelId);
              return;
            }
            const errJson = await res.json().catch(() => null);
            const msg =
              (errJson && errJson.error && errJson.error.message) ||
              `HTTP ${res.status}: ${res.statusText}`;
            const errStatus = (errJson && errJson.error && errJson.error.status) || "";
            lastErrMsg = msg;

            if (res.status === 404) {
              notFound.push(modelId);
              if (!discoveredGlobalBase && targetBase === cleanBase) {
                discoveredGlobalBase = deriveVertexGlobalBaseFromError(cleanBase, msg);
              }
            }

            const isCredentialErr =
              res.status === 401 ||
              res.status === 403 ||
              (res.status === 400 &&
                (/API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED/i.test(errStatus) ||
                  /api\s*key|unauthenticated|permission|credential|not supported/i.test(msg)));
            if (isCredentialErr && !authErrorMsg) {
              authErrorMsg = msg;
            }
          } catch (err) {
            lastErrMsg = err && err.message ? err.message : String(err);
          } finally {
            if (timer !== null) clearTimeout(timer);
          }
        })
      );

      return { verified, notFound, discoveredGlobalBase, authErrorMsg, lastErrMsg };
    };

    const cachedGlobal = getCachedVertexGlobalBase(cleanBase, apiKey);
    const initialBase = cachedGlobal || cleanBase;
    const pass1 = await runProbeBatch(initialBase, candidates);

    const verifiedIds = [...pass1.verified];
    let authErrorMsg = pass1.authErrorMsg;
    let lastErrMsg = pass1.lastErrMsg;
    let ranPass2 = false;
    let pass2NotFound = 0;

    if (initialBase === cleanBase && pass1.discoveredGlobalBase && pass1.notFound.length > 0) {
      rememberVertexGlobalBase(cleanBase, apiKey, pass1.discoveredGlobalBase);
      ranPass2 = true;
      const pass2 = await runProbeBatch(pass1.discoveredGlobalBase, pass1.notFound);
      verifiedIds.push(...pass2.verified);
      pass2NotFound = pass2.notFound.length;
      if (!authErrorMsg && pass2.authErrorMsg) authErrorMsg = pass2.authErrorMsg;
      if (pass2.lastErrMsg) lastErrMsg = pass2.lastErrMsg;
    } else if (initialBase !== cleanBase && pass1.notFound.length > 0) {
      ranPass2 = true;
      const pass2 = await runProbeBatch(cleanBase, pass1.notFound);
      verifiedIds.push(...pass2.verified);
      pass2NotFound = pass2.notFound.length;
      if (!authErrorMsg && pass2.authErrorMsg) authErrorMsg = pass2.authErrorMsg;
      if (pass2.lastErrMsg) lastErrMsg = pass2.lastErrMsg;
    }

    if (verifiedIds.length > 0) {
      const sorted = prioritizeModelIds(verifiedIds);
      sorted.isVertexProbed = true;
      return sorted;
    }
    if (authErrorMsg) {
      throw new Error(`Vertex AI: ${authErrorMsg}`);
    }
    const allStillNotFound =
      pass1.notFound.length === candidates.length &&
      (!ranPass2 || pass2NotFound === pass1.notFound.length);
    if (allStillNotFound) {
      const fallback = prioritizeModelIds(VERTEX_AI_CURATED_MODELS);
      fallback.isFallbackCatalog = true;
      return fallback;
    }
    throw new Error(`Vertex AI: ${lastErrMsg || "Model availability probe failed"}`);
  }

  /**
   * 从目标接口动态拉取可用的对话生成模型列表（自动过滤嵌入、语音、生图等非对话模型）。
   */
  async function fetchAvailableModels({
    provider,
    baseUrl,
    apiKey,
    currentModel = "",
    extraModels = []
  }) {
    const protocol = detectProtocol(provider, baseUrl);

    if (protocol === "anthropic") {
      const cleanBase = normalizeAnthropicBaseUrl(baseUrl);
      const res = await fetch(`${cleanBase}/models?limit=100`, {
        method: "GET",
        headers: buildAnthropicHeaders(apiKey, false)
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const msg =
          (errJson && errJson.error && errJson.error.message) ||
          `HTTP ${res.status}: ${res.statusText}`;
        throw createApiError(msg, res.status);
      }
      const data = await res.json();
      const ids = (Array.isArray(data.data) ? data.data : [])
        .map(m => (typeof m === "string" ? m : m.id || m.name || ""))
        .filter(Boolean);
      return prioritizeModelIds(ids);
    }

    if (protocol === "vertex") {
      const cleanBase = resolveGeminiEndpointBase(baseUrl);
      const rawKey = (apiKey || "").trim();
      const isOAuth = /^Bearer\s+/i.test(rawKey) || /^ya29\./i.test(rawKey);
      const isOfficialVertex = /aiplatform\.googleapis\.com/i.test(cleanBase);
      const mergedExtra = [
        ...(Array.isArray(extraModels) ? extraModels : []),
        ...(currentModel ? [currentModel] : [])
      ];

      // 官方 Vertex AI Express API Key 禁止访问 GET /models：
      // 合并一方在线清单 + 历史自定义探测记录 + 内置 Gemini 4/3/2.5 候选，再并行免费 :countTokens 实测
      if (isOfficialVertex && !isOAuth) {
        const discovered = await discoverGoogleFirstPartyModels(apiKey);
        return probeVertexAvailableModels({
          cleanBase,
          apiKey,
          extraModels: [...mergedExtra, ...discovered]
        });
      }

      const defaultHeaders = buildGeminiAuthHeaders(apiKey, false);
      const probes = [{ url: `${cleanBase}/models?pageSize=200`, headers: defaultHeaders }];

      if (/\/v1\//i.test(cleanBase)) {
        probes.push({
          url: `${cleanBase.replace(/\/v1\//i, "/v1beta1/")}/models?pageSize=200`,
          headers: defaultHeaders
        });
      }

      if (!/googleapis\.com/i.test(cleanBase)) {
        try {
          const origin = new URL(cleanBase).origin;
          probes.push({ url: `${origin}/v1/models`, headers: defaultHeaders });
          if (apiKey && !/^Bearer\s+/i.test(apiKey)) {
            probes.push({
              url: `${origin}/v1/models`,
              headers: { Authorization: `Bearer ${apiKey}` }
            });
          }
        } catch (e) {}
      }

      let lastErrMsg = "";
      let onlyUnsupportedOrMissing = true;

      for (const probe of probes) {
        try {
          const res = await fetch(probe.url, { method: "GET", headers: probe.headers });
          if (res.ok) {
            const data = await res.json().catch(() => ({}));
            const ids = extractGeminiStyleModelIds(data);
            if (ids.length > 0) {
              return prioritizeModelIds(ids);
            }
            continue;
          }
          if (res.status !== 401 && res.status !== 403 && res.status !== 404) {
            onlyUnsupportedOrMissing = false;
          }
          const errJson = await res.json().catch(() => null);
          lastErrMsg =
            (errJson && errJson.error && errJson.error.message) ||
            `HTTP ${res.status}: ${res.statusText}`;
        } catch (netErr) {
          onlyUnsupportedOrMissing = false;
          lastErrMsg = netErr && netErr.message ? netErr.message : String(netErr);
        }
      }

      // 若 GET /models 返回 401/403/404，自动通过免费 :countTokens 探测或反代降级目录解析
      if (onlyUnsupportedOrMissing) {
        return probeVertexAvailableModels({ cleanBase, apiKey, extraModels: mergedExtra });
      }
      throw new Error(lastErrMsg || "Vertex AI /models request failed");
    }

    if (protocol === "gemini") {
      const cleanBase = resolveGeminiEndpointBase(baseUrl);
      const res = await fetch(`${cleanBase}/models?pageSize=200`, {
        method: "GET",
        headers: buildGeminiAuthHeaders(apiKey, false)
      });
      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const msg =
          (errJson && errJson.error && errJson.error.message) ||
          `HTTP ${res.status}: ${res.statusText}`;
        throw createApiError(msg, res.status);
      }
      const data = await res.json();
      return prioritizeModelIds(extractGeminiStyleModelIds(data));
    }

    let cleanBase = (baseUrl || "").trim().replace(/\/+$/, "");
    cleanBase = cleanBase.replace(/\/chat\/completions$/i, "");
    const endpoint = /\/models$/i.test(cleanBase) ? cleanBase : `${cleanBase}/models`;

    const headers = applyOpenRouterHeaders({}, cleanBase);
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(endpoint, { method: "GET", headers });
    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `HTTP ${res.status}: ${res.statusText}`;
      throw createApiError(msg, res.status);
    }

    const data = await res.json();
    const list = Array.isArray(data.data)
      ? data.data
      : Array.isArray(data.models)
        ? data.models
        : [];
    const ids = list
      .map(item => (typeof item === "string" ? item : item.id || item.name || ""))
      .filter(
        id =>
          id &&
          !/embed|rerank|whisper|tts|speech|moderation|dall-e|flux|stable-diffusion|bge-|bce-/i.test(
            id
          )
      );

    return prioritizeModelIds(ids);
  }

  /**
   * 从模型原始文本中稳健提取 JSON 对象或数组，兼容思考标签及 Markdown 代码块包裹。
   */
  function extractJsonFromText(raw) {
    if (!raw) throw new Error("Empty model response");
    let text = String(raw).trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    if (text.startsWith("```")) {
      text = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      const firstBrace = text.indexOf("{");
      const firstBracket = text.indexOf("[");
      if (firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace)) {
        const arrMatch = text.match(/\[[\s\S]*\]/);
        if (arrMatch) {
          try {
            return JSON.parse(arrMatch[0]);
          } catch (e2) {}
        }
      }
      const objMatch = text.match(/\{[\s\S]*\}/);
      if (objMatch) {
        try {
          return JSON.parse(objMatch[0]);
        } catch (e3) {}
      }
      throw new Error("Invalid JSON output: " + text.slice(0, 80));
    }
  }

  async function callGeminiNative({
    provider,
    baseUrl,
    apiKey,
    model,
    systemPrompt,
    userPrompt,
    jsonSchema,
    vertexPriority = false,
    signal = null
  }) {
    if (signal && signal.aborted) throw createAbortError();
    const cleanBase = resolveGeminiEndpointBase(baseUrl);
    const isVertex = isVertexAiUrl(cleanBase);
    const cleanModel = (model || "gemini-3.8-flash")
      .trim()
      .replace(/^(?:publishers\/google\/)?models\//i, "")
      .replace(/:generateContent$/i, "");

    const encodedModel = encodeURIComponent(cleanModel);
    const isFlash25 = /^gemini-2\.5-flash/i.test(cleanModel);

    const generationConfig = {
      temperature: 0,
      responseMimeType: "application/json"
    };
    if (jsonSchema) {
      generationConfig.responseSchema = jsonSchema;
    }
    if (isFlash25) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }

    const primaryPayload = {
      ...(systemPrompt ? { systemInstruction: { parts: [{ text: systemPrompt }] } } : {}),
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig
    };

    const useVertexPriority = Boolean(isVertex && (!provider || provider === "gemini") && vertexPriority);
    const headers = Object.assign(
      buildGeminiAuthHeaders(apiKey, true),
      buildVertexPriorityHeaders(useVertexPriority)
    );

    let { res, endpoint, cachedErrJson } = await postGeminiWithVertexRouting({
      cleanBase,
      apiKey,
      encodedModel,
      action: "generateContent",
      isVertex,
      headers,
      body: JSON.stringify(primaryPayload),
      signal
    });

    // 若特定模型或反代不支持 responseSchema / systemInstruction，则逐级降级重试（保留 role 以兼容 Vertex AI）
    if (res.status === 400) {
      if (signal && signal.aborted) throw createAbortError();
      cachedErrJson = null;
      const combinedPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: combinedPrompt }] }],
          generationConfig: {
            temperature: 0,
            responseMimeType: "application/json"
          }
        }),
        ...(signal ? { signal } : {})
      });

      if (res.status === 400) {
        if (signal && signal.aborted) throw createAbortError();
        res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: combinedPrompt }] }]
          }),
          ...(signal ? { signal } : {})
        });
      }
    }

    if (!res.ok) {
      const errJson = cachedErrJson || (await res.json().catch(() => null));
      const detail =
        (errJson && errJson.error && errJson.error.message) ||
        res.statusText ||
        "Request failed";
      throw createApiError(`${isVertex ? "Vertex AI" : "Gemini API"} (${res.status}): ${detail}`, res.status);
    }

    const data = await res.json();
    const parts =
      (data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts) ||
      [];
    const rawText = parts
      .filter(p => !p.thought && typeof p.text === "string")
      .map(p => p.text)
      .join("\n")
      .trim();

    return extractJsonFromText(rawText);
  }

  async function callOpenAICompatible({ baseUrl, apiKey, model, systemPrompt, userPrompt, signal = null }) {
    if (signal && signal.aborted) throw createAbortError();
    const cleanBase = (baseUrl || "").trim().replace(/\/+$/, "");
    const endpoint = /\/chat\/completions$/i.test(cleanBase)
      ? cleanBase
      : `${cleanBase}/chat/completions`;

    // 推理系模型通常不接受显式 temperature 或 response_format 参数
    const isReasoning = /o1|o3|o4|reasoner|reasoning|luna|terra|sol|astra|deepseek-r1|\br1\b/i.test(
      model || ""
    );
    const messages = systemPrompt
      ? [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ]
      : [{ role: "user", content: userPrompt }];

    const body = { model, messages };
    if (!isReasoning) {
      body.temperature = 0;
      body.response_format = { type: "json_object" };
    }

    const headers = applyOpenRouterHeaders({ "Content-Type": "application/json" }, cleanBase);
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    let res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });

    // 参数不兼容导致 400 时，合并为单条 user 消息进行最简兼容请求
    if (res.status === 400) {
      if (signal && signal.aborted) throw createAbortError();
      const mergedPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: mergedPrompt }]
        }),
        ...(signal ? { signal } : {})
      });
    }

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `${res.status} ${res.statusText}`;
      throw createApiError(`AI API (${res.status}): ${msg}`, res.status);
    }

    const data = await res.json();
    const rawText =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      "";
    return extractJsonFromText(rawText);
  }

  async function callAnthropicNative({ baseUrl, apiKey, model, systemPrompt, userPrompt, signal = null }) {
    if (signal && signal.aborted) throw createAbortError();
    const cleanBase = normalizeAnthropicBaseUrl(baseUrl);
    const endpoint = `${cleanBase}/messages`;
    const body = {
      model: model || "claude-haiku-5-5",
      max_tokens: 4096,
      temperature: 0,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: [{ role: "user", content: userPrompt }]
    };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: buildAnthropicHeaders(apiKey, true),
      body: JSON.stringify(body),
      ...(signal ? { signal } : {})
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `${res.status} ${res.statusText}`;
      throw createApiError(`Claude API (${res.status}): ${msg}`, res.status);
    }

    const data = await res.json();
    const rawText = (Array.isArray(data.content) ? data.content : [])
      .filter(block => block && block.type === "text" && typeof block.text === "string")
      .map(block => block.text)
      .join("\n")
      .trim();
    return extractJsonFromText(rawText);
  }

  /** 统一模型调用入口，按协议路由至对应适配器 */
  async function callLLM(params) {
    const protocol = detectProtocol(params.provider, params.baseUrl);
    if (protocol === "gemini" || protocol === "vertex") {
      return callGeminiNative(params);
    }
    if (protocol === "anthropic") {
      return callAnthropicNative(params);
    }
    return callOpenAICompatible(params);
  }

  /** 发送最小探测消息验证接口地址、密钥与模型 ID 是否可用 */
  async function testAIConnection({
    provider,
    baseUrl,
    apiKey,
    model,
    vertexPriority = false,
    onMeta = null
  }) {
    const protocol = detectProtocol(provider, baseUrl);
    if (protocol === "anthropic") {
      const cleanBase = normalizeAnthropicBaseUrl(baseUrl);
      const endpoint = `${cleanBase}/messages`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: buildAnthropicHeaders(apiKey, true),
        body: JSON.stringify({
          model: model || "claude-haiku-5-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with OK" }]
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const msg =
          (errJson && errJson.error && errJson.error.message) ||
          `HTTP ${res.status}: ${res.statusText}`;
        throw createApiError(msg, res.status);
      }

      const data = await res.json();
      const text = (Array.isArray(data.content) ? data.content : [])
        .filter(b => b && b.type === "text" && b.text)
        .map(b => b.text)
        .join("")
        .trim();
      return text || "OK";
    }

    if (protocol === "gemini" || protocol === "vertex") {
      const cleanBase = resolveGeminiEndpointBase(baseUrl);
      const isVertex = protocol === "vertex" || isVertexAiUrl(cleanBase);
      const cleanModel = (model || "gemini-3.8-flash")
        .trim()
        .replace(/^(?:publishers\/google\/)?models\//i, "")
        .replace(/:generateContent$/i, "");
      const encodedModel = encodeURIComponent(cleanModel);

      const payload = { contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }] };
      if (/^gemini-2\.5-flash/i.test(cleanModel)) {
        payload.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
      }

      const useVertexPriority = Boolean(isVertex && provider === "gemini" && vertexPriority);
      const headers = Object.assign(
        buildGeminiAuthHeaders(apiKey, true),
        buildVertexPriorityHeaders(useVertexPriority)
      );

      let { res, endpoint, cachedErrJson } = await postGeminiWithVertexRouting({
        cleanBase,
        apiKey,
        encodedModel,
        action: "generateContent",
        isVertex,
        headers,
        body: JSON.stringify(payload)
      });

      if (res.status === 400 && payload.generationConfig) {
        cachedErrJson = null;
        res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }] })
        });
      }

      if (!res.ok) {
        const errJson = cachedErrJson || (await res.json().catch(() => null));
        const msg =
          (errJson && errJson.error && errJson.error.message) ||
          `HTTP ${res.status}: ${res.statusText}`;
        throw createApiError(msg, res.status);
      }

      const data = await res.json();
      const trafficType = String((data && data.usageMetadata && data.usageMetadata.trafficType) || "");
      if (typeof onMeta === "function") {
        onMeta({ trafficType, priorityRequested: useVertexPriority });
      }
      const parts =
        (data.candidates &&
          data.candidates[0] &&
          data.candidates[0].content &&
          data.candidates[0].content.parts) ||
        [];
      const reply = parts
        .filter(p => !p.thought && p.text)
        .map(p => p.text)
        .join("")
        .trim();
      return reply || "OK";
    }

    const cleanBase = (baseUrl || "").trim().replace(/\/+$/, "");
    const endpoint = /\/chat\/completions$/i.test(cleanBase)
      ? cleanBase
      : `${cleanBase}/chat/completions`;
    const headers = applyOpenRouterHeaders({ "Content-Type": "application/json" }, cleanBase);
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Hi" }]
      })
    });

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `HTTP ${res.status}: ${res.statusText}`;
      throw createApiError(msg, res.status);
    }

    const data = await res.json();
    return (
      (data.choices &&
        data.choices[0] &&
        data.choices[0].message &&
        data.choices[0].message.content &&
        data.choices[0].message.content.trim()) ||
      "OK"
    );
  }

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.llm = {
    VERTEX_AI_CURATED_MODELS,
    VERTEX_PRIORITY_OFFICIAL_ORIGINS: Array.from(VERTEX_PRIORITY_OFFICIAL_HOSTS.values()),
    resolveActiveProviderConfig,
    isVertexAiUrl,
    getVertexPriorityOriginInfo,
    buildVertexPriorityHeaders,
    detectProtocol,
    normalizeGeminiBaseUrl,
    deriveVertexGlobalBaseFromError,
    buildGeminiAuthHeaders,
    buildAnthropicHeaders,
    fetchAvailableModels,
    probeSingleVertexModel,
    callLLM,
    testAIConnection,
    extractJsonFromText,
    sanitizeErrorExcerpt,
    classifyAiError,
    isAbortError
  };
})(typeof window !== "undefined" ? window : globalThis);
