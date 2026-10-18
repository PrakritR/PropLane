/**
 * W8: manager operations by text. The gaps between the spec's command table and the portal
 * catalog the manager SMS agent already carries:
 *
 *   list_tours_on_day            "Who's touring tomorrow?"                         read
 *   list_unpaid_rent             "Who hasn't paid October rent?"                   read
 *   get_application_review_link  "Approve Priya's application"                    read (a deep link; approval stays in the portal)
 *   broadcast_to_residents       "Text all 5257 residents: ..."                    write, YES-gated
 *   set_up_payouts               "set up payouts"                                  read (mints a phone-bound link)
 *
 * Rooms (vacancies, "mark room 3 rented") live in `manager-ops-rooms.ts`. Every read is scoped by the
 * context it is given (the workspace behind the number, a teammate's houses); the broadcast
 * re-derives its recipients at execute time and sends through `send_message`, the one messaging
 * path, so its sender-scope gate and its audit row are the same ones the portal uses.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defineTool, defineWriteTool } from "../registry";
import type { AgentContext } from "../context";
import { auditDayBucket, updateAuditResult, writeAuditLog } from "../audit";
import { loadManagerApplications } from "./residents";
import { listPropertiesTool } from "./properties";
import { sendMessageTool } from "./messaging";
import { mintLinkForTexter } from "./one-number-links";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { rentStatusFor, toursOnDay } from "@/lib/one-number/ops-facts.server";
import { monthLabel, resolveDayKey, resolveMonthKey, usd, whichHouseQuestion } from "@/lib/one-number/ops-text";
import { toGsm7 } from "@/lib/one-number/segments";
import { buildPortalApplicationOpenHref } from "@/lib/manager-applications-storage";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { isCurrentResidentApplicationRow } from "@/lib/current-resident";
import { isPhoneOptedOut } from "@/lib/sms-consent";
import { propertyInAgentWorkspace } from "@/lib/agent/manager-workspace-scope";
import type { DemoApplicantRow } from "@/data/demo-portal";

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim());

// ---- list_tours_on_day -----------------------------------------------------------------------

export const listToursOnDayTool = defineTool({
  name: "list_tours_on_day",
  description:
    "List the tours on one day, in Pacific time: confirmed tours (time, who, house) and open tour requests. `day` is \"today\", \"tomorrow\" or a YYYY-MM-DD date. Optionally one house (property id from list_properties). Use for 'who's touring tomorrow' and 'any tours today'. The day is worked out by the tool; never compute a date yourself.",
  kind: "read",
  inputSchema: z
    .object({
      day: z.string().min(1).max(20).describe("\"today\", \"tomorrow\" or YYYY-MM-DD."),
      propertyId: z.string().optional().describe("Optional property id to narrow to one house."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const dayKey = resolveDayKey(input.day);
    if (!dayKey) return { error: "day must be today, tomorrow or a real date as YYYY-MM-DD." };
    const tours = await toursOnDay(ctx, dayKey, input.propertyId);
    return { day: tours.day, confirmedCount: tours.confirmed.length, confirmed: tours.confirmed.map(({ time, who, house }) => ({ time, who, house })), openRequests: tours.requests.map(({ time, who, house }) => ({ time, who, house })) };
  },
});

// ---- list_unpaid_rent ------------------------------------------------------------------------

export const listUnpaidRentTool = defineTool({
  name: "list_unpaid_rent",
  description:
    "Rent status for one month: how many residents have paid and who has not, with the balance each still owes and the total. `month` is YYYY-MM (omit for the current month). Optionally one house (property id from list_properties). Use for 'who hasn't paid October rent'. Counts and amounts come from this tool only.",
  kind: "read",
  inputSchema: z
    .object({
      month: z.string().max(7).optional().describe("YYYY-MM; omit for the current month."),
      propertyId: z.string().optional().describe("Optional property id to narrow to one house."),
    })
    .strict(),
  handler: async (ctx, input) => {
    const month = resolveMonthKey(input.month);
    if (!month) return { error: "month must look like 2026-10." };
    const status = await rentStatusFor(ctx, month, input.propertyId);
    return {
      month: monthLabel(month),
      paidCount: status.paidCount,
      unpaidCount: status.unpaidCount,
      unpaidTotal: usd(status.unpaidCents),
      unpaid: status.unpaid.map((line) => ({ resident: line.residentName, house: line.house, owes: usd(line.balanceCents), status: line.status })),
    };
  },
});

// ---- get_application_review_link -------------------------------------------------------------

export const getApplicationReviewLinkTool = defineTool({
  name: "get_application_review_link",
  description:
    "Get the portal link that opens one application for review. Approving or declining an application is done in the portal, never by text: when the manager asks to approve (or decline) someone, find the application with list_applications, call this, and reply with the link. Never say the application was approved.",
  kind: "read",
  inputSchema: z.object({ applicationId: z.string().min(1).describe("Application id from list_applications.") }).strict(),
  handler: async (ctx, input) => {
    const wanted = input.applicationId.trim().toLowerCase();
    const rows = await loadManagerApplications(ctx);
    const row = rows.find((r) => str(r.id).toLowerCase() === wanted);
    if (!row) return { found: false, message: "No application with that id on this account. Use list_applications for valid ids." };
    const origin = resolveEmailLinkBaseUrl().replace(/\/$/, "");
    return {
      found: true,
      applicant: str(row.name) || null,
      property: str(row.property) || null,
      status: str(row.bucket) || null,
      url: `${origin}${buildPortalApplicationOpenHref(str(row.id))}`,
    };
  },
});

// ---- broadcast_to_residents ------------------------------------------------------------------

const MESSAGE_MAX = 600;
const SEND_CHUNK = 20;

type House = { id: string; title: string };
type Resident = { email: string; name: string; propertyId: string };

function applicationPropertyId(row: DemoApplicantRow): string {
  return str(row.assignedPropertyId) || str(row.propertyId) || str((row.application as { propertyId?: unknown } | undefined)?.propertyId);
}

/**
 * Who a broadcast reaches, derived from live rows every time it is asked (preview AND execute):
 * the current residents of the houses in this context's scope, one per email. A house the
 * context cannot see has no residents here, whatever id the model passed.
 */
