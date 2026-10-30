import type { ResidentAgentContext } from "../../resident-context";
import { residentManagerIds } from "../../resident-context";
import { wrapUntrustedContent } from "../../untrusted-content";

const PAGE_SIZE = 1000;

/**
 * Load the complete set of the resident's records from a portal table, scoped
 * by the authenticated `resident_user_id` and paginated by a stable column
 * so nothing is silently truncated.
 */
export async function loadResidentIdentityRows<T>(
  ctx: ResidentAgentContext,
  table: string,
  map: (rowData: unknown) => T,
): Promise<T[]> {
  const out: T[] = [];
  // No identity means no rows — never an unfiltered read of a shared table.
  if (!ctx.userId) return out;
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = ctx.db
      .from(table)
      .select("row_data")
      .eq("resident_user_id", ctx.userId);
    if (ctx.activeManagerId) query = query.eq("manager_user_id", ctx.activeManagerId);
    const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { row_data: unknown }[];
    for (const r of rows) out.push(map(r.row_data));
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

/**
 * Load service and lease records scoped by the authenticated resident subject.
 */
export async function loadResidentEmailRows<T>(
  ctx: ResidentAgentContext,
  table: string,
  map: (rowData: unknown) => T,
): Promise<T[]> {
  const out: T[] = [];
  // An absent subject must never trigger an unscoped read.
  if (!ctx.userId) return out;
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = ctx.db
      .from(table)
      .select("row_data")
      .eq("resident_user_id", ctx.userId);
    if (ctx.activeManagerId) query = query.eq("manager_user_id", ctx.activeManagerId);
    const { data, error } = await query.order("id", { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as { row_data: unknown }[];
    for (const r of rows) out.push(map(r.row_data));
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

export type LinkedManagerContact = { id: string; email: string; name: string };

/**
 * Profiles of the managers linked to this resident (ids come from the
 * authenticated context, never from model input).
 */
export async function linkedManagerContacts(ctx: ResidentAgentContext): Promise<LinkedManagerContact[]> {
  const managerIds = residentManagerIds(ctx);
  if (managerIds.length === 0) return [];
  const { data, error } = await ctx.db
    .from("profiles")
    .select("id, email, full_name")
    .in("id", managerIds);
  if (error) throw new Error(error.message);
  return (data ?? [])
    .map((row: { id: unknown; email: unknown; full_name: unknown }) => {
      const email = String(row.email ?? "").trim().toLowerCase();
      return {
        id: String(row.id ?? "").trim(),
        email,
        name: String(row.full_name ?? "").trim() || email,
      };
    })
    .filter((c: LinkedManagerContact) => c.id && c.email);
}

/**
 * Stable content hash (djb2) for audit dedupe keys built from free text — the
 * text itself never reaches the audit table.
 */
export function contentHash(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = ((h << 5) + h + input.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Wrap other-party-authored free text (manager notes, vendor summaries) so the
 * model treats it as quoted data, never as instructions. Returns null for
 * empty text so projections stay compact.
 */
export function untrustedText(source: string, text: string | null | undefined): { untrustedContent: string } | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return wrapUntrustedContent("MESSAGE", source, trimmed);
}
