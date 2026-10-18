"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import { Input, Textarea } from "@/components/ui/input";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { createKnowledgeEntry, patchKnowledgeEntry } from "@/lib/one-number/knowledge/client";
import type { KnowledgeAudience, KnowledgeEntry } from "@/lib/one-number/knowledge/types";

const AUDIENCE_OPTIONS = [
  { value: "residents", label: "Residents and the team" },
  { value: "all", label: "Anyone who texts" },
  { value: "team", label: "The team only" },
];

/**
 * Add or edit one saved answer. `propertyId` names the house the list belongs to; omitted means the
 * team-wide list. An existing entry keeps its own scope unless the manager changes "Applies to".
 */
export function KnowledgeEntryModal({
  open,
  entry,
  propertyId,
  canManageTeam,
  onClose,
  onSaved,
}: {
  open: boolean;
  entry: KnowledgeEntry | null;
  propertyId: string | null;
  canManageTeam: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [audience, setAudience] = useState<KnowledgeAudience>("residents");
  const [scope, setScope] = useState<"house" | "team">("house");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuestion(entry?.question ?? "");
    setAnswer(entry?.answer ?? "");
    setAudience(entry?.audience ?? "residents");
    setScope(entry ? (entry.propertyId ? "house" : "team") : propertyId ? "house" : "team");
    setError(null);
  }, [open, entry, propertyId]);

  const houseId = entry?.propertyId ?? propertyId;
  const scopeLocked = !propertyId && !entry?.propertyId;

  const save = async () => {
    if (!question.trim() || !answer.trim()) {
      setError("Enter a question and an answer.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (entry) {
        const result = await patchKnowledgeEntry(entry.id, {
          action: "edit",
          question,
          answer,
          audience,
          ...(scope === "team" ? { scope: "team" as const } : houseId ? { propertyId: houseId } : {}),
        });
        if (!result.ok) {
          setError("Could not save. Try again.");
          return;
        }
      } else {
        const created = await createKnowledgeEntry({
          question,
          answer,
          audience,
          propertyId: scope === "team" ? null : houseId,
        });
        if (!created) {
          setError("Could not save. Try again.");
          return;
        }
      }
      onSaved();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      title={entry ? "Edit answer" : "Add answer"}
      onClose={onClose}
      presentation="dialog"
      dense
      panelClassName="max-w-xl"
      stackClassName="fixed inset-0 z-[80] overflow-y-auto overscroll-contain"
      footer={
        <ModalFooter>
          <Button type="button" variant="primary" className="rounded-full" data-attr="knowledge-entry-save" onClick={() => save()}>
            Save
          </Button>
        </ModalFooter>
      }
    >
      <div className="space-y-3">
        <div>
          <p className="text-sm font-medium text-foreground">Question</p>
          <Input value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} placeholder="What is the Wi-Fi password?" className="mt-1" data-attr="knowledge-entry-question" />
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">Answer</p>
          <Textarea value={answer} maxLength={2000} rows={4} onChange={(e) => setAnswer(e.target.value)} className="mt-1" data-attr="knowledge-entry-answer" />
        </div>
        {canManageTeam && !scopeLocked ? (
          <FieldSingleSelect
            label="Applies to"
            value={scope}
            onChange={(next) => setScope(next === "team" ? "team" : "house")}
            options={[
              { value: "house", label: "This house" },
              { value: "team", label: "All houses" },
            ]}
            dataAttr="knowledge-entry-scope"
          />
        ) : null}
        <FieldSingleSelect
          label="Who can hear it"
          value={audience}
          onChange={(next) => setAudience(next === "all" || next === "team" ? next : "residents")}
          options={AUDIENCE_OPTIONS}
          dataAttr="knowledge-entry-audience"
        />
        {error ? (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
