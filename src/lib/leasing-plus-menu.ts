import type { QuickAddEntry } from "@/lib/leasing-quick-add";

/**
 * The round blue + on a property Applications / Leases tab opens a menu: the blank item first ("Add
 * application" / "Add lease"), then one item per PropLane default the property does not currently carry.
 * This replaces the old separate "Quick add" row under the list.
 */
export type LeasingPlusMenuEntry = {
  /** "blank" opens the empty editor; "preset" adds the PropLane default `key`. */
  kind: "blank" | "preset";
  key: string;
  label: string;
};

export function leasingPlusMenuEntries(
  blankLabel: string,
  presets: readonly QuickAddEntry[],
): LeasingPlusMenuEntry[] {
  return [
    { kind: "blank", key: "__blank", label: blankLabel },
    ...presets.map((entry) => ({ kind: "preset" as const, key: entry.key, label: entry.label })),
  ];
}
