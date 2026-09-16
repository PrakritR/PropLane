import { NextResponse } from "next/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  lookupResidentConfirmation,
  rateResidentConfirmation,
  resolveResidentConfirmation,
} from "@/lib/work-order-resident-confirmation.server";

export const runtime = "nodejs";

/**
 * Public, token-authenticated: the resident's "was this fixed?" answer. The
 * token is the authorization — it was minted for exactly one work order and
 * one ask — so there is no session here on purpose (the link is opened from an
 * email or a text, often on a phone that has never signed in).
 */
export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get("t")?.trim() ?? "";
  if (!token) return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  const db = createSupabaseServiceRoleClient();
  const result = await lookupResidentConfirmation(db, token);
  return NextResponse.json(result, { status: result.ok ? 200 : 404, headers: { "Cache-Control": "no-store" } });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    token?: string;
    action?: "fixed" | "not_fixed" | "rate";
    note?: string;
    rating?: number;
  };
  const token = String(body.token ?? "").trim();
  if (!token) return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  const db = createSupabaseServiceRoleClient();
  if (body.action === "rate") {
    const result = await rateResidentConfirmation(db, { token, rating: Number(body.rating), note: body.note });
    return NextResponse.json(result, { status: result.ok ? 200 : 409 });
  }
  if (body.action !== "fixed" && body.action !== "not_fixed") {
    return NextResponse.json({ ok: false, reason: "invalid" }, { status: 400 });
  }
  const result = await resolveResidentConfirmation(db, { token, verdict: body.action, note: body.note });
  return NextResponse.json(result, { status: result.ok ? 200 : 409 });
}
