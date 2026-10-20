/** "1. Ambika" is a list position, not part of the name people say ("Ambika"). Pure. */
export function serviceWorkspaceLabel(name: string): string {
  return name.replace(/^\s*\d+\s*[.)-]\s*/, "").trim() || name.trim();
}
