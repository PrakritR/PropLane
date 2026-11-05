/** Secret-free decisions shared by browser observations and offline refusal tests. */
export function assertVerifiedSignupControl(control: { isInput: boolean; readOnly: boolean; value: string }, email: string): void {
  if (!control.isInput || !control.readOnly || control.value !== email) throw new Error("Verified email control did not match the synthetic mailbox.");
}

export function residentApplicationDestination(gateUrl: string, origin: string, propertyId: string): string {
  const gate = new URL(gateUrl);
  const next = gate.searchParams.get("next");
  if (gate.origin !== origin || gate.pathname !== "/auth/verify-phone" || !next?.startsWith("/resident/applications/apply?")) throw new Error("Resident signup did not preserve its application destination.");
  const destination = new URL(next, origin);
  if (destination.origin !== origin || destination.pathname !== "/resident/applications/apply" || destination.searchParams.getAll("propertyId").length !== 1 || destination.searchParams.get("propertyId") !== propertyId) throw new Error("Resident signup changed the listing identity.");
  return destination.pathname + destination.search;
}
