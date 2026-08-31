import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";
import { canonicalApplicationAxisId } from "@/lib/manager-applications-storage";

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
  const signerKey = canonicalApplicationAxisId(signerAppId);
  memory = memory.map((sub) => {
    const matchesSigner = canonicalApplicationAxisId(sub.signerAppId) === signerKey;
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
  if (!canUseStorage() || memory.length > 0) return;
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as CosignerSubmission[];
    if (Array.isArray(parsed)) memory = parsed;
  } catch {
    /* ignore */
  }
}

function persist() {
  if (!canUseStorage()) return;
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    /* ignore */
  }
}

export function appendCosignerSubmission(sub: CosignerSubmission) {
  hydrate();
  memory = [...memory, sub];
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
  const id = canonicalApplicationAxisId(signerAppId);
  if (!id) return [];
  try {
    const res = await fetch(`/api/cosigner-submissions?signerAppId=${encodeURIComponent(id)}`, {
      credentials: "include",
      cache: "no-store",
    });
    if (!res.ok) return readCosignerSubmissionsForSignerAppId(signerAppId);
    const body = (await res.json()) as { rows?: CosignerSubmission[] };
    return Array.isArray(body.rows) ? body.rows : [];
  } catch {
    return readCosignerSubmissionsForSignerAppId(signerAppId);
  }
}

export function readCosignerSubmissionsForSignerAppId(signerAppId: string): CosignerSubmission[] {
  hydrate();
  const id = canonicalApplicationAxisId(signerAppId);
  if (!id) return [];
  return memory.filter((s) => canonicalApplicationAxisId(s.signerAppId) === id);
}
