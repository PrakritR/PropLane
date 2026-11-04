import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://example.test" }));
vi.mock("@/lib/co-manager-notification-recipients.server", () => ({ resolvePropertyScopedManagerRecipientIds: vi.fn() }));
vi.mock("@/lib/service-automation-settings.server", () => ({ resolveServiceAutomationSettingsForRow: vi.fn() }));
vi.mock("@/lib/settings/scope-resolver.server", () => ({ createSettingsScopeCache: () => ({}) }));
vi.mock("@/lib/work-order-events.server", () => ({ workOrderEvent: vi.fn() }));
import { expireVendorOffers } from "@/lib/work-order-offer-expiry.server";
const offer = { id: "offer-1", work_order_id: "service-1", manager_user_id: "manager-1", vendor_directory_id: "vendor-1", vendor_user_id: null, expires_at: "2026-10-15T12:00:00Z" };
const now = new Date("2026-10-16T12:00:00Z");
function fixture() {
 const rpc = vi.fn().mockResolvedValue({ data: [offer], error: null });
 const db = { rpc, from(table: string) {
  const result = { data: table === "work_order_vendor_offers" ? [offer] : [], error: null };
  const query: Record<string, unknown> = {};
  for(const method of ["select","eq","not","lte","limit","in"]) query[method]=()=>query;
  query.then=(resolve: (value: unknown)=>unknown)=>Promise.resolve(result).then(resolve);
  return query;
 } };
 return {db,rpc};
}
describe("offer expiry uses serialized lifecycle", () => {
 beforeEach(()=>vi.clearAllMocks());
 it("claims a due offer through the service boundary RPC",async () => {
  const {db,rpc}=fixture();
  expect(await expireVendorOffers(db as never,now)).toEqual({expired:1,managersTold:0});
  expect(rpc).toHaveBeenCalledExactlyOnceWith("invalidate_vendor_service_offers",{p_work_order_id:"service-1",p_manager_user_id:"manager-1",p_status:"expired",p_offer_id:"offer-1",p_now:now.toISOString()});
 });
 it("does not count or notify an offer another worker already invalidated",async () => {
  const {db,rpc}=fixture();rpc.mockResolvedValue({data:[],error:null});
  expect(await expireVendorOffers(db as never,now)).toEqual({expired:0,managersTold:0});
 });
 it("fails closed when the serialized transition is unavailable",async () => {
  const {db,rpc}=fixture();rpc.mockResolvedValue({data:null,error:{message:"migration unavailable"}});
  await expect(expireVendorOffers(db as never,now)).rejects.toMatchObject({message:"migration unavailable"});
 });
});
