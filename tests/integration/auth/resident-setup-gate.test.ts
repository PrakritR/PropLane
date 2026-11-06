vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
import { describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";
import { POST as residentRegister } from "@/app/api/auth/resident-register/route";
import { POST as registerResident } from "@/app/api/auth/register-resident/route";
import { POST as residentSetup } from "@/app/api/auth/resident-setup/route";

describe("resident account creation gates", () => {
  it("requires a verified session before resident provisioning", async () => {
    const req = jsonRequest("http://localhost/api/auth/resident-register", { method: "POST", body: { email: "new@example.com", phone: "2065550100" } });
    const res = await residentRegister(req);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("EMAIL_VERIFICATION_REQUIRED");
  });

  it("rejects legacy POST /api/auth/register-resident", async () => {
    const res = await registerResident();
    expect(res.status).toBe(403);
    const { data } = await parseJsonResponse<{ error?: string }>(res);
    expect(String(data.error ?? "").toLowerCase()).toContain("setup link");
  });

  it("rejects POST /api/auth/resident-setup without a token", async () => {
    const req = jsonRequest("http://localhost/api/auth/resident-setup", {
      method: "POST",
      body: {
        email: "a@b.com",
        password: "password123",
        axisId: "AXIS-1",
      },
    });
    const res = await residentSetup(req);
    expect(res.status).toBe(403);
    const { data } = await parseJsonResponse<{ error?: string }>(res);
    expect(String(data.error ?? "").toLowerCase()).toContain("setup link");
  });
});
