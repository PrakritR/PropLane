/**
 * `POST /api/portal/listing-extract-ad` — listing fields from ad text the
 * manager pasted. Manager-only. Text in, JSON out; this route never fetches a
 * URL (docs/agents/listing-prefill.md).
 */
import { NextResponse } from "next/server";
import { resolveAgentContext } from "@/lib/tools/context";
import { track } from "@/lib/analytics/posthog";
import { AD_TEXT_MAX_CHARS, extractAdText } from "@/lib/listing-prefill/extract-ad.server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let raw: { text?: unknown };
  try {
    raw = (await req.json()) as { text?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const text = typeof raw.text === "string" ? raw.text.trim() : "";
  if (text.length < 20) return NextResponse.json({ error: "Paste the ad's headline and body first." }, { status: 400 });
  if (text.length > AD_TEXT_MAX_CHARS) {
    return NextResponse.json({ error: `That's longer than ${AD_TEXT_MAX_CHARS.toLocaleString("en-US")} characters — paste just the ad.` }, { status: 413 });
  }

  const { ad, source } = await extractAdText(text, ctx);
  const filled = Object.entries(ad).filter(([, v]) => (Array.isArray(v) ? v.length > 0 : v != null)).length;
  track("listing_ad_text_imported", ctx.userId, { fields: filled, source });
  return NextResponse.json({ ad, source });
}
