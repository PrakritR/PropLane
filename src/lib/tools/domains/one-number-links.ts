/**
 * `send_my_link`: the agent hands the texter a phone-bound link ("send my rent link", "resend
 * application", "job link"). One tool per surface, one core:
 *
 *   resident SMS   rent / move_in / lease      (ResidentAgentContext)
 *   leasing SMS    gallery / tour / application (AgentContext + leasingScope)
 *   vendor SMS     job                          (AgentContext + vendorScope)
 *
 * Why this is a read tool and not a write: it sends nothing. It mints a link bound to the phone
 * that is TEXTING (read from the verified session/identity, never from the model), and the agent's
 * reply, which goes to that same phone, carries the URL. No third party is contacted, no money
 * moves, nothing is shown that the texter could not already open, and re-asking replaces the
 * previous link instead of stacking them. The mint is rate-limited per phone.
 *
 * Flag safety: nothing is minted unless the workspace is on the shared line; in `per_workspace`
 * mode every call answers `links_unavailable` and the agent falls back to the existing link tools.
 */
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { defineTool, type ToolDefinition, type ToolRegistry } from "../registry";
import type { AgentContext } from "../context";
import type { ResidentAgentContext } from "../resident-context";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { PHONE_BOUND_LINK_POLICY, type PhoneBoundLinkPurpose } from "@/lib/one-number/contracts";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { mintPhoneBoundLink, PhoneBoundLinkError } from "@/lib/one-number/links.server";
import { normalizeConsentPhone } from "@/lib/sms-consent";
import type { HouseholdCharge } from "@/lib/household-charges";
import { loadOwnCharges } from "./resident/balance";
import { resolveLiveListingForSms } from "./leasing-sms";

export type SendMyLinkResult =
  | { ok: true; url: string; purpose: PhoneBoundLinkPurpose; requiresCode: boolean; expires: string }
  | { ok: false; error: "links_unavailable" | "nothing_to_link" | "not_found" | "rate_limited" };

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

function expiryLabel(purpose: PhoneBoundLinkPurpose): string {
  const ttl = PHONE_BOUND_LINK_POLICY[purpose].ttlHours;
  if (ttl === "until_closed") return "until the job closes";
  const days = Math.round(ttl / 24);
  return `${days} days`;
}

/** The shared mint path every surface goes through. */
export async function mintLinkForTexter(
  db: SupabaseClient,
  input: {
    workspaceId: string | null;
    phone: string;
    purpose: PhoneBoundLinkPurpose;
    targetType: string;
    targetId: string;
    createdBy: string | null;
    /**
     * Mint even when the workspace is not on the shared line (per_workspace mode, or a workspace with a number of its
     * own). Only a caller that has already bound the workspace to the texter passes this: the resident tool, whose
     * charges come from the owner the resident's verified phone is linked to. The link is the same phone-bound
     * `/l/<token>` with the same code step; the code is texted from that workspace's own work number.
     */
    allowPerWorkspace?: boolean;
  },
): Promise<SendMyLinkResult> {
  const phoneKey = normalizeConsentPhone(input.phone);
  if (!input.workspaceId || !/^\d{10}$/.test(phoneKey)) return { ok: false, error: "nothing_to_link" };
  const config = await loadSharedLineConfig(db);
  if (!workspaceOnSharedLine(config, input.workspaceId) && !input.allowPerWorkspace) return { ok: false, error: "links_unavailable" };
  try {
    const minted = await mintPhoneBoundLink(db, {
      phoneKey,
      workspaceId: input.workspaceId,
      purpose: input.purpose,
      targetType: input.targetType,
      targetId: input.targetId,
      createdBy: input.createdBy,
    });
    return {
      ok: true,
      url: minted.url,
      purpose: input.purpose,
      requiresCode: PHONE_BOUND_LINK_POLICY[input.purpose].requiresOtp,
      expires: expiryLabel(input.purpose),
    };
  } catch (error) {
    if (error instanceof PhoneBoundLinkError && error.code === "rate_limited") return { ok: false, error: "rate_limited" };
    return { ok: false, error: "links_unavailable" };
  }
}

/**
 * Add `send_my_link` to a surface's registry ONLY while the line is shared (`shared` mode). In
 * `per_workspace` and `shadow` the registry is returned untouched, so those surfaces keep exactly
 * today's tool set. One `sms_runtime_config` read, failing closed to "unchanged".
 */
