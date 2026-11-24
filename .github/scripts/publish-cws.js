/**
 * Chrome Web Store 自动上传与提审脚本（CI 独立模块）
 *
 * 依赖环境变量：
 * - CWS_EXTENSION_ID / CWS_CLIENT_ID / CWS_CLIENT_SECRET / CWS_REFRESH_TOKEN
 * - ZIP_PATH / RELEASE_TAG / ZIP_NAME
 */

"use strict";

const fs = require("fs");

async function main() {
  const {
    CWS_EXTENSION_ID: extId,
    CWS_CLIENT_ID: clientId,
    CWS_CLIENT_SECRET: clientSecret,
    CWS_REFRESH_TOKEN: refreshToken,
    ZIP_PATH: zipPath,
    RELEASE_TAG: releaseTag,
    ZIP_NAME: zipName,
    GITHUB_OUTPUT: ghOutput,
    GITHUB_STEP_SUMMARY: ghSummary
  } = process.env;

  if (!extId || !clientId || !clientSecret || !refreshToken) {
    if (ghOutput) fs.appendFileSync(ghOutput, "status=skipped\n");
    if (ghSummary) {
      fs.appendFileSync(
        ghSummary,
        [
          "### Chrome Web Store 自动同步已跳过",
          "未检测到完整的商店 API Secrets（`CWS_EXTENSION_ID` / `CWS_CLIENT_ID` / `CWS_CLIENT_SECRET` / `CWS_REFRESH_TOKEN`）。",
          `GitHub Release（\`${zipName}\`）已正常发布；配置好 Secrets 后可随时手动重新运行本工作流完成商店自动提交。`
        ].join("\n") + "\n"
      );
    }
    return;
  }

  if (!zipPath || !fs.existsSync(zipPath)) {
    throw new Error(`Extension zip package not found: ${zipPath}`);
  }

  const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const tokenData = await tokenResp.json().catch(() => ({}));
  if (!tokenResp.ok || !tokenData.access_token) {
    console.error("OAuth token exchange failed:", {
      httpStatus: tokenResp.status,
      error: tokenData.error || "unknown_error",
      error_description: tokenData.error_description || ""
    });
    process.exit(1);
  }

  const accessToken = String(tokenData.access_token);
  console.log(`::add-mask::${accessToken}`);

  const zipBuffer = fs.readFileSync(zipPath);
  const uploadResp = await fetch(
    `https://www.googleapis.com/upload/chromewebstore/v1.1/items/${encodeURIComponent(extId)}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-goog-api-version": "2"
      },
      body: zipBuffer
    }
  );
  const uploadData = await uploadResp.json().catch(() => ({}));
  console.log(
    "Upload status:",
    JSON.stringify({
      httpStatus: uploadResp.status,
      uploadState: uploadData.uploadState,
      itemError: uploadData.itemError || []
    })
  );
  if (!uploadResp.ok || uploadData.uploadState !== "SUCCESS") {
    console.error("Chrome Web Store upload failed.");
    process.exit(1);
  }

  const publishResp = await fetch(
    `https://www.googleapis.com/chromewebstore/v1.1/items/${encodeURIComponent(extId)}/publish?publishTarget=default`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "x-goog-api-version": "2",
        "Content-Length": "0"
      }
    }
  );
  const publishData = await publishResp.json().catch(() => ({}));
  console.log(
    "Publish status:",
    JSON.stringify({
      httpStatus: publishResp.status,
      status: publishData.status,
      statusDetail: publishData.statusDetail
    })
  );
  if (!publishResp.ok || !Array.isArray(publishData.status) || !publishData.status.includes("OK")) {
    console.error("Chrome Web Store publish failed.");
    process.exit(1);
  }

  if (ghOutput) fs.appendFileSync(ghOutput, "status=published\n");
  if (ghSummary) {
    fs.appendFileSync(
      ghSummary,
      [
        "### Chrome Web Store 自动同步成功",
        `- 版本：\`${releaseTag}\``,
        "- 状态：已自动上传并提交 Chrome 商店审核"
      ].join("\n") + "\n"
    );
  }
}

main().catch(err => {
  console.error("Unexpected Chrome publish error:", err && err.message ? err.message : String(err));
  process.exit(1);
});
