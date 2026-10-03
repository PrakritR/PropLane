import { NextResponse } from "next/server";

import { requireBookingsManager } from "@/lib/channel-calendar/require-manager.server";
import { listStayMeta, saveStayMeta } from "@/lib/channel-calendar/stay-meta.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    return NextResponse.json({ metas: await listStayMeta(ctx.db, ctx.userId) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

/** Notes and stay details for a signed-lease or application stay (C2-BK2 / CX-ST1). */
export async function POST(req: Request) {
  try {
    const ctx = await requireBookingsManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = await req.json().catch(() => null);
    const result = await saveStayMeta(ctx.db, ctx.userId, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true, meta: result.meta });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}
