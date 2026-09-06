import type { CapturedPhoto } from "@/lib/native/use-native-camera";
import type { InspectionDetail, InspectionRole } from "./model";

export type InspectionPendingPhoto = { itemId: string; photo: CapturedPhoto };
export type InspectionEditorSnapshot = { detail: InspectionDetail; saved: string; pendingPhoto: InspectionPendingPhoto | null };
/**
 * Two independent buckets under one key.
 *
 * `active` is work that can still be resumed into an editable draft. `unsent` is
 * material the server has already frozen out — it belongs to no report and is only
 * ever read back, exported or discarded by hand. A report that is reopened after a
 * freeze holds BOTH, so neither may evict the other: keying them together and
 * letting the current editability pick one silently dropped the recovery bucket
 * (and leaked its object URL) the moment a manager clicked Request changes.
 */
export type InspectionEditorDraft = {
  active: InspectionEditorSnapshot | null;
  unsent: InspectionEditorSnapshot[];
};
/** Bounded like the key map itself — recovery is a safety net, not a second store. */
export const MAX_UNSENT_RECOVERY_BUCKETS = 3;
// Memory only: a browser/native back gesture must not discard the last typing pause
// or a failed upload. Entries are actor-scoped, bounded and expire after one hour.
const drafts = new Map<string, { draft: InspectionEditorDraft; timer: ReturnType<typeof setTimeout> }>();
export const inspectionDraftKey = (userId: string, role: InspectionRole, id: string) => `${userId}:${role}:${id}`;

function pendingPhotosOf(draft: InspectionEditorDraft | undefined): InspectionPendingPhoto[] {
  if (!draft) return [];
  return [draft.active?.pendingPhoto, ...draft.unsent.map((bucket) => bucket.pendingPhoto)].filter(
    (pending): pending is InspectionPendingPhoto => Boolean(pending),
  );
}

/** Oldest first, so the cap drops the least recent and releases its object URL. */
export function appendUnsentRecovery(
  buckets: InspectionEditorSnapshot[],
  next: InspectionEditorSnapshot,
): InspectionEditorSnapshot[] {
  const merged = [...buckets, next];
  while (merged.length > MAX_UNSENT_RECOVERY_BUCKETS) {
    const dropped = merged.shift();
    if (dropped?.pendingPhoto) URL.revokeObjectURL(dropped.pendingPhoto.photo.previewUrl);
  }
  return merged;
}

export function discardInspectionDraft(key: string) {
  const entry = drafts.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  for (const pending of pendingPhotosOf(entry.draft)) URL.revokeObjectURL(pending.photo.previewUrl);
  drafts.delete(key);
}
export function retainInspectionDraft(key: string, draft: InspectionEditorDraft) {
  const existing = drafts.get(key);
  if (existing) clearTimeout(existing.timer);
  const kept = new Set(pendingPhotosOf(draft).map((pending) => pending.photo));
  for (const pending of pendingPhotosOf(existing?.draft)) {
    if (!kept.has(pending.photo)) URL.revokeObjectURL(pending.photo.previewUrl);
  }
  drafts.set(key, { draft, timer: setTimeout(() => discardInspectionDraft(key), 60 * 60_000) });
  while (drafts.size > 10) discardInspectionDraft(drafts.keys().next().value!);
}
export function peekInspectionDraft(key: string): InspectionEditorDraft | undefined { return drafts.get(key)?.draft; }
export function takeInspectionDraft(key: string): InspectionEditorDraft | undefined {
  const entry = drafts.get(key);
  if (!entry) return;
  clearTimeout(entry.timer); drafts.delete(key);
  return entry.draft;
}
