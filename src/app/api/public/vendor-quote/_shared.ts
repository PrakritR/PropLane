import { resolveRequestOrigin } from "@/lib/app-url";
import { createHash } from "node:crypto";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";

export const VENDOR_QUOTE_SESSION_COOKIE = {
  response: "vendor_quote_response_session",
  withdrawal: "vendor_quote_withdrawal_session",
} as const;

export const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "X-Robots-Tag": "noindex, nofollow, noarchive, nosnippet",
  "Referrer-Policy": "no-referrer",
};

const JSON_LIMIT = 24 * 1024;

export async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > JSON_LIMIT) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > JSON_LIMIT) {
        try { await reader.cancel(); } catch { /* Body is discarded either way. */ }
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

export function hasSameOriginJson(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin || request.headers.get("sec-fetch-site") === "cross-site") return false;
  try {
    return new URL(origin).origin === new URL(resolveRequestOrigin(request)).origin &&
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
  } catch {
    return false;
  }
}

export async function limitPublicRequest(request: Request, action: string, token?: string) {
  const ip = clientIpFrom(request);
  const ipLimit = await rateLimit(`vendor-quote:${action}:ip:${ip}`, 40, 60_000);
  if (!ipLimit.ok) return false;
  if (token) {
    const digest = createHash("sha256").update(token).digest("hex");
    const tokenLimit = await rateLimit(`vendor-quote:${action}:token:${digest}`, 20, 60_000);
    if (!tokenLimit.ok) return false;
  }
  return true;
}
