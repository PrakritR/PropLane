import { describe, expect, it } from "vitest";

import { buildStoreZip, crc32, safeZipEntryName } from "@/lib/zip-store";

describe("zip-store", () => {
  it("computes the standard CRC-32", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("writes a readable STORE archive", () => {
    const a = new TextEncoder().encode("hello");
    const b = new Uint8Array([1, 2, 3, 4]);
    const zip = buildStoreZip([{ name: "a.txt", data: a }, { name: "b.bin", data: b }]);
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    expect(view.getUint32(0, true)).toBe(0x04034b50);
    expect(view.getUint32(zip.length - 22, true)).toBe(0x06054b50);
    expect(view.getUint16(zip.length - 22 + 10, true)).toBe(2);
    const centralStart = view.getUint32(zip.length - 22 + 16, true);
    expect(view.getUint32(centralStart, true)).toBe(0x02014b50);
    // first entry data sits right after its header + name
    expect(new TextDecoder().decode(zip.slice(30 + 5, 30 + 5 + 5))).toBe("hello");
    expect(view.getUint32(14, true)).toBe(crc32(a));
  });

  it("flattens entry names", () => {
    expect(safeZipEntryName("../../etc/passwd")).toBe("passwd");
    expect(safeZipEntryName("a\\b\\c.jpg")).toBe("c.jpg");
    expect(safeZipEntryName("")).toBe("file");
  });
});
