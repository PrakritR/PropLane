"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Home, KeyRound, MapPin, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { PropertyAiInfoEditorModal, type AiInfoEditorTarget } from "@/components/portal/property-ai-info-editor-modal";
import { PROMOTION_HOUSE_NOTES_MAX_CHARS } from "@/components/portal/promotion-house-notes";
import {
  type AiCommunicationCustomItem,
  type AiCommunicationInfoSection,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  persistManagerListingSubmissionOnServer,
  resolveManagerListingSubmissionForPropertyId,
} from "@/lib/manager-property-save-target";
import {
  AI_INFO_BUILTIN_ROWS,
  AI_INFO_GROUP_OPTIONS,
  type AiInfoBuiltinKey,
  type AiInfoTabId,
} from "@/lib/property-ai-info-rows";

type SectionKey = "about" | AiCommunicationInfoSection;

function readBuiltinText(sub: ManagerListingSubmissionV1, key: SectionKey): string {
  if (key === "about") return sub.marketingNotes ?? "";
  return sub.aiCommunicationInfo?.[key] ?? "";
}

const GROUP_ICONS: Record<string, LucideIcon> = {
  home: Home,
  leasing: KeyRound,
  rules: ShieldCheck,
  area: MapPin,
  custom: Sparkles,
};

function makeCustomId(): string {
  return `ai-custom-${Date.now().toString(36)}`;
}

