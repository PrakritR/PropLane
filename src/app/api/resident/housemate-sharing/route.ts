import { NextRequest, NextResponse } from "next/server";
import { ZodError } from "zod";
import { resolveResidentAgentContext } from "@/lib/tools/resident-context";
import { readHousemateSharing, saveHousemateSharing } from "@/lib/resident-housemate-sharing.server";

export const runtime = "nodejs";
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
async function handle(req: NextRequest) {
  try {
    if (req.method !== "GET") {
      let sameOrigin = false;
      try { sameOrigin = new URL(req.headers.get("origin") ?? "").host === req.headers.get("host"); } catch { /* denied below */ }
      if (!sameOrigin) return json({ error: "Open your resident portal to change sharing preferences." }, 403);
    }
    const ctx = await resolveResidentAgentContext();
    if (!ctx) return json({ error: "Sign in to your resident portal." }, 401);
    if (req.method === "GET") return json({ preferences: await readHousemateSharing(ctx) });
    const text = await req.text();
    if (text.length > 2000) return json({ error: "Invalid sharing preferences." }, 400);
    let input: unknown;
    try { input = JSON.parse(text); } catch { return json({ error: "Invalid sharing preferences." }, 400); }
    return json({ preferences: await saveHousemateSharing(ctx, input) });
  } catch (error) {
    if (error instanceof ZodError) return json({ error: "Choose which details you want to share." }, 400);
    return json({ error: "Could not save or load sharing preferences. Please try again." }, 500);
  }
}
export const GET = handle;
export const PATCH = handle;
