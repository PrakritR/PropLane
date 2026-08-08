const AIRBNB_ICAL_HOSTS = new Set(["www.airbnb.com", "airbnb.com", "www.airbnb.ca", "airbnb.ca"]);

/** Airbnb calendar export URLs only — rejects arbitrary fetch targets. */
export function isValidAirbnbImportUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!AIRBNB_ICAL_HOSTS.has(url.hostname.toLowerCase())) return false;
  const path = url.pathname.toLowerCase();
  return path.includes("/calendar/ical/");
}

export function normalizeAirbnbImportUrl(raw: string): string {
  return raw.trim();
}
