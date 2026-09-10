import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
/** Only formerly public assets are exposed, and only after atomic publication. */
export async function GET(_req: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" };
  if (!/^[a-f0-9-]{36}$/i.test(id)) return new Response("Not found", { status: 404, headers });
  try {
    const db = createSupabaseServiceRoleClient();
    const { data: object, error } = await db.from("account_recovery_objects").select("private_path")
      .eq("id", id).eq("state", "active").eq("is_public", true).maybeSingle();
    if (error) throw error;
    if (!object) return new Response("Not found", { status: 404, headers });
    const { data, error: downloadError } = await db.storage.from("account-recovery").download(object.private_path);
    if (downloadError || !data) return new Response("Not found", { status: 404, headers });
    return new Response(data, { headers: { ...headers, "Content-Type": data.type || "application/octet-stream" } });
  } catch { return new Response("Asset unavailable", { status: 503, headers }); }
}
