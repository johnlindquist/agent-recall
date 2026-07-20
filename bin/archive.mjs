#!/usr/bin/env node
// agent-recall archiver: append-preserving copy of agent transcripts.
// One-shot, bounded, no deletion ever propagates from source to archive.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const HOME = os.homedir();
const ROOT = process.env.RECALL_HOME || path.join(HOME, "Library/Application Support/AgentRecall");
const ARCHIVE = path.join(ROOT, "archive");
const STATE = path.join(ROOT, "state");
const LOGS = path.join(ROOT, "logs");
const MANIFEST = path.join(STATE, "archive-manifest.json");
const LOCK = path.join(STATE, "archive.lock");

const MAX_SECONDS = Number(process.env.RECALL_MAX_SECONDS || 90);
const MAX_FILE = Number(process.env.RECALL_MAX_FILE || 1024 * 1024 * 1024);
const MAX_FILES = Number(process.env.RECALL_MAX_FILES || 20000);
const MAX_ARCHIVE = Number(process.env.RECALL_MAX_ARCHIVE || 50 * 1024 * 1024 * 1024);
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
// Monitored but NOT archived yet (SQLite snapshot lane not enabled; see doctor).
const MONITOR_ONLY = [["agy", path.join(HOME, ".gemini/antigravity-cli/conversations")]];

const t0 = Date.now();
const deadline = () => (Date.now() - t0) / 1000 > MAX_SECONDS;
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

function log(line) {
  fs.mkdirSync(LOGS, { recursive: true, mode: 0o700 });
  const f = path.join(LOGS, "sync.log");
  try { if (fs.existsSync(f) && fs.statSync(f).size > 2 * 1024 * 1024) fs.renameSync(f, f + ".1"); } catch {}
  fs.appendFileSync(f, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
}

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, "utf8")); } catch { return { entries: {}, runs: [] }; }
}
function saveManifest(m) {
  const tmp = MANIFEST + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
  fs.renameSync(tmp, MANIFEST);
}

function* walk(dir, depth = 0) {
  if (depth > 8) return;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walk(p, depth + 1);
    else if (e.isFile() && EXT.has(path.extname(e.name))) yield p;
  }
}

function tailHash(fd, size) {
  const n = Math.min(size, 4096);
  const buf = Buffer.alloc(n);
  fs.readSync(fd, buf, 0, n, size - n);
  return sha(buf);
}

function archiveSize() {
  let total = 0;
  for (const f of walkAll(ARCHIVE)) { try { total += fs.statSync(f).size; } catch {} }
  return total;
}
function* walkAll(dir) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walkAll(p); else if (e.isFile()) yield p;
  }
}

