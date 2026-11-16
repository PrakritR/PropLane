import { NextResponse } from "next/server";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import {
  createRecurringPayable,
  generateDueRecurringEntries,
  listRecurringPayables,
  updateRecurringPayable,
  type RecurringPayableInput,
} from "@/lib/finance/recurring-payables.server";
import { pacificCalendarDateYmd } from "@/lib/pacific-time";
import { resolveActiveWorkspaceRowScope } from "@/lib/workspaces/row-scope.server";

export const runtime = "nodejs";

async function gate() {
  const auth = await getReportsAuthContext();
  if (!auth) return { response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) } as const;
  const access = await assertManagerFinancialsAccess(auth);
  if (!access.ok) return { response: NextResponse.json({ error: access.error }, { status: access.status }) } as const;
  return { auth } as const;
}

/** GET: the manager's recurring payables inside the active workspace. */
export async function GET() {
  try {
    const g = await gate();
    if ("response" in g) return g.response;
    const scope = await resolveActiveWorkspaceRowScope(g.auth.db, g.auth.userId);
    return NextResponse.json({ payables: await listRecurringPayables(g.auth.db, g.auth.userId, scope) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to load recurring payables." }, { status: 500 });
  }
}

/** POST: create one, then generate whatever is already due (so a monthly payable shows its first Due entry at once). */
export async function POST(req: Request) {
  try {
    const g = await gate();
    if ("response" in g) return g.response;
    const body = (await req.json()) as RecurringPayableInput;
    const scope = await resolveActiveWorkspaceRowScope(g.auth.db, g.auth.userId);
    const result = await createRecurringPayable(g.auth.db, g.auth.userId, body, scope);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    await generateDueRecurringEntries(g.auth.db, pacificCalendarDateYmd(), { managerUserId: g.auth.userId }).catch((e: unknown) =>
      console.error("recurring payable first generation failed", e instanceof Error ? e.message : "unknown"));
    return NextResponse.json({ payable: result.value });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create the recurring payable." }, { status: 500 });
  }
}

/** PATCH: edit, pause, resume or end one (a schedule is never deleted: its generated entries keep their link). */
export async function PATCH(req: Request) {
  try {
    const g = await gate();
    if ("response" in g) return g.response;
    const body = (await req.json()) as RecurringPayableInput & { id?: string };
    const id = typeof body.id === "string" ? body.id.trim() : "";
    if (!id) return NextResponse.json({ error: "id required." }, { status: 400 });
    const scope = await resolveActiveWorkspaceRowScope(g.auth.db, g.auth.userId);
    const result = await updateRecurringPayable(g.auth.db, g.auth.userId, id, body, scope);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ payable: result.value });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to update the recurring payable." }, { status: 500 });
  }
}
