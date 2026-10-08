import "server-only";

import { listAdminUserIds } from "@/lib/auth/admin-role";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { growthDb, must, type GrowthDb } from "./db.server";

export function buildDigestBody(posts: Array<{ id: string; title: string; format: string }>, origin: string): string {
  return [
    `${posts.length} growth post${posts.length === 1 ? "" : "s"} waiting for review:`,
    "",
    ...posts.map((p) => `- ${p.title} (${p.format}): ${origin}/admin/growth/post/${p.id}`),
    "",
    "Approve in the admin UI; nothing publishes without it.",
  ].join("\n");
}

async function digestRecipients(db: GrowthDb): Promise<string[]> {
  const env = process.env.GROWTH_DIGEST_TO?.trim();
  if (env) return env.split(",").map((e) => e.trim()).filter(Boolean);
  const ids = await listAdminUserIds(db);
  if (ids.length === 0) return [];
  const rows = (await db.from("profiles").select("email").in("id", ids)).data ?? [];
  return [...new Set((rows as { email: string | null }[]).map((r) => String(r.email ?? "").trim().toLowerCase()).filter((e) => e.includes("@")))];
}

export async function sendGrowthDigest(db: GrowthDb = growthDb()): Promise<{ sent: boolean; count: number }> {
  const posts = must(
    await db.from("growth_posts").select("id,title,format").eq("status", "review").order("created_at", { ascending: true }),
    "review posts",
  ) as Array<{ id: string; title: string; format: string }>;
  if (posts.length === 0) return { sent: false, count: 0 };
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = (await digestRecipients(db)).filter((e) => !e.endsWith("@axis.local"));
  if (!apiKey || to.length === 0) return { sent: false, count: posts.length };
  const origin = (process.env.NEXT_PUBLIC_CANONICAL_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "https://proplane.app").replace(/\/$/, "");
  const res = await postResendEmail({
    apiKey,
    // Admin operational email, not a manager workspace effect: attribute to the first admin id when known.
    actorUserId: (await listAdminUserIds(db))[0] ?? "00000000-0000-0000-0000-000000000000",
    effectSummary: "Growth digest email captured for the test workspace.",
    payload: {
      from: process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>",
      to,
      subject: `Growth: ${posts.length} post${posts.length === 1 ? "" : "s"} to review`,
      text: buildDigestBody(posts, origin),
    },
  });
  return { sent: res.ok, count: posts.length };
}
