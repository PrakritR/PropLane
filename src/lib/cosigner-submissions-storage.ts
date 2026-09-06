import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";

export type CosignerSubmission = {
  /** Server row id (`cosigner_submission_records.id`). */
  id?: string;
  signerAppId: string;
  signerFullName: string;
  fullName: string;
  email: string;
  phone: string;
  dob: string;
  dlNumber: string;
  ssn: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  notEmployed: boolean;
  employerName: string;
  employerAddress: string;
  supervisorName: string;
  supervisorPhone: string;
  jobTitle: string;
  monthlyIncome: string;
  annualIncome: string;
  employmentStart: string;
  otherIncome: string;
  bankruptcy: string;
  criminal: string;
  consentCredit: boolean;
  signature: string;
  dateSigned: string;
  submittedAt: string;
  backgroundCheck?: ApplicationBackgroundCheck;
};

/** Update a co-signer's cached background check after demo screening or a server refresh. */
export function patchCosignerBackgroundCheckInCache(
  signerAppId: string,
  cosignerSubmissionId: string | undefined,
  backgroundCheck: ApplicationBackgroundCheck,
  submittedAt?: string,
): void {
  hydrate();
  const signerKey = normalizeApplicationAxisId(signerAppId).toUpperCase();
  memory = memory.map((sub) => {
    const matchesSigner = normalizeApplicationAxisId(sub.signerAppId).toUpperCase() === signerKey;
    if (!matchesSigner) return sub;
    if (cosignerSubmissionId) {
      if (sub.id !== cosignerSubmissionId) return sub;
    } else if (submittedAt) {
      if (sub.submittedAt !== submittedAt) return sub;
    } else {
      return sub;
    }
    return { ...sub, backgroundCheck };
  });
  persist();
}

const KEY = "axis:cosigner-submissions:v1";
let memory: CosignerSubmission[] = [];

function canUseStorage() {
  return typeof window !== "undefined";
}

function hydrate() {
  if (!canUseStorage()) return;
  try {
    // Older versions persisted the ORIGINAL form (including full SSN and ID)
    // even though the server masked its copy. Never hydrate that legacy cache.
    window.sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

function persist() {
  hydrate();
}

export function appendCosignerSubmission(sub: CosignerSubmission) {
  hydrate();
  // The actual form is sent directly to the server; a UI cache has no reason
  // to retain a complete SSN. Keep the same last-four projection as storage.
  const digits = sub.ssn.replace(/\D/g, "");
  memory = [...memory, { ...sub, ssn: digits ? `***-**-${digits.slice(-4)}` : "" }];
  persist();
}

export async function submitCosignerToServerAwait(
  sub: CosignerSubmission,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch("/api/public/cosigner-submissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub),
    });
    const body = (await res.json().catch(() => null)) as { error?: string; id?: string } | null;
    if (!res.ok) return { ok: false, error: body?.error ?? "Could not save co-signer form." };
    appendCosignerSubmission(body?.id ? { ...sub, id: body.id } : sub);
    return { ok: true };
  } catch {
    return { ok: false, error: "Could not save co-signer form." };
  }
}

export async function fetchCosignerSubmissionsForSignerAppId(
  signerAppId: string,
): Promise<CosignerSubmission[]> {
  const id = normalizeApplicationAxisId(signerAppId).toUpperCase();
  if (!id) return [];
  try {
    const res = await fetch(`/api/cosigner-submissions?signerAppId=${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store",
    });
    // Cached data must not override revoked permissions or an expired session.
    if (!res.ok) return [];
    const body = (await res.json()) as { rows?: CosignerSubmission[] };
    return Array.isArray(body.rows) ? body.rows : [];
  } catch {
    return [];
  }
}

export function readCosignerSubmissionsForSignerAppId(signerAppId: string): CosignerSubmission[] {
  hydrate();
  const id = normalizeApplicationAxisId(signerAppId).toUpperCase();
  if (!id) return [];
  return memory.filter((s) => normalizeApplicationAxisId(s.signerAppId).toUpperCase() === id);
}
