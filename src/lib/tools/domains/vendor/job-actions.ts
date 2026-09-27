import { z } from "zod";
import { defineWriteTool } from "../../registry";
import type { VendorAgentContext } from "../../vendor-context";
import { writeAuditLog, updateAuditResult } from "../../audit";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  markWorkOrderDoneByVendor,
  setVendorPriceForWorkOrder,
  submitWorkOrderBid,
} from "@/lib/work-order-bids.server";
import {
  contentHash,
  findOwnBid,
  formatUsd,
  resolveVendorWorkOrderTarget,
  vendorWorkOrderActor,
  type VendorWorkOrder,
} from "./load-vendor-rows";

/** "Fix sink · Maple House, Unit 3" style label for previews and replies. */
function jobLabel(row: DemoManagerWorkOrderRow): string {
  const where = [row.propertyName, row.unit ? `Unit ${row.unit}` : ""].filter(Boolean).join(", ");
  return `${row.title || "Work order"}${where ? ` · ${where}` : ""}`;
}

/* ------------------------------------------------------------------------ */
/* submit_bid                                                               */
/* ------------------------------------------------------------------------ */

type SubmitBidInput = { workOrderId: string; amountUsd: number; proposedTimeIso?: string; note?: string };

type ResolvedSubmitBid = {
  target: VendorWorkOrder;
  amountCents: number;
  proposedIso: string;
};

/**
 * Shared preview/execute validation, mirroring the submit route's gates: the
 * work order must be assigned or offered to THIS vendor, bidding must be open
 * (or the vendor's own post-consultation bid still awaiting its price), and an
 * already-resolved bid can never be re-submitted.
 */
async function resolveSubmitBid(
  ctx: VendorAgentContext,
  input: SubmitBidInput,
): Promise<{ ok: true; resolved: ResolvedSubmitBid } | { ok: false; error: string }> {
  const target = await resolveVendorWorkOrderTarget(ctx, input.workOrderId);
  if (!target) {
    return {
      ok: false,
      error: `No work order "${input.workOrderId}" is assigned or offered to you. Use list_my_jobs for valid ids.`,
    };
  }
  const amountCents = Math.round(input.amountUsd * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, error: "Bid amount must be a positive dollar amount." };
  }

  const ownBid = await findOwnBid(ctx, target.id);
  if (ownBid && ownBid.status !== "submitted") {
    return {
      ok: false,
      error:
        ownBid.status === "accepted"
          ? "Your bid on this work order was already accepted — its amount is locked and can't be re-bid."
          : "Your bid on this work order has already been resolved.",
    };
  }
  // Same gate as the route: bidding open, or a post-consultation price still pending.
  const pricingPending =
    ownBid?.status === "submitted" &&
    ownBid.quote_mode === "after_consultation" &&
    ownBid.consultation_visit_at &&
    ownBid.amount_cents == null;
  if (target.row.biddingOpen !== true && !pricingPending) {
    return { ok: false, error: "Bidding is not open for this work order." };
  }

  const proposedRaw = input.proposedTimeIso?.trim() || target.row.scheduledAtIso || "";
  const proposedDate = new Date(proposedRaw);
  if (!proposedRaw || Number.isNaN(proposedDate.getTime())) {
    return {
      ok: false,
      error:
        "Include proposedTimeIso (an ISO datetime for when you could do the work) — this job has no scheduled time to default to.",
    };
  }
  return { ok: true, resolved: { target, amountCents, proposedIso: proposedDate.toISOString() } };
}

