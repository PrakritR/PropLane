"use client";

/**
 * The one Quick apply sheet. The public listing's price card opens it on a fixed listing; the resident
 * portal's round blue + opens it with a listing picker first. Room and move-in, the two confirmations
 * (screening consent when the listing asks for it, "my saved answers are current") and the typed signature
 * make one sheet and one Submit. The server decides whether the saved answers are enough
 * (`POST /api/portal/quick-apply`); when they are not, the full application opens prefilled.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PropertySearchPicker, type PropertySearchOption } from "@/components/marketing/property-search-picker";
import { CheckboxOption } from "@/components/portal/listing-wizard-v2/wizard-primitives";
import { Button } from "@/components/ui/button";
import { DateField } from "@/components/ui/date-field";
import { Input, Select } from "@/components/ui/input";
import { Modal } from "@/components/ui/modal";
import {
  isPropertyActiveForLeads,
  loadPublicExtraListingsFromServer,
  readExtraListingsPublic,
} from "@/lib/demo-property-pipeline";
import { PROPERTY_PIPELINE_EVENT } from "@/lib/property-pipeline-events";
import { isProductionPublicSite } from "@/lib/public-demo-access";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isWizardFormFieldRequired, wizardFormFieldLabel } from "@/lib/rental-application/application-field-catalog";
import { applicationConfigForApplicant } from "@/lib/rental-application/application-template-config";
import { getPropertyById } from "@/lib/rental-application/data";
import { isEntireHomeListing, type ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import { pacificTodayKey } from "@/lib/sheet-sync/dates";
import { resetQuickApplyReadiness } from "@/hooks/use-quick-apply-eligibility";
import { syncManagerApplicationsFromServer } from "@/lib/manager-applications-storage";

type QuickApplyResponse = {
  ok?: boolean;
  applicationId?: string;
  href?: string;
  needsWizard?: boolean;
  needsPayment?: boolean;
  error?: string;
};

export type QuickApplySheetProps = {
  open: boolean;
  onClose: () => void;
  /** A fixed listing (the public page). Without it the sheet opens on a listing picker. */
  propertyId?: string;
  /**
   * The fixed listing's own submission, handed down by the page that already has it. The public listing
   * route never loads the client-side extras catalog, so `getPropertyById` cannot answer for it there and
   * the rooms and the screening question would both go missing.
   */
  submission?: ManagerListingSubmissionV1 | null;
  initialRoomId?: string;
  initialMoveIn?: string;
  showToast: (message: string) => void;
  /** Open an in-app path. Defaults to the router; the resident portal passes its own navigator. */
  navigate?: (href: string) => void;
  /** Picker step only: skip Quick apply and start the full application for the chosen listing. */
  onFullApplication?: (propertyId: string) => void;
};

