"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PreviewPanel } from "@/components/portal/add-workspace/parts";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import { parseWorkOrderCategoryFromDescription } from "@/lib/reports/formal-documents/spec";
import type { WorkAssignee } from "@/lib/work-assignment";
import { cn } from "@/lib/utils";

type AssignMode = "vendor" | "team";

function tradeForRow(row: DemoManagerWorkOrderRow): string {
  const fromCategory = row.category?.trim();
  if (fromCategory) return fromCategory;
  return parseWorkOrderCategoryFromDescription(row.description ?? "") ?? "Maintenance";
}

function sortVendorsForTrade(vendors: ManagerVendorRow[], trade: string): ManagerVendorRow[] {
  const t = trade.toLowerCase();
  return [...vendors].sort((a, b) => {
    const aMatch = (a.trade ?? "").toLowerCase().includes(t) ? 1 : 0;
    const bMatch = (b.trade ?? "").toLowerCase().includes(t) ? 1 : 0;
    return bMatch - aMatch || a.name.localeCompare(b.name);
  });
}

export function ServiceAssignModal({
  open,
  row,
  vendors,
  teamMembers,
  bidCount,
  onClose,
  onAssign,
  onOpenPublish,
  onOpenCompareQuotes,
}: {
  open: boolean;
  row: DemoManagerWorkOrderRow | null;
  vendors: ManagerVendorRow[];
  teamMembers: readonly { userId: string; name?: string | null; title?: string | null }[];
  bidCount: number;
  onClose: () => void;
  onAssign: (assignee: WorkAssignee) => void;
  onOpenPublish: () => void;
  onOpenCompareQuotes: () => void;
}) {
  const [mode, setMode] = useState<AssignMode>("vendor");
  const [vendorId, setVendorId] = useState("");
  const [memberId, setMemberId] = useState("");

  const trade = row ? tradeForRow(row) : "";
  const sortedVendors = useMemo(() => sortVendorsForTrade(vendors, trade), [vendors, trade]);
  const team = useMemo(() => {
    return [...teamMembers].sort((a, b) => {
      const aMaint = (a.title ?? "").toLowerCase().includes("maintenance") ? 1 : 0;
      const bMaint = (b.title ?? "").toLowerCase().includes("maintenance") ? 1 : 0;
      return bMaint - aMaint || (a.name ?? "").localeCompare(b.name ?? "");
    });
  }, [teamMembers]);

  const previewWho =
    mode === "vendor"
      ? sortedVendors.find((v) => v.id === vendorId)?.name ?? "A vendor"
      : team.find((m) => m.userId === memberId)?.name ?? "A team member";

  const previewLines =
    mode === "team"
      ? [
          `${previewWho} is notified in this service thread.`,
          "No vendor payment is created for team work.",
        ]
      : [
          `${previewWho} is notified and shares this service thread with you.`,
          row?.biddingOpen || bidCount > 0
            ? "Compare quotes before hiring if several vendors bid."
            : "You can also send for bids from local vendors.",
        ];

  const primaryLabel = mode === "vendor" ? "Assign vendor" : "Assign team member";

  return (
    <PortalDialog
      open={open}
      onClose={onClose}
      title="Assign"
      primaryAction={{
        label: primaryLabel,
        onClick: () => {
          if (!row) return;
          if (mode === "vendor") {
            const vendor = sortedVendors.find((v) => v.id === vendorId);
            if (!vendor) return;
            onAssign({ type: "vendor", id: vendor.id, name: vendor.name });
          } else {
            const member = team.find((m) => m.userId === memberId);
            if (!member) return;
            onAssign({ type: "team", id: member.userId, name: member.name ?? "Team member" });
          }
          onClose();
        },
        disabled:
          !row ||
          (mode === "vendor" && !vendorId) ||
          (mode === "team" && !memberId),
      }}
    >
      {row ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,280px)]">
          <div className="space-y-4">
            <div className="flex rounded-full border border-border p-0.5" role="tablist" aria-label="Assignee type">
              {(["vendor", "team"] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={mode === id}
                  className={cn(
                    "flex-1 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
                    mode === id ? "bg-primary text-primary-foreground" : "text-muted",
                  )}
                  onClick={() => setMode(id)}
                  data-attr={`service-assign-mode-${id}`}
                >
                  {id === "vendor" ? "Vendor" : "Team member"}
                </button>
              ))}
            </div>
            {mode === "vendor" ? (
              <>
                <FieldSingleSelect
                  label="Your vendors"
                  value={vendorId}
                  onChange={setVendorId}
                  placeholder="Choose a vendor"
                  options={sortedVendors.map((v) => ({
                    value: v.id,
                    label: v.trade?.trim() ? `${v.name} · ${v.trade}` : v.name,
                  }))}
                  dataAttr="service-assign-vendor"
                />
                <div className="flex flex-wrap gap-2">
                  {!row.biddingOpen && bidCount === 0 ? (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 rounded-full px-3 text-xs"
                      data-attr="service-assign-get-quotes"
                      onClick={() => {
                        onClose();
                        onOpenPublish();
                      }}
                    >
                      Get quotes from local vendors
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      variant="outline"
                      className="h-8 rounded-full px-3 text-xs"
                      data-attr="service-assign-compare-quotes"
                      onClick={() => {
                        onClose();
                        onOpenCompareQuotes();
                      }}
                    >
                      Compare quotes
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <FieldSingleSelect
                label="Workspace members"
                value={memberId}
                onChange={setMemberId}
                placeholder="Choose a team member"
                options={team.map((m) => ({
                  value: m.userId,
                  label: m.title?.trim() ? `${m.name ?? m.userId} · ${m.title}` : (m.name ?? m.userId),
                }))}
                dataAttr="service-assign-team"
              />
            )}
          </div>
          <PreviewPanel
            title="Who is told"
            name={previewWho}
            sub={row.propertyName ?? ""}
            facts={[]}
            creates={previewLines.map((line) => ({ tone: "yes" as const, text: line }))}
          />
        </div>
      ) : null}
    </PortalDialog>
  );
}
