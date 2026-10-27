import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { toGsm7 } from "@/lib/one-number/segments";
import { appendLineTurn, findOrCreateLineSession, VENDOR_LINE_SESSION_KIND } from "@/lib/one-number/vendor-jobs/history.server";
import { asksForWorkOnOwnNumber, parseOwnNumberJobReply, type OwnNumberJobReply } from "@/lib/one-number/vendor-jobs/own-number-intent";
import { titleWithoutAddress } from "@/lib/open-jobs-near.server";
import { requestBoardJob } from "@/lib/service-work-board.server";
import { buildVendorLineContext } from "@/lib/tools/vendor-line-context";
import { runListOpenJobsNear } from "@/lib/tools/domains/vendor-line";
import { recordVendorYes } from "@/lib/vendor-dispatch/responses.server";

/**
 * "Any work?" texted to a vendor's OWN dedicated number from their verified phone (docs/agents/one-number.md).
 *
 * The reply is one short numbered list: jobs offered to THIS vendor (dispatch attempts still `offered`, found through
 * the vendor's own `manager_vendor_records`, never a body value) first, then the public Find work board through the
 * SAME `list_open_jobs_near` read the PropLane line uses. A job on both shows once, as sent to the vendor. The list is
 * saved on the vendor's own-number chat session so "2" or "bid 2 $120" resolves against exactly what was sent:
 * a number is never trusted past that list, and the vendor id comes from the number that was texted.
 * Privacy matches the 206 board: a general area, never a street, unit, resident or contact detail.
 */
export const OWN_NUMBER_LIST_CAP = 5;
export const OWN_NUMBER_LIST_TTL_MS = 45 * 60 * 1000;
const SOURCE = "own_number_work";
const MAX_REPLY_CHARS = 300; // two GSM-7 segments of 153

export const OWN_NUMBER_COPY = {
  empty: "Nothing open near you right now.",
  prompt: "Reply a number to see it or bid.",
  stale: "I do not have a job list for you right now. Text 'any work' for a fresh one.",
} as const;

export type OwnNumberJobEntry = {
  n: number;
  kind: "dispatch" | "board";
  title: string;
  area: string;
  /** "Anytime" is not shown; kept for the detail text. */
  when: string;
  budget: string;
  /** First name of the manager (or workspace) a direct job came from; null for a public one. */
  from: string | null;
  attemptId?: string;
  ref?: string;
};

type Row = Record<string, unknown>;

const firstWord = (value: unknown): string => String(value ?? "").trim().split(/\s+/)[0] ?? "";

const SENDER_FALLBACK = "a manager";
const senderKey = (ownerUserId: string, workspaceId: string | null) => `${ownerUserId}|${workspaceId ?? ""}`;

/**
 * The first name (or workspace name) behind every direct job in one pass: two reads for the whole list, not two per
 * attempt. This runs on the inbound SMS path, so a sender that cannot be read is the generic label, never a refusal.
 */
async function senderLabels(
  db: SupabaseClient,
  senders: ReadonlyArray<{ ownerUserId: string; workspaceId: string | null }>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    const ownerIds = [...new Set(senders.map((s) => s.ownerUserId).filter(Boolean))];
    const byOwner = new Map<string, string>();
    if (ownerIds.length > 0) {
      const { data } = await db.from("profiles").select("id, full_name").in("id", ownerIds);
      for (const row of (data ?? []) as Row[]) {
        const first = firstWord(row.full_name);
        if (first) byOwner.set(String(row.id), first);
      }
    }
    const workspaceIds = [
      ...new Set(senders.filter((s) => !byOwner.has(s.ownerUserId) && s.workspaceId).map((s) => s.workspaceId as string)),
    ];
    const byWorkspace = new Map<string, string>();
    if (workspaceIds.length > 0) {
      const { data } = await db.from("portal_workspaces").select("id, name").in("id", workspaceIds);
      for (const row of (data ?? []) as Row[]) {
        const name = String(row.name ?? "").trim();
        if (name) byWorkspace.set(String(row.id), name);
      }
    }
    for (const sender of senders) {
      const label =
        byOwner.get(sender.ownerUserId) ??
        (sender.workspaceId ? byWorkspace.get(sender.workspaceId) : undefined) ??
        SENDER_FALLBACK;
      labels.set(senderKey(sender.ownerUserId, sender.workspaceId), label);
    }
  } catch {
    // every unresolved sender falls back to the generic label
  }
  return labels;
}

