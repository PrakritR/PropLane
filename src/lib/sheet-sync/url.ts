export type ParsedSpreadsheetUrl = {
  spreadsheetId: string;
  gid: string | null;
  url: string;
};

const ID_RE = /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/;
const GID_RE = /(?:[?&#]gid=)(\d+)/i;

export function parseSpreadsheetUrl(raw: string): ParsedSpreadsheetUrl | null {
  const url = raw.trim();
  if (!url) return null;
  const idMatch = ID_RE.exec(url);
  if (!idMatch) return null;
  const gidMatch = GID_RE.exec(url);
  return {
    spreadsheetId: idMatch[1]!,
    gid: gidMatch?.[1] ?? null,
    url,
  };
}

export function spreadsheetExportCsvUrl(spreadsheetId: string, gid?: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/export?format=csv`;
  return gid ? `${base}&gid=${gid}` : base;
}

export function spreadsheetHtmlViewUrl(spreadsheetId: string, gid?: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/htmlview`;
  return gid ? `${base}?gid=${gid}` : base;
}

export function canonicalSpreadsheetEditUrl(spreadsheetId: string, gid?: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
  return gid ? `${base}?gid=${gid}#gid=${gid}` : base;
}

const PRIVATE_HOST_RE = /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home)$/i;

/** True for IPv4/IPv6 literals — a published CSV link is always a named host. */
function isIpLiteral(hostname: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":") || hostname.startsWith("[");
}

/** https, no credentials, default port, a real public-looking DNS name. */
export function isSafePublicHttpsUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes(".") || isIpLiteral(host) || PRIVATE_HOST_RE.test(host)) return false;
  return true;
}

/**
 * A "Published CSV link": a plain https URL ending in .csv, or a Google
 * Sheets "File > Share > Publish to web" link (`.../pub?output=csv`).
 * No Google sign-in is involved, so this is also the SSRF gate: public
 * https hosts only.
 */
export function isValidPublishedCsvUrl(raw: string): boolean {
  if (!isSafePublicHttpsUrl(raw)) return false;
  const url = new URL(raw.trim());
  if (/\.csv$/i.test(url.pathname)) return true;
  const isGoogleDocs = url.hostname.toLowerCase() === "docs.google.com";
  return (
    isGoogleDocs &&
    url.pathname.startsWith("/spreadsheets/") &&
    /\/pub(html)?$/.test(url.pathname) &&
    url.searchParams.get("output")?.toLowerCase() === "csv"
  );
}

/** Stable synthetic spreadsheet id for a CSV-link binding (FNV-1a of the URL). */
export function csvSpreadsheetId(csvUrl: string): string {
  let h = 0x811c9dc5;
  for (const ch of csvUrl.trim()) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `csv_${h.toString(16)}`;
}
