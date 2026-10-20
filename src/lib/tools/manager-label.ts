/**
 * The manager as a resident or vendor sees them in a text preview: a name, never a login email
 * (a profile with no name falls back to its email, which must not reach the other party).
 */
export function managerLabelForPreview(name: string): string {
  return name.includes("@") ? "your property manager" : name;
}
