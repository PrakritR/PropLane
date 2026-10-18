"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, CircleAlert, Clock, Home, MessageSquare } from "lucide-react";
import { PortalCommunicationShell } from "@/components/portal/portal-communication-shell";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { SegmentedTwo } from "@/components/ui/segmented-control";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { usePaidPortalBasePath } from "@/lib/portal-base-path-client";
import { decideEscalation, fetchEscalations } from "@/lib/automations/client";
import {
  ESCALATION_SOURCE_LABELS,
  type EscalationItem,
  type EscalationStatus,
} from "@/lib/automations/escalations";

function whenLabel(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/**
 * Communication, Escalations: what the assistant, a house group's RA or an unanswered question
 * handed to the team. One list (Open | Resolved), one ⋯ per row. The asker is shown by role and the
 * last four digits of their number, never the number.
 */
export function ManagerEscalationsInbox() {
  const base = usePaidPortalBasePath();
  const navigate = usePortalNavigate();
  const [status, setStatus] = useState<EscalationStatus>("open");
  const [items, setItems] = useState<EscalationItem[] | null>(null);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setError(false);
    const next = await fetchEscalations(status);
    if (next === null) setError(true);
    setItems(next);
  }, [status]);
  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  return (
    <PortalCommunicationShell title="Escalations" hideTitleOnMobileNav={false}>
      <div className="flex items-center justify-between gap-3 px-1 pb-3">
        <PortalIconAction
          icon={ArrowLeft}
          label="Back to Communication"
          data-attr="escalations-back"
          onClick={() => navigate(`${base}/communication/active`)}
        />
        <SegmentedTwo
          value={status}
          onChange={setStatus}
          left={{ id: "open", label: "Open" }}
          right={{ id: "resolved", label: "Resolved" }}
          className="w-56"
        />
      </div>
      <PortalRecordListSurface
        dataAttr="escalations-list"
        loading={items === null && !error}
        loadError={error ? "Could not load escalations." : undefined}
        onRetry={() => void load()}
        isEmpty={items !== null && items.length === 0}
        emptyCard={{ title: status === "open" ? "Nothing to follow up" : "Nothing resolved yet", section: "communication" }}
      >
        {(items ?? []).map((item) => (
          <PortalPropertyRecordRow
            key={item.id}
            title={item.question}
            address={[item.houseLabel, item.role.charAt(0).toUpperCase() + item.role.slice(1), item.phoneTail ? `•••• ${item.phoneTail}` : ""]
              .filter(Boolean)
              .join(" · ")}
            leading={<PortalRowIconTile icon={CircleAlert} />}
            leadingShape="square"
            facts={
              <>
                <PortalRowFact icon={Home} srLabel="Source">
                  {ESCALATION_SOURCE_LABELS[item.source]}
                </PortalRowFact>
                {item.excerpt && item.excerpt !== item.question ? (
                  <PortalRowFact icon={MessageSquare} srLabel="Thread excerpt">
                    {item.excerpt.length > 90 ? `${item.excerpt.slice(0, 87)}...` : item.excerpt}
                  </PortalRowFact>
                ) : null}
                <PortalRowFact icon={Clock} srLabel="When">
                  {whenLabel(item.escalatedAt)}
                </PortalRowFact>
              </>
            }
            dataAttr="escalation-row"
            actions={
              <RowActionsMenu
                label={item.question}
                items={[
                  item.resolvedAt
                    ? { id: "reopen", label: "Reopen", onSelect: async () => { await decideEscalation(item.id, "reopen"); await load(); } }
                    : { id: "resolve", label: "Mark resolved", onSelect: async () => { await decideEscalation(item.id, "resolve"); await load(); } },
                ]}
              />
            }
          />
        ))}
      </PortalRecordListSurface>
    </PortalCommunicationShell>
  );
}
