"use client";

import { useEffect, useState } from "react";
import { Modal, ModalFooter } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { useAppUi } from "@/components/providers/app-ui-provider";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";

const PRIORITIES = ["Low", "Medium", "High", "Emergency"] as const;

export function EditServiceWorkOrderModal({
  open,
  row,
  onClose,
  onSaved,
}: {
  open: boolean;
  row: DemoManagerWorkOrderRow | null;
  onClose: () => void;
  onSaved?: () => void;
}) {
  const { showToast } = useAppUi();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("Medium");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !row) return;
    setTitle(row.title ?? "");
    setDescription(row.description ?? "");
    setPriority(row.priority?.trim() || "Medium");
    setCost(row.cost && row.cost !== "—" ? row.cost : "");
    setBusy(false);
  }, [open, row]);

  const onSave = () => {
    if (!row) return;
    const nextTitle = title.trim();
    if (!nextTitle) {
      showToast("Title is required.");
      return;
    }
    setBusy(true);
    try {
      updateManagerWorkOrder(row.id, (current) => ({
        ...current,
        title: nextTitle,
        description: description.trim(),
        priority: priority.trim() || current.priority,
        ...(cost.trim() ? { cost: cost.trim() } : {}),
      }));
      showToast("Service updated.");
      onSaved?.();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open && Boolean(row)}
      title="Edit service"
      dense
      fullPage={false}
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <ModalFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={busy || !row}
            onClick={onSave}
            data-attr="edit-service-work-order-save"
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      }
    >
      {row ? (
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              disabled={busy}
              data-attr="edit-service-work-order-title"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Priority</span>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              disabled={busy}
              data-attr="edit-service-work-order-priority"
            >
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Cost</span>
            <Input
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="$0"
              disabled={busy}
              data-attr="edit-service-work-order-cost"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Details</span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              disabled={busy}
              data-attr="edit-service-work-order-description"
            />
          </label>
          <p className="text-xs text-muted">
            Visit arrival and vendor assignment are edited from Schedule visit.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
