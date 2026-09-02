/**
 * Tour tools: see what is open, request a tour, book one, move one, cancel one.
 *
 * Two rules shape everything here.
 *
 * **The agent never invents a slot.** Every time it offers or accepts comes from
 * `listOpenTourSlots` (`tour-availability.server.ts`), the same function that
 * draws the public booking grid: `offered = published (or the 9-5 default)
 * MINUS calendar-busy MINUS already-booked`. Before that function existed the
 * only server-side slot math available to a tool omitted Google-busy entirely,
 * so an agent would have offered times the manager's calendar says they are
 * busy for.
 *
 * **Requesting and booking are different acts, held by different people.** A
 * resident or a prospect REQUESTS: `request_tour` files a pending inquiry
 * exactly as the web form does, and the manager still approves it (the
 * approval-first invariant in docs/agents/tours-scheduling.md). Only a manager
 * BOOKS, and only for a property they own.
 *
 * Slot keys are wall time pinned to Pacific. Never build a `Date` from one —
 * use `tour-slot-math.ts`, which is what `listOpenTourSlots` already does.
 */
import { z } from "zod";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import type { ResidentAgentContext } from "../resident-context";
import { writeAuditLog, updateAuditResult, auditDayBucket } from "../audit";
import { listOpenTourSlots } from "@/lib/tour-availability.server";
import { createTourInquiry } from "@/lib/tour-inquiry-create.server";
import { createManualPlannedTour } from "@/lib/manual-planned-tour.server";
import { cancelPlannedTour, reschedulePlannedTour } from "@/lib/tour-planned-change.server";
import { formatTourRangeLabel } from "@/lib/tour-inquiry.server";
import { slotStartMs, TOUR_CALENDAR_TIME_ZONE } from "@/lib/tour-slot-math";
import { smsAccessAllowsPropertyRecord } from "@/lib/sms/manager-sms-access";

/** Slots are a grid; a page of them is plenty for a chat reply or a text. */
const SLOT_LIMIT = 40;

const slotsInputSchema = z
  .object({
    propertyId: z.string().min(1).describe("The listing/property id to check availability for."),
    buildingName: z.string().optional().describe("Optional building name, to resolve a property by house key."),
    address: z.string().optional().describe("Optional street address, to resolve a property by house key."),
  })
  .strict();

type SlotsInput = z.infer<typeof slotsInputSchema>;

type OfferedSlot = { slotKey: string; start: string; end: string; label: string; hostUserId: string; hostLabel: string };

/**
 * Turn the raw `slotHosts` map into the shape a model can quote back: one entry
 * per bookable slot with real ISO bounds derived from the slot key, sorted, and
 * capped. The ISO bounds matter — every write below takes `start`/`end`, and
 * the model must never compute them itself from a wall-time key.
 */
async function loadOfferedSlots(
  db: AgentContext["db"],
  input: SlotsInput,
): Promise<{ slots: OfferedSlot[]; timeZone: string }> {
  const result = await listOpenTourSlots(db, {
    propertyId: input.propertyId,
    buildingName: input.buildingName ?? null,
    address: input.address ?? null,
  });
  if (!result.ok) throw new Error(result.error);

  const slots: OfferedSlot[] = [];
  for (const [slotKey, hosts] of Object.entries(result.slotHosts)) {
    const startMs = slotStartMs(slotKey);
    if (startMs === null) continue;
    const host = hosts[0];
    if (!host) continue;
    const start = new Date(startMs).toISOString();
    const end = new Date(startMs + 30 * 60 * 1000).toISOString();
    slots.push({
      slotKey,
      start,
      end,
      label: formatTourRangeLabel(start, end),
      hostUserId: host.userId,
      hostLabel: host.label,
    });
  }
  slots.sort((a, b) => a.start.localeCompare(b.start));
  return { slots: slots.slice(0, SLOT_LIMIT), timeZone: TOUR_CALENDAR_TIME_ZONE };
}

const SLOTS_DESCRIPTION =
  "List the tour times currently open for a property, with the host for each. This is the ONLY source of bookable times — published availability minus calendar-busy minus already-booked, the same grid the public booking page shows. Always call this before offering, requesting, or booking a time, and quote the returned start/end verbatim; never work a time out yourself.";

/** Manager-scoped read. Availability is public by nature, so no extra filter. */
export const listOpenTourSlotsTool = defineTool<SlotsInput, { slots: OfferedSlot[]; timeZone: string }>({
  name: "list_open_tour_slots",
  description: SLOTS_DESCRIPTION,
  inputSchema: slotsInputSchema,
  handler: (ctx, input) => loadOfferedSlots(ctx.db, input),
});

