/**
 * 全局静态常量与默认配置定义
 *
 * 集中维护模型服务商预设、多主题综合站点白名单、默认示例规则及偏好设置默认值，
 * 供弹窗、控制台与后台服务共享引用。
 */

(function (global) {
  "use strict";

  const PROVIDER_PRESETS = {
    siliconflow: {
      name: "SiliconFlow",
      baseUrl: "https://api.siliconflow.cn/v1",
      apiKey: "",
      model: "deepseek-ai/DeepSeek-V4.1-Flash",
      quickModels: [
        "deepseek-ai/DeepSeek-V4.1-Flash",
        "Qwen/Qwen3.5-35B-A3B",
        "zai-org/GLM-5.3-Flash",
        "Qwen/Qwen3-8B"
      ],
      keyPlaceholder: "sk-...",
      urlHintKey: "ai_base_url_hint"
    },
    gemini: {
      name: "Google Gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: "",
      model: "gemini-3.8-flash",
      quickModels: [
        "gemini-3.8-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.1-pro"
      ],
      keyPlaceholder: "AIzaSy...",
      urlHintKey: "ai_gemini_url_hint"
    },
    deepseek: {
      name: "DeepSeek",
      baseUrl: "https://api.deepseek.com/v1",
      apiKey: "",
      model: "deepseek-flash",
      quickModels: ["deepseek-flash", "deepseek-v4-pro", "deepseek-reasoner"],
      keyPlaceholder: "sk-...",
      urlHintKey: "ai_base_url_hint"
    },
    openai: {
      name: "OpenAI",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "",
      model: "gpt-6-luna",
      quickModels: ["gpt-6-luna", "gpt-6.1-terra", "gpt-6.2-sol"],
      keyPlaceholder: "sk-...",
      urlHintKey: "ai_base_url_hint"
    },
    ollama: {
      name: "Ollama (Local)",
      baseUrl: "http://localhost:11434/v1",
      apiKey: "ollama",
      model: "qwen3.5:9b",
      quickModels: ["qwen3.5:9b", "qwen3.5:4b", "gemma4:12b"],
      keyPlaceholder: "ollama",
      urlHintKey: "ai_base_url_hint"
    },
    custom: {
      name: "Custom Endpoint",
      baseUrl: "",
      apiKey: "",
      model: "",
      quickModels: [],
      keyPlaceholder: "sk-... / AIzaSy...",
      urlHintKey: "ai_base_url_hint"
    }
  };

  /** 旧版本默认模型标识集合，用于在用户未自定义密钥时平滑升级默认推荐模型 */
  const LEGACY_DEFAULT_MODELS = new Set([
    "deepseek-ai/DeepSeek-V3",
    "gemini-2.5-flash",
    "deepseek-chat",
    "gpt-4o-mini",
    "qwen2.5:7b"
  ]);

  /**
   * 综合型多主题内容平台域名集合。
   * 此类站点上的不同页面主题差异极大（例如视频、帖子、仓库、文档），
   * 因此不能仅凭域名本身推断归属目录，需交由页面标题或正文语义判定。
   */
  const MULTI_TOPIC_DOMAINS = new Set([
    "github.com",
    "gist.github.com",
    "gitlab.com",
    "gitee.com",
    "bitbucket.org",
    "codeberg.org",
    "youtube.com",
    "youtu.be",
    "bilibili.com",
    "b23.tv",
    "x.com",
    "twitter.com",
    "reddit.com",
    "zhihu.com",
    "zhuanlan.zhihu.com",
    "juejin.cn",
    "csdn.net",
    "blog.csdn.net",
    "cnblogs.com",
    "segmentfault.com",
    "jianshu.com",
    "medium.com",
    "substack.com",
    "dev.to",
    "mp.weixin.qq.com",
    "weibo.com",
    "xiaohongshu.com",
    "douyin.com",
    "v2ex.com",
    "stackoverflow.com",
    "stackexchange.com",
    "superuser.com",
    "serverfault.com",
    "wikipedia.org",
    "notion.so",
    "notion.site",
    "feishu.cn",
    "yuque.com",
    "docs.google.com",
    "drive.google.com",
    "pan.baidu.com",
    "alipan.com",
    "aliyundrive.com",
    "quark.cn",
    "google.com",
    "bing.com",
    "baidu.com"
  ]);

  /** 默认示例规则集（初始为关闭状态，便于用户按需启用或参考语法） */
  const DEFAULT_UNIVERSAL_RULES = [
    {
      id: "rule_code_repos",
      enabled: false,
      name: "Git Repositories",
      pattern: "github.com | gitlab.com | bitbucket.org",
      matchType: "wildcard",
      semanticAlias: "代码|开发|Repo|Git|Dev|Tech",
      subSemanticAlias: "代码|托管|仓库|Repo|Git",
      targetFolder: "技术与开发",
      targetSubfolder: "代码仓库"
    },
    {
      id: "rule_tech_docs",
      enabled: false,
      name: "Developer Docs",
      pattern: "developer.mozilla.org | devdocs.io | w3schools.com",
      matchType: "wildcard",
      semanticAlias: "开发|技术|文档|Doc|Reference",
      subSemanticAlias: "文档|参考|Doc|Reference",
      targetFolder: "技术与开发",
      targetSubfolder: "技术文档"
    },
    {
      id: "rule_dev_qa",
      enabled: false,
      name: "Community & Q&A",
      pattern: "stackoverflow.com | reddit.com",
      matchType: "wildcard",
      semanticAlias: "社区|论坛|问答|Community|Forum",
      subSemanticAlias: "问答|讨论|社区",
      targetFolder: "社区与资讯",
      targetSubfolder: "问答社区"
    },
    {
      id: "rule_media_streaming",
      enabled: false,
      name: "Streaming & Media",
      pattern: "youtube.com | vimeo.com",
      matchType: "wildcard",
      semanticAlias: "视频|媒体|娱乐|Media|Video|Streaming",
      subSemanticAlias: "视频|流媒体",
      targetFolder: "影音与媒体",
      targetSubfolder: "视频平台"
    }
  ];

  /** 用户偏好默认配置 */
  const DEFAULT_PREFERENCES = {
    autoSaveCountdown: 0,
    stripSuffixes: true,
    panguSpacing: true,
    language: "",
    titleStyle: "scannable",
    aiLanguage: "ui",
    extractPageContext: true,
    subfolderPolicy: "balanced",
    ruleMatchUseAiTitle: false,
    customInstruction: ""
  };

  /** 目录标识圆点调色板，用于在弹窗与控制台中提供稳定的视觉区分 */
  const FOLDER_DOT_PALETTE = [
    "#5b5bd6",
    "#0d9488",
    "#2563eb",
    "#d97706",
    "#9333ea",
    "#e11d48",
    "#059669",
    "#0284c7"
  ];

  global.MarkFlowModules = global.MarkFlowModules || {};
  global.MarkFlowModules.constants = {
    PROVIDER_PRESETS,
    LEGACY_DEFAULT_MODELS,
    MULTI_TOPIC_DOMAINS,
    DEFAULT_UNIVERSAL_RULES,
    DEFAULT_PREFERENCES,
    FOLDER_DOT_PALETTE
  };
})(typeof window !== "undefined" ? window : globalThis);
