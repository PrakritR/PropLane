/** URL-only setup helpers shared by browser forms and server email rendering.
 * Token generation, validation and encrypted persistence remain server-only.
 */
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { formatProplaneIdForDisplay } from "@/lib/manager-id";

export function residentSetupIdFromUrlParams(params: { get(name: string): string | null }): string {
  const proplane = params.get("proplane_id")?.trim() ?? "";
  if (proplane) return normalizeApplicationAxisId(proplane);
  const legacy = params.get("axis_id")?.trim() ?? "";
  return legacy ? normalizeApplicationAxisId(legacy) : "";
}

export function buildResidentSetupHref(token: string, axisId: string): string {
  const id = formatProplaneIdForDisplay(normalizeApplicationAxisId(axisId));
  const params = new URLSearchParams({
    token: token.trim(),
    proplane_id: id,
  });
  return `/auth/resident-setup?${params.toString()}`;
}

export function residentSetupAccountUrl(origin: string, token: string, axisId: string): string {
  const base = origin.replace(/\/$/, "") || "https://prop-lane.space";
  return `${base}${buildResidentSetupHref(token, axisId)}`;
}

