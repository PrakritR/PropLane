import type { SupabaseClient } from "@supabase/supabase-js";
import type { WorkOrderCategory } from "@/lib/work-order-taxonomy";

export type VendorDispatchMode = "off" | "approve" | "auto";

export type VendorDispatchSettings = {
  /** off = feature dark; approve = agent proposes + manager one-taps; auto = dispatch within guardrails. */
  mode: VendorDispatchMode;
  /** Gates the vendor-messaging agent (SMS + inbox) on dispatched work orders. */
  agentMessagingEnabled: boolean;
  /** Allows managers to find vendors and collect quotes for a service. */
  quoteSourcingEnabled: boolean;
  /**
   * Downgrades auto-dispatch to a proposal when a cost estimate exists and
   * exceeds this. Dispatch itself commits no money, so this is advisory until
   * a bid is accepted. Null = no cap.
   */
  spendCapCents: number | null;
  /** Auto mode may only pick these directory vendor ids. Null = any matched vendor. */
  approvedVendorIds: string[] | null;
  /** Auto mode only fires for these categories. Null = all categories. */
  categories: WorkOrderCategory[] | null;
  /** Proposal/dispatch notification channels for the manager; inbox is always on. */
  notify: { push: boolean; sms: boolean };
};

export const DEFAULT_VENDOR_DISPATCH_SETTINGS: VendorDispatchSettings = {
  mode: "off",
  agentMessagingEnabled: false,
  quoteSourcingEnabled: false,
  spendCapCents: null,
  approvedVendorIds: null,
  categories: null,
  notify: { push: true, sms: false },
};

export function normalizeVendorDispatchSettings(raw: unknown): VendorDispatchSettings {
  const r = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const stringList = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.map((v) => String(v).trim()).filter(Boolean) : null;
  const spendCap = Math.round(Number(r.spendCapCents));
  const notify = (r.notify && typeof r.notify === "object" ? r.notify : {}) as Record<string, unknown>;
  return {
    mode: r.mode === "approve" || r.mode === "auto" ? r.mode : "off",
    agentMessagingEnabled: r.agentMessagingEnabled === true,
    quoteSourcingEnabled: r.quoteSourcingEnabled === true,
    spendCapCents: Number.isFinite(spendCap) && spendCap > 0 ? spendCap : null,
    approvedVendorIds: stringList(r.approvedVendorIds),
    categories: stringList(r.categories) as WorkOrderCategory[] | null,
    notify: { push: notify.push !== false, sms: notify.sms === true },
  };
}

/** Read failure falls back to defaults (mode off), keeping the feature dark rather than failing open. */
export async function loadVendorDispatchSettings(
  db: SupabaseClient,
  managerUserId: string,
): Promise<VendorDispatchSettings> {
  const { data } = await db
    .from("manager_automation_settings")
    .select("vendor_dispatch")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  return normalizeVendorDispatchSettings(data?.vendor_dispatch ?? null);
}

export async function saveVendorDispatchSettings(
  db: SupabaseClient,
  managerUserId: string,
  settings: unknown,
): Promise<VendorDispatchSettings> {
  const normalized = normalizeVendorDispatchSettings(settings);
  const { error } = await db.from("manager_automation_settings").upsert(
    {
      manager_user_id: managerUserId,
      vendor_dispatch: normalized,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "manager_user_id" },
  );
  if (error) throw error;
  return normalized;
}
