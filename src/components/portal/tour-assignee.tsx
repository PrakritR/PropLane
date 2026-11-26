"use client";

import { useCallback, useEffect, useState } from "react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { PortalDialog } from "@/components/portal/portal-dialog";

export type TourAssigneeInfo = {
  assigneeUserId: string;
  assigneeName: string;
  candidates: { id: string; name: string }[];
  calendarNote: string | null;
};

/** Who a confirmed tour is assigned to, loaded from the server (which re-derives the team). Null until known or when not permitted. */
export function useTourAssignee(plannedEventId: string | null) {
  const [info, setInfo] = useState<TourAssigneeInfo | null>(null);
  const load = useCallback(async () => {
    if (!plannedEventId) return;
    try {
      const res = await fetch(`/api/portal-tour-inquiries/assignee?id=${encodeURIComponent(plannedEventId)}`, { credentials: "include" });
      if (!res.ok) return setInfo(null);
      setInfo((await res.json()) as TourAssigneeInfo);
    } catch {
      setInfo(null);
    }
  }, [plannedEventId]);
  useEffect(() => {
    setInfo(null);
    void load();
  }, [load]);
  return { info, reload: load };
}

export function TourReassignDialog({
  open,
  onClose,
  plannedEventId,
  info,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  plannedEventId: string;
  info: TourAssigneeInfo | null;
  onDone: () => void;
}) {
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (open) {
      setPick(info?.assigneeUserId ?? "");
      setError("");
    }
  }, [open, info?.assigneeUserId]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/portal-tour-inquiries/assignee", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: plannedEventId, assigneeUserId: pick }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) return setError(data.error ?? "That did not go through. Try again.");
      onDone();
      onClose();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PortalDialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      dismissBlocked={busy}
      title="Reassign tour"
      primaryAction={{
        label: "Reassign",
        onClick: () => void submit(),
        disabled: busy || !pick || pick === info?.assigneeUserId,
        loading: busy,
        dataAttr: "tour-reassign-submit",
      }}
    >
      <div className="space-y-3" data-attr="tour-reassign-dialog">
        <FieldSingleSelect
          label="Assigned to"
          value={pick}
          onChange={setPick}
          options={(info?.candidates ?? []).map((c) => ({ value: c.id, label: c.name }))}
          disabled={busy}
          dataAttr="tour-reassign-select"
        />
        {error ? <p role="alert" className="text-[13px] text-red-600">{error}</p> : null}
      </div>
    </PortalDialog>
  );
}
