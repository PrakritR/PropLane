"use client";

/** Opens the property lease or application template in a solo browser tab (replica ps40.newTab). */
export function openPropertyFormTemplateInNewTab(
  kind: "lease" | "application",
  templateId: string,
): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.set("solo", "1");
  url.searchParams.delete("propertyLeaseTemplate");
  url.searchParams.delete("propertyApplicationTemplate");
  if (kind === "lease") url.searchParams.set("propertyLeaseTemplate", templateId);
  else url.searchParams.set("propertyApplicationTemplate", templateId);
  window.open(url.toString(), "_blank", "noopener,noreferrer");
}

export function readSoloPropertyFormTemplateId(
  searchParams: URLSearchParams | null,
  kind: "lease" | "application",
): string | null {
  if (!searchParams || searchParams.get("solo") !== "1") return null;
  const key = kind === "lease" ? "propertyLeaseTemplate" : "propertyApplicationTemplate";
  const id = searchParams.get(key)?.trim();
  return id || null;
}
