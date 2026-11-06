import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
type Health = { configured: boolean; domainVerified: boolean; available: boolean; status: "unauthorized" | "not_configured" | "unavailable" | "unverified" | "verified" };
function result(status: Health["status"], configured = false): Health {
  const verified = status === "verified";
  return { configured, domainVerified: verified, available: verified, status };
}
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function senderDomain(from: string): string | null {
  const raw = from.trim();
  const address = raw.includes("<") ? /^.*<([^<>]+)>$/.exec(raw)?.[1]?.trim() : raw;
  const match = address?.match(/^[^\s@<>]+@([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)$/i);
  const domain = match?.[1]?.toLowerCase();
  return domain && domain.includes(".") && !domain.includes("..") ? domain : null;
}
/** Read-only provider check; neither sender nor provider response leaves the server. */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json(result("unauthorized"), { status: 401, headers });
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const domain = senderDomain(process.env.RESEND_FROM ?? "");
  if (!apiKey || !domain) return NextResponse.json(result("not_configured"), { status: 503, headers });
  try {
    let after: string | undefined;
    const signal = AbortSignal.timeout(8000);
    for (let page = 0; page < 5; page++) {
      const url = new URL("https://api.resend.com/domains");
      url.searchParams.set("limit", "100");
      if (after) url.searchParams.set("after", after);
      const response = await fetch(url, { method: "GET", headers: { Authorization: `Bearer ${apiKey}` }, cache: "no-store", redirect: "error", signal });
      if (!response.ok) throw new Error("Provider unavailable");
      const body: unknown = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data) || typeof (body as { has_more?: unknown }).has_more !== "boolean") throw new Error("Provider response unavailable");
      const { data, has_more: hasMore } = body as { data: Array<{ id?: unknown; name?: unknown; status?: unknown; capabilities?: { sending?: unknown } }>; has_more: boolean };
      const match = data.find((item) => typeof item?.name === "string" && item.name.trim().toLowerCase() === domain);
      if (match) {
        const verified = match.status === "verified" && match.capabilities?.sending === "enabled";
        return NextResponse.json(result(verified ? "verified" : "unverified", true), { headers });
      }
      if (!hasMore) return NextResponse.json(result("unverified", true), { headers });
      const next = data[data.length - 1]?.id;
      if (typeof next !== "string" || !next || next === after) throw new Error("Provider pagination unavailable");
      after = next;
    }
    throw new Error("Provider pagination limit");
  } catch {
    return NextResponse.json(result("unavailable", true), { status: 503, headers });
  }
}
