/** A new fragment must initialize a fresh quote document, even on the same route. */
export function reloadVendorQuoteDocument(): void {
  window.location.reload();
}
