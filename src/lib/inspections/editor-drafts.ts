import type { CapturedPhoto } from "@/lib/native/use-native-camera";
import type { InspectionDetail, InspectionRole } from "./model";

export type InspectionEditorDraft = { detail: InspectionDetail; saved: string; pendingPhoto: { itemId: string; photo: CapturedPhoto } | null };
// Memory only: a browser/native back gesture must not discard the last typing pause
// or a failed upload. Entries are actor-scoped, bounded and expire after one hour.
const drafts = new Map<string, { draft: InspectionEditorDraft; timer: ReturnType<typeof setTimeout> }>();
export const inspectionDraftKey = (userId: string, role: InspectionRole, id: string) => `${userId}:${role}:${id}`;
export function discardInspectionDraft(key: string) {
  const entry = drafts.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  if (entry.draft.pendingPhoto) URL.revokeObjectURL(entry.draft.pendingPhoto.photo.previewUrl);
  drafts.delete(key);
}
export function retainInspectionDraft(key: string, draft: InspectionEditorDraft) {
  const existing = drafts.get(key);
  if (existing) clearTimeout(existing.timer);
  if (existing?.draft.pendingPhoto && existing.draft.pendingPhoto.photo !== draft.pendingPhoto?.photo) URL.revokeObjectURL(existing.draft.pendingPhoto.photo.previewUrl);
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
