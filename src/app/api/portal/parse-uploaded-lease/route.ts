import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { parseUploadedLeasePdfBytes, dataUrlToPdfBytes } from "@/lib/uploaded-lease-parse.server";
import { UnsafePdfImportError } from "@/lib/pdf-import/pdf-source.server";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Mirrors the 3.5 MB cap `managerUploadLeasePdf` enforces, plus base64 overhead. */
const MAX_DATA_URL_CHARS = 5 * 1024 * 1024;

/**
 * Structure a manager-uploaded lease PDF into PropLane's lease format.
 *
 * The caller posts bytes it already holds (it just chose the file), so this
 * route discloses nothing new — but it is still manager-authenticated and rate
 * limited, because it burns CPU on a PDF stack. It reads and writes no lease
 * rows: persistence stays in the lease-pipeline store, and this route is a pure
 * bytes-in / structure-out transform.
 *
 * The lease text never leaves this process. Extraction is deterministic regex
 * (`uploaded-lease-extraction.ts`), deliberately not a model call: lease
 * content is private tenant data and sending it to a third party is the
 * captain's decision, not this route's.
 */
export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (auth.role !== "manager" && auth.role !== "admin") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const limited = await rateLimit(`parse-uploaded-lease:${auth.userId}`, 12, 60_000);
  if (!limited.ok) {
    return NextResponse.json({ error: "Too many parse requests. Try again shortly." }, { status: 429 });
  }

  let body: { dataUrl?: string; fileName?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const dataUrl = body.dataUrl?.trim() ?? "";
  const fileName = body.fileName?.trim() || "Uploaded lease.pdf";
  if (!dataUrl.startsWith("data:application/pdf")) {
    return NextResponse.json({ error: "A PDF data URL is required." }, { status: 400 });
  }
  if (dataUrl.length > MAX_DATA_URL_CHARS) {
    return NextResponse.json({ error: "PDF is too large to parse." }, { status: 413 });
  }

  try {
    const parse = await parseUploadedLeasePdfBytes({ bytes: dataUrlToPdfBytes(dataUrl), fileName });
    return NextResponse.json({ parse });
  } catch (error) {
    if (error instanceof UnsafePdfImportError) {
      return NextResponse.json({ error: "PDF contains active or unsupported content and cannot be imported." }, { status: 422 });
    }
    // Parser exceptions may include PDF metadata or extracted fragments. Keep
    // the request log content-free; the client only needs a safe failure.
    return NextResponse.json({ error: "Could not parse that lease PDF." }, { status: 500 });
  }
}
