import { NextResponse } from "next/server";
import { authorizeDispatchActor } from "@/lib/vendor-dispatch/access.server";
import { listDispatchRuns } from "@/lib/vendor-dispatch/runs-read.server";

export const runtime = "nodejs";

const SOURCE_TYPES = new Set(["work_order", "service_request", "tour", "cleaning", "manual"]);
const STATUSES = new Set([
  "awaiting_approval",
  "offering",
  "accepted",
  "exhausted",
  "declined_by_manager",
  "canceled",
  "completed",
]);

/** Dispatch runs of the active workspace: `?sourceType=&sourceId=` for one service, `?status=awaiting_approval` for the Filter. */
export async function GET(req: Request) {
  try {
    const gate = await authorizeDispatchActor("read");
    if (!gate.ok) return gate.response;
    const url = new URL(req.url);
    const sourceType = url.searchParams.get("sourceType")?.trim() || null;
    const sourceId = url.searchParams.get("sourceId")?.trim() || null;
    const status = url.searchParams.get("status")?.trim() || null;
    if (sourceType && !SOURCE_TYPES.has(sourceType)) return NextResponse.json({ error: "Unknown source." }, { status: 400 });
    if (status && !STATUSES.has(status)) return NextResponse.json({ error: "Unknown status." }, { status: 400 });
    if (sourceId && sourceId.length > 200) return NextResponse.json({ error: "Unknown source." }, { status: 400 });
    const result = await listDispatchRuns(gate.db, gate.actor, { sourceType, sourceId, status });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ runs: result.runs });
  } catch {
    return NextResponse.json({ error: "Could not load dispatch." }, { status: 500 });
  }
}