export async function resolveBroadcastAudience(
  ctx: AgentContext,
  input: { propertyId?: string; allHouses?: boolean },
): Promise<{ houses: House[]; residents: Resident[]; question?: string }> {
  const { properties } = await listPropertiesTool.handler(ctx, {});
  const known = new Map<string, House>();
  for (const p of properties) {
    if (!propertyInAgentWorkspace(ctx.workspace, p.id)) continue;
    known.set(p.id, { id: p.id, title: str(p.title) || str(p.address) || p.id });
  }
  const rows = (await loadManagerApplications(ctx)).filter((r) => isCurrentResidentApplicationRow(r) && str(r.email).includes("@"));
  const byHouse = new Map<string, Resident[]>();
  for (const row of rows) {
    const propertyId = applicationPropertyId(row);
    if (!known.has(propertyId)) continue;
    const list = byHouse.get(propertyId) ?? [];
    list.push({ email: str(row.email).toLowerCase(), name: str(row.name) || str(row.email), propertyId });
    byHouse.set(propertyId, list);
  }
  const withResidents = [...byHouse.keys()].map((id) => known.get(id)!).sort((a, b) => a.title.localeCompare(b.title));

  let houses: House[];
  const wanted = input.propertyId?.trim();
  if (wanted) {
    const house = known.get(wanted);
    if (!house) throw new Error("No house with that id in this workspace. Use list_properties for valid ids.");
    houses = [house];
  } else if (input.allHouses === true) {
    houses = withResidents;
  } else if (withResidents.length > 1) {
    return { houses: [], residents: [], question: whichHouseQuestion(withResidents.map((h) => h.title)) };
  } else {
    houses = withResidents;
  }
  const seen = new Set<string>();
  const residents: Resident[] = [];
  for (const house of houses) {
    for (const resident of byHouse.get(house.id) ?? []) {
      if (seen.has(resident.email)) continue;
      seen.add(resident.email);
      residents.push(resident);
    }
  }
  return { houses, residents };
}