/** The identical read, bound to the resident context type. */
export const residentListOpenTourSlotsTool = defineTool<
  SlotsInput,
  { slots: OfferedSlot[]; timeZone: string },
  ResidentAgentContext
>({
  name: "list_open_tour_slots",
  description: SLOTS_DESCRIPTION,
  inputSchema: slotsInputSchema,
  handler: (ctx, input) => loadOfferedSlots(ctx.db as AgentContext["db"], input),
});

const requestTourInputSchema = z
  .object({
    propertyId: z.string().min(1).describe("The property id to tour, from list_open_tour_slots or a listing tool."),
    propertyTitle: z.string().optional().describe("Display title of the property, for the request record."),
    roomLabel: z.string().optional().describe("Optional room the tour is about."),
    slotKey: z.string().min(1).describe("The chosen slot key, copied verbatim from list_open_tour_slots."),
    start: z.string().min(1).describe("ISO start, copied verbatim from list_open_tour_slots."),
    end: z.string().min(1).describe("ISO end, copied verbatim from list_open_tour_slots."),
    hostUserId: z.string().min(1).describe("The host userId for that slot, copied verbatim from list_open_tour_slots."),
    name: z.string().min(1).describe("Full name of the person touring."),
    email: z.string().min(3).describe("Their email address."),
    phone: z.string().min(7).describe("Their 10-digit phone number."),
    notes: z.string().max(1000).optional().describe("Anything they want the manager to know."),
  })
  .strict();

type RequestTourInput = z.infer<typeof requestTourInputSchema>;

const REQUEST_TOUR_DESCRIPTION =
  "Request a tour at an open slot. This files a tour REQUEST for the property's manager to approve, exactly like the website's booking form — it does not book anything and does not put the time on anyone's calendar. Get the slot from list_open_tour_slots and copy slotKey, start, end and hostUserId verbatim.";

/**
 * Build the inquiry row. `hostUserId` is a TARGET, not scope: `createTourInquiry`
 * re-derives whether that host may actually host this property and whether the
 * slot is genuinely published and free, so naming a manager here proves nothing.
 */
function tourInquiryRowFrom(input: RequestTourInput): Record<string, unknown> {
  return {
    kind: "tour",
    propertyId: input.propertyId,
    propertyTitle: input.propertyTitle?.trim() || undefined,
    roomLabel: input.roomLabel?.trim() || undefined,
    managerUserId: input.hostUserId,
    name: input.name.trim(),
    email: input.email.trim(),
    phone: input.phone.trim(),
    notes: input.notes?.trim() || undefined,
    slotKey: input.slotKey,
    proposedStart: input.start,
    proposedEnd: input.end,
    requestedWindows: [
      { start: input.start, end: input.end, slotKey: input.slotKey, adminUserId: input.hostUserId },
    ],
  };
}

function requestTourPreviewFields(input: RequestTourInput) {
  const fields = [
    { label: "Property", value: input.propertyTitle?.trim() || input.propertyId },
    { label: "Time", value: formatTourRangeLabel(input.start, input.end) },
    { label: "Name", value: input.name.trim() },
    { label: "Email", value: input.email.trim() },
    { label: "Phone", value: input.phone.trim() },
  ];
  if (input.roomLabel?.trim()) fields.splice(1, 0, { label: "Room", value: input.roomLabel.trim() });
  if (input.notes?.trim()) fields.push({ label: "Notes", value: input.notes.trim() });
  return fields;
}

/**
 * Verify the requested slot is still on offer for that host. Runs in BOTH the
 * preview and the handler: a slot open when the preview was built can be taken
 * by the time someone confirms, and `createTourInquiry` would then reject it
 * with a bare conflict rather than something a person can act on.
 */
async function assertSlotStillOpen(db: AgentContext["db"], input: RequestTourInput): Promise<void> {
  const { slots } = await loadOfferedSlots(db, { propertyId: input.propertyId });
  const match = slots.find((slot) => slot.slotKey === input.slotKey && slot.hostUserId === input.hostUserId);
  if (!match) {
    throw new Error("That tour time is no longer open. Check list_open_tour_slots for the current times.");
  }
  if (match.start !== input.start || match.end !== input.end) {
    throw new Error("That slot's times have changed. Re-read list_open_tour_slots and use the new start and end.");
  }
}

