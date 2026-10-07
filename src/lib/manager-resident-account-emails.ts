import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

/**
 * Which of these resident emails already have a PropLane account.
 *
 * The Residents page asks on every household-charges / applications / property tick, and a page load
 * produces four or five of those ticks within a few seconds. Each used to be its own POST carrying
 * the same list. The answer only changes when an account is created, so one read per distinct list
 * is shared by concurrent callers and reused for `RESIDENT_ACCOUNT_EMAILS_TTL_MS`. A failed read is
 * never kept, so the next tick retries. Coverage: `tests/unit/manager-resident-account-emails.test.ts`.
 */
export const RESIDENT_ACCOUNT_EMAILS_TTL_MS = 30_000;
const MAX_ENTRIES = 16;

type Entry = { at: number; promise: Promise<string[] | null> };
const entries = new Map<string, Entry>();

if (typeof window !== "undefined") {
  // One account's answer is never the next account's.
  onPortalSessionViewerChange(() => entries.clear());
}

function listKey(emails: string[]): string {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort().join("\n");
}

/** Resolves the emails that have an account, or `null` when the read failed (keep what the caller has). */
export function loadResidentAccountEmails(emails: string[], opts?: { force?: boolean }): Promise<string[] | null> {
  const key = listKey(emails);
  const existing = entries.get(key);
  if (!opts?.force && existing && Date.now() - existing.at < RESIDENT_ACCOUNT_EMAILS_TTL_MS) return existing.promise;
  if (entries.size >= MAX_ENTRIES) entries.clear();
  const entry: Entry = {
    at: Date.now(),
    promise: (async () => {
      try {
        const res = await fetch("/api/manager/resident-account-emails", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ emails }),
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { emails?: string[] };
        return (body.emails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean);
      } catch {
        return null;
      }
    })(),
  };
  entries.set(key, entry);
  void entry.promise.then((result) => {
    if (result === null && entries.get(key) === entry) entries.delete(key);
  });
  return entry.promise;
}