/** How many of these residents a text can reach right now: a verified phone that has not said STOP. */
async function countTextable(db: SupabaseClient, emails: string[]): Promise<number> {
  if (emails.length === 0) return 0;
  const { data, error } = await db.from("profiles").select("phone, phone_verified_at").in("email", emails);
  if (error) return 0;
  let n = 0;
  for (const row of (data ?? []) as Array<{ phone?: unknown; phone_verified_at?: unknown }>) {
    const phone = str(row.phone);
    if (!phone || !row.phone_verified_at) continue;
    if (await isPhoneOptedOut(db, phone)) continue;
    n += 1;
  }
  return n;
}

function broadcastBody(message: string): string {
  return toGsm7(message.replace(/\s+/g, " ").trim());
}

export const broadcastToResidentsTool = defineWriteTool({
  name: "broadcast_to_residents",
  description:
    "Send one message to the current residents of one house, or of every house, each as their own one-to-one message (inbox, email and text by the resident's own settings; a resident who opted out of texts is not texted). Use for 'text all 5257 residents: water is off Tuesday'. Pass a property id from list_properties, or allHouses: true; if the manager runs several houses and named none, call this without either and ask the question the error gives. The preview lists the recipient count. Rent, move-in and move-out notices are automatic and are not sent with this.",
  inputSchema: z
    .object({
      propertyId: z.string().optional().describe("The house, from list_properties."),
      allHouses: z.boolean().optional().describe("True to reach every house's residents."),
      message: z.string().min(1).max(MESSAGE_MAX).describe("The message, in the manager's words."),
    })
    .strict(),
  preview: async (ctx, input) => {
    if (input.propertyId && input.allHouses) throw new Error("Pass a house or allHouses, not both.");
    const audience = await resolveBroadcastAudience(ctx, input);
    if (audience.question) throw new Error(audience.question);
    if (audience.residents.length === 0) throw new Error("No current residents to message there.");
    const body = broadcastBody(input.message);
    if (!body) throw new Error("The message is empty.");
    const textable = await countTextable(ctx.db as unknown as SupabaseClient, audience.residents.map((r) => r.email));
    const where = audience.houses.length === 1 ? audience.houses[0]!.title : `${audience.houses.length} houses`;
    return {
      confirmedInput: { ...(input.propertyId ? { propertyId: input.propertyId } : {}), ...(input.allHouses ? { allHouses: true } : {}), message: body },
      kind: "broadcast_to_residents",
      title: `Message ${audience.residents.length} resident${audience.residents.length === 1 ? "" : "s"}`,
      summary: `Send "${body.length > 70 ? `${body.slice(0, 67)}...` : body}" to ${audience.residents.length} resident${audience.residents.length === 1 ? "" : "s"} at ${where}.`,
      fields: [
        { label: "Where", value: where },
        { label: "Residents", value: String(audience.residents.length) },
        { label: "By text", value: `${textable} of ${audience.residents.length}` },
        { label: "Message", value: body },
      ],
      ...(body.length > 160 ? { warnings: ["Longer than one text segment."] } : {}),
      confirmLabel: `Send to ${audience.residents.length}`,
      batchCount: audience.residents.length,
    };
  },
  handler: async (ctx, input) => {
    // Everything is re-derived: the stored ids are never proof of who may be messaged.
    const audience = await resolveBroadcastAudience(ctx, input);
    if (audience.question) throw new Error(audience.question);
    if (audience.residents.length === 0) throw new Error("No current residents to message there; nothing was sent.");
    const body = broadcastBody(input.message);
    const emails = audience.residents.map((r) => r.email).sort();
    const dedupeKey = `broadcast_to_residents:${ctx.landlordId}:${emails.length}:${emails[0]}:${hash(`${body}\n${emails.join(",")}`)}:${auditDayBucket()}`;
    const audit = await writeAuditLog(ctx, {
      action: "broadcast_to_residents",
      toolName: "broadcast_to_residents",
      inputSummary: { recipientCount: emails.length, houseCount: audience.houses.length, allHouses: input.allHouses === true },
      dedupeKey,
    });
    if (!audit.recorded) {
      if (audit.duplicate) return { reply: "This exact message already went to the same residents today, so it was not sent again." };
      throw new Error("Could not record the action; nothing was sent.");
    }
    const subject = audience.houses.length === 1 ? `Notice for ${audience.houses[0]!.title}` : "Notice from your property manager";
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < emails.length; i += SEND_CHUNK) {
      try {
        // The messaging tool re-resolves and re-authorizes every address against the sender's scope.
        await sendMessageTool.handler(ctx, { toEmails: emails.slice(i, i + SEND_CHUNK), subject, body });
        sent += Math.min(SEND_CHUNK, emails.length - i);
      } catch {
        failed += Math.min(SEND_CHUNK, emails.length - i);
      }
    }
    await updateAuditResult(ctx, dedupeKey, { sent, failed }, failed > 0 && sent === 0 ? { clearDedupeKey: true } : undefined);
    if (sent === 0) throw new Error("The message could not be delivered to anyone.");
    return {
      reply: `Sent to ${sent} resident${sent === 1 ? "" : "s"}${failed > 0 ? `; ${failed} could not be reached` : ""}.`,
      resultSummary: { sent, failed },
    };
  },
});

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

