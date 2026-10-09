"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { RecordFactCard, RecordFactRow, RecordRowsCard } from "@/components/portal/portal-record-overview-kit";
import { ManagerBillingCards } from "@/components/portal/admin-manager-account-detail";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import type { AdminAccountBilling } from "@/lib/admin/admin-account-billing.server";
import { formatPacificDate, formatPacificDateTime } from "@/lib/pacific-time";
import { ADMIN_ACCOUNT_ROLE_LABEL, type AdminAccountRowKind } from "@/lib/admin/admin-account-keys";
import type { AdminAccountDetail } from "@/lib/admin/admin-account-detail.server";

/** The wallet facts `/api/admin/manager-billing` derives for one manager (read-only). */
export type AdminAccountBillingSummary = {
  planLabel: string;
  comms: { allowanceCents: number | null; remainingCents: number | null; exhausted: boolean } | null;
};

/** `$12.34 left`, `No credit left`, or undefined for a free plan / unread wallet. */
export function commsCreditLabel(summary: AdminAccountBillingSummary | undefined): string | undefined {
  const comms = summary?.comms;
  if (!comms || comms.allowanceCents === null) return undefined;
  if (comms.exhausted) return "No credit left";
  if (comms.remainingCents === null) return "Unlimited";
  return `$${(comms.remainingCents / 100).toFixed(2)} left`;
}

const dateOnly = (iso: string | null) =>
  iso ? formatPacificDate(iso, { year: "numeric", month: "short", day: "numeric" }) : "—";
