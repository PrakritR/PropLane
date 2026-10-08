import { NextResponse } from "next/server";
import { AdminInputError } from "@/lib/admin/admin-input-error";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import {
  createExpenseSchema,
  createPlatformExpense,
  deleteExpenseSchema,
  deletePlatformExpense,
  expenseRangeSchema,
  listPlatformExpenses,
  updateExpenseSchema,
  updatePlatformExpense,
} from "@/lib/admin/platform-expenses.server";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

function failure(action: string, error: unknown) {
  if (error instanceof AdminInputError) return json({ error: error.message }, error.status);
  // A PostgREST message names tables and columns: logged here, never returned.
  console.error(`${action} /api/admin/expenses failed`, error);
  return json({ error: "Could not save that. Try again." }, 500);
}

const invalid = (error: { issues: Array<{ message: string }> }) =>
  json({ error: error.issues[0]?.message ?? "Invalid expense." }, 400);

const readBody = (req: Request) => req.json().catch(() => null);

/** GET /api/admin/expenses?from=YYYY-MM&to=YYYY-MM — expenses that can charge in the range. Admin-only. */
export async function GET(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const params = new URL(req.url).searchParams;
  const range = expenseRangeSchema.safeParse({ from: params.get("from"), to: params.get("to") });
  if (!range.success) return invalid(range.error);
  try {
    return json({ expenses: await listPlatformExpenses(range.data) });
  } catch (error) {
    return failure("GET", error);
  }
}

/** POST /api/admin/expenses — add an expense. */
export async function POST(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const parsed = createExpenseSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error);
  try {
    return json({ expense: await createPlatformExpense(parsed.data, gate.userId) }, 201);
  } catch (error) {
    return failure("POST", error);
  }
}

/** PATCH /api/admin/expenses — `{ id, ...fields }`; omitted fields keep their value. */
export async function PATCH(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const parsed = updateExpenseSchema.safeParse(await readBody(req));
  if (!parsed.success) return invalid(parsed.error);
  try {
    return json({ expense: await updatePlatformExpense(parsed.data) });
  } catch (error) {
    return failure("PATCH", error);
  }
}

/** DELETE /api/admin/expenses — `{ id }` or `?id=`. Removes the row and its receipt file. */
export async function DELETE(req: Request) {
  const gate = await requireAdminRoute();
  if (!gate.ok) return gate.response;
  const queryId = new URL(req.url).searchParams.get("id");
  const parsed = deleteExpenseSchema.safeParse(queryId ? { id: queryId } : await readBody(req));
  if (!parsed.success) return invalid(parsed.error);
  try {
    await deletePlatformExpense(parsed.data.id);
    return json({ ok: true });
  } catch (error) {
    return failure("DELETE", error);
  }
}
