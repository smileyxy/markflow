/**
 * Microsoft Edge Add-ons Publish API v1.1 自动上传与提审脚本（CI 独立模块）
 *
 * 仅用于已通过首次人工审核上架后的版本增量自动发布。
 * 依赖环境变量：
 * - EDGE_PRODUCT_ID / EDGE_CLIENT_ID / EDGE_API_KEY
 * - ZIP_PATH / RELEASE_TAG / ZIP_NAME / RELEASE_NOTES_FILE（可选）
 */

"use strict";

const fs = require("fs");

const EDGE_API_BASE = "https://api.addons.microsoftedge.microsoft.com";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractOperationId(locationHeader) {
  if (!locationHeader) return "";
  const cleaned = String(locationHeader).trim().replace(/[?#].*$/, "").replace(/\/+$/, "");
  const parts = cleaned.split("/").filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function buildSubmissionNotes(releaseTag, notesFile) {
  if (notesFile && fs.existsSync(notesFile)) {
    const raw = fs.readFileSync(notesFile, "utf8").trim();
    if (raw) {
      return raw.length > 1500 ? `${raw.slice(0, 1497)}...` : raw;
    }
  }
  return `Automated release ${releaseTag || ""}`.trim();
}

function logAuthHintIfNeeded(status) {
  if (status === 401 || status === 403) {
    console.error(
      "Edge Publish API 鉴权失败（401/403）：Microsoft Edge API Key 每 72 天过期，请在 Partner Center 重新生成并更新 GitHub Secret `EDGE_API_KEY`。"
    );
  }
}

async function pollEdgeOperation(url, headers, label, maxAttempts = 60, intervalMs = 5000) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const resp = await fetch(url, { method: "GET", headers });
    const rawText = await resp.text();
    let data = {};
    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch (e) {
      data = { rawText };
    }

    if (!resp.ok) {
      logAuthHintIfNeeded(resp.status);
      throw new Error(
        `${label} status query failed (HTTP ${resp.status}): ${JSON.stringify(data)}`
      );
    }

    const status = String(data.status || "");
    console.log(`[Edge ${label}] attempt ${attempt}/${maxAttempts}: status=${status}`);

    if (status === "Succeeded") {
      return data;
    }
    if (status === "Failed") {
      throw new Error(
        `${label} failed: errorCode=${data.errorCode || "unknown"}, message=${data.message || ""}, errors=${JSON.stringify(data.errors || [])}`
      );
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs);
    }
  }
  throw new Error(`${label} polling timed out after ${maxAttempts} attempts.`);
}

