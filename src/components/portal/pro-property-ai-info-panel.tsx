"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeftRight, Check, Home, KeyRound, MapPin, ShieldCheck, Sparkles, type LucideIcon } from "lucide-react";
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
  inStay,
  stayLabel,
  stayTabsFor,
  type PropertyStay,
  type StayAppliesTo,
} from "@/lib/property-stay-tabs";
import { withShortTermText } from "@/lib/property-ai-info-by-stay";
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

function readShortTermText(sub: ManagerListingSubmissionV1, key: SectionKey): string {
  return sub.aiCommunicationInfoShortTerm?.[key] ?? "";
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
  const [editorShortOn, setEditorShortOn] = useState(false);
  const [editorShortValue, setEditorShortValue] = useState("");
  const [editorAppliesTo, setEditorAppliesTo] = useState<StayAppliesTo>("both");
  const [stayPick, setStayPick] = useState<PropertyStay>("long_term");
  const [saving, setSaving] = useState(false);

  const customItems = useMemo(() => resolved?.sub.aiCommunicationCustom ?? [], [resolved]);

  // Every built-in row is shared, so it shows in both tabs; a custom row shows where it applies. Only a row
  // that belongs to one stay alone holds a tab open on a property that does not allow that stay.
  const tabStays: PropertyStay[] = resolved
    ? stayTabsFor(resolved.sub, {
        long_term: customItems.filter((c) => c.appliesTo === "long_term").length,
        short_term:
          customItems.filter((c) => c.appliesTo === "short_term").length +
          AI_INFO_BUILTIN_ROWS.filter((row) => readShortTermText(resolved.sub, row.key).trim()).length,
      })
    : ["long_term"];
  const stay: PropertyStay = tabStays.includes(stayPick) ? stayPick : (tabStays[0] ?? "long_term");
  const countFor = (s: PropertyStay) =>
    AI_INFO_BUILTIN_ROWS.length + customItems.filter((c) => inStay(c.appliesTo, s)).length;

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
    const short = readShortTermText(resolved.sub, key);
    setEditorShortOn(Boolean(short.trim()));
    setEditorShortValue(short);
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
    setEditorAppliesTo(item.appliesTo ?? "both");
    setEditorOpen(true);
  }, []);

  const openNewCustom = () => {
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
    setEditorAppliesTo(stay);
    setEditorOpen(true);
  };

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
      const base: ManagerListingSubmissionV1 = {
        ...resolved.sub,
        // Switched off clears the short-term text; on keeps (or adds) it beside the shared text.
        aiCommunicationInfoShortTerm: withShortTermText(
          resolved.sub.aiCommunicationInfoShortTerm,
          key,
          editorShortOn ? editorShortValue.slice(0, PROMOTION_HOUSE_NOTES_MAX_CHARS) : "",
        ),
      };
      const next: ManagerListingSubmissionV1 =
        key === "about"
          ? { ...base, marketingNotes: text }
          : {
              ...base,
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
      ...(editorAppliesTo === "both" ? {} : { appliesTo: editorAppliesTo }),
    };
    const nextList = existing
      ? list.map((c) => (c.id === existing.id ? item : c))
      : [...list, item];
    const next = { ...resolved.sub, aiCommunicationCustom: nextList };
    if (await persistSubmission(next)) {
      setEditorOpen(false);
      showToast(existing ? "Saved" : `${title} added`);
    }
  }, [editorAppliesTo, editorGroup, editorShortOn, editorShortValue, editorTarget, editorTitle, editorValue, persistSubmission, resolved, showToast]);

  const clearEditor = useCallback(async () => {
    if (!resolved || !editorTarget || editorTarget.kind !== "builtin") return;
    const key = editorTarget.key;
    const cleared: ManagerListingSubmissionV1 = {
      ...resolved.sub,
      aiCommunicationInfoShortTerm: withShortTermText(resolved.sub.aiCommunicationInfoShortTerm, key, ""),
    };
    const next: ManagerListingSubmissionV1 =
      key === "about"
        ? { ...cleared, marketingNotes: "" }
        : {
            ...cleared,
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
      const cleared: ManagerListingSubmissionV1 = {
        ...resolved.sub,
        aiCommunicationInfoShortTerm: withShortTermText(resolved.sub.aiCommunicationInfoShortTerm, key, ""),
      };
      const next: ManagerListingSubmissionV1 =
        key === "about"
          ? { ...cleared, marketingNotes: "" }
          : {
              ...cleared,
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
    /** "Shared" | "Long term" | "Short term": what the row says in this tab. */
    stayFact: string;
    custom: AiCommunicationCustomItem | null;
    builtinKey: AiInfoBuiltinKey | null;
  };
  const entries: Entry[] = [
    ...AI_INFO_BUILTIN_ROWS.map((row): Entry => {
      // The Short term tab shows a row's short-term version when it has one; every other view is the shared text.
      const short = stay === "short_term" ? readShortTermText(resolved.sub, row.key).trim() : "";
      return {
        id: row.key,
        title: row.title,
        group: row.group,
        len: (short || readBuiltinText(resolved.sub, row.key).trim()).length,
        stayFact: short ? "Short term" : "Shared",
        custom: null,
        builtinKey: row.key,
      };
    }),
    ...customItems
      .filter((item) => inStay(item.appliesTo, stay))
      .map(
        (item): Entry => ({
          id: `custom-${item.id}`,
          title: item.title,
          group: item.group,
          len: item.text.trim().length,
          stayFact: item.appliesTo === "long_term" || item.appliesTo === "short_term" ? stayLabel(item.appliesTo) : "Shared",
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
            items={tabStays.map((id) => ({ id, label: stayLabel(id), count: countFor(id) }))}
            activeId={stay}
            onChange={(id) => setStayPick(id as PropertyStay)}
            ariaLabel="What the assistant knows"
          />
        }
        activeDestinationId={stay}
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
                  <PortalRowFact icon={ArrowLeftRight} srLabel="Applies to">
                    {entry.stayFact}
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
        appliesTo={editorAppliesTo}
        onAppliesToChange={editorTarget?.kind === "custom" ? (next) => setEditorAppliesTo(next as StayAppliesTo) : undefined}
        shortTermEnabled={editorShortOn}
        onShortTermEnabledChange={editorTarget?.kind === "builtin" ? setEditorShortOn : undefined}
        shortTermValue={editorShortValue}
        onShortTermValueChange={setEditorShortValue}
        onClose={() => setEditorOpen(false)}
        onSave={() => void saveEditor()}
        onClear={editorTarget?.kind === "builtin" && editorValue.trim() ? () => void clearEditor() : undefined}
        onDelete={editorTarget?.kind === "custom" && !editorTarget?.isNew ? () => void deleteCustom() : undefined}
        busy={saving}
      />
    </div>
  );
}
