"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { WorkAssignmentPicker } from "@/components/portal/work-assignment-picker";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { useManagerUserId } from "@/hooks/use-manager-user-id";
import { useWorkAssignmentDirectory } from "@/hooks/use-work-assignment-directory";
import {
  scheduleServiceVisit,
  type ScheduleVisitAssigneeChoice,
} from "@/lib/schedule-service-visit";
import { normalizeAssignee, type WorkAssignee } from "@/lib/work-assignment";
import { fetchManagerTimeSuggestion } from "@/lib/manager-schedule-suggest.client";

/** The pill shown beside "Visit arrival" — `null` once the manager types their
 * own time, since a hand-picked time is no longer a suggestion. */
type SuggestPill = "availability" | "proplane-pick" | "none";

const SUGGEST_PILL_LABEL: Record<SuggestPill, string> = {
  availability: "From your availability",
  "proplane-pick": "PropLane pick",
  none: "Nothing free in 14 days",
};

const SUGGEST_PILL_TONE: Record<SuggestPill, "success" | "info" | "danger"> = {
  availability: "success",
  "proplane-pick": "info",
  none: "danger",
};

function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function toDatetimeLocalValue(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fromDatetimeLocalValue(s: string): string | null {
  if (!s.trim()) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

const DURATIONS = [
  { value: 30, label: "30 minutes" },
  { value: 60, label: "1 hour" },
  { value: 90, label: "1½ hours" },
  { value: 120, label: "2 hours" },
  { value: 180, label: "3 hours" },
  { value: 240, label: "Half a day" },
] as const;

/** The row's current assignee, or the signed-in manager when it has none yet. */
function initialAssignee(
  row: DemoManagerWorkOrderRow,
  self: WorkAssignee | null,
): WorkAssignee | null {
  const stored = normalizeAssignee(row.assignee);
  if (stored) return stored;
  if (row.vendorId?.trim()) {
    return { type: "vendor", id: row.vendorId.trim(), name: row.vendorName?.trim() || "Vendor" };
  }
  return self;
}

/**
 * Schedule visit — who takes it and when. The picker is the same one Tasks
 * uses: the manager team first, then vendors (a vendor can take maintenance,
 * never an add-on service — `assignableKindsFor` decides, not this popup).
 */
export function ScheduleServiceVisitModal({
  open,
  row,
  onClose,
  onScheduled,
}: {
  open: boolean;
  row: DemoManagerWorkOrderRow | null;
  onClose: () => void;
  onScheduled?: () => void;
}) {
  const { showToast } = useAppUi();
  const { userId: managerUserId, email, ready: authReady } = useManagerUserId();
  const { teamMembers, vendors } = useWorkAssignmentDirectory({
    managerUserId,
    managerName: email,
    enabled: open,
  });
  const [assignee, setAssignee] = useState<WorkAssignee | null>(null);
  const [visitLocal, setVisitLocal] = useState("");
  const [durationMinutes, setDurationMinutes] = useState<number>(60);
  const [busy, setBusy] = useState(false);
  /** `null` = no pill: either a real scheduled/proposed time, or the manager
   * has typed their own. Only the fetched-suggestion path shows one. */
  const [suggestPill, setSuggestPill] = useState<SuggestPill | null>(null);
  const [suggestLoading, setSuggestLoading] = useState(false);

  const self = useMemo<WorkAssignee | null>(() => {
    if (!managerUserId) return null;
    const me = teamMembers.find((m) => m.userId === managerUserId);
    return { type: "team", id: managerUserId, name: me?.name?.trim() || email?.trim() || "You" };
  }, [email, managerUserId, teamMembers]);

  /** Ask the server for a suggestion at the given duration, optionally after a
   * given ISO ("Next open"). Never throws — `fetchManagerTimeSuggestion` already
   * folds every failure into `null`. */
  const askSuggestion = useCallback(
    async (duration: number, after?: string) => {
      if (!row) return null;
      setSuggestLoading(true);
      try {
        return await fetchManagerTimeSuggestion({
          kind: "services",
          durationMinutes: duration,
          seed: row.id,
          excludeWorkOrderId: row.id,
          after,
        });
      } finally {
        setSuggestLoading(false);
      }
    },
    [row],
  );

  useEffect(() => {
    if (!open || !row) return;
    setAssignee(initialAssignee(row, self));
    setDurationMinutes(60);
    setBusy(false);
    setSuggestPill(null);
    setSuggestLoading(false);

    if (row.scheduledAtIso) {
      setVisitLocal(toDatetimeLocalValue(row.scheduledAtIso));
      return;
    }
    if (row.proposedVisit?.iso) {
      setVisitLocal(toDatetimeLocalValue(row.proposedVisit.iso));
      setSuggestPill(row.proposedVisit.source);
      return;
    }

    setVisitLocal("");
    let cancelled = false;
    void askSuggestion(60).then((suggestion) => {
      if (cancelled) return;
      if (suggestion) {
        setVisitLocal(toDatetimeLocalValue(suggestion.iso));
        setSuggestPill(suggestion.source);
      } else {
        setSuggestPill("none");
      }
    });
    return () => {
      cancelled = true;
    };
    // `self` resolves once the directory loads; re-running on it would clobber a
    // pick the manager already made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row]);

  useEffect(() => {
    if (!open || assignee || !self) return;
    setAssignee(self);
  }, [open, assignee, self]);

  const propertyLine = useMemo(() => {
    if (!row) return "";
    const unit = row.unit?.trim();
    return unit ? `${row.propertyName} · ${unit}` : row.propertyName;
  }, [row]);

  const onConfirm = async () => {
    if (!row || !managerUserId || !authReady) return;
    const iso = fromDatetimeLocalValue(visitLocal);
    if (!iso) {
      showToast("Choose a visit date and time to schedule.");
      return;
    }
    if (!assignee) {
      showToast("Choose who takes this visit.");
      return;
    }
    let choice: ScheduleVisitAssigneeChoice;
    if (assignee.type === "vendor") {
      choice = { kind: "vendor", vendorId: assignee.id };
    } else if (assignee.id === managerUserId) {
      choice = { kind: "self" };
    } else {
      choice = { kind: "team", userId: assignee.id, name: assignee.name };
    }
    setBusy(true);
    try {
      const result = await scheduleServiceVisit({
        managerUserId,
        managerName: email,
        row,
        visitAtIso: iso,
        durationMinutes,
        assignee: choice,
      });
      if (!result.ok) {
        showToast(result.error ?? "Could not schedule visit.");
        return;
      }
      showToast(
        `Service scheduled.${result.vendorNotified ? ` ${result.vendorNotified}` : ""}`,
      );
      onScheduled?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  const onNextOpen = async () => {
    const after = fromDatetimeLocalValue(visitLocal) ?? new Date().toISOString();
    const suggestion = await askSuggestion(durationMinutes, after);
    if (suggestion) {
      setVisitLocal(toDatetimeLocalValue(suggestion.iso));
      setSuggestPill(suggestion.source);
    } else {
      showToast("No later open time in the next 14 days.");
    }
  };

  const hasSuggestion = suggestPill === "availability" || suggestPill === "proplane-pick";

  return (
    <Modal
      open={open && Boolean(row)}
      title="Schedule visit"
      dense
      fullPage={false}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <ModalFooter>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !row}
            onClick={() => onConfirm()}
            data-attr="schedule-service-visit-confirm"
          >
            {busy ? "Scheduling…" : "Schedule visit"}
          </Button>
        </ModalFooter>
      }
    >
      {row ? (
        <div className="space-y-4">
          <div>
            <p className="text-sm font-medium text-foreground">{row.title}</p>
            {propertyLine ? <p className="mt-0.5 text-xs text-muted">{propertyLine}</p> : null}
            {row.residentName?.trim() ? (
              <p className="mt-0.5 text-xs text-muted">Resident: {row.residentName.trim()}</p>
            ) : null}
          </div>

          <WorkAssignmentPicker
            kind="maintenance"
            value={assignee}
            teamMembers={teamMembers}
            vendors={vendors}
            disabled={busy}
            label="Assign to"
            dataAttr="schedule-service-visit-assignee"
            onChange={setAssignee}
          />

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block space-y-1.5">
              <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                Visit arrival
                {suggestPill ? (
                  <span data-attr="schedule-service-visit-source">
                    <Badge tone={SUGGEST_PILL_TONE[suggestPill]}>{SUGGEST_PILL_LABEL[suggestPill]}</Badge>
                  </span>
                ) : null}
              </span>
              <div className="flex items-center gap-2">
                <Input
                  type="datetime-local"
                  value={visitLocal}
                  onChange={(e) => {
                    setVisitLocal(e.target.value);
                    setSuggestPill(null);
                  }}
                  disabled={busy || suggestLoading}
                  className="flex-1"
                  data-attr="schedule-service-visit-datetime"
                />
                {hasSuggestion ? (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy || suggestLoading}
                    onClick={() => onNextOpen()}
                    data-attr="schedule-service-visit-next-open"
                  >
                    Next open
                  </Button>
                ) : null}
              </div>
            </label>
            <label className="block space-y-1.5">
              <span className="text-xs font-medium text-muted">Duration</span>
              <Select
                value={String(durationMinutes)}
                onChange={(e) => {
                  const next = Number(e.target.value) || 60;
                  setDurationMinutes(next);
                  if (suggestPill === null) return;
                  void askSuggestion(next).then((suggestion) => {
                    if (suggestion) {
                      setVisitLocal(toDatetimeLocalValue(suggestion.iso));
                      setSuggestPill(suggestion.source);
                    } else {
                      setSuggestPill("none");
                    }
                  });
                }}
                disabled={busy}
                data-attr="schedule-service-visit-duration"
              >
                {DURATIONS.map((d) => (
                  <option key={d.value} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
            </label>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