async function main() {
  const {
    EDGE_PRODUCT_ID: productId,
    EDGE_CLIENT_ID: clientId,
    EDGE_API_KEY: apiKey,
    REQUIRE_PUBLISH: requirePublishRaw,
    ZIP_PATH: zipPath,
    RELEASE_TAG: releaseTag,
    ZIP_NAME: zipName,
    RELEASE_NOTES_FILE: notesFile,
    GITHUB_OUTPUT: ghOutput,
    GITHUB_STEP_SUMMARY: ghSummary
  } = process.env;

  const missingSecrets = [
    ["EDGE_PRODUCT_ID", productId],
    ["EDGE_CLIENT_ID", clientId],
    ["EDGE_API_KEY", apiKey]
  ]
    .filter(([, val]) => !val)
    .map(([name]) => name);

  const requirePublish = String(requirePublishRaw || "").toLowerCase() === "true";

  if (missingSecrets.length > 0) {
    const missingList = missingSecrets.join(", ");
    if (requirePublish) {
      console.error(
        `::error::Microsoft Edge Add-ons publish failed — missing required GitHub Secrets: ${missingList}`
      );
      if (ghSummary) {
        fs.appendFileSync(
          ghSummary,
          [
            "### ❌ Microsoft Edge Add-ons 发布失败（缺少必要 Secrets）",
            `- 缺失 Secret：\`${missingList}\``,
            "- 本次由 `workflow_dispatch` 显式启用了 Edge 商店发布，请在仓库 Settings → Secrets and variables → Actions 补齐后重试。"
          ].join("\n") + "\n"
        );
      }
      process.exit(1);
    }

    console.warn(
      `::warning::Microsoft Edge Add-ons auto-publish skipped — missing GitHub Secrets: ${missingList}`
    );
    if (ghOutput) fs.appendFileSync(ghOutput, "status=skipped\n");
    if (ghSummary) {
      fs.appendFileSync(
        ghSummary,
        [
          "### ⚠️ Microsoft Edge Add-ons 自动同步已跳过",
          `未检测到完整的 Edge 商店 API Secrets（缺失：\`${missingList}\`）。`,
          `GitHub Release（\`${zipName}\`）已正常发布；配置好 Secrets 后可随时手动重新运行本工作流自动提交 Edge 商店。`
        ].join("\n") + "\n"
      );
    }
    return;
  }

  console.log(`::add-mask::${apiKey}`);

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Extension zip package not found: ${zipPath}`);
  }

  const authHeaders = {
    Authorization: `ApiKey ${apiKey}`,
    "X-ClientID": clientId
  };

  // 1. 上传扩展包至 Edge 商店草稿
  const zipBuffer = fs.readFileSync(zipPath);
  const uploadUrl = `${EDGE_API_BASE}/v1/products/${encodeURIComponent(productId)}/submissions/draft/package`;
  const uploadResp = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/zip"
    },
    body: zipBuffer
  });

  if (!uploadResp.ok) {
    logAuthHintIfNeeded(uploadResp.status);
    const errBody = await uploadResp.text().catch(() => "");
    throw new Error(`Edge package upload failed (HTTP ${uploadResp.status}): ${errBody}`);
  }

  const uploadLocation = uploadResp.headers.get("location") || "";
  const uploadOpId = extractOperationId(uploadLocation);
  console.log("Edge draft upload accepted:", {
    httpStatus: uploadResp.status,
    operationId: uploadOpId
  });
  if (!uploadOpId) {
    throw new Error(`Missing operation Location header on upload response: "${uploadLocation}"`);
  }

  // 2. 轮询草稿包校验结果
  const uploadOpUrl = `${EDGE_API_BASE}/v1/products/${encodeURIComponent(productId)}/submissions/draft/package/operations/${encodeURIComponent(uploadOpId)}`;
  await pollEdgeOperation(uploadOpUrl, authHeaders, "DraftUpload", 60, 5000);

  // 3. 提交正式审核
  const notes = buildSubmissionNotes(releaseTag, notesFile);
  const publishUrl = `${EDGE_API_BASE}/v1/products/${encodeURIComponent(productId)}/submissions`;
  const publishResp = await fetch(publishUrl, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ notes })
  });

  if (!publishResp.ok) {
    logAuthHintIfNeeded(publishResp.status);
    const errBody = await publishResp.text().catch(() => "");
    throw new Error(`Edge submission failed (HTTP ${publishResp.status}): ${errBody}`);
  }

  const pubLocation = publishResp.headers.get("location") || "";
  const pubOpId = extractOperationId(pubLocation);
  console.log("Edge submission accepted:", {
    httpStatus: publishResp.status,
    operationId: pubOpId || "(none)"
  });

  let submissionState = "Accepted";
  if (pubOpId) {
    const pubOpUrl = `${EDGE_API_BASE}/v1/products/${encodeURIComponent(productId)}/submissions/operations/${encodeURIComponent(pubOpId)}`;
    try {
      await pollEdgeOperation(pubOpUrl, authHeaders, "Submission", 30, 5000);
      submissionState = "Succeeded";
    } catch (pollErr) {
      if (/timed out/i.test(pollErr.message)) {
        submissionState = "InProgress";
        console.log("Edge submission is still processing asynchronously on Partner Center.");
      } else {
        throw pollErr;
      }
    }
  }

  if (ghOutput) fs.appendFileSync(ghOutput, "status=published\n");
  if (ghSummary) {
    fs.appendFileSync(
      ghSummary,
      [
        "### Microsoft Edge Add-ons 自动同步成功",
        `- 版本：\`${releaseTag}\``,
        `- 审核提交状态：\`${submissionState}\``
      ].join("\n") + "\n"
    );
  }
}

main().catch(err => {
  console.error("Unexpected Edge publish error:", err && err.message ? err.message : String(err));
  process.exit(1);
});