/**
 * Resident-facing tour request. The resident's OWN contact details should be
 * used; the tool still takes them explicitly because a resident may be booking
 * with a different email than their account (a co-applicant, a family member),
 * and the manager needs whatever the guest will actually answer.
 */
export const residentRequestTourTool = defineWriteTool<
  RequestTourInput,
  { reply: string },
  ResidentAgentContext
>({
  name: "request_tour",
  description: REQUEST_TOUR_DESCRIPTION,
  inputSchema: requestTourInputSchema,
  // `hostUserId` names the manager who will host. It is a target, re-verified
  // against published availability in both phases, never a scope key.
  allowedIdentityInputs: ["hostUserId"],
  preview: async (ctx, input) => {
    await assertSlotStillOpen(ctx.db as AgentContext["db"], input);
    return {
      kind: "request_tour",
      title: "Request a tour",
      summary: `Ask ${input.propertyTitle?.trim() || "the property manager"} for a tour at ${formatTourRangeLabel(input.start, input.end)}.`,
      fields: requestTourPreviewFields(input),
      warnings: ["This sends a request. The manager confirms the time before it is booked."],
      confirmLabel: "Send tour request",
    };
  },
  handler: async (ctx, input) => {
    const db = ctx.db as AgentContext["db"];
    await assertSlotStillOpen(db, input);
    const created = await createTourInquiry(db, { incoming: tourInquiryRowFrom(input) });
    if (!created.ok) throw new Error(created.error);
    return {
      reply: `Tour requested for ${formatTourRangeLabel(input.start, input.end)}. The manager will confirm the time.`,
    };
  },
});

/**
 * The prospect-facing SMS version, bound to the manager-shaped context the
 * leasing SMS agent runs on.
 *
 * This is the SECOND entry ever in a surface's inline `allowWriteTools`, after
 * `escalate_to_manager`, and for the same reason: a texting prospect is
 * anonymous, so there is no `user_id` a pending action could be claimed on and
 * therefore no way to confirm one. It is safe to run inline because it is the
 * same risk class as an escalation — it files a request and notifies the
 * manager, and books nothing. Do not extend that allowlist to anything that
 * changes state the manager has not seen.
 */
export const leasingRequestTourTool = defineWriteTool<RequestTourInput, { reply: string }>({
  name: "request_tour",
  description: REQUEST_TOUR_DESCRIPTION,
  inputSchema: requestTourInputSchema,
  allowedIdentityInputs: ["hostUserId"],
  preview: async (ctx, input) => {
    await assertSlotStillOpen(ctx.db, input);
    return {
      kind: "request_tour",
      title: "Request a tour",
      fields: requestTourPreviewFields(input),
      warnings: ["This sends a request. The manager confirms the time before it is booked."],
      confirmLabel: "Send tour request",
    };
  },
  handler: async (ctx, input) => {
    await assertSlotStillOpen(ctx.db, input);
    const created = await createTourInquiry(ctx.db, { incoming: tourInquiryRowFrom(input) });
    if (!created.ok) throw new Error(created.error);
    return {
      reply: `Tour requested for ${formatTourRangeLabel(input.start, input.end)}. ${input.name.trim()} will hear back once the manager confirms.`,
    };
  },
});

const bookTourInputSchema = z
  .object({
    propertyId: z.string().min(1).describe("The property to tour. Must be one this landlord owns."),
    propertyTitle: z.string().optional().describe("Display title, for the calendar entry."),
    roomLabel: z.string().optional().describe("Optional room the tour is about."),
    guestName: z.string().min(1).describe("Who is touring."),
    guestEmail: z.string().optional().describe("Guest email, so they can be notified."),
    guestPhone: z.string().optional().describe("Guest phone."),
    start: z.string().min(1).describe("ISO start, copied verbatim from list_open_tour_slots."),
    end: z.string().min(1).describe("ISO end, copied verbatim from list_open_tour_slots."),
    notes: z.string().max(1000).optional().describe("Notes for the tour."),
  })
  .strict();

type BookTourInput = z.infer<typeof bookTourInputSchema>;

/**
 * Confirm the time is still on offer for THIS landlord. Run in preview and
 * again in the handler: `createManualPlannedTour` only checks planned-tour
 * overlap, so without this a manager could book over their own published
 * availability rules or a pending request from a prospect.
 */
