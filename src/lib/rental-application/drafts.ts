import type { RentalWizardFormState } from "./types";

const RENTAL_WIZARD_DRAFT_KEY = "axis:rental-application:draft:v1";
export const DRAFT_AXIS_ID_KEY = "axis:rental-application:draft-axis-id:v1";
const COSIGNER_DRAFT_KEY = "axis:rental-cosigner:draft:v1";
const memoryDrafts = new Map<string, unknown>();
type VariantDraft = Pick<RentalWizardFormState, "applicationTemplateId" | "applicationTemplateVersion" | "customFieldAnswers"> & { axisId?: string; serverOnly?: boolean };
const variantDrafts = new Map<string, VariantDraft>();
const VARIANT_AXIS_IDS_KEY = "axis:rental-application:variant-axis-ids:v1";

function variantDraftKey(propertyId: string, rentalType: string): string {
  return `${propertyId.trim()}:${rentalType}`;
}

export function rememberRentalVariantDraft(form: RentalWizardFormState): void {
  if (!form.propertyId.trim()) return;
  const key = variantDraftKey(form.propertyId, form.rentalType);
  if (variantDrafts.get(key)?.serverOnly) return;
  variantDrafts.set(variantDraftKey(form.propertyId, form.rentalType), {
    axisId: variantDrafts.get(key)?.axisId ?? readJson<string>(DRAFT_AXIS_ID_KEY) ?? undefined,
    applicationTemplateId: form.applicationTemplateId,
    applicationTemplateVersion: form.applicationTemplateVersion,
    customFieldAnswers: [...form.customFieldAnswers],
  });
}

export function loadRentalVariantDraft(propertyId: string, rentalType: string) {
  const key = variantDraftKey(propertyId, rentalType);
  const draft = variantDrafts.get(key);
  if (draft) return draft;
  // Only record references survive a reload. Answers and template pins must
  // come back from the authorized server row, never browser storage.
  const axisId = readVariantAxisIds()[key];
  return axisId ? { axisId, customFieldAnswers: [], serverOnly: true } : undefined;
}

function readVariantAxisIds(): Record<string, string> {
  if (!canUseStorage()) return {};
  try {
    const parsed: unknown = JSON.parse(window.sessionStorage.getItem(VARIANT_AXIS_IDS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => key.length < 300 && typeof value === "string" && value.length > 0 && value.length < 160));
  } catch {
    return {};
  }
}

export function rememberRentalVariantAxisId(propertyId: string, rentalType: string, axisId: string): void {
  const key = variantDraftKey(propertyId, rentalType);
  const existing = variantDrafts.get(key);
  variantDrafts.set(key, { ...existing, customFieldAnswers: existing?.customFieldAnswers ?? [], axisId, serverOnly: existing?.serverOnly ?? (!existing && readVariantAxisIds()[key] === axisId) } as VariantDraft);
  writeJson(DRAFT_AXIS_ID_KEY, axisId);
  if (canUseStorage()) {
    try {
      window.sessionStorage.setItem(VARIANT_AXIS_IDS_KEY, JSON.stringify({ ...readVariantAxisIds(), [key]: axisId }));
    } catch {
      /* unavailable storage does not block the live draft */
    }
  }
}

export function completeRentalVariantRestore(form: RentalWizardFormState): void {
  if (!form.propertyId.trim()) return;
  variantDrafts.delete(variantDraftKey(form.propertyId, form.rentalType));
  rememberRentalVariantDraft(form);
}

function canUseStorage() {
  return typeof window !== "undefined";
}

function readJson<T>(key: string): T | null {
  if (!canUseStorage()) return null;
  return memoryDrafts.has(key) ? (memoryDrafts.get(key) as T) : null;
}

function writeJson(key: string, value: unknown) {
  if (!canUseStorage()) return;
  memoryDrafts.set(key, value);
}

function removeItem(key: string) {
  if (!canUseStorage()) return;
  memoryDrafts.delete(key);
}

export function loadRentalWizardDraft(): Partial<RentalWizardFormState> | null {
  return readJson<Partial<RentalWizardFormState>>(RENTAL_WIZARD_DRAFT_KEY);
}

export function saveRentalWizardDraft(value: RentalWizardFormState) {
  writeJson(RENTAL_WIZARD_DRAFT_KEY, value);
  rememberRentalVariantDraft(value);
}

export function loadRentalWizardDraftAxisId(): string | null {
  return readJson<string>(DRAFT_AXIS_ID_KEY);
}

export function saveRentalWizardDraftAxisId(id: string) {
  writeJson(DRAFT_AXIS_ID_KEY, id.trim());
  const draft = loadRentalWizardDraft();
  if (draft?.propertyId && draft.rentalType) rememberRentalVariantAxisId(draft.propertyId, draft.rentalType, id.trim());
}

export function clearRentalWizardDraft() {
  removeItem(RENTAL_WIZARD_DRAFT_KEY);
  removeItem(DRAFT_AXIS_ID_KEY);
  variantDrafts.clear();
  if (canUseStorage()) {
    try { window.sessionStorage.removeItem(VARIANT_AXIS_IDS_KEY); } catch { /* unavailable */ }
  }
  clearPublicApplyResumeAxisId();
}

/**
 * The PUBLIC apply flow's reload-survivable resume reference. The in-memory
 * draft above is wiped by a real page reload (and by a return from an external
 * redirect like Stripe checkout), so the axis id — and ONLY the axis id, never
 * answers/PII/photo bytes — is kept in sessionStorage. Together with the
 * freshest resident-setup token (already in sessionStorage, see
 * `rememberApplicationSetupToken`) it lets a guest resume their in-progress
 * application after a reload; it never outlives the tab.
 */
const PUBLIC_APPLY_RESUME_AXIS_ID_KEY = "axis:rental-application:public-resume-axis-id:v1";

export function rememberPublicApplyResumeAxisId(id: string) {
  const trimmed = id.trim();
  if (!canUseStorage() || !trimmed) return;
  try {
    window.sessionStorage.setItem(PUBLIC_APPLY_RESUME_AXIS_ID_KEY, trimmed);
  } catch {
    /* ignore */
  }
}

export function loadPublicApplyResumeAxisId(): string | null {
  if (!canUseStorage()) return null;
  try {
    return window.sessionStorage.getItem(PUBLIC_APPLY_RESUME_AXIS_ID_KEY);
  } catch {
    return null;
  }
}

export function clearPublicApplyResumeAxisId() {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.removeItem(PUBLIC_APPLY_RESUME_AXIS_ID_KEY);
  } catch {
    /* ignore */
  }
}

export function loadCosignerDraft<T>(): T | null {
  return readJson<T>(COSIGNER_DRAFT_KEY);
}

export function saveCosignerDraft<T>(value: T) {
  writeJson(COSIGNER_DRAFT_KEY, value);
}

export function clearCosignerDraft() {
  removeItem(COSIGNER_DRAFT_KEY);
}
