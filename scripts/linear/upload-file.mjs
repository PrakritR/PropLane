/**
 * Upload a file to Linear storage; returns assetUrl for markdown embed.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { linearGraphql } from "./graphql.mjs";

export async function uploadFileToLinear(filePath) {
  const buf = readFileSync(filePath);
  const filename = basename(filePath);
  const contentType = filename.endsWith(".png")
    ? "image/png"
    : filename.endsWith(".jpg") || filename.endsWith(".jpeg")
      ? "image/jpeg"
      : "application/octet-stream";

  const data = await linearGraphql(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile {
          uploadUrl
          assetUrl
          headers { key value }
        }
      }
    }`,
    { contentType, filename, size: buf.length },
  );

  const upload = data.fileUpload?.uploadFile;
  if (!data.fileUpload?.success || !upload?.uploadUrl) {
    throw new Error("fileUpload failed");
  }

  const headers = new Headers();
  headers.set("Content-Type", contentType);
  headers.set("Cache-Control", "public, max-age=31536000");
  for (const { key, value } of upload.headers ?? []) {
    headers.set(key, value);
  }

  const put = await fetch(upload.uploadUrl, { method: "PUT", headers, body: buf });
  if (!put.ok) throw new Error(`upload PUT HTTP ${put.status}`);

  return upload.assetUrl;
}
