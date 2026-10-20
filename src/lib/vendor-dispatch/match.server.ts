import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { normalizeE164 } from "@/lib/phone-e164";
import { readVendorTextConsent } from "@/lib/sms/vendor-conversation-consent.server";
import { suggestVendorsForWorkOrder } from "@/lib/work-order-auto-match";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import type { DispatchUrgency } from "@/lib/vendor-dispatch/trades";
import { VENDOR_TRADES, tradeDefinition } from "@/lib/vendor-dispatch/trades";
import { isBusinessHoursPacific } from "@/lib/vendor-dispatch/time";
import { firstNameOf } from "@/lib/vendor-dispatch/text";
import type { ChainVendor, DispatchRuleRow } from "@/lib/vendor-dispatch/types";

/**
 * Which rule governs a job and who is offered it, in order (vendor-dispatch-1018).
 *
 * Precedence: a `selected` rule naming the property beats `all`; an issue-specific
 * rule beats trade-only; `urgencies` and `hours` (business = Mon-Fri 8-18 Pacific)
 * filter; ties go to the newest rule. A vendor is dropped from the chain when they
 * have no phone, have opted out of texts, are parked on BUSY, or are inactive.
 * No rule: the existing trade-and-fairness ranking (`suggestVendorsForWorkOrder`).
 */

/** Postgres / PostgREST "that table or column is not there yet" - prod runs code before migrations. */
export function isMissingRelationError(error: unknown): boolean {
  const code = String((error as { code?: unknown } | null)?.code ?? "");
  return code === "42P01" || code === "42703" || code === "PGRST205" || code === "PGRST204";
}

export type MatchInput = {
  workspaceId: string;
  ownerUserId: string;
  trade: string;
  issue?: string | null;
  propertyId?: string | null;
  urgency: DispatchUrgency;
  at?: Date;
  /** When the job is a work order, its row drives the fairness ranking of the fallback. */
  workOrder?: DemoManagerWorkOrderRow | null;
  /** The job's general area (never a street): ranks roster vendors whose service area matches. */
  area?: string | null;
};

export type MatchResult = {
  rule: DispatchRuleRow | null;
  chain: ChainVendor[];
  source: "rule" | "fallback" | "none";
};

/** Legacy roster labels (`TRADE_OPTIONS` on the vendors panel) mapped onto dispatch trades. */
const LEGACY_TRADE_LABELS: Record<string, string[]> = {
  plumbing: ["plumber"],
  electrical: ["electrician"],
  hvac: ["hvac"],
  "appliance repair": ["appliance"],
  appliance: ["appliance"],
  cleaning: ["cleaner"],
  "general maintenance": ["handyman", "general"],
  landscaping: ["landscaping"],
  "pest control": ["pest"],
  locksmith: ["locksmith"],
  "access / locks": ["locksmith"],
};

/** The dispatch trade ids a roster vendor covers (ids, labels, and the legacy single `trade`). */
export function vendorTradeIds(vendor: Pick<ManagerVendorRow, "trade" | "trades">): Set<string> {
  const ids = new Set<string>();
  const labels = [...(vendor.trades ?? []), vendor.trade].map((label) => String(label ?? "").trim().toLowerCase()).filter(Boolean);
  for (const label of labels) {
    const direct = VENDOR_TRADES.find((entry) => entry.id === label || entry.label.toLowerCase() === label);
    if (direct) ids.add(direct.id);
    for (const mapped of LEGACY_TRADE_LABELS[label] ?? []) ids.add(mapped);
  }
  return ids;
}

export type VendorRecord = {
  id: string;
  manager_user_id: string | null;
  vendor_user_id: string | null;
  row_data: ManagerVendorRow | null;
};

function ruleAppliesTo(rule: DispatchRuleRow, input: MatchInput, at: Date): boolean {
  if (!rule.active) return false;
  if (rule.workspace_id !== input.workspaceId) return false;
  if (rule.trade !== input.trade) return false;
  if (rule.issue && rule.issue !== (input.issue ?? null)) return false;
  if (Array.isArray(rule.urgencies) && rule.urgencies.length > 0 && !rule.urgencies.includes(input.urgency)) return false;
  if (rule.property_scope === "selected") {
    if (!input.propertyId || !(rule.property_ids ?? []).includes(input.propertyId)) return false;
  }
  if (rule.hours === "business" && !isBusinessHoursPacific(at)) return false;
  if (rule.hours === "after_hours" && isBusinessHoursPacific(at)) return false;
  return true;
}

