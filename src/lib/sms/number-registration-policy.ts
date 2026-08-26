/**
 * Pure policy for the per-manager SMS number system. No Twilio / Supabase
 * imports so it is cheap to unit-test and safe to import from anywhere.
 *
 * Two independent axes decide whether a manager can send from their OWN number:
 *   1. provision_state — does a usable number physically exist yet?
 *   2. registration_state — is that manager's messaging registration approved?
 *
 * The ISV/reseller model makes registration PER MANAGER. A single shared
 * registration is just the degenerate case where every manager's row points at
 * one shared record (`registration_ref`) whose state is resolved from env, so
 * one flip approves everyone through the exact same code path.
 */

export type ProvisionState =
  | "pending_registration"
  | "provisioning"
  | "active"
  | "failed"
  | "released";

export type RegistrationState = "pending" | "approved" | "rejected";

/** Deployment-wide control for provisioning and managed-number sends. */
export type SmsRuntimeMode = "paused" | "allowlisted_self_service" | "automatic";

/** Whether the number is attached to the provider sender pool/service. */
export type SmsNumberAttachmentState =
  | "not_attached"
  | "attaching"
  | "attached"
  | "failed";

/** Carrier registration for the individual phone number, separate from its manager. */
export type SmsNumberRegistrationState =
  | "not_submitted"
  | "pending"
  | "registered"
  | "failed"
  | "deregistering"
  | "deregistered";

export type ManagerSmsNumberRecord = {
  managerUserId: string;
  phoneNumber: string | null;
  phoneNumberSid: string | null;
  messagingServiceSid: string | null;
  provider: string;
  areaCode: string | null;
  provisionState: ProvisionState;
  registrationState: RegistrationState;
  registrationRef: string | null;
  attempts: number;
  lastError: string | null;
  requestedAt: string | null;
  provisionedAt: string | null;
  releasedAt: string | null;
  registrationUpdatedAt: string | null;
  updatedAt: string | null;
  /** Additive control-plane fields. Optional while legacy row readers migrate. */
  attachmentState?: SmsNumberAttachmentState;
  numberRegistrationState?: SmsNumberRegistrationState;
  graceStartedAt?: string | null;
  graceExpiresAt?: string | null;
  quarantinedAt?: string | null;
  quarantineReason?: string | null;
};

const PROVISION_STATES: ReadonlySet<string> = new Set([
  "pending_registration",
  "provisioning",
  "active",
  "failed",
  "released",
]);

const REGISTRATION_STATES: ReadonlySet<string> = new Set(["pending", "approved", "rejected"]);

const SMS_RUNTIME_MODES: ReadonlySet<string> = new Set([
  "paused",
  "allowlisted_self_service",
  "automatic",
]);

const SMS_NUMBER_ATTACHMENT_STATES: ReadonlySet<string> = new Set([
  "not_attached",
  "attaching",
  "attached",
  "failed",
]);

const SMS_NUMBER_REGISTRATION_STATES: ReadonlySet<string> = new Set([
  "not_submitted",
  "pending",
  "registered",
  "failed",
  "deregistering",
  "deregistered",
]);

export function normalizeProvisionState(value: string | null | undefined): ProvisionState {
  const v = String(value ?? "").trim();
  return (PROVISION_STATES.has(v) ? v : "pending_registration") as ProvisionState;
}

export function normalizeRegistrationState(value: string | null | undefined): RegistrationState {
  const v = String(value ?? "").trim();
  return (REGISTRATION_STATES.has(v) ? v : "pending") as RegistrationState;
}

/** Unknown runtime values fail closed to the deployment kill switch. */
export function normalizeSmsRuntimeMode(value: string | null | undefined): SmsRuntimeMode {
  const v = String(value ?? "").trim();
  return (SMS_RUNTIME_MODES.has(v) ? v : "paused") as SmsRuntimeMode;
}

/** Unknown attachment values are treated as unattached, never send-ready. */
export function normalizeSmsNumberAttachmentState(
  value: string | null | undefined,
): SmsNumberAttachmentState {
  const v = String(value ?? "").trim();
  return (SMS_NUMBER_ATTACHMENT_STATES.has(v) ? v : "not_attached") as SmsNumberAttachmentState;
}

/** Unknown per-number registration values are treated as not submitted. */
export function normalizeSmsNumberRegistrationState(
  value: string | null | undefined,
): SmsNumberRegistrationState {
  const v = String(value ?? "").trim();
  return (SMS_NUMBER_REGISTRATION_STATES.has(v) ? v : "not_submitted") as SmsNumberRegistrationState;
}

