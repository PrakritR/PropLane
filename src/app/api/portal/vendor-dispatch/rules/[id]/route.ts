import { NextResponse } from "next/server";
import { authorizeDispatchActor } from "@/lib/vendor-dispatch/access.server";
import { deleteDispatchRule, updateDispatchRule } from "@/lib/vendor-dispatch/rules.server";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** Edit a rule, or pause/resume it with `{ active }`. Missing keys keep the stored value. */
export async function PATCH(req: Request, ctx: Ctx) {
  try {
    const gate = await authorizeDispatchActor("edit");
    if (!gate.ok) return gate.response;
    const { id } = await ctx.params;
    const body = await req.json().catch(() => null);
    const result = await updateDispatchRule(gate.db, gate.actor, id, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ rule: result.value });
  } catch {
    return NextResponse.json({ error: "Could not save the rule." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  try {
    const gate = await authorizeDispatchActor("delete");
    if (!gate.ok) return gate.response;
    const { id } = await ctx.params;
    const result = await deleteDispatchRule(gate.db, gate.actor, id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Could not delete the rule." }, { status: 500 });
  }
}
