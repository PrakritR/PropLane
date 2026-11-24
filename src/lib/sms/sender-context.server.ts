import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { listLineMemberships } from "@/lib/one-number/line-member-status.server";
import { findResidentCandidates, findVerifiedProfileByPhone } from "@/lib/one-number/router-lookups.server";
import { holdsAdminRole, listServiceWorkspaceRefs } from "@/lib/sms/service-manager-inbound.server";
import {
  decideSenderContext,
  resolveSenderTarget,
  sameTarget,
  type SenderContext,
  type SenderDecision,
  type SenderHome,
  type SenderPending,
  type SenderSticky,
  type SenderTarget,
  type ServiceWorkspaceLite,
} from "@/lib/sms/sender-context";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * Who is this verified sender TEXTING AS? The pure decision is `sender-context.ts`; this file loads what it needs and
 * keeps the two small pieces of state. Docs: docs/agents/one-number.md § Who is the sender texting as.
 *
 * Everything is re-derived from the database on every text and FAILS CLOSED: a membership, role or residency read that
 * errors adds no context (a sender can only ever lose a context to a failed read, never gain one), and when the
 * contexts themselves cannot be read the text is `unchanged` - exactly the context the number's own identity gate
 * already proved, never a wider one.
 *
 * State (no new table): two rows of `sms_line_sessions`, keyed like the service-manager picker's (`sm:`, `smo:`).
 *   `scs:<phone>`  the last pick (sticky, 12 hours)
 *   `scq:<phone>`  the question we asked and the text it is holding (30 minutes)
 */

type Row = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());
const obj = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});

const stickyKey = (phone: string) => `scs:${normalizeConsentPhone(phone)}`;
const questionKey = (phone: string) => `scq:${normalizeConsentPhone(phone)}`;

export type ResolvedSenderTarget = { context: SenderContext; workspace: ServiceWorkspaceLite | null };

export type SenderContextOutcome =
  | { kind: "unchanged" }
  | { kind: "reply"; text: string }
  | { kind: "run"; body: string; tag: string | null; resolved: ResolvedSenderTarget; source: Extract<SenderDecision, { kind: "run" }>["source"] };

