/**
 * `suggest_listing_photos`: a resident texts photos of their own house ("my house is 5257, post these").
 *
 * It NEVER edits a listing. The confirmed action tags the photos this resident just texted (their own phone, this
 * manager's number, last 30 minutes, found server-side, never named by the model) and sends their manager one notice with
 * the pictures; the manager places them with `place_resident_suggested_photos`. SMS only: the phone is the session's.
 */
import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { residentManagerIds } from "../../resident-context";
import { auditDayBucket, updateAuditResult, writeAuditLog } from "../../audit";
import { loadSenderRecentImages, recordListingPhotoSuggestion, suggestionIdFor } from "@/lib/listing-photo-suggestions.server";
import { publicOrigin } from "../leasing-sms";

export const SUGGEST_LISTING_PHOTOS_REPLY = "Thanks - I sent these to your manager to review. They decide what goes on the listing.";

function sender(ctx: ResidentAgentContext): { phone: string; managerId: string } {
  const phone = ctx.smsSenderPhoneE164?.trim() ?? "";
  const managerIds = residentManagerIds(ctx);
  if (ctx.channel !== "sms" || !phone) throw new Error("Photos can be suggested only by text, from your own phone.");
  if (managerIds.length !== 1) throw new Error("I could not tell which manager to send these to. Please message your manager directly.");
  return { phone, managerId: managerIds[0]! };
}

export const suggestListingPhotosTool = defineWriteTool({
  name: "suggest_listing_photos",
  description:
    "The resident texted photos of their own house and wants them on the listing (\"my house is 5257, post these\"). This does NOT change the listing: it sends the photos they just texted to their manager to review. Pass `note` with what the resident said about the house or room. Tell them the manager will review; never say the photos are posted.",
  inputSchema: z
    .object({ note: z.string().max(200).optional().describe("The resident's own words about which house or room, e.g. \"5257, my room\".") })
    .strict(),
  preview: async (ctx: ResidentAgentContext, input) => {
    const { phone, managerId } = sender(ctx);
    const files = await loadSenderRecentImages(ctx.db, { senderPhoneE164: phone, managerUserId: managerId });
    if (files.length === 0) throw new Error("I do not see photos from you in the last half hour. Text the photos again, then ask me.");
    return {
      kind: "suggest_listing_photos",
      title: "Send photos to your manager",
      summary: `Send ${files.length} photo${files.length === 1 ? "" : "s"} to your manager to review for the listing.`,
      fields: [
        { label: "Photos", value: String(files.length) },
        ...(input.note?.trim() ? [{ label: "Your note", value: input.note.trim() }] : []),
      ],
      confirmLabel: "Send photos",
    };
  },
  handler: async (ctx: ResidentAgentContext, input) => {
    const { phone, managerId } = sender(ctx);
    const files = await loadSenderRecentImages(ctx.db, { senderPhoneE164: phone, managerUserId: managerId });
    if (files.length === 0) throw new Error("No recent photos from you were found; nothing was sent.");
    const suggestionId = suggestionIdFor(ctx.userId, files);
    const dedupeKey = `suggest_listing_photos:${ctx.userId}:${suggestionId}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "suggest_listing_photos",
      toolName: "suggest_listing_photos",
      inputSummary: { count: files.length },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "Those photos were already sent to your manager." };
      throw new Error("Could not record the action; nothing was sent.");
    }
    const { data: profile } = await ctx.db.from("profiles").select("full_name").eq("id", ctx.userId).maybeSingle();
    const result = await recordListingPhotoSuggestion(ctx.db, {
      senderPhoneE164: phone,
      managerUserId: managerId,
      residentUserId: ctx.userId,
      residentName: String((profile as { full_name?: string | null } | null)?.full_name ?? "").trim(),
      note: input.note ?? "",
      origin: publicOrigin(),
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { error: result.error }, { clearDedupeKey: true });
      throw new Error("No recent photos from you were found; nothing was sent.");
    }
    await updateAuditResult(ctx, dedupeKey, { count: result.count, notified: result.notified });
    return {
      reply: result.notified ? SUGGEST_LISTING_PHOTOS_REPLY : "Your photos are saved for your manager to review.",
      resultSummary: { count: result.count, notified: result.notified },
    };
  },
});
