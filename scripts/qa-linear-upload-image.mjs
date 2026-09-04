#!/usr/bin/env node
/** Upload a PNG to Linear and return the asset URL for markdown embedding. */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { requireLinearApiKey } from "./linear/load-env.mjs";
import { linearGraphql } from "./linear/graphql.mjs";

export async function uploadLinearImage(filePath) {
  const buf = readFileSync(filePath);
  const filename = basename(filePath);
  const contentType = "image/png";
  const size = buf.length;

  const data = await linearGraphql(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
      fileUpload(contentType: $contentType, filename: $filename, size: $size) {
        success
        uploadFile { uploadUrl assetUrl headers { key value } }
      }
    }`,
    { contentType, filename, size },
  );

  const upload = data.fileUpload;
  if (!upload?.success || !upload.uploadFile?.uploadUrl) {
    throw new Error("Linear fileUpload failed");
  }

  const headers = Object.fromEntries(
    (upload.uploadFile.headers ?? []).map((h) => [h.key, h.value]),
  );
  const res = await fetch(upload.uploadFile.uploadUrl, {
    method: "PUT",
    headers: { ...headers, "Content-Type": contentType },
    body: buf,
  });
  if (!res.ok) throw new Error(`Linear image PUT failed: ${res.status}`);
  return upload.uploadFile.assetUrl;
}

if (process.argv[1]?.endsWith("qa-linear-upload-image.mjs") && process.argv[2]) {
  const url = await uploadLinearImage(process.argv[2]);
  console.log(url);
}
