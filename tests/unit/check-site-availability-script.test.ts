// The read-only site availability check: a stub site serves a catalog and a snapshot that disagree on one room.
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const methods: string[] = [];

/** Async on purpose: the stub server lives in this process, so a blocking spawn would starve it. */
function runScript(args: string[]): Promise<{ status: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("node", ["scripts/check-site-availability.mjs", ...args], { encoding: "utf8" }, (error, stdout) => {
      resolve({ status: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout });
    });
  });
}
let server: ReturnType<typeof createServer>;
let base = "";

const catalog = {
  listings: [
    {
      id: "p4709", title: "4709A 8th Ave",
      listingSubmission: { rooms: [
        { id: "r6", name: "Room 6", availability: "Unavailable (occupied)", occupancyCapacity: 1 }, // snapshot says free: mismatch
        { id: "r7", name: "Room 7", availability: "Available now", occupancyCapacity: 1 },          // snapshot says free: fine
        { id: "r8", name: "Room 8", availability: "Available now", occupancyCapacity: 1 },          // snapshot says occupied: mismatch
        { id: "r9", name: "Room 9", availability: "Leased until Aug 31, 2027", occupancyCapacity: 1 }, // the live label of a held room: agrees
        { id: "r10", name: "Room 10", availability: "Available Nov 6", occupancyCapacity: 1 },        // says "not free today" but the room is vacant: mismatch
      ] },
    },
  ],
};
const snapshot = {
  rooms: [
    { roomChoice: "p4709::r6", spans: [{ start: "2020-01-01", end: "2020-12-31", count: 1 }] },
    { roomChoice: "p4709::r7", spans: [] },
    { roomChoice: "p4709::r8", spans: [{ start: "2020-01-01", end: null, count: 1 }] },
    { roomChoice: "p4709::r9", spans: [{ start: "2020-01-01", end: "2999-08-31", count: 1 }] },
    { roomChoice: "p4709::r10", spans: [] },
  ],
};

beforeAll(async () => {
  server = createServer((req, res) => {
    methods.push(req.method ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/api/property-records/public") return void res.end(JSON.stringify(catalog));
    if (req.url === "/api/public/approved-room-occupancy") return void res.end(JSON.stringify(snapshot));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("scripts/check-site-availability.mjs", () => {
  it("prints every mismatch, exits 1, and only ever reads (GET)", async () => {
    const run = await runScript([base, "--json"]);
    expect(run.status).toBe(1);
    const out = JSON.parse(run.stdout) as { rooms: number; mismatches: { room: string }[] };
    expect(out.rooms).toBe(5);
    expect(out.mismatches.map((m) => m.room).sort()).toEqual(["Room 10", "Room 6", "Room 8"]);
    expect(new Set(methods)).toEqual(new Set(["GET"]));
  });

  it("exits 2 when the site cannot be read", async () => {
    const run = await runScript(["http://127.0.0.1:1"]);
    expect(run.status).toBe(2);
  });
});
