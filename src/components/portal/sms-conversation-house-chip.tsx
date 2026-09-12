"use client";

/**
 * The house chip in a Communication thread header.
 *
 * One workspace number is shared by the whole team, and which members see a
 * thread is decided by the house(s) it is about — so the chip is both the
 * label ("5257 Brooklyn · from the leasing agent") and the one manual control.
 * Automatic tags come from records and the leasing agent; a pick here
 * replaces them and is the only way to clear a thread back to untagged.
 */
import { useCallback, useState } from "react";
import { CheckboxMultiSelect, type CheckboxMultiSelectOption } from "@/components/ui/checkbox-multi-select";
import { useAppUi } from "@/components/providers/app-ui-provider";
import { conversationHouseSourceLabel, type ConversationHouse } from "@/lib/manager-sms-messages";

type WorkspaceHouse = { propertyId: string; label: string; ownerUserId: string };

let housesCache: { at: number; houses: WorkspaceHouse[] } | null = null;

async function loadWorkspaceHouses(): Promise<WorkspaceHouse[]> {
  if (housesCache && Date.now() - housesCache.at < 60_000) return housesCache.houses;
  const res = await fetch("/api/manager/sms-conversations/houses", { cache: "no-store" });
  if (!res.ok) throw new Error("Could not load houses.");
  const body = (await res.json()) as { houses?: WorkspaceHouse[] };
  const houses = Array.isArray(body.houses) ? body.houses : [];
  housesCache = { at: Date.now(), houses };
  return houses;
}

export function SmsConversationHouseChip({
  conversationKey,
  ownerManagerUserId,
  houses,
  canEdit,
  onChanged,
}: {
  conversationKey: string;
  ownerManagerUserId: string | null | undefined;
  houses: ConversationHouse[];
  canEdit: boolean;
  onChanged?: () => void;
}) {
  const { showToast } = useAppUi();
  const [options, setOptions] = useState<CheckboxMultiSelectOption[] | null>(null);
  // Local selection only while a save is in flight; otherwise the server's
  // houses are the truth, so a reload after a peer's change needs no effect.
  const [pending, setPending] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const selected = pending ?? houses.map((h) => h.propertyId);

  const ensureOptions = useCallback(async () => {
    if (options) return;
    try {
      const all = await loadWorkspaceHouses();
      // Only this thread's workspace: a co-manager in two workspaces must not
      // be offered the other owner's houses for this owner's thread.
      const owner = String(ownerManagerUserId ?? "").trim();
      setOptions(
        all
          .filter((h) => !owner || h.ownerUserId === owner)
          .map((h) => ({ value: h.propertyId, label: h.label })),
      );
    } catch {
      setOptions([]);
    }
  }, [options, ownerManagerUserId]);

  const save = useCallback(
    async (next: string[]) => {
      setPending(next);
      setSaving(true);
      try {
        const res = await fetch("/api/manager/sms-conversations/houses", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationKey, propertyIds: next }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error || "Could not save the house.");
        }
        onChanged?.();
      } catch (e) {
        showToast(e instanceof Error ? e.message : "Could not save the house.");
      } finally {
        setPending(null);
        setSaving(false);
      }
    },
    [conversationKey, onChanged, showToast],
  );

  const primary = houses[0] ?? null;
  const triggerLabel = primary
    ? houses.length > 1
      ? `${primary.label} +${houses.length - 1}`
      : primary.label
    : undefined;
  const title = primary
    ? `${houses.map((h) => h.label).join(", ")} · ${conversationHouseSourceLabel(primary.source)}`
    : "No house yet — only teammates with every house can see this thread";

  return (
    <span title={title} onPointerDown={() => void ensureOptions()} onFocus={() => void ensureOptions()}>
      <CheckboxMultiSelect
        label="House"
        hideLabel
        variant="pill"
        dataAttr="sms-conversation-house"
        options={options ?? (primary ? houses.map((h) => ({ value: h.propertyId, label: h.label })) : [])}
        selected={selected}
        onChange={(next) => void save(next)}
        disabled={saving}
        readOnly={!canEdit}
        emptyLabel="Assign a house"
        emptyMenuText={options === null ? "Loading houses…" : "No houses in this workspace yet"}
        selectionTriggerLabel={triggerLabel}
        searchPlaceholder="Search houses…"
        className="max-w-[12rem]"
      />
    </span>
  );
}