async function assertBookableForLandlord(ctx: AgentContext, input: BookTourInput): Promise<void> {
  if (ctx.managerSmsAccess) {
    const { data, error } = await ctx.db
      .from("manager_property_records")
      .select("id, manager_user_id")
      .eq("id", input.propertyId)
      .limit(1);
    if (error) throw new Error(error.message);
    const rec = ((data ?? []) as { id: string; manager_user_id?: string | null }[])[0];
    if (!rec || !smsAccessAllowsPropertyRecord(ctx, rec)) {
      throw new Error(
        "That property is not in the houses this number can act on. Call list_properties and pick one it returns.",
      );
    }
  }
  const { slots } = await loadOfferedSlots(ctx.db, { propertyId: input.propertyId });
  const match = slots.find(
    (slot) => slot.start === input.start && slot.end === input.end && slot.hostUserId === ctx.landlordId,
  );
  if (!match) {
    throw new Error(
      "That time is not open for you on this property. Call list_open_tour_slots and pick one of the times it returns.",
    );
  }
}

/**
 * Book a tour outright, from scratch — no inquiry required. This is what
 * `confirm_tour_inquiry` could never do: that one needs an existing pending
 * request, so "book Jane Thursday at 3" was impossible until now.
 *
 * It writes a `kind: "tour"` planned event, which is what makes the slot
 * disappear from the public grid; a plain calendar event does not.
 */
