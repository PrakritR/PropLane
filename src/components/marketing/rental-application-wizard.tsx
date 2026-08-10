"use client";

import { track } from "@/lib/analytics/track-client";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { PORTAL_DETAIL_BTN } from "@/components/portal/portal-data-table";
import {
  loadPublicExtraListingsFromServer,
  loadPublicPropertyLeadFromServer,
  PROPERTY_PIPELINE_EVENT,
  isPropertyActiveForLeads,
  readExtraListingsPublic,
} from "@/lib/demo-property-pipeline";
import { filterSandboxFromPublicCatalog } from "@/lib/public-sandbox-listings";
import { isProductionPublicSite } from "@/lib/public-demo-access";
import {
  ensurePendingApplicationFeeCharge,
  findApplicationFeeCharge,
  HOUSEHOLD_CHARGES_EVENT,
  markApplicationFeePaidAfterStripe,
  recordApplicationCharges,
  removePendingApplicationFeeCharge,
} from "@/lib/household-charges";
import { fetchApplicationFeePreview } from "@/lib/rental-application/application-fee-preview-client";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";
import {
  getBundleOptionsForProperty,
  getPropertyById,
  getPropertyForPublicLink,
  getRoomOptionsForProperty,
  isEntireHomeProperty,
  isPropertyRentedByRoom,
  isRoomApprovedConflict,
  isRoomPendingConflict,
  LISTING_ROOM_CHOICE_SEP,
} from "@/lib/rental-application/data";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { resolveApplicationFeePayChannel, isAchApplicationFeeChannel } from "@/lib/rental-application/application-fee-channel";
import {
  clearRentalWizardDraft,
  loadPublicApplyResumeAxisId,
  loadRentalWizardDraft,
  loadRentalWizardDraftAxisId,
  rememberPublicApplyResumeAxisId,
  saveRentalWizardDraft,
  saveRentalWizardDraftAxisId,
} from "@/lib/rental-application/drafts";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  applicationsForResidentEmail,
  residentApplicationFeeGate,
  residentApplicationSubmitBlocked,
} from "@/lib/rental-application/application-policy";
import {
  findInProgressRowForTarget,
  isInProgressApplicationRow,
  markApplicationSubmitInitiated,
  shouldSyncInProgressDraft,
  switchApplicationTargetProperty,
  syncInProgressApplicationRow,
  targetMatchesApplication,
  type ApplicationRequestTarget,
} from "@/lib/rental-application/in-progress-application";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { GroupRole, RentalWizardErrors, RentalWizardFormState } from "@/lib/rental-application/types";
import { resolveSubmitGroupId, makeApplicationGroupId } from "@/lib/rental-application/application-groups";
import {
  parseGroupLeaderAppIdParam,
  GROUP_LEADER_APP_ID_PARAM,
  groupLeaderInviteFormPatch,
} from "@/lib/rental-application/group-apply-link";
import { fetchGroupLeaderLinkPreview } from "@/lib/rental-application/group-leader-link-client";
import { rentalWizardStepTitle } from "@/lib/rental-application/wizard-step-titles";
import {
  computeLeaseEndDate,
  normalizeIsoDateInput,
  shouldAutoComputeLeaseEnd,
} from "@/lib/rental-application/lease-dates";
import { RENTAL_WIZARD_STEP_COUNT } from "@/lib/rental-application/types";
import { normalizePersistedWizardStep } from "@/lib/rental-application/wizard-step-schema";
import { normalizeCustomApplicationFields } from "@/lib/manager-listing-submission";
import {
  activeApplicationWizardSteps,
  applicationConfigForVariant,
} from "@/lib/rental-application/application-field-catalog";
import { digitsOnly, maskPhoneInput, maskSsnInput } from "@/lib/rental-application/masks";
import { countValidationErrors, validateRentalWizardStep } from "@/lib/rental-application/validate";
import { sanitizeApplicationFormForListing } from "@/lib/rental-application/validate-application-submit";
import {
  RENTAL_WIZARD_STEP_FIELD_ORDER,
  scrollToFirstWizardFieldError,
} from "@/lib/wizard-field-errors";
import {
  APPLICATION_SAVE_STATUS_EVENT,
  getApplicationSetupToken,
  rememberApplicationSetupToken,
  replaceManagerApplicationRowInCache,
  syncManagerApplicationsFromServer,
  syncPublicApprovedApplicationsFromServer,
  upsertApplicationRowToServerAwait,
} from "@/lib/manager-applications-storage";
import { residentSetupIdFromUrlParams } from "@/lib/auth/resident-setup-token";
import { RentalWizardStepBody } from "./rental-wizard-steps";
import { ManagerLinkGate } from "@/components/marketing/manager-link-gate";
import { ApplicationUnavailableContactManager } from "@/components/marketing/application-unavailable-contact-manager";
import { RentalApplicationFinishPanel } from "@/components/marketing/rental-application-finish-panel";
import {
  activeWizardProgressPct,
  canNavigateToWizardStep,
  nextActiveWizardStep,
  nextWizardMaxReached,
  prevActiveWizardStep,
} from "@/lib/wizard-step-nav";
import { residentBrowseFromApplicationHref } from "@/lib/resident-public-nav";
import { isDemoModeActive, DEMO_GUIDED_USER_ID } from "@/lib/demo/demo-session";
import { isElementOnScreen } from "@/lib/dom-visibility";
import { buildDemoApplicationAutofill } from "@/lib/demo/demo-application-autofill";
import {
  DEMO_APPLICATION_SUBMITTED_EVENT,
  DEMO_CLOSE_RESIDENT_APPLY_EVENT,
  DEMO_RENTAL_AUTOFILL_EVENT,
} from "@/lib/demo/demo-playback";
import { propertyAcceptingOnlineApplications } from "@/lib/property-application-template-sync";

const processedApplicationFeeSessions = new Set<string>();

export type RentalApplicationWizardMode = "public" | "portal" | "manager";

export type RentalApplicationWizardProps = {
  showToast: (msg: string) => void;
  mode?: RentalApplicationWizardMode;
  exitPath?: string;
  sessionEmail?: string;
  /** Portal table layout — drops the standalone page chrome. */
  layout?: "standalone" | "embedded";
  /** Demo / embedded portal apply when URL search params are unavailable. */
  linkedPropertyId?: string;
  /**
   * Portal-only URL for wizard step sync and fee-checkout return. Defaults to
   * `/resident/applications/apply`; pass the application detail path when the
   * wizard is embedded on `/resident/applications/{bucket}/{id}`.
   */
  applyPath?: string;
  onManagerSendToResident?: (payload: { axisId: string }) => void;
  onManagerCancel?: () => void;
  managerActionBusy?: boolean;
  /**
   * Manager property preview — walk through the applicant wizard without saving
   * drafts, syncing rows, or submitting.
   */
  templatePreview?: boolean;
  /** Pre-select long-term vs short-term when `linkedPropertyId` is set without URL params. */
  linkedRentalType?: "standard" | "short_term";
};

