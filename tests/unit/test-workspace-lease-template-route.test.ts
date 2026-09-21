import { beforeEach, describe, expect, it, vi } from "vitest";

const { getReportsAuthContext, storageDownload, dbFrom } = vi.hoisted(() => ({
  getReportsAuthContext: vi.fn(),
  storageDownload: vi.fn(),
  dbFrom: vi.fn(),
}));

vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext }));

import { GET } from "@/app/api/portal/lease-template/route";

const USER = "10000000-0000-4000-8000-000000000001";
const path = `${USER}/template.pdf`;

function request() {
  return new Request(`http://localhost/api/portal/lease-template?path=${encodeURIComponent(path)}`);
}

describe("lease-template GET business-access gate", () => {
  beforeEach(() => {
    getReportsAuthContext.mockReset();
    storageDownload.mockReset();
    dbFrom.mockReset();
  });

  it("returns the non-oracle 404 before relationship or storage reads when durable access is revoked", async () => {
    getReportsAuthContext.mockResolvedValue(null);

    const response = await GET(request());

    expect(response.status).toBe(404);
    expect(dbFrom).not.toHaveBeenCalled();
    expect(storageDownload).not.toHaveBeenCalled();
  });

  it("still streams a legitimate folder owner's PDF", async () => {
    storageDownload.mockResolvedValue({
      data: new Blob([new Uint8Array([0x25, 0x50, 0x44, 0x46])], { type: "application/pdf" }),
      error: null,
    });
    const db = {
      from: dbFrom,
      storage: { from: vi.fn(() => ({ download: storageDownload })) },
    };
    getReportsAuthContext.mockResolvedValue({ role: "manager", userId: USER, email: "owner@example.com", db });

    const response = await GET(request());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(storageDownload).toHaveBeenCalledWith(path);
    expect(dbFrom).not.toHaveBeenCalled();
  });
});
