/**
 * Live proof for the property import reader — runs the real model on a
 * fixture and prints what it understood. Dev only; needs ANTHROPIC_API_KEY in
 * .env.local. Never part of the test suite.
 *
 *   NODE_ENV=development node --conditions react-server --import tsx \
 *     scripts/testing/property-import-live-read.mts owner-messy.xlsx buildium-rent-roll.xlsx
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { readPropertyImportFile } from "@/lib/property-import/read-file.server";
import { understandPropertyImport } from "@/lib/property-import/understand.server";

const env = readFileSync(".env.local", "utf8");
for (const line of env.split("\n")) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
}
for (const f of process.argv.slice(2)) {
  const bytes = new Uint8Array(readFileSync(path.join("tests/fixtures/portfolio-import", f)));
  const source = await readPropertyImportFile({ bytes, fileName: f, mediaType: "" });
  const t0 = Date.now();
  const u = await understandPropertyImport({ source, actor: { userId: "live-proof" } });
  console.log(`\n## ${f} — ${u.properties.length} properties, ${u.properties.reduce((n, p) => n + p.rooms.length, 0)} rooms, ${u.rowsRead} rows, ${Date.now() - t0}ms`);
  for (const s of u.sheets) console.log(`  sheet ${s.name} [${s.used ? "used" : "skipped"}]: ${s.whatItIs}`);
  for (const p of u.properties) {
    const rooms = p.rooms.map((r) => `${r.label}:${r.rent ?? "-"}/${r.deposit ?? "-"}@r${r.sourceRow ?? "?"}`).join(", ");
    console.log(`  - ${p.name} · ${p.address}, ${p.city} ${p.state} ${p.zip} · ${p.propertyType} · ${p.rentByRoom ? "by room" : "whole"} · ${p.bedrooms}bd/${p.bathrooms ?? "?"}ba · rent ${p.monthlyRent ?? "-"} · rooms ${rooms} · ${p.sourceSheet} rows ${p.sourceRows.join(",")} · ${p.confidence}${p.needsLook.length ? ` · LOOK: ${p.needsLook.join("; ")}` : ""}`);
  }
  for (const s of u.summary) console.log(`  * ${s}`);
}
