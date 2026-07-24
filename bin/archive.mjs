#!/usr/bin/env node
// agent-recall archiver: append-preserving copy of agent transcripts.
// One-shot, bounded, crash-consistent; no deletion ever propagates from
// source to archive. Protocol (validation findings A1-A15, A17-A18):
//   - fail-closed manifest load with schema validation; a damaged manifest is
//     never auto-replaced (repair is a deliberate separate operation)
//   - generation names derive from disk; publication is no-clobber
//     (linkSync + dir fsync); orphan generations are adopted on recovery
//   - appends are copy-on-write: clone gen -> append -> fsync -> verify
//     against the open source fd -> rename -> dir fsync; a state/archive-dirty
//     marker gates full reconciliation on the next run
//   - candidates live in archive/.tmp (outside the generation namespace),
//     are removed in finally, and quarantined to archive/.quarantine on recovery
// Manifest: schemaVersion 2. v1 manifests (entries {rel,gens,size,mtimeMs,
// ino,tail}) are read as-is and migrated on first save (adds ctimeMs, dirKey,
// archiveBytes, cursor, outcome as they become known).
// Exit codes: 0 ok/incomplete, 1 error, 75 (EX_TEMPFAIL) another archiver live.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
process.umask(0o077); // every file this process creates is user-only (A11)

const HOME = os.homedir();
const ROOT = process.env.RECALL_HOME || path.join(HOME, "Library/Application Support/AgentRecall");
const ARCHIVE = path.join(ROOT, "archive");
const STATE = path.join(ROOT, "state");
const LOGS = path.join(ROOT, "logs");
const MANIFEST = path.join(STATE, "archive-manifest.json");
const LOCK = path.join(STATE, "archive.lock");
const DIRTY = path.join(STATE, "archive-dirty");
const TMP = path.join(ARCHIVE, ".tmp");
const QUAR = path.join(ARCHIVE, ".quarantine");
const GEN_RE = /^g(\d{4,})\.(jsonl|ndjson|json|log|txt)$/;
const STALE_GRACE_MS = 10 * 60 * 1000; // lock with unreadable owner file
const EXIT_BUSY = 75;

function envNum(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`invalid ${name}: ${JSON.stringify(raw)} (need finite positive number)`);
  return n;
}
const MAX_SECONDS = envNum("RECALL_MAX_SECONDS", 90);
const MAX_FILE = envNum("RECALL_MAX_FILE", 1024 * 1024 * 1024);
const MAX_FILES = envNum("RECALL_MAX_FILES", 20000); // caps MUTATIONS per run, not observations
const MAX_ARCHIVE = envNum("RECALL_MAX_ARCHIVE", 50 * 1024 * 1024 * 1024);
const EXT = new Set([".jsonl", ".ndjson", ".json", ".log"]);

const SOURCES = process.env.RECALL_ONLY_SELFTEST
  ? [["selftest", process.env.RECALL_SELFTEST_SOURCE]]
  : [
      ["claude-primary", path.join(HOME, ".claude/projects")],
      ["claude-second", path.join(HOME, ".claude-second/projects")],
      ["codex-active", path.join(HOME, ".codex/sessions")],
      ["codex-archived", path.join(HOME, ".codex/archived_sessions")],
      ["grok", path.join(HOME, ".grok/sessions")],
      ["kimi-code", path.join(HOME, ".kimi-code/sessions")],
      ["kimi-legacy", path.join(HOME, ".kimi/sessions")],
      ["pi", path.join(HOME, ".pi/agent/sessions")],
    ];
const t0 = Date.now();
const deadline = () => (Date.now() - t0) / 1000 > MAX_SECONDS;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const rand = (n = 6) => crypto.randomBytes(n).toString("hex");
const die = (msg, code) => { const e = new Error(msg); if (code) e.code = code; throw e; };
const crashAt = (label) => { if (process.env.RECALL_TEST_CRASH_AT === label) process.exit(99); };
const seqOf = (name) => Number(GEN_RE.exec(name)[1]);

function log(line) {
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  const f = path.join(LOGS, "sync.log");
  try { if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + ".1"); } catch {}
  fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