/**
 * Runtime gate shared by provisioning and dispatch. The pilot mode is explicit:
 * merely being eligible or registered does not put a manager on the allowlist.
 */
export function smsRuntimeAllowsManager(
  mode: SmsRuntimeMode | string | null | undefined,
  managerIsAllowlisted: boolean,
): boolean {
  const normalized = normalizeSmsRuntimeMode(mode);
  if (normalized === "automatic") return true;
  return normalized === "allowlisted_self_service" && managerIsAllowlisted;
}

/**
 * Registration state a deployment applies to managers who share ONE registration
 * record (env `SMS_SHARED_REGISTRATION_STATE`, default `pending`). This is what
 * lets a single-brand deployment flip everyone live by changing one env var
 * without touching per-manager rows.
 */
export function sharedRegistrationState(
  env: Record<string, string | undefined> = process.env,
): RegistrationState {
  return normalizeRegistrationState(env.SMS_SHARED_REGISTRATION_STATE);
}

/** The shared-registration ref this deployment recognises (default `shared`). */
export function sharedRegistrationRef(
  env: Record<string, string | undefined> = process.env,
): string {
  return String(env.SMS_SHARED_REGISTRATION_REF ?? "shared").trim() || "shared";
}

/**
 * Effective registration state for a manager. When the row points at the shared
 * registration record, the state comes from env (so one flip moves everyone);
 * otherwise the manager's own per-row state is authoritative. One code path
 * covers both the reseller (per-manager) and single-shared-registration models.
 */
export function effectiveRegistrationState(
  record: Pick<ManagerSmsNumberRecord, "registrationState" | "registrationRef">,
  env: Record<string, string | undefined> = process.env,
): RegistrationState {
  const ref = String(record.registrationRef ?? "").trim();
  if (ref && ref === sharedRegistrationRef(env)) {
    return sharedRegistrationState(env);
  }
  return normalizeRegistrationState(record.registrationState);
}

/**
 * Money guard: real Twilio purchases only happen when explicitly enabled
 * (`SMS_PROVISIONING_ENABLED=1`). Off by default so a fleet of managers can be
 * parked in `pending_registration` with zero spend until an operator opts in.
 * Independent of registration: a number may be bought before it can send.
 */
export function isProvisioningEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return String(env.SMS_PROVISIONING_ENABLED ?? "").trim() === "1";
}

/**
 * True when the manager may send from their own provisioned number: a usable
 * number physically exists AND that manager's registration is approved. A number
 * can be `active` while registration is still `pending` — it exists but cannot
 * send yet, which is exactly the state a freshly provisioned reseller number
 * sits in until its brand clears.
 */
export function managerCanSendFromOwnNumber(
  record: Pick<
    ManagerSmsNumberRecord,
    "provisionState" | "phoneNumber" | "registrationState" | "registrationRef"
  > | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!record) return false;
  if (normalizeProvisionState(record.provisionState) !== "active") return false;
  if (!String(record.phoneNumber ?? "").trim()) return false;
  return effectiveRegistrationState(record, env) === "approved";
}

/** True when a number physically exists (active) regardless of registration. */
export function managerHasActiveNumber(
  record: Pick<ManagerSmsNumberRecord, "provisionState" | "phoneNumber"> | null,
): boolean {
  if (!record) return false;
  return (
    normalizeProvisionState(record.provisionState) === "active" &&
    !!String(record.phoneNumber ?? "").trim()
  );
}

/** States a provisioning sweep should (re)attempt when provisioning is enabled. */
export function needsProvisioning(
  record: Pick<ManagerSmsNumberRecord, "provisionState"> | null,
): boolean {
  if (!record) return true;
  const state = normalizeProvisionState(record.provisionState);
  return state === "pending_registration" || state === "failed";
}

// ---------------------------------------------------------------------------
// SMS encoding / segment estimation. This intentionally models provider billing
// units rather than JavaScript characters: GSM extension characters use two
// septets, while non-GSM text uses UTF-16 code units (UCS-2), so an emoji uses
// two units.
// ---------------------------------------------------------------------------

export type SmsEncoding = "gsm-7" | "ucs-2";

export type SmsSegmentEstimate = {
  encoding: SmsEncoding;
  /** GSM septets or UCS-2/UTF-16 code units used by the body. */
  encodedUnits: number;
  segmentCount: number;
  singleSegmentLimit: number;
  multipartSegmentLimit: number;
};

const GSM_7_BASIC_CHARACTERS: ReadonlySet<string> = new Set(
  Array.from(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
  ),
);