export const submitBidTool = defineWriteTool({
  name: "submit_bid",
  description:
    "Submit (or update) your cost bid on a work order that is open for bidding — pass the workOrderId from list_my_jobs or list_my_offers, your labor amount in dollars, and optionally when you could do the work. Cannot change a bid the manager already accepted.",
  inputSchema: z
    .object({
      workOrderId: z.string().min(1).describe("Id of a work order open for bidding (from list_my_jobs or list_my_offers)."),
      amountUsd: z.number().positive().max(500000).describe("Your labor bid in US dollars, e.g. 450 or 449.99."),
      proposedTimeIso: z
        .string()
        .optional()
        .describe("Optional ISO datetime for when you could do the work; defaults to the job's scheduled time."),
      note: z.string().max(2000).optional().describe("Optional short note to the manager alongside the bid."),
    })
    .strict(),
  preview: async (ctx: VendorAgentContext, input) => {
    const res = await resolveSubmitBid(ctx, input);
    if (!res.ok) throw new Error(res.error);
    const { target, amountCents, proposedIso } = res.resolved;
    const lines = [
      { label: "Job", value: jobLabel(target.row) },
      { label: "Bid (labor)", value: formatUsd(amountCents) },
      { label: "Proposed time", value: proposedIso },
    ];
    if (input.note?.trim()) lines.push({ label: "Note", value: input.note.trim() });
    return {
      kind: "submit_bid",
      title: "Submit bid",
      summary: `Bid ${formatUsd(amountCents)} on "${target.row.title || target.id}" and notify the manager.`,
      fields: lines,
      confirmLabel: "Submit bid",
    };
  },
  handler: async (ctx: VendorAgentContext, input) => {
    // Re-resolve everything at execute time; the shared lib re-checks access,
    // bidding state, and bid status again before writing.
    const res = await resolveSubmitBid(ctx, input);
    if (!res.ok) throw new Error(res.error);
    const { target, amountCents, proposedIso } = res.resolved;

    const dedupeKey = `submit_bid:${ctx.landlordId}:${target.id}:${contentHash(`${amountCents}|${proposedIso}`)}`;
    const audit = await writeAuditLog(ctx, {
      action: "submit_bid",
      toolName: "submit_bid",
      inputSummary: { workOrderId: target.id, amountCents, proposedTimeIso: proposedIso },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: `Already done — this exact ${formatUsd(amountCents)} bid was already submitted on "${target.row.title || target.id}".` };
      }
      throw new Error("Could not record the action; no bid was submitted.");
    }

    const actor = await vendorWorkOrderActor(ctx);
    const result = await submitWorkOrderBid(ctx.db, actor, {
      workOrderId: target.id,
      amountCents,
      proposedTime: proposedIso,
      note: input.note,
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { error: "submit_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    await updateAuditResult(ctx, dedupeKey, { workOrderId: target.id, amountCents });
    return { reply: `Submitted your ${formatUsd(amountCents)} bid on "${jobLabel(target.row)}", proposing ${proposedIso}. The manager will review it.`, resultSummary: { workOrderId: target.id, amountCents } };
  },
});

/* ------------------------------------------------------------------------ */
/* set_my_price                                                             */
/* ------------------------------------------------------------------------ */

type SetPriceInput = { workOrderId: string; amountUsd: number; materialsUsd?: number };

type ResolvedSetPrice = {
  target: VendorWorkOrder;
  amountCents: number;
  materialsCents: number;
};

/**
 * Shared preview/execute validation for price entry. THE INVARIANT: an
 * accepted bid's amount_cents is the immutable payout anchor — the bid status
 * is checked BEFORE anything is written, and setVendorPriceForWorkOrder
 * re-checks it (including a compare-and-swap WHERE clause) at write time.
 */
async function resolveSetPrice(
  ctx: VendorAgentContext,
  input: SetPriceInput,
): Promise<{ ok: true; resolved: ResolvedSetPrice } | { ok: false; error: string }> {
  const target = await resolveVendorWorkOrderTarget(ctx, input.workOrderId);
  // Price entry is only for the currently assigned vendor (offers don't qualify).
  if (!target || target.assignment !== "assigned") {
    return {
      ok: false,
      error: `No work order "${input.workOrderId}" is assigned to you. Use list_my_jobs for valid ids.`,
    };
  }
  if (target.row.bucket !== "scheduled") {
    return { ok: false, error: "Price can only be set on scheduled work orders." };
  }
  if (target.row.automationStatus) {
    return { ok: false, error: "This work order has already been marked done." };
  }
  const amountCents = Math.round(input.amountUsd * 100);
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, error: "Labor amount must be a positive dollar amount." };
  }
  // Omitted materials preserve the job's current materials cost instead of zeroing it.
  const materialsCents =
    input.materialsUsd === undefined ? (target.row.materialsCostCents ?? 0) : Math.round(input.materialsUsd * 100);
  if (!Number.isFinite(materialsCents) || materialsCents < 0) {
    return { ok: false, error: "Materials amount must be zero or a positive dollar amount." };
  }

  const ownBid = await findOwnBid(ctx, target.id);
  if (ownBid?.status === "accepted") {
    return {
      ok: false,
      error: "Your accepted quote amount is locked — the manager already accepted it, so the price can't be changed here.",
    };
  }
  return { ok: true, resolved: { target, amountCents, materialsCents } };
}

