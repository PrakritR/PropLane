"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { ModalAssistantStrip } from "@/components/portal/modal-assistant-strip";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { computeLeaseEndDate, shouldAutoComputeLeaseEnd } from "@/lib/rental-application/lease-dates";
import { CUSTOM_LEASE_TERM, SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import {
  extendMoveOutTypesForProperty,
  renewalLeaseTermOptionsForProperty,
  renewalRentalTypeForTerm,
  type ExtendMoveOutTypeId,
} from "@/lib/lease-renewal-terms";
import { formatPacificDate } from "@/lib/pacific-time";
import { cn } from "@/lib/utils";

type LeaseChangeIntent = "extend" | "early";

type LeaseRenewConfig = {
  leaseId: string;
  currentTerm: string;
  currentRentLabel: string;
  currentRentalType?: "standard" | "short_term" | string | null;
  renewUrl?: string;
};

function addMonthsToIsoDate(isoDate: string, months: number): string {
  const parts = isoDate.split("-").map(Number);
  if (parts.length !== 3) return isoDate;
  const [year, month, day] = parts as [number, number, number];
  const date = new Date(year, month - 1 + months, day);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toISOString().slice(0, 10);
}

/** Day after an ISO date (renewals default to starting when the current lease ends). */
function dayAfter(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

type AvailabilityResult =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; direction: "extend" | "decrease" | "same" }
  | { status: "unavailable"; direction: "extend"; reason: string; nextAvailableDate?: string | null }
  | { status: "error"; message: string };

function LeaseRenewalFormFields({
  leaseTerm,
  leaseStart,
  customEnd,
  rent,
  currentRentLabel,
  onLeaseStartChange,
  onCustomEndChange,
  onRentChange,
}: {
  leaseTerm: string;
  leaseStart: string;
  customEnd: string;
  rent: string;
  currentRentLabel: string;
  onLeaseStartChange: (value: string) => void;
  onCustomEndChange: (value: string) => void;
  onRentChange: (value: string) => void;
}) {
  const rentalType = renewalRentalTypeForTerm(leaseTerm);
  const isShortTerm = rentalType === "short_term";
  const isMonthToMonth = !isShortTerm && leaseTerm === "Month-to-Month";
  const isCustom = !isShortTerm && leaseTerm === CUSTOM_LEASE_TERM;
  const leaseEnd = useMemo(() => {
    if (isMonthToMonth) return "";
    if (isShortTerm || isCustom) return customEnd;
    return shouldAutoComputeLeaseEnd(leaseTerm, rentalType) ? computeLeaseEndDate(leaseStart, leaseTerm) : customEnd;
  }, [leaseTerm, leaseStart, customEnd, isMonthToMonth, isShortTerm, isCustom, rentalType]);

  return (
    <>
      <div className="mb-4 flex items-center gap-3 rounded-xl border border-border bg-accent/20 px-4 py-3 text-sm">
        <span className="text-muted">Renewal term</span>
        <span className="ml-auto font-semibold text-foreground">{leaseTerm}</span>
      </div>

      <div className="mb-4 grid gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-muted">
            {isShortTerm ? "Check-in" : "Renewal starts"}
          </label>
          <input
            type="date"
            value={leaseStart}
            onChange={(e) => onLeaseStartChange(e.target.value)}
            className="w-full rounded-xl border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-blue-100"
          />
        </div>
        <div>
          <label className="mb-1.5 block text-sm font-semibold text-muted">
            {isShortTerm ? "Check-out" : "Ends"}
          </label>
          {isMonthToMonth ? (
            <div className="rounded-xl border border-border bg-accent/30 px-3 py-2.5 text-sm text-muted">Open-ended</div>
          ) : isShortTerm || isCustom || !shouldAutoComputeLeaseEnd(leaseTerm, rentalType) ? (
            <input
              type="date"
              value={customEnd}
              min={leaseStart || undefined}
              onChange={(e) => onCustomEndChange(e.target.value)}
              className="w-full rounded-xl border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          ) : (
            <div className="rounded-xl border border-border bg-accent/30 px-3 py-2.5 text-sm text-foreground">
              {leaseEnd || "—"}
            </div>
          )}
        </div>
      </div>

      <div className="mb-4">
        <label className="mb-1.5 block text-sm font-semibold text-muted">
          {isShortTerm ? "Nightly rate" : "Monthly rent"}
        </label>
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted">$</span>
          <Input
            value={rent}
            inputMode="decimal"
            onChange={(e) => onRentChange(e.target.value)}
            className="pl-7"
            placeholder="e.g. 1450"
            data-attr="lease-renew-rent"
          />
        </div>
        <p className="mt-1.5 text-xs text-muted">
          Leave blank to keep current rent{currentRentLabel ? ` (${currentRentLabel})` : ""}.
        </p>
      </div>
    </>
  );
}

function useLeaseRenewalSubmit({
  leaseTerm,
  leaseStart,
  customEnd,
  rent,
  renewUrl,
  leaseId,
  onClose,
  onSuccess,
}: {
  leaseTerm: string;
  leaseStart: string;
  customEnd: string;
  rent: string;
  renewUrl: string;
  leaseId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { showToast } = useAppUi();
  const [submitting, setSubmitting] = useState(false);

  const rentalType = renewalRentalTypeForTerm(leaseTerm);
  const isShortTerm = rentalType === "short_term";
  const isMonthToMonth = !isShortTerm && leaseTerm === "Month-to-Month";
  const isCustom = !isShortTerm && leaseTerm === CUSTOM_LEASE_TERM;
  const leaseEnd = useMemo(() => {
    if (isMonthToMonth) return "";
    if (isShortTerm || isCustom) return customEnd;
    return shouldAutoComputeLeaseEnd(leaseTerm, rentalType) ? computeLeaseEndDate(leaseStart, leaseTerm) : customEnd;
  }, [leaseTerm, leaseStart, customEnd, isMonthToMonth, isShortTerm, isCustom, rentalType]);

  const rentAmount = rent.trim() ? Number(rent.replace(/[^\d.]/g, "")) : null;
  const canConfirm =
    !submitting &&
    Boolean(leaseTerm) &&
    Boolean(leaseStart) &&
    (isMonthToMonth || Boolean(leaseEnd)) &&
    (!leaseEnd || leaseEnd >= leaseStart) &&
    (rentAmount == null || (Number.isFinite(rentAmount) && rentAmount > 0));

  const handleConfirm = useCallback(async () => {
    if (!canConfirm) return;
    setSubmitting(true);
    try {
      const res = await fetch(renewUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(renewUrl.includes("/manager/") ? { leaseId, mode: "renew" } : {}),
          leaseTerm,
          leaseStart,
          leaseEnd,
          monthlyRent: rentAmount,
          rentalType,
        }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) {
        showToast(json.error ?? "Could not create the renewal.");
      } else {
        onClose();
        onSuccess();
        showToast("Renewal created. The lease needs to be signed by both parties. Payments update once it's fully signed.");
      }
    } catch {
      showToast("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }, [canConfirm, renewUrl, leaseId, leaseTerm, leaseStart, leaseEnd, rentAmount, rentalType, onClose, onSuccess, showToast]);

  return { submitting, canConfirm, handleConfirm };
}

export function LeaseAmendMoveOutModal({
  open,
  onClose,
  currentEnd,
  leaseStart,
  title = "Renew or extend lease",
  checkUrl,
  amendUrl,
  amendBody,
  onSuccess,
  propertyId = "",
  renew,
  /** @deprecated Inline renewal replaces opening a second modal when `renew` is set. */
  onOpenRenew,
}: {
  open: boolean;
  onClose: () => void;
  currentEnd: string;
  leaseStart: string;
  title?: string;
  checkUrl: string;
  amendUrl: string;
  amendBody?: Record<string, string>;
  onSuccess: () => void;
  propertyId?: string;
  /** When set, term picks expand the same modal with renewal fields instead of a second popup. */
  renew?: LeaseRenewConfig;
  onOpenRenew?: (leaseTerm: string) => void;
}) {
  const { showToast } = useAppUi();
  const [intent, setIntent] = useState<LeaseChangeIntent>("extend");
  const [extendType, setExtendType] = useState<ExtendMoveOutTypeId | null>(null);
  const [selectedLongTerm, setSelectedLongTerm] = useState("");
  const [selectedDate, setSelectedDate] = useState("");
  const [availability, setAvailability] = useState<AvailabilityResult>({ status: "idle" });
  const [submitting, setSubmitting] = useState(false);
  const [assistantInstance, setAssistantInstance] = useState(0);
  const [activeRenewTerm, setActiveRenewTerm] = useState<string | null>(null);
  const [renewLeaseStart, setRenewLeaseStart] = useState("");
  const [renewCustomEnd, setRenewCustomEnd] = useState("");
  const [renewRent, setRenewRent] = useState("");
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const extendTypeOptions = useMemo(() => extendMoveOutTypesForProperty(propertyId), [propertyId]);
  const longTermOption = extendTypeOptions.find((option) => option.id === "long_term");
  const longTermChoices = longTermOption?.id === "long_term" ? longTermOption.leaseTerms : [];
  const defaultRenewStart = currentEnd ? dayAfter(currentEnd) : new Date().toISOString().slice(0, 10);

  const openRenewFlow = useCallback(
    (leaseTerm: string) => {
      if (renew) {
        setActiveRenewTerm(leaseTerm);
        setRenewLeaseStart(defaultRenewStart);
        setRenewCustomEnd("");
        setRenewRent(renew.currentRentLabel.replace(/[^\d.]/g, ""));
        return;
      }
      onClose();
      onOpenRenew?.(leaseTerm);
    },
    [renew, onClose, onOpenRenew, defaultRenewStart],
  );

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setIntent("extend");
        setExtendType(null);
        setSelectedLongTerm("");
        setSelectedDate("");
        setAvailability({ status: "idle" });
        setSubmitting(false);
        setActiveRenewTerm(null);
        setRenewLeaseStart("");
        setRenewCustomEnd("");
        setRenewRent("");
      });
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setAssistantInstance((instance) => instance + 1);
  }, [open]);

  useEffect(() => {
    if (!open || intent !== "early" || selectedDate) return;
    if (!currentEnd) return;
    queueMicrotask(() => setSelectedDate(currentEnd));
  }, [open, intent, currentEnd, selectedDate]);

  const customExtendsViaRenewal =
    extendType === "custom" &&
    Boolean(renew) &&
    renewalLeaseTermOptionsForProperty(propertyId).includes(CUSTOM_LEASE_TERM);

  const showRenewForm = Boolean(renew && activeRenewTerm && intent === "extend");
  const showCustomDateExtend =
    intent === "extend" && (!propertyId.trim() || (extendType === "custom" && !customExtendsViaRenewal));
  const showExtendTypePicker = intent === "extend" && Boolean(propertyId.trim()) && !showRenewForm;
  const showLongTermPicker =
    showExtendTypePicker && extendType === "long_term" && longTermChoices.length > 0 && !showRenewForm;

  const direction = selectedDate
    ? selectedDate < currentEnd
      ? "decrease"
      : selectedDate > currentEnd
        ? "extend"
        : "same"
    : null;

  useEffect(() => {
    if (!showCustomDateExtend) return;
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    if (!selectedDate || selectedDate === currentEnd) {
      queueMicrotask(() => setAvailability({ status: "idle" }));
      return;
    }
    if (direction === "decrease") {
      queueMicrotask(() => setAvailability({ status: "available", direction: "decrease" }));
      return;
    }
    queueMicrotask(() => setAvailability({ status: "checking" }));
    checkTimerRef.current = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(checkUrl, {
            method: checkUrl.includes("/manager/") ? "PUT" : "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ newLeaseEnd: selectedDate, ...amendBody }),
          });
          const json = (await res.json()) as {
            available?: boolean;
            direction?: string;
            reason?: string;
            nextAvailableDate?: string | null;
            error?: string;
          };
          if (!res.ok || json.error) {
            setAvailability({ status: "error", message: json.error ?? "Could not check availability." });
            return;
          }
          if (json.available) {
            setAvailability({ status: "available", direction: "extend" });
          } else {
            setAvailability({
              status: "unavailable",
              direction: "extend",
              reason: json.reason ?? "This room is not available for the selected period.",
              nextAvailableDate: json.nextAvailableDate ?? null,
            });
          }
        } catch {
          setAvailability({ status: "error", message: "Network error. Please try again." });
        }
      })();
    }, 600);
    return () => {
      if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    };
  }, [showCustomDateExtend, selectedDate, currentEnd, direction, checkUrl, amendBody]);

  const canConfirmAmend =
    (intent === "early" || showCustomDateExtend) &&
    Boolean(selectedDate) &&
    selectedDate !== currentEnd &&
    !submitting &&
    availability.status !== "checking" &&
    availability.status !== "unavailable";

  const renewUrl = renew?.renewUrl ?? "/api/manager/amend-lease";
  const {
    submitting: renewSubmitting,
    canConfirm: canConfirmRenew,
    handleConfirm: handleRenewConfirm,
  } = useLeaseRenewalSubmit({
    leaseTerm: activeRenewTerm ?? "",
    leaseStart: renewLeaseStart,
    customEnd: renewCustomEnd,
    rent: renewRent,
    renewUrl,
    leaseId: renew?.leaseId ?? "",
    onClose,
    onSuccess,
  });

  const quickExtendOptions = useMemo(
    () =>
      currentEnd
        ? ([1, 3, 6] as const).map((months) => ({
            months,
            label: `+${months} month${months === 1 ? "" : "s"}`,
            value: addMonthsToIsoDate(currentEnd, months),
          }))
        : [],
    [currentEnd],
  );

  const handleConfirmAmend = async () => {
    if (!selectedDate || !canConfirmAmend) return;
    setSubmitting(true);
    try {
      const res = await fetch(amendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newLeaseEnd: selectedDate, ...amendBody }),
      });
      const json = (await res.json()) as { ok?: boolean; error?: string; direction?: string };
      if (!res.ok || !json.ok) {
        showToast(json.error ?? "Failed to update move-out date.");
      } else {
        onClose();
        onSuccess();
        const msg =
          json.direction === "decrease"
            ? "Move-out date updated. The lease needs to be re-signed."
            : "Lease extended. The lease needs to be re-signed.";
        showToast(msg);
      }
    } catch {
      showToast("Network error. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const handleExtendTypeSelect = (typeId: ExtendMoveOutTypeId) => {
    setExtendType(typeId);
    setSelectedLongTerm("");
    setSelectedDate("");
    setAvailability({ status: "idle" });
    setActiveRenewTerm(null);

    if (typeId === "month_to_month") {
      const option = extendTypeOptions.find((entry) => entry.id === "month_to_month");
      if (option?.id === "month_to_month") {
        openRenewFlow(option.leaseTerm);
      }
      return;
    }
    if (typeId === "short_term") {
      const option = extendTypeOptions.find((entry) => entry.id === "short_term");
      if (option?.id === "short_term") {
        openRenewFlow(option.leaseTerm);
      }
      return;
    }
    if (typeId === "long_term") {
      return;
    }
    if (typeId === "custom") {
      if (renew && renewalLeaseTermOptionsForProperty(propertyId).includes(CUSTOM_LEASE_TERM)) {
        openRenewFlow(CUSTOM_LEASE_TERM);
      }
    }
  };

  const handleLongTermSelect = (leaseTerm: string) => {
    setSelectedLongTerm(leaseTerm);
    openRenewFlow(leaseTerm);
  };

  const currentEndFormatted = currentEnd
    ? formatPacificDate(currentEnd, { year: "numeric", month: "long", day: "numeric" })
    : "—";

  const showAmendFooter = showCustomDateExtend || intent === "early";
  const showRenewFooter = showRenewForm;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      assistantStrip={false}
      footer={
        <div className="flex flex-col gap-0">
          {showRenewFooter ? (
            <ModalFooter className="w-full pb-0">
              <Button
                type="button"
                variant="primary"
                className="flex-1 rounded-full"
                disabled={!canConfirmRenew}
                onClick={() => handleRenewConfirm()}
                data-attr="lease-renew-confirm"
              >
                {renewSubmitting ? "Creating…" : "Create renewal"}
              </Button>
            </ModalFooter>
          ) : showAmendFooter ? (
            <ModalFooter className="w-full pb-0">
              <Button
                type="button"
                variant="primary"
                className="flex-1 rounded-full"
                disabled={!canConfirmAmend}
                onClick={() => handleConfirmAmend()}
              >
                {submitting ? "Saving…" : direction === "decrease" ? "Update move-out" : "Extend lease"}
              </Button>
            </ModalFooter>
          ) : null}
          <ModalAssistantStrip
            contextHint={title}
            storageScopeKey={title}
            conversationInstance={assistantInstance}
            className={showRenewFooter || showAmendFooter ? "mt-3 border-t border-border pt-0" : undefined}
          />
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-3 rounded-xl bg-accent/30 px-4 py-3 text-sm">
        <span className="text-muted">Current move-out date</span>
        <span className="ml-auto font-semibold text-foreground">{currentEndFormatted}</span>
      </div>

      {!showRenewForm ? (
        <>
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-semibold text-muted">What do you want to do?</label>
            <Select
              value={intent}
              onChange={(e) => {
                const next = e.target.value as LeaseChangeIntent;
                setIntent(next);
                setExtendType(null);
                setSelectedLongTerm("");
                setSelectedDate("");
                setAvailability({ status: "idle" });
                setActiveRenewTerm(null);
              }}
              data-attr="lease-amend-intent"
            >
              <option value="extend">Extend move-out</option>
              <option value="early">Early move-out</option>
            </Select>
          </div>

          {showExtendTypePicker ? (
            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-semibold text-muted">Extension type</label>
              <Select
                value={extendType ?? ""}
                onChange={(e) => {
                  const next = e.target.value as ExtendMoveOutTypeId;
                  if (next) handleExtendTypeSelect(next);
                }}
                data-attr="lease-amend-extend-type"
              >
                <option value="" disabled>
                  Select extension type
                </option>
                {extendTypeOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}

          {showLongTermPicker ? (
            <div className="mb-4">
              <label className="mb-1.5 block text-sm font-semibold text-muted">Lease length</label>
              <Select
                value={selectedLongTerm}
                onChange={(e) => {
                  if (e.target.value) handleLongTermSelect(e.target.value);
                }}
                data-attr="lease-amend-long-term"
              >
                <option value="" disabled>
                  Select lease length
                </option>
                {longTermChoices.map((term) => (
                  <option key={term} value={term}>
                    {term}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </>
      ) : null}

      {showRenewForm && activeRenewTerm ? (
        <LeaseRenewalFormFields
          leaseTerm={activeRenewTerm}
          leaseStart={renewLeaseStart}
          customEnd={renewCustomEnd}
          rent={renewRent}
          currentRentLabel={renew?.currentRentLabel ?? ""}
          onLeaseStartChange={setRenewLeaseStart}
          onCustomEndChange={setRenewCustomEnd}
          onRentChange={setRenewRent}
        />
      ) : null}

      {!showRenewForm && (intent === "early" || showCustomDateExtend) ? (
        <>
          <div className="mb-4">
            <label className="mb-1.5 block text-sm font-semibold text-muted">New move-out date</label>
            {showCustomDateExtend && quickExtendOptions.length > 0 ? (
              <div className="mb-3 flex flex-wrap gap-2">
                {quickExtendOptions.map((option) => (
                  <button
                    key={option.months}
                    type="button"
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs font-semibold",
                      selectedDate === option.value
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted hover:border-primary/30",
                    )}
                    onClick={() => setSelectedDate(option.value)}
                  >
                    {option.label}
                  </button>
                ))}
                <button
                  type="button"
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs font-semibold",
                    selectedDate && !quickExtendOptions.some((option) => option.value === selectedDate)
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted hover:border-primary/30",
                  )}
                  onClick={() => setSelectedDate("")}
                >
                  Custom date
                </button>
              </div>
            ) : null}
            <input
              type="date"
              value={selectedDate}
              min={leaseStart || undefined}
              max={intent === "early" && currentEnd ? currentEnd : undefined}
              onChange={(e) => setSelectedDate(e.target.value)}
              className="w-full rounded-xl border border-border px-3 py-2.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-blue-100"
            />
          </div>

          {selectedDate && selectedDate !== currentEnd ? (
            <div className="mb-5 space-y-2">
              {direction === "decrease" ? (
                <div className="rounded-xl border px-4 py-3 text-sm portal-banner-pending">
                  Moving out earlier may result in an early termination fee. Confirm any charges with your property manager.
                </div>
              ) : null}
              {direction === "extend" && availability.status === "checking" ? (
                <p className="text-sm text-muted">Checking room availability…</p>
              ) : null}
              {direction === "extend" && availability.status === "available" ? (
                <p className="rounded-xl border px-4 py-3 text-sm portal-banner-success">
                  Room is available through the new date.
                </p>
              ) : null}
              {direction === "extend" && availability.status === "unavailable" ? (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{availability.reason}</p>
              ) : null}
              {availability.status === "error" ? (
                <p className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">{availability.message}</p>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}

      {showRenewForm ? (
        <button
          type="button"
          className="mt-1 text-sm font-semibold text-primary"
          onClick={() => {
            setActiveRenewTerm(null);
            setExtendType(null);
            setSelectedLongTerm("");
          }}
        >
          Change renewal option
        </button>
      ) : null}
    </Modal>
  );
}

/**
 * Standalone renew modal — prefer passing `renew` to LeaseAmendMoveOutModal for one popup.
 */
export function LeaseRenewModal({
  open,
  onClose,
  currentEnd,
  currentTerm,
  currentRentLabel,
  propertyId,
  currentRentalType,
  leaseId,
  onSuccess,
  renewUrl = "/api/manager/amend-lease",
  initialLeaseTerm,
}: {
  open: boolean;
  onClose: () => void;
  currentEnd: string;
  currentTerm: string;
  currentRentLabel: string;
  propertyId: string;
  currentRentalType?: "standard" | "short_term" | string | null;
  leaseId: string;
  onSuccess: () => void;
  renewUrl?: string;
  initialLeaseTerm?: string;
}) {
  const termOptions = useMemo(() => renewalLeaseTermOptionsForProperty(propertyId), [propertyId]);
  const defaultStart = currentEnd ? dayAfter(currentEnd) : new Date().toISOString().slice(0, 10);
  const resolvedInitialTerm = useMemo(() => {
    const preferred = (initialLeaseTerm ?? currentTerm).trim();
    if (preferred && termOptions.includes(preferred)) return preferred;
    if (currentRentalType === "short_term" && termOptions.includes(SHORT_TERM_LEASE_TERM)) {
      return SHORT_TERM_LEASE_TERM;
    }
    return termOptions[0] ?? "12-Month";
  }, [initialLeaseTerm, currentTerm, currentRentalType, termOptions]);
  const [leaseTerm, setLeaseTerm] = useState(resolvedInitialTerm);
  const [leaseStart, setLeaseStart] = useState(defaultStart);
  const [customEnd, setCustomEnd] = useState("");
  const [rent, setRent] = useState(() => currentRentLabel.replace(/[^\d.]/g, ""));
  const [assistantInstance, setAssistantInstance] = useState(0);

  useEffect(() => {
    if (!open) {
      queueMicrotask(() => {
        setLeaseTerm(resolvedInitialTerm);
        setLeaseStart(defaultStart);
        setCustomEnd("");
        setRent(currentRentLabel.replace(/[^\d.]/g, ""));
      });
    }
  }, [open, resolvedInitialTerm, defaultStart, currentRentLabel]);

  useEffect(() => {
    if (!open) return;
    setAssistantInstance((instance) => instance + 1);
  }, [open]);

  const { submitting, canConfirm, handleConfirm } = useLeaseRenewalSubmit({
    leaseTerm,
    leaseStart,
    customEnd,
    rent,
    renewUrl,
    leaseId,
    onClose,
    onSuccess,
  });

  const currentEndFormatted = currentEnd
    ? formatPacificDate(currentEnd, { year: "numeric", month: "long", day: "numeric" })
    : "No end date (month-to-month)";

  return (
    <Modal
      open={open}
      title="Renew lease"
      onClose={onClose}
      panelClassName="max-w-md"
      assistantStrip={false}
      footer={
        <div className="flex flex-col gap-0">
          <ModalFooter className="w-full pb-0">
            <Button
              type="button"
              variant="primary"
              className="flex-1 rounded-full"
              disabled={!canConfirm}
              onClick={() => handleConfirm()}
              data-attr="lease-renew-confirm"
            >
              {submitting ? "Creating…" : "Create renewal"}
            </Button>
          </ModalFooter>
          <ModalAssistantStrip
            contextHint="Renew lease"
            storageScopeKey="Renew lease"
            conversationInstance={assistantInstance}
            className="mt-3 border-t border-border pt-0"
          />
        </div>
      }
    >
      <div className="mb-4 flex items-center gap-3 rounded-xl bg-accent/30 px-4 py-3 text-sm">
        <span className="text-muted">Current lease ends</span>
        <span className="ml-auto font-semibold text-foreground">{currentEndFormatted}</span>
      </div>

      <div className="mb-4">
        <label className="mb-1.5 block text-sm font-semibold text-muted">New lease term</label>
        <Select value={leaseTerm} onChange={(e) => setLeaseTerm(e.target.value)} data-attr="lease-renew-term">
          {termOptions.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </Select>
      </div>

      <LeaseRenewalFormFields
        leaseTerm={leaseTerm}
        leaseStart={leaseStart}
        customEnd={customEnd}
        rent={rent}
        currentRentLabel={currentRentLabel}
        onLeaseStartChange={setLeaseStart}
        onCustomEndChange={setCustomEnd}
        onRentChange={setRent}
      />
    </Modal>
  );
}
