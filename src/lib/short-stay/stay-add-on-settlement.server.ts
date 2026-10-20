import "server-only";

/**
 * What happens once a guest's early check-in / late checkout charge is PAID (bookings-times-1018, contract C).
 * The Stripe webhook calls `settleStayAddOnsForCharges` right after it marks a household charge paid (a card
 * checkout, or a bank payment that cleared). Never for a payment still `processing`.
 *
 * For each paid add-on charge:
 * - availability is checked AGAIN against the room right now (the request-time check can be stale: the
 *   previous guest overstayed, a new booking took the slot);
 * - available -> the stay's real check-in / checkout time moves (`checkInTime` / `checkOutTime`, `starts_at` /
 *   `ends_at`), the record becomes `paid`, the turnover clean is re-timed, the guest is texted from the work
 *   number and the team hears about it;
 * - NOT available (or the capacity trigger refuses the new time, or the stay is gone, or no request matches
 *   the charge) -> the money goes back automatically through `refundPaidHouseholdCharge` on a deterministic
 *   idempotency key, the record becomes `refunded`, the guest is texted and the team hears about it. The
 *   webhook's `charge.refunded` books the ledger as for any refund; nothing here writes the ledger.
 *
 * Idempotent: a replayed webhook finds the record `paid` / `refunded` and does nothing twice. A failure that
 * moves no money and changes nothing THROWS, so the webhook answers 500 and Stripe redelivers.
 */
