import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import {
  ALL_SHEET_PROPERTIES,
  loadGoogleSheetsConnection,
  loadManagerSheetBindings,
  newSheetBindingId,
  occupancyGidForSpreadsheet,
  publicManagerSheetBinding,
  saveGoogleSheetsConnection,
  saveManagerSheetBindings,
  type ManagerSheetBinding,
  type ManagerSheetStaysTab,
} from "@/lib/manager-sheet-link";
import { googleSheetsPublicStatus } from "@/lib/sheet-sync/google-sheets-auth";
import { warmGoogleCalendarOAuthConfig } from "@/lib/google-calendar/settings";
import type { StaysTableColumnMap } from "@/lib/sheet-sync/parse-stays-table";

export const runtime = "nodejs";

function asTrimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET() {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  await warmGoogleCalendarOAuthConfig();
  const [bindings, sheets] = await Promise.all([
    loadManagerSheetBindings(actor.db, actor.userId),
    loadGoogleSheetsConnection(actor.db, actor.userId),
  ]);
  return NextResponse.json({
    links: bindings.map(publicManagerSheetBinding),
    sheets: googleSheetsPublicStatus(sheets),
  });
}

export async function POST(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    spreadsheetId?: unknown;
    title?: unknown;
    workspaceId?: unknown;
    propertyId?: unknown;
  } | null;
  const spreadsheetId = asTrimmed(body?.spreadsheetId);
  if (!spreadsheetId) {
    return NextResponse.json({ error: "Choose a spreadsheet." }, { status: 400 });
  }
  const propertyId = asTrimmed(body?.propertyId);
  const next: ManagerSheetBinding = {
    id: newSheetBindingId(),
    title: asTrimmed(body?.title) || "Spreadsheet",
    spreadsheetId,
    occupancyGid: occupancyGidForSpreadsheet(spreadsheetId),
    houseTabs: [],
    staysTab: null,
    workspaceId: asTrimmed(body?.workspaceId),
    propertyId: propertyId && propertyId !== ALL_SHEET_PROPERTIES ? propertyId : null,
    autoSync: true,
    lastSyncedAt: null,
    lastError: null,
    lastSummary: null,
  };
  const saved = await saveManagerSheetBindings(actor.db, actor.userId, [
    ...(await loadManagerSheetBindings(actor.db, actor.userId)),
    next,
  ]);
  return NextResponse.json({ links: saved.map(publicManagerSheetBinding) });
}

export async function PATCH(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    id?: unknown;
    spreadsheetId?: unknown;
    title?: unknown;
    workspaceId?: unknown;
    propertyId?: unknown;
    autoSync?: unknown;
    /** BUILD-WAVE2 C210: `null` clears the linked stays tab; omit to leave it as-is. */
    staysTab?: {
      gid?: unknown;
      title?: unknown;
      columnMap?: unknown;
      nameMap?: unknown;
    } | null;
  } | null;
  const id = asTrimmed(body?.id);
  if (!id) return NextResponse.json({ error: "Missing spreadsheet." }, { status: 400 });
  const bindings = await loadManagerSheetBindings(actor.db, actor.userId);
  const index = bindings.findIndex((row) => row.id === id);
  if (index < 0) return NextResponse.json({ error: "Spreadsheet not found." }, { status: 404 });
  const current = bindings[index];
  const spreadsheetId = asTrimmed(body?.spreadsheetId) || current.spreadsheetId;
  const propertyRaw = body?.propertyId === null ? ALL_SHEET_PROPERTIES : asTrimmed(body?.propertyId);
  const staysTab: ManagerSheetStaysTab | null =
    body?.staysTab === undefined
      ? current.staysTab
      : body.staysTab === null
        ? null
        : {
            gid: asTrimmed(body.staysTab.gid),
            title: asTrimmed(body.staysTab.title),
            columnMap:
              body.staysTab.columnMap && typeof body.staysTab.columnMap === "object"
                ? (body.staysTab.columnMap as StaysTableColumnMap)
                : null,
            nameMap:
              body.staysTab.nameMap && typeof body.staysTab.nameMap === "object" && !Array.isArray(body.staysTab.nameMap)
                ? Object.fromEntries(
                    Object.entries(body.staysTab.nameMap as Record<string, unknown>).filter(
                      (entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim().length > 0,
                    ),
                  )
                : {},
          };
  if (staysTab && !staysTab.gid) {
    return NextResponse.json({ error: "Choose a tab to link as Stays." }, { status: 400 });
  }
  bindings[index] = {
    ...current,
    spreadsheetId,
    occupancyGid: occupancyGidForSpreadsheet(spreadsheetId, current.occupancyGid),
    title: asTrimmed(body?.title) || current.title,
    workspaceId: typeof body?.workspaceId === "string" ? body.workspaceId.trim() : current.workspaceId,
    propertyId:
      body?.propertyId === undefined
        ? current.propertyId
        : propertyRaw && propertyRaw !== ALL_SHEET_PROPERTIES
          ? propertyRaw
          : null,
    autoSync: typeof body?.autoSync === "boolean" ? body.autoSync : current.autoSync,
    staysTab,
  };
  const saved = await saveManagerSheetBindings(actor.db, actor.userId, bindings);
  return NextResponse.json({ links: saved.map(publicManagerSheetBinding) });
}

export async function DELETE(req: Request) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const url = new URL(req.url);
  const id = url.searchParams.get("id")?.trim() || "";
  const google = url.searchParams.get("google") === "1";
  if (google) {
    await saveGoogleSheetsConnection(actor.db, actor.userId, {
      connected: false,
      email: null,
      refreshToken: null,
      accessToken: null,
      accessTokenExpiresAt: null,
    });
    return NextResponse.json({ ok: true });
  }
  if (!id) return NextResponse.json({ error: "Missing spreadsheet." }, { status: 400 });
  const saved = await saveManagerSheetBindings(
    actor.db,
    actor.userId,
    (await loadManagerSheetBindings(actor.db, actor.userId)).filter((row) => row.id !== id),
  );
  return NextResponse.json({ links: saved.map(publicManagerSheetBinding) });
}
