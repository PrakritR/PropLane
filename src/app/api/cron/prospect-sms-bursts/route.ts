import { NextResponse, after } from "next/server";
import { recoverProspectSmsBursts } from "@/lib/sms/prospect-sms-burst.server";
import { runInlineProspectBurst } from "@/lib/sms/prospect-sms-burst-job.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 120;

// ponytail: a few inline runs per sweep while the queue is down; the next sweep takes the rest.
const MAX_INLINE_PER_SWEEP = 3;
// A turn can take up to ~60s. Start none after this, so no run is killed at
// maxDuration holding a credit reservation that later replays as "interrupted".
const INLINE_START_DEADLINE_MS = 40_000;

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const startedAt = Date.now();
    const db = createSupabaseServiceRoleClient();
    const { unpublished, ...result } = await recoverProspectSmsBursts(db);
    const dueMs = (dueAt: string | null) => (dueAt ? Date.parse(dueAt) : 0);
    const inline = unpublished
      .filter((burst) => dueMs(burst.dueAt) <= startedAt)
      .sort((a, b) => dueMs(a.dueAt) - dueMs(b.dueAt))
      .slice(0, MAX_INLINE_PER_SWEEP);
    if (inline.length) {
      // The queue refused these (outage or quota). Run them here behind the same
      // revision claim rather than waiting for the queue to come back.
      const deadline = startedAt + INLINE_START_DEADLINE_MS;
      after(async () => {
        for (const burst of inline) {
          if (Date.now() >= deadline) break;
          await runInlineProspectBurst(db, { ...burst, dueAt: null });
        }
      });
    }
    return NextResponse.json(
      { ok: result.failed === 0, ...result, inline: inline.length },
      { status: result.failed === 0 ? 200 : 503 },
    );
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Prospect SMS burst recovery failed.",
    }, { status: 503 });
  }
}
