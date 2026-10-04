import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { archivePayee, createPayee, listPayees, listTeammates, updatePayee } from "@/lib/manager-payees.server";
import type { PayeeInput } from "@/lib/manager-payees";

export const runtime = "nodejs";

/**
 * Saved payees for "Add payment". The owner is the authenticated manager, re-derived here from the
 * session; no id in the request body or query is ever trusted as ownership. The service-role
 * client is pinned to that manager inside `manager-payees.server.ts`.
 */
async function gate() {
  const auth = await getReportsAuthContext();
  if (!auth) return { response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  const access = await assertManagerFinancialsAccess(auth);
  if (!access.ok) return { response: NextResponse.json({ error: access.error }, { status: access.status }) } as const;
  return { auth } as const;
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const g = await gate();
    if ("response" in g) return g.response;
    const [payees, teammates] = await Promise.all([
      listPayees(g.auth.db, g.auth.userId),
      listTeammates(g.auth.db, g.auth.userId),
    ]);
    return NextResponse.json({ payees, teammates }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load payees." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const g = await gate();
    if ("response" in g) return g.response;
    const body = await readBody(req);
    if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
    const result = await createPayee(g.auth.db, g.auth.userId, body as PayeeInput);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ payee: result.value });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to save payee." }, { status: 500 });
  }
}

/** Update a payee's details, or `{ id, archived: true }` to archive it (payments already made keep their name). */
export async function PATCH(req: Request) {
  try {
    const g = await gate();
    if ("response" in g) return g.response;
    const body = await readBody(req);
    const id = typeof body?.id === "string" ? body.id.trim() : "";
    if (!body || !id) return NextResponse.json({ error: "id required." }, { status: 400 });
    if (body.archived === true) {
      const archived = await archivePayee(g.auth.db, g.auth.userId, id);
      if (!archived.ok) return NextResponse.json({ error: archived.error }, { status: archived.status });
      return NextResponse.json({ ok: true, id: archived.value.id });
    }
    const result = await updatePayee(g.auth.db, g.auth.userId, id, body as PayeeInput);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ payee: result.value });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to update payee." }, { status: 500 });
  }
}
