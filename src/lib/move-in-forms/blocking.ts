/**
 * What a resident still owes, from their unsubmitted ("sent") move-in forms. Each form carries a
 * `blocks` value on its snapshot (copied from the template when it was sent; absent = its kind's
 * default, so every intake form written before this existed keeps blocking Move-in details):
 *
 *  - `move_in_details`: the resident's Move-in details tab is locked until it is submitted;
 *  - `lease_signing`:   the resident's lease signature is refused (409);
 *  - `approval`:        the manager's Approve of that application is refused (409).
 *
 * Only a `sent` copy blocks: a submitted or cancelled one never does. The readers below are the one
 * place that rule lives, so the resident access state, the lease route and the approve route can
 * never disagree.
 *
 * ONE error rule, for every reader here: a read that does not come back blocks. That includes a
 * missing or schema-cache-stale table — this table ships with the move-in form migrations, so an
 * unreadable one is an outage, not an environment without the feature, and an unreadable gate is a
 * locked gate.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { proplaneIdLookupVariants } from "@/lib/manager-id";
import { moveInFormDefaultKindOfId } from "./templates";
import { resolveMoveInFormBlocks, type MoveInFormBlocks, type MoveInFormKind } from "./types";

export type BlockingFormsPending = {
  moveInDetails: boolean;
  leaseSigning: boolean;
  approval: boolean;
  /**
   * The read itself failed, so every block is on without a form behind any of them. Still a refusal
   * (fail closed), but a retryable one: a caller must say "could not check", never name a form the
   * manager or resident would then go looking for.
   */
  readFailed?: boolean;
  /** The first (oldest) blocking form per kind of block, so a lock can link to the form that unlocks it. */
  formIds?: Partial<Record<"moveInDetails" | "leaseSigning" | "approval", string>>;
};

export const NO_BLOCKING_FORMS: BlockingFormsPending = { moveInDetails: false, leaseSigning: false, approval: false };

export const BLOCKING_FORMS_FAIL_CLOSED: BlockingFormsPending = { moveInDetails: true, leaseSigning: true, approval: true, readFailed: true };

export const FINISH_FORMS_FIRST_MESSAGE = "Finish your forms first. A form your manager sent has to be submitted before you can sign.";
export const APPROVAL_BLOCKED_BY_FORM_MESSAGE = "A form sent to this applicant has to be submitted before you can approve the application.";
/** The read failed: nothing is known, so nothing is named. Both sides of a 503 say "try again". */
export const APPROVAL_FORMS_CHECK_FAILED_MESSAGE = "Could not check this applicant's forms — try again.";
export const RESIDENT_FORMS_CHECK_FAILED_MESSAGE = "Could not check your forms — try again.";

type BlockingRow = {
  id: string;
  form_id?: string | null;
  status: string;
  sent_at?: string | null;
  snapshot?: { kind?: MoveInFormKind; blocks?: unknown } | null;
  /**
   * False for a row counted only because it has no bound Auth subject yet. It still blocks — a
   * restriction never fails open — but it is never named back to the viewer, who cannot open it.
   */
  nameable?: boolean;
};

const KEY_OF: Record<Exclude<MoveInFormBlocks, "nothing">, "moveInDetails" | "leaseSigning" | "approval"> = {
  move_in_details: "moveInDetails",
  lease_signing: "leaseSigning",
  approval: "approval",
};

/** The `blocks` a stored row carries: its snapshot's value, else the default of its kind. */
export function blocksOfRow(row: Pick<BlockingRow, "form_id" | "snapshot">): MoveInFormBlocks {
  const kind = row.snapshot?.kind ?? (row.form_id ? moveInFormDefaultKindOfId(row.form_id) : null) ?? "other";
  return resolveMoveInFormBlocks(row.snapshot?.blocks, kind);
}

/** Pure: which blocks a resident's rows add up to. Only `sent` rows count. */
export function blockingFormsFromRows(rows: readonly BlockingRow[]): BlockingFormsPending {
  const sent = rows.filter((row) => row.status === "sent").sort((a, b) => (a.sent_at ?? "").localeCompare(b.sent_at ?? ""));
  const out: BlockingFormsPending = { moveInDetails: false, leaseSigning: false, approval: false, formIds: {} };
  for (const row of sent) {
    const blocks = blocksOfRow(row);
    if (blocks === "nothing") continue;
    const key = KEY_OF[blocks];
    out[key] = true;
    if (row.nameable !== false && !out.formIds![key]) out.formIds![key] = row.id;
  }
  return out;
}

/** PostgREST `or=` values are comma- and paren-delimited; a quoted value keeps an id literal. */
function quoteFilterValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** `%`, `_` and the escape character itself, so an id carrying one cannot widen an `ilike`. */
function literalPattern(value: string): string {
  return value.replace(/[\\%_]/g, "\\$&");
}

