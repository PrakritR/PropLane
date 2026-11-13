import { NextResponse } from "next/server";

import { requireChannelFinanceContext } from "@/lib/channel-finance/access.server";
import { previewChannelCsv } from "@/lib/channel-finance/csv-import";
import { loadFinanceCandidates, recordFinanceFacts } from "@/lib/channel-finance/store.server";
import { FINANCE_PLATFORMS, type FinancePlatform } from "@/lib/channel-finance/types";

export const runtime = "nodejs";

const MAX_CSV_BYTES = 2_000_000;

/**
 * Backfill from a channel's own CSV export. `commit: false` (default) previews: per-row errors, skipped rows and what would be
 * saved, writing nothing. `commit: true` saves every READY row, idempotent on (platform, confirmation code, kind): the same
 * file twice changes nothing. A bad row never blocks the good ones.
 */
export async function POST(req: Request) {
  try {
    const ctx = await requireChannelFinanceContext("edit");
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json().catch(() => ({}))) as { platform?: unknown; csv?: unknown; commit?: unknown };
    const platform = FINANCE_PLATFORMS.find((p) => p === body.platform) as FinancePlatform | undefined;
    if (!platform) return NextResponse.json({ error: "Pick Airbnb or Booking.com." }, { status: 400 });
    if (typeof body.csv !== "string" || !body.csv.trim()) return NextResponse.json({ error: "Choose a CSV file." }, { status: 400 });
    if (body.csv.length > MAX_CSV_BYTES) return NextResponse.json({ error: "That file is too large (2 MB max)." }, { status: 413 });
    const preview = previewChannelCsv(platform, body.csv);
    const summary = { ready: preview.rows.length, errors: preview.errors.slice(0, 200), errorCount: preview.errors.length, skipped: preview.skipped.length, fatal: preview.fatal };
    if (body.commit !== true || preview.fatal) {
      return NextResponse.json({ committed: false, ...summary, sample: preview.rows.slice(0, 8).map((r) => ({ line: r.line, ...r.facts })) });
    }
    const candidates = await loadFinanceCandidates(ctx.db, { ownerUserId: ctx.scope.ownerUserId, workspaceId: ctx.scope.workspaceId });
    let saved = 0;
    let needsRoom = 0;
    let failed = 0;
    for (const row of preview.rows) {
      const outcome = await recordFinanceFacts(ctx.db, { ownerUserId: ctx.scope.ownerUserId, workspaceId: ctx.scope.workspaceId, facts: row.facts, source: "csv", review: "ok", candidates });
      if (!outcome) failed += 1;
      else {
        saved += 1;
        if (outcome.reviewStatus === "needs_room") needsRoom += 1;
      }
    }
    return NextResponse.json({ committed: true, ...summary, saved, needsRoom, failed });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
