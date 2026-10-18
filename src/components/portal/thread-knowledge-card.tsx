"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, Flag, Pencil, X } from "lucide-react";
import { KnowledgeEntryModal } from "@/components/portal/knowledge-entry-modal";
import { PortalIconAction } from "@/components/portal/portal-icon-action";
import { Button } from "@/components/ui/button";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import {
  actOnDraft,
  fetchThreadKnowledge,
  patchKnowledgeEntry,
  type ThreadKnowledgeView,
} from "@/lib/one-number/knowledge/client";
import type { KnowledgeEntry } from "@/lib/one-number/knowledge/types";

/**
 * What the learning loop adds to one SMS thread, drawn above the composer:
 *  - the assistant's held draft (Use draft puts it in the composer; the X rejects it),
 *  - an auto-sent reply flagged for review (looks right / needs a fix),
 *  - a suggested answer: "Save this answer for <house>?" with Save / Edit / Dismiss and a scope pick.
 * Renders nothing when the thread has none of these, and nothing when the read is refused.
 * `refreshKey` changes when the thread's messages change, so a manager's send retires a draft.
 */
export function ThreadKnowledgeCard({
  phone,
  refreshKey,
  onUseDraft,
}: {
  phone: string | null | undefined;
  refreshKey: string | number;
  onUseDraft: (body: string) => void;
}) {
  const [data, setData] = useState<ThreadKnowledgeView | null>(null);
  const [scope, setScope] = useState<"house" | "team">("house");
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!phone) {
      setData(null);
      return;
    }
    setData(await fetchThreadKnowledge(phone));
  }, [phone]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (!data) return null;
  const suggestion = data.suggestions[0] ?? null;
  if (!suggestion && !data.draft && !data.reviewing) return null;

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 space-y-2 border-t border-border bg-card px-4 py-3" data-attr="thread-knowledge-card">
      {data.draft ? (
        <div className="rounded-xl border border-border bg-background p-3" data-attr="thread-ai-draft">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-semibold text-foreground">Assistant draft</p>
            <PortalIconAction icon={X} label="Discard draft" disabled={busy} onClick={() => void act(() => actOnDraft(data.draft!.id, "reject"))} data-attr="thread-ai-draft-discard" />
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[14px] text-foreground">{data.draft.body}</p>
          <div className="mt-2 flex justify-end">
            <Button type="button" variant="primary" className="rounded-full" data-attr="thread-ai-draft-use" onClick={() => onUseDraft(data.draft!.body)}>
              Use draft
            </Button>
          </div>
        </div>
      ) : null}

      {data.reviewing ? (
        <div className="rounded-xl border border-border bg-background p-3" data-attr="thread-ai-review">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[13px] font-semibold text-foreground">Assistant replied</p>
            <div className="flex items-center gap-1">
              <PortalIconAction icon={Check} label="Looks right" disabled={busy} onClick={() => void act(() => actOnDraft(data.reviewing!.id, "ok"))} data-attr="thread-ai-review-ok" />
              <PortalIconAction icon={Flag} label="Needed a fix" disabled={busy} onClick={() => void act(() => actOnDraft(data.reviewing!.id, "corrected"))} data-attr="thread-ai-review-fix" />
            </div>
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[14px] text-foreground">{data.reviewing.body}</p>
        </div>
      ) : null}

      {suggestion ? (
        <div className="rounded-xl border border-border bg-background p-3" data-attr="thread-knowledge-suggestion">
          <p className="text-[13px] font-semibold text-foreground">
            {suggestion.houseLabel ? `Save this answer for ${suggestion.houseLabel}?` : "Save this answer?"}
          </p>
          <p className="mt-1 text-[13px] text-muted">{suggestion.question}</p>
          <p className="mt-1 whitespace-pre-wrap text-[14px] text-foreground">{suggestion.answer}</p>
          <div className="mt-2 flex flex-wrap items-end justify-between gap-2">
            {data.canManageTeam && suggestion.propertyId ? (
              <FieldSingleSelect
                label="Applies to"
                value={scope}
                onChange={(next) => setScope(next === "team" ? "team" : "house")}
                options={[
                  { value: "house", label: "This house" },
                  { value: "team", label: "All houses" },
                ]}
                dataAttr="thread-knowledge-scope"
              />
            ) : (
              <span />
            )}
            <div className="flex items-center gap-1">
              <PortalIconAction icon={Pencil} label="Edit" disabled={busy} onClick={() => setEditing(suggestion)} data-attr="thread-knowledge-edit" />
              <Button type="button" variant="ghost" disabled={busy} data-attr="thread-knowledge-dismiss" onClick={() => act(() => patchKnowledgeEntry(suggestion.id, { action: "dismiss" }))}>
                Dismiss
              </Button>
              <Button type="button" variant="primary" className="rounded-full" disabled={busy} data-attr="thread-knowledge-save" onClick={() => act(() => patchKnowledgeEntry(suggestion.id, { action: "approve", scope }))}>
                Save
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      <KnowledgeEntryModal
        open={editing !== null}
        entry={editing}
        propertyId={editing?.propertyId ?? null}
        canManageTeam={data.canManageTeam}
        onClose={() => setEditing(null)}
        onSaved={() => void load()}
      />
    </div>
  );
}
