/**
 * 书签语义分类、目录架构规划与门面聚合模块
 *
 * 负责提示词编排、单页语义分类、轻量纯标题命名、批量书签映射、
 * 两阶段目录蓝图重构，并将全部子模块能力统一汇总导出为 MarkFlowEngine。
 */

(function (global) {
  "use strict";

  const constants = global.MarkFlowModules.constants;
  const platform = (global.MarkFlowModules && global.MarkFlowModules.platform) || {
    isRootBookmarkNode: id => ["0", "1", "2", "3"].includes(String(id)),
    isRootFolderName: name =>
      !name ||
      /^(根目录|书签栏|其他书签|收藏夹栏|其他收藏夹|Bookmarks Bar|Other Bookmarks|Favorites Bar|Other Favorites)$/i.test(
        String(name).trim()
      )
  };
  const utils = global.MarkFlowModules.utils;
  const tree = global.MarkFlowModules.tree;
  const rules = global.MarkFlowModules.rules;
  const sorter = global.MarkFlowModules.sorter;
  const cleaner = global.MarkFlowModules.cleaner || {};
  const llm = global.MarkFlowModules.llm;

  const { DEFAULT_PREFERENCES, MULTI_TOPIC_DOMAINS } = constants;
  const { parseUrlInfo, cleanTitleLocally, finalizeTitle, stripLeadingEmoji } = utils;
  const { matchRuleEngine } = rules;
  const { resolveActiveProviderConfig, callLLM } = llm;
  const { inferLocalFuncGroup } = sorter;

  /** 移除目录标题开头的 Emoji、编号或几何符号装饰前缀 */
  function stripVisualDecorations(str) {
    return stripLeadingEmoji(String(str || "").trim())
      .replace(/^(?:\d{2,}[\s.、·-]+|[◆▸■•★▪❖➤]\s*)/u, "")
      .trim();
  }

  /** 根据视觉风格枚举构造系统提示词中的命名格式要求 */
  function buildIconStyleInstruction(iconStyle) {
    if (iconStyle === "emoji_both") {
      return "所有【一级主目录】与【二级子目录】名称开头均须带 1 个贴合语义的 Emoji 图标 + 空格 + 精炼名称。";
    }
    if (iconStyle === "plain") {
      return "所有【一级主目录】和【二级子目录】统一使用清爽纯文字命名，禁止添加任何 Emoji、数字序号或符号前缀。";
    }
    if (iconStyle === "numbered") {
      return "每个【一级主目录】名称开头使用两位数字编号（例如 01 工作、02 技术）；所有【二级子目录】统一使用纯文字（不加编号与 Emoji）。";
    }
    if (iconStyle === "symbol") {
      return "每个【一级主目录】名称开头使用几何符号前缀「◆ 」（例如 ◆ 工作、◆ 技术）；所有【二级子目录】统一使用纯文字（不加符号与 Emoji）。";
    }
    return "每个【一级主目录】名称开头带 1 个贴合语义的 Emoji 图标 + 空格 + 精炼名称；所有【二级子目录】统一使用纯文字（禁止加 Emoji）。";
  }

  /** 构建注入模型的现有目录架构与样本摘要文本 */
  function buildFolderCataloguePrompt(treeAnalysis) {
    const { folders, styleProfile } = treeAnalysis;
    const mainCategories = folders.filter(f => f.depth === 2);

    if (mainCategories.length === 0) {
      const bar = folders.find(f => f.id === "1") || folders[0];
      return {
        catalogueText: bar ? `- [主目录ID:${bar.id}] ${bar.title} (暂无分类子目录)` : "暂无目录",
        subStyleNote: "二级子目录使用纯文字，长度 2~6 字"
      };
    }

    const lines = [];
    for (const parent of mainCategories) {
      const subs = folders.filter(f => f.parentId === parent.id && f.depth === 3);
      const parentHint = parent.scopeHint ? ` | 收纳范围: ${parent.scopeHint}` : "";
      const parentSamples =
        parent.samples && parent.samples.length > 0
          ? ` | 样本: ${parent.samples.slice(0, 4).join("; ")}`
          : "";

      if (subs.length === 0) {
        lines.push(
          `- [主目录ID:${parent.id}] ${parent.title} (平铺目录，符合此主题请直接选用该主目录ID)${parentHint}${parentSamples}`
        );
      } else {
        lines.push(`- [主目录ID:${parent.id}] ${parent.title}${parentSamples}`);
        for (const sub of subs) {
          const hintPart = sub.scopeHint ? ` | 收纳范围: ${sub.scopeHint}` : "";
          const samplePart =
            sub.samples && sub.samples.length > 0
              ? ` | 样本: ${sub.samples.slice(0, 4).join("; ")}`
              : "";
          lines.push(`  ├─ [子目录ID:${sub.id}] ${sub.title}${hintPart}${samplePart}`);
        }
      }
    }

    const subStyleNote = styleProfile.subUsesEmoji
      ? "二级子目录可带前缀图标，长度 2~6 字"
      : "二级子目录使用纯文字（禁止加 Emoji 图标），长度 2~6 字";

    return {
      catalogueText: lines.join("\n"),
      subStyleNote
    };
  }

  /**
   * 解析 AI 输出标题与新建目录名的目标语言规则，支持 7 套国际化语言及“保持网页原语言”。
   */
  function resolveAiOutputLanguage(preferences = {}) {
    const pref = Object.assign({}, DEFAULT_PREFERENCES, preferences || {});
    const mode = pref.aiLanguage || "ui";
    const resolvedUi =
      typeof global.resolveDisplayLanguage === "function"
        ? global.resolveDisplayLanguage(pref.language)
        : pref.language || "zh_CN";

    const folderRulesByLang = {
      zh_CN: "所有新建或建议的目录名称统一使用简洁简体中文（2~6 字）。",
      zh_TW: "所有新建或建議的資料夾名稱統一使用簡潔繁體中文（2~6 字）。",
      en: "All newly generated or suggested folder names MUST be concise English (1–3 words).",
      ja: "新規作成・提案するフォルダ名はすべて簡潔な日本語（2〜8文字）にしてください。",
      ko: "새로 생성하거나 제안하는 폴더 이름은 모두 간결한 한국어(2~8자)로 작성하세요.",
      de: "Alle neu erstellten oder vorgeschlagenen Ordnernamen müssen kurzes, klares Deutsch sein (1–3 Wörter).",
      es: "Todos los nombres de carpetas nuevos o sugeridos deben estar en español conciso (1–3 palabras)."
    };

    const titleRulesByLang = {
      zh_CN: "精简标题、新建目录名与归类依据统一使用简洁自然的简体中文（专有英文品牌与技术名词保留原拼写）。",
      zh_TW: "精簡標題、新建資料夾名稱與歸類依據統一使用簡潔自然的繁體中文（專有英文品牌與技術名詞保留原拼寫）。",
      en: "Output ALL cleaned bookmark titles, folder names, and brief reasons in crisp, natural English.",
      ja: "整形後のブックマークタイトル・新規フォルダ名・分類理由はすべて簡潔で自然な日本語で出力してください。",
      ko: "정리된 북마크 제목, 새 폴더 이름, 분류 근거는 모두 간결하고 자연스러운 한국어로 출력하세요.",
      de: "Gib alle bereinigten Titel, Ordnernamen und kurzen Begründungen in klarem, natürlichem Deutsch aus.",
      es: "Genera todos los títulos limpios, nombres de carpetas y motivos breves en español natural y conciso."
    };

    if (mode === "page") {
      return {
        mode: "page",
        uiLang: resolvedUi,
        titleRule:
          "保持每个网页原本的语言输出精简标题（英文网页保留英文，中文网页保留中文，日韩德西网页保留原语言），不强行翻译。",
        folderRule: folderRulesByLang[resolvedUi] || folderRulesByLang.en
      };
    }

    const effectiveLang = mode === "ui" ? resolvedUi : mode;
    return {
      mode: effectiveLang,
      uiLang: effectiveLang,
      titleRule: titleRulesByLang[effectiveLang] || titleRulesByLang.en,
      folderRule: folderRulesByLang[effectiveLang] || folderRulesByLang.en
    };
  }

  /** 构建单页及批量分类共用的系统提示词 */
  function buildClassifierSystemPrompt(preferences = {}) {
    const pref = Object.assign({}, DEFAULT_PREFERENCES, preferences || {});
    const langCfg = resolveAiOutputLanguage(pref);

    let subfolderRule = "";
    if (pref.subfolderPolicy === "strict_reuse") {
      subfolderRule = `  1) 严格复用现有目录：必须直接从用户现有的【子目录ID】或平铺型【主目录ID】中选择最贴合的一项；
  2) 【强制要求】：suggestedSubfolder 必须始终返回 null，不建议新建任何目录；
  3) 严禁归入“其他书签”。`;
    } else if (pref.subfolderPolicy === "proactive") {
      subfolderRule = `  1) 若现有【子目录ID】高度精准契合（匹配度 ≥ 80%），直接选用该子目录ID，suggestedSubfolder 设为 null；
  2) 若网页属于某主目录大类下的清晰独立子主题，且现有子目录不够贴切或过于宽泛，primaryFolderId 选该主目录ID，并在 suggestedSubfolder 中给出简明二级分类建议；
  3) 若目标主目录本身是无子目录的平铺型目录且直接匹配，选用该主目录ID；严禁归入“其他书签”，严禁创建三级目录。`;
    } else {
      subfolderRule = `  1) 若目标主目录下已有契合的【子目录ID】（匹配度 ≥ 65%），直接选用该子目录ID，suggestedSubfolder 设为 null；
  2) 若目标【主目录ID】本身是无子目录的平铺型目录，直接选用该主目录ID；
  3) 仅当网页明确属于某主目录大类，但该主目录下现有子目录均明显不符时，primaryFolderId 填该主目录ID，并在 suggestedSubfolder 给出简明二级分类建议；
  4) 严禁归入“其他书签”，严禁创建超过两级的目录深度。`;
    }

    let titleStyleRule = "";
    if (pref.titleStyle === "concise") {
      titleStyleRule = `- 极简短名范式：
  尽可能只保留清晰的品牌、产品、项目或核心主题短名（3~12 字），不附加多余的用途说明后缀；若为具体文章或内部系统则提炼最精炼的主标题。`;
    } else if (pref.titleStyle === "faithful") {
      titleStyleRule = `- 保真精简范式：
  仅剥离网站 SEO 推广尾缀、未读数前缀与广告噪音，尽可能保留网页原标题表述，不强行拆分为“主体 · 用途”结构（控制在 6~26 字）。`;
    } else {
      titleStyleRule = `- 扫视型命名范式：
  对于工具、平台、应用或站点主页，推荐「品牌/主体 · 核心用途」（如 "Figma · 协同界面设计"）；对于具体文章、帖子或原本已清晰完整的专有系统名，仅剥离推广尾缀与冗余噪音，自然保留完整语义（控制在 5~22 字）。`;
    }

    const customNoteRaw = String(pref.customInstruction || "").trim().slice(0, 300);
    const customNoteBlock = customNoteRaw
      ? `\n\n【四、用户个性化归类补充偏好（在不违背 JSON 格式与两级深度前提下优先遵从）】：\n${customNoteRaw}`
      : "";

    return `你是 MarkFlow 信息架构与书签归类引擎。
请完全基于用户现有的目录结构、收纳范围说明及目录内真实书签样本进行客观语义推理，不预设特定行业偏见。

【一、归类判定准则（按 P1 → P4 依次判定）】
- P1 专属业务与私域上下文对齐：
  若书签属于组织内部系统、私有部署服务、特定端口或子域名后台，重点结合【域名/端口/路径规律】、【原所在目录路径】及目录样本特征，精准归入对应业务目录。
- P2 垂直站点归属连续性：
  若输入提供了【同站点历史归属锚点】（仅针对垂直功能网站），只要当前页面核心用途未跨界，优先对齐该锚点目录。对于综合型多主题内容平台（视频站、社交媒体、代码托管站、百科论坛），必须忽略平台外壳，按页面具体主题归类。
- P3 使用目的优先（使用目的 > 所属主题领域 > 内容媒介形式）：
  判断用户收藏该网页的核心目的（直接操作的工具/工作台、查阅学习的参考资料、社区资讯或生活影音），并与候选目录的收纳范围及样本比对。
- P4 层级经济性与新建策略：
${subfolderRule}

【二、书签标题清洗与残缺还原规范】
- 残缺与模糊标题还原：
  当原标题仅为缺乏辨识度的通用词（如 "Login"、"Dashboard"、"首页"、"控制台"、"Admin"、"文档"、"Swagger"）时，必须结合【域名/品牌名】、【URL 路径】与【原所在目录】还原出可读名称，禁止直接输出孤立的“登录”“首页”或“文档”。
${titleStyleRule}
- 排版规范：中英文与数字之间保留单个空格。

【三、输出语言策略】
- ${langCfg.titleRule}
- ${langCfg.folderRule}${customNoteBlock}`;
  }

  /**
   * 阶段一：通览待整理书签全量清单，自底向上生成两级目录架构蓝图。
   */
  async function generateTaxonomyBlueprint({
    bookmarks,
    lockedFolders = [],
    iconStyle = "emoji",
    aiConfig,
    preferences = {},
    signal = null
  }) {
    const activeCfg = resolveActiveProviderConfig(aiConfig);
    if (!activeCfg.enabled || !activeCfg.baseUrl || (!activeCfg.apiKey && activeCfg.provider !== "ollama")) {
      throw new Error("AI model is not configured or enabled");
    }

    const pref = Object.assign({}, DEFAULT_PREFERENCES, preferences || {});
    const langCfg = resolveAiOutputLanguage(pref);
    const customNoteRaw = String(pref.customInstruction || "").trim().slice(0, 300);

    // 统计高频域名分布以辅助模型识别高频场景
    const hostClusters = new Map();
    bookmarks.forEach(bm => {
      const uInfo = parseUrlInfo(bm.url);
      const key = uInfo.isIpOrLocal ? uInfo.hostKey : uInfo.hostname || "other";
      hostClusters.set(key, (hostClusters.get(key) || 0) + 1);
    });

    const topHostsSummary = Array.from(hostClusters.entries())
      .filter(([, cnt]) => cnt >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60)
      .map(([host, cnt]) => `${host}(${cnt})`)
      .join(", ");

    // 按均匀步长抽样（600 条以内全量传入）并保留原目录与路径信息
    const maxFullItems = 600;
    const step = bookmarks.length > maxFullItems ? bookmarks.length / maxFullItems : 1;
    const fullInventoryLines = [];
    for (let i = 0; i < Math.min(bookmarks.length, maxFullItems); i++) {
      const bm = bookmarks[Math.floor(i * step)];
      const u = parseUrlInfo(bm.url);
      const origCtx =
        bm.parentTitle &&
        !platform.isRootBookmarkNode(bm.parentId) &&
        !platform.isRootFolderName(bm.parentTitle)
          ? ` | 原目录:${bm.parentTitle}`
          : "";
      const hostAndPath = u.valid
        ? `${u.isIpOrLocal ? u.hostKey : u.hostname}${u.pathHint !== "/" ? u.pathHint.slice(0, 32) : ""}`
        : bm.url.slice(0, 40);
      fullInventoryLines.push(
        `[${i + 1}] ${cleanTitleLocally(bm.title).slice(0, 38)}${origCtx} | ${hostAndPath}`
      );
    }

    const iconInstruction = buildIconStyleInstruction(iconStyle);

    const lockedNotice =
      lockedFolders.length > 0
        ? `\n【用户已锁定的现有一级目录（保持原样不参与重构，请勿创建重复目录）】：\n${lockedFolders.map(f => `- ${f.title}`).join("\n")}\n`
        : "";

    const customNoteSection = customNoteRaw
      ? `\n5. 用户个性化偏好补充：\n   - ${customNoteRaw}`
      : "";

    const blueprintSystemPrompt = `你是信息架构师，负责通读用户的全量书签清单，自底向上归纳出清晰、互斥、低认知负荷的两级书签栏目录体系。

【架构设计规范】：
1. 场景驱动与 MECE 原则：
   - 依据清单中的真实业务场景与使用目的划分同级目录，边界清晰无重叠；严禁编造没有书签支撑的空分类，严禁使用“其他/杂项/未分类”等笼统名称。
2. 一屏宽度控制：
   - 规划 5 ~ 9 个【一级主目录】（含锁定目录总数不超过 10 个），按高频程度从左到右排列。
3. 密度自适应分层：
   - 预计书签数 < 7 条或主题高度集中的一级主目录，将 subfolders 设为空数组 []，直接平铺收纳；
   - 仅当书签体量充足（≥ 7 条）且存在 2 个及以上鲜明子场景时，才划分 2 ~ 6 个【二级子目录】，每个子目录至少承载 3 条书签。
4. 命名规范与样本锚点：
   - ${iconInstruction}
   - 目录语言要求：${langCfg.folderRule}
   - 为每个最终收纳节点提供简短 scopeHint（15 字内）与 2 ~ 3 个来自输入清单的真实 seedSamples。${customNoteSection}`;

    const blueprintUserPrompt = `待规划书签总数：${bookmarks.length} 条。${lockedNotice}
${topHostsSummary ? `【高频域名统计】：${topHostsSummary}\n` : ""}
【书签语义清单】：
${fullInventoryLines.join("\n")}

请严格输出如下 JSON 对象（不含 Markdown 代码块）：
{
  "inferredPersona": "一句话概括该书签库的核心使用场景",
  "categories": [
    {
      "title": "一级主目录名称",
      "scopeHint": "收纳边界简述",
      "seedSamples": ["平铺主目录的真实代表书签"],
      "subfolders": [
        {
          "title": "二级子目录名称（无需细分时整个数组为空 []）",
          "scopeHint": "收纳边界简述",
          "seedSamples": ["代表书签1 [domain]", "代表书签2 [domain]"]
        }
      ]
    }
  ]
}`;

    const geminiBlueprintSchema = {
      type: "OBJECT",
      properties: {
        inferredPersona: { type: "STRING" },
        categories: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              title: { type: "STRING" },
              scopeHint: { type: "STRING" },
              seedSamples: { type: "ARRAY", items: { type: "STRING" } },
              subfolders: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    title: { type: "STRING" },
                    scopeHint: { type: "STRING" },
                    seedSamples: { type: "ARRAY", items: { type: "STRING" } }
                  },
                  required: ["title", "scopeHint", "seedSamples"]
                }
              }
            },
            required: ["title", "scopeHint", "subfolders"]
          }
        }
      },
      required: ["categories"]
    };

    const parsed = await callLLM({
      provider: activeCfg.provider,
      baseUrl: activeCfg.baseUrl,
      apiKey: activeCfg.apiKey,
      model: activeCfg.model,
      vertexPriority: activeCfg.provider === "gemini" && Boolean(activeCfg.vertexPriority),
      systemPrompt: blueprintSystemPrompt,
      userPrompt: blueprintUserPrompt,
      jsonSchema: geminiBlueprintSchema,
      signal
    });

    const rawCategories = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.categories)
        ? parsed.categories
        : [];

    if (rawCategories.length === 0) {
      throw new Error("Empty taxonomy blueprint returned");
    }

    const seenL1 = new Set();
    const normalized = [];

    rawCategories.forEach((cat, cIdx) => {
      let l1Title = String(cat.title || "").trim();
      if (!l1Title) return;
      if (iconStyle === "plain") {
        l1Title = stripVisualDecorations(l1Title);
      } else if (iconStyle === "numbered") {
        const cleanBase = stripVisualDecorations(l1Title);
        if (!cleanBase) return;
        l1Title = `${String(normalized.length + 1).padStart(2, "0")} ${cleanBase}`;
      } else if (iconStyle === "symbol") {
        const cleanBase = stripVisualDecorations(l1Title);
        if (!cleanBase) return;
        l1Title = `◆ ${cleanBase}`;
      }
      const dedupKey = stripVisualDecorations(l1Title).toLowerCase();
      if (!dedupKey || seenL1.has(dedupKey)) return;
      seenL1.add(dedupKey);

      const catSeeds = (Array.isArray(cat.seedSamples) ? cat.seedSamples : [])
        .map(s => String(s || "").trim().slice(0, 38))
        .filter(Boolean)
        .slice(0, 3);

      const seenSub = new Set();
      const subs = [];
      (Array.isArray(cat.subfolders) ? cat.subfolders : []).forEach((sub, sIdx) => {
        const rawSubTitle = typeof sub === "string" ? sub : sub && sub.title;
        let subTitle = String(rawSubTitle || "").trim();
        subTitle =
          iconStyle === "emoji_both"
            ? subTitle.replace(/^(?:\d{2,}[\s.、·-]+|[◆▸■•★▪❖➤]\s*)/u, "").trim()
            : stripVisualDecorations(subTitle);
        const subDedupKey = stripVisualDecorations(subTitle).toLowerCase();
        if (!subTitle || !subDedupKey || seenSub.has(subDedupKey)) return;
        seenSub.add(subDedupKey);

        const rawSeeds = Array.isArray(sub && sub.seedSamples) ? sub.seedSamples : [];
        const seedSamples = rawSeeds
          .map(s => String(s || "").trim().slice(0, 38))
          .filter(Boolean)
          .slice(0, 3);

        subs.push({
          id: `bp_${cIdx}_${sIdx}_${Date.now()}`,
          title: subTitle,
          originalTitle: subTitle,
          scopeHint: String((sub && sub.scopeHint) || "").slice(0, 44),
          seedSamples
        });
      });

      // 若某一级目录下仅有单个子目录，则直接扁平化为平铺主目录
      const finalSubs = subs.length === 1 ? [] : subs;
      const finalCatSeeds =
        finalSubs.length === 0 && catSeeds.length === 0 && subs.length === 1
          ? subs[0].seedSamples
          : catSeeds;
      const finalCatScope =
        finalSubs.length === 0 && !cat.scopeHint && subs.length === 1
          ? subs[0].scopeHint
          : String(cat.scopeHint || "").slice(0, 44);

      normalized.push({
        id: `bp_${cIdx}_${Date.now()}`,
        title: l1Title,
        originalTitle: l1Title,
        scopeHint: finalCatScope,
        seedSamples: finalCatSeeds,
        subfolders: finalSubs
      });
    });

    return normalized;
  }

  /** 将可编辑蓝图结构转换为与 analyzeBookmarkTree 同构的虚拟目录树 */
  function buildBlueprintTreeAnalysis(blueprintCategories, iconStyle = "emoji") {
    const folders = [];
    const folderMap = new Map();

    const rootBar = {
      id: "1",
      title: "Bookmarks Bar",
      displayText: "Bookmarks Bar",
      breadcrumb: "Bookmarks Bar",
      depth: 1,
      parentId: "0",
      directBookmarkCount: 0,
      samples: [],
      searchKey: "bookmarks bar favorites bar 书签栏 收藏夹栏"
    };
    folders.push(rootBar);
    folderMap.set("1", rootBar);

    blueprintCategories.forEach((cat, cIdx) => {
      const isLastCat = cIdx === blueprintCategories.length - 1;
      const catPrefix = isLastCat ? "└── " : "├── ";
      const childBasePrefix = isLastCat ? "    " : "│   ";
      const subs = Array.isArray(cat.subfolders) ? cat.subfolders : [];

      const l1WasRenamed =
        cat.originalTitle &&
        stripLeadingEmoji(cat.originalTitle).toLowerCase() !==
          stripLeadingEmoji(cat.title).toLowerCase();

      const l1Obj = {
        id: String(cat.id),
        title: cat.title,
        displayText: `${catPrefix}${cat.title}`,
        breadcrumb: cat.title,
        depth: 2,
        parentId: "1",
        topL1Id: String(cat.id),
        scopeHint: l1WasRenamed ? "" : cat.scopeHint || "",
        directBookmarkCount: 0,
        samples:
          !l1WasRenamed && subs.length === 0 && Array.isArray(cat.seedSamples)
            ? [...cat.seedSamples]
            : [],
        searchKey: cat.title.toLowerCase()
      };
      folders.push(l1Obj);
      folderMap.set(l1Obj.id, l1Obj);

      subs.forEach((sub, sIdx) => {
        const isLastSub = sIdx === subs.length - 1;
        const subPrefix = childBasePrefix + (isLastSub ? "└── " : "├── ");
        const breadcrumb = `${cat.title} › ${sub.title}`;

        const wasRenamed =
          sub.originalTitle &&
          stripLeadingEmoji(sub.originalTitle).toLowerCase() !==
            stripLeadingEmoji(sub.title).toLowerCase();

        const l2Obj = {
          id: String(sub.id),
          title: sub.title,
          displayText: `${subPrefix}${sub.title}`,
          breadcrumb,
          depth: 3,
          parentId: l1Obj.id,
          topL1Id: l1Obj.id,
          scopeHint: wasRenamed ? "" : sub.scopeHint || "",
          directBookmarkCount: 0,
          samples: !wasRenamed && Array.isArray(sub.seedSamples) ? [...sub.seedSamples] : [],
          searchKey: `${cat.title} ${sub.title}`.toLowerCase()
        };
        folders.push(l2Obj);
        folderMap.set(l2Obj.id, l2Obj);
      });
    });

    return {
      isBlueprint: true,
      folders,
      folderMap,
      bookmarks: [],
      hostFolderCounts: new Map(),
      ipHostFolderCounts: new Map(),
      styleProfile: {
        mainUsesEmoji: iconStyle === "emoji" || iconStyle === "emoji_both",
        subUsesEmoji: iconStyle === "emoji_both"
      }
    };
  }

  /**
   * 映射后孤岛目录收敛：
   * 仅含 0~1 条书签的子目录自动收拢至所属主目录；空主目录自动裁剪，避免落地后产生空壳文件夹。
   */
  function consolidateOrphanSubfolders(reorgItems, blueprintCategories) {
    if (!Array.isArray(reorgItems) || !Array.isArray(blueprintCategories)) {
      return { consolidatedCategories: blueprintCategories || [], rolledUpCount: 0 };
    }

    const folderCounts = new Map();
    for (const item of reorgItems) {
      if (item.ignored) continue;
      const fid = String(item.targetFolderId);
      folderCounts.set(fid, (folderCounts.get(fid) || 0) + 1);
    }

    let rolledUpCount = 0;
    const rollUpSubfolderToParent = (subId, parentCat) => {
      for (const item of reorgItems) {
        if (String(item.targetFolderId) === String(subId)) {
          item.targetFolderId = String(parentCat.id);
          item.targetFolderName = parentCat.title;
          folderCounts.set(String(parentCat.id), (folderCounts.get(String(parentCat.id)) || 0) + 1);
          rolledUpCount++;
        }
      }
      folderCounts.delete(String(subId));
    };

    const nextCategories = [];
    for (const cat of blueprintCategories) {
      const keptSubs = [];
      for (const sub of cat.subfolders || []) {
        const cnt = folderCounts.get(String(sub.id)) || 0;
        if (cnt <= 1) {
          rollUpSubfolderToParent(sub.id, cat);
        } else {
          keptSubs.push(sub);
        }
      }

      if (keptSubs.length === 1) {
        const soleSub = keptSubs[0];
        const totalInCat =
          (folderCounts.get(String(cat.id)) || 0) + (folderCounts.get(String(soleSub.id)) || 0);
        if (totalInCat <= 6) {
          rollUpSubfolderToParent(soleSub.id, cat);
          keptSubs.length = 0;
        }
      }

      const totalCatItems =
        (folderCounts.get(String(cat.id)) || 0) +
        keptSubs.reduce((acc, s) => acc + (folderCounts.get(String(s.id)) || 0), 0);

      if (totalCatItems > 0 || blueprintCategories.length === 1) {
        nextCategories.push(Object.assign({}, cat, { subfolders: keptSubs }));
      }
    }

    return {
      consolidatedCategories: nextCategories.length > 0 ? nextCategories : blueprintCategories,
      rolledUpCount
    };
  }

  /** 分批映射前按垂直站点与局域网主机预聚合，便于同站书签在相近批次中保持目录一致 */
  function clusterBookmarksForBatching(rawBookmarks) {
    if (!Array.isArray(rawBookmarks) || rawBookmarks.length <= 1) return rawBookmarks || [];

    const buckets = new Map();
    const multiTopicItems = [];

    rawBookmarks.forEach((bm, idx) => {
      const tagged = Object.assign({}, bm, { _origOrderIdx: idx });
      const uInfo = parseUrlInfo(bm.url);
      if (!uInfo.valid || uInfo.isMultiTopic) {
        multiTopicItems.push(tagged);
        return;
      }
      const groupKey = uInfo.isIpOrLocal ? `lan:${uInfo.hostname}` : `dom:${uInfo.baseDomain}`;
      if (!buckets.has(groupKey)) buckets.set(groupKey, []);
      buckets.get(groupKey).push(tagged);
    });

    const clustered = [];
    const sortedBuckets = Array.from(buckets.values()).sort((a, b) => b.length - a.length);
    for (const group of sortedBuckets) {
      clustered.push(...group);
    }
    clustered.push(...multiTopicItems);
    return clustered;
  }

  /** 批量处理期间滚动沉淀已映射样本与同站锚点，供后续批次参考 */
  function recordRollingMappingAnchor(treeAnalysis, rawUrl, cleanTitle, targetFolderId) {
    if (!treeAnalysis || !targetFolderId) return;
    const folder = treeAnalysis.folderMap.get(String(targetFolderId));
    if (!folder || folder.id === "1" || folder.id === "2") return;

    const uInfo = parseUrlInfo(rawUrl);

    if (folder.samples.length < 4 && cleanTitle) {
      const hostTag = uInfo.valid ? (uInfo.isIpOrLocal ? uInfo.hostKey : uInfo.hostname) : "";
      const sampleLabel = hostTag
        ? `${cleanTitle.slice(0, 24)} [${hostTag}]`
        : cleanTitle.slice(0, 26);
      if (!folder.samples.includes(sampleLabel)) {
        folder.samples.push(sampleLabel);
      }
    }

    if (uInfo.valid && !uInfo.isMultiTopic) {
      const fid = String(targetFolderId);
      if (!treeAnalysis.hostFolderCounts.has(uInfo.hostKey)) {
        treeAnalysis.hostFolderCounts.set(uInfo.hostKey, new Map());
      }
      const m1 = treeAnalysis.hostFolderCounts.get(uInfo.hostKey);
      m1.set(fid, (m1.get(fid) || 0) + 1);

      const secondaryKey = uInfo.isIpOrLocal ? uInfo.hostname : uInfo.baseDomain;
      if (secondaryKey && !MULTI_TOPIC_DOMAINS.has(secondaryKey)) {
        if (!treeAnalysis.ipHostFolderCounts.has(secondaryKey)) {
          treeAnalysis.ipHostFolderCounts.set(secondaryKey, new Map());
        }
        const m2 = treeAnalysis.ipHostFolderCounts.get(secondaryKey);
        m2.set(fid, (m2.get(fid) || 0) + 1);
      }
    }
  }

  /** 将旧目录树中的域名记忆映射至新蓝图的对应虚拟目录 ID */
  function translateDomainMemoryToBlueprint(oldDomainMemory, oldTreeAnalysis, blueprintTree) {
    const translated = {};
    if (!oldDomainMemory || !oldTreeAnalysis || !blueprintTree) return translated;

    const bpFolders = blueprintTree.folders.filter(f => f.depth >= 2);
    for (const [hostKey, oldFid] of Object.entries(oldDomainMemory)) {
      const oldFolder = oldTreeAnalysis.folderMap.get(String(oldFid));
      if (!oldFolder) continue;
      const oldClean = stripLeadingEmoji(oldFolder.title).toLowerCase();
      if (!oldClean) continue;

      const matchedBp =
        bpFolders.find(
          f =>
            f.depth === 3 &&
            (stripLeadingEmoji(f.title).toLowerCase() === oldClean ||
              stripLeadingEmoji(f.title).toLowerCase().includes(oldClean) ||
              oldClean.includes(stripLeadingEmoji(f.title).toLowerCase()))
        ) ||
        bpFolders.find(
          f =>
            f.depth === 2 &&
            (stripLeadingEmoji(f.title).toLowerCase() === oldClean ||
              stripLeadingEmoji(f.title).toLowerCase().includes(oldClean))
        );

      if (matchedBp) {
        translated[hostKey] = matchedBp.id;
      }
    }
    return translated;
  }

  /** 重构落地后将历史域名偏好无损迁移至新建的真实 Chrome 目录 ID */
  function migrateDomainMemoryAfterRebuild({
    oldDomainMemory = {},
    oldTreeAnalysis,
    activeItems = [],
    virtualToRealId,
    lockedL1Ids = new Set()
  }) {
    const nextMemory = {};

    for (const [hostKey, oldFid] of Object.entries(oldDomainMemory)) {
      const oldFolder = oldTreeAnalysis && oldTreeAnalysis.folderMap.get(String(oldFid));
      if (
        oldFolder &&
        (lockedL1Ids.has(oldFolder.id) || (oldFolder.topL1Id && lockedL1Ids.has(oldFolder.topL1Id)))
      ) {
        nextMemory[hostKey] = String(oldFid);
      }
    }

    const rememberedKeys = new Set(Object.keys(oldDomainMemory));
    for (const item of activeItems) {
      const uInfo = parseUrlInfo(item.url);
      if (!uInfo.valid || uInfo.isMultiTopic) continue;
      const realId = virtualToRealId.get(String(item.targetFolderId));
      if (!realId || realId === "1" || realId === "2") continue;

      if (rememberedKeys.has(uInfo.hostKey)) nextMemory[uInfo.hostKey] = String(realId);
      if (rememberedKeys.has(uInfo.hostname)) nextMemory[uInfo.hostname] = String(realId);
      if (rememberedKeys.has(uInfo.baseDomain)) nextMemory[uInfo.baseDomain] = String(realId);
    }

    return nextMemory;
  }

  /** 清洗并校验单页分类结果，兜底非法目录 ID 与子目录策略约束 */
  function sanitizeClassificationOutput(
    rawRes,
    { url, localCleanTitle, treeAnalysis, domainAffinity, preferences = {}, usePangu = true }
  ) {
    const res = rawRes || {};
    const { folders, folderMap, styleProfile } = treeAnalysis;

    const resolveFolder = candidate => {
      if (!candidate) return null;
      const str = String(candidate).trim();
      if (folderMap.has(str) && str !== "2") return folderMap.get(str);
      return (
        folders.find(f => f.depth >= 2 && (f.title === str || f.title.includes(str))) || null
      );
    };

    let primaryFolder =
      resolveFolder(res.primaryFolderId || res.folderId) ||
      (domainAffinity && resolveFolder(domainAffinity.folderId)) ||
      folders.find(f => f.depth === 2) ||
      folders.find(f => f.id === "1") ||
      folders[0];

    const rawAlts = Array.isArray(res.alternativeFolderIds) ? res.alternativeFolderIds : [];
    if (domainAffinity && domainAffinity.confidence === "exact_memory") {
      const memFolder = resolveFolder(domainAffinity.folderId);
      if (memFolder && primaryFolder && memFolder.id !== primaryFolder.id) {
        rawAlts.unshift(primaryFolder.id);
        primaryFolder = memFolder;
      }
    }

    let suggestedSubfolder =
      typeof res.suggestedSubfolder === "string" && res.suggestedSubfolder.trim() !== "null"
        ? res.suggestedSubfolder.trim()
        : null;

    if (preferences && preferences.subfolderPolicy === "strict_reuse") {
      suggestedSubfolder = null;
    }

    if (suggestedSubfolder && primaryFolder) {
      if (primaryFolder.depth >= 3) {
        suggestedSubfolder = null;
      } else {
        if (!styleProfile.subUsesEmoji) {
          suggestedSubfolder = stripLeadingEmoji(suggestedSubfolder);
        }
        suggestedSubfolder = suggestedSubfolder.slice(0, 12).trim();

        const existingSub = folders.find(
          f =>
            f.parentId === primaryFolder.id &&
            (f.title.toLowerCase() === suggestedSubfolder.toLowerCase() ||
              stripLeadingEmoji(f.title) === stripLeadingEmoji(suggestedSubfolder))
        );
        if (existingSub) {
          primaryFolder = existingSub;
          suggestedSubfolder = null;
        }
      }
    }

    const alternativeFolders = [];
    const seenIds = new Set([primaryFolder ? primaryFolder.id : "", "0", "1", "2"]);
    if (domainAffinity && !seenIds.has(String(domainAffinity.folderId))) {
      const af = resolveFolder(domainAffinity.folderId);
      if (af) {
        alternativeFolders.push(af);
        seenIds.add(af.id);
      }
    }
    for (const altId of rawAlts) {
      const af = resolveFolder(altId);
      if (af && !seenIds.has(af.id)) {
        alternativeFolders.push(af);
        seenIds.add(af.id);
        if (alternativeFolders.length >= 2) break;
      }
    }

    const cleanTitle = finalizeTitle(
      res.title,
      localCleanTitle,
      usePangu,
      url,
      primaryFolder ? primaryFolder.breadcrumb : ""
    );

    return {
      title: cleanTitle,
      folderId: primaryFolder ? primaryFolder.id : "",
      folder: primaryFolder || null,
      alternativeFolders,
      suggestedSubfolder: suggestedSubfolder || null,
      reason: (res.reason || "").slice(0, 22)
    };
  }

  /** 单页智能分类（弹窗收藏主流程） */
  async function classifySinglePage({
    url,
    rawTitle,
    localCleanTitle,
    pageContext,
    treeAnalysis,
    domainAffinity,
    aiConfig,
    preferences = {},
    usePangu = true,
    signal = null
  }) {
    const activeCfg = resolveActiveProviderConfig(aiConfig);
    const { catalogueText, subStyleNote } = buildFolderCataloguePrompt(treeAnalysis);
    const uInfo = parseUrlInfo(url);
    const systemPrompt = buildClassifierSystemPrompt(preferences);

    const ctxLines = [
      `- URL: ${url}`,
      `- 域名与关键路径: ${uInfo.hostKey || uInfo.hostname}${uInfo.pathHint}`,
      `- 原始网页标题: ${rawTitle || localCleanTitle}`
    ];

    if (pageContext) {
      if (pageContext.siteName) ctxLines.push(`- 站点名称: ${pageContext.siteName}`);
      if (pageContext.schemaType) ctxLines.push(`- 结构化类型: ${pageContext.schemaType}`);
      if (pageContext.h1 && pageContext.h1 !== rawTitle) ctxLines.push(`- 页面 H1: ${pageContext.h1}`);
      if (pageContext.breadcrumbs) ctxLines.push(`- 面包屑路径: ${pageContext.breadcrumbs}`);
      if (pageContext.description) ctxLines.push(`- 页面描述: ${pageContext.description}`);
      if (pageContext.keywords) ctxLines.push(`- 关键词: ${pageContext.keywords}`);
      if (pageContext.platformHint) ctxLines.push(`- 平台特征: ${pageContext.platformHint}`);
      if (pageContext.h2s) ctxLines.push(`- 章节大纲: ${pageContext.h2s}`);
      if (pageContext.excerpt) ctxLines.push(`- 正文摘要: ${pageContext.excerpt}`);
    }

    if (domainAffinity) {
      ctxLines.push(
        `- 【同站点历史归属锚点】: ID=${domainAffinity.folderId} (${domainAffinity.breadcrumb}) [${domainAffinity.reason}]`
      );
    }

    const userPrompt = `【用户现有书签目录架构与样本画像】（新建子目录要求：${subStyleNote}）：
${catalogueText}

【待归类网页多维语义信息】：
${ctxLines.join("\n")}

请严格输出如下 JSON 对象（不含 Markdown 代码块或多余文字）：
{
  "pageIntent": "一句话概括网页真实用途",
  "title": "符合命名风格与语言策略的精简书签标题",
  "primaryFolderId": "最匹配的现有目录ID（纯字符串）",
  "alternativeFolderIds": ["次优备选目录ID_1", "次优备选目录ID_2"],
  "suggestedSubfolder": null,
  "reason": "10字以内的归类依据"
}`;

    const geminiSchema = {
      type: "OBJECT",
      properties: {
        pageIntent: { type: "STRING" },
        title: { type: "STRING" },
        primaryFolderId: { type: "STRING" },
        alternativeFolderIds: { type: "ARRAY", items: { type: "STRING" } },
        suggestedSubfolder: { type: "STRING", nullable: true },
        reason: { type: "STRING" }
      },
      required: ["pageIntent", "title", "primaryFolderId", "alternativeFolderIds", "reason"]
    };

    const rawRes = await callLLM({
      provider: activeCfg.provider,
      baseUrl: activeCfg.baseUrl,
      apiKey: activeCfg.apiKey,
      model: activeCfg.model,
      vertexPriority: activeCfg.provider === "gemini" && Boolean(activeCfg.vertexPriority),
      systemPrompt,
      userPrompt,
      jsonSchema: geminiSchema,
      signal
    });

    return sanitizeClassificationOutput(rawRes, {
      url,
      localCleanTitle,
      treeAnalysis,
      domainAffinity,
      preferences,
      usePangu
    });
  }

  /** 轻量纯标题命名（用于命中本地规则或用户主动单点润色标题，不发送目录树节省 Token） */
  async function generateCleanTitleOnly({
    url,
    rawTitle,
    localCleanTitle,
    pageContext,
    targetFolderName = "",
    aiConfig,
    preferences = {},
    usePangu = true,
    signal = null
  }) {
    const activeCfg = resolveActiveProviderConfig(aiConfig);
    const pref = Object.assign({}, DEFAULT_PREFERENCES, preferences || {});
    const langCfg = resolveAiOutputLanguage(pref);
    const uInfo = parseUrlInfo(url);

    let styleInstruction =
      "推荐范式：「品牌/主体 · 核心用途」（5~22字）；若是具体文章或已清晰的业务系统名则保留主标题去噪音。";
    if (pref.titleStyle === "concise") {
      styleInstruction = "极简短名范式：仅保留最核心的品牌、产品或项目名（3~12字），不附带用途后缀。";
    } else if (pref.titleStyle === "faithful") {
      styleInstruction = "保真精简范式：仅剔除广告推广尾缀与未读数，保留原标题原意（6~26字）。";
    }

    const customNote = String(pref.customInstruction || "").trim().slice(0, 220);
    const systemPrompt = `你是书签标题精简与重塑专家，仅输出一个高辨识度、整洁美观的书签标题。
- 残缺还原：若原标题为 "Login"、"Dashboard"、"首页"、"Swagger" 等模糊词，结合域名、路径与所属目录还原出可读名称。
- 命名风格：${styleInstruction}
- 语言策略：${langCfg.titleRule}
- 排版规范：中英文与数字间保留单个空格。${customNote ? `\n- 用户补充偏好：${customNote}` : ""}`;

    const ctxLines = [
      `- URL: ${url}`,
      `- 域名与路径: ${uInfo.hostKey || uInfo.hostname}${uInfo.pathHint}`,
      `- 原始标题: ${rawTitle || localCleanTitle}`
    ];
    if (targetFolderName) ctxLines.push(`- 所在目标目录: ${targetFolderName}`);
    if (pageContext) {
      if (pageContext.siteName) ctxLines.push(`- 站点名: ${pageContext.siteName}`);
      if (pageContext.h1 && pageContext.h1 !== rawTitle) ctxLines.push(`- 页面 H1: ${pageContext.h1}`);
      if (pageContext.description) ctxLines.push(`- 页面描述: ${pageContext.description}`);
      if (pageContext.platformHint) ctxLines.push(`- 平台特征: ${pageContext.platformHint}`);
    }

    const userPrompt = `请为以下网页生成最佳书签标题，严格输出 JSON 对象：
${ctxLines.join("\n")}

{"title": "精简后的书签标题"}`;

    const geminiTitleSchema = {
      type: "OBJECT",
      properties: { title: { type: "STRING" } },
      required: ["title"]
    };

    const parsed = await callLLM({
      provider: activeCfg.provider,
      baseUrl: activeCfg.baseUrl,
      apiKey: activeCfg.apiKey,
      model: activeCfg.model,
      vertexPriority: activeCfg.provider === "gemini" && Boolean(activeCfg.vertexPriority),
      systemPrompt,
      userPrompt,
      jsonSchema: geminiTitleSchema,
      signal
    });

    return finalizeTitle(parsed && parsed.title, localCleanTitle, usePangu, url, targetFolderName);
  }

  /** 批量书签归类与功能聚簇标注（智能整理主引擎） */
  async function classifyBatchBookmarks({
    items,
    treeAnalysis,
    aiConfig,
    preferences = {},
    usePangu = true,
    signal = null
  }) {
    const activeCfg = resolveActiveProviderConfig(aiConfig);
    const { catalogueText } = buildFolderCataloguePrompt(treeAnalysis);
    const { folders, folderMap, isBlueprint } = treeAnalysis;
    const systemPrompt = buildClassifierSystemPrompt(preferences);

    const itemLines = items.map((it, idx) => {
      const uInfo = parseUrlInfo(it.bm.url);
      const anchorStr = it.domainAffinity
        ? ` | 同站锚点ID:${it.domainAffinity.folderId}(${it.domainAffinity.breadcrumb})`
        : "";
      const origFolderHint =
        it.bm.parentTitle &&
        !platform.isRootBookmarkNode(it.bm.parentId) &&
        !platform.isRootFolderName(it.bm.parentTitle)
          ? ` | 原目录路径:${it.bm.parentTitle}`
          : "";
      return `[${idx}] 原标题: ${it.bm.title}${origFolderHint} | 站点与路径:${uInfo.hostKey || uInfo.hostname}${uInfo.pathHint}${anchorStr} | URL: ${it.bm.url}`;
    });

    const userPrompt = `【目标书签目录架构${isBlueprint ? "（新规划架构：有子目录的归入子目录ID，平铺目录直接归入主目录ID）" : "与样本画像"}】：
${catalogueText}

【待批量归类书签列表（共 ${items.length} 项）】：
${itemLines.join("\n")}

请为每条书签生成精简标题、目标目录 ID 及 2~4 字功能聚簇标签 funcGroup（同功能网站使用一致标签便于目录内聚簇排序），严格输出如下 JSON 对象：
{
  "items": [
    {
      "index": 0,
      "cleanTitle": "精简书签标题",
      "targetFolderId": "目标目录ID",
      "funcGroup": "2~4字功能分组标签",
      "reason": "8字内依据"
    }
  ]
}`;

    const geminiBatchSchema = {
      type: "OBJECT",
      properties: {
        items: {
          type: "ARRAY",
          items: {
            type: "OBJECT",
            properties: {
              index: { type: "INTEGER" },
              cleanTitle: { type: "STRING" },
              targetFolderId: { type: "STRING" },
              funcGroup: { type: "STRING" },
              reason: { type: "STRING" }
            },
            required: ["index", "cleanTitle", "targetFolderId", "funcGroup", "reason"]
          }
        }
      },
      required: ["items"]
    };

    const parsed = await callLLM({
      provider: activeCfg.provider,
      baseUrl: activeCfg.baseUrl,
      apiKey: activeCfg.apiKey,
      model: activeCfg.model,
      vertexPriority: activeCfg.provider === "gemini" && Boolean(activeCfg.vertexPriority),
      systemPrompt,
      userPrompt,
      jsonSchema: geminiBatchSchema,
      signal
    });

    const rawList = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed && parsed.items)
        ? parsed.items
        : Array.isArray(parsed && parsed.bookmarks)
          ? parsed.bookmarks
          : [];

    const byIndex = new Map();
    rawList.forEach((entry, pos) => {
      const idx = typeof entry.index === "number" ? entry.index : pos;
      byIndex.set(idx, entry);
    });

    const defaultFallback =
      folders.find(f => f.depth === 3) || folders.find(f => f.depth === 2) || folders[0];

    return items.map((it, idx) => {
      const aiEntry = byIndex.get(idx) || {};
      const candidateId = String(aiEntry.targetFolderId || "").trim();
      const dest =
        (folderMap.has(candidateId) && candidateId !== "2" && folderMap.get(candidateId)) ||
        folders.find(
          f => f.depth >= 2 && candidateId && (f.title === candidateId || f.title.includes(candidateId))
        ) ||
        (it.domainAffinity && folderMap.get(String(it.domainAffinity.folderId))) ||
        (!isBlueprint && folderMap.get(String(it.bm.parentId))) ||
        defaultFallback;

      const finalTitle = finalizeTitle(
        aiEntry.cleanTitle,
        it.cleanTitle,
        usePangu,
        it.bm.url,
        it.bm.parentTitle || (dest ? dest.breadcrumb : "")
      );

      return {
        cleanTitle: finalTitle,
        targetFolderId: dest ? dest.id : defaultFallback.id,
        targetFolderName: dest ? dest.breadcrumb : defaultFallback.title,
        funcGroup:
          String(aiEntry.funcGroup || "").trim().slice(0, 12) ||
          inferLocalFuncGroup(it.bm.url, finalTitle),
        reason: (aiEntry.reason || "").slice(0, 20)
      };
    });
  }

  /**
   * 纯本地零请求估算单次智能整理或全盘重构的 Token 消耗规模与请求批次数。
   * 仅基于书签体量、规则命中率与目录树规模进行经验估算，不硬编码各厂商动态价格。
   */
  function estimateReorganizeTokens({
    mode = "existing",
    bookmarks = [],
    rules: userRules = [],
    treeAnalysis = null,
    aiConfig = {},
    preferences = {}
  } = {}) {
    const list = Array.isArray(bookmarks) ? bookmarks : [];
    const totalBookmarks = list.length;
    const activeCfg = resolveActiveProviderConfig(aiConfig);
    const hasCredential = Boolean(
      activeCfg.baseUrl && (activeCfg.apiKey || activeCfg.provider === "ollama")
    );
    const aiEnabled = Boolean(activeCfg.enabled && hasCredential);
    const isLocalFree = activeCfg.provider === "ollama";

    if (mode === "dedup" || mode === "deadlinks") {
      return {
        totalBookmarks,
        ruleMatchedCount: 0,
        aiCount: 0,
        batchCount: 0,
        estimatedTokens: 0,
        isLocalFree: true,
        aiEnabled: false,
        providerLabel: activeCfg.providerLabel,
        model: activeCfg.model
      };
    }

    if (totalBookmarks === 0) {
      return {
        totalBookmarks: 0,
        ruleMatchedCount: 0,
        aiCount: 0,
        batchCount: 0,
        estimatedTokens: 0,
        isLocalFree,
        aiEnabled,
        providerLabel: activeCfg.providerLabel,
        model: activeCfg.model
      };
    }

    const folderCount =
      (treeAnalysis && Array.isArray(treeAnalysis.folders) && treeAnalysis.folders.length) || 8;
    const folderSummaryTokens = Math.min(900, Math.max(80, folderCount * 28));
    const BATCH_SIZE = 12;

    if (mode === "rebuild") {
      const stage1Tokens = 700 + Math.min(totalBookmarks, 600) * 28 + 900;
      const mappingBatches = Math.ceil(totalBookmarks / BATCH_SIZE);
      const batchTokens = mappingBatches * (550 + folderSummaryTokens) + totalBookmarks * 160;
      return {
        totalBookmarks,
        ruleMatchedCount: 0,
        aiCount: totalBookmarks,
        batchCount: 1 + mappingBatches,
        estimatedTokens: stage1Tokens + batchTokens,
        isLocalFree,
        aiEnabled,
        providerLabel: activeCfg.providerLabel,
        model: activeCfg.model
      };
    }

    let ruleMatchedCount = 0;
    for (const bm of list) {
      if (matchRuleEngine(bm.url, userRules)) {
        ruleMatchedCount++;
      }
    }

    const unhandledCount = Math.max(0, totalBookmarks - ruleMatchedCount);
    if (!aiEnabled) {
      return {
        totalBookmarks,
        ruleMatchedCount,
        aiCount: 0,
        batchCount: 0,
        estimatedTokens: 0,
        isLocalFree,
        aiEnabled: false,
        providerLabel: activeCfg.providerLabel,
        model: activeCfg.model
      };
    }

    const ruleAiTitle = Boolean(preferences && preferences.ruleMatchUseAiTitle);
    const ruleTitleTokens = ruleAiTitle ? ruleMatchedCount * 220 : 0;
    const batchCount = unhandledCount > 0 ? Math.ceil(unhandledCount / BATCH_SIZE) : 0;
    const batchTokens =
      batchCount * (550 + folderSummaryTokens) + unhandledCount * 160;
    const totalRequests = batchCount + (ruleAiTitle ? ruleMatchedCount : 0);

    return {
      totalBookmarks,
      ruleMatchedCount,
      aiCount: unhandledCount,
      batchCount: totalRequests,
      estimatedTokens: batchTokens + ruleTitleTokens,
      isLocalFree,
      aiEnabled: true,
      providerLabel: activeCfg.providerLabel,
      model: activeCfg.model
    };
  }

  // 聚合导出统一的 MarkFlowEngine 门面对象
  global.MarkFlowEngine = Object.assign(
    {},
    constants,
    utils,
    tree,
    rules,
    sorter,
    cleaner,
    llm,
    {
      platform,
      resolveAiOutputLanguage,
      buildClassifierSystemPrompt,
      sanitizeClassificationOutput,
      generateCleanTitleOnly,
      generateTaxonomyBlueprint,
      buildBlueprintTreeAnalysis,
      consolidateOrphanSubfolders,
      clusterBookmarksForBatching,
      recordRollingMappingAnchor,
      translateDomainMemoryToBlueprint,
      migrateDomainMemoryAfterRebuild,
      classifySinglePage,
      classifyBatchBookmarks,
      estimateReorganizeTokens
    }
  );
})(typeof window !== "undefined" ? window : globalThis);
