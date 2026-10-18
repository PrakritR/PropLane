import { NextResponse } from "next/server";
import { authorizeDispatchActor } from "@/lib/vendor-dispatch/access.server";
import { createDispatchRule, listDispatchRules } from "@/lib/vendor-dispatch/rules.server";

export const runtime = "nodejs";

/** The active workspace's dispatch rules (owner, or a co-manager with Services on the houses). */
export async function GET() {
  try {
    const gate = await authorizeDispatchActor("read");
    if (!gate.ok) return gate.response;
    const result = await listDispatchRules(gate.db, gate.actor);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    // The houses a rule may name, so the editor offers exactly what the server will accept.
    const houses = gate.actor.workspace.propertyIds.map(String).filter((id) => gate.actor.grantedPropertyIds === null || gate.actor.grantedPropertyIds.has(id));
    return NextResponse.json({ rules: result.value, workspacePropertyIds: houses, canEditAllHouses: gate.actor.grantedPropertyIds === null });
  } catch {
    return NextResponse.json({ error: "Could not load dispatch rules." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const gate = await authorizeDispatchActor("edit");
    if (!gate.ok) return gate.response;
    const body = await req.json().catch(() => null);
    const result = await createDispatchRule(gate.db, gate.actor, body);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ rule: result.value }, { status: 201 });
  } catch {
    return NextResponse.json({ error: "Could not save the rule." }, { status: 500 });
  }
}
