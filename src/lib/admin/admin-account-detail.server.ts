import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { pickBestManagerPurchaseRow } from "@/lib/manager-access";
import { likeLiteral } from "@/lib/admin/admin-accounts.server";
import { isPortalSandboxEmail } from "@/lib/portal-sandbox-accounts";
import { adminAiTracesUrl, adminSessionReplaysUrl } from "@/lib/admin/admin-external-links";

/**
 * Everything the admin account record shows, in one read. Never carries
 * password hashes, tokens, provider secrets or raw Stripe account ids — a
 * connected account is reported as linked / not linked only. The id is a path
 * parameter, so the caller must already have verified it is a UUID and that
 * the profile exists.
 */
export type AdminAccountDetail = {
  id: string;
  email: string;
  fullName: string;
  phone: string;
  propLaneId: string;
  roles: string[];
  status: "active" | "disabled";
  createdAt: string | null;
  lastSignInAt: string | null;
  emailConfirmed: boolean;
  /** Managers only — the RAW stored plan SKU the billing editor edits. */
  manager: { tier: string; billing: string } | null;
  workspaces: {
    owned: {
      id: string;
      name: string;
      isDefault: boolean;
      createdAt: string | null;
      payoutsEnabled: boolean | null;
    }[];
    links: {
      id: string;
      relation: "inviter" | "invitee";
      counterpartName: string;
      tabKind: string;
      propertyCount: number;
      since: string | null;
    }[];
  };
  payments: {
    connectLinked: boolean;
    payouts: {
      id: string;
      status: string;
      amountCents: number;
      arrivalDate: string | null;
      failureMessage: string | null;
      createdAt: string | null;
    }[];
    disputes: {
      id: string;
      status: string;
      amountCents: number;
      reason: string | null;
      createdAt: string | null;
    }[];
  };
  communications: {
    id: string;
    channel: "sms" | "email";
    at: string | null;
    /** Provider-reported state: delivered, failed, sent, … */
    status: string;
    errorCode: string | null;
    summary: string;
  }[];
  audit: {
    id: string;
    action: string;
    toolName: string | null;
    createdAt: string | null;
    /** True when this account itself took the action (otherwise it was done on its behalf). */
    byAccount: boolean;
  }[];
  support: {
    feedback: { id: string; reportType: string; title: string; status: string; createdAt: string | null }[];
    sessionReplaysUrl: string | null;
    aiTracesUrl: string | null;
  };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isAdminAccountId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

function maskPhone(phone: string | null | undefined): string {
  const digits = String(phone ?? "").replace(/\D+/g, "");
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : "•••";
}

type Row = Record<string, unknown>;
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const num = (value: unknown): number => (typeof value === "number" ? value : Number(value) || 0);

export async function loadAdminAccountDetail(db: SupabaseClient, id: string): Promise<AdminAccountDetail | null> {
  const { data: profile } = await db
    .from("profiles")
    .select("id, email, full_name, phone, manager_id, role, application_approved, created_at, stripe_connect_account_id")
    .eq("id", id)
    .maybeSingle();
  if (!profile) return null;
  const p = profile as Row;
  const email = str(p.email);
  // Demo/sandbox accounts are hidden from every real admin view, so a record URL for one is a 404 too.
  if (isPortalSandboxEmail(email)) return null;

  const [roleRes, authRes, purchasesById, purchasesByEmail, wsRes, linkRes, payoutRes, disputeRes] =
    await Promise.all([
      db.from("profile_roles").select("role").eq("user_id", id),
      db.auth.admin.getUserById(id).catch(() => ({ data: null })),
      db
        .from("manager_purchases")
        .select("id, tier, billing, paid_at, user_id, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id")
        .eq("user_id", id),
      email
        ? db
            .from("manager_purchases")
            .select("id, tier, billing, paid_at, user_id, stripe_customer_id, stripe_subscription_id, stripe_checkout_session_id")
            .eq("email", email)
        : Promise.resolve({ data: [] as Row[] }),
      db
        .from("portal_workspaces")
        .select("id, name, is_default, created_at, stripe_connect_payouts_enabled")
        .eq("owner_user_id", id)
        .order("created_at", { ascending: true }),
      db
        .from("account_link_invites")
        .select(
          "id, inviter_user_id, invitee_user_id, tab_kind, inviter_display_name, invitee_display_name, assigned_property_ids, responded_at",
        )
        .eq("status", "accepted")
        .or(`inviter_user_id.eq.${id},invitee_user_id.eq.${id}`)
        .limit(50),
      db
        .from("stripe_payouts")
        .select("id, status, amount_cents, arrival_date, failure_message, created_at")
        .eq("manager_user_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
      db
        .from("stripe_disputes")
        .select("id, status, amount_cents, reason, created_at")
        .eq("manager_user_id", id)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);

  const roles = new Set<string>(((roleRes.data ?? []) as Row[]).map((r) => str(r.role)).filter(Boolean));
  const legacyRole = str(p.role);
  if (legacyRole) roles.add(legacyRole);

  const authUser = (authRes as { data: { user?: { last_sign_in_at?: string | null; email_confirmed_at?: string | null } | null } | null }).data?.user;

  // Plan: same purchase picker the Accounts list uses, so the raw SKU matches.
  const purchaseMap = new Map<string, Row>();
  for (const row of [...((purchasesById.data ?? []) as Row[]), ...((purchasesByEmail.data ?? []) as Row[])]) {
    purchaseMap.set(str(row.id), row);
  }
  const purchase = roles.has("manager")
    ? pickBestManagerPurchaseRow(
        [...purchaseMap.values()].map((r) => ({
          id: str(r.id),
          tier: strOrNull(r.tier),
          billing: strOrNull(r.billing),
          paid_at: strOrNull(r.paid_at),
          user_id: strOrNull(r.user_id),
          stripe_customer_id: strOrNull(r.stripe_customer_id),
          stripe_subscription_id: strOrNull(r.stripe_subscription_id),
          stripe_checkout_session_id: strOrNull(r.stripe_checkout_session_id),
        })),
        id,
      )
    : null;

  // Workspaces: the Connect columns arrive in a later migration — if the
  // database predates them, read the base columns instead of failing the record.
  let workspaceRows = (wsRes.data ?? []) as Row[];
  let payoutsKnown = !wsRes.error;
  if (wsRes.error) {
    const fallback = await db
      .from("portal_workspaces")
      .select("id, name, is_default, created_at")
      .eq("owner_user_id", id)
      .order("created_at", { ascending: true });
    workspaceRows = (fallback.data ?? []) as Row[];
    payoutsKnown = false;
  }

  const links = ((linkRes.data ?? []) as Row[]).map((row) => {
    const relation: "inviter" | "invitee" = str(row.inviter_user_id) === id ? "inviter" : "invitee";
    return {
      id: str(row.id),
      relation,
      counterpartName: str(relation === "inviter" ? row.invitee_display_name : row.inviter_display_name) || "Linked account",
      tabKind: str(row.tab_kind),
      propertyCount: Array.isArray(row.assigned_property_ids) ? row.assigned_property_ids.length : 0,
      since: strOrNull(row.responded_at),
    };
  });

  // Communication log: SMS this account sent or received, plus email addressed to it.
  const [smsLogRes, smsOutboxRes, mailRes] = await Promise.all([
    db
      .from("sms_delivery_log")
      .select("id, to_phone, status, error_code, created_at")
      .eq("manager_user_id", id)
      .order("created_at", { ascending: false })
      .limit(30),
    db
      .from("sms_outbox")
      .select("id, recipient_phone, purpose, status, provider_error_code, created_at")
      .eq("recipient_user_id", id)
      .order("created_at", { ascending: false })
      .limit(30),
    email
      ? db
          .from("portal_outbound_mail_records")
          .select("id, recipient_email, subject, created_at, emailSent:row_data->>emailSent")
          .ilike("recipient_email", likeLiteral(email))
          .order("created_at", { ascending: false })
          .limit(30)
      : Promise.resolve({ data: [] as Row[] }),
  ]);

  const communications: AdminAccountDetail["communications"] = [
    ...((smsLogRes.data ?? []) as Row[]).map((r) => ({
      id: `log-${str(r.id)}`,
      channel: "sms" as const,
      at: strOrNull(r.created_at),
      status: str(r.status) || "unknown",
      errorCode: strOrNull(r.error_code),
      summary: `Text to ${maskPhone(str(r.to_phone))}`,
    })),
    ...((smsOutboxRes.data ?? []) as Row[]).map((r) => ({
      id: `outbox-${str(r.id)}`,
      channel: "sms" as const,
      at: strOrNull(r.created_at),
      status: str(r.status) || "unknown",
      errorCode: strOrNull(r.provider_error_code),
      summary: `${str(r.purpose).replace(/_/g, " ") || "Text"} to ${maskPhone(str(r.recipient_phone))}`,
    })),
    ...((mailRes.data ?? []) as unknown as Row[])
      // One account's log is only its own mail: the pattern above narrows the
      // read, this decides it.
      .filter((r) => str(r.recipient_email).trim().toLowerCase() === email.toLowerCase())
      .map((r) => ({
        id: `mail-${str(r.id)}`,
        channel: "email" as const,
        at: strOrNull(r.created_at),
        status: str(r.emailSent) === "false" ? "not emailed" : "sent",
        errorCode: null,
        summary: str(r.subject) || "Email",
      })),
  ]
    .sort((a, b) => (Date.parse(b.at ?? "") || 0) - (Date.parse(a.at ?? "") || 0))
    .slice(0, 50);

  const [auditRes, feedbackRes] = await Promise.all([
    db
      .from("audit_log")
      .select("id, actor_user_id, landlord_id, action, tool_name, created_at")
      .or(`actor_user_id.eq.${id},landlord_id.eq.${id}`)
      .order("created_at", { ascending: false })
      .limit(50),
    db
      .from("portal_bug_feedback_records")
      .select("id, report_type, created_at, title:row_data->>title, status:row_data->>status")
      .eq("reporter_user_id", id)
      .order("created_at", { ascending: false })
      .limit(20),
  ]);

  return {
    id,
    email,
    fullName: str(p.full_name),
    phone: str(p.phone),
    propLaneId: str(p.manager_id),
    roles: [...roles].sort(),
    status: p.application_approved === false ? "disabled" : "active",
    createdAt: strOrNull(p.created_at),
    lastSignInAt: authUser?.last_sign_in_at ?? null,
    emailConfirmed: Boolean(authUser?.email_confirmed_at),
    manager: roles.has("manager") ? { tier: purchase?.tier ?? "free", billing: purchase?.billing ?? "free" } : null,
    workspaces: {
      owned: workspaceRows.map((row) => ({
        id: str(row.id),
        name: str(row.name),
        isDefault: row.is_default === true,
        createdAt: strOrNull(row.created_at),
        payoutsEnabled: payoutsKnown ? row.stripe_connect_payouts_enabled === true : null,
      })),
      links,
    },
    payments: {
      connectLinked: Boolean(str(p.stripe_connect_account_id).trim()),
      payouts: ((payoutRes.data ?? []) as Row[]).map((r) => ({
        id: str(r.id),
        status: str(r.status),
        amountCents: num(r.amount_cents),
        arrivalDate: strOrNull(r.arrival_date),
        failureMessage: strOrNull(r.failure_message),
        createdAt: strOrNull(r.created_at),
      })),
      disputes: ((disputeRes.data ?? []) as Row[]).map((r) => ({
        id: str(r.id),
        status: str(r.status),
        amountCents: num(r.amount_cents),
        reason: strOrNull(r.reason),
        createdAt: strOrNull(r.created_at),
      })),
    },
    communications,
    audit: ((auditRes.data ?? []) as Row[]).map((r) => ({
      id: str(r.id),
      action: str(r.action),
      toolName: strOrNull(r.tool_name),
      createdAt: strOrNull(r.created_at),
      byAccount: str(r.actor_user_id) === id,
    })),
    support: {
      feedback: ((feedbackRes.data ?? []) as unknown as Row[]).map((r) => ({
        id: str(r.id),
        reportType: str(r.report_type) || "bug",
        title: str(r.title) || "Untitled",
        status: str(r.status) || "open",
        createdAt: strOrNull(r.created_at),
      })),
      sessionReplaysUrl: adminSessionReplaysUrl(id),
      aiTracesUrl: adminAiTracesUrl(id),
    },
  };
}
