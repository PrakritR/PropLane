/**
 * The AI on a vendor's PropLane number: its ENTIRE capability surface.
 *
 * One read (the vendor's business details plus the AI info they wrote) and one
 * write, `handoff_to_vendor`, whose only effect is a note in the vendor's own
 * inbox and a forward to the vendor's own phone. There is no tool that books,
 * quotes, schedules, charges, or texts anyone: answer-only is structural, not a
 * prompt request. Scope is the vendor who owns the texted number, taken from
 * context, never from model input.
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { VendorNumberAiContext } from "../vendor-number-ai-context";
import { handOffToVendor } from "@/lib/vendor-number-ai-handoff.server";
import { loadVendorBusinessProfile } from "@/lib/vendor-business-profile.server";

export const VENDOR_NUMBER_AI_HANDOFF_TOOL = "handoff_to_vendor";

export const getVendorInfoTool = defineTool<Record<string, never>, unknown, VendorNumberAiContext>({
  name: "get_vendor_info",
  description:
    "The business you answer for: name, trades, service area, and the hours, rates, how to book, emergency and other notes the vendor wrote for you. This is everything you may state. A blank field means the vendor has not said, so you do not know it.",
  inputSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
  handler: async (ctx) => {
    const profile = await loadVendorBusinessProfile(ctx.db, ctx.vendorUserId);
    const info = profile.aiInfo;
    return {
      businessName: profile.businessName || null,
      trades: profile.trades,
      serviceArea: profile.serviceArea || null,
      serviceAreaZips: profile.serviceAreaZips,
      serviceRadiusMiles: profile.serviceRadiusMiles,
      hours: info.hours || null,
      rates: info.rates || null,
      howToBook: info.how_to_book || null,
      emergencies: info.emergency || null,
      anythingElse: info.extra || null,
    };
  },
});

const handoffInput = z.object({
  reason: z.string().trim().min(1).max(200),
}).strict();

export const handoffToVendorTool = defineWriteTool<z.infer<typeof handoffInput>, unknown, VendorNumberAiContext>({
  name: VENDOR_NUMBER_AI_HANDOFF_TOOL,
  description:
    "Hand this conversation to the vendor: they get a note in PropLane and a text on their own phone. Use it for an emergency, a request to book or reschedule, a price quote you cannot give from the vendor's notes, a complaint, or anything the vendor's notes do not answer. It does not message the person you are talking to. `reason` is one short sentence for the vendor.",
  inputSchema: handoffInput,
  preview: async (_ctx, input) => ({
    kind: VENDOR_NUMBER_AI_HANDOFF_TOOL,
    title: "Hand off to the vendor",
    confirmLabel: "Hand off",
    fields: [{ label: "Reason", value: input.reason }],
  }),
  handler: async (ctx, input) => {
    const result = await handOffToVendor(ctx.db, {
      vendorUserId: ctx.vendorUserId, senderPhone: ctx.senderPhone, senderText: ctx.senderText,
      messageSid: ctx.messageSid, reason: input.reason, forwardToPhone: ctx.forwardToPhone, provider: ctx.provider, now: ctx.now,
    });
    return { reply: "The vendor has been notified.", ...result };
  },
});
