"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Eye, MessageSquareText, Plus } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { KnowledgeEntryModal } from "@/components/portal/knowledge-entry-modal";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import {
  deleteKnowledgeEntry,
  fetchKnowledge,
  patchKnowledgeEntry,
} from "@/lib/one-number/knowledge/client";
import type { KnowledgeAudience, KnowledgeEntry } from "@/lib/one-number/knowledge/types";

const AUDIENCE_WORD: Record<KnowledgeAudience, string> = {
  all: "Anyone who texts",
  residents: "Residents",
  team: "Team only",
};

export function knowledgeExcerpt(text: string, max = 70): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The house's saved answers, as rows in the House details list: question, answer excerpt, who can
 * hear it, and a menu. Suggested answers wait here too until a manager saves or dismisses them.
 * Renders nothing until the first load answers.
 */
export function PropertyKnowledgeList({ propertyId, showToast }: { propertyId: string; showToast?: (message: string) => void }) {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [canManageTeam, setCanManageTeam] = useState(false);
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeEntry | null>(null);

  const load = useCallback(async () => {
    const result = await fetchKnowledge({ propertyId });
    if (result) {
      setEntries(result.entries);
      setCanManageTeam(result.canManageTeam);
    } else {
      setEntries((prev) => prev ?? []);
    }
  }, [propertyId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (entries === null) return null;

  const openAdd = () => {
    setEditing(null);
    setModalOpen(true);
  };
  const openEdit = (entry: KnowledgeEntry) => {
    setEditing(entry);
    setModalOpen(true);
  };

  return (
    <>
      {entries.map((entry) => {
        const suggested = entry.status === "suggested";
        return (
          <PortalPropertyRecordRow
            key={entry.id}
            title={entry.question}
            leading={<PortalRowIconTile icon={suggested ? MessageSquareText : BookOpen} />}
            leadingShape="square"
            attention={suggested}
            facts={[
              <PortalRowFact key="a" icon={BookOpen} srLabel="Answer">
                {knowledgeExcerpt(entry.answer)}
              </PortalRowFact>,
              <PortalRowFact key="w" icon={Eye} srLabel="Who can hear it">
                {suggested ? "Waiting to be saved" : AUDIENCE_WORD[entry.audience]}
              </PortalRowFact>,
            ]}
            onOpen={() => openEdit(entry)}
            dataAttr="property-knowledge-row"
            actions={
              <RowActionsMenu
                label={entry.question}
                items={[
                  suggested && {
                    id: "save",
                    label: "Save",
                    onSelect: async () => {
                      const result = await patchKnowledgeEntry(entry.id, { action: "approve", scope: "house" });
                      showToast?.(result.ok ? "Answer saved." : "Could not save that answer.");
                      await load();
                    },
                  },
                  suggested && {
                    id: "dismiss",
                    label: "Dismiss",
                    onSelect: async () => {
                      const result = await patchKnowledgeEntry(entry.id, { action: "dismiss" });
                      showToast?.(result.ok ? "Dismissed." : "Could not dismiss that.");
                      await load();
                    },
                  },
                  { id: "edit", label: "Edit", onSelect: () => openEdit(entry) },
                  { id: "delete", label: "Delete", danger: true, onSelect: () => setDeleting(entry) },
                ]}
              />
            }
          />
        );
      })}
      <PortalPropertyRecordRow
        title="Add an answer"
        leading={<PortalRowIconTile icon={Plus} />}
        leadingShape="square"
        onOpen={openAdd}
        dataAttr="property-knowledge-add-row"
        facts={[]}
      />
      <KnowledgeEntryModal
        open={modalOpen}
        entry={editing}
        propertyId={propertyId}
        canManageTeam={canManageTeam}
        onClose={() => setModalOpen(false)}
        onSaved={() => {
          showToast?.("Answer saved.");
          void load();
        }}
      />
      <ConfirmDeleteModal
        open={deleting !== null}
        title="Delete this answer?"
        description="The assistant will stop using it."
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            const ok = await deleteKnowledgeEntry(deleting.id);
            showToast?.(ok ? "Answer deleted." : "Could not delete that answer.");
            setDeleting(null);
            await load();
          }
        }}
      />
    </>
  );
}