import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { wallInstantIso, stayAddOnLabel, formatStayTime, formatAddOnPrice, type StayAddOnKind, type StayAddOnRecord } from "@/lib/bookings/stay-times";
import { decideChargeRefund } from "@/lib/charge-refund";
import { resolveChargePaidCents } from "@/lib/charge-paid-cents.server";
import { HouseholdChargeRefundReviewError, refundPaidHouseholdCharge } from "@/lib/household-charge-refund-rail.server";
import { bestEffortFailed } from "@/lib/observability/best-effort";
import { ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";
import {
  stayAddOnChargeId,
  stayAddOnConfirmedText,
  stayAddOnDate,
  stayAddOnRefundText,
  stayAddOnDayLabel,
  isStayAddOnKind,
  readStayAddOns,
} from "@/lib/short-stay/stay-add-ons";
import {
  contextFromBlock,
  quoteStayAddOn,
  swapStayRow,
  withAddOnRecord,
  type StayAddOnContext,
} from "@/lib/short-stay/stay-add-ons.server";
import { loadOwnerIdentity, loadStayLabels } from "@/lib/short-stay/stay-labels.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { refreshTurnoverCleaningTimes } from "@/lib/vendor-dispatch/turnover-timing.server";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export type StayAddOnSettlement =
  | { outcome: "ignored"; reason: "not_add_on" | "not_paid" | "already_settled" }
  | { outcome: "applied"; kind: StayAddOnKind; chargeId: string; time: string }
  | { outcome: "refunded"; kind: StayAddOnKind; chargeId: string; reason: string }
  /** The automatic refund hit a terminal refusal: the add-on is stamped `refund_failed` and the host is told once. */
  | { outcome: "refund_failed"; kind: StayAddOnKind; chargeId: string; reason: string; error: string };

const CHARGE_ID_SHAPE = /^hc_mgr_stay_.+_(early_check_in|late_check_out)$/;

/** Stripe's refund idempotency key for an add-on: the same charge and amount always map to the same refund. */
export function stayAddOnRefundKey(chargeId: string, amountCents: number): string {
  return `stay-add-on-refund:${chargeId}:${amountCents}`;
}

type BlockRow = { id: string; manager_user_id: string | null; property_id: string | null; record_type: string; row_data: unknown; updated_at: string | null };

async function readBlockRow(db: SupabaseClient, blockId: string): Promise<BlockRow | null> {
  const { data, error } = await db
    .from("portal_schedule_records")
    .select("id, manager_user_id, property_id, record_type, row_data, updated_at")
    .eq("id", blockId)
    .maybeSingle();
  if (error) throw new Error("Could not read the stay for its paid add-on.");
  return (data as BlockRow | null) ?? null;
}

/* ───────────────────────── the Stripe charge to refund ───────────────────────── */

async function stripeChargeIdFor(
  db: SupabaseClient,
  chargeId: string,
  options: { stripe?: Stripe; paymentIntentId?: string | null },
): Promise<{ stripeChargeId: string | null; ledgerAmountCents: number | null }> {
  const { data: payment } = await db
    .from("ledger_entries")
    .select("stripe_charge_id, amount_cents")
    .eq("source_charge_id", chargeId)
    .eq("entry_type", "payment")
    .maybeSingle();
  const fromLedger = typeof payment?.stripe_charge_id === "string" ? payment.stripe_charge_id.trim() : "";
  const ledgerAmountCents = payment?.amount_cents == null ? null : Number(payment.amount_cents);
  if (fromLedger) return { stripeChargeId: fromLedger, ledgerAmountCents };
  // The ledger line can lag the webhook: the payment intent names the same charge.
  if (options.stripe && options.paymentIntentId) {
    const intent = await options.stripe.paymentIntents.retrieve(options.paymentIntentId);
    const latest = typeof intent.latest_charge === "string" ? intent.latest_charge : intent.latest_charge?.id;
    if (latest) return { stripeChargeId: latest, ledgerAmountCents };
  }
  return { stripeChargeId: null, ledgerAmountCents };
}

/* ───────────────────────── the guest's text and the team's notice ───────────────────────── */

async function textGuest(
  db: SupabaseClient,
  input: { row: Record<string, unknown>; ownerId: string; propertyId: string; chargeId: string; purpose: string; body: string },
): Promise<void> {
  const phone = typeof input.row.residentPhone === "string" ? input.row.residentPhone : "";
  if (!phone) return;
  const email = typeof input.row.residentEmail === "string" ? input.row.residentEmail.trim().toLowerCase() : "";
  await enqueueOwnerSms(
    {
      managerUserId: input.ownerId,
      actorUserId: input.ownerId,
      recipientPhone: phone,
      recipientEmail: email || undefined,
      body: `PropLane: ${input.body}`,
      sendClass: "transactional",
      purpose: input.purpose,
      counterpartyRole: "prospect",
      propertyId: input.propertyId,
      dedupeKey: `${input.purpose}:${input.chargeId}`,
    },
    db,
  );
}

/** `channel_booking` / `short_stay_add_on_paid|refunded` to the owner and teammates (the notice spine). */
async function emitAddOnNotice(
  db: SupabaseClient,
  input: {
    event: "short_stay_add_on_paid" | "short_stay_add_on_refunded" | "short_stay_add_on_refund_failed";
    headline: string;
    detail: string;
    blockId: string;
    chargeId: string;
    ownerId: string;
    propertyId: string;
    roomId: string;
    row: Record<string, unknown>;
  },
): Promise<void> {
  const owner = await loadOwnerIdentity(db, input.ownerId);
  if (!owner.email) return;
  const labels = await loadStayLabels(db, input.propertyId, input.roomId);
  const guestName = typeof input.row.residentName === "string" && input.row.residentName.trim() ? input.row.residentName.trim() : "Guest";
  const url = `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/portal/bookings/${encodeURIComponent(`block:${input.blockId}`)}`;
  const line = [input.headline, labels.propertyLabel, labels.roomLabel, input.detail, guestName].join(" · ");
  await emitActionEvent(db, {
    eventId: `${input.event}:${input.chargeId}`,
    domain: "channel_booking",
    event: input.event,
    managerUserId: input.ownerId,
    entityId: input.blockId,
    category: "tours",
    senderUserId: input.ownerId,
    senderEmail: owner.email,
    senderName: owner.name || undefined,
    payload: { propertyId: input.propertyId, roomId: input.roomId, blockId: input.blockId, chargeId: input.chargeId },
    templateContext: { propertyTitle: labels.propertyLabel, roomLabel: labels.roomLabel, stayLabel: input.detail, url },
    recipients: [{ audience: "manager", userId: input.ownerId, rendered: { subject: input.headline, text: `${line}\n\n${url}`, smsText: `${line}\n${url}` } }],
  });
}

/* ───────────────────────── paid, now apply or refund ───────────────────────── */

/**
 * Settles ONE paid add-on charge. See the file header. `stripe` is needed only on the refund path.
 */
export async function applyPaidStayAddOn(
  db: SupabaseClient,
  input: { chargeId: string; stripe?: Stripe; paymentIntentId?: string | null; now?: Date },
): Promise<StayAddOnSettlement> {
  const chargeId = input.chargeId.trim();
  if (!CHARGE_ID_SHAPE.test(chargeId)) return { outcome: "ignored", reason: "not_add_on" };
  const { data: chargeRow, error: chargeError } = await db
    .from("portal_household_charge_records")
    .select("id, manager_user_id, status, row_data")
    .eq("id", chargeId)
    .maybeSingle();
  if (chargeError) throw new Error("Could not read the add-on charge.");
  if (!chargeRow) return { outcome: "ignored", reason: "not_add_on" };
  const charge = asRecord(chargeRow.row_data);
  const kind = charge.stayAddOn;
  const blockId = typeof charge.guestStayBlockId === "string" ? charge.guestStayBlockId.trim() : "";
  if (!isStayAddOnKind(kind) || !blockId || stayAddOnChargeId(blockId, kind) !== chargeId) {
    return { outcome: "ignored", reason: "not_add_on" };
  }
  // Only a SETTLED payment moves a stay's time or sends money back; a bank payment still clearing waits.
  if (chargeRow.status !== "paid" || charge.status === "processing") return { outcome: "ignored", reason: "not_paid" };

  const now = input.now ?? new Date();
  const nowIso = now.toISOString();

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const block = await readBlockRow(db, blockId);
    const row = asRecord(block?.row_data);
    const stored = readStayAddOns(row.stayDetails)[kind];

    // Replay: this charge already decided the add-on.
    if (stored && stored.chargeId === chargeId && (stored.status === "paid" || stored.status === "refunded" || stored.status === "refund_failed")) {
      return { outcome: "ignored", reason: "already_settled" };
    }

    const refuse = (reason: string, alreadyRefunded = false) =>
      refundUnhonoredAddOn(db, { chargeId, chargeRow, charge, kind, blockId, block, stored, reason, now, alreadyRefunded, stripe: input.stripe, paymentIntentId: input.paymentIntentId });

    // A payment that was already refunded (the redelivery after a crash between the refund and the stay's
    // record) is settled-refunded BEFORE anything is quoted: it never applies the add-on. Go straight to recording it.
    if (Number(charge.refundedCents ?? 0) > 0) {
      return refuse(typeof charge.stayAddOnRefundReason === "string" ? charge.stayAddOnRefundReason : "refunded", true);
    }

    if (!block || block.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE) return refuse("stay_cancelled");
    if (row.residentUserId !== charge.residentUserId || !charge.residentUserId) return refuse("wrong_guest");
    if (!stored || stored.chargeId !== chargeId) return refuse("no_request");
    const ctx = await contextFromBlock(db, block);
    if (!ctx || ctx.bookingStatus !== "confirmed") return refuse("stay_not_confirmed");

    const quote = quoteStayAddOn(ctx, kind, { requestedTime: stored.time, now });
    if (!quote.available) return refuse(quote.reason);

    const times = {
      checkInTime: kind === "early_check_in" ? stored.time : ctx.stay.checkInTime,
      checkOutTime: kind === "late_check_out" ? stored.time : ctx.stay.checkOutTime,
    };
    const startsAt = wallInstantIso(ctx.stay.checkIn, times.checkInTime, ctx.clock.timeZone);
    const endsAt = wallInstantIso(ctx.stay.checkOut, times.checkOutTime, ctx.clock.timeZone);
    const paidRecord: StayAddOnRecord = { ...stored, status: "paid", paidAt: nowIso };
    const nextRow = {
      ...withAddOnRecord(ctx.row, kind, paidRecord),
      checkInTime: times.checkInTime,
      checkOutTime: times.checkOutTime,
      startsAt,
      endsAt,
    };
    const swapped = await swapStayRow(db, ctx, { row_data: nextRow, starts_at: startsAt, ends_at: endsAt }, nowIso);
    if (swapped === "lost") continue;
    if (swapped === "refused") return refuse("slot_taken");
    // A constraint error repeats forever: the time cannot be honored, so the money goes back. Any other write
    // failure is transient: throw, and the webhook is redelivered.
    if (swapped === "rejected") return refuse("write_rejected");
    if (swapped === "failed") throw new Error("Could not apply the paid add-on to the stay.");

    await afterApplied(db, { ctx, kind, chargeId, record: paidRecord, nextRow, times });
    return { outcome: "applied", kind, chargeId, time: stored.time };
  }
  throw new Error("The stay kept changing while its paid add-on was applied.");
}

