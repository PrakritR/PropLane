import { NextResponse } from "next/server";
import { parseLeasePdfBuffer } from "@/lib/lease-pdf-parse.server";
import { isLeaseTemplatePath, LEASE_TEMPLATE_BUCKET } from "@/lib/lease-template-storage";
import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export const maxDuration = 60;

const ALLOWED_KINDS = new Set<PropertyLeaseTemplateKind>(["short-term", "long-term", "time-based", "custom"]);

export async function POST(req: Request) {
  const auth = await getReportsAuthContext();
  if (!auth?.userId) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  const limited = await rateLimit(`parse-lease-pdf:${auth.userId}`, 12, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many parse requests. Try again shortly." }, { status: 429 });
  }

  let body: { path?: string; fileName?: string; kind?: PropertyLeaseTemplateKind };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const path = body.path?.trim() ?? "";
  const fileName = body.fileName?.trim() || "Uploaded lease.pdf";
  const kindHint = body.kind && ALLOWED_KINDS.has(body.kind) ? body.kind : undefined;

  if (!path || !isLeaseTemplatePath(path)) {
    return NextResponse.json({ error: "Invalid lease template path." }, { status: 400 });
  }

  const folderOwner = path.split("/")[0] ?? "";
  if (folderOwner !== auth.userId) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const db = createSupabaseServiceRoleClient();
  const { data, error } = await db.storage.from(LEASE_TEMPLATE_BUCKET).download(path);
  if (error || !data) {
    return NextResponse.json({ error: "Could not read that lease file." }, { status: 404 });
  }

  const bytes = Buffer.from(await data.arrayBuffer());
  const docUrl = `/api/portal/lease-template?path=${encodeURIComponent(path)}`;

  try {
    const { html, parsed, sourceSha256, sourceIssues, coverage } = await parseLeasePdfBuffer({
      bytes,
      docName: fileName,
      docUrl,
      kindHint,
    });
    return NextResponse.json({
      html,
      inferredKind: parsed.inferredKind,
      sectionCount: parsed.sections.length,
      sourceSha256,
      sourceIssues,
      coverage,
    });
  } catch {
    // PDF/parser exceptions can contain document metadata or extracted text.
    return NextResponse.json({ error: "Could not parse that lease PDF." }, { status: 422 });
  }
}