// Each extension-table character consumes an escape septet plus its own septet.
const GSM_7_EXTENSION_CHARACTERS: ReadonlySet<string> = new Set(
  Array.from("\f^{}\\[~]|€"),
);

function gsm7UnitCount(body: string): number | null {
  let units = 0;
  for (const character of body) {
    if (GSM_7_BASIC_CHARACTERS.has(character)) {
      units += 1;
    } else if (GSM_7_EXTENSION_CHARACTERS.has(character)) {
      units += 2;
    } else {
      return null;
    }
  }
  return units;
}

/**
 * Estimate provider-billed SMS segments using GSM-7 (160/153 septets) or UCS-2
 * (70/67 UTF-16 code units). An empty body has zero segments.
 */
export function estimateSmsSegments(body: string): SmsSegmentEstimate {
  const gsmUnits = gsm7UnitCount(body);
  const encoding: SmsEncoding = gsmUnits === null ? "ucs-2" : "gsm-7";
  const encodedUnits = gsmUnits ?? body.length;
  const singleSegmentLimit = encoding === "gsm-7" ? 160 : 70;
  const multipartSegmentLimit = encoding === "gsm-7" ? 153 : 67;
  const segmentCount =
    encodedUnits === 0
      ? 0
      : encodedUnits <= singleSegmentLimit
        ? 1
        : Math.ceil(encodedUnits / multipartSegmentLimit);

  return {
    encoding,
    encodedUnits,
    segmentCount,
    singleSegmentLimit,
    multipartSegmentLimit,
  };
}

// ---------------------------------------------------------------------------
// Strict managed-number sendability. Keep `managerCanSendFromOwnNumber` above
// for compatibility with legacy callers; new dispatch code should use this
// decision, which includes the runtime kill switch and carrier control plane.
// ---------------------------------------------------------------------------

export type SmsNumberGraceState = "none" | "active" | "expired" | "invalid";

export type ManagerSmsNumberSendabilityRecord = Pick<
  ManagerSmsNumberRecord,
  | "provisionState"
  | "phoneNumber"
  | "registrationState"
  | "registrationRef"
> & {
  attachmentState: SmsNumberAttachmentState | string | null | undefined;
  numberRegistrationState: SmsNumberRegistrationState | string | null | undefined;
  graceStartedAt: string | null | undefined;
  graceExpiresAt: string | null | undefined;
  quarantinedAt: string | null | undefined;
  quarantineReason?: string | null | undefined;
};

export type ManagerSmsNumberBlockReason =
  | "runtime_paused"
  | "manager_not_allowlisted"
  | "number_missing"
  | "number_not_active"
  | "manager_registration_not_approved"
  | "number_not_attached"
  | "number_not_registered"
  | "number_quarantined"
  | "number_in_grace"
  | "number_grace_expired"
  | "number_grace_invalid";

export type ManagerSmsNumberSendabilityDecision = {
  sendable: boolean;
  reason: ManagerSmsNumberBlockReason | null;
};

export type ManagerSmsNumberSendabilityOptions = {
  runtimeMode: SmsRuntimeMode | string | null | undefined;
  managerIsAllowlisted?: boolean;
  now?: Date;
  env?: Record<string, string | undefined>;
};