/** The post-swap effects: the stay is already updated and none of these may undo it. */
async function afterApplied(
  db: SupabaseClient,
  input: {
    ctx: StayAddOnContext;
    kind: StayAddOnKind;
    chargeId: string;
    record: StayAddOnRecord;
    nextRow: Record<string, unknown>;
    times: { checkInTime: string; checkOutTime: string };
  },
): Promise<void> {
  const { ctx, kind, chargeId, record, nextRow } = input;
  // The clean that ends at this check-in (early) or starts at this checkout (late) moves with the time.
  const previous = ctx.others.filter((other) => other.checkOut <= ctx.stay.checkIn).sort((a, b) => b.checkOut.localeCompare(a.checkOut))[0];
  const checkOutDate = kind === "late_check_out" ? ctx.stay.checkOut : previous?.checkOut;
  if (checkOutDate) {
    await refreshTurnoverCleaningTimes(db, { ownerUserId: ctx.ownerId, propertyId: ctx.propertyId, roomId: ctx.roomId, checkOutDate }).catch(
      bestEffortFailed("re-time the turnover clean", { blockId: ctx.blockId, kind }),
    );
  }
  const dates = { checkIn: ctx.stay.checkIn, checkOut: ctx.stay.checkOut };
  await textGuest(db, {
    row: nextRow,
    ownerId: ctx.ownerId,
    propertyId: ctx.propertyId,
    chargeId,
    purpose: "short_stay_add_on_confirmed",
    body: stayAddOnConfirmedText({ kind, time: record.time, ...dates }),
  }).catch(bestEffortFailed("stay add-on confirmation text", { blockId: ctx.blockId, kind }));
  await emitAddOnNotice(db, {
    event: "short_stay_add_on_paid",
    headline: `${stayAddOnLabel(kind)} added`,
    detail: `${stayAddOnLabel(kind)} ${formatStayTime(record.time)} on ${stayAddOnDayLabel(stayAddOnDate(kind, dates))}`,
    blockId: ctx.blockId,
    chargeId,
    ownerId: ctx.ownerId,
    propertyId: ctx.propertyId,
    roomId: ctx.roomId,
    row: nextRow,
  }).catch(bestEffortFailed("stay add-on team notice", { blockId: ctx.blockId, kind }));
}

