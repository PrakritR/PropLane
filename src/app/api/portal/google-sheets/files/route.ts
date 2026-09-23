import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { getGoogleSheetsAccessToken } from "@/lib/sheet-sync/google-sheets-auth";

export const runtime = "nodejs";

export async function GET() {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const accessToken = await getGoogleSheetsAccessToken(actor.db, actor.userId);
  if (!accessToken) {
    return NextResponse.json({ error: "Connect Google first." }, { status: 401 });
  }
  const query = encodeURIComponent("mimeType='application/vnd.google-apps.spreadsheet' and trashed=false");
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${query}&fields=files(id,name)&pageSize=50&orderBy=viewedByMeTime desc`,
    { headers: { Authorization: `Bearer ${accessToken}` } },
  );
  const data = (await res.json().catch(() => null)) as { files?: Array<{ id?: string; name?: string }>; error?: { message?: string } } | null;
  if (!res.ok) {
    return NextResponse.json({ error: data?.error?.message || "Could not list spreadsheets." }, { status: 400 });
  }
  return NextResponse.json({
    files: (data?.files ?? [])
      .map((file) => ({ id: file.id?.trim() || "", name: file.name?.trim() || "Spreadsheet" }))
      .filter((file) => file.id),
  });
}
