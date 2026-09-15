import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import { PropertyImportFileError, readPropertyImportFile } from "@/lib/property-import/read-file.server";
import { PropertyImportUnderstandError, understandPropertyImport } from "@/lib/property-import/understand.server";
import { PROPERTY_IMPORT_MAX_BYTES, type PropertyImportReadResponse } from "@/lib/property-import/types";

/**
 * POST multipart { file, hint? } → what PropLane understood from the file.
 *
 * Nothing is stored here. The workspace turns each understood property into
 * an ordinary listing draft through the same save path Add property uses, so
 * ownership, the plan limit and autosave stay one code path.
 */
export const runtime = "nodejs";
export const maxDuration = 120;

const STATUS: Record<Extract<PropertyImportReadResponse, { ok: false }>["code"], number> = {
  unreadable: 422,
  empty: 422,
  too_large: 413,
  unsupported: 415,
  unavailable: 503,
};

function fail(code: keyof typeof STATUS, error: string) {
  return NextResponse.json({ ok: false, error, code } satisfies PropertyImportReadResponse, { status: STATUS[code] });
}

export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return NextResponse.json({ ok: false, error: "Sign in required.", code: "unavailable" }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Not found." }, { status: 404 });

  const limited = await rateLimit(`property-import-read:${auth.userId}`, 8, 60_000);
  if (!limited.ok) return NextResponse.json({ ok: false, error: "Too many reads in a row. Try again in a minute.", code: "unavailable" }, { status: 429 });

  const length = Number(req.headers.get("content-length") ?? "0");
  if (length > PROPERTY_IMPORT_MAX_BYTES + 64 * 1024) return fail("too_large", "That file is over 5 MB. Export a smaller sheet, or split it.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: "Send the file as multipart form data.", code: "unsupported" }, { status: 400 });
  }
  const file = form.get("file");
  if (!(file instanceof File)) return NextResponse.json({ ok: false, error: "A file is required.", code: "unsupported" }, { status: 400 });
  const hintRaw = form.get("hint");
  const hint = typeof hintRaw === "string" ? hintRaw : null;

  let source;
  try {
    source = await readPropertyImportFile({
      bytes: new Uint8Array(await file.arrayBuffer()),
      fileName: file.name || "import",
      mediaType: file.type || "",
    });
  } catch (err) {
    if (err instanceof PropertyImportFileError) return fail(err.code, err.message);
    console.error("property-import: read failed", err);
    return fail("unreadable", "Couldn't open that file.");
  }

  try {
    const understanding = await understandPropertyImport({
      source,
      hint,
      actor: { userId: auth.userId, metadata: { landlordId: auth.userId } },
    });
    track(hint ? "property_import_reread" : "property_import_read", auth.userId, {
      sourceKind: understanding.sourceKind,
      sheets: understanding.sheets.length,
      rowsRead: understanding.rowsRead,
      propertyCount: understanding.properties.length,
      roomCount: understanding.properties.reduce((n, p) => n + p.rooms.length, 0),
      needsLookCount: understanding.properties.filter((p) => p.needsLook.length > 0).length,
      withHint: Boolean(hint),
    });
    return NextResponse.json({ ok: true, understanding } satisfies PropertyImportReadResponse);
  } catch (err) {
    if (err instanceof PropertyImportUnderstandError) return fail(err.code, err.message);
    console.error("property-import: understand failed", err);
    return fail("unreadable", "PropLane couldn't read that file just now. Try again in a moment.");
  }
}
