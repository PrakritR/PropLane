import { normalizeE164 } from "@/lib/phone-e164";
import { isVendorTrade } from "@/lib/vendor-dispatch/vendor-roles";
import { tradeDefinition, type VendorTrade } from "@/lib/vendor-dispatch/trades";

/**
 * The PropLane Service VENDOR ROSTER, pure part (client and server).
 *
 * A roster vendor is a `manager_vendor_records` row owned by the SERVICE OWNER with `row_data.serviceRoster = true`.
 * The existing vendor model already carries what dispatch needs (name, phone, `dispatchTrades`, `serviceArea`,
 * `dispatchAvailable`, `active`, the vendor text-consent ledger), so there is no second table and no second dispatcher:
 * the engine reads these rows for every `is_service` workspace (`src/lib/vendor-dispatch/service-roster.server.ts`).
 */

export const SERVICE_VENDOR_NAME_MAX = 80;
export const SERVICE_VENDOR_AREA_MAX = 120;
/** How the roster vendor's consent to be texted is documented on the row and in the consent ledger. */
export const SERVICE_VENDOR_CONSENT_BASIS = "added_by_admin_prior_relationship";
/** Row id prefix: a roster vendor id is never a manager's own typed id. */
export const SERVICE_VENDOR_ID_PREFIX = "svcv-";

export type ServiceVendorInput = {
  name: string;
  /** E.164, US. */
  phone: string;
  trades: VendorTrade[];
  area: string;
};

export type ServiceVendorInputResult = { ok: true; value: ServiceVendorInput } | { ok: false; error: string };

export function cleanServiceVendorPhone(raw: unknown): string | null {
  const e164 = normalizeE164(typeof raw === "string" ? raw.trim() : "");
  return e164 && /^\+1[2-9][0-9]{9}$/.test(e164) ? e164 : null;
}

/** Validate an add / edit form. Phone is US E.164; at least one trade; area optional. */
export function cleanServiceVendorInput(raw: Record<string, unknown>): ServiceVendorInputResult {
  const name = typeof raw.name === "string" ? raw.name.replace(/\s+/g, " ").trim() : "";
  if (!name) return { ok: false, error: "Enter the vendor's name." };
  if (name.length > SERVICE_VENDOR_NAME_MAX) return { ok: false, error: "That name is too long." };
  const phone = cleanServiceVendorPhone(raw.phone);
  if (!phone) return { ok: false, error: "Enter a US phone number, like (206) 555-0100." };
  const trades = Array.isArray(raw.trades) ? [...new Set(raw.trades.filter(isVendorTrade))] : [];
  if (trades.length === 0) return { ok: false, error: "Choose at least one trade." };
  const areaRaw = raw.area;
  if (areaRaw !== undefined && areaRaw !== null && typeof areaRaw !== "string") return { ok: false, error: "Enter the area as text." };
  const area = typeof areaRaw === "string" ? areaRaw.replace(/\s+/g, " ").trim() : "";
  if (area.length > SERVICE_VENDOR_AREA_MAX) return { ok: false, error: "That area is too long." };
  return { ok: true, value: { name, phone, trades, area } };
}

export function serviceVendorTradeLabels(trades: readonly string[]): string[] {
  return trades.map((id) => tradeDefinition(id)?.label ?? "").filter(Boolean);
}

/**
 * The ONE intro text a roster vendor gets when added. It names PropLane and who added them and says how it works.
 * The transport appends the first-text sender line ("- <name> at PropLane via PropLane. Reply STOP to opt out."),
 * which is the opt-out. Plain GSM-7.
 */
export function composeServiceVendorIntro(input: { adminFirstName?: string | null }): string {
  const who = (input.adminFirstName ?? "").trim().split(/\s+/)[0] || "The PropLane team";
  return `PropLane here. ${who} added you to our local vendor list for homes we manage. You'll get texts when a job near you needs doing. Reply YES to a job to take it.`;
}

/** What the admin list draws for one roster vendor. */
export type ServiceVendorView = {
  id: string;
  name: string;
  phone: string;
  trades: VendorTrade[];
  area: string;
  paused: boolean;
  /** The vendor texted STOP (or revoked): never texted. */
  optedOut: boolean;
  /** The one intro text left (ISO), or null. */
  introSentAt: string | null;
  /** The phone belongs to a PropLane vendor account (the roster entry links to it, no duplicate). */
  hasAccount: boolean;
};