/** Higher is more specific. Property naming outranks issue specificity; recency breaks ties. */
function ruleRank(rule: DispatchRuleRow): [number, number, number] {
  return [
    rule.property_scope === "selected" ? 1 : 0,
    rule.issue ? 1 : 0,
    Date.parse(rule.updated_at || rule.created_at || "") || 0,
  ];
}

export function orderMatchingRules(rules: DispatchRuleRow[], input: MatchInput, at: Date = input.at ?? new Date()): DispatchRuleRow[] {
  return rules
    .filter((rule) => ruleAppliesTo(rule, input, at))
    .sort((a, b) => {
      const ra = ruleRank(a);
      const rb = ruleRank(b);
      for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return rb[i]! - ra[i]!;
      return 0;
    });
}

/** The active rules of a workspace that name this trade, newest first. A missing table is "no rules". */
export async function loadActiveRules(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId?: string | null; trade: string },
): Promise<DispatchRuleRow[]> {
  let query = db
    .from("vendor_dispatch_rules")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("trade", input.trade)
    .eq("active", true);
  if (input.ownerUserId) query = query.eq("owner_user_id", input.ownerUserId);
  const { data, error } = await query;
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(error.message);
  }
  return (data ?? []) as DispatchRuleRow[];
}

async function busyVendorIds(db: SupabaseClient, vendorIds: string[], at: Date): Promise<Set<string>> {
  if (vendorIds.length === 0) return new Set();
  const { data, error } = await db
    .from("vendor_dispatch_attempts")
    .select("vendor_directory_id, busy_until")
    .in("vendor_directory_id", vendorIds)
    .gt("busy_until", at.toISOString());
  if (error) {
    if (isMissingRelationError(error)) return new Set();
    throw new Error(error.message);
  }
  return new Set(((data ?? []) as Array<{ vendor_directory_id: string }>).map((row) => row.vendor_directory_id));
}

async function isReachable(
  db: SupabaseClient,
  ownerUserId: string,
  phone: string,
  vendorUserId: string | null,
): Promise<boolean> {
  try {
    const consent = await readVendorTextConsent(db, { managerUserId: ownerUserId, vendorUserId, phone });
    if (!consent.ok) return false;
    return consent.state !== "opted_out" && consent.state !== "revoked";
  } catch {
    return false;
  }
}

/**
 * Turn roster records into reachable chain entries, keeping the given order.
 *
 * A row the caller does not own is kept only when it is shared with managers, or when it is a live
 * PropLane Service ROSTER row of the platform service owner: those are texted AS the service owner, so
 * their consent is judged against that owner too. Keying consent and ownership on the caller alone
 * dropped every roster vendor from a re-offer and asked the wrong ledger about their STOP.
 */
export async function toChain(
  db: SupabaseClient,
  ownerUserId: string,
  orderedIds: string[],
  records: Map<string, VendorRecord>,
  at: Date,
  options: { requireTrade?: string } = {},
): Promise<ChainVendor[]> {
  const busy = await busyVendorIds(db, orderedIds, at);
  let serviceOwnerId: string | null | undefined;
  const chain: ChainVendor[] = [];
  for (const id of orderedIds) {
    const record = records.get(id);
    const vendor = record?.row_data;
    if (!record || !vendor || vendor.active === false) continue;
    const ownedByManager = record.manager_user_id === ownerUserId;
    let sender = ownerUserId;
    if (!ownedByManager) {
      const roster = vendor as { serviceRoster?: unknown; rosterRemovedAt?: unknown };
      const liveRoster = roster.serviceRoster === true && !roster.rosterRemovedAt;
      if (liveRoster) {
        if (serviceOwnerId === undefined) {
          serviceOwnerId = await import("@/lib/service/service-catalog.server")
            .then((m) => m.readPlatformServiceOwnerId(db))
            .catch(() => null);
        }
        if (!serviceOwnerId || serviceOwnerId !== record.manager_user_id) continue;
        sender = serviceOwnerId;
      } else if (vendor.sharedWithManagers !== true) {
        continue;
      }
    }
    if (busy.has(id)) continue;
    if (options.requireTrade && !vendorTradeIds(vendor).has(options.requireTrade)) continue;
    const phone = normalizeE164(String(vendor.phone ?? "").trim());
    if (!phone) continue;
    const vendorUserId = record.vendor_user_id ?? vendor.vendorUserId ?? null;
    if (!(await isReachable(db, sender, phone, vendorUserId))) continue;
    const name = String(vendor.name ?? "").trim() || "Vendor";
    chain.push({
      vendorDirectoryId: id,
      name,
      firstName: firstNameOf(vendor.preferredName || name) || "Vendor",
      phone,
      vendorUserId,
      position: chain.length,
    });
  }
  return chain;
}