/** The one normalized form every application-id comparison in this file compares on. */
function applicationIdKey(value: unknown): string {
  return String(value ?? "").trim().toUpperCase();
}

/**
 * One application-id scope for both halves of a read: the PostgREST filter that pulls the rows and
 * the in-memory test that keeps them. They must describe the SAME set — the filter is what actually
 * fetches an unbound row, so a filter narrower than the test silently turns a restriction into a
 * fail-open. `application_id` holds whatever spelling its row carried (`AXIS-` or `PROPLANE-`, in
 * either case: `normalizeApplicationAxisId` preserves it), so the ids are expanded through
 * `proplaneIdLookupVariants` and matched case-insensitively with `ilike` rather than exact `in`.
 */
function applicationIdScope(ids: readonly string[] | undefined): { patterns: string[]; keys: Set<string> } {
  // Keyed on the normalized form the `ilike` itself matches on, so two spellings of one id do not
  // become two identical (non-indexable) terms in the filter.
  const byKey = new Map<string, string>();
  for (const id of ids ?? []) {
    for (const variant of proplaneIdLookupVariants(typeof id === "string" ? id : "")) {
      const trimmed = variant.trim();
      if (trimmed && !byKey.has(applicationIdKey(trimmed))) byKey.set(applicationIdKey(trimmed), trimmed);
    }
  }
  return { patterns: [...byKey.values()], keys: new Set(byKey.keys()) };
}

/** A case-insensitive match on any id in the scope, as one PostgREST logical term. */
function applicationIdMatchTerm(patterns: readonly string[]): string {
  const terms = patterns.map((id) => `application_id.ilike.${quoteFilterValue(literalPattern(id))}`);
  return terms.length === 1 ? terms[0]! : `or(${terms.join(",")})`;
}

const SELECT = "id, form_id, status, sent_at, snapshot, resident_user_id, application_id";
/** The same read plus the two columns a caller-scope test needs. */
const SCOPED_SELECT = `${SELECT}, manager_user_id, property_id`;

/** The two facts that say whose a sent form is. */
export type BlockingFormOwnership = { manager_user_id: string | null; property_id: string | null };

/**
 * The application ids a lease row belongs to (its primary application and every joint member's), for
 * `loadResidentBlockingForms({ applicationIds })`. Every row this admits is still pinned to the
 * signing resident's own user id, so another member's id can only ever match that resident's own
 * copies. An UNBOUND row carries no subject to pin, so it is scoped by `leaseOwnApplicationIds`
 * instead — never by this list.
 */
export function leaseApplicationIds(row: {
  axisId?: string | null;
  jointLeaseMembers?: ReadonlyArray<{ applicationId?: string | null }> | null;
} | null | undefined): string[] {
  if (!row) return [];
  const ids = [row.axisId, ...(Array.isArray(row.jointLeaseMembers) ? row.jointLeaseMembers.map((member) => member?.applicationId) : [])];
  return [...new Set(ids.map((id) => (typeof id === "string" ? id.trim() : "")).filter(Boolean))];
}

/**
 * The ONE application a lease row names for this login: its primary `axisId`, and only when the
 * row's own stored subject IS that login. This is the only lease-side id an unbound form may be
 * scoped by. A joint member's application never qualifies: an unbound form on it is a form only the
 * co-applicant can submit and that nobody can even name back (an unbound row is never `nameable`),
 * so gating this resident on it would be a refusal they have no way to clear.
 */
export function leaseOwnApplicationIds(
  lease: { residentUserId?: string | null; axisId?: string | null } | null | undefined,
  viewerUserId: string | null | undefined,
): string[] {
  const viewer = (viewerUserId ?? "").trim();
  const owner = (lease?.residentUserId ?? "").trim();
  if (!viewer || owner !== viewer) return [];
  const id = typeof lease?.axisId === "string" ? lease.axisId.trim() : "";
  return id ? [id] : [];
}

/**
 * A resident's blocking forms use their authenticated user id. Manager approval callers without a
 * user id retain the historical email lookup. `propertyId` narrows to one house; omitted = every house.
 *
 * A block is a RESTRICTION, so the subject test fails closed — but only within an exact scope the
 * caller already authorized. A `sent` form still waiting for its application's subject to be proven
 * (`resident_user_id` null) blocks when it belongs to one of the `ownApplicationIds` — the
 * applications THIS login is itself tied to — never because an address matches (an address is not
 * proof of control, and `profiles.email` is not even mailbox proof) and never because a co-applicant
 * on the same lease is tied to it. Without `ownApplicationIds` no unbound row is considered at all.
 * Such a row is never named in `formIds`: the resident cannot open it until the setup invitation
 * binds it, so pointing at it would be a dead end.
 *
 * `callerHolds` is for a MANAGER asking about someone else's resident: only forms the caller may judge
 * by count, so another landlord's form neither blocks this manager nor reveals itself. A predicate
 * that throws fails closed like a failed read.
 */
