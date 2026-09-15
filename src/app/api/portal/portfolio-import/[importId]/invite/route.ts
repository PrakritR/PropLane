import { NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { getReportsAuthContext } from "@/lib/reports/auth";
import { invitePortfolioImportResidents } from "@/lib/portfolio-import/invite.server";
import { loadPortfolioImport } from "@/lib/portfolio-import/store.server";
import type { PortfolioImportInviteChannel } from "@/lib/portfolio-import/types";

export const runtime = "nodejs";

const VALID_CHANNELS = new Set<PortfolioImportInviteChannel>(["email", "text", "both"]);

export async function POST(req: Request, ctx: { params: Promise<{ importId: string }> }) {
  const { importId } = await ctx.params;
  const auth = await getReportsAuthContext({ preferRole: "manager" });
  if (!auth?.userId) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  if (auth.role !== "manager" && auth.role !== "admin") return NextResponse.json({ error: "Not found." }, { status: 404 });

  const row = await loadPortfolioImport(auth.db, auth.userId, importId);
  if (!row) return NextResponse.json({ error: "Import not found." }, { status: 404 });
  if (row.status !== "completed") {
    return NextResponse.json({ error: "Commit this import before inviting residents." }, { status: 409 });
  }

  const limited = await rateLimit(`portfolio-import-invite:${auth.userId}`, 10, 60_000);
  if (!limited.ok) return NextResponse.json({ error: "Too many invite requests. Try again shortly." }, { status: 429 });

  let body: { residentKeys?: unknown; channels?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const residentKeys = Array.isArray(body.residentKeys)
    ? body.residentKeys.filter((k): k is string => typeof k === "string" && k.trim().length > 0)
    : [];
  if (residentKeys.length === 0) return NextResponse.json({ error: "residentKeys is required." }, { status: 400 });

  const channels = VALID_CHANNELS.has(body.channels as PortfolioImportInviteChannel)
    ? (body.channels as PortfolioImportInviteChannel)
    : null;
  if (!channels) return NextResponse.json({ error: "channels must be 'email', 'text', or 'both'." }, { status: 400 });

  const { data: profile } = await auth.db.from("profiles").select("full_name").eq("id", auth.userId).maybeSingle();

  const { results, workNumber } = await invitePortfolioImportResidents({
    db: auth.db,
    managerUserId: auth.userId,
    actor: { userId: auth.userId, email: auth.email, managerName: String(profile?.full_name ?? "") },
    importId,
    residentKeys,
    channels,
  });

  return NextResponse.json({ results, workNumber });
}