export async function withSendMyLinkTool<Ctx>(
  db: SupabaseClient,
  registry: ToolRegistry<Ctx>,
  tool: ToolDefinition<any, any, Ctx>, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<ToolRegistry<Ctx>> {
  if (registry.has(tool.name)) return registry;
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return registry;
  const next: ToolRegistry<Ctx> = new Map(registry);
  next.set(tool.name, tool);
  return next;
}

/**
 * The resident's `send_my_link` on every line mode. A resident's rent link is bound to their verified phone and
 * unlocked by a texted code, so it needs no shared line: in per_workspace mode it is minted for the workspace of the
 * number they texted (or, on the PropLane line, the workspace that holds their lease) and the code comes from that
 * workspace's own work number. The tool itself refuses anything but an SMS turn with a verified phone.
 */
export function withResidentSendMyLinkTool<Ctx>(
  registry: ToolRegistry<Ctx>,
  tool: ToolDefinition<any, any, Ctx>, // eslint-disable-line @typescript-eslint/no-explicit-any
): ToolRegistry<Ctx> {
  if (registry.has(tool.name)) return registry;
  const next: ToolRegistry<Ctx> = new Map(registry);
  next.set(tool.name, tool);
  return next;
}

/** Several shared-line tools at once (one `sms_runtime_config` read); same flag rule as `withSendMyLinkTool`. */
export async function withSharedLineTools<Ctx>(
  db: SupabaseClient,
  registry: ToolRegistry<Ctx>,
  tools: ReadonlyArray<ToolDefinition<any, any, Ctx>>, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<ToolRegistry<Ctx>> {
  const missing = tools.filter((tool) => !registry.has(tool.name));
  if (missing.length === 0) return registry;
  const config = await loadSharedLineConfig(db);
  if (config.mode !== "shared") return registry;
  const next: ToolRegistry<Ctx> = new Map(registry);
  for (const tool of missing) next.set(tool.name, tool);
  return next;
}

const DESCRIPTION_TAIL =
  " Put the returned url in your reply, once, on its own line. If requiresCode is true, add one short line that a code will be texted to this number when they open it. The link only works for this number. Never type a URL from memory.";

// ---- resident SMS --------------------------------------------------------------------------

const RESIDENT_PURPOSES = ["rent", "move_in", "lease"] as const;

async function residentVerifiedPhone(ctx: ResidentAgentContext): Promise<string | null> {
  const { data } = await ctx.db.from("profiles").select("phone, phone_verified_at").eq("id", ctx.userId).maybeSingle();
  const row = data as { phone?: unknown; phone_verified_at?: unknown } | null;
  if (!row?.phone_verified_at) return null;
  return str(row.phone) || null;
}

export const residentSendMyLinkTool = defineTool<
  { purpose: (typeof RESIDENT_PURPOSES)[number] },
  SendMyLinkResult,
  ResidentAgentContext
>({
  name: "send_my_link",
  description:
    "Get a secure link, tied to the resident's own phone number, for what they asked to open: rent (pay their open charge by card), move_in (the move-in checklist) or lease (sign or read the lease). Use for 'send my rent link' and similar. Only available while texting." +
    DESCRIPTION_TAIL,
  kind: "read",
  inputSchema: z.object({ purpose: z.enum(RESIDENT_PURPOSES) }).strict(),
  handler: async (ctx, input) => {
    if (ctx.channel !== "sms" || !ctx.activeManagerId) return { ok: false, error: "links_unavailable" };
    const phone = await residentVerifiedPhone(ctx);
    if (!phone) return { ok: false, error: "nothing_to_link" };

    if (input.purpose === "rent") {
      const open = (await loadOwnCharges(ctx)).filter(
        (c: HouseholdCharge) => (c.status === "pending" || c.status === "failed" || c.status === "partially_paid") && !str(c.id).includes(","),
      );
      if (open.length === 0) return { ok: false, error: "nothing_to_link" };
      // One workspace per link: the first open charge decides it, the rest must share it.
      const workspaceId = await resolveWorkspaceForProperty(ctx.db, str(open[0]!.propertyId) || null, ctx.activeManagerId);
      const sameWorkspace: HouseholdCharge[] = [];
      for (const charge of open) {
        const w = await resolveWorkspaceForProperty(ctx.db, str(charge.propertyId) || null, ctx.activeManagerId);
        if (w === workspaceId) sameWorkspace.push(charge);
        if (sameWorkspace.length >= 10) break;
      }
      return mintLinkForTexter(ctx.db, {
        workspaceId,
        phone,
        purpose: "rent",
        targetType: "charge",
        targetId: sameWorkspace.map((c) => c.id).join(","),
        createdBy: ctx.userId,
        allowPerWorkspace: true,
      });
    }

    const workspaceId = await resolveWorkspaceForProperty(ctx.db, null, ctx.activeManagerId);
    return mintLinkForTexter(ctx.db, {
      workspaceId,
      phone,
      purpose: input.purpose,
      targetType: "resident",
      targetId: ctx.userId,
      createdBy: ctx.userId,
      allowPerWorkspace: true,
    });
  },
});

// ---- leasing SMS (prospects) ----------------------------------------------------------------

const PROSPECT_PURPOSES = ["gallery", "tour", "application"] as const;

export const leasingSendMyLinkTool = defineTool<
  { purpose: (typeof PROSPECT_PURPOSES)[number]; propertyId: string },
  SendMyLinkResult,
  AgentContext
>({
  name: "send_my_link",
  description:
    "Get a link tied to the prospect's own phone number for a matched listing: gallery (photos and details, no code), tour (pick a time, no code) or application (the application, prefilled with their number; a code is texted first). Use to send or resend the application, the tour page or the photos." +
    DESCRIPTION_TAIL,
  kind: "read",
  inputSchema: z.object({ purpose: z.enum(PROSPECT_PURPOSES), propertyId: z.string().min(1).max(200) }).strict(),
  handler: async (ctx, input) => {
    const scope = ctx.leasingScope;
    if (!scope || scope.channel !== "sms" || !scope.prospectPhoneE164) return { ok: false, error: "links_unavailable" };
    // The same live-listing check get_listing_link / build_prospect_links use.
    const listingId = await resolveLiveListingForSms(ctx, input.propertyId);
    if (!listingId) return { ok: false, error: "not_found" };
    const workspaceId = await resolveWorkspaceForProperty(ctx.db, listingId, ctx.landlordId);
    return mintLinkForTexter(ctx.db, {
      workspaceId,
      phone: scope.prospectPhoneE164,
      purpose: input.purpose,
      targetType: "listing",
      targetId: listingId,
      createdBy: null,
    });
  },
});

// ---- vendor SMS -----------------------------------------------------------------------------

export const vendorSendMyLinkTool = defineTool<{ purpose: "job" }, SendMyLinkResult, AgentContext>({
  name: "send_my_link",
  description:
    "Get a link tied to the vendor's own phone number that opens THIS job (no code). Use for 'job link' and 'send me the details'." +
    DESCRIPTION_TAIL,
  kind: "read",
  inputSchema: z.object({ purpose: z.literal("job") }).strict(),
  handler: async (ctx) => {
    const scope = ctx.vendorScope;
    if (!scope) return { ok: false, error: "links_unavailable" };
    // The phone is the one this session was opened for; the work order is the session's own.
    const { data: session } = await ctx.db
      .from("agent_sessions")
      .select("vendor_phone_e164, landlord_id, work_order_id")
      .eq("id", scope.sessionId)
      .maybeSingle();
    const row = session as { vendor_phone_e164?: unknown; landlord_id?: unknown; work_order_id?: unknown } | null;
    const phone = str(row?.vendor_phone_e164);
    if (!row || str(row.landlord_id) !== ctx.landlordId || str(row.work_order_id) !== scope.workOrderId || !phone) {
      return { ok: false, error: "nothing_to_link" };
    }
    const { data: order } = await ctx.db
      .from("portal_work_order_records")
      .select("property_id, assigned_property_id")
      .eq("id", scope.workOrderId)
      .eq("manager_user_id", ctx.landlordId)
      .maybeSingle();
    if (!order) return { ok: false, error: "not_found" };
    const propertyId = str((order as Record<string, unknown>).assigned_property_id) || str((order as Record<string, unknown>).property_id);
    const workspaceId = await resolveWorkspaceForProperty(ctx.db, propertyId || null, ctx.landlordId);
    return mintLinkForTexter(ctx.db, {
      workspaceId,
      phone,
      purpose: "job",
      targetType: "work_order",
      targetId: scope.workOrderId,
      createdBy: null,
    });
  },
});
