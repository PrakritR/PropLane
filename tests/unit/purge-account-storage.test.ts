import { describe, expect, it, vi } from "vitest";
import { purgeAccountStorageFolder } from "@/lib/auth/purge-account-storage";
import { assertAccountCleanupSucceeded } from "@/lib/auth/account-deletion-errors";
import { loadAccountCleanupRows } from "@/lib/auth/load-account-cleanup-rows";

describe("account file discovery", () => {
  it("collects rows beyond the PostgREST page boundary before deletion starts", async () => {
    const rows = Array.from({ length: 1105 }, (_, id) => ({ id }));
    const page = vi.fn(async (from: number, to: number) => ({ data: rows.slice(from, to + 1), error: null }));
    expect(await loadAccountCleanupRows(page)).toEqual(rows);
    expect(page).toHaveBeenCalledTimes(12);
  });

  it("rejects a failed later page rather than returning incomplete file references", async () => {
    const page = vi.fn()
      .mockResolvedValueOnce({ data: Array.from({ length: 100 }, (_, id) => ({ id })), error: null })
      .mockResolvedValueOnce({ data: null, error: { code: "57014", message: "timeout" } });
    await expect(loadAccountCleanupRows(page)).rejects.toThrow("timeout");
  });
});

describe("account deletion failures", () => {
  it("allows absent tables but rejects missing columns, access errors and timeouts", () => {
    for (const code of ["42P01", "PGRST205"]) {
      expect(() => assertAccountCleanupSucceeded({ code, message: "missing table" })).not.toThrow();
    }
    for (const code of ["42703", "PGRST204", "42501", "57014"]) {
      expect(() => assertAccountCleanupSucceeded({ code, message: "schema cache / query failed" })).toThrow();
    }
  });
});

describe("purgeAccountStorageFolder", () => {
  it("deletes every page and nested attachment, only within the owner's folder", async () => {
    const objects = new Set(Array.from({ length: 205 }, (_, i) => `owner/${String(i).padStart(3, "0")}.jpg`));
    objects.add("owner/nested/receipt.pdf");
    objects.add("another-owner/keep.jpg");
    const remove = vi.fn(async (paths: string[]) => {
      for (const path of paths) objects.delete(path);
      return { error: null };
    });
    const list = vi.fn(async (prefix: string, { offset, limit }: { offset: number; limit: number }) => {
      const entries = new Map<string, { name: string; id: string | null }>();
      for (const path of objects) {
        if (!path.startsWith(`${prefix}/`)) continue;
        const rest = path.slice(prefix.length + 1);
        const name = rest.split("/")[0];
        entries.set(name, { name, id: rest.includes("/") ? null : path });
      }
      return { data: [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(offset, offset + limit), error: null };
    });
    const db = { storage: { from: () => ({ list, remove }) } };
    await purgeAccountStorageFolder(db as never, "photos", "owner");
    expect([...objects]).toEqual(["another-owner/keep.jpg"]);
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("rejects failed listing or removal so the account delete can be retried", async () => {
    const remove = vi.fn(async () => ({ error: { message: "storage unavailable" } }));
    const list = vi.fn(async () => ({ data: [{ name: "file.pdf", id: "file" }], error: null }));
    const db = { storage: { from: () => ({ list, remove }) } };
    await expect(purgeAccountStorageFolder(db as never, "documents", "owner")).rejects.toThrow("storage unavailable");
    list.mockResolvedValueOnce({ data: null, error: { message: "list denied" } } as never);
    await expect(purgeAccountStorageFolder(db as never, "documents", "owner")).rejects.toThrow("list denied");
  });

  it.each(["", "../other", "owner/../other", "/", "owner/"])("refuses unsafe folder %s", async (folder) => {
    await expect(purgeAccountStorageFolder({} as never, "documents", folder)).rejects.toThrow("explicit owner folder");
  });
});