/** Dispatch jobs offered to this vendor and still open, newest offer first. Scoped through the vendor's own roster rows. */
type Candidate = OwnNumberJobEntry & { sourceId?: string };

async function loadOfferedToVendor(db: SupabaseClient, vendorUserId: string, now: Date): Promise<Candidate[]> {
  try {
    const { data: records } = await db.from("manager_vendor_records").select("id").eq("vendor_user_id", vendorUserId);
    const recordIds = ((records ?? []) as Row[]).map((r) => String(r.id));
    if (recordIds.length === 0) return [];
    const { data: attempts } = await db
      .from("vendor_dispatch_attempts")
      .select("id, run_id, status, timeout_at, offered_at")
      .in("vendor_directory_id", recordIds)
      .eq("status", "offered")
      .order("offered_at", { ascending: false })
      .limit(20);
    const live = ((attempts ?? []) as Row[]).filter((a) => !a.timeout_at || new Date(String(a.timeout_at)) > now);
    if (live.length === 0) return [];
    const { data: runs } = await db
      .from("vendor_dispatch_runs")
      .select("id, owner_user_id, workspace_id, trade, issue, status, pay_cents, details, source_type, source_id")
      .in("id", [...new Set(live.map((a) => String(a.run_id)))]);
    const runById = new Map(((runs ?? []) as Row[]).map((r) => [String(r.id), r]));
    const labels = await senderLabels(
      db,
      [...runById.values()]
        .filter((run) => run.status === "offering")
        .map((run) => ({ ownerUserId: String(run.owner_user_id ?? ""), workspaceId: (run.workspace_id as string | null) ?? null })),
    );
    const entries: Candidate[] = [];
    for (const attempt of live) {
      const run = runById.get(String(attempt.run_id));
      if (!run || run.status !== "offering") continue;
      const details = (run.details && typeof run.details === "object" ? run.details : {}) as Row;
      const trade = String(run.trade ?? "Job");
      const title = titleWithoutAddress(String(details.what ?? "").trim() || trade, trade);
      const cents = typeof run.pay_cents === "number" ? run.pay_cents : null;
      entries.push({
        n: 0,
        kind: "dispatch",
        title,
        area: String(details.area ?? "").trim() || "Nearby",
        when: String(details.whenLabel ?? "").trim() || "Anytime",
        budget: cents ? `$${Math.round(cents / 100)}` : "",
        from: labels.get(senderKey(String(run.owner_user_id ?? ""), (run.workspace_id as string | null) ?? null)) ?? SENDER_FALLBACK,
        attemptId: String(attempt.id),
        sourceId: run.source_type === "work_order" ? String(run.source_id ?? "") : undefined,
      });
    }
    return entries;
  } catch {
    return [];
  }
}

async function loadPublicBoard(db: SupabaseClient, vendorUserId: string, phone: string): Promise<Candidate[]> {
  try {
    const ctx = buildVendorLineContext(db, { landlordId: vendorUserId, senderPhone: phone, vendorUserId });
    const listed = await runListOpenJobsNear(ctx, {}, { includeRefs: true, limit: 8 });
    return listed.jobs.map((job) => ({
      n: 0,
      kind: "board" as const,
      title: job.title,
      area: job.area || "Nearby",
      when: job.when,
      budget: job.budget,
      from: null,
      ...(job.ref ? { ref: job.ref } : {}),
      sourceId: job.serviceId,
    }));
  } catch {
    return [];
  }
}

