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
