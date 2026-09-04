"use client";

import { Breadcrumbs, type Crumb } from "@/components/layout/breadcrumbs";
import { PortalPropertyFilter } from "@/components/portal/pro-section-shell";
import {
  MANAGER_TABLE_TH,
  PortalKpiTabStrip,
  PORTAL_KPI_LABEL,
  PORTAL_KPI_VALUE,
} from "@/components/portal/portal-metrics";
import { PORTAL_DATA_TABLE, PORTAL_DATA_TABLE_SCROLL,
  PORTAL_DATA_TABLE_WRAP,
  PortalDataTableEmpty,
  PORTAL_TABLE_HEAD_ROW,
  PORTAL_TABLE_TD,
  PORTAL_TABLE_TR,} from "@/components/portal/portal-data-table";
import { PortalListSectionShell, PortalSectionPrimaryButton } from "@/components/portal/portal-list-section";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Toolbar } from "@/components/ui/empty-state";
import type { WorkspaceAction, WorkspaceModel } from "@/lib/portal-workspace-model";
import type { PortalKind } from "@/lib/portal-types";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/input";
import { TabNav, type TabItem } from "@/components/ui/tabs";
import type { ReactNode } from "react";
import { useState } from "react";

function toHeaderActions(
  actions: WorkspaceAction[],
  openModal: (p: { title: string; body: string }) => void,
  showToast: (m: string) => void,
): ReactNode {
  if (!actions.length) return null;

  let primaryPlaced = false;
  return (
    <>
      {actions.map((a) => {
        const label = a.label.trim();
        const isRefresh = /^refresh/i.test(label);
        const isPrimary = !isRefresh && !primaryPlaced;
        if (isPrimary) primaryPlaced = true;

        const onClick = () =>
          a.kind === "modal" ? openModal({ title: label, body: a.message }) : showToast(a.message);

        if (isPrimary) {
          return (
            <PortalSectionPrimaryButton key={a.label} onClick={onClick}>
              {label}
            </PortalSectionPrimaryButton>
          );
        }

        return (
          <Button key={a.label} type="button" variant="outline" onClick={onClick}>
            {label}
          </Button>
        );
      })}
    </>
  );
}