export function ManagerPropertyAiInfoPanel({
  propertyId,
  managerUserId,
  revision = 0,
  showToast,
  onUpdated,
}: {
  propertyId: string;
  managerUserId: string | null;
  revision?: number;
  showToast: (message: string) => void;
  onUpdated?: () => void;
}) {
  const resolved = useMemo(() => {
    void revision;
    if (!managerUserId || !propertyId.trim()) return null;
    return resolveManagerListingSubmissionForPropertyId(managerUserId, propertyId);
  }, [managerUserId, propertyId, revision]);

  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<AiInfoEditorTarget | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [editorTitle, setEditorTitle] = useState("");
  const [editorGroup, setEditorGroup] = useState<AiInfoTabId>("home");
  const [saving, setSaving] = useState(false);

  const customItems = resolved?.sub.aiCommunicationCustom ?? [];

  const totalCount = AI_INFO_BUILTIN_ROWS.length + customItems.length;

  const openBuiltin = useCallback((key: AiInfoBuiltinKey) => {
    if (!resolved) return;
    const row = AI_INFO_BUILTIN_ROWS.find((r) => r.key === key)!;
    setEditorTarget({
      kind: "builtin",
      key,
      title: row.title,
      sampleQuestion: row.sampleQuestion,
    });
    setEditorValue(readBuiltinText(resolved.sub, key));
    setEditorOpen(true);
  }, [resolved]);

  const openCustom = useCallback((item: AiCommunicationCustomItem) => {
    setEditorTarget({
      kind: "custom",
      id: item.id,
      title: item.title,
      sampleQuestion: `What can you tell me about ${item.title.toLowerCase()}?`,
      group: item.group,
    });
    setEditorTitle(item.title);
    setEditorGroup(item.group === "custom" ? "custom" : (item.group as AiInfoTabId));
    setEditorValue(item.text);
    setEditorOpen(true);
  }, []);

  const openNewCustom = useCallback(() => {
    setEditorTarget({
      kind: "custom",
      id: "",
      title: "",
      sampleQuestion: "What can you tell me about this?",
      isNew: true,
      group: "home",
    });
    setEditorTitle("");
    setEditorGroup("home");
    setEditorValue("");
    setEditorOpen(true);
  }, []);

  const persistSubmission = useCallback(
    async (next: ManagerListingSubmissionV1) => {
      if (!resolved || !managerUserId) return false;
      setSaving(true);
      const ok = await persistManagerListingSubmissionOnServer(resolved.saveTarget, managerUserId, next);
      setSaving(false);
      if (!ok) {
        showToast("Could not save. Try again.");
        return false;
      }
      onUpdated?.();
      return true;
    },
    [managerUserId, onUpdated, resolved, showToast],
  );

  const saveEditor = useCallback(async () => {
    if (!resolved || !editorTarget) return;
    const text = editorValue.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS).trim();
    if (editorTarget.kind === "builtin") {
      const key = editorTarget.key;
      const next: ManagerListingSubmissionV1 =
        key === "about"
          ? { ...resolved.sub, marketingNotes: text }
          : {
              ...resolved.sub,
              aiCommunicationInfo: {
                tours: resolved.sub.aiCommunicationInfo?.tours ?? "",
                rules: resolved.sub.aiCommunicationInfo?.rules ?? "",
                pricing: resolved.sub.aiCommunicationInfo?.pricing ?? "",
                neighborhood: resolved.sub.aiCommunicationInfo?.neighborhood ?? "",
                [key]: text,
              },
            };
      if (await persistSubmission(next)) {
        setEditorOpen(false);
        showToast("Saved");
      }
      return;
    }
    const title = editorTitle.trim();
    if (!title) {
      showToast("Give this a title.");
      return;
    }
    const list = [...(resolved.sub.aiCommunicationCustom ?? [])];
    const existing = editorTarget.isNew ? null : list.find((c) => c.id === editorTarget.id) ?? null;
    const item: AiCommunicationCustomItem = {
      id: existing?.id ?? makeCustomId(),
      title,
      text: editorValue.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS),
      group: editorGroup,
    };
    const nextList = existing
      ? list.map((c) => (c.id === existing.id ? item : c))
      : [...list, item];
    const next = { ...resolved.sub, aiCommunicationCustom: nextList };
    if (await persistSubmission(next)) {
      setEditorOpen(false);
      showToast(existing ? "Saved" : `${title} added`);
    }
  }, [editorGroup, editorTarget, editorTitle, editorValue, persistSubmission, resolved, showToast]);

  const clearEditor = useCallback(async () => {
    if (!resolved || !editorTarget || editorTarget.kind !== "builtin") return;
    const key = editorTarget.key;
    const next: ManagerListingSubmissionV1 =
      key === "about"
        ? { ...resolved.sub, marketingNotes: "" }
        : {
            ...resolved.sub,
            aiCommunicationInfo: {
              tours: resolved.sub.aiCommunicationInfo?.tours ?? "",
              rules: resolved.sub.aiCommunicationInfo?.rules ?? "",
              pricing: resolved.sub.aiCommunicationInfo?.pricing ?? "",
              neighborhood: resolved.sub.aiCommunicationInfo?.neighborhood ?? "",
              [key]: "",
            },
          };
    if (await persistSubmission(next)) {
      setEditorValue("");
      setEditorOpen(false);
      showToast("Cleared");
    }
  }, [editorTarget, persistSubmission, resolved, showToast]);

  const deleteCustom = useCallback(async () => {
    if (!resolved || !editorTarget || editorTarget.kind !== "custom" || editorTarget.isNew) return;
    const nextList = (resolved.sub.aiCommunicationCustom ?? []).filter((c) => c.id !== editorTarget.id);
    if (await persistSubmission({ ...resolved.sub, aiCommunicationCustom: nextList.length ? nextList : undefined })) {
      setEditorOpen(false);
      showToast("Deleted");
    }
  }, [editorTarget, persistSubmission, resolved, showToast]);

  useEffect(() => {
    if (editorTarget?.kind === "custom" && !editorTarget.isNew) {
      setEditorTitle(editorTarget.title);
    }
  }, [editorTarget]);

  const deleteCustomRow = useCallback(
    async (id: string) => {
      if (!resolved) return;
      const nextList = (resolved.sub.aiCommunicationCustom ?? []).filter((c) => c.id !== id);
      if (await persistSubmission({ ...resolved.sub, aiCommunicationCustom: nextList.length ? nextList : undefined })) {
        showToast("Deleted");
      }
    },
    [persistSubmission, resolved, showToast],
  );

  const clearEditorForKey = useCallback(
    async (key: AiInfoBuiltinKey) => {
      if (!resolved) return;
      const next: ManagerListingSubmissionV1 =
        key === "about"
          ? { ...resolved.sub, marketingNotes: "" }
          : {
              ...resolved.sub,
              aiCommunicationInfo: {
                tours: resolved.sub.aiCommunicationInfo?.tours ?? "",
                rules: resolved.sub.aiCommunicationInfo?.rules ?? "",
                pricing: resolved.sub.aiCommunicationInfo?.pricing ?? "",
                neighborhood: resolved.sub.aiCommunicationInfo?.neighborhood ?? "",
                [key]: "",
              },
            };
      if (await persistSubmission(next)) showToast("Cleared");
    },
    [persistSubmission, resolved, showToast],
  );

  if (!resolved) return null;

  const q = search.trim().toLowerCase();
  const groupRank = (group: string) => {
    const i = AI_INFO_GROUP_OPTIONS.findIndex((o) => o.id === group);
    return i < 0 ? AI_INFO_GROUP_OPTIONS.length - 1 : i;
  };
  const groupLabel = (group: string) =>
    AI_INFO_GROUP_OPTIONS[groupRank(group)]?.label ?? "Other";
  type Entry = {
    id: string;
    title: string;
    group: string;
    len: number;
    custom: AiCommunicationCustomItem | null;
    builtinKey: AiInfoBuiltinKey | null;
  };
  const entries: Entry[] = [
    ...AI_INFO_BUILTIN_ROWS.map(
      (row): Entry => ({
        id: row.key,
        title: row.title,
        group: row.group,
        len: readBuiltinText(resolved.sub, row.key).trim().length,
        custom: null,
        builtinKey: row.key,
      }),
    ),
    ...customItems.map(
      (item): Entry => ({
        id: `custom-${item.id}`,
        title: item.title,
        group: item.group,
        len: item.text.trim().length,
        custom: item,
        builtinKey: null,
      }),
    ),
  ]
    .map((entry, index) => ({ entry, index }))
    .sort((x, y) => groupRank(x.entry.group) - groupRank(y.entry.group) || x.index - y.index)
    .map(({ entry }) => entry)
    .filter((entry) => !q || `${entry.title} ${groupLabel(entry.group)}`.toLowerCase().includes(q));

  return (
    <div data-attr="property-ai-info">
      <PortalListControlStack
        className="plp-header-card mb-2 max-lg:mb-1.5"
        variant="command"
        destinationRow={
          <LocalDestinationNav
            appearance="command"
            items={[{ id: "knows", label: "What the assistant knows", count: totalCount }]}
            activeId="knows"
            onChange={() => {}}
            ariaLabel="What the assistant knows"
          />
        }
        activeDestinationId="knows"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search what the assistant knows",
          dataAttr: "property-ai-info-search",
        }}
        primary={
          <PortalPrimaryIconAction
            label="Add to what the assistant knows"
            data-attr="property-ai-info-add"
            onClick={openNewCustom}
          />
        }
      />
      <PortalRecordListSurface
        isEmpty={entries.length === 0}
        emptyCard={{ title: q ? "No matches" : "Nothing here yet", section: "ai-info", tone: q ? "muted" : "default" }}
      >
        {entries.map((entry) => {
          const open = () => (entry.custom ? openCustom(entry.custom) : openBuiltin(entry.builtinKey!));
          return (
            <PortalPropertyRecordRow
              key={entry.id}
              title={entry.title}
              leading={<PortalRowIconTile icon={Sparkles} />}
              leadingShape="square"
              facts={
                <>
                  <PortalRowFact icon={GROUP_ICONS[entry.group] ?? Sparkles} srLabel="Category">
                    {groupLabel(entry.group)}
                  </PortalRowFact>
                  {entry.len ? (
                    <PortalRowFact icon={Check}>{entry.len} chars</PortalRowFact>
                  ) : (
                    <PortalRowFact icon={AlertCircle}>Not filled in yet</PortalRowFact>
                  )}
                </>
              }
              onOpen={open}
              dataAttr={entry.custom ? `property-ai-info-row-custom-${entry.custom.id}` : `property-ai-info-row-${entry.builtinKey}`}
              actions={
                <RowActionsMenu
                  label={entry.title}
                  items={[
                    { id: "edit", label: "Edit", onSelect: open },
                    entry.custom
                      ? { id: "delete", label: "Delete", danger: true, onSelect: () => void deleteCustomRow(entry.custom!.id) }
                      : entry.len
                        ? { id: "clear", label: "Clear", onSelect: () => void clearEditorForKey(entry.builtinKey!) }
                        : null,
                  ]}
                />
              }
            />
          );
        })}
      </PortalRecordListSurface>

      <PropertyAiInfoEditorModal
        open={editorOpen}
        target={editorTarget}
        value={editorValue}
        onChange={setEditorValue}
        customTitle={editorTitle}
        onCustomTitleChange={setEditorTitle}
        showCustomTitle={editorTarget?.kind === "custom"}
        group={editorGroup}
        onGroupChange={(next) => setEditorGroup(next as AiInfoTabId)}
        onClose={() => setEditorOpen(false)}
        onSave={() => void saveEditor()}
        onClear={editorTarget?.kind === "builtin" && editorValue.trim() ? () => void clearEditor() : undefined}
        onDelete={editorTarget?.kind === "custom" && !editorTarget?.isNew ? () => void deleteCustom() : undefined}
        busy={saving}
      />
    </div>
  );
}
