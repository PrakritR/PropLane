import { isDemoModeActive } from "@/lib/demo/demo-session";
import { normalizeApplicationAxisId, readManagerApplicationRows } from "@/lib/manager-applications-storage";
import {
  assessCosignerSignerApplication,
  type CosignerSignerLinkPreview,
  validateCosignerSignerAppIdInput,
} from "@/lib/rental-application/cosigner-signer-link";

export async function fetchCosignerSignerLinkPreview(signerAppId: string, templateId?: string, templateVersion?: number): Promise<CosignerSignerLinkPreview> {
  const validated = validateCosignerSignerAppIdInput(signerAppId);
  if (!validated.ok) {
    return { ok: false, code: "invalid_id", message: validated.message };
  }

  if (isDemoModeActive()) {
    const target = validated.normalized;
    const row =
      readManagerApplicationRows().find(
        (r) => normalizeApplicationAxisId(r.id).toUpperCase() === target,
      ) ?? null;
    return assessCosignerSignerApplication(target, row);
  }

  const q = new URLSearchParams({ signerAppId: validated.normalized });
  if (templateId && Number.isSafeInteger(templateVersion)) {
    q.set("templateId", templateId);
    q.set("templateVersion", String(templateVersion));
  }
  const res = await fetch(`/api/public/cosigner-signer-link?${q.toString()}`);
  const body = (await res.json().catch(() => null)) as CosignerSignerLinkPreview | null;
  if (!body || typeof body !== "object" || !("ok" in body)) {
    return {
      ok: false,
      code: "not_found",
      message: "Could not verify that co-signer link. Try again in a moment.",
    };
  }
  return body;
}