function main() {
  fs.mkdirSync(STATE, { recursive: true, mode: 0o700 });
  // Lock: mkdir-based, stale takeover after MAX_SECONDS + 60s.
  try { fs.mkdirSync(LOCK); } catch {
    try {
      const age = Date.now() - fs.statSync(LOCK).mtimeMs;
      if (age > (MAX_SECONDS + 60) * 1000) { fs.rmSync(LOCK, { recursive: true, force: true }); fs.mkdirSync(LOCK); }
      else { log("skip already-running"); process.exit(0); }
    } catch { process.exit(0); }
  }
  const release = () => { try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch {} };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(130));
  process.on("SIGTERM", () => process.exit(143));

  const m = loadManifest();
  const counts = { copied: 0, appended: 0, generations: 0, skipped: 0, errors: 0, storageSkipped: 0, files: 0 };
  const startingSize = fs.existsSync(ARCHIVE) ? archiveSize() : 0;
  let archBytes = startingSize;

  for (const [source, rootDir] of SOURCES) {
    if (!fs.existsSync(rootDir)) continue;
    for (const src of walk(rootDir)) {
      if (deadline() || counts.files >= MAX_FILES) { counts.storageSkipped++; break; }
      counts.files++;
      try {
        const st = fs.statSync(src);
        if (st.size > MAX_FILE) { counts.skipped++; continue; }
        const rel = path.relative(rootDir, src);
        const id = `${source} ${rel}`;
        const key = sha(id).slice(0, 16);
        const dir = path.join(ARCHIVE, source, key);
        let e = m.entries[id];
        if (e && e.size === st.size && e.mtimeMs === st.mtimeMs && e.ino === st.ino) { counts.skipped++; continue; }
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        const relFile = path.join(dir, "relpath.txt");
        if (!fs.existsSync(relFile)) fs.writeFileSync(relFile, rel + "\n", { mode: 0o600 });
        if (!e) e = m.entries[id] = { rel, gens: [], size: 0, mtimeMs: 0, ino: st.ino, tail: "" };

        const genName = () => `g${String(e.gens.length + 1).padStart(4, "0")}${path.extname(src) || ".txt"}`;
        const lastGen = e.gens.length ? path.join(dir, e.gens[e.gens.length - 1]) : null;

        let appended = false;
        if (lastGen && st.size >= e.size && e.size > 0 && st.ino === e.ino) {
          // verify the archived prefix still matches via stored tail hash
          const fd = fs.openSync(src, "r");
          try {
            if (tailHash(fd, e.size) === e.tail) {
              const want = st.size - e.size;
              if (want > 0) {
                if (archBytes + want > MAX_ARCHIVE) { counts.storageSkipped++; fs.closeSync(fd); continue; }
                const buf = Buffer.alloc(Math.min(want, 8 * 1024 * 1024));
                const out = fs.openSync(lastGen, "a");
                let off = e.size, left = want;
                try {
                  while (left > 0) {
                    const n = fs.readSync(fd, buf, 0, Math.min(buf.length, left), off);
                    if (n <= 0) break;
                    fs.writeSync(out, buf, 0, n); off += n; left -= n;
                  }
                  fs.fsyncSync(out);
                } finally { fs.closeSync(out); }
                archBytes += want;
              }
              const fd2 = fs.openSync(src, "r");
              e.tail = tailHash(fd2, st.size); fs.closeSync(fd2);
              e.size = st.size; e.mtimeMs = st.mtimeMs; e.ino = st.ino;
              counts.appended++; appended = true;
            }
          } finally { fs.closeSync(fd); }
        }
        if (!appended) {
          // full copy as a new immutable generation (first sight, shrink, or rewrite)
          if (archBytes + st.size > MAX_ARCHIVE) { counts.storageSkipped++; continue; }
          const gname = genName();
          const tmp = path.join(dir, gname + ".partial");
          fs.copyFileSync(src, tmp);
          fs.renameSync(tmp, path.join(dir, gname));
          fs.chmodSync(path.join(dir, gname), 0o600);
          e.gens.push(gname);
          const fd = fs.openSync(src, "r");
          e.tail = tailHash(fd, st.size); fs.closeSync(fd);
          e.size = st.size; e.mtimeMs = st.mtimeMs; e.ino = st.ino;
          archBytes += st.size;
          counts.copied++;
          if (e.gens.length > 1) counts.generations++;
        }
      } catch (err) { counts.errors++; log(`error ${String(err.message || err).slice(0, 120)}`); }
    }
  }

  // monitor-only sources: record presence for doctor/coverage, archive nothing
  const monitor = {};
  for (const [name, dir] of MONITOR_ONLY) {
    try { monitor[name] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".db")).length : 0; }
    catch { monitor[name] = -1; }
  }

  m.lastRun = { at: new Date().toISOString(), seconds: (Date.now() - t0) / 1000, counts, monitor, archiveBytes: archBytes };
  m.runs = [...(m.runs || []), m.lastRun].slice(-30);
  saveManifest(m);
  log(`ok copied=${counts.copied} appended=${counts.appended} gens=${counts.generations} skipped=${counts.skipped} errors=${counts.errors} storageSkipped=${counts.storageSkipped} bytes=${archBytes}`);
}

main();
