"use client";

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import {
  getRoomOptionsForProperty,
  parseRoomChoiceValue,
} from "@/lib/rental-application/data";
import { LONG_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import {
  normalizeLeaseIntakeAnswers,
  type LeaseIntakeAnswers,
} from "@/lib/leasing/lease-application-field-map";
import {
  updateLeasePipelineRow,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";
import { leaseUnlocksWithoutApplicationApproval } from "@/lib/leasing-pipeline-preferences";
import { readCachedLeasingPipelinePreferences } from "@/lib/leasing-pipeline-client-cache";

const FIELD_LABEL_CLASS = "mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted";

const TERM_MONTH_OPTIONS = [
  { value: "12", label: "12 months" },
  { value: "9", label: "9 months" },
  { value: "6", label: "6 months" },
  { value: "3", label: "3 months" },
  { value: "1", label: "Month-to-month" },
  { value: "0", label: "Long-term (dates define length)" },
] as const;

function termMonthsToLabel(months: number | null | undefined): string {
  if (months == null) return "";
  if (months === 1) return "Month-to-Month";
  if (months === 3) return "3-Month";
  if (months === 6) return "6-Month";
  if (months === 9) return "9-Month";
  if (months === 12) return "12-Month";
  if (months === 0) return LONG_TERM_LEASE_TERM;
  return LONG_TERM_LEASE_TERM;
}

/**
 * Minimal lease-first intake on a draft resident lease: room, move-in, term.
 * Saved to `row.leaseIntake` for bidirectional autofill into a later application.
 */
export function ResidentLeaseIntakeSection({
  row,
  onSaved,
}: {
  row: LeasePipelineRow;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const prefs = readCachedLeasingPipelinePreferences();
  const leaseFirst = leaseUnlocksWithoutApplicationApproval(prefs);
  const isDraft = row.status === "Draft" || row.bucket === "manager";
  const propertyId = row.propertyId?.trim() || row.application?.propertyId?.trim() || "";

  const initial = useMemo(() => {
    const stored = normalizeLeaseIntakeAnswers(row.leaseIntake) ?? {};
    const room =
      stored.roomChoice?.trim() ||
      row.roomChoice?.trim() ||
      row.application?.roomChoice1?.trim() ||
      "";
    const months =
      stored.termMonths ??
      (stored.leaseTerm === "Month-to-Month"
        ? 1
        : stored.leaseTerm === "3-Month"
          ? 3
          : stored.leaseTerm === "6-Month"
            ? 6
            : stored.leaseTerm === "9-Month"
              ? 9
              : stored.leaseTerm === "12-Month"
                ? 12
                : stored.leaseTerm === LONG_TERM_LEASE_TERM
                  ? 0
                  : null);
    return {
      roomChoice: room,
      leaseStart: stored.leaseStart?.trim() || row.application?.leaseStart?.trim() || "",
      termMonths: months == null ? "12" : String(months),
    };
  }, [row]);

  const [roomChoice, setRoomChoice] = useState(initial.roomChoice);
  const [leaseStart, setLeaseStart] = useState(initial.leaseStart);
  const [termMonths, setTermMonths] = useState(initial.termMonths);
  const [busy, setBusy] = useState(false);

  const roomOptions = useMemo(() => {
    if (!propertyId) return [];
    return getRoomOptionsForProperty(propertyId, { includeUnavailable: true }).filter((o) => o.value);
  }, [propertyId]);

  if (!leaseFirst || !isDraft || !propertyId) return null;

  const save = async () => {
    const months = Number(termMonths);
    const leaseTerm = termMonthsToLabel(Number.isFinite(months) ? months : null);
    const parsed = roomChoice ? parseRoomChoiceValue(roomChoice) : { propertyId, listingRoomId: undefined };
    const intake: LeaseIntakeAnswers = {
      fullLegalName: row.residentName?.trim() || undefined,
      email: row.residentEmail?.trim().toLowerCase() || undefined,
      leaseStart: leaseStart.trim() || undefined,
      leaseTerm: leaseTerm || undefined,
      termMonths: Number.isFinite(months) ? months : null,
      propertyId,
      listingRoomId: parsed.listingRoomId,
      roomChoice: roomChoice.trim() || undefined,
    };
    setBusy(true);
    try {
      const ok = updateLeasePipelineRow(row.id, {
        leaseIntake: intake,
        roomChoice: roomChoice.trim() || row.roomChoice || null,
        application: {
          ...(row.application ?? {}),
          propertyId,
          leaseStart: leaseStart.trim() || row.application?.leaseStart || "",
          leaseTerm: leaseTerm || row.application?.leaseTerm || "",
          roomChoice1: roomChoice.trim() || row.application?.roomChoice1 || "",
          fullLegalName: row.application?.fullLegalName || row.residentName || "",
          email: row.application?.email || row.residentEmail || "",
        },
      });
      if (!ok) {
        showToast("Could not save lease details.");
        return;
      }
      showToast("Lease details saved.");
      onSaved?.();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mb-4 rounded-2xl border border-border bg-card p-3 sm:p-4"
      data-attr="resident-lease-intake"
    >
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">Lease details</p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {roomOptions.length > 0 ? (
          <div>
            <label htmlFor="resident-lease-intake-room" className={FIELD_LABEL_CLASS}>
              Room
            </label>
            <Select
              id="resident-lease-intake-room"
              value={roomChoice}
              onChange={(e) => setRoomChoice(e.target.value)}
              data-attr="resident-lease-intake-room"
            >
              <option value="">Select room</option>
              {roomOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
        <div>
          <label htmlFor="resident-lease-intake-start" className={FIELD_LABEL_CLASS}>
            Move-in date
          </label>
          <Input
            id="resident-lease-intake-start"
            type="date"
            value={leaseStart}
            onChange={(e) => setLeaseStart(e.target.value)}
            data-attr="resident-lease-intake-start"
          />
        </div>
        <div className={roomOptions.length > 0 ? "sm:col-span-2" : undefined}>
          <label htmlFor="resident-lease-intake-term" className={FIELD_LABEL_CLASS}>
            Lease term
          </label>
          <Select
            id="resident-lease-intake-term"
            value={termMonths}
            onChange={(e) => setTermMonths(e.target.value)}
            data-attr="resident-lease-intake-term"
          >
            {TERM_MONTH_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
      <div className="mt-3">
        <Button type="button" onClick={() => void save()} disabled={busy} data-attr="resident-lease-intake-save">
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