// ---- set_up_payouts (manager) ----------------------------------------------------------------

export type PayoutLinkResult =
  | { ok: true; alreadySetUp: true; last4: string | null }
  | { ok: true; alreadySetUp: false; url: string; requiresCode: boolean; expires: string }
  | { ok: false; error: "nothing_to_link" | "rate_limited" | "not_found" | "links_unavailable" };

/** The last four of a person's default payout destination, when the cache has one. */
export async function defaultPayoutLast4(db: SupabaseClient, ownerUserId: string): Promise<string | null> {
  const { data } = await db
    .from("payout_destinations_cache")
    .select("last4, is_default, updated_at")
    .eq("owner_user_id", ownerUserId)
    .order("is_default", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last4 = str((data as { last4?: unknown } | null)?.last4);
  return /^\d{4}$/.test(last4) ? last4 : null;
}

/**
 * The one core for "set up payouts" (manager and vendor): the texter's OWN verified phone, a
 * payouts link bound to it (code-protected, 30-minute money session), nothing else. Already set up
 * answers with the last four on file and mints nothing.
 */
export async function payoutLinkForTexter(
  db: SupabaseClient,
  input: { userId: string; targetType: "manager" | "vendor"; workspaceId: string | null; phone: string | null; phoneVerified: boolean; payoutsEnabled: boolean },
): Promise<PayoutLinkResult> {
  if (input.payoutsEnabled) return { ok: true, alreadySetUp: true, last4: await defaultPayoutLast4(db, input.userId) };
  if (!input.phone || !input.phoneVerified) return { ok: false, error: "nothing_to_link" };
  const minted = await mintLinkForTexter(db, {
    workspaceId: input.workspaceId,
    phone: input.phone,
    purpose: "payouts",
    targetType: input.targetType,
    targetId: input.userId,
    createdBy: input.userId,
  });
  if (!minted.ok) return { ok: false, error: minted.error };
  return { ok: true, alreadySetUp: false, url: minted.url, requiresCode: minted.requiresCode, expires: minted.expires };
}

const PAYOUT_DESCRIPTION_TAIL =
  " Put the returned url in your reply, once, on its own line, and say a code will be texted to this number when they open it. If alreadySetUp is true, say payouts are already set up and name the last four if present. If the error is links_unavailable, say payouts are set up in PropLane under Financials. Never type a URL from memory. Bank details never go by text.";

export const managerSetUpPayoutsTool = defineTool({
  name: "set_up_payouts",
  description:
    "Give the manager a secure link, tied to their own phone, to connect the bank account that receives their payouts (Stripe hosted onboarding, after a one-time code). Use for 'set up payouts' and 'how do I get paid'." + PAYOUT_DESCRIPTION_TAIL,
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx): Promise<PayoutLinkResult> => {
    // Payouts belong to the account owner; a teammate on someone else's number has no payout account here.
    if (ctx.managerSmsAccess?.mode === "delegated" || ctx.landlordId !== ctx.userId) return { ok: false, error: "not_found" };
    const { data } = await ctx.db
      .from("profiles")
      .select("phone, phone_verified_at, stripe_connect_payouts_enabled")
      .eq("id", ctx.userId)
      .maybeSingle();
    const row = data as { phone?: unknown; phone_verified_at?: unknown; stripe_connect_payouts_enabled?: unknown } | null;
    const workspaceId = ctx.workspace?.id?.trim() || (await resolveWorkspaceForProperty(ctx.db, null, ctx.landlordId));
    return payoutLinkForTexter(ctx.db, {
      userId: ctx.userId,
      targetType: "manager",
      workspaceId,
      phone: str(row?.phone) || null,
      phoneVerified: Boolean(row?.phone_verified_at),
      payoutsEnabled: row?.stripe_connect_payouts_enabled === true,
    });
  },
});