async function loadRecords(db: SupabaseClient, ids: string[]): Promise<Map<string, VendorRecord>> {
  const map = new Map<string, VendorRecord>();
  if (ids.length === 0) return map;
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .in("id", ids);
  if (error) throw new Error(error.message);
  for (const row of (data ?? []) as VendorRecord[]) map.set(row.id, row);
  return map;
}

/** The ordered, reachable vendors of one rule (position 0 = primary). */
export async function loadRuleChain(
  db: SupabaseClient,
  rule: Pick<DispatchRuleRow, "id" | "owner_user_id">,
  at: Date = new Date(),
): Promise<ChainVendor[]> {
  const { data, error } = await db
    .from("vendor_dispatch_rule_vendors")
    .select("vendor_directory_id, position")
    .eq("rule_id", rule.id)
    .order("position", { ascending: true });
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(error.message);
  }
  const ordered = ((data ?? []) as Array<{ vendor_directory_id: string; position: number }>)
    .sort((a, b) => a.position - b.position)
    .map((row) => row.vendor_directory_id);
  const records = await loadRecords(db, ordered);
  return toChain(db, rule.owner_user_id, ordered, records, at);
}

/**
 * The subset of these roster entries that may be texted right now, in the order given: the SAME busy-window and
 * opt-out rules the first wave applies. A re-offer must go through this, never straight off the attempt rows.
 */
export async function reachableVendorDirectoryIds(
  db: SupabaseClient,
  input: { ownerUserId: string; vendorDirectoryIds: readonly string[]; at?: Date },
): Promise<string[]> {
  const ordered = [...new Set(input.vendorDirectoryIds.filter(Boolean))];
  if (ordered.length === 0) return [];
  const records = await loadRecords(db, ordered);
  const chain = await toChain(db, input.ownerUserId, ordered, records, input.at ?? new Date());
  const reachable = new Set(chain.map((vendor) => vendor.vendorDirectoryId));
  return ordered.filter((id) => reachable.has(id));
}

/** Every reachable vendor of the trade on this manager's roster (the "offer all cleaners at once" set). */
export async function loadTradeRoster(
  db: SupabaseClient,
  input: { ownerUserId: string; trade: string; propertyId?: string | null; at?: Date; workspaceId?: string | null; area?: string | null },
): Promise<ChainVendor[]> {
  const own = await loadOwnTradeRoster(db, input);
  return withServiceRoster(db, { workspaceId: input.workspaceId, trade: input.trade, area: input.area, at: input.at }, own);
}

async function loadOwnTradeRoster(
  db: SupabaseClient,
  input: { ownerUserId: string; trade: string; propertyId?: string | null; at?: Date },
): Promise<ChainVendor[]> {
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("manager_user_id", input.ownerUserId);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as VendorRecord[]).filter((row) => {
    const vendor = row.row_data;
    // `dispatchAvailable === false` is the vendor form's "do not text this one jobs". The service roster already
    // honours it; on a PropLane-created service workspace the owner IS the service owner, so every roster row also
    // arrives down this path and an unticked vendor was still being offered work.
    if (!vendor || vendor.active === false || vendor.dispatchAvailable === false) return false;
    if (input.propertyId && vendor.propertyIds && vendor.propertyIds.length > 0 && !vendor.propertyIds.includes(input.propertyId)) {
      return false;
    }
    return vendorTradeIds(vendor).has(input.trade);
  });
  const ordered = rows
    .sort((a, b) => {
      const pa = a.row_data?.vendorPriority === "primary" ? 0 : 1;
      const pb = b.row_data?.vendorPriority === "primary" ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return String(a.row_data?.name ?? "").localeCompare(String(b.row_data?.name ?? ""));
    })
    .map((row) => row.id);
  const records = new Map(rows.map((row) => [row.id, row] as const));
  return toChain(db, input.ownerUserId, ordered, records, input.at ?? new Date());
}

/**
 * A PropLane Service workspace (`is_service`) is also offered to the service-wide vendor roster (admin Service >
 * Vendors), behind the workspace's own vendors. Any other workspace, or a roster that cannot be read, returns `own`
 * unchanged.
 */