export async function loadResidentBlockingForms(
  db: SupabaseClient,
  who: {
    email: string;
    userId?: string | null;
    propertyId?: string | null;
    /**
     * Every application the lease in question belongs to, its joint members included. With
     * `propertyId`, a form counts when it is for that property OR is tied to one of these
     * applications, so a lease row whose stored property id is stale or mismatched can never open
     * the gate for a form that is plainly this resident's for this lease. Every row this admits is
     * still pinned to `userId`.
     */
    applicationIds?: readonly string[];
    /**
     * The applications this login is itself tied to (`leaseOwnApplicationIds`). An UNBOUND row has
     * no subject to pin, so this — never `applicationIds` — is the only scope that admits one.
     */
    ownApplicationIds?: readonly string[];
    callerHolds?: (form: BlockingFormOwnership) => Promise<boolean>;
  },
): Promise<BlockingFormsPending> {
  const email = who.email.trim().toLowerCase();
  if (!who.userId && !email) return NO_BLOCKING_FORMS;
  try {
    const scope = applicationIdScope(who.applicationIds);
    const ownScope = applicationIdScope(who.ownApplicationIds);
    // With application ids the property narrowing moves in memory: it is an OR with the application match.
    const orScope = Boolean(who.propertyId) && scope.patterns.length > 0;
    let query = db.from("resident_move_in_forms").select(who.callerHolds || orScope ? SCOPED_SELECT : SELECT).eq("status", "sent");
    query = who.userId
      ? ownScope.patterns.length
        ? query.or(`resident_user_id.eq.${who.userId},and(resident_user_id.is.null,${applicationIdMatchTerm(ownScope.patterns)})`)
        : query.eq("resident_user_id", who.userId)
      : query.eq("resident_email", email);
    if (who.propertyId && !orScope) query = query.eq("property_id", who.propertyId);
    const { data, error } = await query;
    if (error) return BLOCKING_FORMS_FAIL_CLOSED;
    let rows = ((data ?? []) as unknown as Array<BlockingRow & { resident_user_id?: string | null; manager_user_id?: string | null; property_id?: string | null; application_id?: string | null }>)
      .filter((row) => !who.userId
        || row.resident_user_id === who.userId
        || (!row.resident_user_id && ownScope.keys.has(applicationIdKey(row.application_id))))
      .map((row) => (who.userId && !row.resident_user_id ? { ...row, nameable: false } : row));
    if (orScope) {
      rows = rows.filter((row) => row.property_id === who.propertyId || scope.keys.has(applicationIdKey(row.application_id)));
    }
    if (who.callerHolds) {
      // Concurrently: the predicate shares one request-scoped memo of the caller's property scope, so a
      // resident with several forms costs one round of checks rather than one per row.
      const holds = await Promise.all(
        rows.map((row) => who.callerHolds!({ manager_user_id: row.manager_user_id ?? null, property_id: row.property_id ?? null })),
      );
      rows = rows.filter((_, index) => holds[index]);
    }
    return blockingFormsFromRows(rows);
  } catch {
    return BLOCKING_FORMS_FAIL_CLOSED;
  }
}

/**
 * The columns the facts read needs, and nothing more: the two snapshot keys a block is derived from are
 * projected out of the jsonb rather than dragging every form's questions and PDF metadata onto the
 * resident's hot path (AGENTS.md § Performance & egress).
 */
const FACTS_SELECT = "id, form_id, status, sent_at, resident_user_id, application_id, snapshot_kind:snapshot->>kind, snapshot_blocks:snapshot->>blocks";

type FormsFactsRow = {
  id: string;
  form_id?: string | null;
  status: string;
  sent_at?: string | null;
  resident_user_id?: string | null;
  application_id?: string | null;
  snapshot_kind?: string | null;
  snapshot_blocks?: string | null;
};

function factsRowAsBlockingRow(row: FormsFactsRow, nameable = true): BlockingRow {
  return {
    id: row.id,
    form_id: row.form_id,
    status: row.status,
    sent_at: row.sent_at,
    snapshot: { kind: (row.snapshot_kind ?? undefined) as MoveInFormKind | undefined, blocks: row.snapshot_blocks ?? undefined },
    nameable,
  };
}

/**
 * Every application this login is bound to by a STORED subject, and nothing else: the application
 * rows whose own `row_data.residentUserId` is this login, plus the primary application of a lease
 * row whose `resident_user_id` is this login. The second arm is what reaches the real cohort — a
 * form is unbound only because its application was unbound when it was sent, so an
 * application-subject-only scope excludes that cohort by construction, while the signed lease the
 * same resident holds still names it. No address is read on either arm, and no joint member's
 * application is: an unbound form on a co-applicant's application is one only they can submit.
 *
 * `null` means a read failed; every caller turns that into a refusal, never an empty scope.
 */