/* ───────────────────────── paid but cannot be honored: refund ───────────────────────── */

/** A Stripe refusal that retrying never fixes (a bad request), as opposed to a network or rate-limit failure. */
function isTerminalStripeError(error: unknown): boolean {
  const e = error as { type?: string; rawType?: string; name?: string } | null;
  return e?.type === "StripeInvalidRequestError" || e?.rawType === "invalid_request_error" || e?.name === "StripeInvalidRequestError";
}

/**
 * Writes the outcome (`refunded` / `refund_failed`) on the stay's record for this charge, re-reading and
 * retrying when another write beat it (`lost`). A constraint error that repeats forever is logged and
 * skipped (the money state is already right); a transient failure, or retries exhausted, throws so the
 * webhook is redelivered. Returns the block as last read (null when the stay is gone).
 */
async function recordAddOnOutcome(
  db: SupabaseClient,
  input: { blockId: string; kind: StayAddOnKind; chargeId: string; charge: Record<string, unknown>; status: "refunded" | "refund_failed"; reason: string; nowIso: string },
): Promise<BlockRow | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const block = await readBlockRow(db, input.blockId);
    if (!block || block.record_type !== ROOM_DATE_BLOCK_RECORD_TYPE) return null;
    const row = asRecord(block.row_data);
    const stored = readStayAddOns(row.stayDetails)[input.kind];
    if (!stored || stored.chargeId !== input.chargeId || row.residentUserId !== input.charge.residentUserId || stored.status === input.status) return block;
    const next: StayAddOnRecord = {
      ...stored,
      status: input.status,
      ...(input.status === "refunded" ? { refundedAt: input.nowIso } : {}),
      refundReason: input.reason,
    };
    const swapped = await swapStayRow(db, { blockId: block.id, updatedAt: block.updated_at ?? null }, { row_data: withAddOnRecord(row, input.kind, next) }, input.nowIso);
    if (swapped === "ok") return { ...block, row_data: withAddOnRecord(row, input.kind, next) };
    if (swapped === "rejected" || swapped === "refused") {
      bestEffortFailed("record a stay add-on refund outcome", { blockId: input.blockId, chargeId: input.chargeId })(new Error(swapped));
      return block;
    }
    if (swapped === "failed") throw new Error("Could not record the add-on refund on the stay.");
  }
  throw new Error("The stay kept changing while its add-on refund was recorded.");
}