const dateTime = (iso: string | null) => (iso ? formatPacificDateTime(iso) : "—");
const money = (cents: number) =>
  `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const words = (value: string) => value.replace(/_/g, " ");
const sentence = (value: string) => {
  const w = words(value);
  return w ? w.charAt(0).toUpperCase() + w.slice(1) : w;
};

/** A failed-looking status is the one thing on a row drawn red. */
function Status({ value, bad }: { value: string; bad?: boolean }) {
  return <span className={bad ? "text-[13px] text-[var(--status-overdue-fg)]" : "text-[13px] text-muted"}>{value}</span>;
}
const BAD_STATUS = /fail|undeliver|reject|error|lost|needs_response|blocked|not emailed/i;

export function AccountOverviewSection({
  detail,
  kind,
  billing,
}: {
  detail: AdminAccountDetail;
  kind: AdminAccountRowKind;
  billing?: AdminAccountBillingSummary;
}) {
  const comms = commsCreditLabel(billing);
  return (
    <RecordFactCard title="Account" dataAttr="admin-account-overview">
      <RecordFactRow label="Role" value={ADMIN_ACCOUNT_ROLE_LABEL[kind]} />
      {kind === "manager" ? <RecordFactRow label="Plan" value={billing?.planLabel ?? "—"} /> : null}
      <RecordFactRow
        label="Status"
        value={detail.status === "active" ? "Active" : "Disabled"}
        tone={detail.status === "active" ? "ok" : "bad"}
      />
      <RecordFactRow label="PropLane ID" value={detail.propLaneId || "—"} />
      <RecordFactRow label="Email" value={detail.email || "—"} />
      <RecordFactRow
        label="Email confirmed"
        value={detail.emailConfirmed ? "Yes" : "No"}
        tone={detail.emailConfirmed ? "ok" : undefined}
      />
      <RecordFactRow label="Phone" value={detail.phone || "—"} />
      <RecordFactRow label="Joined" value={dateOnly(detail.createdAt)} />
      <RecordFactRow label="Last sign-in" value={detail.lastSignInAt ? dateTime(detail.lastSignInAt) : "Never"} />
      {kind === "manager" ? <RecordFactRow label="Comms credit" value={comms ?? "—"} /> : null}
    </RecordFactCard>
  );
}

export function AccountWorkspacesSection({ detail }: { detail: AdminAccountDetail }) {
  return (
    <>
      <RecordFactCard title="Roles" count={detail.roles.length} dataAttr="admin-account-roles">
        {detail.roles.length === 0 ? (
          <p className="px-[var(--portal-card-padding,14px)] py-5 text-center text-[13px] text-muted">No roles.</p>
        ) : (
          detail.roles.map((role) => <RecordFactRow key={role} label={sentence(role)} value="Granted" />)
        )}
      </RecordFactCard>
      <RecordRowsCard
        title="Workspaces"
        dataAttr="admin-account-workspaces"
        emptyLabel="Owns no workspaces."
        rows={detail.workspaces.owned.map((w) => ({
          id: w.id,
          title: w.name || "Workspace",
          sub: `${w.isDefault ? "Default · " : ""}Created ${dateOnly(w.createdAt)}`,
          figure:
            w.payoutsEnabled === null ? undefined : (
              <Status value={w.payoutsEnabled ? "Payouts on" : "Payouts off"} bad={!w.payoutsEnabled} />
            ),
        }))}
      />
      <RecordRowsCard
        title="Linked accounts"
        dataAttr="admin-account-links"
        emptyLabel="No linked accounts."
        rows={detail.workspaces.links.map((l) => ({
          id: l.id,
          title: l.counterpartName,
          sub: `${l.relation === "inviter" ? "Invited them" : "Invited by them"} · ${l.propertyCount} ${l.propertyCount === 1 ? "property" : "properties"} · ${dateOnly(l.since)}`,
          figure: <Status value={sentence(l.tabKind)} />,
        }))}
      />
    </>
  );
}

/**
 * Billing & plan: Subscription, Trial & discounts and Limits as fact cards, then the payments
 * Stripe has taken from this account. One read (`GET /api/admin/accounts/<id>/billing`) feeds all
 * of it; a change in any popup re-reads the record and this.
 */
export function AccountBillingSection({
  detail,
  onRefresh,
  showToast,
}: {
  detail: AdminAccountDetail;
  onRefresh: () => void;
  showToast: (m: string) => void;
}) {
  const accountId = detail.id;
  const isManager = Boolean(detail.manager);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const action = searchParams?.get("action") ?? null;
  // Drop ?action= once its popup is open so a refresh or a close does not reopen it.
  const clearAction = useCallback(() => {
    const next = new URLSearchParams(searchParams?.toString() ?? "");
    next.delete("action");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [pathname, router, searchParams]);
  const [billing, setBilling] = useState<AdminAccountBilling | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!isManager) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/admin/accounts/${encodeURIComponent(accountId)}/billing`, {}, 20_000);
        if (cancelled) return;
        if (!res.ok) {
          setState("error");
          return;
        }
        setBilling((await res.json()) as AdminAccountBilling);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, isManager, tick]);

  if (!detail.manager) return null;

  const onChanged = () => {
    setTick((n) => n + 1);
    onRefresh();
  };

  return (
    <>
      <ManagerBillingCards
        row={{
          id: detail.id,
          tier: detail.manager.tier,
          active: detail.status === "active",
          joinedAt: detail.createdAt,
        }}
        billing={billing}
        billingState={state}
        onChanged={onChanged}
        showToast={showToast}
        initialAction={action}
        onActionConsumed={clearAction}
      />
      <RecordRowsCard
        title="Payments from this account"
        dataAttr="admin-account-billing-payments"
        emptyLabel={
          state === "loading"
            ? "Loading…"
            : billing && !billing.stripe.available
              ? "Stripe could not be reached."
              : "No payments yet."
        }
        rows={(billing?.payments ?? []).map((p) => ({
          id: p.id,
          title: p.description,
          sub: `${dateOnly(p.at)}${p.number ? ` · ${p.number}` : ""}`,
          figure: <span className="text-[13.5px] font-semibold tabular-nums text-foreground">{money(p.amountCents)}</span>,
          onClick: p.invoiceUrl ? () => window.open(p.invoiceUrl!, "_blank", "noopener,noreferrer") : undefined,
        }))}
      />
    </>
  );
}

