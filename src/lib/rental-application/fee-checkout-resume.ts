/**
 * PRP-431 — survive Stripe embedded Checkout return.
 *
 * Wizard answers live in an in-memory Map (not sessionStorage). A full-page
 * return from Stripe wipes `form.email`, so the fee_checkout effect used to
 * bail silently and never finalize. Stash the fee identity just before minting
 * Checkout so verify + finalize can re-bind without waiting on resume.
 *
 * Prefer sessionStorage (survives full reload in the same tab). Fall back to a
 * module Map when sessionStorage is unavailable (some test runners).
 */
export type ApplicationFeeCheckoutResume = {
  email: string;
  propertyId: string;
  fullLegalName?: string;
  axisId?: string;
};

/** Finish-panel snapshot so a remount after Stripe still shows confirmation. */
export type ApplicationFeeSubmitConfirm = {
  sessionId: string;
  axisId: string;
  email: string;
  propertyId: string;
  propertyTitle?: string;
  guestFlow: boolean;
  portalFlow: boolean;
  setupHref?: string;
};

const FEE_CHECKOUT_RESUME_KEY = "axis:rental-application:fee-checkout-resume:v1";
const FEE_SUBMIT_CONFIRM_KEY = "axis:rental-application:fee-submit-confirm:v1";
const memoryResume = new Map<string, ApplicationFeeCheckoutResume>();
const memoryConfirm = new Map<string, ApplicationFeeSubmitConfirm>();

function writeJson(key: string, value: unknown, memory: Map<string, unknown>): void {
  memory.set(key, value as never);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* memory already holds it */
  }
}

function readJson<T>(key: string, memory: Map<string, T>): T | null {
  if (typeof window !== "undefined") {
    try {
      const raw = window.sessionStorage.getItem(key);
      if (raw) return JSON.parse(raw) as T;
    } catch {
      /* fall through */
    }
  }
  return memory.get(key) ?? null;
}

function clearKey(key: string, memory: Map<string, unknown>): void {
  memory.delete(key);
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function writeResume(payload: ApplicationFeeCheckoutResume): void {
  writeJson(FEE_CHECKOUT_RESUME_KEY, payload, memoryResume as Map<string, unknown>);
}

function readResume(): ApplicationFeeCheckoutResume | null {
  const fromStore = readJson<Partial<ApplicationFeeCheckoutResume>>(
    FEE_CHECKOUT_RESUME_KEY,
    memoryResume as Map<string, Partial<ApplicationFeeCheckoutResume>>,
  );
  if (!fromStore) return null;
  const email = typeof fromStore.email === "string" ? fromStore.email.trim().toLowerCase() : "";
  const propertyId = typeof fromStore.propertyId === "string" ? fromStore.propertyId.trim() : "";
  if (!email.includes("@") || !propertyId) return null;
  return {
    email,
    propertyId,
    ...(typeof fromStore.fullLegalName === "string" && fromStore.fullLegalName.trim()
      ? { fullLegalName: fromStore.fullLegalName.trim() }
      : {}),
    ...(typeof fromStore.axisId === "string" && fromStore.axisId.trim()
      ? { axisId: fromStore.axisId.trim() }
      : {}),
  };
}

export function rememberApplicationFeeCheckoutResume(input: ApplicationFeeCheckoutResume): void {
  const email = input.email.trim().toLowerCase();
  const propertyId = input.propertyId.trim();
  if (!email.includes("@") || !propertyId) return;
  writeResume({
    email,
    propertyId,
    ...(input.fullLegalName?.trim() ? { fullLegalName: input.fullLegalName.trim() } : {}),
    ...(input.axisId?.trim() ? { axisId: input.axisId.trim() } : {}),
  });
}

export function loadApplicationFeeCheckoutResume(): ApplicationFeeCheckoutResume | null {
  return readResume();
}

export function clearApplicationFeeCheckoutResume(): void {
  clearKey(FEE_CHECKOUT_RESUME_KEY, memoryResume as Map<string, unknown>);
}

export function rememberApplicationFeeSubmitConfirm(input: ApplicationFeeSubmitConfirm): void {
  const sessionId = input.sessionId.trim();
  const axisId = input.axisId.trim();
  if (!sessionId || !axisId) return;
  writeJson(
    FEE_SUBMIT_CONFIRM_KEY,
    {
      sessionId,
      axisId,
      email: input.email.trim().toLowerCase(),
      propertyId: input.propertyId.trim(),
      ...(input.propertyTitle?.trim() ? { propertyTitle: input.propertyTitle.trim() } : {}),
      guestFlow: Boolean(input.guestFlow),
      portalFlow: Boolean(input.portalFlow),
      ...(input.setupHref?.trim() ? { setupHref: input.setupHref.trim() } : {}),
    } satisfies ApplicationFeeSubmitConfirm,
    memoryConfirm as Map<string, unknown>,
  );
}

export function loadApplicationFeeSubmitConfirm(sessionId?: string): ApplicationFeeSubmitConfirm | null {
  const stored = readJson<ApplicationFeeSubmitConfirm>(
    FEE_SUBMIT_CONFIRM_KEY,
    memoryConfirm as Map<string, ApplicationFeeSubmitConfirm>,
  );
  if (!stored?.sessionId?.trim() || !stored.axisId?.trim()) return null;
  if (sessionId?.trim() && stored.sessionId.trim() !== sessionId.trim()) return null;
  return stored;
}

export function clearApplicationFeeSubmitConfirm(): void {
  clearKey(FEE_SUBMIT_CONFIRM_KEY, memoryConfirm as Map<string, unknown>);
}
