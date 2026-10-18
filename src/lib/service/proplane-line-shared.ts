/** Client-safe: the PropLane line's modes and how the admin panel names them. */
export const PROPLANE_LINE_MODES = ["per_workspace", "shadow", "shared"] as const;
export type ProplaneLineMode = (typeof PROPLANE_LINE_MODES)[number];

export const PROPLANE_LINE_MODE_LABEL: Record<ProplaneLineMode, string> = {
  per_workspace: "Per workspace",
  shadow: "Shadow",
  shared: "Shared",
};

/** Off = every workspace texts from its own number (today); Shadow = routes in the background, sends nothing new; Shared = live. */
export function proplaneLineStatus(mode: ProplaneLineMode, sharedNumber: string | null): "Off" | "Shadow" | "Live" {
  if (mode === "shared" && sharedNumber) return "Live";
  if (mode === "shadow") return "Shadow";
  return "Off";
}
