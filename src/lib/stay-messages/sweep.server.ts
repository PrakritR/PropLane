import "server-only";

/**
 * The check-in / check-out sweep (design-1112 §7). Runs from `/api/cron/stay-messages` every five minutes and is driven by
 * ports (`StayMessageDeps`) so the unit tests drive the clock and a fake ledger through the very same code.
 *
 * Exactly-once, three layers deep: the ledger's unique (stay_key, kind) row is claimed BEFORE any send (insert-then-send, a
 * compare-and-set on `updated_at`); each channel's own result is stored, so a retry sends only the channels that did not
 * deliver; and every downstream send carries the same deterministic idempotency key.
 */
import { buildStayFacts, stayFactsHash } from "@/lib/stay-messages/facts";
import { checkInWindow, checkOutWindow, stayEnded } from "@/lib/stay-messages/schedule";
import { buildStayMessage, type StayMessageSettings } from "@/lib/stay-messages/templates";
import type {
  ChannelName,
  ChannelResults,
  LedgerRow,
  StayCandidate,
  StayHoldReason,
  StayMessageDeps,
  StayMessageKind,
  StayMessageStatus,
  StayMessageSweepSummary,
  StayProperty,
} from "@/lib/stay-messages/types";

const MAX_ATTEMPTS = 3;
const CHANNELS: readonly ChannelName[] = ["sms", "email", "inbox"];

function hasContact(candidate: StayCandidate): boolean {
  return Boolean(candidate.guestPhone || candidate.guestEmail || candidate.guestUserId);
}

function attemptsOf(row: LedgerRow | null): number {
  return typeof row?.channels.attempts === "number" ? row.channels.attempts : 0;
}

function statusFromChannels(results: ChannelResults): StayMessageStatus {
  const outcomes = CHANNELS.map((channel) => results[channel]).filter((value): value is NonNullable<typeof value> => Boolean(value));
  const sent = outcomes.filter((outcome) => outcome.status === "sent").length;
  const failed = outcomes.filter((outcome) => outcome.status === "failed").length;
  if (sent > 0 && failed === 0) return "sent";
  if (sent > 0) return "partial";
  if (failed > 0) return "failed";
  return "held";
}

export async function runStayMessageSweep(deps: StayMessageDeps): Promise<StayMessageSweepSummary> {
  const summary: StayMessageSweepSummary = { examined: 0, sent: 0, partial: 0, failed: 0, held: 0, cancelled: 0, corrections: 0 };
  const candidates = await deps.loadCandidates();
  const properties = new Map<string, StayProperty | null>();
  const settingsCache = new Map<string, StayMessageSettings>();
  const now = deps.now();

  const settingsFor = async (candidate: StayCandidate): Promise<StayMessageSettings> => {
    const key = `${candidate.ownerUserId}:${candidate.workspaceId ?? ""}`;
    let settings = settingsCache.get(key);
    if (!settings) {
      settings = await deps.loadSettings({ ownerUserId: candidate.ownerUserId, workspaceId: candidate.workspaceId });
      settingsCache.set(key, settings);
    }
    return settings;
  };

  for (const candidate of candidates) {
    summary.examined += 1;
    try {
      let property = properties.get(candidate.propertyId);
      if (property === undefined) {
        property = await deps.loadProperty(candidate.propertyId);
        properties.set(candidate.propertyId, property);
      }
      if (!property) continue;

      if (candidate.status === "cancelled") {
        for (const kind of ["check_in", "check_out"] as const) {
          const row = await deps.ledger.find(candidate.stayKey, kind);
          if (row && (row.status === "scheduled" || row.status === "held" || row.status === "failed")) {
            await deps.ledger.update(row.id, { status: "cancelled", holdReason: "cancelled" });
            summary.cancelled += 1;
          }
        }
        continue; // a cancelled booking is never sent anything, and nothing after a send either
      }
      if (candidate.status !== "confirmed" || !candidate.leaseSigned) continue;

      const settings = await settingsFor(candidate);
      if (!settings.sources[candidate.source]) continue;
      if (!hasContact(candidate)) continue;

      const ctx = { deps, candidate, property, settings, now, summary };
      const checkIn = checkInWindow({ checkInDate: candidate.checkIn, checkInTime: candidate.checkInTime, now, timeZone: property.timeZone });
      if (checkIn?.state === "due") await deliverKind(ctx, "check_in", checkIn.dueAt, null);
      if (candidate.checkOut && candidate.checkOut !== "9999-12-31") {
        const checkOut = checkOutWindow({ checkOutDate: candidate.checkOut, checkOutTime: candidate.checkOutTime, now, timeZone: property.timeZone });
        if (checkOut?.state === "due") await deliverKind(ctx, "check_out", checkOut.dueAt, null);
      }
      await maybeCorrect(ctx);
    } catch (cause) {
      // One stay's failure never stops the rest of the sweep; no guest data in the log.
      console.error("stay message sweep: one stay failed", cause instanceof Error ? cause.message : "unknown");
    }
  }
  return summary;
}

type Ctx = {
  deps: StayMessageDeps;
  candidate: StayCandidate;
  property: StayProperty;
  settings: StayMessageSettings;
  now: Date;
  summary: StayMessageSweepSummary;
};