export function AccountPaymentsSection({ detail }: { detail: AdminAccountDetail }) {
  const { payments } = detail;
  return (
    <>
      <RecordFactCard title="Stripe Connect" dataAttr="admin-account-connect">
        <RecordFactRow
          label="Payouts"
          value={payments.connectLinked ? "Account linked" : "Not set up"}
          tone={payments.connectLinked ? "ok" : "bad"}
        />
      </RecordFactCard>
      <RecordRowsCard
        title="Recent payouts"
        dataAttr="admin-account-payouts"
        emptyLabel="No payouts."
        rows={payments.payouts.map((p) => ({
          id: p.id,
          title: money(p.amountCents),
          sub: p.failureMessage ?? (p.arrivalDate ? `Arrives ${dateOnly(p.arrivalDate)}` : dateOnly(p.createdAt)),
          figure: <Status value={sentence(p.status)} bad={BAD_STATUS.test(p.status)} />,
        }))}
      />
      <RecordRowsCard
        title="Disputes"
        dataAttr="admin-account-disputes"
        emptyLabel="No disputes."
        rows={payments.disputes.map((d) => ({
          id: d.id,
          title: money(d.amountCents),
          sub: `${d.reason ? `${sentence(d.reason)} · ` : ""}${dateOnly(d.createdAt)}`,
          figure: <Status value={sentence(d.status)} bad={BAD_STATUS.test(d.status)} />,
        }))}
      />
    </>
  );
}

export function AccountCommunicationSection({ detail }: { detail: AdminAccountDetail }) {
  return (
    <RecordRowsCard
      title="Recent messages"
      dataAttr="admin-account-communication"
      emptyLabel="No messages."
      rows={detail.communications.map((c) => ({
        id: c.id,
        title: c.summary,
        sub: `${c.channel === "sms" ? "Text" : "Email"} · ${dateTime(c.at)}`,
        figure: (
          <Status
            value={`${sentence(c.status)}${c.errorCode ? ` · ${c.errorCode}` : ""}`}
            bad={BAD_STATUS.test(c.status) || Boolean(c.errorCode)}
          />
        ),
      }))}
    />
  );
}

export function AccountAuditSection({ detail }: { detail: AdminAccountDetail }) {
  return (
    <RecordRowsCard
      title="Audit trail"
      dataAttr="admin-account-audit"
      emptyLabel="No recorded actions."
      rows={detail.audit.map((a) => ({
        id: a.id,
        title: sentence(a.toolName || a.action),
        sub: dateTime(a.createdAt),
        figure: <Status value={a.byAccount ? "By this account" : "On its behalf"} />,
      }))}
    />
  );
}

export function AccountSupportSection({ detail }: { detail: AdminAccountDetail }) {
  const { support } = detail;
  const links = [
    support.sessionReplaysUrl
      ? { id: "replays", title: "Open session replays in PostHog", href: support.sessionReplaysUrl }
      : null,
    support.aiTracesUrl ? { id: "traces", title: "Open AI traces in Langfuse", href: support.aiTracesUrl } : null,
  ].filter((x): x is { id: string; title: string; href: string } => Boolean(x));
  return (
    <>
      <RecordRowsCard
        title="Feedback"
        dataAttr="admin-account-feedback"
        emptyLabel="No feedback from this account."
        rows={support.feedback.map((f) => ({
          id: f.id,
          title: f.title,
          sub: `${f.reportType === "bug" ? "Bug" : "Feedback"} · ${dateOnly(f.createdAt)}`,
          figure: <Status value={sentence(f.status)} />,
          href: "/admin/bugs-feedback",
        }))}
      />
      {links.length > 0 ? (
        <RecordRowsCard
          title="Tools"
          dataAttr="admin-account-support-links"
          rows={links.map((l) => ({
            id: l.id,
            title: l.title,
            onClick: () => window.open(l.href, "_blank", "noopener,noreferrer"),
          }))}
        />
      ) : null}
    </>
  );
}
