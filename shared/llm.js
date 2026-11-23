/**
 * 大模型双协议通信适配模块
 *
 * 统一封装 Google Gemini 原生协议（v1beta generateContent）与
 * OpenAI 兼容协议（/chat/completions），并负责模型列表拉取、连通性检测及 JSON 容错提取。
 */

(function (global) {
  "use strict";

  const { PROVIDER_PRESETS } = global.MarkFlowModules.constants;

  /**
   * 解析当前激活的服务商配置，合并用户保存值与默认预设。
   * @param {Object} aiConfig 存储中的 aiConfig 对象
   * @returns {Object}
   */
  function resolveActiveProviderConfig(aiConfig) {
    const cfg = aiConfig || {};
    const provider = cfg.provider || "siliconflow";
    const preset = PROVIDER_PRESETS[provider] || PROVIDER_PRESETS.siliconflow;
    const saved = (cfg.providers && cfg.providers[provider]) || {};

    return {
      enabled: !!cfg.enabled,
      provider,
      providerLabel: preset.name,
      baseUrl: (saved.baseUrl || cfg.baseUrl || preset.baseUrl || "").trim(),
      apiKey: (saved.apiKey || cfg.apiKey || preset.apiKey || "").trim(),
      model: (saved.model || cfg.model || preset.model || "").trim()
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
   * 根据服务商标识与 Base URL 自动判定通信协议（gemini、vertex 或 openai）。
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

  /** 按高性价比与轻量推理优先级对远程拉取的模型 ID 排序 */
  function prioritizeModelIds(ids) {
    const unique = Array.from(new Set(ids));
    const scoreModel = id => {
      const s = id.toLowerCase();
      let score = 0;
      if (/flash|lite|luna|mini|nano|a3b|8b|9b|turbo/i.test(s)) score += 30;
      if (/gemini-4|gemini-3\.8|gemini-3\.5|gpt-6|deepseek-v4|deepseek-flash|qwen3\.5|glm-5/i.test(s)) {
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

  /**
   * 从目标接口动态拉取可用的对话生成模型列表（自动过滤嵌入、语音、生图等非对话模型）。
   */
  async function fetchAvailableModels({ provider, baseUrl, apiKey }) {
    const protocol = detectProtocol(provider, baseUrl);

    if (protocol === "gemini" || protocol === "vertex") {
      const cleanBase = resolveGeminiEndpointBase(baseUrl);
      const res = await fetch(`${cleanBase}/models?pageSize=200`, {
        method: "GET",
        headers: buildGeminiAuthHeaders(apiKey, false)
      });
      if (!res.ok) {
        if (protocol === "vertex" && (res.status === 404 || res.status === 403)) {
          throw new Error(
            "Vertex AI endpoint does not expose /models with this credential; please pick a recommended model chip or enter Model ID manually."
          );
        }
        const errJson = await res.json().catch(() => null);
        const msg =
          (errJson && errJson.error && errJson.error.message) ||
          `HTTP ${res.status}: ${res.statusText}`;
        throw new Error(msg);
      }
      const data = await res.json();
      const rawModels = Array.isArray(data.models)
        ? data.models
        : Array.isArray(data.publisherModels)
          ? data.publisherModels
          : [];
      const ids = rawModels
        .filter(m => {
          const methods = m.supportedGenerationMethods;
          const supportsGen = !Array.isArray(methods) || methods.includes("generateContent");
          return supportsGen && !/embedding|imagen|veo|aqa|tts|audio/i.test(m.name || "");
        })
        .map(m => String(m.name || "").replace(/^(?:publishers\/google\/)?models\//i, ""))
        .filter(Boolean);

      return prioritizeModelIds(ids);
    }

    let cleanBase = (baseUrl || "").trim().replace(/\/+$/, "");
    cleanBase = cleanBase.replace(/\/chat\/completions$/i, "");
    const endpoint = /\/models$/i.test(cleanBase) ? cleanBase : `${cleanBase}/models`;

    const headers = {};
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    const res = await fetch(endpoint, { method: "GET", headers });
    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `HTTP ${res.status}: ${res.statusText}`;
      throw new Error(msg);
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

  async function callGeminiNative({ baseUrl, apiKey, model, systemPrompt, userPrompt, jsonSchema }) {
    const cleanBase = resolveGeminiEndpointBase(baseUrl);
    const isVertex = isVertexAiUrl(cleanBase);
    const cleanModel = (model || "gemini-3.8-flash")
      .trim()
      .replace(/^(?:publishers\/google\/)?models\//i, "")
      .replace(/:generateContent$/i, "");

    const endpoint = `${cleanBase}/models/${encodeURIComponent(cleanModel)}:generateContent`;
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

    const headers = buildGeminiAuthHeaders(apiKey, true);

    let res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(primaryPayload)
    });

    // 若特定模型或反代不支持 responseSchema / systemInstruction，则逐级降级重试（保留 role 以兼容 Vertex AI）
    if (res.status === 400) {
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
        })
      });

      if (res.status === 400) {
        res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            contents: [{ role: "user", parts: [{ text: combinedPrompt }] }]
          })
        });
      }
    }

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `${res.status} ${res.statusText}`;
      throw new Error(`${isVertex ? "Vertex AI" : "Gemini API"}: ${msg}`);
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

  async function callOpenAICompatible({ baseUrl, apiKey, model, systemPrompt, userPrompt }) {
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

    const headers = { "Content-Type": "application/json" };
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

    let res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body)
    });

    // 参数不兼容导致 400 时，合并为单条 user 消息进行最简兼容请求
    if (res.status === 400) {
      const mergedPrompt = systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt;
      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: mergedPrompt }]
        })
      });
    }

    if (!res.ok) {
      const errJson = await res.json().catch(() => null);
      const msg =
        (errJson && errJson.error && errJson.error.message) ||
        `${res.status} ${res.statusText}`;
      throw new Error(`AI API (${res.status}): ${msg}`);
    }

    const data = await res.json();
    const rawText =
      (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) ||
      "";
    return extractJsonFromText(rawText);
  }

  /** 统一模型调用入口，按协议路由至对应适配器 */
  async function callLLM(params) {
    const protocol = detectProtocol(params.provider, params.baseUrl);
    if (protocol === "gemini" || protocol === "vertex") {
      return callGeminiNative(params);
    }
    return callOpenAICompatible(params);
  }

  /** 发送最小探测消息验证接口地址、密钥与模型 ID 是否可用 */
  async function testAIConnection({ provider, baseUrl, apiKey, model }) {
    const protocol = detectProtocol(provider, baseUrl);
    if (protocol === "gemini" || protocol === "vertex") {
      const cleanBase = resolveGeminiEndpointBase(baseUrl);
      const cleanModel = (model || "gemini-3.8-flash")
        .trim()
        .replace(/^(?:publishers\/google\/)?models\//i, "")
        .replace(/:generateContent$/i, "");
      const endpoint = `${cleanBase}/models/${encodeURIComponent(cleanModel)}:generateContent`;

      const payload = { contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }] };
      if (/^gemini-2\.5-flash/i.test(cleanModel)) {
        payload.generationConfig = { thinkingConfig: { thinkingBudget: 0 } };
      }

      const headers = buildGeminiAuthHeaders(apiKey, true);

      let res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(payload)
      });

      if (res.status === 400 && payload.generationConfig) {
        res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "Reply with OK" }] }] })
        });
      }

      if (!res.ok) {
        const errJson = await res.json().catch(() => null);
        const msg =
          (errJson && errJson.error && errJson.error.message) ||
          `HTTP ${res.status}: ${res.statusText}`;
        throw new Error(msg);
      }

      const data = await res.json();
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
    const headers = { "Content-Type": "application/json" };
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
      throw new Error(msg);
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
    resolveActiveProviderConfig,
    isVertexAiUrl,
    detectProtocol,
    normalizeGeminiBaseUrl,
    buildGeminiAuthHeaders,
    fetchAvailableModels,
    callLLM,
    testAIConnection,
    extractJsonFromText
  };
})(typeof window !== "undefined" ? window : globalThis);
