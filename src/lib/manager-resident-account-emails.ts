import { onPortalSessionViewerChange } from "@/lib/auth/portal-session-gate";

/**
 * Which of these resident emails already have a PropLane account.
 *
 * The Residents page asks on every household-charges / applications / property tick, and a page load
 * produces four or five of those ticks within a few seconds. Each used to be its own POST carrying
 * the same list. The answer only changes when an account is created, so one read per distinct list
 * is shared by concurrent callers and reused for `RESIDENT_ACCOUNT_EMAILS_TTL_MS`. A failed read is
 * never kept, so the next tick retries.
 *
 * Every surface that asks this question reads through here (Residents, the manager Dashboard, the
 * lease send sheet) so there is ONE answer per page. `{ force: true }` is how a caller says "this
 * list may have just changed" — the sheet polling after an invite — and it refreshes THAT list
 * only: the sheet polls every 8 seconds, so dropping every entry would put the pages behind it
 * back to one POST per tick, which is exactly the loop this cache removed.
 * Coverage: `tests/unit/manager-resident-account-emails.test.ts`.
 */
export const RESIDENT_ACCOUNT_EMAILS_TTL_MS = 30_000;
const MAX_ENTRIES = 16;

type Entry = { at: number; promise: Promise<string[] | null> };
const entries = new Map<string, Entry>();

if (typeof window !== "undefined") {
  // One account's answer is never the next account's.
  onPortalSessionViewerChange(() => invalidateResidentAccountEmails());
}

function listKey(emails: string[]): string {
  return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))].sort().join("\n");
}

/** Forget every cached answer: an account was created, or the viewer changed. */
export function invalidateResidentAccountEmails(): void {
  entries.clear();
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