export function PortalWorkspaceClient({
  portalKind,
  portalLabel,
  tabId,
  tabs,
  model,
  breadcrumbs,
}: {
  portalKind?: PortalKind;
  portalLabel: string;
  tabId: string;
  tabs: TabItem[];
  model: WorkspaceModel;
  breadcrumbs: Crumb[];
}) {
  const { showToast, openModal } = useAppUi();
  const isCompactPortalShell =
    portalKind === "admin" || portalKind === "resident" || portalKind === "manager" || portalKind === "pro";
  const useSectionShell = isCompactPortalShell;
  const showToolbar = model.showToolbar !== false;
  const showQuickLinks = model.showQuickLinks !== false;

  const hasTable = Boolean(model.columns && model.rows?.length);
  const [activeKpi, setActiveKpi] = useState(0);

  const legacyKpiGrid =
    !useSectionShell && model.kpis?.length ? (
      <div
        className={
          model.kpis.length === 5
            ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-5"
            : model.kpis.length === 4
              ? "grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
              : model.kpis.length === 2
                ? "grid gap-3 md:grid-cols-2"
                : "grid gap-4 md:grid-cols-3"
        }
      >
        {model.kpis.map((k) => (
          <Card key={k.label} className="border-border bg-card p-5">
            <p className={PORTAL_KPI_VALUE}>{k.value}</p>
            <p className={PORTAL_KPI_LABEL}>{k.label}</p>
            {k.hint ? <p className="mt-2 text-sm text-muted">{k.hint}</p> : null}
          </Card>
        ))}
      </div>
    ) : null;

  const tableContent = hasTable ? (
    <div className={PORTAL_DATA_TABLE_WRAP}>
      <div className={PORTAL_DATA_TABLE_SCROLL}>
        <table className={PORTAL_DATA_TABLE}>
          <thead>
            <tr className={PORTAL_TABLE_HEAD_ROW}>
              {model.columns!.map((c) => (
                <th key={c.key} className={MANAGER_TABLE_TH}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {model.rows!.map((row, idx) => (
              <tr key={idx} className={PORTAL_TABLE_TR}>
                {model.columns!.map((c) => (
                  <td key={c.key} className={PORTAL_TABLE_TD}>
                    {row[c.key]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  ) : model.emptyState ? (
    <PortalDataTableEmpty
      message={model.emptyState.title}
      icon="data"
    />
  ) : (
    <PortalDataTableEmpty message="Nothing to show yet" icon="default" />
  );

  const workspaceBody = (
    <>
      {tabs.length ? (
        <div className={isCompactPortalShell ? "mb-1" : ""}>
          <TabNav items={tabs} activeId={tabId} />
        </div>
      ) : null}

      {legacyKpiGrid}

      {showToolbar ? (
        <Toolbar>
          <div className="flex w-full flex-col gap-2 md:flex-row md:items-center">
            <Input placeholder="Search" className="md:max-w-md" />
            <Select className="md:max-w-xs">
              <option>All statuses</option>
              <option>Active</option>
              <option>Archived</option>
            </Select>
            <Button
              type="button"
              variant="outline"
              className="md:ml-auto"
              onClick={() => showToast("Filters are not connected yet.")}
            >
              Filters
            </Button>
          </div>
        </Toolbar>
      ) : null}

      {!isCompactPortalShell && model.notes ? (
        <div className="rounded-[24px] border px-5 py-4 text-sm portal-banner-pending">{model.notes}</div>
      ) : null}

      {!isCompactPortalShell ? (
        <div className="flex flex-wrap gap-2">
          {model.actions.map((a) => (
            <Button
              key={a.label}
              type="button"
              variant={a.kind === "modal" ? "secondary" : "primary"}
              onClick={() =>
                a.kind === "modal" ? openModal({ title: a.label, body: a.message }) : showToast(a.message)
              }
            >
              {a.label}
            </Button>
          ))}
        </div>
      ) : null}

      {tableContent}

      {showQuickLinks ? (
        <Card className="p-5">
          <p className="text-sm font-semibold text-foreground">Quick links</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={() => showToast("Coming soon")}>
              Export
            </Button>
            <Button type="button" variant="outline" onClick={() => showToast("Coming soon")}>
              Bulk actions
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => openModal({ title: "Keyboard shortcuts", body: "Shortcuts are not configured yet." })}
            >
              Shortcuts
            </Button>
          </div>
        </Card>
      ) : null}
    </>
  );

  const hideInboxPropertyFilter =
    (portalKind === "admin" || portalKind === "manager" || portalKind === "pro") && model.title === "Inbox";

  const headerFilters =
    portalKind === "admin" && !hideInboxPropertyFilter ? (
      <PortalPropertyFilter residents={model.title === "Payments"} applications={model.title === "Services"} />
    ) : (portalKind === "manager" || portalKind === "pro") && !hideInboxPropertyFilter ? (
      <PortalPropertyFilter residents={model.title === "Payments"} applications={model.title === "Applications"} />
    ) : portalKind === "resident" ? (
      <PortalPropertyFilter residents={model.title === "Payments"} />
    ) : null;

  if (useSectionShell) {
    const kpisForShell =
      model.kpis?.map((k) => ({
        value: k.value,
        label: k.label,
      })) ?? undefined;

    return (
      <PortalListSectionShell
        title={model.title}
        subtitle={model.subtitle.trim() || undefined}
        primaryAction={toHeaderActions(model.actions, openModal, showToast)}
        filterRow={headerFilters ?? undefined}
      >
        <div className="space-y-5">
          {kpisForShell?.length ? (
            <PortalKpiTabStrip items={kpisForShell} activeIndex={activeKpi} onSelect={setActiveKpi} textAlign="center" />
          ) : null}
          {workspaceBody}
        </div>
      </PortalListSectionShell>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3">
        <Breadcrumbs items={breadcrumbs} />
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{model.eyebrow}</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{model.title}</h1>
            {model.subtitle.trim() ? <p className="mt-2 max-w-prose text-sm text-muted">{model.subtitle}</p> : null}
          </div>
          <Badge tone="info">{portalLabel}</Badge>
        </div>
      </div>

      {workspaceBody}
    </div>
  );
}
