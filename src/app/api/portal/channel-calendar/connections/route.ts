import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import { resolveRequestOrigin } from "@/lib/app-url";
import { NextResponse } from "next/server";

import {
  deleteChannelCalendarConnection,
  ensureRoomExportCalendarUrl,
  listChannelCalendarConnections,
  upsertChannelCalendarConnection,
} from "@/lib/channel-calendar/sync.server";
import {
  isChannelCalendarInputError,
  parseChannelCalendarProvider,
} from "@/lib/channel-calendar/airbnb-url";
import {
  managerCanWriteCalendarForProperties,
  managerCanWriteCalendarForProperty,
  managerHasCalendarAccessForProperty,
} from "@/lib/auth/manager-lease-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

async function requireManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  if (!(await userHoldsManagerRole(db, user.id))) return null;
  return { db, userId: user.id };
}

type BatchItem = { propertyId?: string; roomId?: string; provider?: string | null; label?: string | null; importUrl?: string | null };
type BatchResult = { ok: true; connection: Awaited<ReturnType<typeof upsertChannelCalendarConnection>> } | { ok: false; error: string };

/** Most links one request carries: a 28-room workspace on a few channels, with room to spare. */
const CONNECTION_BATCH_MAX = 100;

/**
 * Each item is exactly one single-room POST: the same Calendar-at-edit check on ITS house (decided once per
 * house, in one round trip), the same validator, the same upsert. One bad item never fails the others; every
 * item answers for itself, in order.
 */
async function saveBatch(ctx: { db: ReturnType<typeof createSupabaseServiceRoleClient>; userId: string }, items: BatchItem[], browserOrigin: string): Promise<BatchResult[]> {
  const list = items.slice(0, CONNECTION_BATCH_MAX);
  const writable = await managerCanWriteCalendarForProperties(
    ctx.db,
    ctx.userId,
    [...new Set(list.map((item) => item.propertyId?.trim() ?? "").filter(Boolean))],
  );
  const results: BatchResult[] = [];
  for (const item of list) {
    const propertyId = item.propertyId?.trim() ?? "";
    const roomId = item.roomId?.trim() ?? "";
    if (!propertyId || !roomId) {
      results.push({ ok: false, error: "propertyId and roomId are required." });
      continue;
    }
    const provider = item.provider == null || String(item.provider).trim() === "" ? "airbnb" : parseChannelCalendarProvider(item.provider);
    if (!provider) {
      results.push({ ok: false, error: "Unknown calendar channel." });
      continue;
    }
    if (!writable.has(propertyId)) {
      results.push({ ok: false, error: "Forbidden." });
      continue;
    }
    try {
      const connection = await upsertChannelCalendarConnection(
        ctx.db,
        {
          managerUserId: ctx.userId,
          propertyId,
          roomId,
          provider,
          label: item.label ?? null,
          ...(Object.prototype.hasOwnProperty.call(item, "importUrl") ? { importUrl: item.importUrl ?? null } : {}),
        },
        browserOrigin,
      );
      results.push({ ok: true, connection });
    } catch (e) {
      results.push({ ok: false, error: e instanceof Error ? e.message : "Failed." });
    }
  }
  return results;
}

