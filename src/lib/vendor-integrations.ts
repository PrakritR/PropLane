/** Providers a vendor can ask to be notified about. Client-safe; the API allowlists against this. */
export const VENDOR_INTEGRATION_PROVIDERS = [
  { id: "jobber", label: "Jobber" },
  { id: "housecall_pro", label: "Housecall Pro" },
  { id: "thumbtack", label: "Thumbtack" },
] as const;

export type VendorIntegrationProvider = (typeof VENDOR_INTEGRATION_PROVIDERS)[number]["id"];

export function isVendorIntegrationProvider(value: unknown): value is VendorIntegrationProvider {
  return VENDOR_INTEGRATION_PROVIDERS.some((p) => p.id === value);
}
