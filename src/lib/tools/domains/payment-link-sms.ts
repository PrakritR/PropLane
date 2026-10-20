/**
 * `send_payment_link` for the leasing SMS surface, in its own module so the link tools stay a small, separately
 * mockable file.
 */
import { z } from "zod";
import { defineTool } from "../registry";
import type { AgentContext } from "../context";
import type { HouseholdCharge } from "@/lib/household-charges";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { findPhoneOwnedResidentId } from "@/lib/short-stay/guest-login.server";
import { mintLinkForTexter } from "./one-number-links";

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim());

const DESCRIPTION_TAIL =
  " Put the returned url in your reply, once, on its own line. If requiresCode is true, add one short line that a code will be texted to this number when they open it. The link only works for this number. Never type a URL from memory.";

// ---- leasing SMS: "send me the payment link" --------------------------------------------------

export type SendPaymentLinkResult =
  | {
      ok: true;
      url: string;
      requiresCode: true;
      expires: string;
      charges: Array<{ title: string; amount: string; property: string }>;
      total: string | null;
    }
  | { ok: false; error: "links_unavailable" | "nothing_to_link" | "rate_limited" };

const dollarCents = (label: string): number | null => {
  const m = /^\$\s*([\d,]+(?:\.\d{1,2})?)$/.exec(label.trim());
  return m ? Math.round(Number(m[1]!.replace(/,/g, "")) * 100) : null;
};

/**
 * "Send me the payment link": a short-stay guest with a confirmed stay, or an applicant whose approval
 * raised a deposit or first-month charge, texts the line and gets the phone-bound pay link for what they owe.
 * Identity is the TEXTING phone, resolved to the login that phone provably owns (the guest placeholder it
 * minted, or the one account whose VERIFIED phone it is); the charges are that login's own open ones and the
 * page re-derives all of it again. The reply names each charge and its exact amount from the rows.
 */
export const leasingSendPaymentLinkTool = defineTool<Record<string, never>, SendPaymentLinkResult, AgentContext>({
  name: "send_payment_link",
  description:
    "Send the texter a secure link, tied to their own phone number, to pay what they owe now: a confirmed short stay, or a deposit, first month or application charge on an approved application. Use for 'send me the payment link', 'how do I pay', 'pay my deposit'. Name each charge with its exact amount from the result, then put the url on its own line, and add that a code is texted when they open it. If nothing_to_link, say nothing is waiting for payment yet and that you will text the link as soon as it is ready." +
    DESCRIPTION_TAIL,
  kind: "read",
  inputSchema: z.object({}).strict(),
  handler: async (ctx): Promise<SendPaymentLinkResult> => {
    const scope = ctx.leasingScope;
    if (!scope || scope.channel !== "sms" || !scope.prospectPhoneE164 || scope.testActorUserId) return { ok: false, error: "links_unavailable" };
    const phone = normalizeE164(scope.prospectPhoneE164);
    if (!phone) return { ok: false, error: "nothing_to_link" };
    const userId = await findPhoneOwnedResidentId(ctx.db, phone);
    if (!userId) return { ok: false, error: "nothing_to_link" };

    const { data } = await ctx.db
      .from("portal_household_charge_records")
      .select("id, manager_user_id, status, row_data")
      .eq("resident_user_id", userId)
      .in("status", ["pending", "failed"])
      .limit(60);
    const now = Date.now();
    const rows = ((data ?? []) as Array<{ id: string; manager_user_id?: string | null; row_data?: HouseholdCharge | null }>).filter((row) => {
      const charge = row.row_data;
      if (!charge?.id || str(charge.id).includes(",")) return false;
      const visibleAt = Date.parse(str((charge as { residentVisibleAt?: unknown }).residentVisibleAt));
      return !Number.isFinite(visibleAt) || visibleAt <= now;
    });
    if (rows.length === 0) return { ok: false, error: "nothing_to_link" };

    // One workspace per link; only homes this line may speak for: PropLane-managed workspaces, or this number's own.
    const byWorkspace = new Map<string, typeof rows>();
    for (const row of rows) {
      const workspaceId = await resolveWorkspaceForProperty(ctx.db, str(row.row_data?.propertyId) || null, str(row.manager_user_id));
      if (!workspaceId) continue;
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), row]);
    }
    let chosen: { workspaceId: string; rows: typeof rows } | null = null;
    for (const [workspaceId, group] of byWorkspace) {
      const { data: ws } = await ctx.db.from("portal_workspaces").select("is_service").eq("id", workspaceId).maybeSingle();
      const allowed = (ws as { is_service?: unknown } | null)?.is_service === true || group.every((row) => str(row.manager_user_id) === ctx.landlordId);
      if (allowed) {
        chosen = { workspaceId, rows: group.slice(0, 10) };
        break;
      }
    }
    if (!chosen) return { ok: false, error: "nothing_to_link" };

    const minted = await mintLinkForTexter(ctx.db, {
      workspaceId: chosen.workspaceId,
      phone,
      purpose: "rent",
      targetType: "charge",
      targetId: chosen.rows.map((row) => row.id).join(","),
      createdBy: null,
      allowPerWorkspace: true,
    });
    if (!minted.ok) return { ok: false, error: minted.error === "rate_limited" ? "rate_limited" : "links_unavailable" };
    const charges = chosen.rows.map((row) => ({
      title: str(row.row_data?.title) || "Charge",
      amount: str(row.row_data?.balanceLabel) || str(row.row_data?.amountLabel),
      property: str(row.row_data?.propertyLabel),
    }));
    const cents = charges.map((c) => dollarCents(c.amount));
    const total = cents.every((c): c is number => c !== null)
      ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents.reduce((a, b) => a + b, 0) / 100)
      : null;
    return { ok: true, url: minted.url, requiresCode: true, expires: minted.expires, charges, total };
  },
});
