"use client";

import { useState } from "react";
import { Zap } from "lucide-react";
import { ListSkeleton } from "@/components/ui/list-skeleton";
import { Textarea } from "@/components/ui/input";
import { LocalDestinationNav } from "@/components/ui/destination-nav";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { PortalListControlStack, portalListAddPrimaryLabel } from "@/components/portal/portal-list-control-stack";
import { PortalPrimaryIconAction } from "@/components/portal/portal-icon-action";
import { PortalRecordListSurface } from "@/components/portal/portal-record-list-surface";
import { PortalPropertyRecordRow } from "@/components/portal/portal-record-row";
import { VendorRowMenu } from "@/components/portal/vendor-row-menu";
import { useOptionalAppUi, useConfirm } from "@/components/providers/app-ui-provider";
import { MODAL_FIELD_LABEL_CLASS } from "@/components/ui/modal";
import { useVendorQuickReplies } from "@/lib/use-vendor-quick-replies";
import {
  VENDOR_QUICK_REPLY_MAX_COUNT,
  VENDOR_QUICK_REPLY_MAX_LENGTH,
  addVendorQuickReply,
  deleteVendorQuickReply,
  editVendorQuickReply,
  moveVendorQuickReply,
  type VendorQuickReply,
} from "@/lib/vendor-quick-replies";

/**
 * Settings → Quick replies: the vendor's own saved messages. Add, edit, delete
 * and reorder (via the row ⋯); every change saves the whole list through
 * `PUT /api/vendor/quick-replies`. The ⚡ in the Communication composer, a
 * review reply and the bid note read this same list.
 */
export function VendorQuickRepliesSettings() {
  const ui = useOptionalAppUi();
  const confirm = useConfirm();
  const { replies, loading, error, save } = useVendorQuickReplies();
  const [editing, setEditing] = useState<{ id: string | null; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const persist = async (next: VendorQuickReply[], done?: string) => {
    const result = await save(next);
    if (!result.ok) {
      ui?.showToast(result.error ?? "Could not save quick replies.");
      return false;
    }
    if (done) ui?.showToast(done);
    return true;
  };

  const submit = async () => {
    if (!editing) return;
    const text = editing.text.trim();
    if (!text) return;
    setSaving(true);
    try {
      const next = editing.id ? editVendorQuickReply(replies, editing.id, text) : addVendorQuickReply(replies, text);
      if (await persist(next, editing.id ? "Quick reply saved." : "Quick reply added.")) setEditing(null);
    } finally {
      setSaving(false);
    }
  };

  const atLimit = replies.length >= VENDOR_QUICK_REPLY_MAX_COUNT;

  return (
    <div data-attr="vendor-quick-replies-settings">
      <PortalListControlStack
        className="mb-2"
        variant="command"
        destinationAriaLabel="Quick replies"
        destinationRow={
          <LocalDestinationNav
            appearance="command"
            activeId="all"
            onChange={() => undefined}
            ariaLabel="Quick replies"
            items={[{ id: "all", label: "Quick replies", count: replies.length, dataAttr: "vendor-quick-replies-tab" }]}
          />
        }
        primary={
          <PortalPrimaryIconAction
            label={portalListAddPrimaryLabel("quick reply")}
            data-attr="vendor-quick-replies-add"
            disabled={atLimit}
            onClick={() => setEditing({ id: null, text: "" })}
          />
        }
      />
      {loading ? (
        <ListSkeleton rows={3} showLeading={false} />
      ) : error ? (
        <p role="alert" className="py-6 text-center text-sm" data-attr="vendor-quick-replies-error">
          {error}
        </p>
      ) : (
        <PortalRecordListSurface
          isEmpty={replies.length === 0}
          emptyCard={{ title: "No quick replies yet", tone: "muted" }}
          dataAttr="vendor-quick-replies-list"
        >
          {replies.map((reply, index) => (
            <PortalPropertyRecordRow
              key={reply.id}
              title={reply.text}
              leading={
                <span className="flex size-14 items-center justify-center rounded-xl bg-accent text-primary" aria-hidden>
                  <Zap className="size-5" />
                </span>
              }
              leadingShape="square"
              onOpen={() => setEditing({ id: reply.id, text: reply.text })}
              dataAttr="vendor-quick-reply-row"
              actions={
                <VendorRowMenu
                  label={reply.text}
                  dataAttr="vendor-quick-reply-menu"
                  items={[
                    { id: "edit", label: "Edit", onSelect: () => setEditing({ id: reply.id, text: reply.text }) },
                    {
                      id: "move-up",
                      label: "Move up",
                      disabled: index === 0,
                      onSelect: () => void persist(moveVendorQuickReply(replies, reply.id, -1)),
                    },
                    {
                      id: "move-down",
                      label: "Move down",
                      disabled: index === replies.length - 1,
                      onSelect: () => void persist(moveVendorQuickReply(replies, reply.id, 1)),
                    },
                    {
                      id: "delete",
                      label: "Delete",
                      destructive: true,
                      onSelect: () =>
                        void (async () => {
                          const ok = await confirm({
                            title: "Delete quick reply",
                            description: reply.text,
                            confirmLabel: "Delete",
                          });
                          if (ok) await persist(deleteVendorQuickReply(replies, reply.id), "Quick reply deleted.");
                        })(),
                    },
                  ]}
                />
              }
            />
          ))}
        </PortalRecordListSurface>
      )}
      <PortalDialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing?.id ? "Edit quick reply" : "Add quick reply"}
        dataAttr="vendor-quick-reply-dialog"
        primaryAction={{
          label: "Save quick reply",
          onClick: () => submit(),
          disabled: saving || !editing?.text.trim(),
          loading: saving,
          dataAttr: "vendor-quick-reply-save",
        }}
      >
        <div className="space-y-2">
          <label htmlFor="vendor-quick-reply-text" className={MODAL_FIELD_LABEL_CLASS}>
            Message
          </label>
          <Textarea
            id="vendor-quick-reply-text"
            rows={4}
            autoFocus
            value={editing?.text ?? ""}
            maxLength={VENDOR_QUICK_REPLY_MAX_LENGTH}
            onChange={(e) => setEditing((cur) => (cur ? { ...cur, text: e.target.value } : cur))}
            data-attr="vendor-quick-reply-text"
          />
        </div>
      </PortalDialog>
    </div>
  );
}