function makeNewApplicationId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `PROPLANE-${crypto.randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  }
  return `PROPLANE-${Date.now().toString(36).toUpperCase()}`;
}

function ensureRentalWizardAxisId(): string {
  const existing = loadRentalWizardDraftAxisId()?.trim();
  if (existing) return existing;
  const id = makeNewApplicationId();
  saveRentalWizardDraftAxisId(id);
  return id;
}

function rentalApplicationExitPath(mode: RentalApplicationWizardMode, exitPath?: string): string {
  if (exitPath?.startsWith("/")) return exitPath;
  if (mode === "manager") return "/portal/applications/incomplete";
  return mode === "portal" ? "/resident/applications" : "/auth/sign-in";
}

function rentalApplicationApplyPath(mode: RentalApplicationWizardMode): string {
  return mode === "portal" ? "/resident/applications/apply" : "/rent/apply";
}

function wizardTargetFromParam(
  searchParams: { get: (key: string) => string | null },
): ApplicationRequestTarget | null {
  const propertyId = searchParams.get("propertyId")?.trim() || "";
  if (!propertyId) return null;
  return {
    propertyId,
    listingRoomId: searchParams.get("listingRoomId")?.trim() || undefined,
    bundleId: searchParams.get("bundle")?.trim() || undefined,
  };
}

function wizardTargetSignature(target: ApplicationRequestTarget | null): string {
  if (!target) return "";
  return [target.propertyId, target.listingRoomId ?? "", target.bundleId ?? ""].join("::");
}

export { isElementOnScreen };

/** `wizardStep` is only ever written for steps 1-3 (see the step-tracking effect below), so a value outside that range is never trustworthy. */
function parseBoundedWizardStep(raw: string | null): number | null {
  if (!raw) return null;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 3) return null;
  return parsed;
}

/**
 * The step persisted on the SERVER application record can be any real step
 * (1..RENTAL_WIZARD_STEP_COUNT), unlike the URL param which is capped at 3. This
 * is what resumes a resident at step 12 after they return from an external
 * redirect (a Stripe checkout) or reload deep in the form, instead of dumping
 * them back at step 1.
 */
export function parsePersistedWizardStep(raw: unknown, schema?: unknown): number | null {
  return normalizePersistedWizardStep(raw, schema);
}

/**
 * The portal-mode step effect below writes `?wizardStep=N` to the URL for
 * steps 1-3 (removing it above step 3) so a resumed session can land back
 * where it left off — but nothing ever READ it back on mount, so `step`
 * always started at `useState(1)` regardless of the URL. Any remount while
 * on steps 1-3 (a real page reload, or the browser restoring a tab) therefore
 * silently threw the resident back to "Group Application" even though their
 * draft — property, room, everything — was intact. Only trust the param when
 * the locally-loaded draft still matches THIS request's target; otherwise a
 * stale `wizardStep` left over from a different property/room must not skip
 * a fresh application ahead. This covers the fast path where the in-memory
 * draft (module-level, not persisted to disk) survived — e.g. a remount
 * within the same tab. A genuine full-page reload wipes that draft entirely,
 * so the reconciliation effect below ALSO restores `step` once it confirms
 * (via a server fetch) that this target really does match an existing
 * in-progress application. See `tests/unit/rental-wizard-step-resume.test.tsx`.
 */
export function initialWizardStepFromRequest(
  mode: RentalApplicationWizardMode,
  target: ApplicationRequestTarget | null,
  searchParams: { get: (key: string) => string | null },
): number {
  if (mode !== "portal") return 1;
  const parsed = parseBoundedWizardStep(searchParams.get("wizardStep"));
  if (!parsed) return 1;
  const draft = loadRentalWizardDraft();
  if (!draft) return 1;
  if (target && !targetMatchesApplication(target, { application: draft })) return 1;
  return parsed;
}

const activeRentalWizardsByDocument = new WeakMap<Document, number>();

/**
 * Suppress the floating assistant while a portal application wizard owns the
 * bottom action area. The resident list mounts separate mobile and desktop
 * wizard copies, so this is reference-counted rather than a blind set/remove.
 */
export function markRentalWizardActive(doc: Document): () => void {
  const root = doc.documentElement;
  const nextCount = (activeRentalWizardsByDocument.get(doc) ?? 0) + 1;
  activeRentalWizardsByDocument.set(doc, nextCount);
  root.setAttribute("data-rental-wizard-active", "");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = Math.max(0, (activeRentalWizardsByDocument.get(doc) ?? 1) - 1);
    if (remaining > 0) {
      activeRentalWizardsByDocument.set(doc, remaining);
      return;
    }
    activeRentalWizardsByDocument.delete(doc);
    root.removeAttribute("data-rental-wizard-active");
  };
}

export function RentalApplicationWizard({
  showToast,
  mode = "public",
  exitPath,
  sessionEmail,
  layout = "standalone",
  linkedPropertyId: linkedPropertyIdProp,
  applyPath,
  onManagerSendToResident,
  onManagerCancel,
  managerActionBusy = false,
  templatePreview = false,
  linkedRentalType,
}: RentalApplicationWizardProps) {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-3xl px-4 py-16 text-center text-muted">Loading application…</div>
      }
    >
      <RentalApplicationWizardInner
        showToast={showToast}
        mode={mode}
        exitPath={exitPath}
        sessionEmail={sessionEmail}
        layout={layout}
        linkedPropertyId={linkedPropertyIdProp}
        applyPath={applyPath}
        onManagerSendToResident={onManagerSendToResident}
        onManagerCancel={onManagerCancel}
        managerActionBusy={managerActionBusy}
        templatePreview={templatePreview}
        linkedRentalType={linkedRentalType}
      />
    </Suspense>
  );
}

function RentalApplicationWizardInner({
  showToast,
  mode = "public",
  exitPath,
  sessionEmail,
  layout = "standalone",
  linkedPropertyId: linkedPropertyIdProp,
  applyPath,
  onManagerSendToResident,
  onManagerCancel,
  managerActionBusy = false,
  templatePreview = false,
  linkedRentalType,
}: RentalApplicationWizardProps) {
  const searchParams = useSearchParams();
  const requestedTarget = wizardTargetFromParam(searchParams);
  const requestedTargetSignature = wizardTargetSignature(requestedTarget);
  const [step, setStep] = useState(() => initialWizardStepFromRequest(mode, requestedTarget, searchParams));
  const [maxStepReached, setMaxStepReached] = useState(() => initialWizardStepFromRequest(mode, requestedTarget, searchParams));
  // Frozen at mount, from the URL as it arrived — NOT re-read later. The
  // step-tracking effect below fires on the very first render (since `step`
  // starts at 1 whenever the local draft fast path above didn't apply) and
  // immediately overwrites `?wizardStep=` to match, so by the time the async
  // reconciliation effect's server fetch resolves, `searchParams.get(
  // "wizardStep")` would already read back that clobbered "1" instead of the
  // real value the resident's browser actually requested — losing the resume
  // step in exactly the full-reload case this exists to fix.
  const initialWizardStepParamRef = useRef(searchParams.get("wizardStep"));
  const [form, setForm] = useState<RentalWizardFormState>(() => {
    const leaderAppIdFromUrl = templatePreview
      ? ""
      : parseGroupLeaderAppIdParam(searchParams.get(GROUP_LEADER_APP_ID_PARAM));
    const groupInvitePatch = leaderAppIdFromUrl ? groupLeaderInviteFormPatch(leaderAppIdFromUrl) : {};

    if (templatePreview) {
      const pid = linkedPropertyIdProp?.trim() ?? "";
      const shortTerm = linkedRentalType === "short_term";
      return {
        ...createInitialRentalWizardState(),
        ...(pid
          ? {
              propertyId: pid,
              rentalType: shortTerm ? ("short_term" as const) : ("standard" as const),
              leaseTerm: shortTerm ? SHORT_TERM_LEASE_TERM : "",
            }
          : {}),
      };
    }
    const draft = loadRentalWizardDraft();
    if (!draft) return { ...createInitialRentalWizardState(), ...groupInvitePatch };
    // A draft still loaded (same tab, no reload) for a DIFFERENT property/room
    // than this request must never flash onto a fresh apply — start blank and
    // let the reconciliation effect resolve the real target (an existing
    // in-progress application for it, or a clean new one).
    if (requestedTarget && draft && !targetMatchesApplication(requestedTarget, { application: draft })) {
      clearRentalWizardDraft();
      return { ...createInitialRentalWizardState(), ...groupInvitePatch };
    }
    return { ...createInitialRentalWizardState(), ...draft, ...groupInvitePatch };
  });
  // Tracks which target signature has been confirmed (matched to an existing
  // in-progress application, or confirmed fresh) by the reconciliation effect.
  // While it disagrees with the CURRENT requested target, no other effect may
  // mint a new axis id or sync/create an application row — otherwise a reload
  // can create a duplicate before the async server lookup below has a chance
  // to find the real match. Mirrors the `form` initializer's own draft-match
  // check (rather than sharing it via a ref, which render may not read/write).
  //
  // A local draft ALONE is not proof this target was already reconciled: on a
  // fresh navigation, the listing-prefill effect can populate a brand-new
  // draft's propertyId/room from the SAME URL before this ever runs, which
  // would coincidentally "match" a target it has never actually checked
  // against the server. Only an already-saved axis id proves this exact
  // session already resolved (found-or-created) a real application for it.
  const [reconciledSignature, setReconciledSignature] = useState<string>(() => {
    if (!loadRentalWizardDraftAxisId()?.trim()) return "";
    const draft = loadRentalWizardDraft();
    const matchedTarget = !draft
      ? !requestedTarget
      : !requestedTarget || targetMatchesApplication(requestedTarget, { application: draft });
    return matchedTarget ? requestedTargetSignature : "";
  });
  const isReconcilingTarget = Boolean(requestedTargetSignature) && reconciledSignature !== requestedTargetSignature;
  const [errors, setErrors] = useState<RentalWizardErrors>({});
  const [draftReady] = useState(true);
  const [applicationAxisId, setApplicationAxisId] = useState(
    () => loadRentalWizardDraftAxisId()?.trim() ?? "",
  );
  const ensureApplicationId = useCallback(() => {
    const id = ensureRentalWizardAxisId();
    setApplicationAxisId((prev) => (prev === id ? prev : id));
    return id;
  }, []);
  const [extrasTick, setExtrasTick] = useState(0);
  const [chargeTick, setChargeTick] = useState(0);
  const [feeStepUserId, setFeeStepUserId] = useState<string | null>(null);
  const [reviewReturnStep, setReviewReturnStep] = useState<number | null>(null);
  const [postSubmit, setPostSubmit] = useState<{
    axisId: string;
    email: string;
    propertyTitle?: string;
    emailSent?: boolean;
    syncError?: string;
    guestFlow?: boolean;
    mailtoHref?: string;
    setupHref?: string;
    /** Organizer application id for group invite link on the finish screen. */
    groupLeaderAppId?: string;
    groupRole?: GroupRole;
    groupSize?: string;
    groupPropertyId?: string;
    hasCosigner?: "yes" | "no" | null;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showAvailabilityWarnings, setShowAvailabilityWarnings] = useState(false);
  const [demoAutofillSubmitPending, setDemoAutofillSubmitPending] = useState(false);
  /** Bumps after server sync so step 3 room dropdowns re-filter against approved occupancy. */
  const [occupancySyncEpoch, setOccupancySyncEpoch] = useState(0);
  const [applicationFeeCheckBusy, setApplicationFeeCheckBusy] = useState(false);
  const [applicationFeeCheckError, setApplicationFeeCheckError] = useState<string | null>(null);
  /**
   * SERVER-authoritative application fee (cents) for the CURRENT property,
   * from `/api/public/application-fee-preview`. The gate, the displayed
   * amount, and the booked charge all derive from this one answer — never
   * from the browser catalog's per-listing fee, which is only the
   * grandfathered fallback and can disagree with what checkout charges.
   * `null` = not resolved yet, which the gate treats as "fee unknown, hold
   * the applicant", never as free.
   */
  const [serverFee, setServerFee] = useState<{ propertyId: string; cents: number } | null>(null);
  const [waiverCodeBusy, setWaiverCodeBusy] = useState(false);
  const [waiverCodeError, setWaiverCodeError] = useState<string | null>(null);
  /** True when the most recent background autosave of THIS application failed. */
  const [autosaveFailed, setAutosaveFailed] = useState(false);
  const router = useRouter();

  // The step ids that carry a visible question for the CURRENT form variant.
  // Section steps (3-10) fall out when the variant has no question in them, so
  // the short-term form skips the screening sections its curated default turns
  // off. Short-term correctness rides on `rentalType` alone (curated default),
  // but custom manager questions and a manager-customized short-term slice come
  // from the listing submission, which loads asynchronously — so `extrasTick`
  // (bumped when the public catalog arrives) is a dep, otherwise a resumed draft
  // whose propertyId is set at mount would compute against a missing submission
  // and never recompute, disagreeing with the step bodies and `validateAllPrior`.
  const activeSteps = useMemo(() => {
    void extrasTick;
    const prop = form.propertyId.trim() ? getPropertyById(form.propertyId.trim()) : undefined;
    const listingSub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
    return activeApplicationWizardSteps(
      applicationConfigForVariant(listingSub, form.rentalType),
      normalizeCustomApplicationFields,
    );
  }, [form.propertyId, form.rentalType, extrasTick]);
  const nextActiveStep = useCallback(
    (from: number) => nextActiveWizardStep(activeSteps, from),
    [activeSteps],
  );
  const prevActiveStep = useCallback(
    (from: number) => prevActiveWizardStep(activeSteps, from),
    [activeSteps],
  );
  const wizardExitPath = rentalApplicationExitPath(mode, exitPath);
  const wizardApplyPath =
    applyPath?.startsWith("/") ? applyPath : rentalApplicationApplyPath(mode);
  const browseHomesHref = residentBrowseFromApplicationHref(wizardApplyPath);
  /**
   * `ResidentApplicationsPanel` renders an expanded in-progress row's detail
   * TWICE per row — once inside the `lg:hidden` mobile card list, once inside
   * the `hidden lg:block` desktop table — so CSS, not React, decides which
   * is on screen. Both mounts are fully live `RentalApplicationWizardInner`
   * instances with independent `step` state. Without this guard, the
   * off-screen instance's `step` never advances (it receives no clicks), so
   * its copy of THIS effect kept firing on every `searchParams` change and
   * rewriting `?wizardStep=` back down to whatever ITS stale `step` was —
   * fighting the on-screen instance's own writes in an unthrottled
   * `router.replace` loop, hundreds of times per second. That is the actual
   * "glitches and goes back to start of application" the captain saw: only
   * the ON-SCREEN instance may own the URL's step bookkeeping.
   */
  const rootRef = useRef<HTMLDivElement>(null);
  const isOnScreen = useCallback(() => isElementOnScreen(rootRef.current), []);

  useLayoutEffect(() => {
    if (!templatePreview) return;
    const scrollParent = rootRef.current?.closest(".overflow-y-auto");
    scrollParent?.scrollTo({ top: 0 });
    rootRef.current?.querySelector(".rental-wizard-step-content")?.scrollTo?.({ top: 0 });
  }, [templatePreview, step]);

  useEffect(() => {
    if (templatePreview || form.applicantRole !== "cosigner") return;
    const query = searchParams.toString();
    router.replace(query ? `/rent/apply/cosigner?${query}` : "/rent/apply/cosigner");
  }, [form.applicantRole, router, searchParams, templatePreview]);

  useEffect(() => {
    if (mode !== "portal" && mode !== "manager") return;
    return markRentalWizardActive(document);
  }, [mode]);

  useEffect(() => {
    if (templatePreview) return;
    if (mode !== "portal" || postSubmit || isDemoModeActive() || !isOnScreen()) return;
    const params = new URLSearchParams(searchParams.toString());
    const prev = params.get("wizardStep");
    if (step <= 3) {
      const next = String(step);
      if (prev === next) return;
      params.set("wizardStep", next);
    } else if (prev) {
      params.delete("wizardStep");
    } else {
      return;
    }
    const qs = params.toString();
    router.replace(qs ? `${wizardApplyPath}?${qs}` : wizardApplyPath, { scroll: false });
  }, [mode, postSubmit, router, searchParams, step, templatePreview, wizardApplyPath, isOnScreen]);

  const exitApplication = useCallback(() => {
    if (templatePreview) {
      onManagerCancel?.();
      return;
    }
    if (mode === "manager") {
      onManagerCancel?.();
      return;
    }
    if (isDemoModeActive()) {
      window.dispatchEvent(new Event(DEMO_CLOSE_RESIDENT_APPLY_EVENT));
      return;
    }
    router.push(wizardExitPath);
  }, [mode, onManagerCancel, router, templatePreview, wizardExitPath]);

  const listingPrefillKey = useMemo(() => {
    return [
      searchParams.get("propertyId") ?? linkedPropertyIdProp?.trim() ?? "",
      searchParams.get("roomName") ?? "",
      searchParams.get("floor") ?? "",
      searchParams.get("roomPrice") ?? "",
      searchParams.get("listingRoomId") ?? "",
      searchParams.get("bundle") ?? "",
      searchParams.get("phone") ?? "",
      searchParams.get("rentalType") ?? linkedRentalType ?? "",
    ].join("|");
  }, [linkedPropertyIdProp, linkedRentalType, searchParams]);

  const linkedPropertyId =
    linkedPropertyIdProp?.trim() || searchParams.get("propertyId")?.trim() || "";

  /** listingPrefillKey already applied to the form — prevents re-clobbering user edits when catalogs refresh. */
  const listingPrefillAppliedRef = useRef("");
  const startedSetupEmailAxisRef = useRef<string | null>(null);

  useEffect(() => {
    void syncPublicApprovedApplicationsFromServer().then(() => setOccupancySyncEpoch((n) => n + 1));
  }, []);

  useEffect(() => {
    if (mode !== "portal") return;
    void loadPublicExtraListingsFromServer().then(() => setExtrasTick((n) => n + 1));
  }, [mode]);

  useEffect(() => {
    const on = () => setExtrasTick((n) => n + 1);
    if (linkedPropertyId) {
      void loadPublicPropertyLeadFromServer(linkedPropertyId).then(() => on());
    }
    window.addEventListener(PROPERTY_PIPELINE_EVENT, on);
    return () => window.removeEventListener(PROPERTY_PIPELINE_EVENT, on);
  }, [linkedPropertyId]);

  useEffect(() => {
    const on = () => setChargeTick((n) => n + 1);
    window.addEventListener(HOUSEHOLD_CHARGES_EVENT, on);
    return () => window.removeEventListener(HOUSEHOLD_CHARGES_EVENT, on);
  }, []);

  // Surface autosave failures for THIS application. A background save that fails
  // must never disappear silently — raise a banner so the resident knows their
  // latest changes are not yet saved, and clear it the moment a save lands.
  useEffect(() => {
    if (isDemoModeActive()) return;
    const on = (e: Event) => {
      const detail = (e as CustomEvent<{ ok?: boolean; id?: string }>).detail;
      if (!detail?.id) return;
      const mine = loadRentalWizardDraftAxisId()?.trim();
      if (!mine || detail.id.trim() !== mine) return;
      setAutosaveFailed(!detail.ok);
    };
    window.addEventListener(APPLICATION_SAVE_STATUS_EVENT, on as EventListener);
    return () => window.removeEventListener(APPLICATION_SAVE_STATUS_EVENT, on as EventListener);
  }, []);

  useEffect(() => {
    if (!isDemoModeActive()) return;
    const onAutofill = (e: Event) => {
      const detail = (e as CustomEvent<{
        propertyId?: string;
        form?: RentalWizardFormState;
        submitAfter?: boolean;
      }>).detail;
      const pid = detail?.propertyId?.trim();
      if (!pid) return;
      const next = detail?.form ?? buildDemoApplicationAutofill(pid);
      setForm(next);
      setMaxStepReached(RENTAL_WIZARD_STEP_COUNT);
      setStep(detail?.submitAfter ? RENTAL_WIZARD_STEP_COUNT : 1);
      setErrors({});
      clearRentalWizardDraft();
      saveRentalWizardDraft(next);
      saveRentalWizardDraftAxisId(ensureRentalWizardAxisId());
      if (detail?.submitAfter) setDemoAutofillSubmitPending(true);
    };
    window.addEventListener(DEMO_RENTAL_AUTOFILL_EVENT, onAutofill as EventListener);
    return () => window.removeEventListener(DEMO_RENTAL_AUTOFILL_EVENT, onAutofill as EventListener);
  }, []);

  useEffect(() => {
    if (step !== 11) return;
    let cancelled = false;
    void (async () => {
      try {
        const supabase = createSupabaseBrowserClient();
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!cancelled) setFeeStepUserId(user?.id ?? null);
      } catch {
        if (!cancelled) setFeeStepUserId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step]);

  // Resolve the server's effective fee once the applicant reaches the review
  // or fee step (re-runs as catalogs arrive via extrasTick, since the
  // listing's managerUserId may not be resolvable on a cold browser).
  useEffect(() => {
    if ((step !== 10 && step !== 11) || isDemoModeActive()) return;
    const pid = form.propertyId.trim();
    if (!pid) return;
    const managerUserId = getPropertyById(pid)?.managerUserId?.trim() ?? "";
    if (!managerUserId) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const load = () => {
      void fetchApplicationFeePreview({ propertyId: pid, managerUserId, rentalType: form.rentalType }).then((preview) => {
        if (cancelled) return;
        if (!preview) {
          // Transient failure — keep the gate closed (fee unknown) and retry
          // rather than leaving the applicant stuck on "Confirming…".
          retryTimer = window.setTimeout(load, 4000);
          return;
        }
        setServerFee({ propertyId: pid, cents: preview.applicationFeeCents });
      });
    };
    load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [step, form.propertyId, form.rentalType, extrasTick]);

  const propertyOptions = useMemo(() => {
    void extrasTick;
    if (mode === "portal") {
      return filterSandboxFromPublicCatalog(readExtraListingsPublic(), {
        production: isProductionPublicSite(),
      })
        .filter(isPropertyActiveForLeads)
        .map((property) => ({ value: property.id, label: property.title }))
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    if (!linkedPropertyId) return [];
    const prop = getPropertyForPublicLink(linkedPropertyId);
    if (!prop) return [];
    return [{ value: prop.id, label: prop.title }];
  }, [extrasTick, linkedPropertyId, mode]);

  const linkedProperty = useMemo(() => {
    void extrasTick;
    if (linkedPropertyId) return getPropertyForPublicLink(linkedPropertyId);
    if (mode === "portal") {
      const pid = form.propertyId.trim();
      if (!pid) return undefined;
      return getPropertyForPublicLink(pid) ?? getPropertyById(pid);
    }
    return undefined;
  }, [extrasTick, form.propertyId, linkedPropertyId, mode]);

  const canRenderWizard = useMemo(() => {
    if (mode === "portal") {
      if (linkedPropertyId) return Boolean(linkedProperty);
      return true;
    }
    if (mode === "manager") return Boolean(linkedPropertyId && linkedProperty);
    return Boolean(linkedPropertyId && linkedProperty);
  }, [linkedProperty, linkedPropertyId, mode]);

  const applicationsAvailable = useMemo(() => {
    void extrasTick;
    if (templatePreview || mode === "manager") return true;
    const prop = linkedProperty;
    if (!prop?.listingSubmission) return true;
    return propertyAcceptingOnlineApplications(prop.listingSubmission);
  }, [extrasTick, linkedProperty, mode, templatePreview]);

  useEffect(() => {
    if (templatePreview) return;
    if (mode !== "portal" && mode !== "manager") return;
    const email = sessionEmail?.trim();
    if (!email?.includes("@")) return;
    queueMicrotask(() => {
      setForm((prev) => (prev.email.trim() ? prev : { ...prev, email }));
    });
  }, [mode, sessionEmail, templatePreview]);

  useEffect(() => {
    if (templatePreview) return;
    // The off-screen duplicate mount (see the `isOnScreen` doc comment above)
    // must never write the shared, module-level draft: its `form` only holds
    // whatever it last reconciled and never receives the resident's actual
    // edits, so a later write from it would silently revert the on-screen
    // instance's fresher data the next time either instance reloads that
    // draft — the "room never lands on the application row" half of the bug.
    if (!draftReady || !isOnScreen()) return;
    saveRentalWizardDraft(form);
  }, [draftReady, form, templatePreview, isOnScreen]);

  useEffect(() => {
    if (templatePreview) return;
    if (!draftReady || !isOnScreen()) return;
    // Wait for reconciliation to confirm this target before minting an axis id
    // or writing anything to the server — otherwise a fresh page load can sync
    // a brand-new row before the async lookup below finds the real match.
    if (mode === "portal" && isReconcilingTarget) return;
    const email = (mode === "portal" || mode === "manager" ? sessionEmail ?? form.email : form.email).trim();
    const pid = form.propertyId.trim();
    if (!shouldSyncInProgressDraft({ email, propertyId: pid })) return;
    const axisId = ensureApplicationId();
    // The public flow's in-memory draft dies on a real reload — keep the axis id
    // (only the id, no answers) in sessionStorage so the resume effect below can
    // restore the saved application afterwards.
    if (mode === "public" && !isDemoModeActive()) rememberPublicApplyResumeAxisId(axisId);
    // Persist the live step alongside the answers so a reload / return from an
    // external redirect resumes exactly here (the debounced, serialized upsert
    // in `scheduleApplicationRowUpsert` coalesces these writes).
    syncInProgressApplicationRow({
      axisId,
      form,
      residentEmail: email,
      wizardStep: step,
      wizardMaxStepReached: maxStepReached,
    });

    if (mode !== "public" || isDemoModeActive()) return;
    if (startedSetupEmailAxisRef.current === axisId) return;

    const notifyKey = `application_started_notified_${axisId}`;
    if (typeof window !== "undefined" && window.sessionStorage.getItem(notifyKey) === "1") {
      startedSetupEmailAxisRef.current = axisId;
      return;
    }

    const timer = window.setTimeout(() => {
      void fetch("/api/portal/send-application-started", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim().toLowerCase(),
          axisId,
          setupToken: getApplicationSetupToken(axisId) ?? undefined,
        }),
      })
        .then((res) => {
          if (!res.ok) return;
          startedSetupEmailAxisRef.current = axisId;
          try {
            window.sessionStorage.setItem(notifyKey, "1");
          } catch {
            /* ignore */
          }
        })
        .catch(() => undefined);
    }, 2000);

    return () => window.clearTimeout(timer);
  }, [draftReady, form, mode, sessionEmail, templatePreview, isReconcilingTarget, isOnScreen, step, maxStepReached]);

  useEffect(() => {
    if (templatePreview) return;
    if (!draftReady || mode !== "portal") return;
    const email = (sessionEmail ?? form.email).trim().toLowerCase();
    if (!email.includes("@")) return; // resolved once email is known — effect reruns.

    // Derived fresh from searchParams (not the render-scoped `requestedTarget`
    // object, which is a new reference every render and would make this a
    // dependency that never stabilizes).
    const target = wizardTargetFromParam(searchParams);
    const signature = wizardTargetSignature(target);

    // A local draft is only trustworthy as "already reconciled" if it also
    // carries a saved axis id — proof this exact session already resolved
    // (found-or-created) a real application for it. Without one, a draft can
    // just be the listing-prefill effect's freshly populated propertyId/room
    // for THIS target, which would otherwise look like a false match and skip
    // the one server check that finds the real existing application.
    const existingAxisId = loadRentalWizardDraftAxisId()?.trim();
    const existingDraft = existingAxisId ? loadRentalWizardDraft() : null;
    if (existingDraft) {
      // Bare entry (no explicit property/room in the URL) — keep whatever is
      // already loaded; there's nothing more specific to reconcile against.
      // The loaded draft already IS this exact application — nothing to do.
      if (!target || targetMatchesApplication(target, { application: existingDraft })) {
        setReconciledSignature(signature);
        return;
      }
      // Otherwise the loaded draft belongs to a DIFFERENT property/room than
      // this request. Fall through and resolve the real target below instead
      // of letting an unrelated application's data silently carry over.
    }

    let cancelled = false;
    void syncManagerApplicationsFromServer({ force: true }).then(() => {
      if (cancelled) return;
      const inProgress = applicationsForResidentEmail(email).filter(isInProgressApplicationRow);
      const hit = findInProgressRowForTarget(inProgress, target);
      if (hit?.application) {
        // An in-progress application already exists for this exact target — resume it.
        saveRentalWizardDraftAxisId(hit.id);
        saveRentalWizardDraft({ ...createInitialRentalWizardState(), ...hit.application, email });
        setForm({ ...createInitialRentalWizardState(), ...hit.application, email });
        // The server confirmed this target IS an existing application, so we can
        // resume the resident's exact position even though the synchronous
        // local-draft fast path in `initialWizardStepFromRequest` couldn't (a
        // full page reload — or a return from a Stripe redirect — wipes the
        // in-memory draft before this effect ever runs). Prefer the step
        // PERSISTED ON THE RECORD (any step 1..12) so returning from an external
        // redirect at step 12 lands back at step 12, not step 1. Fall back to the
        // URL param (steps 1-3) read from the FROZEN ref — never a live
        // `searchParams` lookup, which the step-tracking effect already
        // overwrote to match `step`'s initial value of 1 before this async fetch
        // resolved.
        const persistedStep = parsePersistedWizardStep(hit.application.wizardStep, hit.application.wizardStepSchema);
        const resumedStep = persistedStep ?? parseBoundedWizardStep(initialWizardStepParamRef.current);
        const persistedMax = parsePersistedWizardStep(
          hit.application.wizardMaxStepReached,
          hit.application.wizardStepSchema,
        );
        if (resumedStep) {
          setStep(resumedStep);
          setMaxStepReached((prev) => Math.max(prev, persistedMax ?? 0, resumedStep));
        } else if (persistedMax) {
          setMaxStepReached((prev) => Math.max(prev, persistedMax));
        }
        setReconciledSignature(signature);
        return;
      }
      // No in-progress application matches this target. If a stale draft for
      // a different property/room is still loaded (same browser tab, no
      // reload), it must not bleed into a fresh application — clear it so a
      // new draft (and a new axis id, minted on next save) starts clean.
      if (target && existingDraft) {
        clearRentalWizardDraft();
        setForm({ ...createInitialRentalWizardState(), email });
      }
      // Either a match was found and loaded above, or none exists and this is
      // confirmed to be a genuinely fresh target — either way, it is now safe
      // for the sync/create effect to mint an axis id and write to the server.
      setReconciledSignature(signature);
    });
    return () => {
      cancelled = true;
    };
  }, [draftReady, form.email, mode, searchParams, sessionEmail, templatePreview]);

  // PUBLIC apply: restore an in-progress application after a real page reload
  useEffect(() => {
    if (templatePreview) return;
    if (!draftReady || mode !== "public" || isDemoModeActive()) return;
    if (loadRentalWizardDraftAxisId()?.trim()) return; // live draft present — nothing was lost
    const target = wizardTargetFromParam(searchParams);
    const tokenFromUrl = searchParams.get("token")?.trim();
    const axisIdFromUrl = residentSetupIdFromUrlParams(searchParams);
    if (tokenFromUrl && axisIdFromUrl) {
      rememberApplicationSetupToken(axisIdFromUrl, tokenFromUrl);
      rememberPublicApplyResumeAxisId(axisIdFromUrl);
    }
    let cancelled = false;
    void (async () => {
      let hit: DemoApplicantRow | null = null;
      const resumeAxisId = loadPublicApplyResumeAxisId()?.trim();
      const resumeToken = resumeAxisId ? getApplicationSetupToken(resumeAxisId) : null;
      if (resumeAxisId && resumeToken) {
        try {
          const res = await fetch("/api/portal/application-resume", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id: resumeAxisId, token: resumeToken }),
          });
          if (res.ok) {
            const body = (await res.json().catch(() => null)) as { row?: DemoApplicantRow } | null;
            if (body?.row?.application) hit = body.row;
          }
        } catch {
          /* resume is best-effort */
        }
      }
      if (!hit) {
        try {
          const res = await fetch("/api/manager-applications?scope=self", { credentials: "include" });
          if (res.ok) {
            const body = (await res.json().catch(() => null)) as { rows?: DemoApplicantRow[] } | null;
            const rows = (Array.isArray(body?.rows) ? body.rows : []).filter(isInProgressApplicationRow);
            hit = findInProgressRowForTarget(rows, target) ?? null;
          }
        } catch {
          /* signed out or transient — nothing to resume */
        }
      }
      if (cancelled || !hit?.application) return;
      if (target && !targetMatchesApplication(target, hit)) return;
      // A save may have landed while these reads were in flight — never clobber it.
      if (loadRentalWizardDraftAxisId()?.trim()) return;
      const email = (hit.email ?? "").trim();
      const restored: RentalWizardFormState = {
        ...createInitialRentalWizardState(),
        ...hit.application,
        ...(email ? { email } : {}),
      };
      saveRentalWizardDraftAxisId(hit.id);
      saveRentalWizardDraft(restored);
      setForm(restored);
        const persistedStep = parsePersistedWizardStep(hit.application.wizardStep, hit.application.wizardStepSchema);
        const persistedMax = parsePersistedWizardStep(
          hit.application.wizardMaxStepReached,
          hit.application.wizardStepSchema,
        );
      if (persistedStep) {
        setStep(persistedStep);
        setMaxStepReached((prev) => Math.max(prev, persistedMax ?? 0, persistedStep));
      } else if (persistedMax) {
        setMaxStepReached((prev) => Math.max(prev, persistedMax));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [draftReady, mode, searchParams]);

  useEffect(() => {
    if (!draftReady) return;
    const pid = (searchParams.get("propertyId") ?? "").trim() || linkedPropertyIdProp?.trim() || "";
    if (!pid) return;
    if (listingPrefillAppliedRef.current === listingPrefillKey) return;
    // Public listings load async on a cold browser — hold the prefill until the
    // property resolves so room/bundle auto-select doesn't silently miss
    // (extrasTick re-runs this effect as catalogs arrive).
    void extrasTick;
    if (!getPropertyById(pid)) return;
    listingPrefillAppliedRef.current = listingPrefillKey;

    const listingRoomId = searchParams.get("listingRoomId") ?? "";
    const bundleParam = (searchParams.get("bundle") ?? "").trim();
    const phoneParam = (searchParams.get("phone") ?? "").trim();
    const rentalTypeParam = (searchParams.get("rentalType") ?? linkedRentalType ?? "").trim();
    const shortTermFromLink = rentalTypeParam === "short_term";

    queueMicrotask(() => {
      setForm((prev) => {
        let base: RentalWizardFormState = prev;
        if (prev.propertyId.trim() && prev.propertyId.trim() !== pid) {
          const email = (sessionEmail ?? prev.email).trim().toLowerCase();
          const switched = switchApplicationTargetProperty({
            previousPropertyId: prev.propertyId,
            nextPropertyId: pid,
            inProgressRows: email.includes("@")
              ? applicationsForResidentEmail(email).filter(isInProgressApplicationRow)
              : [],
          });
          if (switched?.resumedApplication) {
            base = {
              ...createInitialRentalWizardState(),
              ...switched.resumedApplication,
              email: prev.email || switched.resumedApplication.email || "",
            };
          }
        }

        const opts = getRoomOptionsForProperty(pid, { includeUnavailable: true }).filter((o) => o.value);
        // Entire-home listings apply for the whole place — never pre-select a
        // bedroom, even when the listing page passed a room id for display.
        const entireHome = isEntireHomeProperty(pid);
        let room1 = entireHome ? pid : opts[0]?.value ?? "";
        const lr = listingRoomId.trim();
        if (lr && !entireHome) {
          const composite = `${pid}${LISTING_ROOM_CHOICE_SEP}${lr}`;
          const hit = opts.find((o) => o.value === composite);
          if (hit) room1 = hit.value;
        }

        // "Apply for this bundle" — pre-select the bundle when it matches a
        // manager-defined bundle on this listing. A bundle application on a
        // by-room listing carries no ranked room choices.
        const bundleId = bundleParam && getBundleOptionsForProperty(pid, { rentalType: shortTermFromLink ? "short_term" : "standard" }).some((o) => o.value === bundleParam)
          ? bundleParam
          : "";
        const bundleReplacesRooms = Boolean(bundleId) && isPropertyRentedByRoom(pid);

        const phoneDigits = digitsOnly(phoneParam).slice(-10);
        const phone =
          phoneDigits.length === 10 && digitsOnly(prev.phone).length < 10
            ? maskPhoneInput("", phoneDigits)
            : prev.phone;

        const rentalType = shortTermFromLink ? "short_term" : prev.rentalType;
        const leaseTerm = shortTermFromLink
          ? (prev.leaseTerm || SHORT_TERM_LEASE_TERM)
          : prev.rentalType === "short_term" && !shortTermFromLink
            ? ""
            : prev.leaseTerm;
        return {
          ...base,
          propertyId: pid,
          bundleId,
          phone,
          rentalType,
          leaseTerm,
          roomChoice1: bundleReplacesRooms ? "" : room1 || base.roomChoice1,
          roomChoice2: "",
          roomChoice3: "",
          // A restored draft may hold answers for a different listing's questions.
          ...(base.propertyId && base.propertyId !== pid ? { customFieldAnswers: [] } : {}),
        };
      });
    });
  }, [draftReady, extrasTick, linkedPropertyIdProp, linkedRentalType, listingPrefillKey, searchParams, sessionEmail]);

  useEffect(() => {
    if (!draftReady || templatePreview) return;
    const leaderAppId = parseGroupLeaderAppIdParam(searchParams.get(GROUP_LEADER_APP_ID_PARAM));
    if (!leaderAppId) return;

    let cancelled = false;
    void fetchGroupLeaderLinkPreview(leaderAppId).then((preview) => {
      if (cancelled) return;
      setForm((prev) => {
        const invitePatch = groupLeaderInviteFormPatch(leaderAppId);
        const next: RentalWizardFormState = {
          ...prev,
          ...invitePatch,
          ...(preview.ok
            ? {
                groupLeaderAppId: preview.leaderAppId,
                groupId: preview.groupId,
                ...(preview.groupSize != null && !prev.groupSize.trim()
                  ? { groupSize: String(preview.groupSize) }
                  : {}),
                ...(preview.propertyId && !prev.propertyId.trim()
                  ? { propertyId: preview.propertyId }
                  : {}),
              }
            : {}),
        };
        if (
          prev.groupLeaderAppId.trim().toUpperCase() === next.groupLeaderAppId.trim().toUpperCase() &&
          prev.applyingAsGroup === next.applyingAsGroup &&
          prev.groupRole === next.groupRole &&
          prev.groupId === next.groupId &&
          prev.propertyId === next.propertyId &&
          prev.groupSize === next.groupSize
        ) {
          return prev;
        }
        return next;
      });
      if (!preview.ok) {
        setErrors((prev) => ({ ...prev, groupLeaderAppId: preview.message }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [draftReady, searchParams, templatePreview]);

  const patchForm = useCallback((p: Partial<RentalWizardFormState>) => {
    setForm((f) => {
      let merged: RentalWizardFormState = { ...f, ...p };
      if ("propertyId" in p) {
        const nextPid = (p.propertyId ?? "").trim();
        const prevPid = f.propertyId.trim();
        if (nextPid && prevPid && nextPid !== prevPid) {
          const email = (sessionEmail ?? f.email).trim().toLowerCase();
          const switched = switchApplicationTargetProperty({
            previousPropertyId: prevPid,
            nextPropertyId: nextPid,
            inProgressRows: email.includes("@")
              ? applicationsForResidentEmail(email).filter(isInProgressApplicationRow)
              : [],
          });
          if (switched?.resumedApplication) {
            merged = {
              ...createInitialRentalWizardState(),
              ...switched.resumedApplication,
              ...merged,
              email: f.email || switched.resumedApplication.email || "",
            };
          }
        }
      }
      // Custom application answers belong to one listing — drop them if the property changes.
      if ("propertyId" in p && (p.propertyId ?? "") !== f.propertyId && !("customFieldAnswers" in p)) {
        merged.customFieldAnswers = [];
      }
      if ("leaseStart" in p) merged.leaseStart = normalizeIsoDateInput(p.leaseStart);
      if ("leaseEnd" in p) merged.leaseEnd = p.leaseEnd ? normalizeIsoDateInput(p.leaseEnd) : "";
      if ("leaseTerm" in p && p.leaseTerm === "Month-to-Month") merged.leaseEnd = "";
      const endExplicit = "leaseEnd" in p;
      if (
        !endExplicit &&
        ("leaseTerm" in p || "leaseStart" in p) &&
        shouldAutoComputeLeaseEnd(merged.leaseTerm, merged.rentalType)
      ) {
        const computed = computeLeaseEndDate(merged.leaseStart, merged.leaseTerm);
        if (computed) merged.leaseEnd = computed;
      }
      return merged;
    });
    if (Object.keys(p).some((k) => ["propertyId", "roomChoice1", "roomChoice2", "roomChoice3", "bundleId", "rentalType", "leaseTerm", "leaseStart", "leaseEnd"].includes(k))) {
      setShowAvailabilityWarnings(false);
    }
    setErrors((e) => {
      const next = { ...e };
      for (const k of Object.keys(p)) delete next[k];
      if ("customFieldAnswers" in p) {
        for (const k of Object.keys(next)) if (k.startsWith("custom:")) delete next[k];
      }
      return next;
    });
  }, [sessionEmail]);

  useEffect(() => {
    if (!draftReady || step !== 11) return;
    const pid = form.propertyId.trim();
    const prop = pid ? getPropertyById(pid) : undefined;
    const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
    const next = resolveApplicationFeePayChannel(sub, form.applicationFeePayChannel);
    if (next !== form.applicationFeePayChannel) {
      queueMicrotask(() => patchForm({ applicationFeePayChannel: next }));
    }
  }, [draftReady, step, form.propertyId, form.applicationFeePayChannel, patchForm]);

  const setPhoneMasked = useCallback((key: keyof RentalWizardFormState, next: string) => {
    setForm((f) => ({ ...f, [key]: maskPhoneInput(String(f[key] ?? ""), next) }));
    setErrors((e) => ({ ...e, [key]: "" }));
  }, []);

  const setPhone = useCallback((next: string) => setPhoneMasked("phone", next), [setPhoneMasked]);
  const setLandlordPhone = useCallback((next: string) => setPhoneMasked("currentLandlordPhone", next), [setPhoneMasked]);
  const setPrevLandlordPhone = useCallback((next: string) => setPhoneMasked("prevLandlordPhone", next), [setPhoneMasked]);
  const setSupervisorPhone = useCallback((next: string) => setPhoneMasked("supervisorPhone", next), [setPhoneMasked]);
  const setRef1Phone = useCallback((next: string) => setPhoneMasked("ref1Phone", next), [setPhoneMasked]);
  const setRef2Phone = useCallback((next: string) => setPhoneMasked("ref2Phone", next), [setPhoneMasked]);

  const setSsn = useCallback((next: string) => {
    setForm((f) => ({ ...f, ssn: maskSsnInput(next) }));
    setErrors((e) => ({ ...e, ssn: "" }));
  }, []);

  const goToStep = useCallback((n: number) => {
    if (!canNavigateToWizardStep(n, maxStepReached)) return;
    setStep(n);
    setErrors({});
    setReviewReturnStep(null);
    if (n === 3) setShowAvailabilityWarnings(false);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [maxStepReached]);

  const editFromReview = useCallback((n: number) => {
    if (!canNavigateToWizardStep(n, maxStepReached)) return;
    setStep(n);
    setErrors({});
    setReviewReturnStep(n);
    if (n === 3) setShowAvailabilityWarnings(false);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  }, [maxStepReached]);

  const validateAllPrior = useCallback(() => {
    for (let s = 1; s <= 9; s++) {
      const e = validateRentalWizardStep(s, form);
      if (countValidationErrors(e) > 0) {
        setErrors(e);
        setStep(s);
        showToast("Please review the highlighted fields before submitting.");
        queueMicrotask(() =>
          scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[s] ?? [], e),
        );
        return false;
      }
    }
    return true;
  }, [form, setStep, showToast]);

  const applicationFeeGate = useMemo(() => {
    void chargeTick;
    void extrasTick;
    const pid = form.propertyId.trim();
    const email = form.email.trim();
    const serverFeeCents = serverFee && serverFee.propertyId === pid ? serverFee.cents : null;
    const gate = residentApplicationFeeGate({
      propertyId: pid,
      residentEmail: email,
      residentUserId: feeStepUserId,
      serverFeeCents,
    });
    // A manager waiver code redeemed server-side (`applicationFeeWaived`) fully
    // satisfies the fee: no charge, no Stripe session, nothing owed.
    if (form.applicationFeeWaived) {
      return { needsFee: false, paid: true, displayLabel: gate.displayLabel, amount: gate.amount, waived: true, pending: false };
    }
    // Server truth not resolved yet (outside the serverless demo sandbox):
    // never claim "no fee required" off the browser catalog alone — hold the
    // gate closed until the preview answers. A fee already recorded paid, or
    // waived by policy, still passes.
    const pending =
      serverFeeCents == null &&
      !isDemoModeActive() &&
      Boolean(pid) &&
      email.includes("@") &&
      Boolean(getPropertyById(pid)?.managerUserId?.trim());
    if (pending && !gate.waived) {
      const charge = findApplicationFeeCharge(email, pid, feeStepUserId);
      const paid = charge?.status === "paid";
      return { needsFee: !paid, paid, displayLabel: "…", amount: gate.amount, waived: false, pending: true };
    }
    return {
      needsFee: gate.needsFee,
      paid: gate.paid,
      displayLabel: gate.displayLabel,
      amount: gate.amount,
      waived: gate.waived,
      pending: false,
    };
  }, [form.propertyId, form.email, form.applicationFeeWaived, feeStepUserId, chargeTick, serverFee, extrasTick]);

  const applicationFeePaymentVerified =
    applicationFeeGate.paid || form.applicationFeeZelleSentConfirmed;

  const handleCheckApplicationFeePayment = useCallback(async () => {
    const pid = form.propertyId.trim();
    const emailTrim = form.email.trim();
    const prop = pid ? getPropertyById(pid) : undefined;
    const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
    const payChannel = resolveApplicationFeePayChannel(sub, form.applicationFeePayChannel);
    if (!pid || !emailTrim.includes("@")) {
      setApplicationFeeCheckError("Enter your email and property before checking payment.");
      return;
    }
    if (isAchApplicationFeeChannel(payChannel)) return;

    setApplicationFeeCheckBusy(true);
    setApplicationFeeCheckError(null);
    try {
      const managerUserIdForFee = prop?.managerUserId?.trim() ?? "";
      const preview =
        managerUserIdForFee && !isDemoModeActive()
          ? await fetchApplicationFeePreview({
              propertyId: pid,
              managerUserId: managerUserIdForFee,
              rentalType: form.rentalType,
            })
          : null;
      ensurePendingApplicationFeeCharge({
        residentEmail: form.email,
        residentName: form.fullLegalName,
        residentUserId: feeStepUserId,
        propertyId: pid,
        feeAmountOverride: preview ? preview.applicationFeeCents / 100 : undefined,
      });

      const res = await fetch("/api/public/application-fee-check-payment", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          propertyId: pid,
          residentEmail: emailTrim,
          residentName: form.fullLegalName?.trim() || undefined,
          channel: payChannel,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        paid?: boolean;
        message?: string;
        error?: string;
      };
      if (!res.ok) {
        setApplicationFeeCheckError(typeof data.error === "string" ? data.error : "Could not check payment.");
        return;
      }
      if (!data.paid) {
        setApplicationFeeCheckError(
          typeof data.message === "string" ? data.message : "We haven't received this payment yet. Send the fee, wait a moment, then check again.",
        );
        setForm((f) => ({ ...f, applicationFeeZelleSentConfirmed: false }));
        setErrors((e) => ({ ...e, applicationFeeZelleSentConfirmed: "" }));
        return;
      }
      setForm((f) => ({ ...f, applicationFeeZelleSentConfirmed: true }));
      setErrors((e) => ({ ...e, applicationFeeZelleSentConfirmed: "" }));
      setChargeTick((n) => n + 1);
      showToast("Payment verified.");
    } finally {
      setApplicationFeeCheckBusy(false);
    }
  }, [feeStepUserId, form.applicationFeePayChannel, form.email, form.fullLegalName, form.propertyId, showToast]);

  useEffect(() => {
    setApplicationFeeCheckError(null);
  }, [form.applicationFeePayChannel]);

  const handleApplyWaiverCode = useCallback(async () => {
    const pid = form.propertyId.trim();
    const emailTrim = form.email.trim();
    const code = form.applicationFeeWaiverCode.trim();
    if (!code) {
      setWaiverCodeError("Enter a waiver code.");
      return;
    }
    if (!pid || !emailTrim.includes("@")) {
      setWaiverCodeError("Enter your email and property before applying a code.");
      return;
    }
    const prop = getPropertyById(pid);
    const managerUserId = prop?.managerUserId?.trim() ?? "";
    if (!managerUserId) {
      setWaiverCodeError("This listing can't accept waiver codes yet.");
      return;
    }
    if (isDemoModeActive()) {
      setForm((f) => ({ ...f, applicationFeeWaived: true }));
      setWaiverCodeError(null);
      showToast("Waiver code applied (demo).");
      return;
    }
    setWaiverCodeBusy(true);
    setWaiverCodeError(null);
    try {
      const res = await fetch("/api/public/application-fee-waiver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ propertyId: pid, managerUserId, residentEmail: emailTrim, code }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; waived?: boolean; error?: string };
      if (!res.ok || !data.waived) {
        setWaiverCodeError(typeof data.error === "string" ? data.error : "That code isn't valid.");
        return;
      }
      setForm((f) => ({ ...f, applicationFeeWaived: true }));
      setChargeTick((n) => n + 1);
      showToast("Waiver code applied — no application fee due.");
    } catch {
      setWaiverCodeError("Could not apply that code. Please try again.");
    } finally {
      setWaiverCodeBusy(false);
    }
  }, [form.applicationFeeWaiverCode, form.email, form.propertyId, showToast]);

  const finalizeApplicationSubmit = useCallback(
    async (residentUserId: string | null) => {
      if (submitting) return;
      const pid = form.propertyId.trim();
      const emailTrim = form.email.trim();
      const block = residentApplicationSubmitBlocked({
        propertyId: pid,
        residentEmail: emailTrim,
        roomChoice1: form.roomChoice1,
      });
      if (block.blocked) {
        showToast(block.reason ?? "You cannot submit another application for this listing.");
        return;
      }
      setSubmitting(true);
      const prop = pid ? getPropertyById(pid) : undefined;
      const axisId = loadRentalWizardDraftAxisId()?.trim() || makeNewApplicationId();
      // Stop the per-keystroke draft effect from issuing further writes for this
      // application now that it is being submitted.
      markApplicationSubmitInitiated(axisId);
      const listing = prop;
      const applicantName = form.fullLegalName.trim() || "Applicant";

      // Group applications: organizers mint (or keep) a household link code; joiners
      // resolve it from the organizer's application id via the public link preview.
      let formForGroup = form;
      if (form.applyingAsGroup === "yes" && form.groupLeaderAppId.trim()) {
        const preview = await fetchGroupLeaderLinkPreview(form.groupLeaderAppId);
        if (!preview.ok) {
          setSubmitting(false);
          showToast(preview.message);
          return;
        }
        formForGroup = {
          ...form,
          groupId: preview.groupId,
          groupLeaderAppId: preview.leaderAppId,
          groupRole: "joining",
          ...(preview.propertyId && !form.propertyId.trim() ? { propertyId: preview.propertyId } : {}),
          ...(preview.groupSize != null && !form.groupSize.trim()
            ? { groupSize: String(preview.groupSize) }
            : {}),
        };
      } else if (form.applyingAsGroup === "yes") {
        formForGroup = {
          ...form,
          groupRole: "first",
          groupId: form.groupId.trim() || makeApplicationGroupId(),
        };
      }
      const resolvedGroupId = resolveSubmitGroupId(formForGroup);
      const withGroupId: RentalWizardFormState =
        resolvedGroupId && resolvedGroupId !== formForGroup.groupId
          ? { ...formForGroup, groupId: resolvedGroupId }
          : formForGroup;
      // Sanitize at SUBMIT (only here — never on a mid-form lease-term switch, so
      // toggling long<->short keeps in-progress answers): the stored snapshot and
      // the manager view must carry ONLY the questions the CHOSEN form actually
      // asked. Otherwise an applicant who fills the long-term form (SSN, driver's
      // license, employment, references, credit consent) and then picks Short-Term
      // Stay would submit all of that PII for a form that never asked it. Variant
      // resolved from the submitted form's own `rentalType`; fields the chosen form
      // did ask are untouched.
      const submittedListingSub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
      const submittedForm: RentalWizardFormState = sanitizeApplicationFormForListing(
        withGroupId,
        submittedListingSub,
      );

      // A redeemed waiver code means NOTHING is charged: no $0 line, no
      // pending application-fee row — including one created earlier via the
      // manual (Zelle/Venmo) path before the code was applied.
      const feeWaivedByCode = Boolean(form.applicationFeeWaived);
      if (feeWaivedByCode && pid) {
        removePendingApplicationFeeCharge(emailTrim, pid);
      }
      // Book the charge at the SERVER's effective fee (manager-level setting)
      // whenever it is resolvable, so the manager's books always equal what
      // was actually collected — a 0 books nothing.
      let applicationFeeAmount: number | null = null;
      if (!feeWaivedByCode && !isDemoModeActive() && pid) {
        const managerUserIdForFee = prop?.managerUserId?.trim() ?? "";
        if (managerUserIdForFee) {
          const preview = await fetchApplicationFeePreview({
            propertyId: pid,
            managerUserId: managerUserIdForFee,
            rentalType: form.rentalType,
          });
          if (preview) applicationFeeAmount = preview.applicationFeeCents / 100;
        }
      }

      recordApplicationCharges(
        {
          residentEmail: form.email,
          residentName: form.fullLegalName,
          residentUserId,
          propertyId: form.propertyId,
          applicationId: axisId,
          managerUserId: listing?.managerUserId ?? prop?.managerUserId ?? null,
        },
        { skipApplicationFee: feeWaivedByCode, applicationFeeAmount },
      );

      const feeCharge = findApplicationFeeCharge(form.email, pid, residentUserId);
      const applicationRow = {
        id: axisId,
        name: applicantName,
        property: (listing?.title?.trim() || pid.trim()) || "Listing",
        propertyId: pid || undefined,
        managerUserId: listing?.managerUserId ?? feeCharge?.managerUserId ?? prop?.managerUserId ?? null,
        stage: "Submitted" as const,
        bucket: "pending" as const,
        backgroundCheckStatus: "pending_review" as const,
        detail: `Submitted ${new Date().toLocaleString()}`,
        email: emailTrim,
        residentUserId: residentUserId ?? undefined,
        axisId,
        application: structuredClone(submittedForm),
      };

      replaceManagerApplicationRowInCache(applicationRow);
      const sync = await upsertApplicationRowToServerAwait(applicationRow);
      if (sync.ok && sync.row) {
        replaceManagerApplicationRowInCache(sync.row);
      }

      let emailSent = false;
      let mailtoHref: string | undefined;
      // Seed the finish CTA from the server-authoritative handoff minted during the
      // application upsert. This holds even if the follow-up email route fails, so
      // "Create your resident account" is never lost to a flaky send.
      let setupHref: string | undefined = sync.setupHref;
      const propertyTitle = (listing?.title?.trim() || pid.trim()) || undefined;
      const isGuestSubmit = !residentUserId && !isDemoModeActive();
      if (sync.ok && emailTrim.includes("@") && isGuestSubmit) {
        try {
          const res = await fetch("/api/portal/send-application-submitted", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              email: emailTrim,
              axisId,
              applicantName: applicantName !== "Applicant" ? applicantName : undefined,
              propertyTitle,
              includeSetupHandoff: true,
              // Reuse the token already minted on the row so the emailed link
              // matches the finish-screen link (the route skips token rotation).
              setupToken: sync.setupToken,
            }),
          });
          const payload = (await res.json().catch(() => ({}))) as { mailtoHref?: string; setupHref?: string };
          emailSent = res.ok;
          if (typeof payload.mailtoHref === "string" && payload.mailtoHref.startsWith("mailto:")) {
            mailtoHref = payload.mailtoHref;
          }
          if (typeof payload.setupHref === "string" && payload.setupHref.startsWith("/auth/resident-setup")) {
            setupHref = payload.setupHref;
          }
        } catch {
          emailSent = false;
        }
      }

      track("rental_application_submitted", {
        axis_id: axisId,
        property_id: pid || undefined,
        synced_to_server: sync.ok,
        email_sent: emailSent,
        group_role: submittedForm.applyingAsGroup === "yes" ? submittedForm.groupRole ?? undefined : undefined,
      });
      clearRentalWizardDraft();
      setForm(createInitialRentalWizardState());
      setStep(1);
      setErrors({});
      setChargeTick((n) => n + 1);
      setSubmitting(false);
      if (mode === "portal" && sync.ok) {
        showToast("Application submitted.");
        if (isDemoModeActive()) {
          window.dispatchEvent(
            new CustomEvent(DEMO_APPLICATION_SUBMITTED_EVENT, { detail: { axisId } }),
          );
          return;
        }
        router.replace("/resident/applications");
        return;
      }
      setPostSubmit({
        axisId,
        email: emailTrim,
        propertyTitle,
        emailSent,
        syncError: sync.ok ? undefined : sync.error,
        guestFlow: isGuestSubmit,
        mailtoHref,
        setupHref,
        groupLeaderAppId:
          submittedForm.applyingAsGroup === "yes" && submittedForm.groupRole === "first"
            ? axisId
            : undefined,
        groupRole: submittedForm.applyingAsGroup === "yes" ? submittedForm.groupRole : undefined,
        groupSize: submittedForm.applyingAsGroup === "yes" ? submittedForm.groupSize : undefined,
        groupPropertyId: submittedForm.applyingAsGroup === "yes" ? submittedForm.propertyId : undefined,
        hasCosigner: submittedForm.hasCosigner,
      });
      if (sync.ok) {
        showToast("Application submitted.");
      } else {
        showToast(sync.error ?? "Application saved locally but could not sync to server. Try again.");
      }
    },
    [form, mode, router, setStep, showToast, submitting],
  );

  useEffect(() => {
    if (!demoAutofillSubmitPending || !isDemoModeActive()) return;
    setDemoAutofillSubmitPending(false);
    void finalizeApplicationSubmit(DEMO_GUIDED_USER_ID);
  }, [demoAutofillSubmitPending, finalizeApplicationSubmit, form]);

  const primaryButtonLabel = useMemo(() => {
    if (mode === "manager" && step === 10) {
      return managerActionBusy ? "Loading preview…" : "Send to resident";
    }
    if (step !== 11) return "Continue";
    if (!applicationFeeGate.needsFee) return submitting ? "Submitting…" : "Submit application";
    const prop = form.propertyId.trim() ? getPropertyById(form.propertyId.trim()) : undefined;
    const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
    const payChannel = resolveApplicationFeePayChannel(sub, form.applicationFeePayChannel);
    if (isAchApplicationFeeChannel(payChannel)) {
      // Card fee is paid inline above; the button only submits once it's paid.
      return applicationFeeGate.paid ? (submitting ? "Submitting…" : "Submit application") : "Complete payment above";
    }
    if (payChannel === "zelle" || payChannel === "venmo" || payChannel === "other") {
      if (!applicationFeePaymentVerified) {
        return "Check payment above";
      }
      return submitting ? "Submitting…" : "Submit application";
    }
    return submitting ? "Submitting…" : "Submit application";
  }, [
    mode,
    step,
    managerActionBusy,
    form,
    applicationFeeGate.paid,
    applicationFeeGate.needsFee,
    applicationFeePaymentVerified,
    submitting,
  ]);

  useEffect(() => {
    if (!draftReady || isDemoModeActive()) return;
    const feeCheckout = searchParams.get("fee_checkout");
    if (feeCheckout === "cancel") {
      showToast("Checkout cancelled. You can try again when you are ready.");
      router.replace(wizardApplyPath);
      return;
    }
    // "return" is the inline (embedded) completion redirect; "success" is the
    // legacy hosted redirect. Both are verified server-side below before the
    // fee is treated as paid.
    if (feeCheckout !== "success" && feeCheckout !== "return") return;
    const sessionId = searchParams.get("session_id")?.trim();
    if (!sessionId) return;

    const pid = form.propertyId.trim();
    const em = form.email.trim();
    if (!pid || !em.includes("@")) return;

    if (processedApplicationFeeSessions.has(sessionId)) {
      router.replace(wizardApplyPath);
      return;
    }

    void (async () => {
      const managerUserIdForFee = getPropertyById(pid)?.managerUserId?.trim() ?? "";
      const feePreview = managerUserIdForFee
        ? await fetchApplicationFeePreview({
            propertyId: pid,
            managerUserId: managerUserIdForFee,
            rentalType: form.rentalType,
          })
        : null;
      const feeAmountOverride = feePreview ? feePreview.applicationFeeCents / 100 : undefined;
      const res = await fetch("/api/stripe/application-fee-verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, expectedEmail: em }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        paid?: boolean;
        processing?: boolean;
        error?: string;
        propertyId?: string | null;
        emailMatches?: boolean;
        depositChargeId?: string | null;
      };
      if (!res.ok) {
        showToast(typeof data.error === "string" ? data.error : "Could not verify payment.");
        router.replace(wizardApplyPath);
        return;
      }
      if (!data.paid) {
        // Retained for legacy in-flight ACH application-fee sessions created
        // before the fee channel switched to card: those still return
        // complete-but-unpaid while the bank transfer clears. New sessions are
        // card, so they come back paid.
        if (data.processing) {
          ensurePendingApplicationFeeCharge({
            residentEmail: form.email,
            residentName: form.fullLegalName,
            residentUserId: feeStepUserId,
            propertyId: pid,
            feeAmountOverride,
          });
          processedApplicationFeeSessions.add(sessionId);
          showToast("Bank transfer submitted. Your application fee will be marked paid when the transfer clears.");
          finalizeApplicationSubmit(feeStepUserId);
          router.replace(wizardApplyPath);
          return;
        }
        showToast(typeof data.error === "string" ? data.error : "Payment not completed yet.");
        router.replace(wizardApplyPath);
        return;
      }
      if (
        String(data.propertyId ?? "")
          .trim()
          .toLowerCase() !== pid.toLowerCase() ||
        data.emailMatches !== true
      ) {
        showToast("Payment confirmation does not match this application. Use the same email and listing as before checkout.");
        router.replace(wizardApplyPath);
        return;
      }
      ensurePendingApplicationFeeCharge({
        residentEmail: form.email,
        residentName: form.fullLegalName,
        residentUserId: feeStepUserId,
        propertyId: pid,
        feeAmountOverride,
      });
      const marked = markApplicationFeePaidAfterStripe(form.email, pid, feeStepUserId);
      if (!marked) {
        showToast("Payment succeeded, but the application fee line could not be updated.");
        router.replace(wizardApplyPath);
        return;
      }
      setChargeTick((n) => n + 1);
      processedApplicationFeeSessions.add(sessionId);
      finalizeApplicationSubmit(feeStepUserId);
      router.replace(wizardApplyPath);
    })();
  }, [draftReady, searchParams, form.propertyId, form.email, form.fullLegalName, form.applicationFeeWaived, feeStepUserId, router, showToast, finalizeApplicationSubmit, wizardApplyPath]);

  const handleContinue = () => {
    if (templatePreview) {
      if (!validateAllPrior()) return;
      const next = nextActiveStep(step);
      if (next > step) {
        setStep(next);
        setErrors({});
        if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
        return;
      }
      showToast("Preview only — applicants submit from this screen.");
      return;
    }
    if (step === 11) {
      if (!validateAllPrior()) return;
      void (async () => {
        if (isDemoModeActive()) {
          finalizeApplicationSubmit(feeStepUserId ?? DEMO_GUIDED_USER_ID);
          return;
        }
        let residentUserId: string | null = null;
        try {
          const supabase = createSupabaseBrowserClient();
          const {
            data: { user },
          } = await supabase.auth.getUser();
          residentUserId = user?.id ?? null;
        } catch {
          /* ignore */
        }
        const pid = form.propertyId.trim();
        const emailTrim = form.email.trim();
        const prop = pid ? getPropertyById(pid) : undefined;
        const sub = prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
        const payChannel = resolveApplicationFeePayChannel(sub, form.applicationFeePayChannel);
        // The submit decision derives from the SERVER's effective fee (same
        // resolver checkout uses), never the browser catalog alone. If the
        // server can't answer right now, fail closed — never submit fee-free
        // on a guess.
        const managerUserIdForFee = prop?.managerUserId?.trim() ?? "";
        let serverFeeCents: number | null = null;
        if (managerUserIdForFee && !form.applicationFeeWaived) {
          const preview = await fetchApplicationFeePreview({
            propertyId: pid,
            managerUserId: managerUserIdForFee,
            rentalType: form.rentalType,
          });
          if (!preview) {
            const msg = "We couldn't confirm the application fee. Check your connection and try again.";
            setApplicationFeeCheckError(msg);
            showToast(msg);
            return;
          }
          serverFeeCents = preview.applicationFeeCents;
        }
        const feeGate = residentApplicationFeeGate({
          propertyId: pid,
          residentEmail: emailTrim,
          residentUserId,
          serverFeeCents,
        });
        // A redeemed manager waiver code fully covers the fee — submit directly.
        const needsFee = feeGate.needsFee && !form.applicationFeeWaived;

        if (needsFee && isAchApplicationFeeChannel(payChannel)) {
          // Card payment is collected INLINE in the step (embedded Stripe form),
          // not by redirecting from this button. If the applicant has already
          // paid (returned from the embedded form), submit; otherwise point them
          // at the inline form instead of leaving the wizard.
          const charge = findApplicationFeeCharge(form.email, pid, residentUserId);
          if (charge?.status === "paid") {
            finalizeApplicationSubmit(residentUserId);
            return;
          }
          const managerUserId = prop?.managerUserId?.trim() ?? "";
          if (!managerUserId) {
            showToast("This listing cannot take card payments yet. Contact the manager before submitting.");
            return;
          }
          showToast("Complete the card payment above to submit your application.");
          return;
        }

        if (needsFee && (payChannel === "zelle" || payChannel === "venmo" || payChannel === "other")) {
          if (!applicationFeePaymentVerified) {
            const hint =
              payChannel === "other"
                ? "Tap Check payment above after following the payment instructions."
                : `Tap Check payment above after sending the application fee by ${payChannel === "venmo" ? "Venmo" : "Zelle"}.`;
            showToast(hint);
            setErrors((e) => ({
              ...e,
              applicationFeeZelleSentConfirmed: hint,
            }));
            queueMicrotask(() =>
              scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[11] ?? [], {
                applicationFeeZelleSentConfirmed: hint,
              }),
            );
            return;
          }

          ensurePendingApplicationFeeCharge({
            residentEmail: form.email,
            residentName: form.fullLegalName,
            residentUserId,
            propertyId: pid,
            feeAmountOverride: serverFeeCents != null ? serverFeeCents / 100 : undefined,
          });

          const checkRes = await fetch("/api/public/application-fee-check-payment", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              propertyId: pid,
              residentEmail: emailTrim,
              residentName: form.fullLegalName?.trim() || undefined,
              channel: payChannel,
              feeWaived: form.applicationFeeWaived,
            }),
          });
          const checkData = (await checkRes.json().catch(() => ({}))) as {
            paid?: boolean;
            message?: string;
            error?: string;
          };
          if (!checkRes.ok) {
            const msg = typeof checkData.error === "string" ? checkData.error : "Could not verify payment.";
            setApplicationFeeCheckError(msg);
            showToast(msg);
            return;
          }
          if (!checkData.paid) {
            const msg =
              typeof checkData.message === "string"
                ? checkData.message
                : "We haven't received this payment yet. Send the fee, wait a moment, then check again.";
            setForm((f) => ({ ...f, applicationFeeZelleSentConfirmed: false }));
            setApplicationFeeCheckError(msg);
            setErrors((e) => ({
              ...e,
              applicationFeeZelleSentConfirmed:
                payChannel === "other"
                  ? "Tap Check payment above after following the payment instructions."
                  : `Tap Check payment above after sending the application fee by ${payChannel === "venmo" ? "Venmo" : "Zelle"}.`,
            }));
            showToast(msg);
            queueMicrotask(() =>
              scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[11] ?? [], {
                applicationFeeZelleSentConfirmed: msg,
              }),
            );
            return;
          }

          setForm((f) => ({ ...f, applicationFeeZelleSentConfirmed: true }));
          setApplicationFeeCheckError(null);
          setErrors((e) => ({ ...e, applicationFeeZelleSentConfirmed: "" }));
          setChargeTick((n) => n + 1);
          finalizeApplicationSubmit(residentUserId);
          return;
        }

        finalizeApplicationSubmit(residentUserId);
      })();
      return;
    }
    if (step === 10) {
      if (!validateAllPrior()) return;
      if (mode === "manager") {
        const axisId = ensureApplicationId();
        const email = (sessionEmail ?? form.email).trim();
        syncInProgressApplicationRow({
          axisId,
          form,
          residentEmail: email,
          wizardStep: step,
          wizardMaxStepReached: maxStepReached,
        });
        onManagerSendToResident?.({ axisId });
        return;
      }
      setStep(11);
      setMaxStepReached((m) => nextWizardMaxReached(m, 11));
      setErrors({});
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (step === 1 && form.applicantRole === "cosigner") return;
    void (async () => {
      if (step === 1 && form.applyingAsGroup === "yes" && form.groupLeaderAppId.trim()) {
        const preview = await fetchGroupLeaderLinkPreview(form.groupLeaderAppId);
        if (!preview.ok) {
          setErrors({ groupLeaderAppId: preview.message });
          showToast(preview.message);
          queueMicrotask(() =>
            scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[1] ?? [], {
              groupLeaderAppId: preview.message,
            }),
          );
          return;
        }
      }

      const e = validateRentalWizardStep(step, form);
      setErrors(e);
      if (countValidationErrors(e) > 0) {
        showToast("Please fix the highlighted fields before continuing.");
        queueMicrotask(() =>
          scrollToFirstWizardFieldError(RENTAL_WIZARD_STEP_FIELD_ORDER[step] ?? [], e),
        );
        return;
      }
      if (step === 1 && maxStepReached < 2) {
        track("rental_application_started", { property_id: form.propertyId || undefined });
      }
      if (step === 3) {
        const approvedConflict = form.roomChoice1
          ? isRoomApprovedConflict(form.roomChoice1, form.leaseStart, form.leaseEnd)
          : false;
        const pendingConflict = !approvedConflict && form.roomChoice1
          ? isRoomPendingConflict(form.roomChoice1, form.leaseStart, form.leaseEnd)
          : false;
        setShowAvailabilityWarnings(approvedConflict || pendingConflict);
        if (approvedConflict) {
          showToast("Your first-choice room may be unavailable for those move-in dates, but your application can still continue.");
        } else if (pendingConflict) {
          showToast("Someone else has already applied for your first-choice room on those dates, but your application can still continue.");
        }
      }
      if (reviewReturnStep != null && reviewReturnStep === step) {
        setStep(10);
        setReviewReturnStep(null);
      } else {
        const next = nextActiveStep(step);
        setStep(next);
        setMaxStepReached((m) => nextWizardMaxReached(m, next));
      }
      setErrors({});
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
    })();
  };

  const handleBack = () => {
    if (step <= 1) {
      exitApplication();
      return;
    }
    if (step === 11) {
      setStep(10);
      setErrors({});
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (reviewReturnStep != null && reviewReturnStep === step) {
      setStep(10);
      setErrors({});
      setReviewReturnStep(null);
      if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const prev = prevActiveStep(step);
    setStep(prev);
    setErrors({});
    if (prev === 3) setShowAvailabilityWarnings(false);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const progressPct = activeWizardProgressPct(activeSteps, step);
  const embedded = layout === "embedded";

  return (
    <div
      ref={rootRef}
      className={
        embedded
          ? "rental-wizard rental-wizard--embedded"
          : "rental-wizard mx-auto max-w-3xl px-4 py-5 sm:py-14"
      }
    >
      {!embedded && !postSubmit ? (
        <div className="rental-wizard-page-title text-center sm:text-left">
          <h1 className="text-xl font-bold tracking-tight text-foreground sm:text-3xl md:text-4xl">Rental application</h1>
        </div>
      ) : null}

      {form.applicantRole === "cosigner" ? null : !canRenderWizard ? (
          <div className="mt-8">
            <ManagerLinkGate
              title="Open your manager’s apply link"
              body={
                linkedPropertyId && !linkedProperty
                  ? "This property link is invalid or no longer active. Ask your property manager for a new apply link."
                  : "Applications start from a link your property manager shares after you find a unit on Zillow, Redfin, or elsewhere."
              }
            />
          </div>
        ) : !applicationsAvailable ? (
          <div className="mt-8">
            <ApplicationUnavailableContactManager
              propertyTitle={linkedProperty?.title}
              managerEmail={linkedProperty?.managerContactEmail}
              managerPhone={linkedProperty?.contactSmsPhone}
            />
          </div>
        ) : postSubmit ? (
          <RentalApplicationFinishPanel
            axisId={postSubmit.axisId}
            email={postSubmit.email}
            emailSent={postSubmit.emailSent}
            syncError={postSubmit.syncError}
            guestFlow={postSubmit.guestFlow}
            mailtoHref={postSubmit.mailtoHref}
            setupHref={postSubmit.setupHref}
            groupLeaderAppId={postSubmit.groupLeaderAppId}
            groupRole={postSubmit.groupRole}
            groupSize={postSubmit.groupSize}
            groupPropertyId={postSubmit.groupPropertyId}
            hasCosigner={postSubmit.hasCosigner}
            onDone={() => setPostSubmit(null)}
          />
        ) : (
          <div
            className={
              embedded
                ? "rental-wizard-shell"
                : "rental-wizard-shell mt-4 rounded-2xl border border-border bg-card p-4 shadow-[0_24px_80px_-32px_rgba(15,23,42,0.18)] sm:mt-8 sm:rounded-3xl sm:p-9 md:p-11 [html[data-theme=dark]_&]:shadow-[0_24px_80px_-32px_rgba(0,0,0,0.55)] [html[data-theme=dark]_&]:ring-1 [html[data-theme=dark]_&]:ring-white/8"
            }
          >
            <div className="rental-wizard-step-header border-b border-border pb-4 sm:pb-6">
              {/*
                Deliberately no "Step N of M" and no numbered 1..N pills: the
                applicant must never see how long the application is (a total
                on the first screen is a reason to abandon). The eyebrow names
                the form (long-term vs short-term), the title names the current
                section, and the bar below carries forward motion — no total.
              */}
              <p className="rental-wizard-step-eyebrow text-[10px] font-bold uppercase tracking-[0.18em] text-muted/70 sm:text-[11px]">
                {form.rentalType === "short_term" ? "Short-term stay application" : "Rental application"}
              </p>
              <p className="rental-wizard-step-title mt-1 text-lg font-bold tracking-tight text-foreground sm:text-xl">
                {rentalWizardStepTitle(step, form)}
              </p>
              <div className="rental-wizard-progress mt-3 h-1.5 overflow-hidden rounded-full bg-accent/30 sm:mt-4 sm:h-2 [html[data-theme=dark]_&]:bg-white/10">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${progressPct}%` }}
                  aria-hidden="true"
                />
              </div>
            </div>

            <div className="rental-wizard-step-content pt-5 sm:pt-8">
              <RentalWizardStepBody
                step={step}
                form={form}
                errors={errors}
                mode={mode}
                propertyOptions={propertyOptions}
                propertyLocked={
                  templatePreview
                    ? Boolean(linkedPropertyId?.trim())
                    : mode !== "portal" && Boolean(linkedPropertyId && linkedProperty)
                }
                emailLocked={(mode === "portal" || mode === "manager") && Boolean(sessionEmail?.includes("@"))}
                patch={patchForm}
                applicationFeeGate={applicationFeeGate}
                applicationFeeCheckBusy={applicationFeeCheckBusy}
                applicationFeeCheckError={applicationFeeCheckError}
                applicationFeePaymentVerified={applicationFeePaymentVerified}
                onCheckApplicationFeePayment={() => {
                  void handleCheckApplicationFeePayment();
                }}
                waiverCodeBusy={waiverCodeBusy}
                waiverCodeError={waiverCodeError}
                onApplyWaiverCode={() => {
                  void handleApplyWaiverCode();
                }}
                applyReturnPath={wizardApplyPath}
                occupancySyncEpoch={occupancySyncEpoch}
                showAvailabilityWarnings={showAvailabilityWarnings}
                setPhone={setPhone}
                setLandlordPhone={setLandlordPhone}
                setPrevLandlordPhone={setPrevLandlordPhone}
                setSupervisorPhone={setSupervisorPhone}
                setRef1Phone={setRef1Phone}
                setRef2Phone={setRef2Phone}
                setSsn={setSsn}
                goToStep={goToStep}
                editFromReview={editFromReview}
                getApplicationId={ensureApplicationId}
                onEnsureApplicationId={ensureApplicationId}
                savedApplicationId={applicationAxisId}
                photoSetupTokenRequired={mode !== "portal" && !sessionEmail?.includes("@")}
                getPhotoSetupToken={() => getApplicationSetupToken(ensureApplicationId())}
              />
            </div>

            {autosaveFailed ? (
              <p
                role="status"
                className="rental-wizard-autosave-error mt-6 rounded-xl border px-4 py-3 text-sm portal-banner-pending"
                data-attr="rental-wizard-autosave-error"
              >
                We couldn&apos;t save your latest changes. Your progress is kept on this device — keep this tab open and continue; we&apos;ll retry as you edit. If this keeps happening, check your connection.
              </p>
            ) : null}

            <div
              className={
                embedded
                  ? "rental-wizard-actions mt-6 flex flex-wrap items-center justify-between gap-3"
                  : "rental-wizard-actions mt-8 flex flex-col-reverse gap-3 border-t border-border pt-6 sm:mt-10 sm:flex-row sm:items-center sm:justify-between sm:pt-8"
              }
            >
              <Button
                type="button"
                variant="outline"
                className={embedded ? PORTAL_DETAIL_BTN : "w-full min-h-[48px] sm:w-auto sm:min-w-[120px]"}
                onClick={handleBack}
              >
                {step <= 1
                  ? embedded
                    ? "Cancel"
                    : "Exit application"
                  : reviewReturnStep != null && reviewReturnStep === step
                    ? "Back to review"
                    : "Back"}
              </Button>
              <Button
                type="button"
                variant="primary"
                className={embedded ? undefined : "w-full min-h-[48px] sm:w-auto sm:min-w-[200px]"}
                data-attr="rental-wizard-continue"
                onClick={handleContinue}
                disabled={submitting || (mode === "manager" && managerActionBusy)}
              >
                {submitting ? "Submitting…" : primaryButtonLabel}
              </Button>
            </div>
            {step <= 3 && mode !== "manager" ? (
              <p className="rental-wizard-browse-homes mt-4 text-center text-sm">
                <Link
                  href={browseHomesHref}
                  data-attr="rental-wizard-browse-homes"
                  className="font-semibold text-primary underline-offset-2 hover:underline"
                >
                  Browse homes
                </Link>
              </p>
            ) : null}
          </div>
        )}
    </div>
  );
}
