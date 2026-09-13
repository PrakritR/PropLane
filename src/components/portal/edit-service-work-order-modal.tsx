"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/modal";
import { Input, Select, Textarea } from "@/components/ui/input";
import { SaveStatus } from "@/components/ui/save-status";
import { useAutosaveDraft } from "@/hooks/use-autosave-draft";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { updateManagerWorkOrder } from "@/lib/manager-work-orders-storage";

const PRIORITIES = ["Low", "Medium", "High", "Emergency"] as const;

/** Edit a maintenance service. Saves itself — × is the only way out. */
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
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState<string>("Medium");
  const [cost, setCost] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const changedRef = useRef(false);

  useEffect(() => {
    if (!open || !row) {
      setHydrated(false);
      changedRef.current = false;
      return;
    }
    setTitle(row.title ?? "");
    setDescription(row.description ?? "");
    setPriority(row.priority?.trim() || "Medium");
    setCost(row.cost && row.cost !== "—" ? row.cost : "");
    const t = setTimeout(() => setHydrated(true), 0);
    return () => clearTimeout(t);
  }, [open, row]);

  const draft = useMemo(() => ({ title, description, priority, cost }), [title, description, priority, cost]);

  const persist = useCallback(
    async (d: typeof draft) => {
      if (!row) return;
      updateManagerWorkOrder(row.id, (current) => ({
        ...current,
        title: d.title.trim(),
        description: d.description.trim(),
        priority: d.priority.trim() || current.priority,
        ...(d.cost.trim() ? { cost: d.cost.trim() } : {}),
      }));
      changedRef.current = true;
    },
    [row],
  );

  const autosave = useAutosaveDraft({
    draft,
    enabled: open && Boolean(row) && hydrated,
    validate: (d) => (d.title.trim() ? null : "Needs a title"),
    save: persist,
  });

  const handleClose = useCallback(() => {
    void autosave.flush().finally(() => {
      onClose();
      if (changedRef.current) onSaved?.();
    });
  }, [autosave, onClose, onSaved]);

  return (
    <Modal
      open={open && Boolean(row)}
      title="Edit service"
      dense
      fullPage={false}
      onClose={handleClose}
      status={<SaveStatus status={autosave} />}
    >
      {row ? (
        <div className="space-y-4">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Title</span>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-attr="edit-service-work-order-title"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Priority</span>
            <Select
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
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
              data-attr="edit-service-work-order-cost"
            />
          </label>
          <label className="block space-y-1.5">
            <span className="text-xs font-medium text-muted">Details</span>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              data-attr="edit-service-work-order-description"
            />
          </label>
          <p className="text-xs text-muted">
            Visit arrival and assignment are edited from Schedule visit.
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
