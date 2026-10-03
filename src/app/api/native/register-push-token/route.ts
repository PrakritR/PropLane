import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  token?: string;
  platform?: string;
};

const ALLOWED_PLATFORMS = new Set(["ios", "android", "web"]);

/**
 * Stores (or re-assigns) a device push token for the signed-in user. The token
 * is the primary key, so logging in on a shared device reassigns it to the new
 * user rather than fanning out notifications to a previous resident.
 */
export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json()) as Body;
    const token = body.token?.trim();
    const platform = body.platform?.trim().toLowerCase();

    if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });
    if (!platform || !ALLOWED_PLATFORMS.has(platform)) {
      return NextResponse.json({ error: "valid platform required" }, { status: 400 });
    }

    const db = createSupabaseServiceRoleClient();
    const { error } = await db.from("device_push_tokens").upsert(
      {
        token,
        user_id: user.id,
        platform,
        disabled_at: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "token" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to register token.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Releases a device push token when its owner signs out. Scoped to the caller's
 * own token: a token that belongs to someone else is left exactly as it is.
 */
export async function DELETE(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const body = (await req.json().catch(() => ({}))) as Body;
    const token = body.token?.trim();
    if (!token) return NextResponse.json({ error: "token required" }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { error } = await db
      .from("device_push_tokens")
      .update({ disabled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq("token", token)
      .eq("user_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to release token.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
