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
 * never disagree. A read that fails is treated as blocking (fail closed) wherever a decision rides
 * on it; a missing table means the feature is not set up in this environment, which blocks nothing.
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
  const expanded = new Set<string>();
  for (const id of ids ?? []) {
    for (const variant of proplaneIdLookupVariants(typeof id === "string" ? id : "")) {
      if (variant.trim()) expanded.add(variant.trim());
    }
  }
  const patterns = [...expanded];
  return { patterns, keys: new Set(patterns.map(applicationIdKey)) };
}

/** A case-insensitive match on any id in the scope, as one PostgREST logical term. */
function applicationIdMatchTerm(patterns: readonly string[]): string {
  const terms = patterns.map((id) => `application_id.ilike.${quoteFilterValue(literalPattern(id))}`);
  return terms.length === 1 ? terms[0]! : `or(${terms.join(",")})`;
}

function tableMissing(error: { code?: string; message?: string }): boolean {
  const message = (error.message ?? "").toLowerCase();
  return error.code === "PGRST205" || error.code === "42P01" || message.includes("schema cache") || (message.includes("relation") && message.includes("does not exist"));
}

const SELECT = "id, form_id, status, sent_at, snapshot, resident_user_id, application_id";
/** The same read plus the two columns a caller-scope test needs. */
const SCOPED_SELECT = `${SELECT}, manager_user_id, property_id`;

/** The two facts that say whose a sent form is. */
export type BlockingFormOwnership = { manager_user_id: string | null; property_id: string | null };

/**
 * The application ids a lease row belongs to (its primary application and every joint member's), for
 * `loadResidentBlockingForms({ applicationIds })`. The forms read is already pinned to the signing
 * resident's own user id, so another member's id can only ever match that resident's own copies.
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
 * A resident's blocking forms use their authenticated user id. Manager approval callers without a
 * user id retain the historical email lookup. `propertyId` narrows to one house; omitted = every house.
 *
 * A block is a RESTRICTION, so the subject test fails closed — but only within an exact scope the
 * caller already authorized. A `sent` form still waiting for its application's subject to be proven
 * (`resident_user_id` null) blocks when it belongs to one of the `applicationIds` this request is
 * about (the lease being signed and its joint members), never because an address matches: an
 * address is not proof of control, and `profiles.email` is not even mailbox proof. Without
 * `applicationIds` no unbound row is considered at all. Such a row is never named in `formIds`: the
 * resident cannot open it until the setup invitation binds it, so pointing at it would be a dead end.
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
     * Every spelling of the application ids the lease in question belongs to. With `propertyId`, a form
     * counts when it is for that property OR is tied to one of these applications, so a lease row whose
     * stored property id is stale or mismatched can never open the gate for a form that is plainly
     * this resident's for this lease.
     */
    applicationIds?: readonly string[];
    callerHolds?: (form: BlockingFormOwnership) => Promise<boolean>;
  },
): Promise<BlockingFormsPending> {
  const email = who.email.trim().toLowerCase();
  if (!who.userId && !email) return NO_BLOCKING_FORMS;
  try {
    const scope = applicationIdScope(who.applicationIds);
    // With application ids the property narrowing moves in memory: it is an OR with the application match.
    const orScope = Boolean(who.propertyId) && scope.patterns.length > 0;
    let query = db.from("resident_move_in_forms").select(who.callerHolds || orScope ? SCOPED_SELECT : SELECT).eq("status", "sent");
    query = who.userId
      ? scope.patterns.length
        ? query.or(`resident_user_id.eq.${who.userId},and(resident_user_id.is.null,${applicationIdMatchTerm(scope.patterns)})`)
        : query.eq("resident_user_id", who.userId)
      : query.eq("resident_email", email);
    if (who.propertyId && !orScope) query = query.eq("property_id", who.propertyId);
    const { data, error } = await query;
    if (error) return tableMissing(error) ? NO_BLOCKING_FORMS : BLOCKING_FORMS_FAIL_CLOSED;
    let rows = ((data ?? []) as unknown as Array<BlockingRow & { resident_user_id?: string | null; manager_user_id?: string | null; property_id?: string | null; application_id?: string | null }>)
      .filter((row) => !who.userId
        || row.resident_user_id === who.userId
        || (!row.resident_user_id && scope.keys.has(applicationIdKey(row.application_id))))
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
 * The applications whose stored subject IS this login, which is the only scope that can claim an
 * unbound form for a resident without reading an address. `null` means the read failed, which every
 * caller turns into a refusal rather than an empty scope.
 */
async function subjectBoundApplicationIds(db: SupabaseClient, userId: string): Promise<string[] | null> {
  const { data, error } = await db
    .from("manager_application_records")
    .select("id, row_id:row_data->>id")
    .eq("row_data->>residentUserId", userId);
  if (error) return null;
  const ids = new Set<string>();
  for (const row of (data ?? []) as { id?: unknown; row_id?: unknown }[]) {
    for (const value of [row.id, row.row_id]) {
      const id = String(value ?? "").trim();
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * Both forms facts the resident portal's access state needs, from ONE read of the resident's
 * non-cancelled copies: whether a form has ever been sent to them at all, and what their unsubmitted
 * ones block. `blockingFormsFromRows` counts only the `sent` rows, so one select answers both and the
 * resident hot path never queries this table twice. A failed read blocks (fail closed) and reports
 * `hasForms: false` — a form nobody can read must not also unlock a nav row.
 *
 * `blocking.moveInDetails` is what every move-in-details redaction keys on, so the unbound rows
 * count here too — within an exact scope, never by address: a `sent` form with no subject yet blocks
 * when it sits on an application whose STORED subject is this login. An unbound row never sets
 * `hasForms` and is never named: the resident still cannot open it until the setup invitation binds
 * it, so it restricts without unlocking a nav row or pointing at a dead end. The subject-scope read
 * failing is a refusal, not an empty scope.
 */
export async function loadResidentFormsFacts(
  db: SupabaseClient,
  who: { email: string; userId?: string | null },
): Promise<{ hasForms: boolean; blocking: BlockingFormsPending }> {
  if (!who.userId) return { hasForms: false, blocking: NO_BLOCKING_FORMS };
  try {
    const boundApplicationIds = await subjectBoundApplicationIds(db, who.userId);
    if (boundApplicationIds === null) return { hasForms: false, blocking: BLOCKING_FORMS_FAIL_CLOSED };
    const scope = applicationIdScope(boundApplicationIds);
    let query = db.from("resident_move_in_forms").select(FACTS_SELECT).neq("status", "cancelled");
    query = scope.patterns.length
      ? query.or(`resident_user_id.eq.${who.userId},and(resident_user_id.is.null,${applicationIdMatchTerm(scope.patterns)})`)
      : query.eq("resident_user_id", who.userId);
    const { data, error } = await query;
    if (error) {
      return { hasForms: false, blocking: tableMissing(error) ? NO_BLOCKING_FORMS : BLOCKING_FORMS_FAIL_CLOSED };
    }
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
    if (error) return tableMissing(error) ? NO_BLOCKING_FORMS : BLOCKING_FORMS_FAIL_CLOSED;
    return blockingFormsFromRows((data ?? []) as BlockingRow[]);
  } catch {
    return BLOCKING_FORMS_FAIL_CLOSED;
  }
}