async function withServiceRoster(
  db: SupabaseClient,
  input: { workspaceId?: string | null; trade: string; area?: string | null; at?: Date },
  own: ChainVendor[],
): Promise<ChainVendor[]> {
  if (!input.workspaceId) return own;
  try {
    const roster = await import("@/lib/vendor-dispatch/service-roster.server");
    const serviceOwnerId = await roster.serviceOwnerForWorkspace(db, input.workspaceId);
    if (!serviceOwnerId) return own;
    const chain = await roster.loadServiceRosterChain(db, { serviceOwnerId, trade: input.trade, area: input.area, at: input.at });
    return roster.mergeRosterChain(own, chain);
  } catch {
    return own;
  }
}

/** The existing fairness ranking, restricted to vendors whose trades include the job's trade; a service workspace adds the roster. */
async function fallbackChain(db: SupabaseClient, input: MatchInput, at: Date): Promise<ChainVendor[]> {
  // A service workspace's chain continues into the service-wide roster (admin Service > Vendors): own vendors first,
  // merged by `mergeRosterChain` (ONE entry per phone). Deduping on the directory id instead texted the same person
  // twice on one run - a workspace vendor row and a roster row - and made their YES ambiguous between two identical handles.
  const roster = await loadTradeRoster(db, {
    ownerUserId: input.ownerUserId,
    trade: input.trade,
    propertyId: input.propertyId,
    workspaceId: input.workspaceId,
    area: input.area,
    at,
  });
  const workOrder = input.workOrder;
  if (!workOrder?.category || roster.length === 0) return roster.map((vendor, index) => ({ ...vendor, position: index }));
  const records = await loadRecords(db, roster.map((vendor) => vendor.vendorDirectoryId));
  const rows = roster
    .map((vendor) => (records.get(vendor.vendorDirectoryId)?.row_data ? { ...records.get(vendor.vendorDirectoryId)!.row_data!, id: vendor.vendorDirectoryId } : null))
    .filter((row): row is ManagerVendorRow => Boolean(row));
  let ranked: string[] = [];
  try {
    ranked = suggestVendorsForWorkOrder({ ...workOrder, managerUserId: workOrder.managerUserId ?? input.ownerUserId }, rows).map((candidate) => candidate.vendorId);
  } catch {
    ranked = [];
  }
  const byId = new Map(roster.map((vendor) => [vendor.vendorDirectoryId, vendor] as const));
  const ordered = [...ranked.filter((id) => byId.has(id)), ...roster.map((vendor) => vendor.vendorDirectoryId).filter((id) => !ranked.includes(id))];
  return ordered.map((id, index) => ({ ...byId.get(id)!, position: index }));
}

export async function matchDispatchRule(db: SupabaseClient, input: MatchInput): Promise<MatchResult> {
  const at = input.at ?? new Date();
  if (!tradeDefinition(input.trade)) return { rule: null, chain: [], source: "none" };
  const rules = orderMatchingRules(
    await loadActiveRules(db, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, trade: input.trade }),
    input,
    at,
  );
  for (const rule of rules) {
    const chain = await loadRuleChain(db, rule, at);
    if (chain.length > 0) return { rule, chain, source: "rule" };
  }
  // A rule matched but nobody on it can be texted: report the rule with an empty chain
  // rather than quietly routing around the manager's own choice of vendors.
  if (rules.length > 0) return { rule: rules[0]!, chain: [], source: "none" };
  const chain = await fallbackChain(db, input, at);
  return { rule: null, chain, source: chain.length > 0 ? "fallback" : "none" };
}

/** True when the workspace has an active rule that would govern this job (used to pick rule vs legacy dispatch). */
export async function workspaceHasMatchingRule(db: SupabaseClient, input: MatchInput): Promise<boolean> {
  try {
    const rules = orderMatchingRules(
      await loadActiveRules(db, { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId, trade: input.trade }),
      input,
      input.at ?? new Date(),
    );
    if (rules.length > 0) return true;
    // A PropLane Service workspace needs no rule of its own: the service roster is its standing chain. Both reads are
    // memoized per client, so a sweep over many stays does not re-scan the roster once per stay.
    const roster = await import("@/lib/vendor-dispatch/service-roster.server");
    const serviceOwnerId = await roster.serviceOwnerForWorkspace(db, input.workspaceId);
    if (!serviceOwnerId) return false;
    // Propose-by-default is a DEFAULT: a workspace whose dispatch mode was explicitly saved "off" gets no runs, so
    // the standing roster must not stand in for a rule there either.
    const { resolveDispatchSettings } = await import("@/lib/vendor-dispatch/service-default.server");
    const resolution = await resolveDispatchSettings(db, input.ownerUserId, input.workspaceId);
    if (resolution.settings.mode === "off") return false;
    return await roster.serviceRosterHasTrade(db, serviceOwnerId, input.trade);
  } catch {
    return false;
  }
}
