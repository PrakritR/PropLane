import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import { PropertyImportFileError, readPropertyImportFile } from "@/lib/property-import/read-file.server";
import { PropertyImportUnderstandError, understandPropertyImport } from "@/lib/property-import/understand.server";
import type { PropertyImportUnderstanding } from "@/lib/property-import/types";
import { UnderstandResidentsError, understandResidents } from "@/lib/portfolio-import/understand-residents.server";
import { proposePortfolioImport, fileKindFor } from "@/lib/portfolio-import/propose";
import { createPortfolioImportProposal } from "@/lib/portfolio-import/store.server";
import {
  PORTFOLIO_IMPORT_MAX_BYTES_PER_FILE,
  PORTFOLIO_IMPORT_MAX_FILES,
  PORTFOLIO_IMPORT_RATE_LIMIT_PER_MINUTE,
  type PortfolioImportProposal,
} from "@/lib/portfolio-import/types";

/**
 * POST multipart { files[] (1-50, ≤5MB each), hint? } -> a stored proposal.
 *
 * Runs the property/room read (src/lib/property-import/understand.server.ts,
 * unchanged) and the resident read (understand-residents.server.ts) over
 * EVERY file, merges them with `proposePortfolioImport`, and stores the
 * result under a fresh importId — the review screen and the agent's
 * `portfolio_import_status` tool both read that stored proposal, never the
 * raw model output again.
 */
export const runtime = "nodejs";
export const maxDuration = 300;

function fail(status: number, error: string) {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return fail(401, "Sign in required.");
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Not found." }, { status: 404 });

  const limited = await rateLimit(`portfolio-import-read:${auth.userId}`, PORTFOLIO_IMPORT_RATE_LIMIT_PER_MINUTE, 60_000);
  if (!limited.ok) return fail(429, "Too many reads in a row. Try again in a minute.");

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "Send the files as multipart form data.");
  }
  const files = form.getAll("files").filter((f): f is File => f instanceof File);
  if (files.length === 0) return fail(400, "At least one file is required.");
  if (files.length > PORTFOLIO_IMPORT_MAX_FILES) return fail(400, `Send at most ${PORTFOLIO_IMPORT_MAX_FILES} files.`);
  for (const file of files) {
    if (file.size > PORTFOLIO_IMPORT_MAX_BYTES_PER_FILE) return fail(413, `"${file.name}" is over 5 MB. Export a smaller file, or split it.`);
  }
  const hintRaw = form.get("hint");
  const hint = typeof hintRaw === "string" ? hintRaw : null;

  const understandings: PropertyImportUnderstanding[] = [];
  const residentsByFile: Awaited<ReturnType<typeof understandResidents>>[] = [];
  const fileMeta: { name: string; kind: "spreadsheet" | "appfolio" | "buildium" | "lease_pdf" | "rent_roll_pdf" | "unknown" }[] = [];

  for (const file of files) {
    let source;
    try {
      source = await readPropertyImportFile({ bytes: new Uint8Array(await file.arrayBuffer()), fileName: file.name || "import", mediaType: file.type || "" });
    } catch (err) {
      if (err instanceof PropertyImportFileError) return fail(err.code === "too_large" ? 413 : err.code === "unsupported" ? 415 : 422, `"${file.name}": ${err.message}`);
      console.error("portfolio-import: read failed", err);
      return fail(422, `Couldn't open "${file.name}".`);
    }

    try {
      const [understanding, residents] = await Promise.all([
        understandPropertyImport({ source, hint, actor: { userId: auth.userId, metadata: { landlordId: auth.userId } } }),
        understandResidents({ source, hint, actor: { userId: auth.userId, metadata: { landlordId: auth.userId } } }),
      ]);
      understandings.push(understanding);
      residentsByFile.push(residents);
      fileMeta.push({ name: file.name, kind: fileKindFor(understanding) });
    } catch (err) {
      if (err instanceof PropertyImportUnderstandError || err instanceof UnderstandResidentsError) {
        const status = err.code === "unavailable" ? 503 : 422;
        return fail(status, `"${file.name}": ${err.message}`);
      }
      console.error("portfolio-import: understand failed", err);
      return fail(422, `PropLane couldn't read "${file.name}" just now. Try again in a moment.`);
    }
  }

  const importId = randomUUID();
  const proposal: PortfolioImportProposal = proposePortfolioImport({ importId, files: fileMeta, understandings, residentsByFile });

  try {
    await createPortfolioImportProposal({ db: auth.db, managerUserId: auth.userId, proposal });
  } catch (err) {
    console.error("portfolio-import: store failed", err);
    return fail(500, "Could not save what PropLane read from those files. Try again in a moment.");
  }

  track("portfolio_import_read", auth.userId, {
    files: files.length,
    properties: proposal.summary.properties,
    rooms: proposal.summary.rooms,
    residents: proposal.summary.residents,
    gaps: proposal.summary.gaps,
    withHint: Boolean(hint),
  });

  return NextResponse.json({ ok: true, proposal });
}
