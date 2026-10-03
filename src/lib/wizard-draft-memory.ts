/**
 * A wizard's unsaved answers, kept for the life of the page.
 *
 * Closing a wizard with the x keeps what was typed (Draft saved); opening the same
 * form again returns to it. The store is in memory on purpose: a draft can hold
 * File objects and half-parsed documents that cannot be serialized, and nothing
 * here is a record — the server only ever sees the finished add.
 *
 * Keys name the form, not the instance ("add-resident:person"), so reopening the
 * same door finds the same draft and a different door never does.
 */
const drafts = new Map<string, unknown>();

export function readWizardDraft<T>(key: string): T | undefined {
  return drafts.get(key) as T | undefined;
}

export function writeWizardDraft<T>(key: string, value: T): void {
  drafts.set(key, value);
}

export function clearWizardDraft(key: string): void {
  drafts.delete(key);
}

export function hasWizardDraft(key: string): boolean {
  return drafts.has(key);
}