export async function residentBoundApplicationIds(db: SupabaseClient, userId: string): Promise<string[] | null> {
  const uid = userId.trim();
  if (!uid) return [];
  const [applications, leases] = await Promise.all([
    db.from("manager_application_records").select("id, row_id:row_data->>id").eq("row_data->>residentUserId", uid),
    db.from("portal_lease_pipeline_records").select("row_data").eq("resident_user_id", uid),
  ]);
  if (applications.error || leases.error) return null;
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = String(value ?? "").trim();
    if (id) ids.add(id);
  };
  for (const row of (applications.data ?? []) as { id?: unknown; row_id?: unknown }[]) {
    add(row.id);
    add(row.row_id);
  }
  // Already pinned to this login by the query, so the row's own primary application is this
  // resident's. A joint member's is deliberately left out: see `leaseOwnApplicationIds`.
  for (const row of (leases.data ?? []) as { row_data?: { axisId?: unknown } | null }[]) {
    add(row.row_data?.axisId);
  }
  return [...ids];
}

/**
 * Both forms facts the resident portal's access state needs, from ONE read of the resident's
 * non-cancelled copies: whether a form has ever been sent to them at all, and what their unsubmitted
 * ones block. `blockingFormsFromRows` counts only the `sent` rows, so one select answers both and the
 * resident hot path never queries this table twice.
 *
 * `blocking.moveInDetails` is what every move-in-details redaction keys on, so the unbound rows
 * count here too — within an exact scope, never by address: a `sent` form with no subject yet blocks
 * when it sits on an application this login is bound to (`residentBoundApplicationIds`). An unbound
 * row never sets `hasForms` and is never named: the resident still cannot open it until the setup
 * invitation binds it, so it restricts without unlocking a nav row or pointing at a dead end.
 *
 * `boundApplicationIds` lets a caller that has already read that scope hand it over rather than pay
 * for the unindexed `row_data->>residentUserId` scan twice in one request; `null` says that caller's
 * own read failed. EVERY read behind this answer fails CLOSED, the module's one error rule.
 */
export async function loadResidentFormsFacts(
  db: SupabaseClient,
  who: { email: string; userId?: string | null; boundApplicationIds?: readonly string[] | null },
): Promise<{ hasForms: boolean; blocking: BlockingFormsPending }> {
  if (!who.userId) return { hasForms: false, blocking: NO_BLOCKING_FORMS };
  try {
    const boundApplicationIds = who.boundApplicationIds === undefined
      ? await residentBoundApplicationIds(db, who.userId)
      : who.boundApplicationIds;
    if (boundApplicationIds === null) return { hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED };
    const scope = applicationIdScope(boundApplicationIds);
    let query = db.from("resident_move_in_forms").select(FACTS_SELECT).neq("status", "cancelled");
    query = scope.patterns.length
      ? query.or(`resident_user_id.eq.${who.userId},and(resident_user_id.is.null,${applicationIdMatchTerm(scope.patterns)})`)
      : query.eq("resident_user_id", who.userId);
    const { data, error } = await query;
    if (error) return { hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED };
    const all = (data ?? []) as FormsFactsRow[];
    const bound = all.filter((row) => row.resident_user_id === who.userId);
    const unbound = all.filter((row) => !row.resident_user_id && scope.keys.has(applicationIdKey(row.application_id)));
    const rows = [...bound.map((row) => factsRowAsBlockingRow(row)), ...unbound.map((row) => factsRowAsBlockingRow(row, false))];
    return { hasForms: bound.length > 0, blocking: blockingFormsFromRows(rows) };
  } catch {
    return { hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED };
  }
}

/**
 * An application's blocking forms (the manager's Approve): sent copies tied to that application id.
 * Pass every spelling of the id (`AXIS-` / `PROPLANE-` prefixes): the column holds whichever the row carried.
 */
export async function loadApplicationBlockingForms(db: SupabaseClient, applicationIds: string | readonly string[]): Promise<BlockingFormsPending> {
  const ids = [...new Set((Array.isArray(applicationIds) ? applicationIds : [applicationIds as string]).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return NO_BLOCKING_FORMS;
  try {
    const { data, error } = await db.from("resident_move_in_forms").select(SELECT).in("application_id", ids).eq("status", "sent");
    if (error) return BLOCKING_FORMS_FAIL_CLOSED;
    return blockingFormsFromRows((data ?? []) as BlockingRow[]);
  } catch {
    return BLOCKING_FORMS_FAIL_CLOSED;
  }
}