export const setMyPriceTool = defineWriteTool({
  name: "set_my_price",
  description:
    "Set your labor (and optionally materials) price on a scheduled work order you're assigned to, before marking it done — pass the workOrderId from list_my_jobs. Refused once your bid on the job has been accepted: that amount is locked.",
  inputSchema: z
    .object({
      workOrderId: z.string().min(1).describe("Id of a scheduled work order assigned to you (from list_my_jobs)."),
      amountUsd: z.number().positive().max(500000).describe("Your labor price in US dollars, e.g. 450 or 449.99."),
      materialsUsd: z
        .number()
        .min(0)
        .max(500000)
        .optional()
        .describe("Optional equipment/materials cost in US dollars; omit to keep the job's current materials cost."),
    })
    .strict(),
  preview: async (ctx: VendorAgentContext, input) => {
    const res = await resolveSetPrice(ctx, input);
    if (!res.ok) throw new Error(res.error);
    const { target, amountCents, materialsCents } = res.resolved;
    return {
      kind: "set_my_price",
      title: "Set your price",
      summary: `Set your price on "${target.row.title || target.id}" to ${formatUsd(amountCents + materialsCents)} total.`,
      fields: [
          { label: "Job", value: jobLabel(target.row) },
          { label: "Labor", value: formatUsd(amountCents) },
          { label: "Materials", value: formatUsd(materialsCents) },
          { label: "Total", value: formatUsd(amountCents + materialsCents) },
        ],
      confirmLabel: "Set price",
    };
  },
  handler: async (ctx: VendorAgentContext, input) => {
    // Re-resolve at execute time; the shared lib re-checks the accepted-bid
    // lock in its own read AND in the bid UPDATE's WHERE clause.
    const res = await resolveSetPrice(ctx, input);
    if (!res.ok) throw new Error(res.error);
    const { target, amountCents, materialsCents } = res.resolved;

    const dedupeKey = `set_my_price:${ctx.landlordId}:${target.id}:${amountCents}:${materialsCents}`;
    const audit = await writeAuditLog(ctx, {
      action: "set_my_price",
      toolName: "set_my_price",
      inputSummary: { workOrderId: target.id, amountCents, materialsCents },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) {
        return { reply: `Already done — the price on "${target.row.title || target.id}" is already ${formatUsd(amountCents + materialsCents)}.` };
      }
      throw new Error("Could not record the action; the price was not changed.");
    }

    const actor = await vendorWorkOrderActor(ctx);
    const result = await setVendorPriceForWorkOrder(ctx.db, actor, {
      workOrderId: target.id,
      amountCents,
      materialsCents,
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { error: "set_price_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    await updateAuditResult(ctx, dedupeKey, { workOrderId: target.id, amountCents, materialsCents });
    return { reply: `Set your price on "${jobLabel(target.row)}": ${formatUsd(amountCents)} labor + ${formatUsd(materialsCents)} materials (${formatUsd(amountCents + materialsCents)} total).`, resultSummary: { workOrderId: target.id, amountCents, materialsCents } };
  },
});

/* ------------------------------------------------------------------------ */
/* mark_job_done                                                            */
/* ------------------------------------------------------------------------ */

type MarkDoneInput = { workOrderId: string; workDoneSummary?: string };

/** Shared preview/execute validation for the vendor's "job done" signal. */
async function resolveMarkDone(
  ctx: VendorAgentContext,
  input: MarkDoneInput,
): Promise<{ ok: true; target: VendorWorkOrder } | { ok: false; error: string }> {
  const target = await resolveVendorWorkOrderTarget(ctx, input.workOrderId);
  if (!target || target.assignment !== "assigned") {
    return {
      ok: false,
      error: `No work order "${input.workOrderId}" is assigned to you. Use list_my_jobs for valid ids.`,
    };
  }
  if (target.row.bucket !== "scheduled") {
    return { ok: false, error: "This work order isn't ready to be marked done." };
  }
  if (target.row.automationStatus) {
    return { ok: false, error: "This work order has already been marked done." };
  }
  return { ok: true, target };
}

export const markJobDoneTool = defineWriteTool({
  name: "mark_job_done",
  description:
    "Mark a scheduled work order you're assigned to as done, optionally with a short summary of the work — pass the workOrderId from list_my_jobs. This notifies the manager to review and approve payment; it does not complete the job or move money by itself.",
  inputSchema: z
    .object({
      workOrderId: z.string().min(1).describe("Id of a scheduled work order assigned to you (from list_my_jobs)."),
      workDoneSummary: z.string().max(2000).optional().describe("Optional summary of the work performed, shown to the manager."),
    })
    .strict(),
  preview: async (ctx: VendorAgentContext, input) => {
    const res = await resolveMarkDone(ctx, input);
    if (!res.ok) throw new Error(res.error);
    const lines = [
      { label: "Job", value: jobLabel(res.target.row) },
      { label: "Effect", value: "Notifies the manager to review and approve payment" },
    ];
    if (input.workDoneSummary?.trim()) lines.push({ label: "Summary", value: input.workDoneSummary.trim() });
    return {
      kind: "mark_job_done",
      title: "Mark job done",
      summary: `Mark "${res.target.row.title || res.target.id}" as done and notify the manager for approval.`,
      fields: lines,
      confirmLabel: "Mark done",
    };
  },
  handler: async (ctx: VendorAgentContext, input) => {
    const res = await resolveMarkDone(ctx, input);
    if (!res.ok) throw new Error(res.error);
    const { target } = res;

    // One-shot state transition: retries return already-done forever.
    const dedupeKey = `mark_job_done:${ctx.landlordId}:${target.id}`;
    const audit = await writeAuditLog(ctx, {
      action: "mark_job_done",
      toolName: "mark_job_done",
      inputSummary: { workOrderId: target.id },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: `Already done — "${target.row.title || target.id}" was already marked done.` };
      throw new Error("Could not record the action; the job was not marked done.");
    }

    const actor = await vendorWorkOrderActor(ctx);
    const result = await markWorkOrderDoneByVendor(ctx.db, actor, {
      workOrderId: target.id,
      note: input.workDoneSummary,
    });
    if (!result.ok) {
      await updateAuditResult(ctx, dedupeKey, { error: "mark_done_failed" }, { clearDedupeKey: true });
      throw new Error(result.error);
    }

    await updateAuditResult(ctx, dedupeKey, { workOrderId: target.id });
    return { reply: `Marked "${jobLabel(target.row)}" as done — the manager has been notified to review and approve payment.`, resultSummary: { workOrderId: target.id } };
  },
});