/** Every context this verified sender holds right now. Null when the reads cannot say (the caller changes nothing). */
export async function loadSenderContexts(db: SupabaseClient, args: { actorUserId: string; fromPhone: string }): Promise<SenderContext[] | null> {
  const memberships = await listLineMemberships(db, args.actorUserId, { kinds: ["owner", "teammate"] }).catch(() => null);
  if (!memberships) return null;
  const isAdmin = await holdsAdminRole(db, args.actorUserId).catch(() => false);
  const serviceRefs = isAdmin ? await listServiceWorkspaceRefs(db).catch(() => null) : null;

  const out: SenderContext[] = [];
  for (const m of memberships) {
    // A platform admin reaches every PropLane-managed workspace through the admin context, never as a manager of it.
    if (m.isService && isAdmin && serviceRefs) continue;
    // The client owner of a managed workspace is a person writing to PropLane's staff, not a manager (`handleOwnerLine`).
    if (m.isService && m.kind === "owner") continue;
    out.push({
      kind: "manager",
      key: `manager:${m.workspaceId}`,
      workspaceId: m.workspaceId,
      ownerUserId: m.ownerUserId,
      name: m.workspaceName,
      isDefault: m.isDefault,
      isService: m.isService,
      basis: m.kind === "owner" ? "owner" : "seat",
      viewerSeat: m.teamRole === "viewer",
    });
  }
  if (isAdmin && serviceRefs && serviceRefs.length > 0) out.push({ kind: "admin", key: "admin", workspaces: serviceRefs });

  // A residency counts only for the account whose VERIFIED, unique phone this is (never an address or a name).
  const profile = await findVerifiedProfileByPhone(db, args.fromPhone).catch(() => null);
  if (profile && profile.id === args.actorUserId) {
    const residencies = await findResidentCandidates(db, args.fromPhone).catch(() => []);
    const seen = new Set<string>();
    for (const r of residencies) {
      const key = `resident:${r.workspaceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: "resident", key, workspaceId: r.workspaceId, ownerUserId: r.ownerUserId, propertyId: r.propertyId, label: r.label });
    }
  }
  return out;
}

/** The homes in the sender's contexts, each tagged with the target a text naming it resolves to. */
export async function loadSenderHomes(db: SupabaseClient, contexts: readonly SenderContext[]): Promise<SenderHome[]> {
  const homes: SenderHome[] = [];
  const byWorkspace = new Map<string, SenderTarget>();
  const defaultOf = new Map<string, string>();
  for (const c of contexts) {
    if (c.kind === "manager") {
      byWorkspace.set(c.workspaceId, { key: c.key });
      if (c.isDefault) defaultOf.set(c.ownerUserId, c.workspaceId);
    } else if (c.kind === "admin") {
      for (const ws of c.workspaces) {
        byWorkspace.set(ws.id, { key: "admin", workspaceId: ws.id });
        if (ws.isDefault) defaultOf.set(ws.ownerUserId, ws.id);
      }
    } else {
      homes.push({ id: c.key, address: c.label, title: c.label, buildingName: "", neighborhood: "", target: { key: c.key } });
    }
  }
  const owners = [
    ...new Set(contexts.flatMap((c) => (c.kind === "manager" ? [c.ownerUserId] : c.kind === "admin" ? c.workspaces.map((w) => w.ownerUserId) : []))),
  ];
  if (owners.length === 0) return homes;
  // Only the naming facts, projected out of the jsonb: these rows carry whole listing submissions and this read runs
  // on nearly every inbound text from a multi-context sender (AGENTS.md § Performance & egress).
  const { data, error } = await db
    .from("manager_property_records")
    .select(
      [
        "id",
        "manager_user_id",
        "workspace_id",
        "pd_status:property_data->>status",
        "rd_status:row_data->>status",
        "pd_address:property_data->>address",
        "rd_address:row_data->>address",
        "pd_street:property_data->>streetAddress",
        "rd_street:row_data->>streetAddress",
        "pd_title:property_data->>title",
        "rd_title:row_data->>title",
        "pd_building:property_data->>buildingName",
        "rd_building:row_data->>buildingName",
        "pd_hood:property_data->>neighborhood",
        "rd_hood:row_data->>neighborhood",
      ].join(","),
    )
    .in("manager_user_id", owners)
    .limit(3000);
  if (error) throw new Error("homes unreadable");
  for (const rec of (data ?? []) as unknown as Row[]) {
    const ws = str(rec.workspace_id) || defaultOf.get(str(rec.manager_user_id)) || "";
    const target = byWorkspace.get(ws);
    if (!target) continue;
    if (str(rec.pd_status) === "draft" || str(rec.rd_status) === "draft") continue;
    const pick = (pd: unknown, rd: unknown): string => str(pd) || str(rd);
    const address = pick(rec.pd_address, rec.rd_address) || pick(rec.pd_street, rec.rd_street) || pick(rec.pd_title, rec.rd_title);
    if (!address) continue;
    homes.push({
      id: str(rec.id),
      address,
      title: pick(rec.pd_title, rec.rd_title),
      buildingName: pick(rec.pd_building, rec.rd_building),
      neighborhood: pick(rec.pd_hood, rec.rd_hood),
      target,
    });
  }
  return homes;
}

const ACCEPTED = ["queued", "claimed", "deferred", "submitting", "submitted", "sent", "delivered", "unknown"];

/** The workspace of the newest text we sent this phone (an Assistant notice, an agent reply), and when. */
async function loadLastNotice(db: SupabaseClient, fromPhone: string): Promise<{ workspaceId: string; at: number } | null> {
  const e164 = normalizeE164(fromPhone) ?? fromPhone;
  const { data, error } = await db
    .from("sms_outbox")
    .select("workspace_id, created_at")
    .eq("recipient_phone", e164)
    .not("workspace_id", "is", null)
    // An agent's reply to one of their own texts is not a notice: only what we sent unprompted counts.
    .or("dedupe_key.is.null,dedupe_key.not.like.inbound_reply_%")
    .in("status", ACCEPTED)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return null;
  const row = ((data ?? []) as Row[])[0];
  const at = row ? Date.parse(str(row.created_at)) : NaN;
  return row && str(row.workspace_id) && Number.isFinite(at) ? { workspaceId: str(row.workspace_id), at } : null;
}

async function readRow(db: SupabaseClient, phoneKey: string): Promise<{ data: Row; at: number } | null> {
  try {
    const { data, error } = await db.from("sms_line_sessions").select("pending_candidates, pending_asked_at").eq("phone_key", phoneKey).maybeSingle();
    if (error || !data) return null;
    const row = data as Row;
    const at = row.pending_asked_at ? Date.parse(str(row.pending_asked_at)) : NaN;
    return Number.isFinite(at) ? { data: obj(row.pending_candidates), at } : null;
  } catch {
    return null;
  }
}

async function writeRow(db: SupabaseClient, phoneKey: string, value: Row): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await db
    .from("sms_line_sessions")
    .upsert({ phone_key: phoneKey, pending_candidates: value, pending_asked_at: now, last_inbound_at: now, updated_at: now }, { onConflict: "phone_key" });
  if (error) console.error("sender context state save failed", error.code ?? "unknown");
}

const targetOf = (value: unknown): SenderTarget | null => {
  const v = obj(value);
  return str(v.key) ? { key: str(v.key), workspaceId: str(v.workspaceId) || null } : null;
};

async function loadSticky(db: SupabaseClient, phone: string): Promise<SenderSticky | null> {
  const row = await readRow(db, stickyKey(phone));
  const target = row ? targetOf(row.data) : null;
  if (!row || !target) return null;
  const explicitAt = row.data.explicitAt;
  return { target, at: row.at, explicitAt: typeof explicitAt === "number" && Number.isFinite(explicitAt) ? explicitAt : undefined };
}

async function loadPending(db: SupabaseClient, phone: string): Promise<SenderPending | null> {
  const row = await readRow(db, questionKey(phone));
  if (!row) return null;
  const options = Array.isArray(row.data.options) ? (row.data.options.map(targetOf).filter(Boolean) as SenderTarget[]) : [];
  return options.length ? { options, body: str(row.data.body), messageSid: str(row.data.messageSid), at: row.at } : null;
}

const clear = (db: SupabaseClient, key: string) => db.from("sms_line_sessions").delete().eq("phone_key", key).then(() => undefined, () => undefined);

/**
 * Decide, persist, and tell the pipeline what to do. `numberWorkspaceId` is the workspace whose OWN work number the text
 * arrived on (null on the PropLane line, which belongs to no sender). Never throws: any failure is `unchanged`.
 */
export async function resolveSenderContext(
  db: SupabaseClient,
  args: { actorUserId: string; fromPhone: string; body: string; messageSid: string; numberWorkspaceId: string | null },
): Promise<SenderContextOutcome> {
  try {
    const contexts = await loadSenderContexts(db, args);
    if (!contexts || contexts.length < 2) return { kind: "unchanged" };
    const [sticky, pending] = await Promise.all([loadSticky(db, args.fromPhone), loadPending(db, args.fromPhone)]);
    let homes: Promise<readonly SenderHome[]> | null = null;
    const numberDefault: SenderTarget | null = (() => {
      if (!args.numberWorkspaceId) return null;
      const own = contexts.find((c) => c.kind === "manager" && c.workspaceId === args.numberWorkspaceId);
      if (own) return { key: own.key };
      const admin = contexts.find((c) => c.kind === "admin");
      return admin && admin.kind === "admin" && admin.workspaces.some((w) => w.id === args.numberWorkspaceId)
        ? { key: "admin", workspaceId: args.numberWorkspaceId }
        : null;
    })();
    const decision = await decideSenderContext({
      body: args.body,
      messageSid: args.messageSid,
      contexts,
      sticky,
      pending,
      numberDefault,
      now: Date.now(),
      loadHomes: () => (homes ??= loadSenderHomes(db, contexts)),
      loadNotice: () => loadLastNotice(db, args.fromPhone),
    });
    if (decision.kind === "unchanged") return { kind: "unchanged" };
    if (decision.kind === "reply") {
      if (decision.pending) await writeRow(db, questionKey(args.fromPhone), decision.pending);
      else await clear(db, questionKey(args.fromPhone));
      // The only replies that carry a pick are the ones the sender asked for (a bare switch, the menu's answer), so
      // the pick is theirs: it holds for its window even on a workspace's own work number.
      if (decision.sticky) {
        await writeRow(db, stickyKey(args.fromPhone), { key: decision.sticky.key, workspaceId: decision.sticky.workspaceId ?? null, explicitAt: Date.now() });
      }
      return { kind: "reply", text: decision.text };
    }
    const resolved = resolveSenderTarget(contexts, decision.target);
    if (!resolved) return { kind: "unchanged" };
    await clear(db, questionKey(args.fromPhone));
    // Switch words and the answer to our question are the sender's own pick. Any other turn that lands on the context
    // that pick NAMED is still inside the one request they opened, so it carries the ORIGINAL moment forward - the
    // window runs from the pick, never from the last text. A turn on a different context ends the pick.
    const explicitAt =
      decision.source === "switch" || decision.source === "answer"
        ? Date.now()
        : sameTarget(sticky?.target ?? null, decision.target)
          ? sticky?.explicitAt ?? null
          : null;
    await writeRow(db, stickyKey(args.fromPhone), { key: decision.target.key, workspaceId: decision.target.workspaceId ?? null, explicitAt });
    return { kind: "run", body: decision.body, tag: decision.tag, resolved, source: decision.source };
  } catch (error) {
    console.error("sender context unresolved", error instanceof Error ? error.name : "unknown");
    return { kind: "unchanged" };
  }
}
