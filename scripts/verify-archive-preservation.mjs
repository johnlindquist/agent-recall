#!/usr/bin/env node
// Streaming proof that installation/sync preserved every pre-existing archive byte.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

process.umask(0o077);
const USAGE = `usage:
  verify-archive-preservation.mjs snapshot --root <absolute RECALL_HOME> --out <snapshot.json>
  verify-archive-preservation.mjs verify --root <absolute RECALL_HOME> --snapshot <snapshot.json>`;

function die(message) { throw new Error(String(message)); }

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const command = argv[0];
  if (!new Set(["snapshot", "verify"]).has(command)) die(USAGE);
  const out = { command };
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    if (!value || !new Set(["--root", "--out", "--snapshot"]).has(key)) die(USAGE);
    out[key.slice(2)] = value;
  }
  if (!out.root || !path.isAbsolute(out.root)) die("--root must be an absolute path");
  if (command === "snapshot" && !out.out) die("snapshot requires --out");
  if (command === "verify" && !out.snapshot) die("verify requires --snapshot");
  return out;
}

function canonicalFiles(root) {
  const archive = path.join(root, "archive");
  const files = [];
  let top;
  try { top = fs.readdirSync(archive, { withFileTypes: true }); }
  catch (error) { die(`cannot read archive: ${error.code || error.message}`); }
  const stack = top.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(archive, entry.name));
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) die(`symlink in canonical archive: ${path.relative(root, fp)}`);
      if (entry.isDirectory()) stack.push(fp);
      else if (entry.isFile()) files.push(fp);
    }
  }
  return files.sort();
}

function hashRange(fd, size) {
  const hash = crypto.createHash("sha256");
  const buf = Buffer.alloc(1024 * 1024);
  for (let pos = 0; pos < size; ) {
    const want = Math.min(buf.length, size - pos);
    const n = fs.readSync(fd, buf, 0, want, pos);
    if (n <= 0) die(`short read at ${pos}/${size}`);
    hash.update(buf.subarray(0, n));
    pos += n;
  }
  return hash.digest("hex");
}

function stableFingerprint(fp, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const fd = fs.openSync(fp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const before = fs.fstatSync(fd);
      if (!before.isFile()) die(`not a regular file: ${fp}`);
      const sha256 = hashRange(fd, before.size);
      const after = fs.fstatSync(fd);
      if (before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs)
        return { size: before.size, sha256 };
    } finally { fs.closeSync(fd); }
  }
  die(`file changed during snapshot after ${retries} attempts: ${fp}`);
}

function prefixFingerprint(fp, size) {
  const fd = fs.openSync(fp, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) die(`not a regular file: ${fp}`);
    if (stat.size < size) die(`file shrank: ${fp} (${stat.size} < ${size})`);
    return { size: stat.size, sha256: hashRange(fd, size) };
  } finally { fs.closeSync(fd); }
}

function loadManifest(root) {
  const fp = path.join(root, "state", "archive-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(fp, "utf8"));
  if (!manifest?.entries || typeof manifest.entries !== "object" || Array.isArray(manifest.entries))
    die("archive manifest entries are invalid");
  const entries = {};
  for (const [id, entry] of Object.entries(manifest.entries)) {
    if (!entry || typeof entry.rel !== "string" || !Array.isArray(entry.gens)) die(`invalid manifest entry: ${id}`);
    entries[id] = { rel: entry.rel, dirKey: entry.dirKey ?? null, gens: [...entry.gens] };
  }
  return entries;
}

function writeAtomic(fp, value) {
  const dir = path.dirname(path.resolve(fp));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = path.join(dir, `.${path.basename(fp)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    const body = Buffer.from(JSON.stringify(value));
    let offset = 0;
    while (offset < body.length) offset += fs.writeSync(fd, body, offset, body.length - offset);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, fp);
  fs.chmodSync(fp, 0o600);
}

function snapshot(args) {
  const files = {};
  let bytes = 0, logs = 0;
  for (const fp of canonicalFiles(args.root)) {
    const rel = path.relative(args.root, fp);
    const fingerprint = stableFingerprint(fp);
    files[rel] = fingerprint;
    bytes += fingerprint.size;
    if (fp.endsWith(".log")) logs++;
  }
  const manifestEntries = loadManifest(args.root);
  writeAtomic(args.out, { schemaVersion: 1, root: args.root, createdAt: new Date().toISOString(), files, manifestEntries });
  console.log(`ARCHIVE_SNAPSHOT_OK files=${Object.keys(files).length} bytes=${bytes} logs=${logs} manifestEntries=${Object.keys(manifestEntries).length}`);
}

function verify(args) {
  const saved = JSON.parse(fs.readFileSync(args.snapshot, "utf8"));
  if (saved?.schemaVersion !== 1 || !saved.files || !saved.manifestEntries) die("snapshot schema is invalid");
  let prefixBytes = 0, grown = 0;
  for (const [rel, before] of Object.entries(saved.files)) {
    const fp = path.join(args.root, rel);
    const after = prefixFingerprint(fp, before.size);
    if (after.sha256 !== before.sha256) die(`old prefix changed: ${rel}`);
    prefixBytes += before.size;
    if (after.size > before.size) grown++;
  }
  const currentManifest = loadManifest(args.root);
  for (const [id, before] of Object.entries(saved.manifestEntries)) {
    const after = currentManifest[id];
    if (!after) die(`manifest entry removed: ${id}`);
    if (after.rel !== before.rel || after.dirKey !== before.dirKey) die(`manifest identity changed: ${id}`);
    for (const gen of before.gens) if (!after.gens.includes(gen)) die(`manifest generation removed: ${id} ${gen}`);
  }
  const current = new Set(canonicalFiles(args.root).map((fp) => path.relative(args.root, fp)));
  const old = new Set(Object.keys(saved.files));
  const added = [...current].filter((rel) => !old.has(rel)).length;
  console.log(`ARCHIVE_PRESERVATION_PASS oldFiles=${old.size} oldPrefixBytes=${prefixBytes} grown=${grown} new=${added}`);
}

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(USAGE); process.exit(0); }
  if (args.command === "snapshot") snapshot(args); else verify(args);
} catch (error) {
  console.error(`ARCHIVE_PRESERVATION_FAIL: ${String(error?.message ?? error).slice(0, 400)}`);
  process.exit(1);
}
