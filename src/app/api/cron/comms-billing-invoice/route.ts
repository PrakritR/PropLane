import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/server-env";

export const runtime = "nodejs";
export const maxDuration = 300;

function isAuthorized(req: Request): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    // Same rule as every other cron here: preview deployments are public and
    // hold real credentials, so secretless access is a localhost convenience
    // only. This one moves money, so it fails closed everywhere else.
    return !process.env.VERCEL_ENV && !isProductionRuntime();
  }
  return req.headers.get("authorization") === `Bearer ${cronSecret}`;
}

/** Legacy endpoint retained for existing cron configuration; it never charges cards. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  return NextResponse.json({ ok: true, skipped: "prepaid_credit", invoiced: 0 });
}