async function hold(ctx: Ctx, existing: LedgerRow | null, kind: StayMessageKind, dueAt: Date, reason: StayHoldReason, factsHash: string | null): Promise<void> {
  const { deps, candidate, property } = ctx;
  let row = existing;
  let first = false;
  if (!row) {
    const inserted = await deps.ledger.insert({
      workspaceId: candidate.workspaceId ?? "",
      stayKey: candidate.stayKey,
      kind,
      status: "held",
      holdReason: reason,
      dueAt: dueAt.toISOString(),
      roomId: candidate.roomId || null,
      factsHash,
    });
    row = inserted.row;
    first = inserted.created;
  } else if (row.status !== "held" || row.holdReason !== reason) {
    await deps.ledger.update(row.id, { status: "held", holdReason: reason });
    first = true;
  }
  ctx.summary.held += first ? 1 : 0;
  // One flag per hold, not one per five-minute sweep.
  if (first) {
    const room = property.rooms.find((r) => r.id === candidate.roomId)?.label || "this room";
    const text =
      reason === "room_code_missing"
        ? `${kind === "check_in_correction" ? "Update" : "Check-in"} message held: ${room} at ${property.label} has no door code. Add the room's Room door code and it sends on its own.`
        : `Check-in message held for ${property.label}: it would have carried a code that is not this guest's. Nothing was sent.`;
    await deps.flagManager({
      workspaceId: candidate.workspaceId,
      ownerUserId: candidate.ownerUserId,
      propertyId: candidate.propertyId,
      text,
      key: `stay-msg-held:${candidate.stayKey}:${kind}:${reason}`,
    });
  }
}

async function deliverKind(ctx: Ctx, kind: StayMessageKind, dueAt: Date, factsHash: string | null, header?: string): Promise<boolean> {
  const { deps, candidate, property, settings, now } = ctx;
  const existing = await deps.ledger.find(candidate.stayKey, kind, kind === "check_in_correction" ? factsHash : undefined);
  if (existing) {
    if (existing.status === "sent") return false;
    if ((existing.status === "partial" || existing.status === "failed") && attemptsOf(existing) >= MAX_ATTEMPTS) return false;
  }
  const facts = buildStayFacts({ kind, candidate, property, settings, now });
  const template = kind === "check_out" ? settings.templates.checkOut : settings.templates.checkIn;
  const built = buildStayMessage({ template, facts, correctionHeader: header });
  const hash = factsHash ?? stayFactsHash(candidate, property);
  if (!built.ok) {
    if (built.reason === "room_code_missing" || built.reason === "foreign_code") await hold(ctx, existing, kind, dueAt, built.reason, hash);
    return false;
  }

  let row = existing;
  if (!row) {
    const inserted = await deps.ledger.insert({
      workspaceId: candidate.workspaceId ?? "",
      stayKey: candidate.stayKey,
      kind,
      status: "scheduled",
      dueAt: dueAt.toISOString(),
      roomId: candidate.roomId || null,
      factsHash: hash,
    });
    row = inserted.row;
    // Lost the race: another sweep inserted first and owns this send.
    if (!inserted.created && row.status !== "scheduled" && row.status !== "held") return false;
  }
  if (!(await deps.ledger.claim(row))) return false;

  const sentSoFar: ChannelResults = { ...row.channels };
  const results = await deps.send({
    candidate,
    property,
    kind,
    subject: built.subject,
    body: built.body,
    smsBody: built.smsBody,
    already: row.channels,
    checkpoint: async (partial) => {
      for (const channel of CHANNELS) {
        const outcome = partial[channel];
        if (outcome && sentSoFar[channel]?.status !== "sent") sentSoFar[channel] = outcome;
      }
      await deps.ledger.update(row!.id, { channels: { ...sentSoFar, attempts: attemptsOf(row) } });
    },
    dedupeBase: kind === "check_in_correction" ? `${candidate.stayKey}:${kind}:${hash.slice(0, 16)}` : `${candidate.stayKey}:${kind}`,
  });
  const merged: ChannelResults = { ...row.channels };
  for (const channel of CHANNELS) {
    const outcome = results[channel];
    if (outcome && merged[channel]?.status !== "sent") merged[channel] = outcome;
  }
  merged.attempts = attemptsOf(row) + 1;
  const status = statusFromChannels(merged);
  const delivered = status === "sent" || status === "partial";
  await deps.ledger.update(row.id, {
    status,
    holdReason: status === "held" ? "no_contact" : null,
    sentAt: delivered ? now.toISOString() : null,
    factsHash: hash,
    channels: merged,
  });
  if (status === "sent") ctx.summary.sent += 1;
  else if (status === "partial") ctx.summary.partial += 1;
  else if (status === "failed") ctx.summary.failed += 1;
  else ctx.summary.held += 1;
  for (const channel of CHANNELS) {
    const outcome = results[channel];
    if (outcome?.status === "failed") {
      await deps.recordIssue({ candidate, kind, channel, reason: outcome.reason ?? "The send failed.", eventId: `stay-msg:${candidate.stayKey}:${kind}:${channel}` });
    }
  }
  return delivered;
}

/** After the check-in went out: the room or the dates changed -> ONE correction message, then the stored hash moves. */
async function maybeCorrect(ctx: Ctx): Promise<void> {
  const { deps, candidate, property, now } = ctx;
  if (stayEnded({ checkOutDate: candidate.checkOut ?? "9999-12-31", checkOutTime: candidate.checkOutTime, now, timeZone: property.timeZone })) return;
  const checkIn = await deps.ledger.find(candidate.stayKey, "check_in");
  if (!checkIn || (checkIn.status !== "sent" && checkIn.status !== "partial") || !checkIn.factsHash) return;
  const hash = stayFactsHash(candidate, property);
  if (hash === checkIn.factsHash) return;
  const room = property.rooms.find((r) => r.id === candidate.roomId)?.label;
  const header = `Update: your stay details changed${room ? `, you are now in ${room}` : ""}.`;
  const delivered = await deliverKind(ctx, "check_in_correction", new Date(now.getTime()), hash, header);
  if (delivered) {
    await deps.ledger.update(checkIn.id, { factsHash: hash });
    ctx.summary.corrections += 1;
  }
}
