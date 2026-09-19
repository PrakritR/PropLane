import { beforeEach, describe, expect, it, vi } from "vitest";

const authUser = vi.hoisted(() => vi.fn());
const businessAccess = vi.hoisted(() => vi.fn());
const serviceDb = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: () => ({ auth: { getUser: authUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: businessAccess,
}));

import { DELETE, GET, POST } from "@/app/api/listing-photos/route";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function storageDb() {
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  return {
    upload,
    remove,
    db: {
      storage: {
        from: vi.fn(() => ({
          upload,
          remove,
          getPublicUrl: (path: string) => ({ data: { publicUrl: `https://example.test/storage/v1/object/public/listing-photos/${path}` } }),
        })),
      },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  authUser.mockResolvedValue({ data: { user: { id: ACTOR } } });
});

describe("classified listing-media server boundary", () => {
  it("announces server upload only from the server-derived active namespace", async () => {
    const { db } = storageDb();
    serviceDb.mockReturnValue(db);
    businessAccess.mockResolvedValue({ kind: "test", workspaceId: WORKSPACE });
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ serverUpload: true });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("writes classified media into the authenticated private namespace", async () => {
    const { db, upload } = storageDb();
    serviceDb.mockReturnValue(db);
    businessAccess.mockResolvedValue({ kind: "test", workspaceId: WORKSPACE });
    const response = await POST(new Request("https://prop-lane.test/api/listing-photos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/jpeg;base64,aGVsbG8=" }),
    }));
    expect(response.status).toBe(200);
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^test-workspaces/${WORKSPACE}/${ACTOR}/`)),
      expect.any(Buffer),
      expect.objectContaining({ upsert: false }),
    );
  });

  it("refuses cross-namespace cleanup and allows only its own paths", async () => {
    const { db, remove } = storageDb();
    serviceDb.mockReturnValue(db);
    businessAccess.mockResolvedValue({ kind: "test", workspaceId: WORKSPACE });
    const foreign = await DELETE(new Request("https://prop-lane.test/api/listing-photos", {
      method: "DELETE",
      body: JSON.stringify({ paths: [`test-workspaces/${WORKSPACE}/other/photo.jpg`] }),
    }));
    expect(foreign.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();

    const ownPath = `test-workspaces/${WORKSPACE}/${ACTOR}/photo.jpg`;
    const own = await DELETE(new Request("https://prop-lane.test/api/listing-photos", {
      method: "DELETE",
      body: JSON.stringify({ paths: [ownPath] }),
    }));
    expect(own.status).toBe(200);
    expect(remove).toHaveBeenCalledWith([ownPath]);
  });

  it.each(["suspended", "expired", "flag-off"]) ("denies %s identities before media writes", async (state) => {
    const { db, upload } = storageDb();
    serviceDb.mockReturnValue(db);
    businessAccess.mockResolvedValue({ kind: "denied", state });
    const response = await POST(new Request("https://prop-lane.test/api/listing-photos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dataUrl: "data:image/jpeg;base64,aGVsbG8=" }),
    }));
    expect(response.status).toBe(403);
    expect(upload).not.toHaveBeenCalled();
  });
});