function listingOptions(): PropertySearchOption[] {
  return filterSandboxFromPublicCatalog(readExtraListingsPublic(), { production: isProductionPublicSite() })
    .filter(isPropertyActiveForLeads)
    .map((property) => {
      const prop = getPropertyById(property.id);
      return {
        id: property.id,
        title: property.title,
        subtitle: prop?.address,
        tags: prop ? [prop.neighborhood, prop.rentLabel].filter(Boolean) : undefined,
        searchText: prop
          ? `${prop.title} ${prop.address} ${prop.neighborhood} ${prop.buildingName} ${prop.zip}`
          : property.title,
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

function QuickApplySheetBody({
  open,
  onClose,
  propertyId: fixedPropertyId,
  submission,
  initialRoomId = "",
  initialMoveIn = "",
  showToast,
  navigate,
  onFullApplication,
}: QuickApplySheetProps) {
  const router = useRouter();
  const go = navigate ?? ((href: string) => router.push(href));
  const [tick, setTick] = useState(0);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [roomId, setRoomId] = useState(initialRoomId);
  const [moveIn, setMoveIn] = useState(initialMoveIn);
  const [consentCredit, setConsentCredit] = useState(false);
  const [consentTruth, setConsentTruth] = useState(false);
  const [confirmCurrent, setConfirmCurrent] = useState(false);
  const [signature, setSignature] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const propertyId = fixedPropertyId || pickedId || "";

  useEffect(() => {
    if (!open || fixedPropertyId) return;
    void loadPublicExtraListingsFromServer();
    const on = () => setTick((n) => n + 1);
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [fixedPropertyId, open]);

  const options = useMemo(() => {
    void tick;
    return open && !fixedPropertyId ? listingOptions() : [];
  }, [fixedPropertyId, open, tick]);

  const property = propertyId ? getPropertyById(propertyId) : undefined;
  const handed = fixedPropertyId && submission?.v === 1 ? submission : null;
  const sub = handed ?? (property?.listingSubmission?.v === 1 ? property.listingSubmission : null);
  /**
   * An entire-home listing is applied for as the WHOLE place: the server stores the property id as the
   * unit choice, so its bedrooms are never offered here and no room id is sent for one.
   */
  const entireHome = sub ? isEntireHomeListing(sub) : false;
  const rooms = useMemo(
    () =>
      entireHome
        ? []
        : (sub?.rooms ?? []).filter((room) => room.id).map((room, index) => ({ id: room.id, name: room.name?.trim() || `Room ${index + 1}` })),
    [entireHome, sub],
  );
  const needsRoomPick = rooms.length > 1;
  /**
   * The listing's credit/background consent question, in the applicant's own sentence (or the
   * manager's rewording). Shown whenever the listing ASKS it: an optional consent question is still
   * the applicant's to tick, and the server orders screening only from this box. `ready` below gates
   * on `screeningRequired`, so an optional box may be left empty and a required one may not.
   */
  const screeningLabel = useMemo(
    () =>
      sub
        ? wizardFormFieldLabel(applicationConfigForApplicant(sub, "standard").config, "consentCredit", {
            applicantDefault: "I consent to a credit and background check",
          })
        : undefined,
    [sub],
  );
  const screeningRequired = useMemo(
    () => (sub ? isWizardFormFieldRequired(applicationConfigForApplicant(sub, "standard").config, "consentCredit") : false),
    [sub],
  );
  /**
   * The listing's truthfulness certification, in the applicant's own sentence (or the manager's, when
   * they reworded the question). It is a legal attestation — the manager reads it as "Accuracy
   * confirmed" and the application PDF prints it as acknowledged — so the applicant ticks THIS or
   * nothing is recorded: the server stamps the answer only from this box (`quick-apply.server.ts`),
   * never from the confirmation below it, and never for a listing that does not ask.
   */
  const truthLabel = useMemo(
    () =>
      sub
        ? wizardFormFieldLabel(applicationConfigForApplicant(sub, "standard").config, "consentTruth", {
            applicantDefault: "I confirm the information provided is true and complete.",
          })
        : undefined,
    [sub],
  );
  const truthRequired = useMemo(
    () => (sub ? isWizardFormFieldRequired(applicationConfigForApplicant(sub, "standard").config, "consentTruth") : false),
    [sub],
  );

  const ready =
    Boolean(propertyId) &&
    (!needsRoomPick || Boolean(roomId)) &&
    // Move-in is the one fact this sheet exists to collect; without it the server builds an empty lease.
    Boolean(moveIn) &&
    confirmCurrent &&
    signature.trim().length > 1 &&
    (!screeningRequired || consentCredit) &&
    (!truthRequired || consentTruth);

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/portal/quick-apply", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId,
          roomId: entireHome ? undefined : roomId || undefined,
          leaseStart: moveIn || undefined,
          consentCredit,
          consentTruth,
          confirmCurrent,
          signature: signature.trim(),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as QuickApplyResponse;
      if (body.ok && body.href) {
        // The new row belongs in the resident's Pending list before they land on it.
        await syncManagerApplicationsFromServer({ force: true, selfScope: true }).catch(() => undefined);
        resetQuickApplyReadiness();
        showToast("Application submitted");
        onClose();
        go(body.href);
        return;
      }
      if ((body.needsWizard || body.needsPayment) && body.href) {
        showToast(body.needsPayment ? "One step left: the application fee." : "A few answers are needed. Opening the application.");
        onClose();
        go(body.href);
        return;
      }
      setError(body.error || "We couldn't submit your application. Try again.");
    } catch {
      setError("We couldn't submit your application. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const picking = !fixedPropertyId && !pickedId;
  return (
    <Modal
      open={open}
      title="Quick apply"
      onClose={onClose}
      panelClassName="max-w-lg"
      assistantContext="Quick apply"
      assistantStorageScopeKey="Quick apply"
      footer={
        picking ? undefined : (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              {!fixedPropertyId ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full px-4 text-[13px]"
                  data-attr="quick-apply-change-listing"
                  onClick={() => setPickedId(null)}
                >
                  Change listing
                </Button>
              ) : null}
              {onFullApplication && propertyId ? (
                <Button
                  type="button"
                  variant="outline"
                  className="rounded-full px-4 text-[13px]"
                  data-attr="quick-apply-full"
                  onClick={() => onFullApplication(propertyId)}
                >
                  Full application
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              variant="primary"
              className="rounded-full"
              data-attr="quick-apply-submit"
              disabled={!ready || busy}
              onClick={() => submit()}
            >
              {busy ? "Submitting…" : "Submit"}
            </Button>
          </div>
        )
      }
    >
      {picking ? (
        <PropertySearchPicker
          options={options}
          value={pickedId}
          onChange={setPickedId}
          placeholder="Search by address, neighborhood, or property name…"
          emptyMessage="No properties match your search."
          listEmptyMessage="No properties are available to apply for right now."
          ariaLabel="Search properties to apply for"
        />
      ) : (
        <div className="space-y-3" data-attr="quick-apply-sheet">
          {!fixedPropertyId ? (
            <p className="text-sm font-bold text-foreground" data-attr="quick-apply-listing">{property?.title ?? ""}</p>
          ) : null}
          {needsRoomPick ? (
            <label className="block text-xs font-semibold text-muted">
              Room
              <Select aria-label="Room" className="mt-1" value={roomId} onChange={(e) => setRoomId(e.target.value)}>
                <option value="">Choose a room</option>
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>{room.name}</option>
                ))}
              </Select>
            </label>
          ) : null}
          <label className="block text-xs font-semibold text-muted">
            Move-in
            <DateField value={moveIn} onChange={setMoveIn} min={pacificTodayKey()} className="mt-1" aria-label="Move-in" />
          </label>
          {screeningLabel ? (
            <CheckboxOption
              label={screeningLabel}
              checked={consentCredit}
              onChange={setConsentCredit}
              dataAttr="quick-apply-consent-screening"
            />
          ) : null}
          {truthLabel ? (
            <CheckboxOption
              label={truthLabel}
              checked={consentTruth}
              onChange={setConsentTruth}
              dataAttr="quick-apply-consent-truth"
            />
          ) : null}
          <CheckboxOption
            label="I confirm my saved answers are current"
            checked={confirmCurrent}
            onChange={setConfirmCurrent}
            dataAttr="quick-apply-confirm-current"
          />
          <label className="block text-xs font-semibold text-muted">
            Signature
            <Input
              aria-label="Signature"
              className="mt-1"
              autoComplete="name"
              placeholder="Type your full legal name"
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
            />
          </label>
          {error ? (
            <p className="text-sm font-semibold text-[var(--status-overdue-fg)]" role="alert" data-attr="quick-apply-error">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}

/** Mounted only while open, so every opening starts clean and the room and date the card holds carry in. */
export function QuickApplySheet(props: QuickApplySheetProps) {
  return props.open ? <QuickApplySheetBody {...props} /> : null;
}