// ---- exact I/O helpers (A5, A10) ----
function readExact(fd, buf, off, len, pos) {
  for (let got = 0; got < len; ) {
    const n = fs.readSync(fd, buf, off + got, len - got, pos + got);
    if (n <= 0) die(`short read at offset ${pos + got}`);
    got += n;
  }
}
function writeAll(fd, buf, off, len, pos) {
  for (let put = 0; put < len; ) {
    const n = fs.writeSync(fd, buf, off + put, len - put, pos === null ? null : pos + put);
    if (n <= 0) die("short write");
    put += n;
  }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function copyRange(fromFd, toFd, len, fromPos = 0, toPos = 0) {
  const buf = Buffer.alloc(Math.min(len, 8 * 1024 * 1024) || 1);
  for (let done = 0; done < len; ) {
    const n = Math.min(buf.length, len - done);
    readExact(fromFd, buf, 0, n, fromPos + done);
    writeAll(toFd, buf, 0, n, toPos + done);
    done += n;
  }
}
function tailHash(fd, size) {
  const n = Math.min(size, 4096);
  const buf = Buffer.alloc(n);
  if (n > 0) readExact(fd, buf, 0, n, size - n);
  return sha(buf);
}
// Full byte-range comparison; the only valid append acceptance proof (A4).
function sameRange(fdA, fdB, len) {
  const CH = 1024 * 1024;
  const a = Buffer.alloc(Math.min(CH, Math.max(len, 1)));
  const b = Buffer.alloc(a.length);
  for (let pos = 0; pos < len; ) {
    if (deadline()) die("deadline during compare", "EDEADLINE");
    const n = Math.min(CH, len - pos);
    readExact(fdA, a, 0, n, pos);
    readExact(fdB, b, 0, n, pos);
    if (a.compare(b, 0, n, 0, n) !== 0) return false;
    pos += n;
  }
  return true;
}
// Single-open source: realpath containment, O_NOFOLLOW, fstat, swap check (A5, A14).
function openContainedSource(rootReal, p) {
  const real = fs.realpathSync(p);
  if (real !== rootReal && !real.startsWith(rootReal + path.sep)) die(`source escapes root: ${p}`, "EESCAPE");
  const fd = fs.openSync(p, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) die(`not a regular file: ${p}`, "ENOTFILE");
    const rst = fs.statSync(real);
    if (rst.dev !== st.dev || rst.ino !== st.ino) die(`source swapped during open: ${p}`, "ESWAP");
    return { fd, st };
  } catch (err) { fs.closeSync(fd); throw err; }
}