/** Vendor SMS: the same core, pinned to the vendor behind this session (never a model-supplied id). */
export const vendorSetUpPayoutsTool = defineTool({
  name: "set_up_payouts",
  description:
    "Give the vendor a secure link, tied to their own phone, to connect the bank account their payouts go to (Stripe hosted onboarding, after a one-time code). Use for 'set up payouts', 'how do I get paid'." + PAYOUT_DESCRIPTION_TAIL,
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx): Promise<PayoutLinkResult> => {
    const scope = ctx.vendorScope;
    const vendorUserId = scope?.vendorUserId?.trim();
    if (!scope || !vendorUserId) return { ok: false, error: "nothing_to_link" };
    const { data: session } = await ctx.db
      .from("agent_sessions")
      .select("vendor_phone_e164, landlord_id, work_order_id")
      .eq("id", scope.sessionId)
      .maybeSingle();
    const s = session as { vendor_phone_e164?: unknown; landlord_id?: unknown; work_order_id?: unknown } | null;
    const phone = str(s?.vendor_phone_e164);
    if (!s || str(s.landlord_id) !== ctx.landlordId || str(s.work_order_id) !== scope.workOrderId || !phone) {
      return { ok: false, error: "nothing_to_link" };
    }
    // The vendor's own profile decides whether payouts are already on and whether this phone is theirs.
    const { data: profile } = await ctx.db
      .from("profiles")
      .select("phone, phone_verified_at, stripe_connect_payouts_enabled")
      .eq("id", vendorUserId)
      .maybeSingle();
    const p = profile as { phone?: unknown; phone_verified_at?: unknown; stripe_connect_payouts_enabled?: unknown } | null;
    const { data: order } = await ctx.db
      .from("portal_work_order_records")
      .select("property_id, assigned_property_id")
      .eq("id", scope.workOrderId)
      .eq("manager_user_id", ctx.landlordId)
      .maybeSingle();
    const o = order as { property_id?: unknown; assigned_property_id?: unknown } | null;
    const workspaceId = await resolveWorkspaceForProperty(ctx.db, str(o?.assigned_property_id) || str(o?.property_id) || null, ctx.landlordId);
    return payoutLinkForTexter(ctx.db, {
      userId: vendorUserId,
      targetType: "vendor",
      workspaceId,
      phone,
      // The session's phone is the one that texted; the profile must agree that it is this vendor's verified number.
      phoneVerified: Boolean(p?.phone_verified_at) && digits(str(p?.phone)) === digits(phone),
      payoutsEnabled: p?.stripe_connect_payouts_enabled === true,
    });
  },
});

function digits(value: string): string {
  return value.replace(/\D/g, "").slice(-10);
}

export const managerOpsTools = [
  listToursOnDayTool,
  listUnpaidRentTool,
  getApplicationReviewLinkTool,
  broadcastToResidentsTool,
  managerSetUpPayoutsTool,
];