const norm = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function buildOwnNumberJobList(db: SupabaseClient, input: { vendorUserId: string; phone: string; now: Date }): Promise<OwnNumberJobEntry[]> {
  const [direct, board] = await Promise.all([loadOfferedToVendor(db, input.vendorUserId, input.now), loadPublicBoard(db, input.vendorUserId, input.phone)]);
  const seenSource = new Set(direct.map((e) => e.sourceId).filter(Boolean) as string[]);
  const seenText = new Set(direct.map((e) => `${norm(e.title)}|${norm(e.area)}`));
  const publicOnly = board.filter((e) => !(e.sourceId && seenSource.has(e.sourceId)) && !seenText.has(`${norm(e.title)}|${norm(e.area)}`));
  return [...direct, ...publicOnly]
    .slice(0, OWN_NUMBER_LIST_CAP)
    .map(({ sourceId: _sourceId, ...rest }, i): OwnNumberJobEntry => ({ ...rest, n: i + 1 }));
}

/**
 * The reply AND the entries it actually renders. Trailing entries are dropped until the text fits two segments, so
 * the two must be returned together: only what was SENT may be saved as the live list, or a bare "bid 5" would
 * resolve against a job whose title, area and sender the vendor never saw.
 */
export function composeOwnNumberJobList(entries: OwnNumberJobEntry[]): { reply: string; shown: OwnNumberJobEntry[] } {
  if (entries.length === 0) return { reply: OWN_NUMBER_COPY.empty, shown: [] };
  const line = (e: OwnNumberJobEntry) => `${e.n}. ${e.title}, ${e.area}, ${e.from ? `sent to you by ${e.from}` : "open to all"}.`;
  const render = (list: OwnNumberJobEntry[]) => toGsm7(`${list.map(line).join(" ")} ${OWN_NUMBER_COPY.prompt}`);
  let shown = entries;
  let text = render(shown);
  while (text.length > MAX_REPLY_CHARS && shown.length > 1) {
    shown = shown.slice(0, -1);
    text = render(shown);
  }
  return { reply: text, shown };
}

/* ---- the saved list ------------------------------------------------------------------------------------- */

async function saveList(db: SupabaseClient, input: { vendorUserId: string; phone: string; body: string; reply: string; sid: string; now: Date; trace: Row }) {
  const sessionId = await findOrCreateLineSession(db, { ownerUserId: input.vendorUserId, phoneE164: input.phone, vendorUserId: input.vendorUserId });
  if (!sessionId) return;
  await appendLineTurn(db, { sessionId, ownerUserId: input.vendorUserId, inbound: input.body, reply: input.reply, messageSid: input.sid, now: input.now, replyTrace: input.trace });
}

type LiveList = { entries: OwnNumberJobEntry[]; issuedAtMs: number };

/**
 * The newest assistant turn of the vendor's own-number session, when it is a live job list.
 *
 * The 45 minutes run from when the list was ISSUED (`issued_at`, carried forward by every answer to a pick),
 * not from the last turn: answering a pick must not buy the list another window, or a bare number stays a job
 * pick for as long as the vendor keeps replying. Either timestamp being too old retires the list.
 */
