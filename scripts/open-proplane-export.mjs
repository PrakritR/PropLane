#!/usr/bin/env node
/**
 * Open a PropLane data export (`proplane-export-<date>.proplane`) with its password.
 *
 * Node only, no dependencies, so a manager who has left the product — or anyone they hand the
 * file to — can open it with nothing but this script. The container is AES-256-GCM under an
 * scrypt-derived key; the layout is documented in `src/lib/account-export/export-crypto.ts`,
 * which this file mirrors byte for byte. A version bump there needs a matching branch here.
 *
 * Usage:
 *   node scripts/open-proplane-export.mjs <file.proplane> [--out <path>] [--extract <dir>]
 *
 * The password is read from PROPLANE_EXPORT_PASSWORD, or prompted for on the terminal
 * (never a command-line flag — a flag lands in shell history and `ps`).
 *
 *   --out <path>      where to write the decrypted zip (default: <file>.zip beside the input)
 *   --extract <dir>   also unpack manifest.json and tables/*.json into <dir>
 *
 * Exit 0 = opened. 1 = wrong password / not an export / altered file. 2 = usage error.
 */

import { createDecipheriv, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { inflateRawSync } from "node:zlib";

const MAGIC = Buffer.from("PLEXPORT", "ascii");
const VERSION = 1;
const HEADER_LENGTH = 40;
const TAG_LENGTH = 16;
const PREFIX_LENGTH = HEADER_LENGTH + TAG_LENGTH;
const KEY_LENGTH = 32;
const SCRYPT_MAXMEM = 128 * 1024 * 1024;

function usage(message) {
  if (message) console.error(message);
  console.error("Usage: node scripts/open-proplane-export.mjs <file.proplane> [--out <path>] [--extract <dir>]");
  process.exit(2);
}

function parseArgs(argv) {
  const args = { file: null, out: null, extract: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") args.out = argv[++i] ?? usage("--out needs a path.");
    else if (arg === "--extract") args.extract = argv[++i] ?? usage("--extract needs a directory.");
    else if (arg === "--help" || arg === "-h") usage();
    else if (arg.startsWith("--")) usage(`Unknown flag ${arg}.`);
    else if (!args.file) args.file = arg;
    else usage("Only one input file.");
  }
  if (!args.file) usage();
  return args;
}

async function readPassword() {
  const fromEnv = process.env.PROPLANE_EXPORT_PASSWORD;
  if (fromEnv) return fromEnv;
  if (!process.stdin.isTTY) usage("Set PROPLANE_EXPORT_PASSWORD when stdin is not a terminal.");
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const muted = { on: false };
  const write = rl._writeToOutput?.bind(rl);
  if (write) rl._writeToOutput = (text) => (muted.on ? undefined : write(text));
  return new Promise((done) => {
    rl.question("Export password: ", (answer) => {
      muted.on = false;
      process.stdout.write("\n");
      rl.close();
      done(answer);
    });
    muted.on = true;
  });
}

/** Mirror of `decryptExportPayload`. */
function decrypt(bytes, password) {
  if (bytes.length < PREFIX_LENGTH || !timingSafeEqual(bytes.subarray(0, MAGIC.length), MAGIC)) {
    throw new Error("Not a PropLane export file.");
  }
  const version = bytes.readUInt8(8);
  if (version !== VERSION) throw new Error(`Unsupported export version ${version}.`);
  const log2N = bytes.readUInt8(9);
  const r = bytes.readUInt8(10);
  const p = bytes.readUInt8(11);
  if (log2N < 10 || log2N > 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    throw new Error("Not a PropLane export file.");
  }
  const header = bytes.subarray(0, HEADER_LENGTH);
  const salt = bytes.subarray(12, 28);
  const iv = bytes.subarray(28, 40);
  const tag = bytes.subarray(HEADER_LENGTH, PREFIX_LENGTH);
  const ciphertext = bytes.subarray(PREFIX_LENGTH);
  const key = scryptSync(Buffer.from(password.normalize("NFKC"), "utf8"), salt, KEY_LENGTH, {
    N: 2 ** log2N,
    r,
    p,
    maxmem: SCRYPT_MAXMEM,
  });
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error("Wrong password, or the file has been altered.");
  } finally {
    key.fill(0);
  }
}

/**
 * Minimal zip reader — stored (0) and deflate (8) entries via the central directory, which
 * is all `fflate.zipSync` ever writes. Enough to unpack our own archive without a dependency.
 */
function unzip(zip) {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i -= 1) {
    if (zip.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Decrypted payload is not a zip archive.");
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < entryCount; n += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const localExtraLength = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = inflateRawSync(raw);
    else throw new Error(`Unsupported zip compression method ${method} for ${name}.`);
    entries.push({ name, data });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function safeJoin(root, name) {
  const target = resolve(root, name);
  if (target !== root && !target.startsWith(root + "/")) throw new Error(`Refusing to write outside ${root}: ${name}`);
  return target;
}

const args = parseArgs(process.argv.slice(2));
const input = resolve(args.file);
let file;
try {
  file = readFileSync(input);
} catch {
  usage(`Cannot read ${input}.`);
}

const password = await readPassword();
let zip;
try {
  zip = decrypt(file, password);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

const outPath = resolve(args.out ?? `${input}.zip`);
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, zip);
console.log(`Decrypted zip written to ${outPath} (${zip.length} bytes).`);

if (args.extract) {
  const root = resolve(args.extract);
  mkdirSync(root, { recursive: true });
  const entries = unzip(zip);
  for (const entry of entries) {
    const target = safeJoin(root, entry.name);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, entry.data);
  }
  console.log(`Extracted ${entries.length} file(s) into ${root}.`);
  const manifest = entries.find((entry) => entry.name === "manifest.json");
  if (manifest) {
    const parsed = JSON.parse(manifest.data.toString("utf8"));
    console.log(`Exported ${parsed.exportedAt}: ${parsed.rowCount} rows across ${parsed.tableCount} tables.`);
  }
}