function parseIsoMillis(value: string): number | null {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Resolve the reconciliation grace window. A half-written or malformed window
 * is invalid and therefore blocks sends instead of silently extending grace.
 */
export function resolveSmsNumberGraceState(
  record: Pick<ManagerSmsNumberSendabilityRecord, "graceStartedAt" | "graceExpiresAt">,
  now: Date = new Date(),
): SmsNumberGraceState {
  const startedAt = String(record.graceStartedAt ?? "").trim();
  const expiresAt = String(record.graceExpiresAt ?? "").trim();
  if (!startedAt && !expiresAt) return "none";
  if (!startedAt || !expiresAt) return "invalid";

  const startMillis = parseIsoMillis(startedAt);
  const expiryMillis = parseIsoMillis(expiresAt);
  const nowMillis = now.getTime();
  if (
    startMillis === null ||
    expiryMillis === null ||
    !Number.isFinite(nowMillis) ||
    startMillis >= expiryMillis ||
    nowMillis < startMillis
  ) {
    return "invalid";
  }
  return nowMillis >= expiryMillis ? "expired" : "active";
}

/** A timestamp or reason is enough to fail closed as quarantined. */
export function smsNumberIsQuarantined(
  record: Pick<ManagerSmsNumberSendabilityRecord, "quarantinedAt" | "quarantineReason">,
): boolean {
  return Boolean(
    String(record.quarantinedAt ?? "").trim() ||
      String(record.quarantineReason ?? "").trim(),
  );
}

/**
 * Complete pure send gate for a manager-owned number. Manager approval and
 * per-number carrier registration are intentionally separate requirements.
 */
export function evaluateManagerSmsNumberSendability(
  record: ManagerSmsNumberSendabilityRecord | null,
  options: ManagerSmsNumberSendabilityOptions,
): ManagerSmsNumberSendabilityDecision {
  const runtimeMode = normalizeSmsRuntimeMode(options.runtimeMode);
  if (runtimeMode === "paused") return { sendable: false, reason: "runtime_paused" };
  if (!smsRuntimeAllowsManager(runtimeMode, options.managerIsAllowlisted ?? false)) {
    return { sendable: false, reason: "manager_not_allowlisted" };
  }
  if (!record || !String(record.phoneNumber ?? "").trim()) {
    return { sendable: false, reason: "number_missing" };
  }
  if (normalizeProvisionState(record.provisionState) !== "active") {
    return { sendable: false, reason: "number_not_active" };
  }
  if (effectiveRegistrationState(record, options.env) !== "approved") {
    return { sendable: false, reason: "manager_registration_not_approved" };
  }
  if (normalizeSmsNumberAttachmentState(record.attachmentState) !== "attached") {
    return { sendable: false, reason: "number_not_attached" };
  }
  if (normalizeSmsNumberRegistrationState(record.numberRegistrationState) !== "registered") {
    return { sendable: false, reason: "number_not_registered" };
  }
  if (smsNumberIsQuarantined(record)) {
    return { sendable: false, reason: "number_quarantined" };
  }

  const graceState = resolveSmsNumberGraceState(record, options.now);
  if (graceState === "active") {
    return { sendable: false, reason: "number_in_grace" };
  }
  if (graceState === "expired") {
    return { sendable: false, reason: "number_grace_expired" };
  }
  if (graceState === "invalid") {
    return { sendable: false, reason: "number_grace_invalid" };
  }
  return { sendable: true, reason: null };
}

export function managerSmsNumberIsSendable(
  record: ManagerSmsNumberSendabilityRecord | null,
  options: ManagerSmsNumberSendabilityOptions,
): boolean {
  return evaluateManagerSmsNumberSendability(record, options).sendable;
}

// ---------------------------------------------------------------------------
// Quiet hours — applies to non-urgent AUTOMATED sends (rent reminders, notices),
// never to STOP/HELP control replies or a manager's own live reply.
// ---------------------------------------------------------------------------

export type QuietHoursConfig = {
  /** IANA timezone the window is evaluated in. */
  tz: string;
  /** Inclusive hour [0-23] quiet hours begin (e.g. 21 = 9pm). */
  startHour: number;
  /** Exclusive hour [0-23] quiet hours end (e.g. 8 = 8am). */
  endHour: number;
};

export const DEFAULT_QUIET_HOURS: QuietHoursConfig = {
  tz: "America/Los_Angeles",
  startHour: 21,
  endHour: 8,
};

/** Hour-of-day [0-23] for `date` in the given IANA timezone. */
export function hourInTimezone(date: Date, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      hour12: false,
      timeZone: tz,
    }).formatToParts(date);
    const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
    // Intl can emit "24" for midnight under hour12:false — fold to 0.
    const h = Number(raw) % 24;
    return Number.isFinite(h) ? h : 0;
  } catch {
    return date.getUTCHours();
  }
}

/**
 * True when `date` falls inside quiet hours. Handles windows that wrap past
 * midnight (start > end), which is the common 9pm–8am case.
 */
export function isWithinQuietHours(
  date: Date,
  config: QuietHoursConfig = DEFAULT_QUIET_HOURS,
): boolean {
  const hour = hourInTimezone(date, config.tz);
  const { startHour, endHour } = config;
  if (startHour === endHour) return false; // no quiet window
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  // Wraps midnight: quiet if at/after start OR before end.
  return hour >= startHour || hour < endHour;
}

export type SmsSendClass = "control" | "transactional" | "automated";

/**
 * Whether a send of the given class is allowed to go out right now. Quiet hours
 * only suppress `automated` traffic (rent reminders, bulk notices). Control
 * (STOP/HELP) and transactional (a manager's live reply, an AI answer to an
 * inbound question) are always allowed.
 */
export function quietHoursBlocks(
  sendClass: SmsSendClass,
  date: Date,
  config: QuietHoursConfig = DEFAULT_QUIET_HOURS,
): boolean {
  if (sendClass !== "automated") return false;
  return isWithinQuietHours(date, config);
}