async function loadLiveList(db: SupabaseClient, vendorUserId: string, phone: string, now: Date): Promise<LiveList | null> {
  try {
    const { data: session } = await db
      .from("agent_sessions").select("id")
      .eq("landlord_id", vendorUserId).eq("kind", VENDOR_LINE_SESSION_KIND).eq("vendor_phone_e164", phone).limit(1).maybeSingle();
    const sessionId = (session as Row | null)?.id ? String((session as Row).id) : null;
    if (!sessionId) return null;
    const { data } = await db
      .from("agent_messages").select("role, tool_trace, created_at")
      .eq("session_id", sessionId).eq("role", "assistant").order("created_at", { ascending: false }).limit(1);
    const latest = ((data ?? []) as Row[])[0];
    const trace = (latest?.tool_trace ?? null) as Row | null;
    if (!latest || trace?.source !== "propline_line" || trace.list_source !== SOURCE || trace.list_kind !== "job_list") return null;
    const turnAt = Date.parse(String(latest.created_at ?? ""));
    const issuedAt = trace.issued_at ? Date.parse(String(trace.issued_at)) : NaN;
    const oldest = Number.isFinite(issuedAt) ? Math.min(issuedAt, turnAt) : turnAt;
    const age = now.getTime() - oldest;
    if (!Number.isFinite(age) || age > OWN_NUMBER_LIST_TTL_MS || age < -60_000) return null;
    const entries = Array.isArray(trace.entries) ? (trace.entries as OwnNumberJobEntry[]) : [];
    return entries.length > 0 ? { entries, issuedAtMs: Number.isFinite(issuedAt) ? issuedAt : turnAt } : null;
  } catch {
    return null;
  }
}

/**
 * The vendor's own number is about to ask them "Reply to" which manager: a bare number is the manager pick from here
 * on, not a job. Marks the saved list used.
 */
export async function retireOwnNumberJobList(db: SupabaseClient, input: { vendorUserId: string; phone: string; body: string; messageSid: string; now?: Date }): Promise<void> {
  try {
    const now = input.now ?? new Date();
    if (!(await loadLiveList(db, input.vendorUserId, input.phone, now))) return;
    await saveList(db, { vendorUserId: input.vendorUserId, phone: input.phone, body: input.body, reply: "(reply-to prompt)", sid: `${input.messageSid}:route`, now, trace: { list_source: SOURCE, list_kind: "route_prompt" } });
  } catch {
    // The list simply stays live until it expires.
  }
}

/* ---- the turn ------------------------------------------------------------------------------------------- */

export type OwnNumberWorkTurn = { handled: false } | { handled: true; reply: string };

function detailText(e: OwnNumberJobEntry): string {
  const bits = [e.title, e.area, e.when && e.when !== "Anytime" ? e.when : "", e.budget ? (e.kind === "dispatch" ? `pays ${e.budget}` : e.budget) : ""].filter(Boolean);
  return bits.join(", ");
}

export async function handleOwnNumberWorkText(
  db: SupabaseClient,
  input: {
    vendorUserId: string;
    phone: string;
    text: string;
    messageSid: string;
    now?: Date;
    origin?: string;
    /** Newest activity on this number's manager conversations; a number texted after the list is a reply to them. */
    relayActivityAt?: Date | null;
  },
): Promise<OwnNumberWorkTurn> {
  const now = input.now ?? new Date();
  const text = String(input.text ?? "");
  const origin = (input.origin ?? resolveEmailLinkBaseUrl()).replace(/\/$/, "");
  const link = `${origin}/vendor/work-orders/find-work`;

  if (asksForWorkOnOwnNumber(text)) {
    const entries = await buildOwnNumberJobList(db, { vendorUserId: input.vendorUserId, phone: input.phone, now });
    // Only the entries the reply actually listed are saved: the list resolves against exactly what was sent.
    const { reply, shown } = composeOwnNumberJobList(entries);
    await saveList(db, {
      vendorUserId: input.vendorUserId, phone: input.phone, body: text.slice(0, 200), reply, sid: input.messageSid, now,
      trace: shown.length > 0
        ? { list_source: SOURCE, list_kind: "job_list", issued_at: now.toISOString(), entries: shown }
        : { list_source: SOURCE, list_kind: "empty" },
    });
    return { handled: true, reply };
  }

  const picked = parseOwnNumberJobReply(text);
  if (!picked) return { handled: false };
  const live = await loadLiveList(db, input.vendorUserId, input.phone, now);
  if (!live) return { handled: false };
  // A manager text, or the vendor's own relayed reply, after the list went out means the conversation has moved on:
  // "2" is then an answer to that manager, not a job pick, and the relay below takes it.
  if (input.relayActivityAt && input.relayActivityAt.getTime() > live.issuedAtMs) return { handled: false };
  const { entries, issuedAtMs } = live;
  const entry = entries.find((e) => e.n === picked.index);
  const answer = async (reply: string): Promise<OwnNumberWorkTurn> => {
    const sessionId = await findOrCreateLineSession(db, { ownerUserId: input.vendorUserId, phoneE164: input.phone, vendorUserId: input.vendorUserId });
    // Answering a pick keeps the list resolvable for the rest of its window: the vendor may ask about another number.
    if (sessionId) {
      await appendLineTurn(db, { sessionId, ownerUserId: input.vendorUserId, inbound: text.slice(0, 200), reply, messageSid: input.messageSid, now, replyTrace: { list_source: SOURCE, list_kind: "job_list", issued_at: new Date(issuedAtMs).toISOString(), entries } });
    }
    return { handled: true, reply: toGsm7(reply) };
  };
  if (!entry) return answer(`I do not have a job ${picked.index} on that list. Reply a number from it.`);
  return answer(await resolvePick(db, { vendorUserId: input.vendorUserId, entry, picked, link }));
}

