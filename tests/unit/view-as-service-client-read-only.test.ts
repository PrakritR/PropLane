import { beforeEach, describe, expect, it, vi } from "vitest";
import { signViewAsToken, VIEW_AS_TTL_SECONDS } from "@/lib/auth/view-as-token";

const SECRET = "w".repeat(40);
const state = vi.hoisted(() => ({ cookieValue: undefined as string | undefined }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => (name === "axis_view_as" && state.cookieValue ? { value: state.cookieValue } : undefined),
  })),
}));

const { withViewAsReadOnly } = await import("@/lib/supabase/view-as-read-only");

/** A supabase-js shaped fake: chainable, awaitable builders; records what actually ran. */
function makeClient() {
  const ran: string[] = [];
  function builder(label: string) {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit", "match"]) b[m] = () => b;
    b.single = () => b;
    b.maybeSingle = () => b;
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      ran.push(label);
      return Promise.resolve({ data: [{ ok: true }], error: null }).then(resolve, reject);
    };
    return b;
  }
  const client = {
    from: (table: string) => ({
      select: () => builder(`select:${table}`),
      insert: () => builder(`insert:${table}`),
      update: () => builder(`update:${table}`),
      upsert: () => builder(`upsert:${table}`),
      delete: () => builder(`delete:${table}`),
    }),
    rpc: () => builder("rpc"),
    storage: {
      from: (bucket: string) => ({
        list: async () => {
          ran.push(`list:${bucket}`);
          return { data: [], error: null };
        },
        createSignedUrl: async () => {
          ran.push(`signed:${bucket}`);
          return { data: { signedUrl: "https://signed" }, error: null };
        },
        download: async () => {
          ran.push(`download:${bucket}`);
          return { data: new Blob(), error: null };
        },
        upload: async () => {
          ran.push(`upload:${bucket}`);
          return { data: {}, error: null };
        },
        remove: async () => {
          ran.push(`remove:${bucket}`);
          return { data: [], error: null };
        },
      }),
    },
  };
  return { client: withViewAsReadOnly(client as never) as typeof client, ran };
}

async function open() {
  const iat = Math.floor(Date.now() / 1000);
  state.cookieValue = await signViewAsToken(
    { v: 1, adminId: "a", targetId: "t", portal: "manager", iat, exp: iat + VIEW_AS_TTL_SECONDS, sid: "s" },
    SECRET,
  );
}

beforeEach(() => {
  process.env.PROPLANE_VIEW_AS_SECRET = SECRET;
  state.cookieValue = undefined;
});

describe("service-role client while a view-as session is open", () => {
  it("lets every write through when no session is open", async () => {
    const { client, ran } = makeClient();
    await client.from("t").insert({}).select();
    await client.from("t").update({}).eq("id", "1");
    await client.from("t").upsert({}).select().single();
    await client.from("t").delete().eq("id", "1");
    expect(ran).toEqual(["insert:t", "update:t", "upsert:t", "delete:t"]);
  });

  it("refuses insert / update / upsert / delete without running them, resolving a Supabase-shaped error", async () => {
    await open();
    const { client, ran } = makeClient();
    const results = await Promise.all([
      client.from("portal_service_request_records").insert({}).select(),
      client.from("portal_service_request_records").update({}).eq("id", "1"),
      client.from("portal_service_request_records").upsert({}).select().single(),
      client.from("portal_service_request_records").delete().eq("id", "1"),
    ]);
    expect(ran).toEqual([]);
    for (const result of results as Array<{ data: unknown; error: { message: string; code: string } }>) {
      expect(result.data).toBeNull();
      expect(result.error.message).toBe("read_only_view_as");
    }
  });

  it("leaves reads untouched", async () => {
    await open();
    const { client, ran } = makeClient();
    const { data } = await client.from("profiles").select().eq("id", "1").maybeSingle();
    expect(data).toEqual([{ ok: true }]);
    expect(ran).toEqual(["select:profiles"]);
  });

  it("still lets the session append to its own audit trail", async () => {
    await open();
    const { client, ran } = makeClient();
    await client.from("audit_log").insert({});
    expect(ran).toEqual(["insert:audit_log"]);
  });

  it("refuses storage writes and private-file access, but allows listing", async () => {
    await open();
    const { client, ran } = makeClient();
    const bucket = client.storage.from("documents");
    expect((await bucket.createSignedUrl()).error).toMatchObject({ message: "read_only_view_as" });
    expect((await bucket.download()).error).toMatchObject({ message: "read_only_view_as" });
    expect((await bucket.upload()).error).toMatchObject({ message: "read_only_view_as" });
    expect((await bucket.remove()).error).toMatchObject({ message: "read_only_view_as" });
    expect(ran).toEqual([]);
    expect((await bucket.list()).error).toBeNull();
    expect(ran).toEqual(["list:documents"]);
  });

  it("is a no-op for a tampered or expired cookie", async () => {
    state.cookieValue = "garbage";
    const { client, ran } = makeClient();
    await client.from("t").insert({});
    expect(ran).toEqual(["insert:t"]);
    const past = Math.floor(Date.now() / 1000) - 7200;
    state.cookieValue = await signViewAsToken(
      { v: 1, adminId: "a", targetId: "t", portal: "manager", iat: past, exp: past + VIEW_AS_TTL_SECONDS, sid: "s" },
      SECRET,
    );
    await client.from("t").delete();
    expect(ran).toEqual(["insert:t", "delete:t"]);
  });

  it("does not interfere with rpc (documented gap)", async () => {
    await open();
    const { client, ran } = makeClient();
    await client.rpc();
    expect(ran).toEqual(["rpc"]);
  });
});
