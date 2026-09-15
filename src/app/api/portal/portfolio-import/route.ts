import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { track } from "@/lib/analytics/posthog";
import { parsePortfolioImportUpload } from "@/lib/portfolio-import/parse.server";
import { PortfolioImportRowLimitError, PortfolioImportUnreadableError } from "@/lib/portfolio-import/errors";
import {
  createPortfolioImport,
  listPortfolioImports,
  PortfolioImportDuplicateError,
  sha256Hex,
  summaryFor,
} from "@/lib/portfolio-import/store.server";
import type { PortfolioImportSourcePreset } from "@/lib/portfolio-import/types";

export const runtime = "nodejs";

const MAX_DATA_URL_CHARS = 5 * 1024 * 1024;
const VALID_PRESETS = new Set<PortfolioImportSourcePreset>(["appfolio", "buildium", "generic", "pdf"]);

function decodeDataUrl(dataUrl: string): { bytes: Uint8Array; mediaType: string } | null {
  const match = /^data:([^;,]*)(;base64)?,([\s\S]*)$/.exec(dataUrl);
  if (!match) return null;
  const mediaType = match[1] || "application/octet-stream";
  const isBase64 = Boolean(match[2]);
  const data = match[3] ?? "";
  try {
    if (isBase64) {
      const bin = Buffer.from(data, "base64");
      return { bytes: new Uint8Array(bin), mediaType };
    }
    return { bytes: new Uint8Array(Buffer.from(decodeURIComponent(data), "utf-8")), mediaType };
  } catch {
    return null;
  }
}

export async function POST(req: Request) {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Not found." }, { status: 404 });

  const limited = await rateLimit(`portfolio-import:${auth.userId}`, 6, 60_000);
  if (!limited.ok) return NextResponse.json({ error: "Too many import requests. Try again shortly." }, { status: 429 });

  let body: { dataUrl?: string; fileName?: string; presetHint?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const dataUrl = body.dataUrl?.trim() ?? "";
  const fileName = body.fileName?.trim() || "import.csv";
  const presetHint = VALID_PRESETS.has(body.presetHint as PortfolioImportSourcePreset)
    ? (body.presetHint as PortfolioImportSourcePreset)
    : undefined;

  if (!dataUrl) return NextResponse.json({ error: "dataUrl is required." }, { status: 400 });
  if (dataUrl.length > MAX_DATA_URL_CHARS) return NextResponse.json({ error: "That file is too large to import." }, { status: 413 });

  const decoded = decodeDataUrl(dataUrl);
  if (!decoded) return NextResponse.json({ error: "A valid data URL is required." }, { status: 400 });

  try {
    const { sourceKind, preset, table, draft } = await parsePortfolioImportUpload({
      db: auth.db,
      managerUserId: auth.userId,
      actor: { userId: auth.userId, metadata: { landlordId: auth.userId } },
      bytes: decoded.bytes,
      fileName,
      mediaType: decoded.mediaType,
      presetHint,
    });

    if (draft.rowCount === 0 || (draft.properties.length === 0 && draft.residents.length === 0)) {
      return NextResponse.json({ error: "This file has no data rows to import.", code: "no_rows" }, { status: 422 });
    }

    const fileSha256 = sha256Hex(decoded.bytes);
    const row = await createPortfolioImport({
      db: auth.db,
      managerUserId: auth.userId,
      sourceKind,
      preset,
      fileName,
      fileSha256,
      table,
      draft,
    });

    track("portfolio_import_started", auth.userId, { source: sourceKind });

    return NextResponse.json(
      { importId: row.id, summary: summaryFor(row), draft },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof PortfolioImportDuplicateError) {
      return NextResponse.json({ error: err.message, importId: err.importId }, { status: 409 });
    }
    if (err instanceof PortfolioImportRowLimitError) {
      return NextResponse.json({ error: err.message, code: "row_limit", count: err.count }, { status: 422 });
    }
    if (err instanceof PortfolioImportUnreadableError) {
      return NextResponse.json({ error: err.message, code: "unreadable" }, { status: 422 });
    }
    console.error("portfolio-import: upload failed", err);
    return NextResponse.json({ error: "Could not read that file." }, { status: 500 });
  }
}

export async function GET() {
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Not found." }, { status: 404 });

  const rows = await listPortfolioImports(auth.db, auth.userId);
  const imports = rows.map((row) => summaryFor(row)).filter((s): s is NonNullable<typeof s> => Boolean(s));
  return NextResponse.json({ imports });
}
