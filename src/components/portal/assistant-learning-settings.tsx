"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, Plus } from "lucide-react";
import { ConfirmDeleteModal } from "@/components/portal/confirm-delete-modal";
import { KnowledgeEntryModal } from "@/components/portal/knowledge-entry-modal";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalPropertyRecordRow, PortalRowFact, PortalRowIconTile } from "@/components/portal/portal-record-row";
import { PortalSettingsGroup, PortalSettingsRow, PortalSettingsSection } from "@/components/portal/portal-settings-ui";
import { RowActionsMenu } from "@/components/portal/row-actions-menu";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { TopicReplyMode } from "@/lib/one-number/contracts";
import {
  deleteKnowledgeEntry,
  fetchKnowledge,
  fetchReplyModes,
  saveReplyMode,
  type ReplyModeRow,
} from "@/lib/one-number/knowledge/client";
import { REPLY_TOPIC_LABELS } from "@/lib/one-number/knowledge/topics";
import type { KnowledgeEntry } from "@/lib/one-number/knowledge/types";
import { knowledgeExcerpt } from "@/components/portal/property-knowledge-list";

const MODE_OPTIONS: { value: TopicReplyMode; label: string }[] = [
  { value: "draft", label: "Draft for me to send" },
  { value: "auto_review", label: "Send and flag for review" },
  { value: "full_auto", label: "Send automatically" },
];

/**
 * Settings, Communication: one row per topic with the most the assistant may do on its own. A
 * workspace that has never picked keeps today's behaviour (every reply goes out); the first pick
 * on any topic opts the workspace in. Absent when the read is refused.
 */
export function AssistantReplyModesSection() {
  const [data, setData] = useState<{ topics: ReplyModeRow[]; canEdit: boolean } | null>(null);
  const [busyTopic, setBusyTopic] = useState<string | null>(null);

  const load = useCallback(async () => setData(await fetchReplyModes()), []);
  useEffect(() => {
    void load();
  }, [load]);

  if (!data) return null;
  return (
    <PortalSettingsSection title="Assistant replies">
      <PortalSettingsGroup>
        {data.topics.map((row) => (
          <PortalSettingsRow key={row.topic} label={REPLY_TOPIC_LABELS[row.topic]}>
            <FieldSingleSelect
              variant="cell"
              hideLabel
              label={`${REPLY_TOPIC_LABELS[row.topic]} reply mode`}
              value={row.ceiling ?? "full_auto"}
              disabled={!data.canEdit || busyTopic === row.topic}
              onChange={async (next) => {
                setBusyTopic(row.topic);
                await saveReplyMode(row.topic, next as TopicReplyMode);
                await load();
                setBusyTopic(null);
              }}
              options={MODE_OPTIONS}
              wrapperClassName="w-60"
              dataAttr={`reply-mode-${row.topic}`}
            />
          </PortalSettingsRow>
        ))}
      </PortalSettingsGroup>
    </PortalSettingsSection>
  );
}

/** Settings, Communication: answers that apply to every house, with the same row menu as a house's list. */
export function TeamKnowledgeSection() {
  const [entries, setEntries] = useState<KnowledgeEntry[] | null>(null);
  const [canManageTeam, setCanManageTeam] = useState(false);
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [deleting, setDeleting] = useState<KnowledgeEntry | null>(null);

  const load = useCallback(async () => {
    const result = await fetchKnowledge({ team: true });
    if (result) {
      setEntries(result.entries.filter((e) => e.propertyId === null));
      setCanManageTeam(result.canManageTeam);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (entries === null) return null;
  return (
    <PortalSettingsSection
      title="Answers for all houses"
      action={
        canManageTeam ? (
          <PortalPrimaryIconAction
            icon={Plus}
            label="Add answer"
            data-attr="team-knowledge-add"
            onClick={() => {
              setEditing(null);
              setModalOpen(true);
            }}
          />
        ) : null
      }
    >
      <PortalSettingsGroup>
        {entries.map((entry) => (
          <PortalPropertyRecordRow
            key={entry.id}
            title={entry.question}
            leading={<PortalRowIconTile icon={BookOpen} />}
            leadingShape="square"
            facts={[
              <PortalRowFact key="a" icon={BookOpen} srLabel="Answer">
                {knowledgeExcerpt(entry.answer)}
              </PortalRowFact>,
            ]}
            onOpen={canManageTeam ? () => { setEditing(entry); setModalOpen(true); } : undefined}
            dataAttr="team-knowledge-row"
            actions={
              canManageTeam ? (
                <RowActionsMenu
                  label={entry.question}
                  items={[
                    { id: "edit", label: "Edit", onSelect: () => { setEditing(entry); setModalOpen(true); } },
                    { id: "delete", label: "Delete", danger: true, onSelect: () => setDeleting(entry) },
                  ]}
                />
              ) : undefined
            }
          />
        ))}
      </PortalSettingsGroup>
      <KnowledgeEntryModal
        open={modalOpen}
        entry={editing}
        propertyId={null}
        canManageTeam={canManageTeam}
        onClose={() => setModalOpen(false)}
        onSaved={() => void load()}
      />
      <ConfirmDeleteModal
        open={deleting !== null}
        title="Delete this answer?"
        description="The assistant will stop using it."
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (deleting) {
            await deleteKnowledgeEntry(deleting.id);
            setDeleting(null);
            await load();
          }
        }}
      />
    </PortalSettingsSection>
  );
}
