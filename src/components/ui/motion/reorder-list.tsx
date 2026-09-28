"use client";

/**
 * M017 — reorder list primitive.
 *
 * Ports the TECHNIQUE of interior.dev's Reorder List (MIT license,
 * github.com/ddoemonn/interior, © ozzy) — "the gap the siblings open is the
 * drop target" — WITHOUT its dependency: that component is built on
 * `motion`'s `Reorder.Group`/`Reorder.Item`, a package this app does not
 * carry (see review-0927/interior-dev-research.md §1/§4). Per BUILD-0927.md
 * ("New dependency: avoid; if unavoidable, say so first"), this is a plain
 * pointer + `useFlipRows` (flip-rows.ts) reimplementation instead — no new
 * package, same interaction and the same full keyboard alternative
 * interior.dev's own a11y notes describe: a grip button arms the row, then
 * Arrow-Up/Down actually reorders it, Escape disarms.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useFlipRows } from "@/components/ui/motion/flip-rows";
import { cn } from "@/lib/utils";

export function ReorderList<T extends { id: string }>({
  items,
  onReorder,
  renderRow,
  label,
  className,
}: {
  items: readonly T[];
  /** Called with the full new order whenever a drag or a keyboard move commits. */
  onReorder: (next: T[]) => void;
  renderRow: (item: T, index: number) => ReactNode;
  /** Read to assistive tech on the list's own `role="list"`. */
  label: string;
  className?: string;
}) {
  const { registerRow } = useFlipRows(items.map((i) => i.id));
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const draggingIndexRef = useRef<number | null>(null);

  const moveTo = (fromId: string, toIndex: number) => {
    const fromIndex = items.findIndex((i) => i.id === fromId);
    if (fromIndex === -1 || toIndex < 0 || toIndex >= items.length || fromIndex === toIndex) return;
    const next = items.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved!);
    onReorder(next);
  };

  useEffect(() => {
    if (!draggingId) return;
    const activeId = draggingId;
    function onPointerMove(e: PointerEvent) {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el?.closest<HTMLElement>("[data-reorder-id]");
      const overId = row?.dataset.reorderId;
      if (!overId || overId === activeId) return;
      const overIndex = items.findIndex((i) => i.id === overId);
      if (overIndex !== -1) moveTo(activeId, overIndex);
    }
    function onPointerUp() {
      setDraggingId(null);
      draggingIndexRef.current = null;
    }
    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);
    return () => {
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerup", onPointerUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draggingId, items]);

  return (
    <div role="list" aria-label={label} className={className}>
      {items.map((item, index) => (
        <div
          key={item.id}
          ref={registerRow(item.id)}
          role="listitem"
          data-reorder-id={item.id}
          className={cn("motion-reorder-item", draggingId === item.id && "is-dragging")}
        >
          <button
            type="button"
            className={cn("motion-reorder-grip", armedId === item.id && "is-armed")}
            aria-pressed={armedId === item.id}
            aria-label={`Reorder ${label} row ${index + 1} of ${items.length} — press Enter, then Arrow Up or Down`}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              setDraggingId(item.id);
              draggingIndexRef.current = index;
            }}
            onClick={() => setArmedId((cur) => (cur === item.id ? null : item.id))}
            onKeyDown={(e) => {
              if (armedId !== item.id) return;
              if (e.key === "ArrowUp") {
                e.preventDefault();
                moveTo(item.id, index - 1);
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                moveTo(item.id, index + 1);
              } else if (e.key === "Escape") {
                setArmedId(null);
              }
            }}
          >
            <span aria-hidden>⠿</span>
          </button>
          {renderRow(item, index)}
        </div>
      ))}
    </div>
  );
}
