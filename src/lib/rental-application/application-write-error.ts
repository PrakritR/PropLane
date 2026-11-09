/** Expose only the known capacity refusals; database messages may contain private data. */
export function managerApplicationDatabaseWriteMessage(error: { code?: string; message: string }): string {
  if (error.code !== "P4001") return "Could not save application.";
  const known = new Set([
    "This room is blocked for the requested dates.",
    "No bed is available in this room for the requested dates.",
    "That resident slot is already held for this room.",
  ]);
  return known.has(error.message) ? error.message : "The selected room is unavailable for these dates.";
}
