/**
 * 扩展后台服务脚本（Manifest V3 Service Worker）
 *
 * 仅负责首次安装时的默认本地存储初始化，不常驻后台轮询，
 * 不监听或上报任何用户浏览历史。
 */

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

const DEFAULT_SETTINGS = {
  aiConfig: {
    enabled: false,
    provider: "siliconflow",
    apiKey: "",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V4.1-Flash",
    autoCleanTitle: true,
    temperature: 0
  },
  rules: DEFAULT_UNIVERSAL_RULES,
  preferences: {
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
  }
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(["aiConfig", "rules", "preferences"]);
  const toSet = {};

  if (!existing.aiConfig) toSet.aiConfig = DEFAULT_SETTINGS.aiConfig;
  if (!existing.rules) toSet.rules = DEFAULT_SETTINGS.rules;
  if (!existing.preferences) toSet.preferences = DEFAULT_SETTINGS.preferences;

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }
});