// ---- manifest (A1, A10) ----
function archiveHasGenerations() {
  const stack = [ARCHIVE];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
    for (const en of ents) {
      if (en.name.startsWith(".")) continue;
      if (en.isDirectory()) stack.push(path.join(d, en.name));
      else if (en.isFile() && GEN_RE.test(en.name)) return true;
    }
  }
  return false;
}
function loadManifest() {
  let raw;
  try { raw = fs.readFileSync(MANIFEST, "utf8"); } catch (err) {
    if (err.code !== "ENOENT") throw err;
    if (archiveHasGenerations()) die("manifest missing but archive has committed generations; refusing to run (manifest repair required)");
    return { schemaVersion: 2, entries: {}, runs: [] };
  }
  let m;
  try { m = JSON.parse(raw); } catch { die("manifest is not valid JSON; refusing to run (manifest repair required, file left in place)"); }
  if (!m || typeof m !== "object" || Array.isArray(m)) die("manifest root is not an object");
  if (!m.entries || typeof m.entries !== "object" || Array.isArray(m.entries)) die("manifest entries invalid");
  if (m.runs !== undefined && !Array.isArray(m.runs)) die("manifest runs invalid");
  for (const [id, e] of Object.entries(m.entries)) {
    if (!e || typeof e !== "object" || Array.isArray(e) || typeof e.rel !== "string" || !Array.isArray(e.gens)) die(`manifest entry invalid: ${id}`);
    if (typeof e.size !== "number" || !Number.isFinite(e.size) || e.size < 0) die(`manifest entry size invalid: ${id}`);
    for (const g of e.gens) if (typeof g !== "string" || !GEN_RE.test(g)) die(`unsafe generation name in manifest: ${id} ${JSON.stringify(g)}`);
  }
  m.schemaVersion = 2; // v1 read as-is; migrated on first save
  if (!Array.isArray(m.runs)) m.runs = [];
  return m;
}
function saveManifest(m) {
  const tmp = `${MANIFEST}.${process.pid}.${rand(4)}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try {
    const b = Buffer.from(JSON.stringify(m));
    writeAll(fd, b, 0, b.length, null);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, MANIFEST);
  fsyncDir(STATE);
}

// ---- owner-token lock (A6, A7) ----
function acquireLock() {
  const token = rand(16);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      fs.mkdirSync(LOCK, { mode: 0o700 });
      const fd = fs.openSync(path.join(LOCK, "owner.json"), "wx", 0o600);
      try {
        const b = Buffer.from(JSON.stringify({ pid: process.pid, token, startedAt: Date.now() }));
        writeAll(fd, b, 0, b.length, null);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fsyncDir(LOCK);
      return token;
    } catch (err) { if (err.code !== "EEXIST") throw err; }
    let owner = null;
    try { owner = JSON.parse(fs.readFileSync(path.join(LOCK, "owner.json"), "utf8")); } catch {}
    if (owner && Number.isInteger(owner.pid)) {
      let live = true;
      try { process.kill(owner.pid, 0); } catch (err) { live = err.code === "EPERM"; }
      if (live) return null; // holder is alive (or unverifiable): busy
      // dead holder: atomic rename-to-stale takeover (two takers can't both win)
    } else {
      // owner file unreadable (crash between mkdir and write): mtime + grace
      let st = null;
      try { st = fs.statSync(LOCK); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
      if (Date.now() - st.mtimeMs < STALE_GRACE_MS) return null;
    }
    const stale = `${LOCK}.stale-${process.pid}-${rand(4)}`;
    try { fs.renameSync(LOCK, stale); } catch (err) { if (err.code === "ENOENT") continue; throw err; }
    fs.rmSync(stale, { recursive: true, force: true });
  }
  return null;
}
function releaseLock(token) {
  try {
    const owner = JSON.parse(fs.readFileSync(path.join(LOCK, "owner.json"), "utf8"));
    if (owner.token !== token) return; // not ours anymore
    const tomb = `${LOCK}.released-${process.pid}-${rand(4)}`;
    fs.renameSync(LOCK, tomb);
    fs.rmSync(tomb, { recursive: true, force: true });
  } catch {}
}

// ---- quarantine + generation reconciliation (A2, A3, A9) ----
function quarantine(p, counts) {
  fs.mkdirSync(QUAR, { recursive: true, mode: 0o700 });
  fs.renameSync(p, path.join(QUAR, `${Date.now()}-${rand(4)}-${path.basename(p)}`));
  counts.quarantined++;
  log(`quarantined ${p}`);
}
// List committed generations; anything else (e.g. legacy *.partial) is quarantined.
function gensOnDisk(dir, counts) {
  let ents;
  try { ents = fs.readdirSync(dir); } catch (err) { if (err.code === "ENOENT") return []; throw err; }
  const gens = [];
  for (const n of ents) {
    if (GEN_RE.test(n)) gens.push(n);
    else if (n !== "relpath.txt" && !n.startsWith(".")) quarantine(path.join(dir, n), counts);
  }
  gens.sort((a, b) => seqOf(a) - seqOf(b));
  return gens;
}
// Adopt orphan on-disk generations; recover size/tail from the committed newest
// generation and invalidate the stat fast path so the source is re-verified.
function recoverEntryFromDisk(dir, e, counts) {
  const names = gensOnDisk(dir, counts);
  let pruned = false;
  for (const g of e.gens) {
    if (!names.includes(g)) { counts.recoveryErrors++; pruned = true; log(`recovery: manifest generation missing on disk ${path.join(dir, g)}`); }
  }
  if (pruned) e.gens = e.gens.filter((g) => names.includes(g));
  let adopted = false;
  for (const g of names) if (!e.gens.includes(g)) { e.gens.push(g); adopted = true; }
  e.gens.sort((a, b) => seqOf(a) - seqOf(b));
  if (!names.length) { if (pruned) { e.size = 0; e.tail = ""; e.mtimeMs = 0; e.ctimeMs = 0; } return; }
  const newest = path.join(dir, names[names.length - 1]);
  const nst = fs.statSync(newest);
  if (adopted || pruned || nst.size !== e.size) {
    const fd = fs.openSync(newest, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { e.size = fs.fstatSync(fd).size; e.tail = tailHash(fd, e.size); } finally { fs.closeSync(fd); }
    e.mtimeMs = 0; e.ctimeMs = 0; // force full re-verify against source
  }
}
function fullRecover(m, counts) {
  let ents;
  try { ents = fs.readdirSync(TMP); } catch (err) { ents = err.code === "ENOENT" ? [] : (() => { throw err; })(); }
  for (const n of ents) quarantine(path.join(TMP, n), counts);
  for (const [id, e] of Object.entries(m.entries)) {
    const source = id.slice(0, id.indexOf(" "));
    const dir = path.join(ARCHIVE, source, e.dirKey || sha(id).slice(0, 16));
    try {
      if (!fs.existsSync(dir)) {
        if (e.gens.length) { counts.recoveryErrors++; log(`recovery: entry dir missing ${dir}`); e.gens = []; e.size = 0; e.tail = ""; e.mtimeMs = 0; e.ctimeMs = 0; }
        continue;
      }
      recoverEntryFromDisk(dir, e, counts);
    } catch (err) { counts.recoveryErrors++; log(`recovery error ${dir} ${err.code || err.message}`); }
  }
}

// Strict: any readdir/stat error aborts the run (A13). Hidden dirs (.tmp,
// .quarantine) are outside the cap definition (A12).
function archiveSizeStrict() {
  let total = 0;
  const stack = [ARCHIVE];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch (err) { if (err.code === "ENOENT" && d === ARCHIVE) return 0; throw err; }
    for (const en of ents) {
      if (en.name.startsWith(".")) continue;
      const p = path.join(d, en.name);
      if (en.isDirectory()) stack.push(p);
      else if (en.isFile()) total += fs.statSync(p).size;
    }
  }
  return total;
}

// Sorted, counter-instrumented source walk (A11, A14).
function* walk(dir, counts, depth = 0) {
  if (depth > 8) { counts.depthSkipped++; return; }
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (err) {
    if (err.code === "ENOENT" && depth === 0) return;
    counts.walkErrors++; log(`walk error ${dir} ${err.code || err.message}`); return;
  }
  ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) { counts.symlinkSkipped++; continue; }
    if (e.isDirectory()) yield* walk(p, counts, depth + 1);
    else if (e.isFile() && EXT.has(path.extname(e.name))) yield p;
  }
}

// relpath.txt guards short-key dir collisions (A2); new colliding entries fall
// back to the full-SHA dir name. Returns bytes written when relpath was created.
function resolveEntryDir(m, id, rel, source) {
  const e = m.entries[id];
  const keys = e ? [e.dirKey || sha(id).slice(0, 16)] : [sha(id).slice(0, 16), sha(id)];
  for (const key of keys) {
    const dir = path.join(ARCHIVE, source, key);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const rf = path.join(dir, "relpath.txt");
    let cur = null;
    try { cur = fs.readFileSync(rf, "utf8"); } catch (err) { if (err.code !== "ENOENT") throw err; }
    if (cur === null) {
      const fd = fs.openSync(rf, "wx", 0o600);
      try { const b = Buffer.from(rel + "\n"); writeAll(fd, b, 0, b.length, null); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fsyncDir(dir);
      return { dir, key, relpathBytes: Buffer.byteLength(rel) + 1 };
    }
    if (cur === rel + "\n") return { dir, key, relpathBytes: 0 };
    if (e) die(`relpath mismatch in ${dir}: expected ${JSON.stringify(rel)} found ${JSON.stringify(cur.trim())}`);
  }
  die(`relpath collision unresolvable for ${id}`);
}

function run() {
  const m = loadManifest();
  const counts = {
    copied: 0, appended: 0, generations: 0, skipped: 0, changed: 0, files: 0,
    errors: 0, recoveryErrors: 0, walkErrors: 0, depthSkipped: 0, symlinkSkipped: 0,
    oversizeSkipped: 0, archiveLimitSkipped: 0, deadlineHit: 0, fileLimitHit: 0, quarantined: 0,
  };

  const wasDirty = fs.existsSync(DIRTY);
  if (wasDirty) { log("dirty marker present: reconciling archive with manifest"); fullRecover(m, counts); }

  // Archive byte accounting: cached O(1) unless dirty/missing/stale (A13).
  let archBytes;
  const verifiedAt = Date.parse(m.archiveBytesVerifiedAt || "") || 0;
  if (!wasDirty && Number.isFinite(m.archiveBytes) && Date.now() - verifiedAt < 24 * 3600 * 1000) {
    archBytes = m.archiveBytes;
  } else {
    archBytes = archiveSizeStrict();
    m.archiveBytesVerifiedAt = new Date().toISOString();
  }

  let dirtySet = wasDirty;
  const setDirty = () => {
    if (dirtySet) return;
    const fd = fs.openSync(DIRTY, "w", 0o600);
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fsyncDir(STATE);
    dirtySet = true;
  };

  function processItem(it) {
    const { source, rootReal, src, rel } = it;
    counts.files++;
    let srcFd = -1, archFd = -1, candFd = -1, candPath = null;
    try {
      const o = openContainedSource(rootReal, src);
      srcFd = o.fd;
      const st = o.st;
      if (st.size > MAX_FILE) { counts.oversizeSkipped++; return "ok"; }
      const id = `${source} ${rel}`;
      let e = m.entries[id];
      if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && e.ino === st.ino && e.ctimeMs === st.ctimeMs) { counts.skipped++; return "ok"; }
      // capacity-check new entries before creating their dir (A12)
      if (!e && archBytes + st.size + Buffer.byteLength(rel) + 1 > MAX_ARCHIVE) { counts.archiveLimitSkipped++; return "ok"; }

      const loc = resolveEntryDir(m, id, rel, source);
      archBytes += loc.relpathBytes;
      if (!e) e = m.entries[id] = { rel, gens: [], size: 0, mtimeMs: 0, ctimeMs: 0, ino: st.ino, tail: "", dirKey: loc.key };
      else if (!e.dirKey) e.dirKey = loc.key;
      recoverEntryFromDisk(loc.dir, e, counts); // adopt orphans, quarantine strays

      const lastGen = e.gens.length ? path.join(loc.dir, e.gens[e.gens.length - 1]) : null;
      let append = false;
      if (lastGen && st.size >= e.size) {
        archFd = fs.openSync(lastGen, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW); // read-only no-create (A5)
        if (fs.fstatSync(archFd).size === e.size
          && (e.size === 0 || tailHash(srcFd, e.size) === e.tail) // tail hash: quick REJECT only (A4)
          && sameRange(srcFd, archFd, e.size)) append = true;     // full archived-prefix proof (A4)
      }
      const want = st.size - e.size;
      if (append && want === 0) { // content unchanged, metadata drifted
        e.mtimeMs = st.mtimeMs; e.ctimeMs = st.ctimeMs; e.ino = st.ino;
        counts.skipped++;
        return "ok";
      }
      const addBytes = append ? want : st.size;
      if (archBytes + addBytes > MAX_ARCHIVE) { counts.archiveLimitSkipped++; return "ok"; }
      if (typeof fs.statfsSync === "function") { // scratch-space check, distinct from the cap (A12)
        const f = fs.statfsSync(ROOT);
        if (f.bavail * f.bsize < (append ? e.size + want : st.size) + 64 * 1024 * 1024) die(`low free space under ${ROOT}`, "ENOSPC");
      }

      setDirty();
      fs.mkdirSync(TMP, { recursive: true, mode: 0o700 });
      candPath = path.join(TMP, `cand-${process.pid}-${rand()}`);

      if (append) {
        // copy-on-write append (A3): clone, append, fsync, verify, rename, dir fsync
        try {
          fs.copyFileSync(lastGen, candPath, fs.constants.COPYFILE_FICLONE_FORCE | fs.constants.COPYFILE_EXCL);
        } catch {
          candFd = fs.openSync(candPath, "wx", 0o600);
          copyRange(archFd, candFd, e.size);
          fs.closeSync(candFd); candFd = -1;
        }
        candFd = fs.openSync(candPath, "r+");
        copyRange(srcFd, candFd, want, e.size, e.size);
        crashAt("after-append-bytes");
        fs.fsyncSync(candFd);
        if (fs.fstatSync(candFd).size !== st.size) die("append candidate size mismatch");
        if (!sameRange(srcFd, candFd, st.size)) die("append candidate diverges from source");
        fs.renameSync(candPath, lastGen); // atomic prefix -> superset replace
        candPath = null; // candFd now holds the committed generation's inode
        crashAt("after-append-replace");
        fsyncDir(loc.dir);
        const g = fs.fstatSync(candFd); // committed-fd-derived metadata (A3)
        e.size = g.size; e.tail = tailHash(candFd, g.size);
        e.mtimeMs = st.mtimeMs; e.ctimeMs = st.ctimeMs; e.ino = st.ino;
        archBytes += want; counts.appended++; counts.changed++;
      } else {
        // new immutable generation (first sight, shrink, or rewrite)
        const seq = e.gens.length ? seqOf(e.gens[e.gens.length - 1]) + 1 : 1;
        const gname = `g${String(seq).padStart(4, "0")}${EXT.has(path.extname(src)) ? path.extname(src) : ".txt"}`;
        candFd = fs.openSync(candPath, "wx+", 0o600);
        copyRange(srcFd, candFd, st.size);
        fs.fsyncSync(candFd);
        if (fs.fstatSync(candFd).size !== st.size) die("generation candidate size mismatch");
        if (!sameRange(srcFd, candFd, st.size)) die("generation candidate diverges from source");
        fs.linkSync(candPath, path.join(loc.dir, gname)); // no-clobber publish (A2)
        fsyncDir(loc.dir);
        crashAt("after-generation-publish");
        fs.unlinkSync(candPath); candPath = null; // candFd still refers to the published inode
        e.gens.push(gname);
        const g = fs.fstatSync(candFd);
        e.size = g.size; e.tail = tailHash(candFd, g.size);
        e.mtimeMs = st.mtimeMs; e.ctimeMs = st.ctimeMs; e.ino = st.ino;
        archBytes += st.size; counts.copied++; counts.changed++;
        if (e.gens.length > 1) counts.generations++;
      }
      return "ok";
    } catch (err) {
      if (err && err.code === "EDEADLINE") return "deadline";
      if (err && err.code === "ENOENT" && srcFd < 0) { counts.skipped++; return "ok"; } // source vanished mid-run
      counts.errors++;
      log(`error ${source} ${rel} ${err && err.code ? err.code + " " : ""}${String((err && err.message) || err).slice(0, 160)}`);
      return "ok";
    } finally {
      for (const fd of [srcFd, archFd, candFd]) if (fd >= 0) { try { fs.closeSync(fd); } catch {} }
      if (candPath) { try { fs.unlinkSync(candPath); } catch {} }
    }
  }

  // Deterministic scan order with persisted cursor rotation (A11).
  const items = [];
  for (const [source, rootDir] of SOURCES) {
    if (!rootDir || !fs.existsSync(rootDir)) continue;
    const rootReal = fs.realpathSync(rootDir);
    for (const src of walk(rootDir, counts)) items.push({ source, rootReal, src, rel: path.relative(rootDir, src) });
  }
  let start = 0;
  if (m.cursor) {
    const i = items.findIndex((it) => it.source === m.cursor.source && it.rel === m.cursor.rel);
    if (i > 0) start = i;
  }
  delete m.cursor;
  for (let k = 0; k < items.length; k++) {
    const it = items[(start + k) % items.length];
    if (deadline()) { counts.deadlineHit++; m.cursor = { source: it.source, rel: it.rel }; break; }
    if (counts.changed >= MAX_FILES) { counts.fileLimitHit++; m.cursor = { source: it.source, rel: it.rel }; break; }
    if (processItem(it) === "deadline") { counts.deadlineHit++; m.cursor = { source: it.source, rel: it.rel }; break; }
  }

  const outcome = counts.errors || counts.walkErrors || counts.recoveryErrors ? "error"
    : counts.deadlineHit || counts.fileLimitHit || counts.archiveLimitSkipped ? "incomplete" : "ok";
  m.archiveBytes = archBytes;
  m.lastRun = { at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, counts, outcome, archiveBytes: archBytes };
  m.runs = [...(m.runs || []), m.lastRun].slice(-30);
  saveManifest(m); // durable before the dirty marker clears (A3, A10)
  if (dirtySet && counts.recoveryErrors === 0) { fs.rmSync(DIRTY, { force: true }); fsyncDir(STATE); }
  log(`${outcome} copied=${counts.copied} appended=${counts.appended} gens=${counts.generations} skipped=${counts.skipped} errors=${counts.errors} walkErrors=${counts.walkErrors} recoveryErrors=${counts.recoveryErrors} capSkipped=${counts.archiveLimitSkipped} quarantined=${counts.quarantined} bytes=${archBytes}`);
  if (outcome === "error") process.exitCode = 1; // truthful exit (A8)
}

function main() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  fs.mkdirSync(ARCHIVE, { recursive: true, mode: 0o700 });
  const token = acquireLock();
  if (!token) { log("skip: another archiver holds the lock"); process.exitCode = EXIT_BUSY; return; }
  const hold = Number(process.env.RECALL_TEST_HOLD_AFTER_LOCK_MS || 0);
  if (hold > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, hold);
  try { run(); } finally { releaseLock(token); } // no signal handlers: crash safety comes from the protocol (A17)
}

try { main(); } catch (err) {
  try { log(`fatal ${String((err && err.message) || err).slice(0, 200)}`); } catch {}
  console.error(`archive: fatal: ${(err && err.message) || err}`);
  process.exit(1);
}