export const bookTourTool = defineWriteTool<BookTourInput, { reply: string }>({
  name: "book_tour",
  description:
    "Book a tour on the landlord's calendar at a specific open time, without needing an existing tour request. Use for 'book Jane for a tour Thursday at 3'. Get the time from list_open_tour_slots and copy start and end verbatim. Booking removes that slot from the public booking page.",
  inputSchema: bookTourInputSchema,
  preview: async (ctx, input) => {
    await assertBookableForLandlord(ctx, input);
    const fields = [
      { label: "Guest", value: input.guestName.trim() },
      { label: "Property", value: input.propertyTitle?.trim() || input.propertyId },
      { label: "Time", value: formatTourRangeLabel(input.start, input.end) },
    ];
    if (input.roomLabel?.trim()) fields.push({ label: "Room", value: input.roomLabel.trim() });
    if (input.guestEmail?.trim()) fields.push({ label: "Guest email", value: input.guestEmail.trim() });
    if (input.guestPhone?.trim()) fields.push({ label: "Guest phone", value: input.guestPhone.trim() });
    if (input.notes?.trim()) fields.push({ label: "Notes", value: input.notes.trim() });
    return {
      kind: "book_tour",
      title: `Book tour with ${input.guestName.trim()}`,
      summary: `Put a tour with ${input.guestName.trim()} on your calendar for ${formatTourRangeLabel(input.start, input.end)}.`,
      fields,
      warnings: ["This books the time on your calendar and takes the slot off your public booking page."],
      confirmLabel: "Book tour",
    };
  },
  handler: async (ctx, input) => {
    // Re-check against live availability before writing; a preview can be old.
    await assertBookableForLandlord(ctx, input);
    const dedupeKey = `book_tour:${ctx.landlordId}:${input.propertyId}:${input.start}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "book_tour",
      toolName: "book_tour",
      inputSummary: { propertyId: input.propertyId, start: input.start, end: input.end },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "That tour is already on your calendar." };
      throw new Error("Could not record the action; nothing was booked.");
    }
    const result = await createManualPlannedTour(ctx.db, ctx.landlordId, {
      propertyId: input.propertyId,
      propertyTitle: input.propertyTitle,
      roomLabel: input.roomLabel,
      guestName: input.guestName,
      guestEmail: input.guestEmail,
      guestPhone: input.guestPhone,
      start: input.start,
      end: input.end,
      notes: input.notes,
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { booked: false }, { clearDedupeKey: true });
      throw new Error(result.error);
    }
    await updateAuditResult(ctx, dedupeKey, { booked: true });
    return { reply: `Tour booked: ${result.message}` };
  },
});

const cancelTourInputSchema = z
  .object({
    plannedEventId: z.string().min(1).describe("The booked tour's event id, from list_calendar_events (type planned_event)."),
    reason: z.string().max(500).optional().describe("Why it is being cancelled; included in the guest's notice."),
    notifyGuest: z.boolean().optional().describe("Email the guest that it was cancelled (default true)."),
  })
  .strict();

/**
 * Cancel a booked tour AND tell the guest. `cancel_calendar_event` deletes the
 * event silently and leaves the guest expecting to be let in; this is the tool
 * for anything a person is showing up to.
 */
export const cancelTourTool = defineWriteTool<z.infer<typeof cancelTourInputSchema>, { reply: string }>({
  name: "cancel_tour",
  description:
    "Cancel a booked tour and notify the guest by email. Use this rather than cancel_calendar_event for tours — someone is planning to show up. Get the event id from list_calendar_events.",
  inputSchema: cancelTourInputSchema,
  preview: async (ctx, input) => {
    const notifyGuest = input.notifyGuest !== false;
    const fields = [{ label: "Tour", value: input.plannedEventId }];
    if (input.reason?.trim()) fields.push({ label: "Reason", value: input.reason.trim() });
    fields.push({ label: "Guest", value: notifyGuest ? "Will be emailed" : "Will NOT be told" });
    return {
      kind: "cancel_tour",
      title: "Cancel tour",
      fields,
      warnings: notifyGuest
        ? ["This cancels the tour and emails the guest."]
        : ["This cancels the tour WITHOUT telling the guest, so they may still show up."],
      confirmLabel: "Cancel tour",
    };
  },
  handler: async (ctx, input) => {
    // Ownership is enforced inside cancelPlannedTour via the actor id, which
    // comes from the authenticated context and never from the model.
    const result = await cancelPlannedTour(ctx.db, {
      plannedEventId: input.plannedEventId,
      actorUserId: ctx.landlordId,
      isAdmin: ctx.isAdmin,
      reason: input.reason ?? null,
      notifyGuest: input.notifyGuest !== false,
    });
    if (!result.ok) throw new Error(result.error);
    await writeAuditLog(ctx, {
      action: "cancel_tour",
      toolName: "cancel_tour",
      inputSummary: { plannedEventId: input.plannedEventId },
      resultSummary: { guestNotified: result.guestNotification?.ok ?? false },
      dedupeKey: `cancel_tour:${ctx.landlordId}:${input.plannedEventId}`,
    });
    return { reply: result.message };
  },
});

const rescheduleTourInputSchema = z
  .object({
    plannedEventId: z.string().min(1).describe("The booked tour's event id, from list_calendar_events."),
    start: z.string().min(1).describe("New ISO start, copied verbatim from list_open_tour_slots."),
    end: z.string().min(1).describe("New ISO end, copied verbatim from list_open_tour_slots."),
    reason: z.string().max(500).optional().describe("Why it is moving; included in the guest's notice."),
    notifyGuest: z.boolean().optional().describe("Email the guest the new time (default true)."),
  })
  .strict();

/** Move a booked tour to a different time and tell the guest the new one. */
export const rescheduleTourTool = defineWriteTool<z.infer<typeof rescheduleTourInputSchema>, { reply: string }>({
  name: "reschedule_tour",
  description:
    "Move a booked tour to a new time and email the guest the new time. Get the event id from list_calendar_events and the new time from list_open_tour_slots.",
  inputSchema: rescheduleTourInputSchema,
  preview: async (ctx, input) => {
    const notifyGuest = input.notifyGuest !== false;
    const fields = [
      { label: "Tour", value: input.plannedEventId },
      { label: "New time", value: formatTourRangeLabel(input.start, input.end) },
    ];
    if (input.reason?.trim()) fields.push({ label: "Reason", value: input.reason.trim() });
    fields.push({ label: "Guest", value: notifyGuest ? "Will be emailed the new time" : "Will NOT be told" });
    return {
      kind: "reschedule_tour",
      title: "Reschedule tour",
      fields,
      warnings: notifyGuest ? undefined : ["The guest will NOT be told, so they may arrive at the old time."],
      confirmLabel: "Reschedule tour",
    };
  },
  handler: async (ctx, input) => {
    const result = await reschedulePlannedTour(ctx.db, {
      plannedEventId: input.plannedEventId,
      actorUserId: ctx.landlordId,
      isAdmin: ctx.isAdmin,
      start: input.start,
      end: input.end,
      reason: input.reason ?? null,
      notifyGuest: input.notifyGuest !== false,
    });
    if (!result.ok) throw new Error(result.error);
    await writeAuditLog(ctx, {
      action: "reschedule_tour",
      toolName: "reschedule_tour",
      inputSummary: { plannedEventId: input.plannedEventId, start: input.start, end: input.end },
      resultSummary: { guestNotified: result.guestNotification?.ok ?? false },
      dedupeKey: `reschedule_tour:${ctx.landlordId}:${input.plannedEventId}:${input.start}`,
    });
    return { reply: result.message };
  },
});
