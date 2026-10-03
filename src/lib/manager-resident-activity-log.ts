import type { RecordSectionActivityEvent } from "@/components/portal/record-section-renderers";
import { formatResidentShortDate } from "@/lib/manager-resident-lifecycle";

const STORAGE_PREFIX = "manager-resident-activity-log:";

type StoredEntry = { id: string; label: string; at: string };

function storageKey(residentKey: string): string {
  return `${STORAGE_PREFIX}${residentKey.trim().toLowerCase()}`;
}

export function appendManagerResidentActivityLog(residentKey: string, label: string): void {
  if (typeof window === "undefined" || !residentKey.trim() || !label.trim()) return;
  const at = new Date().toISOString();
  const entry: StoredEntry = { id: `log-${at}-${Math.random().toString(36).slice(2, 8)}`, label: label.trim(), at };
  try {
    const raw = window.localStorage.getItem(storageKey(residentKey));
    const prev = raw ? (JSON.parse(raw) as StoredEntry[]) : [];
    const next = [entry, ...prev].slice(0, 40);
    window.localStorage.setItem(storageKey(residentKey), JSON.stringify(next));
  } catch {
    // ignore quota / private mode
  }
}

export function readManagerResidentActivityLog(residentKey: string): RecordSectionActivityEvent[] {
  if (typeof window === "undefined" || !residentKey.trim()) return [];
  try {
    const raw = window.localStorage.getItem(storageKey(residentKey));
    const rows = raw ? (JSON.parse(raw) as StoredEntry[]) : [];
    return rows.map((row) => ({
      id: row.id,
      label: row.label,
      timestamp: formatResidentShortDate(row.at) || row.at,
    }));
  } catch {
    return [];
  }
}
