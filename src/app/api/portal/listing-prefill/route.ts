/**
 * `POST /api/portal/listing-prefill` — facts, a rent estimate and an
 * earlier-ad pointer for one address. Manager-only.
 *
 * Order of work: signed-in check → 30-day cache (free) → plan quota → the
 * providers → cache write. The answer always carries a `status` so the wizard
 * card can show found / none / quota / error / unavailable without guessing
 * from an HTTP code. See docs/agents/listing-prefill.md.
 */
import { NextResponse } from "next/server";
import { resolveAgentContext } from "@/lib/tools/context";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { track } from "@/lib/analytics/posthog";
import { lookupAddressFacts, recordsProviderKind } from "@/lib/listing-prefill/records.server";
import { findPriorAd } from "@/lib/listing-prefill/prior-ad.server";
import { consumeLookup, readPrefillCache, writePrefillCache } from "@/lib/listing-prefill/quota.server";
import { prefillAddressKey, type ListingPrefillResult, type PrefillAddressInput } from "@/lib/listing-prefill/types";

export const runtime = "nodejs";

const MAX_PART = 200;

function part(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_PART) : "";
}

function answer(body: Partial<ListingPrefillResult> & { status: ListingPrefillResult["status"] }) {
  const full: ListingPrefillResult = {
    status: body.status,
    facts: body.facts ?? null,
    rent: body.rent ?? null,
    priorAd: body.priorAd ?? null,
    cached: body.cached ?? false,
    lookupsLeft: body.lookupsLeft ?? null,
    source: body.source ?? null,
  };
  return NextResponse.json(full);
}

export async function POST(req: Request) {
  const ctx = await resolveAgentContext();
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  let raw: Record<string, unknown>;
  try {
    raw = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }
  const input: PrefillAddressInput = { address: part(raw.address), city: part(raw.city), state: part(raw.state), zip: part(raw.zip) };
  if (!input.address) return NextResponse.json({ error: "A street address is required." }, { status: 400 });

  const provider = recordsProviderKind();
  if (!provider) return answer({ status: "unavailable" });

  const db = createSupabaseServiceRoleClient();
  const key = prefillAddressKey(input);

  const cached = await readPrefillCache(db, key, provider);
  if (cached) {
    track("listing_prefill_looked_up", ctx.userId, { found: Boolean(cached.facts), cached: true, priorAd: Boolean(cached.priorAd) });
    return answer({ status: cached.facts ? "found" : "none", facts: cached.facts, rent: cached.rent, priorAd: cached.priorAd, cached: true, source: cached.source });
  }

  const quota = await consumeLookup(db, ctx.userId);
  if (!quota.ok) {
    if (quota.reason === "quota") {
      track("listing_prefill_looked_up", ctx.userId, { found: false, cached: false, priorAd: false, quota: true });
      return answer({ status: "quota", lookupsLeft: 0 });
    }
    return answer({ status: "error" });
  }

  try {
    const [lookup, priorAd] = await Promise.all([lookupAddressFacts(input), findPriorAd(input)]);
    await writePrefillCache(db, key, { facts: lookup.facts, rent: lookup.rent, priorAd, source: provider });
    track("listing_prefill_looked_up", ctx.userId, { found: Boolean(lookup.facts), cached: false, priorAd: Boolean(priorAd) });
    return answer({
      status: lookup.facts ? "found" : "none",
      facts: lookup.facts,
      rent: lookup.rent,
      priorAd,
      cached: false,
      lookupsLeft: quota.left,
      source: provider,
    });
  } catch {
    // The provider failed, not the manager: say so and leave the step usable by hand.
    return answer({ status: "error", lookupsLeft: quota.left });
  }
}
