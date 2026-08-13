import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { parseResidentDocumentPdf } from "@/lib/resident-document-import/parse-resident-document.server";
import type { ResidentDocumentKind } from "@/lib/resident-document-import/types";

export const runtime = "nodejs";

const MAX_DATA_URL_CHARS = 5 * 1024 * 1024;

export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (auth.role !== "manager" && auth.role !== "admin") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const limited = await rateLimit(`parse-resident-document:${auth.userId}`, 8, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many parse requests. Try again shortly." }, { status: 429 });
  }

  let body: { dataUrl?: string; fileName?: string; kind?: ResidentDocumentKind; propertyId?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const dataUrl = body.dataUrl?.trim() ?? "";
  const fileName = body.fileName?.trim() || "Uploaded document.pdf";
  const kind = body.kind === "lease" ? "lease" : body.kind === "application" ? "application" : null;
  if (!kind) return NextResponse.json({ error: "Document kind is required." }, { status: 400 });
  if (!dataUrl.startsWith("data:application/pdf")) {
    return NextResponse.json({ error: "A PDF data URL is required." }, { status: 400 });
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    return NextResponse.json({ error: "PDF is too large to parse." }, { status: 413 });
  }

  try {
    const parse = await parseResidentDocumentPdf({
      db: auth.db,
      managerUserId: auth.userId,
      kind,
      dataUrl,
      fileName,
      preferredPropertyId: body.propertyId?.trim() || null,
      // TraceActor is { userId, sessionId?, metadata? } — AGENTS.md requires the
      // trace to carry landlordId, which rides in metadata rather than as a
      // top-level field.
      actor: { userId: auth.userId, metadata: { landlordId: auth.userId } },
    });
    return NextResponse.json({ parse });
  } catch (err) {
    console.error("parse-resident-document: unexpected failure", err);
    return NextResponse.json({ error: "Could not parse that PDF." }, { status: 500 });
  }
}
