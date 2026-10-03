import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Retired (captain, Oct 3 2026): every workspace is application first, then lease, then the
 * move-in form, so no prospect ever starts a lease ahead of an application. The route stays so an
 * old client gets a clear answer instead of a 404; it creates nothing.
 */
export async function POST() {
  return NextResponse.json({ error: "This home takes an application first." }, { status: 409 });
}
