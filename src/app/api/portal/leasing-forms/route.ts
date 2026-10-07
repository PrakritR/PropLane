import { NextResponse } from "next/server";

import { loadLeasingFormsLibrary, saveLeasingFormsLibrary } from "@/lib/leasing-forms-library.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/** One workspace's Forms library is a few dozen drafts; anything bigger is not a form library. */
const MAX_BODY_BYTES = 2_000_000;

/** The workspace Forms library: every application and lease form defined once (`leasing-forms-library.ts`). */
export async function GET() {
  try {
    const ctx = await requireManagerRouteUser({ fast: true });
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const library = await loadLeasingFormsLibrary(ctx.db, ctx.userId);
    return NextResponse.json({ library });
  } catch {
    return NextResponse.json({ error: "Could not load forms." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  try {
    const ctx = await requireManagerRouteUser();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const text = await req.text();
    if (text.length > MAX_BODY_BYTES) return NextResponse.json({ error: "Too many forms to save." }, { status: 413 });
    let body: { library?: unknown } | null = null;
    try {
      body = JSON.parse(text) as { library?: unknown };
    } catch {
      body = null;
    }
    if (!body || typeof body.library !== "object" || body.library === null) {
      return NextResponse.json({ error: "Send the forms to save." }, { status: 400 });
    }
    const library = await saveLeasingFormsLibrary(ctx.db, ctx.userId, body.library);
    return NextResponse.json({ library });
  } catch {
    return NextResponse.json({ error: "Could not save forms." }, { status: 500 });
  }
}
