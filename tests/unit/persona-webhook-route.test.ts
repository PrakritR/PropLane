import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({ rpc }) }));
import { POST } from "@/app/api/webhooks/persona/route";
const saved = { ...process.env };
afterEach(() => { process.env = { ...saved }; rpc.mockReset(); vi.unstubAllGlobals(); });

describe("Persona webhook", () => {
  it("does not write until a signature is verified and passes only minimal fields", async () => {
    process.env.RESIDENT_IDENTITY_ENABLED = "true";
    process.env.PERSONA_API_KEY = "key";
    process.env.PERSONA_TEMPLATE_ID = "template";
    process.env.PERSONA_WEBHOOK_SECRET = "secret";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const body = JSON.stringify({ data: { id: "evt_1", attributes: { name: "inquiry.approved", "created-at": "2026-10-29T00:00:00Z", payload: { data: { id: "inq_1", type: "inquiry", attributes: { "reference-id": "12345678-1234-1234-1234-123456789012", fields: { ssn: "sensitive" } } } } } } });
    const invalid = await POST(new Request("http://localhost", { method: "POST", body, headers: { "persona-signature": `t=${timestamp},v1=bad` } }));
    expect(invalid.status).toBe(401);
    expect(rpc).not.toHaveBeenCalled();
    const signature = createHmac("sha256", "secret").update(`${timestamp}.${body}`).digest("hex");
    const provider = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: { id: "inq_1", attributes: { "reference-id": "12345678-1234-1234-1234-123456789012", status: "completed" } } }) });
    vi.stubGlobal("fetch", provider);
    const pending = await POST(new Request("http://localhost", { method: "POST", body, headers: { "persona-signature": `t=${timestamp},v1=${signature}` } }));
    expect(pending.status).toBe(503);
    expect(rpc).not.toHaveBeenCalled();
    provider.mockResolvedValue({ ok: true, json: async () => ({ data: { id: "inq_1", attributes: { "reference-id": "12345678-1234-1234-1234-123456789012", status: "approved" } } }) });
    rpc.mockResolvedValue({ data: "applied", error: null });
    const response = await POST(new Request("http://localhost", { method: "POST", body, headers: { "persona-signature": `t=${timestamp},v1=${signature}` } }));
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith("apply_resident_identity_event", { p_event_id: "evt_1", p_inquiry_id: "inq_1", p_reference_id: "12345678-1234-1234-1234-123456789012", p_event_type: "inquiry.approved", p_created_at: "2026-10-29T00:00:00Z" });
  });
});
