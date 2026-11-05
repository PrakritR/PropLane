/** Pure canonical application ID normalization. */
export function normalizeApplicationAxisId(id: unknown): string {
  const raw = typeof id === "string" ? id.trim() : "";
  if (!raw) return raw;
  // Pre-rebrand applications keep their AXIS- ids; new ones are PROPLANE-.
  const upper = raw.toUpperCase();
  if (upper.startsWith("AXIS-") || upper.startsWith("PROPLANE-")) return raw;
  const suffix = raw.replace(/[^a-zA-Z0-9]/g, "").toUpperCase().slice(0, 12);
  return `PROPLANE-${suffix || Date.now().toString(36).toUpperCase()}`;
}