async function refundUnhonoredAddOn(
  db: SupabaseClient,
  input: {
    chargeId: string;
    chargeRow: { id: unknown; manager_user_id: unknown; status: unknown; row_data: unknown };
    charge: Record<string, unknown>;
    kind: StayAddOnKind;
    blockId: string;
    block: BlockRow | null;
    stored: StayAddOnRecord | undefined;
    reason: string;
    now: Date;
    /** The charge row already says money went back: record it on the stay, never refund or quote again. */
    alreadyRefunded?: boolean;
    stripe?: Stripe;
    paymentIntentId?: string | null;
  },
): Promise<StayAddOnSettlement> {
  const { chargeId, charge, kind, stored, reason } = input;
  const nowIso = input.now.toISOString();
  let refundedAmountCents = 0;
  let terminal: string | null = null;

  if (!input.alreadyRefunded) {
    const { stripeChargeId, ledgerAmountCents } = await stripeChargeIdFor(db, chargeId, { stripe: input.stripe, paymentIntentId: input.paymentIntentId });
    const decision = decideChargeRefund({
      kind: String(charge.kind ?? ""),
      status: "paid",
      paidCents: resolveChargePaidCents(ledgerAmountCents, charge),
      alreadyRefundedCents: Number(charge.refundedCents ?? 0),
      stripeChargeId,
      settled: charge.stripePaymentStatus !== "processing" && charge.stripePaymentStatus !== "pending",
    });

    if (decision.ok) {
      let stripe = input.stripe;
      if (!stripe) {
        const { getStripe } = await import("@/lib/stripe");
        stripe = getStripe();
      }
      try {
        await refundPaidHouseholdCharge(stripe, db, {
          chargeId,
          stripeChargeId: decision.stripeChargeId,
          amountCents: decision.amountCents,
          // Deterministic: a redelivered webhook, or a retry after a timeout that actually succeeded, is the SAME refund.
          idempotencyKey: stayAddOnRefundKey(chargeId, decision.amountCents),
          metadata: { proplane_charge_id: chargeId, kind: "stay_add_on_refund", reason },
        });
        refundedAmountCents = decision.amountCents;
      } catch (error) {
        // A TERMINAL refusal (the rail says retry never helps, or Stripe rejects the request) is stamped for a
        // person and returns normally: throwing would make the webhook answer 500 forever. Only a transient
        // failure throws, so Stripe redelivers.
        if (error instanceof HouseholdChargeRefundReviewError || isTerminalStripeError(error)) {
          terminal = error instanceof Error ? error.message : "The refund was refused.";
        } else {
          throw error;
        }
      }
      if (!terminal) {
        const recorded = await db.from("portal_household_charge_records").upsert(
          {
            id: chargeId,
            manager_user_id: input.chargeRow.manager_user_id,
            resident_email: String(charge.residentEmail ?? "").trim().toLowerCase(),
            status: input.chargeRow.status,
            row_data: {
              ...charge,
              refundedCents: Number(charge.refundedCents ?? 0) + decision.amountCents,
              refundAttempts: 1,
              lastRefundedAt: nowIso,
              stayAddOnRefundReason: reason,
            },
            updated_at: nowIso,
          },
          { onConflict: "id" },
        );
        // The refund itself is idempotency-keyed, so throwing here is safe and is the only way the money shows up in
        // Payments: a silent failure leaves the charge reading paid with `refundedCents: 0` while a replay reports
        // `already_settled`, so the same amount could be refunded a second time.
        if (recorded.error) throw new Error(`Stay add-on refund was not recorded: ${recorded.error.message}`);
      }
    } else if (decision.reason !== "nothing_left") {
      // Cannot refund (no Stripe charge on file, payment not settled...): no retry fixes it.
      terminal = decision.message;
    }
    if (terminal) bestEffortFailed("stay add-on refund needs review", { chargeId, reason })(new Error(terminal));
  }

  const status = terminal ? "refund_failed" : "refunded";
  const block = await recordAddOnOutcome(db, { blockId: input.blockId, kind, chargeId, charge, status, reason: terminal ? `${reason}: ${terminal}` : reason, nowIso });

  const row = block ? asRecord(block.row_data) : { residentName: charge.residentName };
  const ownerId = String(block?.manager_user_id ?? charge.managerUserId ?? "").trim();
  const propertyId = String(block?.property_id ?? row.propertyId ?? charge.propertyId ?? "").trim();
  const roomId = String(row.roomId ?? "").trim();
  const checkIn = String(row.checkIn ?? "");
  const checkOut = String(row.checkOut ?? "");
  const time = stored?.time ?? (typeof charge.stayAddOnTime === "string" ? charge.stayAddOnTime : kind === "early_check_in" ? "12:00" : "14:00");
  const priceCents = stored?.priceCents ?? (refundedAmountCents || Number(charge.stayAddOnPriceCents) || 0);

  if (terminal) {
    // ONE notice per charge (its event id is keyed on the charge): the host refunds it from Payments.
    const guest = typeof row.residentName === "string" && row.residentName.trim() ? row.residentName.trim() : "the guest";
    await emitAddOnNotice(db, {
      event: "short_stay_add_on_refund_failed",
      headline: `Refund needs you: ${stayAddOnLabel(kind)}`,
      detail: `Couldn't refund the ${formatAddOnPrice(priceCents)} ${stayAddOnLabel(kind).toLowerCase()} for ${guest} automatically. Refund it from Payments`,
      blockId: input.blockId,
      chargeId,
      ownerId,
      propertyId,
      roomId,
      row,
    }).catch(bestEffortFailed("stay add-on refund-failed notice", { blockId: input.blockId, kind }));
    return { outcome: "refund_failed", kind, chargeId, reason, error: terminal };
  }

  // Also on a replay whose refund already went out: the text and the notice are idempotent on their own
  // keys, and the first delivery may have died before sending them.
  if (block) {
    const standardTime = kind === "early_check_in" ? String(row.checkInTime ?? "15:00") : String(row.checkOutTime ?? "11:00");
    await textGuest(db, {
      row,
      ownerId,
      propertyId,
      chargeId,
      purpose: "short_stay_add_on_refunded",
      body: stayAddOnRefundText({ kind, time, priceCents, checkIn, checkOut, standardTime }),
    }).catch(bestEffortFailed("stay add-on refund text", { blockId: input.blockId, kind }));
    await emitAddOnNotice(db, {
      event: "short_stay_add_on_refunded",
      headline: `${stayAddOnLabel(kind)} refunded`,
      detail: `${stayAddOnLabel(kind)} ${formatStayTime(time)} on ${stayAddOnDayLabel(stayAddOnDate(kind, { checkIn, checkOut }))} could not be honored (${reason})`,
      blockId: input.blockId,
      chargeId,
      ownerId,
      propertyId,
      roomId,
      row,
    }).catch(bestEffortFailed("stay add-on refund notice", { blockId: input.blockId, kind }));
  }
  return { outcome: "refunded", kind, chargeId, reason };
}

/* ───────────────────────── the webhook's one call ───────────────────────── */

/**
 * Settles every stay add-on among a paid payment's charge ids; every other charge is skipped on its id
 * alone (no read). Throws when ONE settlement threw after the others ran, so the webhook is redelivered.
 */
export async function settleStayAddOnsForCharges(
  db: SupabaseClient,
  input: { chargeIds: readonly string[]; stripe?: Stripe; paymentIntentId?: string | null },
): Promise<StayAddOnSettlement[]> {
  const results: StayAddOnSettlement[] = [];
  let failure: unknown = null;
  for (const chargeId of input.chargeIds) {
    if (!CHARGE_ID_SHAPE.test(chargeId.trim())) continue;
    try {
      results.push(await applyPaidStayAddOn(db, { chargeId, stripe: input.stripe, paymentIntentId: input.paymentIntentId }));
    } catch (error) {
      bestEffortFailed("settle a paid stay add-on", { chargeId })(error);
      failure ??= error;
    }
  }
  if (failure) throw failure instanceof Error ? failure : new Error("A paid stay add-on could not be settled.");
  return results;
}
