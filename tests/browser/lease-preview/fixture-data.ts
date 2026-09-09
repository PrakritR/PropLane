// Synthetic lease only. No credentials, real records, or network are used by this fixture.
export const LEASE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body { margin: 0 auto; padding: 24px; max-width: 760px; font: 16px/1.7 Georgia,serif; color:#17181a; background:white; }
h1 { font-size:24px } h2 { font-size:20px; margin-top:32px } table { width:100% } td { padding:8px }
</style></head><body><h1>Residential lease regression fixture</h1>
<h2>1. Parties</h2><p>Example Manager and Example Resident — Example Property, Room 2.</p>
<h2>2. Rent, deposit and term</h2><p>Rent: $1,500.00. Deposit: $1,500.00. Term: September 15, 2026 to September 14, 2027.</p>
${Array.from({ length: 18 }, (_, i) => `<h2>${i + 3}. Lease section ${i + 3}</h2><p>${"Full lease terms remain readable and scrollable. ".repeat(12)}</p>`).join("")}
<h2>21. Disclosures</h2><p data-disclosure-rule="test-required">Required disclosure fixture remains locked.</p>
<h2>22. Signatures</h2><p id="lease-final-section">Final lease section — landlord and resident signatures.</p>
</body></html>`;
export const ROW = {
  id: "lease-preview-fixture",
  propertyId: "fixture-property",
  leaseKind: "individual",
  resident: "Example Resident",
  generatedHtml: LEASE,
};
export let savedHtml = LEASE;
export function saveHtml(html: string) {
  savedHtml = html;
}
