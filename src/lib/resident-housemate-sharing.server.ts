import "server-only";
import { randomUUID } from "node:crypto";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { writeAuditLog, updateAuditResult } from "@/lib/tools/audit";
import { track } from "@/lib/analytics/posthog";
import { housemateSharingSchema, parseHousemateSharing } from "./resident-housemate-sharing";

export async function readHousemateSharing(ctx: ResidentAgentContext) {
  const { data, error } = await ctx.db.from("resident_housemate_sharing").select("preferences").eq("user_id", ctx.userId).maybeSingle();
  if (error) throw new Error("Could not load your sharing preferences. Please try again.");
  return parseHousemateSharing(data?.preferences);
}
export async function saveHousemateSharing(ctx: ResidentAgentContext, input: unknown) {
  const preferences = housemateSharingSchema.parse(input);
  const dedupeKey = `housemate-sharing:${randomUUID()}`;
  const audit = await writeAuditLog(ctx, { action: "housemate_sharing_updated", toolName: "update_housemate_sharing", inputSummary: preferences, dedupeKey });
  if (!audit.recorded) throw new Error("Could not save your sharing preferences. Please try again.");
  const { error } = await ctx.db.from("resident_housemate_sharing").upsert({ user_id: ctx.userId, preferences, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  await updateAuditResult(ctx, dedupeKey, { status: error ? "failed" : "success" });
  if (error) throw new Error("Could not save your sharing preferences. Please try again.");
  track("housemate_sharing_updated", ctx.userId, preferences);
  return preferences;
}