async function resolvePick(
  db: SupabaseClient,
  input: { vendorUserId: string; entry: OwnNumberJobEntry; picked: OwnNumberJobReply; link: string },
): Promise<string> {
  const { entry, picked } = input;
  if (picked.action === "see") {
    return `${entry.n}. ${detailText(entry)}. ${entry.from ? `Sent to you by ${entry.from}.` : "Open to all."} Reply BID ${entry.n}${entry.kind === "dispatch" ? " $amount" : ""} to ${entry.kind === "dispatch" ? "take it" : "ask for it"}.`;
  }
  if (entry.kind === "board") {
    if (!entry.ref) return "That job is no longer open.";
    const result = await requestBoardJob(db as never, { userId: input.vendorUserId, role: "vendor" }, { ref: entry.ref, choice: "bid" });
    if (!result.ok) {
      return result.status === 429 ? "Too many requests. Try again in a bit." : result.status === 403 ? `Finish your vendor profile to request jobs: ${input.link}` : "That job is no longer open.";
    }
    return `Requested: ${detailText(entry)}. ${picked.priceCents ? `Add your $${Math.round(picked.priceCents / 100)} bid in PropLane: ` : "Send your bid in PropLane: "}${input.link}`;
  }
  // A job offered to this vendor: the same engine call the SMS YES uses, after re-checking the offer is theirs.
  if (!entry.attemptId) return "That job is no longer open.";
  if (!picked.priceCents) return `Reply BID ${entry.n} $amount to bid on it.`;
  const { data: attempt } = await db.from("vendor_dispatch_attempts").select("id, run_id, vendor_directory_id, status").eq("id", entry.attemptId).maybeSingle();
  const a = attempt as Row | null;
  const { data: records } = await db.from("manager_vendor_records").select("id").eq("vendor_user_id", input.vendorUserId);
  const mine = new Set(((records ?? []) as Row[]).map((r) => String(r.id)));
  if (!a || !mine.has(String(a.vendor_directory_id)) || a.status !== "offered") return "That job is no longer open.";
  const { data: run } = await db.from("vendor_dispatch_runs").select("owner_user_id").eq("id", String(a.run_id)).maybeSingle();
  const ownerUserId = String((run as Row | null)?.owner_user_id ?? "");
  if (!ownerUserId) return "That job is no longer open.";
  const outcome = await recordVendorYes(db, { ownerUserId, attemptId: entry.attemptId, priceCents: picked.priceCents, rawText: `BID ${entry.n} $${Math.round(picked.priceCents / 100)}` });
  switch (outcome.outcome) {
    case "accepted":
      return `Done, ${entry.title} is yours. The manager will confirm the time.`;
    case "quote_held":
      return `Your $${Math.round(picked.priceCents / 100)} bid is with the manager.`;
    default:
      return "That job is no longer open.";
  }
}
