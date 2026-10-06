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
    if (!out.formIds![key]) out.formIds![key] = row.id;
  }
  return out;
}

function tableMissing(error: { code?: string; message?: string }): boolean {
  const message = (error.message ?? "").toLowerCase();
  return error.code === "PGRST205" || error.code === "42P01" || message.includes("schema cache") || (message.includes("relation") && message.includes("does not exist"));
}

const SELECT = "id, form_id, status, sent_at, snapshot, resident_user_id";

/**
 * A resident's blocking forms: their own sent copies by login email (and login, when the copy is tied
 * to one). `propertyId` narrows to one house (a lease is for one property); omitted = every house.
 */
export async function loadResidentBlockingForms(
  db: SupabaseClient,
  who: { email: string; userId?: string | null; propertyId?: string | null },
): Promise<BlockingFormsPending> {
  const email = who.email.trim().toLowerCase();
  if (!email) return NO_BLOCKING_FORMS;
  try {
    let query = db.from("resident_move_in_forms").select(SELECT).eq("resident_email", email).eq("status", "sent");
    if (who.propertyId) query = query.eq("property_id", who.propertyId);
    const { data, error } = await query;
    if (error) return tableMissing(error) ? NO_BLOCKING_FORMS : BLOCKING_FORMS_FAIL_CLOSED;
    const rows = ((data ?? []) as Array<BlockingRow & { resident_user_id?: string | null }>).filter(
      (row) => !row.resident_user_id || !who.userId || row.resident_user_id === who.userId,
    );
    return blockingFormsFromRows(rows);
  } catch {
    return BLOCKING_FORMS_FAIL_CLOSED;
  }
}

/**
 * Both forms facts the resident portal's access state needs, from ONE read of the resident's
 * non-cancelled copies: whether a form has ever been sent to them at all, and what their unsubmitted
 * ones block. `blockingFormsFromRows` counts only the `sent` rows, so one select answers both and the
 * resident hot path never queries this table twice. A failed read blocks (fail closed) and reports
 * `hasForms: false` — a form nobody can read must not also unlock a nav row.
 */
export async function loadResidentFormsFacts(
  db: SupabaseClient,
  who: { email: string; userId?: string | null },
): Promise<{ hasForms: boolean; blocking: BlockingFormsPending }> {
  const email = who.email.trim().toLowerCase();
  if (!email) return { hasForms: false, blocking: NO_BLOCKING_FORMS };
  try {
    const { data, error } = await db
      .from("resident_move_in_forms")
      .select(SELECT)
      .eq("resident_email", email)
      .neq("status", "cancelled");
    if (error) {
      return { hasForms: false, blocking: tableMissing(error) ? NO_BLOCKING_FORMS : BLOCKING_FORMS_FAIL_CLOSED };
    }
    const rows = ((data ?? []) as Array<BlockingRow & { resident_user_id?: string | null }>).filter(
      (row) => !row.resident_user_id || !who.userId || row.resident_user_id === who.userId,
    );
    return { hasForms: rows.length > 0, blocking: blockingFormsFromRows(rows) };
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
