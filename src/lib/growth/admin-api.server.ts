import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";

const NO_STORE = { "Cache-Control": "private, no-store" };

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE });

export function fail(e: unknown) {
  const message = e instanceof Error ? e.message : "Failed";
  const status = /not found/i.test(message) ? 404 : /invalid growth post transition|cannot regenerate|no platforms|invalid scheduledfor/i.test(message) ? 409 : 500;
  return json({ error: message }, status);
}

/** Admin gate + optional body validation + error mapping, shared by every /api/admin/growth route. */
export async function adminRoute<S extends z.ZodTypeAny | undefined = undefined>(
  req: Request | null,
  schema: S,
  handler: (ctx: { userId: string; body: S extends z.ZodTypeAny ? z.infer<S> : undefined }) => Promise<NextResponse>,
): Promise<NextResponse> {
  try {
    const gate = await requireAdminRoute();
    if (!gate.ok) return gate.response;
    let body: unknown = undefined;
    if (schema) {
      const raw = req ? await req.json().catch(() => null) : null;
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) return json({ error: "Invalid body.", issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) }, 400);
      body = parsed.data;
    }
    return await handler({ userId: gate.userId, body: body as never });
  } catch (e) {
    return fail(e);
  }
}
