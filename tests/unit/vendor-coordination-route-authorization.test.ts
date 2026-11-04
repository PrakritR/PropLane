import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ user: { id: "manager-1", email: "manager@example.test" } as {id:string;email:string}|null, role: "manager", denied: false, ownerRefusal: false, residentAllowed: true, apply: vi.fn(), list: vi.fn(), vendors: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));
vi.mock("@/lib/auth/portal-access", () => ({ getPortalAccessContext: async () => ({ user: h.user, effectiveRole: h.role, profile: { role: h.role } }) }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => ({ kind: h.denied ? "denied" : "live" }) }));
vi.mock("@/lib/property-owner/route-auth.server", () => ({ refuseOwnerOnly: async () => h.ownerRefusal ? new Response(null, {status:403}) : null }));
vi.mock("@/lib/auth/resident-role-access", () => ({ authorizeResidentRole: async () => h.residentAllowed }));
vi.mock("@/lib/vendor-coordination.server", () => ({ applyCoordinationAction: h.apply, listCoordination: h.list, coordinationVendorChoices: h.vendors }));
import { GET, POST } from "@/app/api/portal/vendor-coordination/route";
beforeEach(() => { h.user={id:"manager-1",email:"manager@example.test"};h.role="manager";h.denied=false;h.ownerRefusal=false;h.residentAllowed=true;h.apply.mockReset().mockResolvedValue({id:"proposal-1"});h.list.mockReset().mockResolvedValue([]);h.vendors.mockReset().mockResolvedValue([]); });
describe("coordination route actor authority", () => {
  it.each(["unauthenticated", "business denied", "owner seam denied", "invalid role", "resident role denied"])("refuses %s before reading or applying service state", async (kind) => {
    if(kind==="unauthenticated")h.user=null;
    if(kind==="business denied")h.denied=true;
    if(kind==="owner seam denied")h.ownerRefusal=true;
    if(kind==="invalid role")h.role="owner";
    if(kind==="resident role denied"){h.role="resident";h.residentAllowed=false;}
    const response=await GET(new Request("https://example.test/api/portal/vendor-coordination?workOrderId=service-1"));
    expect(response.status).toBe(kind==="unauthenticated"?401:403);expect(h.list).not.toHaveBeenCalled();expect(h.vendors).not.toHaveBeenCalled();expect(h.apply).not.toHaveBeenCalled();
  });
  it("derives enrollment manager and actor from the authenticated account", async () => {
    const response=await POST(new Request("https://example.test/api/portal/vendor-coordination",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({kind:"enroll",work_order_id:"service-1",vendor_directory_id:"vendor-1",visit_type:"repair",manager_user_id:"forged-manager",actor_user_id:"forged-actor"})}));
    expect(response.status).toBe(200);expect(h.apply).toHaveBeenCalledWith({},expect.objectContaining({role:"manager",userId:"manager-1"}),expect.objectContaining({manager_user_id:"manager-1",actor_user_id:"manager-1"}));
  });
});
