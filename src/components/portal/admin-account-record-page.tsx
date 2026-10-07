"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Trash2, UserCheck, UserX } from "lucide-react";
import { PortalRecordDetailPage, PortalRecordActions } from "@/components/portal/portal-record-detail-page";
import { PortalRecordSectionChrome } from "@/components/portal/portal-record-section-chrome";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalDataTableEmpty } from "@/components/portal/portal-data-table";
import { AdminViewAsAction } from "@/components/portal/admin-view-as-action";
import { useAdminAccountActions } from "@/components/portal/use-admin-account-actions";
import {
  AccountAuditSection,
  AccountBillingSection,
  AccountCommunicationSection,
  AccountOverviewSection,
  AccountPaymentsSection,
  AccountSupportSection,
  AccountWorkspacesSection,
  type AdminAccountBillingSummary,
} from "@/components/portal/admin-account-record-sections";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import {
  adminAccountRail,
  adminAccountSectionFromParam,
  adminAccountSectionHref,
  type AdminAccountRowKind,
} from "@/lib/admin/admin-account-keys";
import type { AdminAccountDetail } from "@/lib/admin/admin-account-detail.server";

const FETCH_TIMEOUT_MS = 20_000;

/**
 * An Accounts row's record: header (tile, name, email line, then the View-as
 * slot and the Disable / Delete icons) over a rail of Account · Money ·
 * Activity sections. Everything it shows comes from one read,
 * `GET /api/admin/accounts/<id>`.
 */
export function AdminAccountRecordPage({
  parsed,
  section: sectionParam,
  backHref,
  onDeleted,
}: {
  parsed: { kind: AdminAccountRowKind; id: string } | null;
  section?: string;
  backHref: string;
  onDeleted: () => void;
}) {
  const { showToast } = useAppUi();
  const [detail, setDetail] = useState<AdminAccountDetail | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "missing" | "error">("loading");
  const [reloadTick, setReloadTick] = useState(0);
  const [billing, setBilling] = useState<AdminAccountBillingSummary | undefined>(undefined);

  const kind = parsed?.kind ?? "manager";
  const id = parsed?.id ?? "";
  const reload = useCallback(() => setReloadTick((n) => n + 1), []);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout(`/api/admin/accounts/${encodeURIComponent(id)}`, {}, FETCH_TIMEOUT_MS);
        if (cancelled) return;
        if (res.status === 404) {
          setState("missing");
          return;
        }
        if (!res.ok) {
          setState("error");
          return;
        }
        setDetail((await res.json()) as AdminAccountDetail);
        setState("ready");
      } catch {
        if (!cancelled) setState("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id, reloadTick]);

  // Plan label and comms credit come from the existing manager-billing read.
  useEffect(() => {
    if (kind !== "manager" || !id) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTimeout("/api/admin/manager-billing", {}, FETCH_TIMEOUT_MS);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { rows?: ({ id: string } & AdminAccountBillingSummary)[] };
        const row = data.rows?.find((r) => r.id === id);
        if (!cancelled && row) setBilling({ planLabel: row.planLabel, comms: row.comms });
      } catch {
        // Overview shows "—" for the plan and credit until a reload succeeds.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, id, reloadTick]);

  const { busy, setActive, remove } = useAdminAccountActions(reload);

  const section = adminAccountSectionFromParam(sectionParam, kind);
  const rail = useMemo(() => adminAccountRail(kind), [kind]);
  const railItems = useMemo(
    () =>
      rail.groups.flatMap((g) =>
        g.ids.map((sid) => ({ id: sid, label: rail.labels[sid], href: adminAccountSectionHref(kind, id, sid) })),
      ),
    [rail, kind, id],
  );

  if (!parsed || state === "missing") {
    return (
      <PortalRecordDetailPage title="Account" backHref={backHref} backLabel="Accounts">
        <PortalDataTableEmpty icon="data" message="Account not found" />
      </PortalRecordDetailPage>
    );
  }
  if (state === "error") {
    return (
      <PortalRecordDetailPage title="Account" backHref={backHref} backLabel="Accounts">
        <PortalDataTableEmpty icon="data" message="Could not load this account" />
      </PortalRecordDetailPage>
    );
  }
  if (state === "loading" || !detail) {
    return (
      <PortalRecordDetailPage title="Account" backHref={backHref} backLabel="Accounts">
        <PortalDataTableEmpty icon="data" message="Loading…" />
      </PortalRecordDetailPage>
    );
  }

  const name = detail.fullName || detail.email;
  const active = detail.status === "active";

  const body = (() => {
    switch (section) {
      case "workspaces":
        return <AccountWorkspacesSection detail={detail} />;
      case "billing":
        return <AccountBillingSection detail={detail} onRefresh={reload} showToast={showToast} />;
      case "payments":
        return <AccountPaymentsSection detail={detail} />;
      case "communication":
        return <AccountCommunicationSection detail={detail} />;
      case "audit":
        return <AccountAuditSection detail={detail} />;
      case "support":
        return <AccountSupportSection detail={detail} />;
      default:
        return <AccountOverviewSection detail={detail} kind={kind} billing={billing} />;
    }
  })();

  return (
    <PortalRecordDetailPage
      title={name}
      subtitle={detail.email}
      avatarName={name}
      backHref={backHref}
      backLabel="Accounts"
      iconTitleActions
      actions={
        <PortalRecordActions>
          {/* SLOT: the View-as button. Owned by the View-as change; first in the header. */}
          <AdminViewAsAction account={{ id: detail.id, kind, email: detail.email, name, active }} />
          <PortalIconAction
            ring
            icon={active ? UserX : UserCheck}
            label={active ? "Disable account" : "Enable account"}
            disabled={busy}
            data-attr="admin-account-toggle-active"
            onClick={() => void setActive(kind, detail.id, !active)}
          />
          <PortalIconAction
            ring
            tone="danger"
            icon={Trash2}
            label="Delete account"
            disabled={busy}
            data-attr="admin-account-delete"
            onClick={() =>
              void remove(kind, detail.id, name).then((deleted) => {
                if (deleted) onDeleted();
              })
            }
          />
        </PortalRecordActions>
      }
    >
      <PortalRecordSectionChrome
        items={railItems}
        activeId={section}
        groups={rail.groups.map((g) => ({ label: g.label, ids: [...g.ids] }))}
        title={name}
        subtitle={detail.email}
        backHref={backHref}
        backLabel="Accounts"
        ariaLabel="Account sections"
        currentLabel={rail.labels[section]}
      >
        <div className="flex flex-col gap-4 px-4 py-4 sm:px-6 lg:px-0" data-attr={`admin-account-section-${section}`}>
          {body}
        </div>
      </PortalRecordSectionChrome>
    </PortalRecordDetailPage>
  );
}
