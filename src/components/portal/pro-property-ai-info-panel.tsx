"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, Sparkles } from "lucide-react";
import { PortalListControlStack } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { ManagerPortalStatusPills } from "@/components/portal/portal-metrics";
import { PortalPropertyRecordRow, PortalRowFact } from "@/components/portal/portal-record-row";
import { RecordActionMenu } from "@/components/ui/record-action-menu";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
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
  AI_INFO_TAB_DEFS,
  type AiInfoBuiltinKey,
  type AiInfoTabId,
} from "@/lib/property-ai-info-rows";

type SectionKey = "about" | AiCommunicationInfoSection;

function readBuiltinText(sub: ManagerListingSubmissionV1, key: SectionKey): string {
  if (key === "about") return sub.marketingNotes ?? "";
  return sub.aiCommunicationInfo?.[key] ?? "";
}

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

  const [activeTab, setActiveTab] = useState<AiInfoTabId>("home");
  const [search, setSearch] = useState("");
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTarget, setEditorTarget] = useState<AiInfoEditorTarget | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [editorTitle, setEditorTitle] = useState("");
  const [editorGroup, setEditorGroup] = useState<AiInfoTabId>("home");
  const [saving, setSaving] = useState(false);

  const customItems = resolved?.sub.aiCommunicationCustom ?? [];

  const customVisible = customItems.some((c) => c.group === "custom" || !AI_INFO_TAB_DEFS.some((t) => t.id === c.group));
  const tabs = useMemo(() => {
    const built = AI_INFO_TAB_DEFS.filter((t) => t.id !== "custom" || customVisible);
    return built.map((tab) => {
      const builtCount = AI_INFO_BUILTIN_ROWS.filter((r) => r.group === tab.id).length;
      const customCount = customItems.filter((c) => (c.group === tab.id || (tab.id === "custom" && c.group === "custom"))).length;
      return { id: tab.id, label: tab.label, count: builtCount + customCount };
    });
  }, [customItems, customVisible]);

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
      group: activeTab === "custom" ? "custom" : activeTab,
    });
    setEditorTitle("");
    setEditorGroup(activeTab);
    setEditorValue("");
    setEditorOpen(true);
  }, [activeTab]);

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
      if (editorTarget.isNew) setActiveTab(editorGroup);
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
  const builtRows = AI_INFO_BUILTIN_ROWS.filter((row) => {
    if (row.group !== activeTab) return false;
    if (!q) return true;
    return row.title.toLowerCase().includes(q);
  });
  const customRows = customItems.filter((item) => {
    const group = item.group === "custom" ? "custom" : item.group;
    if (group !== activeTab) return false;
    if (!q) return true;
    return item.title.toLowerCase().includes(q);
  });

  return (
    <div className="px-3 py-4 max-md:px-2.5" data-attr="property-ai-info">
      <PortalListControlStack
        className="mb-3"
        variant="command"
        destinationRow={
          <ManagerPortalStatusPills
            activeId={activeTab}
            mobileSelect={false}
            onChange={(id) => setActiveTab(id as AiInfoTabId)}
            tabs={tabs.map((t) => ({
              id: t.id,
              label: t.label,
              count: t.count,
              dataAttr: `property-ai-info-tab-${t.id}`,
            }))}
          />
        }
        search={{
          value: search,
          onChange: setSearch,
          placeholder: "Search what the assistant knows",
          dataAttr: "property-ai-info-search",
        }}
        primary={
          <PortalPrimaryIconAction
            label={`Add to ${tabs.find((t) => t.id === activeTab)?.label ?? "section"}`}
            data-attr="property-ai-info-add"
            onClick={openNewCustom}
          />
        }
      />
      <div className="space-y-3">
        {builtRows.map((row) => {
          const text = readBuiltinText(resolved.sub, row.key);
          const len = text.trim().length;
          return (
            <PortalPropertyRecordRow
              key={row.key}
              title={row.title}
              leading={<Sparkles className="size-5 text-primary" aria-hidden />}
              leadingShape="square"
              facts={
                len ? (
                  <PortalRowFact icon={Check}>
                    {len} of {PROMOTION_HOUSE_NOTES_MAX_CHARS} characters
                  </PortalRowFact>
                ) : (
                  <PortalRowFact icon={AlertCircle}>Not filled in yet</PortalRowFact>
                )
              }
              onOpen={() => openBuiltin(row.key)}
              dataAttr={`property-ai-info-row-${row.key}`}
              actions={
                <RecordActionMenu label={`Actions for ${row.title}`}>
                  <DropdownMenuItem onSelect={() => openBuiltin(row.key)}>Edit</DropdownMenuItem>
                  {len ? <DropdownMenuItem onSelect={() => void clearEditorForKey(row.key)}>Clear</DropdownMenuItem> : null}
                </RecordActionMenu>
              }
            />
          );
        })}
        {customRows.map((item) => {
          const len = item.text.trim().length;
          return (
            <PortalPropertyRecordRow
              key={item.id}
              title={item.title}
              leading={<Sparkles className="size-5 text-primary" aria-hidden />}
              leadingShape="square"
              facts={
                len ? (
                  <PortalRowFact icon={Check}>
                    {len} of {PROMOTION_HOUSE_NOTES_MAX_CHARS} characters
                  </PortalRowFact>
                ) : (
                  <PortalRowFact icon={AlertCircle}>Not filled in yet</PortalRowFact>
                )
              }
              onOpen={() => openCustom(item)}
              dataAttr={`property-ai-info-row-custom-${item.id}`}
              actions={
                <RecordActionMenu label={`Actions for ${item.title}`}>
                  <DropdownMenuItem onSelect={() => openCustom(item)}>Edit</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void deleteCustomRow(item.id)}>Delete</DropdownMenuItem>
                </RecordActionMenu>
              }
            />
          );
        })}
      </div>

      <PropertyAiInfoEditorModal
        open={editorOpen}
        target={editorTarget}
        value={editorValue}
        onChange={setEditorValue}
        customTitle={editorTitle}
        onCustomTitleChange={setEditorTitle}
        showCustomTitle={editorTarget?.kind === "custom"}
        onClose={() => setEditorOpen(false)}
        onSave={() => void saveEditor()}
        onClear={editorTarget?.kind === "builtin" && editorValue.trim() ? () => void clearEditor() : undefined}
        onDelete={editorTarget?.kind === "custom" && !editorTarget?.isNew ? () => void deleteCustom() : undefined}
        busy={saving}
      />
    </div>
  );
}
