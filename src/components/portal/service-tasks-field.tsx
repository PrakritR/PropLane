"use client";

import { X } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Checklist editor for a service being logged — one line per task, "+ Add
 * task" appends, × removes. Titles only; `done` is set on the service itself.
 */
export function ServiceTasksField({
  tasks,
  onChange,
  disabled = false,
  dataAttr = "service-tasks",
}: {
  tasks: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  dataAttr?: string;
}) {
  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-muted">Tasks</p>
      <div className="space-y-2">
        {tasks.map((task, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={task}
              onChange={(e) => onChange(tasks.map((t, i) => (i === index ? e.target.value : t)))}
              placeholder={index === 0 ? "e.g. Check supply lines" : "Next task"}
              className="bg-card"
              disabled={disabled}
              data-attr={`${dataAttr}-${index}`}
            />
            <button
              type="button"
              aria-label="Remove task"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-full text-muted hover:text-foreground disabled:opacity-50"
              disabled={disabled}
              onClick={() => onChange(tasks.filter((_, i) => i !== index))}
            >
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="text-xs font-semibold text-primary hover:underline disabled:opacity-50"
          disabled={disabled}
          data-attr={`${dataAttr}-add`}
          onClick={() => onChange([...tasks, ""])}
        >
          + Add task
        </button>
      </div>
    </div>
  );
}