export async function GET(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    // Which of these properties the caller may link calendars on (Calendar module at edit), so the connect
    // modal lists only those. A hint for the UI: every write below re-checks on the server.
    const writableFor = url.searchParams.get("writableFor");
    if (writableFor !== null) {
      const candidates = [...new Set(writableFor.split(",").map((id) => id.trim()).filter(Boolean))].slice(0, 200);
      const writable = await managerCanWriteCalendarForProperties(ctx.db, ctx.userId, candidates);
      return NextResponse.json({ writablePropertyIds: candidates.filter((id) => writable.has(id)) });
    }
    const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
    const roomId = url.searchParams.get("roomId")?.trim() ?? "";
    const roomLabel = url.searchParams.get("roomLabel")?.trim() ?? "";
    if (!propertyId) {
      return NextResponse.json({ error: "propertyId is required." }, { status: 400 });
    }
    if (!(await managerHasCalendarAccessForProperty(ctx.db, ctx.userId, propertyId))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const browserOrigin = resolveRequestOrigin(req);
    if (roomId) {
      // The destination is the site the link is pasted into; "other" carries every channel.
      const rawDestination = url.searchParams.get("provider")?.trim() ?? "";
      const destination = rawDestination === "other" ? "other" : rawDestination ? parseChannelCalendarProvider(rawDestination) : "airbnb";
      if (!destination) return NextResponse.json({ error: "Unknown calendar channel." }, { status: 400 });
      // On a cache miss this MINTS a connection row and a secret public export token, so it is a
      // write however much it reads like one: Calendar at edit, like linking and unlinking.
      if (!(await managerCanWriteCalendarForProperty(ctx.db, ctx.userId, propertyId))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const exportUrl = await ensureRoomExportCalendarUrl(
        ctx.db,
        { propertyId, roomId, label: roomLabel || null, destination },
        browserOrigin,
      );
      return NextResponse.json({ exportUrl });
    }

    const connections = await listChannelCalendarConnections(ctx.db, propertyId, browserOrigin);
    return NextResponse.json({ connections });
  } catch (e) {
    if (isChannelCalendarInputError(e)) return NextResponse.json({ error: e.message, field: e.field }, { status: 400 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const browserOrigin = resolveRequestOrigin(req);
    const body = (await req.json()) as {
      propertyId?: string;
      roomId?: string;
      provider?: string | null;
      label?: string | null;
      importUrl?: string | null;
      /** Batch: the popup's Save (and Paste many) sends every changed room in one request. */
      connections?: BatchItem[];
    };

    if (Array.isArray(body.connections)) {
      return NextResponse.json({ results: await saveBatch(ctx, body.connections, browserOrigin) });
    }

    const propertyId = body.propertyId?.trim() ?? "";
    const roomId = body.roomId?.trim() ?? "";
    if (!propertyId || !roomId) {
      return NextResponse.json({ error: "propertyId and roomId are required." }, { status: 400 });
    }
    const provider = body.provider == null || String(body.provider).trim() === ""
      ? "airbnb"
      : parseChannelCalendarProvider(body.provider);
    if (!provider) {
      return NextResponse.json({ error: "Unknown calendar channel." }, { status: 400 });
    }
    if (!(await managerCanWriteCalendarForProperty(ctx.db, ctx.userId, propertyId))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const connection = await upsertChannelCalendarConnection(
      ctx.db,
      {
        managerUserId: ctx.userId,
        propertyId,
        roomId,
        provider,
        label: body.label ?? null,
        ...(Object.prototype.hasOwnProperty.call(body, "importUrl") ? { importUrl: body.importUrl ?? null } : {}),
      },
      browserOrigin,
    );
    return NextResponse.json({ connection });
  } catch (e) {
    // A mistyped import URL is the caller's input, not a server fault. It used
    // to fall into the generic 500 below, which the Link Airbnb modal showed as
    // nothing at all — the manager clicked Save and the dialog just sat there.
    if (isChannelCalendarInputError(e)) {
      return NextResponse.json({ error: e.message, field: e.field }, { status: 400 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed." }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const ctx = await requireManager();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const url = new URL(req.url);
    const connectionId = url.searchParams.get("id")?.trim() ?? "";
    if (!connectionId) {
      return NextResponse.json({ error: "id is required." }, { status: 400 });
    }

    const { data: row } = await ctx.db
      .from("external_calendar_connections")
      .select("property_id")
      .eq("id", connectionId)
      .maybeSingle();
    if (!row) {
      return NextResponse.json({ error: "Connection not found." }, { status: 404 });
    }
    if (!(await managerCanWriteCalendarForProperty(ctx.db, ctx.userId, String(row.property_id)))) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    await deleteChannelCalendarConnection(ctx.db, connectionId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    const status = message === "Connection not found." ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
