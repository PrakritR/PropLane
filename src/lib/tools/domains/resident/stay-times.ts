import { z } from "zod";
import { defineTool } from "../../registry";
import type { ResidentAgentContext } from "../../resident-context";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { formatAddOnPrice, formatStayMoment, formatStayTime } from "@/lib/bookings/stay-times";
import { pacificTodayKey } from "@/lib/room-availability-range";
import { listGuestStays } from "@/lib/short-stay/guest-stays.server";
import {
  stayAddOnPayUrl,
  stayAddOnSuggestedReply,
  stayAddOnUnavailableText,
} from "@/lib/short-stay/stay-add-ons";
import { loadGuestStayForAddOns, quoteStayAddOns } from "@/lib/short-stay/stay-add-ons.server";

/** At most this many upcoming / in-house stays are described in one answer. */
const MAX_STAYS = 5;

/**
 * Read-only: when the signed-in guest checks in and out, and whether a paid early check-in / late checkout can be
 * added to each stay, with the pay link and a reply the assistant may send. There is no write tool on purpose:
 * the guest pays on the link (Stripe test or live, never the model), and the webhook moves the stay's time. So
 * it works on resident SMS too (`readOnly`). The scope is the session's own login; the model supplies no identity.
 */
export const getMyStayTimesTool = defineTool({
  name: "get_my_stay_times",
  description:
    "Get the signed-in guest's upcoming and in-house short stays with their check-in and check-out times (date and time), their estimated arrival, and, for each stay, whether a paid early check-in or late checkout can be added: its time, price, a pay link and a suggested reply. Read-only. Use it to answer 'what time is check-in', 'what time is checkout', 'can I check in early', 'can I get a late checkout'; answer from it and offer the add-on when it is available. When an add-on is unavailable say so plainly (for example 'Early check-in isn't available that day.'). Never promise a time that is not in the result; there is no tool to add or change a time, the guest pays on the link and the time is confirmed by text once it goes through.",
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx: ResidentAgentContext) => {
    const today = pacificTodayKey();
    const stays = (await listGuestStays(ctx.db, { userId: ctx.userId }))
      .filter((stay) => (stay.status === "confirmed" || stay.status === "pending") && stay.checkOut >= today)
      .sort((a, b) => a.checkIn.localeCompare(b.checkIn))
      .slice(0, MAX_STAYS);
    const origin = resolveEmailLinkBaseUrl();
    const out = [];
    for (const stay of stays) {
      const loaded = await loadGuestStayForAddOns(ctx.db, { blockId: stay.id, userId: ctx.userId }).catch(() => null);
      if (!loaded) continue;
      const holdOnly = loaded.bookingStatus === "hold";
      const addOns = quoteStayAddOns(loaded).map((row) => {
        const base = { kind: row.kind, label: row.label };
        if (row.record?.status === "paid") {
          return { ...base, status: "paid" as const, time: row.record.time, message: `${row.label} at ${formatStayTime(row.record.time)} is already added.` };
        }
        if (row.record?.status === "requested") {
          return { ...base, status: "requested" as const, time: row.record.time, message: `${row.label} at ${formatStayTime(row.record.time)} is requested and is charged once the host confirms the stay.` };
        }
        if (row.record?.status === "refund_failed") {
          return { ...base, status: "refund_failed" as const, time: row.record.time, message: `${row.label} could not be added and its refund is being handled by the host.` };
        }
        if (row.record?.status === "refunded") {
          return { ...base, status: "refunded" as const, time: row.record.time, message: `${row.label} was refunded for this stay.` };
        }
        if (!row.offer.available || !row.offer.time || row.offer.priceCents === undefined) {
          return { ...base, status: "unavailable" as const, message: stayAddOnUnavailableText(row.kind) };
        }
        // A pending add-on already has its charge: that charge carries the stored time and price, so the link,
        // the reply and the figures say exactly those (the property's price may have changed since).
        const pending = row.record?.status === "pending" ? row.record : null;
        const time = pending?.time ?? row.offer.time;
        const priceCents = pending?.priceCents ?? row.offer.priceCents;
        const payLink = stayAddOnPayUrl(origin, { blockId: stay.id, kind: row.kind, time });
        return {
          ...base,
          status: pending ? ("pending" as const) : ("available" as const),
          time,
          price: formatAddOnPrice(priceCents),
          priceCents,
          payLink,
          suggestedReply: stayAddOnSuggestedReply({ kind: row.kind, time, priceCents, payUrl: payLink, holdOnly }),
        };
      });
      out.push({
        stayId: stay.id,
        property: stay.propertyLabel,
        room: stay.roomLabel,
        confirmed: !holdOnly,
        checkIn: formatStayMoment(loaded.stay.checkIn, loaded.stay.checkInTime),
        checkOut: formatStayMoment(loaded.stay.checkOut, loaded.stay.checkOutTime),
        standardCheckIn: formatStayMoment(loaded.stay.checkIn, loaded.clock.times.checkInTime),
        standardCheckOut: formatStayMoment(loaded.stay.checkOut, loaded.clock.times.checkOutTime),
        estimatedArrival: stay.estimatedArrival ?? null,
        addOns,
      });
    }
    return { stays: out };
  },
});
